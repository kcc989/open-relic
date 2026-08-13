/**
 * A resumable zlib (RFC 1950/1951) decompressor.
 *
 * `DecompressionStream("deflate")` is right there and cannot be used: a pack is
 * a concatenation of zlib streams with no length prefix, so the only way to
 * find the next object is to be told how many input bytes the previous stream
 * consumed, and the platform stream both hides that and rejects the trailing
 * bytes as junk. Hence this: push bytes in, and once `done` is set, `leftover`
 * is exactly the tail that belongs to whatever comes next.
 *
 * The output length is known before the stream is read — a pack entry's header
 * carries the inflated size — so the buffer is allocated once and matches are
 * copied out of it directly, which is why there is no sliding window here.
 */

export type InflateErrorCode = "truncated" | "corrupt";

export class InflateError extends Error {
  readonly code: InflateErrorCode;

  constructor(code: InflateErrorCode, message: string) {
    super(message);
    this.name = "InflateError";
    this.code = code;
  }
}

/**
 * Thrown by the bit reader when a step ran past the bytes pushed so far, and
 * caught by `push`, which rewinds to where the step began and waits. Steps are
 * written so that everything they read happens before anything they write,
 * which is what makes rewinding safe.
 */
const NEED_INPUT = Symbol("need-input");

const EMPTY = new Uint8Array(0);

const MAX_CODE_BITS = 15;

/** RFC 1951 §3.2.7: the order code lengths for the code-length code arrive in. */
const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
] as const;

/** Match lengths for literal/length symbols 257–285, and their extra bits. */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
] as const;
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const;

const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
] as const;
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
] as const;

/**
 * Canonical Huffman decoding tables in zlib's `puff` shape: how many codes
 * there are of each length, and the symbols in code order. Decoding walks one
 * bit at a time, which costs a little and saves building a 32k-entry lookup
 * for every block.
 */
interface Huffman {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

const buildHuffman = (lengths: Uint8Array): Huffman => {
  const counts = new Uint16Array(MAX_CODE_BITS + 1);
  for (const length of lengths) {
    counts[length] = counts[length]! + 1;
  }
  counts[0] = 0;

  const offsets = new Uint16Array(MAX_CODE_BITS + 2);
  for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
    offsets[length + 1] = offsets[length]! + counts[length]!;
  }

  const symbols = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol]!;
    if (length > 0) {
      symbols[offsets[length]!] = symbol;
      offsets[length] = offsets[length]! + 1;
    }
  }

  return { counts, symbols };
};

const fixedLiteralLengths = (): Uint8Array => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return lengths;
};

const FIXED_LITERALS = buildHuffman(fixedLiteralLengths());
const FIXED_DISTANCES = buildHuffman(new Uint8Array(30).fill(5));

const ADLER_MODULUS = 65_521;

const adler32 = (bytes: Uint8Array): number => {
  let low = 1;
  let high = 0;

  // 5552 is the most bytes that can be summed before `high` could overflow a
  // 32-bit integer, so the modulo happens once per run rather than per byte.
  for (let at = 0; at < bytes.length; at += 5_552) {
    const end = Math.min(at + 5_552, bytes.length);
    for (let i = at; i < end; i += 1) {
      low += bytes[i]!;
      high += low;
    }
    low %= ADLER_MODULUS;
    high %= ADLER_MODULUS;
  }

  return ((high << 16) | low) >>> 0;
};

type Step = "continue" | "wait" | "done";

type State = "zlib-header" | "block-header" | "stored" | "compressed" | "checksum" | "done";

export type InflateFormat = "zlib" | "raw";

export class Inflater {
  readonly #output: Uint8Array;
  #outputAt = 0;

  #input: Uint8Array = EMPTY;
  #bitAt = 0;
  #atEnd = false;

  #state: State;
  readonly #checksummed: boolean;
  #lastBlock = false;
  #storedRemaining = 0;
  #literals: Huffman = FIXED_LITERALS;
  #distances: Huffman = FIXED_DISTANCES;

  #leftover: Uint8Array = EMPTY;

  /** `size` is the inflated length the pack promised, and is enforced. */
  constructor(size: number, format: InflateFormat = "zlib") {
    this.#output = new Uint8Array(size);
    this.#state = format === "zlib" ? "zlib-header" : "block-header";
    this.#checksummed = format === "zlib";
  }

  get done(): boolean {
    return this.#state === "done";
  }

  /** The inflated bytes; only complete once `done`. */
  get output(): Uint8Array {
    return this.#output;
  }

  /** What was pushed past the end of the zlib stream. */
  get leftover(): Uint8Array {
    return this.#leftover;
  }

