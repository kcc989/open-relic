import { describe, expect, test } from "bun:test";

import { PktLineReader } from "../src/git/pkt-line.ts";
import {
  REJECTIONS,
  ReceivePackError,
  accepted,
  readReceivePackRequest,
  receivePackResult,
  rejected,
  screenCommands,
  type ReceivePackReport,
} from "../src/git/receive-pack.ts";
import { ZERO_OID } from "../src/object.ts";
import { streamOf } from "./support/pack.ts";
import { commandLines, readReport } from "./support/receive-pack.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAIN = "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678";
const NEXT = "abcdef0123456789abcdef0123456789abcdef01";

const read = (body: Uint8Array) => {
  const lines = new PktLineReader(streamOf(body));
  return { lines, request: readReceivePackRequest(lines) };
};

describe("the ref update commands a client sends", () => {
  test("reads a create, with the capabilities off the first line", async () => {
    const { request } = read(
      commandLines([{ newOid: MAIN, name: "refs/heads/main" }], [
        "report-status",
        "side-band-64k",
      ]),
    );

    expect(await request).toEqual({
      commands: [
        { oldOid: ZERO_OID, newOid: MAIN, name: "refs/heads/main" },
      ],
      capabilities: ["report-status", "side-band-64k"],
    });
  });

  test("reads several commands, only the first of which carries capabilities", async () => {
    const { request } = read(
      commandLines(
        [
          { oldOid: MAIN, newOid: NEXT, name: "refs/heads/main" },
          { newOid: NEXT, name: "refs/tags/v1" },
        ],
        ["report-status"],
      ),
    );

    const { commands, capabilities } = await request;

    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual({
      oldOid: ZERO_OID,
      newOid: NEXT,
      name: "refs/tags/v1",
    });
    expect(capabilities).toEqual(["report-status"]);
  });

  test("reads a delete, which spells its new value as the zero id", async () => {
    const { request } = read(
      commandLines([{ oldOid: MAIN, name: "refs/heads/gone" }], []),
    );

    expect((await request).commands[0]).toEqual({
      oldOid: MAIN,
      newOid: ZERO_OID,
      name: "refs/heads/gone",
    });
  });

  test("stops at the flush, leaving the pack for the pack reader", async () => {
    const body = new Uint8Array([
      ...commandLines([{ newOid: MAIN, name: "refs/heads/main" }], []),
      ...encoder.encode("PACK…"),
    ]);
    const { lines, request } = read(body);
    await request;

    expect(await new Response(lines.rest()).text()).toBe("PACK…");
  });

  test("a body with nothing in it is a push of nothing, not an error", async () => {
    const { request } = read(new Uint8Array(0));

    expect(await request).toEqual({ commands: [], capabilities: [] });
  });

  test("a body that ends before its flush is a truncated push", async () => {
    const withoutFlush = commandLines(
      [{ newOid: MAIN, name: "refs/heads/main" }],
      [],
    ).slice(0, -4);

    expect(read(withoutFlush).request).rejects.toThrow(ReceivePackError);
  });

  test("a line that is not a command is rejected rather than skipped", async () => {
    const { request } = read(
      encoder.encode("0013not a command at\n0000"),
    );

    expect(request).rejects.toThrow(ReceivePackError);
  });
});

