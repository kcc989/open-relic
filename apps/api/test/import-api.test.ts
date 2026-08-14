import {
  ARTIFACT_TOKEN_PATTERN,
  ERROR_CODES,
  NAMESPACES_PATH,
  type ImportRepoResult,
  type RepoWithRemote,
} from "../src/contracts.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { concat } from "../src/bytes.ts";
import { pktLine } from "../src/git/pkt-line.ts";
import type { RemoteFetch } from "../src/repository-store.ts";
import { RemoteBranchError } from "../src/repository-store.ts";
import { RepositoryStorageExhaustedError } from "../src/object-store.ts";
import { PackError } from "../src/pack.ts";
import type { Json } from "../src/request-body.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { errorCode, result } from "./support/envelope.ts";
import { blob, commit, tree, treeEntry } from "./support/git-objects.ts";
import { buildPack } from "./support/pack.ts";
import { pushBody } from "./support/receive-pack.ts";

const encoder = new TextEncoder();
const exactBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;
const README = blob("Imported over HTTPS\n");
const ROOT = tree([treeEntry("README.md", README)]);
const FIRST = commit({ tree: ROOT, message: "First" });
const SECOND = commit({ tree: ROOT, parents: [FIRST], message: "Second" });
const MAIN = "refs/heads/main";

const pack = buildPack(
  [README, ROOT, FIRST, SECOND].map((object) => ({
    kind: "object" as const,
    type: object.type,
    bytes: object.bytes,
  })),
).bytes;

const advertisement = (branch = "main", oid = SECOND.oid): Uint8Array =>
  concat(
    pktLine("# service=git-upload-pack\n"),
    encoder.encode("0000"),
    pktLine("version 1\n"),
    pktLine(`${oid} HEAD\0symref=HEAD:refs/heads/${branch} shallow ofs-delta object-format=sha1\n`),
    pktLine(`${oid} refs/heads/${branch}\n`),
    encoder.encode("0000"),
  );

const gitRemote =
  (
    options: {
      readonly branch?: string;
      readonly shallow?: readonly string[];
      readonly onRequest?: (request: Request) => void | Promise<void>;
    } = {},
  ): RemoteFetch =>
  async (input, init) => {
    const request = new Request(input, init);
    await options.onRequest?.(request);
    if (request.method === "GET") {
      return new Response(exactBuffer(advertisement(options.branch)), {
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      });
    }
    return new Response(
      exactBuffer(
        concat(
          ...(options.shallow ?? []).map((oid) => pktLine(`shallow ${oid}\n`)),
          ...(options.shallow === undefined ? [] : [encoder.encode("0000")]),
          pktLine("NAK\n"),
          pack,
        ),
      ),
      { headers: { "Content-Type": "application/x-git-upload-pack-result" } },
    );
  };

let harness: TestApp;

