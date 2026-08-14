import { ObjectParseError } from "./object-parse.ts";
import { toHex } from "./sha1.ts";

const decoder = new TextDecoder();

/** A subtree, as Git writes its unpadded octal mode. */
export const TREE_MODE = "40000";
/** A submodule. The commit it names lives in another repository, not ours. */
export const GITLINK_MODE = "160000";

export interface ParsedTreeEntry {
  readonly mode: string;
  readonly name: Uint8Array;
  readonly oid: string;
}

/** Scan Git's repeated `<mode> SP <name> NUL <20 raw bytes>` tree encoding. */
export function* treeEntries(bytes: Uint8Array): Iterable<ParsedTreeEntry> {
  let at = 0;

  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    if (space === -1) {
      throw new ObjectParseError("A tree entry has no mode.");
    }

    const nul = bytes.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > bytes.length) {
      throw new ObjectParseError("A tree entry ends mid-way.");
    }

    const mode = decoder.decode(bytes.subarray(at, space));
    if (!/^[0-7]{5,6}$/.test(mode)) {
      throw new ObjectParseError(`"${mode}" is not a tree entry mode.`);
    }

    yield {
      mode,
      name: bytes.subarray(space + 1, nul),
      oid: toHex(bytes.subarray(nul + 1, nul + 21)),
    };
    at = nul + 21;
  }
}
