import { GITLINK_MODE, TREE_MODE } from "../../src/connectivity.ts";
import { hashObject, type ObjectType } from "../../src/object.ts";
import { fromHex } from "../../src/sha1.ts";
import { concat } from "./pack.ts";

/**
 * Commits, trees, and tags a test can name, so a connectivity walk is exercised
 * against a history someone chose rather than against whatever a fixture pack
 * happens to hold. The bytes are Git's own encodings — anything else and the
 * ids would not be the ids Git computes.
 */

const encoder = new TextEncoder();

export interface GitObject {
  readonly oid: string;
  readonly type: ObjectType;
  readonly bytes: Uint8Array;
}

const object = (type: ObjectType, bytes: Uint8Array): GitObject => ({
  oid: hashObject(type, bytes),
  type,
  bytes,
});

export const blob = (contents: string): GitObject => object("blob", encoder.encode(contents));

export const FILE_MODE = "100644";

/** Re-exported so the writer here and the parser under test cannot disagree. */
export { GITLINK_MODE, TREE_MODE };

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export const treeEntry = (name: string, target: GitObject): TreeEntry => ({
  mode: target.type === "tree" ? TREE_MODE : FILE_MODE,
  name,
  oid: target.oid,
});

/** `<mode> SP <name> NUL <20 raw bytes>`, once per entry, in Git's own order. */
export const tree = (entries: readonly TreeEntry[]): GitObject =>
  object(
    "tree",
    concat(
      ...[...entries]
        .sort((left, right) => (left.name < right.name ? -1 : 1))
        .map((entry) =>
          concat(encoder.encode(`${entry.mode} ${entry.name}\0`), fromHex(entry.oid)),
        ),
    ),
  );

const IDENTITY = "Open Relic <fixtures@open-relic.dev> 1767225600 +0000";

export const commit = (options: {
  readonly tree: GitObject;
  readonly parents?: readonly GitObject[];
  readonly message?: string;
}): GitObject =>
  object(
    "commit",
    encoder.encode(
      [
        `tree ${options.tree.oid}`,
        ...(options.parents ?? []).map((parent) => `parent ${parent.oid}`),
        `author ${IDENTITY}`,
        `committer ${IDENTITY}`,
        "",
        `${options.message ?? "A commit"}\n`,
      ].join("\n"),
    ),
  );

export const tag = (options: { readonly target: GitObject; readonly name: string }): GitObject =>
  object(
    "tag",
    encoder.encode(
      [
        `object ${options.target.oid}`,
        `type ${options.target.type}`,
        `tag ${options.name}`,
        `tagger ${IDENTITY}`,
        "",
        `Tagging ${options.name}\n`,
      ].join("\n"),
    ),
  );
