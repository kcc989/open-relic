import type { ApiEnv } from "../../../../alchemy.run.ts";
import { OPEN_RELIC_API_TOKEN_VARIABLE } from "../../src/api-token.ts";

/** A partial Worker environment for tests that inject every non-token dependency. */
export const envWithApiToken = (token?: string): ApiEnv => {
  // SAFETY: callers use this only where the API-token binding is the sole environment dependency.
  return (token === undefined ? {} : { [OPEN_RELIC_API_TOKEN_VARIABLE]: token }) as ApiEnv;
};
