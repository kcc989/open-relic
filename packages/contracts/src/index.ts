/**
 * Artifacts documents its routes relative to `/accounts/$ACCOUNT_ID`, hung off
 * `https://api.cloudflare.com/client/v4`. An installation is single-tenant and
 * is nothing but Artifacts, so it serves the same endpoints at the root: every
 * segment from `/namespaces` rightward matches Artifacts exactly, and the base
 * URL is the one thing a client changes — the same thing it already changes for
 * the host.
 */
export const NAMESPACES_PATH = "/namespaces" as const;

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST";

export interface EndpointContract {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly samplePath: string;
}

const NAMESPACE = `${NAMESPACES_PATH}/:namespace` as const;
const REPO = `${NAMESPACE}/repos/:repo` as const;
const SAMPLE_NAMESPACE = `${NAMESPACES_PATH}/acme` as const;
const SAMPLE_REPO = `${SAMPLE_NAMESPACE}/repos/demo` as const;

export const REST_ENDPOINTS = [
  // Artifacts creates a namespace implicitly with its first repository and
  // documents only list and get. Explicit create and delete are ours; they sit
  // on methods Artifacts has not spoken for.
  {
    id: "namespaces.create",
    method: "POST",
    path: NAMESPACES_PATH,
    samplePath: NAMESPACES_PATH,
  },
  {
    id: "namespaces.list",
    method: "GET",
    path: NAMESPACES_PATH,
    samplePath: `${NAMESPACES_PATH}?limit=20`,
  },
  {
    id: "namespaces.get",
    method: "GET",
    path: NAMESPACE,
    samplePath: SAMPLE_NAMESPACE,
  },
  {
    id: "namespaces.delete",
    method: "DELETE",
    path: NAMESPACE,
    samplePath: SAMPLE_NAMESPACE,
  },
  {
    id: "repositories.create",
    method: "POST",
    path: `${NAMESPACE}/repos`,
    samplePath: `${SAMPLE_NAMESPACE}/repos`,
  },
  {
    id: "repositories.list",
    method: "GET",
    path: `${NAMESPACE}/repos`,
    samplePath: `${SAMPLE_NAMESPACE}/repos?limit=20&sort=updated_at&direction=desc`,
  },
  {
    id: "repositories.get",
    method: "GET",
    path: REPO,
    samplePath: SAMPLE_REPO,
  },
  {
    id: "repositories.update",
    method: "PATCH",
    path: REPO,
    samplePath: SAMPLE_REPO,
  },
  {
    id: "repositories.delete",
    method: "DELETE",
    path: REPO,
    samplePath: SAMPLE_REPO,
  },
  {
    id: "repositories.fork",
    method: "POST",
    path: `${REPO}/fork`,
    samplePath: `${SAMPLE_REPO}/fork`,
  },
  {
    id: "repositories.import",
    method: "POST",
    path: `${REPO}/import`,
    samplePath: `${SAMPLE_REPO}/import`,
  },
  // A token is minted for a repository but issued by the namespace: the request
  // body names the repo, so one namespace-scoped route mints for all of them.
  {
    id: "tokens.create",
    method: "POST",
    path: `${NAMESPACE}/tokens`,
    samplePath: `${SAMPLE_NAMESPACE}/tokens`,
  },
  {
    id: "tokens.list",
    method: "GET",
    path: `${REPO}/tokens`,
    samplePath: `${SAMPLE_REPO}/tokens?state=all&per_page=30&page=1`,
  },
  {
    id: "tokens.delete",
    method: "DELETE",
    path: `${NAMESPACE}/tokens/:tokenId`,
    samplePath: `${SAMPLE_NAMESPACE}/tokens/0123456789abcdef`,
  },
  {
    id: "contents.log",
    method: "GET",
    path: `${REPO}/log`,
    samplePath: `${SAMPLE_REPO}/log?ref=main&limit=10`,
  },
  {
    id: "contents.commit",
    method: "GET",
    path: `${REPO}/commit/:hash`,
    samplePath: `${SAMPLE_REPO}/commit/deadbeef`,
  },
  {
    id: "contents.tree",
    method: "GET",
    path: `${REPO}/tree/:hash`,
    samplePath: `${SAMPLE_REPO}/tree/deadbeef`,
  },
  {
    id: "contents.blob",
    method: "GET",
    path: `${REPO}/blob/:hash`,
    samplePath: `${SAMPLE_REPO}/blob/deadbeef`,
  },
  {
    id: "contents.file",
    method: "GET",
    path: `${REPO}/file`,
    samplePath: `${SAMPLE_REPO}/file?ref=main&path=README.md`,
  },
  // The ref and the path are both slash-bearing, so the ref takes the first
  // segment and the wildcard takes the rest.
  {
    id: "contents.raw",
    method: "GET",
    path: `${REPO}/raw/:ref/*`,
    samplePath: `${SAMPLE_REPO}/raw/main/README.md`,
  },
] as const satisfies readonly EndpointContract[];