  /**
   * The chunk is held, not copied, while the decoder waits for more, so the
   * caller must not write over it after handing it in.
   *
   * @param atEnd - no more bytes exist, so a step that wants input is a
   * truncation rather than something to wait for.
   */
  push(chunk: Uint8Array, atEnd = false): void {
    if (this.done) {
      throw new InflateError("corrupt", "The zlib stream already ended.");
    }

    this.#append(chunk);
    this.#atEnd ||= atEnd;

    for (;;) {
      const resumeAt = this.#bitAt;
      let step: Step;

      try {
        step = this.#step();
      } catch (error) {
        if (error !== NEED_INPUT) {
          throw error;
        }
        this.#bitAt = resumeAt;
        step = "wait";
      }

      if (step === "continue") {
        continue;
      }

      if (step === "done") {
        this.#finish();
        return;
      }

      if (this.#atEnd) {
        throw new InflateError("truncated", "The zlib stream ended early.");
      }

      this.#compact();
      return;
    }
  }

  #finish(): void {
    if (this.#outputAt !== this.#output.length) {
      throw new InflateError(
        "corrupt",
        `Inflated ${this.#outputAt} bytes where ${this.#output.length} were declared.`,
      );
    }

    this.#state = "done";
    this.#leftover = this.#input.slice(this.#bitAt >> 3);
    this.#input = EMPTY;
    this.#bitAt = 0;
  }

  #append(chunk: Uint8Array): void {
    if (this.#input.length === 0) {
      this.#input = chunk;
      this.#bitAt = 0;
      return;
    }

    const combined = new Uint8Array(this.#input.length + chunk.length);
    combined.set(this.#input, 0);
    combined.set(chunk, this.#input.length);
    this.#input = combined;
  }

  /** Drops the bytes already read, so waiting never accumulates the stream. */
  #compact(): void {
    const consumed = this.#bitAt >> 3;
    if (consumed === 0) {
      return;
    }

    this.#input = this.#input.slice(consumed);
    this.#bitAt &= 7;
  }

  #step(): Step {
    switch (this.#state) {
      case "zlib-header":
        return this.#readZlibHeader();
      case "block-header":
        return this.#readBlockHeader();
      case "stored":
        return this.#copyStored();
      case "compressed":
        return this.#decodeSymbol();
      case "checksum":
        return this.#readChecksum();
      case "done":
        return "done";
    }
  }

  #readZlibHeader(): Step {
    const cmf = this.#bits(8);
    const flg = this.#bits(8);

    if ((cmf & 0x0f) !== 8) {
      throw new InflateError("corrupt", "Not a deflate stream.");
    }
    if ((flg & 0x20) !== 0) {
      throw new InflateError("corrupt", "A preset dictionary is not supported.");
    }
    if (((cmf << 8) | flg) % 31 !== 0) {
      throw new InflateError("corrupt", "The zlib header check failed.");
    }

    this.#state = "block-header";
    return "continue";
  }

  #readBlockHeader(): Step {
    this.#lastBlock = this.#bits(1) === 1;
    const kind = this.#bits(2);

    switch (kind) {
      case 0:
        return this.#readStoredHeader();
      case 1:
        this.#literals = FIXED_LITERALS;
        this.#distances = FIXED_DISTANCES;
        this.#state = "compressed";
        return "continue";
      case 2:
        return this.#readDynamicTables();
      default:
        throw new InflateError("corrupt", "Reserved deflate block type.");
    }
  }

  #readStoredHeader(): Step {
    this.#align();
    const length = this.#bits(16);
    const complement = this.#bits(16);

    if (length !== (~complement & 0xffff)) {
      throw new InflateError("corrupt", "A stored block's length is corrupt.");
    }

    this.#storedRemaining = length;
    this.#state = "stored";
    return "continue";
  }

  #copyStored(): Step {
    const from = this.#bitAt >> 3;
    const take = Math.min(this.#input.length - from, this.#storedRemaining);

    if (take > 0) {
      this.#write(this.#input.subarray(from, from + take));
      this.#bitAt += take * 8;
      this.#storedRemaining -= take;
    }

    if (this.#storedRemaining > 0) {
      return "wait";
    }

    this.#state = this.#stateAfterBlock();
    return "continue";
  }

  #readDynamicTables(): Step {
    const literalCount = this.#bits(5) + 257;
    const distanceCount = this.#bits(5) + 1;
    const codeLengthCount = this.#bits(4) + 4;

    const codeLengths = new Uint8Array(CODE_LENGTH_ORDER.length);
    for (let i = 0; i < codeLengthCount; i += 1) {
      codeLengths[CODE_LENGTH_ORDER[i]!] = this.#bits(3);
    }
    const codeLengthCodes = buildHuffman(codeLengths);

    const lengths = new Uint8Array(literalCount + distanceCount);
    let at = 0;
    while (at < lengths.length) {
      const symbol = this.#decode(codeLengthCodes);

      if (symbol < 16) {
        lengths[at] = symbol;
        at += 1;
        continue;
      }

      let repeat: number;
      let value = 0;

      if (symbol === 16) {
        if (at === 0) {
          throw new InflateError("corrupt", "Nothing to repeat.");
        }
        value = lengths[at - 1]!;
        repeat = 3 + this.#bits(2);
      } else if (symbol === 17) {
        repeat = 3 + this.#bits(3);
      } else {
        repeat = 11 + this.#bits(7);
      }

      if (at + repeat > lengths.length) {
        throw new InflateError("corrupt", "A code length repeat overruns.");
      }

      lengths.fill(value, at, at + repeat);
      at += repeat;
    }

    this.#literals = buildHuffman(lengths.subarray(0, literalCount));
    this.#distances = buildHuffman(lengths.subarray(literalCount));
    this.#state = "compressed";
    return "continue";
  }

  /**
   * One literal or one match. Every bit this reads is read before a byte is
   * written, so `push` can rewind and retry the whole symbol when the input
   * runs out mid-way.
   */
  #decodeSymbol(): Step {
    const symbol = this.#decode(this.#literals);

    if (symbol < 256) {
      this.#writeByte(symbol);
      return "continue";
    }

    if (symbol === 256) {
      this.#state = this.#stateAfterBlock();
      return "continue";
    }

    const lengthCode = symbol - 257;
    if (lengthCode >= LENGTH_BASE.length) {
      throw new InflateError("corrupt", "Invalid length symbol.");
    }
    const length = LENGTH_BASE[lengthCode]! + this.#bits(LENGTH_EXTRA[lengthCode]!);

    const distanceCode = this.#decode(this.#distances);
    if (distanceCode >= DISTANCE_BASE.length) {
      throw new InflateError("corrupt", "Invalid distance symbol.");
    }
    const distance = DISTANCE_BASE[distanceCode]! + this.#bits(DISTANCE_EXTRA[distanceCode]!);

    if (distance > this.#outputAt) {
      throw new InflateError("corrupt", "A match reaches before the output.");
    }
    if (this.#outputAt + length > this.#output.length) {
      throw new InflateError("corrupt", "The inflated data overruns its size.");
    }

    // Byte at a time on purpose: a match may overlap itself, which is how
    // deflate encodes runs.
    let from = this.#outputAt - distance;
    for (let i = 0; i < length; i += 1) {
      this.#output[this.#outputAt] = this.#output[from]!;
      this.#outputAt += 1;
      from += 1;
    }

    return "continue";
  }

  #readChecksum(): Step {
    this.#align();
    const stored =
      ((this.#bits(8) << 24) | (this.#bits(8) << 16) | (this.#bits(8) << 8) | this.#bits(8)) >>> 0;

    if (stored !== adler32(this.#output.subarray(0, this.#outputAt))) {
      throw new InflateError("corrupt", "The zlib checksum does not match.");
    }

    return "done";
  }

  #stateAfterBlock(): State {
    if (!this.#lastBlock) {
      return "block-header";
    }
    if (this.#checksummed) {
      return "checksum";
    }

    // A raw deflate stream still pads its last block to a byte boundary. The
    // caller owns whatever begins at the following byte (gzip's trailer).
    this.#align();
    return "done";
  }

  #write(bytes: Uint8Array): void {
    if (this.#outputAt + bytes.length > this.#output.length) {
      throw new InflateError("corrupt", "The inflated data overruns its size.");
    }

    this.#output.set(bytes, this.#outputAt);
    this.#outputAt += bytes.length;
  }

  #writeByte(byte: number): void {
    if (this.#outputAt >= this.#output.length) {
      throw new InflateError("corrupt", "The inflated data overruns its size.");
    }

    this.#output[this.#outputAt] = byte;
    this.#outputAt += 1;
  }

  #align(): void {
    this.#bitAt = (this.#bitAt + 7) & ~7;
  }

  #bits(count: number): number {
    if (count === 0) {
      return 0;
    }
    if (this.#bitAt + count > this.#input.length * 8) {
      throw NEED_INPUT;
    }

    let value = 0;
    let filled = 0;
    let at = this.#bitAt;

    while (filled < count) {
      const used = at & 7;
      const take = Math.min(8 - used, count - filled);
      value |= ((this.#input[at >> 3]! >> used) & ((1 << take) - 1)) << filled;
      filled += take;
      at += take;
    }

    this.#bitAt = at;
    return value >>> 0;
  }

  #decode(table: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;

    for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
      code |= this.#bits(1);
      const count = table.counts[length]!;

      if (code - first < count) {
        return table.symbols[index + (code - first)]!;
      }

      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }

    throw new InflateError("corrupt", "An incomplete Huffman code was used.");
  }
}
