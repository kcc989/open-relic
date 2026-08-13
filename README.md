# Open Relic

An open-source, self-hostable implementation of
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) — versioned,
Git-speaking storage — built on Cloudflare Durable Objects and running on your
own Cloudflare account, with no access to the Artifacts product.

Compatibility is the specification, not a feature: a client written against
Artifacts should work against an installation with nothing changed but the host.
[ADR-0001](./docs/adr/0001-wire-compatible-with-cloudflare-artifacts.md) records
what that binds us to, and where the API below does not match yet.

**`git push`, `git clone`, and `git fetch` work.** The namespace and repository
APIs are implemented, and a Git client can round-trip branches over authenticated
Git Smart HTTP. Everything else — contents, forks, and imports — is still a
registered route that answers `501`:

- Hono routes for every REST and Git Smart HTTP endpoint in the initial API
- Effect v4 as the typed stub service boundary
- Drizzle as the ORM over Durable Object SQLite, with generated migrations
- Alchemy v2 for the Cloudflare Worker and SQLite-backed Durable Objects
- Bun workspaces for the API app and shared endpoint contracts
- The Cloudflare v4 envelope on every response, success or failure

## The wire

Artifacts documents its REST routes relative to `/accounts/$ACCOUNT_ID`, hung off
`https://api.cloudflare.com/client/v4`. An installation is single-tenant and is
nothing but Artifacts, so it serves the same endpoints at the root — `POST
/namespaces/:namespace/repos`, not `POST
/client/v4/accounts/:id/artifacts/namespaces/:namespace/repos`. Everything from
`/namespaces` rightward matches Artifacts exactly, as does every body, field
name, status code, and error shape. The base URL is the one thing a client
changes, which is the same thing it already changes for the host.

Every JSON response is the v4 envelope:

```json
{ "result": {}, "success": true, "errors": [], "messages": [] }
```

Every route rooted at `/namespaces` is the installation's control plane and
requires `Authorization: Bearer $OPEN_RELIC_API_TOKEN`. Configure the same long,
random value on the Worker and in the client. This installation API token is
distinct from the short-lived, repo-scoped `art_v1_…` tokens used by Git; an
unset installation token closes the control plane rather than opening it.

