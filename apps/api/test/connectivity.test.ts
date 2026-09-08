import { describe, expect, test } from "bun:test";

import {
  ObjectParseError,
  commitParents,
  findMissingObject,
  linksToReach,
  linksToVerify,
  type ObjectSource,
} from "../src/connectivity.ts";
import type { PackBase } from "../src/pack.ts";
import {
  GITLINK_MODE,
  blob,
  commit,
  tag,
  tree,
  treeEntry,
  type GitObject,
} from "./support/git-objects.ts";
import { concat } from "./support/pack.ts";

const encoder = new TextEncoder();

/** A repository that holds exactly these objects and nothing else. */
const holding = (...objects: readonly GitObject[]): ObjectSource => {
  const held = new Map(objects.map((object) => [object.oid, object]));

  return {
    read: async (oid): Promise<PackBase | null> => {
      const found = held.get(oid);
      return found === undefined ? null : { type: found.type, bytes: found.bytes };
    },
  };
};

const walk = (tip: string, source: ObjectSource) =>
  findMissingObject(tip, source, {
    verified: new Set<string>(),
    visited: new Set<string>(),
  });

const README = blob("Anvil firmware\n");
const MAIN_C = blob("int");
const DOCS = tree([treeEntry("README.md", README)]);
const ROOT = tree([treeEntry("docs", DOCS), treeEntry("main.c", MAIN_C)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const SECOND = commit({ tree: ROOT, parents: [FIRST], message: "Second" });

describe("what an object names", () => {
  test("a commit names its tree and every parent", () => {
    expect(linksToVerify("commit", SECOND.bytes)).toEqual([
      { oid: ROOT.oid, type: "tree" },
      { oid: FIRST.oid, type: "commit" },
    ]);
  });

  test("a merge commit names both parents, in order", () => {
    const merge = commit({ tree: ROOT, parents: [FIRST, SECOND] });

    expect(commitParents(merge.bytes)).toEqual([FIRST.oid, SECOND.oid]);
  });

  test("a tree names its subtrees and its blobs, since a push must deliver both", () => {
    expect(linksToVerify("tree", ROOT.bytes)).toEqual([
      { oid: DOCS.oid, type: "tree" },
      { oid: MAIN_C.oid, type: "blob" },
    ]);
  });

  test("a reachability walk names both trees and blobs", () => {
    expect(linksToReach("tree", ROOT.bytes)).toEqual([
      { oid: DOCS.oid, type: "tree" },
      { oid: MAIN_C.oid, type: "blob" },
    ]);
  });

  test("a tree does not name a submodule's commit, which lives elsewhere", () => {
    const withSubmodule = tree([
      { mode: GITLINK_MODE, name: "vendor", oid: FIRST.oid },
      treeEntry("docs", DOCS),
    ]);

    expect(linksToVerify("tree", withSubmodule.bytes)).toEqual([{ oid: DOCS.oid, type: "tree" }]);
    expect(linksToReach("tree", withSubmodule.bytes)).toEqual([{ oid: DOCS.oid, type: "tree" }]);
  });

  test("a tag names what it points at, with the type it declares", () => {
    expect(linksToVerify("tag", tag({ target: SECOND, name: "v1" }).bytes)).toEqual([
      { oid: SECOND.oid, type: "commit" },
    ]);
  });

  test("a blob names nothing", () => {
    expect(linksToVerify("blob", README.bytes)).toEqual([]);
  });

  const unreadable: ReadonlyArray<readonly [string, "commit" | "tag", string]> = [
    ["a commit with no tree", "commit", "author nobody\n\nno tree here\n"],
    ["a commit whose tree is not an object id", "commit", "tree nope\n\n"],
    ["a tag naming no object", "tag", "type commit\n\n"],
    [
      "a tag naming a type there is no such thing as",
      "tag",
      `object ${FIRST.oid}\ntype sandwich\n\n`,
    ],
  ];

  for (const [label, type, contents] of unreadable) {
    test(`refuses to guess at ${label}`, () => {
      expect(() => linksToVerify(type, encoder.encode(contents))).toThrow(ObjectParseError);
    });
  }

  test("refuses a tree entry that ends mid-object-id", () => {
    const truncated = concat(encoder.encode("100644 README.md\0"), new Uint8Array(7));

    expect(() => linksToVerify("tree", truncated)).toThrow(ObjectParseError);
  });
});

describe("the connectivity walk", () => {
  test("finds nothing missing when the whole history is there", async () => {
    const source = holding(SECOND, FIRST, ROOT, DOCS, README, MAIN_C);

    expect(await walk(SECOND.oid, source)).toBeNull();
  });

  test("names the tree a commit points at but the push did not carry", async () => {
    expect(await walk(FIRST.oid, holding(FIRST))).toBe(ROOT.oid);
  });

  test("names a missing parent, so a truncated history is caught", async () => {
    expect(await walk(SECOND.oid, holding(SECOND, ROOT, DOCS))).toBe(FIRST.oid);
  });

  test("names a missing subtree several levels down", async () => {
    expect(await walk(FIRST.oid, holding(FIRST, ROOT, MAIN_C))).toBe(DOCS.oid);
  });

  test("names a missing blob, since a tree naming one nobody sent is unfetchable", async () => {
    expect(await walk(FIRST.oid, holding(FIRST, ROOT, DOCS, MAIN_C))).toBe(README.oid);
  });

  test("asks whether a blob exists rather than reading it", async () => {
    const reads: string[] = [];
    const present = holding(FIRST, ROOT, DOCS, README, MAIN_C);
    const source: ObjectSource = {
      read: async (oid) => {
        reads.push(oid);
        return present.read(oid);
      },
      has: async (oid) => (await present.read(oid)) !== null,
    };

    expect(await walk(FIRST.oid, source)).toBeNull();
    expect(reads).not.toContain(README.oid);
    expect(reads).toContain(ROOT.oid);
  });

  test("walks through an annotated tag to what it tags", async () => {
    const annotated = tag({ target: FIRST, name: "v1" });

    expect(await walk(annotated.oid, holding(annotated, FIRST, ROOT, MAIN_C))).toBe(DOCS.oid);
    expect(
      await walk(annotated.oid, holding(annotated, FIRST, ROOT, DOCS, README, MAIN_C)),
    ).toBeNull();
  });

  test("an object we cannot parse is as good as missing", async () => {
    const source: ObjectSource = {
      read: async () => ({ type: "commit", bytes: encoder.encode("garbage") }),
    };

    expect(await walk(FIRST.oid, source)).toBe(FIRST.oid);
  });

  test("stops at objects a previous push already walked", async () => {
    const reads: string[] = [];
    const source: ObjectSource = {
      read: async (oid) => {
        reads.push(oid);
        return holding(SECOND).read(oid);
      },
    };

    const missing = await findMissingObject(SECOND.oid, source, {
      verified: new Set([ROOT.oid, FIRST.oid]),
      visited: new Set(),
    });

    // The old tip and its tree were proven when they landed, so a push that
    // adds one commit costs one commit rather than the whole history.
    expect(missing).toBeNull();
    expect(reads).toEqual([SECOND.oid]);
  });

  test("walks shared history once across the commands of one push", async () => {
    const reads: string[] = [];
    const store = holding(SECOND, FIRST, ROOT, DOCS, README, MAIN_C);
    const source: ObjectSource = {
      read: async (oid) => {
        reads.push(oid);
        return store.read(oid);
      },
    };
    const shared = {
      verified: new Set<string>(),
      visited: new Set<string>(),
    };

    await findMissingObject(SECOND.oid, source, shared);
    const before = reads.length;
    await findMissingObject(FIRST.oid, source, shared);

    expect(reads.length).toBe(before);
  });
});
