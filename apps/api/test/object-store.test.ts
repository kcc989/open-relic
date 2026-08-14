import { afterEach, expect, test } from "bun:test";

import { CHUNK_BYTES, ObjectStore, RepositoryStorageExhaustedError } from "../src/object-store.ts";
import type { SyncKv } from "../src/db/kv.ts";
import { objects as objectRows } from "../src/db/repository-schema.ts";
import { hashObject } from "../src/object.ts";
import type { PackObject } from "../src/pack.ts";
import {
  createSqliteFullError,
  createTestRepositoryStorage,
  type TestRepositoryStorage,
} from "./support/database.ts";

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
});

test("an object that arrived whole has no delta", async () => {
  const objects = store();
  const written = blob(utf8("whole"));

  await objects.write(written);

  expect(await objects.readDelta(written.oid)).toBeNull();
});

test("writing an object twice leaves one copy", async () => {
  const objects = store();
  const written = blob(utf8("written twice"));

  await objects.write(written);
  await objects.write(written);

  expect((await objects.read(written.oid))?.bytes).toEqual(written.bytes);
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
    chunks: 2,
    bytes: written.bytes.length,
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
    chunks: 2,
    bytes: written.bytes.length,
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
    chunks: 2,
    bytes: written.bytes.length,
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
    delta: { baseOid: "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31", bytes: rawDelta },
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
