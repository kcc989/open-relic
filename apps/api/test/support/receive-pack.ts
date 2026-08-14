import { flushPkt, pktLine } from "../../src/git/pkt-line.ts";
import { ZERO_OID } from "../../src/object.ts";
import type { GitObject } from "./git-objects.ts";
import { buildPack, concat } from "./pack.ts";

/**
 * The client half of a push, so a test can write what `git push` would send
 * rather than a blob of hex — and read back what it would read, with the
 * `side-band-64k` framing taken off again.
 */

const decoder = new TextDecoder();

export interface PushCommand {
  /** Defaults to the zero id, which is how a create spells "nothing here yet". */
  readonly oldOid?: string;
  readonly newOid?: string;
  readonly name: string;
}

/** What `git push` asks for against our advertisement. */
export const CLIENT_CAPABILITIES: readonly string[] = [
  "report-status-v2",
  "side-band-64k",
  "ofs-delta",
  "agent=git/2.99.0",
];

export const commandLines = (
  commands: readonly PushCommand[],
  capabilities: readonly string[],
): Uint8Array<ArrayBuffer> =>
  concat(
    ...commands.map((command, at) => {
      const line = `${command.oldOid ?? ZERO_OID} ${command.newOid ?? ZERO_OID} ${command.name}`;
      return pktLine(
        at === 0 && capabilities.length > 0 ? `${line}\0${capabilities.join(" ")}\n` : `${line}\n`,
      );
    }),
    flushPkt(),
  );

/** A pack carrying exactly these objects, each whole rather than delta'd. */
export const packOf = (objects: readonly GitObject[]): Uint8Array<ArrayBuffer> =>
  buildPack(
    objects.map((object) => ({
      kind: "object" as const,
      type: object.type,
      bytes: object.bytes,
    })),
  ).bytes;

export const pushBody = (options: {
  readonly commands: readonly PushCommand[];
  readonly objects?: readonly GitObject[];
  readonly capabilities?: readonly string[];
  readonly pushOptions?: readonly string[];
  /** For the packs a test wants to be wrong on purpose. */
  readonly pack?: Uint8Array<ArrayBuffer>;
}): Uint8Array<ArrayBuffer> => {
  const capabilities = options.capabilities ?? CLIENT_CAPABILITIES;
  const pack = options.pack ?? (options.objects === undefined ? null : packOf(options.objects));
  const pushOptions = capabilities.includes("push-options")
    ? concat(...(options.pushOptions ?? []).map((option) => pktLine(option)), flushPkt())
    : new Uint8Array(0);

  return pack === null
    ? concat(commandLines(options.commands, capabilities), pushOptions)
    : concat(commandLines(options.commands, capabilities), pushOptions, pack);
};

export interface Report {
  /** `unpack ok`, `ok <ref>`, `ng <ref> <reason>` — newlines already off. */
  readonly lines: readonly string[];
  /** What the progress band carried, for a human to read. */
  readonly progress: readonly string[];
}

const asText = (bytes: Uint8Array): string => decoder.decode(bytes).replace(/\n$/, "");

export const readReport = (body: Uint8Array): Report => {
  const outer = [...pktLines(body)];

  // A report line starts with `u`, `o`, or `n`; a sideband packet starts with
  // the band number. Nothing else can be at the front of either.
  const sideband = outer.some((line) => line.length > 0 && line[0]! <= 3);

  if (!sideband) {
    return { lines: outer.map(asText), progress: [] };
  }

  const progress: string[] = [];
  const data: Uint8Array[] = [];

  for (const line of outer) {
    if (line[0] === 1) {
      data.push(line.subarray(1));
    } else {
      progress.push(asText(line.subarray(1)));
    }
  }

  return { lines: [...pktLines(concat(...data))].map(asText), progress };
};

function* pktLines(bytes: Uint8Array): Generator<Uint8Array> {
  let at = 0;

  while (at + 4 <= bytes.length) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);

    if (length === 0) {
      at += 4;
      continue;
    }

    yield bytes.subarray(at + 4, at + length);
    at += length;
  }
}
