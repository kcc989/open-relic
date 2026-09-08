/**
 * Reading a pack, in one pass, without holding it.
 *
 * Every object is handed to the sink the moment it is complete, so a delta
 * resolves by reading its base back out of storage rather than out of a table
 * of everything seen so far. A small, bounded recent-base window avoids that
 * storage read for nearby deltas. Peak residency stays independent of how long
 * the pack is. That is the property
 * [ADR-0002](../../../docs/adr/0002-git-objects-are-chunked-rows-in-the-repository-object.md)
 * bought the chunked object store to get, so a buffering rewrite of this file
 * would pass its tests and lose the point.
 *
 * A ref-delta may name a base from an earlier push. Reading through the sink is
 * what makes those thin packs work without retaining prior packs in memory.
 */

import { inflateSync } from "node:zlib";

import { DeltaError, applyDelta } from "./delta.ts";
import { InflateError, Inflater } from "./inflate.ts";
import { MAX_OBJECT_BYTES, hashObject, type ObjectType } from "./object.ts";
import { Sha1, toHex } from "./sha1.ts";

/**
 * Git facts, not HTTP ones: the object owns Git and the Worker owns the v4
 * envelope (ADR-0004), so nothing here knows a status code. Receive-pack maps
 * `object-too-large` onto Artifacts' `memoryLimit` and the rest onto
 * `invalidInput` — that `memoryLimit` is in Artifacts' documented list is what
 * says refusing an object too big to hold is an answer rather than a crash.
 */
export type PackErrorCode =
  | "not-a-pack"
  | "unsupported-version"
  | "truncated"
  | "checksum-mismatch"
  | "trailing-bytes"
  | "missing-base"
  | "object-too-large"
  | "corrupt";

export class PackError extends Error {
  readonly code: PackErrorCode;

  constructor(code: PackErrorCode, message: string) {
    super(message);
    this.name = "PackError";
    this.code = code;
  }
}

/** The delta an object arrived as, kept because the pack passes once. */
export interface PackDelta {
  readonly baseOid: string;
  readonly bytes: Uint8Array;
}

export interface PackObject {
  readonly oid: string;
  readonly type: ObjectType;
  readonly bytes: Uint8Array;
  /** `null` when the object arrived whole. */
  readonly delta: PackDelta | null;
  /** The entry's reusable zlib stream, captured while the Pack is read. */
  readonly compressed?: Uint8Array;
}

export interface PackBase {
  readonly type: ObjectType;
  readonly bytes: Uint8Array;
}

/**
 * Where resolved objects go, and where delta bases come back from. The two
 * halves are the same store, which is what keeps the parse streaming.
 */
export interface PackSink {
  readonly read: (oid: string) => Promise<PackBase | null>;
  readonly write: (object: PackObject, timings?: PackTimings) => Promise<void>;
  readonly writeBatch?: (objects: readonly PackObject[], timings?: PackTimings) => Promise<void>;
}

export const PACK_WRITE_BATCH_BYTES = 4 * 1_024 * 1_024;
export const PACK_WRITE_BATCH_COUNT = 128;

/** Pending bases remain readable until their bounded batch reaches storage. */
class PackWrites implements PackSink {
  readonly #sink: PackSink;
  readonly #timings: PackTimings;
  readonly #pending = new Map<string, PackObject>();
  #bytes = 0;

  constructor(sink: PackSink, timings: PackTimings) {
    this.#sink = sink;
    this.#timings = timings;
  }

  async read(oid: string): Promise<PackBase | null> {
    return this.#pending.get(oid) ?? this.#sink.read(oid);
  }

