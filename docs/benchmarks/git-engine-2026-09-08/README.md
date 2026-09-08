# Git engine performance comparison

Baseline: `101bfe1d10a046c2effa0c4790e708b3acec251d`. The updated engine is the code accompanying this report. [Source hashes](source-sha256.json) identify the measured files.

Ingest is the workload that changed. Nothing else moves outside run-to-run noise, which is the expected shape: the previous pass took the query _count_ down, and this one takes the cost of issuing a query down, so only the paths that issue one per object improve.

Both versions received identical generated packs. Each workload ran once for warmup and seven times for measurement. Version order alternated between samples. Tables show median wall time. Bun and workerd benchmarks ran sequentially. Every raw sample is retained in [bun.json](bun.json) and [workerd.json](workerd.json).

The host was Linux x64 on an Intel Xeon @ 2.10GHz. These are local measurements on a shared host. They do not measure Cloudflare network latency, replicated storage, production CPU limits, or client checkout time.

## Local workerd with SQLite Durable Objects

Runtime: `workerd 2026-07-04`, compatibility date `2026-07-04`, `nodejs_compat`. Each version runs in its own service and namespace. Storage uses temporary SQLite files on local disk. Timings include loopback HTTP and response consumption.

| Workload                    |     Before |     After | Before / after |
| --------------------------- | ---------: | --------: | -------------: |
| Parse 10,000 small objects  |  113.06 ms |  96.74 ms |          1.17× |
| Parse 500 source files      |  473.98 ms | 466.68 ms |          1.02× |
| Ingest 10,000 small objects | 1353.20 ms | 772.35 ms |          1.75× |
| Clone 1,000 files           |   89.92 ms |  92.63 ms |          0.97× |
| Fetch an empty commit       |    9.08 ms |   8.74 ms |          1.04× |
| Fetch one changed file      |    9.77 ms |   9.77 ms |          1.00× |
| Check a 500-commit history  |    3.79 ms |   3.75 ms |          1.01× |

Ingest is the only row whose sample ranges do not overlap. Every other row here is unchanged; the ratios are noise on a shared host.

## Bun with migrated SQLite and the test KV adapter

Runtime: `Bun 1.3.11`. Parser workloads use a minimal sink and check every object ID. Ingest uses the real ObjectStore and migrations with in-memory SQLite and the existing KV adapter. Fetch output passes through the pack reader, including checksum checks.

| Workload                                  |     Before |     After | Before / after |
| ----------------------------------------- | ---------: | --------: | -------------: |
| Parse 10,000 small objects, 64 KiB chunks |   79.14 ms |  61.73 ms |          1.28× |
| Parse 10,000 small objects, 1 MiB chunks  |   74.83 ms |  57.84 ms |          1.29× |
| Parse 500 source files, 64 KiB chunks     |  267.90 ms | 268.28 ms |          1.00× |
| Ingest 10,000 small objects               | 1709.55 ms | 276.58 ms |          6.18× |
| Clone 1,000 files                         |   20.63 ms |  17.20 ms |          1.20× |
| Fetch an empty commit                     |    9.19 ms |   9.10 ms |          1.01× |
| Fetch one changed file                    |    8.90 ms |   8.84 ms |          1.01× |
| Check a 500-commit history                |    3.20 ms |   3.68 ms |          0.87× |

The two runtimes disagree about how much ingest improves because they disagree about what ingest costs. Under Bun the statements are nearly free to run and were dominated by the cost of composing them; under workerd each statement also writes to local disk, so removing the composition removes a smaller share. workerd is the runtime that matters, and 1.75× there is the number to quote.

The 500-commit connectivity row is a 0.5 ms difference on a 3 ms workload, in a path this change does not touch.

## A sweep of a 3,002-object repository

Measured outside the two runners above, alternating versions across seven samples with the same fixtures and the migrated Bun SQLite store: 2,000 blobs and their tree and commit reachable, 500 blobs orphaned, 256 objects per step.

| Workload                                 |   Before |    After | Before / after |
| ---------------------------------------- | -------: | -------: | -------------: |
| Mark and reclaim, 2,502 live, 500 orphan | 664.4 ms | 100.0 ms |          6.65× |

## Work eliminated

| Measurement                                 | Before |  After |
| ------------------------------------------- | -----: | -----: |
| Statements built for a 10,000-object ingest | 20,000 |      9 |
| SQL statements run for that ingest          | 20,000 | 20,000 |
| Transactions for that ingest                |     79 |     79 |
| Queries for a 205-object indexed frontier   |      6 |      1 |

Nothing about what reaches SQLite changed. The same statements run, in the same transactions, in the same order; only their composition is hoisted out of the loop.

## Changes and tradeoffs

- The statements an object passes through — claim the row, insert its delta, insert each graph edge, mark it complete, read it back, delete it — are built once per store and reused with bound parameters. A store is constructed with its Durable Object, so the built form outlives a request. This is where essentially all of the ingest gain is.
- The same treatment covers the sweep's mark statements and object reclamation, which run once per object over a whole repository.
- Graph edges are inserted one row at a time rather than 33 rows to a statement. A prepared single-row insert beat both the composed multi-row insert it replaces and a prepared multi-row one, and it removes the bound-value arithmetic.
- Placeholders bind `1`/`0` where a column is a boolean. The bun:sqlite driver accepts a JS boolean and the Durable Object driver's `sql.exec` is not documented to, so the integer is the portable spelling.
- `readIndexedObjects` is one query over a JSON-encoded frontier instead of two `IN` queries per 98 oids, matching `readPackMetadata` and `readObjectClosure` beside it. Its result is unchanged, including edge order, which follows stored rows rather than tree order.
- `Sha1.hex()` asks the hash for hex directly instead of spelling out a byte array it had just allocated. This is the parser rows above; it is worth less under workerd than under Bun.
- A bounded read-ahead that would have let the native inflater take entries straddling a chunk boundary was measured and **discarded**. It buys nothing on either runtime's source-file workload, and it breaks the parser's residency bound — one object plus the chunk it arrived in — which `pack.ts` is built around and `pack.test.ts` enforces. Source-file parsing remains dominated by the resumable JS decoder; improving it means making that decoder faster, not buffering more of the pack.

Type checking, lint, formatting, and the package build all pass, and 590 of 592 tests do. `bun run check` therefore exits non-zero on this host: the two failures are `git-clone-fetch.test.ts` timeouts that reproduce identically on the baseline, where dozens of real `git commit` processes exceed the 5-second limit.

## Reproduce

Create a checkout at the baseline revision. Make the locked dependencies available in both checkouts. Run from the updated checkout:

```sh
git worktree add --detach ../open-relic-baseline 101bfe1d10a046c2effa0c4790e708b3acec251d
bun run benchmark:engine ../open-relic-baseline 7 > bun-results.json
bun run benchmark:workerd ../open-relic-baseline 7 > workerd-results.json
```

The workerd runner binds only to loopback. It removes its temporary services, SQLite databases, and Git clients when it finishes. Deployment is not required.
