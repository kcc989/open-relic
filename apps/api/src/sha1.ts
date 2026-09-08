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

export const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};
