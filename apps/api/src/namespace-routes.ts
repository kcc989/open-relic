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

import type {
  CreateNamespaceCommand,
  NamespaceRegistryClient,
} from "./namespace-registry.ts";
import type { ApiEnv } from "../../../alchemy.run.ts";
import { invalidRequest, notFound, problemResponse } from "./problems.ts";

/**
 * Name of the single registry object. Every request resolves the same id, so
 * slug allocation is serialized by one Durable Object.
 */
export const NAMESPACE_REGISTRY_KEY = "registry";

export const namespaceRegistryFromEnv = (
  env: ApiEnv,
): NamespaceRegistryClient => env.NAMESPACES.getByName(NAMESPACE_REGISTRY_KEY);

type Rejected = { readonly ok: false; readonly detail: string };

type ParsedCreate =
  | { readonly ok: true; readonly command: CreateNamespaceCommand }
  | Rejected;

type ParsedText = { readonly ok: true; readonly value: string | null } | Rejected;

const parseOptionalText = (
  value: unknown,
  field: string,
  maxLength: number,
): ParsedText => {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false, detail: `"${field}" must be a string.` };
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      detail: `"${field}" may be at most ${maxLength} characters.`,
    };
  }

  return { ok: true, value: trimmed.length === 0 ? null : trimmed };
};

const parseCreateBody = (payload: unknown): ParsedCreate => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, detail: "The request body must be a JSON object." };
  }

  const body = payload as Partial<Record<keyof CreateNamespaceBody, unknown>>;
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
      // A namespace always renders as something; the slug is the fallback.
      displayName: displayName.value ?? body.slug,
      description: description.value,
    },
  };
};

const namespaceLocation = (namespace: Namespace): string =>
  `${API_BASE_PATH}/namespaces/${namespace.slug}`;

/**
 * Registers the four namespace endpoints from the contract manifest against a
 * live registry, replacing the `501` stubs `app.ts` installs for everything
 * that is still unimplemented.
 */
export const registerNamespaceRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveRegistry: (env: ApiEnv) => NamespaceRegistryClient,
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
      return problemResponse({
        type: PROBLEM_TYPES.namespaceExists,
        title: "Conflict",
        status: 409,
        detail: `The namespace "${parsed.command.slug}" already exists.`,
        operation: "namespaces.create",
      });
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
    const deleted = await resolveRegistry(context.env).deleteNamespace(slug);

    if (!deleted) {
      return problemResponse(
        notFound("namespaces.delete", `No namespace named "${slug}" exists.`),
      );
    }

    return new Response(null, { status: 204 });
  });
};
