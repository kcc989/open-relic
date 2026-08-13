# Open Relic

An API-only starting point for an open-source, self-hostable Git service built
on Cloudflare Durable Objects.

The namespace API is implemented. Everything else — repositories, tokens,
contents, and Git Smart HTTP — is still a registered route that answers `501`:

- Hono routes for every REST and Git Smart HTTP endpoint in the initial API
- Effect v4 as the typed stub service boundary
- Drizzle as the ORM over Durable Object SQLite, with generated migrations
- Alchemy v2 for the Cloudflare Worker and SQLite-backed Durable Objects
- Bun workspaces for the API app and shared endpoint contracts
- RFC 9457-style problem documents for every failure

## Monorepo

```text
.
├── alchemy.run.ts                 # Cloudflare deployment stack
├── drizzle.config.ts              # drizzle-kit output for the Durable Object
├── apps/api
│   ├── drizzle/                   # Generated migrations (committed)
│   └── src/db/schema.ts           # Drizzle schema
└── packages/contracts             # Shared endpoint manifest and response types
```

`packages/contracts` names the implemented endpoints in
`IMPLEMENTED_ENDPOINT_IDS`. The router skips stub registration for those ids and
the test suite asserts `501` for the complement, so the manifest, the router,
and the tests cannot drift apart.

The deployed `RepositoryObject` is still only a reserved Durable Object
namespace. It does not read or write storage, and its direct `fetch` handler
returns `501` until the Git engine is implemented.

## Namespaces

A namespace owns repositories the way a GitHub user or organization does. Every
namespace in the installation lives in a single SQLite-backed Durable Object,
`NamespaceRegistryObject`, bound as `NAMESPACES` and addressed by the fixed name
`registry`. One object rather than one per namespace, because allocating a slug
has to be a single serialized decision and listing namespaces has to see all of
them; `onConflictDoNothing().returning()` makes the uniqueness check and the
insert one statement.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/v1/namespaces` | `201` with a `Location` header, `409` if the slug is taken, `400` if the body is invalid |
| `GET /api/v1/namespaces` | `200` with `{ "namespaces": [...] }`, ordered by slug |
| `GET /api/v1/namespaces/:namespace` | `200` or `404` |
| `DELETE /api/v1/namespaces/:namespace` | `204` or `404` |

A slug is lowercase alphanumerics with interior hyphens, at most 39 characters,
and may not be one of the reserved segments of the HTTP surface (`api`, `git`,
`healthz`, `static`, `well-known`). It is validated in
`packages/contracts` so clients can apply the same rule before a round trip.

```sh
curl -X POST http://localhost:1337/api/v1/namespaces \
  -H 'Content-Type: application/json' \
  -d '{"slug":"acme","displayName":"Acme, Inc."}'
```

## Database

Drizzle is the ORM. The schema lives in `apps/api/src/db/schema.ts`, and
`drizzle.config.ts` points drizzle-kit at it with the `durable-sqlite` driver:

```sh
bun run db:generate    # drizzle-kit generate
```

That writes `apps/api/drizzle/` — the SQL, a snapshot, and a `migrations.js`
bundle — which is **committed**. There is no network-connected database to push
to, so the Durable Object applies its own migrations: it builds
`drizzle(ctx.storage)` and calls the `durable-sqlite` migrator inside
`blockConcurrencyWhile`, so no request can reach a half-migrated schema, on
first start or after an eviction. `migrations.js` imports each `.sql` file
directly; Alchemy's bundler maps `.sql` to a text module for exactly this case,
so no wrangler-style `rules` config or codegen step is needed.

The Durable Object is a thin RPC shell over `NamespaceRegistry`, which takes any
synchronous drizzle SQLite database. Tests construct one over `bun:sqlite` and
migrate it from the same `apps/api/drizzle/` folder, so the queries and the
generated schema run for real without a Workers runtime — the only thing the
tests skip is the RPC hop.

## Infrastructure

`alchemy.run.ts` is the only description of the deployed system. It declares the
`Api` Worker (bundled from `apps/api/src/index.ts`), the `Namespaces` and
`Repositories` Durable Object namespaces bound to it as `NAMESPACES` and
`REPOSITORIES`, and Workers Observability. There is no `wrangler.toml`; Alchemy
owns the Worker script, bindings, migrations, and `workers.dev` subdomain. It
creates new Durable Object classes as `new_sqlite_classes`, which is where the
registry's SQLite storage comes from.

Bindings flow back into the application as types. The stack exports

```ts
export type ApiEnv = Cloudflare.InferEnv<typeof ApiWorker>;
```

and `apps/api/src/app.ts` builds its router as `new Hono<{ Bindings: ApiEnv }>()`,
so `context.env.NAMESPACES` is typed as
`DurableObjectNamespace<NamespaceRegistryObject>` — the registry's RPC methods
are typed at the call site — and any new binding added to the stack shows up on
`context.env` without a hand-maintained `Env` interface.

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

`GET /healthz` reports liveness:

```json
{ "service": "open-relic", "status": "ok" }
```

Alongside the namespace endpoints above, routes for repositories, tokens,
repository contents, archives, and Git upload/receive pack are registered from
the manifest in `packages/contracts/src/index.ts`, answer `501`, and are covered
by tests.
