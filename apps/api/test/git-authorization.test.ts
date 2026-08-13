import { describe, expect, test } from "bun:test";

import type { ApiEnv } from "../../../alchemy.run.ts";
import {
  ANONYMOUS_WRITE_VARIABLE,
  allowAnonymousWrite,
} from "../src/git/authorization.ts";

const authorize = (env: unknown) =>
  allowAnonymousWrite({
    env: env as ApiEnv,
    request: new Request("http://local.test/git/acme/demo.git/info/refs"),
    namespace: "acme",
    repository: "demo",
  });

describe("the anonymous-write seam", () => {
  test("allows the request when the installation has opted in", () => {
    expect(authorize({ [ANONYMOUS_WRITE_VARIABLE]: "true" })).toEqual({
      allowed: true,
    });
  });

  const refusals: ReadonlyArray<readonly [string, unknown]> = [
    ["the variable is missing", {}],
    ["the environment is missing entirely", undefined],
    ["the variable is empty", { [ANONYMOUS_WRITE_VARIABLE]: "" }],
    ["the variable says something else", { [ANONYMOUS_WRITE_VARIABLE]: "yes" }],
    // Case matters: a near-miss is a configuration mistake, and reading it as
    // consent would open the installation on a typo.
    ["the variable is capitalized", { [ANONYMOUS_WRITE_VARIABLE]: "True" }],
  ];

  for (const [label, env] of refusals) {
    test(`refuses when ${label}`, () => {
      const decision = authorize(env);

      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.detail).toContain(
        ANONYMOUS_WRITE_VARIABLE,
      );
    });
  }
});
