import { ERROR_CODES, NAMESPACES_PATH, type ApiError } from "@open-relic/contracts";
import type { Hono } from "hono";
import mime from "mime";

import type { ApiEnv } from "../../../alchemy.run.ts";
import type { RepositoryObjects } from "./bindings.ts";
import { fail, ok } from "./envelope.ts";
import { isObjectId, type ObjectType } from "./object.ts";
import { ObjectParseError } from "./object-parse.ts";
import { parseCommit, parseTree } from "./repository-content.ts";
import type { RepositoryResolver } from "./repository-resolution.ts";

const REPO = `${NAMESPACES_PATH}/:namespace/repos/:repo` as const;
const ERROR_DOCUMENTATION = "https://developers.cloudflare.com/artifacts/api/errors";
const LOG_DEFAULT_LIMIT = 50;
const LOG_MAX_LIMIT = 1_000;
const LOG_MAX_OFFSET = 10_000;

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

const corruptObject = (): Response =>
  documentedFailure(500, ERROR_CODES.internalError, "A stored git object is corrupt.");

const fileNotFound = (): Response => documentedFailure(404, ERROR_CODES.notFound, "File not found");

const revisionNotFound = (): Response =>
  documentedFailure(404, ERROR_CODES.notFound, "Revision not found");

const invalidLogParameter = (name: "limit" | "offset", detail: string): Response =>
  documentedFailure(400, ERROR_CODES.invalidInput, `"${name}" ${detail}`, {
    pointer: `/${name}`,
  });

const parseLogInteger = (
  raw: string | undefined,
  name: "limit" | "offset",
  fallback: number,
): number | Response => {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^-?\d+$/.test(raw)) {
    return invalidLogParameter(name, "must be a non-negative integer.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return invalidLogParameter(name, "is too large.");
  }
  if (name === "limit" && (value < 1 || value > LOG_MAX_LIMIT)) {
    return invalidLogParameter(name, `must be between 1 and ${LOG_MAX_LIMIT}.`);
  }
  if (name === "offset" && (value < 0 || value > LOG_MAX_OFFSET)) {
    return invalidLogParameter(name, `must be between 0 and ${LOG_MAX_OFFSET}.`);
  }
  return value;
};

export const registerContentRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveRepository: RepositoryResolver,
  resolveObjects: (env: ApiEnv) => RepositoryObjects,
): void => {
  app.get(`${REPO}/log`, async (context) => {
    const limit = parseLogInteger(context.req.query("limit"), "limit", LOG_DEFAULT_LIMIT);
    if (limit instanceof Response) {
      return limit;
    }
    const offset = parseLogInteger(context.req.query("offset"), "offset", 0);
    if (offset instanceof Response) {
      return offset;
    }

    const namespaceSlug = context.req.param("namespace");
    const repositoryName = context.req.param("repo");
    const resolved = await resolveRepository.resolve({
      env: context.env,
      namespace: namespaceSlug,
      name: repositoryName,
    });
    if (resolved instanceof Response) {
      return resolved;
    }

    const history = await resolveObjects(context.env)
      .get(resolved.durableObjectId)
      .readHistory(context.req.query("ref") ?? null, limit, offset);
    if (!history.ok) {
      return history.reason === "revision-not-found" ? revisionNotFound() : corruptObject();
    }
    return ok(history.commits);
  });

  const resolvedFile = async (
    env: ApiEnv,
    namespaceSlug: string,
    repositoryName: string,
    revision: string | null,
    path: string,
  ): Promise<Response | ReadableStream<Uint8Array>> => {
    const resolved = await resolveRepository.resolve({
      env,
      namespace: namespaceSlug,
      name: repositoryName,
    });
    if (resolved instanceof Response) {
      return resolved;
    }

    const file = await resolveObjects(env).get(resolved.durableObjectId).readFile(revision, path);
    if (file.ok) {
      return file.bytes;
    }
    if (file.reason === "revision-not-found") {
      return revisionNotFound();
    }
    if (file.reason === "file-not-found" || file.reason === "wrong-object-type") {
      return fileNotFound();
    }
    return corruptObject();
  };

  app.get(`${REPO}/file`, async (context) => {
    const path = context.req.query("path");
    if (path === undefined || path.length === 0) {
      return documentedFailure(400, ERROR_CODES.invalidInput, '"path" is required.', {
        pointer: "/path",
      });
    }

    const result = await resolvedFile(
      context.env,
      context.req.param("namespace"),
      context.req.param("repo"),
      context.req.query("ref") ?? null,
      path,
    );
    return result instanceof Response
      ? result
      : new Response(result, { headers: { "Content-Type": "application/octet-stream" } });
  });

  app.get(`${REPO}/raw/:ref/*`, async (context) => {
    let path: string;
    try {
      // The first seven components are empty, namespaces, namespace, repos,
      // repo, raw, and ref. Decode each file-path component exactly once so a
      // literal percent sign is not mistaken for a second layer of escaping.
      path = new URL(context.req.raw.url).pathname
        .split("/")
        .slice(7)
        .map(decodeURIComponent)
        .join("/");
    } catch (error) {
      if (error instanceof URIError) {
        return documentedFailure(400, ERROR_CODES.invalidInput, "Invalid file path", {
          pointer: "/path",
        });
      }
      throw error;
    }
    if (path.length === 0) {
      return fileNotFound();
    }
    const result = await resolvedFile(
      context.env,
      context.req.param("namespace"),
      context.req.param("repo"),
      context.req.param("ref"),
      path,
    );
    return result instanceof Response
      ? result
      : new Response(result, {
          headers: { "Content-Type": mime.getType(path) ?? "application/octet-stream" },
        });
  });

  app.get(`${REPO}/commit/:hash`, async (context) => {
    const hash = context.req.param("hash");
    if (!isObjectId(hash)) {
      return invalidHash();
    }

    const namespaceSlug = context.req.param("namespace");
    const repositoryName = context.req.param("repo");
    const resolved = await resolveRepository.resolve({
      env: context.env,
      namespace: namespaceSlug,
      name: repositoryName,
    });
    if (resolved instanceof Response) {
      return resolved;
    }
    const object = await resolveObjects(context.env).get(resolved.durableObjectId).readObject(hash);
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
    const resolved = await resolveRepository.resolve({
      env: context.env,
      namespace: namespaceSlug,
      name: repositoryName,
    });
    if (resolved instanceof Response) {
      return resolved;
    }
    const object = await resolveObjects(context.env).get(resolved.durableObjectId).readObject(hash);
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
    const resolved = await resolveRepository.resolve({
      env: context.env,
      namespace: namespaceSlug,
      name: repositoryName,
    });
    if (resolved instanceof Response) {
      return resolved;
    }
    const stream = await resolveObjects(context.env).get(resolved.durableObjectId).readBlob(hash);
    if (stream === null) {
      return objectNotFound("blob");
    }

    return new Response(stream, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  });
};
