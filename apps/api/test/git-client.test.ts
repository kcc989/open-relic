import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitTestApp, type TestApp } from "./support/app.ts";

const git = Bun.which("git");

if (git === null) {
  throw new Error("Real Git compatibility tests require a git executable on PATH.");
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let harness: TestApp;
let server: ReturnType<typeof Bun.serve>;
let workingTree: string;
let remote: string;

const runGitAt = async (cwd: string, ...args: readonly string[]): Promise<GitResult> => {
  const child = Bun.spawn([git, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const runGit = (...args: readonly string[]): Promise<GitResult> => runGitAt(workingTree, ...args);

const gitSucceeds = async (...args: readonly string[]): Promise<string> => {
  const result = await runGit(...args);

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }

  return result.stdout.trim();
};

const gitSucceedsAt = async (cwd: string, ...args: readonly string[]): Promise<string> => {
  const result = await runGitAt(cwd, ...args);

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }

  return result.stdout.trim();
};

const packedBytes = (gitDirectory: string): number => {
  const directory = join(gitDirectory, "objects", "pack");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".pack"))
    .reduce((total, name) => total + statSync(join(directory, name)).size, 0);
};

const countingStream = (
  source: ReadableStream<Uint8Array>,
  count: (bytes: number) => void,
): ReadableStream<Uint8Array> =>
  source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        count(chunk.length);
        controller.enqueue(chunk);
      },
    }),
  );

const commit = async (contents: string, message: string): Promise<void> => {
  writeFileSync(join(workingTree, "README.md"), contents);
  await gitSucceeds("add", "README.md");
  await gitSucceeds("commit", "--quiet", "-m", message);
};

const expectRemoteMainAt = async (source: string): Promise<void> => {
  // `ls-remote` speaks upload-pack, which Open Relic does not implement yet.
  // A dry-run push asks receive-pack for its real advertisement, and Git calls
  // the ref up to date only when the advertised object id equals `source`.
  const result = await runGit(
    "push",
    "--dry-run",
    "--porcelain",
    remote,
    `${source}:refs/heads/main`,
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("[up to date]");
};

beforeEach(async () => {
  harness = await createGitTestApp();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => harness.app.fetch(request),
  });

  workingTree = mkdtempSync(join(tmpdir(), "open-relic-git-client-"));
  const repositoryToken = harness.repositoryToken;
  if (repositoryToken === null) {
    throw new Error("The Git test repository did not return a credential.");
  }

  const remoteUrl = new URL("/git/acme/demo.git", server.url);
  remoteUrl.username = "x";
  remoteUrl.password = repositoryToken.split("?expires=")[0]!;
  remote = remoteUrl.toString();

  await gitSucceeds("init", "--quiet", "--initial-branch=main");
  await gitSucceeds("config", "user.name", "Open Relic Test");
  await gitSucceeds("config", "user.email", "open-relic-test@example.invalid");
});

afterEach(() => {
  server.stop(true);
  harness.close();
  rmSync(workingTree, { recursive: true, force: true });
});

describe("a real Git client over Smart HTTP", () => {
  test("pushes a commit and observes the ref move", async () => {
    await commit("Anvil firmware\n", "First");

    const push = await runGit("push", "--porcelain", remote, "HEAD:refs/heads/main");

    expect(push.exitCode).toBe(0);
    expect(push.stdout).toContain("[new branch]");
    await expectRemoteMainAt("HEAD");
  });

  test("rejects a forced non-fast-forward push without moving the ref", async () => {
    await commit("Anvil firmware\n", "First");
    await gitSucceeds("push", "--porcelain", remote, "HEAD:refs/heads/main");
    await gitSucceeds("branch", "accepted", "HEAD");

    writeFileSync(join(workingTree, "README.md"), "Anvil firmware, rewritten\n");
    await gitSucceeds("add", "README.md");
    await gitSucceeds("commit", "--quiet", "--amend", "-m", "Rewritten");

    const rejected = await runGit("push", "--force", "--porcelain", remote, "HEAD:refs/heads/main");

    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stdout).toContain("[remote rejected]");
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("non-fast-forward");
    await expectRemoteMainAt("accepted");
  });

  test("keeps a real repository's fresh-clone pack within four times its compact source and push packs", async () => {
    let pushWireBytes = 0;
    let cloneWireBytes = 0;

    server.stop(true);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        let forwarded = request;
        if (request.body !== null && request.url.endsWith("/git-receive-pack")) {
          forwarded = new Request(request, {
            body: countingStream(request.body, (bytes) => {
              pushWireBytes += bytes;
            }),
            method: request.method,
          });
        }

        const response = await harness.app.fetch(forwarded);
        if (response.body === null || !request.url.endsWith("/git-upload-pack")) {
          return response;
        }

        return new Response(
          countingStream(response.body, (bytes) => {
            cloneWireBytes += bytes;
          }),
          { headers: response.headers, status: response.status, statusText: response.statusText },
        );
      },
    });

    const remoteUrl = new URL("/git/acme/demo.git", server.url);
    remoteUrl.username = "x";
    remoteUrl.password = harness.repositoryToken?.split("?expires=")[0] ?? "";
    remote = remoteUrl.toString();

    const contents = new Uint8Array(256 * 1_024);
    let random = 0x6d2b79f5;
    for (let index = 0; index < contents.length; index += 1) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      contents[index] = random & 0xff;
    }

    for (let revision = 0; revision < 48; revision += 1) {
      const changed = (revision * 7_919) % contents.length;
      contents[changed] = contents[changed]! ^ (revision + 1);
      writeFileSync(join(workingTree, "firmware.bin"), contents);
      await gitSucceeds("add", "firmware.bin");
      await gitSucceeds("commit", "--quiet", "-m", `Revision ${revision}`);
    }

    const sourceSha = await gitSucceeds("rev-parse", "HEAD");
    await gitSucceeds("gc", "--aggressive", "--quiet");
    const sourcePackBytes = packedBytes(join(workingTree, ".git"));
    await gitSucceeds("push", "--porcelain", remote, "HEAD:refs/heads/main");

    const checkout = join(workingTree, "fresh-clone");
    await gitSucceeds("clone", "--quiet", remote, checkout);
    const clonePackBytes = packedBytes(join(checkout, ".git"));

    console.info(
      "fresh clone pack benchmark",
      JSON.stringify({ sourcePackBytes, pushWireBytes, cloneWireBytes, clonePackBytes }),
    );

    expect(cloneWireBytes).toBeLessThan(pushWireBytes * 4);
    expect(clonePackBytes).toBeLessThan(sourcePackBytes * 4);
    expect(await gitSucceedsAt(checkout, "rev-parse", "HEAD")).toBe(sourceSha);
    expect(await gitSucceedsAt(checkout, "fsck", "--full")).toBe("");
  }, 30_000);
});
