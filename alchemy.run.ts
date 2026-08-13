import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import type { RepositoryObject } from "./apps/api/src/repository-object.ts";

export const ApiWorker = Cloudflare.Worker("Api", {
  main: "./apps/api/src/index.ts",
  compatibility: { date: "2026-08-12" },
  env: {
    REPOSITORIES: Cloudflare.DurableObject<RepositoryObject>("Repositories", {
      className: "RepositoryObject",
    }),
  },
  observability: {
    enabled: true,
  },
});

export default Alchemy.Stack(
  "OpenRelic",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const api = yield* ApiWorker;

    return {
      apiUrl: api.url,
    };
  }),
);
