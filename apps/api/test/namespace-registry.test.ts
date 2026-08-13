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
      displayName: "Acme, Inc.",
      description: "Anvils and rockets",
    });
    expect(Date.parse(outcome.namespace.createdAt)).not.toBeNaN();
  });

  test("rejects a slug that is already taken", async () => {
    const store = registry();
    expect((await store.createNamespace(command("acme"))).created).toBe(true);

    const second = await store.createNamespace(
      command("acme", "a different one"),
    );

    expect(second).toEqual({ created: false, reason: "slug-taken" });
    expect(await store.listNamespaces()).toHaveLength(1);
    expect((await store.getNamespace("acme"))?.description).toBeNull();
  });
});

describe("reads", () => {
  test("lists namespaces alphabetically", async () => {
    const store = registry();
    for (const slug of ["zeta", "acme", "middle"]) {
      await store.createNamespace(command(slug));
    }

    const listed = await store.listNamespaces();

    expect(listed.map((namespace) => namespace.slug)).toEqual([
      "acme",
      "middle",
      "zeta",
    ]);
  });

  test("returns null for an unknown slug", async () => {
    expect(await registry().getNamespace("nope")).toBeNull();
  });
});

describe("deleteNamespace", () => {
  test("removes an existing namespace", async () => {
    const store = registry();
    await store.createNamespace(command("acme"));

    expect(await store.deleteNamespace("acme")).toBe(true);
    expect(await store.getNamespace("acme")).toBeNull();
    expect(await store.listNamespaces()).toEqual([]);
  });

  test("reports that an unknown slug was not removed", async () => {
    expect(await registry().deleteNamespace("nope")).toBe(false);
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