A failure keeps the shape and moves into `errors`, using
[Artifacts' documented codes](https://developers.cloudflare.com/artifacts/api/errors/):

```json
{
  "result": null,
  "success": false,
  "errors": [{ "code": 10200, "message": "No namespace named \"nope\" exists." }],
  "messages": []
}
```

A rejected field carries a JSON pointer at it in `errors[].source.pointer`.

Lists answer with a bare array in `result` and their paging state beside it in
`result_info`. Cursors are keyset, not offset — the cursor carries the sort key
of the last row handed out — so a repository created mid-walk cannot shift rows
onto a page the client has already seen. `cursor` is empty once the last page has
been handed out.

A cursor names a position in one ordering of one filtered set, so it also
carries the `sort`, `direction`, and `search` it was issued under. Replaying it
against a different query is a `400`, not a quietly different page: comparing a
stored `created_at` against a name would let every row through and hand back
page one again under a fresh cursor. A cursor the service did not issue is a
`400` for the same reason — an empty page would be indistinguishable from a
finished list.

```json
{ "result_info": { "cursor": "eyJ2IjoiLi4uIn0", "per_page": 20, "count": 20 } }
```

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

Artifacts creates a namespace implicitly with its first repository and documents
only list and get. Explicit create and delete are ours; they sit on methods
Artifacts has not spoken for on those paths.

| Endpoint                         | Behavior                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /namespaces`               | `201` with a `Location` header, `409` if the slug is taken, `400` if the body is invalid |
| `GET /namespaces?limit=&cursor=` | `200`, ordered by slug, with `result_info`                                               |
| `GET /namespaces/:namespace`     | `200` or `404`                                                                           |
| `DELETE /namespaces/:namespace`  | `200` with `{ "slug": … }` or `404`; takes the namespace's repositories with it          |

The delete answers `200`, not the `202` a repository delete answers, because it
really has finished: the index rows and the objects behind them are gone by the
time it replies.

A slug is lowercase alphanumerics with interior hyphens, at most 39 characters,
and may not be one of the reserved segments of the HTTP surface (`api`, `git`,
`healthz`, `static`, `well-known`). It is validated in
`packages/contracts` so clients can apply the same rule before a round trip.

```sh
curl -X POST http://localhost:1337/namespaces \
  -H "Authorization: Bearer $OPEN_RELIC_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"acme","display_name":"Acme, Inc."}'
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

| Endpoint                                                                   | Behavior                                                                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /namespaces/:namespace/repos`                                        | `200` with `{id, name, description, default_branch, remote, token}`, `404` if the namespace is unknown, `409` if the name is taken, `400` if the body is invalid |
| `GET /namespaces/:namespace/repos?limit=&cursor=&search=&sort=&direction=` | `200` with `result_info`, `404` if the namespace is unknown                                                                                                      |
| `GET /namespaces/:namespace/repos/:repo`                                   | `200` or `404`                                                                                                                                                   |
| `DELETE /namespaces/:namespace/repos/:repo`                                | `202` with `{ "id": … }` or `404`; discards the repository object's storage                                                                                      |

A create answers with a deliberately narrower shape than a list or get: the
identity, the remote to clone from, and the one token it will not show again.
List and get carry the full `RepoInfo` — `id`, `name`, `description`,
`default_branch`, `created_at`, `updated_at`, `last_push_at`, `source`,
`read_only` — plus `remote`. `last_push_at` is stamped by a push that moved a
ref; `source` stays `null` until import exists to write it.

`sort` is one of `created_at`, `updated_at`, `last_push_at`, or `name`,
defaulting to `created_at` descending. `search` filters on an infix of the name.
`limit` defaults to 50 and caps at 200.

The remote is built from the host the request arrived on, so an installation
advertises whatever host the client actually reached it at. The returned token
is a persisted, write-scoped `art_v1_<40 hex>?expires=<unix seconds>` token for
that repository. Only its SHA-256 digest is stored; its plaintext is returned
once in the create response and cannot be recovered later.

A name is lowercase alphanumerics with interior dots, underscores, and hyphens,
at most 100 characters, and may not end in `.git` — `/git/:namespace/:repo.git`
appends that suffix itself. `default_branch` defaults to `main` and is checked
against a conservative subset of `git check-ref-format`.

Deleting a namespace deletes its repositories in the same transaction and hands
back the object ids, which the route then discards; an index row and the object
it points at are never removed by the same layer.

```sh
curl -X POST http://localhost:1337/namespaces/acme/repos \
  -H "Authorization: Bearer $OPEN_RELIC_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","description":"Anvil firmware"}'
```

## Tokens

Tokens are repo-scoped Git credentials with `read` or `write` scope and an
expiry. They live in the registry so a Git request can be refused before the
repository is resolved. Revocation is retained as state for token listings;
deleting a repository or namespace cascades to its tokens.

| Endpoint                                                               | Behavior                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /namespaces/:namespace/tokens`                                   | Mints for the body’s `repo`; defaults to write scope and a 24-hour TTL |
| `GET /namespaces/:namespace/repos/:repo/tokens?state=&per_page=&page=` | Lists metadata and offset pagination; never returns plaintext          |
| `DELETE /namespaces/:namespace/tokens/:id`                             | Revokes the token and returns `{ "id": … }`                            |

```sh
curl -X POST http://localhost:1337/namespaces/acme/tokens \
  -H "Authorization: Bearer $OPEN_RELIC_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"repo":"demo","scope":"write","ttl":3600}'
```

## Git Smart HTTP

A repository's remote is `/git/:namespace/:repo.git`, and the first thing any
Git client asks it for is an **advertisement**: the refs the server holds and
the capabilities it supports. The push side of the protocol is implemented, from
that advertisement through to the refs a push moves.

```sh
curl 'http://localhost:1337/git/acme/demo.git/info/refs?service=git-receive-pack' \
  -H "Authorization: Bearer $OPEN_RELIC_TOKEN"
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

| Capability                   | Why                                                                   |
| ---------------------------- | --------------------------------------------------------------------- |
| `report-status`              | Per-ref accept or reject, which is how a push reports anything at all |
| `side-band-64k`              | Progress and errors alongside the response                            |
| `ofs-delta`                  | Offset deltas in the pack                                             |
| `no-thin`                    | Never send a delta whose base is not in the pack                      |
| `object-format=sha1`         | The only hash we store                                                |
| `agent=open-relic/<version>` | Identifies the server in a client's trace                             |

`delete-refs`, `atomic`, `push-options`, and `report-status-v2` are deliberately
absent: an unadvertised capability is how a client learns not to use one, and
advertising something we do not honor is worse than not advertising it.

An advertisement is Git's protocol rather than JSON, so it is the one response
that is not a v4 envelope. Failures on this path still are — a Git client reads
the status code and little else, and there is no reason for a second error
shape.

The path from a request to a repository is: the Worker authorizes the token for
`namespace/repo`, resolves that name in the registry, and calls a named RPC
method on the repository object, which returns a stream of pkt-lines.
`RepositoryObject`'s `fetch` handler is not part of that path and answers `501`.
See [ADR-0004](./docs/adr/0004-git-reaches-a-repository-over-rpc.md).

Bearer authentication uses the full token returned by the REST API. HTTP Basic
uses any non-empty username and the token secret — the `art_v1_…` half before
`?expires=` — as its password. A push requires write scope; missing, expired,
revoked, read-scoped, or differently repo-scoped tokens are refused before the
repository lookup.

```sh
git -c http.extraHeader="Authorization: Bearer $OPEN_RELIC_TOKEN" \
  push "$OPEN_RELIC_REMOTE" HEAD:main
