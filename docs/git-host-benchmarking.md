# Git host benchmarking

This runbook compares the Git client behavior of GitHub, hosted Cloudflare
Artifacts, and a deployed Open Relic installation using any public GitHub
repository. The reusable entrypoint is
[`scripts/benchmark-git-hosts.sh`](../scripts/benchmark-git-hosts.sh).

It preserves the deployed proof run from 2026-08-13 in a form that can be
repeated without depending on files under `.context` or on credentials stored
at machine-specific paths.

## What the benchmark does

For one source repository, each host receives the same default-branch history
in a newly created empty repository. The script then:

1. Records the source SHA, commit count, packed object count, and pack size.
2. Times an initial push with `/usr/bin/time -p`.
3. Times a fresh clone and verifies that its checked-out SHA matches the source.
4. Times `git fsck --full --no-progress` and records the clone's pack size.
5. Copies the clone locally to create a second client without warming the
   server through another clone.
6. Creates one disposable commit, times its push, fetches it from the second
   client, and verifies `FETCH_HEAD`.
7. Deletes the three disposable remote resources and every temporary clone,
   including after a failure or interrupt.

Times are wall-clock seconds. Lower is better. `sha_integrity=pass` means the
fresh clone and incremental fetch both named the expected commits; `git fsck`
must also exit successfully before a row is printed.

This is an end-to-end Git-client benchmark. It includes network latency,
Cloudflare/GitHub request handling, server storage and pack work, transfer, and
local Git checkout. It is not a server-only CPU benchmark.

## Prerequisites

- Bash, Git, GitHub CLI (`gh`), `curl`, `jq`, and `/usr/bin/time`.
- `gh auth status` succeeds, and its token can create and delete private
  repositories for the authenticated GitHub user. Cleanup fails loudly if the
  token lacks GitHub's repository-deletion permission.
- A Cloudflare API token and account id with access to hosted Artifacts.
- A deployed Open Relic Worker and its API token. Use an isolated Alchemy stage,
  not `prod`.

Deploy Open Relic at the exact revision under test and retain the stage:

```sh
export OPEN_RELIC_API_TOKEN="$(openssl rand -hex 32)"
BENCHMARK_STAGE="benchmark_$(date -u +%Y%m%d%H%M%S)"
bun alchemy deploy --stage "$BENCHMARK_STAGE" --yes
export OPEN_RELIC_URL="https://the-worker-url-from-deploy.workers.dev"
```

Also provide the hosted Artifacts credentials without putting them on the
command line or in a report:

```sh
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-api-token"
```

## Run one repository

Pinning the SHA makes later runs comparable and prevents an upstream push from
silently changing the workload:

```sh
mkdir -p .context/benchmarks

scripts/benchmark-git-hosts.sh \
  --repo-url https://github.com/redwoodjs/sdk \
  --label redwood \
  --expected-sha 4fdfe5636b34a9d917570d4321fc05422326ffd3 \
  | tee .context/benchmarks/redwood.tsv
```

For a new repository, omit `--expected-sha` on the first run, take
`source_sha` from the result, and use it for subsequent runs. The source URL
must be a public GitHub repository, but it may name any owner and repository.

Run repositories separately so each gets its own result file:

```sh
scripts/benchmark-git-hosts.sh \
  --repo-url https://github.com/alchemy-run/alchemy \
  --label alchemy \
  --expected-sha 8c458c871bbcf6c0177e567e58a75d8d9bd31185 \
  | tee .context/benchmarks/alchemy.tsv
```

The host order defaults to `github,artifacts,open-relic`. Change it to detect
order or transient network effects, or run only a subset while debugging:

```sh
scripts/benchmark-git-hosts.sh \
  --repo-url https://github.com/owner/repository \
  --hosts open-relic,artifacts,github
```

`--keep-remotes` is available for investigation. The script prints the exact
resources retained; remove them manually afterward. Local temporary clones are
always deleted.

When finished, destroy the isolated Open Relic stage:

```sh
bun alchemy destroy --stage "$BENCHMARK_STAGE" --yes
```

## Reproducibility notes

Before comparing runs, record the Open Relic commit and stage, Git version,
machine, approximate location, and network connection alongside the TSV:

```sh
{
  git rev-parse HEAD
  git --version
  uname -a
  sw_vers
} >.context/benchmarks/environment.txt
```

The 2026-08-13 proof used one sample per operation from the same Mac and network.
That is useful deployed evidence, but not a statistically stable performance
study. For regression decisions, run at least three samples per repository,
alternate the host order, report the median, and retain every raw TSV. Do not
compare unpinned source SHAs or runs from materially different networks.

Clone pack size can differ from source pack size because every server may
choose different deltas and compression. A correct SHA and successful `fsck`
prove repository integrity; they do not imply equivalent transfer efficiency.

## Preserved 2026-08-13 results

These were single end-to-end samples. Both repositories passed initial push,
fresh clone, SHA verification, and `git fsck --full` on all three hosts. Open
Relic's deployed smoke also passed incremental push and fetch. The source pack
is the GitHub source clone's packed size.

### RedwoodSDK

Source `4fdfe5636b34a9d917570d4321fc05422326ffd3`; 2,626 commits;
30,773 packed objects; 88.25 MiB source pack.

| Measurement            |        GitHub | Cloudflare Artifacts | Open Relic |
| ---------------------- | ------------: | -------------------: | ---------: |
| Initial push           |   **37.38 s** |             129.21 s |    94.67 s |
| Fresh clone + checkout |    **2.58 s** |              28.81 s |    50.61 s |
| `git fsck --full`      |    **0.98 s** |               1.14 s |     1.07 s |
| Clone pack             | **88.27 MiB** |           124.41 MiB |  88.67 MiB |
| SHA / integrity        |          Pass |                 Pass |       Pass |

### Alchemy

Source `8c458c871bbcf6c0177e567e58a75d8d9bd31185`; 1,369 commits;
45,936 packed objects; 74.27 MiB source pack.

| Measurement            |        GitHub | Cloudflare Artifacts | Open Relic |
| ---------------------- | ------------: | -------------------: | ---------: |
| Initial push           |   **30.42 s** |             291.42 s |    97.38 s |
| Fresh clone + checkout |    **3.47 s** |              45.95 s |    75.99 s |
| `git fsck --full`      |    **1.07 s** |               1.23 s |     1.14 s |
| Clone pack             | **74.27 MiB** |           101.30 MiB |  74.58 MiB |
| SHA / integrity        |          Pass |                 Pass |       Pass |

The same run observed one newly deployed Worker returning Cloudflare `1042`
and one namespace request returning `500` before the deployment stabilized.
The reusable script therefore waits up to 60 seconds for Open Relic's health
endpoint before it creates benchmark resources.
