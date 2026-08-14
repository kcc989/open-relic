/** Protocol v0/v1 upload-pack negotiation and streaming pack generation. */

import { createDeflate } from "node:zlib";

import { commitParents, linksToFetch } from "../connectivity.ts";
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
const SHALLOW_PATTERN = /^shallow ([0-9a-f]{40})\n?$/;
const DEEPEN_PATTERN = /^deepen ([0-9]+)\n?$/;

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
  readonly shallow: readonly string[];
  readonly depth: number | undefined;
  readonly haves: readonly string[];
  readonly capabilities: readonly string[];
  readonly done: boolean;
}

export interface UploadPackObjectSource {
  readonly has: (oid: string) => Promise<boolean>;
  readonly read: (oid: string) => Promise<PackBase | null>;
  readonly readDeltaBase: (oid: string) => Promise<string | null>;
  readonly readDelta: (oid: string) => Promise<PackDelta | null>;
}

const readRequest = async (body: ReadableStream<Uint8Array>): Promise<UploadPackRequest> => {
  const lines = new PktLineReader(body);
  const wants: string[] = [];
  const shallow: string[] = [];
  const haves: string[] = [];
  let capabilities: readonly string[] = [];
  let depth: number | undefined;
  let inHaves = false;
  let inShallow = false;

  try {
    for (;;) {
      const line = await lines.next();

      if (line.kind === "end") {
        return { wants, shallow, depth, haves, capabilities, done: false };
      }
      if (line.kind === "flush") {
        if (!inHaves) {
          inHaves = true;
          continue;
        }
        return { wants, shallow, depth, haves, capabilities, done: false };
      }

      const text = decoder.decode(line.payload);
      if (!inHaves) {
        const match = WANT_PATTERN.exec(text);
        if (match !== null && !inShallow) {
          wants.push(match[1]!);
          if (wants.length === 1) {
            capabilities = (match[2] ?? "").split(" ").filter((value) => value !== "");
          }
          continue;
        }

        inShallow = true;
        const shallowMatch = SHALLOW_PATTERN.exec(text);
        if (shallowMatch !== null && depth === undefined) {
          shallow.push(shallowMatch[1]!);
          continue;
        }

        const deepenMatch = DEEPEN_PATTERN.exec(text);
        if (deepenMatch !== null && depth === undefined) {
          const parsed = Number(deepenMatch[1]);
          if (!Number.isSafeInteger(parsed)) {
            throw new UploadPackError(`"${text.trim()}" is not a valid depth request.`);
          }
          depth = parsed === 0 ? undefined : parsed;
          continue;
        }

        throw new UploadPackError(`"${text.trim()}" is not a valid upload request line.`);
      }

      if (text === "done\n" || text === "done") {
        await lines.cancel();
        return { wants, shallow, depth, haves, capabilities, done: true };
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
  shallow: ReadonlySet<string> = new Set(),
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
    for (const link of linksToFetch(object.type, object.bytes, shallow.has(oid))) {
      pending.push(link);
    }
  }

  return { objects, held };
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

/** Compress one object without ever assembling its encoded form in memory. */
async function* deflate(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const compressor = createDeflate();
  compressor.end(bytes);

  for await (const chunk of compressor) {
    yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
}

interface PackOrder {
  readonly oids: readonly string[];
  readonly deltaBases: ReadonlyMap<string, string>;
}

/**
 * Put every in-pack delta base before the object that depends on it. Planning
 * retains only object ids: resolved objects and delta bodies remain in storage
 * until the writer reaches their one entry.
 */
const orderPack = async (
  oids: readonly string[],
  source: UploadPackObjectSource,
): Promise<PackOrder> => {
  const included = new Set(oids);
  const deltaBases = new Map<string, string>();
  const dependents = new Map<string, string[]>();
  const dependentOids = new Set<string>();

  for (const oid of oids) {
    const baseOid = await source.readDeltaBase(oid);
    if (baseOid === null) {
      continue;
    }

    deltaBases.set(oid, baseOid);
    if (!included.has(baseOid) || baseOid === oid) {
      continue;
    }

    dependentOids.add(oid);
    const existing = dependents.get(baseOid);
    if (existing === undefined) {
      dependents.set(baseOid, [oid]);
    } else {
      existing.push(oid);
    }
  }

  const ordered: string[] = [];
  const queued = new Set<string>();
  const ready = oids.filter((oid) => !dependentOids.has(oid));
  ready.forEach((oid) => queued.add(oid));

  for (let at = 0; at < ready.length; at += 1) {
    const oid = ready[at]!;
    ordered.push(oid);

    for (const dependent of dependents.get(oid) ?? []) {
      if (!queued.has(dependent)) {
        queued.add(dependent);
        ready.push(dependent);
      }
    }
  }

  // Cyclic persisted relationships cannot come from a valid pack, but falling
  // back to full objects is safer than failing a fetch over corrupted metadata.
  for (const oid of oids) {
    if (!queued.has(oid)) {
      ordered.push(oid);
    }
  }

  return { oids: ordered, deltaBases };
};

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

  const order = await orderPack(oids, source);
  const emitted = new Set<string>();

  yield* emit(packHeader(order.oids.length));

  for (const oid of order.oids) {
    const plannedBase = order.deltaBases.get(oid);
    const baseIsAvailable =
      plannedBase !== undefined &&
      (emitted.has(plannedBase) || (thin && clientObjects.has(plannedBase)));
    const storedDelta = baseIsAvailable ? await source.readDelta(oid) : null;
    const delta = storedDelta !== null && storedDelta.baseOid === plannedBase ? storedDelta : null;
    let header: Uint8Array;
    let bytes: Uint8Array;

    if (delta === null) {
      const object = await source.read(oid);
      if (object === null) {
        throw new UploadPackError(`Object ${oid} vanished while its pack was being written.`);
      }
      header = entryHeader(PACK_KINDS[object.type], object.bytes.length);
      bytes = object.bytes;
    } else {
      header = entryHeader(REF_DELTA, delta.bytes.length);
      bytes = delta.bytes;
    }

    yield* emit(header);
    if (delta !== null) {
      yield* emit(fromHex(delta.baseOid));
    }

    for await (const chunk of deflate(bytes)) {
      yield* emit(chunk);
    }

    emitted.add(oid);
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

interface DepthPlan {
  readonly shallow: ReadonlySet<string>;
  readonly unshallow: ReadonlySet<string>;
}

/** Find the commit grafts produced by an absolute `deepen` request. */
const planDepth = async (
  wants: readonly string[],
  clientShallow: readonly string[],
  depth: number,
  source: UploadPackObjectSource,
  repositoryShallow: ReadonlySet<string>,
): Promise<DepthPlan> => {
  const pending: Array<{ readonly oid: string; readonly depth: number }> = wants.map((oid) => ({
    oid,
    depth: 1,
  }));
  const commits = new Map<
    string,
    { readonly depth: number; readonly parents: readonly string[] }
  >();
  const visitedNonCommits = new Set<string>();

  for (let at = 0; at < pending.length; at += 1) {
    const next = pending[at]!;
    const knownCommit = commits.get(next.oid);
    if (knownCommit !== undefined && knownCommit.depth <= next.depth) {
      continue;
    }

    const object = await source.read(next.oid);
    if (object === null) {
      throw new UploadPackError(`The wanted object ${next.oid} does not exist.`);
    }

    if (object.type === "commit") {
      const parents = commitParents(object.bytes);
      commits.set(next.oid, { depth: next.depth, parents });
      if (!repositoryShallow.has(next.oid) && next.depth < depth) {
        for (const oid of parents) {
          pending.push({ oid, depth: next.depth + 1 });
        }
      }
      continue;
    }

    if (visitedNonCommits.has(next.oid)) {
      continue;
    }
    visitedNonCommits.add(next.oid);
    if (object.type === "tag") {
      for (const link of linksToFetch(object.type, object.bytes)) {
        pending.push({ oid: link.oid, depth: next.depth });
      }
    }
  }

  const shallow = new Set<string>();
  for (const [oid, commit] of commits) {
    if (repositoryShallow.has(oid) || (commit.depth >= depth && commit.parents.length > 0)) {
      shallow.add(oid);
    }
  }

  const unshallow = new Set(clientShallow.filter((oid) => commits.has(oid) && !shallow.has(oid)));
  return { shallow, unshallow };
};

async function* uploadPackResult(
  body: ReadableStream<Uint8Array>,
  source: UploadPackObjectSource,
  advertisedOids: ReadonlySet<string>,
  shallow: ReadonlySet<string>,
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

  const depthPlan =
    request.depth === undefined
      ? null
      : await planDepth(request.wants, request.shallow, request.depth, source, shallow);
  if (depthPlan !== null) {
    for (const oid of depthPlan.shallow) {
      yield pktLine(`shallow ${oid}\n`);
    }
    for (const oid of depthPlan.unshallow) {
      yield pktLine(`unshallow ${oid}\n`);
    }
    yield flushPkt();
    // Stateless Smart HTTP performs one depth-only exchange before normal
    // have/done negotiation. That response is exactly the shallow update;
    // an early NAK would be left unread and corrupt the next RPC round.
    if (!request.done && request.haves.length === 0) {
      return;
    }
  }

  const clientBoundaries = new Set([...shallow, ...request.shallow]);
  const client = await reachable(request.haves, source, false, new Set(), clientBoundaries);
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

  // Deepening has to walk through the client's otherwise-known tips to reach
  // the parents behind an old graft. The final filter still omits every object
  // the client already holds from the pack.
  const stopAt =
    depthPlan !== null && depthPlan.unshallow.size > 0 ? new Set<string>() : client.held;
  const wanted = await reachable(
    request.wants,
    source,
    true,
    stopAt,
    depthPlan?.shallow ?? shallow,
  );
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
  shallow: ReadonlySet<string> = new Set(),
): ReadableStream<Uint8Array> =>
  streamFrom(uploadPackResult(body, source, advertisedOids, shallow));
