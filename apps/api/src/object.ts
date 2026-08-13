/**
 * What an object is on the wire: a type, a length, and the bytes, hashed
 * together into the name everything else refers to it by.
 */

import { Sha1 } from "./sha1.ts";

export const OBJECT_TYPES = ["commit", "tree", "blob", "tag"] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

export const isObjectType = (value: string): value is ObjectType =>
  (OBJECT_TYPES as readonly string[]).includes(value);

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