```

Refs live in a `refs` table in the repository object rather than as Git's loose
files plus `packed-refs`: that split exists because of a filesystem, and a push
has to move several refs in one transaction.

## Push

`POST /git/:namespace/:repo.git/git-receive-pack` is the other half. The body is
the client's ref update commands as pkt-lines, then a flush, then the pack; the
response is `report-status`, one line per ref.

```text
0000000000000000000000000000000000000000 <new> refs/heads/main\0report-status side-band-64k …
0000
PACK…
```

```text
000eunpack ok
0017ok refs/heads/main
0000
```

A push is read in one pass by `RepositoryStore.receivePack`, and the order is
the design:

1. **Read the commands.** The capabilities travel on the first one and apply to
   the whole push.
2. **Screen each command** against the refs we hold — deletes, malformed names,
   a ref named twice, a create of something that exists, an update from a value
   the ref no longer has. This is pure policy and lives in `git/receive-pack.ts`
   with the rest of the wire; nothing here reads storage.
3. **Read the pack** into the object store, streaming. A push whose commands are
   all deletes carries no pack, so none is waited for.
4. **Walk what the push claims.** From each new ref value, out through commits,
   trees, and tags, confirming the repository holds every one. The walk stops at
   objects a previous push already proved, so the cost of a push is
   proportional to what it added rather than to the history.
5. **Check the fast-forward.** A commits-only walk back from the new tip looking
   for the old one.
6. **Move the refs**, all of them and any HEAD rewrite, in one transaction.

**Blobs are skipped in the walk.** They are the expensive half of any real
repository — most of the objects and nearly all of the bytes — and a pack that
parsed completely already implies them: every entry was inflated, hashed, and
written. What the walk is looking for is the shape a truncated or hand-made pack
gets wrong, which is a commit or tree naming something that was never sent.

Objects written by a push that then fails are left in place. A ref is the only
thing that makes an object reachable, so orphans are a storage cost rather than
a correctness problem; sweeping them is separate work.

**Deletes and non-fast-forward updates are rejected**, per-command, in
`report-status` — matching the advertisement, which offers neither `delete-refs`
nor any way to force. A client that sends one anyway is told so rather than
quietly ignored.

| `ng` reason                                 | When                                              |
| ------------------------------------------- | ------------------------------------------------- |
| `deleting a ref is not supported`           | The new value is the zero id                      |
| `non-fast-forward`                          | The old tip is not behind the new one             |
| `missing necessary objects`                 | The connectivity walk found a gap                 |
| `the ref has moved since it was advertised` | The old value is not what we hold                 |
| `funny refname`                             | Not under `refs/`, or not a name Git would create |
| `n/a (unpacker error)`                      | The pack could not be read; `unpack` says why     |

HEAD retargets in exactly one case: the repository held no refs at all and the
push created exactly one branch. That is `git init && git push -u origin master`
against a repository created with a different default, where a HEAD naming a
branch nobody will push is a repository no clone can check out. Any other push
leaves it alone — which branch a repository is _for_ is not a push's to decide
once there is anything to decide between. The registry's `default_branch` and
`last_push_at` are stamped afterwards, outside the transaction: they are copies
for the REST surface, and a stamp that fails leaves them stale rather than
leaving a ref half-moved.

The Worker's CPU ceiling is five minutes, which is what a first push of a real
repository needs and what the fast-forward walk is budgeted against — proving a
push is _not_ a fast-forward means reading every commit the new tip reaches, so
it gives up after `FAST_FORWARD_COMMIT_BUDGET` commits and says so on the
progress band rather than being killed mid-request.

## Clone and fetch

Upload-pack advertises `HEAD` and the repository's refs, then walks the closure
of each `want` and subtracts the closure of the client's `have` lines. A clone
therefore receives the full reachable repository, while an incremental fetch
receives only the objects added since its common base.

The response is generated as it is pulled: the pack header, one object or delta
at a time, then the incremental SHA-1 trailer. It crosses the repository RPC
boundary and the Worker as a `ReadableStream`; no complete pack is assembled in
memory. Objects are currently zlib-framed with stored deflate blocks. That is a
valid Git pack and keeps the writer runtime-portable; choosing a compression
strategy is a later performance change rather than a wire change.

When the requesting client has a persisted delta's base and negotiated
`thin-pack`, upload-pack emits the stored delta as a `ref-delta` instead of
inflating the full object onto the wire. If the base is not among the client's
reachable `have` objects, the resolved object is sent whole.

Protocol v1 is supported explicitly: a request carrying `Git-Protocol:
version=1` receives the `version 1` marker before the advertisement. Protocol v2
is deferred. A v2 request receives the truthful v0 advertisement, so Git
automatically falls back instead of being promised `ls-refs` or v2 `fetch`.
Shallow and deepen capabilities are likewise unadvertised until their graph
boundaries are implemented. `filter` and `include-tag` remain unsupported,
matching Artifacts.

## Objects and packs

`readPack` is what a push is built on: it takes the byte stream of a Git pack and
leaves the repository holding every object the pack carried, named by SHA-1.
Streams cross the RPC boundary, so a pack reaches the object without the Worker
buffering it.

Objects are stored inflated: metadata in the `objects` table, bytes in the
object's synchronous KV storage under `o:<oid>:<n>`, split into 1.5 MiB chunks
because Durable Object storage caps a key and its value together at 2 MB. When
an object arrived as a **delta**, the raw delta goes under `d:<oid>:<n>` with its
base's hash in `object_deltas`; upload-pack reuses it when the client already has
that base. The incoming pack passes through our hands exactly once. See
[ADR-0002](./docs/adr/0002-git-objects-are-chunked-rows-in-the-repository-object.md).

The parse is a single streaming pass, and that is the whole point of storing
objects this way. Each resolved object is written the moment it is complete, so
a delta resolves by reading its base back out of storage rather than by holding
the pack in memory: peak residency is one object, one base, and one stream
chunk, independent of pack size. `apps/api/test/pack.test.ts` measures that
directly — a pack four times longer is read with no more in flight. A rewrite
that buffered the pack would pass every other test and lose the reason the store
looks like this.

| Module                    | What it is                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/pack.ts`             | The pack reader: entry headers, `ofs-delta` and `ref-delta` resolution, the trailing checksum              |
| `src/object-store.ts`     | Objects as chunked rows, and the sink the pack is read into                                                |
| `src/connectivity.ts`     | What a commit, tree, or tag names, and the walks that answer "is it all here" and "is this a fast-forward" |
| `src/inflate.ts`          | A resumable zlib decompressor                                                                              |
| `src/sha1.ts`             | Incremental SHA-1                                                                                          |
| `src/delta.ts`            | Git's copy/insert delta encoding                                                                           |
| `src/git/pkt-line.ts`     | Git's framing, written and read — and the hand-off from the commands to the pack behind them               |
| `src/git/receive-pack.ts` | The push conversation: commands in, `report-status` out, and what this server accepts                      |
| `src/git/upload-pack.ts`  | Fetch negotiation, reachability subtraction, and the streaming pack writer                                 |
| `src/repository-store.ts` | The order all of it happens in, and the transaction at the end                                             |

