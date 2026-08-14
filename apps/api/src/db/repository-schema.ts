import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { OBJECT_TYPES } from "../object.ts";

/**
 * Deliberately no namespace or name: the registry owns naming. Nor HEAD — that
 * lives in the object's KV storage as the literal Git file, so a detached HEAD
 * is expressible and there is one authority for it (ADR-0003).
 *
 * What is left is the row's existence, which is what marks the object
 * initialized, and the creation time it shares with its index entry.
 */
export const repositoryState = sqliteTable("repository_state", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  /** Incremented with every accepted ref transaction so a sweep can detect a stale walk. */
  refVersion: integer("ref_version").notNull().default(0),
});

/**
 * The object is already scoped to one repository, so the table is a singleton;
 * the key exists only to make "upsert the state" expressible.
 */
export const REPOSITORY_STATE_ID = "repository";

export type RepositoryStateRow = typeof repositoryState.$inferSelect;

/**
 * The repository's refs, full name (`refs/heads/main`) to object id. A table
 * rather than Git's loose files plus `packed-refs`, because the only reason
 * that split exists is a filesystem, and because a push has to move several
 * refs in one transaction.
 *
 * HEAD is not here: it is the one ref-shaped thing Git keeps outside the ref
 * store, and it stays outside ours too (ADR-0003).
 */
export const refs = sqliteTable("refs", {
  name: text("name").primaryKey(),
  objectId: text("object_id").notNull(),
});

export type RefRow = typeof refs.$inferSelect;

/**
 * Commits whose parents are intentionally absent after a shallow import. Git's
 * `$GIT_DIR/shallow` file carries the same set in a filesystem repository.
 */
export const shallowCommits = sqliteTable("shallow_commits", {
  oid: text("oid").primaryKey(),
});

/**
 * One row per Git object, with the bytes themselves in the KV half under
 * `o:<oid>:<n>` (ADR-0002). `chunk_count` is what tells a read how many keys to
 * ask for, so the row and the chunks are only meaningful together.
 */
export const objects = sqliteTable("objects", {
  oid: text("oid").primaryKey(),
  type: text("type", { enum: OBJECT_TYPES }).notNull(),
  size: integer("size").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  /** Readers ignore a row until every resolved and retained-delta chunk exists. */
  complete: integer("complete", { mode: "boolean" }).notNull().default(true),
});

export type ObjectRow = typeof objects.$inferSelect;

/**
 * The delta an object arrived as, when it arrived as one, chunked under
 * `d:<oid>:<n>`. Nothing reads it until fetch lands; it is here because the
 * pack passes through our hands exactly once (ADR-0002).
 */
export const objectDeltas = sqliteTable("object_deltas", {
  oid: text("oid")
    .primaryKey()
    .references(() => objects.oid, { onDelete: "cascade" }),
  baseOid: text("base_oid").notNull(),
  size: integer("size").notNull(),
  chunkCount: integer("chunk_count").notNull(),
});

export type ObjectDeltaRow = typeof objectDeltas.$inferSelect;

export const SWEEP_PHASES = ["mark", "sweep", "complete"] as const;

/**
 * The durable checkpoint for one repository sweep. A completed row is retained
 * as the repository's latest reclamation report; the next sweep replaces it.
 */
export const sweepState = sqliteTable("sweep_state", {
  id: text("id").primaryKey(),
  phase: text("phase", { enum: SWEEP_PHASES }).notNull(),
  refVersion: integer("ref_version").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  reachableObjects: integer("reachable_objects").notNull().default(0),
  reclaimedObjects: integer("reclaimed_objects").notNull().default(0),
  reclaimedChunks: integer("reclaimed_chunks").notNull().default(0),
  reclaimedBytes: integer("reclaimed_bytes").notNull().default(0),
});

export const SWEEP_STATE_ID = "sweep";

export type SweepStateRow = typeof sweepState.$inferSelect;

/**
 * The persisted mark set and work queue. Row presence means reachable; pending
 * says that object's outgoing links still need to be walked.
 */
export const sweepReachable = sqliteTable("sweep_reachable", {
  oid: text("oid").primaryKey(),
  /** Null only for a ref root, whose type is learned from its own metadata. */
  expectedType: text("expected_type", { enum: OBJECT_TYPES }),
  pending: integer("pending", { mode: "boolean" }).notNull(),
});
