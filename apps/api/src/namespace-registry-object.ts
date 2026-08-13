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
 * Every namespace in the installation, and the index of every repository, in
 * one Durable Object: allocating a slug or a repository name has to be a single
 * serialized decision, and listing namespaces has to see all of them.
 * Repository *contents* stay out of here — the index row only points at the
 * `RepositoryObject` that holds them.
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

    // Each object migrates its own storage — there is no network-connected
    // database to push to. Blocking means no request can reach a half-migrated
    // schema, on first start or after an eviction.
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
