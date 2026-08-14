import { ERROR_CODES } from "@open-relic/contracts";
import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../drizzle/repository/migrations.js";
import type { ApiEnv } from "../../../alchemy.run.ts";
import { repositoryIndexFromEnv } from "./bindings.ts";
import { fail } from "./envelope.ts";
import type { UploadProtocolVersion } from "./git/advertisement.ts";
import {
  ImportOperation,
  type ImportCheckpoint,
  type ImportJob,
  type ImportJobOutcome,
  type StoredImportJob,
} from "./import-operation.ts";
import type { PackBase } from "./pack.ts";
import type { RepackProgress } from "./repack.ts";
import {
  RepositoryStore,
  type ForkOptions,
  type ForkObject,
  type ForkOutcome,
  type ForkState,
  type ForkTarget,
  type ImportedBranch,
  type RepositoryHistoryResult,
  type RepositoryFileResult,
  type ReceivePackOutcome,
  type RemoteBranchRequest,
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
  readonly #importOperation: ImportOperation;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.#db = drizzle(ctx.storage);
    this.#store = new RepositoryStore(this.#db, ctx.storage.kv);
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
        resetImport: (init) => this.#store.resetImport(init),
        importBranch: (request) => this.#store.importBranch(request, globalThis.fetch),
        destroy: () => this.#store.destroyStorage(() => ctx.storage.deleteAll()),
      },
      registry: repositoryIndexFromEnv(apiEnv),
    });

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

  copyForkTo(target: ForkTarget, options: ForkOptions): Promise<ForkOutcome> {
    return this.#store.copyForkTo(target, options);
  }

  writeForkObject(
    object: ForkObject,
    bytes: ReadableStream<Uint8Array>,
    deltaBytes?: ReadableStream<Uint8Array>,
  ): Promise<void> {
    return this.#store.writeForkObject(object, bytes, deltaBytes);
  }

  async completeFork(state: ForkState): Promise<void> {
    await this.#store.completeFork(state);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async importBranch(request: RemoteBranchRequest): Promise<ImportedBranch> {
    // Import can leave complete but unreachable objects when the remote fails
    // late. Persist reclamation before the first network or storage await.
    const scheduled = this.ctx.storage.setAlarm(Date.now());
    return this.#store.importBranch(request, globalThis.fetch, scheduled);
  }

  resetImport(init: RepositoryInit): Promise<void> {
    return this.#store.resetImport(init);
  }

  /** Persist and alarm the job before any network request can begin. */
  async scheduleImport(job: ImportJob): Promise<ImportJobOutcome> {
    return this.#importOperation.schedule(job);
  }

  /** Start or resume reclamation; alarms carry subsequent batches. */
  async sweep(): Promise<SweepProgress> {
    return this.#advanceSweep();
  }

  async repack(): Promise<RepackProgress> {
    return this.#store.repack();
  }

  override async alarm(): Promise<void> {
    if (await this.#importOperation.hasJob()) {
      await this.#importOperation.run();
      return;
    }
    await this.#advanceMaintenance();
  }

  readObject(oid: string): Promise<PackBase | null> {
    return this.#store.readObject(oid);
  }

  readBlob(oid: string): Promise<ReadableStream<Uint8Array> | null> {
    return this.#store.readBlob(oid);
  }

  readHistory(
    revision: string | null,
    limit: number,
    offset: number,
  ): Promise<RepositoryHistoryResult> {
    return this.#store.readHistory(revision, limit, offset);
  }

  readFile(revision: string | null, path: string): Promise<RepositoryFileResult> {
    return this.#store.readFile(revision, path);
  }

  hasObject(oid: string): Promise<boolean> {
    return this.#store.hasObject(oid);
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

  async #advanceMaintenance(): Promise<void> {
    // Once Repack has a stable Sweep index, continue it directly. Calling
    // Sweep first would treat its completed checkpoint as a request to start a
    // new walk and make every Repack batch pay for the whole repository again.
    const activeRepack = await this.#store.repack();
    if (activeRepack.phase === "select") {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    if (activeRepack.justCompleted) {
      console.log("Repository maintenance completed", {
        repositoryObject: this.ctx.id.toString(),
      });
      return;
    }
    const sweep = await this.#store.sweep();
    if (sweep.phase !== "complete") {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }

    const repack = await this.#store.repack();
    if (repack.phase !== "complete") {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }

    console.log("Repository maintenance completed", {
      repositoryObject: this.ctx.id.toString(),
      reachableObjects: sweep.reachableObjects,
      reclaimedObjects: sweep.reclaimedObjects,
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
