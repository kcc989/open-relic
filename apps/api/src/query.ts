import { decodeCursor, type CursorKey } from "./pagination.ts";
import type { Rejected } from "./request-body.ts";

export type Parsed<T> = { readonly ok: true; readonly value: T } | Rejected;

/**
 * Absent means the documented default, not zero: a client that omits `limit`
 * asks for a page, not for nothing.
 */
export const parseLimit = (
  raw: string | undefined,
  fallback: number,
  max: number,
): Parsed<number> => {
  if (raw === undefined) {
    return { ok: true, value: fallback };
  }
  if (!/^\d+$/.test(raw)) {
    return { ok: false, detail: `"limit" must be a positive integer.` };
  }

  const limit = Number(raw);
  if (limit < 1 || limit > max) {
    return { ok: false, detail: `"limit" must be between 1 and ${max}.` };
  }

  return { ok: true, value: limit };
};

export const parseChoice = <T extends string>(
  raw: string | undefined,
  field: string,
  allowed: readonly T[],
  fallback: T,
): Parsed<T> => {
  if (raw === undefined) {
    return { ok: true, value: fallback };
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    return {
      ok: false,
      detail: `"${field}" must be one of ${allowed.join(", ")}.`,
    };
  }

  return { ok: true, value: raw as T };
};

/** Absent and blank both mean "no filter", so `?search=` is not a dead end. */
export const parseSearch = (
  raw: string | undefined,
  maxLength: number,
): Parsed<string | null> => {
  if (raw === undefined) {
    return { ok: true, value: null };
  }

  const trimmed = raw.trim();
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      detail: `"search" may be at most ${maxLength} characters.`,
    };
  }

  return { ok: true, value: trimmed.length === 0 ? null : trimmed };
};

/**
 * Absent and blank both mean "start at the beginning". Anything else has to
 * decode, and a cursor that does not is rejected rather than treated as the end
 * of the walk — a client that garbled one should be told so, not handed an
 * empty page it cannot tell apart from a finished list.
 */
export const parseCursorKey = (
  raw: string | undefined,
): Parsed<CursorKey | null> => {
  if (raw === undefined || raw.length === 0) {
    return { ok: true, value: null };
  }

  const key = decodeCursor(raw);
  return key === null
    ? { ok: false, detail: `"cursor" is not a cursor this service issued.` }
    : { ok: true, value: key };
};

/**
 * A cursor names a position in one ordering of one filtered set, so it is only
 * meaningful against the query that minted it. Replaying it under a different
 * sort would compare a value against a column it never came from — an ISO
 * timestamp against a name, say, where digits sort before letters and every row
 * qualifies — and hand back page one again under a fresh cursor, forever.
 */
export const cursorMatchesQuery = (
  key: CursorKey,
  fields: Readonly<Record<string, string>>,
): boolean =>
  Object.entries(fields).every(([field, value]) => key[field] === value);

export const CURSOR_QUERY_MISMATCH =
  `"cursor" was issued for a different sort, direction, or search. Start the walk again without it.` as const;
