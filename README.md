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

## Development

Requires [Bun](https://bun.sh/) and a Cloudflare account for Alchemy commands.

```sh
bun install
bun run check
bun run plan
bun run dev
```

Deploy after configuring an Alchemy Cloudflare profile:

```sh
bun alchemy login
bun run deploy
```

`GET /healthz` is the only successful application endpoint. It returns:

```json
{ "service": "open-relic", "status": "ok" }
```

All routes supplied for namespaces, repositories, tokens, repository contents,
archives, and Git upload/receive pack are registered from the manifest in
`packages/contracts/src/index.ts` and covered by tests.
