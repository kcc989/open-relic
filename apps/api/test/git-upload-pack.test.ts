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
          commands: [{ oldOid: FIRST.oid, newOid: REJECTED.oid, name: MAIN }],
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
          readDelta: async () => null,
        },
        new Set([FIRST.oid]),
      ),
    ).arrayBuffer();

    expect(checks.get(README.oid)).toBe(1);
    expect(reads.get(README.oid)).toBe(1);
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
});
