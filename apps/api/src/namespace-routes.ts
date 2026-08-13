import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  NAMESPACES_PATH,
  NAMESPACE_DESCRIPTION_MAX_LENGTH,
  NAMESPACE_DISPLAY_NAME_MAX_LENGTH,
  describeNamespaceSlugViolation,
  validateNamespaceSlug,
  type DeleteNamespaceResult,
  type NamespaceInfo,
} from "@open-relic/contracts";
import { Schema } from "effect";
import type { Hono } from "hono";

import type { ApiEnv } from "../../../alchemy.run.ts";
import type { RepositoryObjects } from "./bindings.ts";
import { alreadyExists, invalidInput, notFound, ok, okList } from "./envelope.ts";
import type { CreateNamespaceCommand, NamespaceRegistryClient } from "./namespace-registry.ts";
import { encodeCursor } from "./pagination.ts";
import { parseCursorKey, parseLimit } from "./query.ts";
import { decodeJson, parseOptionalText, type Json, type Rejected } from "./request-body.ts";

type ParsedCreate = { readonly ok: true; readonly command: CreateNamespaceCommand } | Rejected;

const CreateNamespaceJson = Schema.Struct({
  slug: Schema.String,
  display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const parseCreateBody = (payload: Json): ParsedCreate => {
  const object = decodeJson(CreateNamespaceJson, payload);
  if (!object.ok) {
    return object;
  }

  const violation = validateNamespaceSlug(object.value.slug);
  if (violation !== null) {
    return {
      ok: false,
      detail: describeNamespaceSlugViolation(violation),
      pointer: "/slug",
    };
  }

  const displayName = parseOptionalText(
    object.value.display_name,
    "display_name",
    NAMESPACE_DISPLAY_NAME_MAX_LENGTH,
  );
  if (!displayName.ok) {
    return displayName;
  }

  const description = parseOptionalText(
    object.value.description,
    "description",
    NAMESPACE_DESCRIPTION_MAX_LENGTH,
  );
  if (!description.ok) {
    return description;
  }

  return {
    ok: true,
    command: {
      slug: object.value.slug,
      displayName: displayName.value ?? object.value.slug,
      description: description.value,
    },
  };
};

const namespaceLocation = (namespace: NamespaceInfo): string =>
  `${NAMESPACES_PATH}/${namespace.slug}`;

export const registerNamespaceRoutes = (
  app: Hono<{ Bindings: ApiEnv }>,
  resolveRegistry: (env: ApiEnv) => NamespaceRegistryClient,
  resolveObjects: (env: ApiEnv) => RepositoryObjects,
): void => {
  /**
   * Ours, not Artifacts': there a namespace appears with its first repository
   * and only list and get are documented. Creating one explicitly costs nothing
   * a client has to know about, and it sits on a method Artifacts has not
   * spoken for on this path.
   */
  app.post(NAMESPACES_PATH, async (context) => {
    let payload: Json;
    try {
      // SAFETY: req.json() is the JSON value at this HTTP boundary; Schema rejects the rest.
      payload = (await context.req.json()) as Json;
    } catch {
      return invalidInput("The request body must be valid JSON.");
    }

    const parsed = parseCreateBody(payload);
    if (!parsed.ok) {
      return invalidInput(parsed.detail, parsed.pointer);
    }

    const outcome = await resolveRegistry(context.env).createNamespace(parsed.command);

    if (!outcome.created) {
      return alreadyExists(`The namespace "${parsed.command.slug}" already exists.`);
    }

    return ok(outcome.namespace, {
      status: 201,
      headers: { Location: namespaceLocation(outcome.namespace) },
    });
  });

  app.get(NAMESPACES_PATH, async (context) => {
    const limit = parseLimit(context.req.query("limit"), LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    if (!limit.ok) {
      return invalidInput(limit.detail);
    }

    const cursor = parseCursorKey(context.req.query("cursor"));
    if (!cursor.ok) {
      return invalidInput(cursor.detail);
    }
    // Namespaces list in one fixed order, so the cursor carries only the slug
    // it resumes after; there is no sort for it to disagree with.
    if (cursor.value !== null && cursor.value.n === undefined) {
      return invalidInput(`"cursor" is not a cursor this service issued.`);
    }

    const page = await resolveRegistry(context.env).listNamespaces({
      limit: limit.value,
      after: cursor.value?.n ?? null,
    });

    return okList(page.namespaces, {
      cursor: page.next === null ? "" : encodeCursor({ n: page.next }),
      per_page: limit.value,
      count: page.namespaces.length,
    });
  });

  app.get(`${NAMESPACES_PATH}/:namespace`, async (context) => {
    const slug = context.req.param("namespace");
    const namespace = await resolveRegistry(context.env).getNamespace(slug);

    if (namespace === null) {
      return notFound(`No namespace named "${slug}" exists.`);
    }

    return ok(namespace);
  });

  /**
   * Also ours. It answers `200`, not the `202` a repository delete answers,
   * because it really has finished: the index rows and the objects behind them
   * are gone by the time it replies.
   */
  app.delete(`${NAMESPACES_PATH}/:namespace`, async (context) => {
    const slug = context.req.param("namespace");
    const outcome = await resolveRegistry(context.env).deleteNamespace(slug);

    if (!outcome.deleted) {
      return notFound(`No namespace named "${slug}" exists.`);
    }

    // The index rows are already gone, so this only discards storage nothing
    // can reach.
    if (outcome.repositoryObjectIds.length > 0) {
      const objects = resolveObjects(context.env);
      await Promise.all(outcome.repositoryObjectIds.map((id) => objects.get(id).destroy()));
    }

    return ok({ slug } satisfies DeleteNamespaceResult);
  });
};
