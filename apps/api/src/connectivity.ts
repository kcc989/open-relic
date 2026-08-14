/**
 * Whether a repository can actually reach what a push says it can.
 *
 * A pack is a claim: these objects, and everything they name, are now here. The
 * claim has to be checked before a ref makes them reachable, because a ref
 * naming an object that is not there is a repository no client can read and
 * that nothing after the fact can repair.
 *
 * **Blobs are skipped.** They are the expensive half of any real repository —
 * most of the objects and nearly all of the bytes — and a pack that parsed
 * completely already implies them: every entry was inflated, hashed, and
 * written. What the walk is really looking for is the shape a truncated or
 * hand-made pack gets wrong, which is a commit or a tree naming something that
 * was never sent.
 */

import { isObjectId, isObjectType, type ObjectType } from "./object.ts";
import { ObjectParseError } from "./object-parse.ts";
import type { PackBase } from "./pack.ts";
import { GITLINK_MODE, TREE_MODE, treeEntries } from "./tree-entry.ts";

export { ObjectParseError } from "./object-parse.ts";
export { GITLINK_MODE, TREE_MODE } from "./tree-entry.ts";

/** Where the walk reads from; {@link ObjectStore} is the one that matters. */
export interface ObjectSource {
  readonly read: (oid: string) => Promise<PackBase | null>;
}

export interface ObjectLink {
  readonly oid: string;
  readonly type: ObjectType;
}

const decoder = new TextDecoder();

/**
 * The header of a commit or a tag: its lines up to the first blank one, each
 * split once at its first space. The message after it is not ours, and a commit
 * message is most of a commit.
 */
const headerFields = (bytes: Uint8Array): ReadonlyMap<string, string[]> => {
  let end = bytes.length;
  for (let at = 0; at + 1 < bytes.length; at += 1) {
    if (bytes[at] === 0x0a && bytes[at + 1] === 0x0a) {
      end = at;
      break;
    }
  }

  const fields = new Map<string, string[]>();

  for (const line of decoder.decode(bytes.subarray(0, end)).split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) {
      continue;
    }

    const field = line.slice(0, space);
    const value = line.slice(space + 1).trim();
    const existing = fields.get(field);

    if (existing === undefined) {
      fields.set(field, [value]);
    } else {
      existing.push(value);
    }
  }

  return fields;
};

/** The tree a commit names, and the commits it descends from. */
interface CommitHeader {
  readonly tree: string;
  readonly parents: readonly string[];
}

const commitHeader = (bytes: Uint8Array): CommitHeader => {
  const fields = headerFields(bytes);
  const [tree] = fields.get("tree") ?? [];

  if (tree === undefined || !isObjectId(tree)) {
    throw new ObjectParseError("A commit names no tree.");
  }

  const parents = fields.get("parent") ?? [];
  for (const parent of parents) {
    if (!isObjectId(parent)) {
      throw new ObjectParseError(`"${parent}" is not a parent's object id.`);
    }
  }

  return { tree, parents };
};

const commitLinks = (bytes: Uint8Array): readonly ObjectLink[] => {
  const { tree, parents } = commitHeader(bytes);

  return [{ oid: tree, type: "tree" }, ...parents.map((oid) => ({ oid, type: "commit" as const }))];
};

const tagLinks = (bytes: Uint8Array): readonly ObjectLink[] => {
  const fields = headerFields(bytes);
  const [target] = fields.get("object") ?? [];
  const [type] = fields.get("type") ?? [];

  if (target === undefined || !isObjectId(target)) {
    throw new ObjectParseError("A tag names no object.");
  }
  if (type === undefined || !isObjectType(type)) {
    throw new ObjectParseError(`A tag names the type "${type}".`);
  }

  return [{ oid: target, type }];
};

/**
 * `<mode> SP <name> NUL <20 raw bytes>`, repeated. Only subtrees come back:
 * blobs are the half we deliberately do not check, and a gitlink names a commit
 * in a repository that is not this one.
 */
const treeLinks = (bytes: Uint8Array, includeBlobs: boolean): readonly ObjectLink[] => {
  const links: ObjectLink[] = [];

  for (const entry of treeEntries(bytes)) {
    if (entry.mode === TREE_MODE) {
      links.push({ oid: entry.oid, type: "tree" });
    } else if (entry.mode !== GITLINK_MODE) {
      if (includeBlobs) {
        links.push({ oid: entry.oid, type: "blob" });
      }
    }
  }

  return links;
};

/**
 * The objects this one names that we insist on holding. Not everything it
 * references — see the note at the top of this file about blobs.
 */
export const linksToVerify = (type: ObjectType, bytes: Uint8Array): readonly ObjectLink[] => {
  switch (type) {
    case "commit":
      return commitLinks(bytes);
    case "tree":
      return treeLinks(bytes, false);
    case "tag":
      return tagLinks(bytes);
    case "blob":
      return [];
  }
};

/**
 * Every object this one makes reachable. Unlike the connectivity walk, a
 * sweep must follow blobs too: skipping their existence is safe while proving
 * a complete pack, but skipping their mark would collect live file contents.
 */
export const linksToReach = (type: ObjectType, bytes: Uint8Array): readonly ObjectLink[] => {
  switch (type) {
    case "commit":
      return commitLinks(bytes);
    case "tree":
      return treeLinks(bytes, true);
    case "tag":
      return tagLinks(bytes);
    case "blob":
      return [];
  }
};

/** Every object named by this one, for walking the closure a fetch must send. */
export const linksToFetch = linksToReach;

export const commitParents = (bytes: Uint8Array): readonly string[] => commitHeader(bytes).parents;

export interface WalkOptions {
  /**
   * Where the walk may stop: the objects the repository's refs point at right
   * now. Reaching one ends that line, which is what keeps the cost of a push
   * proportional to the history it added rather than to all of it.
   *
   * **Ref tips specifically, not "objects we already hold".** A ref exists only
   * because a push proved its whole closure, so stopping at one is sound.
   * Stopping at any present object is not: a push that failed this very check
   * leaves its objects behind, and a later push naming one of them would be
   * waved through on the strength of an object whose own children were never
   * confirmed.
   */
  readonly verified: ReadonlySet<string>;
  /** Carried across the commands of one push, so shared history is walked once. */
  readonly visited: Set<string>;
}

/**
 * The first object reachable from `tip` that the repository does not hold, or
 * `null` when everything is there.
 *
 * An object that cannot be parsed is as good as missing: we would be unable to
 * tell what it reaches, so we cannot say the push is complete.
 */
export const findMissingObject = async (
  tip: string,
  source: ObjectSource,
  { verified, visited }: WalkOptions,
): Promise<string | null> => {
  const pending: string[] = [tip];

  while (pending.length > 0) {
    const oid = pending.pop()!;

    if (visited.has(oid) || verified.has(oid)) {
      continue;
    }
    visited.add(oid);

    const object = await source.read(oid);
    if (object === null) {
      return oid;
    }

    try {
      for (const link of linksToVerify(object.type, object.bytes)) {
        pending.push(link.oid);
      }
    } catch (error) {
      if (error instanceof ObjectParseError) {
        return oid;
      }
      throw error;
    }
  }

  return null;
};
