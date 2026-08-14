import {
  NAMESPACES_PATH,
  REST_ENDPOINTS,
  type ApiEnvelope,
  type CommitInfo,
  type TreeEntryInfo,
} from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createGitTestApp, type TestApp } from "./support/app.ts";
import { envelope, result } from "./support/envelope.ts";
import { blob, commit, GITLINK_MODE, tree, type GitObject } from "./support/git-objects.ts";
import { pushBody } from "./support/receive-pack.ts";
import {
  HOSTED_BLOB_FIXTURE,
  HOSTED_COMMIT_FIXTURE,
  HOSTED_MALFORMED_HASH_FIXTURE,
  HOSTED_MISSING_OBJECT_FIXTURES,
  HOSTED_TREE_FIXTURE,
  HOSTED_WRONG_OBJECT_FIXTURES,
} from "./fixtures/hosted-artifacts-content.ts";

const CONTENT = `http://local.test${NAMESPACES_PATH}/acme/repos/demo`;
const PUSH = "http://local.test/git/acme/demo.git/git-receive-pack";
const MAIN = "refs/heads/main";
const MISSING_OID = "1".repeat(40);

const README = blob("Anvil firmware\n");
const RUN = blob("#!/bin/sh\necho anvil\n");
const LINK = blob("README.md");
const EMPTY_DIR = tree([]);
const EXTERNAL_COMMIT = "2".repeat(40);
const ROOT = tree([
  { mode: "100644", name: "README.md", oid: README.oid },
  { mode: "40000", name: "dir", oid: EMPTY_DIR.oid },
  { mode: "120000", name: "link", oid: LINK.oid },
  { mode: "100755", name: "run", oid: RUN.oid },
  { mode: GITLINK_MODE, name: "vendor", oid: EXTERNAL_COMMIT },
]);
const FIRST = commit({ tree: ROOT, message: "First" });
// The helper adds Git's terminal LF, so these bytes end in two LFs. Hosted
// Artifacts removes one and preserves the other as part of the message.
const SECOND = commit({
  tree: ROOT,
  parents: [FIRST],
  message: "  leading spaces\nbody trailing spaces  \n",
});
const LEGACY_IDENTITY = "Legacy Import <legacy@example.com> 1767225602";
const LEGACY = commit({
  tree: ROOT,
  parents: [SECOND],
  message: "Imported without a timezone",
  author: LEGACY_IDENTITY,
  committer: LEGACY_IDENTITY,
});
const OBJECTS: readonly GitObject[] = [LEGACY, SECOND, FIRST, ROOT, EMPTY_DIR, README, LINK, RUN];

let harness: TestApp;

