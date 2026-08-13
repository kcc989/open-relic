import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The slug is the primary key, which is what makes claiming one a single
 * `INSERT ... ON CONFLICT DO NOTHING` rather than a read-then-write race.
 * Timestamps are ISO-8601 text so the row can be handed to the API unchanged.
 */
export const namespaces = sqliteTable("namespaces", {
  slug: text("slug").primaryKey(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type NamespaceRow = typeof namespaces.$inferSelect;
export type NewNamespaceRow = typeof namespaces.$inferInsert;

/**
 * The pointer to a repository, not the repository: `durable_object_id` is the
 * stringified id of the `RepositoryObject` that holds its contents, so naming
 * lives here alone and a future rename moves no Git data.
 *
 * `(namespace_slug, name)` is the primary key for the same reason the namespace
 * slug is: claiming a name is then a single `ON CONFLICT DO NOTHING`.
 *
 * `default_branch` is denormalized from the repository object's `HEAD` so that
 * listing a namespace stays one query instead of a fan-out of RPCs. The
 * repository object stays authoritative; both are written on create.
 */
export const repositories = sqliteTable(
  "repositories",
  {
    namespaceSlug: text("namespace_slug")
      .notNull()
      .references(() => namespaces.slug, { onDelete: "cascade" }),
    name: text("name").notNull(),
    durableObjectId: text("durable_object_id").notNull(),
    description: text("description"),
    defaultBranch: text("default_branch").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [primaryKey({ columns: [table.namespaceSlug, table.name] })],
);

export type RepositoryRow = typeof repositories.$inferSelect;
export type NewRepositoryRow = typeof repositories.$inferInsert;
