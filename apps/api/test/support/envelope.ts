import type { ApiEnvelope, ResultInfo } from "@open-relic/contracts";

/**
 * Every REST response is a v4 envelope, so the tests read one through here
 * rather than casting `response.json()` at each call site.
 */
export const envelope = async <T>(response: Response): Promise<ApiEnvelope<T>> => {
  // SAFETY: REST responses are v4 envelopes; callers assert success or error separately.
  return (await response.json()) as ApiEnvelope<T>;
};

/** The `result` of a response the test already expects to have succeeded. */
export const result = async <T>(response: Response): Promise<T> => {
  const body = await envelope<T>(response);
  if (!body.success || body.result === null) {
    throw new Error(`Expected a successful envelope, got ${JSON.stringify(body)}`);
  }
  return body.result;
};

/** The first error code of a failure, which is what the tests assert on. */
export const errorCode = async (response: Response): Promise<number | null> => {
  const body = await envelope<never>(response);
  return body.errors[0]?.code ?? null;
};

export const pageCursor = (info: ResultInfo | undefined): string => {
  if (info === undefined || !("cursor" in info)) {
    throw new Error("Expected a cursor page.");
  }
  return info.cursor;
};
