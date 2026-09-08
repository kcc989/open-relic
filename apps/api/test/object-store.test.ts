import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { deflateSync, inflateSync } from "node:zlib";

import { CHUNK_BYTES, ObjectStore, RepositoryStorageExhaustedError } from "../src/object-store.ts";
import type { SyncKv } from "../src/db/kv.ts";
import { objectLinks, objects as objectRows } from "../src/db/repository-schema.ts";
import { hashObject } from "../src/object.ts";
import type { PackObject } from "../src/pack.ts";
import {
  createSqliteFullError,
  createTestRepositoryStorage,
  type TestRepositoryStorage,
} from "./support/database.ts";
import { blob as gitBlob, commit, tree, treeEntry } from "./support/git-objects.ts";

const openHandles: Array<() => void> = [];

const storage = (): TestRepositoryStorage => {
  const opened = createTestRepositoryStorage();
  openHandles.push(opened.close);
  return opened;
};

const store = (): ObjectStore => {
  const { db, kv } = storage();
  return new ObjectStore(db, kv);
};

afterEach(() => {
  for (const close of openHandles.splice(0)) {
    close();
  }
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const blob = (contents: Uint8Array): PackObject => ({
  oid: hashObject("blob", contents),
  type: "blob",
  bytes: contents,
  delta: null,
});

const filled = (length: number, seed: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * seed + 11) & 0xff;
  }
  return bytes;
};

const storageFull = (): Error => createSqliteFullError();
const cachedBytes = (bytes: Uint8Array): number => bytes.length + deflateSync(bytes).length;

const failPutOnce = (kv: SyncKv, rejects: (key: string) => boolean): SyncKv => {
  let failed = false;

  return {
    get: <T>(key: string): T | undefined => kv.get<T>(key),
    put: <T>(key: string, value: T): void => {
      if (!failed && rejects(key)) {
        failed = true;
        throw storageFull();
      }
      kv.put(key, value);
    },
    delete: (key: string): void => kv.delete(key),
  };
};

test("an object that was never written reads as nothing", async () => {
  const objects = store();

  expect(await objects.read("9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31")).toBeNull();
  expect(await objects.has("9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31")).toBe(false);
});

test("an object round-trips with its type", async () => {
  const objects = store();
  const written = blob(utf8("hello, pack\n"));

  await objects.write(written);

  expect(await objects.read(written.oid)).toEqual({
    type: "blob",
    bytes: written.bytes,
  });
  expect(await objects.has(written.oid)).toBe(true);
});

test("an empty object round-trips", async () => {
  const objects = store();
  const written = blob(new Uint8Array(0));

  await objects.write(written);

  expect(await objects.describe(written.oid)).toEqual({
    oid: written.oid,
    type: "blob",
    size: 0,
    chunkCount: 0,
  });
  expect((await objects.read(written.oid))?.bytes.length).toBe(0);
});

test("an object larger than one chunk round-trips byte-identically", async () => {
  const objects = store();
  const contents = filled(CHUNK_BYTES * 2 + 7, 31);
  const written = blob(contents);

  await objects.write(written);

  expect(await objects.describe(written.oid)).toEqual({
    oid: written.oid,
    type: "blob",
    size: contents.length,
    chunkCount: 3,
  });
  expect((await objects.read(written.oid))?.bytes).toEqual(contents);
});

test("a streamed object is byte-oriented for transfer over Workers RPC", async () => {
  const objects = store();
  const written = blob(utf8("stream me"));
  await objects.write(written);

  const stream = await objects.readStream(written.oid, "blob");
  const reader = stream!.getReader({ mode: "byob" });
  const next = await reader.read(new Uint8Array(written.bytes.length));

  expect(next.done).toBe(false);
  expect(next.value).toEqual(Uint8Array.from(written.bytes));
  await reader.cancel();
});

test("a delta and its base hash are kept alongside the resolved object", async () => {
  const objects = store();
  const resolved = utf8("the resolved contents");
  const rawDelta = utf8("not really a delta, but bytes we must not lose");
  const baseOid = "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31";
  const oid = hashObject("blob", resolved);

  await objects.write({
    oid,
    type: "blob",
    bytes: resolved,
    delta: { baseOid, bytes: rawDelta },
  });

  expect((await objects.read(oid))?.bytes).toEqual(resolved);
  expect(await objects.readDelta(oid)).toEqual({ baseOid, bytes: rawDelta });
  expect([...inflateSync((await objects.readFullPackEntry(oid))!.compressed)]).toEqual([
    ...resolved,
  ]);
  expect([...inflateSync((await objects.readDeltaPackEntry(oid))!.compressed)]).toEqual([
    ...rawDelta,
  ]);
});

