export const API_BASE_PATH = "/api/v1" as const;

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST";

export interface EndpointContract {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly samplePath: string;
}

export const REST_ENDPOINTS = [
  {
    id: "namespaces.create",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces`,
    samplePath: `${API_BASE_PATH}/namespaces`,
  },
  {
    id: "namespaces.list",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces`,
    samplePath: `${API_BASE_PATH}/namespaces`,
  },
  {
    id: "namespaces.get",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace`,
    samplePath: `${API_BASE_PATH}/namespaces/acme`,
  },
  {
    id: "namespaces.delete",
    method: "DELETE",
    path: `${API_BASE_PATH}/namespaces/:namespace`,
    samplePath: `${API_BASE_PATH}/namespaces/acme`,
  },
  {
    id: "repositories.create",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos`,
  },
  {
    id: "repositories.list",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos`,
  },
  {
    id: "repositories.get",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo`,
  },
  {
    id: "repositories.update",
    method: "PATCH",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo`,
  },
  {
    id: "repositories.delete",
    method: "DELETE",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo`,
  },
  {
    id: "repositories.fork",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/fork`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/fork`,
  },
  {
    id: "repositories.import",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/import`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/import`,
  },
  {
    id: "tokens.create",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/tokens`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/tokens`,
  },
  {
    id: "tokens.list",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/tokens`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/tokens`,
  },
  {
    id: "tokens.delete",
    method: "DELETE",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/tokens/:tokenId`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/tokens/token-1`,
  },
  {
    id: "contents.refs",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/refs`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/refs`,
  },
  {
    id: "contents.log",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/log`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/log`,
  },
  {
    id: "contents.commit",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/commits/:hash`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/commits/deadbeef`,
  },
  {
    id: "contents.tree",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/trees/:hash`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/trees/deadbeef`,
  },
  {
    id: "contents.blob",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/blobs/:hash`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/blobs/deadbeef`,
  },
  {
    id: "contents.file",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/files/*`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/files/src/index.ts?ref=main`,
  },
  {
    id: "contents.archive",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/archive/*`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/archive/main.tar.gz`,
  },
] as const satisfies readonly EndpointContract[];

export const GIT_HTTP_ENDPOINTS = [
  {
    id: "git.uploadPack.advertise",
    method: "GET",
    path: "/git/:namespace/:repo.git/info/refs",
    samplePath: "/git/acme/demo.git/info/refs?service=git-upload-pack",
  },
  {
    id: "git.uploadPack",
    method: "POST",
    path: "/git/:namespace/:repo.git/git-upload-pack",
    samplePath: "/git/acme/demo.git/git-upload-pack",
  },
  {
    id: "git.receivePack.advertise",
    method: "GET",
    path: "/git/:namespace/:repo.git/info/refs",
    samplePath: "/git/acme/demo.git/info/refs?service=git-receive-pack",
  },
  {
    id: "git.receivePack",
    method: "POST",
    path: "/git/:namespace/:repo.git/git-receive-pack",
    samplePath: "/git/acme/demo.git/git-receive-pack",
  },
] as const satisfies readonly EndpointContract[];

export const HTTP_ENDPOINTS = [
  ...REST_ENDPOINTS,
  ...GIT_HTTP_ENDPOINTS,
] as const;

export type EndpointId = (typeof HTTP_ENDPOINTS)[number]["id"];

/**
 * Endpoints that the API actually serves. Everything else in the manifest is
 * still registered, but answers `501`.
 *
 * `app.ts` skips stub registration for these ids and the test suite derives its
 * "still a stub" expectations from the complement, so implementing an endpoint
 * is a one-line change here rather than a hunt through the router and tests.
 */
export const IMPLEMENTED_ENDPOINT_IDS = [
  "namespaces.create",
  "namespaces.list",
  "namespaces.get",
  "namespaces.delete",
] as const satisfies readonly EndpointId[];

export type ImplementedEndpointId = (typeof IMPLEMENTED_ENDPOINT_IDS)[number];

export const isImplementedEndpoint = (
  id: EndpointId,
): id is ImplementedEndpointId =>
  (IMPLEMENTED_ENDPOINT_IDS as readonly EndpointId[]).includes(id);

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly operation?: EndpointId;
}

export const PROBLEM_BASE_URI = "https://open-relic.dev/problems" as const;

export const PROBLEM_TYPES = {
  invalidRequest: `${PROBLEM_BASE_URI}/invalid-request`,
  namespaceExists: `${PROBLEM_BASE_URI}/namespace-exists`,
  notFound: `${PROBLEM_BASE_URI}/not-found`,
  notImplemented: `${PROBLEM_BASE_URI}/not-implemented`,
} as const;

/**
 * A namespace owns repositories the way a GitHub user or organization does. It
 * is addressed by its slug in both the REST API (`/api/v1/namespaces/:slug`)
 * and Git Smart HTTP (`/git/:slug/:repo.git`), so the slug has to survive being
 * a path segment on both.
 */
export interface Namespace {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly createdAt: string;
}

export interface CreateNamespaceBody {
  readonly slug: string;
  readonly displayName?: string;
  readonly description?: string;
}

export interface NamespaceListBody {
  readonly namespaces: readonly Namespace[];
}

export const NAMESPACE_SLUG_MAX_LENGTH = 39;
export const NAMESPACE_DISPLAY_NAME_MAX_LENGTH = 100;
export const NAMESPACE_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Lowercase alphanumerics and interior hyphens. Deliberately narrower than a
 * URL path segment: no percent-encoding, no case folding, and no `.git` suffix
 * ambiguity when the slug is concatenated into a Git remote URL.
 */
export const NAMESPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Slugs that would collide with a fixed path segment of the HTTP surface.
 */
export const RESERVED_NAMESPACE_SLUGS: readonly string[] = [
  "api",
  "git",
  "healthz",
  "static",
  "well-known",
];

export type NamespaceSlugViolation =
  | "empty"
  | "malformed"
  | "reserved"
  | "too-long";

export const validateNamespaceSlug = (
  slug: string,
): NamespaceSlugViolation | null => {
  if (slug.length === 0) {
    return "empty";
  }
  if (slug.length > NAMESPACE_SLUG_MAX_LENGTH) {
    return "too-long";
  }
  if (!NAMESPACE_SLUG_PATTERN.test(slug)) {
    return "malformed";
  }
  if (RESERVED_NAMESPACE_SLUGS.includes(slug)) {
    return "reserved";
  }
  return null;
};

export const describeNamespaceSlugViolation = (
  violation: NamespaceSlugViolation,
): string => {
  switch (violation) {
    case "empty":
      return "A namespace slug is required.";
    case "too-long":
      return `A namespace slug may be at most ${NAMESPACE_SLUG_MAX_LENGTH} characters.`;
    case "malformed":
      return "A namespace slug may only contain lowercase letters, digits, and interior hyphens.";
    case "reserved":
      return "That namespace slug is reserved by the API.";
  }
};
