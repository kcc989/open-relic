import {
  GIT_HTTP_ENDPOINTS,
  REST_ENDPOINTS,
  type EndpointId,
  type ProblemDetails,
} from "@open-relic/contracts";
import { Effect } from "effect";
import { Hono } from "hono";

import {
  EndpointNotImplemented,
  GitServiceStub,
  type GitService,
} from "./stub-service.ts";

const NOT_IMPLEMENTED_TYPE =
  "https://open-relic.dev/problems/not-implemented";
const NOT_FOUND_TYPE = "https://open-relic.dev/problems/not-found";

const notImplemented = (
  operation: EndpointId,
): ProblemDetails => ({
  type: NOT_IMPLEMENTED_TYPE,
  title: "Not Implemented",
  status: 501,
  detail: `The ${operation} endpoint is registered, but its behavior has not been implemented.`,
  operation,
});

export const createApp = (service: GitService = GitServiceStub) => {
  const app = new Hono();

  app.get("/healthz", (context) =>
    context.json({ service: "open-relic", status: "ok" }),
  );

  const registerStub = (
    method: "DELETE" | "GET" | "PATCH" | "POST",
    path: string,
    operation: EndpointId,
  ) => {
    app.on(method, path, async (context) => {
      const response = await Effect.runPromise(
        service.invoke(operation).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        ),
      );

      if (response instanceof EndpointNotImplemented) {
        return context.json(notImplemented(response.operation), 501, {
          "Content-Type": "application/problem+json",
        });
      }

      return context.body(null, 204);
    });
  };

  for (const endpoint of REST_ENDPOINTS) {
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

  app.get("/git/:namespace/:repo.git/info/refs", async (context) => {
    const serviceName = context.req.query("service");
    const operation =
      serviceName === "git-upload-pack"
        ? "git.uploadPack.advertise"
        : "git.receivePack.advertise";

    const response = await Effect.runPromise(
      service.invoke(operation).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => undefined,
        }),
      ),
    );

    if (response instanceof EndpointNotImplemented) {
      return context.json(notImplemented(response.operation), 501, {
        "Content-Type": "application/problem+json",
      });
    }

    return context.body(null, 204);
  });

  app.notFound((context) =>
    context.json(
      {
        type: NOT_FOUND_TYPE,
        title: "Not Found",
        status: 404,
        detail: "No route matches this request.",
      } satisfies ProblemDetails,
      404,
      { "Content-Type": "application/problem+json" },
    ),
  );

  return app;
};

export const app = createApp();
