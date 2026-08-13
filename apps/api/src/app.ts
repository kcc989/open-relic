import {
  GIT_HTTP_ENDPOINTS,
  PROBLEM_TYPES,
  REST_ENDPOINTS,
  isImplementedEndpoint,
  type EndpointId,
} from "@open-relic/contracts";
import { Effect } from "effect";
import { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import {
  namespaceRegistryFromEnv,
  repositoryIndexFromEnv,
  repositoryObjectsFromEnv,
  type RepositoryObjects,
} from "./bindings.ts";
import type { NamespaceRegistryClient } from "./namespace-registry.ts";
import { registerNamespaceRoutes } from "./namespace-routes.ts";
import { notImplemented, problemResponse } from "./problems.ts";
import type { RepositoryIndexClient } from "./repository-index.ts";
import { registerRepositoryRoutes } from "./repository-routes.ts";
import {
  EndpointNotImplemented,
  GitServiceStub,
  type GitService,
} from "./stub-service.ts";

export interface AppDependencies {
  /** Stub boundary for every endpoint the Git engine has yet to implement. */
  readonly gitService?: GitService;
  /**
   * Resolves the namespace registry for a request. Defaults to the Durable
   * Object bound as `NAMESPACES`; tests substitute a local one.
   */
  readonly namespaceRegistry?: (env: ApiEnv) => NamespaceRegistryClient;
  /** Resolves the repository index, which shares the registry's object. */
  readonly repositoryIndex?: (env: ApiEnv) => RepositoryIndexClient;
  /**
   * Resolves the per-repository Durable Objects bound as `REPOSITORIES`.
   */
  readonly repositoryObjects?: (env: ApiEnv) => RepositoryObjects;
}

export const createApp = ({
  gitService = GitServiceStub,
  namespaceRegistry = namespaceRegistryFromEnv,
  repositoryIndex = repositoryIndexFromEnv,
  repositoryObjects = repositoryObjectsFromEnv,
}: AppDependencies = {}) => {
  // Bindings come from the Alchemy stack, so `context.env.NAMESPACES` is the
  // same Durable Object namespace that `alchemy.run.ts` provisions.
  const app = new Hono<{ Bindings: ApiEnv }>();

  app.get("/healthz", (context) =>
    context.json({ service: "open-relic", status: "ok" }),
  );

  registerNamespaceRoutes(app, namespaceRegistry, repositoryObjects);
  registerRepositoryRoutes(app, repositoryIndex, repositoryObjects);

  const invokeStub = async (operation: EndpointId): Promise<Response> => {
    const failure = await Effect.runPromise(
      gitService.invoke(operation).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined,
        }),
      ),
    );

    return failure instanceof EndpointNotImplemented
      ? problemResponse(notImplemented(failure.operation))
      : new Response(null, { status: 204 });
  };

  const registerStub = (
    method: "DELETE" | "GET" | "PATCH" | "POST",
    path: string,
    operation: EndpointId,
  ) => {
    app.on(method, path, () => invokeStub(operation));
  };

  for (const endpoint of REST_ENDPOINTS) {
    // Implemented endpoints are already registered above; registering a stub
    // for them would only shadow a live route with a `501`.
    if (isImplementedEndpoint(endpoint.id)) {
      continue;
    }
    registerStub(endpoint.method, endpoint.path, endpoint.id);
  }

  for (const endpoint of GIT_HTTP_ENDPOINTS) {
    // Both advertisement operations share a path. Dispatch by Git's required
    // service query parameter while keeping each operation separately named.
    if (endpoint.id.endsWith(".advertise")) {
      continue;
    }
    registerStub(endpoint.method, endpoint.path, endpoint.id);
  }

  app.get("/git/:namespace/:repo.git/info/refs", (context) =>
    invokeStub(
      context.req.query("service") === "git-upload-pack"
        ? "git.uploadPack.advertise"
        : "git.receivePack.advertise",
    ),
  );

  app.notFound(() =>
    problemResponse({
      type: PROBLEM_TYPES.notFound,
      title: "Not Found",
      status: 404,
      detail: "No route matches this request.",
    }),
  );

  return app;
};

export const app = createApp();
