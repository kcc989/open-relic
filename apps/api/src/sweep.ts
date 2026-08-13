import { asc, eq, isNull, sql } from "drizzle-orm";

import { linksToReach } from "./connectivity.ts";
import type { SyncSqliteDatabase } from "./db/database.ts";
import {
  REPOSITORY_STATE_ID,
  SWEEP_STATE_ID,
  objects,
  refs,
  repositoryState,
  sweepReachable,
  sweepState,
  type SweepStateRow,
} from "./db/repository-schema.ts";
import { ObjectStore } from "./object-store.ts";

/** One alarm turn stays bounded even when a repository contains millions of objects. */
export const SWEEP_BATCH_SIZE = 64;

/** Durable Object SQLite rejects statements that bind more values than this. */
const SQLITE_MAX_BOUND_VALUES = 100;
/** `oid`, `expected_type`, and `pending` are bound for every reachable row. */
const SWEEP_REACHABLE_BOUND_VALUES_PER_ROW = 3;
const SWEEP_REACHABLE_INSERT_BATCH_SIZE = Math.floor(
  SQLITE_MAX_BOUND_VALUES / SWEEP_REACHABLE_BOUND_VALUES_PER_ROW,
);

export interface SweepProgress {
  readonly phase: "mark" | "sweep" | "complete";
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly reachableObjects: number;
  readonly reclaimedObjects: number;
  readonly reclaimedChunks: number;
  /** Inflated object bytes plus persisted delta bytes; storage overhead is excluded. */
  readonly reclaimedBytes: number;
}

export class SweepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepError";
  }
}

/**
 * A persisted mark-and-sweep over one repository. Each call advances at most
 * one batch, so an alarm can resume after eviction, retry, or a CPU boundary.
 */
export class RepositorySweeper {
  readonly #db: SyncSqliteDatabase;
  readonly #objects: ObjectStore;

  constructor(db: SyncSqliteDatabase, objects: ObjectStore) {
    this.#db = db;
    this.#objects = objects;
  }

