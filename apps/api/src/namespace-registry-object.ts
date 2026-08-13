import type { Namespace } from "@open-relic/contracts";
import { DurableObject } from "cloudflare:workers";
import {
  drizzle,
  type DrizzleSqliteDODatabase,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../drizzle/migrations.js";
import {
  NamespaceRegistry,
  type CreateNamespaceCommand,
  type CreateNamespaceOutcome,
} from "./namespace-registry.ts";

/**
 * Every namespace in the installation lives in this one Durable Object.
 *
 * Namespaces are a small, globally-unique index — allocating a slug has to be
 * a single serialized decision, and listing them has to see all of them — so
 * one SQLite-backed object holds the whole registry rather than one object per
 * namespace. Repository data stays out of here; it belongs to
 * `RepositoryObject`, which shards per repository.
 *
 * The class is deliberately just an RPC shell: the queries live in
 * {@link NamespaceRegistry}, over a drizzle database this constructor happens
 * to build from `ctx.storage`.
 */
export class NamespaceRegistryObject extends DurableObject {
  readonly #db: DrizzleSqliteDODatabase;
  readonly #registry: NamespaceRegistry;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this.#db = drizzle(ctx.storage);
    this.#registry = new NamespaceRegistry(this.#db);

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

  deleteNamespace(slug: string): Promise<boolean> {
    return this.#registry.deleteNamespace(slug);
  }
}
