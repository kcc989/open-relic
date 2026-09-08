import { describe, expect, test } from "bun:test";

import {
  delimiterPkt,
  PKT_LINE_MAX_PAYLOAD_BYTES,
  PktLineError,
  PktLineReader,
  REST_READ_BYTES,
  flushPkt,
  pktLine,
  pktLineStream,
} from "../src/git/pkt-line.ts";
import { concat, streamOf } from "./support/pack.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);

/**
 * A byte stream as workerd hands one over: a default reader is answered
 * `chunkSize` bytes at a time, and a BYOB reader's `readAtLeast` — which the
 * standard lacks and Bun's byte streams do not offer — fills the view to the
 * minimum asked for, or to the end. `requested` records each minimum.
 */
const readAtLeastStream = (
  bytes: Uint8Array,
  chunkSize: number,
  requested: number[],
  onCancel: (reason: string) => void = () => {},
): ReadableStream<Uint8Array> => {
  // One position for both readers: the BYOB reader carries on from wherever
  // the default reader left the stream. No read-ahead, so that position is
  // exactly what the default reader consumed.
  let at = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        const chunk = bytes.slice(at, at + chunkSize);
        at += chunk.length;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  const read = async (view: Uint8Array, minBytes: number) => {
    const count = Math.min(Math.max(minBytes, view.length), bytes.length - at, view.length);
    const value = view.subarray(0, count);
    value.set(bytes.subarray(at, at + count));
    at += count;
    return { done: count === 0, value };
  };
  const byob = {
    read: (view: Uint8Array) => read(view, 1),
    readAtLeast: (minBytes: number, view: Uint8Array) => {
      requested.push(minBytes);
      return read(view, minBytes);
    },
    releaseLock: () => {},
    cancel: async (reason: string) => onCancel(reason),
    closed: Promise.resolve(undefined),
  };
  const getReader = stream.getReader.bind(stream);
  // SAFETY: the test stands in for a runtime whose BYOB reader has this shape.
  stream.getReader = ((options?: { readonly mode?: "byob" }) =>
    options?.mode === "byob" ? byob : getReader()) as typeof stream.getReader;
  return stream;
};

describe("pktLine", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["counts its own four-byte length", "a\n", "0006a\n"],
    ["pads the length to four hex digits", "", "0004"],
    ["writes the length in lowercase hex", "x".repeat(0xfa - 4), `00fa${"x".repeat(0xfa - 4)}`],
    [
      "is the shape Git's service header takes",
      "# service=git-receive-pack\n",
      "001f# service=git-receive-pack\n",
    ],
  ];

  for (const [label, payload, expected] of cases) {
    test(label, () => {
      expect(text(pktLine(payload))).toBe(expected);
    });
  }

  test("measures bytes rather than characters", () => {
    // Two characters, four bytes: a length in characters would frame the line
    // short and desynchronize everything after it.
    expect(text(pktLine("é€"))).toBe("0009é€");
  });

  test("accepts bytes as readily as text", () => {
    expect(text(pktLine(new Uint8Array([0x61, 0x62])))).toBe("0006ab");
  });

  test("refuses a payload larger than Git's maximum", () => {
    // Git's own limit rather than what four hex digits could frame: a reader
    // dies with `protocol error: bad line length` above 65520 on the wire.
    expect(PKT_LINE_MAX_PAYLOAD_BYTES).toBe(65516);
    expect(() => pktLine("x".repeat(PKT_LINE_MAX_PAYLOAD_BYTES))).not.toThrow();
    expect(() => pktLine("x".repeat(PKT_LINE_MAX_PAYLOAD_BYTES + 1))).toThrow(RangeError);
  });
});

describe("protocol-v2 control packets", () => {
  test("writes and reads a delimiter", async () => {
    const reader = new PktLineReader(streamOf(delimiterPkt()));

    expect(await reader.nextV2()).toEqual({ kind: "delimiter" });
  });

  test("keeps a delimiter invalid on a v0/v1 reader", async () => {
    const reader = new PktLineReader(streamOf(delimiterPkt()));

    expect(reader.next()).rejects.toThrow(PktLineError);
  });
});

describe("flushPkt", () => {
  test("is a length with no payload", () => {
    expect(text(flushPkt())).toBe("0000");
  });

  test("is a fresh array each time, so an enqueued buffer cannot be reused", () => {
    expect(flushPkt().buffer).not.toBe(flushPkt().buffer);
  });
});

describe("pktLineStream", () => {
  test("emits the lines it is given, in order", async () => {
    const stream = pktLineStream([pktLine("a\n"), flushPkt()]);

    expect(await new Response(stream).text()).toBe("0006a\n0000");
  });

  test("pulls lazily, so a long ref list is not encoded to send its first line", async () => {
    let produced = 0;
    function* lines(): Generator<Uint8Array> {
      for (let index = 0; index < 100; index += 1) {
        produced += 1;
        yield pktLine(`${index}\n`);
      }
    }

    const reader = pktLineStream(lines()).getReader();
    const first = await reader.read();

    expect(text(first.value!)).toBe("00060\n");
    // A buffering implementation would have run the generator to exhaustion;
    // the stream only keeps enough to satisfy the read plus its queue.
    expect(produced).toBeLessThan(10);

    await reader.cancel();
  });
});

