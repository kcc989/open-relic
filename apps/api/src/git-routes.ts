import {
  GIT_REPOSITORY_PATH,
  repositoryNameFromPath,
  type EndpointId,
} from "@open-relic/contracts";
import type { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import type { RepositoryObjects } from "./bindings.ts";
import { forbidden, gitAuthenticationRequired, invalidInput, notFound } from "./envelope.ts";
import {
  RECEIVE_PACK_ADVERTISEMENT_CONTENT_TYPE,
  RECEIVE_PACK_SERVICE,
} from "./git/advertisement.ts";
import type { AuthorizeGitRequest } from "./git/authorization.ts";
import { RECEIVE_PACK_RESULT_CONTENT_TYPE } from "./git/receive-pack.ts";
import type { RepositoryIndexClient, RepositoryPointer } from "./repository-index.ts";

/** Just enough of Hono's context for the preamble both Git routes share. */
type GitRouteContext = {
  readonly env: ApiEnv;
  readonly req: { readonly raw: Request; param(name: string): string };
};

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
  { repositoryIndex, repositoryObjects, authorize, notImplemented }: GitRouteDependencies,
): void => {
  /**
   * What every Git request does before it can do anything else: refuse the
   * unauthorized, then resolve `namespace/repo` in the registry.
   *
   * The refusal comes *first*, so whether a repository exists is not something
   * an unauthorized client can learn (ADR-0004), and the lookup is what keeps
   * an unknown name from waking a repository object.
   */
  const resolve = async (context: GitRouteContext): Promise<RepositoryPointer | Response> => {
    const namespace = context.req.param("namespace");
    const name = repositoryNameFromPath(context.req.param("repo"));

    const decision = await authorize({
      env: context.env,
      request: context.req.raw,
      namespace,
      repository: name,
      requiredScope: "write",
    });

    if (!decision.allowed) {
      return gitAuthenticationRequired(decision.detail);
    }

    const found = await repositoryIndex(context.env).getRepository(namespace, name);

    return found ?? notFound(`No repository named "${namespace}/${name}" exists.`);
  };

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
      return invalidInput(
        `"service" must be "${RECEIVE_PACK_SERVICE}" or "${UPLOAD_PACK_SERVICE}"; the dumb HTTP protocol is not supported.`,
      );
    }

    const found = await resolve(context);
    if (found instanceof Response) {
      return found;
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

  app.post(`${GIT_REPOSITORY_PATH}/git-receive-pack`, async (context) => {
    const found = await resolve(context);
    if (found instanceof Response) {
      return found;
    }

    // The one refusal that needs the repository itself, which is why it is here
    // rather than in the authorization seam.
    if (found.repository.read_only) {
      return forbidden(
        `The repository "${found.repository.name}" is read-only and does not accept pushes.`,
      );
    }

    const body = context.req.raw.body;
    if (body === null) {
      return invalidInput("A push must carry its ref update commands as a body.");
    }

    // Everything Git-shaped happens inside the object: it is what the push
    // serializes on, and the body streams to it rather than through the
    // Worker's memory (ADR-0004).
    const outcome = await repositoryObjects(context.env)
      .get(found.durableObjectId)
      .receivePack(body);

    if (outcome.accepted) {
      // After the refs moved, and outside the transaction that moved them. The
      // index only carries a copy of what the repository object now owns, so a
      // stamp that fails leaves it stale rather than costing the client the
      // report for a push that has already happened.
      try {
        await repositoryIndex(context.env).recordPush(
          context.req.param("namespace"),
          found.repository.name,
          {
            pushedAt: new Date().toISOString(),
            defaultBranch: outcome.retargetedTo,
          },
        );
      } catch {
        // Deliberately swallowed: see above.
      }
    }

    return new Response(outcome.report, {
      headers: {
        "Content-Type": RECEIVE_PACK_RESULT_CONTENT_TYPE,
        ...NO_CACHE_HEADERS,
      },
    });
  });
};
