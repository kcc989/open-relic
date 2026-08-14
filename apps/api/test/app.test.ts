import {
  ERROR_CODES,
  GIT_HTTP_ENDPOINTS,
  REST_ENDPOINTS,
  isImplementedEndpoint,
} from "@open-relic/contracts";
import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app.ts";
import { allowControlPlane } from "../src/control-plane-authorization.ts";
import { envWithApiToken } from "./support/env.ts";
import { envelope, errorCode } from "./support/envelope.ts";

const app = createApp({ authorizeControlPlane: allowControlPlane });

describe("health", () => {
  test("reports that the installation is ready", async () => {
    const response = await app.request(
      "http://local.test/healthz",
      undefined,
      envWithApiToken("a".repeat(32)),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      service: "open-relic",
      status: "ok",
    });
  });

  test("reports an unavailable installation when the API token is missing or weak", async () => {
    const missing = await app.request("http://local.test/healthz");
    const weak = await app.request(
      "http://local.test/healthz",
      undefined,
      envWithApiToken("a".repeat(31)),
    );

    expect(missing.status).toBe(503);
    expect(await missing.json<{ service: string; status: string }>()).toEqual({
      service: "open-relic",
      status: "unavailable",
    });
    expect(weak.status).toBe(503);
    expect(await weak.json<{ service: string; status: string }>()).toEqual({
      service: "open-relic",
      status: "unavailable",
    });
  });
});

describe("REST API stubs", () => {
  // Implemented endpoints have their own suites; everything else must still
  // answer 501 so the manifest and the router cannot drift apart.
  for (const endpoint of REST_ENDPOINTS.filter(
    (candidate) => !isImplementedEndpoint(candidate.id),
  )) {
    test(`${endpoint.method} ${endpoint.path}`, async () => {
      const response = await app.request(
        new Request(`http://local.test${endpoint.samplePath}`, {
          method: endpoint.method,
        }),
      );

      expect(response.status).toBe(501);
      const body = await envelope<never>(response);
      expect(body).toMatchObject({ result: null, success: false });
      expect(body.errors[0]?.code).toBe(ERROR_CODES.notImplemented);
      // The operation is named in the message rather than in a field of its
      // own: the v4 envelope has no room for one, and inventing a field would
      // be an extension on a shape Artifacts has spoken for.
      expect(body.errors[0]?.message).toContain(endpoint.id);
    });
  }
});

describe("Git Smart HTTP stubs", () => {
  for (const endpoint of GIT_HTTP_ENDPOINTS.filter(
    (candidate) => !isImplementedEndpoint(candidate.id),
  )) {
    test(`${endpoint.method} ${endpoint.samplePath}`, async () => {
      const response = await app.request(
        new Request(`http://local.test${endpoint.samplePath}`, {
          method: endpoint.method,
        }),
      );

      expect(response.status).toBe(501);
      const body = await envelope<never>(response);
      expect(body.errors[0]?.code).toBe(ERROR_CODES.notImplemented);
      expect(body.errors[0]?.message).toContain(endpoint.id);
    });
  }
});

test("unknown routes remain 404s in the envelope", async () => {
  const response = await app.request("http://local.test/nope");

  expect(response.status).toBe(404);
  expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
});