describe("PktLineReader", () => {
  const reader = (body: string, options?: { readonly chunkSize?: number }): PktLineReader =>
    new PktLineReader(streamOf(encoder.encode(body), options));

  test("reads a line's payload without its length", async () => {
    const lines = reader("0009hello");

    expect(await lines.next()).toEqual({
      kind: "line",
      payload: encoder.encode("hello"),
    });
  });

  test("tells a flush packet from the end of the stream", async () => {
    const lines = reader("0006a\n0000");

    expect((await lines.next()).kind).toBe("line");
    expect(await lines.next()).toEqual({ kind: "flush" });
    expect(await lines.next()).toEqual({ kind: "end" });
  });

  test("reads an empty line, which is not a flush", async () => {
    const lines = reader("0004");

    expect(await lines.next()).toEqual({
      kind: "line",
      payload: new Uint8Array(0),
    });
  });

  test("reassembles a line split across chunks", async () => {
    // A body arrives in whatever slices the network chose, and a pkt-line is
    // framed by a length rather than delimited, so the two never line up.
    const lines = reader("0014half here, half\n0000", { chunkSize: 3 });
    const line = await lines.next();

    expect(line.kind === "line" && text(line.payload)).toBe("half here, half\n");
  });

  test("hands the bytes past the last line to whoever reads next", async () => {
    // This is the whole reason the two halves are one reader: a pack follows
    // the commands with nothing between them but a flush packet.
    const lines = reader("0006a\n0000PACK and then some", { chunkSize: 5 });

    await lines.next();
    await lines.next();

    expect(await new Response(lines.rest()).text()).toBe("PACK and then some");
  });

  test("reads the rest of a byte stream in pieces of the size it asks for", async () => {
    // A request body on workerd is a byte stream whose BYOB reader can be asked
    // for a minimum, which is how the pack behind the commands arrives in large
    // pieces rather than the 4 KiB a default reader is answered with. The
    // commands took a default reader first, so the hand-over is also a change
    // of reader mid-stream — the byte stream here answers both.
    const body = concat(
      encoder.encode("0006a\n0000"),
      encoder.encode("P".repeat(REST_READ_BYTES * 2 + 7)),
    );
    const requested: number[] = [];
    const lines = new PktLineReader(readAtLeastStream(body, 4, requested));

    await lines.next();
    await lines.next();

    const pieces: number[] = [];
    for await (const piece of lines.rest()) {
      pieces.push(piece.length);
    }

    // Every read asked for a full piece, including the one that found the end.
    expect(requested).toEqual(Array(4).fill(REST_READ_BYTES));
    // The default reader's over-read leads, then every piece is full but the last.
    expect(pieces).toEqual([2, REST_READ_BYTES, REST_READ_BYTES, 5]);
  });

  test("keeps a default reader for a stream that is not a byte stream", async () => {
    // Bun's request bodies, and any adapter handing over a plain stream: a BYOB
    // reader is refused with a TypeError, and the rest is read as it comes.
    const lines = reader("0006a\n0000PACK and then some", { chunkSize: 4 });

    await lines.next();
    await lines.next();

    const pieces: number[] = [];
    for await (const piece of lines.rest()) {
      pieces.push(piece.length);
    }

    expect(pieces).toEqual([2, 4, 4, 4, 4]);
  });

  test("cancels the rest through the BYOB reader it took", async () => {
    const cancelled: string[] = [];
    const stream = readAtLeastStream(encoder.encode("0000PACK"), 4, [], (reason) => {
      cancelled.push(reason);
    });
    const lines = new PktLineReader(stream);
    await lines.next();

    await lines.rest().cancel("gone");

    expect(cancelled).toEqual(["gone"]);
  });

  test("hands over an empty stream when nothing followed", async () => {
    const lines = reader("0000");
    await lines.next();

    expect(await new Response(lines.rest()).text()).toBe("");
  });

  test("refuses to read a line once the rest has been handed over", async () => {
    const lines = reader("0000PACK");
    await lines.next();
    lines.rest();

    expect(lines.next()).rejects.toThrow(PktLineError);
  });

  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["a length that is not hex", "zzzz"],
    ["protocol v2's delimiter, which push does not speak", "0001"],
    ["a length below the four its own field takes", "0003"],
    ["a length past what a reader will accept", "ffffx"],
    ["a stream that ends inside a length", "00"],
    ["a stream that ends inside a payload", "0010short"],
  ];

  for (const [label, body] of malformed) {
    test(`rejects ${label}`, async () => {
      expect(reader(body).next()).rejects.toThrow(PktLineError);
    });
  }
});
