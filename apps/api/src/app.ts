import {
  GIT_HTTP_ENDPOINTS,
  REST_ENDPOINTS,
  isImplementedEndpoint,
  type EndpointId,
} from "@open-relic/contracts";
import { Effect } from "effect";
import { Hono, type MiddlewareHandler } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import {
  namespaceRegistryFromEnv,
  repositoryIndexFromEnv,
  repositoryObjectsFromEnv,
  tokenRegistryFromEnv,
  type RepositoryObjects,
} from "./bindings.ts";
import {
  authorizeApiToken,
  type AuthorizeControlPlaneRequest,
} from "./control-plane-authorization.ts";
import { apiTokenFromEnv } from "./api-token.ts";
import { registerContentRoutes } from "./content-routes.ts";
import { controlPlaneAuthenticationRequired, notFound, notImplemented } from "./envelope.ts";
import { registerGitRoutes } from "./git-routes.ts";
import { authorizeRepoToken, type AuthorizeGitRequest } from "./git/authorization.ts";
import type { NamespaceRegistryClient } from "./namespace-registry.ts";
import { registerNamespaceRoutes } from "./namespace-routes.ts";
import type { RepositoryIndexClient } from "./repository-index.ts";
import { registerRepositoryRoutes } from "./repository-routes.ts";
import { EndpointNotImplemented, GitServiceStub, type GitService } from "./stub-service.ts";
import { registerTokenRoutes } from "./token-routes.ts";
import type { TokenRegistryClient } from "./token-registry.ts";

export interface AppDependencies {
  readonly gitService?: GitService;
  readonly namespaceRegistry?: (env: ApiEnv) => NamespaceRegistryClient;
  readonly repositoryIndex?: (env: ApiEnv) => RepositoryIndexClient;
  readonly repositoryObjects?: (env: ApiEnv) => RepositoryObjects;
  readonly tokenRegistry?: (env: ApiEnv) => TokenRegistryClient;
  readonly authorizeGit?: AuthorizeGitRequest;
  readonly authorizeControlPlane?: AuthorizeControlPlaneRequest;
}

export const createApp = ({
  gitService = GitServiceStub,
  namespaceRegistry = namespaceRegistryFromEnv,
  repositoryIndex = repositoryIndexFromEnv,
  repositoryObjects = repositoryObjectsFromEnv,
  tokenRegistry = tokenRegistryFromEnv,
  authorizeGit,
  authorizeControlPlane = authorizeApiToken,
}: AppDependencies = {}) => {
  const app = new Hono<{ Bindings: ApiEnv }>();

  app.get("/healthz", (context) =>
    apiTokenFromEnv(context.env) === null
      ? context.json({ service: "open-relic", status: "unavailable" }, 503)
      : context.json({ service: "open-relic", status: "ok" }),
  );

  const protectControlPlane: MiddlewareHandler<{ Bindings: ApiEnv }> = async (context, next) => {
    const allowed = await authorizeControlPlane({
      env: context.env,
      request: context.req.raw,
    });
    if (!allowed) {
      return controlPlaneAuthenticationRequired();
    }
    await next();
  };

  app.use("/namespaces", protectControlPlane);
  app.use("/namespaces/*", protectControlPlane);

  registerNamespaceRoutes(app, namespaceRegistry, repositoryObjects);
  registerRepositoryRoutes(app, repositoryIndex, repositoryObjects, tokenRegistry);
  registerContentRoutes(app, repositoryIndex, repositoryObjects);
  registerTokenRoutes(app, tokenRegistry, repositoryIndex);

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
      ? notImplemented(failure.operation)
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
    // Both advertisement operations share a path, so the Git routes own it and
    // dispatch by the service Git names in the query string.
    if (endpoint.id.endsWith(".advertise") || isImplementedEndpoint(endpoint.id)) {
      continue;
    }
    registerStub(endpoint.method, endpoint.path, endpoint.id);
  }

  registerGitRoutes(app, {
    repositoryIndex,
    repositoryObjects,
    authorize: authorizeGit ?? authorizeRepoToken(tokenRegistry),
  });

  app.notFound(() => notFound("No route matches this request."));

  return app;
};

export const app = createApp();
