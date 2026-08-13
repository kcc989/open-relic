import type { Namespace } from "@open-relic/contracts";
import { asc, eq } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import {
  namespaces,
  repositories,
  type NamespaceRow,
} from "./db/registry-schema.ts";

export interface CreateNamespaceCommand {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
}

/**
 * A taken slug is a normal outcome, not an exception. Returning it as data
 * keeps the failure typed across the Durable Object RPC boundary, where a
 * thrown error would arrive as an opaque string.
 */
export type CreateNamespaceOutcome =
  | { readonly created: true; readonly namespace: Namespace }
  | { readonly created: false; readonly reason: "slug-taken" };

/**
 * Deleting a namespace takes its repositories with it. The object ids of the
 * repositories that were dropped come back so the caller can destroy their
 * storage; the index row and the object it points at are removed by different
 * layers, and only the caller holds the `REPOSITORIES` binding.
 */
export interface DeleteNamespaceOutcome {
  readonly deleted: boolean;
  readonly repositoryObjectIds: readonly string[];
}

/**
 * The registry as a caller sees it: the Durable Object's RPC surface.
 *
 * A `DurableObjectStub<NamespaceRegistryObject>` satisfies this, and so does a
 * bare {@link NamespaceRegistry} over a local drizzle database, which is how
 * the routes are tested without a Workers runtime.
 */
export interface NamespaceRegistryClient {
  readonly createNamespace: (
    command: CreateNamespaceCommand,
  ) => Promise<CreateNamespaceOutcome>;
  readonly listNamespaces: () => Promise<readonly Namespace[]>;
  readonly getNamespace: (slug: string) => Promise<Namespace | null>;
  readonly deleteNamespace: (slug: string) => Promise<DeleteNamespaceOutcome>;
}

const toNamespace = (row: NamespaceRow): Namespace => ({
  slug: row.slug,
  displayName: row.displayName,
  description: row.description,
  createdAt: row.createdAt,
});

/**
 * The namespace registry's behavior, over any drizzle SQLite database.
 *
 * {@link NamespaceRegistryObject} is a thin Durable Object shell around this
 * class, which is what lets the tests drive the real implementation — the same
 * queries against the same generated migrations — without a Workers runtime.
 */
export class NamespaceRegistry {
  readonly #db: SyncSqliteDatabase;

  constructor(db: SyncSqliteDatabase) {
    this.#db = db;
  }

  /**
   * `ON CONFLICT DO NOTHING ... RETURNING` makes claiming a slug one
   * statement, so two concurrent creates cannot both observe it as free.
   */
  async createNamespace(
    command: CreateNamespaceCommand,
  ): Promise<CreateNamespaceOutcome> {
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

  async listNamespaces(): Promise<Namespace[]> {
    const rows = await this.#db
      .select()
      .from(namespaces)
      .orderBy(asc(namespaces.slug));

    return rows.map(toNamespace);
  }

  async getNamespace(slug: string): Promise<Namespace | null> {
    const rows = await this.#db
      .select()
      .from(namespaces)
      .where(eq(namespaces.slug, slug))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toNamespace(row);
  }

  /**
   * Removes a namespace and every repository indexed under it, in one
   * transaction so a caller can never observe repositories orphaned from their
   * namespace. Repositories go first: the index row is the child of the
   * namespace row.
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
