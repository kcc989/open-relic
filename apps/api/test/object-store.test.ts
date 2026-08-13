import { afterEach, expect, test } from "bun:test";

import { CHUNK_BYTES, ObjectStore } from "../src/object-store.ts";
import { hashObject } from "../src/object.ts";
import type { PackObject } from "../src/pack.ts";
import { createTestRepositoryStorage, type TestRepositoryStorage } from "./support/database.ts";

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
