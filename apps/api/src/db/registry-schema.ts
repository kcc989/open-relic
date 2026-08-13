import {
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
 *
 * `id` is the API's opaque handle for the repository — what a delete answers
 * with. It is not the `durable_object_id`: naming and storage are already
 * separate here, and a public id that was a function of the object holding the
 * bytes would tie the two back together.
 */
export const repositories = sqliteTable(
  "repositories",
  {
    namespaceSlug: text("namespace_slug")
      .notNull()
      .references(() => namespaces.slug, { onDelete: "cascade" }),
    name: text("name").notNull(),
    id: text("id").notNull(),
    durableObjectId: text("durable_object_id").notNull(),
    description: text("description"),
    defaultBranch: text("default_branch").notNull(),
    /** Refused by the Git surface on push; the REST surface only reports it. */
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(false),
    /** The remote an import copied from; `null` for a repository created here. */
    source: text("source"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** `null` until the first push lands, which is what Artifacts reports. */
    lastPushAt: text("last_push_at"),
  },
  (table) => [
    primaryKey({ columns: [table.namespaceSlug, table.name] }),
    uniqueIndex("repositories_id_unique").on(table.id),
  ],
);

export type RepositoryRow = typeof repositories.$inferSelect;
export type NewRepositoryRow = typeof repositories.$inferInsert;

/**
 * Repo-scoped Git tokens live with the registry because authorization happens
 * before a repository object is resolved. Only a SHA-256 digest of the secret
 * is stored; the plaintext exists long enough to cross the creation response
 * once and cannot be recovered by list or revoke.
 */
export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    namespaceSlug: text("namespace_slug").notNull(),
    repositoryName: text("repository_name").notNull(),
    secretHash: text("secret_hash").notNull(),
    scope: text("scope", { enum: ["read", "write"] }).notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    expiresAtUnix: integer("expires_at_unix").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.namespaceSlug, table.repositoryName],
      foreignColumns: [repositories.namespaceSlug, repositories.name],
      name: "tokens_repository_fk",
    }).onDelete("cascade"),
    uniqueIndex("tokens_secret_hash_unique").on(table.secretHash),
  ],
);

export type TokenRow = typeof tokens.$inferSelect;
