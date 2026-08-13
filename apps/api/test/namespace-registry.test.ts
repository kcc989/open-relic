import { afterEach, describe, expect, test } from "bun:test";

import { NamespaceRegistry } from "../src/namespace-registry.ts";
import { createTestDatabase } from "./support/database.ts";

const openHandles: Array<() => void> = [];

const registry = () => {
  const { db, close } = createTestDatabase();
  openHandles.push(close);
  return new NamespaceRegistry(db);
};

afterEach(() => {
  for (const close of openHandles.splice(0)) {
    close();
  }
});

const command = (slug: string, description: string | null = null) => ({
  slug,
  displayName: slug,
  description,
});

/** The whole list, for assertions that are not about paging. */
const page = (limit = 50, cursor: string | null = null) => ({ limit, cursor });

describe("createNamespace", () => {
  test("stores a namespace and stamps its creation time", async () => {
    const outcome = await registry().createNamespace({
      slug: "acme",
      displayName: "Acme, Inc.",
      description: "Anvils and rockets",
    });

    expect(outcome.created).toBe(true);
    if (!outcome.created) {
      return;
    }

    expect(outcome.namespace).toMatchObject({
      slug: "acme",
      display_name: "Acme, Inc.",
      description: "Anvils and rockets",
    });
    expect(Date.parse(outcome.namespace.created_at)).not.toBeNaN();
  });

  test("rejects a slug that is already taken", async () => {
    const store = registry();
    expect((await store.createNamespace(command("acme"))).created).toBe(true);

    const second = await store.createNamespace(
      command("acme", "a different one"),
    );

    expect(second).toEqual({ created: false, reason: "slug-taken" });
    expect((await store.listNamespaces(page())).namespaces).toHaveLength(1);
    expect((await store.getNamespace("acme"))?.description).toBeNull();
  });
});

describe("reads", () => {
  test("lists namespaces alphabetically", async () => {
    const store = registry();
    for (const slug of ["zeta", "acme", "middle"]) {
      await store.createNamespace(command(slug));
    }

    const listed = await store.listNamespaces(page());

    expect(listed.namespaces.map((namespace) => namespace.slug)).toEqual([
      "acme",
      "middle",
      "zeta",
    ]);
    // Everything fit, so there is nothing to resume from.
    expect(listed.cursor).toBe("");
  });

  test("returns null for an unknown slug", async () => {
    expect(await registry().getNamespace("nope")).toBeNull();
  });
});

describe("paging", () => {
  const seeded = async (...slugs: readonly string[]) => {
    const store = registry();
    for (const slug of slugs) {
      await store.createNamespace(command(slug));
    }
    return store;
  };

  test("walks every namespace exactly once across pages", async () => {
    const store = await seeded("acme", "beta", "delta", "gamma", "zeta");

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const listed = await store.listNamespaces(page(2, cursor));
      seen.push(...listed.namespaces.map((namespace) => namespace.slug));
      cursor = listed.cursor === "" ? null : listed.cursor;
    } while (cursor !== null);

    expect(seen).toEqual(["acme", "beta", "delta", "gamma", "zeta"]);
  });

  test("does not hand back a cursor on an exactly-full last page", async () => {
    const store = await seeded("acme", "beta");

    expect((await store.listNamespaces(page(2))).cursor).toBe("");
  });

  test("skips a namespace inserted behind the cursor", async () => {
    const store = await seeded("beta", "delta");
    const first = await store.listNamespaces(page(1));

    // `acme` sorts before the cursor, so the walk cannot see it — the price of
    // a keyset cursor, and the reason a page never shifts under the client.
    await store.createNamespace(command("acme"));
    const second = await store.listNamespaces(page(10, first.cursor));

    expect(first.namespaces.map((namespace) => namespace.slug)).toEqual([
      "beta",
    ]);
    expect(second.namespaces.map((namespace) => namespace.slug)).toEqual([
      "delta",
    ]);
  });

  test("answers an unreadable cursor with an empty page", async () => {
    const store = await seeded("acme");

    expect(await store.listNamespaces(page(10, "not-a-cursor"))).toEqual({
      namespaces: [],
      cursor: "",
    });
  });
});

describe("deleteNamespace", () => {
  test("removes an existing namespace", async () => {
    const store = registry();
    await store.createNamespace(command("acme"));

    expect(await store.deleteNamespace("acme")).toEqual({
      deleted: true,
      repositoryObjectIds: [],
    });
    expect(await store.getNamespace("acme")).toBeNull();
    expect((await store.listNamespaces(page())).namespaces).toEqual([]);
  });

  test("reports that an unknown slug was not removed", async () => {
    expect(await registry().deleteNamespace("nope")).toEqual({
      deleted: false,
      repositoryObjectIds: [],
    });
  });
});

test("a registry reopened on the same database sees existing rows", async () => {
  const { db, close } = createTestDatabase();
  await new NamespaceRegistry(db).createNamespace(command("acme"));

  // A Durable Object is reconstructed against the same storage after eviction.
  const reopened = new NamespaceRegistry(db);

  expect((await reopened.getNamespace("acme"))?.slug).toBe("acme");
  close();
});
