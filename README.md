# Open Relic

An open-source, self-hostable implementation of
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) — versioned,
Git-speaking storage — built on Cloudflare Durable Objects and running on your
own Cloudflare account.

Compatibility is the specification, not a feature: a client written against
Artifacts should work against an installation with nothing changed but the host.
[ADR-0001](./docs/adr/0001-wire-compatible-with-cloudflare-artifacts.md) records
what that binds us to, and where the API does not match yet.

`git push`, `git clone`, `git fetch` (protocol v1 and v2), repository forks, and
public HTTPS imports work. The namespace, repository, token, and content APIs are
implemented; the remaining endpoints in the manifest answer `501`.

## Architecture

An installation is a single Cloudflare Worker in front of two SQLite-backed
Durable Object classes.

```text
Git / REST client
        │
        ▼
  Worker (Hono)            apps/api/src/app.ts
   ├── REST routes         v4 envelope, bearer API token
   └── Git Smart HTTP      /git/:namespace/:repo.git, art_v1_… Git tokens
        │  RPC (streams cross this boundary)
        ├──────────────► NamespaceRegistryObject   one per installation
        │                namespaces, repository index, Git tokens
        └──────────────► RepositoryObject          one per repository
                         HEAD, refs, objects, deltas, sweep state
```

- **Worker** — Hono router. Authorizes the request, resolves `namespace/repo` in
  the registry, and calls a named RPC method on the repository object. Owns the
  Cloudflare v4 response envelope; Git responses are pkt-lines rather than JSON.
- **`NamespaceRegistryObject`** (`NAMESPACES`, fixed name `registry`) — every
  namespace in the installation, plus the `(namespace, name)` → repository object
  id index and the Git tokens. One object, because allocating a slug has to be a
  single serialized decision and listing has to see all of them.
- **`RepositoryObject`** (`REPOSITORIES`) — one per repository, addressed only by
  the id stored in the registry. Holds what Git owns and what grows without
  bound. Naming lives entirely in the registry, so a rename moves a row and not a
  byte of Git data. See
  [ADR-0004](./docs/adr/0004-git-reaches-a-repository-over-rpc.md).

### Storage

Each Durable Object class has its own Drizzle schema, drizzle-kit config, and
committed migrations, applied by the object itself inside
`blockConcurrencyWhile`.

| Object                    | Schema                                 | Migrations                     |
| ------------------------- | -------------------------------------- | ------------------------------ |
| `NamespaceRegistryObject` | `apps/api/src/db/registry-schema.ts`   | `apps/api/drizzle/registry/`   |
| `RepositoryObject`        | `apps/api/src/db/repository-schema.ts` | `apps/api/drizzle/repository/` |

Git bytes are the exception to the schema. `HEAD` is stored as the literal bytes
of the `.git/HEAD` file
([ADR-0003](./docs/adr/0003-head-is-the-literal-git-file.md)); object bytes,
pack representations, and retained deltas are chunked KV values beside the SQL
rows that describe them
([ADR-0002](./docs/adr/0002-git-objects-are-chunked-rows-in-the-repository-object.md),
[ADR-0006](./docs/adr/0006-resolved-objects-and-pack-representations-are-a-hybrid.md)).
KV and SQL are one SQLite database inside the object, so a row and a file written
in the same storage turn commit together.

### Git modules

Packs are read and written in a single streaming pass, so peak residency is one
object rather than one pack.

| Module                     | What it is                                                     |
| -------------------------- | -------------------------------------------------------------- |
| `src/pack.ts`              | Pack reader: entry headers, `ofs-delta`/`ref-delta`, checksum  |
| `src/object-store.ts`      | Objects as chunked rows, and the sink a pack is read into      |
| `src/connectivity.ts`      | What an object names, and the reachability walks over that     |
| `src/inflate.ts`           | A resumable zlib decompressor                                  |
| `src/sha1.ts`              | Incremental SHA-1                                              |
| `src/delta.ts`             | Git's copy/insert delta encoding                               |
| `src/git/pkt-line.ts`      | Git's framing, written and read                                |
| `src/git/receive-pack.ts`  | The push conversation: commands in, `report-status` out        |
| `src/git/upload-pack.ts`   | Fetch negotiation and the streaming pack writer                |
| `src/git/remote-branch.ts` | Credentialless Smart HTTP discovery and outbound branch fetch  |
| `src/sweep.ts`             | Reachability sweep, orphan reclamation, delta selection        |
| `src/repository-store.ts`  | The order all of it happens in, and the transaction at the end |

### Monorepo

```text
.
├── alchemy.run.ts                 # The only description of the deployed system
├── drizzle.config.ts              # drizzle-kit output for the registry object
├── drizzle.repository.config.ts   # drizzle-kit output for a repository object
├── apps/api                       # Worker, Durable Objects, Git implementation
├── packages/contracts             # Shared endpoint manifest and response types
└── docs/adr                       # Architecture decisions
```

`packages/contracts` names the implemented endpoints in
`IMPLEMENTED_ENDPOINT_IDS`. The router skips stub registration for those ids and
the test suite asserts `501` for the complement, so the manifest, the router, and
the tests cannot drift apart.

`alchemy.run.ts` declares the Worker, both Durable Object namespaces,
observability, and CPU limits — there is no `wrangler.toml`. Its exported
`ApiEnv` types `context.env` in the router, so bindings and RPC methods are typed
at the call site.

## Development

Requires [Bun](https://bun.sh/) and a Cloudflare account for Alchemy commands.

```sh
bun install
bun run check      # typecheck, lint, format, test
bun run dev
```

Authenticate once, then deploy:

```sh
bun alchemy login   # or copy .env.example to .env and use an API token
bun run deploy
```

Every command takes `--stage`, and Alchemy derives a distinct Worker name and
Durable Object namespaces per stage, so stages never share state. `--stage`
defaults to `dev_$USER`. CI deploys the `prod` stage from `main`.

Protected routes require `Authorization: Bearer $OPEN_RELIC_API_TOKEN`; generate
it with `openssl rand -hex 32`. An unset or too-short value fails closed —
`/healthz` is the only unauthenticated endpoint and reports `503` in that case.

`bun test` requires `git` on `PATH`. Tests run the Hono application in-process
against `bun:sqlite` and a real Git binary, so they cover the router, protocol,
pack reader, and migrations, but not the Workers runtime or the RPC hop.

## Documentation

- [CONTEXT.md](./CONTEXT.md) — the domain vocabulary shared by the API, the Git
  protocol, and the storage beneath both
- [docs/adr](./docs/adr) — architecture decisions
- [Cloudflare smoke-testing runbook](./docs/cloudflare-smoke-testing.md) —
  exercise a real stage with real Git repositories
- [Git host benchmarking runbook](./docs/git-host-benchmarking.md) — compare
  against GitHub and hosted Artifacts
- [AGENTS.md](./AGENTS.md) — guide for coding agents

## License

Open Relic is available under the [MIT License](./LICENSE).
