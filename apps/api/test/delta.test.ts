import { expect, test } from "bun:test";

import { DeltaError, applyDelta } from "../src/delta.ts";
import {
  buildDelta,
  copyInstruction,
  insertInstruction,
} from "./support/pack.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const base = utf8("the quick brown fox jumps over the lazy dog");

test("copies spans of the base and inserts the rest", () => {
  const delta = buildDelta(base.length, 24, [
    copyInstruction(0, 4),
    insertInstruction(utf8("slow ")),
    copyInstruction(16, 15),
  ]);

  expect(text(applyDelta(base, delta))).toBe("the slow fox jumps over ");
});

test("a copy of size zero means the largest copy the encoding can express", () => {
  const large = new Uint8Array(0x10000 + 8).fill(0x61);
  const delta = buildDelta(large.length, 0x10000, [copyInstruction(0, 0x10000)]);

  expect(applyDelta(large, delta)).toEqual(large.subarray(0, 0x10000));
});

test("a delta written against a different base is rejected", () => {
  const delta = buildDelta(base.length + 1, 3, [insertInstruction(utf8("abc"))]);

  expect(() => applyDelta(base, delta)).toThrow(DeltaError);
  expect(() => applyDelta(base, delta)).toThrow(/44-byte base/);
});

test("a copy that reaches past the base is rejected", () => {
  const delta = buildDelta(base.length, 10, [
    copyInstruction(base.length - 2, 10),
  ]);

  expect(() => applyDelta(base, delta)).toThrow(/past the base/);
});

test("a delta that does not produce what it declared is rejected", () => {
  const delta = buildDelta(base.length, 99, [copyInstruction(0, 4)]);

  expect(() => applyDelta(base, delta)).toThrow(/4 bytes where 99/);
});

test("the reserved instruction is rejected", () => {
  const delta = buildDelta(base.length, 1, [Uint8Array.from([0])]);

  expect(() => applyDelta(base, delta)).toThrow(/reserved instruction/);
});

test("a delta that stops mid-instruction is rejected", () => {
  const delta = buildDelta(base.length, 5, [insertInstruction(utf8("abcde"))]);

  expect(() => applyDelta(base, delta.subarray(0, delta.length - 2))).toThrow(
    DeltaError,
  );
});
