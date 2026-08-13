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
});

/**
 * The object is already scoped to one repository, so the table is a singleton;
 * the key exists only to make "upsert the state" expressible.
 */
export const REPOSITORY_STATE_ID = "repository";

export type RepositoryStateRow = typeof repositoryState.$inferSelect;

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
