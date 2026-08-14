import type { TokenScope } from "../contracts.ts";

import type { ApiEnv } from "../../../../alchemy.run.ts";
import type { TokenRegistryClient } from "../token-registry.ts";

export interface GitAuthorizationRequest {
  readonly env: ApiEnv;
  readonly request: Request;
  readonly namespace: string;
  readonly repository: string;
  readonly requiredScope: TokenScope;
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly detail: string };

export type AuthorizeGitRequest = (
  request: GitAuthorizationRequest,
) => Promise<AuthorizationDecision>;

const bearerToken = (authorization: string): string | null => {
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
};

const basicToken = (authorization: string): string | null => {
  const match = /^Basic\s+(.+)$/i.exec(authorization);
  if (match === null) {
    return null;
  }

  try {
    const decoded = atob(match[1]!);
    const separator = decoded.indexOf(":");
    return separator <= 0 ? null : decoded.slice(separator + 1);
  } catch {
    return null;
  }
};

/** Both credential spellings Artifacts documents for Git Smart HTTP. */
export const tokenFromRequest = (request: Request): string | null => {
  const authorization = request.headers.get("Authorization");
  return authorization === null ? null : (bearerToken(authorization) ?? basicToken(authorization));
};

const REFUSAL = "A valid token with the required scope is needed for this Git operation.";

/** Builds the authorization seam over the same registry the REST routes write. */
export const authorizeRepoToken =
  (resolveTokens: (env: ApiEnv) => TokenRegistryClient): AuthorizeGitRequest =>
  async ({ env, request, namespace, repository, requiredScope }) => {
    const presentedToken = tokenFromRequest(request);
    if (presentedToken === null) {
      return { allowed: false, detail: REFUSAL };
    }

    const allowed = await resolveTokens(env).authorizeToken({
      presentedToken,
      namespaceSlug: namespace,
      repositoryName: repository,
      requiredScope,
    });

    return allowed ? { allowed: true } : { allowed: false, detail: REFUSAL };
  };
