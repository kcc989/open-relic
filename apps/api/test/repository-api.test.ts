import {
  ARTIFACT_TOKEN_PATTERN,
  ERROR_CODES,
  NAMESPACES_PATH,
  REPOSITORY_NAME_MAX_LENGTH,
  type CreateRepoResult,
  type RepoWithRemote,
} from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestApp, type TestApp } from "./support/app.ts";
import { envelope, errorCode, result } from "./support/envelope.ts";

const NAMESPACES = `http://local.test${NAMESPACES_PATH}`;
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

const names = async (response: Response) =>
  (await result<RepoWithRemote[]>(response)).map((repository) =>
    repository.name,
  );

describe("POST /namespaces/:namespace/repos", () => {
  test("answers with the identity, the remote, and one token", async () => {
    const response = await create({
      name: "demo",
      description: "A demo repository",
    });
    const body = await result<CreateRepoResult>(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      name: "demo",
      description: "A demo repository",
      default_branch: "main",
      remote: "http://local.test/git/acme/demo.git",
    });
    expect(body.id).toStartWith("repo_");
    expect(body.token).toMatch(ARTIFACT_TOKEN_PATTERN);
  });

  test("does not leak the list shape into the create shape", async () => {
    const body = await result<CreateRepoResult>(await create({ name: "demo" }));

    // Artifacts answers a create with six fields and no timestamps.
    expect(Object.keys(body).sort()).toEqual([
      "default_branch",
      "description",
      "id",
      "name",
      "remote",
      "token",
    ]);
  });

  test("builds the remote from the host the client actually reached", async () => {
    const response = await harness.app.request(
      new Request("https://relic.example.com/namespaces/acme/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "demo" }),
      }),
    );

    expect((await result<CreateRepoResult>(response)).remote).toBe(
      "https://relic.example.com/git/acme/demo.git",
    );
  });

  test("initializes the repository's own Durable Object", async () => {
    await create({ name: "demo", default_branch: "trunk" });

    const [durableObjectId] = harness.objects.mintedIds;
    expect(durableObjectId).toBeString();

    const stored = await harness.objects.describe(durableObjectId!);
    expect(stored?.defaultBranch).toBe("trunk");
    // The object and its index entry agree on one creation time.
    const listed = await result<RepoWithRemote>(
      await harness.app.request(`${REPOS}/demo`),
    );
    expect(stored?.createdAt).toBe(listed.created_at);
  });

  test("defaults the description to null and the branch to main", async () => {
    const body = await result<CreateRepoResult>(await create({ name: "demo" }));

    expect(body.description).toBeNull();
    expect(body.default_branch).toBe("main");
  });

  test("accepts a hierarchical default branch", async () => {
    const response = await create({
      name: "demo",
      default_branch: "release/2.0.x",
    });

    expect(response.status).toBe(200);
    expect((await result<CreateRepoResult>(response)).default_branch).toBe(
      "release/2.0.x",
    );
  });

  test("stores a read-only repository as read-only", async () => {
    await create({ name: "demo", read_only: true });

    expect(
      (await result<RepoWithRemote>(await harness.app.request(`${REPOS}/demo`)))
        .read_only,
    ).toBe(true);
  });

  test("404s when the namespace does not exist", async () => {
    const response = await create({ name: "demo" }, "nope");

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
  });

  test("rejects a duplicate name with 409", async () => {
    await create({ name: "demo" });
    const response = await create({ name: "demo" });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe(ERROR_CODES.alreadyExists);
  });

  test("leaves no repository object behind when the name is taken", async () => {
    await create({ name: "demo" });
    await create({ name: "demo" });

    // Two ids were minted — one per attempt — but only the accepted one was
    // ever initialized, so the rejected create allocated no storage.
    expect(harness.objects.mintedIds).toHaveLength(2);
    expect(harness.objects.liveIds).toEqual([harness.objects.mintedIds[0]!]);
  });

  const invalidNames: ReadonlyArray<readonly [string, unknown]> = [
    ["a missing name", {}],
    ["a non-string name", { name: 42 }],
    ["an empty name", { name: "" }],
    ["an uppercase name", { name: "Demo" }],
    ["a name with a slash", { name: "acme/demo" }],
    ["a name with a leading hyphen", { name: "-demo" }],
    ["a name with a trailing dot", { name: "demo." }],
    ["a name ending in .git", { name: "demo.git" }],
    ["an over-long name", { name: "a".repeat(REPOSITORY_NAME_MAX_LENGTH + 1) }],
  ];

  for (const [label, body] of invalidNames) {
    test(`rejects ${label} with 400 and the repo-name code`, async () => {
      const response = await create(body);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(ERROR_CODES.invalidRepoName);
    });
  }

  const invalidBodies: ReadonlyArray<readonly [string, unknown]> = [
    ["a non-string description", { name: "demo", description: 42 }],
    ["an over-long description", { name: "demo", description: "x".repeat(501) }],
    ["a non-boolean read_only", { name: "demo", read_only: "yes" }],
    ["a non-string default branch", { name: "demo", default_branch: 42 }],
    ["an empty default branch", { name: "demo", default_branch: "" }],
    ["a default branch with ..", { name: "demo", default_branch: "a..b" }],
    [
      "a default branch ending in .lock",
      { name: "demo", default_branch: "x.lock" },
    ],
    [
      "a default branch with a space",
      { name: "demo", default_branch: "my branch" },
    ],
    // Git applies these rules per slash-separated component, not to the whole
    // name, so a valid-looking prefix does not rescue an invalid component.
    [
      "a dot-prefixed branch component",
      { name: "demo", default_branch: "foo/.bar" },
    ],
    ["a .lock branch component", { name: "demo", default_branch: "a.lock/b" }],
    [
      "a bare-dot branch component",
      { name: "demo", default_branch: "foo/./bar" },
    ],
    ["an empty branch component", { name: "demo", default_branch: "foo//bar" }],
    [
      "a default branch with a trailing slash",
      { name: "demo", default_branch: "foo/" },
    ],
    ["a JSON array", []],
  ];

  for (const [label, body] of invalidBodies) {
    test(`rejects ${label} with 400`, async () => {
      const response = await create(body);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
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
  test("starts empty and still reports its paging state", async () => {
    const response = await harness.app.request(REPOS);
    const body = await envelope<RepoWithRemote[]>(response);

    expect(response.status).toBe(200);
    expect(body.result).toEqual([]);
    expect(body.result_info).toEqual({ cursor: "", per_page: 50, count: 0 });
  });

  test("carries every documented field, including the remote", async () => {
    await create({ name: "demo", description: "A demo repository" });

    const [repository] = await result<RepoWithRemote[]>(
      await harness.app.request(REPOS),
    );

    expect(Object.keys(repository!).sort()).toEqual([
      "created_at",
      "default_branch",
      "description",
      "id",
      "last_push_at",
      "name",
      "read_only",
      "remote",
      "source",
      "updated_at",
    ]);
    expect(repository).toMatchObject({
      name: "demo",
      last_push_at: null,
      source: null,
      read_only: false,
      remote: "http://local.test/git/acme/demo.git",
    });
  });

  test("sorts by name when asked to", async () => {
    await create({ name: "zeta" });
    await create({ name: "demo" });

    expect(
      await names(
        await harness.app.request(`${REPOS}?sort=name&direction=asc`),
      ),
    ).toEqual(["demo", "zeta"]);
  });

  test("filters by search", async () => {
    await create({ name: "api-server" });
    await create({ name: "web" });

    expect(await names(await harness.app.request(`${REPOS}?search=api`))).toEqual(
      ["api-server"],
    );
  });

  test("pages with limit and cursor", async () => {
    for (const name of ["alpha", "beta", "delta"]) {
      await create({ name });
    }

    const first = await harness.app.request(
      `${REPOS}?limit=2&sort=name&direction=asc`,
    );
    const firstBody = await envelope<RepoWithRemote[]>(first);
    const cursor = (firstBody.result_info as { cursor: string }).cursor;
    const second = await harness.app.request(
      `${REPOS}?limit=2&sort=name&direction=asc&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(firstBody.result?.map((repository) => repository.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(firstBody.result_info).toMatchObject({ per_page: 2, count: 2 });
    expect(await names(second)).toEqual(["delta"]);
  });

  describe("a cursor is bound to the query that issued it", () => {
    /** Three repositories, and the cursor after the first page of one. */
    const firstPage = async (query: string) => {
      for (const name of ["alpha", "beta", "delta"]) {
        await create({ name });
      }

      const body = await envelope<RepoWithRemote[]>(
        await harness.app.request(`${REPOS}?limit=2&${query}`),
      );
      return (body.result_info as { cursor: string }).cursor;
    };

    test("replaying it under the same query walks forward", async () => {
      const cursor = await firstPage("sort=name&direction=asc");

      const second = await harness.app.request(
        `${REPOS}?limit=2&sort=name&direction=asc&cursor=${encodeURIComponent(cursor)}`,
      );

      expect(await names(second)).toEqual(["delta"]);
    });

    // Each of these would otherwise compare the stored sort value against a
    // column it never came from. Under the default `created_at desc`, an ISO
    // timestamp measured against a name lets every row through — so the client
    // silently receives page one again, under a fresh cursor, forever.
    const mismatches: ReadonlyArray<readonly [string, string, string]> = [
      ["a different sort", "", "sort=name&direction=asc"],
      ["a different direction", "sort=name&direction=asc", "sort=name&direction=desc"],
      ["a search that was not applied", "sort=name&direction=asc", "sort=name&direction=asc&search=alpha"],
      ["a dropped search", "sort=name&direction=asc&search=a", "sort=name&direction=asc"],
    ];

    for (const [label, minted, replayed] of mismatches) {
      test(`rejects it under ${label}`, async () => {
        const cursor = await firstPage(minted);

        const response = await harness.app.request(
          `${REPOS}?limit=2&${replayed}&cursor=${encodeURIComponent(cursor)}`,
        );

        expect(response.status).toBe(400);
        expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
      });
    }

    test("rejects a cursor it did not issue rather than ending the walk", async () => {
      const response = await harness.app.request(`${REPOS}?cursor=garbage`);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
    });
  });

  const invalidQueries = [
    "limit=0",
    "limit=201",
    "limit=abc",
    "sort=nonsense",
    "direction=sideways",
  ];

  for (const query of invalidQueries) {
    test(`rejects ?${query} with 400`, async () => {
      const response = await harness.app.request(`${REPOS}?${query}`);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(ERROR_CODES.invalidInput);
    });
  }

  test("404s for an unknown namespace", async () => {
    const response = await harness.app.request(`${NAMESPACES}/nope/repos`);

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
  });
});

describe("GET /namespaces/:namespace/repos/:repo", () => {
  test("returns the stored repository", async () => {
    await create({ name: "demo", description: "A demo repository" });

    const response = await harness.app.request(`${REPOS}/demo`);

    expect(response.status).toBe(200);
    expect(await result<RepoWithRemote>(response)).toMatchObject({
      name: "demo",
      description: "A demo repository",
      remote: "http://local.test/git/acme/demo.git",
    });
  });

  test("404s for an unknown repository", async () => {
    const response = await harness.app.request(`${REPOS}/nope`);

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
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
  test("answers 202 with the id, discards the object, and frees the name", async () => {
    const created = await result<CreateRepoResult>(await create({ name: "demo" }));
    const [durableObjectId] = harness.objects.mintedIds;

    const response = await harness.app.request(
      new Request(`${REPOS}/demo`, { method: "DELETE" }),
    );

    expect(response.status).toBe(202);
    expect(await result<{ id: string }>(response)).toEqual({ id: created.id });
    expect(harness.objects.destroyedIds).toEqual([durableObjectId!]);
    expect((await harness.app.request(`${REPOS}/demo`)).status).toBe(404);
  });

  test("404s for an unknown repository and destroys nothing", async () => {
    const response = await harness.app.request(
      new Request(`${REPOS}/nope`, { method: "DELETE" }),
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
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

    expect(response.status).toBe(200);
    expect([...harness.objects.destroyedIds].sort()).toEqual([...minted].sort());
    expect((await harness.app.request(REPOS)).status).toBe(404);
  });
});
