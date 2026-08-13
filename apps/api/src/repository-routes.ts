import {
  DEFAULT_BRANCH,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  NAMESPACES_PATH,
  REPOSITORY_DESCRIPTION_MAX_LENGTH,
  REPOSITORY_NAME_MAX_LENGTH,
  REPO_LIST_DEFAULT_DIRECTION,
  REPO_LIST_DEFAULT_SORT,
  REPO_SORT_FIELDS,
  SORT_DIRECTIONS,
  TOKEN_TTL_DEFAULT_SECONDS,
  describeBranchNameViolation,
  describeRepositoryNameViolation,
  validateBranchName,
  validateRepositoryName,
  type CreateRepoResult,
  type DeleteRepoResult,
  type RepoInfo,
  type RepoSortField,
  type RepoWithRemote,
  type SortDirection,
} from "@open-relic/contracts";
import { Schema } from "effect";
import type { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import type { RepositoryObjects } from "./bindings.ts";
import { alreadyExists, invalidInput, invalidRepoName, notFound, ok, okList } from "./envelope.ts";
import { encodeCursor } from "./pagination.ts";
import {
  CURSOR_QUERY_MISMATCH,
  cursorMatchesQuery,
  parseChoice,
  parseCursorKey,
  parseLimit,
  parseSearch,
} from "./query.ts";
import { gitRemoteUrl } from "./remote.ts";
import type {
  CreateRepositoryCommand,
  RepositoryCursor,
  RepositoryIndexClient,
} from "./repository-index.ts";
import {
  decodeJson,
  parseOptionalFlag,
  parseOptionalText,
  type Json,
  type Rejected,
} from "./request-body.ts";
import type { TokenRegistryClient } from "./token-registry.ts";

type NewRepository = Omit<CreateRepositoryCommand, "durableObjectId">;

type ParsedCreate =
  | { readonly ok: true; readonly command: NewRepository }
  | (Rejected & { readonly badName?: true });

const CreateRepoJson = Schema.Struct({
  name: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  default_branch: Schema.optionalKey(Schema.String),
  read_only: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

const parseCreateBody = (namespaceSlug: string, payload: Json): ParsedCreate => {
  const object = decodeJson(CreateRepoJson, payload);
  if (!object.ok) {
    return object;
  }

  const name = object.value.name;
  if (!Schema.is(Schema.String)(name)) {
    return { ok: false, detail: `"name" must be a string.`, badName: true };
  }

  const nameViolation = validateRepositoryName(name);
  if (nameViolation !== null) {
    return {
      ok: false,
      detail: describeRepositoryNameViolation(nameViolation),
      badName: true,
    };
  }

  const description = parseOptionalText(
    object.value.description,
    "description",
    REPOSITORY_DESCRIPTION_MAX_LENGTH,
  );
  if (!description.ok) {
    return description;
  }

  const readOnly = parseOptionalFlag(object.value.read_only, false);
  if (!readOnly.ok) {
    return readOnly;
  }

  const defaultBranch = object.value.default_branch ?? DEFAULT_BRANCH;
  const branchViolation = validateBranchName(defaultBranch);
  if (branchViolation !== null) {
    return {
      ok: false,
      detail: describeBranchNameViolation(branchViolation),
      pointer: "/default_branch",
    };
  }

  return {
    ok: true,
    command: {
      namespaceSlug,
      name: name,
      description: description.value,
      defaultBranch,
      readOnly: readOnly.value,
    },
  };
};

const noSuchRepository = (namespaceSlug: string, name: string): string =>
  `No repository named "${namespaceSlug}/${name}" exists.`;

/**
 * The query a cursor was minted under, carried inside the cursor so a later
 * page can be checked against it. `v` and `n` name a position in one ordering
 * of one filtered set; replaying them under a different one would compare a
 * value against a column it never came from.
 */
const cursorBinding = (sort: RepoSortField, direction: SortDirection, search: string | null) => ({
  s: sort,
  d: direction,
  q: search ?? "",
});

export const registerRepositoryRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveIndex: (env: ApiEnv) => RepositoryIndexClient,
  resolveObjects: (env: ApiEnv) => RepositoryObjects,
  resolveTokens: (env: ApiEnv) => TokenRegistryClient,
): void => {
  const REPOS = `${NAMESPACES_PATH}/:namespace/repos` as const;
  const REPO = `${REPOS}/:repo` as const;

  /** The list and get shape: the stored row plus the remote to clone it from. */
  const withRemote = (
    context: { req: { url: string } },
    namespaceSlug: string,
    repository: RepoInfo,
  ): RepoWithRemote => ({
    ...repository,
    remote: gitRemoteUrl(context.req.url, namespaceSlug, repository.name),
  });

  app.post(REPOS, async (context) => {
    const namespaceSlug = context.req.param("namespace");

    let payload: Json;
    try {
      // SAFETY: req.json() is the JSON value at this HTTP boundary; Schema rejects the rest.
      payload = (await context.req.json()) as Json;
    } catch {
      return invalidInput("The request body must be valid JSON.");
    }

    const parsed = parseCreateBody(namespaceSlug, payload);
    if (!parsed.ok) {
      // A bad name has its own code, because it is the one rejection a client
      // can fix by choosing differently rather than by fixing its request.
      return parsed.badName === true
        ? invalidRepoName(parsed.detail)
        : invalidInput(parsed.detail, parsed.pointer);
    }

    const objects = resolveObjects(context.env);
    // Minted before the insert so the index row and the object it points at are
    // decided together; if the insert is rejected the id is simply never used.
    const durableObjectId = objects.createId();

    const outcome = await resolveIndex(context.env).createRepository({
      ...parsed.command,
      durableObjectId,
    });

    if (!outcome.created) {
      return outcome.reason === "namespace-missing"
        ? notFound(`No namespace named "${namespaceSlug}" exists.`)
        : alreadyExists(`The repository "${namespaceSlug}/${parsed.command.name}" already exists.`);
    }

    // The name is claimed; now give the object its Git state.
    await objects.get(durableObjectId).initialize({
      defaultBranch: outcome.repository.default_branch,
      createdAt: outcome.repository.created_at,
    });

    const issued = await resolveTokens(context.env).createToken({
      namespaceSlug,
      repositoryName: outcome.repository.name,
      scope: "write",
      ttlSeconds: TOKEN_TTL_DEFAULT_SECONDS,
    });
    if (!issued.created) {
      // The row was just created. Only a concurrent delete can make it vanish
      // before its initial token is issued, in which case it is truthfully gone.
      return notFound(noSuchRepository(namespaceSlug, outcome.repository.name));
    }

    // Narrower than the list and get shape on purpose: Artifacts answers a
    // create with the identity, the remote, and the one token it will not show
    // again.
    return ok({
      id: outcome.repository.id,
      name: outcome.repository.name,
      description: outcome.repository.description,
      default_branch: outcome.repository.default_branch,
      remote: gitRemoteUrl(context.req.url, namespaceSlug, outcome.repository.name),
      token: issued.token.plaintext,
    } satisfies CreateRepoResult);
  });

  app.get(REPOS, async (context) => {
    const namespaceSlug = context.req.param("namespace");

    const limit = parseLimit(context.req.query("limit"), LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    if (!limit.ok) {
      return invalidInput(limit.detail);
    }

    const sort = parseChoice(
      context.req.query("sort"),
      "sort",
      REPO_SORT_FIELDS,
      REPO_LIST_DEFAULT_SORT,
    );
    if (!sort.ok) {
      return invalidInput(sort.detail);
    }

    const direction = parseChoice(
      context.req.query("direction"),
      "direction",
      SORT_DIRECTIONS,
      REPO_LIST_DEFAULT_DIRECTION,
    );
    if (!direction.ok) {
      return invalidInput(direction.detail);
    }

    const search = parseSearch(context.req.query("search"), REPOSITORY_NAME_MAX_LENGTH);
    if (!search.ok) {
      return invalidInput(search.detail);
    }

    const binding = cursorBinding(sort.value, direction.value, search.value);

    const cursor = parseCursorKey(context.req.query("cursor"));
    if (!cursor.ok) {
      return invalidInput(cursor.detail);
    }

    let position: RepositoryCursor | null = null;
    if (cursor.value !== null) {
      const key = cursor.value;
      if (key.v === undefined || key.n === undefined) {
        return invalidInput(`"cursor" is not a cursor this service issued.`);
      }
      if (!cursorMatchesQuery(key, binding)) {
        return invalidInput(CURSOR_QUERY_MISMATCH);
      }
      position = { value: key.v, name: key.n };
    }

    const page = await resolveIndex(context.env).listRepositories(namespaceSlug, {
      limit: limit.value,
      cursor: position,
      search: search.value,
      sort: sort.value,
      direction: direction.value,
    });

    if (page === null) {
      return notFound(`No namespace named "${namespaceSlug}" exists.`);
    }

    return okList(
      page.repositories.map((repository) => withRemote(context, namespaceSlug, repository)),
      {
        cursor:
          page.next === null
            ? ""
            : encodeCursor({
                v: page.next.value,
                n: page.next.name,
                ...binding,
              }),
        per_page: limit.value,
        count: page.repositories.length,
      },
    );
  });

  app.get(REPO, async (context) => {
    const namespaceSlug = context.req.param("namespace");
    const name = context.req.param("repo");
    const found = await resolveIndex(context.env).getRepository(namespaceSlug, name);

    if (found === null) {
      return notFound(noSuchRepository(namespaceSlug, name));
    }

    return ok(withRemote(context, namespaceSlug, found.repository));
  });

  /**
   * `202`, matching Artifacts: the name is free the moment this returns, but
   * discarding a repository's contents is not something a caller should have to
   * wait on to be told it worked.
   */
  app.delete(REPO, async (context) => {
    const namespaceSlug = context.req.param("namespace");
    const name = context.req.param("repo");
    const deleted = await resolveIndex(context.env).deleteRepository(namespaceSlug, name);

    if (deleted === null) {
      return notFound(noSuchRepository(namespaceSlug, name));
    }

    // The pointer is gone first, so nothing can reach a half-emptied
    // repository even if discarding its storage fails.
    await resolveObjects(context.env).get(deleted.durableObjectId).destroy();

    return ok({ id: deleted.id } satisfies DeleteRepoResult, { status: 202 });
  });
};