/** A clone URL carries the suffix; a stored repository name never does. */
export const GIT_REPOSITORY_SUFFIX = ".git";

/**
 * The `.git` suffix is a constraint on the parameter rather than text after it:
 * a router reads `/git/:namespace/:repo.git/…` as a parameter *named* `repo.git`
 * that matches a suffix-less URL just as happily.
 */
export const GIT_REPOSITORY_PATH = "/git/:namespace/:repo{.+\\.git}" as const;

/** `demo.git` as it arrives from the router, back to the name `demo`. */
export const repositoryNameFromPath = (parameter: string): string =>
  parameter.slice(0, -GIT_REPOSITORY_SUFFIX.length);

export const GIT_HTTP_ENDPOINTS = [
  {
    id: "git.uploadPack.advertise",
    method: "GET",
    path: `${GIT_REPOSITORY_PATH}/info/refs`,
    samplePath: "/git/acme/demo.git/info/refs?service=git-upload-pack",
  },
  {
    id: "git.uploadPack",
    method: "POST",
    path: `${GIT_REPOSITORY_PATH}/git-upload-pack`,
    samplePath: "/git/acme/demo.git/git-upload-pack",
  },
  {
    id: "git.receivePack.advertise",
    method: "GET",
    path: `${GIT_REPOSITORY_PATH}/info/refs`,
    samplePath: "/git/acme/demo.git/info/refs?service=git-receive-pack",
  },
  {
    id: "git.receivePack",
    method: "POST",
    path: `${GIT_REPOSITORY_PATH}/git-receive-pack`,
    samplePath: "/git/acme/demo.git/git-receive-pack",
  },
] as const satisfies readonly EndpointContract[];

export const HTTP_ENDPOINTS = [...REST_ENDPOINTS, ...GIT_HTTP_ENDPOINTS] as const;

export type EndpointId = (typeof HTTP_ENDPOINTS)[number]["id"];

/**
 * `app.ts` skips stub registration for these ids and the test suite derives its
 * "still a stub" expectations from the complement, so implementing an endpoint
 * is a one-line change here rather than a hunt through the router and tests.
 */
export const IMPLEMENTED_ENDPOINT_IDS = [
  "namespaces.create",
  "namespaces.list",
  "namespaces.get",
  "namespaces.delete",
  "repositories.create",
  "repositories.list",
  "repositories.get",
  "repositories.delete",
  "repositories.fork",
  "tokens.create",
  "tokens.list",
  "tokens.delete",
  "contents.commit",
  "contents.tree",
  "contents.blob",
  "git.receivePack.advertise",
  "git.receivePack",
  "git.uploadPack.advertise",
  "git.uploadPack",
] as const satisfies readonly EndpointId[];

export type ImplementedEndpointId = (typeof IMPLEMENTED_ENDPOINT_IDS)[number];

export const isImplementedEndpoint = (id: EndpointId): id is ImplementedEndpointId =>
  IMPLEMENTED_ENDPOINT_IDS.some((implemented) => implemented === id);

/** The Git remote handed back on create; only the path shape has to match. */
export const gitRemotePath = (namespaceSlug: string, name: string): string =>
  `/git/${namespaceSlug}/${name}.git`;

// ---------------------------------------------------------------------------
// The Cloudflare v4 envelope
// ---------------------------------------------------------------------------

export interface ApiError {
  readonly code: number;
  readonly message: string;
  readonly documentation_url?: string;
  readonly source?: { readonly pointer?: string };
}

/** Keyset pagination: `cursor` is empty once the last page has been handed out. */
export interface CursorResultInfo {
  readonly cursor: string;
  readonly per_page: number;
  readonly count: number;
}

export interface OffsetResultInfo {
  readonly page: number;
  readonly per_page: number;
  readonly total_pages: number;
  readonly count: number;
  readonly total_count: number;
}

export type ResultInfo = CursorResultInfo | OffsetResultInfo;

/**
 * Artifacts documents these for the repository list. Namespaces list with the
 * same `limit`/`cursor` pair and no documented bounds of their own, so they
 * borrow these rather than inventing a second pair a client would have to learn.
 */
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

export interface ApiEnvelope<T> {
  readonly result: T | null;
  readonly success: boolean;
  readonly errors: readonly ApiError[];
  readonly messages: readonly ApiError[];
  readonly result_info?: ResultInfo;
}

/**
 * Artifacts' documented codes. `notImplemented` and `forbidden` are ours —
 * Artifacts publishes no code for an unimplemented route because it has none,
 * and none for a refused Git request because that surface answers in Git's
 * protocol rather than in this envelope — and both are deliberately outside the
 * ranges Cloudflare has used.
 */
