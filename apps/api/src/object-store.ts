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
import type { PackBase, PackDelta, PackObject, PackSink, PackTimings } from "./pack.ts";

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

interface CompressedRepresentation {
  readonly size: number;
  readonly chunkCount: number;
}

export interface PackRepresentationMetadata {
  readonly oid: string;
  readonly type: ObjectRow["type"];
  readonly size: number;
  readonly full: CompressedRepresentation | null;
  readonly delta: {
    readonly baseOid: string;
    readonly size: number;
    readonly compressed: CompressedRepresentation | null;
  } | null;
}

export type CachedPackEntry =
  | {
      readonly kind: "full";
      readonly type: ObjectRow["type"];
      readonly size: number;
      readonly compressed: Uint8Array;
    }
  | {
      readonly kind: "delta";
      readonly baseOid: string;
      readonly size: number;
      readonly compressed: Uint8Array;
    };

export interface CachedPackEntryRequest {
  readonly metadata: PackRepresentationMetadata;
  readonly preferredBaseOid: string | null;
}

type CachedPackSelection =
  | {
      readonly oid: string;
      readonly prefix: typeof COMPRESSED_OBJECT_PREFIX;
      readonly size: number;
      readonly chunkCount: number;
      readonly entry: Omit<Extract<CachedPackEntry, { readonly kind: "full" }>, "compressed">;
    }
  | {
      readonly oid: string;
      readonly prefix: typeof COMPRESSED_DELTA_PREFIX;
      readonly size: number;
      readonly chunkCount: number;
      readonly entry: Omit<Extract<CachedPackEntry, { readonly kind: "delta" }>, "compressed">;
    };

interface PreparedPackWrite {
  readonly object: PackObject;
  readonly objectChunks: number;
  readonly deltaChunks: number;
  readonly fullCompressed: Uint8Array | null;
  readonly deltaCompressed: Uint8Array | null;
  readonly compressedObjectChunks: number;
  readonly compressedDeltaChunks: number;
  readonly links: readonly ObjectLink[];
  readonly linksIndexed: boolean;
  readonly hasIncomingRepresentation: boolean;
  claimed: boolean;
}

