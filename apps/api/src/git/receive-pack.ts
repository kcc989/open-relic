/**
 * The push conversation, as bytes: the ref update commands a client sends, and
 * the `report-status` it reads back.
 *
 * Nothing here touches storage. What a command *means* — whether the ref moved,
 * whether the objects arrived — is the repository's, and lives beside it.
 */

import { validateBranchName } from "@open-relic/contracts";

import { concat } from "../bytes.ts";
import { ZERO_OID } from "../object.ts";
import { flushPkt, pktLine, type PktLineReader } from "./pkt-line.ts";

/** What a client reads the outcome of a push back as. */
export const RECEIVE_PACK_RESULT_CONTENT_TYPE = "application/x-git-receive-pack-result" as const;

export const REPORT_STATUS_CAPABILITY = "report-status";
export const SIDE_BAND_64K_CAPABILITY = "side-band-64k";

/**
 * The multiplexed stream `side-band-64k` turns the response into: the report on
 * band 1, anything we want a human to read on band 2, and a fatal on band 3.
 * A client prints band 2 verbatim, prefixed with `remote:`.
 */
const DATA_BAND = 1;
const PROGRESS_BAND = 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * One line of the client's command list: move `name` from `oldOid` to `newOid`.
 * A create spells its old value as the zero id and a delete its new one, so all
 * three cases are one shape.
 */
export interface ReceivePackCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly name: string;
}

export interface ReceivePackRequest {
  readonly commands: readonly ReceivePackCommand[];
  /** Only the first command line carries them; they apply to the whole push. */
  readonly capabilities: readonly string[];
}

export const isCreate = (command: ReceivePackCommand): boolean => command.oldOid === ZERO_OID;

export const isDelete = (command: ReceivePackCommand): boolean => command.newOid === ZERO_OID;

/**
 * A push we could not read far enough into to blame a ref for. It carries
 * whatever capabilities had already been negotiated, so the refusal still
 * reaches the client on the band it asked to be spoken to on.
 */
export class ReceivePackError extends Error {
  readonly capabilities: readonly string[];

  constructor(message: string, capabilities: readonly string[]) {
    super(message);
    this.name = "ReceivePackError";
    this.capabilities = capabilities;
  }
}

const COMMAND_PATTERN = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/;

/** `capabilities` is `null` on every line but the first, which is the only one that carries them. */
interface ParsedCommandLine {
  readonly command: ReceivePackCommand;
  readonly capabilities: readonly string[] | null;
}

const parseCommandLine = (
  payload: Uint8Array,
  negotiated: readonly string[],
): ParsedCommandLine => {
  const text = decoder.decode(payload).replace(/\n$/, "");
  const separator = text.indexOf("\0");
  const head = separator === -1 ? text : text.slice(0, separator);
  const capabilities =
    separator === -1
      ? null
      : text
          .slice(separator + 1)
          .split(" ")
          .filter((capability) => capability !== "");

  const match = COMMAND_PATTERN.exec(head);
  if (match === null) {
    throw new ReceivePackError(`"${head}" is not a ref update command.`, negotiated);
  }

  return {
    command: { oldOid: match[1]!, newOid: match[2]!, name: match[3]! },
    capabilities,
  };
};

/**
 * Reads the command list and stops at its flush packet, leaving the reader
 * sitting on the pack that follows.
 */
export const readReceivePackRequest = async (lines: PktLineReader): Promise<ReceivePackRequest> => {
  const commands: ReceivePackCommand[] = [];
  let capabilities: readonly string[] = [];

  for (;;) {
    const line = await lines.next();

    if (line.kind === "flush") {
      return { commands, capabilities };
    }

    // A body that runs out before its flush packet is a truncated push, not an
    // empty one: the pack it promised is missing along with the flush.
    if (line.kind === "end") {
      if (commands.length === 0) {
        return { commands, capabilities };
      }
      throw new ReceivePackError(
        "The request ended before the ref update commands did.",
        capabilities,
      );
    }

    const parsed = parseCommandLine(line.payload, capabilities);
    if (parsed.capabilities !== null && commands.length === 0) {
      capabilities = parsed.capabilities;
    }
    commands.push(parsed.command);
  }
};

/** A pushed ref's outcome, in the order the client asked for it. */
export type RefStatus =
  | { readonly name: string; readonly accepted: true }
  | { readonly name: string; readonly accepted: false; readonly reason: string };

export const accepted = (name: string): RefStatus => ({ name, accepted: true });

export const rejected = (name: string, reason: string): RefStatus => ({
  name,
  accepted: false,
  reason,
});

/** What Git prints when a push fails, spelled the way Git spells it. */
export const UNPACK_OK = "ok";

export interface ReceivePackReport {
  /** `ok`, or why the pack could not be read. */
  readonly unpack: string;
  readonly refs: readonly RefStatus[];
  /**
   * Explanations for a human, sent on the progress band. A client that did not
   * ask for `side-band-64k` has nowhere to put them and gets none — the report
   * is the whole response there, and prose in it would corrupt the report.
   */
  readonly messages: readonly string[];
}

