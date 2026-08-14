import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HEAD_KEY } from "../src/head.ts";
import { ZERO_OID } from "../src/object.ts";
import { REJECTIONS, RepositoryStore, type ReceivePackOutcome } from "../src/repository-store.ts";
import { createTestRepositoryStorage, type TestRepositoryStorage } from "./support/database.ts";
import { blob, commit, tag, tree, treeEntry, type GitObject } from "./support/git-objects.ts";
import {
  buildDelta,
  buildPack,
  copyInstruction,
  insertInstruction,
  streamOf,
} from "./support/pack.ts";
import { packOf, pushBody, readReport, type PushCommand } from "./support/receive-pack.ts";

/**
 * A push, end to end, against the real schema and the real pack reader — the
 * only thing skipped is the RPC hop and the Worker in front of it.
 */

const README = blob("Anvil firmware\n");
const ROOT = tree([treeEntry("README.md", README)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const FIRST_OBJECTS = [FIRST, ROOT, README];

const REVISED = blob("Anvil firmware, revised\n");
const SECOND_ROOT = tree([treeEntry("README.md", REVISED)]);
const SECOND = commit({
  tree: SECOND_ROOT,
  parents: [FIRST],
  message: "Second",
});
const SECOND_OBJECTS = [SECOND, SECOND_ROOT, REVISED];

/** A history of its own, sharing no commit with FIRST. */
const ELSEWHERE = commit({ tree: ROOT, message: "Elsewhere" });

const MAIN = "refs/heads/main";

let opened: TestRepositoryStorage;
let store: RepositoryStore;

beforeEach(async () => {
  opened = createTestRepositoryStorage();
  store = new RepositoryStore(opened.db, opened.kv);
  await store.initialize({
    defaultBranch: "main",
    createdAt: "2026-08-13T00:00:00.000Z",
  });
});

afterEach(() => {
  opened.close();
});

const push = (options: {
  readonly commands: readonly PushCommand[];
  readonly objects?: readonly GitObject[];
  readonly capabilities?: readonly string[];
  readonly pushOptions?: readonly string[];
  readonly pack?: Uint8Array<ArrayBuffer>;
}): Promise<ReceivePackOutcome> => store.receivePack(streamOf(pushBody(options)));

const report = (outcome: ReceivePackOutcome) => readReport(outcome.report);

/** The refs the repository would advertise, which is the only view that counts. */
const advertised = async (): Promise<string> =>
  new Response(await store.advertiseReceivePack()).text();

describe("a first push to an empty repository", () => {
  test("creates the branch and reports it accepted", async () => {
    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: FIRST_OBJECTS,
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
    expect(outcome.accepted).toBe(true);
    expect(await advertised()).toContain(`${FIRST.oid} ${MAIN}\0`);
  });

  test("reads a body that arrives in slices smaller than its own framing", async () => {
    // A request body arrives in whatever chunks the network chose, which line
    // up with neither a pkt-line nor the pack behind it.
    const outcome = await store.receivePack(
      streamOf(
        pushBody({
          commands: [{ newOid: FIRST.oid, name: MAIN }],
          objects: FIRST_OBJECTS,
        }),
        { chunkSize: 3 },
      ),
    );

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
  });

  test("leaves the pushed objects readable", async () => {
    await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: FIRST_OBJECTS,
    });

    expect(await store.hasObject(README.oid)).toBe(true);
    expect((await store.readObject(FIRST.oid))?.type).toBe("commit");
  });

  test("retargets HEAD when the push gave the repository its only branch", async () => {
    // `git init && git push -u origin master` against a repository created
    // with a different default: a HEAD naming a branch nobody will push is a
    // repository no clone can check out.
    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: "refs/heads/master" }],
      objects: FIRST_OBJECTS,
    });

    expect(opened.kv.get(HEAD_KEY)).toBe("ref: refs/heads/master\n");
    expect(outcome.retargetedTo).toBe("master");
    expect((await store.describe())?.defaultBranch).toBe("master");
  });

  test("leaves HEAD alone when the push named the branch it already points at", async () => {
    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: FIRST_OBJECTS,
    });

    expect(opened.kv.get(HEAD_KEY)).toBe("ref: refs/heads/main\n");
    expect(outcome.retargetedTo).toBeNull();
  });

  test("leaves HEAD alone when the push created more than one branch", async () => {
    // Which branch a repository is *for* is not a push's to decide once there
    // is anything to decide between.
    await push({
      commands: [
        { newOid: FIRST.oid, name: "refs/heads/master" },
        { newOid: ELSEWHERE.oid, name: "refs/heads/trunk" },
      ],
      objects: [...FIRST_OBJECTS, ELSEWHERE],
    });

    expect(opened.kv.get(HEAD_KEY)).toBe("ref: refs/heads/main\n");
  });

  test("retargets past a tag pushed alongside the one branch", async () => {
    const annotated = tag({ target: FIRST, name: "v1" });

    await push({
      commands: [
        { newOid: FIRST.oid, name: "refs/heads/master" },
        { newOid: annotated.oid, name: "refs/tags/v1" },
      ],
      objects: [...FIRST_OBJECTS, annotated],
    });

    expect(opened.kv.get(HEAD_KEY)).toBe("ref: refs/heads/master\n");
  });
});

