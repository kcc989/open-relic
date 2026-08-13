import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createGitTestApp, type TestApp } from "./support/app.ts";
import { blob, commit, tag, tree, treeEntry } from "./support/git-objects.ts";
import { pushBody } from "./support/receive-pack.ts";

const README = blob("Anvil firmware\n");
const ROOT = tree([treeEntry("README.md", README)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const V1 = tag({ target: FIRST, name: "v1" });
const REVISED = blob("Anvil firmware, revised\n");
const SECOND_ROOT = tree([treeEntry("README.md", REVISED)]);
const SECOND = commit({ tree: SECOND_ROOT, parents: [FIRST], message: "Second" });
const MAIN = "refs/heads/main";

let harness: TestApp;
let directory: string;

const push = (body: Uint8Array<ArrayBuffer>) =>
  harness.app.request(
    new Request("http://local.test/git/acme/demo.git/git-receive-pack", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.repositoryToken}`,
        "Content-Type": "application/x-git-receive-pack-request",
      },
      body,
    }),
  );

const remoteFor = (port: number | undefined): string => {
  if (harness.repositoryToken === null) {
    throw new Error("The Git test repository has no token.");
  }
  if (port === undefined) {
    throw new Error("The Git test server has no port.");
  }
  return `http://x:${encodeURIComponent(harness.repositoryToken)}@127.0.0.1:${port}/git/acme/demo.git`;
};

beforeEach(async () => {
  harness = await createGitTestApp();
  directory = await mkdtemp(join(tmpdir(), "open-relic-clone-"));

  const response = await push(
    pushBody({
      commands: [
        { newOid: FIRST.oid, name: MAIN },
        { newOid: V1.oid, name: "refs/tags/v1" },
      ],
      objects: [FIRST, ROOT, README, V1],
    }),
  );

  expect(response.status).toBe(200);
});

afterEach(async () => {
  harness.close();
  await rm(directory, { recursive: true, force: true });
});

const run = async (command: readonly string[]): Promise<string> => {
  const child = Bun.spawn([...command], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr}`);
  }

  return stdout.trim();
};

describe("a real Git client", () => {
  test("clones a pushed repository and checks out HEAD", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => harness.app.fetch(request),
    });
    const checkout = join(directory, "checkout");

    try {
      await run(["git", "-c", "protocol.version=1", "clone", remoteFor(server.port), checkout]);

      expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("Anvil firmware\n");
      expect(await run(["git", "-C", checkout, "rev-parse", "HEAD"])).toBe(FIRST.oid);
      expect(await run(["git", "-C", checkout, "rev-parse", "refs/tags/v1^{}"])).toBe(FIRST.oid);
    } finally {
      server.stop(true);
    }
  });

  test("fetches a fast-forward pushed after the clone", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => harness.app.fetch(request),
    });
    const checkout = join(directory, "checkout");

    try {
      await run(["git", "clone", remoteFor(server.port), checkout]);

      const response = await push(
        pushBody({
          commands: [{ oldOid: FIRST.oid, newOid: SECOND.oid, name: MAIN }],
          objects: [SECOND, SECOND_ROOT, REVISED],
        }),
      );
      expect(response.status).toBe(200);

      await run(["git", "-C", checkout, "fetch", "origin"]);

      expect(await run(["git", "-C", checkout, "rev-parse", "origin/main"])).toBe(SECOND.oid);
      expect(await run(["git", "-C", checkout, "show", "origin/main:README.md"])).toBe(
        "Anvil firmware, revised",
      );
    } finally {
      server.stop(true);
    }
  });

  test("fetches after enough divergent local history for Git to gzip negotiation rounds", async () => {
    const encodings: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (request.method === "POST" && request.url.endsWith("/git-upload-pack")) {
          encodings.push(request.headers.get("Content-Encoding"));
        }
        return harness.app.fetch(request);
      },
    });
    const remote = remoteFor(server.port);
    const reader = join(directory, "reader");
    const writer = join(directory, "writer");

    try {
      await run(["git", "clone", remote, reader]);
      await run(["git", "clone", remote, writer]);
      await run(["git", "-C", reader, "config", "user.name", "Open Relic"]);
      await run(["git", "-C", reader, "config", "user.email", "tests@open-relic.dev"]);

      for (let commit = 1; commit <= 120; commit += 1) {
        await run(["git", "-C", reader, "commit", "--allow-empty", "-m", `Local ${commit}`]);
      }

      await run(["git", "-C", writer, "config", "user.name", "Open Relic"]);
      await run(["git", "-C", writer, "config", "user.email", "tests@open-relic.dev"]);
      await writeFile(join(writer, "README.md"), "Anvil firmware, remote\n");
      await run(["git", "-C", writer, "add", "README.md"]);
      await run(["git", "-C", writer, "commit", "-m", "Remote"]);
      const remoteTip = await run(["git", "-C", writer, "rev-parse", "HEAD"]);
      await run(["git", "-C", writer, "push", "origin", "HEAD:main"]);

      await run(["git", "-C", reader, "fetch", "origin"]);

      expect(encodings).toContain("gzip");
      expect(await run(["git", "-C", reader, "rev-parse", "origin/main"])).toBe(remoteTip);
    } finally {
      server.stop(true);
    }
  });
});
