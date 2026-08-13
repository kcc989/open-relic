/**
 * `HEAD`, as Git stores it.
 *
 * A repository object holds the literal bytes of `.git/HEAD` under one key, so
 * this module is the whole codec: `ref: refs/heads/main\n` when symbolic, a
 * bare 40-hex object id when detached. Storing the file rather than a branch
 * name is what lets a detached HEAD exist at all — see
 * [ADR-0003](../../../docs/adr/0003-head-is-the-literal-git-file.md).
 */

/** The key `HEAD` lives under in a repository object's KV storage. */
export const HEAD_KEY = "HEAD";

/** The ref path prefix that makes a ref a branch. */
export const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * Where HEAD points: at a ref by name, or at an object directly.
 *
 * Detached is not a state the REST API can create today, but it is the state a
 * repository lands in whenever HEAD names an object rather than a branch, so
 * the type admits it and the storage needs no schema change to hold it.
 */
export type Head =
  | { readonly kind: "symbolic"; readonly ref: string }
  | { readonly kind: "detached"; readonly oid: string };

/** The ref path a branch name lives at. */
export const branchRef = (branch: string): string =>
  `${BRANCH_REF_PREFIX}${branch}`;

/** A HEAD pointing at a branch, which is what `git init` writes. */
export const symbolicHead = (branch: string): Head => ({
  kind: "symbolic",
  ref: branchRef(branch),
});

export const detachedHead = (oid: string): Head => ({
  kind: "detached",
  oid,
});

/** The bytes `.git/HEAD` would hold, trailing newline included. */
export const formatHead = (head: Head): string =>
  head.kind === "symbolic" ? `ref: ${head.ref}\n` : `${head.oid}\n`;

// Git skips any run of whitespace after `ref:`, including none at all.
const SYMBOLIC_PREFIX = /^ref:\s*/;
const OBJECT_ID = /^[0-9a-f]{40}$/;

/**
 * Parses the contents of a `HEAD` file, or `null` if they are neither form.
 *
 * `null` rather than a throw because a repository whose HEAD cannot be read is
 * a fact a caller has to answer for — the REST API reports no default branch —
 * not an exception the storage layer can resolve.
 */
export const parseHead = (contents: string): Head | null => {
  const line = contents.trim();

  if (SYMBOLIC_PREFIX.test(line)) {
    const ref = line.replace(SYMBOLIC_PREFIX, "");
    return ref === "" ? null : { kind: "symbolic", ref };
  }

  return OBJECT_ID.test(line) ? { kind: "detached", oid: line } : null;
};

/**
 * The branch HEAD points at, or `null` when it is detached or points somewhere
 * outside `refs/heads/`. This is what the REST API answers with as
 * `default_branch`.
 */
export const headBranch = (head: Head): string | null => {
  if (head.kind !== "symbolic" || !head.ref.startsWith(BRANCH_REF_PREFIX)) {
    return null;
  }

  const branch = head.ref.slice(BRANCH_REF_PREFIX.length);
  return branch === "" ? null : branch;
};
