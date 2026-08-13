import {
  GIT_REPOSITORY_PATH,
  PROBLEM_TYPES,
  repositoryNameFromPath,
  type EndpointId,
} from "@open-relic/contracts";
import type { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import type { RepositoryObjects } from "./bindings.ts";
import {
  RECEIVE_PACK_ADVERTISEMENT_CONTENT_TYPE,
  RECEIVE_PACK_SERVICE,
} from "./git/advertisement.ts";
import type { AuthorizeGitRequest } from "./git/authorization.ts";
import { forbidden, notFound, problemResponse } from "./problems.ts";
import type { RepositoryIndexClient } from "./repository-index.ts";

export const UPLOAD_PACK_SERVICE = "git-upload-pack";

/**
 * What Git's own server sends with an advertisement. A cached ref list would
 * have a client push against refs that have since moved.
 */
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-cache, max-age=0, must-revalidate",
  Expires: "Fri, 01 Jan 1980 00:00:00 GMT",
  Pragma: "no-cache",
} as const;

export interface GitRouteDependencies {
  readonly repositoryIndex: (env: ApiEnv) => RepositoryIndexClient;
  readonly repositoryObjects: (env: ApiEnv) => RepositoryObjects;
  readonly authorize: AuthorizeGitRequest;
  /** The stub the rest of the Git surface still answers with. */
  readonly notImplemented: (operation: EndpointId) => Promise<Response>;
}

export const registerGitRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  {
    repositoryIndex,
    repositoryObjects,
    authorize,
    notImplemented,
  }: GitRouteDependencies,
): void => {
  // Both advertisements share a path and are told apart by the service Git
  // names in the query string, so one route dispatches to two operations.
  app.get(`${GIT_REPOSITORY_PATH}/info/refs`, async (context) => {
    const service = context.req.query("service");

    if (service === UPLOAD_PACK_SERVICE) {
      return notImplemented("git.uploadPack.advertise");
    }

    if (service !== RECEIVE_PACK_SERVICE) {
      // No service parameter is Git's dumb protocol asking for a file listing.
      // We have no files to list, and saying so is better than a 404 that reads
      // like a missing repository.
      return problemResponse({
        type: PROBLEM_TYPES.invalidRequest,
        title: "Bad Request",
        status: 400,
        detail: `"service" must be "${RECEIVE_PACK_SERVICE}" or "${UPLOAD_PACK_SERVICE}"; the dumb HTTP protocol is not supported.`,
      });
    }

    const operation: EndpointId = "git.receivePack.advertise";
    const namespace = context.req.param("namespace");
    const name = repositoryNameFromPath(context.req.param("repo"));

    // Before the lookup: whether a repository exists is itself something an
    // unauthorized client should not be able to learn.
    const decision = authorize({
      env: context.env,
      request: context.req.raw,
      namespace,
      repository: name,
    });

    if (!decision.allowed) {
      return problemResponse(forbidden(operation, decision.detail));
    }

    // The registry resolves the name, so an unknown namespace or repository is
    // answered without waking a repository object.
    const found = await repositoryIndex(context.env).getRepository(
      namespace,
      name,
    );

    if (found === null) {
      return problemResponse(
        notFound(
          operation,
          `No repository named "${namespace}/${name}" exists.`,
        ),
      );
    }

    const advertisement = await repositoryObjects(context.env)
      .get(found.durableObjectId)
      .advertiseReceivePack();

    return new Response(advertisement, {
      headers: {
        "Content-Type": RECEIVE_PACK_ADVERTISEMENT_CONTENT_TYPE,
        ...NO_CACHE_HEADERS,
      },
    });
  });
};
