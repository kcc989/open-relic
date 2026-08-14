import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../drizzle/registry/migrations.js";
import { withNamespaceRegistry } from "./namespace-registry.ts";
import { REGISTRY_DATABASE, REGISTRY_NOW, type RegistryStorage } from "./registry-storage.ts";
import { withRepositoryIndex } from "./repository-index.ts";
import { withTokenRegistry } from "./token-registry.ts";

class DurableRegistryStorage extends DurableObject implements RegistryStorage {
  readonly [REGISTRY_DATABASE]: DrizzleSqliteDODatabase;
  readonly [REGISTRY_NOW] = () => new Date();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    this[REGISTRY_DATABASE] = drizzle(ctx.storage);

    // Each object migrates its own storage — there is no network-connected
    // database to push to. Blocking means no request can reach a half-migrated
    // schema, on first start or after an eviction.
    ctx.blockConcurrencyWhile(async () => {
      migrate(this[REGISTRY_DATABASE], migrations);
    });
  }
}

/**
 * Every namespace in the installation, and the index of every repository, in
 * one Durable Object: allocating a slug or a repository name has to be a single
 * serialized decision, and listing namespaces has to see all of them.
 * Repository *contents* stay out of here — the index row only points at the
 * `RepositoryObject` that holds them.
 */
export class NamespaceRegistryObject extends withTokenRegistry(
  withRepositoryIndex(withNamespaceRegistry(DurableRegistryStorage)),
) {}