test("an object that arrived whole has no delta", async () => {
  const objects = store();
  const written = blob(utf8("whole"));

  await objects.write(written);

  expect(await objects.readDelta(written.oid)).toBeNull();
});

test("publishes a supplied compressed Pack representation byte-for-byte", async () => {
  const objects = store();
  const contents = filled(8_192, 17);
  const compressed = new Uint8Array(deflateSync(contents, { level: 1 }));
  const written = { ...blob(contents), compressed };

  await objects.write(written);

  expect((await objects.readFullPackEntry(written.oid))?.compressed).toEqual(compressed);
});

test("writing an object twice leaves one copy", async () => {
  const objects = store();
  const written = blob(utf8("written twice"));

  await objects.write(written);
  await objects.write(written);

  expect((await objects.read(written.oid))?.bytes).toEqual(written.bytes);
});

test("a completed object is deduplicated before its bytes are recompressed", async () => {
  const objects = store();
  const written = blob(utf8("already compressed"));
  await objects.write(written);
  const duplicate: PackObject = {
    oid: written.oid,
    type: written.type,
    delta: null,
    get bytes(): Uint8Array {
      throw new Error("duplicate bytes were read");
    },
  };

  await expect(objects.write(duplicate)).resolves.toBeUndefined();
});

test("deduplicates repeated graph edges during writes and index backfills", async () => {
  const opened = storage();
  const objects = new ObjectStore(opened.db, opened.kv);
  const shared = gitBlob("shared contents\n");
  const repeated = tree([treeEntry("one.txt", shared), treeEntry("two.txt", shared)]);
  await objects.write({ ...repeated, delta: null });

  expect((await objects.readIndexedObjects([repeated.oid])).get(repeated.oid)?.links).toEqual([
    { oid: shared.oid, type: "blob" },
  ]);

  await opened.db.delete(objectLinks).where(eq(objectLinks.sourceOid, repeated.oid));
  await opened.db
    .update(objectRows)
    .set({ linksIndexed: false })
    .where(eq(objectRows.oid, repeated.oid));

  expect(await objects.indexLinks(repeated.oid)).toBe(true);
  expect((await objects.readIndexedObjects([repeated.oid])).get(repeated.oid)?.links).toEqual([
    { oid: shared.oid, type: "blob" },
  ]);
});

test("batches delta and reachability metadata below Cloudflare SQLite's bind limit", async () => {
  let queries = 0;
  const opened = createTestRepositoryStorage({
    maxBoundValues: 100,
    onQuery: () => {
      queries += 1;
    },
  });
  openHandles.push(opened.close);
  const objects = new ObjectStore(opened.db, opened.kv);
  const written = Array.from({ length: 205 }, (_, at) => blob(utf8(`object ${at}`)));
  for (const object of written) {
    await objects.write(object);
  }
  const oids = written.map(({ oid }) => oid);

  expect(await objects.readDeltaBases(oids)).toEqual(new Map());
  queries = 0;
  expect((await objects.readPackMetadata(oids)).size).toBe(oids.length);
  expect(queries).toBe(1);
  queries = 0;
  expect((await objects.readIndexedObjects(oids)).size).toBe(oids.length);
  expect(queries).toBe(1);
});

test("reads a frontier's graph rows and their edges in one query", async () => {
  const opened = createTestRepositoryStorage({ maxBoundValues: 100 });
  openHandles.push(opened.close);
  const objects = new ObjectStore(opened.db, opened.kv);
  const leaves = Array.from({ length: 120 }, (_, at) => gitBlob(`leaf ${at}\n`));
  const root = tree(leaves.map((leaf, at) => treeEntry(`file-${at}`, leaf)));
  for (const object of [...leaves, root]) {
    await objects.write({ ...object, delta: null });
  }

  const indexed = await objects.readIndexedObjects([root.oid, ...leaves.map(({ oid }) => oid)]);

  expect(indexed.size).toBe(leaves.length + 1);
  // A blob is indexed and reaches nothing; the tree reaches every one of them.
  expect(indexed.get(leaves[0]!.oid)).toEqual({ type: "blob", links: [] });
  expect(indexed.get(root.oid)?.type).toBe("tree");
  // Edge order follows the stored rows, not the tree, so compare the set.
  expect([...(indexed.get(root.oid)?.links ?? [])].map(({ oid }) => oid).sort()).toEqual(
    leaves.map(({ oid }) => oid).sort(),
  );
});