`DecompressionStream("deflate")` cannot do this job: a pack is a concatenation
of zlib streams with no length prefix, so the next object can only be found by
being told how many input bytes the last stream consumed, which the platform
stream hides. `crypto.subtle.digest` is likewise whole-buffer only, and the
pack's trailing checksum covers a stream we never buffer. Both are hand-written
for that reason and for no other.

Residency is bounded rather than merely small, because every size in a pack is a
number the sender chose and is read before a byte of the object arrives. An
entry declaring more than `MAX_OBJECT_BYTES`, and a delta declaring a result
larger than that, are refused on the header — before the buffer is allocated, so
the answer is an `object-too-large` rejection rather than the runtime killing
the object. The limit is 32 MiB because resolving a delta holds three of these
at once; lifting it means inflating whole objects straight into chunks instead
of into one buffer, since only a delta's base genuinely has to be resident.

Both delta encodings resolve, including chains several deep. Thin packs are out
of scope, which is what advertising `no-thin` promises the client: a delta whose
base is nowhere is a `missing-base` error rather than a case to handle.

Failures are a `PackError` with a code, and the code is a Git fact rather than
an HTTP one — the object owns Git and the Worker owns the envelope, so push maps
these onto Artifacts' documented codes when it lands:

| `PackError.code`                                                                                                   | Artifacts code         |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `object-too-large`                                                                                                 | `memoryLimit` (10402)  |
| `not-a-pack`, `unsupported-version`, `truncated`, `checksum-mismatch`, `trailing-bytes`, `missing-base`, `corrupt` | `invalidInput` (10100) |

