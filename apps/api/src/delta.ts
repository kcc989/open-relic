/**
 * Git's delta encoding: two varint sizes, then a run of instructions that
 * either copy a span of the base or insert literal bytes. Documented in
 * `Documentation/technical/pack-format.txt` in Git's own tree.
 */

import { MAX_OBJECT_BYTES } from "./object.ts";

export type DeltaErrorCode = "corrupt" | "too-large";

export class DeltaError extends Error {
  readonly code: DeltaErrorCode;

  constructor(code: DeltaErrorCode, message: string) {
    super(message);
    this.name = "DeltaError";
    this.code = code;
  }
}

interface Varint {
  readonly value: number;
  readonly next: number;
}

/** Little-endian base-128, high bit continues — the delta header's sizes. */
const readVarint = (delta: Uint8Array, at: number): Varint => {
  let value = 0;
  let shift = 0;
  let cursor = at;

  for (;;) {
    const byte = delta[cursor];
    if (byte === undefined) {
      throw new DeltaError("corrupt", "A delta size ran past the end of the delta.");
    }

    cursor += 1;
    // Multiplied rather than shifted: `<<` is 32-bit, and a size that overflows
    // it would be read as something else entirely rather than rejected.
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;

    if (!Number.isSafeInteger(value)) {
      throw new DeltaError("corrupt", "A delta size is larger than we can address.");
    }

    if ((byte & 0x80) === 0) {
      return { value, next: cursor };
    }
  }
};

/**
 * Copies at least this long are handed to the runtime; most instructions are
 * shorter, and a loop costs less than the view a bulk copy needs.
 */
const BULK_COPY_BYTES = 64;

export const applyDelta = (base: Uint8Array, delta: Uint8Array): Uint8Array => {
  const baseSize = readVarint(delta, 0);
  const resultSize = readVarint(delta, baseSize.next);

  if (baseSize.value !== base.length) {
    throw new DeltaError(
      "corrupt",
      `The delta expects a ${baseSize.value}-byte base, and the base is ${base.length} bytes.`,
    );
  }

  // Checked before allocating, not after: the size is the sender's number, and
  // a delta of a few bytes can name any result it likes.
  if (resultSize.value > MAX_OBJECT_BYTES) {
    throw new DeltaError(
      "too-large",
      `The delta declares a ${resultSize.value}-byte result, past the ${MAX_OBJECT_BYTES}-byte limit.`,
    );
  }

  const result = new Uint8Array(resultSize.value);
  const end = delta.length;
  let at = resultSize.next;
  let written = 0;

  while (at < end) {
    const opcode = delta[at]!;
    at += 1;

    if ((opcode & 0x80) !== 0) {
      // Copy: the low bits say which of the four offset bytes and three size
      // bytes were worth sending; the rest are zero. A byte past the end of
      // the delta reads as nothing and is caught by the position afterwards.
      let offset = 0;
      let size = 0;
      if ((opcode & 0x01) !== 0) {
        offset = delta[at]!;
        at += 1;
      }
      if ((opcode & 0x02) !== 0) {
        offset |= delta[at]! << 8;
        at += 1;
      }
      if ((opcode & 0x04) !== 0) {
        offset |= delta[at]! << 16;
        at += 1;
      }
      if ((opcode & 0x08) !== 0) {
        offset |= delta[at]! << 24;
        at += 1;
      }
      if ((opcode & 0x10) !== 0) {
        size = delta[at]!;
        at += 1;
      }
      if ((opcode & 0x20) !== 0) {
        size |= delta[at]! << 8;
        at += 1;
      }
      if ((opcode & 0x40) !== 0) {
        size |= delta[at]! << 16;
        at += 1;
      }
      if (at > end) {
        throw new DeltaError("corrupt", "A delta instruction ran past the end of the delta.");
      }

      offset >>>= 0;
      // A zero size means the largest copy the encoding can express.
      size = size === 0 ? 0x10000 : size;

      if (offset + size > base.length) {
        throw new DeltaError("corrupt", "A copy instruction reaches past the base.");
      }
      if (written + size > result.length) {
        throw new DeltaError("corrupt", "A delta produced more than it declared.");
      }

      if (size >= BULK_COPY_BYTES) {
        result.set(base.subarray(offset, offset + size), written);
        written += size;
      } else {
        for (const last = written + size; written < last; written += 1) {
          result[written] = base[offset]!;
          offset += 1;
        }
      }
      continue;
    }

    if (opcode === 0) {
      throw new DeltaError("corrupt", "A delta used the reserved instruction 0.");
    }

    // Insert: the opcode is the count of literal bytes that follow.
    if (at + opcode > end) {
      throw new DeltaError("corrupt", "An insert instruction reaches past the delta.");
    }
    if (written + opcode > result.length) {
      throw new DeltaError("corrupt", "A delta produced more than it declared.");
    }

    for (const last = written + opcode; written < last; written += 1) {
      result[written] = delta[at]!;
      at += 1;
    }
  }

  if (written !== result.length) {
    throw new DeltaError(
      "corrupt",
      `The delta produced ${written} bytes where ${result.length} were declared.`,
    );
  }

  return result;
};
