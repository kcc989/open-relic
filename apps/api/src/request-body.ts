import { Result, Schema } from "effect";

/**
 * `pointer` is the JSON pointer at the offending field, which the v4 envelope
 * carries as `errors[].source.pointer` so a client can attribute the rejection
 * to one input rather than to the request as a whole.
 */
export type Rejected = {
  readonly ok: false;
  readonly detail: string;
  readonly pointer?: string;
};

export type Parsed<Value> = { readonly ok: true; readonly value: Value } | Rejected;

export type ParsedText = { readonly ok: true; readonly value: string | null } | Rejected;

export type ParsedFlag = { readonly ok: true; readonly value: boolean } | Rejected;

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export const decodeJson = <Value>(schema: Schema.Codec<Value>, payload: Json): Parsed<Value> => {
  const decoded = Schema.decodeUnknownResult(schema)(payload);
  return Result.isFailure(decoded)
    ? { ok: false, detail: decoded.failure.message }
    : { ok: true, value: decoded.success };
};

/** Absent, null, and blank all parse to `null` — one spelling of "unset". */
export const parseOptionalText = (
  value: string | null | undefined,
  field: string,
  maxLength: number,
): ParsedText => {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      detail: `"${field}" may be at most ${maxLength} characters.`,
      pointer: `/${field}`,
    };
  }

  return { ok: true, value: trimmed.length === 0 ? null : trimmed };
};

/** Strict: `"true"` and `1` are not booleans, and guessing at them would hide a bug. */
export const parseOptionalFlag = (
  value: boolean | null | undefined,
  fallback: boolean,
): ParsedFlag => {
  if (value === undefined || value === null) {
    return { ok: true, value: fallback };
  }

  return { ok: true, value };
};
