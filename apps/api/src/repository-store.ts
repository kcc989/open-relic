import { eq } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import {
  REPOSITORY_STATE_ID,
  repositoryState,
} from "./db/repository-schema.ts";

/**
 * What a repository object is told about itself when it is created. Naming is
 * absent on purpose — the registry owns that; this is the Git side of a
 * `git init --bare`.
 */
export interface RepositoryInit {
  readonly defaultBranch: string;
  /**
   * Stamped by the index so the repository and its index entry report the same
   * creation time rather than two clocks a round trip apart.
   */
  readonly createdAt: string;
}

export type RepositorySnapshot = RepositoryInit;

/**
 * A repository object as a caller sees it: the RPC surface of
 * `RepositoryObject`. A `DurableObjectStub<RepositoryObject>` satisfies this,
 * and so does an in-memory double in the tests.
 */
export interface RepositoryObjectClient {
  readonly initialize: (init: RepositoryInit) => Promise<RepositorySnapshot>;
  readonly describe: () => Promise<RepositorySnapshot | null>;
  readonly destroy: () => Promise<void>;
}

/**
 * The state a repository holds about itself, over any drizzle SQLite database.
 *
 * `RepositoryObject` is a thin Durable Object shell around this class, which is
 * what lets the tests drive the real queries against the real generated
 * migrations without a Workers runtime.
 */
export class RepositoryStore {
  readonly #db: SyncSqliteDatabase;

  constructor(db: SyncSqliteDatabase) {
    this.#db = db;
  }

  /**
   * Idempotent: a repeated call keeps the state written by the first. Creating
   * a repository is an index write followed by this one, so a retry after a
   * failed round trip must not reset a repository that already exists.
   */
  async initialize(init: RepositoryInit): Promise<RepositorySnapshot> {
    await this.#db
      .insert(repositoryState)
      .values({
        id: REPOSITORY_STATE_ID,
        defaultBranch: init.defaultBranch,
        createdAt: init.createdAt,
      })
      .onConflictDoNothing();

    const stored = await this.describe();
    return stored ?? init;
  }

  async describe(): Promise<RepositorySnapshot | null> {
    const rows = await this.#db
      .select()
      .from(repositoryState)
      .where(eq(repositoryState.id, REPOSITORY_STATE_ID))
      .limit(1);

    const row = rows[0];
    return row === undefined
      ? null
      : { defaultBranch: row.defaultBranch, createdAt: row.createdAt };
  }
}
