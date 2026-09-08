# Git engine performance comparison

Baseline: `6ffc4902457b05848ff4ae2158d18cb08f69f58d`. The updated engine is the code accompanying this report. [Source hashes](source-sha256.json) identify the measured files.

The largest measured gains are incremental fetches and connectivity checks. Source-file parsing in workerd is effectively unchanged.

Both versions received identical generated packs. Each workload ran once for warmup and seven times for measurement. Version order alternated between samples. Tables show median wall time. Bun and workerd benchmarks ran sequentially. Every raw sample is retained in [bun.json](bun.json) and [workerd.json](workerd.json).

The host was Linux x64 on an AMD EPYC 9V74 80-Core Processor. These are local measurements on a shared host. They do not measure Cloudflare network latency, replicated storage, production CPU limits, or client checkout time.

## Local workerd with SQLite Durable Objects

Runtime: `workerd 2026-07-04`, compatibility date `2026-07-04`, `nodejs_compat`. Each version runs in its own service and namespace. Storage uses temporary SQLite files on local disk. Timings include loopback HTTP and response consumption. Ingest samples use fresh repositories. Fetch and connectivity samples use a seeded repository. Workload creation is outside the timed requests.

| Workload                    |     Before |     After | Before / after |
| --------------------------- | ---------: | --------: | -------------: |
| Parse 10,000 small objects  |   94.63 ms |  79.74 ms |          1.19× |
| Parse 500 source files      |  355.68 ms | 353.61 ms |          1.01× |
| Ingest 10,000 small objects | 1066.91 ms | 918.50 ms |          1.16× |
| Clone 1,000 files           |   78.03 ms |  67.06 ms |          1.16× |
| Fetch an empty commit       |   62.04 ms |   8.57 ms |          7.24× |
| Fetch one changed file      |   63.29 ms |   9.76 ms |          6.49× |
| Check a 500-commit history  |   45.09 ms |   3.64 ms |         12.40× |

Every fetched pack passed `git index-pack --stdin --strict`. Both Git clients passed `git fsck --full` after the fetch workloads.

## Bun with migrated SQLite and the test KV adapter

Runtime: `Bun 1.2.7`. Parser workloads use a minimal sink and check every object ID. Ingest uses the real ObjectStore and migrations with in-memory SQLite and the existing KV adapter. Fetch output passes through the pack reader, including checksum checks. These timings exclude fixture creation and validation after the operation.

| Workload                                  |     Before |      After | Before / after |
| ----------------------------------------- | ---------: | ---------: | -------------: |
| Parse 10,000 small objects, 64 KiB chunks |  173.35 ms |   79.14 ms |          2.19× |
| Parse 10,000 small objects, 1 MiB chunks  |  399.54 ms |   80.43 ms |          4.97× |
| Parse 500 source files, 64 KiB chunks     |  282.14 ms |  212.45 ms |          1.33× |
| Ingest 10,000 small objects               | 1850.03 ms | 1211.49 ms |          1.53× |
| Clone 1,000 files                         |   16.80 ms |   15.34 ms |          1.10× |
| Fetch an empty commit                     |   17.40 ms |    7.81 ms |          2.23× |
| Fetch one changed file                    |   16.99 ms |    7.56 ms |          2.25× |
| Check a 500-commit history                |   52.51 ms |    2.97 ms |         17.70× |

## Work eliminated and memory bounds

| Measurement                               | Before |  After |
| ----------------------------------------- | -----: | -----: |
| Transactions for 10,000-object ingest     | 10,000 |     79 |
| SQL statements for that ingest            | 20,000 | 20,000 |
| SQL queries for the connectivity workload |    502 |      1 |
| Objects sent for an empty commit          |  1,002 |      1 |
| Response bytes for an empty commit        | 68,638 |    240 |
| Objects sent for one changed file         |  1,002 |      3 |
| Response bytes for one changed file       | 68,624 | 23,777 |

Write batches are bounded by 128 objects and 4 MiB of retained payloads. Larger objects are published alone. A failed batch rolls back as a unit. Earlier completed batches remain intact.

Fetch reserves bytes for active and queued windows together, up to 16 MiB. An oversized representation runs alone. Regression tests check both ordinary windows and oversized entries. This is a scheduling bound; these runs did not measure peak process memory. KV reads and representation assembly can hold additional buffers.

## Changes and tradeoffs

- The inflater returns a view of unused input. PackStream reuses that view when its buffer is empty.
- The parser uses ObjectStore's batch writer. Pending objects remain available as delta bases.
- Incremental fetches subtract objects reachable from common client commits. This adds an indexed graph query and avoids sending unchanged trees and blobs. A large client history can make that query expensive; broader repository workloads remain useful.
- Connectivity uses one recursive SQLite query when indexes are complete. Missing indexes use the existing object parsing path. Failed walks cannot establish verified boundaries for later commands.
- Fetch read-ahead accounts for active and queued bytes together.
- Native inflation is limited to buffered entries between 1 KiB and 4 MiB with ample input. Split streams retain the resumable decoder. An earlier speculative version regressed the workerd source workload, so that version was discarded. The final guarded path improves the Bun source workload and leaves workerd source parsing effectively unchanged.

The fixtures contain 10,000 small unique blobs, 500 source-like blobs based on `repository-store.ts`, a 1,000-file snapshot, and 500 additional commits. They are deterministic synthetic workloads. The performance packs contain whole objects; correctness tests also cover real Git delta packs, thin packs, shallow histories, storage exhaustion, retry, and Git client interoperability.

`bun run check` passed: type checking, lint, formatting, 590 tests, and the package build.

## Reproduce

Create a checkout at the baseline revision. Make the locked dependencies available in both checkouts. Run from the updated checkout:

```sh
git worktree add --detach ../open-relic-baseline 6ffc4902457b05848ff4ae2158d18cb08f69f58d
bun run benchmark:engine ../open-relic-baseline 7 > bun-results.json
bun run benchmark:workerd ../open-relic-baseline 7 > workerd-results.json
```

The workerd runner binds only to loopback. It removes its temporary services, SQLite databases, and Git clients when it finishes. Deployment is not required.