describe("a second push", () => {
  beforeEach(async () => {
    await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: FIRST_OBJECTS,
    });
  });

  test("fast-forwards the branch", async () => {
    const outcome = await push({
      commands: [{ oldOid: FIRST.oid, newOid: SECOND.oid, name: MAIN }],
      objects: SECOND_OBJECTS,
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
    expect(await advertised()).toContain(`${SECOND.oid} ${MAIN}\0`);
  });

  test("leaves HEAD where it was", async () => {
    await push({
      commands: [{ oldOid: FIRST.oid, newOid: SECOND.oid, name: MAIN }],
      objects: SECOND_OBJECTS,
    });

    expect(opened.kv.get(HEAD_KEY)).toBe("ref: refs/heads/main\n");
  });

  test("accepts a forced rewind", async () => {
    await push({
      commands: [{ oldOid: FIRST.oid, newOid: SECOND.oid, name: MAIN }],
      objects: SECOND_OBJECTS,
    });

    const outcome = await push({
      commands: [{ oldOid: SECOND.oid, newOid: FIRST.oid, name: MAIN }],
      objects: [],
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
    expect(outcome.accepted).toBe(true);
    expect(await advertised()).toContain(`${FIRST.oid} ${MAIN}\0`);
  });

  test("accepts a forced update to unrelated history", async () => {
    const outcome = await push({
      commands: [{ oldOid: FIRST.oid, newOid: ELSEWHERE.oid, name: MAIN }],
      objects: [ELSEWHERE],
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
    expect(await advertised()).toContain(`${ELSEWHERE.oid} ${MAIN}\0`);
  });

  test("deletes a ref", async () => {
    const outcome = await push({
      commands: [{ oldOid: FIRST.oid, newOid: ZERO_OID, name: MAIN }],
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
    expect(outcome.accepted).toBe(true);
    expect(await advertised()).toContain("capabilities^{}");
  });

  test("accepts a thin pack whose ref-delta base arrived in the first push", async () => {
    const shared = README.bytes.subarray(0, README.bytes.length - 1);
    const suffix = REVISED.bytes.subarray(shared.length);
    const delta = buildDelta(README.bytes.length, REVISED.bytes.length, [
      copyInstruction(0, shared.length),
      insertInstruction(suffix),
    ]);
    const thin = buildPack([
      { kind: "object", type: SECOND.type, bytes: SECOND.bytes },
      { kind: "object", type: SECOND_ROOT.type, bytes: SECOND_ROOT.bytes },
      { kind: "ref-delta", baseOid: README.oid, delta },
    ]).bytes;

    const outcome = await push({
      commands: [{ oldOid: FIRST.oid, newOid: SECOND.oid, name: MAIN }],
      pack: thin,
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
    expect((await store.readObject(REVISED.oid))?.bytes).toEqual(REVISED.bytes);
  });

  test("rejects a push against a ref that has moved since the advertisement", async () => {
    const outcome = await push({
      commands: [{ oldOid: ELSEWHERE.oid, newOid: SECOND.oid, name: MAIN }],
      objects: SECOND_OBJECTS,
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ng ${MAIN} ${REJECTIONS.stale}`]);
  });

  test("accepts a command that moves a ref to where it already is", async () => {
    // Git's own receive-pack answers one with `ok`, and compatibility is the
    // specification.
    const outcome = await push({
      commands: [{ oldOid: FIRST.oid, newOid: FIRST.oid, name: MAIN }],
      objects: [],
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
    expect(await advertised()).toContain(`${FIRST.oid} ${MAIN}\0`);
  });

  test("rejects a create of a ref that already exists", async () => {
    const outcome = await push({
      commands: [{ newOid: SECOND.oid, name: MAIN }],
      objects: SECOND_OBJECTS,
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ng ${MAIN} ${REJECTIONS.exists}`]);
  });
});

describe("a push whose objects are not all there", () => {
  test("moves no refs, and says which object it wanted", async () => {
    // The pack carries the commit but not the tree it names.
    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: [FIRST, README],
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ng ${MAIN} ${REJECTIONS.missingObjects}`]);
    expect(report(outcome).progress.join("")).toContain(ROOT.oid);
    expect(await advertised()).toContain("capabilities^{}");
  });

  test("leaves the objects it did receive in place", async () => {
    // A ref is the only thing that makes an object reachable, so orphans are a
    // storage cost rather than a correctness problem.
    await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: [FIRST, README],
    });

    expect(await store.hasObject(FIRST.oid)).toBe(true);
  });

  test("rejects a ref pointing at an object the push never mentioned", async () => {
    const outcome = await push({
      commands: [{ newOid: ELSEWHERE.oid, name: MAIN }],
      objects: FIRST_OBJECTS,
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ng ${MAIN} ${REJECTIONS.missingObjects}`]);
  });
});

describe("a push whose pack cannot be read", () => {
  test("says so in unpack and rejects every ref", async () => {
    const corrupt = packOf(FIRST_OBJECTS);
    corrupt[corrupt.length - 1] = (corrupt.at(-1)! ^ 0xff) & 0xff;

    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      pack: corrupt,
    });
    const { lines, progress } = report(outcome);

    expect(lines[0]).toStartWith("unpack ");
    expect(lines[0]).not.toBe("unpack ok");
    expect(lines[1]).toBe(`ng ${MAIN} ${REJECTIONS.unpacker}`);
    expect(progress.join("")).toContain("could not read the push");
    expect(await advertised()).toContain("capabilities^{}");
  });

  test("says so legibly when the pack is not a pack at all", async () => {
    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      pack: new TextEncoder().encode("this is not a pack, it is a sentence"),
    });

    expect(report(outcome).lines[0]).toContain("PACK");
  });
});

describe("a push the server cannot make sense of", () => {
  test("a body that is not pkt-lines is refused in unpack, blaming no ref", async () => {
    const outcome = await store.receivePack(
      streamOf(new TextEncoder().encode("POST / HTTP/1.1\r\n\r\n")),
    );

    expect(report(outcome).lines).toHaveLength(1);
    expect(report(outcome).lines[0]).toStartWith("unpack ");
    expect(outcome.accepted).toBe(false);
  });

  test("a push of nothing changes nothing", async () => {
    // A client that named no refs also never sent the capability line, so
    // there is nobody to report to and nothing to report.
    const outcome = await push({ commands: [] });

    expect(outcome.report).toHaveLength(0);
    expect(outcome.accepted).toBe(false);
    expect(await advertised()).toContain("capabilities^{}");
  });
});

describe("the shape of a ref a push may name", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["a name outside refs/", "main"],
    ["HEAD, which is not in the ref store", "HEAD"],
    ["a component starting with a dot", "refs/heads/.hidden"],
    ["a name ending in .lock", "refs/heads/main.lock"],
    ["a doubled slash", "refs/heads//main"],
    ["a name with a space in it", "refs/heads/two words"],
  ];

  for (const [label, name] of refused) {
    test(`refuses ${label}`, async () => {
      const outcome = await push({
        commands: [{ newOid: FIRST.oid, name }],
        objects: FIRST_OBJECTS,
      });

      expect(report(outcome).lines).toEqual(["unpack ok", `ng ${name} ${REJECTIONS.funnyRefname}`]);
    });
  }

  test("refuses the same ref named twice rather than picking one", async () => {
    const outcome = await push({
      commands: [
        { newOid: FIRST.oid, name: MAIN },
        { newOid: ELSEWHERE.oid, name: MAIN },
      ],
      objects: [...FIRST_OBJECTS, ELSEWHERE],
    });

    expect(report(outcome).lines).toEqual([
      "unpack ok",
      `ok ${MAIN}`,
      `ng ${MAIN} ${REJECTIONS.duplicate}`,
    ]);
    expect(await advertised()).toContain(`${FIRST.oid} ${MAIN}\0`);
  });
});

