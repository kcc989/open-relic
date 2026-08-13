/**
 * The seam every Git request passes through before it reaches a repository.
 * Repo-scoped tokens replace the implementation below; the shape is what a
 * token check needs — the credential on the request, and the repository it is
 * being spent against.
 */

import type { ApiEnv } from "../../../../alchemy.run.ts";

export interface GitAuthorizationRequest {
  readonly env: ApiEnv;
  readonly request: Request;
  readonly namespace: string;
  readonly repository: string;
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly detail: string };

export type AuthorizeGitRequest = (
  request: GitAuthorizationRequest,
) => AuthorizationDecision;

/**
 * The installation's blanket opt-in to unauthenticated pushes. A `string`
 * rather than a boolean because it is a Worker environment variable, and its
 * absence is the case that matters.
 */
export const ANONYMOUS_WRITE_VARIABLE = "ALLOW_ANONYMOUS_WRITE";

const ANONYMOUS_WRITE_ENABLED = "true";

/**
 * Allows everyone, but only where the installation has said so. Absent
 * configuration is a refusal rather than a default, so an installation that has
 * never heard of this variable is closed rather than open to the world.
 */
export const allowAnonymousWrite: AuthorizeGitRequest = ({ env }) => {
  // `env` is typed as always present, but a Worker deployed without the
  // variable is exactly the case this exists to refuse.
  const configured = (env as Partial<ApiEnv> | undefined)?.[
    ANONYMOUS_WRITE_VARIABLE
  ];

  return configured === ANONYMOUS_WRITE_ENABLED
    ? { allowed: true }
    : {
        allowed: false,
        detail: `This installation does not allow unauthenticated writes. Set ${ANONYMOUS_WRITE_VARIABLE}="${ANONYMOUS_WRITE_ENABLED}" to enable them.`,
      };
};
