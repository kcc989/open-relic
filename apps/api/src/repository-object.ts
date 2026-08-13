import { ERROR_CODES } from "@open-relic/contracts";
import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../drizzle/repository/migrations.js";
import { fail } from "./envelope.ts";
import type { UploadProtocolVersion } from "./git/advertisement.ts";
import type { PackBase } from "./pack.ts";
import {
  RepositoryStore,
  type ReceivePackOutcome,
  type RepositoryInit,
  type RepositorySnapshot,
} from "./repository-store.ts";
import type { SweepProgress } from "./sweep.ts";

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

  advertiseUploadPack(protocolVersion: UploadProtocolVersion): Promise<ReadableStream<Uint8Array>> {
    return this.#store.advertiseUploadPack(protocolVersion);
  }

  uploadPack(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
    return this.#store.uploadPack(body);
  }

  /**
   * The request body streams in over RPC, so a pack reaches the object without
   * the Worker buffering it, and the outcome comes back as bytes plus the two
   * facts the registry needs.
   */
  async receivePack(body: ReadableStream<Uint8Array>): Promise<ReceivePackOutcome> {
    // Persist the follow-up before reading the stream. Even a disconnected or
    // CPU-killed push can then leave only temporary orphans. Calling into the
    // store before yielding claims its operation gate, so an immediately due
    // alarm cannot finish a stale sweep before this push begins.
    const scheduled = this.ctx.storage.setAlarm(Date.now());
    return this.#store.receivePack(body, scheduled);
  }

  /** Start or resume reclamation; alarms carry subsequent batches. */
  async sweep(): Promise<SweepProgress> {
    return this.#advanceSweep();
  }

  override async alarm(): Promise<void> {
    await this.#advanceSweep();
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
    await this.#store.destroyStorage(() => this.ctx.storage.deleteAll());
  }

  async #advanceSweep(): Promise<SweepProgress> {
    return this.#store.sweep(undefined, async (progress) => {
      if (progress.phase === "complete") {
        console.log("Repository sweep completed", {
          repositoryObject: this.ctx.id.toString(),
          ...progress,
        });
      } else {
        await this.ctx.storage.setAlarm(Date.now());
      }
    });
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
