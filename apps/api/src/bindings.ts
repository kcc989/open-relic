import type { ApiEnv } from "../../../alchemy.run.ts";
import type { NamespaceRegistryClient } from "./namespace-registry.ts";
import type { RepositoryIndexClient } from "./repository-index.ts";
import type { RepositoryObjectClient } from "./repository-store.ts";

/**
 * Name of the single registry object. Every request resolves the same id, so
 * allocating a namespace slug or a repository name is serialized by one
 * Durable Object.
 */
export const NAMESPACE_REGISTRY_KEY = "registry";

export const namespaceRegistryFromEnv = (
  env: ApiEnv,
): NamespaceRegistryClient => env.NAMESPACES.getByName(NAMESPACE_REGISTRY_KEY);

/**
 * The repository index lives in the same object as the namespace registry —
 * the index row is what points a namespace at a repository — so this resolves
 * the same stub through a narrower interface.
 */
export const repositoryIndexFromEnv = (env: ApiEnv): RepositoryIndexClient =>
  env.NAMESPACES.getByName(NAMESPACE_REGISTRY_KEY);

/**
 * The repository objects themselves, addressed by the ids the index stores.
 *
 * Ids are minted here rather than inside the registry so that a create the
 * index rejects never leaves an initialized object behind: an unused id has no
 * storage attached to it.
 */
export interface RepositoryObjects {
  readonly createId: () => string;
  readonly get: (durableObjectId: string) => RepositoryObjectClient;
}

export const repositoryObjectsFromEnv = (env: ApiEnv): RepositoryObjects => ({
  createId: () => env.REPOSITORIES.newUniqueId().toString(),
  get: (durableObjectId) =>
    env.REPOSITORIES.get(env.REPOSITORIES.idFromString(durableObjectId)),
});
