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
  describeBranchNameViolation,
  describeRepositoryNameViolation,
  validateBranchName,
  validateRepositoryName,
  type CreateRepoRequest,
  type CreateRepoResult,
  type DeleteRepoResult,
  type RepoInfo,
  type RepoWithRemote,
} from "@open-relic/contracts";
import type { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import type { RepositoryObjects } from "./bindings.ts";
import {
  alreadyExists,
  invalidInput,
  invalidRepoName,
  notFound,
  ok,
  okList,
} from "./envelope.ts";
import { parseChoice, parseCursor, parseLimit, parseSearch } from "./query.ts";
import { gitRemoteUrl, mintArtifactToken } from "./remote.ts";
import type {
  CreateRepositoryCommand,
  RepositoryIndexClient,
} from "./repository-index.ts";
import {
  parseJsonObject,
  parseOptionalFlag,
  parseOptionalText,
  type Rejected,
} from "./request-body.ts";

type NewRepository = Omit<CreateRepositoryCommand, "durableObjectId">;

type ParsedCreate =
  | { readonly ok: true; readonly command: NewRepository }
  | (Rejected & { readonly badName?: true });

const parseCreateBody = (
  namespaceSlug: string,
  payload: unknown,
): ParsedCreate => {
  const object = parseJsonObject(payload);
  if (!object.ok) {
    return object;
  }

  const body = object.value as Partial<
    Record<keyof CreateRepoRequest, unknown>
  >;
  if (typeof body.name !== "string") {
    return { ok: false, detail: `"name" must be a string.`, badName: true };
  }

  const nameViolation = validateRepositoryName(body.name);
  if (nameViolation !== null) {
    return {
      ok: false,
      detail: describeRepositoryNameViolation(nameViolation),
      badName: true,
    };
  }

  const description = parseOptionalText(
    body.description,
    "description",
    REPOSITORY_DESCRIPTION_MAX_LENGTH,
  );
  if (!description.ok) {
    return description;
  }

  const readOnly = parseOptionalFlag(body.read_only, "read_only", false);
  if (!readOnly.ok) {
    return readOnly;
  }

  if (
    body.default_branch !== undefined &&
    typeof body.default_branch !== "string"
  ) {
    return {
      ok: false,
      detail: `"default_branch" must be a string.`,
      pointer: "/default_branch",
    };
  }

  const defaultBranch = body.default_branch ?? DEFAULT_BRANCH;
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
      name: body.name,
      description: description.value,
      defaultBranch,
      readOnly: readOnly.value,
    },
  };
};

const noSuchRepository = (namespaceSlug: string, name: string): string =>
  `No repository named "${namespaceSlug}/${name}" exists.`;

export const registerRepositoryRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveIndex: (env: ApiEnv) => RepositoryIndexClient,
  resolveObjects: (env: ApiEnv) => RepositoryObjects,
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

    let payload: unknown;
    try {
      payload = await context.req.json();
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
        : alreadyExists(
            `The repository "${namespaceSlug}/${parsed.command.name}" already exists.`,
          );
    }

    // The name is claimed; now give the object its Git state.
    await objects.get(durableObjectId).initialize({
      defaultBranch: outcome.repository.default_branch,
      createdAt: outcome.repository.created_at,
    });

    // Narrower than the list and get shape on purpose: Artifacts answers a
    // create with the identity, the remote, and the one token it will not show
    // again.
    return ok({
      id: outcome.repository.id,
      name: outcome.repository.name,
      description: outcome.repository.description,
      default_branch: outcome.repository.default_branch,
      remote: gitRemoteUrl(
        context.req.url,
        namespaceSlug,
        outcome.repository.name,
      ),
      token: mintArtifactToken(),
    } satisfies CreateRepoResult);
  });

  app.get(REPOS, async (context) => {
    const namespaceSlug = context.req.param("namespace");

    const limit = parseLimit(
      context.req.query("limit"),
      LIST_DEFAULT_LIMIT,
      LIST_MAX_LIMIT,
    );
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

    const search = parseSearch(
      context.req.query("search"),
      REPOSITORY_NAME_MAX_LENGTH,
    );
    if (!search.ok) {
      return invalidInput(search.detail);
    }

    const page = await resolveIndex(context.env).listRepositories(
      namespaceSlug,
      {
        limit: limit.value,
        cursor: parseCursor(context.req.query("cursor")),
        search: search.value,
        sort: sort.value,
        direction: direction.value,
      },
    );

    if (page === null) {
      return notFound(`No namespace named "${namespaceSlug}" exists.`);
    }

    return okList(
      page.repositories.map((repository) =>
        withRemote(context, namespaceSlug, repository),
      ),
      {
        cursor: page.cursor,
        per_page: limit.value,
        count: page.repositories.length,
      },
    );
  });

  app.get(REPO, async (context) => {
    const namespaceSlug = context.req.param("namespace");
    const name = context.req.param("repo");
    const found = await resolveIndex(context.env).getRepository(
      namespaceSlug,
      name,
    );

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
    const deleted = await resolveIndex(context.env).deleteRepository(
      namespaceSlug,
      name,
    );

    if (deleted === null) {
      return notFound(noSuchRepository(namespaceSlug, name));
    }

    // The pointer is gone first, so nothing can reach a half-emptied
    // repository even if discarding its storage fails.
    await resolveObjects(context.env).get(deleted.durableObjectId).destroy();

    return ok({ id: deleted.id } satisfies DeleteRepoResult, { status: 202 });
  });
};
