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
  createTestRepositoryDatabase,
  type TestDatabase,
} from "./database.ts";

/**
 * The `REPOSITORIES` binding, standing in for the Durable Object namespace.
 *
 * Each id gets a real {@link RepositoryStore} over its own in-memory database
 * migrated from `drizzle/repository`, so the object side of a create is
 * exercised for real; only the RPC hop and Durable Object placement are
 * skipped. Which ids were minted and destroyed is recorded so tests can assert
 * that a rejected create leaves no object behind and a delete takes one with
 * it.
 */
export class FakeRepositoryObjects implements RepositoryObjects {
  readonly #databases = new Map<string, TestDatabase>();
  readonly #minted: string[] = [];
  readonly #destroyed: string[] = [];

  createId(): string {
    const id = `repository-object-${this.#minted.length + 1}`;
    this.#minted.push(id);
    return id;
  }

  get(durableObjectId: string): RepositoryObjectClient {
    const store = new RepositoryStore(this.#databaseFor(durableObjectId).db);

    return {
      initialize: (init) => store.initialize(init),
      describe: () => store.describe(),
      destroy: async () => {
        this.#destroyed.push(durableObjectId);
        this.#databases.get(durableObjectId)?.close();
        this.#databases.delete(durableObjectId);
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

  /** The ids that currently hold storage — an object that was created and not destroyed. */
  get liveIds(): readonly string[] {
    return [...this.#databases.keys()];
  }

  describe(durableObjectId: string): Promise<RepositorySnapshot | null> {
    return this.get(durableObjectId).describe();
  }

  close(): void {
    for (const database of this.#databases.values()) {
      database.close();
    }
    this.#databases.clear();
  }

  #databaseFor(durableObjectId: string): TestDatabase {
    const existing = this.#databases.get(durableObjectId);
    if (existing !== undefined) {
      return existing;
    }

    const created = createTestRepositoryDatabase();
    this.#databases.set(durableObjectId, created);
    return created;
  }
}

export interface TestApp {
  readonly app: ReturnType<typeof createApp>;
  readonly objects: FakeRepositoryObjects;
  readonly close: () => void;
}

/**
 * The whole API over one in-memory registry database and a set of in-memory
 * repository objects — the real routes, the real queries, the real migrations.
 */
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
