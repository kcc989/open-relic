import type { ApiEnvelope } from "@open-relic/contracts";

/**
 * Every REST response is a v4 envelope, so the tests read one through here
 * rather than casting `response.json()` at each call site.
 */
export const envelope = async <T>(
  response: Response,
): Promise<ApiEnvelope<T>> => (await response.json()) as ApiEnvelope<T>;

/** The `result` of a response the test already expects to have succeeded. */
export const result = async <T>(response: Response): Promise<T> => {
  const body = await envelope<T>(response);
  if (!body.success || body.result === null) {
    throw new Error(
      `Expected a successful envelope, got ${JSON.stringify(body)}`,
    );
  }
  return body.result;
};

/** The first error code of a failure, which is what the tests assert on. */
export const errorCode = async (response: Response): Promise<number | null> => {
  const body = await envelope<unknown>(response);
  return body.errors[0]?.code ?? null;
};
