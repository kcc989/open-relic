import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { deflateSync } from "node:zlib";

import { findMissingObject } from "../src/connectivity.ts";
import { objects as objectRows } from "../src/db/repository-schema.ts";
import { flushPkt, pktLine } from "../src/git/pkt-line.ts";
import { PACK_PREFETCH_BYTES, uploadPackResultStream } from "../src/git/upload-pack.ts";
import { ObjectStore, type PackRepresentationMetadata } from "../src/object-store.ts";
import {
  PACK_WRITE_BATCH_COUNT,
  createPackTimings,
  readPack,
  type PackObject,
} from "../src/pack.ts";
import { createTestRepositoryStorage } from "./support/database.ts";
import { blob, commit, tree, treeEntry } from "./support/git-objects.ts";
import { buildDelta, buildPack, concat, insertInstruction, streamOf } from "./support/pack.ts";

const handles: Array<() => void> = [];
afterEach(() => {
  for (const close of handles.splice(0)) close();
});
const storage = () => {
  const opened = createTestRepositoryStorage();
  handles.push(opened.close);
  return opened;
};

test("parser publishes bounded batches and resolves a delta across the batch boundary", async () => {
  const { db, kv } = storage();
  const store = new ObjectStore(db, kv);
  const leaves = Array.from({ length: PACK_WRITE_BATCH_COUNT + 1 }, (_, i) => blob(`base ${i}`));
  const target = blob("result");
  const delta = buildDelta(leaves[0]!.bytes.length, target.bytes.length, [
    insertInstruction(target.bytes),
  ]);
  const pack = buildPack([
    ...leaves.map((leaf) => ({ kind: "object" as const, ...leaf })),
    { kind: "ref-delta", baseOid: leaves[0]!.oid, delta },
  ]);
  const batches: number[] = [];
  await readPack(streamOf(pack.bytes, { chunkSize: 7 }), {
    read: (oid) => store.read(oid),
    write: () => {
      throw new Error("The batch writer must be used.");
    },
    writeBatch: async (batch, timings) => {
      batches.push(batch.length);
      await store.writeBatch(batch, timings);
    },
  });
  expect(batches).toEqual([PACK_WRITE_BATCH_COUNT, 2]);
  expect((await store.read(target.oid))?.bytes).toEqual(target.bytes);
});

test("parser propagates a failed batch without retrying it", async () => {
  const leaves = Array.from({ length: PACK_WRITE_BATCH_COUNT + 1 }, (_, i) => blob(`object ${i}`));
  let batches = 0;
  await expect(
    readPack(streamOf(buildPack(leaves.map((leaf) => ({ kind: "object", ...leaf }))).bytes), {
      read: async () => null,
      write: async () => {},
      writeBatch: async () => {
        batches += 1;
        throw new Error("storage failed");
      },
    }),
  ).rejects.toThrow("storage failed");
  expect(batches).toBe(1);
});

for (const chunkSize of [7, 65_536]) {
  test(`native and split-stream inflation preserve entry boundaries with ${chunkSize}-byte chunks`, async () => {
    const leaves = [blob("source contents\n".repeat(500)), blob("next entry\n".repeat(150))];
    const stored: PackObject[] = [];
    await readPack(
      streamOf(buildPack(leaves.map((leaf) => ({ kind: "object", ...leaf }))).bytes, { chunkSize }),
      {
        read: async () => null,
        write: async (object) => {
          stored.push(object);
        },
      },
    );
    expect(stored.map((object) => object.oid)).toEqual(leaves.map((object) => object.oid));
    expect(stored.map((object) => Array.from(object.bytes))).toEqual(
      leaves.map((object) => Array.from(object.bytes)),
    );
  });
}

test("native inflation does not accept a false declared size", async () => {
  const leaf = blob("compressible data\n".repeat(500));
  for (const declaredSize of [2_000, leaf.bytes.length + 1]) {
    const pack = buildPack([{ kind: "object", ...leaf, declaredSize }]);
    await expect(
      readPack(streamOf(pack.bytes), { read: async () => null, write: async () => {} }),
    ).rejects.toThrow();
  }
});

test("native inflation consumes exactly one buffered entry", async () => {
  let state = 12345;
  const padding = Uint8Array.from({ length: 16_384 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 255;
  });
  const first = blob("native buffer\n".repeat(200));
  const pack = buildPack([
    { kind: "object", ...first },
    { kind: "object", type: "blob", bytes: padding },
  ]);
  const timings = createPackTimings();
  const output: PackObject[] = [];
  await readPack(
    streamOf(pack.bytes),
    {
      read: async () => null,
      write: async (object) => {
        output.push(object);
      },
    },
    timings,
  );
  expect(timings.nativeInflates).toBeGreaterThan(0);
  expect(output[0]!.oid).toBe(first.oid);
  expect(output[1]!.bytes).toEqual(padding);
});