export const ERROR_CODES = {
  invalidInput: 10100,
  invalidRepoName: 10101,
  invalidTtl: 10103,
  invalidUrl: 10104,
  remoteAuthRequired: 10106,
  notFound: 10200,
  alreadyExists: 10201,
  importInProgress: 10302,
  forkInProgress: 10303,
  internalError: 10400,
  upstreamUnavailable: 10401,
  memoryLimit: 10402,
  notImplemented: 10900,
  forbidden: 10901,
} as const;

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * Artifacts documents `NamespaceName` as a bare string and never the namespace
 * object, so this shape is ours. `slug` is the vocabulary a namespace is
 * identified by; the rest follows the v4 surface's snake_case.
 */
export interface NamespaceInfo {
  readonly slug: string;
  readonly display_name: string;
  readonly description: string | null;
  readonly created_at: string;
}

export interface CreateNamespaceRequest {
  readonly slug: string;
  readonly display_name?: string;
  readonly description?: string;
}

export interface DeleteNamespaceResult {
  readonly slug: string;
}

export const NAMESPACE_SLUG_MAX_LENGTH = 39;
export const NAMESPACE_DISPLAY_NAME_MAX_LENGTH = 100;
export const NAMESPACE_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Deliberately narrower than a URL path segment: no percent-encoding and no
 * case folding, because the slug is concatenated into a Git remote URL.
 */
export const NAMESPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Slugs that would collide with a fixed path segment of the HTTP surface. */
export const RESERVED_NAMESPACE_SLUGS: readonly string[] = [
  "api",
  "git",
  "healthz",
  "static",
  "well-known",
];

export type NamespaceSlugViolation = "empty" | "malformed" | "reserved" | "too-long";

