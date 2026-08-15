import { describe, expect, test } from "bun:test";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as OpenRelicWorker from "../src/worker.ts";

import { Namespace, type Installation } from "../src/index.ts";

// SAFETY: each runtime case fails namespace validation before Installation is read.
const installation: Installation = undefined as never;

describe("Namespace", () => {
  for (const namespace of ["", "Default", "two_words", "git", "a".repeat(40)]) {
    test(`rejects invalid namespace ${JSON.stringify(namespace)}`, async () => {
      await expect(Effect.runPromise(Namespace(installation, { namespace }))).rejects.toThrow(
        `Invalid Open Relic namespace '${namespace}'`,
      );
    });
  }
});

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type ConsumerEnv = Cloudflare.InferEnv<{
  ARTIFACTS: ReturnType<typeof Namespace>;
}>;

// The compile-time contract is the native Artifacts surface even though the
// deployed binding is backed by Open Relic's namespace adapter.
type _BindingIsArtifacts = Expect<Equal<ConsumerEnv["ARTIFACTS"], Artifacts>>;
type _PublicClientIsArtifacts = Expect<Equal<OpenRelicWorker.Artifacts, Artifacts>>;
