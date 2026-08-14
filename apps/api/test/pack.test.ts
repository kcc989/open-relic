import { afterEach, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

import { CHUNK_BYTES, ObjectStore } from "../src/object-store.ts";
import { MAX_OBJECT_BYTES, hashObject, type ObjectType } from "../src/object.ts";
import { PackError, readPack, type PackObject, type PackSummary } from "../src/pack.ts";
import {
  buildDelta,
  buildPack,
  concat,
  copyInstruction,
  insertInstruction,
  streamOf,
  type PackEntry,
} from "./support/pack.ts";
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

const oidOf = (type: ObjectType, bytes: Uint8Array): string => hashObject(type, bytes);

const packErrorCode = async (reading: Promise<PackSummary>): Promise<string> => {
  try {
    await reading;
  } catch (error) {
    expect(error).toBeInstanceOf(PackError);
    if (error instanceof PackError) {
      return error.code;
    }
    throw error;
  }

  throw new Error("The pack was accepted where it should have been rejected.");
};

/** Barely compressible, so a pack's size is about the size of its objects. */
const noisy = (length: number, seed: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = seed * 2_654_435_761;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    bytes[i] = (state >> 15) & 0xff;
  }
  return bytes;
};

test("reads whole objects and names them the way Git does", async () => {
  const objects = store();
  const contents = utf8("what a pack carries\n");
  const pack = buildPack([{ kind: "object", type: "blob", bytes: contents }]);

  expect(await readPack(streamOf(pack.bytes), objects)).toEqual({
    objectCount: 1,
  });
  expect((await objects.read(oidOf("blob", contents)))?.bytes).toEqual(contents);
});

test("captures each incoming entry's compressed representation", async () => {
  const contents = utf8("preserve this zlib stream\n");
  const pack = buildPack([{ kind: "object", type: "blob", bytes: contents }]);
  const written: PackObject[] = [];

  await readPack(streamOf(pack.bytes, { chunkSize: 7 }), {
    read: async () => null,
    write: async (object) => {
      written.push(object);
    },
  });

  expect(written).toHaveLength(1);
  expect(new Uint8Array(inflateSync(written[0]!.compressed!))).toEqual(Uint8Array.from(contents));
});

test("every object type keeps its type", async () => {
  const objects = store();
  const types: readonly ObjectType[] = ["commit", "tree", "blob", "tag"];
  const entries: PackEntry[] = types.map((type) => ({
    kind: "object",
    type,
    bytes: utf8(`a ${type}`),
  }));

  await readPack(streamOf(buildPack(entries).bytes), objects);

  for (const type of types) {
    const oid = oidOf(type, utf8(`a ${type}`));
    expect((await objects.describe(oid))?.type).toBe(type);
  }
});

test("an ofs-delta resolves against an earlier object in the pack", async () => {
  const objects = store();
  const base = utf8("a base object that a delta will edit");
  const delta = buildDelta(base.length, 41, [
    copyInstruction(0, 7),
    insertInstruction(utf8("brand new ")),
    copyInstruction(7, 24),
  ]);

  const pack = buildPack([
    { kind: "object", type: "blob", bytes: base },
    { kind: "ofs-delta", baseIndex: 0, delta },
  ]);

  await readPack(streamOf(pack.bytes), objects);

  const resolved = utf8("a base brand new object that a delta will");
  expect((await objects.read(oidOf("blob", resolved)))?.bytes).toEqual(resolved);
});

test("a nearby delta base is reused without reading it back from storage", async () => {
  const base = utf8("a recently resolved base");
  const baseOid = oidOf("blob", base);
  const resolved = utf8("a recently resolved result");
  const delta = buildDelta(base.length, resolved.length, [insertInstruction(resolved)]);
  const written = new Map<string, PackObject>();

  await readPack(
    streamOf(
      buildPack([
        { kind: "object", type: "blob", bytes: base },
        { kind: "ofs-delta", baseIndex: 0, delta },
      ]).bytes,
    ),
    {
      read: async (oid) => {
        if (oid === baseOid) {
          throw new Error("recent base was read back from storage");
        }
        const object = written.get(oid);
        return object === undefined ? null : { type: object.type, bytes: object.bytes };
      },
      write: async (object) => {
        written.set(object.oid, object);
      },
    },
  );

  expect(written.get(oidOf("blob", resolved))?.bytes).toEqual(resolved);
});

