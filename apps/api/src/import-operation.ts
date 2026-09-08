import type { DeletedRepository, RepositoryPointer } from "./repository-index.ts";
import { RemoteBranchError, type RemoteBranchRequest } from "./git/remote-branch.ts";
import { RepositoryStorageExhaustedError } from "./object-store.ts";
import { PackError, type PackErrorCode } from "./pack.ts";

export interface ImportedBranch {
  readonly branch: string;
  readonly oid: string;
  readonly shallow: readonly string[];
  readonly objects: number;
}

export interface ImportJob {
  readonly namespaceSlug: string;
  readonly repositoryName: string;
  readonly createdAt: string;
  readonly initialBranch: string;
  readonly request: RemoteBranchRequest;
}

export interface StoredImportJob extends ImportJob {
  readonly attempts: number;
}

export type ImportFailureCode =
  | RemoteBranchError["code"]
  | "storage-exhausted"
  | "invalid-pack"
  | "internal";

export interface ImportJobFailure {
  readonly completed: false;
  readonly retrying: false;
  readonly code: ImportFailureCode;
  readonly message: string;
  readonly packErrorCode: PackErrorCode | null;
}

export interface ImportJobRetrying {
  readonly completed: false;
  readonly retrying: true;
  readonly code: "upstream-unavailable";
  readonly message: string;
  readonly packErrorCode: null;
}

export type ImportJobOutcome =
  | { readonly completed: true; readonly imported: ImportedBranch }
  | ImportJobFailure
  | ImportJobRetrying;

export type ImportCheckpoint =
  | { readonly kind: "imported"; readonly imported: ImportedBranch }
  | { readonly kind: "failed"; readonly failure: ImportJobFailure };

export interface ImportOperationStorage {
  /** Persist a fresh job and its first alarm in one storage transaction. */
  readonly persistScheduledJob: (job: StoredImportJob) => Promise<void>;
  readonly readJob: () => Promise<StoredImportJob | undefined>;
  readonly writeJob: (job: StoredImportJob) => Promise<void>;
  readonly readCheckpoint: () => Promise<ImportCheckpoint | undefined>;
  readonly writeCheckpoint: (checkpoint: ImportCheckpoint) => Promise<void>;
  /** Clear a published job and make its next alarm a repository sweep atomically. */
  readonly completePublishedJob: () => Promise<void>;
  readonly armAlarm: () => Promise<void>;
}

export interface ImportRepository {
  readonly resetImport: (init: {
    readonly defaultBranch: string;
    readonly createdAt: string;
  }) => Promise<void>;
  readonly importBranch: (request: RemoteBranchRequest) => Promise<ImportedBranch>;
  readonly destroy: () => Promise<void>;
}

export interface ImportRegistry {
  readonly finishImport: (
    namespaceSlug: string,
    repositoryName: string,
    durableObjectId: string,
    defaultBranch: string,
  ) => Promise<boolean>;
  readonly getRepository: (
    namespaceSlug: string,
    repositoryName: string,
  ) => Promise<RepositoryPointer | null>;
  readonly deleteImportIfOwned: (
    namespaceSlug: string,
    repositoryName: string,
    durableObjectId: string,
  ) => Promise<DeletedRepository | null>;
}

export interface ImportOperationDependencies {
  readonly durableObjectId: string;
  readonly storage: ImportOperationStorage;
  readonly repository: ImportRepository;
  readonly registry: ImportRegistry;
}

const MAX_IMPORT_ATTEMPTS = 3;

/**
 * Durable import coordination without a Workers runtime dependency. The
 * Durable Object supplies storage, alarms, repository RPC, and registry RPC;
 * this class owns every state transition and is exercised directly by tests.
 */
export class ImportOperation {
  readonly #durableObjectId: string;
  readonly #storage: ImportOperationStorage;
  readonly #repository: ImportRepository;
  readonly #registry: ImportRegistry;
  #operation = Promise.resolve();

  constructor(dependencies: ImportOperationDependencies) {
    this.#durableObjectId = dependencies.durableObjectId;
    this.#storage = dependencies.storage;
    this.#repository = dependencies.repository;
    this.#registry = dependencies.registry;
  }

  async schedule(job: ImportJob): Promise<ImportJobOutcome> {
    await this.#storage.persistScheduledJob({ ...job, attempts: 0 });
    try {
      return await this.#exclusive(() => this.#run());
    } catch {
      // Once the job exists, the initiating request must never destroy this
      // object for a transient storage or RPC failure. The checkpoint and
      // alarm make every later phase resumable by the object itself.
      await this.#rearmAfterRegistryFailure();
      return retryingOperation();
    }
  }

