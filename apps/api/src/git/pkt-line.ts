/**
 * Git's framing for everything on the wire: a four-digit lowercase hex length
 * that counts itself, then the payload. `0000` is the flush packet — a length
 * with no payload, which is why an empty pkt-line is spelled `0004` instead.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PKT_LINE_LENGTH_BYTES = 4;

/**
 * Git's ceiling, which is lower than the length field's: four hex digits could
 * frame `ffff` bytes, but a Git reader dies with `protocol error: bad line
 * length` above 65520 on the wire.
 */
export const PKT_LINE_MAX_BYTES = 65520;

export const PKT_LINE_MAX_PAYLOAD_BYTES = PKT_LINE_MAX_BYTES - PKT_LINE_LENGTH_BYTES;

export const FLUSH_PKT_TEXT = "0000";

/**
 * A fresh array per call rather than a shared constant: enqueuing a buffer into
 * a stream can transfer it, and a flush packet is written many times per
 * response.
 */
export const flushPkt = (): Uint8Array => encoder.encode(FLUSH_PKT_TEXT);

export const pktLine = (payload: Uint8Array | string): Uint8Array => {
  const bytes = payload instanceof Uint8Array ? payload : encoder.encode(payload);

  if (bytes.length > PKT_LINE_MAX_PAYLOAD_BYTES) {
    throw new RangeError(
      `A pkt-line payload may be at most ${PKT_LINE_MAX_PAYLOAD_BYTES} bytes; got ${bytes.length}.`,
    );
  }

  const length = bytes.length + PKT_LINE_LENGTH_BYTES;
  const line = new Uint8Array(length);
  line.set(encoder.encode(length.toString(16).padStart(PKT_LINE_LENGTH_BYTES, "0")));
  line.set(bytes, PKT_LINE_LENGTH_BYTES);

  return line;
};

/**
 * Pulls one line at a time from `lines`, so a response is never assembled in
 * memory and a generator upstream can encode as it reads.
 */
export const pktLineStream = (lines: Iterable<Uint8Array>): ReadableStream<Uint8Array> => {
  const iterator = lines[Symbol.iterator]();

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
  });
};

export class PktLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PktLineError";
  }
}

/**
 * A flush is the end of a *section*, not of the stream: a receive-pack request
 * ends its ref update commands with one and then sends a pack, so the two have
 * to be told apart.
 */
export type PktLine =
  | { readonly kind: "line"; readonly payload: Uint8Array }
  | { readonly kind: "flush" }
  | { readonly kind: "end" };

const EMPTY = new Uint8Array(0);

/** Git writes lowercase; a reader that insisted on it would be gratuitous. */
const LENGTH_PATTERN = /^[0-9a-fA-F]{4}$/;

/**
 * The other half of {@link pktLine}: pkt-lines off a request body, and then the
 * raw bytes that follow them.
 *
 * The two halves are one reader on purpose. A pkt-line is framed by a length
 * rather than delimited, so reading one very nearly always over-reads into what
 * comes next; {@link PktLineReader.rest} is how those bytes reach the pack
 * reader instead of being lost, and is what keeps a push streaming rather than
 * buffered.
 */
export class PktLineReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array = EMPTY;
  #exhausted = false;
  #handedOver = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  async next(): Promise<PktLine> {
    if (this.#handedOver) {
      throw new PktLineError("The rest of this stream has already been handed over.");
    }

    if (!(await this.#fill(PKT_LINE_LENGTH_BYTES))) {
      if (this.#buffer.length > 0) {
        throw new PktLineError("The stream ended inside a pkt-line's length.");
      }
      return { kind: "end" };
    }

    const length = this.#declaredLength();

    if (length === 0) {
      this.#advance(PKT_LINE_LENGTH_BYTES);
      return { kind: "flush" };
    }

    // `0001` and `0002` are protocol v2's delimiters and `0003` is nothing at
    // all. Push is v1 only, so none of them belong on this stream.
    if (length < PKT_LINE_LENGTH_BYTES) {
      throw new PktLineError(`A pkt-line length of ${length} has no meaning in this protocol.`);
    }

    if (length > PKT_LINE_MAX_BYTES) {
      throw new PktLineError(
        `A pkt-line may be at most ${PKT_LINE_MAX_BYTES} bytes; got ${length}.`,
      );
    }

    if (!(await this.#fill(length))) {
      throw new PktLineError("The stream ended inside a pkt-line's payload.");
    }

    const payload = this.#buffer.slice(PKT_LINE_LENGTH_BYTES, length);
    this.#advance(length);
    return { kind: "line", payload };
  }

  /**
   * Everything not yet consumed, as a stream — the bytes already pulled past
   * the last pkt-line first, then the rest of the body. Reading a line after
   * this is an error, because this reader no longer owns the stream.
   */
  rest(): ReadableStream<Uint8Array> {
    this.#handedOver = true;

    // Copied off the read buffer rather than sliced from it: this chunk is
    // handed to a stream that outlives the command phase, and a view would keep
    // every byte the command phase ever grew alive behind it.
    let leftover: Uint8Array = this.#buffer.slice();
    this.#buffer = EMPTY;
    const reader = this.#reader;

    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (leftover.length > 0) {
          controller.enqueue(leftover);
        }
        leftover = EMPTY;
      },
      async pull(controller) {
        // A reader that is already done answers `done` again, so it is its own
        // exhaustion flag.
        const { done, value } = await reader.read();
        if (done || value === undefined) {
          controller.close();
          return;
        }

        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
  }

  /** Gives up on the rest of the body, for a request whose tail we will not read. */
  async cancel(): Promise<void> {
    if (this.#handedOver) {
      return;
    }

    this.#handedOver = true;
    this.#buffer = EMPTY;
    await this.#reader.cancel();
  }

  #declaredLength(): number {
    const text = decoder.decode(this.#buffer.subarray(0, PKT_LINE_LENGTH_BYTES));

    if (!LENGTH_PATTERN.test(text)) {
      throw new PktLineError(`"${text}" is not a pkt-line length.`);
    }

    return Number.parseInt(text, 16);
  }

  #advance(count: number): void {
    this.#buffer = this.#buffer.subarray(count);
  }

  async #fill(count: number): Promise<boolean> {
    while (this.#buffer.length < count) {
      if (!(await this.#pull())) {
        return false;
      }
    }

    return true;
  }

  async #pull(): Promise<boolean> {
    if (this.#exhausted) {
      return false;
    }

    const { done, value } = await this.#reader.read();
    if (done || value === undefined) {
      this.#exhausted = true;
      return false;
    }

    if (this.#buffer.length === 0) {
      this.#buffer = value;
      return true;
    }

    const grown = new Uint8Array(this.#buffer.length + value.length);
    grown.set(this.#buffer, 0);
    grown.set(value, this.#buffer.length);
    this.#buffer = grown;

    return true;
  }
}
