/**
 * Whether a repository can actually reach what a push says it can.
 *
 * A pack is a claim: these objects, and everything they name, are now here. The
 * claim has to be checked before a ref makes them reachable, because a ref
 * naming an object that is not there is a repository no client can read and
 * that nothing after the fact can repair.
 *
 * **Blobs are checked for existence only.** They are the expensive half of any
 * real repository — most of the objects and nearly all of the bytes — but a
 * pack that parsed completely does not imply them: it holds what the client
 * chose to send, and a tree may name a blob that is in neither the pack nor
 * the repository. A blob names nothing, so the walk never reads one; it asks
 * whether the blob is there, batched through the link index where possible.
 */

import { isObjectId, isObjectType, type ObjectType } from "./object.ts";
import { ObjectParseError } from "./object-parse.ts";
import type { PackBase } from "./pack.ts";
import type { IndexedObject } from "./object-store.ts";
import { GITLINK_MODE, TREE_MODE, treeEntries } from "./tree-entry.ts";

export { ObjectParseError } from "./object-parse.ts";
export { GITLINK_MODE, TREE_MODE } from "./tree-entry.ts";

/** Where the walk reads from; {@link ObjectStore} is the one that matters. */
export interface ObjectSource {
  readonly read: (oid: string) => Promise<PackBase | null>;
  /** Existence without the bytes, for blobs; `read` is the fallback. */
  readonly has?: (oid: string) => Promise<boolean>;
  readonly readConnectivity?: (
    tip: string,
    verified: ReadonlySet<string>,
    shallow: ReadonlySet<string>,
  ) => Promise<readonly string[] | null>;
  readonly readIndexedObjects?: (
    oids: readonly string[],
  ) => Promise<ReadonlyMap<string, IndexedObject>>;
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
 * Every object this one makes reachable, which is also every object a push
 * has to have delivered: Git's own connectivity check walks blobs, and a ref
 * whose tree names a missing blob is a ref no clone can fetch.
 */
export const linksToReach = (
  type: ObjectType,
  bytes: Uint8Array,
  shallowCommit = false,
): readonly ObjectLink[] => {
  switch (type) {
    case "commit": {
      const links = commitLinks(bytes);
      return shallowCommit ? links.slice(0, 1) : links;
    }
    case "tree":
      return treeLinks(bytes, true);
    case "tag":
      return tagLinks(bytes);
    case "blob":
      return [];
  }
};

/** The objects this one names that a push must have delivered. */
export const linksToVerify = linksToReach;

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
  /** Commits whose trees are present but whose parents are intentionally absent. */
  readonly shallow?: ReadonlySet<string>;
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
  { verified, visited, shallow = new Set() }: WalkOptions,
): Promise<string | null> => {
  if (verified.has(tip) || visited.has(tip)) return null;
  const indexedClosure = await source.readConnectivity?.(
    tip,
    new Set([...verified, ...visited]),
    shallow,
  );
  if (indexedClosure !== undefined && indexedClosure !== null) {
    for (const oid of indexedClosure) visited.add(oid);
    return null;
  }
  const pending: { readonly oid: string; readonly type: ObjectType | null }[] = [
    { oid: tip, type: null },
  ];
  const traversed = new Set<string>();

  while (pending.length > 0) {
    const batch = pending.splice(Math.max(0, pending.length - 98)).reverse();
    const frontier: typeof batch = [];
    const queued = new Set<string>();
    for (const link of batch) {
      if (
        visited.has(link.oid) ||
        verified.has(link.oid) ||
        traversed.has(link.oid) ||
        queued.has(link.oid)
      ) {
        continue;
      }
      queued.add(link.oid);
      frontier.push(link);
    }
    const indexed = await source.readIndexedObjects?.(frontier.map((link) => link.oid));
    for (const { oid, type } of frontier) {
      traversed.add(oid);
      const cached = indexed?.get(oid);
      if (cached !== undefined) {
        for (const link of cached.links) {
          if (cached.type === "commit" && shallow.has(oid) && link.type === "commit") continue;
          pending.push(link);
        }
        continue;
      }

      // A blob names nothing, so whether it exists is the whole question and
      // its bytes are never worth reading.
      if (type === "blob" && source.has !== undefined) {
        if (!(await source.has(oid))) {
          return oid;
        }
        continue;
      }

      const object = await source.read(oid);
      if (object === null) {
        return oid;
      }
      try {
        for (const link of linksToVerify(object.type, object.bytes, shallow.has(oid))) {
          pending.push(link);
        }
      } catch (error) {
        if (error instanceof ObjectParseError) {
          return oid;
        }
        throw error;
      }
    }
  }

  // Only a successful walk can establish boundaries for another push command.
  for (const oid of traversed) visited.add(oid);
  return null;
};
