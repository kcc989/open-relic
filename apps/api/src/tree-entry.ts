import { ObjectParseError } from "./object-parse.ts";
import type { ObjectType } from "./object.ts";

/** A subtree, as Git writes its unpadded octal mode. */
export const TREE_MODE = "40000";
/** A submodule. The commit it names lives in another repository, not ours. */
export const GITLINK_MODE = "160000";

const OID_BYTES = 20;
const SPACE = 0x20;
const NUL = 0x00;

export interface ParsedTreeEntry {
  readonly mode: string;
  readonly name: Uint8Array;
  readonly oid: string;
}

/** What a tree entry names, in the shape the graph index stores. */
export interface TreeLink {
  readonly oid: string;
  readonly type: ObjectType;
}

const HEX_DIGITS = "0123456789abcdef";
const HEX_HIGH = new Uint8Array(256);
const HEX_LOW = new Uint8Array(256);
for (let byte = 0; byte < 256; byte += 1) {
  HEX_HIGH[byte] = HEX_DIGITS.charCodeAt(byte >> 4);
  HEX_LOW[byte] = HEX_DIGITS.charCodeAt(byte & 0xf);
}
const hexScratch = new Uint8Array(OID_BYTES * 2);
const hexDecoder = new TextDecoder();

/**
 * The hex of the 20 bytes at `at`. A push hexes one id per tree entry, so this
 * writes the digits into one reused buffer and decodes it in a single call
 * instead of concatenating twenty pairs.
 */
const oidAt = (bytes: Uint8Array, at: number): string => {
  for (let index = 0; index < OID_BYTES; index += 1) {
    const byte = bytes[at + index]!;
    hexScratch[index * 2] = HEX_HIGH[byte]!;
    hexScratch[index * 2 + 1] = HEX_LOW[byte]!;
  }
  return hexDecoder.decode(hexScratch);
};

/**
 * A repository uses a handful of distinct modes, so each spelling is decoded
 * once and then found again by its octal value and length rather than decoded
 * per entry. Length is part of the key so a zero-padded mode keeps its
 * spelling, as it does on disk.
 */
const modeSpellings = new Map<number, string>();

/** `<mode> SP <name> NUL <20 raw bytes>`, once, positioned by where it ends. */
interface EntryBounds {
  mode: string;
  space: number;
  nul: number;
}

const bounds: EntryBounds = { mode: "", space: 0, nul: 0 };

const scanEntry = (bytes: Uint8Array, at: number): void => {
  const space = bytes.indexOf(SPACE, at);
  if (space === -1) {
    throw new ObjectParseError("A tree entry has no mode.");
  }

  const nul = bytes.indexOf(NUL, space + 1);
  if (nul === -1 || nul + OID_BYTES + 1 > bytes.length) {
    throw new ObjectParseError("A tree entry ends mid-way.");
  }

  const digits = space - at;
  let value = 0;
  let octal = digits === 5 || digits === 6;
  for (let index = at; octal && index < space; index += 1) {
    const digit = bytes[index]! - 0x30;
    octal = digit >= 0 && digit <= 7;
    value = value * 8 + digit;
  }
  if (!octal) {
    throw new ObjectParseError(
      `"${hexDecoder.decode(bytes.subarray(at, space))}" is not a tree entry mode.`,
    );
  }

  const key = value * 2 + (digits - 5);
  let mode = modeSpellings.get(key);
  if (mode === undefined) {
    mode = hexDecoder.decode(bytes.subarray(at, space));
    modeSpellings.set(key, mode);
  }

  bounds.mode = mode;
  bounds.space = space;
  bounds.nul = nul;
};

/** Scan Git's repeated `<mode> SP <name> NUL <20 raw bytes>` tree encoding. */
export function* treeEntries(bytes: Uint8Array): Iterable<ParsedTreeEntry> {
  let at = 0;

  while (at < bytes.length) {
    scanEntry(bytes, at);
    const { mode, space, nul } = bounds;

    yield {
      mode,
      name: bytes.subarray(space + 1, nul),
      oid: oidAt(bytes, nul + 1),
    };
    at = nul + OID_BYTES + 1;
  }
}

/**
 * The objects a tree's entries name, without materializing the entries: the
 * names are never looked at, and an id is only hexed when its link is kept.
 * Subtrees always are; a gitlink names a commit in a repository that is not
 * this one; blobs are the caller's call.
 */
export const treeLinks = (bytes: Uint8Array, includeBlobs: boolean): readonly TreeLink[] => {
  const links: TreeLink[] = [];
  let at = 0;

  while (at < bytes.length) {
    scanEntry(bytes, at);
    const { mode, nul } = bounds;

    if (mode === TREE_MODE) {
      links.push({ oid: oidAt(bytes, nul + 1), type: "tree" });
    } else if (includeBlobs && mode !== GITLINK_MODE) {
      links.push({ oid: oidAt(bytes, nul + 1), type: "blob" });
    }
    at = nul + OID_BYTES + 1;
  }

  return links;
};
