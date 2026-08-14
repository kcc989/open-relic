/** Protocol v0/v1 upload-pack negotiation and streaming pack generation. */

import { createDeflate } from "node:zlib";

import { commitParents, linksToFetch } from "../connectivity.ts";
import {
  RepositoryStorageExhaustedError,
  type CachedPackEntry,
  type CachedPackEntryRequest,
  type IndexedObject,
  type PackRepresentationMetadata,
} from "../object-store.ts";
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

interface UploadPackTimings {
  startedAt: number;
  requestMs: number;
  negotiationMs: number;
  packPlanningMs: number;
  storageReadMs: number;
  deflateMs: number;
  hashMs: number;
  firstByteMs: number | null;
  responseBytes: number;
  objects: number;
}

const createUploadPackTimings = (): UploadPackTimings => ({
  startedAt: performance.now(),
  requestMs: 0,
  negotiationMs: 0,
  packPlanningMs: 0,
  storageReadMs: 0,
  deflateMs: 0,
  hashMs: 0,
  firstByteMs: null,
  responseBytes: 0,
  objects: 0,
});

const rounded = (value: number): number => Number(value.toFixed(2));

const logUploadPackTimings = (timings: UploadPackTimings): void => {
  console.log(
    `Git upload-pack timings ${JSON.stringify({
      totalMs: rounded(performance.now() - timings.startedAt),
      requestMs: rounded(timings.requestMs),
      negotiationMs: rounded(timings.negotiationMs),
      packPlanningMs: rounded(timings.packPlanningMs),
      storageReadMs: rounded(timings.storageReadMs),
      deflateMs: rounded(timings.deflateMs),
      hashMs: rounded(timings.hashMs),
      firstByteMs: timings.firstByteMs === null ? null : rounded(timings.firstByteMs),
      responseBytes: timings.responseBytes,
      objects: timings.objects,
    })}`,
  );
};

const timedStorageRead = async <T>(
  timings: UploadPackTimings,
  read: () => Promise<T>,
): Promise<T> => {
  const started = performance.now();
  try {
    return await read();
  } finally {
    timings.storageReadMs += performance.now() - started;
  }
};

