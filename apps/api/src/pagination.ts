/**
 * Cursors are keyset, not offset: the cursor carries the sort key of the last
 * row handed out, so a page is a range scan and a repository created mid-walk
 * cannot shift rows onto a page the client has already seen.
 *
 * The encoding lives at the route rather than in the store, because a cursor is
 * a wire format: the store deals in the position a page resumes from, and the
 * route is what turns that into a string a client can hold and hand back.
 *
 * The payload is opaque on purpose — it is base64url so it survives a query
 * string, and clients are expected to echo it back rather than read it.
 */
import { Result, Schema } from "effect";

export type CursorKey = Record<string, string>;

const CursorKeySchema = Schema.Record(Schema.String, Schema.String);

const toBase64Url = (text: string): string =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const fromBase64Url = (text: string): string => {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
};

export const encodeCursor = (key: CursorKey): string => toBase64Url(JSON.stringify(key));

/**
 * `null` for anything that is not a cursor this service minted. Callers turn
 * that into a rejected request rather than an empty page: a cursor that cannot
 * be read is a caller error, and answering it with "the list ended" would be
 * indistinguishable from the list actually having ended.
 */
export const decodeCursor = (cursor: string): CursorKey | null => {
  try {
    const decoded = Schema.decodeUnknownResult(CursorKeySchema)(JSON.parse(fromBase64Url(cursor)));
    return Result.isFailure(decoded) ? null : decoded.success;
  } catch {
    return null;
  }
};

/** `%`, `_`, and the escape character itself are literals in a search term. */
export const escapeLikePattern = (term: string): string =>
  term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
