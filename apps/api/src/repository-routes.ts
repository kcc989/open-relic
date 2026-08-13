import {
  API_BASE_PATH,
  DEFAULT_BRANCH,
  PROBLEM_TYPES,
  REPOSITORY_DESCRIPTION_MAX_LENGTH,
  describeBranchNameViolation,
  describeRepositoryNameViolation,
  validateBranchName,
  validateRepositoryName,
  type CreateRepositoryBody,
  type Repository,
  type RepositoryListBody,
} from "@open-relic/contracts";
import type { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import type { RepositoryObjects } from "./bindings.ts";
import { conflict, invalidRequest, notFound, problemResponse } from "./problems.ts";
import type {
  CreateRepositoryCommand,
  RepositoryIndexClient,
} from "./repository-index.ts";
import {
  parseJsonObject,
  parseOptionalText,
  type Rejected,
} from "./request-body.ts";

/** Everything a create needs except the object id, which the route mints. */
type NewRepository = Omit<CreateRepositoryCommand, "durableObjectId">;

type ParsedCreate = { readonly ok: true; readonly command: NewRepository } | Rejected;

const parseCreateBody = (
  namespaceSlug: string,
  payload: unknown,
): ParsedCreate => {
  const object = parseJsonObject(payload);
  if (!object.ok) {
    return object;
  }

  const body = object.value as Partial<Record<keyof CreateRepositoryBody, unknown>>;
  if (typeof body.name !== "string") {
    return { ok: false, detail: `"name" must be a string.` };
  }

  const nameViolation = validateRepositoryName(body.name);
  if (nameViolation !== null) {
    return { ok: false, detail: describeRepositoryNameViolation(nameViolation) };
  }

  const description = parseOptionalText(
    body.description,
    "description",
    REPOSITORY_DESCRIPTION_MAX_LENGTH,
  );
  if (!description.ok) {
    return description;
  }

  if (body.defaultBranch !== undefined && typeof body.defaultBranch !== "string") {
    return { ok: false, detail: `"defaultBranch" must be a string.` };
  }

  const defaultBranch = body.defaultBranch ?? DEFAULT_BRANCH;
  const branchViolation = validateBranchName(defaultBranch);
  if (branchViolation !== null) {
    return { ok: false, detail: describeBranchNameViolation(branchViolation) };
  }

  return {
    ok: true,
    command: {
      namespaceSlug,
      name: body.name,
      description: description.value,
      defaultBranch,
    },
  };
};

const repositoryLocation = (repository: Repository): string =>
  `${API_BASE_PATH}/namespaces/${repository.namespace}/repos/${repository.name}`;

const noSuchRepository = (namespaceSlug: string, name: string): string =>
  `No repository named "${namespaceSlug}/${name}" exists.`;

/**
 * Registers the repository endpoints from the contract manifest.
 *
 * Every route resolves a name through the index first; the repository object is
 * only reached for the operations that change what it stores.
 */
export const registerRepositoryRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveIndex: (env: ApiEnv) => RepositoryIndexClient,
  resolveObjects: (env: ApiEnv) => RepositoryObjects,
): void => {
  const REPOS = `${API_BASE_PATH}/namespaces/:namespace/repos` as const;
  const REPO = `${REPOS}/:repo` as const;

  app.post(REPOS, async (context) => {
    const namespaceSlug = context.req.param("namespace");

    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return problemResponse(
        invalidRequest(
          "repositories.create",
          "The request body must be valid JSON.",
        ),
      );
    }

    const parsed = parseCreateBody(namespaceSlug, payload);
    if (!parsed.ok) {
      return problemResponse(
        invalidRequest("repositories.create", parsed.detail),
      );
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
      return problemResponse(
        outcome.reason === "namespace-missing"
          ? notFound(
              "repositories.create",
              `No namespace named "${namespaceSlug}" exists.`,
            )
          : conflict(
              "repositories.create",
              PROBLEM_TYPES.repositoryExists,
              `The repository "${namespaceSlug}/${parsed.command.name}" already exists.`,
            ),
      );
    }

    // The name is claimed; now give the object its Git state. Initialization is
    // idempotent, so a retry after a failed round trip converges rather than
    // resetting a repository that already answered for itself.
    await objects.get(durableObjectId).initialize({
      defaultBranch: outcome.repository.defaultBranch,
      createdAt: outcome.repository.createdAt,
    });

    return Response.json(outcome.repository, {
      status: 201,
      headers: { Location: repositoryLocation(outcome.repository) },
    });
  });

  app.get(REPOS, async (context) => {
    const namespaceSlug = context.req.param("namespace");
    const repositories = await resolveIndex(context.env).listRepositories(
      namespaceSlug,
    );

    if (repositories === null) {
      return problemResponse(
        notFound(
          "repositories.list",
          `No namespace named "${namespaceSlug}" exists.`,
        ),
      );
    }

    return Response.json({ repositories } satisfies RepositoryListBody);
  });

  app.get(REPO, async (context) => {
    const namespaceSlug = context.req.param("namespace");
    const name = context.req.param("repo");
    const found = await resolveIndex(context.env).getRepository(
      namespaceSlug,
      name,
    );

    if (found === null) {
      return problemResponse(
        notFound("repositories.get", noSuchRepository(namespaceSlug, name)),
      );
    }

    return Response.json(found.repository);
  });

  app.delete(REPO, async (context) => {
    const namespaceSlug = context.req.param("namespace");
    const name = context.req.param("repo");
    const durableObjectId = await resolveIndex(context.env).deleteRepository(
      namespaceSlug,
      name,
    );

    if (durableObjectId === null) {
      return problemResponse(
        notFound("repositories.delete", noSuchRepository(namespaceSlug, name)),
      );
    }

    // The pointer is gone first, so nothing can reach a half-emptied
    // repository even if discarding its storage fails.
    await resolveObjects(context.env).get(durableObjectId).destroy();

    return new Response(null, { status: 204 });
  });
};
