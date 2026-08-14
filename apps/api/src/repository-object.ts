import { ERROR_CODES } from "@open-relic/contracts";
import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../drizzle/repository/migrations.js";
import type { ApiEnv } from "../../../alchemy.run.ts";
import { repositoryIndexFromEnv } from "./bindings.ts";
import { fail } from "./envelope.ts";
import {
  ImportOperation,
  type ImportCheckpoint,
  type ImportJob,
  type ImportJobOutcome,
  type StoredImportJob,
} from "./import-operation.ts";
import {
  REPOSITORY_DATABASE,
  REPOSITORY_KV,
  withRepositoryStore,
  type ReceivePackOutcome,
  type RepositoryStorage,
} from "./repository-store.ts";
import type { SweepProgress } from "./sweep.ts";

class DurableRepositoryStorage extends DurableObject implements RepositoryStorage {
  readonly [REPOSITORY_DATABASE]: DrizzleSqliteDODatabase;
  readonly [REPOSITORY_KV]: DurableObjectStorage["kv"];

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this[REPOSITORY_DATABASE] = drizzle(ctx.storage);
    this[REPOSITORY_KV] = ctx.storage.kv;

    ctx.blockConcurrencyWhile(async () => {
      migrate(this[REPOSITORY_DATABASE], migrations);
    });
  }
}

/**
 * One repository, in its own Durable Object: a repository is what Git
 * operations serialize on — a push has to apply against a single consistent
 * view of the refs — and what grows without bound.
 *
 * Nothing addresses this object by name. The registry allocates
 * `namespace/name` and stores the resulting object id, and every request
 * resolves the name to that id first.
 */
export class RepositoryObject extends withRepositoryStore(DurableRepositoryStorage) {
  readonly #importOperation: ImportOperation;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    // SAFETY: this class is bound only by ApiWorker, whose inferred bindings are ApiEnv.
    const apiEnv = env as ApiEnv;
    this.#importOperation = new ImportOperation({
      durableObjectId: ctx.id.toString(),
      storage: {
        persistScheduledJob: (job) =>
          ctx.storage.transaction(async (transaction) => {
            await transaction.put(IMPORT_JOB_KEY, job);
            await transaction.delete(IMPORT_CHECKPOINT_KEY);
            await transaction.setAlarm(Date.now());
          }),
        readJob: () => ctx.storage.get<StoredImportJob>(IMPORT_JOB_KEY),
        writeJob: (job) => ctx.storage.put(IMPORT_JOB_KEY, job),
        readCheckpoint: () => ctx.storage.get<ImportCheckpoint>(IMPORT_CHECKPOINT_KEY),
        writeCheckpoint: (checkpoint) => ctx.storage.put(IMPORT_CHECKPOINT_KEY, checkpoint),
        completePublishedJob: () =>
          ctx.storage.transaction(async (transaction) => {
            await transaction.delete(IMPORT_JOB_KEY);
            await transaction.delete(IMPORT_CHECKPOINT_KEY);
            await transaction.setAlarm(Date.now());
          }),
        armAlarm: () => ctx.storage.setAlarm(Date.now()),
      },
      repository: {
        resetImport: (init) => this.resetImport(init),
        importBranch: (request) => this.importBranch(request, globalThis.fetch),
        destroy: () => this.destroyStorage(() => ctx.storage.deleteAll()),
      },
      registry: repositoryIndexFromEnv(apiEnv),
    });
  }

  /**
   * The request body streams in over RPC, so a pack reaches the object without
   * the Worker buffering it, and the outcome comes back as bytes plus the two
   * facts the registry needs.
   */
  override async receivePack(body: ReadableStream<Uint8Array>): Promise<ReceivePackOutcome> {
    // Persist the follow-up before reading the stream. Even a disconnected or
    // CPU-killed push can then leave only temporary orphans. Calling into the
    // store before yielding claims its operation gate, so an immediately due
    // alarm cannot finish a stale sweep before this push begins.
    const scheduled = this.ctx.storage.setAlarm(Date.now());
    return super.receivePack(body, scheduled);
  }

  /** Start or resume reclamation; alarms carry subsequent batches. */
  override async sweep(): Promise<SweepProgress> {
    return this.#advanceSweep();
  }

  /** Persist and alarm the job before any network request can begin. */
  async scheduleImport(job: ImportJob): Promise<ImportJobOutcome> {
    return this.#importOperation.schedule(job);
  }

  override async alarm(): Promise<void> {
    if (await this.#importOperation.hasJob()) {
      await this.#importOperation.run();
      return;
    }
    await this.#advanceSweep();
  }

  /**
   * Leaves the storage empty, which is the point: a Durable Object is only
   * reclaimed once its storage is empty, so re-creating the schema here — even
   * the migration bookkeeping — would leave every deleted repository as an
   * unreachable object accruing stored-data charges forever. If something does
   * somehow reach it again, the constructor migrates it from scratch.
   */
  async destroy(): Promise<void> {
    await this.#importOperation.destroy();
  }

  async #advanceSweep(): Promise<SweepProgress> {
    return super.sweep(undefined, async (progress) => {
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

const IMPORT_JOB_KEY = "operation:import";
const IMPORT_CHECKPOINT_KEY = "operation:import:checkpoint";
