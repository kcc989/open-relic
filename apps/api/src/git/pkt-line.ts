/**
 * Git's framing for everything on the wire: a four-digit lowercase hex length
 * that counts itself, then the payload. `0000` is the flush packet — a length
 * with no payload, which is why an empty pkt-line is spelled `0004` instead.
 */

const encoder = new TextEncoder();

export const PKT_LINE_LENGTH_BYTES = 4;

/** A pkt-line's length field is four hex digits, so `ffff` bounds the whole line. */
export const PKT_LINE_MAX_PAYLOAD_BYTES = 0xffff - PKT_LINE_LENGTH_BYTES;

export const FLUSH_PKT_TEXT = "0000";

/**
 * A fresh array per call rather than a shared constant: enqueuing a buffer into
 * a stream can transfer it, and a flush packet is written many times per
 * response.
 */
export const flushPkt = (): Uint8Array => encoder.encode(FLUSH_PKT_TEXT);

export const pktLine = (payload: Uint8Array | string): Uint8Array => {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;

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
export const pktLineStream = (
  lines: Iterable<Uint8Array>,
): ReadableStream<Uint8Array> => {
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
