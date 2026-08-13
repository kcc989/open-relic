import { afterEach, describe, expect, test } from "bun:test";

import { NamespaceRegistry } from "../src/namespace-registry.ts";
import { RepositoryIndex } from "../src/repository-index.ts";
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
  durableObjectId,
});

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
      durableObjectId: "object-1",
    });

    expect(outcome.created).toBe(true);
    if (!outcome.created) {
      return;
    }

    expect(outcome.repository).toMatchObject({
      namespace: "acme",
      name: "demo",
      description: "A demo",
      defaultBranch: "trunk",
    });
    expect(Date.parse(outcome.repository.createdAt)).not.toBeNaN();
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
  test("lists a namespace's repositories alphabetically", async () => {
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

    const listed = await store.repositories.listRepositories("acme");

    expect(listed?.map((repository) => repository.name)).toEqual([
      "demo",
      "middle",
      "zeta",
    ]);
  });

  test("distinguishes an empty namespace from a missing one", async () => {
    const store = await withNamespace();

    expect(await store.repositories.listRepositories("acme")).toEqual([]);
    expect(await store.repositories.listRepositories("nope")).toBeNull();
  });

  test("resolves a name to the object that holds the repository", async () => {
    const store = await withNamespace();
    await store.repositories.createRepository(
      command("acme", "demo", "object-42"),
    );

    expect(await store.repositories.getRepository("acme", "demo")).toMatchObject(
      {
        durableObjectId: "object-42",
        repository: { namespace: "acme", name: "demo" },
      },
    );
  });

  test("returns null for an unknown repository", async () => {
    const store = await withNamespace();

    expect(await store.repositories.getRepository("acme", "nope")).toBeNull();
  });
});

describe("deleteRepository", () => {
  test("hands back the object id it dropped", async () => {
    const store = await withNamespace();
    await store.repositories.createRepository(
      command("acme", "demo", "object-42"),
    );

    expect(await store.repositories.deleteRepository("acme", "demo")).toBe(
      "object-42",
    );
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
    expect(await store.repositories.listRepositories("acme")).toBeNull();
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
    expect(
      (await store.repositories.listRepositories("other"))?.map(
        (repository) => repository.name,
      ),
    ).toEqual(["demo"]);
  });
});
