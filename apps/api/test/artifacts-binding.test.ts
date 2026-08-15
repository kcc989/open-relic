import { ArtifactsError, createOpenRelicArtifacts } from "@openrelic/alchemy/worker";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ArtifactsBindingService,
  invokeArtifactsBinding,
} from "../src/artifacts-binding-service.ts";
import { concat } from "../src/bytes.ts";
import { ERROR_CODES } from "../src/contracts.ts";
import { pktLine } from "../src/git/pkt-line.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { blob, commit, tree, treeEntry } from "./support/git-objects.ts";
import { buildPack } from "./support/pack.ts";

const encoder = new TextEncoder();
const readme = blob("Imported through the binding\n");
const root = tree([treeEntry("README.md", readme)]);
const head = commit({ tree: root, message: "Initial" });
const importPack = buildPack(
  [readme, root, head].map((object) => ({
    kind: "object" as const,
    type: object.type,
    bytes: object.bytes,
  })),
).bytes;
const exactBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;
const bindingRemote = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  if (request.method === "GET") {
    return new Response(
      exactBuffer(
        concat(
          pktLine("# service=git-upload-pack\n"),
          encoder.encode("0000"),
          pktLine("version 1\n"),
          pktLine(`${head.oid} HEAD\0symref=HEAD:refs/heads/trunk object-format=sha1\n`),
          pktLine(`${head.oid} refs/heads/trunk\n`),
          encoder.encode("0000"),
        ),
      ),
      { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } },
    );
  }
  return new Response(exactBuffer(concat(pktLine("NAK\n"), importPack)), {
    headers: { "Content-Type": "application/x-git-upload-pack-result" },
  });
};

let harness: TestApp;
let binding: ArtifactsBindingService;
let now: Date;

beforeEach(() => {
  now = new Date("2026-08-15T12:00:00.000Z");
  harness = createTestApp(() => now);
  binding = new ArtifactsBindingService(
    { namespace: "acme", publicUrl: "https://relic.example.com/control-plane" },
    {
      namespaces: harness.namespaces,
      repositories: harness.repositories,
      objects: harness.objects,
      tokens: harness.tokens,
    },
  );
});

afterEach(() => {
  harness.close();
});