test("omits an object whose graph edges were never indexed", async () => {
  const opened = storage();
  const objects = new ObjectStore(opened.db, opened.kv);
  const contents = gitBlob("unindexed contents\n");
  const root = tree([treeEntry("README.md", contents)]);
  await objects.write({ ...root, delta: null });
  await opened.db
    .update(objectRows)
    .set({ linksIndexed: false })
    .where(eq(objectRows.oid, root.oid));

  expect((await objects.readIndexedObjects([root.oid])).size).toBe(0);
});

test("finds candidate Objects in a client's indexed closure without returning the closure", async () => {
  const objects = store();
  const contents = gitBlob("reachable contents\n");
  const root = tree([treeEntry("README.md", contents)]);
  const first = commit({ tree: root, message: "First" });
  const second = commit({ tree: root, parents: [first], message: "Second" });
  for (const object of [contents, root, first, second]) {
    await objects.write({ ...object, delta: null });
  }

  expect(
    await objects.readReachableObjects(
      new Set([second.oid]),
      new Set([first.oid, contents.oid, "f".repeat(40)]),
    ),
  ).toEqual(new Set([first.oid, contents.oid]));
  expect(
    await objects.readReachableObjects(
      new Set([second.oid]),
      new Set([first.oid, contents.oid]),
      new Set([second.oid]),
    ),
  ).toEqual(new Set([contents.oid]));
});

test("reads a complete indexed closure with client and shallow boundaries", async () => {
  const objects = store();
  const contents = gitBlob("reachable contents\n");
  const root = tree([treeEntry("README.md", contents)]);
  const first = commit({ tree: root, message: "First" });
  const second = commit({ tree: root, parents: [first], message: "Second" });
  for (const object of [contents, root, first, second]) {
    await objects.write({ ...object, delta: null });
  }

  expect(new Set(await objects.readObjectClosure(new Set([second.oid])))).toEqual(
    new Set([second.oid, first.oid, root.oid, contents.oid]),
  );
  expect(
    new Set(await objects.readObjectClosure(new Set([second.oid]), new Set([first.oid]))),
  ).toEqual(new Set([second.oid, root.oid, contents.oid]));
  expect(
    new Set(
      await objects.readObjectClosure(new Set([second.oid]), new Set(), new Set([second.oid])),
    ),
  ).toEqual(new Set([second.oid, root.oid, contents.oid]));
  expect(await objects.readObjectClosure(new Set(["f".repeat(40)]))).toBeNull();
});

test("a store reopened on the same storage sees the objects", async () => {
  const { db, kv } = storage();
  const written = blob(utf8("survives eviction"));
  await new ObjectStore(db, kv).write(written);

  expect((await new ObjectStore(db, kv).read(written.oid))?.bytes).toEqual(written.bytes);
});

test("an object whose chunks went missing is an error, not silent truncation", async () => {
  const opened = storage();
  const objects = new ObjectStore(opened.db, opened.kv);
  const written = blob(utf8("about to lose its bytes"));
  await objects.write(written);

  opened.kv.delete(`o:${written.oid}:0`);

  expect(objects.read(written.oid)).rejects.toThrow(/is missing/);
});

test("storage exhaustion during resolved chunks leaves nothing visible and a retry repairs it", async () => {
  const opened = storage();
  const written = blob(filled(CHUNK_BYTES + 7, 19));
  const exhausted = new ObjectStore(
    opened.db,
    failPutOnce(opened.kv, (key) => key === `o:${written.oid}:1`),
  );

  expect(exhausted.write(written)).rejects.toThrow("Repository storage is full.");

  const retry = new ObjectStore(opened.db, opened.kv);
  expect(await retry.read(written.oid)).toBeNull();
  expect(opened.kv.get(`o:${written.oid}:0`)).toBeUndefined();
  expect(opened.kv.get(`o:${written.oid}:1`)).toBeUndefined();

  await retry.write(written);
  expect((await retry.read(written.oid))?.bytes).toEqual(written.bytes);
  expect(await retry.reclaim(written.oid)).toEqual({
    objects: 1,
    chunks: 3,
    bytes: cachedBytes(written.bytes),
  });
  expect(opened.kv.get(`o:${written.oid}:0`)).toBeUndefined();
  expect(opened.kv.get(`o:${written.oid}:1`)).toBeUndefined();
});

