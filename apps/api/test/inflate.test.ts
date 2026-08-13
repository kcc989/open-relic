import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { InflateError, Inflater } from "../src/inflate.ts";

const deflate = (bytes: Uint8Array, level?: number): Uint8Array =>
  new Uint8Array(
    level === undefined ? deflateSync(bytes) : deflateSync(bytes, { level }),
  );

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
const inflate = (
  compressed: Uint8Array,
  size: number,
  chunkSize: number,
): Inflater => {
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
    expect((error as InflateError).code).toBe("truncated");
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

  expect(() => inflate(compressed, bytes.length + 1, 4_096)).toThrow(
    /1000 bytes where 1001/,
  );
  expect(() => inflate(compressed, bytes.length - 1, 4_096)).toThrow(/overruns/);
});

test("bytes that are not a zlib stream are rejected", () => {
  const notZlib = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

  expect(() => inflate(notZlib, 10, 6)).toThrow(/deflate stream/);
});
