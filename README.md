# Open Relic

An API-only starting point for an open-source, self-hostable Git service built
on Cloudflare Durable Objects.

This repository intentionally contains **no Git or repository business logic
yet**. It establishes the HTTP contract, deployment boundary, and test harness
that the engine can grow into:

- Hono routes for every REST and Git Smart HTTP endpoint in the initial API
- Effect v4 as the typed stub service boundary
- Alchemy v2 for the Cloudflare Worker and SQLite-backed Durable Object
- Bun workspaces for the API app and shared endpoint contracts
- RFC 9457-style `501 Not Implemented` responses from every stub

## Monorepo

```text
.
├── alchemy.run.ts                 # Cloudflare deployment stack
├── apps/api                       # Hono Worker and empty RepositoryObject
└── packages/contracts             # Shared endpoint manifest and response types
```

The deployed `RepositoryObject` is only a reserved Durable Object namespace.
It does not read or write storage. Its direct `fetch` handler and all public API
routes return `501` until the Git engine is implemented.

## Infrastructure

`alchemy.run.ts` is the only description of the deployed system. It declares the
`Api` Worker (bundled from `apps/api/src/index.ts`), the `Repositories` Durable
Object namespace bound to it as `REPOSITORIES`, and Workers Observability. There
is no `wrangler.toml`; Alchemy owns the Worker script, bindings, migrations, and
`workers.dev` subdomain.

Bindings flow back into the application as types. The stack exports

```ts
export type ApiEnv = Cloudflare.InferEnv<typeof ApiWorker>;
```

and `apps/api/src/app.ts` builds its router as `new Hono<{ Bindings: ApiEnv }>()`,
so `context.env.REPOSITORIES` is typed as
`DurableObjectNamespace<RepositoryObject>` and any new binding added to the stack
shows up on `context.env` without a hand-maintained `Env` interface.

## Development

Requires [Bun](https://bun.sh/) and a Cloudflare account for Alchemy commands.

```sh
bun install
bun run check
bun run plan
bun run dev
```

Authenticate once, then deploy:

```sh
bun alchemy login   # or copy .env.example to .env and use an API token
bun run deploy
```

### Stages

Every command takes `--stage`, and Alchemy derives a distinct Worker name and
Durable Object namespace per stage, so stages never share state. `--stage`
defaults to `dev_$USER`, which is what `bun run deploy` and `bun run dev` use.

```sh
bun run plan:prod      # alchemy plan --stage prod
bun run deploy:prod    # alchemy deploy --stage prod
bun run tail           # stream live Worker logs
bun run destroy        # tear down the current stage
```

CI deploys the `prod` stage from `main` via `.github/workflows/deploy.yml`. It
needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as repository secrets in
a `prod` environment; the token needs Workers Scripts:Edit, Workers
Subdomain:Edit, Workers Observability:Edit, and Account Settings:Read.

`GET /healthz` is the only successful application endpoint. It returns:

```json
{ "service": "open-relic", "status": "ok" }
```

All routes supplied for namespaces, repositories, tokens, repository contents,
archives, and Git upload/receive pack are registered from the manifest in
`packages/contracts/src/index.ts` and covered by tests.