test("cleanup failure does not replace the repository storage failure", async () => {
  const opened = storage();
  const written = blob(filled(CHUNK_BYTES + 7, 43));
  let storageFailed = false;
  let cleanupFailed = false;
  const failingKv: SyncKv = {
    get: <T>(key: string): T | undefined => opened.kv.get<T>(key),
    put: <T>(key: string, value: T): void => {
      if (!storageFailed && key === `o:${written.oid}:1`) {
        storageFailed = true;
        throw storageFull();
      }
      opened.kv.put(key, value);
    },
    delete: (key: string): void => {
      if (!cleanupFailed && key === `o:${written.oid}:0`) {
        cleanupFailed = true;
        throw new Error("cleanup failed");
      }
      opened.kv.delete(key);
    },
  };

  expect(new ObjectStore(opened.db, failingKv).write(written)).rejects.toBeInstanceOf(
    RepositoryStorageExhaustedError,
  );
});

test("interrupted cleanup remains discoverable for reclamation", async () => {
  const opened = storage();
  const written = blob(filled(CHUNK_BYTES + 7, 47));
  let storageFailed = false;
  let cleanupFailed = false;
  const failingKv: SyncKv = {
    get: <T>(key: string): T | undefined => opened.kv.get<T>(key),
    put: <T>(key: string, value: T): void => {
      if (!storageFailed && key === `o:${written.oid}:1`) {
        storageFailed = true;
        throw storageFull();
      }
      opened.kv.put(key, value);
    },
    delete: (key: string): void => {
      if (!cleanupFailed && key === `o:${written.oid}:0`) {
        cleanupFailed = true;
        throw new Error("cleanup interrupted");
      }
      opened.kv.delete(key);
    },
  };

  await expect(new ObjectStore(opened.db, failingKv).write(written)).rejects.toBeInstanceOf(
    RepositoryStorageExhaustedError,
  );

  const recovery = new ObjectStore(opened.db, opened.kv);
  expect(await recovery.reclaim(written.oid)).toEqual({
    objects: 1,
    chunks: 3,
    bytes: cachedBytes(written.bytes),
  });
  expect(opened.kv.get(`o:${written.oid}:0`)).toBeUndefined();
  expect(opened.kv.get(`o:${written.oid}:1`)).toBeUndefined();
});

test("an object is not readable while its failing write is still incomplete", async () => {
  const opened = storage();
  const written = blob(utf8("must not appear before its chunks do"));
  const reader = new ObjectStore(opened.db, opened.kv);
  let observed: Promise<unknown> | undefined;
  const failingKv: SyncKv = {
    get: <T>(key: string): T | undefined => opened.kv.get<T>(key),
    put: <T>(key: string, value: T): void => {
      if (key === `o:${written.oid}:0` && observed === undefined) {
        observed = reader.read(written.oid);
        throw storageFull();
      }
      opened.kv.put(key, value);
    },
    delete: (key: string): void => opened.kv.delete(key),
  };

  expect(new ObjectStore(opened.db, failingKv).write(written)).rejects.toThrow(
    "Repository storage is full.",
  );
  expect(observed).toBeDefined();
  expect(await observed).toBeNull();
});

test("storage exhaustion during retained delta chunks removes every representation", async () => {
  const opened = storage();
  const resolved = filled(CHUNK_BYTES + 7, 23);
  const rawDelta = filled(CHUNK_BYTES + 3, 37);
  const baseOid = "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31";
  const oid = hashObject("blob", resolved);
  const written: PackObject = {
    oid,
    type: "blob",
    bytes: resolved,
    delta: { baseOid, bytes: rawDelta },
  };
  const exhausted = new ObjectStore(
    opened.db,
    failPutOnce(opened.kv, (key) => key === `d:${oid}:1`),
  );

  expect(exhausted.write(written)).rejects.toThrow("Repository storage is full.");

  const retry = new ObjectStore(opened.db, opened.kv);
  expect(await retry.read(oid)).toBeNull();
  expect(await retry.readDelta(oid)).toBeNull();
  for (const key of [`o:${oid}:0`, `o:${oid}:1`, `d:${oid}:0`, `d:${oid}:1`]) {
    expect(opened.kv.get(key)).toBeUndefined();
  }

  await retry.write(written);
  expect((await retry.read(oid))?.bytes).toEqual(resolved);
  expect(await retry.readDelta(oid)).toEqual({ baseOid, bytes: rawDelta });
});

