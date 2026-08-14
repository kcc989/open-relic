import type { ApiEnv } from "../../../alchemy.run.ts";
import { matchesApiToken } from "./api-token.ts";

export interface ControlPlaneAuthorizationRequest {
  readonly env: ApiEnv;
  readonly request: Request;
}

export type AuthorizeControlPlaneRequest = (
  request: ControlPlaneAuthorizationRequest,
) => boolean | Promise<boolean>;

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("Authorization");
  if (authorization === null) {
    return null;
  }
  return /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? null;
};

/**
 * The installation's control-plane credential. It is distinct from a
 * repository-scoped Git token and protects every route rooted at `/namespaces`.
 */
export const authorizeApiToken: AuthorizeControlPlaneRequest = async ({ env, request }) => {
  const presented = bearerToken(request);

  return presented !== null && (await matchesApiToken(env, presented));
};

/** Test-only seam for suites whose subject is below control-plane authentication. */
export const allowControlPlane: AuthorizeControlPlaneRequest = () => true;
