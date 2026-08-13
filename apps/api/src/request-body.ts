/**
 * The shared shape of a rejected parse: the caller turns `detail` into a `400`
 * problem document naming its own operation.
 */
export type Rejected = { readonly ok: false; readonly detail: string };

export type ParsedObject =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | Rejected;

export type ParsedText =
  | { readonly ok: true; readonly value: string | null }
  | Rejected;

export const parseJsonObject = (payload: unknown): ParsedObject =>
  typeof payload !== "object" || payload === null || Array.isArray(payload)
    ? { ok: false, detail: "The request body must be a JSON object." }
    : { ok: true, value: payload as Record<string, unknown> };

/**
 * An absent, null, or blank field parses to `null` — the API stores "no
 * description" one way rather than distinguishing it from an empty string.
 */
export const parseOptionalText = (
  value: unknown,
  field: string,
  maxLength: number,
): ParsedText => {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false, detail: `"${field}" must be a string.` };
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      detail: `"${field}" may be at most ${maxLength} characters.`,
    };
  }

  return { ok: true, value: trimmed.length === 0 ? null : trimmed };
};