test("storage exhaustion while publishing metadata leaves chunks retryable", async () => {
  const opened = storage();
  const written = blob(utf8("complete only after the final metadata write"));
  opened.client.run(`
    CREATE TRIGGER fail_object_completion
    BEFORE UPDATE OF complete ON objects
    WHEN NEW.complete = 1
    BEGIN
      SELECT RAISE(ABORT, 'database or disk is full: SQLITE_FULL');
    END
  `);
  const exhausted = new ObjectStore(opened.db, opened.kv);

  expect(exhausted.write(written)).rejects.toThrow("Repository storage is full.");
  expect(await exhausted.read(written.oid)).toBeNull();
  expect(opened.kv.get(`o:${written.oid}:0`)).toBeUndefined();

  opened.client.run("DROP TRIGGER fail_object_completion");
  await exhausted.write(written);
  expect((await exhausted.read(written.oid))?.bytes).toEqual(written.bytes);
});

test("reclaim finds a full-entry cache left by interrupted publication cleanup", async () => {
  const opened = storage();
  const resolved = utf8("resolved bytes whose full cache is deferred");
  const oid = hashObject("blob", resolved);
  await new ObjectStore(opened.db, opened.kv).write({
    oid,
    type: "blob",
    bytes: resolved,
    delta: {
      baseOid: "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31",
      bytes: utf8("retained delta"),
    },
  });
  opened.client.run(`
    CREATE TRIGGER fail_full_cache_publication
    BEFORE UPDATE OF compressed_size ON objects
    WHEN NEW.compressed_size IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'database or disk is full: SQLITE_FULL');
    END
  `);
  let cleanupFailed = false;
  const interruptedKv: SyncKv = {
    get: <T>(key: string): T | undefined => opened.kv.get<T>(key),
    put: <T>(key: string, value: T): void => opened.kv.put(key, value),
    delete: (key: string): void => {
      if (!cleanupFailed && key === `z:${oid}:0`) {
        cleanupFailed = true;
        throw new Error("cleanup interrupted");
      }
      opened.kv.delete(key);
    },
  };

  await expect(
    new ObjectStore(opened.db, interruptedKv).readFullPackEntry(oid),
  ).rejects.toBeInstanceOf(RepositoryStorageExhaustedError);
  const [staged] = await opened.db
    .select({
      compressedSize: objectRows.compressedSize,
      compressedChunkCount: objectRows.compressedChunkCount,
    })
    .from(objectRows)
    .where(eq(objectRows.oid, oid));
  expect(staged).toEqual({ compressedSize: null, compressedChunkCount: 1 });
  expect(opened.kv.get(`z:${oid}:0`)).toBeDefined();

  opened.client.run("DROP TRIGGER fail_full_cache_publication");
  await new ObjectStore(opened.db, opened.kv).reclaim(oid);
  expect(opened.kv.get(`z:${oid}:0`)).toBeUndefined();
});

test("reclaim finds a Delta cache left by interrupted publication cleanup", async () => {
  const opened = storage();
  const resolved = utf8("resolved bytes with a retained delta");
  const oid = hashObject("blob", resolved);
  await new ObjectStore(opened.db, opened.kv).write({
    oid,
    type: "blob",
    bytes: resolved,
    delta: {
      baseOid: "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31",
      bytes: utf8("delta cache bytes"),
    },
  });
  opened.client.run(`
    CREATE TRIGGER fail_delta_cache_publication
    BEFORE UPDATE OF compressed_size ON object_deltas
    WHEN NEW.compressed_size IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'database or disk is full: SQLITE_FULL');
    END
  `);
  let cleanupFailed = false;
  const interruptedKv: SyncKv = {
    get: <T>(key: string): T | undefined => opened.kv.get<T>(key),
    put: <T>(key: string, value: T): void => opened.kv.put(key, value),
    delete: (key: string): void => {
      if (!cleanupFailed && key === `zd:${oid}:0`) {
        cleanupFailed = true;
        throw new Error("cleanup interrupted");
      }
      opened.kv.delete(key);
    },
  };

  await expect(
    new ObjectStore(opened.db, interruptedKv).readDeltaPackEntry(oid),
  ).rejects.toBeInstanceOf(RepositoryStorageExhaustedError);
  expect(opened.kv.get(`zd:${oid}:0`)).toBeDefined();

  opened.client.run("DROP TRIGGER fail_delta_cache_publication");
  await new ObjectStore(opened.db, opened.kv).reclaim(oid);
  expect(opened.kv.get(`zd:${oid}:0`)).toBeUndefined();
});

