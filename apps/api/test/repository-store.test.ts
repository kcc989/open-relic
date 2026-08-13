import { afterEach, expect, test } from "bun:test";

import { HEAD_KEY } from "../src/head.ts";
import { RepositoryStore } from "../src/repository-store.ts";
import {
  createTestRepositoryStorage,
  seedRefs,
  type TestRepositoryStorage,
} from "./support/database.ts";

const openHandles: Array<() => void> = [];

const storage = (): TestRepositoryStorage => {
  const opened = createTestRepositoryStorage();
  openHandles.push(opened.close);
  return opened;
};

const store = () => {
  const { db, kv } = storage();
  return new RepositoryStore(db, kv);
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

const DETACHED_OID = "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31";

test("an uninitialized repository object describes itself as empty", async () => {
  expect(await store().describe()).toBeNull();
});

test("initializing records the branch HEAD will point at", async () => {
  const repository = store();

  expect(await repository.initialize(init)).toEqual(init);
  expect(await repository.describe()).toEqual(init);
});

test("initializing writes HEAD as the bytes git init would write", async () => {
  const opened = storage();
  await new RepositoryStore(opened.db, opened.kv).initialize({
    ...init,
    defaultBranch: "release/2.0.x",
  });

  expect(opened.kv.get(HEAD_KEY)).toBe("ref: refs/heads/release/2.0.x\n");
});

test("initializing twice keeps the first state", async () => {
  const opened = storage();
  const repository = new RepositoryStore(opened.db, opened.kv);
  await repository.initialize(init);

  const second = await repository.initialize({
    defaultBranch: "trunk",
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  expect(second).toEqual(init);
  expect(await repository.describe()).toEqual(init);
  expect(opened.kv.get(HEAD_KEY)).toBe("ref: refs/heads/main\n");
});

test("a store reopened on the same storage sees the existing state", async () => {
  const { db, kv } = storage();
  await new RepositoryStore(db, kv).initialize(init);

  // A Durable Object is reconstructed against the same storage after eviction.
  expect(await new RepositoryStore(db, kv).describe()).toEqual(init);
});

test("a detached HEAD leaves the repository with no default branch", async () => {
  const opened = storage();
  const repository = new RepositoryStore(opened.db, opened.kv);
  await repository.initialize(init);

  opened.kv.put(HEAD_KEY, `${DETACHED_OID}\n`);

  expect(await repository.describe()).toEqual({
    defaultBranch: null,
    createdAt: init.createdAt,
  });
});

test("a repository with no refs advertises the zero-id capabilities line", async () => {
  const repository = store();
  await repository.initialize(init);

  const advertisement = await new Response(await repository.advertiseReceivePack()).text();

  expect(advertisement).toContain(`${"0".repeat(40)} capabilities^{}\0`);
});

test("the advertisement names the refs the repository holds", async () => {
  const opened = storage();
  const repository = new RepositoryStore(opened.db, opened.kv);
  await repository.initialize(init);
  await seedRefs(opened.db, {
    "refs/tags/v1": "abcdef0123456789abcdef0123456789abcdef01",
    "refs/heads/main": "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
  });

  const advertisement = await new Response(await repository.advertiseReceivePack()).text();

  // Byte order by full ref name, which is the order Git advertises in, so the
  // branch carries the capabilities and the tag follows it.
  expect(advertisement).toContain("1a2b3c4d5e6f708192a3b4c5d6e7f80912345678 refs/heads/main\0");
  expect(advertisement).toEndWith("abcdef0123456789abcdef0123456789abcdef01 refs/tags/v1\n0000");
});

test("an unreadable HEAD leaves the repository with no default branch", async () => {
  const opened = storage();
  const repository = new RepositoryStore(opened.db, opened.kv);
  await repository.initialize(init);

  opened.kv.delete(HEAD_KEY);

  expect(await repository.describe()).toEqual({
    defaultBranch: null,
    createdAt: init.createdAt,
  });
});
