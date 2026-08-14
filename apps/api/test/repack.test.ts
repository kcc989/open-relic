import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { objectDeltas, objects as objectRows } from "../src/db/repository-schema.ts";
import { applyDelta } from "../src/delta.ts";
import { ObjectStore } from "../src/object-store.ts";
import {
  REPACK_DELTA_MEMORY_BUDGET_BYTES,
  RepositoryRepacker,
  buildRepackDelta,
  estimateRepackDeltaMemory,
} from "../src/repack.ts";
import { RepositoryStore } from "../src/repository-store.ts";
import { hashObject } from "../src/object.ts";
import {
  createTestRepositoryStorage,
  seedRefs,
  type TestRepositoryStorage,
} from "./support/database.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

let opened: TestRepositoryStorage | undefined;

afterEach(() => {
  opened?.close();
  opened = undefined;
});

test("the bounded repack delta reproduces changed prefixes, middles, suffixes, and empty values", () => {
  for (const [base, target] of [
    ["shared prefix / old middle / shared suffix", "shared prefix / new middle / shared suffix"],
    ["abcdef", "abc"],
    ["abc", "abcdef"],
    ["", ""],
    ["old", "new"],
  ] as const) {
    const baseBytes = utf8(base);
    const targetBytes = utf8(target);
    expect(applyDelta(baseBytes, buildRepackDelta(baseBytes, targetBytes))).toEqual(targetBytes);
  }
});

test("rejects a 32 MiB delta pair before constructing its over-budget working set", () => {
  const objectSize = 32 * 1_024 * 1_024;

  expect(estimateRepackDeltaMemory(objectSize, objectSize)).toBeGreaterThan(
    REPACK_DELTA_MEMORY_BUDGET_BYTES,
  );
  expect(estimateRepackDeltaMemory(1_024, 1_024)).toBeLessThan(REPACK_DELTA_MEMORY_BUDGET_BYTES);
});

test("skips an over-budget pair before reading either resolved object", async () => {
  opened = createTestRepositoryStorage();
  const repository = new RepositoryStore(opened.db, opened.kv);
  await repository.initialize({ defaultBranch: "main", createdAt: "2026-08-13T00:00:00.000Z" });
  const oids = ["1".repeat(40), "2".repeat(40)];
  for (const oid of oids) {
    await opened.db.insert(objectRows).values({
      oid,
      type: "blob",
      size: 32 * 1_024 * 1_024,
      chunkCount: 22,
      compressedSize: 1,
      compressedChunkCount: 1,
      linksIndexed: true,
      complete: true,
    });
    // Repack needs only this metadata's size. The deliberately absent `o:`
    // chunks make the test fail if it loads either resolved candidate.
    opened.kv.put(`z:${oid}:0`, Uint8Array.of(0));
  }
  await seedRefs(opened.db, { "refs/heads/one": oids[0]!, "refs/heads/two": oids[1]! });
  for (;;) {
    if ((await repository.sweep(8)).phase === "complete") {
      break;
    }
  }

  await expect(
    new RepositoryRepacker(opened.db, new ObjectStore(opened.db, opened.kv)).step(8),
  ).resolves.toMatchObject({ phase: "complete", selectedDeltas: 0 });
});

test("background repacking selects a useful delta from the completed reachability index", async () => {
  opened = createTestRepositoryStorage();
  const repository = new RepositoryStore(opened.db, opened.kv);
  const objects = new ObjectStore(opened.db, opened.kv);
  await repository.initialize({ defaultBranch: "main", createdAt: "2026-08-13T00:00:00.000Z" });

  const prefix = "stable firmware contents\n".repeat(2_048);
  const values = [utf8(`${prefix}release one\n`), utf8(`${prefix}release two\n`)];
  const written = values.map((bytes) => ({
    oid: hashObject("blob", bytes),
    type: "blob" as const,
    bytes,
    delta: null,
  }));
  for (const object of written) {
    await objects.write(object);
  }
  await seedRefs(opened.db, {
    "refs/heads/one": written[0]!.oid,
    "refs/heads/two": written[1]!.oid,
  });

  for (;;) {
    const sweep = await repository.sweep(1);
    if (sweep.phase === "complete") {
      break;
    }
  }

  const repacker = new RepositoryRepacker(opened.db, objects);
  for (;;) {
    const progress = await repacker.step(1);
    if (progress.phase === "complete") {
      break;
    }
  }

  const deltas = await Promise.all(written.map((object) => objects.readDelta(object.oid)));
  const selected = deltas.find((delta) => delta !== null);
  expect(selected).not.toBeNull();
  const targetAt = deltas.findIndex((delta) => delta !== null);
  const base = await objects.read(selected!.baseOid);
  expect(base).not.toBeNull();
  expect(applyDelta(base!.bytes, selected!.bytes)).toEqual(written[targetAt]!.bytes);
  expect(
    (await objects.readDeltaPackEntry(written[targetAt]!.oid))!.compressed.length,
  ).toBeLessThan((await objects.readFullPackEntry(written[targetAt]!.oid))!.compressed.length);
});

test("background repacking backfills full and Delta compression deferred by bounded ingest", async () => {
  opened = createTestRepositoryStorage();
  const repository = new RepositoryStore(opened.db, opened.kv);
  const objects = new ObjectStore(opened.db, opened.kv);
  await repository.initialize({ defaultBranch: "main", createdAt: "2026-08-13T00:00:00.000Z" });
  const baseBytes = utf8("a".repeat(8_192));
  const targetBytes = utf8(`${"a".repeat(8_000)}changed`);
  const baseOid = hashObject("blob", baseBytes);
  const targetOid = hashObject("blob", targetBytes);
  await objects.write({ oid: baseOid, type: "blob", bytes: baseBytes, delta: null });
  await objects.write({
    oid: targetOid,
    type: "blob",
    bytes: targetBytes,
    delta: { baseOid, bytes: buildRepackDelta(baseBytes, targetBytes) },
  });
  await seedRefs(opened.db, { "refs/heads/base": baseOid, "refs/heads/target": targetOid });
  expect(
    (
      await opened.db
        .select({ compressedSize: objectRows.compressedSize })
        .from(objectRows)
        .where(eq(objectRows.oid, targetOid))
    )[0]?.compressedSize,
  ).toBeNull();
  expect(
    (
      await opened.db
        .select({ compressedSize: objectDeltas.compressedSize })
        .from(objectDeltas)
        .where(eq(objectDeltas.oid, targetOid))
    )[0]?.compressedSize,
  ).toBeNull();

  for (;;) {
    if ((await repository.sweep(1)).phase === "complete") {
      break;
    }
  }
  const repacker = new RepositoryRepacker(opened.db, objects);
  for (;;) {
    if ((await repacker.step(1)).phase === "complete") {
      break;
    }
  }

  const [objectAfter] = await opened.db
    .select({ compressedSize: objectRows.compressedSize })
    .from(objectRows)
    .where(eq(objectRows.oid, targetOid));
  const [deltaAfter] = await opened.db
    .select({ compressedSize: objectDeltas.compressedSize })
    .from(objectDeltas)
    .where(eq(objectDeltas.oid, targetOid));
  expect(objectAfter?.compressedSize).toBeGreaterThan(0);
  expect(deltaAfter?.compressedSize).toBeGreaterThan(0);
});
