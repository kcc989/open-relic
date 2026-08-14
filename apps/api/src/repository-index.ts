import type { RepoInfo, RepoSortField, SortDirection } from "@open-relic/contracts";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import {
  namespaces,
  repositories,
  type NewRepositoryRow,
  type RepositoryRow,
  type RepositoryStatus,
} from "./db/registry-schema.ts";
import { escapeLikePattern } from "./pagination.ts";
import {
  LocalRegistryStorage,
  REGISTRY_DATABASE,
  type RegistryStorageConstructor,
} from "./registry-storage.ts";

export interface CreateRepositoryCommand {
  readonly namespaceSlug: string;
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly readOnly: boolean;
  readonly source?: string | null;
  readonly status?: RepositoryStatus;
  /**
   * The `RepositoryObject` this name will point at, allocated by the caller so
   * that a rejected create never leaves an initialized object behind.
   */
  readonly durableObjectId: string;
}

/**
 * Both are data, not exceptions: a thrown error would arrive at the Worker as
 * an opaque string across the Durable Object RPC boundary.
 */
export type CreateRepositoryOutcome =
  | { readonly created: true; readonly repository: RepoInfo }
  | {
      readonly created: false;
      readonly reason: "name-taken" | "namespace-missing";
    };

/**
 * The position a page resumes from: the sort key of the last row handed out,
 * and its name to break a tie. Not a wire cursor — the route is what encodes
 * this into a string, and what binds it to the query that produced it.
 */
export interface RepositoryCursor {
  readonly value: string;
  readonly name: string;
}

export interface ListRepositoriesQuery {
  readonly limit: number;
  readonly cursor: RepositoryCursor | null;
  readonly search: string | null;
  readonly sort: RepoSortField;
  readonly direction: SortDirection;
}

export interface RepositoryPage {
  readonly repositories: readonly RepoInfo[];
  /** Where the next page resumes; `null` once the walk has finished. */
  readonly next: RepositoryCursor | null;
}

export interface RepositoryPointer {
  readonly repository: RepoInfo;
  readonly durableObjectId: string;
  readonly status: RepositoryStatus;
}

/** What a delete answers with, and what its storage has to be discarded by. */
export interface DeletedRepository {
  readonly id: string;
  readonly durableObjectId: string;
}

/**
 * What a push changes about a repository's index entry. `defaultBranch` is
 * `null` on all but the one push that retargets HEAD, and the row is left
 * alone then — the repository object stays authoritative for HEAD, and this
 * column is the copy that keeps listing a namespace one query.
 */
export interface PushRecord {
  readonly pushedAt: string;
  readonly defaultBranch: string | null;
}

const toRepository = (row: RepositoryRow): RepoInfo => ({
  id: row.id,
  name: row.name,
  description: row.description,
  default_branch: row.defaultBranch,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
  last_push_at: row.lastPushAt,
  source: row.source,
  read_only: row.readOnly,
});

const newRepositoryId = (): string => `repo_${crypto.randomUUID().replaceAll("-", "")}`;

/**
 * `last_push_at` is the one nullable sort key, and NULL breaks the tuple
 * comparison a keyset cursor is built on. Coalescing it to the empty string
 * makes the ordering total and puts never-pushed repositories first ascending,
 * which is where SQLite's own NULLS FIRST would have put them.
 */
const sortExpression = (field: RepoSortField): SQL => {
  switch (field) {
    case "created_at":
      return sql`${repositories.createdAt}`;
    case "updated_at":
      return sql`${repositories.updatedAt}`;
    case "last_push_at":
      return sql`coalesce(${repositories.lastPushAt}, '')`;
    case "name":
      return sql`${repositories.name}`;
  }
};

/** The value the cursor has to carry for the row to be resumable from it. */
const sortValue = (row: RepositoryRow, field: RepoSortField): string => {
  switch (field) {
    case "created_at":
      return row.createdAt;
    case "updated_at":
      return row.updatedAt;
    case "last_push_at":
      return row.lastPushAt ?? "";
    case "name":
      return row.name;
  }
};

/**
 * Shares a database with `NamespaceRegistry` — one registry object holds both —
 * so a repository can be checked against its namespace and inserted in one
 * transaction, and listing a namespace is one query rather than a fan-out of
 * RPCs to every repository object.
 */