test("a ref-delta resolves against an object already in the repository", async () => {
  const objects = store();
  const base = utf8("a base that arrived in an earlier push");
  const baseOid = oidOf("blob", base);
  await objects.write({ oid: baseOid, type: "blob", bytes: base, delta: null });

  const delta = buildDelta(base.length, 6, [copyInstruction(0, 6)]);
  const pack = buildPack([{ kind: "ref-delta", baseOid, delta }]);

  await readPack(streamOf(pack.bytes), objects);

  expect((await objects.read(oidOf("blob", utf8("a base"))))?.bytes).toEqual(utf8("a base"));
});

test("a chain of deltas several deep resolves, each against the one before", async () => {
  const objects = store();
  const depth = 6;
  const base = utf8("0");
  const entries: PackEntry[] = [{ kind: "object", type: "blob", bytes: base }];

  let previous = base;
  const expected: Uint8Array[] = [base];

  for (let step = 1; step <= depth; step += 1) {
    const next = concat(previous, utf8(String(step)));
    entries.push({
      kind: "ofs-delta",
      baseIndex: step - 1,
      delta: buildDelta(previous.length, next.length, [
        copyInstruction(0, previous.length),
        insertInstruction(utf8(String(step))),
      ]),
    });
    expected.push(next);
    previous = next;
  }

  await readPack(streamOf(buildPack(entries).bytes), objects);

  for (const contents of expected) {
    expect((await objects.read(oidOf("blob", contents)))?.bytes).toEqual(contents);
  }
});

test("a delta keeps its raw bytes and its base hash", async () => {
  const objects = store();
  const base = utf8("the base of the delta");
  const delta = buildDelta(base.length, 8, [copyInstruction(0, 8)]);

  await readPack(
    streamOf(
      buildPack([
        { kind: "object", type: "blob", bytes: base },
        { kind: "ofs-delta", baseIndex: 0, delta },
      ]).bytes,
    ),
    objects,
  );

  expect(await objects.readDelta(oidOf("blob", utf8("the base")))).toEqual({
    baseOid: oidOf("blob", base),
    bytes: delta,
  });
});

test("an object spanning several chunks survives the round trip", async () => {
  const objects = store();
  const contents = noisy(CHUNK_BYTES + 4_096, 17);

  await readPack(
    streamOf(buildPack([{ kind: "object", type: "blob", bytes: contents }]).bytes, {
      chunkSize: 8_192,
    }),
    objects,
  );

  expect((await objects.read(oidOf("blob", contents)))?.bytes).toEqual(contents);
});

const OBJECT_BYTES = 20_000;
const STREAM_CHUNK_BYTES = 16 * 1_024;

interface Residency {
  readonly packBytes: number;
  /** The most pack bytes ever read but not yet turned into stored objects. */
  readonly peakInFlight: number;
  readonly stored: number;
}

/**
 * Reads a pack of `count` barely-compressible objects, watching how far the
 * reader runs ahead of what it has already stored. Bytes pulled past the start
 * of the next unwritten entry are, by definition, bytes the reader is still
 * holding.
 */
const measureResidency = async (count: number): Promise<Residency> => {
  const objects = store();
  const entries: PackEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      kind: "object",
      type: "blob",
      bytes: noisy(OBJECT_BYTES, index + 1),
    });
  }

  const pack = buildPack(entries);
  let stored = 0;
  let peakInFlight = 0;

  const watching = {
    read: objects.read.bind(objects),
    write: async (object: Parameters<ObjectStore["write"]>[0]) => {
      await objects.write(object);
      stored += 1;
    },
  };

  await readPack(
    streamOf(pack.bytes, {
      chunkSize: STREAM_CHUNK_BYTES,
      onPull: (pulled) => {
        const settled = pack.offsets[stored] ?? pack.bytes.length;
        peakInFlight = Math.max(peakInFlight, pulled - settled);
      },
    }),
    watching,
  );

  return { packBytes: pack.bytes.length, peakInFlight, stored };
};

test("memory does not scale with the pack — the same pack four times over holds no more", async () => {
  const small = await measureResidency(50);
  const large = await measureResidency(200);

  expect(small.stored).toBe(50);
  expect(large.stored).toBe(200);
  expect(large.packBytes).toBeGreaterThan(small.packBytes * 3);

  // One object, plus the chunk it arrived in, plus the slack of a stream that
  // reads one chunk ahead. A reader that buffered the pack would grow with it.
  const bound = OBJECT_BYTES + STREAM_CHUNK_BYTES * 2;
  expect(small.peakInFlight).toBeLessThan(bound);
  expect(large.peakInFlight).toBeLessThan(bound);
});

test("bytes that are not a pack are rejected", async () => {
  const notAPack = concat(utf8("NOPE"), new Uint8Array(28));

  expect(await packErrorCode(readPack(streamOf(notAPack), store()))).toBe("not-a-pack");
});

