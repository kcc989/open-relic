import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The single row every `RepositoryObject` holds about itself.
 *
 * Deliberately no namespace or name: the registry owns the naming, and a
 * repository object that also stored its name would be a second source of
 * truth for it. What lives here is Git state — `default_branch` is the target
 * of `HEAD`, which a bare repository has from the moment it is initialized and
 * before it has a single ref. Refs and objects join it here when the Git engine
 * lands.
 */
export const repositoryState = sqliteTable("repository_state", {
  id: text("id").primaryKey(),
  defaultBranch: text("default_branch").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * Primary key of the one row in {@link repositoryState}. A Durable Object is
 * already scoped to a single repository, so the table is a singleton and the
 * key exists only to make "upsert the state" expressible.
 */
export const REPOSITORY_STATE_ID = "repository";

export type RepositoryStateRow = typeof repositoryState.$inferSelect;
