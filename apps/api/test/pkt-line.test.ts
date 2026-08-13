import { describe, expect, test } from "bun:test";

import {
  PKT_LINE_MAX_PAYLOAD_BYTES,
  flushPkt,
  pktLine,
  pktLineStream,
} from "../src/git/pkt-line.ts";

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
