import {
  ARTIFACT_TOKEN_PATTERN,
  ERROR_CODES,
  type ForkRepoResult,
  type RepoWithRemote,
} from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RepositoryStorageExhaustedError } from "../src/object-store.ts";
import type { Json } from "../src/request-body.ts";
import { createGitTestApp, type TestApp } from "./support/app.ts";
import { errorCode, result } from "./support/envelope.ts";
import { blob, commit, tag, tree, treeEntry, type GitObject } from "./support/git-objects.ts";
import { pushBody } from "./support/receive-pack.ts";

const README = blob("Anvil firmware\n");
const ROOT = tree([treeEntry("README.md", README)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const REVISED = blob("Anvil firmware, revised\n");
const FEATURE_ROOT = tree([treeEntry("README.md", REVISED)]);
const FEATURE = commit({ tree: FEATURE_ROOT, parents: [FIRST], message: "Feature" });
const V1 = tag({ target: FIRST, name: "v1" });
const ORPHAN = blob("not reachable\n");
const EMPTY = blob("");
const EMPTY_ROOT = tree([treeEntry("empty.txt", EMPTY)]);
const EMPTY_COMMIT = commit({ tree: EMPTY_ROOT, message: "Empty file" });
const MAIN = "refs/heads/main";
const FEATURE_REF = "refs/heads/feature";
const TAG = "refs/tags/v1";

let harness: TestApp;

beforeEach(async () => {
  harness = await createGitTestApp();
});

afterEach(() => {
  harness.close();
});

const push = (
  commands: Parameters<typeof pushBody>[0]["commands"],
  objects: readonly GitObject[] = [],
) =>
  harness.app.request(
    new Request("http://local.test/git/acme/demo.git/git-receive-pack", {
      method: "POST",
      headers: { Authorization: `Bearer ${harness.repositoryToken}` },
      body: pushBody({ commands, objects }),
    }),
  );

const seedFullSource = () =>
  push(
    [
      { newOid: FIRST.oid, name: MAIN },
      { newOid: FEATURE.oid, name: FEATURE_REF },
      { newOid: V1.oid, name: TAG },
    ],
    [FIRST, ROOT, README, FEATURE, FEATURE_ROOT, REVISED, V1, ORPHAN],
  );

const fork = (body: Json) =>
  harness.app.request(
    new Request("http://local.test/namespaces/acme/repos/demo/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const targetClient = () => {
  const targetId = harness.objects.mintedIds.at(-1);
  if (targetId === undefined) {
    throw new Error("No target repository object was minted.");
  }
  return harness.objects.get(targetId);
};

const advertisement = async (): Promise<string> =>
  new Response(await targetClient().advertiseReceivePack()).text();

describe("POST /namespaces/:namespace/repos/:source/fork", () => {
  test("copies every ref and the union of reachable objects, but not orphans", async () => {
    await seedFullSource();

    const response = await fork({ name: "copy", description: "A fork" });
    const body = await result<ForkRepoResult>(response);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      name: "copy",
      description: "A fork",
      default_branch: "main",
      source: "acme/demo",
      remote: "http://local.test/git/acme/copy.git",
      objects: 7,
    });
    expect(body.token).toMatch(ARTIFACT_TOKEN_PATTERN);
    expect(await advertisement()).toContain(`${FIRST.oid} ${MAIN}`);
    expect(await advertisement()).toContain(`${FEATURE.oid} ${FEATURE_REF}`);
    expect(await advertisement()).toContain(`${V1.oid} ${TAG}`);
    expect(await targetClient().hasObject(ORPHAN.oid)).toBe(false);

    const stored = await result<RepoWithRemote>(
      await harness.app.request("http://local.test/namespaces/acme/repos/copy"),
    );
    expect(stored.source).toBe("acme/demo");

    await harness.app.request(
      new Request("http://local.test/namespaces/acme/repos/demo", { method: "DELETE" }),
    );
    expect((await harness.app.request("http://local.test/namespaces/acme/repos/copy")).status).toBe(
      200,
    );
    expect(await targetClient().hasObject(FIRST.oid)).toBe(true);
  });

  test("default_branch_only copies HEAD, its branch, and only its reachable closure", async () => {
    await seedFullSource();

    const body = await result<ForkRepoResult>(
      await fork({ name: "copy", default_branch_only: true }),
    );

    expect(body.objects).toBe(3);
    expect(await targetClient().describe()).toMatchObject({ defaultBranch: "main" });
    expect(await advertisement()).toContain(`${FIRST.oid} ${MAIN}`);
    expect(await advertisement()).not.toContain(FEATURE_REF);
    expect(await advertisement()).not.toContain(TAG);
    expect(await targetClient().hasObject(FEATURE.oid)).toBe(false);
  });

  test("preserves an empty repository's HEAD and reports zero objects", async () => {
    const body = await result<ForkRepoResult>(await fork({ name: "empty-copy" }));

    expect(body.objects).toBe(0);
    expect(await targetClient().describe()).toMatchObject({ defaultBranch: "main" });
    expect(await advertisement()).toContain(`${"0".repeat(40)} capabilities^{}`);
  });

  test("copies a reachable zero-length Git object", async () => {
    await push([{ newOid: EMPTY_COMMIT.oid, name: MAIN }], [EMPTY_COMMIT, EMPTY_ROOT, EMPTY]);

    const body = await result<ForkRepoResult>(await fork({ name: "copy" }));
    const copied = await targetClient().readObject(EMPTY.oid);

    expect(body.objects).toBe(3);
    expect(copied).toMatchObject({ type: "blob" });
    expect(copied?.bytes).toHaveLength(0);
  });

  test("gates targeted access while copying but permits deletion and reuse", async () => {
    await seedFullSource();
    const pause = harness.objects.pauseNextForkAfterSnapshot();
    const pending = fork({ name: "copy" });
    await pause.captured;

    try {
      const targeted = await harness.app.request("http://local.test/namespaces/acme/repos/copy");
      const duplicate = await fork({ name: "copy" });
      const token = await harness.app.request(
        new Request("http://local.test/namespaces/acme/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: "copy" }),
        }),
      );
      const content = await Promise.all([
        harness.app.request(`http://local.test/namespaces/acme/repos/copy/commit/${FIRST.oid}`),
        harness.app.request(`http://local.test/namespaces/acme/repos/copy/tree/${ROOT.oid}`),
        harness.app.request(`http://local.test/namespaces/acme/repos/copy/blob/${README.oid}`),
      ]);

      expect(targeted.status).toBe(409);
      expect(await errorCode(targeted)).toBe(ERROR_CODES.forkInProgress);
      expect(duplicate.status).toBe(409);
      expect(await errorCode(duplicate)).toBe(ERROR_CODES.alreadyExists);
      expect(token.status).toBe(409);
      expect(await errorCode(token)).toBe(ERROR_CODES.forkInProgress);
      for (const response of content) {
        expect(response.status).toBe(409);
        expect(await errorCode(response)).toBe(ERROR_CODES.forkInProgress);
      }

      const deletion = await harness.app.request(
        new Request("http://local.test/namespaces/acme/repos/copy", { method: "DELETE" }),
      );
      expect(deletion.status).toBe(202);
    } finally {
      pause.release();
    }

    expect((await pending).status).toBe(500);
    expect((await fork({ name: "copy" })).status).toBe(201);
  });

  test("excludes a source push that starts after the fork snapshot", async () => {
    await push([{ newOid: FIRST.oid, name: MAIN }], [FIRST, ROOT, README]);
    const pause = harness.objects.pauseNextForkAfterSnapshot();
    const pendingFork = fork({ name: "copy" });
    await pause.captured;

    const pendingPush = push(
      [{ oldOid: FIRST.oid, newOid: FEATURE.oid, name: MAIN }],
      [FEATURE, FEATURE_ROOT, REVISED],
    );
    pause.release();
    await Promise.all([pendingFork, pendingPush]);

    expect(await advertisement()).toContain(`${FIRST.oid} ${MAIN}`);
    expect(await targetClient().hasObject(FEATURE.oid)).toBe(false);
    const sourceId = harness.objects.mintedIds[0]!;
    const sourceAdvertisement = await new Response(
      await harness.objects.get(sourceId).advertiseReceivePack(),
    ).text();
    expect(sourceAdvertisement).toContain(`${FEATURE.oid} ${MAIN}`);
  });

  test("destroys a failed target and its reservation so the same name can be retried", async () => {
    await push([{ newOid: FIRST.oid, name: MAIN }], [FIRST, ROOT, README]);
    harness.objects.failNextForkWrite(new RepositoryStorageExhaustedError());

    const failed = await fork({ name: "copy" });

    expect(failed.status).toBe(500);
    expect(await errorCode(failed)).toBe(ERROR_CODES.internalError);
    expect((await harness.app.request("http://local.test/namespaces/acme/repos/copy")).status).toBe(
      404,
    );
    expect(harness.objects.liveIds).toEqual([harness.objects.mintedIds[0]!]);
    expect((await fork({ name: "copy" })).status).toBe(201);
  });

  test("a read-only fork rejects a push even with its initial write token", async () => {
    await push([{ newOid: FIRST.oid, name: MAIN }], [FIRST, ROOT, README]);
    const forked = await result<ForkRepoResult>(await fork({ name: "copy", read_only: true }));

    const response = await harness.app.request(
      new Request("http://local.test/git/acme/copy.git/git-receive-pack", {
        method: "POST",
        headers: { Authorization: `Bearer ${forked.token}` },
        body: pushBody({ commands: [{ name: MAIN }] }),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("validates the fork-only fields and stays in the source namespace", async () => {
    for (const body of [
      { name: "copy", default_branch_only: "yes" },
      { name: "copy", read_only: "yes" },
      { name: "Other/copy" },
    ]) {
      expect((await fork(body)).status).toBe(400);
    }
    expect((await fork({ name: "demo" })).status).toBe(409);
    expect(
      (
        await harness.app.request(
          new Request("http://local.test/namespaces/acme/repos/missing/fork", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "copy" }),
          }),
        )
      ).status,
    ).toBe(404);
  });
});

test("a real Git client clones a fork and checks out its independent HEAD", async () => {
  await push([{ newOid: FIRST.oid, name: MAIN }], [FIRST, ROOT, README]);
  const forked = await result<ForkRepoResult>(await fork({ name: "copy" }));
  const directory = await mkdtemp(join(tmpdir(), "open-relic-fork-"));
  const checkout = join(directory, "checkout");
  const server = Bun.serve({ port: 0, fetch: (request) => harness.app.fetch(request) });
  const remote = new URL("/git/acme/copy.git", server.url);
  remote.username = "x";
  remote.password = forked.token.split("?expires=")[0]!;

  try {
    const child = Bun.spawn(["git", "clone", remote.toString(), checkout], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("Anvil firmware\n");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
