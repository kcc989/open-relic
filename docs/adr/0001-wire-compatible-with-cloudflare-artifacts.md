# Open Relic is wire-compatible with Cloudflare Artifacts

Status: accepted

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) is versioned,
Git-speaking storage, and it is a closed product on Cloudflare's account plane.
Open Relic exists to be that product's API, self-hosted: a client written against
Artifacts — `git`, Wrangler, an SDK, an agent — must work against an Open Relic
installation with nothing changed but the host. Compatibility is therefore not a
feature of Open Relic, it is the specification. Where this repo's own taste and
Artifacts' documented behavior disagree, Artifacts wins.

## What that binds us to

Two surfaces, both documented:

- **REST API** — Artifacts' own paths (`/namespaces/:namespace/repos/…`, served
  at the root; see "The base path" below), the Cloudflare v4 envelope
  (`{result, success, errors, messages}`, `result_info` for pagination), and
  v4-shaped errors (`{code, message}`), not RFC 9457. The installation verifies
  the request's Bearer value against its configured API token,
  standing in for Cloudflare's account-level API token check.
- **Git Smart HTTP** — `https://<host>/git/:namespace/:repo.git`. Fetch negotiates
  protocol v1 or v2; push is v1 only, matching Artifacts, which does not support
  receive-pack over v2. `filter` and `include-tag` are unsupported there, so they
  are unsupported here.

Repository-scoped bearer Git tokens are the credential: `art_v1_<40 hex>?expires=<unix
seconds>`, presented as `Authorization: Bearer …` or as HTTP Basic `x:<secret>`,
with `read` and `write` scopes.

The Workers binding is the third Artifacts surface. It is out of scope until the
REST and Git surfaces are complete, because it is the one a self-hoster can most
easily replace with a `fetch` to their own installation.

## Consequences

The API implemented so far predated this decision and did not match. Most of the
gap is now closed — the shape of the wire is Artifacts' — and what remains is
behavior that has not been built at all rather than behavior built differently:

|              | Open Relic today                      | Artifacts                                                 |
| ------------ | ------------------------------------- | --------------------------------------------------------- |
| Namespaces   | created and deleted explicitly        | created implicitly with the first repo; list and get only |
| Contents     | routes registered, answer `501`       | serve log, objects, and files                             |
| Fork, import | routes registered, answer `501`       | copy repositories and import one remote branch            |
| `source`     | always `null` — nothing writes it yet | set by import                                             |

These closed with the reshaping of the REST surface and Git token
authorization: the path shape, the v4 envelope, `result_info` pagination,
`errors[]` in place of RFC 9457 problem
documents, the contents path spellings, token creation on the namespace, `202`
with `{id}` on repository delete, the `id`/`read_only` repository fields, and
real token issue, list, revoke, expiry, scope, and Git credential checks.

`refs` and `archive/*` are ours, not theirs, and will be removed rather than
maintained as a second content API. Ref discovery remains on Git upload-pack,
and clients create archives after fetching or mounting a working tree.
Extensions are allowed — an installation may serve more than Artifacts does —
but never at the cost of documented behavior. Explicit namespace create and
delete remain extensions on methods Artifacts does not define for those paths.

## The base path

Artifacts documents its routes relative to `/accounts/$ACCOUNT_ID`, hung off
`https://api.cloudflare.com/client/v4`. An installation serves the same
endpoints at the root instead:

| Artifacts                                                             | Open Relic                           |
| --------------------------------------------------------------------- | ------------------------------------ |
| `GET /client/v4/accounts/:id/artifacts/namespaces`                    | `GET /namespaces`                    |
| `POST /client/v4/accounts/:id/artifacts/namespaces/:namespace/repos`  | `POST /namespaces/:namespace/repos`  |
| `POST /client/v4/accounts/:id/artifacts/namespaces/:namespace/tokens` | `POST /namespaces/:namespace/tokens` |

An installation is single-tenant and is nothing but Artifacts, so
`/client/v4/accounts/<ignored>/artifacts` would be three segments of ceremony
carrying no information — an account ID naming an account that does not exist,
under a version marker for an API surface that is not Cloudflare's. Everything
from `/namespaces` rightward matches Artifacts exactly, as does every body,
field name, status code, and error shape. The base URL is the one thing a client
changes, which is the same thing it already changes for the host.

The Git remote is the mirror image. Artifacts hands it to the caller in the repo
create response rather than having the caller construct it, so its host is ours
to choose; only the `/git/:namespace/:repo.git` path shape has to match, and it
already does. An installation builds it from the host the request arrived on, so
it advertises whatever host the client actually reached it at.

Artifacts documents 10 GB per repository, 1 TB per account, and request-rate
limits. Those capacity policies are not part of the wire shape. The initial Open
Relic release deliberately uses a fixed 4 GB logical repository quota so one
repository, its retained deltas, and its metadata fit in one 10 GB SQLite-backed
Durable Object. It does not reproduce Artifacts' request-rate limits. Raising
the repository quota requires a later storage-layout decision rather than a
configuration switch that the current layout cannot honor.
