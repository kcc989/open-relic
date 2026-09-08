/**
 * Git's SHA-1, backed by the runtime's native incremental implementation.
 *
 * Packs need incremental hashing because their trailer covers a stream we do
 * not retain. Objects use the same implementation for `<type> <size>\0<bytes>`.
 * Git fixes SHA-1 as the object-format algorithm here; it is naming data, not
 * a security decision made by Open Relic.
 */

import { createHash, type Hash } from "node:crypto";

/** One entry per byte value, so hex formatting is a lookup rather than arithmetic. */
const HEX_PAIRS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

export class Sha1 {
  readonly #hash: Hash = createHash("sha1");
  #finished = false;

  update(bytes: Uint8Array): this {
    if (this.#finished) {
      throw new Error("SHA-1 was already digested.");
    }
    this.#hash.update(bytes);
    return this;
  }

  digest(): Uint8Array {
    if (this.#finished) {
      throw new Error("SHA-1 was already digested.");
    }
    this.#finished = true;
    return new Uint8Array(this.#hash.digest());
  }

  /**
   * The name is what nearly every caller wants, and asking the hash for it
   * directly skips a byte array we would only spell back out again. Object ids
   * are formed once per Object in a Pack, so the two allocations count.
   */
  hex(): string {
    if (this.#finished) {
      throw new Error("SHA-1 was already digested.");
    }
    this.#finished = true;
    return this.#hash.digest("hex");
  }
}

export const sha1Hex = (bytes: Uint8Array): string => new Sha1().update(bytes).hex();

export const toHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) {
    hex += HEX_PAIRS[byte]!;
  }
  return hex;
};

/** One nibble per ASCII code, in either case; the hex a caller passes is already validated. */
const HEX_NIBBLES = new Uint8Array(128);
for (let nibble = 0; nibble < 16; nibble += 1) {
  const digit = nibble.toString(16);
  HEX_NIBBLES[digit.charCodeAt(0)] = nibble;
  HEX_NIBBLES[digit.toUpperCase().charCodeAt(0)] = nibble;
}

/**
 * Decodes `hex` into `target` from `offset`, for a writer placing ids into a
 * buffer it already owns. A pack names a delta base per entry, so the array
 * {@link fromHex} would allocate counts there.
 */
export const decodeHexInto = (hex: string, target: Uint8Array, offset: number): void => {
  for (let at = 0; at < hex.length; at += 2) {
    target[offset + at / 2] =
      (HEX_NIBBLES[hex.charCodeAt(at) & 0x7f]! << 4) | HEX_NIBBLES[hex.charCodeAt(at + 1) & 0x7f]!;
  }
};

export const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  decodeHexInto(hex, bytes, 0);
  return bytes;
};
