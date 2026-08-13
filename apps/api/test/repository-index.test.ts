import {
  REPO_LIST_DEFAULT_DIRECTION,
  REPO_LIST_DEFAULT_SORT,
  type RepoSortField,
  type SortDirection,
} from "@open-relic/contracts";
import { afterEach, describe, expect, test } from "bun:test";

import { NamespaceRegistry } from "../src/namespace-registry.ts";
import {
  RepositoryIndex,
  type ListRepositoriesQuery,
  type RepositoryCursor,
} from "../src/repository-index.ts";
import { createTestDatabase } from "./support/database.ts";

const openHandles: Array<() => void> = [];

/**
 * Namespaces and repositories share one database because they share one
 * registry object, so the tests build them over one too.
 */
const registry = () => {
  const { db, close } = createTestDatabase();
  openHandles.push(close);

  return {
    namespaces: new NamespaceRegistry(db),
    repositories: new RepositoryIndex(db),
  };
};

afterEach(() => {
  for (const close of openHandles.splice(0)) {
    close();
  }
});

const command = (
  namespaceSlug: string,
  name: string,
  durableObjectId = `object-${namespaceSlug}-${name}`,
) => ({
  namespaceSlug,
  name,
  description: null,
  defaultBranch: "main",
  readOnly: false,
  durableObjectId,
});

/** Artifacts' documented defaults, which is what a bare list means. */
const query = (
  overrides: Partial<ListRepositoriesQuery> = {},
): ListRepositoriesQuery => ({
  limit: 50,
  cursor: null,
  search: null,
  sort: REPO_LIST_DEFAULT_SORT,
  direction: REPO_LIST_DEFAULT_DIRECTION,
  ...overrides,
});

const byName = (
  store: ReturnType<typeof registry>,
  namespaceSlug: string,
  overrides: Partial<ListRepositoriesQuery> = {},
) =>
  store.repositories
    .listRepositories(namespaceSlug, query(overrides))
    .then((page) => page?.repositories.map((repository) => repository.name));

const withNamespace = async (slug = "acme") => {
  const store = registry();
  await store.namespaces.createNamespace({
    slug,
    displayName: slug,
    description: null,
  });
  return store;
};

describe("createRepository", () => {
  test("stores a repository and stamps its creation time", async () => {
    const store = await withNamespace();

    const outcome = await store.repositories.createRepository({
      namespaceSlug: "acme",
      name: "demo",
      description: "A demo",
      defaultBranch: "trunk",
      readOnly: false,
      durableObjectId: "object-1",
    });

    expect(outcome.created).toBe(true);
    if (!outcome.created) {
      return;
    }

    expect(outcome.repository).toMatchObject({
      name: "demo",
      description: "A demo",
      default_branch: "trunk",
      read_only: false,
      source: null,
      last_push_at: null,
    });
    expect(Date.parse(outcome.repository.created_at)).not.toBeNaN();
    // Nothing has touched it yet, so both stamps read the same clock.
    expect(outcome.repository.updated_at).toBe(outcome.repository.created_at);
  });

  test("mints an opaque id that is not the object id", async () => {
    const store = await withNamespace();

    const outcome = await store.repositories.createRepository(
      command("acme", "demo", "object-42"),
    );

    expect(outcome.created).toBe(true);
    if (!outcome.created) {
      return;
    }

    expect(outcome.repository.id).toStartWith("repo_");
    expect(outcome.repository.id).not.toBe("object-42");
  });

  test("gives two repositories different ids", async () => {
    const store = await withNamespace();
    await store.repositories.createRepository(command("acme", "demo"));
    await store.repositories.createRepository(command("acme", "other"));

    const first = await store.repositories.getRepository("acme", "demo");
    const second = await store.repositories.getRepository("acme", "other");

    expect(first?.repository.id).not.toBe(second?.repository.id);
  });

  test("stores the read-only flag", async () => {
    const store = await withNamespace();
    await store.repositories.createRepository({
      ...command("acme", "demo"),
      readOnly: true,
    });

    expect(
      (await store.repositories.getRepository("acme", "demo"))?.repository
        .read_only,
    ).toBe(true);
  });

  test("refuses a namespace that does not exist", async () => {
    const store = registry();

    expect(
      await store.repositories.createRepository(command("nope", "demo")),
    ).toEqual({ created: false, reason: "namespace-missing" });
  });

  test("refuses a name already taken in the namespace", async () => {
    const store = await withNamespace();
    await store.repositories.createRepository(command("acme", "demo"));

    const second = await store.repositories.createRepository(
      command("acme", "demo", "object-second"),
    );

    expect(second).toEqual({ created: false, reason: "name-taken" });
    // The first repository keeps its object; the rejected create's id is
    // never stored, so nothing points at it.
    expect(
      (await store.repositories.getRepository("acme", "demo"))
        ?.durableObjectId,
    ).toBe("object-acme-demo");
  });

  test("allows the same name in two namespaces", async () => {
    const store = await withNamespace();
    await store.namespaces.createNamespace({
      slug: "other",
      displayName: "other",
      description: null,
    });

    expect(
      (await store.repositories.createRepository(command("acme", "demo")))
        .created,
    ).toBe(true);
    expect(
      (await store.repositories.createRepository(command("other", "demo")))
        .created,
    ).toBe(true);
  });
});

