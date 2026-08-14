import type { TokenScope } from "@open-relic/contracts";

import type { ApiEnv } from "../../../alchemy.run.ts";
import {
  forkInProgress,
  gitAuthenticationRequired,
  importInProgress,
  notFound,
} from "./envelope.ts";
import type { AuthorizeGitRequest } from "./git/authorization.ts";
import type { RepositoryIndexClient, RepositoryPointer } from "./repository-index.ts";

export interface GitRepositoryAccess {
  readonly request: Request;
  readonly requiredScope: TokenScope;
}

export interface ResolveRepositoryCommand {
  readonly env: ApiEnv;
  readonly namespace: string;
  readonly name: string;
  /** Omitted on the separately authorized REST control plane. */
  readonly git?: GitRepositoryAccess;
}

/**
 * The one boundary for turning a public `namespace/name` into the pointer that
 * can reach its repository object. A refusal is already a wire response, so a
 * route cannot accidentally vary its status, error code, or wording.
 */
export interface RepositoryResolver {
  readonly resolve: (command: ResolveRepositoryCommand) => Promise<RepositoryPointer | Response>;
}

export const repositoryNotFound = (namespace: string, name: string): Response =>
  notFound(`No repository named "${namespace}/${name}" exists.`);

export const createRepositoryResolver = (
  repositoryIndex: (env: ApiEnv) => RepositoryIndexClient,
  authorizeGit: AuthorizeGitRequest,
): RepositoryResolver => ({
  resolve: async ({ env, namespace, name, git }) => {
    // Authorization deliberately precedes the lookup: an invalid Git token
    // must not be able to discover whether a repository exists (ADR-0004).
    if (git !== undefined) {
      const decision = await authorizeGit({
        env,
        request: git.request,
        namespace,
        repository: name,
        requiredScope: git.requiredScope,
      });
      if (!decision.allowed) {
        return gitAuthenticationRequired(decision.detail);
      }
    }

    const found = await repositoryIndex(env).getRepository(namespace, name);
    if (found === null) {
      return repositoryNotFound(namespace, name);
    }
    if (found.status === "forking") {
      return forkInProgress(`The repository "${namespace}/${name}" is still being forked.`);
    }
    if (found.status === "importing") {
      return importInProgress(`The repository "${namespace}/${name}" is still being imported.`);
    }
    return found;
  },
});
