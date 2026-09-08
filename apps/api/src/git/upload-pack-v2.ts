/** Protocol-v2 command parsing and framing over the shared upload-pack planner. */

import { concat } from "../bytes.ts";
import type { Head } from "../head.ts";
import type { AdvertisedRef } from "./advertisement.ts";
import {
  delimiterPkt,
  flushPkt,
  pktLine,
  pktLineStream,
  PktLineError,
  PktLineReader,
} from "./pkt-line.ts";
import { isObjectId } from "../object.ts";
import {
  MAX_UPLOAD_PACK_LINES,
  UploadPackError,
  type UploadPackObjectSource,
  uploadPackResultStream,
} from "./upload-pack.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface CommandRequest {
  readonly command: string;
  readonly arguments: readonly string[];
}

const lineText = (payload: Uint8Array): string => decoder.decode(payload).replace(/\n$/, "");

const readCommand = async (body: ReadableStream<Uint8Array>): Promise<CommandRequest> => {
  const lines = new PktLineReader(body);
  let command: string | undefined;

  try {
    for (;;) {
      const line = await lines.nextV2();
      if (line.kind === "delimiter") {
        break;
      }
      if (line.kind !== "line") {
        throw new UploadPackError(
          "A protocol-v2 command must end its capabilities with a delimiter.",
        );
      }

      const text = lineText(line.payload);
      if (command === undefined && text.startsWith("command=")) {
        command = text.slice("command=".length);
        continue;
      }
      if (text.startsWith("agent=") || text === "object-format=sha1") {
        continue;
      }
      throw new UploadPackError(`The protocol-v2 capability "${text}" is not supported.`);
    }

    if (command === undefined || command === "") {
      throw new UploadPackError("A protocol-v2 request must name a command.");
    }

    const arguments_: string[] = [];
    for (;;) {
      const line = await lines.nextV2();
      if (line.kind === "flush") {
        return { command, arguments: arguments_ };
      }
      if (line.kind !== "line") {
        throw new UploadPackError(`The protocol-v2 ${command} request ended early.`);
      }
      if (arguments_.length >= MAX_UPLOAD_PACK_LINES) {
        throw new UploadPackError(
          `A protocol-v2 request may carry at most ${MAX_UPLOAD_PACK_LINES} arguments.`,
        );
      }
      arguments_.push(lineText(line.payload));
    }
  } catch (error) {
    await lines.cancel();
    if (error instanceof PktLineError) {
      throw new UploadPackError(error.message);
    }
    throw error;
  }
};

interface LsRefsRequest {
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
  readonly prefixes: readonly string[];
}

const parseLsRefs = (arguments_: readonly string[]): LsRefsRequest => {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];

  for (const argument of arguments_) {
    if (argument === "peel") peel = true;
    else if (argument === "symrefs") symrefs = true;
    else if (argument === "unborn") unborn = true;
    else if (argument.startsWith("ref-prefix "))
      prefixes.push(argument.slice("ref-prefix ".length));
    else throw new UploadPackError(`The ls-refs argument "${argument}" is not supported.`);
  }

  return { peel, symrefs, unborn, prefixes };
};

const selected = (name: string, prefixes: readonly string[]): boolean =>
  prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

const lsRefsResult = (
  refs: readonly AdvertisedRef[],
  head: Head | null,
  request: LsRefsRequest,
): ReadableStream<Uint8Array> => {
  const peeled = new Map(
    refs
      .filter((ref) => ref.name.endsWith("^{}"))
      .map((ref) => [ref.name.slice(0, -3), ref.oid] as const),
  );
  const direct = refs.filter((ref) => !ref.name.endsWith("^{}"));
  const byName = new Map(direct.map((ref) => [ref.name, ref.oid]));

  function* result(): Generator<Uint8Array> {
    if (head !== null && selected("HEAD", request.prefixes)) {
      if (head.kind === "detached") {
        yield pktLine(`${head.oid} HEAD\n`);
      } else {
        const oid = byName.get(head.ref);
        const symref = ` symref-target:${head.ref}`;
        if (oid !== undefined) {
          yield pktLine(`${oid} HEAD${request.symrefs ? symref : ""}\n`);
        } else if (request.unborn) {
          yield pktLine(`unborn HEAD${symref}\n`);
        }
      }
    }

    for (const ref of direct) {
      if (!selected(ref.name, request.prefixes)) continue;
      const peeledOid = request.peel ? peeled.get(ref.name) : undefined;
      yield pktLine(
        `${ref.oid} ${ref.name}${peeledOid === undefined ? "" : ` peeled:${peeledOid}`}\n`,
      );
    }
    yield flushPkt();
  }

  return pktLineStream(result());
};

interface FetchRequest {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  readonly shallow: readonly string[];
  readonly depth: number | undefined;
  readonly done: boolean;
  readonly thinPack: boolean;
  readonly ofsDelta: boolean;
}

