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

export const parseCursor = (raw: string | undefined): string | null =>
  raw === undefined || raw.length === 0 ? null : raw;