beforeEach(async () => {
  harness = await createGitTestApp();

  await harness.app.request(
    new Request(PUSH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.repositoryToken}`,
        "Content-Type": "application/x-git-receive-pack-request",
      },
      body: pushBody({ commands: [{ newOid: LEGACY.oid, name: MAIN }], objects: OBJECTS }),
    }),
  );
});

afterEach(() => {
  harness.close();
});

describe("GET /namespaces/:namespace/repos/:repo/commit/:hash", () => {
  test("matches the hosted shape and removes exactly one trailing message LF", async () => {
    const response = await harness.app.request(`${CONTENT}/commit/${SECOND.oid}`);
    const commitInfo = await result<CommitInfo>(response);

    expect(response.status).toBe(HOSTED_COMMIT_FIXTURE.status);
    expect(Object.keys(commitInfo).sort()).toEqual(
      Object.keys(HOSTED_COMMIT_FIXTURE.body.result).sort(),
    );
    expect(commitInfo).toEqual({
      hash: SECOND.oid,
      treeHash: ROOT.oid,
      message: "  leading spaces\nbody trailing spaces  \n",
      author: { name: "Open Relic", email: "fixtures@open-relic.dev" },
      committer: { name: "Open Relic", email: "fixtures@open-relic.dev" },
      parents: [FIRST.oid],
      authoredAt: 1_767_225_600,
      committedAt: 1_767_225_600,
    });
  });

  test("reads Git-compatible identities that omit the optional timezone", async () => {
    const response = await harness.app.request(`${CONTENT}/commit/${LEGACY.oid}`);
    const commitInfo = await result<CommitInfo>(response);

    expect(response.status).toBe(200);
    expect(commitInfo.author).toEqual({ name: "Legacy Import", email: "legacy@example.com" });
    expect(commitInfo.committer).toEqual({ name: "Legacy Import", email: "legacy@example.com" });
    expect(commitInfo.authoredAt).toBe(1_767_225_602);
    expect(commitInfo.committedAt).toBe(1_767_225_602);
  });
});

describe("GET /namespaces/:namespace/repos/:repo/tree/:hash", () => {
  test("returns the hosted tree-entry shape, including modes and gitlinks", async () => {
    const response = await harness.app.request(`${CONTENT}/tree/${ROOT.oid}`);
    const entries = await result<readonly TreeEntryInfo[]>(response);

    expect(response.status).toBe(HOSTED_TREE_FIXTURE.status);
    expect(entries.map((entry) => Object.keys(entry).sort())).toEqual(
      entries.map(() => Object.keys(HOSTED_TREE_FIXTURE.body.result[0]).sort()),
    );
    expect(entries).toEqual([
      { name: "README.md", mode: "100644", hash: README.oid, type: "blob" },
      { name: "dir", mode: "40000", hash: EMPTY_DIR.oid, type: "tree" },
      { name: "link", mode: "120000", hash: LINK.oid, type: "symlink" },
      { name: "run", mode: "100755", hash: RUN.oid, type: "exec" },
      { name: "vendor", mode: "160000", hash: EXTERNAL_COMMIT, type: "gitlink" },
    ]);
  });
});

describe("GET /namespaces/:namespace/repos/:repo/blob/:hash", () => {
  test("returns exact blob bytes with the hosted content type", async () => {
    // Workers rejects a serialized RPC return at its ceiling. Scale that limit
    // down to this fixture so this test fails if the route buffers readObject.
    harness.objects.limitSerializedRpcTo(README.bytes.byteLength);
    const response = await harness.app.request(`${CONTENT}/blob/${README.oid}`);

    expect(response.status).toBe(HOSTED_BLOB_FIXTURE.status);
    expect(response.headers.get("content-type")).toBe(HOSTED_BLOB_FIXTURE.contentType);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from(README.bytes));
  });
});

describe("direct object failures", () => {
  for (const kind of ["commit", "tree", "blob"] as const) {
    test(`${kind} rejects a malformed hash exactly as hosted Artifacts does`, async () => {
      const response = await harness.app.request(`${CONTENT}/${kind}/deadbeef`);

      expect(response.status).toBe(HOSTED_MALFORMED_HASH_FIXTURE.status);
      expect(await envelope<never>(response)).toEqual(HOSTED_MALFORMED_HASH_FIXTURE.body);
    });

    test(`${kind} distinguishes a missing object`, async () => {
      const fixture = HOSTED_MISSING_OBJECT_FIXTURES[kind];
      const response = await harness.app.request(`${CONTENT}/${kind}/${MISSING_OID}`);

      expect(response.status).toBe(fixture.status);
      expect(await envelope<never>(response)).toEqual(fixture.body);
    });
  }

  const wrongTypes = [
    ["commit", "tree", ROOT.oid],
    ["commit", "blob", README.oid],
    ["tree", "commit", SECOND.oid],
    ["tree", "blob", README.oid],
    ["blob", "commit", SECOND.oid],
    ["blob", "tree", ROOT.oid],
  ] as const;

  for (const [kind, actualType, oid] of wrongTypes) {
    test(`${kind} matches the hosted response for a stored ${actualType}`, async () => {
      const fixture = HOSTED_WRONG_OBJECT_FIXTURES[kind];
      const response = await harness.app.request(`${CONTENT}/${kind}/${oid}`);

      expect(response.status).toBe(fixture.status);
      expect(await envelope<never>(response)).toEqual(fixture.body);
    });
  }

  test("uses the normal repository 404 before making an object RPC", async () => {
    const response = await harness.app.request(
      `http://local.test${NAMESPACES_PATH}/acme/repos/nope/commit/${SECOND.oid}`,
    );

    expect(response.status).toBe(404);
    expect((await envelope<never>(response)).errors[0]?.message).toContain("acme/nope");
  });
});

test("refs and archive are absent from the manifest and fall through to the normal 404", async () => {
  expect(REST_ENDPOINTS.map((endpoint) => endpoint.id)).not.toContain("contents.refs");
  expect(REST_ENDPOINTS.map((endpoint) => endpoint.id)).not.toContain("contents.archive");

  for (const path of [`${CONTENT}/refs`, `${CONTENT}/archive/main.tar.gz`]) {
    const response = await harness.app.request(path);
    const body = await envelope<never>(response);

    expect(response.status).toBe(404);
    expect(body).toEqual({
      result: null,
      success: false,
      errors: [{ code: 10_200, message: "No route matches this request." }],
      messages: [],
    } satisfies ApiEnvelope<never>);
  }
});
