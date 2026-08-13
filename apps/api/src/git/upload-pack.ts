/** Protocol v0/v1 upload-pack negotiation and streaming pack generation. */

import { linksToFetch } from "../connectivity.ts";
import type { PackBase, PackDelta } from "../pack.ts";
import { isObjectId, type ObjectType } from "../object.ts";
import { Sha1, fromHex } from "../sha1.ts";
import {
  PKT_LINE_MAX_PAYLOAD_BYTES,
  PktLineError,
  PktLineReader,
  flushPkt,
  pktLine,
} from "./pkt-line.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const WANT_PATTERN = /^want ([0-9a-f]{40})(?: (.*))?\n?$/;
const HAVE_PATTERN = /^have ([0-9a-f]{40})\n?$/;

const MULTI_ACK_DETAILED = "multi_ack_detailed";
const SIDE_BAND_64K = "side-band-64k";
const THIN_PACK = "thin-pack";
const DATA_BAND = 1;

export class UploadPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadPackError";
  }
}

interface UploadPackRequest {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  readonly capabilities: readonly string[];
  readonly done: boolean;
}

export interface UploadPackObjectSource {
  readonly has: (oid: string) => Promise<boolean>;
  readonly read: (oid: string) => Promise<PackBase | null>;
  readonly readDelta: (oid: string) => Promise<PackDelta | null>;
}

const readRequest = async (body: ReadableStream<Uint8Array>): Promise<UploadPackRequest> => {
  const lines = new PktLineReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let capabilities: readonly string[] = [];
  let inHaves = false;

  try {
    for (;;) {
      const line = await lines.next();

      if (line.kind === "end") {
        return { wants, haves, capabilities, done: false };
      }
      if (line.kind === "flush") {
        if (!inHaves) {
          inHaves = true;
          continue;
        }
        return { wants, haves, capabilities, done: false };
      }

      const text = decoder.decode(line.payload);
      if (!inHaves) {
        const match = WANT_PATTERN.exec(text);
        if (match === null) {
          throw new UploadPackError(`"${text.trim()}" is not a want line.`);
        }

        wants.push(match[1]!);
        if (wants.length === 1) {
          capabilities = (match[2] ?? "").split(" ").filter((value) => value !== "");
        }
        continue;
      }

      if (text === "done\n" || text === "done") {
        await lines.cancel();
        return { wants, haves, capabilities, done: true };
      }

      const match = HAVE_PATTERN.exec(text);
      if (match === null) {
        throw new UploadPackError(`"${text.trim()}" is not a have line.`);
      }
      haves.push(match[1]!);
    }
  } catch (error) {
    await lines.cancel();
    if (error instanceof PktLineError) {
      throw new UploadPackError(error.message);
    }
    throw error;
  }
};

interface ReachableObjects {
  readonly objects: readonly string[];
  readonly held: ReadonlySet<string>;
}

const reachable = async (
  roots: readonly string[],
  source: UploadPackObjectSource,
  missingIsError: boolean,
  stopAt: ReadonlySet<string> = new Set(),
): Promise<ReachableObjects> => {
  const pending: { readonly oid: string; readonly type: ObjectType | null }[] = roots.map(
    (oid) => ({
      oid,
      type: null,
    }),
  );
  const held = new Set<string>();
  const objects: string[] = [];

  while (pending.length > 0) {
    const { oid, type } = pending.pop()!;
    if (held.has(oid) || stopAt.has(oid)) {
      continue;
    }

    if (type === "blob") {
      if (!(await source.has(oid))) {
        if (missingIsError) {
          throw new UploadPackError(`The wanted object ${oid} does not exist.`);
        }
        continue;
      }

      held.add(oid);
      objects.push(oid);
      continue;
    }

    const object = await source.read(oid);
    if (object === null) {
      if (missingIsError) {
        throw new UploadPackError(`The wanted object ${oid} does not exist.`);
      }
      continue;
    }

    held.add(oid);
    objects.push(oid);
    for (const link of linksToFetch(object.type, object.bytes)) {
      pending.push(link);
    }
  }

  return { objects, held };
};

const uint32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

const packHeader = (count: number): Uint8Array => {
  const bytes = new Uint8Array(12);
  bytes.set(encoder.encode("PACK"));
  new DataView(bytes.buffer).setUint32(4, 2);
  new DataView(bytes.buffer).setUint32(8, count);
  return bytes;
};

const PACK_KINDS = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
} satisfies Record<ObjectType, number>;

const REF_DELTA = 7;

const entryHeader = (kind: number, size: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = size;
  let byte = (kind << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);

  while (remaining > 0) {
    bytes.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }

  bytes.push(byte);
  return Uint8Array.from(bytes);
};

const ADLER_MODULUS = 65_521;

const adler32 = (bytes: Uint8Array): number => {
  let low = 1;
  let high = 0;

  for (let at = 0; at < bytes.length; at += 5_552) {
    const end = Math.min(at + 5_552, bytes.length);
    for (let index = at; index < end; index += 1) {
      low += bytes[index]!;
      high += low;
    }
    low %= ADLER_MODULUS;
    high %= ADLER_MODULUS;
  }

  return ((high << 16) | low) >>> 0;
};