const selectCachedPackEntry = ({
  metadata,
  preferredBaseOid,
}: CachedPackEntryRequest): CachedPackSelection | null => {
  if (
    preferredBaseOid !== null &&
    metadata.delta?.baseOid === preferredBaseOid &&
    metadata.delta.compressed !== null
  ) {
    return {
      oid: metadata.oid,
      prefix: COMPRESSED_DELTA_PREFIX,
      size: metadata.delta.compressed.size,
      chunkCount: metadata.delta.compressed.chunkCount,
      entry: {
        kind: "delta",
        baseOid: preferredBaseOid,
        size: metadata.delta.size,
      },
    };
  }

  if (metadata.full !== null) {
    return {
      oid: metadata.oid,
      prefix: COMPRESSED_OBJECT_PREFIX,
      size: metadata.full.size,
      chunkCount: metadata.full.chunkCount,
      entry: { kind: "full", type: metadata.type, size: metadata.size },
    };
  }

  return null;
};

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
  async write(object: PackObject, timings?: PackTimings): Promise<void> {
    await this.writeBatch([object], timings);
  }

  /** Publish a bounded parser batch in one SQLite/KV transaction. */
  async writeBatch(batch: readonly PackObject[], timings?: PackTimings): Promise<void> {
    let pending = [...batch];

    while (pending.length > 0) {
      const prepared: PreparedPackWrite[] = [];
      for (const object of pending) {
        const hasIncomingRepresentation = object.compressed !== undefined;
        if (!hasIncomingRepresentation) {
          const readStarted = performance.now();
          const existing = await this.#stored(object.oid);
          if (timings !== undefined) {
            timings.storageReadMs += performance.now() - readStarted;
          }
          if (existing?.complete) {
            continue;
          }
          if (existing !== null) {
            await this.#discardIncomplete(existing);
          }
        }

        const objectChunks = chunkCount(object.bytes.length);
        const deltaChunks = object.delta === null ? 0 : chunkCount(object.delta.bytes.length);
        // A Pack reader supplies the exact zlib stream that arrived. Other writers
        // still get a reusable representation without having to know Pack syntax.
        const fullCompressed =
          object.delta === null
            ? (object.compressed ?? new Uint8Array(deflateSync(object.bytes)))
            : null;
        const deltaCompressed = object.delta === null ? null : (object.compressed ?? null);
        const compressedObjectChunks =
          fullCompressed === null ? 0 : chunkCount(fullCompressed.length);
        const compressedDeltaChunks =
          deltaCompressed === null ? 0 : chunkCount(deltaCompressed.length);
        let links: readonly ObjectLink[] = [];
        let linksIndexed = false;
        const linksStarted = performance.now();
        try {
          links = deduplicateLinks(linksToFetch(object.type, object.bytes));
          linksIndexed = true;
        } catch (error) {
          if (!(error instanceof ObjectParseError)) {
            throw error;
          }
        } finally {
          if (timings !== undefined) {
            timings.linkIndexMs += performance.now() - linksStarted;
          }
        }

        prepared.push({
          object,
          objectChunks,
          deltaChunks,
          fullCompressed,
          deltaCompressed,
          compressedObjectChunks,
          compressedDeltaChunks,
          links,
          linksIndexed,
          hasIncomingRepresentation,
          claimed: false,
        });
      }

      if (prepared.length === 0) {
        return;
      }

      try {
        const commitStarted = performance.now();
        try {
          await this.#db.transaction((tx) => {
            for (const write of prepared) {
              const { object } = write;
              const inserted = tx
                .insert(objects)
                .values({
                  oid: object.oid,
                  type: object.type,
                  size: object.bytes.length,
                  chunkCount: write.objectChunks,
                  compressedSize: write.fullCompressed?.length ?? null,
                  compressedChunkCount:
                    write.fullCompressed === null ? null : write.compressedObjectChunks,
                  linksIndexed: write.linksIndexed,
                  complete: false,
                })
                .onConflictDoNothing()
                .returning({ oid: objects.oid })
                .all();

              if (inserted.length === 0) {
                continue;
              }
              write.claimed = true;

              if (timings !== undefined) {
                timings.resolvedBytesStored += object.bytes.length;
                timings.compressedBytesStored +=
                  (write.fullCompressed?.length ?? 0) + (write.deltaCompressed?.length ?? 0);
                timings.deltaBytesStored += object.delta?.bytes.length ?? 0;
                timings.linksStored += write.links.length;
              }

              this.#writeChunks(OBJECT_PREFIX, object.oid, object.bytes);
              if (write.fullCompressed !== null) {
                this.#writeChunks(COMPRESSED_OBJECT_PREFIX, object.oid, write.fullCompressed);
              }

              if (object.delta !== null) {
                tx.insert(objectDeltas)
                  .values({
                    oid: object.oid,
                    baseOid: object.delta.baseOid,
                    size: object.delta.bytes.length,
                    chunkCount: write.deltaChunks,
                    compressedSize: write.deltaCompressed?.length ?? null,
                    compressedChunkCount:
                      write.deltaCompressed === null ? null : write.compressedDeltaChunks,
                  })
                  .run();

                this.#writeChunks(DELTA_PREFIX, object.oid, object.delta.bytes);
                if (write.deltaCompressed !== null) {
                  this.#writeChunks(COMPRESSED_DELTA_PREFIX, object.oid, write.deltaCompressed);
                }
              }

              for (let at = 0; at < write.links.length; at += OBJECT_LINK_INSERT_BATCH_SIZE) {
                tx.insert(objectLinks)
                  .values(
                    write.links.slice(at, at + OBJECT_LINK_INSERT_BATCH_SIZE).map((link) => ({
                      sourceOid: object.oid,
                      targetOid: link.oid,
                      targetType: link.type,
                    })),
                  )
                  .run();
              }

              tx.update(objects)
                .set({ complete: true })
                .where(and(eq(objects.oid, object.oid), eq(objects.complete, false)))
                .run();
            }
          });
        } finally {
          if (timings !== undefined) {
            timings.storageCommitMs += performance.now() - commitStarted;
          }
        }

        const retry: PackObject[] = [];
        for (const write of prepared) {
          if (write.claimed || !write.hasIncomingRepresentation) {
            continue;
          }
          const readStarted = performance.now();
          const existing = await this.#stored(write.object.oid);
          if (timings !== undefined) {
            timings.storageReadMs += performance.now() - readStarted;
          }
          if (existing !== null && !existing.complete) {
            await this.#discardIncomplete(existing);
            retry.push(write.object);
          }
        }
        pending = retry;
      } catch (error) {
        const storageExhausted = error instanceof Error && isStorageExhaustion(error);
        for (const write of prepared) {
          if (!write.claimed) {
            continue;
          }
          try {
            // Production KV rolls back with SQL. The marker keeps cleanup
            // discoverable for test stores and future adapters that do not.
            await this.#stageIncompleteWrite(
              write.object,
              write.objectChunks,
              write.deltaChunks,
              write.fullCompressed?.length ?? null,
              write.compressedObjectChunks,
              write.deltaCompressed?.length ?? null,
              write.compressedDeltaChunks,
              write.linksIndexed,
            );
          } catch {
            // Storage exhaustion can also prevent the recovery marker.
          }
          try {
            await this.#discardWrite(
              write.object.oid,
              write.objectChunks,
              write.deltaChunks,
              write.compressedObjectChunks,
              write.compressedDeltaChunks,
            );
          } catch {
            // Preserve the write failure; an incomplete row remains sweepable.
          }
        }
        if (storageExhausted) {
          throw new RepositoryStorageExhaustedError();
        }
        throw error;
      }
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

  /** Plan reusable entries in bounded SQL batches, once per Pack rather than once per Object. */
  async readPackMetadata(
    oids: readonly string[],
  ): Promise<ReadonlyMap<string, PackRepresentationMetadata>> {
    const metadata = new Map<string, PackRepresentationMetadata>();
    if (oids.length === 0) {
      return metadata;
    }

    const rows = await this.#db.all<{
      readonly oid: string;
      readonly type: ObjectRow["type"];
      readonly size: number;
      readonly fullCompressedSize: number | null;
      readonly fullCompressedChunkCount: number | null;
      readonly deltaBaseOid: string | null;
      readonly deltaSize: number | null;
      readonly deltaCompressedSize: number | null;
      readonly deltaCompressedChunkCount: number | null;
    }>(sql`
      with requested(oid) as (
        select value from json_each(${JSON.stringify(oids)})
      )
      select
        ${objects.oid} as oid,
        ${objects.type} as type,
        ${objects.size} as size,
        ${objects.compressedSize} as fullCompressedSize,
        ${objects.compressedChunkCount} as fullCompressedChunkCount,
        ${objectDeltas.baseOid} as deltaBaseOid,
        ${objectDeltas.size} as deltaSize,
        ${objectDeltas.compressedSize} as deltaCompressedSize,
        ${objectDeltas.compressedChunkCount} as deltaCompressedChunkCount
      from requested
      join ${objects}
        on ${objects.oid} = requested.oid
       and ${objects.complete} = true
      left join ${objectDeltas}
        on ${objectDeltas.oid} = ${objects.oid}
    `);

    for (const row of rows) {
      metadata.set(row.oid, {
        oid: row.oid,
        type: row.type,
        size: row.size,
        full:
          row.fullCompressedSize === null || row.fullCompressedChunkCount === null
            ? null
            : {
                size: row.fullCompressedSize,
                chunkCount: row.fullCompressedChunkCount,
              },
        delta:
          row.deltaBaseOid === null || row.deltaSize === null
            ? null
            : {
                baseOid: row.deltaBaseOid,
                size: row.deltaSize,
                compressed:
                  row.deltaCompressedSize === null || row.deltaCompressedChunkCount === null
                    ? null
                    : {
                        size: row.deltaCompressedSize,
                        chunkCount: row.deltaCompressedChunkCount,
                      },
              },
      });
    }
    return metadata;
  }

  /** Resolve only candidate Objects in a client's closure, inside SQLite's graph index. */
  async readReachableObjects(
    roots: ReadonlySet<string>,
    candidates: ReadonlySet<string>,
    shallow: ReadonlySet<string> = new Set(),
  ): Promise<ReadonlySet<string>> {
    if (roots.size === 0 || candidates.size === 0) {
      return new Set();
    }
    const rows = await this.#db.all<{ readonly oid: string }>(sql`
      with recursive
        client_roots(oid) as (
          select value from json_each(${JSON.stringify([...roots])})
        ),
        client_shallow(oid) as (
          select value from json_each(${JSON.stringify([...shallow])})
        ),
        reachable(oid) as (
          select oid from client_roots
          union
          select ${objectLinks.targetOid}
          from ${objectLinks}
          join reachable on ${objectLinks.sourceOid} = reachable.oid
          where ${objectLinks.targetType} <> 'commit'
             or not exists (
               select 1 from client_shallow where client_shallow.oid = reachable.oid
             )
        )
      select candidate.value as oid
      from json_each(${JSON.stringify([...candidates])}) as candidate
      join reachable on reachable.oid = candidate.value
      join ${objects} on ${objects.oid} = candidate.value and ${objects.complete} = true
    `);
    return new Set(rows.map(({ oid }) => oid));
  }

  /**
   * Resolve a complete indexed object closure in one SQLite graph walk.
   *
   * `null` means at least one reachable object is missing or predates the graph
   * index, so callers must fall back to reading and parsing Objects. Objects in
   * `stopAt` are client-owned boundaries: they are neither returned nor walked.
   */
  async readObjectClosure(
    roots: ReadonlySet<string>,
    stopAt: ReadonlySet<string> = new Set(),
    shallow: ReadonlySet<string> = new Set(),
  ): Promise<readonly string[] | null> {
    if (roots.size === 0) {
      return [];
    }
    const rows = await this.#db.all<{
      readonly oid: string;
      readonly complete: number | boolean | null;
      readonly linksIndexed: number | boolean | null;
    }>(sql`
      with recursive
        closure_roots(oid) as (
          select value from json_each(${JSON.stringify([...roots])})
        ),
        closure_stops(oid) as (
          select value from json_each(${JSON.stringify([...stopAt])})
        ),
        closure_shallow(oid) as (
          select value from json_each(${JSON.stringify([...shallow])})
        ),
        reachable(oid) as (
          select closure_roots.oid
          from closure_roots
          where not exists (
            select 1 from closure_stops where closure_stops.oid = closure_roots.oid
          )
          union
          select ${objectLinks.targetOid}
          from reachable
          join ${objects}
            on ${objects.oid} = reachable.oid
           and ${objects.complete} = true
           and ${objects.linksIndexed} = true
          join ${objectLinks}
            on ${objectLinks.sourceOid} = reachable.oid
          where not exists (
            select 1
            from closure_stops
            where closure_stops.oid = ${objectLinks.targetOid}
          )
            and (
              ${objectLinks.targetType} <> 'commit'
              or not exists (
                select 1 from closure_shallow where closure_shallow.oid = reachable.oid
              )
            )
        )
      select
        reachable.oid as oid,
        ${objects.complete} as complete,
        ${objects.linksIndexed} as linksIndexed
      from reachable
      left join ${objects} on ${objects.oid} = reachable.oid
    `);
    if (
      rows.some(
        (row) =>
          (row.complete !== true && row.complete !== 1) ||
          (row.linksIndexed !== true && row.linksIndexed !== 1),
      )
    ) {
      return null;
    }
    return rows.map(({ oid }) => oid);
  }

  /** Read one already-planned representation using only synchronous KV lookups. */
  readCachedPackEntry(
    metadata: PackRepresentationMetadata,
    preferredBaseOid: string | null,
  ): CachedPackEntry | null {
    const selected = selectCachedPackEntry({ metadata, preferredBaseOid });
    return selected === null
      ? null
      : {
          ...selected.entry,
          compressed: this.#readChunks(
            selected.prefix,
            selected.oid,
            selected.size,
            selected.chunkCount,
          ),
        };
  }

  /** Fetch explicit representation chunks through Durable Object KV's multi-get API. */
  async readCachedPackEntries(
    requests: readonly CachedPackEntryRequest[],
  ): Promise<ReadonlyMap<string, CachedPackEntry>> {
    if (this.#kv.getMany === undefined) {
      return new Map(
        requests.flatMap((request) => {
          const entry = this.readCachedPackEntry(request.metadata, request.preferredBaseOid);
          return entry === null ? [] : ([[request.metadata.oid, entry]] as const);
        }),
      );
    }

    const selected = requests.flatMap((request) => {
      const entry = selectCachedPackEntry(request);
      return entry === null ? [] : [entry];
    });
    const keys = selected.flatMap((entry) =>
      Array.from({ length: entry.chunkCount }, (_, index) =>
        chunkKey(entry.prefix, entry.oid, index),
      ),
    );
    const chunks = new Map<string, Uint8Array>();
    for (let at = 0; at < keys.length; at += 128) {
      const read = await this.#kv.getMany<Uint8Array>(keys.slice(at, at + 128));
      for (const [key, value] of read) {
        chunks.set(key, value);
      }
    }

    const entries = new Map<string, CachedPackEntry>();
    for (const selection of selected) {
      const compressed = this.#readChunksFrom(
        selection.prefix,
        selection.oid,
        selection.size,
        selection.chunkCount,
        (key) => chunks.get(key),
      );
      entries.set(selection.oid, { ...selection.entry, compressed });
    }
    return entries;
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

  async #stageIncompleteWrite(
    object: PackObject,
    objectChunks: number,
    deltaChunks: number,
    compressedObjectSize: number | null,
    compressedObjectChunks: number,
    compressedDeltaSize: number | null,
    compressedDeltaChunks: number,
    linksIndexed: boolean,
  ): Promise<void> {
    await this.#db.transaction((tx) => {
      tx.insert(objects)
        .values({
          oid: object.oid,
          type: object.type,
          size: object.bytes.length,
          chunkCount: objectChunks,
          compressedSize: compressedObjectSize,
          compressedChunkCount: compressedObjectSize === null ? null : compressedObjectChunks,
          linksIndexed,
          complete: false,
        })
        .onConflictDoNothing()
        .run();
      if (object.delta !== null) {
        tx.insert(objectDeltas)
          .values({
            oid: object.oid,
            baseOid: object.delta.baseOid,
            size: object.delta.bytes.length,
            chunkCount: deltaChunks,
            compressedSize: compressedDeltaSize,
            compressedChunkCount: compressedDeltaSize === null ? null : compressedDeltaChunks,
          })
          .onConflictDoNothing()
          .run();
      }
    });
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
    return this.#readChunksFrom(prefix, oid, size, count, (key) => this.#kv.get<Uint8Array>(key));
  }

  #readChunksFrom(
    prefix: string,
    oid: string,
    size: number,
    count: number,
    readChunk: (key: string) => Uint8Array | undefined,
  ): Uint8Array {
    const bytes = new Uint8Array(size);
    let at = 0;

    for (let index = 0; index < count; index += 1) {
      const key = chunkKey(prefix, oid, index);
      const chunk = readChunk(key);

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
