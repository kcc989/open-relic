import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
