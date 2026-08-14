import { describe, expect, test } from "bun:test";

import {
  API_TOKEN_MIN_BYTES,
  OPEN_RELIC_API_TOKEN_VARIABLE,
  apiTokenForDeployment,
  apiTokenFromEnv,
  isValidApiToken,
} from "../src/api-token.ts";
import { envWithApiToken } from "./support/env.ts";

describe("API token configuration", () => {
  test("requires at least 32 UTF-8 bytes", () => {
    expect(API_TOKEN_MIN_BYTES).toBe(32);
    expect(isValidApiToken("a".repeat(31))).toBeFalse();
    expect(isValidApiToken("a".repeat(32))).toBeTrue();
    expect(isValidApiToken("é".repeat(16))).toBeTrue();
  });

  test("rejects an explicitly configured short deployment value without printing it", () => {
    const weakToken = "do-not-print-this";

    expect(() => apiTokenForDeployment(weakToken)).toThrow(
      `${OPEN_RELIC_API_TOKEN_VARIABLE} must be at least 32 bytes.`,
    );
    try {
      apiTokenForDeployment(weakToken);
    } catch (error) {
      expect(String(error)).not.toContain(weakToken);
    }
  });

  test("keeps absent and empty deployment values fail-closed at runtime", () => {
    expect(apiTokenForDeployment(undefined)).toBe("");
    expect(apiTokenForDeployment("")).toBe("");
    expect(apiTokenFromEnv(envWithApiToken())).toBeNull();
    expect(apiTokenFromEnv(envWithApiToken(""))).toBeNull();
    expect(apiTokenFromEnv(envWithApiToken("a".repeat(31)))).toBeNull();
  });
});
