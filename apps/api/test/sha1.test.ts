import { expect, test } from "bun:test";

import { Sha1, fromHex, sha1Hex, toHex } from "../src/sha1.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const subtleHex = async (bytes: Uint8Array): Promise<string> =>
  toHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-1", bytes.slice() as unknown as BufferSource),
    ),
  );

test("hashes the FIPS 180-4 sample vectors", () => {
  expect(sha1Hex(utf8(""))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  expect(sha1Hex(utf8("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  expect(
    sha1Hex(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
  ).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
});

test("hashes a million repeated characters", () => {
  const hasher = new Sha1();
  const chunk = utf8("a".repeat(1_000));
  for (let i = 0; i < 1_000; i += 1) {
    hasher.update(chunk);
  }

  expect(hasher.hex()).toBe("34aa973cd4c4daa4f61eeb2bdbad27316534016f");
});

test("agrees with crypto.subtle whatever the chunk boundaries are", async () => {
  // Lengths either side of the 64-byte block, and either side of the 56-byte
  // point where the length padding needs a second block of its own.
  const lengths = [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1_000];

  for (const length of lengths) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = (i * 31 + 7) & 0xff;
    }

    const expected = await subtleHex(bytes);
    expect(sha1Hex(bytes)).toBe(expected);

    for (const chunkSize of [1, 7, 64, 100]) {
      const hasher = new Sha1();
      for (let at = 0; at < length; at += chunkSize) {
        hasher.update(bytes.subarray(at, at + chunkSize));
      }
      expect(hasher.hex()).toBe(expected);
    }
  }
});

test("a digested hasher refuses to keep going", () => {
  const hasher = new Sha1();
  hasher.digest();

  expect(() => hasher.update(utf8("more"))).toThrow();
  expect(() => hasher.digest()).toThrow();
});

test("hex round-trips", () => {
  const oid = "9d5c1f2b8a4e7c0d3f6b1a8e5c2d9f0b7a4e6c31";

  expect(toHex(fromHex(oid))).toBe(oid);
});