const parseFetch = (arguments_: readonly string[]): FetchRequest => {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  let thinPack = false;
  let ofsDelta = false;

  // Validated here rather than left to the v1 planner: these values are spliced
  // into pkt-lines, and a payload longer than a pkt-line allows would throw
  // rather than be refused.
  const oidArgument = (argument: string, keyword: string): string => {
    const oid = argument.slice(keyword.length);
    if (!isObjectId(oid)) {
      throw new UploadPackError(`"${oid}" is not an object id.`);
    }
    return oid;
  };

  for (const argument of arguments_) {
    if (argument.startsWith("want ")) wants.push(oidArgument(argument, "want "));
    else if (argument.startsWith("have ")) haves.push(oidArgument(argument, "have "));
    else if (argument.startsWith("shallow ")) shallow.push(oidArgument(argument, "shallow "));
    else if (argument.startsWith("deepen ")) {
      const parsed = Number(argument.slice("deepen ".length));
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || depth !== undefined) {
        throw new UploadPackError(`"${argument}" is not a valid depth request.`);
      }
      depth = parsed;
    } else if (argument === "done") done = true;
    else if (argument === "thin-pack") thinPack = true;
    else if (argument === "ofs-delta") ofsDelta = true;
    else if (argument === "no-progress" || argument === "include-tag") continue;
    else throw new UploadPackError(`The fetch argument "${argument}" is not supported.`);
  }

  return { wants, haves, shallow, depth, done, thinPack, ofsDelta };
};

const v1Request = (request: FetchRequest): Uint8Array => {
  const capabilities = [
    "multi_ack_detailed",
    "side-band-64k",
    ...(request.thinPack ? ["thin-pack"] : []),
    ...(request.ofsDelta ? ["ofs-delta"] : []),
  ];
  return concat(
    ...request.wants.map((oid, index) =>
      pktLine(`want ${oid}${index === 0 ? ` ${capabilities.join(" ")}` : ""}\n`),
    ),
    ...request.shallow.map((oid) => pktLine(`shallow ${oid}\n`)),
    ...(request.depth === undefined ? [] : [pktLine(`deepen ${request.depth}\n`)]),
    flushPkt(),
    ...request.haves.map((oid) => pktLine(`have ${oid}\n`)),
    ...(request.done ? [pktLine("done\n")] : [flushPkt()]),
  );
};

async function* fetchResult(
  request: FetchRequest,
  source: UploadPackObjectSource,
  advertisedOids: ReadonlySet<string>,
  repositoryShallow: ReadonlySet<string>,
): AsyncGenerator<Uint8Array> {
  const legacyRequest = v1Request(request);
  const legacy = uploadPackResultStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(legacyRequest);
        controller.close();
      },
    }),
    source,
    advertisedOids,
    repositoryShallow,
  );
  const lines = new PktLineReader(legacy);

  try {
    const shallowUpdates: Uint8Array[] =
      request.depth === undefined
        ? [...repositoryShallow].sort().map((oid) => encoder.encode(`shallow ${oid}\n`))
        : [];
    if (request.depth !== undefined) {
      for (;;) {
        const update = await lines.next();
        if (update.kind === "flush") break;
        if (update.kind !== "line") {
          throw new UploadPackError(
            "The shared upload-pack planner ended its shallow response early.",
          );
        }
        if (lineText(update.payload).startsWith("ERR ")) {
          yield pktLine(update.payload);
          return;
        }
        shallowUpdates.push(update.payload);
      }
    }

    if (!request.done) {
      yield pktLine("acknowledgments\n");
      const acknowledgements: Uint8Array[] = [];
      for (;;) {
        const line = await lines.next();
        if (line.kind === "end") break;
        if (line.kind !== "line") continue;
        const text = lineText(line.payload);
        // A refusal has to reach the client now, not after it has spent its
        // whole history on haves and finally sent `done`.
        if (text.startsWith("ERR ")) {
          yield pktLine(line.payload);
          return;
        }
        const match = /^ACK ([0-9a-f]{40})(?: common)?$/.exec(text);
        if (match !== null) acknowledgements.push(pktLine(`ACK ${match[1]}\n`));
      }
      if (acknowledgements.length === 0) yield pktLine("NAK\n");
      else yield* acknowledgements;
      yield flushPkt();
      return;
    }

    if (shallowUpdates.length > 0) {
      yield pktLine("shallow-info\n");
      for (const update of shallowUpdates) yield pktLine(update);
      yield delimiterPkt();
    }

    // V0/v1 prefixes a final pack with an ACK/NAK. V2 omits that section when
    // the client sent `done`, so consume it and stream the identical pack.
    const acknowledgement = await lines.next();
    if (acknowledgement.kind !== "line") {
      throw new UploadPackError("The shared upload-pack planner did not start a pack response.");
    }
    if (lineText(acknowledgement.payload).startsWith("ERR ")) {
      yield pktLine(acknowledgement.payload);
      return;
    }
    yield pktLine("packfile\n");

    const rest = lines.rest().getReader();
    for (;;) {
      const { done, value } = await rest.read();
      if (done || value === undefined) return;
      yield value;
    }
  } catch (error) {
    await lines.cancel();
    throw error;
  }
}

const streamFrom = (iterator: AsyncIterator<Uint8Array>): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });

export const uploadPackV2ResultStream = (
  body: ReadableStream<Uint8Array>,
  refs: readonly AdvertisedRef[],
  head: Head | null,
  source: UploadPackObjectSource,
  advertisedOids: ReadonlySet<string>,
  shallow: ReadonlySet<string>,
): ReadableStream<Uint8Array> =>
  streamFrom(
    (async function* () {
      const request = await readCommand(body);
      if (request.command === "ls-refs") {
        const reader = lsRefsResult(refs, head, parseLsRefs(request.arguments)).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || value === undefined) return;
          yield value;
        }
      }
      if (request.command === "fetch") {
        yield* fetchResult(parseFetch(request.arguments), source, advertisedOids, shallow);
        return;
      }
      throw new UploadPackError(`The protocol-v2 command "${request.command}" is not supported.`);
    })(),
  );