describe("reads", () => {
  test("lists only the namespace's own repositories", async () => {
    const store = await withNamespace();
    await store.namespaces.createNamespace({
      slug: "other",
      displayName: "other",
      description: null,
    });
    for (const name of ["zeta", "demo", "middle"]) {
      await store.repositories.createRepository(command("acme", name));
    }
    await store.repositories.createRepository(command("other", "elsewhere"));

    expect(
      (await byName(store, "acme", { sort: "name", direction: "asc" })) ?? [],
    ).toEqual(["demo", "middle", "zeta"]);
  });

  test("distinguishes an empty namespace from a missing one", async () => {
    const store = await withNamespace();

    expect(
      await store.repositories.listRepositories("acme", query()),
    ).toEqual({ repositories: [], next: null });
    expect(
      await store.repositories.listRepositories("nope", query()),
    ).toBeNull();
  });

  test("resolves a name to the object that holds the repository", async () => {
    const store = await withNamespace();
    await store.repositories.createRepository(
      command("acme", "demo", "object-42"),
    );

    expect(await store.repositories.getRepository("acme", "demo")).toMatchObject(
      {
        durableObjectId: "object-42",
        repository: { name: "demo" },
      },
    );
  });

  test("returns null for an unknown repository", async () => {
    const store = await withNamespace();

    expect(await store.repositories.getRepository("acme", "nope")).toBeNull();
  });
});

describe("sorting", () => {
  const seeded = async () => {
    const store = await withNamespace();
    for (const name of ["beta", "alpha", "gamma"]) {
      await store.repositories.createRepository(command("acme", name));
    }
    return store;
  };

  const cases: ReadonlyArray<
    readonly [RepoSortField, SortDirection, readonly string[]]
  > = [
    ["name", "asc", ["alpha", "beta", "gamma"]],
    ["name", "desc", ["gamma", "beta", "alpha"]],
  ];

  for (const [sort, direction, expected] of cases) {
    test(`orders by ${sort} ${direction}`, async () => {
      const store = await seeded();

      expect(await byName(store, "acme", { sort, direction })).toEqual([
        ...expected,
      ]);
    });
  }

  test("orders never-pushed repositories together rather than dropping them", async () => {
    const store = await seeded();

    // `last_push_at` is NULL for all three; the sort still has to return them.
    expect(
      (await byName(store, "acme", {
        sort: "last_push_at",
        direction: "asc",
      })) ?? [],
    ).toHaveLength(3);
  });
});

describe("search", () => {
  const seeded = async () => {
    const store = await withNamespace();
    for (const name of ["api-server", "api-client", "web"]) {
      await store.repositories.createRepository(command("acme", name));
    }
    return store;
  };

  test("filters by an infix of the name", async () => {
    const store = await seeded();

    expect(
      await byName(store, "acme", {
        search: "api",
        sort: "name",
        direction: "asc",
      }),
    ).toEqual(["api-client", "api-server"]);
  });

  test("treats wildcards in the term as literals", async () => {
    const store = await seeded();

    // `%` would match everything if it reached SQLite unescaped.
    expect(await byName(store, "acme", { search: "%" })).toEqual([]);
  });
});

