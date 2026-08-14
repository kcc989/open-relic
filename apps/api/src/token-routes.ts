import {
  NAMESPACES_PATH,
  TOKEN_LIST_DEFAULT_PAGE,
  TOKEN_LIST_DEFAULT_PER_PAGE,
  TOKEN_LIST_DEFAULT_STATE,
  TOKEN_LIST_MAX_PER_PAGE,
  TOKEN_LIST_STATES,
  TOKEN_SCOPES,
  TOKEN_TTL_DEFAULT_SECONDS,
  TOKEN_TTL_MAX_SECONDS,
  TOKEN_TTL_MIN_SECONDS,
  describeRepositoryNameViolation,
  validateRepositoryName,
  type CreateTokenResult,
  type DeleteTokenResult,
  type TokenScope,
} from "@open-relic/contracts";
import { Schema } from "effect";
import type { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import {
  forkInProgress,
  importInProgress,
  invalidInput,
  invalidRepoName,
  invalidTtl,
  notFound,
  ok,
  okList,
} from "./envelope.ts";
import { parseChoice, parseLimit } from "./query.ts";
import { decodeJson, type Json, type Rejected } from "./request-body.ts";
import type { TokenRegistryClient } from "./token-registry.ts";
import type { RepositoryIndexClient } from "./repository-index.ts";

const CreateTokenJson = Schema.Struct({
  repo: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  scope: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  ttl: Schema.optionalKey(
    Schema.Union([Schema.Number, Schema.String, Schema.Boolean, Schema.Null]),
  ),
});

type ParsedCreate =
  | {
      readonly ok: true;
      readonly repositoryName: string;
      readonly scope: TokenScope;
      readonly ttlSeconds: number;
    }
  | (Rejected & { readonly badRepo?: true; readonly badTtl?: true });

const parseCreate = (payload: Json): ParsedCreate => {
  const object = decodeJson(CreateTokenJson, payload);
  if (!object.ok) {
    return object;
  }

  if (!Schema.is(Schema.String)(object.value.repo)) {
    return { ok: false, detail: `"repo" must be a string.`, pointer: "/repo", badRepo: true };
  }
  const violation = validateRepositoryName(object.value.repo);
  if (violation !== null) {
    return {
      ok: false,
      detail: describeRepositoryNameViolation(violation),
      pointer: "/repo",
      badRepo: true,
    };
  }

  const scope = object.value.scope ?? "write";
  const parsedScope = Schema.is(Schema.String)(scope)
    ? TOKEN_SCOPES.find((candidate) => candidate === scope)
    : undefined;
  if (parsedScope === undefined) {
    return { ok: false, detail: `"scope" must be one of read, write.`, pointer: "/scope" };
  }

  const ttl = object.value.ttl ?? TOKEN_TTL_DEFAULT_SECONDS;
  if (
    !Schema.is(Schema.Number)(ttl) ||
    !Number.isInteger(ttl) ||
    ttl < TOKEN_TTL_MIN_SECONDS ||
    ttl > TOKEN_TTL_MAX_SECONDS
  ) {
    return {
      ok: false,
      detail: `"ttl" must be an integer between ${TOKEN_TTL_MIN_SECONDS} and ${TOKEN_TTL_MAX_SECONDS}.`,
      pointer: "/ttl",
      badTtl: true,
    };
  }

  return { ok: true, repositoryName: object.value.repo, scope: parsedScope, ttlSeconds: ttl };
};

const parsePage = (raw: string | undefined): { ok: true; value: number } | Rejected => {
  if (raw === undefined) {
    return { ok: true, value: TOKEN_LIST_DEFAULT_PAGE };
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    return { ok: false, detail: `"page" must be a positive integer.` };
  }
  return { ok: true, value: Number(raw) };
};

const noSuchRepository = (namespaceSlug: string, repositoryName: string): string =>
  `No repository named "${namespaceSlug}/${repositoryName}" exists.`;

export const registerTokenRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveTokens: (env: ApiEnv) => TokenRegistryClient,
  resolveRepositories: (env: ApiEnv) => RepositoryIndexClient,
): void => {
  app.post(`${NAMESPACES_PATH}/:namespace/tokens`, async (context) => {
    let payload: Json;
    try {
      // SAFETY: req.json() is the JSON value at this boundary; Schema rejects the rest.
      payload = (await context.req.json()) as Json;
    } catch {
      return invalidInput("The request body must be valid JSON.");
    }

    const parsed = parseCreate(payload);
    if (!parsed.ok) {
      if (parsed.badRepo === true) {
        return invalidRepoName(parsed.detail, "/repo");
      }
      if (parsed.badTtl === true) {
        return invalidTtl(parsed.detail);
      }
      return invalidInput(parsed.detail, parsed.pointer);
    }

    const namespaceSlug = context.req.param("namespace");
    const repository = await resolveRepositories(context.env).getRepository(
      namespaceSlug,
      parsed.repositoryName,
    );
    if (repository?.status === "forking") {
      return forkInProgress(
        `The repository "${namespaceSlug}/${parsed.repositoryName}" is still being forked.`,
      );
    }
    if (repository?.status === "importing") {
      return importInProgress(
        `The repository "${namespaceSlug}/${parsed.repositoryName}" is still being imported.`,
      );
    }
    const outcome = await resolveTokens(context.env).createToken({
      namespaceSlug,
      repositoryName: parsed.repositoryName,
      scope: parsed.scope,
      ttlSeconds: parsed.ttlSeconds,
    });

    return outcome.created
      ? ok(outcome.token satisfies CreateTokenResult)
      : notFound(noSuchRepository(namespaceSlug, parsed.repositoryName));
  });

  app.get(`${NAMESPACES_PATH}/:namespace/repos/:repo/tokens`, async (context) => {
    const state = parseChoice(
      context.req.query("state"),
      "state",
      TOKEN_LIST_STATES,
      TOKEN_LIST_DEFAULT_STATE,
    );
    if (!state.ok) {
      return invalidInput(state.detail);
    }

    const perPage = parseLimit(
      context.req.query("per_page"),
      TOKEN_LIST_DEFAULT_PER_PAGE,
      TOKEN_LIST_MAX_PER_PAGE,
    );
    if (!perPage.ok) {
      return invalidInput(perPage.detail.replaceAll('"limit"', '"per_page"'));
    }

    const page = parsePage(context.req.query("page"));
    if (!page.ok) {
      return invalidInput(page.detail);
    }

    const namespaceSlug = context.req.param("namespace");
    const repositoryName = context.req.param("repo");
    const repository = await resolveRepositories(context.env).getRepository(
      namespaceSlug,
      repositoryName,
    );
    if (repository?.status === "forking") {
      return forkInProgress(
        `The repository "${namespaceSlug}/${repositoryName}" is still being forked.`,
      );
    }
    if (repository?.status === "importing") {
      return importInProgress(
        `The repository "${namespaceSlug}/${repositoryName}" is still being imported.`,
      );
    }
    const result = await resolveTokens(context.env).listTokens(namespaceSlug, repositoryName, {
      state: state.value,
      page: page.value,
      perPage: perPage.value,
    });
    if (result === null) {
      return notFound(noSuchRepository(namespaceSlug, repositoryName));
    }

    return okList(result.tokens, {
      page: page.value,
      per_page: perPage.value,
      total_pages: Math.ceil(result.totalCount / perPage.value),
      count: result.tokens.length,
      total_count: result.totalCount,
    });
  });

  app.delete(`${NAMESPACES_PATH}/:namespace/tokens/:tokenId`, async (context) => {
    const namespaceSlug = context.req.param("namespace");
    const id = context.req.param("tokenId");
    const revoked = await resolveTokens(context.env).revokeToken(namespaceSlug, id);

    return revoked
      ? ok({ id } satisfies DeleteTokenResult)
      : notFound(`No token named "${id}" exists in namespace "${namespaceSlug}".`);
  });
};
