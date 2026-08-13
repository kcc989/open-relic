import { eq, sql } from "drizzle-orm";

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

export interface ReclaimedObject {
  readonly objects: 1;
  readonly chunks: number;
  /** Inflated object bytes plus persisted delta bytes; storage overhead is excluded. */
  readonly bytes: number;
}

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
    const inserted = await this.#db
      .insert(objects)
      .values({
        oid: object.oid,
        type: object.type,
        size: object.bytes.length,
        chunkCount: chunkCount(object.bytes.length),
      })
      .onConflictDoNothing()
      .returning({ oid: objects.oid });

    if (inserted.length === 0) {
      return;
    }

    this.#writeChunks(OBJECT_PREFIX, object.oid, object.bytes);

    if (object.delta !== null) {
      await this.#db.insert(objectDeltas).values({
        oid: object.oid,
        baseOid: object.delta.baseOid,
        size: object.delta.bytes.length,
        chunkCount: chunkCount(object.delta.bytes.length),
      });

      this.#writeChunks(DELTA_PREFIX, object.oid, object.delta.bytes);
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

  async describe(oid: string): Promise<ObjectRow | null> {
    const rows = await this.#db.select().from(objects).where(eq(objects.oid, oid)).limit(1);

    return rows[0] ?? null;
  }

  async has(oid: string): Promise<boolean> {
    return (await this.describe(oid)) !== null;
  }

  /** `null` when the object arrived whole rather than as a delta. */
  async readDelta(oid: string): Promise<PackDelta | null> {
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
