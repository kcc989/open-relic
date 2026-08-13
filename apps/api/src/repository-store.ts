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

/** The Git side of a `git init --bare`; the registry owns naming. */
export interface RepositoryInit {
  readonly defaultBranch: string;
  /** Stamped by the index, so the object and its index entry share one clock. */
  readonly createdAt: string;
}

export interface RepositorySnapshot {
  /** `null` once HEAD is detached, which Git can arrive at on its own. */
  readonly defaultBranch: string | null;
  readonly createdAt: string;
}

export interface RepositoryObjectClient {
  readonly initialize: (init: RepositoryInit) => Promise<RepositorySnapshot>;
  readonly describe: () => Promise<RepositorySnapshot | null>;
  readonly destroy: () => Promise<void>;
}

/**
 * `RepositoryObject` is a thin Durable Object shell around this class, which is
 * what lets the tests run the real queries against the real migrations without
 * a Workers runtime.
 *
 * HEAD lives in KV rather than SQL because it is a Git file (ADR-0003). Both
 * halves are the same SQLite database inside the object, so the row and the
 * file commit in the same storage turn.
 */
export class RepositoryStore {
  readonly #db: SyncSqliteDatabase;
  readonly #kv: SyncKv;

  constructor(db: SyncSqliteDatabase, kv: SyncKv) {
    this.#db = db;
    this.#kv = kv;
  }

  /**
   * Idempotent, because creating a repository is an index write followed by
   * this one and a retry must not reset a repository that already exists. The
   * row marks the object initialized, so HEAD is written only when the insert
   * claimed it — otherwise a retry naming a different branch would retarget a
   * HEAD that has already answered for itself.
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

  /** Missing or unreadable contents read the same as a detached HEAD. */
  #defaultBranch(): string | null {
    const contents = this.#kv.get(HEAD_KEY);
    if (contents === undefined) {
      return null;
    }

    const head = parseHead(contents);
    return head === null ? null : headBranch(head);
  }
}