beforeEach(async () => {
  harness = createTestApp();
  await harness.app.request(
    new Request(`http://local.test${NAMESPACES_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "acme" }),
    }),
  );
});

afterEach(() => {
  harness.close();
});

const importRepository = (name: string, body: Json) =>
  harness.app.request(
    new Request(`http://local.test/namespaces/acme/repos/${name}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /namespaces/:namespace/repos/:repo/import", () => {
  test("imports a full public branch and returns the hosted create-result shape", async () => {
    harness.objects.queueImportFetch(gitRemote({ branch: "trunk" }));

    const response = await importRepository("mirror", { url: "https://git.example/acme/project" });
    const imported = await result<ImportRepoResult>(response);

    expect(response.status).toBe(201);
    expect(Object.keys(imported).sort()).toEqual(
      [
        "default_branch",
        "description",
        "id",
        "name",
        "objects",
        "remote",
        "source",
        "token",
      ].sort(),
    );
    expect(imported).toMatchObject({
      name: "mirror",
      description: null,
      default_branch: "trunk",
      objects: 4,
      remote: "http://local.test/git/acme/mirror.git",
      source: "git:https://git.example/acme/project.git",
    });
    expect(imported.token).toMatch(ARTIFACT_TOKEN_PATTERN);
    const expires = Number(new URLSearchParams(imported.token.split("?")[1]).get("expires"));
    expect(expires - Math.floor(Date.now() / 1000)).toBeWithin(86_399, 86_401);

    const stored = await result<RepoWithRemote>(
      await harness.app.request("http://local.test/namespaces/acme/repos/mirror"),
    );
    expect(stored).toMatchObject({ default_branch: "trunk", source: imported.source });
  });

  test("uses URL credentials for the fetch but never persists or returns them", async () => {
    const requested: string[] = [];
    harness.objects.queueImportFetch(
      gitRemote({ onRequest: (request) => void requested.push(request.url) }),
    );

    const response = await importRepository("mirror", {
      url: "https://git.example/acme/project?access_token=top-secret#fragment",
    });
    const imported = await result<ImportRepoResult>(response);

    expect(response.status).toBe(201);
    expect(requested).toHaveLength(2);
    expect(requested.every((url) => url.includes("access_token=top-secret"))).toBe(true);
    expect(imported.source).toBe("git:https://git.example/acme/project.git");
    expect(JSON.stringify(imported)).not.toContain("top-secret");

    const stored = await result<RepoWithRemote>(
      await harness.app.request("http://local.test/namespaces/acme/repos/mirror"),
    );
    expect(stored.source).toBe(imported.source);
    expect(JSON.stringify(stored)).not.toContain("top-secret");
    expect(
      await (await harness.app.request("http://local.test/namespaces/acme/repos")).text(),
    ).not.toContain("top-secret");
  });

  test("passes a positive depth through and preserves the shallow boundary", async () => {
    let negotiation = "";
    harness.objects.queueImportFetch(
      gitRemote({
        shallow: [FIRST.oid],
        onRequest: async (request) => {
          if (request.method === "POST") negotiation = await request.text();
        },
      }),
    );

    const response = await importRepository("shallow", {
      url: "https://git.example/acme/project.git",
      depth: 1,
    });

    expect(response.status).toBe(201);
    expect(negotiation).toContain("deepen 1\n");
    const targetId = harness.objects.mintedIds.at(-1)!;
    const advertised = await new Response(
      await harness.objects.get(targetId).advertiseUploadPack(1),
    ).text();
    expect(advertised).toContain(`shallow ${FIRST.oid}\n`);
  });

  test("reserves the target as importing before remote work and rejects duplicates", async () => {
    let release = (): void => {};
    let started = (): void => {};
    const captured = new Promise<void>((resolve) => {
      started = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = gitRemote();
    harness.objects.queueImportFetch(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        started();
        await paused;
      }
      return remote(input, init);
    });

    const pending = importRepository("mirror", { url: "https://git.example/acme/project.git" });
    await captured;

    const targeted = await harness.app.request("http://local.test/namespaces/acme/repos/mirror");
    const duplicate = await importRepository("mirror", {
      url: "https://git.example/acme/project.git",
    });
    expect(targeted.status).toBe(409);
    expect(await errorCode(targeted)).toBe(ERROR_CODES.importInProgress);
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe(ERROR_CODES.alreadyExists);

    release();
    expect((await pending).status).toBe(201);
  });

  test("an old import cannot publish or remove a re-import with the same name", async () => {
    let oldStarted = (): void => {};
    let releaseOld = (): void => {};
    const oldCaptured = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const oldPaused = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let newStarted = (): void => {};
    let releaseNew = (): void => {};
    const newCaptured = new Promise<void>((resolve) => {
      newStarted = resolve;
    });
    const newPaused = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const remote = gitRemote();
    harness.objects.queueImportFetch(
      async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          oldStarted();
          await oldPaused;
        }
        return remote(input, init);
      },
      async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          newStarted();
          await newPaused;
        }
        return remote(input, init);
      },
    );

    const oldImport = importRepository("mirror", { url: "https://git.example/old" });
    await oldCaptured;
    const deletion = harness.app.request(
      new Request("http://local.test/namespaces/acme/repos/mirror", { method: "DELETE" }),
    );

    let absent = await harness.app.request("http://local.test/namespaces/acme/repos/mirror");
    for (let attempt = 0; absent.status !== 404 && attempt < 20; attempt += 1) {
      await Bun.sleep(1);
      absent = await harness.app.request("http://local.test/namespaces/acme/repos/mirror");
    }
    expect(absent.status).toBe(404);

    const newImport = importRepository("mirror", { url: "https://git.example/new" });
    await newCaptured;
    releaseOld();

    expect((await oldImport).status).toBe(500);
    expect((await deletion).status).toBe(202);
    const replacement = await harness.app.request("http://local.test/namespaces/acme/repos/mirror");
    expect(replacement.status).toBe(409);
    expect(await errorCode(replacement)).toBe(ERROR_CODES.importInProgress);

    releaseNew();
    expect((await newImport).status).toBe(201);
    const ready = await result<RepoWithRemote>(
      await harness.app.request("http://local.test/namespaces/acme/repos/mirror"),
    );
    expect(ready.source).toBe("git:https://git.example/new.git");
  });

  test("restarts a transient failure from scratch and succeeds on the next attempt", async () => {
    let calls = 0;
    harness.objects.queueImportFetch(
      async () => {
        calls += 1;
        throw new Error("temporary network failure");
      },
      async (input, init) => {
        calls += 1;
        return gitRemote()(input, init);
      },
    );

    const response = await importRepository("mirror", { url: "https://git.example/acme/project" });

    expect(response.status).toBe(201);
    expect(calls).toBe(3); // one failed GET, then GET + POST on the complete retry
  });

  test("stops after three transient attempts and cleans up the target", async () => {
    let attempts = 0;
    const unavailable: RemoteFetch = async () => {
      attempts += 1;
      throw new Error("temporary network failure");
    };
    harness.objects.queueImportFetch(unavailable, unavailable, unavailable);

    const response = await importRepository("mirror", { url: "https://git.example/acme/project" });

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe(ERROR_CODES.upstreamUnavailable);
    expect(attempts).toBe(3);
    expect(
      (await harness.app.request("http://local.test/namespaces/acme/repos/mirror")).status,
    ).toBe(404);
  });

  test("continues the scheduled import after the initiating client disconnects", async () => {
    let release = (): void => {};
    let started = (): void => {};
    const captured = new Promise<void>((resolve) => {
      started = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = gitRemote();
    harness.objects.queueImportFetch(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        started();
        await paused;
      }
      return remote(input, init);
    });

    const server = Bun.serve({ port: 0, fetch: (request) => harness.app.fetch(request) });
    const controller = new AbortController();
    const initiating = fetch(new URL("/namespaces/acme/repos/mirror/import", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://git.example/acme/project" }),
      signal: controller.signal,
    }).catch(() => null);

    try {
      await captured;
      controller.abort();
      release();
      await initiating;

      let response = await harness.app.request("http://local.test/namespaces/acme/repos/mirror");
      for (let attempt = 0; response.status === 409 && attempt < 20; attempt += 1) {
        await Bun.sleep(1);
        response = await harness.app.request("http://local.test/namespaces/acme/repos/mirror");
      }
      expect(response.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("destroys terminal and storage-exhausted targets so their names can be reused", async () => {
    harness.objects.queueImportFailure(new RepositoryStorageExhaustedError());
    const failed = await importRepository("mirror", { url: "https://git.example/acme/project" });

    expect(failed.status).toBe(500);
    expect(
      (await harness.app.request("http://local.test/namespaces/acme/repos/mirror")).status,
    ).toBe(404);
    expect(harness.objects.liveIds).toEqual([]);

    harness.objects.queueImportFetch(gitRemote());
    expect(
      (await importRepository("mirror", { url: "https://git.example/acme/project" })).status,
    ).toBe(201);
  });

  test("enforces read_only after success even with the one-time write token", async () => {
    harness.objects.queueImportFetch(gitRemote());
    const imported = await result<ImportRepoResult>(
      await importRepository("mirror", {
        url: "https://git.example/acme/project",
        read_only: true,
      }),
    );

    const response = await harness.app.request(
      new Request("http://local.test/git/acme/mirror.git/git-receive-pack", {
        method: "POST",
        headers: { Authorization: `Bearer ${imported.token}` },
        body: pushBody({ commands: [{ name: MAIN }] }),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("maps the probed validation and hosted remote failures", async () => {
    const invalidScheme = await importRepository("scheme", { url: "http://git.example/project" });
    const invalidDepth = await importRepository("depth", {
      url: "https://git.example/project",
      depth: 0,
    });
    expect(await errorCode(invalidScheme)).toBe(ERROR_CODES.invalidInput);
    expect(await errorCode(invalidDepth)).toBe(ERROR_CODES.invalidInput);

    harness.objects.queueImportFetch(
      async () => new Response("html", { headers: { "Content-Type": "text/html" } }),
    );
    expect(
      await errorCode(await importRepository("html", { url: "https://git.example/project" })),
    ).toBe(ERROR_CODES.invalidUrl);

    harness.objects.queueImportFetch(gitRemote());
    expect(
      await errorCode(
        await importRepository("branch", {
          url: "https://git.example/project",
          branch: "missing",
        }),
      ),
    ).toBe(ERROR_CODES.branchNotFound);

    harness.objects.queueImportFetch(async () => new Response(null, { status: 401 }));
    expect(
      await errorCode(await importRepository("private", { url: "https://git.example/project" })),
    ).toBe(ERROR_CODES.remoteAuthRequired);
  });

  test("does not consume all three attempts for a terminal remote error", async () => {
    harness.objects.queueImportFailure(
      new RemoteBranchError("invalid-advertisement", "not a Git remote"),
    );
    const response = await importRepository("mirror", { url: "https://git.example/project" });
    expect(await errorCode(response)).toBe(ERROR_CODES.invalidUrl);
    expect(harness.objects.mintedIds).toHaveLength(1);
  });

  test("maps malformed packs to invalidInput and oversized objects to memoryLimit", async () => {
    harness.objects.queueImportFailure(new PackError("truncated", "The pack ended early."));
    const malformed = await importRepository("malformed", {
      url: "https://git.example/project",
    });

    harness.objects.queueImportFailure(
      new PackError("object-too-large", "The object exceeds the repository object limit."),
    );
    const oversized = await importRepository("oversized", {
      url: "https://git.example/project",
    });

    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe(ERROR_CODES.invalidInput);
    expect(oversized.status).toBe(400);
    expect(await errorCode(oversized)).toBe(ERROR_CODES.memoryLimit);
  });
});
