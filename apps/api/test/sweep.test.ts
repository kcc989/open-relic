import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ObjectStore } from "../src/object-store.ts";
import { RepositoryStore } from "../src/repository-store.ts";
import type { SyncKv } from "../src/db/kv.ts";
import { sweepReachable } from "../src/db/repository-schema.ts";
import type { SweepProgress } from "../src/sweep.ts";
import { blob, commit, tree, treeEntry, type GitObject } from "./support/git-objects.ts";
import {
  createTestRepositoryStorage,
  seedRefs,
  type TestRepositoryStorage,
} from "./support/database.ts";
import { pushBody } from "./support/receive-pack.ts";
import { streamOf } from "./support/pack.ts";

const MAIN = "refs/heads/main";

class DestructibleRepositoryStore extends RepositoryStore {
  destroy(remove: () => Promise<void>): Promise<void> {
    return this.destroyStorage(remove);
  }
}

let opened: TestRepositoryStorage;
let store: DestructibleRepositoryStore;
let objects: ObjectStore;

beforeEach(async () => {
  opened = createTestRepositoryStorage();
  store = new DestructibleRepositoryStore(opened.db, opened.kv);
  objects = new ObjectStore(opened.db, opened.kv);
  await store.initialize({ defaultBranch: "main", createdAt: "2026-08-13T00:00:00.000Z" });
});

afterEach(() => {
  opened.close();
});

const write = async (...written: readonly GitObject[]): Promise<void> => {
  for (const object of written) {
    await objects.write({ ...object, delta: null });
  }
};

const finish = async (
  repository: RepositoryStore = store,
  batchSize: number = 64,
): Promise<SweepProgress> => {
  for (let turns = 0; turns < 100; turns += 1) {
    const progress = await repository.sweep(batchSize);
    if (progress.phase === "complete") {
      return progress;
    }
  }
  throw new Error("The sweep did not finish within 100 turns.");
};

describe("marking from refs", () => {
  test("keeps the complete closure, including file blobs, and reclaims an orphan", async () => {
    const readme = blob("reachable file contents\n");
    const root = tree([treeEntry("README.md", readme)]);
    const tip = commit({ tree: root });
    const orphanBytes = new TextEncoder().encode("unreachable resolved contents");
    const deltaBytes = new TextEncoder().encode("persisted delta");
    const orphan = blob(new TextDecoder().decode(orphanBytes));

    await write(tip, root, readme);
    await objects.write({
      ...orphan,
      delta: { baseOid: readme.oid, bytes: deltaBytes },
    });
    await seedRefs(opened.db, { [MAIN]: tip.oid });

    const progress = await finish();

    expect(await objects.has(tip.oid)).toBe(true);
    expect(await objects.has(root.oid)).toBe(true);
    expect(await objects.has(readme.oid)).toBe(true);
    expect(await objects.has(orphan.oid)).toBe(false);
    expect(await objects.readDelta(orphan.oid)).toBeNull();
    expect(opened.kv.get(`o:${orphan.oid}:0`)).toBeUndefined();
    expect(opened.kv.get(`d:${orphan.oid}:0`)).toBeUndefined();
    expect(progress).toMatchObject({
      phase: "complete",
      reachableObjects: 3,
      reclaimedObjects: 1,
      reclaimedChunks: 2,
      reclaimedBytes: orphanBytes.length + deltaBytes.length,
    });
    expect(progress.completedAt).not.toBeNull();
    expect(
      (await opened.db.select().from(sweepReachable))
        .map(({ oid, pending }) => ({ oid, pending }))
        .sort((left, right) => left.oid.localeCompare(right.oid)),
    ).toEqual([tip.oid, root.oid, readme.oid].sort().map((oid) => ({ oid, pending: false })));
  });

  test("marks an object shared by several refs only once", async () => {
    const shared = blob("shared");
    await write(shared);
    await seedRefs(opened.db, {
      "refs/heads/one": shared.oid,
      "refs/tags/two": shared.oid,
    });

    expect(await finish()).toMatchObject({ reachableObjects: 1, reclaimedObjects: 0 });
    expect(await objects.has(shared.oid)).toBe(true);
  });

  test("marks a tree with more links than fit in one Cloudflare SQLite statement", async () => {
    const files = Array.from({ length: 40 }, (_, index) => blob(`file ${index}\n`));
    const root = tree(files.map((file, index) => treeEntry(`file-${index}.txt`, file)));
    const tip = commit({ tree: root });
    await write(tip, root, ...files);
    await seedRefs(opened.db, { [MAIN]: tip.oid });

    expect(await finish()).toMatchObject({
      phase: "complete",
      reachableObjects: 42,
      reclaimedObjects: 0,
    });
    for (const file of files) {
      expect(await objects.has(file.oid)).toBe(true);
    }
  });

  test("seeds more ref roots than fit in one Cloudflare SQLite statement", async () => {
    const roots = Array.from({ length: 40 }, (_, index) => blob(`root ${index}\n`));
    await write(...roots);
    await seedRefs(
      opened.db,
      Object.fromEntries(roots.map((root, index) => [`refs/heads/root-${index}`, root.oid])),
    );

    expect(await finish()).toMatchObject({
      phase: "complete",
      reachableObjects: 40,
      reclaimedObjects: 0,
    });
  });

  test("does not read blob chunks merely to discover that blobs name nothing", async () => {
    const contents = blob("the bytes a sweep should not load\n");
    const root = tree([treeEntry("large.bin", contents)]);
    const tip = commit({ tree: root });
    await write(tip, root, contents);
    await seedRefs(opened.db, { [MAIN]: tip.oid });

    let blobChunkReads = 0;
    const countingKv: SyncKv = {
      get: <T>(key: string): T | undefined => {
        if (key.startsWith(`o:${contents.oid}:`)) {
          blobChunkReads += 1;
        }
        return opened.kv.get<T>(key);
      },
      put: <T>(key: string, value: T): void => opened.kv.put(key, value),
      delete: (key: string): void => opened.kv.delete(key),
    };

    await finish(new RepositoryStore(opened.db, countingKv));

    expect(blobChunkReads).toBe(0);
    expect(await objects.has(contents.oid)).toBe(true);
  });

  test("a tree naming a missing blob does not wedge reclamation", async () => {
    const missing = blob("named but deliberately absent");
    const root = tree([treeEntry("missing.txt", missing)]);
    const tip = commit({ tree: root });

    const pushed = await store.receivePack(
      streamOf(
        pushBody({
          commands: [{ newOid: tip.oid, name: MAIN }],
          objects: [tip, root],
        }),
      ),
    );
    expect(pushed.accepted).toBe(true);

    const orphan = blob("still reclaimed despite the absent reachable blob");
    await write(orphan);
    const progress = await finish();

    expect(progress).toMatchObject({
      phase: "complete",
      reachableObjects: 3,
      reclaimedObjects: 1,
    });
    expect(await objects.has(tip.oid)).toBe(true);
    expect(await objects.has(root.oid)).toBe(true);
    expect(await objects.has(missing.oid)).toBe(false);
    expect(await objects.has(orphan.oid)).toBe(false);
  });
});