describe("ArtifactsBindingService", () => {
  test("implicitly creates its namespace and returns the Workers create shape", async () => {
    const created = await binding.create("demo", {
      description: "A demo",
      readOnly: true,
      setDefaultBranch: "trunk",
    });

    expect(await harness.namespaces.getNamespace("acme")).not.toBeNull();
    expect(created).toMatchObject({
      name: "demo",
      description: "A demo",
      defaultBranch: "trunk",
      remote: "https://relic.example.com/git/acme/demo.git",
      tokenExpiresAt: "2026-08-16T12:00:00.000Z",
    });
    expect(Object.keys(created).sort()).toEqual([
      "defaultBranch",
      "description",
      "id",
      "name",
      "remote",
      "token",
      "tokenExpiresAt",
    ]);

    const repo = await binding.get("demo");
    expect(repo).toMatchObject({
      name: "demo",
      defaultBranch: "trunk",
      readOnly: true,
      lastPushAt: null,
      source: null,
      remote: "https://relic.example.com/git/acme/demo.git",
    });
    expect(Date.parse(repo.createdAt)).not.toBeNaN();
    expect(repo.updatedAt).toBe(repo.createdAt);
  });

  test("lists with cursor pagination and an unpaged total", async () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      await binding.create(name);
      now = new Date(now.getTime() + 1_000);
    }

    const first = await binding.list({ limit: 2 });
    expect(first.cursor).toBeString();
    const second = await binding.list({ limit: 2, cursor: first.cursor! });

    expect(first.repos.map((repo) => repo.name)).toEqual(["gamma", "beta"]);
    expect(first.total).toBe(3);
    expect(first.repos[0]).not.toHaveProperty("remote");
    expect(second.repos.map((repo) => repo.name)).toEqual(["alpha"]);
    expect(second.total).toBe(3);
    expect(second.cursor).toBeUndefined();
  });

  test("returns an empty list before the implicit namespace exists", async () => {
    expect(await binding.list()).toEqual({ repos: [], total: 0 });
  });

  test("manages repository-scoped tokens and revokes by plaintext or id", async () => {
    await binding.create("demo");
    const repo = await binding.get("demo");
    const plaintext = await repo.createToken("read", 3_600);
    const byId = await repo.createToken("write", 7_200);

    expect(plaintext).toMatchObject({
      scope: "read",
      expiresAt: "2026-08-15T13:00:00.000Z",
    });
    expect((await repo.listTokens()).total).toBe(3);
    expect(await repo.revokeToken(plaintext.plaintext)).toBe(true);
    expect(await repo.revokeToken(byId.id)).toBe(true);
    expect(await repo.revokeToken(byId.id)).toBe(true);

    const tokens = await repo.listTokens();
    expect(tokens.tokens.find((token) => token.id === plaintext.id)?.state).toBe("revoked");
    expect(tokens.tokens.find((token) => token.id === byId.id)?.state).toBe("revoked");
  });

  test("forks through the repository handle and defaults to one branch", async () => {
    await binding.create("source");
    const source = await binding.get("source");
    const fork = await source.fork("copy");

    expect(fork).toMatchObject({
      name: "copy",
      defaultBranch: "main",
      remote: "https://relic.example.com/git/acme/copy.git",
    });
    expect((await binding.get("copy")).source).toBe("acme/source");
  });

  test("imports a public Git branch and returns the Workers result shape", async () => {
    harness.objects.queueImportFetch(bindingRemote);

    const imported = await binding.import({
      source: { url: "https://git.example/acme/project" },
      target: { name: "mirror", opts: { description: "Mirror" } },
    });

    expect(imported).toMatchObject({
      name: "mirror",
      description: "Mirror",
      defaultBranch: "trunk",
      remote: "https://relic.example.com/git/acme/mirror.git",
    });
    expect((await binding.get("mirror")).source).toBe("git:https://git.example/acme/project.git");
  });

  test("deletes idempotently", async () => {
    await binding.create("demo");

    expect(await binding.delete("demo")).toBe(true);
    expect(await binding.delete("demo")).toBe(false);
    expect(harness.objects.liveIds).toEqual([]);
  });

  test("throws binding-compatible error codes", async () => {
    await binding.create("demo");

    const duplicate = binding.create("demo");
    await expect(duplicate).rejects.toMatchObject({
      name: "ArtifactsError",
      code: "ALREADY_EXISTS",
      numericCode: ERROR_CODES.alreadyExists,
    });
    await expect(binding.get("missing")).rejects.toBeInstanceOf(ArtifactsError);
    await expect(binding.create("Bad Name")).rejects.toMatchObject({
      code: "INVALID_REPO_NAME",
      numericCode: ERROR_CODES.invalidRepoName,
    });
    const repo = await binding.get("demo");
    await expect(repo.createToken("write", 1)).rejects.toMatchObject({
      code: "INVALID_TTL",
      numericCode: ERROR_CODES.invalidTtl,
    });
    await expect(repo.revokeToken("")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      numericCode: ERROR_CODES.invalidInput,
    });
  });

  test("revives error properties through the tagged RPC transport", async () => {
    const client = createOpenRelicArtifacts({
      invoke: (request) => invokeArtifactsBinding(binding, request),
    });
    await client.create("demo");

    await expect(client.create("demo")).rejects.toMatchObject({
      name: "ArtifactsError",
      code: "ALREADY_EXISTS",
      numericCode: ERROR_CODES.alreadyExists,
    });
    const repo = await client.get("demo");
    await expect(repo.createToken("write", 1)).rejects.toMatchObject({
      name: "ArtifactsError",
      code: "INVALID_TTL",
      numericCode: ERROR_CODES.invalidTtl,
    });
  });
});