  async write(object: PackObject): Promise<void> {
    if (this.#sink.writeBatch === undefined) {
      await this.#sink.write(object, this.#timings);
      return;
    }
    if (this.#pending.has(object.oid)) return;
    const bytes =
      object.bytes.length + (object.delta?.bytes.length ?? 0) + (object.compressed?.length ?? 0);
    if (this.#bytes + bytes > PACK_WRITE_BATCH_BYTES) await this.flush();
    this.#pending.set(object.oid, object);
    this.#bytes += bytes;
    if (this.#pending.size >= PACK_WRITE_BATCH_COUNT || this.#bytes >= PACK_WRITE_BATCH_BYTES) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.#pending.size === 0) return;
    const batch = [...this.#pending.values()];
    this.#pending.clear();
    this.#bytes = 0;
    await this.#sink.writeBatch!(batch, this.#timings);
  }
}

export interface PackSummary {
  readonly objectCount: number;
}

/** Aggregate receive-pack phases; one log record is emitted per request. */
export interface PackTimings {
  bodyIngressMs: number;
  bodyBytes: number;
  bodyChunks: number;
  inflateMs: number;
  hashMs: number;
  deltaApplyMs: number;
  storageReadMs: number;
  storageWriteMs: number;
  storageCommitMs: number;
  linkIndexMs: number;
  resolvedBytesStored: number;
  compressedBytesStored: number;
  deltaBytesStored: number;
  linksStored: number;
  objects: number;
  deltas: number;
  recentBaseHits: number;
  nativeInflates: number;
}

export const createPackTimings = (): PackTimings => ({
  bodyIngressMs: 0,
  bodyBytes: 0,
  bodyChunks: 0,
  inflateMs: 0,
  hashMs: 0,
  deltaApplyMs: 0,
  storageReadMs: 0,
  storageWriteMs: 0,
  storageCommitMs: 0,
  linkIndexMs: 0,
  resolvedBytesStored: 0,
  compressedBytesStored: 0,
  deltaBytesStored: 0,
  linksStored: 0,
  objects: 0,
  deltas: 0,
  recentBaseHits: 0,
  nativeInflates: 0,
});

const PACK_SIGNATURE = "PACK";
const HEADER_BYTES = 12;
const TRAILER_BYTES = 20;
const OID_BYTES = 20;
const SUPPORTED_VERSIONS = new Set([2, 3]);
const RECENT_BASE_BYTES = 4 * 1_024 * 1_024;
const RECENT_BASE_COUNT = 256;

class RecentPackBases {
  readonly #entries = new Map<string, PackBase>();
  #bytes = 0;

  read(oid: string): PackBase | null {
    return this.#entries.get(oid) ?? null;
  }

  remember(oid: string, object: PackBase): void {
    const previous = this.#entries.get(oid);
    if (previous !== undefined) {
      this.#entries.delete(oid);
      this.#bytes -= previous.bytes.length;
    }
    if (object.bytes.length > RECENT_BASE_BYTES) {
      return;
    }

    this.#entries.set(oid, object);
    this.#bytes += object.bytes.length;
    while (this.#entries.size > RECENT_BASE_COUNT || this.#bytes > RECENT_BASE_BYTES) {
      const oldest = this.#entries.entries().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes.length;
    }
  }
}

const objectTypeForKind = (kind: number): ObjectType | undefined => {
  switch (kind) {
    case 1:
      return "commit";
    case 2:
      return "tree";
    case 3:
      return "blob";
    case 4:
      return "tag";
    default:
      return undefined;
  }
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

const EMPTY = new Uint8Array(0);

/**
 * The byte stream, plus the running checksum of everything except the trailing
 * 20 bytes — which is exactly what the trailer is over. Holding the last 20
 * bytes back from the hasher is how that is arranged without knowing the
 * length in advance.
 */
class PackStream {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #timings: PackTimings;
  readonly #hasher = new Sha1();
  #buffer: Uint8Array = EMPTY;
  #held: Uint8Array = EMPTY;
  #exhausted = false;
  #position = 0;

  constructor(body: ReadableStream<Uint8Array>, timings: PackTimings) {
    this.#reader = body.getReader();
    this.#timings = timings;
  }

  /** Bytes consumed from the start of the pack — an entry's own offset. */
  get position(): number {
    return this.#position;
  }

  async take(count: number): Promise<Uint8Array> {
    while (this.#buffer.length < count) {
      if (!(await this.#pull())) {
        throw new PackError("truncated", "The pack ended mid-object.");
      }
    }

    const taken = this.#buffer.subarray(0, count);
    this.#buffer = this.#buffer.subarray(count);
    this.#position += count;
    return taken;
  }

  async byte(): Promise<number> {
    return (await this.take(1))[0]!;
  }

  /** Whatever is buffered, so the inflater sets the pace rather than a size. */
  async takeBuffered(): Promise<Uint8Array> {
    while (this.#buffer.length === 0) {
      if (!(await this.#pull())) {
        throw new PackError("truncated", "The pack ended mid-object.");
      }
    }

    const taken = this.#buffer;
    this.#buffer = EMPTY;
    this.#position += taken.length;
    return taken;
  }

  /** Hands back the tail an inflater read past the end of its own stream. */
  unread(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }

    if (this.#buffer.length === 0) {
      this.#buffer = bytes;
      this.#position -= bytes.length;
      return;
    }
    const restored = new Uint8Array(bytes.length + this.#buffer.length);
    restored.set(bytes, 0);
    restored.set(this.#buffer, bytes.length);
    this.#buffer = restored;
    this.#position -= bytes.length;
  }

  async atEnd(): Promise<boolean> {
    while (this.#buffer.length === 0 && (await this.#pull())) {
      // Pulling is the only way to learn the stream is over.
    }

    return this.#buffer.length === 0;
  }

  /** The checksum the trailer should carry; only final once the stream is. */
  digest(): Uint8Array {
    return this.#hasher.digest();
  }

  async #pull(): Promise<boolean> {
    if (this.#exhausted) {
      return false;
    }

    const started = performance.now();
    const { done, value } = await this.#reader.read();
    this.#timings.bodyIngressMs += performance.now() - started;
    if (done || value === undefined) {
      this.#exhausted = true;
      return false;
    }
    this.#timings.bodyBytes += value.length;
    this.#timings.bodyChunks += 1;

    this.#hold(value);

    if (this.#buffer.length === 0) {
      this.#buffer = value;
    } else {
      const grown = new Uint8Array(this.#buffer.length + value.length);
      grown.set(this.#buffer, 0);
      grown.set(value, this.#buffer.length);
      this.#buffer = grown;
    }

    return true;
  }

  /**
   * Hashes everything but the last 20 bytes seen so far. Whatever is still
   * held when the stream ends is the trailer, which is the one part of a pack
   * its own checksum does not cover.
   */
  #hold(chunk: Uint8Array): void {
    const started = performance.now();
    try {
      if (chunk.length >= TRAILER_BYTES) {
        this.#hasher.update(this.#held);
        this.#hasher.update(chunk.subarray(0, chunk.length - TRAILER_BYTES));
        this.#held = chunk.slice(chunk.length - TRAILER_BYTES);
        return;
      }

      const combined = new Uint8Array(this.#held.length + chunk.length);
      combined.set(this.#held, 0);
      combined.set(chunk, this.#held.length);

      const keep = Math.min(TRAILER_BYTES, combined.length);
      this.#hasher.update(combined.subarray(0, combined.length - keep));
      this.#held = combined.slice(combined.length - keep);
    } finally {
      this.#timings.hashMs += performance.now() - started;
    }
  }
}

interface EntryHeader {
  readonly kind: number;
  readonly size: number;
}

/**
 * Type in the first byte's bits 4–6, size split across the low nibble and then
 * seven bits at a time.
 */
const readEntryHeader = async (stream: PackStream): Promise<EntryHeader> => {
  let byte = await stream.byte();
  const kind = (byte >> 4) & 0b111;
  let size = byte & 0b1111;
  let shift = 4;

  while ((byte & 0x80) !== 0) {
    byte = await stream.byte();
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;

    if (!Number.isSafeInteger(size)) {
      throw new PackError("corrupt", "An object size is larger than we can address.");
    }
  }

  // The size arrives before the object does and is what the inflated buffer is
  // allocated from, so it is checked here rather than on the way out: a pack of
  // a few hundred kilobytes can otherwise ask for hundreds of megabytes.
  if (size > MAX_OBJECT_BYTES) {
    throw new PackError(
      "object-too-large",
      `A pack entry declares ${size} bytes, past the ${MAX_OBJECT_BYTES}-byte limit.`,
    );
  }

  return { kind, size };
};

/**
 * How far back the base lies, in a variable-length encoding whose continuation
 * subtracts one per byte so that every offset has exactly one spelling.
 */
const readBackOffset = async (stream: PackStream): Promise<number> => {
  let byte = await stream.byte();
  let offset = byte & 0x7f;

  while ((byte & 0x80) !== 0) {
    byte = await stream.byte();
    offset = (offset + 1) * 128 + (byte & 0x7f);

    if (!Number.isSafeInteger(offset)) {
      throw new PackError("corrupt", "A delta offset is larger than we can address.");
    }
  }

  return offset;
};

interface InflatedEntry {
  readonly bytes: Uint8Array;
  readonly compressed: Uint8Array;
}

interface NativeInflation {
  readonly buffer: Uint8Array;
  readonly engine: { readonly bytesWritten: number };
}

/** Try once on buffered entries; split streams keep the resumable decoder. */
const inflateBuffered = (chunk: Uint8Array, size: number): NativeInflation | null => {
  // Small entries cost less to decode than to create a native engine. Require
  // ample buffered input: speculative native calls on split streams regressed
  // workerd. Bound the output too, since incomplete streams fall back to JS.
  if (size < 1_024 || size > PACK_WRITE_BATCH_BYTES || chunk.length < size + 64) return null;
  try {
    // SAFETY: node:zlib returns { buffer, engine } with info:true. Node's type
    // declarations omit that overload; the Uint8Array alternative is checked.
    const result = inflateSync(chunk, { info: true, maxOutputLength: size }) as
      | Uint8Array
      | NativeInflation;
    if (result instanceof Uint8Array) return null;
    if (result.buffer.length !== size || result.engine.bytesWritten > chunk.length) return null;
    return result;
  } catch {
    // The resumable decoder distinguishes truncation, corruption, and size
    // errors. Retrying it also preserves the parser's existing error contract.
    return null;
  }
};

const compressedPrefix = (parts: readonly Uint8Array[], length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let at = 0;

  for (const part of parts) {
    const remaining = length - at;
    if (remaining <= 0) {
      break;
    }
    const copied = part.subarray(0, remaining);
    bytes.set(copied, at);
    at += copied.length;
  }

  return bytes;
};

const inflateEntry = async (
  stream: PackStream,
  size: number,
  timings: PackTimings,
): Promise<InflatedEntry> => {
  let inflater: Inflater | undefined;
  const compressedParts: Uint8Array[] = [];
  let compressedLength = 0;
  const started = performance.now();
  const ingressBefore = timings.bodyIngressMs;

  try {
    const first = await stream.takeBuffered();
    const native = inflateBuffered(first, size);
    if (native !== null) {
      timings.nativeInflates += 1;
      stream.unread(first.subarray(native.engine.bytesWritten));
      return { bytes: native.buffer, compressed: first.slice(0, native.engine.bytesWritten) };
    }
    inflater = new Inflater(size);
    compressedParts.push(first);
    compressedLength += first.length;
    inflater.push(first);
    while (!inflater.done) {
      const chunk = await stream.takeBuffered();
      compressedParts.push(chunk);
      compressedLength += chunk.length;
      inflater.push(chunk);
    }
  } catch (error) {
    if (error instanceof InflateError) {
      throw new PackError(
        error.code === "truncated" ? "truncated" : "corrupt",
        `An object in the pack could not be inflated: ${error.message}`,
      );
    }
    throw error;
  } finally {
    timings.inflateMs += performance.now() - started - (timings.bodyIngressMs - ingressBefore);
  }

  stream.unread(inflater.leftover);
  compressedLength -= inflater.leftover.length;
  return {
    bytes: inflater.output,
    compressed: compressedPrefix(compressedParts, compressedLength),
  };
};

const equal = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, at) => byte === right[at]);

export const readPack = async (
  body: ReadableStream<Uint8Array>,
  sink: PackSink,
  timings: PackTimings = createPackTimings(),
): Promise<PackSummary> => {
  const stream = new PackStream(body, timings);
  const header = await stream.take(HEADER_BYTES);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

  if (new TextDecoder().decode(header.subarray(0, 4)) !== PACK_SIGNATURE) {
    throw new PackError("not-a-pack", "The stream does not begin with PACK.");
  }

  const version = view.getUint32(4);
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new PackError("unsupported-version", `Pack version ${version} is not supported.`);
  }

  const objectCount = view.getUint32(8);

  // Offsets are how `ofs-delta` names its base, so the parse has to remember
  // where each entry began. One entry per object, not per byte.
  const oidByOffset = new Map<number, string>();
  const recentBases = new RecentPackBases();
  const writes = new PackWrites(sink, timings);

  for (let index = 0; index < objectCount; index += 1) {
    const offset = stream.position;
    const { kind, size } = await readEntryHeader(stream);
    // Large entries need the parser's working set without a pending batch too.
    if (size >= PACK_WRITE_BATCH_BYTES) await writes.flush();

    if (kind === OFS_DELTA) {
      const baseOffset = offset - (await readBackOffset(stream));
      const baseOid = oidByOffset.get(baseOffset);

      if (baseOid === undefined) {
        throw new PackError(
          "missing-base",
          `An ofs-delta names offset ${baseOffset}, where no object began.`,
        );
      }

      oidByOffset.set(offset, await resolve(stream, writes, recentBases, timings, size, baseOid));
      continue;
    }

    if (kind === REF_DELTA) {
      const baseOid = toHex(await stream.take(OID_BYTES));
      oidByOffset.set(offset, await resolve(stream, writes, recentBases, timings, size, baseOid));
      continue;
    }

    const type = objectTypeForKind(kind);
    if (type === undefined) {
      throw new PackError("corrupt", `Pack entry type ${kind} is not a thing.`);
    }

    const entry = await inflateEntry(stream, size, timings);
    const hashStarted = performance.now();
    const oid = hashObject(type, entry.bytes);
    timings.hashMs += performance.now() - hashStarted;
    const writeStarted = performance.now();
    await writes.write({
      oid,
      type,
      bytes: entry.bytes,
      delta: null,
      compressed: entry.compressed,
    });
    timings.storageWriteMs += performance.now() - writeStarted;
    timings.objects += 1;
    recentBases.remember(oid, { type, bytes: entry.bytes });
    oidByOffset.set(offset, oid);
  }

  const flushStarted = performance.now();
  await writes.flush();
  timings.storageWriteMs += performance.now() - flushStarted;
  const trailer = await stream.take(TRAILER_BYTES);

  if (!(await stream.atEnd())) {
    throw new PackError("trailing-bytes", "The pack carries bytes past its trailer.");
  }
  const digestStarted = performance.now();
  const digest = stream.digest();
  timings.hashMs += performance.now() - digestStarted;
  if (!equal(trailer, digest)) {
    throw new PackError("checksum-mismatch", "The pack's trailing checksum does not match.");
  }

  return { objectCount };
};

/** Reads the base back out of storage — the whole reason this stays streaming. */
const resolve = async (
  stream: PackStream,
  sink: PackSink,
  recentBases: RecentPackBases,
  timings: PackTimings,
  size: number,
  baseOid: string,
): Promise<string> => {
  const delta = await inflateEntry(stream, size, timings);
  const recent = recentBases.read(baseOid);
  let base = recent;
  if (base === null) {
    const readStarted = performance.now();
    base = await sink.read(baseOid);
    timings.storageReadMs += performance.now() - readStarted;
  } else {
    timings.recentBaseHits += 1;
  }

  if (base === null) {
    throw new PackError(
      "missing-base",
      `The pack deltas against ${baseOid}, which is not in the pack or the repository.`,
    );
  }

  let bytes: Uint8Array;
  const deltaStarted = performance.now();
  try {
    bytes = applyDelta(base.bytes, delta.bytes);
  } catch (error) {
    if (error instanceof DeltaError) {
      throw new PackError(
        error.code === "too-large" ? "object-too-large" : "corrupt",
        `A delta could not be applied: ${error.message}`,
      );
    }
    throw error;
  } finally {
    timings.deltaApplyMs += performance.now() - deltaStarted;
  }

  const hashStarted = performance.now();
  const oid = hashObject(base.type, bytes);
  timings.hashMs += performance.now() - hashStarted;
  const writeStarted = performance.now();
  await sink.write(
    {
      oid,
      type: base.type,
      bytes,
      delta: { baseOid, bytes: delta.bytes },
      compressed: delta.compressed,
    },
    timings,
  );
  timings.storageWriteMs += performance.now() - writeStarted;
  timings.objects += 1;
  timings.deltas += 1;
  recentBases.remember(oid, { type: base.type, bytes });
  return oid;
};