describe("a push of several refs at once", () => {
  test("reports each in the order the client named them, and applies the good ones", async () => {
    const outcome = await push({
      commands: [
        { newOid: FIRST.oid, name: "refs/heads/main" },
        { oldOid: FIRST.oid, newOid: SECOND.oid, name: "refs/heads/gone" },
        { newOid: ELSEWHERE.oid, name: "refs/heads/side" },
      ],
      objects: [...FIRST_OBJECTS, ...SECOND_OBJECTS, ELSEWHERE],
    });

    expect(report(outcome).lines).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      `ng refs/heads/gone ${REJECTIONS.vanished}`,
      "ok refs/heads/side",
    ]);
  });

  test("moves every accepted ref in one transaction", async () => {
    await push({
      commands: [
        { newOid: FIRST.oid, name: "refs/heads/main" },
        { newOid: ELSEWHERE.oid, name: "refs/heads/side" },
      ],
      objects: [...FIRST_OBJECTS, ELSEWHERE],
    });

    const body = await advertised();
    expect(body).toContain(`${FIRST.oid} refs/heads/main\0`);
    expect(body).toContain(`${ELSEWHERE.oid} refs/heads/side\n`);
  });

  test("an atomic push with one bad command moves none of them", async () => {
    const outcome = await push({
      commands: [
        { newOid: FIRST.oid, name: "refs/heads/main" },
        { oldOid: FIRST.oid, newOid: SECOND.oid, name: "refs/heads/gone" },
      ],
      objects: [...FIRST_OBJECTS, ...SECOND_OBJECTS],
      capabilities: ["report-status-v2", "atomic"],
    });

    expect(report(outcome).lines).toEqual([
      "unpack ok",
      `ng refs/heads/main ${REJECTIONS.atomic}`,
      `ng refs/heads/gone ${REJECTIONS.vanished}`,
    ]);
    expect(outcome.accepted).toBe(false);
    expect(await advertised()).toContain("capabilities^{}");
  });
});

describe("what the client asked to be told", () => {
  test("gets a plain report when it did not ask for a sideband", async () => {
    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: FIRST_OBJECTS,
      capabilities: ["report-status"],
    });

    expect(new TextDecoder().decode(outcome.report)).toBe(
      "000eunpack ok\n0017ok refs/heads/main\n0000",
    );
  });

  test("gets nothing at all when it did not ask for a report", async () => {
    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: FIRST_OBJECTS,
      capabilities: [],
    });

    expect(outcome.report).toHaveLength(0);
    // The push still happened; only the telling was declined.
    expect(await advertised()).toContain(`${FIRST.oid} ${MAIN}\0`);
  });

  test("reads push options before the pack and applies the push", async () => {
    const outcome = await push({
      commands: [{ newOid: FIRST.oid, name: MAIN }],
      objects: FIRST_OBJECTS,
      capabilities: ["report-status-v2", "push-options"],
      pushOptions: ["deploy=production", "ci.skip"],
    });

    expect(report(outcome).lines).toEqual(["unpack ok", `ok ${MAIN}`]);
    expect(await advertised()).toContain(`${FIRST.oid} ${MAIN}\0`);
  });
});
