import type { ApiEnv } from "../../../alchemy.run.ts";

export const OPEN_RELIC_API_TOKEN_VARIABLE = "OPEN_RELIC_API_TOKEN";
export const API_TOKEN_MIN_BYTES = 32;

const encoder = new TextEncoder();

/** A configured API token is measured as UTF-8 because that is what authentication compares. */
export const isValidApiToken = (token: string | undefined): token is string =>
  token !== undefined && encoder.encode(token).byteLength >= API_TOKEN_MIN_BYTES;

/**
 * Preserve an absent or empty value so the deployed Worker can report the
 * configuration failure, but refuse an explicitly supplied non-empty weak
 * value before Alchemy plans or deploys it.
 */
export const apiTokenForDeployment = (token: string | undefined): string => {
  if (token !== undefined && token.length > 0 && !isValidApiToken(token)) {
    throw new Error(
      `${OPEN_RELIC_API_TOKEN_VARIABLE} must be at least ${API_TOKEN_MIN_BYTES} bytes.`,
    );
  }
  return token ?? "";
};

/** Invalid runtime configuration is indistinguishable from a missing binding. */
export const apiTokenFromEnv = (env: ApiEnv | undefined): string | null => {
  // SAFETY: the binding may be absent on a misconfigured deployment even though ApiEnv names it.
  const token = (env as Partial<ApiEnv> | undefined)?.[OPEN_RELIC_API_TOKEN_VARIABLE];
  return isValidApiToken(token) ? token : null;
};

const digest = (token: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", encoder.encode(token));

/** Compare against the configured API token without length or first-byte timing exits. */
export const matchesApiToken = async (
  env: ApiEnv | undefined,
  presentedToken: string,
): Promise<boolean> => {
  const configuredToken = apiTokenFromEnv(env);
  if (configuredToken === null) {
    return false;
  }

  // Hash both values to a fixed width before comparing, so neither an early
  // length check nor a first-different-byte exit reveals anything about the
  // configured API token.
  const [configuredDigest, presentedDigest] = await Promise.all([
    digest(configuredToken),
    digest(presentedToken),
  ]);
  const configuredBytes = new Uint8Array(configuredDigest);
  const presentedBytes = new Uint8Array(presentedDigest);
  let difference = 0;

  for (let index = 0; index < configuredBytes.length; index += 1) {
    difference |= configuredBytes[index]! ^ presentedBytes[index]!;
  }
  return difference === 0;
};
