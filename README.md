# Open Relic

An open-source, self-hostable implementation of
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) — versioned,
Git-speaking storage — built on Cloudflare Durable Objects and running on your
own Cloudflare account, with no access to the Artifacts product.

Compatibility is the specification, not a feature: a client written against
Artifacts should work against an installation with nothing changed but the host.
[ADR-0001](./docs/adr/0001-wire-compatible-with-cloudflare-artifacts.md) records
what that binds us to, and where the API below does not match yet.

The namespace and repository APIs are implemented, and a Git client can now get
a ref advertisement for `git-receive-pack`. Everything else — tokens, contents,
forks, imports, and the rest of Git Smart HTTP — is still a registered route
that answers `501`:

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
├── drizzle.config.ts              # drizzle-kit output for the registry object
├── drizzle.repository.config.ts   # drizzle-kit output for a repository object
├── apps/api
│   ├── drizzle/registry/          # Generated migrations (committed)
│   ├── drizzle/repository/
│   └── src/db/                    # Drizzle schema, one per Durable Object
└── packages/contracts             # Shared endpoint manifest and response types
```

`packages/contracts` names the implemented endpoints in
`IMPLEMENTED_ENDPOINT_IDS`. The router skips stub registration for those ids and
the test suite asserts `501` for the complement, so the manifest, the router,
and the tests cannot drift apart.

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
| `DELETE /api/v1/namespaces/:namespace` | `204` or `404`; takes the namespace's repositories with it |

A slug is lowercase alphanumerics with interior hyphens, at most 39 characters,
and may not be one of the reserved segments of the HTTP surface (`api`, `git`,
`healthz`, `static`, `well-known`). It is validated in
`packages/contracts` so clients can apply the same rule before a round trip.

```sh
curl -X POST http://localhost:1337/api/v1/namespaces \
  -H 'Content-Type: application/json' \
  -d '{"slug":"acme","displayName":"Acme, Inc."}'
```

## Repositories

A repository gets a Durable Object of its own, `RepositoryObject`, bound as
`REPOSITORIES`. A repository is what Git operations serialize on — a push has to
apply against one consistent view of the refs — and what grows without bound, so
it gets an object rather than a share of the registry.

Nothing addresses a repository object by name. Creating one mints a Durable
Object id, and the registry stores that id in a `repositories` row keyed by
`(namespace, name)`: the namespace object points at the repository object, and
resolving `acme/demo` is one lookup in the registry followed by a stub. Naming
therefore lives entirely in the registry, so a future rename or transfer moves a
row and not a byte of Git data.

The split is metadata against contents. The registry row holds what the API
answers with, which keeps listing a namespace one query instead of a fan-out of
RPCs. The repository object holds what Git owns — today that is only `HEAD`,
because a bare repository has one from `git init` and before its first ref. Both
are written when the repository is created.

`HEAD` is stored the way Git stores it: the literal bytes of the `.git/HEAD`
file — `ref: refs/heads/main\n` when symbolic, a bare 40-hex object id when
detached — under one key in the object's synchronous KV storage. The API's
`default_branch` is parsed back out of it, so a repository has one authority for
`HEAD` rather than a branch column beside it, and a detached `HEAD` needs no
schema change to be expressible. See
[ADR-0003](./docs/adr/0003-head-is-the-literal-git-file.md). The registry's
`repositories.default_branch` stays what it already was — a denormalized copy
that keeps listing a namespace one query.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/v1/namespaces/:namespace/repos` | `201` with a `Location` header, `404` if the namespace is unknown, `409` if the name is taken, `400` if the body is invalid |
| `GET /api/v1/namespaces/:namespace/repos` | `200` with `{ "repositories": [...] }`, ordered by name, `404` if the namespace is unknown |
| `GET /api/v1/namespaces/:namespace/repos/:repo` | `200` or `404` |
| `DELETE /api/v1/namespaces/:namespace/repos/:repo` | `204` or `404`; discards the repository object's storage |

A name is lowercase alphanumerics with interior dots, underscores, and hyphens,
at most 100 characters, and may not end in `.git` — `/git/:namespace/:repo.git`
appends that suffix itself. `defaultBranch` defaults to `main` and is checked
against a conservative subset of `git check-ref-format`.

Deleting a namespace deletes its repositories in the same transaction and hands
back the object ids, which the route then discards; an index row and the object
it points at are never removed by the same layer.

```sh
curl -X POST http://localhost:1337/api/v1/namespaces/acme/repos \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","description":"Anvil firmware"}'
```

## Git Smart HTTP

A repository's remote is `/git/:namespace/:repo.git`, and the first thing any
Git client asks it for is an **advertisement**: the refs the server holds and
the capabilities it supports. The push side of that is implemented.

