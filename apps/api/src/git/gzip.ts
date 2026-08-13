/** Decode the gzip Content-Encoding Git uses for larger negotiation requests. */

import { InflateError, Inflater } from "../inflate.ts";

const GZIP_FIXED_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;
const DEFLATE_METHOD = 8;

const FLAG_HEADER_CRC = 0x02;
const FLAG_EXTRA = 0x04;
const FLAG_NAME = 0x08;
const FLAG_COMMENT = 0x10;
const RESERVED_FLAGS = 0xe0;

/** Negotiation is pkt-lines, not pack data; this is well above a realistic request. */
export const MAX_GIT_REQUEST_BYTES = 16 * 1_024 * 1_024;

export class GzipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GzipError";
  }
}

const collect = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        break;
      }

      size += value.length;
      if (size > MAX_GIT_REQUEST_BYTES) {
        throw new GzipError(
          `A compressed Git request may be at most ${MAX_GIT_REQUEST_BYTES} bytes.`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }

  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

const terminatedFieldEnd = (bytes: Uint8Array, from: number, limit: number): number => {
  const end = bytes.indexOf(0, from);
  if (end === -1 || end >= limit) {
    throw new GzipError("A gzip header field is not terminated.");
  }
  return end + 1;
};

const compressedStart = (bytes: Uint8Array, trailerAt: number): number => {
  if (bytes.length < GZIP_FIXED_HEADER_BYTES + GZIP_TRAILER_BYTES) {
    throw new GzipError("The gzip request is truncated.");
  }
  if (bytes[0] !== GZIP_MAGIC_FIRST || bytes[1] !== GZIP_MAGIC_SECOND) {
    throw new GzipError("The request does not begin with a gzip header.");
  }
  if (bytes[2] !== DEFLATE_METHOD) {
    throw new GzipError("The gzip request does not use deflate.");
  }

  const flags = bytes[3]!;
  if ((flags & RESERVED_FLAGS) !== 0) {
    throw new GzipError("The gzip request sets reserved header flags.");
  }

  let at = GZIP_FIXED_HEADER_BYTES;
  if ((flags & FLAG_EXTRA) !== 0) {
    if (at + 2 > trailerAt) {
      throw new GzipError("The gzip extra-field length is truncated.");
    }
    const extraLength = new DataView(bytes.buffer, bytes.byteOffset + at, 2).getUint16(0, true);
    at += 2 + extraLength;
  }
  if ((flags & FLAG_NAME) !== 0) {
    at = terminatedFieldEnd(bytes, at, trailerAt);
  }
  if ((flags & FLAG_COMMENT) !== 0) {
    at = terminatedFieldEnd(bytes, at, trailerAt);
  }
  if ((flags & FLAG_HEADER_CRC) !== 0) {
    at += 2;
  }

  if (at >= trailerAt) {
    throw new GzipError("The gzip request has no deflate payload.");
  }
  return at;
};

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ~crc >>> 0;
};

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

export const gunzip = async (
  body: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> => {
  const bytes = await collect(body);
  const trailerAt = bytes.length - GZIP_TRAILER_BYTES;
  const start = compressedStart(bytes, trailerAt);
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + trailerAt, GZIP_TRAILER_BYTES);
  const size = trailer.getUint32(4, true);

  if (size > MAX_GIT_REQUEST_BYTES) {
    throw new GzipError(`An inflated Git request may be at most ${MAX_GIT_REQUEST_BYTES} bytes.`);
  }

  const inflater = new Inflater(size, "raw");
  try {
    inflater.push(bytes.subarray(start, trailerAt), true);
  } catch (error) {
    if (error instanceof InflateError) {
      throw new GzipError(`The gzip request could not be inflated: ${error.message}`);
    }
    throw error;
  }

  if (!inflater.done || inflater.leftover.length > 0) {
    throw new GzipError("The gzip request has trailing compressed data.");
  }
  if (crc32(inflater.output) !== trailer.getUint32(0, true)) {
    throw new GzipError("The gzip request checksum does not match.");
  }

  return streamOf(inflater.output);
};
