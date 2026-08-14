import { deflateSync } from "node:zlib";

import { and, eq, inArray, sql } from "drizzle-orm";

import { linksToFetch, ObjectParseError, type ObjectLink } from "./connectivity.ts";
import type { SyncSqliteDatabase } from "./db/database.ts";
import type { SyncKv } from "./db/kv.ts";
import {
  SWEEP_STATE_ID,
  objectDeltas,
  objectLinks,
  objects,
  sweepState,
  type ObjectRow,
} from "./db/repository-schema.ts";
import type { PackBase, PackDelta, PackObject, PackSink } from "./pack.ts";

/**
 * Durable Object storage caps a key and its value together at 2 MB, so an
 * object's bytes are split at 1.5 MiB with room to spare for the key and the
 * encoding overhead.
 */
export const CHUNK_BYTES = 1_536 * 1_024;

const OBJECT_PREFIX = "o";
const DELTA_PREFIX = "d";
const COMPRESSED_OBJECT_PREFIX = "z";
const COMPRESSED_DELTA_PREFIX = "zd";
const SQLITE_MAX_BOUND_VALUES = 100;
/** Leave room for completeness/index predicates beside an `IN` frontier. */
const OBJECT_METADATA_BATCH_SIZE = SQLITE_MAX_BOUND_VALUES - 2;
const OBJECT_LINK_BOUND_VALUES_PER_ROW = 3;
const OBJECT_LINK_INSERT_BATCH_SIZE = Math.floor(
  SQLITE_MAX_BOUND_VALUES / OBJECT_LINK_BOUND_VALUES_PER_ROW,
);

const deduplicateLinks = (links: readonly ObjectLink[]): readonly ObjectLink[] => {
  const targets = new Set<string>();
  return links.filter((link) => {
    if (targets.has(link.oid)) {
      return false;
    }
    targets.add(link.oid);
    return true;
  });
};

const chunkKey = (prefix: string, oid: string, index: number): string =>
  `${prefix}:${oid}:${index}`;

const chunkCount = (size: number): number => Math.ceil(size / CHUNK_BYTES);

export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

/** A stable failure callers can translate without exposing SQLite internals. */
export class RepositoryStorageExhaustedError extends ObjectStoreError {
  constructor() {
    super("Repository storage is full.");
    this.name = "RepositoryStorageExhaustedError";
  }
}

const isStorageExhaustion = (error: Error, seen = new Set<Error>()): boolean => {
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  if (error.message.includes("SQLITE_FULL") || ("code" in error && error.code === "SQLITE_FULL")) {
    return true;
  }

  return error.cause instanceof Error && isStorageExhaustion(error.cause, seen);
};

export interface ReclaimedObject {
  readonly objects: 1;
  readonly chunks: number;
  /** Resolved, Delta, and compressed payload bytes; storage overhead is excluded. */
  readonly bytes: number;
}

export interface ObjectDescription {
  readonly oid: string;
  readonly type: ObjectRow["type"];
  readonly size: number;
  readonly chunkCount: number;
}

export interface FullPackEntry {
  readonly type: ObjectRow["type"];
  readonly size: number;
  readonly compressed: Uint8Array;
}

export interface DeltaPackEntry {
  readonly baseOid: string;
  readonly size: number;
  readonly compressed: Uint8Array;
}

export interface IndexedObject {
  readonly type: ObjectRow["type"];
  readonly links: readonly ObjectLink[];
}

/**
 * Git objects as chunked rows in the repository's own Durable Object: metadata
 * in SQL, inflated bytes under `o:<oid>:<n>`, reusable compression under
 * `z:<oid>:<n>`, and an optional Delta under `d:`/`zd:`. See
 * [ADR-0002](../../../docs/adr/0002-git-objects-are-chunked-rows-in-the-repository-object.md).
 *
 * It is the sink a pack is read into and the source a delta's base is read
 * back out of, which is the same store on purpose: that is what lets the parse
 * hold one object at a time instead of the pack.
 */
export class ObjectStore implements PackSink {
  readonly #db: SyncSqliteDatabase;
  readonly #kv: SyncKv;

  constructor(db: SyncSqliteDatabase, kv: SyncKv) {
    this.#db = db;
    this.#kv = kv;
  }