export const withRepositoryIndex = <TBase extends RegistryStorageConstructor>(Base: TBase) =>
  class RepositoryIndexMixin extends Base {
    readonly #db: SyncSqliteDatabase = this[REGISTRY_DATABASE];

    /**
     * The namespace check and the insert share a transaction: without it a
     * namespace deleted in between would leave a repository pointing at nothing.
     *
     * The driver is synchronous, so the statements are executed with `.all()`
     * rather than awaited — a transaction that yielded would commit before its
     * body finished.
     */
    async createRepository(command: CreateRepositoryCommand): Promise<CreateRepositoryOutcome> {
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

        // One clock for both stamps: a repository that has never been touched
        // reports the same `created_at` and `updated_at`.
        const now = new Date().toISOString();

        const inserted = tx
          .insert(repositories)
          .values({
            namespaceSlug: command.namespaceSlug,
            name: command.name,
            id: newRepositoryId(),
            durableObjectId: command.durableObjectId,
            description: command.description,
            defaultBranch: command.defaultBranch,
            readOnly: command.readOnly,
            source: command.source ?? null,
            status: command.status ?? "ready",
            createdAt: now,
            updatedAt: now,
            lastPushAt: null,
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
     * `null` is a missing namespace; an empty page is one that owns no matching
     * repositories. One row beyond the limit is read to decide whether there is a
     * next cursor without a second count query.
     */
    async listRepositories(
      namespaceSlug: string,
      query: ListRepositoriesQuery,
    ): Promise<RepositoryPage | null> {
      const namespace = await this.#db
        .select({ slug: namespaces.slug })
        .from(namespaces)
        .where(eq(namespaces.slug, namespaceSlug))
        .limit(1);

      if (namespace.length === 0) {
        return null;
      }

      const expression = sortExpression(query.sort);
      const ascending = query.direction === "asc";
      const filters: SQL[] = [eq(repositories.namespaceSlug, namespaceSlug)];

      if (query.search !== null) {
        const pattern = `%${escapeLikePattern(query.search)}%`;
        filters.push(sql`${repositories.name} LIKE ${pattern} ESCAPE '\\'`);
      }

      if (query.cursor !== null) {
        const { value, name } = query.cursor;

        // A row-value comparison, so the sort key and the name tiebreak resume
        // together — two repositories sharing a timestamp cannot hide each other.
        filters.push(
          ascending
            ? sql`(${expression}, ${repositories.name}) > (${value}, ${name})`
            : sql`(${expression}, ${repositories.name}) < (${value}, ${name})`,
        );
      }

      const rows = await this.#db
        .select()
        .from(repositories)
        .where(and(...filters))
        .orderBy(
          ascending ? asc(expression) : desc(expression),
          ascending ? asc(repositories.name) : desc(repositories.name),
        )
        .limit(query.limit + 1);

      const page = rows.slice(0, query.limit);
      const last = page.at(-1);

      return {
        repositories: page.map(toRepository),
        next:
          rows.length > query.limit && last !== undefined
            ? { value: sortValue(last, query.sort), name: last.name }
            : null,
      };
    }

    async getRepository(namespaceSlug: string, name: string): Promise<RepositoryPointer | null> {
      const rows = await this.#db
        .select()
        .from(repositories)
        .where(and(eq(repositories.namespaceSlug, namespaceSlug), eq(repositories.name, name)))
        .limit(1);

      const row = rows[0];
      return row === undefined
        ? null
        : {
            repository: toRepository(row),
            durableObjectId: row.durableObjectId,
            status: row.status,
          };
    }

    /**
     * Hands back the object id the dropped entry pointed at, so the caller can
     * destroy its storage, and the public id the response answers with. `null`
     * when there was no such repository.
     */
    async deleteRepository(namespaceSlug: string, name: string): Promise<DeletedRepository | null> {
      const deleted = await this.#db
        .delete(repositories)
        .where(and(eq(repositories.namespaceSlug, namespaceSlug), eq(repositories.name, name)))
        .returning({
          id: repositories.id,
          durableObjectId: repositories.durableObjectId,
        });

      return deleted[0] ?? null;
    }

    /** A stale multi-step create may clean up only the row it originally reserved. */
    async deleteImportIfOwned(
      namespaceSlug: string,
      name: string,
      durableObjectId: string,
    ): Promise<DeletedRepository | null> {
      const deleted = await this.#db
        .delete(repositories)
        .where(
          and(
            eq(repositories.namespaceSlug, namespaceSlug),
            eq(repositories.name, name),
            eq(repositories.durableObjectId, durableObjectId),
            eq(repositories.status, "importing"),
          ),
        )
        .returning({
          id: repositories.id,
          durableObjectId: repositories.durableObjectId,
        });

      return deleted[0] ?? null;
    }

    async finishFork(namespaceSlug: string, name: string): Promise<boolean> {
      const updated = await this.#db
        .update(repositories)
        .set({ status: "ready" })
        .where(
          and(
            eq(repositories.namespaceSlug, namespaceSlug),
            eq(repositories.name, name),
            eq(repositories.status, "forking"),
          ),
        )
        .returning({ name: repositories.name });

      return updated.length > 0;
    }

    /** Publish the remote's actual HEAD only if this is still the reserved import. */
    async finishImport(
      namespaceSlug: string,
      name: string,
      durableObjectId: string,
      defaultBranch: string,
    ): Promise<boolean> {
      const updated = await this.#db
        .update(repositories)
        .set({ status: "ready", defaultBranch })
        .where(
          and(
            eq(repositories.namespaceSlug, namespaceSlug),
            eq(repositories.name, name),
            eq(repositories.durableObjectId, durableObjectId),
            eq(repositories.status, "importing"),
          ),
        )
        .returning({ name: repositories.name });

      return updated.length > 0;
    }

    /**
     * Stamps a push onto the index entry, after the refs have already moved.
     *
     * Deliberately not part of the push: the repository object is where a push
     * either happens or does not, and the row here is a copy for the REST
     * surface's benefit. A stamp that fails leaves `last_push_at` stale rather
     * than leaving a ref half-moved.
     */
    async recordPush(namespaceSlug: string, name: string, record: PushRecord): Promise<void> {
      // Built in statements rather than spread conditionally: `default_branch`
      // is left alone on all but the one push that retargets HEAD, and an
      // omission is easier to read as an omission than as an empty object.
      const stamp: Partial<NewRepositoryRow> = { lastPushAt: record.pushedAt };
      if (record.defaultBranch !== null) {
        stamp.defaultBranch = record.defaultBranch;
      }

      await this.#db
        .update(repositories)
        .set(stamp)
        .where(and(eq(repositories.namespaceSlug, namespaceSlug), eq(repositories.name, name)));
    }
  };

export class RepositoryIndex extends withRepositoryIndex(LocalRegistryStorage) {}

export type RepositoryIndexClient = Pick<RepositoryIndex, Extract<keyof RepositoryIndex, string>>;
