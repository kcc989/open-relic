/**
 * What an object is on the wire: a type, a length, and the bytes, hashed
 * together into the name everything else refers to it by.
 */

import { Sha1 } from "./sha1.ts";

export const OBJECT_TYPES = ["commit", "tree", "blob", "tag"] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

export const isObjectType = (value: string): value is ObjectType =>
  (OBJECT_TYPES as readonly string[]).includes(value);

const OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/;

/** The shape of a name, not a claim that anything answers to it. */
export const isObjectId = (value: string): boolean =>
  OBJECT_ID_PATTERN.test(value);

/**
 * The name no object has. Git spells the absence of an object this way rather
 * than by omitting it — an advertisement with no refs still names one, and a
 * push spells "create this ref" as an update from it.
 */
export const ZERO_OID = "0".repeat(40);

/**
 * The largest object we will hold, and so the largest we will accept.
 *
 * Every size in a pack is a number the client chose, read before a byte of the
 * object arrives, and both an object and a delta's result are allocated from
 * one. Without a ceiling, a few hundred kilobytes of pack can ask for hundreds
 * of megabytes of buffer, and a Durable Object has 128 MB — so the failure
 * would be an allocation the runtime kills us for rather than a rejection we
 * can explain.
 *
 * Resolving a delta holds three of these at once — the base, the delta, and
 * the result — which is what puts the number here rather than nearer the
 * limit. Raising it means teaching the reader to inflate whole objects
 * straight into chunks instead of into one buffer; only a delta's base
 * genuinely has to be resident.
 */
export const MAX_OBJECT_BYTES = 32 * 1_024 * 1_024;

const encoder = new TextEncoder();

/**
 * `<type> <size>\0<contents>` — the loose object format, hashed but never
 * stored, since we keep objects inflated and headerless (ADR-0002).
 */
export const hashObject = (type: ObjectType, contents: Uint8Array): string =>
  new Sha1()
    .update(encoder.encode(`${type} ${contents.length}\0`))
    .update(contents)
    .hex();
