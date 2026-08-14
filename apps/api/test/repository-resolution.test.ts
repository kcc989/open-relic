import { ERROR_CODES, type RepoInfo } from "@open-relic/contracts";
import { describe, expect, test } from "bun:test";

import type { AuthorizeGitRequest } from "../src/git/authorization.ts";
import type { RepositoryIndexClient, RepositoryPointer } from "../src/repository-index.ts";
import { createRepositoryResolver } from "../src/repository-resolution.ts";
import { errorCode } from "./support/envelope.ts";
import { envWithApiToken } from "./support/env.ts";

const env = envWithApiToken();
const repository: RepoInfo = {
  id: "repo_demo",
  name: "demo",
  description: null,
  default_branch: "main",
  created_at: "2026-08-13T12:00:00.000Z",
  updated_at: "2026-08-13T12:00:00.000Z",
  last_push_at: null,
  source: null,
  read_only: false,
};

const pointer = (status: RepositoryPointer["status"] = "ready"): RepositoryPointer => ({
  repository,
  durableObjectId: "repository-object-1",
  status,
});

const resolver = (
  found: RepositoryPointer | null,
  authorize: AuthorizeGitRequest = async () => ({ allowed: true }),
) => {
  let lookups = 0;
  const unused = (): never => {
    throw new Error("This repository-index operation is outside the resolver test.");
  };
  const index: RepositoryIndexClient = {
    createRepository: unused,
    listRepositories: unused,
    getRepository: async () => {
      lookups += 1;
      return found;
    },
    deleteRepository: unused,
    deleteImportIfOwned: unused,
    finishFork: unused,
    finishImport: unused,
    recordPush: unused,
  };

  return {
    resolver: createRepositoryResolver(() => index, authorize),
    lookups: () => lookups,
  };
};

const responseFrom = (resolution: RepositoryPointer | Response): Response => {
  expect(resolution).toBeInstanceOf(Response);
  if (!(resolution instanceof Response)) {
    throw new Error("Expected repository resolution to be refused.");
  }
  return resolution;
};

describe("RepositoryResolver", () => {
  test("resolves a ready repository for the REST control plane without Git authorization", async () => {
    let authorizations = 0;
    const { resolver: subject } = resolver(pointer(), async () => {
      authorizations += 1;
      return { allowed: true };
    });

    const resolved = await subject.resolve({ env, namespace: "acme", name: "demo" });

    expect(resolved).toEqual(pointer());
    expect(authorizations).toBe(0);
  });

  test("owns the canonical missing-repository refusal", async () => {
    const { resolver: subject } = resolver(null);

    const resolved = await subject.resolve({ env, namespace: "acme", name: "nope" });

    const response = responseFrom(resolved);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(ERROR_CODES.notFound);
  });

  test("owns the canonical fork-in-progress refusal", async () => {
    const { resolver: subject } = resolver(pointer("forking"));

    const resolved = await subject.resolve({ env, namespace: "acme", name: "demo" });

    const response = responseFrom(resolved);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe(ERROR_CODES.forkInProgress);
  });

  test("owns the canonical import-in-progress refusal", async () => {
    const { resolver: subject } = resolver(pointer("importing"));

    const resolved = await subject.resolve({ env, namespace: "acme", name: "demo" });

    const response = responseFrom(resolved);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe(ERROR_CODES.importInProgress);
  });

  test("passes each Git operation's required scope to authorization", async () => {
    const requiredScopes: string[] = [];
    const { resolver: subject } = resolver(pointer(), async (command) => {
      requiredScopes.push(command.requiredScope);
      return { allowed: true };
    });

    const resolved = await subject.resolve({
      env,
      namespace: "acme",
      name: "demo",
      git: { request: new Request("http://local.test"), requiredScope: "read" },
    });

    expect(resolved).toEqual(pointer());
    expect(requiredScopes).toEqual(["read"]);
  });

  test("refuses unauthorized Git before looking up the repository", async () => {
    const { resolver: subject, lookups } = resolver(null, async () => ({
      allowed: false,
      detail: "No access.",
    }));

    const resolved = await subject.resolve({
      env,
      namespace: "acme",
      name: "private",
      git: { request: new Request("http://local.test"), requiredScope: "read" },
    });

    expect(responseFrom(resolved).status).toBe(401);
    expect(lookups()).toBe(0);
  });
});
