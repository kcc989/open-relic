import {
  NAMESPACES_PATH,
  type CreateNamespaceRequest,
  type CreateRepoRequest,
  type CreateRepoResult,
} from "@open-relic/contracts";

import type { RepositoryObjects } from "../../src/bindings.ts";
import { createApp } from "../../src/app.ts";
import {
  allowControlPlane,
  type AuthorizeControlPlaneRequest,
} from "../../src/control-plane-authorization.ts";
import { NamespaceRegistry } from "../../src/namespace-registry.ts";
import { RepositoryIndex } from "../../src/repository-index.ts";
import {
  RepositoryStore,
  type RepositoryObjectClient,
  type RepositorySnapshot,
} from "../../src/repository-store.ts";
import { TokenRegistry } from "../../src/token-registry.ts";
import {
  createTestDatabase,
  createTestRepositoryStorage,
  seedRefs,
  type TestRepositoryStorage,
} from "./database.ts";
import { result } from "./envelope.ts";

export interface PausedForkSnapshot {
  readonly captured: Promise<void>;
  readonly release: () => void;
}

/**
 * The `REPOSITORIES` binding, standing in for the Durable Object namespace.
 * Each id gets a real {@link RepositoryStore} over its own in-memory storage;
 * only the RPC hop and Durable Object placement are skipped. Minted and
 * destroyed ids are recorded so tests can assert that a rejected create leaves
 * no object behind and a delete takes one with it.
 */
export class FakeRepositoryObjects implements RepositoryObjects {
  readonly #storages = new Map<string, TestRepositoryStorage>();
  readonly #stores = new Map<string, RepositoryStore>();
  readonly #minted: string[] = [];
  readonly #destroyed: string[] = [];
  #serializedRpcLimit = Number.POSITIVE_INFINITY;
  #forkWriteError: Error | null = null;
  #afterForkSnapshot: (() => Promise<void>) | null = null;

  createId(): string {
    const id = `repository-object-${this.#minted.length + 1}`;
    this.#minted.push(id);
    return id;
  }

  get(durableObjectId: string): RepositoryObjectClient {
    const store = this.#storeFor(durableObjectId);

    return {
      initialize: (init) => store.initialize(init),
      describe: () => store.describe(),
      advertiseReceivePack: () => store.advertiseReceivePack(),
      advertiseUploadPack: (protocolVersion) => store.advertiseUploadPack(protocolVersion),
      uploadPack: (body) => store.uploadPack(body),
      receivePack: (body) => store.receivePack(body),
      copyForkTo: (target, options) => {
        const afterSnapshot = this.#afterForkSnapshot ?? undefined;
        this.#afterForkSnapshot = null;
        return store.copyForkTo(target, options, afterSnapshot);
      },
      writeForkObject: (object, bytes) => {
        const error = this.#forkWriteError;
        this.#forkWriteError = null;
        if (error !== null) {
          return Promise.reject(error);
        }
        return store.writeForkObject(object, bytes);
      },
      completeFork: (state) => store.completeFork(state),
      readObject: async (oid) => {
        const object = await store.readObject(oid);
        if (object !== null && object.bytes.byteLength >= this.#serializedRpcLimit) {
          throw new Error("The test RPC value exceeds its serialized size limit.");
        }
        return object;
      },
      readBlob: (oid) => store.readBlob(oid),
      hasObject: (oid) => store.hasObject(oid),
      sweep: () => store.sweep(),
      destroy: async () => {
        this.#destroyed.push(durableObjectId);
        this.#storages.get(durableObjectId)?.close();
        this.#storages.delete(durableObjectId);
        this.#stores.delete(durableObjectId);
      },
    };
  }

  /** Every id handed out, in the order the routes asked for them. */
  get mintedIds(): readonly string[] {
    return this.#minted;
  }

  get destroyedIds(): readonly string[] {
    return this.#destroyed;
  }

  /** The ids that still hold storage: created and not destroyed. */
  get liveIds(): readonly string[] {
    return [...this.#storages.keys()];
  }

  /** Scale down Workers' serialized-RPC ceiling so route tests can cross it cheaply. */
  limitSerializedRpcTo(bytes: number): void {
    this.#serializedRpcLimit = bytes;
  }

  describe(durableObjectId: string): Promise<RepositorySnapshot | null> {
    return this.get(durableObjectId).describe();
  }

  /** Stands in for the push that will write them once receive-pack lands. */
  seedRefs(durableObjectId: string, entries: Readonly<Record<string, string>>): Promise<void> {
    return seedRefs(this.#storageFor(durableObjectId).db, entries);
  }

  failNextForkWrite(error: Error): void {
    this.#forkWriteError = error;
  }

  pauseNextForkAfterSnapshot(): PausedForkSnapshot {
    let signalCaptured = (): void => {};
    let release = (): void => {};
    const captured = new Promise<void>((resolve) => {
      signalCaptured = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#afterForkSnapshot = async () => {
      signalCaptured();
      await paused;
    };
    return { captured, release };
  }

  close(): void {
    for (const storage of this.#storages.values()) {
      storage.close();
    }
    this.#storages.clear();
    this.#stores.clear();
  }

  #storageFor(durableObjectId: string): TestRepositoryStorage {
    const existing = this.#storages.get(durableObjectId);
    if (existing !== undefined) {
      return existing;
    }

    const created = createTestRepositoryStorage();
    this.#storages.set(durableObjectId, created);
    return created;
  }

  #storeFor(durableObjectId: string): RepositoryStore {
    const existing = this.#stores.get(durableObjectId);
    if (existing !== undefined) {
      return existing;
    }
    const storage = this.#storageFor(durableObjectId);
    const created = new RepositoryStore(storage.db, storage.kv);
    this.#stores.set(durableObjectId, created);
    return created;
  }
}

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly objects: FakeRepositoryObjects;
  /** The write token returned once when `createGitTestApp` creates its repository. */
  readonly repositoryToken: string | null;
  readonly close: () => void;
}

/**
 * An installation holding `acme/demo`, which is what every Git test needs
 * before it can ask a repository anything. Built through the REST API rather
 * than by seeding rows, so a Git test is always talking to a repository the
 * service itself created.
 */
export const createGitTestApp = async (
  repository: Partial<CreateRepoRequest> = {},
  now: () => Date = () => new Date(),
): Promise<TestApp> => {
  const harness = createTestApp(now);

  const post = (path: string, body: CreateNamespaceRequest | CreateRepoRequest) =>
    harness.app.request(
      new Request(`http://local.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  await post(NAMESPACES_PATH, { slug: "acme" });
  const created = await result<CreateRepoResult>(
    await post(`${NAMESPACES_PATH}/acme/repos`, { name: "demo", ...repository }),
  );

  return { ...harness, repositoryToken: created.token };
};

export const createTestApp = (
  now: () => Date = () => new Date(),
  authorizeControlPlane: AuthorizeControlPlaneRequest = allowControlPlane,
): TestApp => {
  const registryDatabase = createTestDatabase();
  const registry = new NamespaceRegistry(registryDatabase.db);
  const index = new RepositoryIndex(registryDatabase.db);
  const tokenRegistry = new TokenRegistry(registryDatabase.db, now);
  const objects = new FakeRepositoryObjects();

  const app = createApp({
    namespaceRegistry: () => registry,
    repositoryIndex: () => index,
    repositoryObjects: () => objects,
    tokenRegistry: () => tokenRegistry,
    authorizeControlPlane,
  });

  return {
    app,
    objects,
    repositoryToken: null,
    close: () => {
      objects.close();
      registryDatabase.close();
    },
  };
};
