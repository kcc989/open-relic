import {
  NAMESPACES_PATH,
  REST_ENDPOINTS,
  isImplementedEndpoint,
  type ApiEnvelope,
  type CommitInfo,
  type TreeEntryInfo,
} from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createGitTestApp, type TestApp } from "./support/app.ts";
import { envelope, result } from "./support/envelope.ts";
import { blob, commit, GITLINK_MODE, tag, tree, type GitObject } from "./support/git-objects.ts";
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
const NOTES = blob("Nested notes\n");
const DATA = blob('{"ready":true}\n');
const UNKNOWN = blob("opaque bytes\n");
const PERCENT = blob("literal percent\n");
const NESTED = tree([
  { mode: "100644", name: "100%.txt", oid: PERCENT.oid },
  { mode: "100644", name: "data.json", oid: DATA.oid },
  { mode: "100644", name: "notes.txt", oid: NOTES.oid },
  { mode: "100644", name: "payload.unknown", oid: UNKNOWN.oid },
]);
const EXTERNAL_COMMIT = "2".repeat(40);
const ROOT = tree([
  { mode: "100644", name: "README.md", oid: README.oid },
  { mode: "40000", name: "dir", oid: NESTED.oid },
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
const V1 = tag({ target: SECOND, name: "v1" });
const OBJECTS: readonly GitObject[] = [
  LEGACY,
  SECOND,
  FIRST,
  V1,
  ROOT,
  NESTED,
  README,
  LINK,
  RUN,
  NOTES,
  DATA,
  UNKNOWN,
  PERCENT,
];

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
      body: pushBody({
        commands: [
          { newOid: LEGACY.oid, name: MAIN },
          { newOid: FIRST.oid, name: "refs/heads/feature/nested" },
          { newOid: V1.oid, name: "refs/tags/v1" },
        ],
        objects: OBJECTS,
      }),
    }),
  );
});

