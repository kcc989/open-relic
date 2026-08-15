import {
  ArtifactsError,
  type Artifacts,
  type ArtifactsBindingProps,
  type ArtifactsBindingRequest,
  type ArtifactsBindingResult,
  type ArtifactsCreateRepoResult,
  type ArtifactsCreateTokenResult,
  type ArtifactsErrorCode,
  type ArtifactsRepo,
  type ArtifactsRepoInfo,
  type ArtifactsRepoListResult,
  type ArtifactsTokenInfo,
  type ArtifactsTokenListResult,
  type ArtifactsTokenScope,
} from "@openrelic/alchemy/worker";

import {
  DEFAULT_BRANCH,
  ERROR_CODES,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  REPOSITORY_DESCRIPTION_MAX_LENGTH,
  REPO_LIST_DEFAULT_DIRECTION,
  REPO_LIST_DEFAULT_SORT,
  TOKEN_TTL_DEFAULT_SECONDS,
  TOKEN_TTL_MAX_SECONDS,
  TOKEN_TTL_MIN_SECONDS,
  describeBranchNameViolation,
  describeNamespaceSlugViolation,
  describeRepositoryNameViolation,
  validateBranchName,
  validateNamespaceSlug,
  validateRepositoryName,
  type RepoInfo,
  type TokenInfo,
} from "./contracts.ts";
import type { RepositoryObjects } from "./bindings.ts";
import type { ImportJobFailure, ImportJobRetrying } from "./import-operation.ts";
import type { NamespaceRegistryClient } from "./namespace-registry.ts";
import { encodeCursor } from "./pagination.ts";
import { CURSOR_QUERY_MISMATCH, cursorMatchesQuery, parseCursorKey } from "./query.ts";
import type { RepositoryIndexClient, RepositoryPointer } from "./repository-index.ts";
import { gitRemoteUrl } from "./remote.ts";
import {
  RemoteBranchError,
  validateRemoteBranchRequest,
  type RemoteBranchRequest,
} from "./git/remote-branch.ts";
import type { TokenRegistryClient } from "./token-registry.ts";

export interface ArtifactsBindingDependencies {
  readonly namespaces: NamespaceRegistryClient;
  readonly repositories: RepositoryIndexClient;
  readonly objects: RepositoryObjects;
  readonly tokens: TokenRegistryClient;
}

type MutableRemoteBranchRequest = {
  -readonly [Key in keyof RemoteBranchRequest]: RemoteBranchRequest[Key];
};

const bindingCursor = {
  s: REPO_LIST_DEFAULT_SORT,
  d: REPO_LIST_DEFAULT_DIRECTION,
  q: "",
} as const;

const numericCode = (code: ArtifactsErrorCode): number => {
  switch (code) {
    case "INVALID_INPUT":
      return ERROR_CODES.invalidInput;
    case "INVALID_REPO_NAME":
      return ERROR_CODES.invalidRepoName;
    case "INVALID_TTL":
      return ERROR_CODES.invalidTtl;
    case "INVALID_URL":
      return ERROR_CODES.invalidUrl;
    case "REMOTE_AUTH_REQUIRED":
      return ERROR_CODES.remoteAuthRequired;
    case "NOT_FOUND":
      return ERROR_CODES.notFound;
    case "ALREADY_EXISTS":
      return ERROR_CODES.alreadyExists;
    case "IMPORT_IN_PROGRESS":
      return ERROR_CODES.importInProgress;
    case "FORK_IN_PROGRESS":
      return ERROR_CODES.forkInProgress;
    case "INTERNAL_ERROR":
      return ERROR_CODES.internalError;
    case "UPSTREAM_UNAVAILABLE":
      return ERROR_CODES.upstreamUnavailable;
    case "MEMORY_LIMIT":
      return ERROR_CODES.memoryLimit;
  }
};

const failure = (code: ArtifactsErrorCode, message: string): ArtifactsError =>
  new ArtifactsError(code, numericCode(code), message);