describe("report-status", () => {
  const report: ReceivePackReport = {
    unpack: "ok",
    refs: [
      accepted("refs/heads/main"),
      rejected("refs/heads/old", "non-fast-forward"),
    ],
    messages: ["something worth saying"],
  };

  test("is the plain report when the client asked only for report-status", () => {
    const body = receivePackResult(report, ["report-status"]);

    expect(decoder.decode(body)).toBe(
      "000eunpack ok\n" +
        "0017ok refs/heads/main\n" +
        "0027ng refs/heads/old non-fast-forward\n" +
        "0000",
    );
  });

  test("keeps its progress messages off a stream that cannot carry them", () => {
    // Without side-band-64k the report *is* the response; prose in it would be
    // read as another status line.
    const body = decoder.decode(receivePackResult(report, ["report-status"]));

    expect(body).not.toContain("something worth saying");
  });

  test("multiplexes onto band 1 when the client asked for side-band-64k", () => {
    const body = receivePackResult(report, [
      "report-status",
      "side-band-64k",
    ]);

    expect(readReport(body)).toEqual({
      lines: [
        "unpack ok",
        "ok refs/heads/main",
        "ng refs/heads/old non-fast-forward",
      ],
      progress: ["something worth saying"],
    });
  });

  test("ends the multiplexed stream with a flush of its own", () => {
    const body = receivePackResult(report, ["report-status", "side-band-64k"]);

    expect(decoder.decode(body)).toEndWith("0009\x010000" + "0000");
  });

  test("is nothing at all to a client that did not ask to read one", () => {
    // Bytes on a connection the client considers finished are worse than
    // silence: it is not reading them, and the next request finds them there.
    expect(receivePackResult(report, ["side-band-64k"])).toHaveLength(0);
  });

  test("cannot be made to carry a line the client wrote itself", () => {
    // Half of what goes on a report line came from the client — a ref name it
    // chose, or its own bytes quoted back — so a newline in any of it would
    // forge a status line in the report it is about to read.
    const body = decoder.decode(
      receivePackResult(
        {
          unpack: "bad\nng refs/heads/main forged",
          refs: [rejected("refs/heads/x\ny", "no\nreason")],
          messages: [],
        },
        ["report-status"],
      ),
    );

    expect(body.split("\n")).toHaveLength(3);
    expect(body).toContain("unpack bad ng refs/heads/main forged\n");
    expect(body).toContain("ng refs/heads/x y no reason\n");
  });

  test("carries the reason a pack could not be read in unpack", () => {
    const body = receivePackResult(
      {
        unpack: "The pack's trailing checksum does not match.",
        refs: [rejected("refs/heads/main", "n/a (unpacker error)")],
        messages: [],
      },
      ["report-status"],
    );

    expect(decoder.decode(body)).toContain(
      "unpack The pack's trailing checksum does not match.\n",
    );
  });
});

describe("what this server accepts", () => {
  const HELD = new Map([["refs/heads/main", MAIN]]);

  const screen = (
    commands: readonly { oldOid?: string; newOid?: string; name: string }[],
    refs: ReadonlyMap<string, string> = HELD,
  ) =>
    screenCommands(
      commands.map((command) => ({
        oldOid: command.oldOid ?? ZERO_OID,
        newOid: command.newOid ?? ZERO_OID,
        name: command.name,
      })),
      refs,
    );

  test("lets a create of an unheld ref through", () => {
    expect(screen([{ newOid: NEXT, name: "refs/heads/next" }])).toEqual([null]);
  });

  test("lets an update from what we hold through", () => {
    expect(
      screen([{ oldOid: MAIN, newOid: NEXT, name: "refs/heads/main" }]),
    ).toEqual([null]);
  });

  const refused: ReadonlyArray<
    readonly [string, { oldOid?: string; newOid?: string; name: string }, string]
  > = [
    [
      "a delete, which the advertisement never offered",
      { oldOid: MAIN, name: "refs/heads/main" },
      REJECTIONS.delete,
    ],
    [
      "a create of a ref we already hold",
      { newOid: NEXT, name: "refs/heads/main" },
      REJECTIONS.exists,
    ],
    [
      "an update to a ref that is not there",
      { oldOid: MAIN, newOid: NEXT, name: "refs/heads/gone" },
      REJECTIONS.vanished,
    ],
    [
      "an update from a value we no longer hold",
      { oldOid: NEXT, newOid: MAIN, name: "refs/heads/main" },
      REJECTIONS.stale,
    ],
    [
      "a name outside refs/",
      { newOid: NEXT, name: "main" },
      REJECTIONS.funnyRefname,
    ],
  ];

  for (const [label, command, reason] of refused) {
    test(`refuses ${label}`, () => {
      expect(screen([command])).toEqual([reason]);
    });
  }

  test("keeps the first command to name a ref and refuses the rest", () => {
    expect(
      screen([
        { newOid: NEXT, name: "refs/heads/next" },
        { newOid: MAIN, name: "refs/heads/next" },
      ]),
    ).toEqual([null, REJECTIONS.duplicate]);
  });

  test("lets a ref that is already where the push wants it through", () => {
    // Git's own receive-pack answers a no-op with `ok`.
    expect(
      screen([{ oldOid: MAIN, newOid: MAIN, name: "refs/heads/main" }]),
    ).toEqual([null]);
  });
});
