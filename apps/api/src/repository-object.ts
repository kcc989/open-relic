import { ERROR_CODES } from "@open-relic/contracts";
import { DurableObject } from "cloudflare:workers";
import {
  drizzle,
  type DrizzleSqliteDODatabase,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../drizzle/repository/migrations.js";
import { fail } from "./envelope.ts";
import type { PackBase, PackSummary } from "./pack.ts";
import {
  RepositoryStore,
  type RepositoryInit,
  type RepositorySnapshot,
} from "./repository-store.ts";

/**
 * One repository, in its own Durable Object: a repository is what Git
 * operations serialize on — a push has to apply against a single consistent
 * view of the refs — and what grows without bound.
 *
 * Nothing addresses this object by name. The registry allocates
 * `namespace/name` and stores the resulting object id, and every request
 * resolves the name to that id first.
 */
export class RepositoryObject extends DurableObject {
  readonly #db: DrizzleSqliteDODatabase;
  readonly #store: RepositoryStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.#db = drizzle(ctx.storage);
    this.#store = new RepositoryStore(this.#db, ctx.storage.kv);

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

  advertiseReceivePack(): Promise<ReadableStream<Uint8Array>> {
    return this.#store.advertiseReceivePack();
  }

  readPack(pack: ReadableStream<Uint8Array>): Promise<PackSummary> {
    return this.#store.readPack(pack);
  }

  readObject(oid: string): Promise<PackBase | null> {
    return this.#store.readObject(oid);
  }

  /**
   * Leaves the storage empty, which is the point: a Durable Object is only
   * reclaimed once its storage is empty, so re-creating the schema here — even
   * the migration bookkeeping — would leave every deleted repository as an
   * unreachable object accruing stored-data charges forever. If something does
   * somehow reach it again, the constructor migrates it from scratch.
   */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /**
   * Git reaches this object through RPC methods like
   * {@link RepositoryObject.advertiseReceivePack}, never through a forwarded
   * request, so nothing should arrive here.
   */
  override async fetch(): Promise<Response> {
    return fail(501, {
      code: ERROR_CODES.notImplemented,
      message: "A repository object is addressed over RPC, not over HTTP.",
    });
  }
}
