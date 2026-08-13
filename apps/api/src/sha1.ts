/**
 * SHA-1, incrementally, because both things a pack needs hashed are longer than
 * we are willing to hold: the pack's own trailing checksum covers every byte of
 * a stream we never buffer, and `crypto.subtle` only digests a complete
 * `ArrayBuffer`. Git names objects with SHA-1 for naming, not for security, so
 * the algorithm's collision weakness is not ours to fix — the wire format
 * fixes it for us.
 */

const BLOCK_BYTES = 64;

/** The five 32-bit words SHA-1 starts from, per FIPS 180-4. */
const INITIAL_STATE = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0] as const;

const HEX = "0123456789abcdef";

export class Sha1 {
  readonly #state = Uint32Array.from(INITIAL_STATE);
  readonly #block = new Uint8Array(BLOCK_BYTES);
  readonly #schedule = new Uint32Array(80);
  #pending = 0;
  #length = 0;
  #finished = false;

  update(bytes: Uint8Array): this {
    if (this.#finished) {
      throw new Error("SHA-1 was already digested.");
    }

    this.#length += bytes.length;
    let offset = 0;

    // Top up the partial block first, so the fast path below can read whole
    // blocks straight out of the caller's bytes without copying them.
    if (this.#pending > 0) {
      const wanted = Math.min(BLOCK_BYTES - this.#pending, bytes.length);
      this.#block.set(bytes.subarray(0, wanted), this.#pending);
      this.#pending += wanted;
      offset = wanted;

      if (this.#pending < BLOCK_BYTES) {
        return this;
      }

      this.#compress(this.#block, 0);
      this.#pending = 0;
    }

    while (offset + BLOCK_BYTES <= bytes.length) {
      this.#compress(bytes, offset);
      offset += BLOCK_BYTES;
    }

    if (offset < bytes.length) {
      this.#block.set(bytes.subarray(offset), 0);
      this.#pending = bytes.length - offset;
    }

    return this;
  }

  /** Consumes the hasher: the padding it appends is not resumable state. */
  digest(): Uint8Array {
    if (this.#finished) {
      throw new Error("SHA-1 was already digested.");
    }
    this.#finished = true;

    const bitLength = BigInt(this.#length) * 8n;
    const tail = new Uint8Array(this.#pending < 56 ? 64 : 128);
    tail.set(this.#block.subarray(0, this.#pending), 0);
    tail[this.#pending] = 0x80;

    const view = new DataView(tail.buffer);
    view.setBigUint64(tail.length - 8, bitLength);

    for (let offset = 0; offset < tail.length; offset += BLOCK_BYTES) {
      this.#compress(tail, offset);
    }

    const digest = new Uint8Array(20);
    const digestView = new DataView(digest.buffer);
    for (let word = 0; word < 5; word += 1) {
      digestView.setUint32(word * 4, this.#state[word]!);
    }

    return digest;
  }

  hex(): string {
    return toHex(this.digest());
  }

  #compress(bytes: Uint8Array, offset: number): void {
    const w = this.#schedule;

    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] =
        ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>>
        0;
    }

    for (let i = 16; i < 80; i += 1) {
      const mixed = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = ((mixed << 1) | (mixed >>> 31)) >>> 0;
    }

    let a = this.#state[0]!;
    let b = this.#state[1]!;
    let c = this.#state[2]!;
    let d = this.#state[3]!;
    let e = this.#state[4]!;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;

      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const next = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = next >>> 0;
    }

    this.#state[0] = (this.#state[0]! + a) >>> 0;
    this.#state[1] = (this.#state[1]! + b) >>> 0;
    this.#state[2] = (this.#state[2]! + c) >>> 0;
    this.#state[3] = (this.#state[3]! + d) >>> 0;
    this.#state[4] = (this.#state[4]! + e) >>> 0;
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
