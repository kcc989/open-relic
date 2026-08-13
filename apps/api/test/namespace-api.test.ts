import {
  ERROR_CODES,
  NAMESPACES_PATH,
  NAMESPACE_SLUG_MAX_LENGTH,
  type NamespaceInfo,
} from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestApp, type TestApp } from "./support/app.ts";
import { envelope, errorCode, pageCursor, result } from "./support/envelope.ts";
import type { Json } from "../src/request-body.ts";

const NAMESPACES = `http://local.test${NAMESPACES_PATH}`;

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

const create = (body: Json) =>
  app.request(
    new Request(NAMESPACES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const slugs = async (response: Response) =>
  (await result<NamespaceInfo[]>(response)).map((namespace) => namespace.slug);

describe("POST /namespaces", () => {
  test("creates a namespace and points at it with Location", async () => {
    const response = await create({
      slug: "acme",
      display_name: "Acme, Inc.",
      description: "Anvils and rockets",
    });
    const body = await envelope<NamespaceInfo>(response);

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(`${NAMESPACES_PATH}/acme`);
    expect(body).toMatchObject({
      success: true,
      errors: [],
      messages: [],
      result: {
        slug: "acme",
        display_name: "Acme, Inc.",
        description: "Anvils and rockets",
      },
    });
    expect(body.result?.created_at).toBeString();
  });

  test("falls back to the slug as the display name", async () => {
    const body = await result<NamespaceInfo>(await create({ slug: "acme" }));

    expect(body.display_name).toBe("acme");
    expect(body.description).toBeNull();
  });

  test("rejects a duplicate slug with 409", async () => {
    await create({ slug: "acme" });
    const response = await create({ slug: "acme" });
    const body = await envelope<never>(response);

    expect(response.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.result).toBeNull();
    expect(body.errors[0]?.code).toBe(ERROR_CODES.alreadyExists);
  });

  const invalidBodies: ReadonlyArray<readonly [string, Json]> = [
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
    ["an over-long display name", { slug: "acme", display_name: "x".repeat(101) }],
    ["a JSON array", []],
  ];

  for (const [label, body] of invalidBodies) {
    test(`rejects ${label} with 400`, async () => {
      const response = await create(body);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
    });
  }

  test("attributes a rejected field with a JSON pointer", async () => {
    const body = await envelope<never>(await create({ slug: "Acme" }));

    expect(body.errors[0]?.source).toEqual({ pointer: "/slug" });
  });

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
  test("starts empty and still reports its paging state", async () => {
    const response = await app.request(NAMESPACES);
    const body = await envelope<NamespaceInfo[]>(response);

    expect(response.status).toBe(200);
    expect(body.result).toEqual([]);
    expect(body.result_info).toEqual({ cursor: "", per_page: 50, count: 0 });
  });

  test("lists created namespaces alphabetically", async () => {
    await create({ slug: "zeta" });
    await create({ slug: "acme" });

    expect(await slugs(await app.request(NAMESPACES))).toEqual(["acme", "zeta"]);
  });

  test("pages with limit and cursor", async () => {
    for (const slug of ["acme", "beta", "delta"]) {
      await create({ slug });
    }

    const first = await app.request(`${NAMESPACES}?limit=2`);
    const firstBody = await envelope<NamespaceInfo[]>(first);
    const cursor = pageCursor(firstBody.result_info);
    const secondBody = await envelope<NamespaceInfo[]>(
      await app.request(`${NAMESPACES}?limit=2&cursor=${encodeURIComponent(cursor)}`),
    );

    expect(firstBody.result?.map((namespace) => namespace.slug)).toEqual(["acme", "beta"]);
    expect(cursor).not.toBe("");
    expect(secondBody.result?.map((namespace) => namespace.slug)).toEqual(["delta"]);
    expect(secondBody.result_info).toMatchObject({ cursor: "", count: 1 });
  });

  test("rejects a cursor it did not issue rather than ending the walk", async () => {
    await create({ slug: "acme" });

    const response = await app.request(`${NAMESPACES}?cursor=garbage`);

    // An empty page here would be indistinguishable from a finished list, so a
    // client that garbled its cursor would silently lose the rest of it.
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
  });

  test("rejects a cursor that decodes but carries the wrong keys", async () => {
    // Well-formed base64url JSON, but not a namespace position.
    const cursor = btoa(JSON.stringify({ nonsense: "x" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

    const response = await app.request(`${NAMESPACES}?cursor=${cursor}`);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
  });

  const invalidLimits = ["0", "-1", "abc", "201"];

  for (const limit of invalidLimits) {
    test(`rejects limit=${limit} with 400`, async () => {
      const response = await app.request(`${NAMESPACES}?limit=${limit}`);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
    });
  }
});

describe("GET /namespaces/:namespace", () => {
  test("returns the stored namespace", async () => {
    await create({ slug: "acme", display_name: "Acme, Inc." });

    const response = await app.request(`${NAMESPACES}/acme`);

    expect(response.status).toBe(200);
    expect(await result<NamespaceInfo>(response)).toMatchObject({
      slug: "acme",
      display_name: "Acme, Inc.",
    });
  });

  test("404s for an unknown namespace", async () => {
    const response = await app.request(`${NAMESPACES}/nope`);

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
  });
});

describe("DELETE /namespaces/:namespace", () => {
  test("removes the namespace and names what it removed", async () => {
    await create({ slug: "acme" });

    const response = await app.request(new Request(`${NAMESPACES}/acme`, { method: "DELETE" }));

    // 200, not the 202 a repository delete answers: this one really has
    // finished by the time it replies.
    expect(response.status).toBe(200);
    expect(await result<{ slug: string }>(response)).toEqual({ slug: "acme" });
    expect((await app.request(`${NAMESPACES}/acme`)).status).toBe(404);
  });

  test("404s for an unknown namespace", async () => {
    const response = await app.request(new Request(`${NAMESPACES}/nope`, { method: "DELETE" }));

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
  });
});