describe("GET /namespaces/:namespace/repos/:repo/log", () => {
  test("returns an empty history for an unborn HEAD", async () => {
    const emptyHarness = await createGitTestApp();
    try {
      const response = await emptyHarness.app.request(`${CONTENT}/log`);

      expect(response.status).toBe(200);
      expect(await result<readonly CommitInfo[]>(response)).toEqual([]);
    } finally {
      emptyHarness.close();
    }
  });

  test("resolves HEAD, branch, annotated tag, and full commit SHA", async () => {
    const revisions = [undefined, "main", "feature/nested", "v1", FIRST.oid] as const;
    const expectedHeads = [LEGACY.oid, LEGACY.oid, FIRST.oid, SECOND.oid, FIRST.oid] as const;

    for (const [at, revision] of revisions.entries()) {
      const query = new URLSearchParams({ limit: "1" });
      if (revision !== undefined) {
        query.set("ref", revision);
      }
      const response = await harness.app.request(`${CONTENT}/log?${query}`);
      const history = await result<readonly CommitInfo[]>(response);

      expect(response.status).toBe(200);
      expect(history.map((entry) => entry.hash)).toEqual([expectedHeads[at]!]);
    }
  });

  test("applies offset before limit to the resolved commit history", async () => {
    const response = await harness.app.request(`${CONTENT}/log?ref=main&limit=1&offset=1`);
    const history = await result<readonly CommitInfo[]>(response);

    expect(response.status).toBe(200);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
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

  test("orders merge history by commit date without placing a parent before its child", async () => {
    const identityAt = (timestamp: number): string =>
      `Open Relic <fixtures@open-relic.dev> ${timestamp} +0000`;
    const base = commit({
      tree: ROOT,
      message: "base",
      author: identityAt(1_000),
      committer: identityAt(1_000),
    });
    const old1 = commit({
      tree: ROOT,
      parents: [base],
      message: "old1",
      author: identityAt(1_100),
      committer: identityAt(1_100),
    });
    const old2 = commit({
      tree: ROOT,
      parents: [old1],
      message: "old2",
      author: identityAt(1_200),
      committer: identityAt(1_200),
    });
    const new1 = commit({
      tree: ROOT,
      parents: [base],
      message: "new1",
      author: identityAt(2_000),
      committer: identityAt(2_000),
    });
    const merge = commit({
      tree: ROOT,
      parents: [new1, old2],
      message: "merge",
      author: identityAt(3_000),
      committer: identityAt(3_000),
    });

    const push = await harness.app.request(
      new Request(PUSH, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${harness.repositoryToken}`,
          "Content-Type": "application/x-git-receive-pack-request",
        },
        body: pushBody({
          commands: [{ newOid: merge.oid, name: "refs/heads/merge-order" }],
          objects: [merge, new1, old2, old1, base],
        }),
      }),
    );
    expect(push.status).toBe(200);

    const response = await harness.app.request(`${CONTENT}/log?ref=merge-order&limit=4`);
    const history = await result<readonly CommitInfo[]>(response);

    expect(response.status).toBe(200);
    expect(history.map((entry) => entry.message)).toEqual(["merge", "new1", "old2", "old1"]);
  });

  test("validates limit and offset before walking history", async () => {
    for (const query of [
      "limit=0",
      "limit=1001",
      "limit=1.5",
      "offset=-1",
      "offset=1.5",
      "offset=10001",
    ]) {
      const response = await harness.app.request(`${CONTENT}/log?${query}`);

      expect(response.status).toBe(400);
    }

    const boundary = await harness.app.request(`${CONTENT}/log?offset=10000`);
    expect(boundary.status).toBe(200);
  });

  test("includes an imported shallow boundary without walking beyond it", async () => {
    const [durableObjectId] = harness.objects.liveIds;
    await harness.objects.seedShallowCommits(durableObjectId!, [SECOND.oid]);

    const response = await harness.app.request(`${CONTENT}/log?ref=main&limit=10`);
    const history = await result<readonly CommitInfo[]>(response);

    expect(response.status).toBe(200);
    expect(history.map((entry) => entry.hash)).toEqual([LEGACY.oid, SECOND.oid]);
  });
});

describe("resolved file reads", () => {
  test("file resolves a nested path through HEAD, tag, and full commit SHA", async () => {
    for (const revision of [undefined, "feature/nested", "v1", FIRST.oid] as const) {
      const query = new URLSearchParams({ path: "dir/notes.txt" });
      if (revision !== undefined) {
        query.set("ref", revision);
      }
      const response = await harness.app.request(`${CONTENT}/file?${query}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(await response.text()).toBe("Nested notes\n");
    }
  });

  test("raw resolves nested files and chooses a content type from the path", async () => {
    const fixtures = [
      ["README.md", "text/markdown", "Anvil firmware\n"],
      ["dir/100%25.txt", "text/plain", "literal percent\n"],
      ["dir/data.json", "application/json", '{"ready":true}\n'],
      ["dir/payload.unknown", "application/octet-stream", "opaque bytes\n"],
    ] as const;

    for (const [path, contentType, contents] of fixtures) {
      const response = await harness.app.request(`${CONTENT}/raw/main/${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(await response.text()).toBe(contents);
    }
  });
});

describe("resolved content failures", () => {
  test("reports a missing revision consistently", async () => {
    for (const path of [
      `${CONTENT}/log?ref=missing`,
      `${CONTENT}/file?ref=missing&path=README.md`,
      `${CONTENT}/raw/missing/README.md`,
    ]) {
      const response = await harness.app.request(path);
      const body = await envelope<never>(response);

      expect(response.status).toBe(404);
      expect(body.errors[0]?.message).toBe("Revision not found");
    }
  });

  test("reports a missing path and rejects trees as files", async () => {
    for (const path of [
      `${CONTENT}/file?ref=main&path=dir/missing.txt`,
      `${CONTENT}/file?ref=main&path=dir`,
      `${CONTENT}/raw/main/dir`,
    ]) {
      const response = await harness.app.request(path);
      const body = await envelope<never>(response);

      expect(response.status).toBe(404);
      expect(body.errors[0]?.message).toBe("File not found");
    }
  });

  test("rejects a stored blob when a commit revision is required", async () => {
    const historyResponse = await harness.app.request(`${CONTENT}/log?ref=${README.oid}`);
    expect(historyResponse.status).toBe(500);
    expect((await envelope<never>(historyResponse)).errors[0]?.message).toBe(
      "A stored git object is corrupt.",
    );

    const fileResponse = await harness.app.request(
      `${CONTENT}/file?ref=${README.oid}&path=README.md`,
    );
    expect(fileResponse.status).toBe(404);
    expect((await envelope<never>(fileResponse)).errors[0]?.message).toBe("File not found");
  });

  test("requires a file query path", async () => {
    const response = await harness.app.request(`${CONTENT}/file?ref=main`);
    const body = await envelope<never>(response);

    expect(response.status).toBe(400);
    expect(body.errors[0]?.source?.pointer).toBe("/path");
  });
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
      { name: "dir", mode: "40000", hash: NESTED.oid, type: "tree" },
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

test("resolved content endpoints have left the stub complement", () => {
  for (const id of ["contents.log", "contents.file", "contents.raw"] as const) {
    expect(isImplementedEndpoint(id)).toBeTrue();
  }
});
