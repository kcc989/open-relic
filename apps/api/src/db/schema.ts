import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Every namespace in the installation, stored in the SQLite database of the
 * single `NamespaceRegistryObject`.
 *
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
