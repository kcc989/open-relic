import {
  API_BASE_PATH,
  REPOSITORY_NAME_MAX_LENGTH,
  type Repository,
} from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestApp, type TestApp } from "./support/app.ts";

const NAMESPACES = `http://local.test${API_BASE_PATH}/namespaces`;
const REPOS = `${NAMESPACES}/acme/repos`;

let harness: TestApp;

beforeEach(async () => {
  harness = createTestApp();

  await harness.app.request(
    new Request(NAMESPACES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "acme" }),
    }),
  );
});

afterEach(() => {
  harness.close();
});

const create = (body: unknown, namespace = "acme") =>
  harness.app.request(
    new Request(`${NAMESPACES}/${namespace}/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /namespaces/:namespace/repos", () => {
  test("creates a repository and points at it with Location", async () => {
    const response = await create({
      name: "demo",
      description: "A demo repository",
    });
    const body = (await response.json()) as Repository;

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(
      `${API_BASE_PATH}/namespaces/acme/repos/demo`,
    );
    expect(body).toMatchObject({
      namespace: "acme",
      name: "demo",
      description: "A demo repository",
      defaultBranch: "main",
    });
    expect(body.createdAt).toBeString();
  });

  test("initializes the repository's own Durable Object", async () => {
    const body = (await (
      await create({ name: "demo", defaultBranch: "trunk" })
    ).json()) as Repository;

    const [durableObjectId] = harness.objects.mintedIds;
    expect(durableObjectId).toBeString();
    expect(await harness.objects.describe(durableObjectId!)).toEqual({
      defaultBranch: "trunk",
      // The object and its index entry agree on one creation time.
      createdAt: body.createdAt,
    });
  });

  test("defaults the description to null and the branch to main", async () => {
    const body = (await (await create({ name: "demo" })).json()) as Repository;

    expect(body.description).toBeNull();
    expect(body.defaultBranch).toBe("main");
  });

  test("accepts a hierarchical default branch", async () => {
    const response = await create({
      name: "demo",
      defaultBranch: "release/2.0.x",
    });

    expect(response.status).toBe(201);
    expect(((await response.json()) as Repository).defaultBranch).toBe(
      "release/2.0.x",
    );
  });

  test("404s when the namespace does not exist", async () => {
    const response = await create({ name: "demo" }, "nope");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      status: 404,
      operation: "repositories.create",
    });
  });

  test("rejects a duplicate name with 409", async () => {
    await create({ name: "demo" });
    const response = await create({ name: "demo" });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 409,
      operation: "repositories.create",
    });
  });

  test("leaves no repository object behind when the name is taken", async () => {
    await create({ name: "demo" });
    await create({ name: "demo" });

    // Two ids were minted — one per attempt — but only the accepted one was
    // ever initialized, so the rejected create allocated no storage.
    expect(harness.objects.mintedIds).toHaveLength(2);
    expect(harness.objects.liveIds).toEqual([harness.objects.mintedIds[0]!]);
  });

  const invalidBodies: ReadonlyArray<readonly [string, unknown]> = [
    ["a missing name", {}],
    ["a non-string name", { name: 42 }],
    ["an empty name", { name: "" }],
    ["an uppercase name", { name: "Demo" }],
    ["a name with a slash", { name: "acme/demo" }],
    ["a name with a leading hyphen", { name: "-demo" }],
    ["a name with a trailing dot", { name: "demo." }],
    ["a name ending in .git", { name: "demo.git" }],
    ["an over-long name", { name: "a".repeat(REPOSITORY_NAME_MAX_LENGTH + 1) }],
    ["a non-string description", { name: "demo", description: 42 }],
    ["an over-long description", { name: "demo", description: "x".repeat(501) }],
    ["a non-string default branch", { name: "demo", defaultBranch: 42 }],
    ["an empty default branch", { name: "demo", defaultBranch: "" }],
    ["a default branch with ..", { name: "demo", defaultBranch: "a..b" }],
    ["a default branch ending in .lock", { name: "demo", defaultBranch: "x.lock" }],
    ["a default branch with a space", { name: "demo", defaultBranch: "my branch" }],
    // Git applies these rules per slash-separated component, not to the whole
    // name, so a valid-looking prefix does not rescue an invalid component.
    ["a dot-prefixed branch component", { name: "demo", defaultBranch: "foo/.bar" }],
    ["a .lock branch component", { name: "demo", defaultBranch: "a.lock/b" }],
    ["a bare-dot branch component", { name: "demo", defaultBranch: "foo/./bar" }],
    ["an empty branch component", { name: "demo", defaultBranch: "foo//bar" }],
    ["a default branch with a trailing slash", { name: "demo", defaultBranch: "foo/" }],
    ["a JSON array", []],
  ];

  for (const [label, body] of invalidBodies) {
    test(`rejects ${label} with 400`, async () => {
      const response = await create(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        status: 400,
        operation: "repositories.create",
      });
    });
  }

  test("rejects a malformed JSON body with 400", async () => {
    const response = await harness.app.request(
      new Request(REPOS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
  });
});

describe("GET /namespaces/:namespace/repos", () => {
  test("starts empty", async () => {
    const response = await harness.app.request(REPOS);

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ repositories: [] });
  });

  test("lists the namespace's repositories alphabetically", async () => {
    await create({ name: "zeta" });
    await create({ name: "demo" });

    const body = (await (await harness.app.request(REPOS)).json()) as {
      repositories: Repository[];
    };

    expect(body.repositories.map((repository) => repository.name)).toEqual([
      "demo",
      "zeta",
    ]);
  });

  test("404s for an unknown namespace", async () => {
    const response = await harness.app.request(`${NAMESPACES}/nope/repos`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      status: 404,
      operation: "repositories.list",
    });
  });
});

describe("GET /namespaces/:namespace/repos/:repo", () => {
  test("returns the stored repository", async () => {
    await create({ name: "demo", description: "A demo repository" });

    const response = await harness.app.request(`${REPOS}/demo`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      namespace: "acme",
      name: "demo",
      description: "A demo repository",
    });
  });

  test("404s for an unknown repository", async () => {
    const response = await harness.app.request(`${REPOS}/nope`);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 404,
      operation: "repositories.get",
    });
  });

  test("404s for a repository in another namespace", async () => {
    await harness.app.request(
      new Request(NAMESPACES, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "other" }),
      }),
    );
    await create({ name: "demo" }, "other");

    expect((await harness.app.request(`${REPOS}/demo`)).status).toBe(404);
  });
});

describe("DELETE /namespaces/:namespace/repos/:repo", () => {
  test("removes the repository, discards its object, and answers 204", async () => {
    await create({ name: "demo" });
    const [durableObjectId] = harness.objects.mintedIds;

    const response = await harness.app.request(
      new Request(`${REPOS}/demo`, { method: "DELETE" }),
    );

    expect(response.status).toBe(204);
    expect(harness.objects.destroyedIds).toEqual([durableObjectId!]);
    expect((await harness.app.request(`${REPOS}/demo`)).status).toBe(404);
  });

  test("404s for an unknown repository and destroys nothing", async () => {
    const response = await harness.app.request(
      new Request(`${REPOS}/nope`, { method: "DELETE" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      status: 404,
      operation: "repositories.delete",
    });
    expect(harness.objects.destroyedIds).toEqual([]);
  });
});

describe("deleting a namespace", () => {
  test("takes its repositories and their objects with it", async () => {
    await create({ name: "demo" });
    await create({ name: "other" });
    const minted = [...harness.objects.mintedIds];

    const response = await harness.app.request(
      new Request(`${NAMESPACES}/acme`, { method: "DELETE" }),
    );

    expect(response.status).toBe(204);
    expect([...harness.objects.destroyedIds].sort()).toEqual([...minted].sort());
    expect((await harness.app.request(REPOS)).status).toBe(404);
  });
});
