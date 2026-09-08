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
import { Sha1, decodeHexInto, fromHex } from "../sha1.ts";
import {
  PKT_LINE_LENGTH_BYTES,
  PKT_LINE_MAX_BYTES,
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
const OID_BYTES = 20;
const PACK_REPRESENTATION_READ_BYTES = 8 * 1024 * 1024;
const PACK_REPRESENTATION_READ_KEYS = 96;
const PACK_REPRESENTATION_READ_AHEAD = 4;
export const PACK_PREFETCH_BYTES = 16 * 1024 * 1024;

/** A pack leaves in frames of one side-band packet, whether or not a band was negotiated. */
const PACK_FRAME_BYTES = PKT_LINE_MAX_BYTES;

/**
 * Pack bytes, written into wire-sized frames and hashed a frame at a time.
 *
 * A pack of tens of thousands of small entries would otherwise leave as two or
 * three tiny chunks per object, each crossing every generator and stream
 * between here and the response with a native hash call of its own. Entry
 * headers and base ids are encoded straight into the frame, so a small entry
 * costs a few byte writes and no allocation.
 *
 * With side-band-64k negotiated a frame is one data packet — length, band
 * byte, payload — assembled in place. Without it, a frame is bare pack bytes
 * of the same size.
 */
class PackFrameWriter {
  readonly #hash = new Sha1();
  readonly #timings: UploadPackTimings;
  readonly #prefixBytes: number;
  readonly #payloadBytes: number;
  readonly #ready: Uint8Array[] = [];
  #frame: Uint8Array;
  #filled = 0;
  #hashed = 0;
  #digested = false;

  constructor(banded: boolean, timings: UploadPackTimings) {
    this.#timings = timings;
    this.#prefixBytes = banded ? PKT_LINE_LENGTH_BYTES + 1 : 0;
    this.#payloadBytes = PACK_FRAME_BYTES - this.#prefixBytes;
    this.#frame = this.#allocate();
  }

  /**
   * Copies what fits into the current frame and reports how far into `bytes`
   * it got, so a caller can hand a completed frame on before copying more: an
   * object larger than a frame is never held twice over.
   */
  write(bytes: Uint8Array, from = 0): number {
    const count = Math.min(this.#payloadBytes - this.#filled, bytes.length - from);
    this.#frame.set(
      from === 0 && count === bytes.length ? bytes : bytes.subarray(from, from + count),
      this.#prefixBytes + this.#filled,
    );
    this.#advance(count);
    return from + count;
  }

  /** The type in the first byte's high nibble, then the size as a little-endian varint. */
  writeEntryHeader(kind: number, size: number): void {
    let remaining = Math.floor(size / 16);
    this.#writeByte((remaining > 0 ? 0x80 : 0) | (kind << 4) | (size & 0x0f));
    while (remaining > 0) {
      const next = Math.floor(remaining / 128);
      this.#writeByte((next > 0 ? 0x80 : 0) | (remaining & 0x7f));
      remaining = next;
    }
  }

  writeObjectId(oid: string): void {
    if (this.#payloadBytes - this.#filled >= OID_BYTES) {
      decodeHexInto(oid, this.#frame, this.#prefixBytes + this.#filled);
      this.#advance(OID_BYTES);
      return;
    }

    const bytes = fromHex(oid);
    for (let at = 0; at < bytes.length;) {
      at = this.write(bytes, at);
    }
  }

  /** The oldest completed frame, until none remain. */
  takeFrame(): Uint8Array | undefined {
    return this.#ready.shift();
  }

  /** Appends the pack's trailing checksum and completes whatever frame holds it. */
  finish(): void {
    this.#hashThrough(this.#filled);
    this.#digested = true;
    const digest = this.#hash.digest();
    for (let at = 0; at < digest.length;) {
      at = this.write(digest, at);
    }
    if (this.#filled > 0) {
      this.#ready.push(this.#framed());
    }
  }

  #writeByte(byte: number): void {
    this.#frame[this.#prefixBytes + this.#filled] = byte;
    this.#advance(1);
  }

  #advance(count: number): void {
    this.#filled += count;
    this.#timings.responseBytes += count;
    if (this.#filled === this.#payloadBytes) {
      this.#hashThrough(this.#filled);
      this.#ready.push(this.#framed());
      this.#frame = this.#allocate();
      this.#filled = 0;
      this.#hashed = 0;
    }
  }

  /** The current frame as it goes on the wire, its length written once it is known. */
  #framed(): Uint8Array {
    const length = this.#prefixBytes + this.#filled;
    if (this.#prefixBytes > 0) {
      const hex = length.toString(16).padStart(PKT_LINE_LENGTH_BYTES, "0");
      for (let at = 0; at < PKT_LINE_LENGTH_BYTES; at += 1) {
        this.#frame[at] = hex.charCodeAt(at);
      }
    }
    return length === this.#frame.length ? this.#frame : this.#frame.subarray(0, length);
  }

  /** The checksum covers every payload byte before itself, and never itself. */
  #hashThrough(end: number): void {
    if (this.#digested || end === this.#hashed) {
      return;
    }
    const started = performance.now();
    this.#hash.update(
      this.#frame.subarray(this.#prefixBytes + this.#hashed, this.#prefixBytes + end),
    );
    this.#timings.hashMs += performance.now() - started;
    this.#hashed = end;
  }

  #allocate(): Uint8Array {
    const frame = new Uint8Array(PACK_FRAME_BYTES);
    if (this.#prefixBytes > 0) {
      frame[PKT_LINE_LENGTH_BYTES] = DATA_BAND;
    }
    return frame;
  }
}

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
  readonly bytes: number;
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
    windows.push({ start, end: boundedEnd, requests, bytes: compressedBytes });
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
  banded: boolean,
  timings: UploadPackTimings,
): AsyncGenerator<Uint8Array> {
  const frames = new PackFrameWriter(banded, timings);
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
  let reservedBytes = 0;
  let activeBytes = 0;
  const fillReadAhead = (): void => {
    while (
      nextReadWindow < readWindows.length &&
      nextReadWindow < readWindowAt + PACK_REPRESENTATION_READ_AHEAD
    ) {
      const window = readWindows[nextReadWindow]!;
      // An oversized entry runs alone. Its bytes remain reserved while emitted.
      if (reservedBytes > 0 && reservedBytes + window.bytes > PACK_PREFETCH_BYTES) break;
      reservedBytes += window.bytes;
      const reading = readWindow(window);
      // Cancellation can abandon a pending read. The consumer still observes
      // its error when it reaches this window, without an unhandled rejection.
      void reading.catch(() => {});
      prefetchedWindows.set(nextReadWindow, reading);
      nextReadWindow += 1;
    }
  };
  fillReadAhead();

  frames.write(packHeader(order.oids.length));

  for (let index = 0; index < order.oids.length; index += 1) {
    const currentWindow = readWindows[readWindowAt];
    if (currentWindow !== undefined && index === currentWindow.start) {
      prefetched.clear();
      reservedBytes -= activeBytes;
      activeBytes = 0;
      fillReadAhead();
      prefetched = new Map(await prefetchedWindows.get(readWindowAt)!);
      activeBytes = currentWindow.bytes;
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
    let kind: number;
    let size: number;
    let bytes: Uint8Array | null;
    let compressed: Uint8Array | null;

    if (plannedEntry?.kind === "delta") {
      kind = REF_DELTA;
      size = plannedEntry.size;
      bytes = null;
      compressed = plannedEntry.compressed;
    } else if (plannedEntry?.kind === "full") {
      kind = PACK_KINDS[plannedEntry.type];
      size = plannedEntry.size;
      bytes = null;
      compressed = plannedEntry.compressed;
    } else if (delta === null) {
      const cached = await readOptionalCache(
        source.readFullPackEntry === undefined ? undefined : () => source.readFullPackEntry!(oid),
      );
      if (cached !== null) {
        kind = PACK_KINDS[cached.type];
        size = cached.size;
        bytes = null;
        compressed = cached.compressed;
      } else {
        const object = await timedStorageRead(timings, () => source.read(oid));
        if (object === null) {
          throw new UploadPackError(`Object ${oid} vanished while its pack was being written.`);
        }
        kind = PACK_KINDS[object.type];
        size = object.bytes.length;
        bytes = object.bytes;
        compressed = null;
      }
    } else {
      kind = REF_DELTA;
      size = delta.size;
      bytes = "bytes" in delta ? delta.bytes : null;
      compressed = delta.compressed;
    }

    frames.writeEntryHeader(kind, size);
    const deltaBaseOid = plannedEntry?.kind === "delta" ? plannedEntry.baseOid : delta?.baseOid;
    if (deltaBaseOid !== undefined) {
      frames.writeObjectId(deltaBaseOid);
    }

    if (compressed !== null) {
      for (let at = 0; at < compressed.length;) {
        at = frames.write(compressed, at);
        for (let frame = frames.takeFrame(); frame !== undefined; frame = frames.takeFrame()) {
          yield frame;
        }
      }
    } else {
      const deflateStarted = performance.now();
      for await (const chunk of deflate(bytes!)) {
        for (let at = 0; at < chunk.length;) {
          at = frames.write(chunk, at);
          for (let frame = frames.takeFrame(); frame !== undefined; frame = frames.takeFrame()) {
            yield frame;
          }
        }
      }
      timings.deflateMs += performance.now() - deflateStarted;
    }

    emitted.add(oid);
  }

  frames.finish();
  for (let frame = frames.takeFrame(); frame !== undefined; frame = frames.takeFrame()) {
    yield frame;
  }
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
  // A common commit also owns its trees and blobs. Stopping at the commit
  // alone still sends unchanged objects reached through the new snapshot.
  const heldCandidates =
    commonHaves.size === 0 || wanted.objects.length === 0
      ? new Set<string>()
      : source.readReachableObjects !== undefined
        ? await source.readReachableObjects(commonHaves, wanted.held, clientBoundaries)
        : (await reachable([...commonHaves], source, false, new Set(), clientBoundaries)).held;
  const missing = wanted.objects.filter((oid) => !client.held.has(oid) && !heldCandidates.has(oid));
  timings.negotiationMs += performance.now() - negotiationStarted;
  const banded = request.capabilities.includes(SIDE_BAND_64K);
  yield pktLine(acknowledgement === undefined ? "NAK\n" : `ACK ${acknowledgement}\n`);
  yield* packBytes(
    missing,
    new Set([...client.held, ...heldCandidates]),
    request.capabilities.includes(THIN_PACK),
    source,
    clientBoundaries,
    banded,
    timings,
  );
  if (banded) {
    yield flushPkt();
  }
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
