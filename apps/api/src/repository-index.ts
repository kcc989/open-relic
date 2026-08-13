import type { Repository } from "@open-relic/contracts";
import { and, asc, eq } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import {
  namespaces,
  repositories,
  type RepositoryRow,
} from "./db/registry-schema.ts";

export interface CreateRepositoryCommand {
  readonly namespaceSlug: string;
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  /**
   * The `RepositoryObject` this name will point at, allocated by the caller so
   * that a rejected create never leaves an initialized object behind.
   */
  readonly durableObjectId: string;
}

/**
 * Neither a missing namespace nor a taken name is exceptional, so both are
 * returned as data — a thrown error would arrive at the Worker as an opaque
 * string across the Durable Object RPC boundary.
 */
export type CreateRepositoryOutcome =
  | { readonly created: true; readonly repository: Repository }
  | {
      readonly created: false;
      readonly reason: "name-taken" | "namespace-missing";
    };

/**
 * A repository's entry in the index, with the pointer the API hides.
 */
export interface RepositoryPointer {
  readonly repository: Repository;
  readonly durableObjectId: string;
}

/**
 * The index as a caller sees it: part of the registry Durable Object's RPC
 * surface, alongside {@link NamespaceRegistryClient}.
 */
export interface RepositoryIndexClient {
  readonly createRepository: (
    command: CreateRepositoryCommand,
  ) => Promise<CreateRepositoryOutcome>;
  readonly listRepositories: (
    namespaceSlug: string,
  ) => Promise<readonly Repository[] | null>;
  readonly getRepository: (
    namespaceSlug: string,
    name: string,
  ) => Promise<RepositoryPointer | null>;
  readonly deleteRepository: (
    namespaceSlug: string,
    name: string,
  ) => Promise<string | null>;
}

const toRepository = (row: RepositoryRow): Repository => ({
  namespace: row.namespaceSlug,
  name: row.name,
  description: row.description,
  defaultBranch: row.defaultBranch,
  createdAt: row.createdAt,
});

/**
 * The repository index's behavior, over any drizzle SQLite database.
 *
 * It shares a database with {@link NamespaceRegistry} — one registry object
 * holds both — so a repository can be checked against its namespace and
 * inserted in one transaction, and listing a namespace is one query rather
 * than a fan-out of RPCs to every repository object.
 */
export class RepositoryIndex {
  readonly #db: SyncSqliteDatabase;

  constructor(db: SyncSqliteDatabase) {
    this.#db = db;
  }

  /**
   * Claims a name inside a namespace. The namespace check and the insert share
   * a transaction because they are two statements: without it a namespace
   * deleted in between would leave a repository pointing at nothing.
   *
   * The driver is synchronous, so the statements are executed with `.all()`
   * rather than awaited — a transaction that yielded would commit before its
   * body finished.
   */
  async createRepository(
    command: CreateRepositoryCommand,
  ): Promise<CreateRepositoryOutcome> {
    return this.#db.transaction((tx): CreateRepositoryOutcome => {
      const namespace = tx
        .select({ slug: namespaces.slug })
        .from(namespaces)
        .where(eq(namespaces.slug, command.namespaceSlug))
        .limit(1)
        .all();

      if (namespace.length === 0) {
        return { created: false, reason: "namespace-missing" };
      }

      const inserted = tx
        .insert(repositories)
        .values({
          namespaceSlug: command.namespaceSlug,
          name: command.name,
          durableObjectId: command.durableObjectId,
          description: command.description,
          defaultBranch: command.defaultBranch,
        })
        .onConflictDoNothing()
        .returning()
        .all();

      const row = inserted[0];
      return row === undefined
        ? { created: false, reason: "name-taken" }
        : { created: true, repository: toRepository(row) };
    });
  }

  /**
   * Returns `null` when the namespace itself does not exist, which the API
   * answers differently from a namespace that simply owns no repositories.
   */
  async listRepositories(
    namespaceSlug: string,
  ): Promise<readonly Repository[] | null> {
    const namespace = await this.#db
      .select({ slug: namespaces.slug })
      .from(namespaces)
      .where(eq(namespaces.slug, namespaceSlug))
      .limit(1);

    if (namespace.length === 0) {
      return null;
    }

    const rows = await this.#db
      .select()
      .from(repositories)
      .where(eq(repositories.namespaceSlug, namespaceSlug))
      .orderBy(asc(repositories.name));

    return rows.map(toRepository);
  }

  async getRepository(
    namespaceSlug: string,
    name: string,
  ): Promise<RepositoryPointer | null> {
    const rows = await this.#db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.namespaceSlug, namespaceSlug),
          eq(repositories.name, name),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row === undefined
      ? null
      : { repository: toRepository(row), durableObjectId: row.durableObjectId };
  }

  /**
   * Drops the index entry and hands back the object id it pointed at, so the
   * caller can destroy the repository object's storage. Returns `null` when
   * there was no such repository.
   */
  async deleteRepository(
    namespaceSlug: string,
    name: string,
  ): Promise<string | null> {
    const deleted = await this.#db
      .delete(repositories)
      .where(
        and(
          eq(repositories.namespaceSlug, namespaceSlug),
          eq(repositories.name, name),
        ),
      )
      .returning({ durableObjectId: repositories.durableObjectId });

    return deleted[0]?.durableObjectId ?? null;
  }
}