describe("checkpointing", () => {
  test("resumes from persisted work after the store is recreated", async () => {
    const orphans = [blob("one"), blob("two"), blob("three")];
    await write(...orphans);

    expect(await store.sweep(1)).toMatchObject({ phase: "sweep", reclaimedObjects: 0 });
    expect(await store.sweep(1)).toMatchObject({ phase: "sweep", reclaimedObjects: 1 });

    const reopened = new RepositoryStore(opened.db, opened.kv);
    const progress = await finish(reopened, 1);

    expect(progress).toMatchObject({ phase: "complete", reclaimedObjects: 3 });
    for (const orphan of orphans) {
      expect(await objects.has(orphan.oid)).toBe(false);
    }
  });

  test("restarts its mark when a push changes the refs between batches", async () => {
    const held = blob("the existing tip");
    const adopted = blob("an orphan until the next push");
    await write(held, adopted);
    await seedRefs(opened.db, { [MAIN]: held.oid });

    expect(await store.sweep(1)).toMatchObject({ phase: "sweep", reachableObjects: 1 });

    const pushed = await store.receivePack(
      streamOf(
        pushBody({
          commands: [{ newOid: adopted.oid, name: "refs/heads/adopted" }],
          objects: [],
        }),
      ),
    );
    expect(pushed.accepted).toBe(true);

    const progress = await finish(store, 1);
    expect(progress).toMatchObject({ reachableObjects: 2, reclaimedObjects: 0 });
    expect(await objects.has(held.oid)).toBe(true);
    expect(await objects.has(adopted.oid)).toBe(true);
  });
});

test("a sweep waits for a push in flight before it can inspect or delete objects", async () => {
  const readme = blob("lands during the push\n");
  const root = tree([treeEntry("README.md", readme)]);
  const tip = commit({ tree: root });
  const body = pushBody({
    commands: [{ newOid: tip.oid, name: MAIN }],
    objects: [tip, root, readme],
  });

  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let second = false;
  const slowBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body.subarray(0, Math.floor(body.length / 2)));
    },
    async pull(controller) {
      if (second) {
        return;
      }
      second = true;
      await held;
      controller.enqueue(body.subarray(Math.floor(body.length / 2)));
      controller.close();
    },
  });

  const pushing = store.receivePack(slowBody);
  let swept = false;
  const sweeping = store.sweep(1).then((progress) => {
    swept = true;
    return progress;
  });

  await Promise.resolve();
  await Promise.resolve();
  expect(swept).toBe(false);

  release();
  expect((await pushing).accepted).toBe(true);
  await sweeping;
  await finish(store, 1);

  expect(await objects.has(tip.oid)).toBe(true);
  expect(await objects.has(root.oid)).toBe(true);
  expect(await objects.has(readme.oid)).toBe(true);
});

test("destruction waits until an in-flight sweep has finished re-arming its alarm", async () => {
  let releaseRearm = (): void => {};
  const held = new Promise<void>((resolve) => {
    releaseRearm = resolve;
  });
  let rearmStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    rearmStarted = resolve;
  });
  let alarmArmed = false;

  const sweeping = store.sweep(1, async () => {
    rearmStarted();
    await held;
    alarmArmed = true;
  });
  await started;

  let destroyed = false;
  const destroying = store.destroy(async () => {
    alarmArmed = false;
    destroyed = true;
  });

  await Promise.resolve();
  expect(destroyed).toBe(false);

  releaseRearm();
  await sweeping;
  await destroying;

  expect(destroyed).toBe(true);
  expect(alarmArmed).toBe(false);
});
