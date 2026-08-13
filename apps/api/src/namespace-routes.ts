import {
  API_BASE_PATH,
  NAMESPACE_DESCRIPTION_MAX_LENGTH,
  NAMESPACE_DISPLAY_NAME_MAX_LENGTH,
  PROBLEM_TYPES,
  describeNamespaceSlugViolation,
  validateNamespaceSlug,
  type CreateNamespaceBody,
  type Namespace,
  type NamespaceListBody,
} from "@open-relic/contracts";
import type { Hono } from "hono";

import type { RepositoryObjects } from "./bindings.ts";
import type {
  CreateNamespaceCommand,
  NamespaceRegistryClient,
} from "./namespace-registry.ts";
import type { ApiEnv } from "../../../alchemy.run.ts";
import {
  conflict,
  invalidRequest,
  notFound,
  problemResponse,
} from "./problems.ts";
import {
  parseJsonObject,
  parseOptionalText,
  type Rejected,
} from "./request-body.ts";

type ParsedCreate =
  | { readonly ok: true; readonly command: CreateNamespaceCommand }
  | Rejected;

const parseCreateBody = (payload: unknown): ParsedCreate => {
  const object = parseJsonObject(payload);
  if (!object.ok) {
    return object;
  }

  const body = object.value as Partial<
    Record<keyof CreateNamespaceBody, unknown>
  >;
  if (typeof body.slug !== "string") {
    return { ok: false, detail: `"slug" must be a string.` };
  }

  const violation = validateNamespaceSlug(body.slug);
  if (violation !== null) {
    return { ok: false, detail: describeNamespaceSlugViolation(violation) };
  }

  const displayName = parseOptionalText(
    body.displayName,
    "displayName",
    NAMESPACE_DISPLAY_NAME_MAX_LENGTH,
  );
  if (!displayName.ok) {
    return displayName;
  }

  const description = parseOptionalText(
    body.description,
    "description",
    NAMESPACE_DESCRIPTION_MAX_LENGTH,
  );
  if (!description.ok) {
    return description;
  }

  return {
    ok: true,
    command: {
      slug: body.slug,
      displayName: displayName.value ?? body.slug,
      description: description.value,
    },
  };
};

const namespaceLocation = (namespace: Namespace): string =>
  `${API_BASE_PATH}/namespaces/${namespace.slug}`;

export const registerNamespaceRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveRegistry: (env: ApiEnv) => NamespaceRegistryClient,
  resolveObjects: (env: ApiEnv) => RepositoryObjects,
): void => {
  app.post(`${API_BASE_PATH}/namespaces`, async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return problemResponse(
        invalidRequest("namespaces.create", "The request body must be valid JSON."),
      );
    }

    const parsed = parseCreateBody(payload);
    if (!parsed.ok) {
      return problemResponse(
        invalidRequest("namespaces.create", parsed.detail),
      );
    }

    const outcome = await resolveRegistry(context.env).createNamespace(
      parsed.command,
    );

    if (!outcome.created) {
      return problemResponse(
        conflict(
          "namespaces.create",
          PROBLEM_TYPES.namespaceExists,
          `The namespace "${parsed.command.slug}" already exists.`,
        ),
      );
    }

    return Response.json(outcome.namespace, {
      status: 201,
      headers: { Location: namespaceLocation(outcome.namespace) },
    });
  });

  app.get(`${API_BASE_PATH}/namespaces`, async (context) => {
    const namespaces = await resolveRegistry(context.env).listNamespaces();

    return Response.json({ namespaces } satisfies NamespaceListBody);
  });

  app.get(`${API_BASE_PATH}/namespaces/:namespace`, async (context) => {
    const slug = context.req.param("namespace");
    const namespace = await resolveRegistry(context.env).getNamespace(slug);

    if (namespace === null) {
      return problemResponse(
        notFound("namespaces.get", `No namespace named "${slug}" exists.`),
      );
    }

    return Response.json(namespace);
  });

  app.delete(`${API_BASE_PATH}/namespaces/:namespace`, async (context) => {
    const slug = context.req.param("namespace");
    const outcome = await resolveRegistry(context.env).deleteNamespace(slug);

    if (!outcome.deleted) {
      return problemResponse(
        notFound("namespaces.delete", `No namespace named "${slug}" exists.`),
      );
    }

    // The index rows are already gone, so this only discards storage nothing
    // can reach.
    if (outcome.repositoryObjectIds.length > 0) {
      const objects = resolveObjects(context.env);
      await Promise.all(
        outcome.repositoryObjectIds.map((id) => objects.get(id).destroy()),
      );
    }

    return new Response(null, { status: 204 });
  });
};
