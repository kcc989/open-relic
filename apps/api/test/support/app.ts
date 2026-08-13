import { NAMESPACES_PATH } from "@open-relic/contracts";

import type { RepositoryObjects } from "../../src/bindings.ts";
import { createApp } from "../../src/app.ts";
import { NamespaceRegistry } from "../../src/namespace-registry.ts";
import { RepositoryIndex } from "../../src/repository-index.ts";
import {
  RepositoryStore,
  type RepositoryObjectClient,
  type RepositorySnapshot,
} from "../../src/repository-store.ts";
import {
  createTestDatabase,
  createTestRepositoryStorage,
  seedRefs,
  type TestRepositoryStorage,
} from "./database.ts";

/**
 * The `REPOSITORIES` binding, standing in for the Durable Object namespace.
 * Each id gets a real {@link RepositoryStore} over its own in-memory storage;
 * only the RPC hop and Durable Object placement are skipped. Minted and
 * destroyed ids are recorded so tests can assert that a rejected create leaves
 * no object behind and a delete takes one with it.
 */
export class FakeRepositoryObjects implements RepositoryObjects {
  readonly #storages = new Map<string, TestRepositoryStorage>();
  readonly #minted: string[] = [];
  readonly #destroyed: string[] = [];

  createId(): string {
    const id = `repository-object-${this.#minted.length + 1}`;
    this.#minted.push(id);
    return id;
  }

  get(durableObjectId: string): RepositoryObjectClient {
    const storage = this.#storageFor(durableObjectId);
    const store = new RepositoryStore(storage.db, storage.kv);

    return {
      initialize: (init) => store.initialize(init),
      describe: () => store.describe(),
      advertiseReceivePack: () => store.advertiseReceivePack(),
      receivePack: (body) => store.receivePack(body),
      destroy: async () => {
        this.#destroyed.push(durableObjectId);
        this.#storages.get(durableObjectId)?.close();
        this.#storages.delete(durableObjectId);
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

  describe(durableObjectId: string): Promise<RepositorySnapshot | null> {
    return this.get(durableObjectId).describe();
  }

  /** Stands in for the push that will write them once receive-pack lands. */
  seedRefs(
    durableObjectId: string,
    entries: Readonly<Record<string, string>>,
  ): Promise<void> {
    return seedRefs(this.#storageFor(durableObjectId).db, entries);
  }

  close(): void {
    for (const storage of this.#storages.values()) {
      storage.close();
    }
    this.#storages.clear();
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
}

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly objects: FakeRepositoryObjects;
  readonly close: () => void;
}

/**
 * An installation holding `acme/demo`, which is what every Git test needs
 * before it can ask a repository anything. Built through the REST API rather
 * than by seeding rows, so a Git test is always talking to a repository the
 * service itself created.
 */
export const createGitTestApp = async (
  repository: Record<string, unknown> = {},
): Promise<TestApp> => {
  const harness = createTestApp();

  const post = (path: string, body: Record<string, unknown>) =>
    harness.app.request(
      new Request(`http://local.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  await post(NAMESPACES_PATH, { slug: "acme" });
  await post(`${NAMESPACES_PATH}/acme/repos`, { name: "demo", ...repository });

  return harness;
};

export const createTestApp = (): TestApp => {
  const registryDatabase = createTestDatabase();
  const registry = new NamespaceRegistry(registryDatabase.db);
  const index = new RepositoryIndex(registryDatabase.db);
  const objects = new FakeRepositoryObjects();

  const app = createApp({
    namespaceRegistry: () => registry,
    repositoryIndex: () => index,
    repositoryObjects: () => objects,
  });

  return {
    app,
    objects,
    close: () => {
      objects.close();
      registryDatabase.close();
    },
  };
};
