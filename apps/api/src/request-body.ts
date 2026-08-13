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

export type ParsedObject =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | Rejected;

export type ParsedText =
  | { readonly ok: true; readonly value: string | null }
  | Rejected;

export type ParsedFlag =
  | { readonly ok: true; readonly value: boolean }
  | Rejected;

export const parseJsonObject = (payload: unknown): ParsedObject =>
  typeof payload !== "object" || payload === null || Array.isArray(payload)
    ? { ok: false, detail: "The request body must be a JSON object." }
    : { ok: true, value: payload as Record<string, unknown> };

/** Absent, null, and blank all parse to `null` — one spelling of "unset". */
export const parseOptionalText = (
  value: unknown,
  field: string,
  maxLength: number,
): ParsedText => {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      detail: `"${field}" must be a string.`,
      pointer: `/${field}`,
    };
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
  value: unknown,
  field: string,
  fallback: boolean,
): ParsedFlag => {
  if (value === undefined || value === null) {
    return { ok: true, value: fallback };
  }
  if (typeof value !== "boolean") {
    return {
      ok: false,
      detail: `"${field}" must be a boolean.`,
      pointer: `/${field}`,
    };
  }

  return { ok: true, value };
};
