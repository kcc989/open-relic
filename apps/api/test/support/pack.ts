import { deflateSync } from "node:zlib";

import { concat } from "../../src/bytes.ts";
import type { ObjectType } from "../../src/object.ts";
import { Sha1, fromHex } from "../../src/sha1.ts";

/** The same helper the pack reader uses, so both halves agree byte for byte. */
export { concat };

/**
 * A pack writer, so tests can name the shapes they want — a delta chain, an
 * object that spans chunks, a truncated stream — instead of hunting for a
 * fixture that happens to contain one. Packs from a real Git client live in
 * `test/fixtures` and are what the compatibility test reads.
 */

const ENTRY_TYPES: Readonly<Record<ObjectType, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

/** Type in bits 4–6 of the first byte, then the size seven bits at a time. */
const entryHeader = (kind: number, size: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = size;
  let byte = (kind << 4) | (remaining & 0b1111);
  remaining = Math.floor(remaining / 16);

  while (remaining > 0) {
    bytes.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }

  bytes.push(byte);
  return Uint8Array.from(bytes);
};

/** The `ofs-delta` back-reference, whose continuation subtracts one per byte. */
const backOffset = (distance: number): Uint8Array => {
  const bytes = [distance & 0x7f];
  let remaining = Math.floor(distance / 128);

  while (remaining > 0) {
    remaining -= 1;
    bytes.unshift(0x80 | (remaining & 0x7f));
    remaining = Math.floor(remaining / 128);
  }

  return Uint8Array.from(bytes);
};

const deltaVarint = (value: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = value;

  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0);

  return Uint8Array.from(bytes);
};

export const insertInstruction = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length === 0 || bytes.length > 0x7f) {
    throw new Error("An insert instruction carries 1 to 127 bytes.");
  }
  return concat(Uint8Array.from([bytes.length]), bytes);
};

export const copyInstruction = (offset: number, size: number): Uint8Array => {
  const bytes: number[] = [0x80];

  for (let byte = 0; byte < 4; byte += 1) {
    const value = (offset >>> (byte * 8)) & 0xff;
    if (value !== 0) {
      bytes[0]! |= 1 << byte;
      bytes.push(value);
    }
  }

  for (let byte = 0; byte < 3; byte += 1) {
    const value = (size >>> (byte * 8)) & 0xff;
    if (value !== 0) {
      bytes[0]! |= 0x10 << byte;
      bytes.push(value);
    }
  }

  return Uint8Array.from(bytes);
};

export const buildDelta = (
  baseSize: number,
  resultSize: number,
  instructions: readonly Uint8Array[],
): Uint8Array =>
  concat(deltaVarint(baseSize), deltaVarint(resultSize), ...instructions);

export type PackEntry =
  | {
      readonly kind: "object";
      readonly type: ObjectType;
      readonly bytes: Uint8Array;
      /** Overrides the header's size, for packs that lie about what follows. */
      readonly declaredSize?: number;
    }
  | { readonly kind: "ofs-delta"; readonly baseIndex: number; readonly delta: Uint8Array }
  | { readonly kind: "ref-delta"; readonly baseOid: string; readonly delta: Uint8Array };

export interface BuiltPack {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Where each entry began, which is what an `ofs-delta` counts back from. */
  readonly offsets: readonly number[];
}

export const buildPack = (
  entries: readonly PackEntry[],
  options: { readonly version?: number; readonly declaredCount?: number } = {},
): BuiltPack => {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode("PACK"), 0);
  view.setUint32(4, options.version ?? 2);
  view.setUint32(8, options.declaredCount ?? entries.length);

  const parts: Uint8Array[] = [header];
  const offsets: number[] = [];
  let at = header.length;

  const push = (bytes: Uint8Array): void => {
    parts.push(bytes);
    at += bytes.length;
  };

  for (const entry of entries) {
    offsets.push(at);

    if (entry.kind === "object") {
      push(
        entryHeader(
          ENTRY_TYPES[entry.type],
          entry.declaredSize ?? entry.bytes.length,
        ),
      );
      push(new Uint8Array(deflateSync(entry.bytes)));
      continue;
    }

    if (entry.kind === "ofs-delta") {
      const baseOffset = offsets[entry.baseIndex];
      if (baseOffset === undefined) {
        throw new Error("An ofs-delta must follow its base.");
      }

      push(entryHeader(OFS_DELTA, entry.delta.length));
      push(backOffset(offsets[offsets.length - 1]! - baseOffset));
      push(new Uint8Array(deflateSync(entry.delta)));
      continue;
    }

    push(entryHeader(REF_DELTA, entry.delta.length));
    push(fromHex(entry.baseOid));
    push(new Uint8Array(deflateSync(entry.delta)));
  }

  const body = concat(...parts);
  return {
    bytes: concat(body, new Sha1().update(body).digest()),
    offsets,
  };
};

/**
 * A stream that hands the bytes over one slice at a time, on demand, the way a
 * request body does — so a test can watch how far the reader has pulled.
 */
export const streamOf = (
  bytes: Uint8Array,
  options: {
    readonly chunkSize?: number;
    readonly onPull?: (pulled: number) => void;
  } = {},
): ReadableStream<Uint8Array> => {
  const chunkSize = options.chunkSize ?? 64 * 1_024;
  let at = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }

      const chunk = bytes.slice(at, at + chunkSize);
      at += chunk.length;
      options.onPull?.(at);
      controller.enqueue(chunk);
    },
  });
};
