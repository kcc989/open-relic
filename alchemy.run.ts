import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import type { NamespaceRegistryObject } from "./apps/api/src/namespace-registry-object.ts";
import type { RepositoryObject } from "./apps/api/src/repository-object.ts";

export const ApiWorker = Cloudflare.Worker("Api", {
  main: "./apps/api/src/index.ts",
  // Keep this at or below the newest date the workerd binary bundled with
  // Alchemy supports, otherwise `bun run dev` refuses to start the Worker even
  // though a remote deploy would accept it.
  compatibility: { date: "2026-07-11" },
  env: {
    // Alchemy creates new Durable Object classes as `new_sqlite_classes`, so
    // this namespace comes with the SQLite storage the registry queries.
    NAMESPACES: Cloudflare.DurableObject<NamespaceRegistryObject>("Namespaces", {
      className: "NamespaceRegistryObject",
    }),
    REPOSITORIES: Cloudflare.DurableObject<RepositoryObject>("Repositories", {
      className: "RepositoryObject",
    }),
  },
  observability: {
    enabled: true,
  },
});

export type ApiEnv = Cloudflare.InferEnv<typeof ApiWorker>;

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
