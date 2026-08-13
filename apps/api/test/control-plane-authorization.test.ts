import { ERROR_CODES, NAMESPACES_PATH, REST_ENDPOINTS } from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ApiEnv } from "../../../alchemy.run.ts";
import {
  CONTROL_PLANE_TOKEN_VARIABLE,
  authorizeInstallationApiToken,
} from "../src/control-plane-authorization.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { errorCode } from "./support/envelope.ts";

const API_TOKEN = "installation-control-plane-token";

const envWithToken = (token?: string): ApiEnv => {
  // SAFETY: this suite injects every service dependency, so only the string binding is read.
  return (token === undefined ? {} : { [CONTROL_PLANE_TOKEN_VARIABLE]: token }) as ApiEnv;
};

let harness: TestApp;

beforeEach(() => {
  harness = createTestApp(() => new Date(), authorizeInstallationApiToken);
});

afterEach(() => {
  harness.close();
});

const controlRequest = (
  path: string,
  init: RequestInit = {},
  presentedToken: string | null = API_TOKEN,
  configuredToken: string | null = API_TOKEN,
) => {
  const headers = new Headers(init.headers);
  if (presentedToken !== null) {
    headers.set("Authorization", `Bearer ${presentedToken}`);
  }
  return harness.app.request(
    new Request(`http://local.test${path}`, { ...init, headers }),
    undefined,
    envWithToken(configuredToken ?? undefined),
  );
};

describe("the REST control-plane boundary", () => {
  for (const endpoint of REST_ENDPOINTS) {
    test(`refuses anonymous ${endpoint.method} ${endpoint.path}`, async () => {
      const response = await controlRequest(endpoint.samplePath, { method: endpoint.method }, null);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="Open Relic control plane"',
      );
      expect(await errorCode(response)).toBe(ERROR_CODES.forbidden);
    });
  }

  test("accepts the configured Bearer token", async () => {
    const response = await controlRequest(NAMESPACES_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "acme" }),
    });

    expect(response.status).toBe(201);
  });

  test("refuses a wrong Bearer token", async () => {
    const response = await controlRequest(NAMESPACES_PATH, { method: "GET" }, "wrong");

    expect(response.status).toBe(401);
  });

  test("refuses HTTP Basic because it is only a Git credential spelling", async () => {
    const response = await harness.app.request(
      new Request(`http://local.test${NAMESPACES_PATH}`, {
        headers: { Authorization: `Basic ${btoa(`x:${API_TOKEN}`)}` },
      }),
      undefined,
      envWithToken(API_TOKEN),
    );

    expect(response.status).toBe(401);
  });

  test("fails closed when the installation secret is absent or empty", async () => {
    const absent = await controlRequest(NAMESPACES_PATH, { method: "GET" }, API_TOKEN, null);
    const empty = await controlRequest(NAMESPACES_PATH, { method: "GET" }, API_TOKEN, "");

    expect(absent.status).toBe(401);
    expect(empty.status).toBe(401);
  });

  test("does not disclose repository existence through token minting", async () => {
    await controlRequest(NAMESPACES_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "acme" }),
    });
    await controlRequest(`${NAMESPACES_PATH}/acme/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });

    const mint = (repo: string) =>
      controlRequest(
        `${NAMESPACES_PATH}/acme/tokens`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo }),
        },
        null,
      );

    const existing = await mint("demo");
    const missing = await mint("nope");

    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
  });
});
