import { and, eq, sql } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import type { SyncKv } from "./db/kv.ts";
import {
  SWEEP_STATE_ID,
  objectDeltas,
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
  /** Inflated object bytes plus persisted delta bytes; storage overhead is excluded. */
  readonly bytes: number;
}

export type ObjectDescription = Omit<ObjectRow, "complete">;

/**
 * Git objects as chunked rows in the repository's own Durable Object: metadata
 * in SQL, inflated bytes in the synchronous KV half under `o:<oid>:<n>`, and
 * the delta an object arrived as under `d:<oid>:<n>`. See
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
    const objectChunks = chunkCount(object.bytes.length);
    const deltaChunks = object.delta === null ? 0 : chunkCount(object.delta.bytes.length);
    let claimed = false;

    try {
      const existing = await this.#stored(object.oid);
      if (existing?.complete) {
        return;
      }
      if (existing !== null) {
        await this.#discardIncomplete(existing);
      }

      const inserted = await this.#db
        .insert(objects)
        .values({
          oid: object.oid,
          type: object.type,
          size: object.bytes.length,
          chunkCount: objectChunks,
          complete: false,
        })
        .onConflictDoNothing()
        .returning({ oid: objects.oid });

      if (inserted.length === 0) {
        return;
      }
      claimed = true;

      this.#writeChunks(OBJECT_PREFIX, object.oid, object.bytes);

      if (object.delta !== null) {
        await this.#db.insert(objectDeltas).values({
          oid: object.oid,
          baseOid: object.delta.baseOid,
          size: object.delta.bytes.length,
          chunkCount: deltaChunks,
        });

        this.#writeChunks(DELTA_PREFIX, object.oid, object.delta.bytes);
      }

      await this.#db
        .update(objects)
        .set({ complete: true })
        .where(and(eq(objects.oid, object.oid), eq(objects.complete, false)));
    } catch (error) {
      const storageExhausted = error instanceof Error && isStorageExhaustion(error);
      if (claimed) {
        try {
          await this.#discardWrite(object.oid, objectChunks, deltaChunks);
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
    if (!(await this.has(oid))) {
      return null;
    }

    const rows = await this.#db
      .select({ baseOid: objectDeltas.baseOid })
      .from(objectDeltas)
      .where(eq(objectDeltas.oid, oid))
      .limit(1);

    return rows[0]?.baseOid ?? null;
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

    await this.#db.transaction((tx) => {
      for (let index = 0; index < object.chunkCount; index += 1) {
        this.#kv.delete(chunkKey(OBJECT_PREFIX, oid, index));
      }
      if (delta !== undefined) {
        for (let index = 0; index < delta.chunkCount; index += 1) {
          this.#kv.delete(chunkKey(DELTA_PREFIX, oid, index));
        }
      }

      tx.delete(objects).where(eq(objects.oid, oid)).run();
      tx.update(sweepState)
        .set({
          reclaimedObjects: sql`${sweepState.reclaimedObjects} + 1`,
          reclaimedChunks: sql`${sweepState.reclaimedChunks} + ${object.chunkCount + (delta?.chunkCount ?? 0)}`,
          reclaimedBytes: sql`${sweepState.reclaimedBytes} + ${object.size + (delta?.size ?? 0)}`,
        })
        .where(eq(sweepState.id, SWEEP_STATE_ID))
        .run();
    });

    return {
      objects: 1,
      chunks: object.chunkCount + (delta?.chunkCount ?? 0),
      bytes: object.size + (delta?.size ?? 0),
    };
  }

  #writeChunks(prefix: string, oid: string, bytes: Uint8Array): void {
    for (let index = 0; index * CHUNK_BYTES < bytes.length; index += 1) {
      const at = index * CHUNK_BYTES;
      this.#kv.put<Uint8Array>(chunkKey(prefix, oid, index), bytes.slice(at, at + CHUNK_BYTES));
    }
  }

  /** SQL and synchronous KV share this transaction in a SQLite Durable Object. */
  async #discardWrite(oid: string, objectChunks: number, deltaChunks: number): Promise<void> {
    await this.#db.transaction((tx) => {
      for (let index = 0; index < objectChunks; index += 1) {
        this.#kv.delete(chunkKey(OBJECT_PREFIX, oid, index));
      }
      for (let index = 0; index < deltaChunks; index += 1) {
        this.#kv.delete(chunkKey(DELTA_PREFIX, oid, index));
      }

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

    await this.#discardWrite(object.oid, object.chunkCount, delta?.chunkCount ?? 0);
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
