import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CHUNK_BYTES, ObjectStore } from "../src/object-store.ts";
import { hashObject, isObjectType, type ObjectType } from "../src/object.ts";
import { readPack } from "../src/pack.ts";
import { createTestRepositoryStorage, type TestRepositoryStorage } from "./support/database.ts";
import { streamOf } from "./support/pack.ts";

/**
 * The packs and the manifest in `test/fixtures` were written by a real Git
 * client — see `fixtures/generate.sh`. The manifest is what that client says
 * its objects are named, which is the thing worth agreeing with.
 */

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

interface ManifestEntry {
  readonly oid: string;
  readonly type: ObjectType;
  readonly size: number;
}

const manifest: readonly ManifestEntry[] = JSON.parse(
  new TextDecoder().decode(fixture("real-git-objects.json")),
);

const openHandles: Array<() => void> = [];

const store = (): ObjectStore => {
  const opened: TestRepositoryStorage = createTestRepositoryStorage();
  openHandles.push(opened.close);
  return new ObjectStore(opened.db, opened.kv);
};

afterEach(() => {
  for (const close of openHandles.splice(0)) {
    close();
  }
});

const packs = [
  ["ofs-delta", "real-git-ofs-delta.pack"],
  ["ref-delta", "real-git-ref-delta.pack"],
] as const;

test("the fixture manifest describes the repository we meant to build", () => {
  expect(manifest.length).toBeGreaterThan(20);
  expect(manifest.every((entry) => isObjectType(entry.type))).toBe(true);
  expect(manifest.some((entry) => entry.type === "tag")).toBe(true);
  expect(manifest.some((entry) => entry.size > CHUNK_BYTES)).toBe(true);
});

for (const [encoding, file] of packs) {
  test(`a ${encoding} pack from git yields the objects git named`, async () => {
    const objects = store();

    const summary = await readPack(
      // A chunk far smaller than the pack, so the reader has to hold its
      // state across pushes the way a request body would make it.
      streamOf(fixture(file), { chunkSize: 4_096 }),
      objects,
    );

    expect(summary.objectCount).toBe(manifest.length);

    for (const entry of manifest) {
      const stored = await objects.read(entry.oid);

      expect(stored).not.toBeNull();
      expect(stored?.type).toBe(entry.type);
      expect(stored?.bytes.length).toBe(entry.size);
      // Rehashing is the byte-identical check: a single flipped byte anywhere
      // in the object gives a different name.
      expect(hashObject(stored!.type, stored!.bytes)).toBe(entry.oid);
    }
  });

  test(`a ${encoding} pack's deltas are kept with their bases`, async () => {
    const objects = store();
    await readPack(streamOf(fixture(file), { chunkSize: 4_096 }), objects);

    const deltas = (
      await Promise.all(
        manifest.map(async (entry) => ({
          oid: entry.oid,
          delta: await objects.readDelta(entry.oid),
        })),
      )
    ).filter((entry) => entry.delta !== null);

    // The fixture is packed with a window and a depth, so git really did send
    // deltas; if it stops doing so this assertion is the alarm.
    expect(deltas.length).toBeGreaterThan(3);

    for (const { delta } of deltas) {
      expect(delta?.bytes.length).toBeGreaterThan(0);
      expect(await objects.has(delta!.baseOid)).toBe(true);
    }
  });
}

test("an object larger than a chunk arrives split and reads back whole", async () => {
  const objects = store();
  await readPack(streamOf(fixture("real-git-ofs-delta.pack"), { chunkSize: 4_096 }), objects);

  const large = manifest.find((entry) => entry.size > CHUNK_BYTES);
  const row = await objects.describe(large!.oid);

  expect(row?.chunkCount).toBe(Math.ceil(large!.size / CHUNK_BYTES));
  expect(row!.chunkCount).toBeGreaterThan(1);
  expect(hashObject(row!.type, (await objects.read(large!.oid))!.bytes)).toBe(large!.oid);
});