const validateName = (name: string): string => {
  const violation = validateRepositoryName(name);
  if (violation !== null) {
    throw failure("INVALID_REPO_NAME", describeRepositoryNameViolation(violation));
  }
  return name;
};

const validateDescription = (description: string | undefined): string | null => {
  if (description === undefined || description === null) return null;
  if (description.length > REPOSITORY_DESCRIPTION_MAX_LENGTH) {
    throw failure(
      "INVALID_INPUT",
      `"description" may be at most ${REPOSITORY_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return description;
};

const validateReadOnly = (readOnly: boolean | undefined): boolean => {
  if (readOnly === undefined || readOnly === null) return false;
  return readOnly;
};

const validateDefaultBranch = (branch: string | undefined): string => {
  if (branch === undefined) return DEFAULT_BRANCH;
  const violation = validateBranchName(branch);
  if (violation !== null) {
    throw failure("INVALID_INPUT", describeBranchNameViolation(violation));
  }
  return branch;
};

const validateScope = (scope: ArtifactsTokenScope | undefined): ArtifactsTokenScope => {
  if (scope === undefined) return "write";
  if (scope !== "read" && scope !== "write") {
    throw failure("INVALID_INPUT", '"scope" must be one of read, write.');
  }
  return scope;
};

const validateTtl = (ttl: number | undefined): number => {
  if (ttl === undefined) return TOKEN_TTL_DEFAULT_SECONDS;
  if (!Number.isInteger(ttl) || ttl < TOKEN_TTL_MIN_SECONDS || ttl > TOKEN_TTL_MAX_SECONDS) {
    throw failure(
      "INVALID_TTL",
      `"ttl" must be an integer between ${TOKEN_TTL_MIN_SECONDS} and ${TOKEN_TTL_MAX_SECONDS}.`,
    );
  }
  return ttl;
};

const normalizedImportSource = (value: string): string => {
  const remote = new URL(value);
  remote.pathname = `${remote.pathname.replace(/\/$/, "").replace(/\.git$/, "")}.git`;
  remote.search = "";
  remote.hash = "";
  return `git:${remote.toString()}`;
};

const bindingImportFailure = (outcome: ImportJobFailure | ImportJobRetrying): ArtifactsError => {
  switch (outcome.code) {
    case "invalid-advertisement":
      return failure("INVALID_URL", outcome.message);
    case "branch-not-found":
      return failure("NOT_FOUND", outcome.message);
    case "public-access-failed":
      return failure("REMOTE_AUTH_REQUIRED", outcome.message);
    case "invalid-url":
    case "invalid-depth":
      return failure("INVALID_INPUT", outcome.message);
    case "upstream-unavailable":
      return failure("UPSTREAM_UNAVAILABLE", outcome.message);
    case "invalid-pack":
      return outcome.packErrorCode === "object-too-large"
        ? failure("MEMORY_LIMIT", outcome.message)
        : failure("INVALID_INPUT", outcome.message);
    case "storage-exhausted":
    case "internal":
      return failure("INTERNAL_ERROR", outcome.message);
  }
};

const toRepoInfo = (repo: RepoInfo, remote: string): ArtifactsRepoInfo => ({
  id: repo.id,
  name: repo.name,
  description: repo.description,
  defaultBranch: repo.default_branch,
  createdAt: repo.created_at,
  updatedAt: repo.updated_at,
  lastPushAt: repo.last_push_at,
  source: repo.source,
  readOnly: repo.read_only,
  remote,
});

const toTokenInfo = (token: TokenInfo): ArtifactsTokenInfo => ({
  id: token.id,
  scope: token.scope,
  state: token.state,
  createdAt: token.created_at,
  expiresAt: token.expires_at,
});

/**
 * Transport-neutral implementation of the Artifacts Workers binding. The
 * WorkerEntrypoint supplies trusted namespace/URL props and the local tests
 * supply the same registry clients directly.
 */
export class ArtifactsBindingService implements Artifacts {
  readonly #namespace: string;
  readonly #publicUrl: string;
  readonly #dependencies: ArtifactsBindingDependencies;

  constructor(props: ArtifactsBindingProps, dependencies: ArtifactsBindingDependencies) {
    const namespaceViolation = validateNamespaceSlug(props.namespace);
    if (namespaceViolation !== null) {
      throw failure("INVALID_INPUT", describeNamespaceSlugViolation(namespaceViolation));
    }

    let publicUrl: URL;
    try {
      publicUrl = new URL(props.publicUrl);
    } catch {
      throw failure("INVALID_INPUT", '"publicUrl" must be an absolute HTTP or HTTPS URL.');
    }
    if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") {
      throw failure("INVALID_INPUT", '"publicUrl" must be an absolute HTTP or HTTPS URL.');
    }

    this.#namespace = props.namespace;
    this.#publicUrl = publicUrl.toString();
    this.#dependencies = dependencies;
  }

  async create(
    name: string,
    opts: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    } = {},
  ): Promise<ArtifactsCreateRepoResult> {
    const repositoryName = validateName(name);
    const description = validateDescription(opts?.description);
    const readOnly = validateReadOnly(opts?.readOnly);
    const defaultBranch = validateDefaultBranch(opts?.setDefaultBranch);

    await this.#ensureNamespace();
    const durableObjectId = this.#dependencies.objects.createId();
    const outcome = await this.#dependencies.repositories.createRepository({
      namespaceSlug: this.#namespace,
      name: repositoryName,
      description,
      defaultBranch,
      readOnly,
      durableObjectId,
    });
    if (!outcome.created) {
      throw outcome.reason === "name-taken"
        ? failure(
            "ALREADY_EXISTS",
            `The repository "${this.#namespace}/${repositoryName}" already exists.`,
          )
        : failure("NOT_FOUND", `No namespace named "${this.#namespace}" exists.`);
    }

    try {
      await this.#dependencies.objects.get(durableObjectId).initialize({
        defaultBranch: outcome.repository.default_branch,
        createdAt: outcome.repository.created_at,
      });
      const issued = await this.#dependencies.tokens.createToken({
        namespaceSlug: this.#namespace,
        repositoryName,
        scope: "write",
        ttlSeconds: TOKEN_TTL_DEFAULT_SECONDS,
      });
      if (!issued.created) {
        throw failure(
          "NOT_FOUND",
          `No repository named "${this.#namespace}/${repositoryName}" exists.`,
        );
      }

      return this.#createResult(
        outcome.repository,
        issued.token.plaintext,
        issued.token.expires_at,
      );
    } catch (error) {
      await this.#dependencies.repositories.deleteRepositoryIfOwned(
        this.#namespace,
        repositoryName,
        durableObjectId,
      );
      await this.#dependencies.objects.get(durableObjectId).destroy();
      throw error instanceof ArtifactsError
        ? error
        : failure("INTERNAL_ERROR", `The repository "${repositoryName}" could not be created.`);
    }
  }

  async get(name: string): Promise<ArtifactsRepo> {
    const repositoryName = validateName(name);
    const pointer = await this.#readyRepository(repositoryName);
    return this.#repoHandle(pointer);
  }

  async list(opts: { limit?: number; cursor?: string } = {}): Promise<ArtifactsRepoListResult> {
    const limit = opts?.limit ?? LIST_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
      throw failure("INVALID_INPUT", `"limit" must be an integer between 1 and ${LIST_MAX_LIMIT}.`);
    }

    const parsedCursor = parseCursorKey(opts?.cursor);
    if (!parsedCursor.ok) throw failure("INVALID_INPUT", parsedCursor.detail);
    let cursor = null;
    if (parsedCursor.value !== null) {
      if (
        parsedCursor.value.v === undefined ||
        parsedCursor.value.n === undefined ||
        !cursorMatchesQuery(parsedCursor.value, bindingCursor)
      ) {
        throw failure("INVALID_INPUT", CURSOR_QUERY_MISMATCH);
      }
      cursor = { value: parsedCursor.value.v, name: parsedCursor.value.n };
    }

    const page = await this.#dependencies.repositories.listRepositories(this.#namespace, {
      limit,
      cursor,
      search: null,
      sort: REPO_LIST_DEFAULT_SORT,
      direction: REPO_LIST_DEFAULT_DIRECTION,
    });
    if (page === null) return { repos: [], total: 0 };

    const result: ArtifactsRepoListResult = {
      repos: page.repositories.map((repo) => {
        const { remote: _, ...info } = toRepoInfo(repo, this.#remote(repo.name));
        return info;
      }),
      total: page.totalCount,
    };
    return page.next === null
      ? result
      : {
          ...result,
          cursor: encodeCursor({
            v: page.next.value,
            n: page.next.name,
            ...bindingCursor,
          }),
        };
  }

  async import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: {
      name: string;
      opts?: { description?: string; readOnly?: boolean };
    };
  }): Promise<ArtifactsCreateRepoResult> {
    const name = validateName(params.target?.name);
    const description = validateDescription(params.target?.opts?.description);
    const readOnly = validateReadOnly(params.target?.opts?.readOnly);
    const request: MutableRemoteBranchRequest = { url: params.source.url };
    if (params.source.branch !== undefined) request.branch = params.source.branch;
    if (params.source.depth !== undefined) request.depth = params.source.depth;
    try {
      validateRemoteBranchRequest(request);
    } catch (error) {
      if (error instanceof RemoteBranchError) {
        throw bindingImportFailure({
          completed: false,
          retrying: false,
          code: error.code,
          message: error.message,
          packErrorCode: null,
        });
      }
      throw error;
    }

    await this.#ensureNamespace();
    const durableObjectId = this.#dependencies.objects.createId();
    const source = normalizedImportSource(request.url);
    const reserved = await this.#dependencies.repositories.createRepository({
      namespaceSlug: this.#namespace,
      name,
      description,
      defaultBranch: request.branch ?? DEFAULT_BRANCH,
      readOnly,
      source,
      status: "importing",
      durableObjectId,
    });
    if (!reserved.created) {
      throw reserved.reason === "name-taken"
        ? failure("ALREADY_EXISTS", `The repository "${this.#namespace}/${name}" already exists.`)
        : failure("NOT_FOUND", `No namespace named "${this.#namespace}" exists.`);
    }

    const issued = await this.#dependencies.tokens.createToken({
      namespaceSlug: this.#namespace,
      repositoryName: name,
      scope: "write",
      ttlSeconds: TOKEN_TTL_DEFAULT_SECONDS,
    });
    if (!issued.created) {
      await this.#dependencies.repositories.deleteImportIfOwned(
        this.#namespace,
        name,
        durableObjectId,
      );
      await this.#dependencies.objects.get(durableObjectId).destroy();
      throw failure("INTERNAL_ERROR", `The repository "${name}" could not be imported.`);
    }

    let outcome;
    try {
      outcome = await this.#dependencies.objects.get(durableObjectId).scheduleImport({
        namespaceSlug: this.#namespace,
        repositoryName: name,
        createdAt: reserved.repository.created_at,
        initialBranch: reserved.repository.default_branch,
        request,
      });
    } catch {
      await this.#dependencies.repositories.deleteImportIfOwned(
        this.#namespace,
        name,
        durableObjectId,
      );
      await this.#dependencies.objects.get(durableObjectId).destroy();
      throw failure("INTERNAL_ERROR", `The repository "${name}" could not be imported.`);
    }
    if (!outcome.completed) throw bindingImportFailure(outcome);

    return this.#createResult(
      { ...reserved.repository, default_branch: outcome.imported.branch },
      issued.token.plaintext,
      issued.token.expires_at,
    );
  }

  async delete(name: string): Promise<boolean> {
    const repositoryName = validateName(name);
    const deleted = await this.#dependencies.repositories.deleteRepository(
      this.#namespace,
      repositoryName,
    );
    if (deleted === null) return false;
    await this.#dependencies.objects.get(deleted.durableObjectId).destroy();
    return true;
  }

  async #ensureNamespace(): Promise<void> {
    if ((await this.#dependencies.namespaces.getNamespace(this.#namespace)) !== null) return;
    await this.#dependencies.namespaces.createNamespace({
      slug: this.#namespace,
      displayName: this.#namespace,
      description: null,
    });
  }

  async #readyRepository(name: string): Promise<RepositoryPointer> {
    const found = await this.#dependencies.repositories.getRepository(this.#namespace, name);
    if (found === null) {
      throw failure("NOT_FOUND", `No repository named "${this.#namespace}/${name}" exists.`);
    }
    if (found.status === "importing") {
      throw failure(
        "IMPORT_IN_PROGRESS",
        `The repository "${this.#namespace}/${name}" is still being imported.`,
      );
    }
    if (found.status === "forking") {
      throw failure(
        "FORK_IN_PROGRESS",
        `The repository "${this.#namespace}/${name}" is still being forked.`,
      );
    }
    return found;
  }

  #repoHandle(pointer: RepositoryPointer): ArtifactsRepo {
    const info = toRepoInfo(pointer.repository, this.#remote(pointer.repository.name));
    return {
      ...info,
      createToken: (scope, ttl) => this.#createToken(pointer.repository.name, scope, ttl),
      listTokens: () => this.#listTokens(pointer.repository.name),
      revokeToken: (tokenOrId) => this.#revokeToken(pointer.repository.name, tokenOrId),
      fork: (name, opts) => this.#fork(pointer, name, opts),
    };
  }

  async #createToken(
    repositoryName: string,
    scope?: ArtifactsTokenScope,
    ttl?: number,
  ): Promise<ArtifactsCreateTokenResult> {
    const outcome = await this.#dependencies.tokens.createToken({
      namespaceSlug: this.#namespace,
      repositoryName,
      scope: validateScope(scope),
      ttlSeconds: validateTtl(ttl),
    });
    if (!outcome.created) {
      throw failure(
        "NOT_FOUND",
        `No repository named "${this.#namespace}/${repositoryName}" exists.`,
      );
    }
    return {
      id: outcome.token.id,
      plaintext: outcome.token.plaintext,
      scope: outcome.token.scope,
      expiresAt: outcome.token.expires_at,
    };
  }

  async #listTokens(repositoryName: string): Promise<ArtifactsTokenListResult> {
    const page = await this.#dependencies.tokens.listTokens(this.#namespace, repositoryName, {
      state: "all",
      page: 1,
      perPage: Number.MAX_SAFE_INTEGER,
    });
    if (page === null) {
      throw failure(
        "NOT_FOUND",
        `No repository named "${this.#namespace}/${repositoryName}" exists.`,
      );
    }
    return { tokens: page.tokens.map(toTokenInfo), total: page.totalCount };
  }

  async #revokeToken(repositoryName: string, tokenOrId: string): Promise<boolean> {
    if (tokenOrId.length === 0) {
      throw failure("INVALID_INPUT", '"tokenOrId" must not be empty.');
    }
    return this.#dependencies.tokens.revokeRepositoryToken(
      this.#namespace,
      repositoryName,
      tokenOrId,
    );
  }

  async #fork(
    source: RepositoryPointer,
    name: string,
    opts: {
      description?: string;
      readOnly?: boolean;
      defaultBranchOnly?: boolean;
    } = {},
  ): Promise<ArtifactsCreateRepoResult> {
    const targetName = validateName(name);
    const description = validateDescription(opts?.description);
    const readOnly = validateReadOnly(opts?.readOnly);
    const defaultBranchOnly = opts?.defaultBranchOnly ?? true;

    const durableObjectId = this.#dependencies.objects.createId();
    const reserved = await this.#dependencies.repositories.createRepository({
      namespaceSlug: this.#namespace,
      name: targetName,
      description,
      defaultBranch: source.repository.default_branch,
      readOnly,
      source: `${this.#namespace}/${source.repository.name}`,
      status: "forking",
      durableObjectId,
    });
    if (!reserved.created) {
      throw reserved.reason === "name-taken"
        ? failure(
            "ALREADY_EXISTS",
            `The repository "${this.#namespace}/${targetName}" already exists.`,
          )
        : failure("NOT_FOUND", `No namespace named "${this.#namespace}" exists.`);
    }

    try {
      await this.#dependencies.objects
        .get(source.durableObjectId)
        .copyForkTo(this.#dependencies.objects.get(durableObjectId), {
          createdAt: reserved.repository.created_at,
          defaultBranchOnly,
        });
      const issued = await this.#dependencies.tokens.createToken({
        namespaceSlug: this.#namespace,
        repositoryName: targetName,
        scope: "write",
        ttlSeconds: TOKEN_TTL_DEFAULT_SECONDS,
      });
      if (
        !issued.created ||
        !(await this.#dependencies.repositories.finishFork(this.#namespace, targetName))
      ) {
        throw new Error("The reserved fork target disappeared before it became ready.");
      }
      return this.#createResult(
        reserved.repository,
        issued.token.plaintext,
        issued.token.expires_at,
      );
    } catch {
      await this.#dependencies.repositories.deleteRepositoryIfOwned(
        this.#namespace,
        targetName,
        durableObjectId,
      );
      await this.#dependencies.objects.get(durableObjectId).destroy();
      throw failure(
        "INTERNAL_ERROR",
        `The repository "${this.#namespace}/${source.repository.name}" could not be forked.`,
      );
    }
  }

  #createResult(repo: RepoInfo, token: string, tokenExpiresAt: string): ArtifactsCreateRepoResult {
    return {
      id: repo.id,
      name: repo.name,
      description: repo.description,
      defaultBranch: repo.default_branch,
      remote: this.#remote(repo.name),
      token,
      tokenExpiresAt,
    };
  }

  #remote(name: string): string {
    return gitRemoteUrl(this.#publicUrl, this.#namespace, name);
  }
}

