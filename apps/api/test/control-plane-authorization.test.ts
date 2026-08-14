import { ERROR_CODES, NAMESPACES_PATH, REST_ENDPOINTS } from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../src/app.ts";
import { authorizeApiToken } from "../src/control-plane-authorization.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { envWithApiToken } from "./support/env.ts";
import { errorCode } from "./support/envelope.ts";

const API_TOKEN = "installation-control-plane-token-32";

let harness: TestApp;

beforeEach(() => {
  harness = createTestApp(() => new Date(), authorizeApiToken);
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
    envWithApiToken(configuredToken ?? undefined),
  );
};

describe("the REST control-plane boundary", () => {
  for (const endpoint of REST_ENDPOINTS) {
    test(`refuses anonymous ${endpoint.method} ${endpoint.path}`, async () => {
      const response = await controlRequest(endpoint.samplePath, { method: endpoint.method }, null);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
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

  test("gives missing, malformed, and incorrect credentials the same refusal", async () => {
    const request = (authorization?: string) =>
      harness.app.request(
        new Request(`http://local.test${NAMESPACES_PATH}`, {
          headers: authorization === undefined ? {} : { Authorization: authorization },
        }),
        undefined,
        envWithApiToken(API_TOKEN),
      );

    const responses = await Promise.all([
      request(),
      request("Basic not-for-the-control-plane"),
      request("Bearer wrong"),
      request(`Bearer ${API_TOKEN}x`),
    ]);
    const snapshots = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        challenge: response.headers.get("www-authenticate"),
        body: await response.json(),
      })),
    );

    expect(snapshots).toEqual(snapshots.map(() => snapshots[0]!));
    expect(snapshots[0]?.status).toBe(401);
    expect(snapshots[0]?.challenge).toBe("Bearer");
  });

  test("refuses HTTP Basic because it is only a Git credential spelling", async () => {
    const response = await harness.app.request(
      new Request(`http://local.test${NAMESPACES_PATH}`, {
        headers: { Authorization: `Basic ${btoa(`x:${API_TOKEN}`)}` },
      }),
      undefined,
      envWithApiToken(API_TOKEN),
    );

    expect(response.status).toBe(401);
  });

  test("fails closed when the API token is absent or weak", async () => {
    const absent = await controlRequest(NAMESPACES_PATH, { method: "GET" }, API_TOKEN, null);
    const empty = await controlRequest(NAMESPACES_PATH, { method: "GET" }, API_TOKEN, "");
    const short = await controlRequest(NAMESPACES_PATH, { method: "GET" }, "short", "short");

    expect(absent.status).toBe(401);
    expect(empty.status).toBe(401);
    expect(short.status).toBe(401);
  });

  test("authenticates before body parsing", async () => {
    const response = await controlRequest(
      NAMESPACES_PATH,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      },
      null,
    );

    expect(response.status).toBe(401);
  });

  test("authenticates before namespace lookup", async () => {
    // No storage bindings or dependency fakes are supplied. Reaching the route
    // would therefore throw while resolving the registry.
    const isolatedApp = createApp();
    const response = await isolatedApp.request(
      new Request(`http://local.test${NAMESPACES_PATH}/acme`),
      undefined,
      envWithApiToken(API_TOKEN),
    );

    expect(response.status).toBe(401);
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
