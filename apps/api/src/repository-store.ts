import { eq } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import type { SyncKv } from "./db/kv.ts";
import {
  REPOSITORY_STATE_ID,
  repositoryState,
} from "./db/repository-schema.ts";
import {
  HEAD_KEY,
  formatHead,
  headBranch,
  parseHead,
  symbolicHead,
} from "./head.ts";

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

export interface RepositorySnapshot {
  /**
   * The branch HEAD points at — `null` once HEAD is detached, which the REST
   * API has no way to ask for today but Git can arrive at on its own.
   */
  readonly defaultBranch: string | null;
  readonly createdAt: string;
}

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
 * The state a repository holds about itself, over any drizzle SQLite database
 * and the KV half of the same storage.
 *
 * `RepositoryObject` is a thin Durable Object shell around this class, which is
 * what lets the tests drive the real queries against the real generated
 * migrations without a Workers runtime.
 *
 * HEAD is the one thing that lives in KV rather than SQL: it is a Git file, and
 * storing its literal bytes is what keeps a detached HEAD expressible without a
 * schema change (ADR-0003). Both halves are the same SQLite database inside the
 * object, so the row and the file commit in the same storage turn.
 */
export class RepositoryStore {
  readonly #db: SyncSqliteDatabase;
  readonly #kv: SyncKv;

  constructor(db: SyncSqliteDatabase, kv: SyncKv) {
    this.#db = db;
    this.#kv = kv;
  }

  /**
   * Idempotent: a repeated call keeps the state written by the first. Creating
   * a repository is an index write followed by this one, so a retry after a
   * failed round trip must not reset a repository that already exists.
   *
   * The row is what marks the object initialized, so HEAD is only written when
   * the insert claimed it — otherwise a retry naming a different branch would
   * retarget the HEAD of a repository that already answered for itself.
   */
  async initialize(init: RepositoryInit): Promise<RepositorySnapshot> {
    const inserted = await this.#db
      .insert(repositoryState)
      .values({
        id: REPOSITORY_STATE_ID,
        createdAt: init.createdAt,
      })
      .onConflictDoNothing()
      .returning({ createdAt: repositoryState.createdAt });

    if (inserted.length > 0) {
      this.#kv.put(HEAD_KEY, formatHead(symbolicHead(init.defaultBranch)));
    }

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
    if (row === undefined) {
      return null;
    }

    return { defaultBranch: this.#defaultBranch(), createdAt: row.createdAt };
  }

  /**
   * HEAD, parsed back into the branch name the REST API answers with. Missing
   * or unreadable contents are reported the same way a detached HEAD is: there
   * is no default branch to name.
   */
  #defaultBranch(): string | null {
    const contents = this.#kv.get(HEAD_KEY);
    if (contents === undefined) {
      return null;
    }

    const head = parseHead(contents);
    return head === null ? null : headBranch(head);
  }
}
