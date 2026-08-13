import { afterEach, expect, test } from "bun:test";

import { RepositoryStore } from "../src/repository-store.ts";
import { createTestRepositoryDatabase } from "./support/database.ts";

const openHandles: Array<() => void> = [];

const store = () => {
  const { db, close } = createTestRepositoryDatabase();
  openHandles.push(close);
  return new RepositoryStore(db);
};

afterEach(() => {
  for (const close of openHandles.splice(0)) {
    close();
  }
});

const init = {
  defaultBranch: "main",
  createdAt: "2026-08-13T00:00:00.000Z",
};

test("an uninitialized repository object describes itself as empty", async () => {
  expect(await store().describe()).toBeNull();
});

test("initializing records the branch HEAD will point at", async () => {
  const repository = store();

  expect(await repository.initialize(init)).toEqual(init);
  expect(await repository.describe()).toEqual(init);
});

test("initializing twice keeps the first state", async () => {
  const repository = store();
  await repository.initialize(init);

  const second = await repository.initialize({
    defaultBranch: "trunk",
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  expect(second).toEqual(init);
  expect(await repository.describe()).toEqual(init);
});

test("a store reopened on the same database sees the existing state", async () => {
  const { db, close } = createTestRepositoryDatabase();
  await new RepositoryStore(db).initialize(init);

  // A Durable Object is reconstructed against the same storage after eviction.
  expect(await new RepositoryStore(db).describe()).toEqual(init);
  close();
});
