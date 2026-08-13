import type { EndpointId } from "@open-relic/contracts";
import { Data, Effect } from "effect";

export class EndpointNotImplemented extends Data.TaggedError("EndpointNotImplemented")<{
  readonly operation: EndpointId;
}> {}

export interface GitService {
  readonly invoke: (operation: EndpointId) => Effect.Effect<never, EndpointNotImplemented>;
}

export const GitServiceStub: GitService = {
  invoke: (operation) => Effect.fail(new EndpointNotImplemented({ operation })),
};
