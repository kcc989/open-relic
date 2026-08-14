import { deflateSync } from "node:zlib";

import { and, asc, eq, gt } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import {
  REPACK_STATE_ID,
  REPOSITORY_STATE_ID,
  SWEEP_STATE_ID,
  objects,
  repackCandidates,
  repackState,
  repositoryState,
  sweepReachable,
  sweepState,
} from "./db/repository-schema.ts";
import { ObjectStore, RepositoryStorageExhaustedError } from "./object-store.ts";

/** One alarm turn reads and compares only a bounded number of objects. */
export const REPACK_BATCH_SIZE = 8;
/** Reserve 32 MiB of the Durable Object's 128 MiB ceiling for runtime overhead. */
export const REPACK_DELTA_MEMORY_BUDGET_BYTES = 96 * 1_024 * 1_024;

export interface RepackProgress {
  readonly phase: "waiting" | "select" | "complete";
  readonly processedObjects: number;
  readonly selectedDeltas: number;
  /** True only on the turn that durably transitions this ref version to complete. */
  readonly justCompleted: boolean;
}

const deltaVarint = (value: number): Uint8Array => {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value > 0);
  return Uint8Array.from(bytes);
};

const copyInstruction = (offset: number, size: number): Uint8Array => {
  let opcode = 0x80;
  const operands: number[] = [];
  for (let at = 0; at < 4; at += 1) {
    const byte = (offset >>> (at * 8)) & 0xff;
    if (byte !== 0) {
      opcode |= 1 << at;
      operands.push(byte);
    }
  }
  for (let at = 0; at < 3; at += 1) {
    const byte = Math.floor(size / 2 ** (at * 8)) & 0xff;
    if (byte !== 0) {
      opcode |= 1 << (at + 4);
      operands.push(byte);
    }
  }
  return Uint8Array.from([opcode, ...operands]);
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};

/**
 * A deliberately bounded delta builder: reuse the common prefix and suffix,
 * and insert the changed middle. Compression decides whether that candidate is
 * actually cheaper than the immutable full-entry cache.
 */