test("a pack version we do not speak is rejected", async () => {
  const pack = buildPack([{ kind: "object", type: "blob", bytes: utf8("x") }], {
    version: 4,
  });

  expect(await packErrorCode(readPack(streamOf(pack.bytes), store()))).toBe("unsupported-version");
});

test("a truncated pack is rejected as truncated", async () => {
  const pack = buildPack([{ kind: "object", type: "blob", bytes: noisy(4_000, 5) }]);

  expect(
    await packErrorCode(readPack(streamOf(pack.bytes.slice(0, pack.bytes.length - 40)), store())),
  ).toBe("truncated");
});

test("a pack claiming more objects than it carries is rejected as truncated", async () => {
  const pack = buildPack([{ kind: "object", type: "blob", bytes: utf8("one") }], {
    declaredCount: 2,
  });

  expect(await packErrorCode(readPack(streamOf(pack.bytes), store()))).toBe("truncated");
});

test("a bad trailing checksum is rejected as a checksum mismatch", async () => {
  const pack = buildPack([{ kind: "object", type: "blob", bytes: utf8("two") }]);
  pack.bytes[pack.bytes.length - 1] = pack.bytes[pack.bytes.length - 1]! ^ 0xff;

  expect(await packErrorCode(readPack(streamOf(pack.bytes), store()))).toBe("checksum-mismatch");
});

test("bytes past the trailer are rejected", async () => {
  const pack = buildPack([{ kind: "object", type: "blob", bytes: utf8("three") }]);

  expect(await packErrorCode(readPack(streamOf(concat(pack.bytes, utf8("extra"))), store()))).toBe(
    "trailing-bytes",
  );
});

test("a thin ref-delta whose base is absent from the repository is rejected", async () => {
  const pack = buildPack([
    {
      kind: "ref-delta",
      baseOid: "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31",
      delta: buildDelta(4, 4, [insertInstruction(utf8("nope"))]),
    },
  ]);

  expect(await packErrorCode(readPack(streamOf(pack.bytes), store()))).toBe("missing-base");
});

test("an ofs-delta pointing where no object began is rejected", async () => {
  const base = utf8("a base");
  const pack = buildPack([
    { kind: "object", type: "blob", bytes: base },
    {
      kind: "ofs-delta",
      baseIndex: 0,
      delta: buildDelta(base.length, 1, [copyInstruction(0, 1)]),
    },
  ]);

  // Nudge the back-reference so it lands one byte inside the base's entry.
  const deltaHeaderAt = pack.offsets[1]! + 1;
  pack.bytes[deltaHeaderAt] = pack.bytes[deltaHeaderAt]! - 1;

  expect(await packErrorCode(readPack(streamOf(pack.bytes), store()))).toBe("missing-base");
});

test("an entry declaring more than we will hold is rejected before it is held", async () => {
  const pack = buildPack([
    {
      kind: "object",
      type: "blob",
      bytes: utf8("a few bytes"),
      // A pack of a few hundred bytes asking for 300 MB of buffer. The reader
      // has to refuse on the header; refusing after allocating is the runtime
      // killing the Durable Object, not an answer we can give the client.
      declaredSize: 300 * 1_024 * 1_024,
    },
  ]);

  expect(pack.bytes.length).toBeLessThan(1_024);
  // Reaching this code rather than a size mismatch is what says the buffer was
  // never allocated: nothing downstream of the header check ran.
  expect(await packErrorCode(readPack(streamOf(pack.bytes), store()))).toBe("object-too-large");
});

test("a delta declaring a result larger than we will hold is rejected", async () => {
  const base = utf8("a small base");
  const pack = buildPack([
    { kind: "object", type: "blob", bytes: base },
    {
      kind: "ofs-delta",
      baseIndex: 0,
      delta: buildDelta(base.length, MAX_OBJECT_BYTES + 1, [copyInstruction(0, base.length)]),
    },
  ]);

  expect(await packErrorCode(readPack(streamOf(pack.bytes), store()))).toBe("object-too-large");
});

test("a corrupt object stream is rejected", async () => {
  const pack = buildPack([{ kind: "object", type: "blob", bytes: noisy(5_000, 9) }]);
  // Deep enough into the deflate stream to break the data rather than the
  // header, so the failure is the zlib checksum rather than a bad magic byte.
  pack.bytes[200] = pack.bytes[200]! ^ 0xff;

  expect(await packErrorCode(readPack(streamOf(pack.bytes), store()))).toBe("corrupt");
});
