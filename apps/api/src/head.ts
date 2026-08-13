/**
 * The codec for the literal bytes of `.git/HEAD` — `ref: refs/heads/main\n`
 * when symbolic, a bare 40-hex object id when detached. Storing the file rather
 * than a branch name is what lets a detached HEAD exist at all; see
 * [ADR-0003](../../../docs/adr/0003-head-is-the-literal-git-file.md).
 */

export const HEAD_KEY = "HEAD";

export const BRANCH_REF_PREFIX = "refs/heads/";

export type Head =
  | { readonly kind: "symbolic"; readonly ref: string }
  | { readonly kind: "detached"; readonly oid: string };

export const branchRef = (branch: string): string => `${BRANCH_REF_PREFIX}${branch}`;

export const symbolicHead = (branch: string): Head => ({
  kind: "symbolic",
  ref: branchRef(branch),
});

export const detachedHead = (oid: string): Head => ({
  kind: "detached",
  oid,
});

export const formatHead = (head: Head): string =>
  head.kind === "symbolic" ? `ref: ${head.ref}\n` : `${head.oid}\n`;

// Git skips any run of whitespace after `ref:`, including none at all.
const SYMBOLIC_PREFIX = /^ref:\s*/;
const OBJECT_ID = /^[0-9a-f]{40}$/;

/** `null`, not a throw: an unreadable HEAD is a fact the caller answers for. */
export const parseHead = (contents: string): Head | null => {
  const line = contents.trim();

  if (SYMBOLIC_PREFIX.test(line)) {
    const ref = line.replace(SYMBOLIC_PREFIX, "");
    return ref === "" ? null : { kind: "symbolic", ref };
  }

  return OBJECT_ID.test(line) ? { kind: "detached", oid: line } : null;
};

/** `null` when HEAD is detached or points outside `refs/heads/`. */
export const headBranch = (head: Head): string | null => {
  if (head.kind !== "symbolic" || !head.ref.startsWith(BRANCH_REF_PREFIX)) {
    return null;
  }

  const branch = head.ref.slice(BRANCH_REF_PREFIX.length);
  return branch === "" ? null : branch;
};
