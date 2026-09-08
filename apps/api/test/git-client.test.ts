import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fromHex } from "../src/sha1.ts";
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
let receivePackBodies: Uint8Array[];

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
  receivePackBodies = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const capture = request.url.endsWith("/git-receive-pack")
        ? request
            .clone()
            .arrayBuffer()
            .then((body) => receivePackBodies.push(new Uint8Array(body)))
        : Promise.resolve(0);
      const response = await harness.app.fetch(request);
      await capture;
      return response;
    },
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

  test("rejects a plain non-fast-forward, then accepts it when forced", async () => {
    await commit("Anvil firmware\n", "First");
    await gitSucceeds("push", "--porcelain", remote, "HEAD:refs/heads/main");
    await gitSucceeds("branch", "accepted", "HEAD");

    writeFileSync(join(workingTree, "README.md"), "Anvil firmware, rewritten\n");
    await gitSucceeds("add", "README.md");
    await gitSucceeds("commit", "--quiet", "--amend", "-m", "Rewritten");

    const rejected = await runGit("push", "--porcelain", remote, "HEAD:refs/heads/main");

    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stdout).toContain("[rejected]");
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("non-fast-forward");
    await expectRemoteMainAt("accepted");

    const forced = await runGit("push", "--force", "--porcelain", remote, "HEAD:refs/heads/main");

    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("forced update");
    await expectRemoteMainAt("HEAD");
  });

  test("deletes a ref", async () => {
    await commit("Anvil firmware\n", "First");
    await gitSucceeds(
      "push",
      "--porcelain",
      remote,
      "HEAD:refs/heads/main",
      "HEAD:refs/heads/topic",
    );

    const deleted = await runGit("push", "--porcelain", remote, ":refs/heads/topic");
    const refs = await gitSucceeds("ls-remote", remote, "refs/heads/topic");

    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout).toContain("[deleted]");
    expect(refs).toBe("");
  });

  test("refuses to delete the branch HEAD points at, as a stock Git server does", async () => {
    await commit("Anvil firmware\n", "First");
    await gitSucceeds("push", "--porcelain", remote, "HEAD:refs/heads/main");

    const deleted = await runGit("push", "--porcelain", remote, ":refs/heads/main");
    const refs = await gitSucceeds("ls-remote", remote, "refs/heads/main");

    expect(deleted.exitCode).not.toBe(0);
    expect(deleted.stdout).toContain("deletion of the current branch prohibited");
    expect(refs).toContain("refs/heads/main");
  });

  test("accepts an atomic multi-ref push with push options", async () => {
    await commit("Anvil firmware\n", "First");

    const pushed = await runGit(
      "push",
      "--atomic",
      "--push-option=deploy=production",
      "--porcelain",
      remote,
      "HEAD:refs/heads/main",
      "HEAD:refs/heads/release",
    );

    expect(pushed.exitCode).toBe(0);
    expect(pushed.stdout).toContain("refs/heads/main");
    expect(pushed.stdout).toContain("refs/heads/release");
  });

  test("sends and accepts a thin pack against objects from the previous push", async () => {
    const original = Array.from(
      { length: 5_000 },
      (_, line) => `Anvil firmware line ${line.toString().padStart(4, "0")}\n`,
    ).join("");
    await commit(original, "First");
    await gitSucceeds("push", "--porcelain", remote, "HEAD:refs/heads/main");
    const baseBlob = await gitSucceeds("rev-parse", "HEAD:README.md");

    await commit(original.replace("line 2500", "line 2500 revised"), "Second");
    receivePackBodies = [];
    const pushed = await runGit(
      "-c",
      "pack.window=50",
      "-c",
      "pack.depth=10",
      "push",
      "--porcelain",
      remote,
      "HEAD:refs/heads/main",
    );

    expect(pushed.exitCode).toBe(0);
    const body = receivePackBodies[0];
    expect(body).toBeDefined();
    expect(contains(body!, fromHex(baseBlob))).toBe(true);
    await expectRemoteMainAt("HEAD");
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
    // Every generated object is reachable; omit the unrelated cruft-pack pass
    // so this benchmark measures only the aggressive source pack below.
    await gitSucceeds("gc", "--aggressive", "--no-cruft", "--quiet");
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

const contains = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let at = 0; at <= haystack.length - needle.length; at += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[at + index] !== needle[index]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
};
