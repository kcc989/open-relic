# First-time push of a real repository

Baseline: `c75de98` (the branch of #68, after the clone hill-climb). The updated engine is `0028bd6` and the code accompanying this report. [Source hashes](source-sha256.json) identify the measured files.

The workload is [honojs/hono](https://github.com/honojs/hono) `main` @ `e7b38ee` — 2,809 commits, 23,235 objects, 16,075 of them deltas, a 9.68 MB pack as `git push` sends it — received by a real `git 2.43.0` client into an empty repository. Every push was checked: the remote's `main` names `e7b38ee` afterwards, and the repository clones and passes `git fsck --full`.

The rules were the clone hill-climb's: a first-time push only, nothing that makes a later request faster by caching this one, nothing tuned to the repository. Three engineers worked in parallel on disjoint files — the parser's CPU, what a push writes and the walk that verifies it, and the HTTP layer and the order of the push — and the coordinator measured the result on the production runtime.

## Where a push spent its time

Native git receives this push in about 1.13 s. Before this work, Open Relic took 3.68 s end to end under Bun and about 13 s of ingest on local workerd with SQLite Durable Objects — and the two runtimes disagreed about why. [Bun profile](baseline-push-bun.json), [workerd profile](baseline-ingest-workerd.json).

| Phase              |            Bun |        workerd | Note                                                                                   |
| ------------------ | -------------: | -------------: | -------------------------------------------------------------------------------------- |
| Storage commit     | 1,710 ms (49%) | 5,635 ms (44%) | ~62k KV puts and ~75k statements in 79 transactions; every one a disk write on workerd |
| Body ingress       |    110 ms (3%) | 4,914 ms (37%) | the request body arriving in 2,511 chunks of ~4 KB, ~2 ms each                         |
| Inflate            |   759 ms (22%) |    650 ms (5%) | 1,314 of 23,235 entries reached the native inflater on workerd                         |
| Link indexing      |    276 ms (8%) |    179 ms (1%) | parsing ~7k trees and commits for `object_links`                                       |
| Connectivity check |    163 ms (5%) |        ~200 ms |                                                                                        |
| Hash + delta apply |    252 ms (7%) |    270 ms (2%) |                                                                                        |

Under Bun the parser's CPU looks like a third of the push; on production it is 7%, and 82% is writes plus waiting for the body.

## Where the 2,511 chunks came from

Four Worker behaviours, same engine, workerd, two samples each ([1](ingress-coalesced-worker.json), [2](ingress-whole-body-worker.json), [3](ingress-rpc-pieces.json)):

| The Worker…                                           | Chunks the object's parser saw | Body ingress |      Ingest |
| ----------------------------------------------------- | -----------------------------: | -----------: | ----------: |
| forwards the request as-is                            |                          2,511 |    4.6–5.2 s | 10.9–13.1 s |
| coalesces the body to 512 KB pieces, then forwards    |                          2,439 |        5.2 s | (contended) |
| buffers the whole 9.7 MB body and forwards one value  |                          2,434 |        5.0 s |      11.4 s |
| reads 1 MiB pieces and passes each as an RPC argument |                         **10** |    **1.5 s** |   **7.9 s** |

Whatever the Worker enqueues, a Request body is re-framed into ~4 KB reads on its way into the object; bytes that arrive by another route are not. The HTTP engineer then found that the object can ask for larger reads itself — a BYOB reader with a minimum fill — which reaches the same result without a second RPC protocol; that is the change that shipped. The residual per-read cost scales with the bytes written since the last yield: the object flushes storage at every turn of its event loop, so reads and writes are coupled.

## What changed

- **A push's rows are written per batch, not per object.** Each write batch used to issue one statement per object row, per completion update, per delta row, and per graph edge — 173,663 edge inserts for this repository, each maintaining two B-trees. A batch now runs four statements: claim its rows with one `insert … select … from json_each(?) on conflict do nothing returning`, insert its delta rows and its edges with one `json_each` insert each, and complete the claimed rows with one `update … where oid in (select value from json_each(?))`. Rows still begin incomplete and are completed last, so ADR-0002's "a row is not visibility" and the non-transactional recovery path are unchanged, and one bound value per statement keeps the 100-value limit out of the picture. The index `object_links_target_oid_idx` is dropped: no query reads edges by target, so every push paid a third B-tree for nothing. Tree parsing is byte-level — native `indexOf` for the separators, mode digits validated in place, one hex decode per emitted id — and `treeLinks` no longer materializes entries. Nothing a push stores changed: the same values, rows, and bytes.
- **The pack behind a push is read in megabyte pieces.** On workerd a default reader on any internal stream is answered 4 KiB at a time, before and after the RPC hop, and the object commits its storage at every one of those turns: a 10 MB push paid 2,511 of them. `PktLineReader.rest()` now hands the body over through a BYOB reader asking for a 1 MiB minimum (`readAtLeast`), with an exact fallback to the default reader for streams that are not byte streams (Bun's request bodies, the tests' fixtures). 256 KiB measured clearly slower than 1 MiB; 4 MiB was within noise of it, so the smaller size was kept. Peak residency rises to about three pieces.
- **Deflate is decoded with lookup tables and deltas are applied in place.** The from-scratch inflater decoded every Huffman code a bit at a time through a method call per bit and rewound with a thrown exception per symbol. Each block now builds lookup tables indexed by the next input bits and decodes literals and matches in one loop over a 32-bit accumulator; the delta applier reads copy instructions inline instead of allocating a view per instruction. Public interfaces, error codes, and the parser's residency bound are unchanged. This is ~7% of a production push, so it moves the wall clock little; it moves the JS inflater 2.4× and lands where V8 and JSC agree.
- **The benchmark worker reads a pack the way a push does** — through the pkt-line reader — so the workerd runner measures the production read path.
- Beside this report, [ADR-0007](../../adr/0007-slabs-and-reachability-bitmaps-serve-a-fetch.md) records the design decision the clone measurements pointed at: Slabs and Reachability bitmaps, with a prototype's numbers. It is proposed, not built; nothing here depends on it.

## Result

Both runs below were taken on a quiet host (load average about 1) after every engineer had finished, baseline checkout against the integrated branch.

**Bun, real `git 2.43.0` push over HTTP into a fresh application each time, five samples** ([before](push-bun-before.json), [after](push-bun-after.json)):

|                           |       Before |        After |      Before / after |
| ------------------------- | -----------: | -----------: | ------------------: |
| Push wall time, median    |      3803 ms |      2625 ms |               1.45× |
| Sample range              | 3638–3851 ms | 2525–2730 ms | envelope 1.33–1.53× |
| Server receive-pack total |      3588 ms |      2401 ms |               1.49× |
| Storage commit            |      1916 ms |      1220 ms |               1.57× |
| Inflate                   |       570 ms |       294 ms |               1.94× |
| Link indexing             |       314 ms |        96 ms |               3.27× |
| Connectivity check        |       173 ms |       190 ms |                   — |

**workerd with SQLite Durable Objects, the same pack ingested into a fresh repository, three alternating samples, then the push's connectivity check** ([raw](ingest-workerd-before-after.json)):

|                                                |                 Before |               After |      Before / after |
| ---------------------------------------------- | ---------------------: | ------------------: | ------------------: |
| Ingest, median                                 |              11,997 ms |            5,798 ms |               2.07× |
| Sample range                                   |       11,894–12,456 ms |      5,616–5,805 ms | envelope 2.05–2.22× |
| Body ingress                                   | 5,383 ms, 2,435 chunks | 1,656 ms, 10 chunks |               3.25× |
| Storage commit                                 |               5,048 ms |            3,219 ms |               1.57× |
| Inflate (entries reaching the native inflater) |         662 ms (1,295) |      264 ms (2,827) |               2.51× |
| Link indexing                                  |                 184 ms |               86 ms |               2.14× |
| Connectivity check                             |                 225 ms |              196 ms |               1.15× |

Native Git receives this push in about 1.13 s end to end, so under Bun the push went from 3.4× native to 2.3× native. On production storage what remains is the commit (3.2 s, still the largest phase), the residual ingress that is really storage being flushed at each yield (1.7 s), and about 0.6 s of parser CPU. The next step on the commit is not in this report: ADR-0007's Slabs cut the KV puts a push makes by a third in its prototype, and the raw delta values it leaves in place are a further candidate.

## Measured and rejected

- Coalescing the body in the Worker before the RPC hop (512 KB–1 MiB pieces): the object still saw ~2,440 chunks of 4,096 bytes. Buffering the whole body: 2,434. Passing 1 MiB pieces as RPC method arguments worked (10.9 → 7.9 s) and was dropped in favour of the BYOB reader, which measures the same and needs no second RPC protocol, no session-spanning gate, and no backpressure semantics of its own.
- Prepared 32-row edge inserts plus singles: 732 ms against 692 for single rows and 597 for one `json_each` insert, over the real 173k edges; with the target index dropped, 483 / 486 / 420. Nesting the JSON by source: the same as flat, more code.
- A rewritten closure walk for the connectivity check: 147 vs 183 ms against `main`'s query, but 163 vs 166 ms against this branch's, whose empty-boundary elision had already taken the gain. Reverted. A partial index on non-blob edges: 101 vs 110 ms, not worth a B-tree per push.
- Widening the native-inflate fence from 1 KiB to 4 KiB: under Bun native wins from ~256 B up; under workerd one clean probe said the opposite for 1–4 KiB. Not principled on both runtimes; dropped.
- Per-object hash setup: `hashObject` is 0.6–1 µs for small objects and hashing is throughput-bound on 124 MB of resolved bytes; a pure-JS SHA-1 is 3–8× slower at every size. A scratch-buffer header instead of `TextEncoder`: a wash.
- Inlining the table lookup, a 10-bit table, reusing table storage, an unrolled Adler-32: each within noise of the kept decoder.
- Reordering the push's phases: commands 0.5 ms, refs 0.3 ms, shallow set under 1 ms — nothing to overlap with body arrival, and the exclusive gate must span the whole push.
- Deferring the raw `d:` delta values to repack (about 200 ms of the Bun commit): a representation change touching fork and reclaim accounting, not measured on workerd; left to ADR-0007's phases.

## Findings not acted on

- Git's 4-byte auth-probe POST (`probe_rpc`, sent before any push over `http.postBuffer`) runs the whole receive-pack path, including arming the maintenance alarm — a durable write and a maintenance pass on production for a request that carries nothing. Moving `setAlarm` after the command phase would spare that.
- This host's `push.negotiate=true` gitconfig makes git fetch the upload-pack advertisement before pushing, two extra round trips a default client does not make; the Worker's v2 advertisement lacks `wait-for-done`, so git warns and proceeds.
- Every Git request still makes two sequential registry RPCs; a combined resolve would remove one per request, three per push.
- The connectivity check's remaining ~160 ms is visiting 163k tree→blob edge rows to discard them; a covering `(source_oid, target_oid, target_type)` index would avoid the row lookups at a write cost per push.
- `storageReadMs`/`bodyIngressMs` in the engine's log both include time the object spends flushing storage at each yield; the tables above quote the phases as logged.

## Reproduce

The harnesses are committed beside this report. Create a checkout at the baseline revision and a bare single-branch clone of the fixture (`git clone --bare --single-branch --branch main https://github.com/honojs/hono.git src.git`; `git pack-objects --revs --stdout` of `e7b38ee` for the workerd harness), then:

```sh
bun push-bench.ts <checkout> 5              # Bun, real git push; edit SOURCE at the top
bun workerd-ingest.ts <before> <after> 3    # workerd; worker-profile.ts is beside it
```
