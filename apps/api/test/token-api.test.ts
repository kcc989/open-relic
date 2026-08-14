import {
  ARTIFACT_TOKEN_PATTERN,
  ERROR_CODES,
  NAMESPACES_PATH,
  TOKEN_TTL_MAX_SECONDS,
  TOKEN_TTL_MIN_SECONDS,
  type CreateTokenResult,
  type TokenInfo,
} from "../src/contracts.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Json } from "../src/request-body.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { envelope, errorCode, result } from "./support/envelope.ts";

const NAMESPACES = `http://local.test${NAMESPACES_PATH}`;
const TOKENS = `${NAMESPACES}/acme/tokens`;
const REPO_TOKENS = `${NAMESPACES}/acme/repos/demo/tokens`;

let harness: TestApp;
let now: Date;

beforeEach(async () => {
  now = new Date("2026-08-13T12:00:00.000Z");
  harness = createTestApp(() => now);

  const post = (path: string, body: Json) =>
    harness.app.request(
      new Request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  await post(NAMESPACES, { slug: "acme" });
  await post(`${NAMESPACES}/acme/repos`, { name: "demo" });
});

afterEach(() => {
  harness.close();
});

const create = (body: Json) =>
  harness.app.request(
    new Request(TOKENS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /namespaces/:namespace/tokens", () => {
  test("returns the plaintext once with the documented token shape", async () => {
    const response = await create({ repo: "demo", scope: "read", ttl: 3600 });
    const token = await result<CreateTokenResult>(response);

    expect(response.status).toBe(200);
    expect(token.id).toMatch(/^[0-9a-f]{16}$/);
    expect(token.plaintext).toMatch(ARTIFACT_TOKEN_PATTERN);
    expect(token.scope).toBe("read");
    expect(token.expires_at).toBe("2026-08-13T13:00:00.000Z");
    expect(Object.keys(token).sort()).toEqual(["expires_at", "id", "plaintext", "scope"]);
  });

  test("defaults to a one-day write token", async () => {
    const token = await result<CreateTokenResult>(await create({ repo: "demo" }));

    expect(token.scope).toBe("write");
    expect(token.expires_at).toBe("2026-08-14T12:00:00.000Z");
  });

  test("404s an unknown repository", async () => {
    const response = await create({ repo: "nope" });

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
  });

  for (const [label, body, code] of [
    ["a missing repo", {}, ERROR_CODES.invalidRepoName],
    ["a malformed repo", { repo: "Demo" }, ERROR_CODES.invalidRepoName],
    ["an unknown scope", { repo: "demo", scope: "admin" }, ERROR_CODES.invalidInput],
    [
      "a ttl below the minimum",
      { repo: "demo", ttl: TOKEN_TTL_MIN_SECONDS - 1 },
      ERROR_CODES.invalidTtl,
    ],
    [
      "a ttl above the maximum",
      { repo: "demo", ttl: TOKEN_TTL_MAX_SECONDS + 1 },
      ERROR_CODES.invalidTtl,
    ],
    ["a fractional ttl", { repo: "demo", ttl: 60.5 }, ERROR_CODES.invalidTtl],
  ] as const) {
    test(`rejects ${label}`, async () => {
      const response = await create(body);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(code);
    });
  }
});

describe("GET /namespaces/:namespace/repos/:repo/tokens", () => {
  test("lists metadata without ever returning the plaintext", async () => {
    const created = await result<CreateTokenResult>(
      await create({ repo: "demo", scope: "read", ttl: 3600 }),
    );
    const response = await harness.app.request(`${REPO_TOKENS}?state=all`);
    const body = await envelope<TokenInfo[]>(response);
    const listed = body.result?.find((token) => token.id === created.id);

    expect(response.status).toBe(200);
    expect(listed).toEqual({
      id: created.id,
      scope: "read",
      state: "active",
      created_at: "2026-08-13T12:00:00.000Z",
      expires_at: "2026-08-13T13:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain(created.plaintext);
    expect(body.result_info).toMatchObject({
      page: 1,
      per_page: 30,
      count: 2,
      total_count: 2,
      total_pages: 1,
    });
  });

  test("defaults to active and filters expired tokens explicitly", async () => {
    const expiring = await result<CreateTokenResult>(
      await create({ repo: "demo", scope: "write", ttl: 60 }),
    );
    now = new Date(now.getTime() + 61_000);

    const active = await result<TokenInfo[]>(await harness.app.request(REPO_TOKENS));
    const expired = await result<TokenInfo[]>(
      await harness.app.request(`${REPO_TOKENS}?state=expired`),
    );

    expect(active.map((token) => token.id)).not.toContain(expiring.id);
    expect(expired).toEqual([expect.objectContaining({ id: expiring.id, state: "expired" })]);
  });

  test("pages with offset pagination", async () => {
    for (let index = 0; index < 4; index += 1) {
      await create({ repo: "demo" });
      now = new Date(now.getTime() + 1_000);
    }

    const first = await envelope<TokenInfo[]>(
      await harness.app.request(`${REPO_TOKENS}?state=all&per_page=2&page=1`),
    );
    const second = await envelope<TokenInfo[]>(
      await harness.app.request(`${REPO_TOKENS}?state=all&per_page=2&page=2`),
    );

    expect(first.result).toHaveLength(2);
    expect(second.result).toHaveLength(2);
    expect(first.result_info).toMatchObject({ total_count: 5, total_pages: 3 });
    expect(second.result?.map((token) => token.id)).not.toEqual(
      first.result?.map((token) => token.id),
    );
  });

  for (const query of ["state=nope", "per_page=0", "per_page=101", "page=0", "page=wat"]) {
    test(`rejects ?${query}`, async () => {
      const response = await harness.app.request(`${REPO_TOKENS}?${query}`);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
    });
  }

  test("404s an unknown repository", async () => {
    const response = await harness.app.request(`${NAMESPACES}/acme/repos/nope/tokens`);

    expect(response.status).toBe(404);
  });
});

describe("DELETE /namespaces/:namespace/tokens/:id", () => {
  test("revokes the token and keeps it visible as revoked", async () => {
    const created = await result<CreateTokenResult>(await create({ repo: "demo" }));

    const response = await harness.app.request(
      new Request(`${TOKENS}/${created.id}`, { method: "DELETE" }),
    );
    const deleted = await result<{ id: string }>(response);
    const revoked = await result<TokenInfo[]>(
      await harness.app.request(`${REPO_TOKENS}?state=revoked`),
    );

    expect(response.status).toBe(200);
    expect(deleted).toEqual({ id: created.id });
    expect(revoked).toEqual([expect.objectContaining({ id: created.id, state: "revoked" })]);
  });

  test("404s an unknown token", async () => {
    const response = await harness.app.request(
      new Request(`${TOKENS}/0123456789abcdef`, { method: "DELETE" }),
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
  });
});