  async hasJob(): Promise<boolean> {
    return (await this.#storage.readJob()) !== undefined;
  }

  async run(): Promise<ImportJobOutcome> {
    return this.#exclusive(() => this.#run());
  }

  async destroy(): Promise<void> {
    await this.#exclusive(() => this.#repository.destroy());
  }

  async #run(): Promise<ImportJobOutcome> {
    let job = await this.#storage.readJob();
    if (job === undefined) {
      return terminalFailure("internal", "The durable import job disappeared.");
    }

    const checkpoint = await this.#storage.readCheckpoint();
    if (checkpoint?.kind === "imported") {
      return this.#publish(job, checkpoint.imported);
    }
    if (checkpoint?.kind === "failed") {
      return this.#cleanup(job, checkpoint.failure);
    }

    for (;;) {
      // Checked before the try, not only after a caught failure: a run that
      // dies without throwing (a memory kill, a wall-clock limit) comes back
      // through the alarm with its attempt already counted, and must not loop.
      if (job.attempts >= MAX_IMPORT_ATTEMPTS) {
        const terminal = terminalFailure(
          "upstream-unavailable",
          `The import did not complete in ${MAX_IMPORT_ATTEMPTS} attempts.`,
        );
        await this.#storage.writeCheckpoint({ kind: "failed", failure: terminal });
        return this.#cleanup(job, terminal);
      }

      job = { ...job, attempts: job.attempts + 1 };
      await this.#storage.writeJob(job);

      try {
        await this.#repository.resetImport({
          defaultBranch: job.initialBranch,
          createdAt: job.createdAt,
        });
        const imported = await this.#repository.importBranch(job.request);
        await this.#storage.writeCheckpoint({ kind: "imported", imported });
        return await this.#publish(job, imported);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("The import failed.");
        if (isTransientImportFailure(failure) && job.attempts < MAX_IMPORT_ATTEMPTS) {
          await this.#storage.armAlarm();
          continue;
        }

        const terminal = importFailure(failure);
        await this.#storage.writeCheckpoint({ kind: "failed", failure: terminal });
        return this.#cleanup(job, terminal);
      }
    }
  }

  async #publish(job: StoredImportJob, imported: ImportedBranch): Promise<ImportJobOutcome> {
    let published: boolean;
    try {
      published = await this.#registry.finishImport(
        job.namespaceSlug,
        job.repositoryName,
        this.#durableObjectId,
        imported.branch,
      );
      if (!published) {
        const current = await this.#registry.getRepository(job.namespaceSlug, job.repositoryName);
        if (current?.status === "ready" && current.durableObjectId === this.#durableObjectId) {
          published = true;
        }
      }
    } catch {
      await this.#rearmAfterRegistryFailure();
      return retryingOperation();
    }

    if (!published) {
      const failure = terminalFailure(
        "internal",
        "The reserved import target disappeared before it became ready.",
      );
      await this.#storage.writeCheckpoint({ kind: "failed", failure });
      return this.#cleanup(job, failure);
    }

    await this.#storage.completePublishedJob();
    return { completed: true, imported };
  }

  async #cleanup(job: StoredImportJob, failure: ImportJobFailure): Promise<ImportJobOutcome> {
    try {
      await this.#registry.deleteImportIfOwned(
        job.namespaceSlug,
        job.repositoryName,
        this.#durableObjectId,
      );
    } catch {
      await this.#rearmAfterRegistryFailure();
      return retryingOperation();
    }

    // A false guarded delete means the name is absent or belongs to a newer
    // repository. Either way, only this stale object's storage is destroyed.
    await this.#repository.destroy();
    return failure;
  }

  async #rearmAfterRegistryFailure(): Promise<void> {
    try {
      await this.#storage.armAlarm();
    } catch {
      // The persisted job and checkpoint remain the authority. A later RPC or
      // platform alarm retry can resume without refetching or deleting data.
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operation;
    let release = (): void => {};
    this.#operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const isTransientImportFailure = (error: Error): boolean =>
  error instanceof RemoteBranchError && error.code === "upstream-unavailable";

const terminalFailure = (
  code: Exclude<ImportFailureCode, "invalid-pack">,
  message: string,
): ImportJobFailure => ({
  completed: false,
  retrying: false,
  code,
  message,
  packErrorCode: null,
});

const retryingOperation = (): ImportJobRetrying => ({
  completed: false,
  retrying: true,
  code: "upstream-unavailable",
  message: "The durable import operation will resume in the background.",
  packErrorCode: null,
});

const importFailure = (error: Error): ImportJobFailure => {
  if (error instanceof RemoteBranchError) {
    return terminalFailure(error.code, error.message);
  }
  if (error instanceof RepositoryStorageExhaustedError) {
    return terminalFailure("storage-exhausted", error.message);
  }
  if (error instanceof PackError) {
    return {
      completed: false,
      retrying: false,
      code: "invalid-pack",
      message: error.message,
      packErrorCode: error.code,
    };
  }
  return terminalFailure("internal", "The repository could not be imported.");
};