  /**
   * A no-op when the object is already here. An object is named by the SHA-1 of
   * its contents, so "already here" means "byte-identical", and rewriting the
   * chunks would cost megabytes to arrive where we are.
   */
  async write(object: PackObject): Promise<void> {
    let objectChunks = 0;
    let deltaChunks = 0;
    let fullCompressed: Uint8Array | null = null;
    let compressedObjectChunks = 0;
    const compressedDeltaChunks = 0;
    let links: readonly ObjectLink[] = [];
    let linksIndexed = false;
    let claimed = false;

    try {
      const existing = await this.#stored(object.oid);
      if (existing?.complete) {
        return;
      }
      if (existing !== null) {
        await this.#discardIncomplete(existing);
      }

      objectChunks = chunkCount(object.bytes.length);
      deltaChunks = object.delta === null ? 0 : chunkCount(object.delta.bytes.length);
      // Resolving a Delta already holds its instructions, base, and result.
      // Defer both derived compressions to Repack. Whole objects can cache their
      // full entry here, but only after the cheap completed-row deduplication.
      fullCompressed = object.delta === null ? new Uint8Array(deflateSync(object.bytes)) : null;
      compressedObjectChunks = fullCompressed === null ? 0 : chunkCount(fullCompressed.length);
      try {
        links = deduplicateLinks(linksToFetch(object.type, object.bytes));
        linksIndexed = true;
      } catch (error) {
        if (!(error instanceof ObjectParseError)) {
          throw error;
        }
      }

      const inserted = await this.#db
        .insert(objects)
        .values({
          oid: object.oid,
          type: object.type,
          size: object.bytes.length,
          chunkCount: objectChunks,
          compressedSize: fullCompressed?.length ?? null,
          compressedChunkCount: fullCompressed === null ? null : compressedObjectChunks,
          linksIndexed,
          complete: false,
        })
        .onConflictDoNothing()
        .returning({ oid: objects.oid });

      if (inserted.length === 0) {
        return;
      }
      claimed = true;

      this.#writeChunks(OBJECT_PREFIX, object.oid, object.bytes);
      if (fullCompressed !== null) {
        this.#writeChunks(COMPRESSED_OBJECT_PREFIX, object.oid, fullCompressed);
      }

      if (object.delta !== null) {
        await this.#db.insert(objectDeltas).values({
          oid: object.oid,
          baseOid: object.delta.baseOid,
          size: object.delta.bytes.length,
          chunkCount: deltaChunks,
          compressedSize: null,
          compressedChunkCount: null,
        });

        this.#writeChunks(DELTA_PREFIX, object.oid, object.delta.bytes);
      }

