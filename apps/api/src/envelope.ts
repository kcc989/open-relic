import {
  ERROR_CODES,
  type ApiEnvelope,
  type ApiError,
  type EndpointId,
  type ResultInfo,
} from "@open-relic/contracts";

/**
 * Every JSON response on the REST surface goes through here. Artifacts wraps
 * both halves of the outcome in one envelope — `result` on success, `errors[]`
 * on failure — so a client parses one shape and reads `success` rather than
 * branching on the status code first.
 */
const envelope = <T>(
  body: Partial<ApiEnvelope<T>> & Pick<ApiEnvelope<T>, "result" | "success">,
  init?: ResponseInit,
): Response =>
  Response.json(
    {
      errors: [],
      messages: [],
      ...body,
    } satisfies ApiEnvelope<T>,
    init,
  );

export const ok = <T>(result: T, init?: ResponseInit): Response =>
  envelope({ result, success: true }, init);

/**
 * A list answers with a bare array in `result` and its paging state beside it
 * in `result_info`, rather than an object wrapping both.
 */
export const okList = <T>(
  result: readonly T[],
  resultInfo: ResultInfo,
): Response =>
  envelope({ result, success: true, result_info: resultInfo });

export const fail = (status: number, error: ApiError): Response =>
  envelope({ result: null, success: false, errors: [error] }, { status });

export const invalidInput = (message: string, pointer?: string): Response =>
  fail(400, {
    code: ERROR_CODES.invalidInput,
    message,
    ...(pointer === undefined ? {} : { source: { pointer } }),
  });

export const invalidRepoName = (message: string): Response =>
  fail(400, {
    code: ERROR_CODES.invalidRepoName,
    message,
    source: { pointer: "/name" },
  });

export const notFound = (message: string): Response =>
  fail(404, { code: ERROR_CODES.notFound, message });

/**
 * Not `401`: the Git surface has no credential to ask for yet, so challenging
 * the client would send it round a loop it cannot finish.
 */
export const forbidden = (message: string): Response =>
  fail(403, { code: ERROR_CODES.forbidden, message });

export const alreadyExists = (message: string): Response =>
  fail(409, { code: ERROR_CODES.alreadyExists, message });

export const notImplemented = (operation: EndpointId): Response =>
  fail(501, {
    code: ERROR_CODES.notImplemented,
    message: `The ${operation} endpoint is registered, but its behavior has not been implemented.`,
  });