  async step(batchSize: number = SWEEP_BATCH_SIZE): Promise<SweepProgress> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new RangeError("A sweep batch size must be a positive safe integer.");
    }

    const refVersion = await this.#refVersion();
    let state = await this.#state();

    if (state === null || state.phase === "complete") {
      state = await this.#reset(refVersion, null);
    } else if (state.refVersion !== refVersion) {
      // A push landed between batches. Nothing may be deleted against the old
      // ref snapshot; preserve reclamation totals and walk the new roots first.
      state = await this.#reset(refVersion, state);
    }

    if (state.phase === "mark") {
      await this.#mark(batchSize);
    } else {
      await this.#sweep(batchSize);
    }

    const current = await this.#state();
    if (current === null) {
      throw new SweepError("A sweep lost its durable checkpoint.");
    }
    return this.#progress(current);
  }

  async #refVersion(): Promise<number> {
    const [row] = await this.#db
      .select({ refVersion: repositoryState.refVersion })
      .from(repositoryState)
      .where(eq(repositoryState.id, REPOSITORY_STATE_ID))
      .limit(1);

    return row?.refVersion ?? 0;
  }

  async #state(): Promise<SweepStateRow | null> {
    const [row] = await this.#db
      .select()
      .from(sweepState)
      .where(eq(sweepState.id, SWEEP_STATE_ID))
      .limit(1);

    return row ?? null;
  }

  async #reset(refVersion: number, previous: SweepStateRow | null): Promise<SweepStateRow> {
    const roots = await this.#db.select({ oid: refs.objectId }).from(refs);
    const startedAt = previous?.startedAt ?? new Date().toISOString();

    await this.#db.transaction((tx) => {
      tx.delete(sweepReachable).run();
      tx.insert(sweepState)
        .values({
          id: SWEEP_STATE_ID,
          phase: "mark",
          refVersion,
          startedAt,
          completedAt: null,
          reachableObjects: 0,
          reclaimedObjects: previous?.reclaimedObjects ?? 0,
          reclaimedChunks: previous?.reclaimedChunks ?? 0,
          reclaimedBytes: previous?.reclaimedBytes ?? 0,
        })
        .onConflictDoUpdate({
          target: sweepState.id,
          set: {
            phase: "mark",
            refVersion,
            startedAt,
            completedAt: null,
            reachableObjects: 0,
            reclaimedObjects: previous?.reclaimedObjects ?? 0,
            reclaimedChunks: previous?.reclaimedChunks ?? 0,
            reclaimedBytes: previous?.reclaimedBytes ?? 0,
          },
        })
        .run();

      if (roots.length > 0) {
        for (let at = 0; at < roots.length; at += SWEEP_REACHABLE_INSERT_BATCH_SIZE) {
          tx.insert(sweepReachable)
            .values(
              roots.slice(at, at + SWEEP_REACHABLE_INSERT_BATCH_SIZE).map(({ oid }) => ({
                oid,
                expectedType: null,
                pending: true,
              })),
            )
            .onConflictDoNothing()
            .run();
        }
      }
    });

    const state = await this.#state();
    if (state === null) {
      throw new SweepError("A sweep could not persist its starting checkpoint.");
    }
    return state;
  }

  async #mark(batchSize: number): Promise<void> {
    const pending = await this.#db
      .select({ oid: sweepReachable.oid, expectedType: sweepReachable.expectedType })
      .from(sweepReachable)
      .where(eq(sweepReachable.pending, true))
      .orderBy(asc(sweepReachable.oid))
      .limit(batchSize);

    for (const { oid, expectedType } of pending) {
      const description = await this.#objects.describe(oid);

      if (description === null) {
        // Receive-pack deliberately does not require blobs named by trees to
        // be present. Their names are reachable, but there is no stored object
        // or outgoing edge to inspect and nothing for the sweep to reclaim.
        if (expectedType === "blob") {
          await this.#finishMark(oid, []);
          continue;
        }
        throw new SweepError(`Reachable object ${oid} is missing.`);
      }

      // A blob has no outgoing links. Its row is enough to mark it; reading
      // chunks here would pull nearly all repository bytes out of storage only
      // to discard them.
      if (description.type === "blob") {
        await this.#finishMark(oid, []);
        continue;
      }

      const object = await this.#objects.read(oid);
      if (object === null) {
        throw new SweepError(`Reachable object ${oid} disappeared while it was being marked.`);
      }
      const links = linksToReach(object.type, object.bytes);
      await this.#finishMark(oid, links);
    }

    const [left] = await this.#db
      .select({ oid: sweepReachable.oid })
      .from(sweepReachable)
      .where(eq(sweepReachable.pending, true))
      .limit(1);

    if (left === undefined) {
      await this.#db
        .update(sweepState)
        .set({ phase: "sweep" })
        .where(eq(sweepState.id, SWEEP_STATE_ID));
    }
  }

  async #finishMark(oid: string, links: ReturnType<typeof linksToReach>): Promise<void> {
    await this.#db.transaction((tx) => {
      if (links.length > 0) {
        for (let at = 0; at < links.length; at += SWEEP_REACHABLE_INSERT_BATCH_SIZE) {
          tx.insert(sweepReachable)
            .values(
              links.slice(at, at + SWEEP_REACHABLE_INSERT_BATCH_SIZE).map((link) => ({
                oid: link.oid,
                expectedType: link.type,
                pending: true,
              })),
            )
            .onConflictDoUpdate({
              target: sweepReachable.oid,
              set: {
                expectedType: sql`coalesce(${sweepReachable.expectedType}, excluded.expected_type)`,
              },
            })
            .run();
        }
      }
      tx.update(sweepReachable).set({ pending: false }).where(eq(sweepReachable.oid, oid)).run();
      tx.update(sweepState)
        .set({ reachableObjects: sql`${sweepState.reachableObjects} + 1` })
        .where(eq(sweepState.id, SWEEP_STATE_ID))
        .run();
    });
  }

  async #sweep(batchSize: number): Promise<void> {
    const unreachable = await this.#db
      .select({ oid: objects.oid })
      .from(objects)
      .leftJoin(sweepReachable, eq(objects.oid, sweepReachable.oid))
      .where(isNull(sweepReachable.oid))
      .orderBy(asc(objects.oid))
      .limit(batchSize);

    for (const { oid } of unreachable) {
      await this.#objects.reclaim(oid);
    }

    const [left] = await this.#db
      .select({ oid: objects.oid })
      .from(objects)
      .leftJoin(sweepReachable, eq(objects.oid, sweepReachable.oid))
      .where(isNull(sweepReachable.oid))
      .limit(1);

    if (left === undefined) {
      await this.#db.transaction((tx) => {
        tx.delete(sweepReachable).run();
        tx.update(sweepState)
          .set({ phase: "complete", completedAt: new Date().toISOString() })
          .where(eq(sweepState.id, SWEEP_STATE_ID))
          .run();
      });
    }
  }

  #progress(state: SweepStateRow): SweepProgress {
    return {
      phase: state.phase,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      reachableObjects: state.reachableObjects,
      reclaimedObjects: state.reclaimedObjects,
      reclaimedChunks: state.reclaimedChunks,
      reclaimedBytes: state.reclaimedBytes,
    };
  }
}
