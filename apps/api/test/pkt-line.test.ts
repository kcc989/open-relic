import { describe, expect, test } from "bun:test";

import {
  delimiterPkt,
  PKT_LINE_MAX_PAYLOAD_BYTES,
  PktLineError,
  PktLineReader,
  flushPkt,
  pktLine,
  pktLineStream,
} from "../src/git/pkt-line.ts";
import { streamOf } from "./support/pack.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);

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