test("indexed connectivity avoids raw reads and falls back for old objects", async () => {
  const { db, kv } = storage();
  const store = new ObjectStore(db, kv);
  const root = tree([]);
  const tip = commit({ tree: root });
  for (const object of [root, tip]) await store.write({ ...object, delta: null });
  const reads: string[] = [];
  const source = {
    read: async (oid: string) => {
      reads.push(oid);
      return store.read(oid);
    },
    readIndexedObjects: (oids: readonly string[]) => store.readIndexedObjects(oids),
  };
  const walk = () =>
    findMissingObject(tip.oid, source, { verified: new Set(), visited: new Set() });
  expect(await walk()).toBeNull();
  expect(reads).toEqual([]);
  await db.update(objectRows).set({ linksIndexed: false }).where(eq(objectRows.oid, tip.oid));
  expect(await walk()).toBeNull();
  expect(reads).toEqual([tip.oid]);
});

test("a failed connectivity walk cannot validate another command", async () => {
  const { db, kv } = storage();
  const store = new ObjectStore(db, kv);
  const missing = tree([]);
  const tip = commit({ tree: missing });
  await store.write({ ...tip, delta: null });
  const walk = { verified: new Set<string>(), visited: new Set<string>() };
  expect(await findMissingObject(tip.oid, store, walk)).toBe(missing.oid);
  expect(await findMissingObject(tip.oid, store, walk)).toBe(missing.oid);
  expect(walk.visited.size).toBe(0);
});

for (const indexed of [true, false]) {
  test(`incremental fetch omits unchanged trees and files with indexed source ${indexed}`, async () => {
    const { db, kv } = storage();
    const store = new ObjectStore(db, kv);
    const leaves = Array.from({ length: 100 }, (_, i) => blob(`file ${i}`));
    const root = tree(leaves.map((leaf, i) => treeEntry(`file-${i}`, leaf)));
    const first = commit({ tree: root, message: "First" });
    const second = commit({ tree: root, parents: [first], message: "Empty commit" });
    for (const object of [...leaves, root, first, second])
      await store.write({ ...object, delta: null });
    const source = indexed
      ? store
      : {
          has: (oid: string) => store.has(oid),
          read: (oid: string) => store.read(oid),
          readDeltaBase: (oid: string) => store.readDeltaBase(oid),
          readDelta: (oid: string) => store.readDelta(oid),
        };
    const request = concat(
      pktLine(`want ${second.oid}\n`),
      flushPkt(),
      pktLine(`have ${first.oid}\n`),
      pktLine("done\n"),
    );
    const bytes = new Uint8Array(
      await new Response(
        uploadPackResultStream(streamOf(request), source, new Set([second.oid])),
      ).arrayBuffer(),
    );
    const prefixLength = Number.parseInt(new TextDecoder().decode(bytes.subarray(0, 4)), 16);
    const received: string[] = [];
    await readPack(streamOf(bytes.subarray(prefixLength)), {
      read: (oid) => store.read(oid),
      write: async (object) => {
        received.push(object.oid);
      },
    });
    expect(received).toEqual([second.oid]);
  });
}

for (const [size, initialReads] of [
  [6 * 1024 * 1024, 2],
  [PACK_PREFETCH_BYTES + 1, 1],
] as const) {
  test(`prefetch reserves active and queued entries of ${size} bytes`, async () => {
    const leaves = [blob("first"), blob("second"), blob("third")];
    const compressed = new Map(
      leaves.map((leaf) => [leaf.oid, new Uint8Array(deflateSync(leaf.bytes))]),
    );
    // Account for large representations without allocating their bytes in this scheduling test.
    const metadata = new Map<string, PackRepresentationMetadata>(
      leaves.map((leaf) => [
        leaf.oid,
        {
          oid: leaf.oid,
          type: leaf.type,
          size: leaf.bytes.length,
          full: { size, chunkCount: 16 },
          delta: null,
        },
      ]),
    );
    const reads: string[][] = [];
    const request = concat(
      ...leaves.map((leaf) => pktLine(`want ${leaf.oid}\n`)),
      flushPkt(),
      pktLine("done\n"),
    );
    const response = uploadPackResultStream(
      streamOf(request),
      {
        has: async () => true,
        read: async () => null,
        readDeltaBase: async () => null,
        readDelta: async () => null,
        readObjectClosure: async () => leaves.map((leaf) => leaf.oid),
        readPackMetadata: async () => metadata,
        readCachedPackEntries: async (requests) => {
          reads.push(requests.map(({ metadata }) => metadata.oid));
          return new Map(
            requests.map(({ metadata }) => [
              metadata.oid,
              {
                kind: "full" as const,
                type: metadata.type,
                size: metadata.size,
                compressed: compressed.get(metadata.oid)!,
              },
            ]),
          );
        },
      },
      new Set(leaves.map((leaf) => leaf.oid)),
    );
    const reader = response.getReader();
    await reader.read(); // ACK/NAK
    await reader.read(); // pack header
    await reader.read(); // first entry header
    expect(reads).toEqual(leaves.slice(0, initialReads).map((leaf) => [leaf.oid]));
    while (!(await reader.read()).done) {
      /* Drain and check that every entry eventually arrives. */
    }
    expect(reads).toEqual(leaves.map((leaf) => [leaf.oid]));
  });
}