export const buildRepackDelta = (base: Uint8Array, target: Uint8Array): Uint8Array => {
  let prefix = 0;
  while (prefix < base.length && prefix < target.length && base[prefix] === target[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < target.length - prefix &&
    base[base.length - suffix - 1] === target[target.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const instructions: Uint8Array[] = [deltaVarint(base.length), deltaVarint(target.length)];
  const copy = (offset: number, length: number): void => {
    for (let left = length, at = offset; left > 0;) {
      const size = Math.min(left, 0xff_ffff);
      instructions.push(copyInstruction(at, size));
      at += size;
      left -= size;
    }
  };
  if (prefix > 0) {
    copy(0, prefix);
  }
  for (let at = prefix; at < target.length - suffix; at += 0x7f) {
    const inserted = target.subarray(at, Math.min(target.length - suffix, at + 0x7f));
    instructions.push(Uint8Array.of(inserted.length), inserted);
  }
  if (suffix > 0) {
    copy(base.length - suffix, suffix);
  }
  return concat(instructions);
};

const bucketFor = (type: string, size: number): string =>
  `${type}:${Math.floor(Math.log2(Math.max(1, size)))}`;

const deltaSizeUpperBound = (targetSize: number): number =>
  targetSize + Math.ceil(targetSize / 0x7f) + 32;

const deflateSizeUpperBound = (size: number): number =>
  size + Math.ceil(size / 4_096) + Math.ceil(size / 16_384) + Math.ceil(size / 33_554_432) + 13;

/** Bytes retained while resolving two objects and building plus compressing their candidate Delta. */
export const estimateRepackDeltaMemory = (baseSize: number, targetSize: number): number => {
  const deltaSize = deltaSizeUpperBound(targetSize);
  return baseSize + targetSize + deltaSize + deflateSizeUpperBound(deltaSize);
};

/** Bounded, resumable full-entry backfill and delta selection over the latest sweep index. */
export class RepositoryRepacker {
  readonly #db: SyncSqliteDatabase;
  readonly #objects: ObjectStore;

  constructor(db: SyncSqliteDatabase, objects: ObjectStore) {
    this.#db = db;
    this.#objects = objects;
  }

  async step(batchSize: number = REPACK_BATCH_SIZE): Promise<RepackProgress> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new RangeError("A repack batch size must be a positive safe integer.");
    }

    const [repository] = await this.#db
      .select({ refVersion: repositoryState.refVersion })
      .from(repositoryState)
      .where(eq(repositoryState.id, REPOSITORY_STATE_ID))
      .limit(1);
    const [sweep] = await this.#db
      .select({ phase: sweepState.phase, refVersion: sweepState.refVersion })
      .from(sweepState)
      .where(eq(sweepState.id, SWEEP_STATE_ID))
      .limit(1);

    if (
      repository === undefined ||
      sweep?.phase !== "complete" ||
      sweep.refVersion !== repository.refVersion
    ) {
      return { phase: "waiting", processedObjects: 0, selectedDeltas: 0, justCompleted: false };
    }

    let [state] = await this.#db
      .select()
      .from(repackState)
      .where(eq(repackState.id, REPACK_STATE_ID))
      .limit(1);
    if (state === undefined || state.refVersion !== repository.refVersion) {
      await this.#db.transaction((tx) => {
        tx.delete(repackCandidates).run();
        tx.insert(repackState)
          .values({ id: REPACK_STATE_ID, refVersion: repository.refVersion })
          .onConflictDoUpdate({
            target: repackState.id,
            set: { refVersion: repository.refVersion, cursor: null, completedAt: null },
          })
          .run();
      });
      [state] = await this.#db
        .select()
        .from(repackState)
        .where(eq(repackState.id, REPACK_STATE_ID))
        .limit(1);
    }
    if (state?.completedAt !== null && state?.completedAt !== undefined) {
      return { phase: "complete", processedObjects: 0, selectedDeltas: 0, justCompleted: false };
    }

    const rows = await this.#db
      .select({ oid: objects.oid, type: objects.type, size: objects.size })
      .from(sweepReachable)
      .innerJoin(objects, eq(sweepReachable.oid, objects.oid))
      .where(
        and(
          eq(sweepReachable.pending, false),
          eq(objects.complete, true),
          state?.cursor === null || state?.cursor === undefined
            ? undefined
            : gt(objects.oid, state.cursor),
        ),
      )
      .orderBy(asc(objects.oid))
      .limit(batchSize);

    let selectedDeltas = 0;
    for (const row of rows) {
      await this.#objects.indexLinks(row.oid);
      const fullCompressedSize = await this.#objects.ensureFullPackEntry(row.oid);
      if (fullCompressedSize === null) {
        continue;
      }
      const existingBase = await this.#objects.readDeltaBase(row.oid);
      if (existingBase !== null) {
        await this.#objects.ensureDeltaPackEntry(row.oid);
      }
      const bucket = bucketFor(row.type, row.size);
      const [candidate] = await this.#db
        .select({ oid: repackCandidates.oid, size: objects.size })
        .from(repackCandidates)
        .innerJoin(objects, eq(repackCandidates.oid, objects.oid))
        .where(eq(repackCandidates.bucket, bucket))
        .limit(1);
      let selected = false;

      if (
        existingBase === null &&
        candidate !== undefined &&
        candidate.oid !== row.oid &&
        estimateRepackDeltaMemory(candidate.size, row.size) <= REPACK_DELTA_MEMORY_BUDGET_BYTES
      ) {
        const [base, target] = await Promise.all([
          this.#objects.read(candidate.oid),
          this.#objects.read(row.oid),
        ]);
        if (base !== null && target !== null && base.type === target.type) {
          const delta = buildRepackDelta(base.bytes, target.bytes);
          const compressed = new Uint8Array(deflateSync(delta));
          if (compressed.length + 20 < fullCompressedSize * 0.875) {
            try {
              await this.#objects.installDelta(
                row.oid,
                { baseOid: candidate.oid, bytes: delta },
                compressed,
              );
              selected = true;
              selectedDeltas += 1;
            } catch (error) {
              if (!(error instanceof RepositoryStorageExhaustedError)) {
                throw error;
              }
            }
          }
        }
      }

      if (existingBase === null && !selected) {
        await this.#db
          .insert(repackCandidates)
          .values({ bucket, oid: row.oid })
          .onConflictDoUpdate({ target: repackCandidates.bucket, set: { oid: row.oid } });
      }
    }

    const cursor = rows.at(-1)?.oid ?? state?.cursor ?? null;
    const complete = rows.length < batchSize;
    await this.#db
      .update(repackState)
      .set({ cursor, completedAt: complete ? new Date().toISOString() : null })
      .where(eq(repackState.id, REPACK_STATE_ID));

    return {
      phase: complete ? "complete" : "select",
      processedObjects: rows.length,
      selectedDeltas,
      justCompleted: complete,
    };
  }
}
