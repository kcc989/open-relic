import { ERROR_CODES, NAMESPACES_PATH, type ApiError } from "@open-relic/contracts";
import type { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import type { RepositoryObjects } from "./bindings.ts";
import { fail, notFound, ok } from "./envelope.ts";
import { isObjectId, type ObjectType } from "./object.ts";
import { ObjectParseError } from "./object-parse.ts";
import { parseCommit, parseTree } from "./repository-content.ts";
import type { RepositoryIndexClient } from "./repository-index.ts";

const REPO = `${NAMESPACES_PATH}/:namespace/repos/:repo` as const;
const ERROR_DOCUMENTATION = "https://developers.cloudflare.com/artifacts/api/errors";

type DirectObjectKind = Extract<ObjectType, "blob" | "commit" | "tree">;

const documentedFailure = (
  status: number,
  code: number,
  message: string,
  source?: { readonly pointer: string },
): Response => {
  const error: ApiError = {
    code,
    message,
    documentation_url: `${ERROR_DOCUMENTATION}#${code}`,
  };
  if (source !== undefined) {
    return fail(status, { ...error, source });
  }
  return fail(status, error);
};

const invalidHash = (): Response =>
  documentedFailure(400, ERROR_CODES.invalidInput, "Invalid SHA-1 hash", { pointer: "/hash" });

const objectNotFound = (kind: DirectObjectKind): Response =>
  documentedFailure(
    404,
    ERROR_CODES.notFound,
    `${kind[0]!.toUpperCase()}${kind.slice(1)} not found`,
  );

const repositoryNotFound = (namespaceSlug: string, repositoryName: string): Response =>
  notFound(`No repository named "${namespaceSlug}/${repositoryName}" exists.`);

const corruptObject = (): Response =>
  documentedFailure(500, ERROR_CODES.internalError, "A stored git object is corrupt.");

export const registerContentRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveIndex: (env: ApiEnv) => RepositoryIndexClient,
  resolveObjects: (env: ApiEnv) => RepositoryObjects,
): void => {
  const resolveRepository = async (env: ApiEnv, namespaceSlug: string, repositoryName: string) => {
    const found = await resolveIndex(env).getRepository(namespaceSlug, repositoryName);
    return found === null ? null : resolveObjects(env).get(found.durableObjectId);
  };

  app.get(`${REPO}/commit/:hash`, async (context) => {
    const hash = context.req.param("hash");
    if (!isObjectId(hash)) {
      return invalidHash();
    }

    const namespaceSlug = context.req.param("namespace");
    const repositoryName = context.req.param("repo");
    const repository = await resolveRepository(context.env, namespaceSlug, repositoryName);
    if (repository === null) {
      return repositoryNotFound(namespaceSlug, repositoryName);
    }
    const object = await repository.readObject(hash);
    if (object === null) {
      return objectNotFound("commit");
    }
    if (object.type !== "commit") {
      return corruptObject();
    }

    try {
      return ok(parseCommit(hash, object.bytes));
    } catch (error) {
      if (error instanceof ObjectParseError) {
        return corruptObject();
      }
      throw error;
    }
  });

  app.get(`${REPO}/tree/:hash`, async (context) => {
    const hash = context.req.param("hash");
    if (!isObjectId(hash)) {
      return invalidHash();
    }

    const namespaceSlug = context.req.param("namespace");
    const repositoryName = context.req.param("repo");
    const repository = await resolveRepository(context.env, namespaceSlug, repositoryName);
    if (repository === null) {
      return repositoryNotFound(namespaceSlug, repositoryName);
    }
    const object = await repository.readObject(hash);
    if (object === null) {
      return objectNotFound("tree");
    }
    if (object.type !== "tree") {
      return corruptObject();
    }

    try {
      return ok(parseTree(object.bytes));
    } catch (error) {
      if (error instanceof ObjectParseError) {
        return corruptObject();
      }
      throw error;
    }
  });

  app.get(`${REPO}/blob/:hash`, async (context) => {
    const hash = context.req.param("hash");
    if (!isObjectId(hash)) {
      return invalidHash();
    }

    const namespaceSlug = context.req.param("namespace");
    const repositoryName = context.req.param("repo");
    const repository = await resolveRepository(context.env, namespaceSlug, repositoryName);
    if (repository === null) {
      return repositoryNotFound(namespaceSlug, repositoryName);
    }
    const stream = await repository.readBlob(hash);
    if (stream === null) {
      return objectNotFound("blob");
    }

    return new Response(stream, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  });
};
