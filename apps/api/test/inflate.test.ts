import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";

import { InflateError, Inflater } from "../src/inflate.ts";

const deflate = (bytes: Uint8Array, level?: number): Uint8Array =>
  new Uint8Array(level === undefined ? deflateSync(bytes) : deflateSync(bytes, { level }));

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};

/** Feeds the compressed bytes in fixed-size slices, the way a stream would. */
const inflate = (compressed: Uint8Array, size: number, chunkSize: number): Inflater => {
  const inflater = new Inflater(size);

  for (let at = 0; at < compressed.length && !inflater.done; at += chunkSize) {
    const chunk = compressed.slice(at, at + chunkSize);
    inflater.push(chunk, at + chunkSize >= compressed.length);
  }

  return inflater;
};

const sample = (length: number, seed: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    // Deliberately low entropy, so the compressor emits matches worth decoding.
    bytes[i] = (state >> 16) % 13;
  }
  return bytes;
};

test("round-trips whatever the chunk boundaries are", () => {
  const bytes = sample(50_000, 7);
  const compressed = deflate(bytes);

  for (const chunkSize of [1, 2, 5, 64, 1_024, compressed.length]) {
    const inflater = inflate(compressed, bytes.length, chunkSize);

    expect(inflater.done).toBe(true);
    expect(inflater.output).toEqual(bytes);
    expect(inflater.leftover.length).toBe(0);
  }
});

test("round-trips every compression level, including stored blocks", () => {
  const bytes = sample(70_000, 11);

  for (const level of [0, 1, 6, 9]) {
    const compressed = deflate(bytes, level);
    const inflater = inflate(compressed, bytes.length, 997);

    expect(inflater.output).toEqual(bytes);
  }
});

test("round-trips an empty stream", () => {
  const compressed = deflate(new Uint8Array(0));
  const inflater = inflate(compressed, 0, 1);

  expect(inflater.done).toBe(true);
  expect(inflater.output.length).toBe(0);
});

test("hands back what followed the stream", () => {
  const bytes = sample(4_000, 3);
  const tail = new Uint8Array([1, 2, 3, 4, 5]);
  const inflater = inflate(
    concat(deflate(bytes), tail),
    bytes.length,
    // A chunk large enough that the tail arrives in the same push as the end
    // of the stream, which is the case the pack reader depends on.
    100_000,
  );

  expect(inflater.done).toBe(true);
  expect(inflater.output).toEqual(bytes);
  expect(inflater.leftover).toEqual(tail);
});

test("a stream that stops early is truncated, not corrupt", () => {
  const bytes = sample(9_000, 5);
  const compressed = deflate(bytes);

  const thrown = () => inflate(compressed.slice(0, compressed.length - 8), bytes.length, 64);

  expect(thrown).toThrow(InflateError);
  try {
    thrown();
  } catch (error) {
    expect(error).toBeInstanceOf(InflateError);
    if (error instanceof InflateError) {
      expect(error.code).toBe("truncated");
    }
  }
});

test("a flipped byte is rejected", () => {
  const bytes = sample(9_000, 13);
  const compressed = deflate(bytes);
  compressed[compressed.length - 3] = compressed[compressed.length - 3]! ^ 0xff;

  expect(() => inflate(compressed, bytes.length, 4_096)).toThrow(InflateError);
});

test("a stream that does not inflate to the promised size is rejected", () => {
  const bytes = sample(1_000, 17);
  const compressed = deflate(bytes);

  expect(() => inflate(compressed, bytes.length + 1, 4_096)).toThrow(/1000 bytes where 1001/);
  expect(() => inflate(compressed, bytes.length - 1, 4_096)).toThrow(/overruns/);
});

test("bytes that are not a zlib stream are rejected", () => {
  const notZlib = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

  expect(() => inflate(notZlib, 10, 6)).toThrow(/deflate stream/);
});

/**
 * A deflate writer for the shapes zlib never produces: dynamic blocks whose
 * code sets are wrong on purpose. Every stream here is also run through the
 * runtime's zlib so the decoder is pinned to zlib's answer rather than ours.
 */