test("a retry repairs an incomplete row left by an interrupted write", async () => {
  const opened = storage();
  const written = blob(filled(CHUNK_BYTES + 7, 41));
  await opened.db.insert(objectRows).values({
    oid: written.oid,
    type: written.type,
    size: written.bytes.length,
    chunkCount: 2,
    complete: false,
  });
  opened.kv.put(`o:${written.oid}:0`, written.bytes.slice(0, CHUNK_BYTES));

  const retry = new ObjectStore(opened.db, opened.kv);
  expect(await retry.read(written.oid)).toBeNull();

  await retry.write(written);
  expect((await retry.read(written.oid))?.bytes).toEqual(written.bytes);
  expect(await retry.reclaim(written.oid)).toEqual({
    objects: 1,
    chunks: 3,
    bytes: cachedBytes(written.bytes),
  });
  expect(opened.kv.get(`o:${written.oid}:0`)).toBeUndefined();
  expect(opened.kv.get(`o:${written.oid}:1`)).toBeUndefined();
});

test("reclaim removes object chunks, metadata, and a persisted delta", async () => {
  const opened = storage();
  const objects = new ObjectStore(opened.db, opened.kv);
  const resolved = filled(CHUNK_BYTES + 7, 17);
  const rawDelta = filled(CHUNK_BYTES + 3, 29);
  const oid = hashObject("blob", resolved);

  await objects.write({
    oid,
    type: "blob",
    bytes: resolved,
    delta: {
      baseOid: "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31",
      bytes: rawDelta,
    },
  });

  expect(await objects.reclaim(oid)).toEqual({
    objects: 1,
    chunks: 4,
    bytes: resolved.length + rawDelta.length,
  });
  expect(await objects.read(oid)).toBeNull();
  expect(await objects.readDelta(oid)).toBeNull();
  expect(opened.kv.get(`o:${oid}:0`)).toBeUndefined();
  expect(opened.kv.get(`o:${oid}:1`)).toBeUndefined();
  expect(opened.kv.get(`d:${oid}:0`)).toBeUndefined();
  expect(opened.kv.get(`d:${oid}:1`)).toBeUndefined();
  expect(await objects.reclaim(oid)).toBeNull();
});

test("reads a planned window through one multi-get and merges past the key limit", async () => {
  const opened = storage();
  let multiGets = 0;
  const counting: SyncKv = {
    get: <T>(key: string): T | undefined => opened.kv.get<T>(key),
    getMany: <T>(keys: readonly string[]): Promise<ReadonlyMap<string, T>> => {
      multiGets += 1;
      expect(keys.length).toBeLessThanOrEqual(128);
      return opened.kv.getMany!<T>(keys);
    },
    put: <T>(key: string, value: T): void => opened.kv.put(key, value),
    delete: (key: string): void => opened.kv.delete(key),
  };
  const objects = new ObjectStore(opened.db, counting);
  // A stored-block deflate stays larger than one chunk; the rest fit in one apiece.
  const contents = filled(CHUNK_BYTES + 7, 29);
  const split = {
    ...blob(contents),
    compressed: new Uint8Array(deflateSync(contents, { level: 0 })),
  };
  const small = Array.from({ length: 130 }, (_, at) => blob(utf8(`entry ${at}`)));
  await objects.writeBatch([split, ...small]);
  const oids = [split.oid, ...small.map(({ oid }) => oid)];
  const metadata = await objects.readPackMetadata(oids);
  const requests = oids.map((oid) => ({ metadata: metadata.get(oid)!, preferredBaseOid: null }));

  const entries = await objects.readCachedPackEntries(requests);

  expect(entries.size).toBe(oids.length);
  expect(entries.get(split.oid)?.compressed).toEqual(split.compressed);
  expect(entries.get(small[0]!.oid)?.compressed).toEqual(
    new Uint8Array(deflateSync(small[0]!.bytes)),
  );
  // 132 keys: one full multi-get and one for the remainder.
  expect(multiGets).toBe(2);

  multiGets = 0;
  expect((await objects.readCachedPackEntries(requests.slice(1, 100))).size).toBe(99);
  expect(multiGets).toBe(1);
});
