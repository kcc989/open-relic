import { describe, expect, test } from "bun:test";

import {
  branchRef,
  detachedHead,
  formatHead,
  headBranch,
  parseHead,
  symbolicHead,
} from "../src/head.ts";

const OID = "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31";

describe("formatHead", () => {
  test("writes a symbolic HEAD the way Git writes it", () => {
    expect(formatHead(symbolicHead("main"))).toBe("ref: refs/heads/main\n");
  });

  test("writes a hierarchical branch as its full ref path", () => {
    expect(formatHead(symbolicHead("release/2.0.x"))).toBe("ref: refs/heads/release/2.0.x\n");
  });

  test("writes a detached HEAD as a bare object id", () => {
    expect(formatHead(detachedHead(OID))).toBe(`${OID}\n`);
  });
});

describe("parseHead", () => {
  test("reads back what it wrote, symbolic and detached", () => {
    for (const head of [symbolicHead("main"), detachedHead(OID)]) {
      expect(parseHead(formatHead(head))).toEqual(head);
    }
  });

  test("accepts a symbolic HEAD without its trailing newline", () => {
    expect(parseHead("ref: refs/heads/main")).toEqual(symbolicHead("main"));
  });

  test("accepts whatever whitespace Git tolerates after ref:", () => {
    expect(parseHead("ref:   refs/heads/main\n")).toEqual(symbolicHead("main"));
    expect(parseHead("ref:refs/heads/main\n")).toEqual(symbolicHead("main"));
  });

  test("keeps a symbolic target that is not a branch", () => {
    expect(parseHead("ref: refs/tags/v1\n")).toEqual({
      kind: "symbolic",
      ref: "refs/tags/v1",
    });
  });

  test("accepts a detached object id without its trailing newline", () => {
    expect(parseHead(OID)).toEqual(detachedHead(OID));
  });

  const unparseable: ReadonlyArray<readonly [string, string]> = [
    ["empty contents", ""],
    ["whitespace only", "\n"],
    ["a symbolic ref with no target", "ref: \n"],
    ["a bare ref: with nothing after it", "ref:"],
    ["a short object id", OID.slice(0, 39)],
    ["a long object id", `${OID}a`],
    ["a non-hex object id", `${OID.slice(0, 39)}z`],
    ["an uppercase object id", OID.toUpperCase()],
    ["a bare branch name", "main"],
  ];

  for (const [label, contents] of unparseable) {
    test(`rejects ${label}`, () => {
      expect(parseHead(contents)).toBeNull();
    });
  }
});

describe("headBranch", () => {
  test("names the branch a symbolic HEAD points at", () => {
    expect(headBranch(symbolicHead("trunk"))).toBe("trunk");
    expect(headBranch(symbolicHead("release/2.0.x"))).toBe("release/2.0.x");
  });

  test("has no branch to name when HEAD is detached", () => {
    expect(headBranch(detachedHead(OID))).toBeNull();
  });

  test("has no branch to name when HEAD points outside refs/heads", () => {
    expect(headBranch({ kind: "symbolic", ref: "refs/tags/v1" })).toBeNull();
  });
});

describe("branchRef", () => {
  test("is the ref path a branch name lives at", () => {
    expect(branchRef("main")).toBe("refs/heads/main");
  });
});