      for (let at = 0; at < links.length; at += OBJECT_LINK_INSERT_BATCH_SIZE) {
        await this.#db.insert(objectLinks).values(
          links.slice(at, at + OBJECT_LINK_INSERT_BATCH_SIZE).map((link) => ({
            sourceOid: object.oid,
            targetOid: link.oid,
            targetType: link.type,
          })),
        );
      }

      await this.#db
        .update(objects)
        .set({ complete: true })
        .where(and(eq(objects.oid, object.oid), eq(objects.complete, false)));
    } catch (error) {
      const storageExhausted = error instanceof Error && isStorageExhaustion(error);
      if (claimed) {
        try {
          await this.#discardWrite(
            object.oid,
            objectChunks,
            deltaChunks,
            compressedObjectChunks,
            compressedDeltaChunks,
          );
        } catch {
          // Keep the write failure as the operation's result. An incomplete row
          // remains hidden and lets a retry or sweep finish the cleanup.
        }
      }
      if (storageExhausted) {
        throw new RepositoryStorageExhaustedError();
      }
      throw error;
    }
  }

  async read(oid: string): Promise<PackBase | null> {
    const row = await this.describe(oid);
    if (row === null) {
      return null;
    }

    return {
      type: row.type,
      bytes: this.#readChunks(OBJECT_PREFIX, oid, row.size, row.chunkCount),
    };
  }

  /**
   * Return one stored chunk at a time, so a maximum-size object never becomes
   * one serialized RPC value on its way from the Durable Object to the Worker.
   */
  async readStream(
    oid: string,
    expectedType: PackBase["type"],
  ): Promise<ReadableStream<Uint8Array> | null> {
    const row = await this.describe(oid);
    if (row === null || row.type !== expectedType) {
      return null;
    }

    let index = 0;
    let read = 0;

    return new ReadableStream<Uint8Array>({
      type: "bytes",
      pull: (controller) => {
        if (index === row.chunkCount) {
          if (read !== row.size) {
            controller.error(
              new ObjectStoreError(
                `Object ${oid} holds ${read} bytes where its row declares ${row.size}.`,
              ),
            );
          } else {
            controller.close();
          }
          return;
        }

        const key = chunkKey(OBJECT_PREFIX, oid, index);
        const chunk = this.#kv.get<Uint8Array>(key);
        if (chunk === undefined) {
          controller.error(new ObjectStoreError(`Chunk ${key} is missing.`));
          return;
        }

        index += 1;
        read += chunk.length;
        if (read > row.size) {
          controller.error(
            new ObjectStoreError(
              `Object ${oid} holds more bytes than its row declares (${row.size}).`,
            ),
          );
          return;
        }

        controller.enqueue(Uint8Array.from(chunk));
      },
    });
  }

  async describe(oid: string): Promise<ObjectDescription | null> {
    const rows = await this.#db
      .select({
        oid: objects.oid,
        type: objects.type,
        size: objects.size,
        chunkCount: objects.chunkCount,
      })
      .from(objects)
      .where(and(eq(objects.oid, oid), eq(objects.complete, true)))
      .limit(1);

    return rows[0] ?? null;
  }

  async has(oid: string): Promise<boolean> {
    return (await this.describe(oid)) !== null;
  }

  /** `null` when the object arrived whole rather than as a delta. */
  async readDeltaBase(oid: string): Promise<string | null> {
    return (await this.readDeltaBases([oid])).get(oid) ?? null;
  }

  /** Fetch delta relationships in bounded SQL batches instead of one query per Pack object. */
  async readDeltaBases(oids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const bases = new Map<string, string>();
    for (let at = 0; at < oids.length; at += OBJECT_METADATA_BATCH_SIZE) {
      const batch = oids.slice(at, at + OBJECT_METADATA_BATCH_SIZE);
      if (batch.length === 0) {
        continue;
      }
      const rows = await this.#db
        .select({ oid: objectDeltas.oid, baseOid: objectDeltas.baseOid })
        .from(objectDeltas)
        .innerJoin(objects, eq(objectDeltas.oid, objects.oid))
        .where(and(inArray(objectDeltas.oid, batch), eq(objects.complete, true)));
      for (const row of rows) {
        bases.set(row.oid, row.baseOid);
      }
    }
    return bases;
  }

  /** `null` when the object arrived whole rather than as a delta. */
  async readDelta(oid: string): Promise<PackDelta | null> {
    if (!(await this.has(oid))) {
      return null;
    }

    const rows = await this.#db
      .select()
      .from(objectDeltas)
      .where(eq(objectDeltas.oid, oid))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      baseOid: row.baseOid,
      bytes: this.#readChunks(DELTA_PREFIX, oid, row.size, row.chunkCount),
    };
  }

  /** A full Pack entry whose zlib stream is reusable byte-for-byte. */
  async readFullPackEntry(oid: string): Promise<FullPackEntry | null> {
    if ((await this.ensureFullPackEntry(oid)) === null) {
      return null;
    }
    const row = await this.#stored(oid);
    if (row === null || row.compressedSize === null || row.compressedChunkCount === null) {
      throw new ObjectStoreError(`Object ${oid} lost its compressed Pack entry.`);
    }
    return {
      type: row.type,
      size: row.size,
      compressed: this.#readChunks(
        COMPRESSED_OBJECT_PREFIX,
        oid,
        row.compressedSize,
        row.compressedChunkCount,
      ),
    };
  }

  /** Ensure a full-entry cache exists without materializing it for maintenance callers. */
  async ensureFullPackEntry(oid: string): Promise<number | null> {
    let row = await this.#stored(oid);
    if (row === null || !row.complete) {
      return null;
    }
    if (row.compressedSize === null || row.compressedChunkCount === null) {
      await this.#cacheFullCompression(row);
      row = await this.#stored(oid);
      if (row === null || row.compressedSize === null || row.compressedChunkCount === null) {
        throw new ObjectStoreError(`Object ${oid} could not publish its compressed Pack entry.`);
      }
    }
    return row.compressedSize;
  }

  /** A retained delta Pack entry whose zlib stream is reusable byte-for-byte. */
  async readDeltaPackEntry(oid: string): Promise<DeltaPackEntry | null> {
    if ((await this.ensureDeltaPackEntry(oid)) === null) {
      return null;
    }
    const [row] = await this.#db
      .select()
      .from(objectDeltas)
      .where(eq(objectDeltas.oid, oid))
      .limit(1);
    if (row === undefined || row.compressedSize === null || row.compressedChunkCount === null) {
      throw new ObjectStoreError(`Delta ${oid} lost its compressed Pack entry.`);
    }
    return {
      baseOid: row.baseOid,
      size: row.size,
      compressed: this.#readChunks(
        COMPRESSED_DELTA_PREFIX,
        oid,
        row.compressedSize,
        row.compressedChunkCount,
      ),
    };
  }

  /** Ensure a retained-delta cache exists without materializing it for maintenance callers. */
  async ensureDeltaPackEntry(oid: string): Promise<number | null> {
    if (!(await this.has(oid))) {
      return null;
    }
    let [row] = await this.#db
      .select()
      .from(objectDeltas)
      .where(eq(objectDeltas.oid, oid))
      .limit(1);
    if (row === undefined) {
      return null;
    }
    if (row.compressedSize === null || row.compressedChunkCount === null) {
      await this.#cacheDeltaCompression(row);
      [row] = await this.#db.select().from(objectDeltas).where(eq(objectDeltas.oid, oid)).limit(1);
      if (row === undefined || row.compressedSize === null || row.compressedChunkCount === null) {
        throw new ObjectStoreError(`Delta ${oid} could not publish its compressed Pack entry.`);
      }
    }
    return row.compressedSize;
  }

  /** Resolve already-parsed graph rows for a frontier in bounded SQL batches. */
  async readIndexedObjects(oids: readonly string[]): Promise<ReadonlyMap<string, IndexedObject>> {
    const indexed = new Map<string, IndexedObject>();
    for (let at = 0; at < oids.length; at += OBJECT_METADATA_BATCH_SIZE) {
      const batch = oids.slice(at, at + OBJECT_METADATA_BATCH_SIZE);
      if (batch.length === 0) {
        continue;
      }
      const rows = await this.#db
        .select({ oid: objects.oid, type: objects.type })
        .from(objects)
        .where(
          and(
            inArray(objects.oid, batch),
            eq(objects.complete, true),
            eq(objects.linksIndexed, true),
          ),
        );
      for (const row of rows) {
        indexed.set(row.oid, { type: row.type, links: [] });
      }
      const linked = await this.#db
        .select()
        .from(objectLinks)
        .where(inArray(objectLinks.sourceOid, batch));
      const grouped = new Map<string, ObjectLink[]>();
      for (const row of linked) {
        const links = grouped.get(row.sourceOid) ?? [];
        links.push({ oid: row.targetOid, type: row.targetType });
        grouped.set(row.sourceOid, links);
      }
      for (const [oid, links] of grouped) {
        const object = indexed.get(oid);
        if (object !== undefined) {
          indexed.set(oid, { ...object, links });
        }
      }
    }
    return indexed;
  }

  /** Backfill parsed graph edges for an object written before the index existed. */
  async indexLinks(oid: string): Promise<boolean> {
    const row = await this.#stored(oid);
    if (row === null || !row.complete) {
      return false;
    }
    if (row.linksIndexed) {
      return true;
    }
    const object = await this.read(oid);
    if (object === null) {
      return false;
    }
    let links: readonly ObjectLink[];
    try {
      links = deduplicateLinks(linksToFetch(object.type, object.bytes));
    } catch (error) {
      if (error instanceof ObjectParseError) {
        return false;
      }
      throw error;
    }

    await this.#db.transaction((tx) => {
      tx.delete(objectLinks).where(eq(objectLinks.sourceOid, oid)).run();
      for (let at = 0; at < links.length; at += OBJECT_LINK_INSERT_BATCH_SIZE) {
        tx.insert(objectLinks)
          .values(
            links.slice(at, at + OBJECT_LINK_INSERT_BATCH_SIZE).map((link) => ({
              sourceOid: oid,
              targetOid: link.oid,
              targetType: link.type,
            })),
          )
          .run();
      }
      tx.update(objects).set({ linksIndexed: true }).where(eq(objects.oid, oid)).run();
    });
    return true;
  }

  /** Install a selected Delta only while the object still has no retained representation. */
  async installDelta(oid: string, delta: PackDelta, compressed?: Uint8Array): Promise<void> {
    const [row] = await this.#db
      .select()
      .from(objectDeltas)
      .where(eq(objectDeltas.oid, oid))
      .limit(1);
    if (row !== undefined) {
      return;
    }
    const encoded = compressed ?? new Uint8Array(deflateSync(delta.bytes));
    const deltaChunks = chunkCount(delta.bytes.length);
    const compressedChunks = chunkCount(encoded.length);

    try {
      this.#writeChunks(DELTA_PREFIX, oid, delta.bytes);
      this.#writeChunks(COMPRESSED_DELTA_PREFIX, oid, encoded);
      await this.#db.insert(objectDeltas).values({
        oid,
        baseOid: delta.baseOid,
        size: delta.bytes.length,
        chunkCount: deltaChunks,
        compressedSize: encoded.length,
        compressedChunkCount: compressedChunks,
      });
    } catch (error) {
      this.#deleteChunks(DELTA_PREFIX, oid, deltaChunks);
      this.#deleteChunks(COMPRESSED_DELTA_PREFIX, oid, compressedChunks);
      if (error instanceof Error && isStorageExhaustion(error)) {
        throw new RepositoryStorageExhaustedError();
      }
      throw error;
    }
  }

  /**
   * Remove every representation of one object in one storage transaction.
   * `null` makes retries idempotent when a previous sweep already reclaimed it.
   */
  async reclaim(oid: string): Promise<ReclaimedObject | null> {
    const [object] = await this.#db.select().from(objects).where(eq(objects.oid, oid)).limit(1);
    if (object === undefined) {
      return null;
    }

    const [delta] = await this.#db
      .select()
      .from(objectDeltas)
      .where(eq(objectDeltas.oid, oid))
      .limit(1);
    const compressedObjectChunks = object.compressedChunkCount ?? 0;
    const compressedDeltaChunks = delta?.compressedChunkCount ?? 0;
    const reclaimedChunks =
      object.chunkCount + compressedObjectChunks + (delta?.chunkCount ?? 0) + compressedDeltaChunks;
    const reclaimedBytes =
      object.size +
      (object.compressedSize ?? 0) +
      (delta?.size ?? 0) +
      (delta?.compressedSize ?? 0);

    await this.#db.transaction((tx) => {
      this.#deleteChunks(OBJECT_PREFIX, oid, object.chunkCount);
      this.#deleteChunks(COMPRESSED_OBJECT_PREFIX, oid, compressedObjectChunks);
      if (delta !== undefined) {
        this.#deleteChunks(DELTA_PREFIX, oid, delta.chunkCount);
        this.#deleteChunks(COMPRESSED_DELTA_PREFIX, oid, compressedDeltaChunks);
      }

      tx.delete(objects).where(eq(objects.oid, oid)).run();
      tx.update(sweepState)
        .set({
          reclaimedObjects: sql`${sweepState.reclaimedObjects} + 1`,
          reclaimedChunks: sql`${sweepState.reclaimedChunks} + ${reclaimedChunks}`,
          reclaimedBytes: sql`${sweepState.reclaimedBytes} + ${reclaimedBytes}`,
        })
        .where(eq(sweepState.id, SWEEP_STATE_ID))
        .run();
    });

    return {
      objects: 1,
      chunks: reclaimedChunks,
      bytes: reclaimedBytes,
    };
  }

  #writeChunks(prefix: string, oid: string, bytes: Uint8Array): void {
    for (let index = 0; index * CHUNK_BYTES < bytes.length; index += 1) {
      const at = index * CHUNK_BYTES;
      this.#kv.put<Uint8Array>(chunkKey(prefix, oid, index), bytes.slice(at, at + CHUNK_BYTES));
    }
  }

  #deleteChunks(prefix: string, oid: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.#kv.delete(chunkKey(prefix, oid, index));
    }
  }

  /** SQL and synchronous KV share this transaction in a SQLite Durable Object. */
  async #discardWrite(
    oid: string,
    objectChunks: number,
    deltaChunks: number,
    compressedObjectChunks: number,
    compressedDeltaChunks: number,
  ): Promise<void> {
    await this.#db.transaction((tx) => {
      this.#deleteChunks(OBJECT_PREFIX, oid, objectChunks);
      this.#deleteChunks(DELTA_PREFIX, oid, deltaChunks);
      this.#deleteChunks(COMPRESSED_OBJECT_PREFIX, oid, compressedObjectChunks);
      this.#deleteChunks(COMPRESSED_DELTA_PREFIX, oid, compressedDeltaChunks);

      tx.delete(objects).where(eq(objects.oid, oid)).run();
    });
  }

  async #stored(oid: string): Promise<ObjectRow | null> {
    const [row] = await this.#db.select().from(objects).where(eq(objects.oid, oid)).limit(1);
    return row ?? null;
  }

  async #discardIncomplete(object: ObjectRow): Promise<void> {
    const [delta] = await this.#db
      .select()
      .from(objectDeltas)
      .where(eq(objectDeltas.oid, object.oid))
      .limit(1);

    await this.#discardWrite(
      object.oid,
      object.chunkCount,
      delta?.chunkCount ?? 0,
      object.compressedChunkCount ?? 0,
      delta?.compressedChunkCount ?? 0,
    );
  }

  async #cacheFullCompression(object: ObjectRow): Promise<void> {
    if (object.compressedSize === null && object.compressedChunkCount !== null) {
      await this.#discardFullCompression(object.oid, object.compressedChunkCount);
    }
    const bytes = this.#readChunks(OBJECT_PREFIX, object.oid, object.size, object.chunkCount);
    const compressed = new Uint8Array(deflateSync(bytes));
    const count = chunkCount(compressed.length);
    try {
      await this.#db
        .update(objects)
        .set({ compressedChunkCount: count })
        .where(and(eq(objects.oid, object.oid), eq(objects.complete, true)));
      this.#writeChunks(COMPRESSED_OBJECT_PREFIX, object.oid, compressed);
      await this.#db
        .update(objects)
        .set({ compressedSize: compressed.length })
        .where(and(eq(objects.oid, object.oid), eq(objects.complete, true)));
    } catch (error) {
      try {
        await this.#discardFullCompression(object.oid, count);
      } catch {
        // The staged chunk count stays durable so reclaim or a retry can finish
        // an interrupted cleanup without losing the original cache failure.
      }
      if (error instanceof Error && isStorageExhaustion(error)) {
        throw new RepositoryStorageExhaustedError();
      }
      throw error;
    }
  }

  async #cacheDeltaCompression(delta: typeof objectDeltas.$inferSelect): Promise<void> {
    if (delta.compressedSize === null && delta.compressedChunkCount !== null) {
      await this.#discardDeltaCompression(delta.oid, delta.compressedChunkCount);
    }
    const bytes = this.#readChunks(DELTA_PREFIX, delta.oid, delta.size, delta.chunkCount);
    const compressed = new Uint8Array(deflateSync(bytes));
    const count = chunkCount(compressed.length);
    try {
      await this.#db
        .update(objectDeltas)
        .set({ compressedChunkCount: count })
        .where(eq(objectDeltas.oid, delta.oid));
      this.#writeChunks(COMPRESSED_DELTA_PREFIX, delta.oid, compressed);
      await this.#db
        .update(objectDeltas)
        .set({ compressedSize: compressed.length })
        .where(eq(objectDeltas.oid, delta.oid));
    } catch (error) {
      try {
        await this.#discardDeltaCompression(delta.oid, count);
      } catch {
        // See the full-entry path above: keep the reservation discoverable.
      }
      if (error instanceof Error && isStorageExhaustion(error)) {
        throw new RepositoryStorageExhaustedError();
      }
      throw error;
    }
  }

  async #discardFullCompression(oid: string, count: number): Promise<void> {
    await this.#db.transaction((tx) => {
      this.#deleteChunks(COMPRESSED_OBJECT_PREFIX, oid, count);
      tx.update(objects)
        .set({ compressedSize: null, compressedChunkCount: null })
        .where(eq(objects.oid, oid))
        .run();
    });
  }

  async #discardDeltaCompression(oid: string, count: number): Promise<void> {
    await this.#db.transaction((tx) => {
      this.#deleteChunks(COMPRESSED_DELTA_PREFIX, oid, count);
      tx.update(objectDeltas)
        .set({ compressedSize: null, compressedChunkCount: null })
        .where(eq(objectDeltas.oid, oid))
        .run();
    });
  }

  #readChunks(prefix: string, oid: string, size: number, count: number): Uint8Array {
    const bytes = new Uint8Array(size);
    let at = 0;

    for (let index = 0; index < count; index += 1) {
      const key = chunkKey(prefix, oid, index);
      const chunk = this.#kv.get<Uint8Array>(key);

      if (chunk === undefined) {
        throw new ObjectStoreError(`Chunk ${key} is missing.`);
      }

      bytes.set(chunk, at);
      at += chunk.length;
    }

    if (at !== size) {
      throw new ObjectStoreError(`Object ${oid} holds ${at} bytes where its row declares ${size}.`);
    }

    return bytes;
  }
}
