import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NAMESPACES_PATH, type CreateTokenResult } from "@open-relic/contracts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createGitTestApp, type TestApp } from "./support/app.ts";
import { result } from "./support/envelope.ts";
import { blob, commit, tag, tree, treeEntry } from "./support/git-objects.ts";
import { pushBody } from "./support/receive-pack.ts";

const README = blob("Anvil firmware\n");
const ROOT = tree([treeEntry("README.md", README)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const V1 = tag({ target: FIRST, name: "v1" });
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

const remoteFor = (port: number | undefined, token = harness.repositoryToken): string => {
  if (token === null) {
    throw new Error("The Git test repository has no token.");
  }
  if (port === undefined) {
    throw new Error("The Git test server has no port.");
  }
  return `http://x:${encodeURIComponent(token)}@127.0.0.1:${port}/git/acme/demo.git`;
};

const createReadToken = async () =>
  result<CreateTokenResult>(
    await harness.app.request(
      new Request(`http://local.test${NAMESPACES_PATH}/acme/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "demo", scope: "read" }),
      }),
    ),
  );

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
  test("clones with a read-scoped token and checks out HEAD", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => harness.app.fetch(request),
    });
    const checkout = join(directory, "checkout");
    const readToken = await createReadToken();

    try {
      await run([
        "git",
        "-c",
        "protocol.version=1",
        "clone",
        remoteFor(server.port, readToken.plaintext),
        checkout,
      ]);

      expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("Anvil firmware\n");
      expect(await run(["git", "-C", checkout, "rev-parse", "HEAD"])).toBe(FIRST.oid);
      expect(await run(["git", "-C", checkout, "rev-parse", "refs/tags/v1^{}"])).toBe(FIRST.oid);
      expect(await run(["git", "-C", checkout, "fsck", "--full"])).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("clones a pushed repository with protocol v2", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => harness.app.fetch(request),
    });
    const checkout = join(directory, "checkout-v2");

    try {
      await run(["git", "-c", "protocol.version=2", "clone", remoteFor(server.port), checkout]);

      expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("Anvil firmware\n");
      expect(await run(["git", "-C", checkout, "rev-parse", "HEAD"])).toBe(FIRST.oid);
      expect(await run(["git", "-C", checkout, "rev-parse", "refs/tags/v1^{}"])).toBe(FIRST.oid);
      expect(await run(["git", "-C", checkout, "fsck", "--full"])).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("depth-clones and subsequently fetches from a shallow repository", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => harness.app.fetch(request),
    });
    const writer = join(directory, "writer");
    const reader = join(directory, "reader");
    const readerV2 = join(directory, "reader-v2");

    try {
      await run(["git", "clone", remoteFor(server.port), writer]);
      await run(["git", "-C", writer, "config", "user.name", "Open Relic"]);
      await run(["git", "-C", writer, "config", "user.email", "tests@open-relic.dev"]);
      await writeFile(join(writer, "README.md"), "Anvil firmware, second\n");
      await run(["git", "-C", writer, "add", "README.md"]);
      await run(["git", "-C", writer, "commit", "-m", "Second"]);
      await writeFile(join(writer, "README.md"), "Anvil firmware, third\n");
      await run(["git", "-C", writer, "add", "README.md"]);
      await run(["git", "-C", writer, "commit", "-m", "Third"]);
      await run(["git", "-C", writer, "push", "origin", "HEAD:main"]);

      const [durableObjectId] = harness.objects.mintedIds;
      await harness.objects.seedShallowCommits(durableObjectId!, [FIRST.oid]);

      await run([
        "git",
        "-c",
        "protocol.version=1",
        "clone",
        "--depth=1",
        remoteFor(server.port),
        reader,
      ]);
      expect(await run(["git", "-C", reader, "rev-list", "--count", "HEAD"])).toBe("1");
      await run(["git", "-c", "protocol.version=2", "clone", remoteFor(server.port), readerV2]);
      expect(await run(["git", "-C", readerV2, "rev-list", "--count", "HEAD"])).toBe("3");
      expect((await readFile(join(readerV2, ".git", "shallow"), "utf8")).trim()).toBe(FIRST.oid);

      await writeFile(join(writer, "README.md"), "Anvil firmware, fourth\n");
      await run(["git", "-C", writer, "add", "README.md"]);
      await run(["git", "-C", writer, "commit", "-m", "Fourth"]);
      const remoteTip = await run(["git", "-C", writer, "rev-parse", "HEAD"]);
      await run(["git", "-C", writer, "push", "origin", "HEAD:main"]);

      await run(["git", "-c", "protocol.version=1", "-C", reader, "fetch", "origin"]);
      await run(["git", "-c", "protocol.version=1", "-C", readerV2, "fetch", "origin"]);

      expect(await run(["git", "-C", reader, "rev-parse", "origin/main"])).toBe(remoteTip);
      expect(await run(["git", "-C", reader, "show", "origin/main:README.md"])).toBe(
        "Anvil firmware, fourth",
      );
      expect(await run(["git", "-C", readerV2, "rev-parse", "origin/main"])).toBe(remoteTip);

      await run(["git", "-c", "protocol.version=1", "-C", reader, "fetch", "--depth=3", "origin"]);
      expect(await run(["git", "-C", reader, "rev-list", "--count", "origin/main"])).toBe("3");
    } finally {
      server.stop(true);
    }
  });

  test("fetches a coalesced multi-round response after a fast-forward push", async () => {
    let coalesceUploadPackResponses = false;
    let uploadPackRounds = 0;
    let acknowledgedNegotiationRounds = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const uploadPackRequest =
          coalesceUploadPackResponses &&
          request.method === "POST" &&
          request.url.endsWith("/git-upload-pack")
            ? new Uint8Array(await request.clone().arrayBuffer())
            : null;
        const response = await harness.app.fetch(request);
        if (uploadPackRequest !== null) {
          uploadPackRounds += 1;
          const uploadPackResponse = new Uint8Array(await response.arrayBuffer());
          const requestText = new TextDecoder().decode(uploadPackRequest);
          const responseText = new TextDecoder().decode(uploadPackResponse);
          if (!requestText.includes("done\n") && responseText.includes("ACK ")) {
            acknowledgedNegotiationRounds += 1;
          }
          return new Response(uploadPackResponse, response);
        }
        return response;
      },
    });
    const remote = remoteFor(server.port);
    const writer = join(directory, "writer");
    const reader = join(directory, "reader");

    try {
      await run(["git", "clone", remote, writer]);
      await run(["git", "-C", writer, "config", "user.name", "Open Relic"]);
      await run(["git", "-C", writer, "config", "user.email", "tests@open-relic.dev"]);
      for (let commit = 1; commit <= 80; commit += 1) {
        await run(["git", "-C", writer, "commit", "--allow-empty", "-m", `Remote ${commit}`]);
      }
      await run(["git", "-C", writer, "push", "origin", "HEAD:main"]);

      await run(["git", "clone", remote, reader]);
      await run(["git", "-C", reader, "config", "user.name", "Open Relic"]);
      await run(["git", "-C", reader, "config", "user.email", "tests@open-relic.dev"]);
      for (let commit = 1; commit <= 40; commit += 1) {
        await run(["git", "-C", reader, "commit", "--allow-empty", "-m", `Local ${commit}`]);
      }

      await writeFile(join(writer, "README.md"), "Anvil firmware, remote\n");
      await run(["git", "-C", writer, "add", "README.md"]);
      await run(["git", "-C", writer, "commit", "-m", "New remote tip"]);
      const remoteTip = await run(["git", "-C", writer, "rev-parse", "HEAD"]);
      await run(["git", "-C", writer, "push", "origin", "HEAD:main"]);

      coalesceUploadPackResponses = true;
      await run(["git", "-C", reader, "fetch", "origin"]);

      expect(uploadPackRounds).toBeGreaterThanOrEqual(2);
      expect(acknowledgedNegotiationRounds).toBeGreaterThanOrEqual(1);
      expect(await run(["git", "-C", reader, "rev-parse", "origin/main"])).toBe(remoteTip);
      expect(await run(["git", "-C", reader, "show", "origin/main:README.md"])).toBe(
        "Anvil firmware, remote",
      );
    } finally {
      server.stop(true);
    }
  });

  test("fetches after enough divergent local history for several negotiation rounds", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => harness.app.fetch(request),
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

      expect(await run(["git", "-C", reader, "rev-parse", "origin/main"])).toBe(remoteTip);
    } finally {
      server.stop(true);
    }
  });
});
