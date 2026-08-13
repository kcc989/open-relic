import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The single row every `RepositoryObject` holds about itself.
 *
 * Deliberately no namespace or name: the registry owns the naming, and a
 * repository object that also stored its name would be a second source of
 * truth for it. Nor is HEAD here — it lives in the object's KV storage as the
 * literal contents of the Git file, so that a detached HEAD is expressible and
 * there is one authority for it rather than a column beside it (ADR-0003).
 *
 * What is left is the row's existence, which is what makes a repository object
 * initialized, and the creation time it shares with its index entry. Refs and
 * objects join it here when the Git engine lands.
 */
export const repositoryState = sqliteTable("repository_state", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
});

/**
 * Primary key of the one row in {@link repositoryState}. A Durable Object is
 * already scoped to a single repository, so the table is a singleton and the
 * key exists only to make "upsert the state" expressible.
 */
export const REPOSITORY_STATE_ID = "repository";

export type RepositoryStateRow = typeof repositoryState.$inferSelect;
