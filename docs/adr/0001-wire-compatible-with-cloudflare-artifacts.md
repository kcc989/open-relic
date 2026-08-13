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

- **REST API** — `https://api.cloudflare.com/client/v4/accounts/:accountId/artifacts/…`,
  the Cloudflare v4 envelope (`{result, success, errors, messages}`, `result_info`
  for pagination), and v4-shaped errors (`{code, message}`), not RFC 9457.
- **Git Smart HTTP** — `https://<host>/git/:namespace/:repo.git`. Fetch negotiates
  protocol v1 or v2; push is v1 only, matching Artifacts, which does not support
  receive-pack over v2. `filter` and `include-tag` are unsupported there, so they
  are unsupported here.

Repo-scoped bearer tokens are the Git credential: `art_v1_<40 hex>?expires=<unix
seconds>`, presented as `Authorization: Bearer …` or as HTTP Basic `x:<secret>`,
with `read` and `write` scopes.

The Workers binding is the third Artifacts surface. It is out of scope until the
REST and Git surfaces are complete, because it is the one a self-hoster can most
easily replace with a `fetch` to their own installation.

## Consequences

The API implemented so far predates this decision and does not match. The gap is
known and deliberate — the namespace and repository work was about Durable Object
shape, not about the wire — but it has to close before anything depends on it:

| | Open Relic today | Artifacts |
| --- | --- | --- |
| Base path | `/api/v1/namespaces/…` | `/client/v4/accounts/:accountId/artifacts/namespaces/…` |
| Body | bare JSON (`{"namespaces": […]}`) | v4 envelope |
| Errors | RFC 9457 `application/problem+json` | `errors: [{code, message}]` |
| Namespaces | created and deleted explicitly | created implicitly with the first repo; list and get only |
| Repo create | repository metadata | `{id, name, description, default_branch, remote, token}` — mints a token, returns the clone URL |
| Repo delete | `204` | `202` with `{id}` |
| Repo fields | — | `id`, `read_only` |
| Contents | `commits/:hash`, `trees/:hash`, `blobs/:hash`, `files/*` | `commit/:hash`, `tree/:hash`, `blob/:hash`, `file?ref=&path=`, `raw/:ref/:path` |
| Tokens | `POST …/repos/:repo/tokens` | `POST …/namespaces/:namespace/tokens` with `{repo, scope?, ttl?}`; revoke by id |
| Git remote | `/git/:namespace/:repo.git` | same |

`archive/*` is ours, not theirs. Extensions are allowed — an installation may
serve more than Artifacts does — but never at the cost of a documented behavior,
and never on a path Artifacts has spoken for.

## The account ID segment

An installation is single-tenant, so `/client/v4/accounts/:accountId/artifacts/…`
names an account that does not exist here. The segment stays anyway, and its
value is ignored: any account ID resolves to the one tenant. The client is what
builds that path — Wrangler, the SDKs, every documented `curl` — so dropping the
segment would mean no Artifacts client could reach an installation without being
modified, which is the one thing this ADR exists to prevent.

The Git remote is the mirror image. Artifacts hands it to the caller in the repo
create response rather than having the caller construct it, so its host is ours
to choose; only the `/git/:namespace/:repo.git` path shape has to match, and it
already does.

Artifacts' documented limits are the ones worth designing against: 10 GB per
repository, 1 TB per account, 2,000 requests per 10 seconds per namespace for the
control plane and per artifact for Git.
