import type { ApiEnv } from "../../../alchemy.run.ts";

export const CONTROL_PLANE_TOKEN_VARIABLE = "OPEN_RELIC_API_TOKEN";

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

const sameToken = (left: string, right: string): boolean => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
};

/**
 * The installation's control-plane credential. It is distinct from a
 * repo-scoped Git token and protects every route rooted at `/namespaces`.
 */
export const authorizeInstallationApiToken: AuthorizeControlPlaneRequest = ({ env, request }) => {
  // SAFETY: an unset Worker secret is absent at runtime even though ApiEnv names the binding.
  const configured = (env as Partial<ApiEnv> | undefined)?.[CONTROL_PLANE_TOKEN_VARIABLE];
  const presented = bearerToken(request);

  return (
    configured !== undefined &&
    configured.length > 0 &&
    presented !== null &&
    sameToken(configured, presented)
  );
};

/** Test-only seam for suites whose subject is below control-plane authentication. */
export const allowControlPlane: AuthorizeControlPlaneRequest = () => true;