/**
 * A report line is newline-delimited and half of what goes on one came from the
 * client — a ref name it chose, or its own bytes quoted back in an error. A
 * newline in any of that would let a client forge status lines in the report it
 * is about to read, so the encoder is where they stop.
 */
const isControl = (code: number): boolean => code < 0x20 || code === 0x7f;

const oneLine = (text: string): string => {
  let flattened = "";

  for (const character of text) {
    flattened += isControl(character.charCodeAt(0)) ? " " : character;
  }

  return flattened.trim();
};

const bandLine = (band: number, payload: Uint8Array): Uint8Array =>
  pktLine(concat(Uint8Array.of(band), payload));

function* reportLines(report: ReceivePackReport): Generator<Uint8Array> {
  yield pktLine(`unpack ${oneLine(report.unpack)}\n`);

  for (const ref of report.refs) {
    yield ref.accepted
      ? pktLine(`ok ${oneLine(ref.name)}\n`)
      : pktLine(`ng ${oneLine(ref.name)} ${oneLine(ref.reason)}\n`);
  }

  yield flushPkt();
}

function* resultLines(report: ReceivePackReport, sideband: boolean): Generator<Uint8Array> {
  if (!sideband) {
    yield* reportLines(report);
    return;
  }

  for (const message of report.messages) {
    yield bandLine(PROGRESS_BAND, encoder.encode(`${oneLine(message)}\n`));
  }

  // The report keeps its own framing inside the band, flush packet and all;
  // the outer flush below is what ends the multiplexed stream.
  for (const line of reportLines(report)) {
    yield bandLine(DATA_BAND, line);
  }

  yield flushPkt();
}

/**
 * The response body. Small enough to hand over whole — it is one line per ref
 * the client named — which is what lets the repository return the outcome of a
 * push alongside it rather than only a stream.
 */
export const receivePackResult = (
  report: ReceivePackReport,
  capabilities: readonly string[],
): Uint8Array<ArrayBuffer> => {
  // A client that did not ask for `report-status` is not reading one, and
  // sending it anyway would leave bytes on a connection it considers finished.
  if (!capabilities.includes(REPORT_STATUS_CAPABILITY)) {
    return new Uint8Array(0);
  }

  return concat(...resultLines(report, capabilities.includes(SIDE_BAND_64K_CAPABILITY)));
};

// ---------------------------------------------------------------------------
// What this server accepts
// ---------------------------------------------------------------------------

/**
 * Why a ref did not move, in the words a client prints back to whoever ran
 * `git push`. `non-fast-forward` is Git's own spelling and is worth matching
 * exactly; the rest only have to be true and readable.
 */
export const REJECTIONS = {
  delete: "deleting a ref is not supported",
  funnyRefname: "funny refname",
  duplicate: "the same ref appears twice in this push",
  exists: "the ref already exists",
  vanished: "the ref no longer exists",
  stale: "the ref has moved since it was advertised",
  nonFastForward: "non-fast-forward",
  missingObjects: "missing necessary objects",
  unprovable: "the history is too long to prove a fast-forward",
  unpacker: "n/a (unpacker error)",
} as const;

/**
 * A full ref name, held to a conservative subset of `git check-ref-format`.
 *
 * `validateBranchName` is reused rather than reimplemented: it rejects
 * everything Git rejects and some things Git would allow, and widening it later
 * cannot invalidate a name already stored. It does cap a pushed ref at
 * `BRANCH_NAME_MAX_LENGTH` and turn away the odd name Git would take — `+` and
 * `,` are the realistic ones — which is a narrowing to revisit when the ref
 * rules get a home of their own.
 */
const isRefName = (name: string): boolean =>
  name.startsWith("refs/") && validateBranchName(name) === null;

/**
 * Everything about a push that can be decided from the command list and the
 * refs the repository already holds — no objects read, no storage touched.
 * `null` in a slot means the command survives to the connectivity walk.
 *
 * Deletes and force are the two halves of push deliberately left out of this
 * slice, and `delete-refs` is unadvertised for exactly that reason. A client
 * that sends one anyway is told so rather than quietly ignored.
 */
export const screenCommands = (
  commands: readonly ReceivePackCommand[],
  refs: ReadonlyMap<string, string>,
): readonly (string | null)[] => {
  const seen = new Set<string>();

  return commands.map((command) => {
    if (isDelete(command)) {
      return REJECTIONS.delete;
    }

    if (!isRefName(command.name)) {
      return REJECTIONS.funnyRefname;
    }

    // Two commands for one ref would leave it wherever the transaction happened
    // to write last, which is a contradiction for the client to resolve.
    if (seen.has(command.name)) {
      return REJECTIONS.duplicate;
    }
    seen.add(command.name);

    const held = refs.get(command.name);

    if (isCreate(command)) {
      return held === undefined ? null : REJECTIONS.exists;
    }
    if (held === undefined) {
      return REJECTIONS.vanished;
    }

    // A client pushes against the advertisement it was given; a ref that has
    // moved since means it is deciding from a view we no longer hold. A command
    // that moves a ref to where it already is falls through — Git's own
    // receive-pack answers one with `ok`.
    return held === command.oldOid ? null : REJECTIONS.stale;
  });
};