/** Tagged RPC transport used when callers need full ArtifactsError fidelity. */
export const invokeArtifactsBinding = async (
  service: ArtifactsBindingService,
  request: ArtifactsBindingRequest,
): Promise<ArtifactsBindingResult> => {
  try {
    switch (request.operation) {
      case "create":
        return { ok: true, value: await service.create(request.name, request.options) };
      case "get": {
        const repository = await service.get(request.name);
        const {
          createToken: _,
          listTokens: __,
          revokeToken: ___,
          fork: ____,
          ...info
        } = repository;
        return { ok: true, value: info };
      }
      case "import":
        return { ok: true, value: await service.import(request.params) };
      case "list":
        return { ok: true, value: await service.list(request.options) };
      case "delete":
        return { ok: true, value: await service.delete(request.name) };
      case "createToken": {
        const repository = await service.get(request.repository);
        return {
          ok: true,
          value: await repository.createToken(request.scope, request.ttl),
        };
      }
      case "listTokens": {
        const repository = await service.get(request.repository);
        return { ok: true, value: await repository.listTokens() };
      }
      case "revokeToken": {
        const repository = await service.get(request.repository);
        return { ok: true, value: await repository.revokeToken(request.tokenOrId) };
      }
      case "fork": {
        const repository = await service.get(request.repository);
        return {
          ok: true,
          value: await repository.fork(request.name, request.options),
        };
      }
    }
  } catch (error) {
    const artifactsError =
      error instanceof ArtifactsError
        ? error
        : failure("INTERNAL_ERROR", "The Open Relic binding request failed.");
    return {
      ok: false,
      error: {
        code: artifactsError.code,
        numericCode: artifactsError.numericCode,
        message: artifactsError.message,
      },
    };
  }
};
