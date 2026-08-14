/**
 * Git's SHA-1, backed by the runtime's native incremental implementation.
 *
 * Packs need incremental hashing because their trailer covers a stream we do
 * not retain. Objects use the same implementation for `<type> <size>\0<bytes>`.
 * Git fixes SHA-1 as the object-format algorithm here; it is naming data, not
 * a security decision made by Open Relic.
 */

import { createHash, type Hash } from "node:crypto";

const HEX = "0123456789abcdef";

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

  hex(): string {
    return toHex(this.digest());
  }
}

export const sha1Hex = (bytes: Uint8Array): string => new Sha1().update(bytes).hex();

export const toHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) {
    hex += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
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