// Leaves room for a stored-block header when the bytes are side-band framed.
const DEFLATE_BLOCK_BYTES = PKT_LINE_MAX_PAYLOAD_BYTES - 6;

function* storedDeflate(bytes: Uint8Array): Generator<Uint8Array> {
  yield Uint8Array.of(0x78, 0x01);

  if (bytes.length === 0) {
    yield Uint8Array.of(0x01, 0x00, 0x00, 0xff, 0xff);
  }

  for (let at = 0; at < bytes.length; at += DEFLATE_BLOCK_BYTES) {
    const chunk = bytes.slice(at, at + DEFLATE_BLOCK_BYTES);
    const final = at + chunk.length === bytes.length;
    const header = new Uint8Array(5);
    const view = new DataView(header.buffer);
    header[0] = final ? 1 : 0;
    view.setUint16(1, chunk.length, true);
    view.setUint16(3, ~chunk.length & 0xffff, true);
    yield header;
    yield chunk;
  }

  yield uint32(adler32(bytes));
}

async function* packBytes(
  oids: readonly string[],
  clientObjects: ReadonlySet<string>,
  thin: boolean,
  source: UploadPackObjectSource,
): AsyncGenerator<Uint8Array> {
  const hash = new Sha1();
  const emit = function* (bytes: Uint8Array): Generator<Uint8Array> {
    hash.update(bytes);
    yield bytes;
  };

  yield* emit(packHeader(oids.length));

  for (const oid of oids) {
    const object = await source.read(oid);
    if (object === null) {
      throw new UploadPackError(`Object ${oid} vanished while its pack was being written.`);
    }

    const storedDelta = thin ? await source.readDelta(oid) : null;
    const delta =
      storedDelta !== null && clientObjects.has(storedDelta.baseOid) ? storedDelta : null;
    const header =
      delta === null
        ? entryHeader(PACK_KINDS[object.type], object.bytes.length)
        : entryHeader(REF_DELTA, delta.bytes.length);

    yield* emit(header);
    if (delta !== null) {
      yield* emit(fromHex(delta.baseOid));
    }

    for (const chunk of storedDeflate(delta?.bytes ?? object.bytes)) {
      yield* emit(chunk);
    }
  }

  yield hash.digest();
}

const streamFrom = (iterator: AsyncIterator<Uint8Array>): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });

async function* sideband(
  prefix: Uint8Array,
  pack: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield prefix;

  for await (const chunk of pack) {
    for (let at = 0; at < chunk.length; at += PKT_LINE_MAX_PAYLOAD_BYTES - 1) {
      const payload = chunk.subarray(at, at + PKT_LINE_MAX_PAYLOAD_BYTES - 1);
      const banded = new Uint8Array(payload.length + 1);
      banded[0] = DATA_BAND;
      banded.set(payload, 1);
      yield pktLine(banded);
    }
  }

  yield flushPkt();
}

async function* uploadPackResult(
  body: ReadableStream<Uint8Array>,
  source: UploadPackObjectSource,
  advertisedOids: ReadonlySet<string>,
): AsyncGenerator<Uint8Array> {
  const request = await readRequest(body);
  if (request.wants.length === 0) {
    throw new UploadPackError("An upload-pack request must want at least one object.");
  }
  for (const oid of [...request.wants, ...request.haves]) {
    if (!isObjectId(oid)) {
      throw new UploadPackError(`"${oid}" is not an object id.`);
    }
  }

  const unadvertised = request.wants.find((oid) => !advertisedOids.has(oid));
  if (unadvertised !== undefined) {
    yield pktLine(`ERR upload-pack: not our ref ${unadvertised}\n`);
    return;
  }

  const client = await reachable(request.haves, source, false);
  const acknowledgements = request.haves.filter((oid) => client.held.has(oid));
  const acknowledgement = acknowledgements.at(-1);

  if (!request.done) {
    if (request.capabilities.includes(MULTI_ACK_DETAILED)) {
      for (const oid of acknowledgements) {
        yield pktLine(`ACK ${oid} common\n`);
      }
      yield pktLine("NAK\n");
      return;
    }

    yield pktLine(acknowledgement === undefined ? "NAK\n" : `ACK ${acknowledgement}\n`);
    return;
  }

  const wanted = await reachable(request.wants, source, true, client.held);
  const missing = wanted.objects.filter((oid) => !client.held.has(oid));
  const prefix = pktLine(acknowledgement === undefined ? "NAK\n" : `ACK ${acknowledgement}\n`);
  const pack = packBytes(missing, client.held, request.capabilities.includes(THIN_PACK), source);

  if (request.capabilities.includes(SIDE_BAND_64K)) {
    yield* sideband(prefix, pack);
    return;
  }

  yield prefix;
  yield* pack;
}

/** The body is parsed only when the response is pulled, so neither side buffers it. */
export const uploadPackResultStream = (
  body: ReadableStream<Uint8Array>,
  source: UploadPackObjectSource,
  advertisedOids: ReadonlySet<string>,
): ReadableStream<Uint8Array> => streamFrom(uploadPackResult(body, source, advertisedOids));
