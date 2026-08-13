/**
 * Git's delta encoding: two varint sizes, then a run of instructions that
 * either copy a span of the base or insert literal bytes. Documented in
 * `Documentation/technical/pack-format.txt` in Git's own tree.
 */

export class DeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeltaError";
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
      throw new DeltaError("A delta size ran past the end of the delta.");
    }

    cursor += 1;
    // Multiplied rather than shifted: `<<` is 32-bit, and a size that overflows
    // it would be read as something else entirely rather than rejected.
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;

    if (!Number.isSafeInteger(value)) {
      throw new DeltaError("A delta size is larger than we can address.");
    }

    if ((byte & 0x80) === 0) {
      return { value, next: cursor };
    }
  }
};

export const applyDelta = (base: Uint8Array, delta: Uint8Array): Uint8Array => {
  const baseSize = readVarint(delta, 0);
  const resultSize = readVarint(delta, baseSize.next);

  if (baseSize.value !== base.length) {
    throw new DeltaError(
      `The delta expects a ${baseSize.value}-byte base, and the base is ${base.length} bytes.`,
    );
  }

  const result = new Uint8Array(resultSize.value);
  let at = resultSize.next;
  let written = 0;

  while (at < delta.length) {
    const opcode = delta[at]!;
    at += 1;

    if ((opcode & 0x80) !== 0) {
      // Copy: the low bits say which of the four offset bytes and three size
      // bytes were worth sending; the rest are zero.
      let offset = 0;
      for (let byte = 0; byte < 4; byte += 1) {
        if ((opcode & (1 << byte)) !== 0) {
          offset |= readByte(delta, at) << (byte * 8);
          at += 1;
        }
      }

      let size = 0;
      for (let byte = 0; byte < 3; byte += 1) {
        if ((opcode & (0x10 << byte)) !== 0) {
          size |= readByte(delta, at) << (byte * 8);
          at += 1;
        }
      }

      offset >>>= 0;
      // A zero size means the largest copy the encoding can express.
      size = size === 0 ? 0x10000 : size;

      if (offset + size > base.length) {
        throw new DeltaError("A copy instruction reaches past the base.");
      }

      write(result, written, base.subarray(offset, offset + size));
      written += size;
      continue;
    }

    if (opcode === 0) {
      throw new DeltaError("A delta used the reserved instruction 0.");
    }

    // Insert: the opcode is the count of literal bytes that follow.
    if (at + opcode > delta.length) {
      throw new DeltaError("An insert instruction reaches past the delta.");
    }

    write(result, written, delta.subarray(at, at + opcode));
    written += opcode;
    at += opcode;
  }

  if (written !== result.length) {
    throw new DeltaError(
      `The delta produced ${written} bytes where ${result.length} were declared.`,
    );
  }

  return result;
};

const readByte = (delta: Uint8Array, at: number): number => {
  const byte = delta[at];
  if (byte === undefined) {
    throw new DeltaError("A delta instruction ran past the end of the delta.");
  }
  return byte;
};

const write = (result: Uint8Array, at: number, bytes: Uint8Array): void => {
  if (at + bytes.length > result.length) {
    throw new DeltaError("A delta produced more than it declared.");
  }
  result.set(bytes, at);
};
