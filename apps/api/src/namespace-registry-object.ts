import type { Namespace, Repository } from "@open-relic/contracts";
import { DurableObject } from "cloudflare:workers";
import {
  drizzle,
  type DrizzleSqliteDODatabase,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../drizzle/registry/migrations.js";
import {
  NamespaceRegistry,
  type CreateNamespaceCommand,
  type CreateNamespaceOutcome,
  type DeleteNamespaceOutcome,
} from "./namespace-registry.ts";
import {
  RepositoryIndex,
  type CreateRepositoryCommand,
  type CreateRepositoryOutcome,
  type RepositoryPointer,
} from "./repository-index.ts";

/**
 * Every namespace in the installation, and the index of every repository, live
 * in this one Durable Object.
 *
 * Namespaces are a small, globally-unique index — allocating a slug has to be
 * a single serialized decision, and listing them has to see all of them — so
 * one SQLite-backed object holds the whole registry rather than one object per
 * namespace. Repository names are allocated the same way, and the index row
 * holds the pointer — a Durable Object id — to the `RepositoryObject` that
 * actually stores the repository. Repository *contents* stay out of here.
 *
 * The class is deliberately just an RPC shell: the queries live in
 * {@link NamespaceRegistry} and {@link RepositoryIndex}, over a drizzle
 * database this constructor happens to build from `ctx.storage`.
 */
export class NamespaceRegistryObject extends DurableObject {
  readonly #db: DrizzleSqliteDODatabase;
  readonly #registry: NamespaceRegistry;
  readonly #repositories: RepositoryIndex;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.#db = drizzle(ctx.storage);
    this.#registry = new NamespaceRegistry(this.#db);
    this.#repositories = new RepositoryIndex(this.#db);

    // Migrations are applied by the object itself — there is no separate
    // migration runner and no network-connected database to push to. Blocking
    // concurrency here means no request can reach a half-migrated schema, even
    // on the first request after an eviction.
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.#db, migrations);
    });
  }

  createNamespace(
    command: CreateNamespaceCommand,
  ): Promise<CreateNamespaceOutcome> {
    return this.#registry.createNamespace(command);
  }

  listNamespaces(): Promise<Namespace[]> {
    return this.#registry.listNamespaces();
  }

  getNamespace(slug: string): Promise<Namespace | null> {
    return this.#registry.getNamespace(slug);
  }

  deleteNamespace(slug: string): Promise<DeleteNamespaceOutcome> {
    return this.#registry.deleteNamespace(slug);
  }

  createRepository(
    command: CreateRepositoryCommand,
  ): Promise<CreateRepositoryOutcome> {
    return this.#repositories.createRepository(command);
  }

  listRepositories(
    namespaceSlug: string,
  ): Promise<readonly Repository[] | null> {
    return this.#repositories.listRepositories(namespaceSlug);
  }

  getRepository(
    namespaceSlug: string,
    name: string,
  ): Promise<RepositoryPointer | null> {
    return this.#repositories.getRepository(namespaceSlug, name);
  }

  deleteRepository(
    namespaceSlug: string,
    name: string,
  ): Promise<string | null> {
    return this.#repositories.deleteRepository(namespaceSlug, name);
  }
}
