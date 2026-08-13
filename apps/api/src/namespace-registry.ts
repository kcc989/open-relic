import type { Namespace } from "@open-relic/contracts";
import { asc, eq } from "drizzle-orm";
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core/async/db";

import { namespaces, type NamespaceRow } from "./db/schema.ts";

/**
 * Any synchronous SQLite database drizzle can drive.
 *
 * `DrizzleSqliteDODatabase` (the Durable Object's storage) and
 * `SQLiteBunDatabase` (`bun:sqlite`, used by the tests) both extend this, so
 * the queries below are written once and run unchanged in both places. The run
 * result type is the only thing that differs between the two drivers and
 * nothing here reads it.
 */
export type NamespaceDatabase = SQLiteAsyncDatabase<"sync", unknown>;

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
  readonly deleteNamespace: (slug: string) => Promise<boolean>;
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
  readonly #db: NamespaceDatabase;

  constructor(db: NamespaceDatabase) {
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

  /** Returns whether a row was actually removed. */
  async deleteNamespace(slug: string): Promise<boolean> {
    const deleted = await this.#db
      .delete(namespaces)
      .where(eq(namespaces.slug, slug))
      .returning({ slug: namespaces.slug });

    return deleted.length > 0;
  }
}
