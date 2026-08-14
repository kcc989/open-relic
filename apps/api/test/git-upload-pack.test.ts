import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { flushPkt, pktLine } from "../src/git/pkt-line.ts";
import { uploadPackResultStream } from "../src/git/upload-pack.ts";
import { readPack, type PackBase, type PackObject } from "../src/pack.ts";
import { createGitTestApp, type TestApp } from "./support/app.ts";
import { blob, commit, tag, tree, treeEntry } from "./support/git-objects.ts";
import { buildDelta, buildPack, concat, insertInstruction, streamOf } from "./support/pack.ts";
import { pushBody } from "./support/receive-pack.ts";

const README = blob("Anvil firmware\n");
const ROOT = tree([treeEntry("README.md", README)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const V1 = tag({ target: FIRST, name: "v1" });

const REVISED = blob("Anvil firmware, revised\n");
const SECOND_ROOT = tree([treeEntry("README.md", REVISED)]);
const SECOND = commit({ tree: SECOND_ROOT, parents: [FIRST], message: "Second" });
const DELTA_BASE = blob("Shared firmware base\n");
const DELTA_RESULT = blob("Shared firmware result\n");
const DELTA_ROOT = tree([
  treeEntry("a-base.txt", DELTA_BASE),
  treeEntry("b-result.txt", DELTA_RESULT),
]);
const DELTA_COMMIT = commit({ tree: DELTA_ROOT, parents: [FIRST], message: "Delta ordering" });
const REJECTED = commit({ tree: ROOT, message: "Rejected" });

const MAIN = "refs/heads/main";
const UPLOAD = "http://local.test/git/acme/demo.git/git-upload-pack";

let harness: TestApp;

const post = (path: string, body: Uint8Array<ArrayBuffer>) =>
  harness.app.request(
    new Request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.repositoryToken}`,
        "Content-Type": "application/x-git-upload-pack-request",
      },
      body,
    }),
  );

beforeEach(async () => {
  harness = await createGitTestApp();
  await harness.app.request(
    new Request("http://local.test/git/acme/demo.git/git-receive-pack", {
      method: "POST",
      headers: { Authorization: `Bearer ${harness.repositoryToken}` },
      body: pushBody({
        commands: [
          { newOid: FIRST.oid, name: MAIN },
          { newOid: V1.oid, name: "refs/tags/v1" },
        ],
        objects: [FIRST, ROOT, README, V1],
      }),
    }),
  );
});

afterEach(() => {
  harness.close();
});

const packetPayloads = (bytes: Uint8Array): readonly Uint8Array[] => {
  const payloads: Uint8Array[] = [];
  let at = 0;

  while (at < bytes.length) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(at, at + 4)), 16);
    at += 4;
    if (length === 0) {
      continue;
    }
    payloads.push(bytes.subarray(at, at + length - 4));
    at += length - 4;
  }

  return payloads;
};

const packFromSideband = (bytes: Uint8Array): Uint8Array => {
  const [, ...banded] = packetPayloads(bytes);
  return concat(...banded.map((payload) => payload.subarray(1)));
};

describe("POST /git/:namespace/:repo.git/git-upload-pack", () => {
  test("advertises an annotated tag followed immediately by its peeled target", async () => {
    const response = await harness.app.request(
      "http://local.test/git/acme/demo.git/info/refs?service=git-upload-pack",
      { headers: { Authorization: `Bearer ${harness.repositoryToken}` } },
    );
    const body = await response.text();

    expect(body).toContain(`${V1.oid} refs/tags/v1\n`);
    expect(body).toContain(`${FIRST.oid} refs/tags/v1^{}\n`);
    expect(body.indexOf(`${V1.oid} refs/tags/v1\n`)).toBeLessThan(
      body.indexOf(`${FIRST.oid} refs/tags/v1^{}\n`),
    );
  });

  test("refuses an object left by a rejected push when no advertised ref names it", async () => {
    await harness.app.request(
      new Request("http://local.test/git/acme/demo.git/git-receive-pack", {
        method: "POST",
        headers: { Authorization: `Bearer ${harness.repositoryToken}` },
        body: pushBody({
          // The stale old value rejects the command after the pack has already
          // streamed into storage, leaving REJECTED as an orphan.
          commands: [{ oldOid: SECOND.oid, newOid: REJECTED.oid, name: MAIN }],
          objects: [REJECTED],
        }),
      }),
    );

    const request = concat(pktLine(`want ${REJECTED.oid}\n`), flushPkt(), pktLine("done\n"));
    const response = await post(UPLOAD, request);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const firstLength = Number.parseInt(new TextDecoder().decode(bytes.subarray(0, 4)), 16);

    expect(new TextDecoder().decode(bytes.subarray(4, firstLength))).toBe(
      `ERR upload-pack: not our ref ${REJECTED.oid}\n`,
    );
    expect(bytes.length).toBe(firstLength);
  });

  test("starts the response before reading pack entries and then reads them one at a time", async () => {
    const objects = new Map(
      [FIRST, ROOT, README].map((object) => [
        object.oid,
        { type: object.type, bytes: object.bytes },
      ]),
    );
    const reads = new Map<string, number>();
    const request = concat(pktLine(`want ${FIRST.oid}\n`), flushPkt(), pktLine("done\n"));
    const response = uploadPackResultStream(
      streamOf(request),
      {
        has: async (oid) => objects.has(oid),
        read: async (oid) => {
          reads.set(oid, (reads.get(oid) ?? 0) + 1);
          return objects.get(oid) ?? null;
        },
        readDeltaBase: async () => null,
        readDelta: async () => null,
      },
      new Set([FIRST.oid]),
    );
    const reader = response.getReader();

    expect(reads.size).toBe(0);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("0008NAK\n");
    expect(reads).toEqual(
      new Map([
        [FIRST.oid, 1],
        [ROOT.oid, 1],
      ]),
    );

    const header = (await reader.read()).value!;
    expect(new TextDecoder().decode(header.subarray(0, 4))).toBe("PACK");
    expect(reads).toEqual(
      new Map([
        [FIRST.oid, 1],
        [ROOT.oid, 1],
      ]),
    );

    await reader.read();
    expect(reads).toEqual(
      new Map([
        [FIRST.oid, 2],
        [ROOT.oid, 1],
      ]),
    );
    await reader.cancel();
  });

  test("stops the wanted walk when it reaches the client's known closure", async () => {
    const objects = new Map(
      [FIRST, ROOT, README, SECOND, SECOND_ROOT, REVISED].map((object) => [
        object.oid,
        { type: object.type, bytes: object.bytes },
      ]),
    );
    const reads = new Map<string, number>();
    const request = concat(
      pktLine(`want ${SECOND.oid}\n`),
      flushPkt(),
      pktLine(`have ${FIRST.oid}\n`),
      pktLine("done\n"),
    );

    await new Response(
      uploadPackResultStream(
        streamOf(request),
        {
          has: async (oid) => objects.has(oid),
          read: async (oid) => {
            reads.set(oid, (reads.get(oid) ?? 0) + 1);
            return objects.get(oid) ?? null;
          },
          readDeltaBase: async () => null,
          readDelta: async () => null,
        },
        new Set([SECOND.oid]),
      ),
    ).arrayBuffer();

    expect(reads.get(FIRST.oid)).toBe(1);
    expect(reads.get(ROOT.oid)).toBe(1);
    expect(reads.get(README.oid)).toBeUndefined();
  });

  test("checks linked blobs for existence without reading their bytes during planning", async () => {
    const objects = new Map(
      [FIRST, ROOT, README].map((object) => [
        object.oid,
        { type: object.type, bytes: object.bytes },
      ]),
    );
    const reads = new Map<string, number>();
    const checks = new Map<string, number>();
    const request = concat(pktLine(`want ${FIRST.oid}\n`), flushPkt(), pktLine("done\n"));

    await new Response(
      uploadPackResultStream(
        streamOf(request),
        {
          has: async (oid) => {
            checks.set(oid, (checks.get(oid) ?? 0) + 1);
            return objects.has(oid);
          },
          read: async (oid) => {
            reads.set(oid, (reads.get(oid) ?? 0) + 1);
            return objects.get(oid) ?? null;
          },
          readDeltaBase: async () => null,
          readDelta: async () => null,
        },
        new Set([FIRST.oid]),
      ),
    ).arrayBuffer();

    expect(checks.get(README.oid)).toBe(1);
    expect(reads.get(README.oid)).toBe(1);
  });

  test("negotiates a coalesced side-band fetch over two stateless POST rounds", async () => {
    await harness.app.request(
      new Request("http://local.test/git/acme/demo.git/git-receive-pack", {
        method: "POST",
        headers: { Authorization: `Bearer ${harness.repositoryToken}` },
        body: pushBody({
          commands: [{ oldOid: FIRST.oid, newOid: SECOND.oid, name: MAIN }],
          objects: [SECOND, SECOND_ROOT, REVISED],
        }),
      }),
    );

    const capabilities = "multi_ack_detailed thin-pack side-band-64k ofs-delta";
    const negotiate = concat(
      pktLine(`want ${SECOND.oid} ${capabilities}\n`),
      flushPkt(),
      pktLine(`have ${FIRST.oid}\n`),
      flushPkt(),
    );
    const negotiationResponse = new Uint8Array(await (await post(UPLOAD, negotiate)).arrayBuffer());

    expect(
      packetPayloads(negotiationResponse).map((payload) => new TextDecoder().decode(payload)),
    ).toEqual([`ACK ${FIRST.oid} common\n`, "NAK\n"]);

    const done = concat(
      pktLine(`want ${SECOND.oid} ${capabilities}\n`),
      flushPkt(),
      pktLine(`have ${FIRST.oid}\n`),
      pktLine("done\n"),
    );
    const doneResponse = new Uint8Array(await (await post(UPLOAD, done)).arrayBuffer());
    const [acknowledgement, ...bandedPack] = packetPayloads(doneResponse);

    expect(new TextDecoder().decode(acknowledgement)).toBe(`ACK ${FIRST.oid}\n`);
    expect(bandedPack.length).toBeGreaterThan(0);
    expect(bandedPack.every((payload) => payload[0] === 1)).toBe(true);
    expect(
      new TextDecoder().decode(
        concat(...bandedPack.map((payload) => payload.subarray(1))).subarray(0, 4),
      ),
    ).toBe("PACK");
  });

  test("sends only the new closure and reuses a persisted delta against the client's base", async () => {
    const delta = buildDelta(README.bytes.length, REVISED.bytes.length, [
      insertInstruction(REVISED.bytes),
    ]);
    const secondPack = buildPack([
      { kind: "object", type: SECOND.type, bytes: SECOND.bytes },
      { kind: "object", type: SECOND_ROOT.type, bytes: SECOND_ROOT.bytes },
      { kind: "ref-delta", baseOid: README.oid, delta },
    ]).bytes;

    await harness.app.request(
      new Request("http://local.test/git/acme/demo.git/git-receive-pack", {
        method: "POST",
        headers: { Authorization: `Bearer ${harness.repositoryToken}` },
        body: pushBody({
          commands: [{ oldOid: FIRST.oid, newOid: SECOND.oid, name: MAIN }],
          pack: secondPack,
        }),
      }),
    );

    const request = concat(
      pktLine(`want ${SECOND.oid} thin-pack side-band-64k ofs-delta\n`),
      flushPkt(),
      pktLine(`have ${FIRST.oid}\n`),
      pktLine("done\n"),
    );
    const response = await post(UPLOAD, request);
    const pack = packFromSideband(new Uint8Array(await response.arrayBuffer()));

    const held = new Map<string, PackBase>(
      [FIRST, ROOT, README].map((object) => [
        object.oid,
        { type: object.type, bytes: object.bytes },
      ]),
    );
    const received: PackObject[] = [];
    const summary = await readPack(streamOf(pack), {
      read: async (oid) => held.get(oid) ?? null,
      write: async (object) => {
        received.push(object);
        held.set(object.oid, { type: object.type, bytes: object.bytes });
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    expect(summary.objectCount).toBe(3);
    expect(new Set(received.map((object) => object.oid))).toEqual(
      new Set([SECOND.oid, SECOND_ROOT.oid, REVISED.oid]),
    );
    expect(received.find((object) => object.oid === REVISED.oid)?.delta).toEqual({
      baseOid: README.oid,
      bytes: delta,
    });
  });

  test("orders a fresh clone's persisted delta after its base without making a thin pack", async () => {
    const delta = buildDelta(DELTA_BASE.bytes.length, DELTA_RESULT.bytes.length, [
      insertInstruction(DELTA_RESULT.bytes),
    ]);
    const pushed = buildPack([
      { kind: "object", type: DELTA_COMMIT.type, bytes: DELTA_COMMIT.bytes },
      { kind: "object", type: DELTA_ROOT.type, bytes: DELTA_ROOT.bytes },
      { kind: "object", type: DELTA_BASE.type, bytes: DELTA_BASE.bytes },
      { kind: "ref-delta", baseOid: DELTA_BASE.oid, delta },
    ]).bytes;

    const pushResponse = await harness.app.request(
      new Request("http://local.test/git/acme/demo.git/git-receive-pack", {
        method: "POST",
        headers: { Authorization: `Bearer ${harness.repositoryToken}` },
        body: pushBody({
          commands: [{ oldOid: FIRST.oid, newOid: DELTA_COMMIT.oid, name: MAIN }],
          pack: pushed,
        }),
      }),
    );
    expect(pushResponse.status).toBe(200);

    const request = concat(
      pktLine(`want ${DELTA_COMMIT.oid} side-band-64k ofs-delta\n`),
      flushPkt(),
      pktLine("done\n"),
    );
    const response = await post(UPLOAD, request);
    const pack = packFromSideband(new Uint8Array(await response.arrayBuffer()));
    const held = new Map<string, PackBase>();
    const received: PackObject[] = [];

    await readPack(streamOf(pack), {
      read: async (oid) => held.get(oid) ?? null,
      write: async (object) => {
        received.push(object);
        held.set(object.oid, { type: object.type, bytes: object.bytes });
      },
    });

    expect(received.findIndex((object) => object.oid === DELTA_BASE.oid)).toBeLessThan(
      received.findIndex((object) => object.oid === DELTA_RESULT.oid),
    );
    expect(received.find((object) => object.oid === DELTA_RESULT.oid)?.delta).toEqual({
      baseOid: DELTA_BASE.oid,
      bytes: delta,
    });
  });

  test("does not read a resolved object when its persisted delta can be sent", async () => {
    const delta = buildDelta(DELTA_BASE.bytes.length, DELTA_RESULT.bytes.length, [
      insertInstruction(DELTA_RESULT.bytes),
    ]);
    const objects = new Map(
      [DELTA_COMMIT, DELTA_ROOT, DELTA_BASE, DELTA_RESULT, FIRST, ROOT, README].map((object) => [
        object.oid,
        { type: object.type, bytes: object.bytes },
      ]),
    );
    const reads = new Map<string, number>();
    const request = concat(
      pktLine(`want ${DELTA_COMMIT.oid} side-band-64k ofs-delta\n`),
      flushPkt(),
      pktLine("done\n"),
    );
    const response = uploadPackResultStream(
      streamOf(request),
      {
        has: async (oid) => objects.has(oid),
        read: async (oid) => {
          reads.set(oid, (reads.get(oid) ?? 0) + 1);
          return objects.get(oid) ?? null;
        },
        readDeltaBase: async (oid) => (oid === DELTA_RESULT.oid ? DELTA_BASE.oid : null),
        readDelta: async (oid) =>
          oid === DELTA_RESULT.oid ? { baseOid: DELTA_BASE.oid, bytes: delta } : null,
      },
      new Set([DELTA_COMMIT.oid]),
    );

    await new Response(response).arrayBuffer();

    expect(reads.get(DELTA_RESULT.oid)).toBeUndefined();
  });

  test("writes a full object when its persisted delta base is absent from client and pack", async () => {
    const delta = buildDelta(DELTA_BASE.bytes.length, DELTA_RESULT.bytes.length, [
      insertInstruction(DELTA_RESULT.bytes),
    ]);
    const root = tree([treeEntry("result.txt", DELTA_RESULT)]);
    const tip = commit({ tree: root, parents: [FIRST], message: "Unreachable delta base" });
    const pushed = buildPack([
      { kind: "object", type: tip.type, bytes: tip.bytes },
      { kind: "object", type: root.type, bytes: root.bytes },
      { kind: "object", type: DELTA_BASE.type, bytes: DELTA_BASE.bytes },
      { kind: "ref-delta", baseOid: DELTA_BASE.oid, delta },
    ]).bytes;

    await harness.app.request(
      new Request("http://local.test/git/acme/demo.git/git-receive-pack", {
        method: "POST",
        headers: { Authorization: `Bearer ${harness.repositoryToken}` },
        body: pushBody({
          commands: [{ oldOid: FIRST.oid, newOid: tip.oid, name: MAIN }],
          pack: pushed,
        }),
      }),
    );

    const request = concat(
      pktLine(`want ${tip.oid} thin-pack side-band-64k ofs-delta\n`),
      flushPkt(),
      pktLine("done\n"),
    );
    const response = await post(UPLOAD, request);
    const pack = packFromSideband(new Uint8Array(await response.arrayBuffer()));
    const held = new Map<string, PackBase>();
    const received: PackObject[] = [];

    await readPack(streamOf(pack), {
      read: async (oid) => held.get(oid) ?? null,
      write: async (object) => {
        received.push(object);
        held.set(object.oid, { type: object.type, bytes: object.bytes });
      },
    });

    expect(received.some((object) => object.oid === DELTA_BASE.oid)).toBe(false);
    expect(received.find((object) => object.oid === DELTA_RESULT.oid)?.delta).toBeNull();
  });

  test("compresses full objects instead of expanding them into stored deflate blocks", async () => {
    const compressible = blob("Open Relic pack compression.\n".repeat(16_384));
    const root = tree([treeEntry("large.txt", compressible)]);
    const tip = commit({ tree: root, message: "Compress me" });
    const objects = new Map(
      [tip, root, compressible].map((object) => [
        object.oid,
        { type: object.type, bytes: object.bytes },
      ]),
    );
    const request = concat(
      pktLine(`want ${tip.oid} side-band-64k ofs-delta\n`),
      flushPkt(),
      pktLine("done\n"),
    );
    const response = uploadPackResultStream(
      streamOf(request),
      {
        has: async (oid) => objects.has(oid),
        read: async (oid) => objects.get(oid) ?? null,
        readDeltaBase: async () => null,
        readDelta: async () => null,
      },
      new Set([tip.oid]),
    );
    const pack = packFromSideband(new Uint8Array(await new Response(response).arrayBuffer()));

    expect(pack.length).toBeLessThan(compressible.bytes.length / 10);

    const held = new Map<string, PackBase>();
    await readPack(streamOf(pack), {
      read: async (oid) => held.get(oid) ?? null,
      write: async (object) => {
        held.set(object.oid, { type: object.type, bytes: object.bytes });
      },
    });
    expect(held.get(compressible.oid)?.bytes).toEqual(compressible.bytes);
  });
});