```sh
curl 'http://localhost:1337/git/acme/demo.git/info/refs?service=git-receive-pack'
```

```text
001f# service=git-receive-pack
0000
00950000000000000000000000000000000000000000 capabilities^{}\0report-status side-band-64k …
0000
```

A repository with no refs answers with the zero-id `capabilities^{}` line rather
than an empty body, which is how a client tells a fresh repository from a server
that failed to answer. Refs are advertised in byte order by full name, with the
capabilities hung off the first line. `HEAD` is not advertised and annotated
tags are not peeled — both belong to the upload-pack advertisement.

| Capability | Why |
| --- | --- |
| `report-status` | Per-ref accept or reject, which is how a push reports anything at all |
| `side-band-64k` | Progress and errors alongside the response |
| `ofs-delta` | Offset deltas in the pack |
| `no-thin` | Never send a delta whose base is not in the pack |
| `object-format=sha1` | The only hash we store |
| `agent=open-relic/<version>` | Identifies the server in a client's trace |

`delete-refs`, `atomic`, `push-options`, and `report-status-v2` are deliberately
absent: an unadvertised capability is how a client learns not to use one, and
advertising something we do not honor is worse than not advertising it.

The path from a request to a repository is: the Worker resolves
`namespace/repo` in the registry, passes an authorization seam, and calls a
named RPC method on the repository object, which returns a stream of pkt-lines.
`RepositoryObject`'s `fetch` handler is not part of that path and answers `501`.
See [ADR-0004](./docs/adr/0004-git-reaches-a-repository-over-rpc.md).

There are no credentials yet, so pushes are refused unless the installation sets
`ALLOW_ANONYMOUS_WRITE="true"`. An unset variable is a refusal rather than a
default — an installation that has never heard of it is closed, not open to the
world. Repo-scoped tokens replace it.

```sh
ALLOW_ANONYMOUS_WRITE=true bun run deploy
```

Refs live in a `refs` table in the repository object rather than as Git's loose
files plus `packed-refs`: that split exists because of a filesystem, and a push
has to move several refs in one transaction. Nothing writes to it yet — the
advertisement is a read of an empty ref store until push lands.

## Database

Drizzle is the ORM. Each Durable Object class has its own storage, so each has
its own schema, its own drizzle-kit config, and its own migrations folder:

| Object | Schema | Migrations |
| --- | --- | --- |
| `NamespaceRegistryObject` | `apps/api/src/db/registry-schema.ts` | `apps/api/drizzle/registry/` |
| `RepositoryObject` | `apps/api/src/db/repository-schema.ts` | `apps/api/drizzle/repository/` |

```sh
bun run db:generate    # drizzle-kit generate, once per config
```

That writes the SQL, a snapshot, and a `migrations.js` bundle — all **committed**.
There is no network-connected database to push to, so each Durable Object applies
its own migrations: it builds `drizzle(ctx.storage)` and calls the
`durable-sqlite` migrator inside `blockConcurrencyWhile`, so no request can reach
a half-migrated schema, on first start or after an eviction. `migrations.js`
imports each `.sql` file directly; Alchemy's bundler maps `.sql` to a text module
for exactly this case, so no wrangler-style `rules` config or codegen step is
needed.

Both objects are thin RPC shells over plain classes — `NamespaceRegistry` and
`RepositoryIndex` over the registry's database, `RepositoryStore` over a
repository's — each of which takes any synchronous drizzle SQLite database.
Tests construct one over `bun:sqlite` and migrate it from the same `drizzle/`
folder, so the queries and the generated schema run for real without a Workers
runtime — the only thing the tests skip is the RPC hop.

Git files are the exception to the schema. `RepositoryStore` also takes the
synchronous KV half of the same storage, because `HEAD` is stored as the file
Git writes rather than as columns; the tests hand it a `Map`. KV and SQL are one
SQLite database inside the object, so a row and a file written in the same
storage turn commit together.

The registry's transactions run synchronously (`.all()` rather than `await`)
because the driver is synchronous: a transaction body that yielded would commit
before it finished.

## Infrastructure

`alchemy.run.ts` is the only description of the deployed system. It declares the
`Api` Worker (bundled from `apps/api/src/index.ts`), the `Namespaces` and
`Repositories` Durable Object namespaces bound to it as `NAMESPACES` and
`REPOSITORIES`, and Workers Observability. There is no `wrangler.toml`; Alchemy
owns the Worker script, bindings, migrations, and `workers.dev` subdomain. It
creates new Durable Object classes as `new_sqlite_classes`, which is where both
objects' SQLite storage comes from.

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

Alongside the endpoints above, routes for forks, imports, tokens, repository
contents, archives, the upload-pack advertisement, and both pack transfers are
registered from the manifest in `packages/contracts/src/index.ts`, answer `501`,
and are covered by tests.
