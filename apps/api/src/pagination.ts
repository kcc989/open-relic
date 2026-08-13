/**
 * Cursors are keyset, not offset: the cursor carries the sort key of the last
 * row handed out, so a page is a range scan and a repository created mid-walk
 * cannot shift rows onto a page the client has already seen.
 *
 * The payload is opaque on purpose — it is base64url so it survives a query
 * string, and clients are expected to echo it back rather than read it.
 */
export type CursorKey = Record<string, string>;

const toBase64Url = (text: string): string =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const fromBase64Url = (text: string): string => {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
};

export const encodeCursor = (key: CursorKey): string =>
  toBase64Url(JSON.stringify(key));

/**
 * `null` for anything that is not a cursor this service minted. A caller that
 * tampers with one gets a rejected request rather than a silently different
 * page.
 */
export const decodeCursor = (cursor: string): CursorKey | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(cursor));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  if (Object.values(parsed).some((value) => typeof value !== "string")) {
    return null;
  }

  return parsed as CursorKey;
};

/** `%`, `_`, and the escape character itself are literals in a search term. */
export const escapeLikePattern = (term: string): string =>
  term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
