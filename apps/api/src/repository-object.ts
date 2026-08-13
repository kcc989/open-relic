import { DurableObject } from "cloudflare:workers";
import {
  drizzle,
  type DrizzleSqliteDODatabase,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../drizzle/repository/migrations.js";
import {
  RepositoryStore,
  type RepositoryInit,
  type RepositorySnapshot,
} from "./repository-store.ts";

/**
 * One repository, in its own Durable Object.
 *
 * A repository is the unit that Git operations serialize on — a push has to
 * apply against a single consistent view of the refs — and the unit that grows
 * without bound, so each gets an object of its own rather than a share of the
 * registry. Nothing addresses this object by name: the registry allocates
 * `namespace/name` and stores the resulting object id, and every request
 * resolves the name to that id first.
 *
 * The Git engine is not implemented, so what the object holds today is what
 * `git init --bare` writes before its first ref: `HEAD`, as a default branch.
 * `fetch` stays a `501` because Git Smart HTTP is still unimplemented; the REST
 * API talks to this object over RPC.
 */
export class RepositoryObject extends DurableObject {
  readonly #db: DrizzleSqliteDODatabase;
  readonly #store: RepositoryStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.#db = drizzle(ctx.storage);
    this.#store = new RepositoryStore(this.#db);

    ctx.blockConcurrencyWhile(async () => {
      migrate(this.#db, migrations);
    });
  }

  initialize(init: RepositoryInit): Promise<RepositorySnapshot> {
    return this.#store.initialize(init);
  }

  describe(): Promise<RepositorySnapshot | null> {
    return this.#store.describe();
  }

  /**
   * Drops everything the repository holds, and leaves the storage empty.
   *
   * Empty is the point: a Durable Object is only reclaimed once its storage is
   * empty, so re-creating the schema here — even the migration bookkeeping —
   * would leave every deleted repository as an unreachable object accruing
   * stored-data charges forever. The registry has already forgotten the pointer
   * by the time this runs, so nothing can address the object again; if
   * something somehow does, the constructor migrates it from scratch.
   */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  override async fetch(): Promise<Response> {
    return Response.json(
      {
        type: "https://open-relic.dev/problems/not-implemented",
        title: "Not Implemented",
        status: 501,
        detail: "Git Smart HTTP has not been implemented.",
      },
      {
        status: 501,
        headers: { "Content-Type": "application/problem+json" },
      },
    );
  }
}
