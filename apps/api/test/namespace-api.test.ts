import {
  API_BASE_PATH,
  NAMESPACE_SLUG_MAX_LENGTH,
  type Namespace,
} from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestApp, type TestApp } from "./support/app.ts";

const NAMESPACES = `http://local.test${API_BASE_PATH}/namespaces`;

let harness: TestApp;
let app: TestApp["app"];

// The routes run against the same registry the Durable Object wraps, so the
// only thing these tests skip is the RPC hop.
beforeEach(() => {
  harness = createTestApp();
  app = harness.app;
});

afterEach(() => {
  harness.close();
});

const create = (body: unknown) =>
  app.request(
    new Request(NAMESPACES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /namespaces", () => {
  test("creates a namespace and points at it with Location", async () => {
    const response = await create({
      slug: "acme",
      displayName: "Acme, Inc.",
      description: "Anvils and rockets",
    });
    const body = (await response.json()) as Namespace;

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(
      `${API_BASE_PATH}/namespaces/acme`,
    );
    expect(body).toMatchObject({
      slug: "acme",
      displayName: "Acme, Inc.",
      description: "Anvils and rockets",
    });
    expect(body.createdAt).toBeString();
  });

  test("falls back to the slug as the display name", async () => {
    const body = (await (await create({ slug: "acme" })).json()) as Namespace;

    expect(body.displayName).toBe("acme");
    expect(body.description).toBeNull();
  });

  test("rejects a duplicate slug with 409", async () => {
    await create({ slug: "acme" });
    const response = await create({ slug: "acme" });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(body).toMatchObject({
      status: 409,
      operation: "namespaces.create",
    });
  });

  const invalidBodies: ReadonlyArray<readonly [string, unknown]> = [
    ["a missing slug", {}],
    ["a non-string slug", { slug: 42 }],
    ["an empty slug", { slug: "" }],
    ["an uppercase slug", { slug: "Acme" }],
    ["a slug with a slash", { slug: "acme/demo" }],
    ["a slug with a leading hyphen", { slug: "-acme" }],
    ["a slug with a trailing hyphen", { slug: "acme-" }],
    ["a reserved slug", { slug: "git" }],
    ["an over-long slug", { slug: "a".repeat(NAMESPACE_SLUG_MAX_LENGTH + 1) }],
    ["a non-string description", { slug: "acme", description: 42 }],
    ["an over-long description", { slug: "acme", description: "x".repeat(501) }],
    ["an over-long display name", { slug: "acme", displayName: "x".repeat(101) }],
    ["a JSON array", []],
  ];

  for (const [label, body] of invalidBodies) {
    test(`rejects ${label} with 400`, async () => {
      const response = await create(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        status: 400,
        operation: "namespaces.create",
      });
    });
  }

  test("rejects a malformed JSON body with 400", async () => {
    const response = await app.request(
      new Request(NAMESPACES, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
  });
});

describe("GET /namespaces", () => {
  test("starts empty", async () => {
    const response = await app.request(NAMESPACES);
    const body = (await response.json()) as { namespaces: Namespace[] };

    expect(response.status).toBe(200);
    expect(body).toEqual({ namespaces: [] });
  });

  test("lists created namespaces alphabetically", async () => {
    await create({ slug: "zeta" });
    await create({ slug: "acme" });

    const body = (await (await app.request(NAMESPACES)).json()) as {
      namespaces: Namespace[];
    };

    expect(body.namespaces.map((namespace) => namespace.slug)).toEqual([
      "acme",
      "zeta",
    ]);
  });
});

describe("GET /namespaces/:namespace", () => {
  test("returns the stored namespace", async () => {
    await create({ slug: "acme", displayName: "Acme, Inc." });

    const response = await app.request(`${NAMESPACES}/acme`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      slug: "acme",
      displayName: "Acme, Inc.",
    });
  });

  test("404s for an unknown namespace", async () => {
    const response = await app.request(`${NAMESPACES}/nope`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 404,
      operation: "namespaces.get",
    });
  });
});

describe("DELETE /namespaces/:namespace", () => {
  test("removes the namespace and answers 204", async () => {
    await create({ slug: "acme" });

    const response = await app.request(
      new Request(`${NAMESPACES}/acme`, { method: "DELETE" }),
    );

    expect(response.status).toBe(204);
    expect((await app.request(`${NAMESPACES}/acme`)).status).toBe(404);
  });

  test("404s for an unknown namespace", async () => {
    const response = await app.request(
      new Request(`${NAMESPACES}/nope`, { method: "DELETE" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      status: 404,
      operation: "namespaces.delete",
    });
  });
});