describe("paging", () => {
  const seeded = async (...names: readonly string[]) => {
    const store = await withNamespace();
    for (const name of names) {
      await store.repositories.createRepository(command("acme", name));
    }
    return store;
  };

  test("walks every repository exactly once across pages", async () => {
    const store = await seeded("alpha", "beta", "delta", "gamma", "zeta");

    const seen: string[] = [];
    let cursor: RepositoryCursor | null = null;
    do {
      const page = await store.repositories.listRepositories(
        "acme",
        query({ limit: 2, cursor, sort: "name", direction: "asc" }),
      );
      seen.push(...(page?.repositories ?? []).map((repo) => repo.name));
      cursor = page?.next ?? null;
    } while (cursor !== null);

    expect(seen).toEqual(["alpha", "beta", "delta", "gamma", "zeta"]);
  });

  test("resumes correctly when the sort key ties across rows", async () => {
    // Every row shares one `created_at` only if the clock does not move, so
    // sort by a key that genuinely ties: the name tiebreak is what has to
    // carry the walk.
    const store = await seeded("alpha", "beta", "gamma");

    const seen: string[] = [];
    let cursor: RepositoryCursor | null = null;
    do {
      const page = await store.repositories.listRepositories(
        "acme",
        query({ limit: 1, cursor, sort: "last_push_at", direction: "asc" }),
      );
      seen.push(...(page?.repositories ?? []).map((repo) => repo.name));
      cursor = page?.next ?? null;
    } while (cursor !== null);

    expect([...seen].sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("does not hand back a position on an exactly-full last page", async () => {
    const store = await seeded("alpha", "beta");

    const page = await store.repositories.listRepositories(
      "acme",
      query({ limit: 2 }),
    );

    expect(page?.next).toBeNull();
  });

  test("carries the search filter across a page boundary", async () => {
    const store = await seeded("api-a", "api-b", "web-a", "api-c");

    const first = await store.repositories.listRepositories(
      "acme",
      query({ limit: 2, search: "api", sort: "name", direction: "asc" }),
    );
    const second = await store.repositories.listRepositories(
      "acme",
      query({
        limit: 2,
        cursor: first?.next ?? null,
        search: "api",
        sort: "name",
        direction: "asc",
      }),
    );

    expect(first?.repositories.map((repo) => repo.name)).toEqual([
      "api-a",
      "api-b",
    ]);
    expect(second?.repositories.map((repo) => repo.name)).toEqual(["api-c"]);
  });
});

describe("deleteRepository", () => {
  test("hands back the ids it dropped", async () => {
    const store = await withNamespace();
    const created = await store.repositories.createRepository(
      command("acme", "demo", "object-42"),
    );

    const deleted = await store.repositories.deleteRepository("acme", "demo");

    expect(deleted?.durableObjectId).toBe("object-42");
    expect(deleted?.id).toBe(created.created ? created.repository.id : "");
    expect(await store.repositories.getRepository("acme", "demo")).toBeNull();
  });

  test("reports that an unknown repository was not removed", async () => {
    const store = await withNamespace();

    expect(await store.repositories.deleteRepository("acme", "nope")).toBeNull();
  });
});

describe("deleting a namespace", () => {
  test("takes its repositories with it and names their objects", async () => {
    const store = await withNamespace();
    await store.repositories.createRepository(
      command("acme", "demo", "object-1"),
    );
    await store.repositories.createRepository(
      command("acme", "other", "object-2"),
    );

    const outcome = await store.namespaces.deleteNamespace("acme");

    expect(outcome.deleted).toBe(true);
    expect([...outcome.repositoryObjectIds].sort()).toEqual([
      "object-1",
      "object-2",
    ]);
    expect(
      await store.repositories.listRepositories("acme", query()),
    ).toBeNull();
  });

  test("leaves another namespace's repositories alone", async () => {
    const store = await withNamespace();
    await store.namespaces.createNamespace({
      slug: "other",
      displayName: "other",
      description: null,
    });
    await store.repositories.createRepository(command("acme", "demo"));
    await store.repositories.createRepository(command("other", "demo"));

    const outcome = await store.namespaces.deleteNamespace("acme");

    expect(outcome.repositoryObjectIds).toEqual(["object-acme-demo"]);
    expect(await byName(store, "other")).toEqual(["demo"]);
  });
});