class BitWriter {
  readonly bytes: number[] = [];
  #current = 0;
  #filled = 0;

  bits(value: number, count: number): void {
    for (let bit = 0; bit < count; bit += 1) {
      this.#current |= ((value >> bit) & 1) << this.#filled;
      this.#filled += 1;
      if (this.#filled === 8) {
        this.bytes.push(this.#current);
        this.#current = 0;
        this.#filled = 0;
      }
    }
  }

  /** Huffman codes go most-significant bit first, unlike everything else. */
  code(value: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.bits((value >> bit) & 1, 1);
    }
  }

  align(): void {
    if (this.#filled > 0) {
      this.bytes.push(this.#current);
      this.#current = 0;
      this.#filled = 0;
    }
  }
}

const canonicalCodes = (lengths: readonly number[]): number[] => {
  const max = Math.max(...lengths);
  const perLength = Array.from({ length: max + 1 }, () => 0);
  for (const length of lengths) {
    if (length > 0) perLength[length] = (perLength[length] ?? 0) + 1;
  }
  const next: number[] = [0];
  let code = 0;
  for (let length = 1; length <= max; length += 1) {
    code = (code + perLength[length - 1]!) << 1;
    next[length] = code;
  }
  return lengths.map((length) => (length === 0 ? 0 : next[length]!++));
};

const adler32 = (bytes: Uint8Array): number => {
  let low = 1;
  let high = 0;
  for (const byte of bytes) {
    low = (low + byte) % 65_521;
    high = (high + low) % 65_521;
  }
  return ((high << 16) | low) >>> 0;
};

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** One final dynamic block encoding `payload` as literals with the given code lengths. */
const dynamicBlockStream = (options: {
  readonly payload: Uint8Array;
  readonly literalLengths: readonly number[];
  readonly distanceLengths: readonly number[];
  readonly endOfBlock?: boolean;
}): Uint8Array => {
  const { payload, literalLengths, distanceLengths } = options;
  const writer = new BitWriter();
  writer.bits(1, 1);
  writer.bits(2, 2);
  writer.bits(literalLengths.length - 257, 5);
  writer.bits(distanceLengths.length - 1, 5);

  // Code-length code: every length in use gets a code, sized to be complete.
  const used = [...new Set([...literalLengths, ...distanceLengths])].sort((a, b) => a - b);
  const codeLengthLengths = Array.from({ length: 19 }, () => 0);
  const width = Math.max(1, Math.ceil(Math.log2(used.length)));
  const complete = used.length === 2 ** width;
  used.forEach((symbol, at) => {
    // Give the first symbol the short code when the count is not a power of two.
    codeLengthLengths[symbol] = !complete && at === 0 ? width - 1 : width;
  });
  if (!complete && used.length !== 2 ** (width - 1) + 1) {
    // Fall back to a flat, over-provisioned but complete set of `width` bits
    // by padding with unused symbols that carry a real length.
    let extra = 2 ** width - used.length;
    for (let symbol = 0; symbol < 19 && extra > 0; symbol += 1) {
      if (codeLengthLengths[symbol] === 0) {
        codeLengthLengths[symbol] = width;
        extra -= 1;
      }
    }
    used.forEach((symbol) => {
      codeLengthLengths[symbol] = width;
    });
  }
  const codeLengthCount =
    CODE_LENGTH_ORDER.findLastIndex((symbol) => codeLengthLengths[symbol]! > 0) + 1;
  writer.bits(Math.max(codeLengthCount, 4) - 4, 4);
  for (let at = 0; at < Math.max(codeLengthCount, 4); at += 1) {
    writer.bits(codeLengthLengths[CODE_LENGTH_ORDER[at]!]!, 3);
  }
  const codeLengthCodes = canonicalCodes(codeLengthLengths);
  for (const length of [...literalLengths, ...distanceLengths]) {
    writer.code(codeLengthCodes[length]!, codeLengthLengths[length]!);
  }

  const literalCodes = canonicalCodes(literalLengths);
  for (const byte of payload) {
    writer.code(literalCodes[byte]!, literalLengths[byte]!);
  }
  if (options.endOfBlock !== false) {
    writer.code(literalCodes[256]!, literalLengths[256]!);
  }
  writer.align();

  const checksum = adler32(payload);
  return Uint8Array.from([
    0x78,
    0x01,
    ...writer.bytes,
    (checksum >>> 24) & 0xff,
    (checksum >>> 16) & 0xff,
    (checksum >>> 8) & 0xff,
    checksum & 0xff,
  ]);
};

/** The `InflateError` a push raised; anything else is the test's own bug. */
const inflateFailure = (compressed: Uint8Array): InflateError | null => {
  try {
    new Inflater(PAYLOAD.length).push(compressed, true);
  } catch (error) {
    if (error instanceof InflateError) {
      return error;
    }
    throw error;
  }
  return null;
};

const PAYLOAD = new TextEncoder().encode("tree 0000000000000000000000000000000000000000\n");

/** 256 literals at nine bits and end-of-block at one bit: a complete code. */
const COMPLETE_LITERALS = [...Array<number>(256).fill(9), 1];

describe("code sets zlib refuses", () => {
  const rejectsLikeZlib = (name: string, compressed: Uint8Array, message: RegExp): void => {
    test(name, () => {
      expect(() => inflateSync(compressed)).toThrow();
      const error = inflateFailure(compressed);
      expect(error?.code).toBe("corrupt");
      expect(error?.message).toMatch(message);
    });
  };

  rejectsLikeZlib(
    "more literal codes than deflate defines",
    dynamicBlockStream({
      payload: PAYLOAD,
      literalLengths: [...COMPLETE_LITERALS, ...Array<number>(31).fill(0)],
      distanceLengths: [1],
    }),
    /Too many length or distance symbols/,
  );

  rejectsLikeZlib(
    "an over-subscribed literal code",
    dynamicBlockStream({
      payload: PAYLOAD,
      literalLengths: [...Array<number>(256).fill(8), 8],
      distanceLengths: [1],
    }),
    /Over-subscribed literal\/lengths set/,
  );

  rejectsLikeZlib(
    "an incomplete literal code",
    dynamicBlockStream({
      payload: PAYLOAD,
      literalLengths: [...Array<number>(256).fill(9), 2],
      distanceLengths: [1],
    }),
    /Incomplete literal\/lengths set/,
  );

  rejectsLikeZlib(
    "an incomplete distance code of more than one symbol",
    dynamicBlockStream({
      payload: PAYLOAD,
      literalLengths: COMPLETE_LITERALS,
      distanceLengths: [2, 2],
    }),
    /Incomplete distances set/,
  );

  rejectsLikeZlib(
    "a block with no end-of-block code",
    dynamicBlockStream({
      payload: PAYLOAD,
      literalLengths: [...Array<number>(255).fill(8), 8, 0],
      distanceLengths: [1],
      endOfBlock: false,
    }),
    /no end-of-block code/,
  );

  test("a single one-bit distance code is the one incomplete set zlib allows", () => {
    const compressed = dynamicBlockStream({
      payload: PAYLOAD,
      literalLengths: COMPLETE_LITERALS,
      distanceLengths: [1],
    });

    expect(new Uint8Array(inflateSync(compressed))).toEqual(PAYLOAD);
    const inflater = new Inflater(PAYLOAD.length);
    inflater.push(compressed, true);
    expect(inflater.done).toBe(true);
    expect(inflater.output).toEqual(PAYLOAD);
  });

  test("a zlib header naming a window above 32 KiB is refused", () => {
    const compressed = deflate(PAYLOAD);
    compressed[0] = 0x88;
    compressed[1] = (31 - ((0x88 << 8) % 31)) % 31;
    expect(() => inflateSync(compressed)).toThrow();
    expect(inflateFailure(compressed)?.message).toMatch(/window size/);
  });
});
