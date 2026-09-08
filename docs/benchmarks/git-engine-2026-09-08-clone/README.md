# First-time clone of a real repository

Baseline: `deeb54cdaf0c421ac42af08217d56d72defdc22f`. The updated engine is `1797ab0` and the code accompanying this report. [Source hashes](source-sha256.json) identify the measured files.

The workload is not synthetic. It is [honojs/hono](https://github.com/honojs/hono) at `e7b38ee`, branch `main`: 2,809 commits, 23,235 objects, a 10.16 MiB pack. Every clone was checked against that commit and passed `git fsck --full` or `git index-pack --strict`.

The rules were: only a first-time clone counts, nothing may make a second clone faster than the first, and nothing may be tuned to this repository. Three engineers worked in parallel on disjoint files — the SQL and storage read path, the pack writer, and the HTTP layer — each measuring against the same baseline with the same harness, keeping only what cleared the host's noise, and reporting what they rejected. The coordinator integrated the result and measured it on the production runtime.

## Local workerd with SQLite Durable Objects

Runtime: `workerd 2026-07-04`, `nodejs_compat`, temporary SQLite on local disk. The server-side work of a clone: the fetch request with `side-band-64k`, as a real Git client sends it, timed until the last byte and verified with `git index-pack --strict`. Seven alternating samples after one warmup. [Raw samples.](workerd-real-clone.json)

| Measurement                |      Before |      After | Before / after |
| -------------------------- | ----------: | ---------: | -------------: |
| Server-side clone, median  |    949.3 ms |   734.4 ms |          1.29× |
| Sample range               | 893–1039 ms | 668–789 ms |     no overlap |
| Negotiation (closure walk) |      350 ms |     242 ms |          1.45× |
| Pack planning              |      144 ms |     151 ms |              — |
| Hashing                    |       47 ms |       5 ms |           9.4× |
| Time to first byte         |      350 ms |     243 ms |          1.44× |

An earlier pairing of the same baseline against the integrated engine without the KV adapter change measured 1060 → 680 ms, 1.56× ([raw](workerd-real-clone-before-kv-change.json)). Both pairings are internally consistent and non-overlapping; the difference between them is drift on a shared host between runs, which is why every comparison here is made within one alternating run and never across two.

The KV adapter decision on its own, integrated code both sides, seven alternating pairs ([raw](workerd-kv-adapter-ab.json)): the async 128-key multi-get 729 ms, synchronous `kv.get` per key 650 ms, faster in every pair.

## Bun, real Git client, end to end

`git 2.43.0` pushing and then cloning over HTTP against the whole Worker in-process, a fresh application and push before every clone, seven samples. Storage is bun:sqlite in memory. [Before](bun-real-clone-before.json), [after](bun-real-clone-after.json).

| Measurement             |    Before |     After | Before / after |
| ----------------------- | --------: | --------: | -------------: |
| Clone wall time, median | 1254.6 ms | 1174.2 ms |          1.07× |
| Extreme-sample envelope |           |           |     0.93–1.32× |
| Server share of that    |    833 ms |    482 ms |          1.73× |

The wall-time envelope crosses 1.00×: with this client the clone is bounded by its own `index-pack` (about 500 ms) once bytes start flowing, and Bun's server side was already fast. The server share is unambiguous.

## What changed

- **The closure walk stays on the edge table.** The recursive query behind negotiation evaluated two correlated `not exists` subqueries against empty boundary lists for every one of 173,663 edges, and joined `objects` inside the recursion to gate on flags the final join checks anyway. The boundary lists are now emitted only when non-empty, as materialized `not in` lists, and the recursion joins `objects` only on the connectivity path that needs a source's type. Same result set; negotiation −30%.
- **The pack is written into wire frames.** Upload-pack yielded two or three tiny chunks per object through four generator and stream layers, with a native SHA-1 update per chunk. A frame writer now assembles each 65,520-byte side-band packet in place and hashes it once: ~155 hash updates instead of ~50,000. The bytes on the wire are identical. Without side-band, the same clone previously took 3.9 s on workerd — one tiny chunk per object crossing the object boundary; it now produces the same frames.
- **Chunks are read through the synchronous KV.** On a SQLite-backed object the multi-get reads the same local database as `kv.get`, plus a promise and an actor-cache trip per window. 1.12× on the clone.
- **Single-chunk entries are handed over as read** rather than allocated and copied. Within noise under Bun; kept because it strictly removes an allocation and a copy per object and halves a read window's peak residency.
- **The protocol-v2 advertisement is answered by the Worker.** It names commands, not refs, so the repository object had nothing to add; a v2 clone now makes one fewer Worker→object round trip before `ls-refs`. Unmeasurable in-process; kept on the round-trip argument.

## Measured and rejected

- A JavaScript breadth-first walk over `object_links` in `IN` batches: 265 ms against 159–198 ms for the recursive query.
- Covering indexes on `objects` and `object_deltas`: the planner ignored them where it mattered, and every ingest would pay to maintain them.
- Returning pack metadata from the closure query: −37 to −47 ms per clone, but it crosses the ownership line between the planner and the store and was left for a later change.
- A per-object generator for the frame writer: 9–20 ms against 0.3–1.4 ms for plain calls.
- Emitting the pack header before planning: twelve bytes the client cannot act on.
- Gzip on the response, re-chunking in the route, avoiding the client's initial 401: the pack is already deflated, the route costs 7 ms per 10 MB, and git 2.43 never sends credentials preemptively.

## Findings not acted on

- Every Git request makes two sequential RPCs to the single registry object (authorize the token, then resolve the repository) — six per clone. A combined call would remove three round trips per clone in production; invisible to both local harnesses.
- Open Relic's own import client (`git/remote-branch.ts`) does not request side-band, so an Open Relic→Open Relic import would have hit the slow serving path this change removed.
- `storageReadMs` in the upload-pack log sums the wall time of up to four overlapping read windows and over-counts; the tables above quote it nowhere.

## Reproduce

The harnesses are committed beside this report. Create a checkout at the baseline revision and a bare single-branch clone of the fixture, then:

```sh
git clone --bare --single-branch --branch main https://github.com/honojs/hono.git src.git
bun clone-bench.ts <checkout> 7 --fresh          # Bun, real git client; edit SOURCE at the top
bun workerd-real.ts <before> <after> 7           # workerd; needs hono-main.pack from `git pack-objects`
```