That `memoryLimit` exists in Artifacts' own list is the corroboration for the
ceiling above: refusing an object too big to hold is a documented answer, not an
invention of ours.

`apps/api/test/fixtures` holds packs written by a real Git client, alongside the
object ids that client reported; `fixtures/generate.sh` rebuilds them. Agreeing
with Git about what its own objects are called is the only test that matters
here, so it runs against both delta encodings.

## Database

Drizzle is the ORM. Each Durable Object class has its own storage, so each has
its own schema, its own drizzle-kit config, and its own migrations folder:

| Object                    | Schema                                 | Migrations                     |
| ------------------------- | -------------------------------------- | ------------------------------ |
| `NamespaceRegistryObject` | `apps/api/src/db/registry-schema.ts`   | `apps/api/drizzle/registry/`   |
| `RepositoryObject`        | `apps/api/src/db/repository-schema.ts` | `apps/api/drizzle/repository/` |

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

Git bytes are the exception to the schema. `RepositoryStore` also takes the
synchronous KV half of the same storage, because `HEAD` is stored as the file
Git writes rather than as columns, and because an object's bytes are chunks
rather than a column; the tests hand it a `Map` that structured-clones the way
the real thing does. KV and SQL are one SQLite database inside the object, so a
row and a file written in the same storage turn commit together.

The registry's transactions run synchronously (`.all()` rather than `await`)
because the driver is synchronous: a transaction body that yielded would commit
before it finished.

## Infrastructure

`alchemy.run.ts` is the only description of the deployed system. It declares the
`Api` Worker (bundled from `apps/api/src/index.ts`), the `Namespaces` and
`Repositories` Durable Object namespaces bound to it as `NAMESPACES` and
`REPOSITORIES`, Workers Observability, and a five-minute CPU limit. There is no
`wrangler.toml`; Alchemy owns the Worker script, bindings, migrations, and
`workers.dev` subdomain. It creates new Durable Object classes as
`new_sqlite_classes`, which is where both objects' SQLite storage comes from.

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

To deploy an isolated stage and exercise the real Workers and Durable Objects
runtime with real Git repositories, follow the
[Cloudflare smoke-testing runbook](./docs/cloudflare-smoke-testing.md). Its
script removes all temporary clones on exit and destroys the smoke stage by
default.

### Test coverage

`bun test` requires `git` on `PATH` and fails at startup when it is missing. The
real-client tests serve the runtime-agnostic Hono application over a local HTTP
socket, create a repository through the same application, and have a real Git
binary push into it. Git's receive-pack report and a second advertisement prove
that a commit moves its ref, while a forced non-fast-forward push is rejected
without moving it. Pkt-line encoding and pack reading remain independently
covered by table-driven tests, including pack fixtures generated by Git itself.

This does not run inside the Workers runtime. It covers the router, protocol,
pack reader, migrations, and repository behavior, but not the deployed
Worker-to-Durable-Object RPC hop, runtime stream transfer across that hop,
`drizzle-orm/durable-sqlite`, or `DurableObjectState.storage.kv`. The in-process
tests use Bun's Web APIs, `bun:sqlite`, and a structured-cloning Map in their
place, so Workers-specific stream, digest, and storage behavior remains
uncovered here.

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
needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and a long random
`OPEN_RELIC_API_TOKEN` as repository secrets in a `prod` environment. The
Cloudflare token needs Workers Scripts:Edit, Workers Subdomain:Edit, Workers
Observability:Edit, and Account Settings:Read.

`GET /healthz` reports liveness:

```json
{ "service": "open-relic", "status": "ok" }
```

Alongside the endpoints above, routes for forks, imports, repository
contents, archives, and both halves of upload-pack are registered from the
manifest in `packages/contracts/src/index.ts`, answer `501`, and are covered by
tests.
