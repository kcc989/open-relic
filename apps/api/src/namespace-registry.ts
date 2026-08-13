import type { NamespaceInfo } from "@open-relic/contracts";
import { asc, eq, gt } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import { namespaces, repositories, type NamespaceRow } from "./db/registry-schema.ts";

export interface CreateNamespaceCommand {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
}

/**
 * A taken slug is data, not an exception: a thrown error would arrive across
 * the Durable Object RPC boundary as an opaque string.
 */
export type CreateNamespaceOutcome =
  | { readonly created: true; readonly namespace: NamespaceInfo }
  | { readonly created: false; readonly reason: "slug-taken" };

export interface ListNamespacesQuery {
  readonly limit: number;
  /**
   * The slug to resume after — the position, not a wire cursor. The route is
   * what encodes this into a string a client can hold.
   */
  readonly after: string | null;
}

export interface NamespacePage {
  readonly namespaces: readonly NamespaceInfo[];
  /** The slug the next page resumes after; `null` once the walk has finished. */
  readonly next: string | null;
}

/**
 * The dropped repositories' object ids come back so the caller can destroy
 * their storage — only it holds the `REPOSITORIES` binding.
 */
export interface DeleteNamespaceOutcome {
  readonly deleted: boolean;
  readonly repositoryObjectIds: readonly string[];
}

export interface NamespaceRegistryClient {
  readonly createNamespace: (command: CreateNamespaceCommand) => Promise<CreateNamespaceOutcome>;
  readonly listNamespaces: (query: ListNamespacesQuery) => Promise<NamespacePage>;
  readonly getNamespace: (slug: string) => Promise<NamespaceInfo | null>;
  readonly deleteNamespace: (slug: string) => Promise<DeleteNamespaceOutcome>;
}

const toNamespace = (row: NamespaceRow): NamespaceInfo => ({
  slug: row.slug,
  display_name: row.displayName,
  description: row.description,
  created_at: row.createdAt,
});

/**
 * {@link NamespaceRegistryObject} is a thin Durable Object shell around this
 * class, which is what lets the tests run the real queries against the real
 * migrations without a Workers runtime.
 */
export class NamespaceRegistry {
  readonly #db: SyncSqliteDatabase;

  constructor(db: SyncSqliteDatabase) {
    this.#db = db;
  }

  /**
   * `ON CONFLICT DO NOTHING ... RETURNING` claims a slug in one statement, so
   * two concurrent creates cannot both observe it as free.
   */
  async createNamespace(command: CreateNamespaceCommand): Promise<CreateNamespaceOutcome> {
    const inserted = await this.#db
      .insert(namespaces)
      .values({
        slug: command.slug,
        displayName: command.displayName,
        description: command.description,
      })
      .onConflictDoNothing()
      .returning();

    const row = inserted[0];
    return row === undefined
      ? { created: false, reason: "slug-taken" }
      : { created: true, namespace: toNamespace(row) };
  }

  /**
   * Ordered by slug, which is also the cursor key: the slug is the primary key,
   * so the keyset walk is an index range scan and needs no tiebreak. One row
   * beyond the limit is read to decide whether there is a next cursor.
   */
  async listNamespaces(query: ListNamespacesQuery): Promise<NamespacePage> {
    const rows = await this.#db
      .select()
      .from(namespaces)
      .where(query.after === null ? undefined : gt(namespaces.slug, query.after))
      .orderBy(asc(namespaces.slug))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      namespaces: page.map(toNamespace),
      next: rows.length > query.limit && last !== undefined ? last.slug : null,
    };
  }

  async getNamespace(slug: string): Promise<NamespaceInfo | null> {
    const rows = await this.#db.select().from(namespaces).where(eq(namespaces.slug, slug)).limit(1);

    const row = rows[0];
    return row === undefined ? null : toNamespace(row);
  }

  /**
   * One transaction, so repositories are never observable orphaned from their
   * namespace. Repositories go first: the index row is the child.
   */
  async deleteNamespace(slug: string): Promise<DeleteNamespaceOutcome> {
    return this.#db.transaction((tx): DeleteNamespaceOutcome => {
      const removed = tx
        .delete(repositories)
        .where(eq(repositories.namespaceSlug, slug))
        .returning({ durableObjectId: repositories.durableObjectId })
        .all();

      const deleted = tx
        .delete(namespaces)
        .where(eq(namespaces.slug, slug))
        .returning({ slug: namespaces.slug })
        .all();

      return {
        deleted: deleted.length > 0,
        repositoryObjectIds: removed.map((row) => row.durableObjectId),
      };
    });
  }
}