const readOptionalCache = async <T>(
  read: (() => Promise<T | null>) | undefined,
): Promise<T | null> => {
  if (read === undefined) {
    return null;
  }
  try {
    return await read();
  } catch (error) {
    if (error instanceof RepositoryStorageExhaustedError) {
      return null;
    }
    throw error;
  }
};

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
  readonly readDeltaBases?: (oids: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  readonly readFullPackEntry?: (oid: string) => Promise<{
    readonly type: ObjectType;
    readonly size: number;
    readonly compressed: Uint8Array;
  } | null>;
  readonly readDeltaPackEntry?: (oid: string) => Promise<{
    readonly baseOid: string;
    readonly size: number;
    readonly compressed: Uint8Array;
  } | null>;
  readonly readIndexedObjects?: (
    oids: readonly string[],
  ) => Promise<ReadonlyMap<string, IndexedObject>>;
  readonly readPackMetadata?: (
    oids: readonly string[],
  ) => Promise<ReadonlyMap<string, PackRepresentationMetadata>>;
  readonly readCachedPackEntry?: (
    metadata: PackRepresentationMetadata,
    preferredBaseOid: string | null,
  ) => CachedPackEntry | null;
  readonly readCachedPackEntries?: (
    requests: readonly CachedPackEntryRequest[],
  ) => Promise<ReadonlyMap<string, CachedPackEntry>>;
  readonly readReachableObjects?: (
    roots: ReadonlySet<string>,
    candidates: ReadonlySet<string>,
    shallow: ReadonlySet<string>,
  ) => Promise<ReadonlySet<string>>;
  readonly readObjectClosure?: (
    roots: ReadonlySet<string>,
    stopAt: ReadonlySet<string>,
    shallow: ReadonlySet<string>,
  ) => Promise<readonly string[] | null>;
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
  if (source.readObjectClosure !== undefined) {
    const indexed = await source.readObjectClosure(new Set(roots), stopAt, shallow);
    if (indexed !== null) {
      return { objects: indexed, held: new Set(indexed) };
    }
  }

  const pending: { readonly oid: string; readonly type: ObjectType | null }[] = roots.map(
    (oid) => ({
      oid,
      type: null,
    }),
  );
  const held = new Set<string>();
  const objects: string[] = [];

  while (pending.length > 0) {
    const frontier = pending.splice(Math.max(0, pending.length - 100)).reverse();
    const frontierOids = new Set<string>();
    const candidates = frontier.filter(({ oid }) => {
      if (held.has(oid) || stopAt.has(oid) || frontierOids.has(oid)) {
        return false;
      }
      frontierOids.add(oid);
      return true;
    });
    const indexed =
      source.readIndexedObjects === undefined
        ? new Map<string, IndexedObject>()
        : await source.readIndexedObjects(candidates.map(({ oid }) => oid));

    for (const { oid, type } of candidates) {
      const indexedObject = indexed.get(oid);

      if (type === "blob") {
        if (indexedObject === undefined && !(await source.has(oid))) {
          if (missingIsError) {
            throw new UploadPackError(`The wanted object ${oid} does not exist.`);
          }
          continue;
        }

        held.add(oid);
        objects.push(oid);
        continue;
      }

      if (indexedObject !== undefined) {
        held.add(oid);
        objects.push(oid);
        const links =
          shallow.has(oid) && indexedObject.type === "commit"
            ? indexedObject.links.filter((link) => link.type !== "commit")
            : indexedObject.links;
        pending.push(...links);
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
  }

  return { objects, held };
};

/** Validate negotiation boundaries without walking the closure behind every `have`. */
const heldObjects = async (
  oids: readonly string[],
  source: UploadPackObjectSource,
): Promise<ReadonlySet<string>> => {
  const unique = [...new Set(oids)];
  if (unique.length === 0) {
    return new Set();
  }
  const indexed =
    source.readIndexedObjects === undefined
      ? new Map<string, IndexedObject>()
      : await source.readIndexedObjects(unique);
  const held = new Set<string>();

  for (const oid of unique) {
    if (indexed.has(oid) || (await source.has(oid))) {
      held.add(oid);
    }
  }
  return held;
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
const PACK_REPRESENTATION_READ_BYTES = 8 * 1024 * 1024;
const PACK_REPRESENTATION_READ_KEYS = 96;
const PACK_REPRESENTATION_READ_AHEAD = 4;

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
  readonly metadata: ReadonlyMap<string, PackRepresentationMetadata>;
}

interface PackReadWindow {
  readonly start: number;
  readonly end: number;
  readonly requests: readonly CachedPackEntryRequest[];
}

/**
 * Put every in-pack delta base before the object that depends on it. Planning
 * retains only object ids: resolved objects and delta bodies remain in storage
 * until the writer reaches their one entry.
 */
const orderPack = async (
  oids: readonly string[],
  source: UploadPackObjectSource,
  timings: UploadPackTimings,
): Promise<PackOrder> => {
  const included = new Set(oids);
  const deltaBases = new Map<string, string>();
  const dependents = new Map<string, string[]>();
  const dependentOids = new Set<string>();

  const metadata =
    source.readPackMetadata === undefined
      ? new Map<string, PackRepresentationMetadata>()
      : await timedStorageRead(timings, () => source.readPackMetadata!(oids));
  const storedBases =
    metadata.size > 0
      ? new Map(
          [...metadata].flatMap(([oid, entry]) =>
            entry.delta === null ? [] : ([[oid, entry.delta.baseOid]] as const),
          ),
        )
      : source.readDeltaBases === undefined
        ? new Map(
            await Promise.all(
              oids.map(async (oid) => [oid, await source.readDeltaBase(oid)] as const),
            ).then((entries) =>
              entries.filter((entry): entry is readonly [string, string] => entry[1] !== null),
            ),
          )
        : await timedStorageRead(timings, () => source.readDeltaBases!(oids));

  for (const oid of oids) {
    const baseOid = storedBases.get(oid) ?? null;
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

  return { oids: ordered, deltaBases, metadata };
};

/** Plan bounded reads once so window N+1 can overlap emission of window N. */
const packReadWindows = (
  order: PackOrder,
  thin: boolean,
  availableClientObjects: ReadonlySet<string>,
): readonly PackReadWindow[] => {
  const windows: PackReadWindow[] = [];
  const available = new Set<string>();
  let start = 0;

  while (start < order.oids.length) {
    const requests: CachedPackEntryRequest[] = [];
    let compressedBytes = 0;
    let keys = 0;
    let end = start;

    for (; end < order.oids.length; end += 1) {
      const oid = order.oids[end]!;
      const baseOid = order.deltaBases.get(oid);
      const baseIsAvailable =
        baseOid !== undefined &&
        (available.has(baseOid) || (thin && availableClientObjects.has(baseOid)));
      const metadata = order.metadata.get(oid);
      const representation =
        baseIsAvailable && metadata?.delta?.compressed !== null
          ? metadata?.delta?.compressed
          : metadata?.full;

      if (
        representation !== undefined &&
        representation !== null &&
        requests.length > 0 &&
        (compressedBytes + representation.size > PACK_REPRESENTATION_READ_BYTES ||
          keys + representation.chunkCount > PACK_REPRESENTATION_READ_KEYS)
      ) {
        break;
      }

      if (metadata !== undefined && representation !== undefined && representation !== null) {
        requests.push({
          metadata,
          preferredBaseOid: baseIsAvailable ? baseOid : null,
        });
        compressedBytes += representation.size;
        keys += representation.chunkCount;
      }
      available.add(oid);
    }

    const boundedEnd = Math.max(end, start + 1);
    windows.push({ start, end: boundedEnd, requests });
    start = boundedEnd;
  }

  return windows;
};

async function* packBytes(
  oids: readonly string[],
  clientObjects: ReadonlySet<string>,
  thin: boolean,
  source: UploadPackObjectSource,
  clientShallow: ReadonlySet<string>,
  timings: UploadPackTimings,
): AsyncGenerator<Uint8Array> {
  const hash = new Sha1();
  const emit = function* (bytes: Uint8Array): Generator<Uint8Array> {
    const started = performance.now();
    hash.update(bytes);
    timings.hashMs += performance.now() - started;
    timings.responseBytes += bytes.length;
    yield bytes;
  };

  const planningStarted = performance.now();
  const order = await orderPack(oids, source, timings);
  const included = new Set(order.oids);
  const candidateClientBases = new Set(
    [...order.deltaBases.values()].filter((oid) => !included.has(oid) && !clientObjects.has(oid)),
  );
  const reachableClientBases =
    thin && source.readReachableObjects !== undefined
      ? await timedStorageRead(timings, () =>
          source.readReachableObjects!(clientObjects, candidateClientBases, clientShallow),
        )
      : new Set<string>();
  timings.packPlanningMs += performance.now() - planningStarted;
  timings.objects = order.oids.length;
  const availableClientObjects = new Set([...clientObjects, ...reachableClientBases]);
  const emitted = new Set<string>();
  let prefetched = new Map<string, CachedPackEntry>();
  const readWindows =
    source.readCachedPackEntries === undefined
      ? []
      : packReadWindows(order, thin, availableClientObjects);
  let readWindowAt = 0;
  let nextReadWindow = 0;
  const readWindow = (window: PackReadWindow): Promise<ReadonlyMap<string, CachedPackEntry>> =>
    window.requests.length === 0
      ? Promise.resolve(new Map())
      : timedStorageRead(timings, () => source.readCachedPackEntries!(window.requests));
  const prefetchedWindows = new Map<number, Promise<ReadonlyMap<string, CachedPackEntry>>>();
  const fillReadAhead = (): void => {
    while (
      nextReadWindow < readWindows.length &&
      nextReadWindow < readWindowAt + PACK_REPRESENTATION_READ_AHEAD
    ) {
      prefetchedWindows.set(nextReadWindow, readWindow(readWindows[nextReadWindow]!));
      nextReadWindow += 1;
    }
  };
  fillReadAhead();

  yield* emit(packHeader(order.oids.length));

  for (let index = 0; index < order.oids.length; index += 1) {
    const currentWindow = readWindows[readWindowAt];
    if (currentWindow !== undefined && index === currentWindow.start) {
      prefetched = new Map(await prefetchedWindows.get(readWindowAt)!);
      prefetchedWindows.delete(readWindowAt);
      readWindowAt += 1;
      fillReadAhead();
    }

    const oid = order.oids[index]!;
    const plannedBase = order.deltaBases.get(oid);
    const baseIsAvailable =
      plannedBase !== undefined &&
      (emitted.has(plannedBase) || (thin && availableClientObjects.has(plannedBase)));
    const plannedMetadata = order.metadata.get(oid);
    const plannedEntry =
      prefetched.get(oid) ??
      (source.readCachedPackEntry === undefined || plannedMetadata === undefined
        ? null
        : source.readCachedPackEntry(plannedMetadata, baseIsAvailable ? plannedBase : null));
    const cachedDelta =
      plannedEntry === null && baseIsAvailable
        ? await readOptionalCache(
            source.readDeltaPackEntry === undefined
              ? undefined
              : () => source.readDeltaPackEntry!(oid),
          )
        : null;
    const storedDelta =
      plannedEntry === null && baseIsAvailable && cachedDelta === null
        ? await timedStorageRead(timings, () => source.readDelta(oid))
        : null;
    const delta =
      cachedDelta !== null && cachedDelta.baseOid === plannedBase
        ? cachedDelta
        : storedDelta !== null && storedDelta.baseOid === plannedBase
          ? {
              baseOid: storedDelta.baseOid,
              size: storedDelta.bytes.length,
              compressed: null,
              bytes: storedDelta.bytes,
            }
          : null;
    let header: Uint8Array;
    let bytes: Uint8Array | null;
    let compressed: Uint8Array | null;

    if (plannedEntry?.kind === "delta") {
      header = entryHeader(REF_DELTA, plannedEntry.size);
      bytes = null;
      compressed = plannedEntry.compressed;
    } else if (plannedEntry?.kind === "full") {
      header = entryHeader(PACK_KINDS[plannedEntry.type], plannedEntry.size);
      bytes = null;
      compressed = plannedEntry.compressed;
    } else if (delta === null) {
      const cached = await readOptionalCache(
        source.readFullPackEntry === undefined ? undefined : () => source.readFullPackEntry!(oid),
      );
      if (cached !== null) {
        header = entryHeader(PACK_KINDS[cached.type], cached.size);
        bytes = null;
        compressed = cached.compressed;
      } else {
        const object = await timedStorageRead(timings, () => source.read(oid));
        if (object === null) {
          throw new UploadPackError(`Object ${oid} vanished while its pack was being written.`);
        }
        header = entryHeader(PACK_KINDS[object.type], object.bytes.length);
        bytes = object.bytes;
        compressed = null;
      }
    } else {
      header = entryHeader(REF_DELTA, delta.size);
      bytes = "bytes" in delta ? delta.bytes : null;
      compressed = delta.compressed;
    }

    yield* emit(header);
    const deltaBaseOid = plannedEntry?.kind === "delta" ? plannedEntry.baseOid : delta?.baseOid;
    if (deltaBaseOid !== undefined) {
      yield* emit(fromHex(deltaBaseOid));
    }

    if (compressed !== null) {
      yield* emit(compressed);
    } else {
      const deflateStarted = performance.now();
      for await (const chunk of deflate(bytes!)) {
        yield* emit(chunk);
      }
      timings.deflateMs += performance.now() - deflateStarted;
    }

    emitted.add(oid);
  }

  const digestStarted = performance.now();
  const digest = hash.digest();
  timings.hashMs += performance.now() - digestStarted;
  timings.responseBytes += digest.length;
  yield digest;
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

  const payloadBytes = PKT_LINE_MAX_PAYLOAD_BYTES - 1;
  const pending = new Uint8Array(payloadBytes);
  let pendingBytes = 0;
  for await (const chunk of pack) {
    let at = 0;
    while (at < chunk.length) {
      const copied = Math.min(payloadBytes - pendingBytes, chunk.length - at);
      pending.set(chunk.subarray(at, at + copied), pendingBytes);
      pendingBytes += copied;
      at += copied;

      if (pendingBytes === payloadBytes) {
        const banded = new Uint8Array(PKT_LINE_MAX_PAYLOAD_BYTES);
        banded[0] = DATA_BAND;
        banded.set(pending, 1);
        yield pktLine(banded);
        pendingBytes = 0;
      }
    }
  }

  if (pendingBytes > 0) {
    const banded = new Uint8Array(pendingBytes + 1);
    banded[0] = DATA_BAND;
    banded.set(pending.subarray(0, pendingBytes), 1);
    yield pktLine(banded);
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
  timings: UploadPackTimings,
): AsyncGenerator<Uint8Array> {
  const requestStarted = performance.now();
  const request = await readRequest(body);
  timings.requestMs += performance.now() - requestStarted;
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

  const negotiationStarted = performance.now();
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
  const commonHaves = await heldObjects(request.haves, source);
  // Deepening through an old graft needs the client's full closure for the final
  // subtraction. Normal fetches stop at common `have` commits and never need to
  // enumerate the history and trees the client already owns.
  const client =
    depthPlan !== null && depthPlan.unshallow.size > 0
      ? await reachable(request.haves, source, false, new Set(), clientBoundaries)
      : { objects: [...commonHaves], held: commonHaves };
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
  timings.negotiationMs += performance.now() - negotiationStarted;
  const prefix = pktLine(acknowledgement === undefined ? "NAK\n" : `ACK ${acknowledgement}\n`);
  const pack = packBytes(
    missing,
    client.held,
    request.capabilities.includes(THIN_PACK),
    source,
    clientBoundaries,
    timings,
  );

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
): ReadableStream<Uint8Array> => {
  const timings = createUploadPackTimings();
  const traced = async function* (): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of uploadPackResult(body, source, advertisedOids, shallow, timings)) {
        timings.firstByteMs ??= performance.now() - timings.startedAt;
        yield chunk;
      }
    } finally {
      logUploadPackTimings(timings);
    }
  };
  return streamFrom(traced());
};
