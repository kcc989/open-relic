# Cloudflare deployment smoke testing

This runbook deploys Open Relic with Alchemy to a disposable Cloudflare stage
and drives real Git clients through the Worker and Durable Objects. It covers
the runtime boundary that the Bun test suite cannot: Worker-to-Durable-Object
RPC, streamed request and response bodies, Durable Object SQLite and KV, alarms,
and production migrations.

The reusable entrypoint is [`scripts/cloudflare-smoke.sh`](../scripts/cloudflare-smoke.sh).

## Prerequisites

- Bun and Git are installed.
- `curl`, `jq`, and `openssl` are available.
- Alchemy has an authenticated Cloudflare profile (`bun alchemy login`), or the
  usual `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` variables are set.
- The Cloudflare identity can create Workers and SQLite-backed Durable Object
  namespaces, enable a `workers.dev` subdomain, query observability, and destroy
  the resources afterward.

Do not use the `prod` stage for this test. The script creates a unique stage by
default so it cannot share Durable Object state with another run.

## Run it

From the repository root:

```sh
scripts/cloudflare-smoke.sh 2>&1 | tee ".context/cloudflare-smoke-$(date -u +%Y%m%dT%H%M%SZ).log"
```

The script generates an ephemeral `OPEN_RELIC_API_TOKEN` unless one is already
set. Tokens returned by repository creation are loaded into shell variables,
passed to Git through an HTTP authorization header, and redacted from JSON
printed to the terminal. The original response bodies live only inside the
private temporary directory, are never copied into the report, and are removed
by the exit trap.

By default the script:

1. Installs the lockfile and runs the full local check.
2. Deploys `alchemy.run.ts` to a unique `smoke_<user>_<timestamp>` stage.
3. Verifies health and warm latency, anonymous rejection, invalid Git-token
   rejection, namespace creation, and repository creation over the public
   Worker URL.
4. Pushes `origin/main` from this repository, clones it, compares its SHA, and
   runs `git fsck --full`.
5. Makes a real incremental commit in a temporary clone, pushes it, and fetches
   it into a second clone.
6. Clones `honojs/hono`, records its object and pack size, pushes its full
   `main` history to Open Relic, clones it back, compares SHAs, and runs
   `git fsck --full`.
7. Samples authenticated API latency, reads post-push metadata, fetches recent
   Alchemy/Workers observability logs, and prints failed queries.
8. Removes the local test repositories and destroys the Cloudflare stage, even
   when an earlier assertion fails.

The command exits nonzero for a correctness failure, but it continues past an
incremental-fetch failure so the larger repository still supplies performance
and integrity evidence.

### Useful options

Keep the deployed stage for investigation:

```sh
OPEN_RELIC_API_TOKEN="$(openssl rand -hex 32)" \
  scripts/cloudflare-smoke.sh --keep-stage
```

Supply the token yourself when keeping a stage. Otherwise the generated token
is deliberately discarded and the retained control plane cannot be used
without redeploying it with a new token.

Use a named stage or a different real repository:

```sh
scripts/cloudflare-smoke.sh \
  --stage smoke_boston \
  --real-repo-url https://github.com/isomorphic-git/isomorphic-git.git \
  --real-repo-name isomorphic-git
```

Skip the local suite when it already passed on the exact commit:

```sh
scripts/cloudflare-smoke.sh --skip-check
```

The local ref defaults to `origin/main`. Override it explicitly when validating
a candidate commit:

```sh
SMOKE_LOCAL_REF=HEAD scripts/cloudflare-smoke.sh
```

## Cleanup guarantees

Every source clone, result clone, packet/log scratch file, and response body is
created under one directory returned by:

```sh
mktemp -d "${TMPDIR:-/tmp}/open-relic-smoke.XXXXXX"
```

An `EXIT` trap validates that the directory's basename starts with
`open-relic-smoke.` before running `rm -rf --` on that exact path. It prints the
directory and its size after removal. Interrupts and failed Git commands take
the same cleanup path. The script never deletes the workspace or any source
checkout.

Cloudflare cleanup is also the default. `--keep-stage` is the only path that
leaves the Worker and Durable Object namespaces deployed; the final output
names the retained stage. To remove one later:

```sh
OPEN_RELIC_API_TOKEN="$THE_TOKEN_USED_TO_DEPLOY" \
  bun alchemy destroy --stage "$STAGE" --yes
```

## Reading the measurements

`/usr/bin/time -p` wraps each Git operation. Record at least:

- source commit count, object count, and packed size;
- receive-pack bytes and elapsed push time;
- upload-pack bytes and elapsed clone time;
- source and cloned SHAs;
- `git fsck --full` result;
- incremental push and fetch times; and
- Worker log failures, especially Durable Object alarms and SQL statements.

Compare push and clone pack sizes. A clone pack much larger than the received
pack exposes compression or delta-reuse regressions even when the checkout is
correct.

## Baseline from 2026-08-13

The first deployed run used commit
`96f4b63a3edd186a353b6150b7d91b43123a4e74` and stage `smoke_boston`.

| Repository / operation                       |              Result |
| -------------------------------------------- | ------------------: |
| Warm health requests                         |           76–102 ms |
| Authenticated control-plane requests         |            78–97 ms |
| Open Relic initial push                      |              1.24 s |
| Open Relic fresh clone                       |              1.03 s |
| Open Relic incremental push                  |              0.33 s |
| Open Relic incremental fetch                 | failed after 0.66 s |
| Hono initial push, 22,965 objects / 9.01 MiB |             21.96 s |
| Hono fresh clone, 116.30 MiB received        |             23.16 s |
| Hono `git fsck --full`                       |              passed |

That run produced three follow-up issues:

- [#28](https://github.com/kcc989/open-relic/issues/28) — multi-round
  upload-pack side-band framing;
- [#29](https://github.com/kcc989/open-relic/issues/29) — fresh-clone pack
  compression and delta reuse; and
- [#30](https://github.com/kcc989/open-relic/issues/30) — the 100-bound-value
  Cloudflare SQLite statement ceiling in repository sweeping.

The Hono sweep attempted 40 rows with three values each (120 bound values).
Cloudflare permits 100, so that query shape can safely insert at most 33 rows
(99 values) at a time.
