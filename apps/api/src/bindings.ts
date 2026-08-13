import type { ApiEnv } from "../../../alchemy.run.ts";
import type { NamespaceRegistryClient } from "./namespace-registry.ts";
import type { RepositoryIndexClient } from "./repository-index.ts";
import type { RepositoryObjectClient } from "./repository-store.ts";
import type { TokenRegistryClient } from "./token-registry.ts";

/**
 * Every request resolves the same id, so allocating a namespace slug or a
 * repository name is serialized by one Durable Object.
 */
export const NAMESPACE_REGISTRY_KEY = "registry";

export const namespaceRegistryFromEnv = (env: ApiEnv): NamespaceRegistryClient =>
  env.NAMESPACES.getByName(NAMESPACE_REGISTRY_KEY);

/**
 * The index lives in the same object as the namespace registry, so this is the
 * same stub through a narrower interface.
 */
export const repositoryIndexFromEnv = (env: ApiEnv): RepositoryIndexClient =>
  env.NAMESPACES.getByName(NAMESPACE_REGISTRY_KEY);

/** Token lookup shares the registry object so it can precede repository resolution. */
export const tokenRegistryFromEnv = (env: ApiEnv): TokenRegistryClient =>
  env.NAMESPACES.getByName(NAMESPACE_REGISTRY_KEY);

/** The repository objects themselves, addressed by the ids the index stores. */
export interface RepositoryObjects {
  readonly createId: () => string;
  readonly get: (durableObjectId: string) => RepositoryObjectClient;
}

export const repositoryObjectsFromEnv = (env: ApiEnv): RepositoryObjects => ({
  createId: () => env.REPOSITORIES.newUniqueId().toString(),
  get: (durableObjectId) => env.REPOSITORIES.get(env.REPOSITORIES.idFromString(durableObjectId)),
});
