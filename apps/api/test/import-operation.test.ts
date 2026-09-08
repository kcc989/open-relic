import { describe, expect, test } from "bun:test";

import {
  ImportOperation,
  type ImportCheckpoint,
  type ImportOperationStorage,
  type ImportRegistry,
  type ImportedBranch,
  type StoredImportJob,
} from "../src/import-operation.ts";
import { PackError } from "../src/pack.ts";

class MemoryImportStorage implements ImportOperationStorage {
  job: StoredImportJob | undefined;
  checkpoint: ImportCheckpoint | undefined;
  alarms = 0;

  async persistScheduledJob(job: StoredImportJob): Promise<void> {
    this.job = structuredClone(job);
    this.checkpoint = undefined;
    this.alarms += 1;
  }

  async readJob(): Promise<StoredImportJob | undefined> {
    return this.job;
  }

  async writeJob(job: StoredImportJob): Promise<void> {
    this.job = structuredClone(job);
  }

  async readCheckpoint(): Promise<ImportCheckpoint | undefined> {
    return this.checkpoint;
  }

  async writeCheckpoint(checkpoint: ImportCheckpoint): Promise<void> {
    this.checkpoint = structuredClone(checkpoint);
  }

  async completePublishedJob(): Promise<void> {
    this.job = undefined;
    this.checkpoint = undefined;
    this.alarms += 1;
  }

  async armAlarm(): Promise<void> {
    this.alarms += 1;
  }
}

const imported: ImportedBranch = {
  branch: "trunk",
  oid: "0123456789012345678901234567890123456789",
  shallow: [],
  objects: 4,
};

const job = {
  namespaceSlug: "acme",
  repositoryName: "mirror",
  createdAt: "2026-08-13T12:00:00.000Z",
  initialBranch: "main",
  request: { url: "https://git.example/acme/project.git" },
} as const;

const unusedPointer = async () => null;
const unusedDelete = async () => null;

describe("ImportOperation", () => {
  test("resumes publication after a registry RPC failure without fetching again", async () => {
    const storage = new MemoryImportStorage();
    let imports = 0;
    let publishes = 0;
    let destroyed = false;
    const registry: ImportRegistry = {
      finishImport: async () => {
        publishes += 1;
        if (publishes === 1) throw new Error("registry restarted");
        return true;
      },
      getRepository: unusedPointer,
      deleteImportIfOwned: unusedDelete,
    };
    const operation = new ImportOperation({
      durableObjectId: "object-old",
      storage,
      repository: {
        resetImport: async () => {},
        importBranch: async () => {
          imports += 1;
          return imported;
        },
        destroy: async () => {
          destroyed = true;
        },
      },
      registry,
    });

    const waiting = await operation.schedule(job);

    expect(waiting).toMatchObject({ completed: false, retrying: true });
    expect(storage.checkpoint).toEqual({ kind: "imported", imported });
    expect(storage.job).toBeDefined();
    expect(destroyed).toBe(false);

    expect(await operation.run()).toEqual({ completed: true, imported });
    expect(imports).toBe(1);
    expect(publishes).toBe(2);
    expect(storage.job).toBeUndefined();
    expect(storage.checkpoint).toBeUndefined();
  });

  test("gives up when a crashed run already spent every attempt", async () => {
    // A run that dies without throwing leaves its attempt counted in storage;
    // the alarm brings it back here, and it must not fetch again forever.
    const storage = new MemoryImportStorage();
    let imports = 0;
    let destroyed = false;
    const operation = new ImportOperation({
      durableObjectId: "object-old",
      storage,
      repository: {
        resetImport: async () => {},
        importBranch: async () => {
          imports += 1;
          return imported;
        },
        destroy: async () => {
          destroyed = true;
        },
      },
      registry: {
        finishImport: async () => true,
        getRepository: unusedPointer,
        deleteImportIfOwned: unusedDelete,
      },
    });
    storage.job = { ...job, attempts: 3 };

    expect(await operation.run()).toMatchObject({
      completed: false,
      retrying: false,
      code: "upstream-unavailable",
    });
    expect(imports).toBe(0);
    expect(destroyed).toBe(true);
  });

  test("cannot publish or delete a replacement owned by another object", async () => {
    const storage = new MemoryImportStorage();
    const guardedIds: string[] = [];
    let destroyed = false;
    const operation = new ImportOperation({
      durableObjectId: "object-old",
      storage,
      repository: {
        resetImport: async () => {},
        importBranch: async () => imported,
        destroy: async () => {
          destroyed = true;
        },
      },
      registry: {
        finishImport: async (_namespace, _name, durableObjectId) => {
          guardedIds.push(durableObjectId);
          return false;
        },
        getRepository: async () => ({
          durableObjectId: "object-new",
          status: "importing",
          repository: {
            id: "repo_new",
            name: "mirror",
            description: null,
            default_branch: "main",
            created_at: "2026-08-13T12:01:00.000Z",
            updated_at: "2026-08-13T12:01:00.000Z",
            last_push_at: null,
            source: "git:https://git.example/new.git",
            read_only: false,
          },
        }),
        deleteImportIfOwned: async (_namespace, _name, durableObjectId) => {
          guardedIds.push(durableObjectId);
          return null;
        },
      },
    });

    const outcome = await operation.schedule(job);

    expect(outcome).toMatchObject({ completed: false, retrying: false, code: "internal" });
    expect(guardedIds).toEqual(["object-old", "object-old"]);
    expect(destroyed).toBe(true);
  });

  test("retries terminal cleanup after a registry failure without importing again", async () => {
    const storage = new MemoryImportStorage();
    let imports = 0;
    let deletes = 0;
    let destroyed = false;
    const operation = new ImportOperation({
      durableObjectId: "object-old",
      storage,
      repository: {
        resetImport: async () => {},
        importBranch: async () => {
          imports += 1;
          throw new PackError("truncated", "The pack ended early.");
        },
        destroy: async () => {
          destroyed = true;
        },
      },
      registry: {
        finishImport: async () => false,
        getRepository: unusedPointer,
        deleteImportIfOwned: async () => {
          deletes += 1;
          if (deletes === 1) throw new Error("registry unavailable");
          return null;
        },
      },
    });

    expect(await operation.schedule(job)).toMatchObject({ completed: false, retrying: true });
    expect(storage.checkpoint).toMatchObject({
      kind: "failed",
      failure: { code: "invalid-pack", packErrorCode: "truncated" },
    });
    expect(destroyed).toBe(false);

    expect(await operation.run()).toMatchObject({
      completed: false,
      retrying: false,
      code: "invalid-pack",
      packErrorCode: "truncated",
    });
    expect(imports).toBe(1);
    expect(deletes).toBe(2);
    expect(destroyed).toBe(true);
  });
});
