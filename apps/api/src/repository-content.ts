import {
  type CommitIdentity,
  type CommitInfo,
  type TreeEntryInfo,
  type TreeEntryType,
} from "@open-relic/contracts";

import { isObjectId } from "./object.ts";
import { ObjectParseError } from "./object-parse.ts";
import { GITLINK_MODE, TREE_MODE, treeEntries } from "./tree-entry.ts";

const decoder = new TextDecoder();

interface ParsedIdentity {
  readonly identity: CommitIdentity;
  readonly timestamp: number;
}

const parseIdentity = (value: string, field: "author" | "committer"): ParsedIdentity => {
  const match = /^(.*) <([^<>]*)> (-?\d+)(?: [+-]\d{4})?$/.exec(value);
  if (match === null) {
    throw new ObjectParseError(`A commit has no valid ${field}.`);
  }

  const timestamp = Number(match[3]);
  if (!Number.isSafeInteger(timestamp)) {
    throw new ObjectParseError(`A commit has no valid ${field} timestamp.`);
  }

  return {
    identity: { name: match[1]!, email: match[2]! },
    timestamp,
  };
};

/** Parse Git's textual commit encoding into the hosted Artifacts response. */
export const parseCommit = (hash: string, bytes: Uint8Array): CommitInfo => {
  const separator = bytes.findIndex(
    (byte, at) => byte === 0x0a && at + 1 < bytes.length && bytes[at + 1] === 0x0a,
  );
  if (separator === -1) {
    throw new ObjectParseError("A commit has no message separator.");
  }

  const fields = new Map<string, string[]>();
  for (const line of decoder.decode(bytes.subarray(0, separator)).split("\n")) {
    // Signed commit headers continue across indented lines. None of the fields
    // this response exposes are continuations, so leave those bytes attached to
    // the signature rather than mistaking them for a new field.
    if (line.startsWith(" ")) {
      continue;
    }

    const space = line.indexOf(" ");
    if (space === -1) {
      throw new ObjectParseError("A commit contains a malformed header.");
    }
    const field = line.slice(0, space);
    const value = line.slice(space + 1);
    const existing = fields.get(field);
    if (existing === undefined) {
      fields.set(field, [value]);
    } else {
      existing.push(value);
    }
  }

  const [treeHash] = fields.get("tree") ?? [];
  const [authorValue] = fields.get("author") ?? [];
  const [committerValue] = fields.get("committer") ?? [];
  const parents = fields.get("parent") ?? [];

  if (treeHash === undefined || !isObjectId(treeHash)) {
    throw new ObjectParseError("A commit names no valid tree.");
  }
  if (parents.some((parent) => !isObjectId(parent))) {
    throw new ObjectParseError("A commit names an invalid parent.");
  }
  if (authorValue === undefined || committerValue === undefined) {
    throw new ObjectParseError("A commit has no author or committer.");
  }

  const author = parseIdentity(authorValue, "author");
  const committer = parseIdentity(committerValue, "committer");
  const encodedMessage = decoder.decode(bytes.subarray(separator + 2));
  // Hosted Artifacts treats the final LF as Git's commit-message terminator.
  // Remove exactly that byte; an LF immediately before it remains message data.
  const message = encodedMessage.endsWith("\n") ? encodedMessage.slice(0, -1) : encodedMessage;

  return {
    hash,
    treeHash,
    message,
    author: author.identity,
    committer: committer.identity,
    parents,
    authoredAt: author.timestamp,
    committedAt: committer.timestamp,
  };
};

const entryType = (mode: string): TreeEntryType => {
  if (mode === TREE_MODE) {
    return "tree";
  }
  if (mode === GITLINK_MODE) {
    return "gitlink";
  }
  if (mode === "120000") {
    return "symlink";
  }
  if (mode === "100755") {
    return "exec";
  }
  return "blob";
};

/** Parse Git's binary tree encoding without looking up each named object. */
export const parseTree = (bytes: Uint8Array): readonly TreeEntryInfo[] => {
  const entries: TreeEntryInfo[] = [];

  for (const entry of treeEntries(bytes)) {
    entries.push({
      name: decoder.decode(entry.name),
      mode: entry.mode,
      hash: entry.oid,
      type: entryType(entry.mode),
    });
  }

  return entries;
};