export const validateNamespaceSlug = (slug: string): NamespaceSlugViolation | null => {
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

export const describeNamespaceSlugViolation = (violation: NamespaceSlugViolation): string => {
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

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/** `default_branch` is what a fresh clone checks out: the target of `HEAD`. */
export interface RepoInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly default_branch: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_push_at: string | null;
  /** The import URL or fork source address; `null` when the repository was created empty. */
  readonly source: string | null;
  readonly read_only: boolean;
}

export interface RepoWithRemote extends RepoInfo {
  readonly remote: string;
}

export interface CreateRepoRequest {
  readonly name: string;
  readonly description?: string;
  readonly default_branch?: string;
  readonly read_only?: boolean;
}

/**
 * Deliberately narrower than {@link RepoInfo}: Artifacts answers a create with
 * the identity, the remote, and the one token it will never show again.
 */
export interface CreateRepoResult {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly default_branch: string;
  readonly remote: string;
  readonly token: string;
}

export interface ForkRepoRequest {
  readonly name: string;
  readonly description?: string;
  readonly read_only?: boolean;
  readonly default_branch_only?: boolean;
}

/**
 * Hosted Artifacts includes the stable source address in its fork result in
 * addition to the documented object count and create fields.
 */
export interface ForkRepoResult extends CreateRepoResult {
  readonly objects: number;
  readonly source: string;
}

export interface DeleteRepoResult {
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Repository content
// ---------------------------------------------------------------------------

/** The part of a Git identity Artifacts exposes; timestamps live on the commit. */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/** A stored Git commit, in the response shape verified against Artifacts. */
export interface CommitInfo {
  readonly hash: string;
  readonly treeHash: string;
  readonly message: string;
  readonly author: CommitIdentity;
  readonly committer: CommitIdentity;
  readonly parents: readonly string[];
  /** Unix seconds from the author identity line. */
  readonly authoredAt: number;
  /** Unix seconds from the committer identity line. */
  readonly committedAt: number;
}

export type TreeEntryType = "blob" | "exec" | "gitlink" | "symlink" | "tree";

/** One entry in Git's binary tree encoding, as Artifacts exposes it. */
export interface TreeEntryInfo {
  readonly name: string;
  readonly mode: string;
  readonly hash: string;
  readonly type: TreeEntryType;
}

export const REPOSITORY_NAME_MAX_LENGTH = 100;
export const REPOSITORY_DESCRIPTION_MAX_LENGTH = 500;
export const BRANCH_NAME_MAX_LENGTH = 255;

export const DEFAULT_BRANCH = "main";

export const REPO_SORT_FIELDS = ["created_at", "updated_at", "last_push_at", "name"] as const;

export type RepoSortField = (typeof REPO_SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;

export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const REPO_LIST_DEFAULT_SORT: RepoSortField = "created_at";
export const REPO_LIST_DEFAULT_DIRECTION: SortDirection = "desc";

/**
 * Wider than {@link NAMESPACE_SLUG_PATTERN} because repository names carry
 * file-like conventions (`my.config`, `dot_files`), but held to the same
 * lowercase-only rule so a clone URL never depends on case folding.
 */
export const REPOSITORY_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export type RepositoryNameViolation = "empty" | "git-suffix" | "malformed" | "too-long";

export const validateRepositoryName = (name: string): RepositoryNameViolation | null => {
  if (name.length === 0) {
    return "empty";
  }
  if (name.length > REPOSITORY_NAME_MAX_LENGTH) {
    return "too-long";
  }
  if (!REPOSITORY_NAME_PATTERN.test(name)) {
    return "malformed";
  }
  // `/git/:namespace/:repo.git` appends the suffix itself, so a name that
  // already ends in `.git` would produce two spellings of one clone URL.
  if (name.endsWith(".git")) {
    return "git-suffix";
  }
  return null;
};

export const describeRepositoryNameViolation = (violation: RepositoryNameViolation): string => {
  switch (violation) {
    case "empty":
      return "A repository name is required.";
    case "too-long":
      return `A repository name may be at most ${REPOSITORY_NAME_MAX_LENGTH} characters.`;
    case "malformed":
      return "A repository name may only contain lowercase letters, digits, and interior dots, underscores, and hyphens.";
    case "git-suffix":
      return 'A repository name may not end in ".git".';
  }
};

export type BranchNameViolation = "empty" | "malformed" | "too-long";

/**
 * A conservative subset of `git check-ref-format`: it rejects everything Git
 * rejects and some things Git would allow, so widening it later cannot
 * invalidate a name already stored.
 */
export const validateBranchName = (name: string): BranchNameViolation | null => {
  if (name.length === 0) {
    return "empty";
  }
  if (name.length > BRANCH_NAME_MAX_LENGTH) {
    return "too-long";
  }
  // The allowed alphabet, which also settles the rules about control
  // characters, spaces, `~^:?*[\`, and `@{` by never admitting them.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
    return "malformed";
  }
  if (name.includes("..") || name.endsWith(".")) {
    return "malformed";
  }

  // Git applies its dot rules per slash-separated component, not to the whole
  // name, so `foo/.bar` and `a.lock/b` are refs it will not create. An empty
  // component covers `foo//bar` and a trailing slash.
  for (const component of name.split("/")) {
    if (component.length === 0 || component.startsWith(".") || component.endsWith(".lock")) {
      return "malformed";
    }
  }

  return null;
};

export const describeBranchNameViolation = (violation: BranchNameViolation): string => {
  switch (violation) {
    case "empty":
      return "A branch name is required.";
    case "too-long":
      return `A branch name may be at most ${BRANCH_NAME_MAX_LENGTH} characters.`;
    case "malformed":
      return "That branch name is not a valid Git branch name.";
  }
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export const TOKEN_SCOPES = ["read", "write"] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

export type TokenState = "active" | "expired" | "revoked";

export interface TokenInfo {
  readonly id: string;
  readonly scope: TokenScope;
  readonly state: TokenState;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface CreateTokenRequest {
  readonly repo: string;
  readonly scope?: TokenScope;
  readonly ttl?: number;
}

/** The only response that carries the plaintext token. */
export interface CreateTokenResult {
  readonly id: string;
  readonly plaintext: string;
  readonly scope: TokenScope;
  readonly expires_at: string;
}

export interface DeleteTokenResult {
  readonly id: string;
}

export const TOKEN_LIST_STATES = ["active", "expired", "revoked", "all"] as const;

export type TokenListState = (typeof TOKEN_LIST_STATES)[number];

export const TOKEN_LIST_DEFAULT_STATE: TokenListState = "active";
export const TOKEN_LIST_DEFAULT_PER_PAGE = 30;
export const TOKEN_LIST_MAX_PER_PAGE = 100;
export const TOKEN_LIST_DEFAULT_PAGE = 1;

export const TOKEN_TTL_MIN_SECONDS = 60;
export const TOKEN_TTL_MAX_SECONDS = 31_536_000;
export const TOKEN_TTL_DEFAULT_SECONDS = 86_400;

export const ARTIFACT_TOKEN_PREFIX = "art_v1_" as const;

/** Hex characters in the secret half of a token, not bytes of entropy. */
export const ARTIFACT_TOKEN_SECRET_LENGTH = 40;

/** Artifacts exposes a 16-hex opaque id separately from the 40-hex secret. */
export const ARTIFACT_TOKEN_ID_LENGTH = 16;

export const ARTIFACT_TOKEN_PATTERN = /^art_v1_[0-9a-f]{40}\?expires=\d+$/;

/**
 * The expiry travels in the token rather than beside it, so a client that only
 * ever holds the string can still tell when it has to ask for another.
 */
export const formatArtifactToken = (secret: string, expiresAt: Date): string =>
  `${ARTIFACT_TOKEN_PREFIX}${secret}?expires=${Math.floor(expiresAt.getTime() / 1000)}`;
