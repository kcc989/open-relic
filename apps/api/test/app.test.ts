import {
  GIT_HTTP_ENDPOINTS,
  REST_ENDPOINTS,
  isImplementedEndpoint,
} from "@open-relic/contracts";
import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app.ts";

const app = createApp();

describe("health", () => {
  test("reports that the worker is running", async () => {
    const response = await app.request("http://local.test/healthz");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      service: "open-relic",
      status: "ok",
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
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 501,
        operation: endpoint.id,
      });
    });
  }
});

describe("Git Smart HTTP stubs", () => {
  for (const endpoint of GIT_HTTP_ENDPOINTS) {
    test(`${endpoint.method} ${endpoint.samplePath}`, async () => {
      const response = await app.request(
        new Request(`http://local.test${endpoint.samplePath}`, {
          method: endpoint.method,
        }),
      );

      expect(response.status).toBe(501);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 501,
        operation: endpoint.id,
      });
    });
  }
});

test("unknown routes remain 404s", async () => {
  const response = await app.request("http://local.test/nope");
  const body = (await response.json()) as Record<string, unknown>;

  expect(response.status).toBe(404);
  expect(body).toMatchObject({ status: 404 });
});
