import {
  PROBLEM_TYPES,
  type EndpointId,
  type ProblemDetails,
} from "@open-relic/contracts";

export type ProblemStatus = 400 | 404 | 409 | 501;

export interface ProblemInit {
  readonly type: string;
  readonly title: string;
  readonly status: ProblemStatus;
  readonly detail: string;
  readonly operation?: EndpointId;
}

export const problemResponse = (init: ProblemInit): Response =>
  Response.json(init satisfies ProblemDetails, {
    status: init.status,
    headers: { "Content-Type": "application/problem+json" },
  });

export const notImplemented = (operation: EndpointId): ProblemInit => ({
  type: PROBLEM_TYPES.notImplemented,
  title: "Not Implemented",
  status: 501,
  detail: `The ${operation} endpoint is registered, but its behavior has not been implemented.`,
  operation,
});

export const invalidRequest = (
  operation: EndpointId,
  detail: string,
): ProblemInit => ({
  type: PROBLEM_TYPES.invalidRequest,
  title: "Bad Request",
  status: 400,
  detail,
  operation,
});

export const notFound = (
  operation: EndpointId,
  detail: string,
): ProblemInit => ({
  type: PROBLEM_TYPES.notFound,
  title: "Not Found",
  status: 404,
  detail,
  operation,
});

/**
 * `type` is the caller's, unlike the helpers above: a client distinguishes a
 * taken namespace slug from a taken repository name by it.
 */
export const conflict = (
  operation: EndpointId,
  type: string,
  detail: string,
): ProblemInit => ({
  type,
  title: "Conflict",
  status: 409,
  detail,
  operation,
});
