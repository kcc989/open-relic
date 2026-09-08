# Slabs and Reachability bitmaps serve a fetch

Status: proposed

Every Object receives a permanent **position** when it is published. Its Pack
representation is written into a **Slab** — one KV value of up to 1.5 MiB
holding the representations of a run of consecutive positions, each behind a
small self-describing header — instead of into a KV value of its own. A ref
transaction writes a **Reachability bitmap** for every tip it moves: the set of
positions reachable from that commit, run-length encoded. Upload-pack answers a
fetch whose wants and haves all have bitmaps with set arithmetic, and composes
the Pack by copying byte ranges out of Slabs in position order. Resolved Objects
remain the authority; a Slab and a bitmap are derived, rebuildable, and never
required to serve a fetch.

Positions are the ordering both structures index. They are handed out in
publish order, which is Pack order, and the Pack reader resolves a Delta only
against a base that was published earlier, so a base's position is always lower
than its dependents'. Position order is therefore a valid Pack order without the
topological sort upload-pack performs today, and a Repack may select a new base
only from a lower position to keep it so.

## Why this and not the alternatives

**Why not stay with one KV value per representation.** The server side of a
first-time clone of honojs/hono (2,809 commits, 23,235 Objects) measured
~590 ms on the production runtime after the September hill-climb, against
~450 ms for native Git. What remained was not code: ~340 ms was 23,235
individual `kv.get` calls reassembled into a Pack, ~130 ms was planning that
Pack from 23,235 metadata rows, and ~200 ms was a recursive walk over 173,663
graph edges whose floor is ~160 ms. Native Git serves the same clone from one
mmap'd packfile and a bitmap computed when the pack was written. The per-value
layout also costs push: every Object wrote its representation as one or two
values of its own — 23,235 of the 62,544 KV puts a push of this repository
makes.

**Why not whole cached fetch Packs.** [ADR-0006](./0006-resolved-objects-and-pack-representations-are-a-hybrid.md)
left room for whole immutable fetch Packs as an opportunistic cache keyed by a
ref version and a negotiation shape. This decision does not build that cache
and withdraws the paragraph. A Slab is not a Pack: it has no header or trailer,
it is not keyed by what a client asked for, and one set of Slabs serves every
negotiation shape because a fetch selects entries by position and copies
ranges. A cache of whole Packs would add a second copy of the same bytes for
one shape each, and would be populated by fetches — which the hill-climb rules
forbid and this repository's storage cannot afford. The one property that
paragraph insisted on is kept: Slabs and bitmaps are discardable. A missing
Slab is served from resolved Objects, a missing bitmap falls back to the graph
walk, and a Repack rebuilds either.

**Why not bitmaps alone.** Bitmaps remove the negotiation walk (~200 ms) and
leave the reads and planning (~470 ms) in place. Slabs remove the reads and the
planning and cut push's KV puts; bitmaps need an ordering to index, and Slabs
supply one. Slabs come first; bitmaps follow and are worth less than Slabs on
this workload.

**Why not slabs alone.** Measured: Slabs without bitmaps serve the clone in
~265 ms on workerd, already under native's ~450 ms; the walk is then seven
eighths of what remains, and a clone with side-band sends its first byte only
after negotiation finishes. Bitmaps take the server share to ~57 ms and the
first byte to the first millisecond.

**Why one representation per Object rather than full and Delta both.** ADR-0006
already defers a Delta-resolved Object's full representation to the Repack
alarm. A Slab holds the representation that arrived; a fetch that cannot send
that Delta (the base is neither in the Pack nor held by a thin-pack client)
deflates the resolved Object on the way out, as it does today, without writing
anything. The Repack decides whether such an Object deserves a full entry in a
Slab of its own.

**Why run-length encoding and not EWAH or roaring.** A closure over positions
is long runs of ones with holes for the Objects other refs own or a failed push
left behind. The tip of the fixture encodes in 4 bytes. Runs of
varints need no dependency, decode into a dense bitset in one pass, and are
what compression libraries would emit for this shape anyway. A repository with
millions of positions decodes into a bitset of positions ÷ 8 bytes, which is
within the object's memory for anything its storage can hold.

## What the prototype measured

A throwaway prototype (positions, Slabs written at ingest, the bitmap written
for the pushed tip, upload-pack's fast path) served the real fixture with a
Pack of identical size (9,968,527 bytes) that `git index-pack --strict` and
`git fsck --full` accept. Every comparison below is one alternating run on one
shared host; runs are not comparable with each other.

Server-side clone on workerd with SQLite Durable Objects (`workerd-real.ts`):
the fetch request as a real client sends it, timed to the last byte, seven
alternating samples after a warmup. Phases are the engine's own log at the last
sample. Three pairings, each against the current engine in the same run:

| Pairing              | Current, median (samples)                 | Prototype, median (samples)               | Ratio |
| -------------------- | ----------------------------------------- | ----------------------------------------- | ----: |
| Slabs only           | 590.7 (591, 578, 644, 569, 570, 596, 596) | 264.9 (292, 241, 237, 280, 275, 265, 240) | 2.23× |
| Slabs only, repeated | 624.9 (673, 625, 604, 581, 623, 647, 632) | 271.3 (271, 260, 261, 281, 259, 273, 287) | 2.30× |
| Slabs and bitmap     | 627.4 (663, 614, 602, 627, 603, 702, 649) | 57.2 (63, 57, 52, 52, 49, 62, 57)         | 11.0× |
| Slabs and bitmap, 2  | 612.0 (657, 620, 590, 601, 612, 586, 633) | 49.7 (70, 58, 53, 47, 50, 48, 45)         | 12.3× |
| Slabs and bitmap, 3  | 597.3 (770, 737, 632, 558, 560, 597, 550) | 52.9 (60, 55, 52, 53, 50, 54, 53)         | 11.3× |

The host was shared with three other engineers' benchmarks throughout, and a
runaway process held it at a load average above 20 (four cores) for part of
the window in which the first two slabs-and-bitmap pairings ran; the third ran
at a load average of 6–13. The three agree within 15% on the prototype and
within 5% on the current engine, so the shape of the result is not in doubt,
but none of these is a quiet-host number.

| Phase, ms          | Current | Slabs only | Slabs and bitmap |
| ------------------ | ------: | ---------: | ---------------: |
| Negotiation        |     224 |        194 |                0 |
| Pack planning      |     128 |          0 |                0 |
| Storage reads      |     355 |         10 |               10 |
| Hashing            |       7 |          8 |                6 |
| Time to first byte |     225 |        195 |                0 |

Bun, real `git 2.43` client end to end over HTTP, a fresh application and push
before every clone, seven samples, HEAD asserted and `git fsck --full` run:
wall time 1163.1 ms (1122, 1194, 1471, 1163, 1608, 1016, 1012) against
757.8 ms (793, 652, 768, 739, 758, 741, 852), 1.53×; the server's share of the
median run 451 ms (negotiation 188, planning 147, reads 184) against 61 ms
(negotiation 3, planning 0.3, reads 0.1, hashing 6). What remains of the wall
time is the client's own `index-pack` and checkout.

Push, measured on workerd with the ingest harness (`workerd-ingest.ts` with a
timed bitmap step added), three alternating samples, the whole fixture into a
fresh repository each time:

| Measurement                      | Current                     | Prototype                  |
| -------------------------------- | --------------------------- | -------------------------- |
| Ingest, median (samples)         | 11154 (11154, 10760, 11469) | 10314 (10314, 9887, 11463) |
| Storage commit, median (samples) | 4774 (4774, 4546, 4871)     | 4429 (4429, 4238, 4959)    |
| Bitmap for the tip (samples)     | —                           | 214, 224, 228              |
| Connectivity check (samples)     | 184 (188, 184, 174)         | 198 (198, 195, 203)        |

The commit's sample ranges overlap, so the −7% at the median is within this
host's noise; the put count below is the reliable number. The bitmap is ~5% of
the commit budget and ~2% of the ingest, once per tip a push moves. Push under
Bun with a real `git push` was **not measured**: the push harness hung on this
host for both engines during the measurement window.

Writes an ingest of the fixture makes, counted on the test storage:

| Writes                          | Current | Prototype |
| ------------------------------- | ------: | --------: |
| KV puts                         |  62,544 |    39,317 |
| of which Pack representations   |  23,235 |         7 |
| of which raw Deltas `d:`        |  16,075 |    16,075 |
| of which resolved Objects `o:`  |  23,234 |    23,234 |
| SQL statements                  | 237,891 |   238,537 |
| of which `object_links` inserts | 173,663 |   173,663 |

Slabs remove 37% of the KV puts and none of the SQL statements. The commit is
dominated by the 173,663 `object_links` inserts, which this decision does not
touch; that is the bound on what Slabs can do for push, and it is why the
measured commit moved less than the put count. Retiring the raw `d:` values
(below) would remove a further 16,075 puts, 63% in all.

What the prototype did **not** cover: Sweep and Repack integration (dead
entries, compaction, backfill of Objects that predate positions), retired
bitmaps for haves that are no longer tips, a representation too large for a
Slab (the fixture has none), fork and import bitmaps, shallow and deepen
requests, an incremental fetch with haves (the code path exists and is
untested), and the migration of existing repositories. Its fallback for a Delta
whose base is unavailable reuses today's `ensureFullPackEntry`, which writes a
`z:` value during a fetch; the engine must deflate without writing.

## Consequences

**Ingest.** `ObjectStore` keeps one open Slab buffer of 1.5 MiB beside the
existing publish batch. Each claimed Object takes the next position and appends
its arrived representation — the full zlib stream, or the Delta's — to the
buffer. The Slab closes inside the transaction of the batch that fills it, or
when the Pack ends, as one `kv.put` and one `slabs` row (`id`, `first_position`,
`last_position`, `entries`, `bytes`). Nothing else is written for the
representation: the `z:` and `zd:` values and their size and chunk-count
columns go. A representation that alone exceeds a Slab keeps today's chunked
value under its own key and has a position but no Slab. An Object whose Slab
was still open when the object was evicted mid-push has a complete row and a
position and no covering Slab; it is served from its resolved bytes until a
Repack re-slabs it. Per Object a push writes one fewer KV value; the Slab's
1.5 MiB write replaces ~4,000 small ones. The 4 MiB write-batch bound in
`pack.ts` is unchanged; a Slab spans as many batches as it takes to fill.
A ref-delta against an earlier push's Object finds its base position by one
prepared query, cached for the push in a bounded map. The base's position is
lower by construction.

**Refs.** The ref transaction computes, for each tip it sets, the closure as
positions — the same recursive query negotiation runs today, once per tip
rather than once per clone — and writes it under `bm:<tip>`. A tip that no ref
names any longer loses its bitmap in the same transaction, except after a
fast-forward, where the old tip's closure is a subset of the new one's and its
bitmap stays valid and useful for the next incremental fetch; those retired
bitmaps are bounded per ref. A closure the index cannot express (an Object
without links or without a position) writes no bitmap, and the fetch falls
back. A bitmap is keyed by the commit, so two refs at one tip share it. Import
and fork write bitmaps when they create refs. Push pays the walk it used to
make fetches pay: on the fixture 214–228 ms on workerd (164 ms under Bun),
against a storage commit of ~4.4–4.8 s. A fast-forward can be cheaper — the
old tip's bitmap plus a walk that stops at bitmapped tips and unions the
bitmaps it reached — and the prototype measured only the full walk.

**Fetch.** When every want and every common have has a bitmap, the Pack is the
union of the wants minus the union of the haves, and no graph walk runs. Slabs
are read in id order; a Slab whose range holds no wanted position is skipped;
within a Slab each header is decoded and the entry copied into the frame writer
or passed over. Peak residency is one Slab plus one read ahead, 3 MiB, in place
of the 16 MiB representation budget. A Delta whose base position was emitted,
or is held by a thin-pack client, goes as a ref-delta; otherwise the resolved
Object is deflated on the way out. Positions no Slab covers are resolved to
Objects at the end by one query. A fetch with a depth or a shallow boundary, or
a have without a bitmap, takes today's path; it is correct and no slower than
before. With Slabs and no bitmap the closure walk still runs, and the Pack is
still a range copy.

**Sweep.** Reclaiming an Orphan deletes its resolved chunks and rows as today
and leaves its bytes in the Slab, adding their length to the Slab's
`dead_bytes`. No bitmap names an Orphan, so serving never reaches them. The
mark phase is unchanged by this decision; that it could be the union of every
tip's bitmap is left for a later one. A bitmap of a retired tip is deleted when
its ref is force-updated, because its closure may then include Orphans.

**Repack.** Three bounded jobs, one Slab or one batch per alarm turn, all
within the existing 96 MiB budget: backfill an Object that predates positions
(its Delta's base first, so the ordering invariant holds), which is how an
existing repository grows Slabs and bitmaps without a migration of its bytes;
select a Delta whose base has a lower position and append the new
representation to the open Repack Slab, adding the superseded entry's position
to its Slab's dead list; and rewrite a Slab whose dead bytes pass half its size,
keeping every survivor's position. Positions never change, so a Repack never
touches a bitmap.

**Fork.** The target publishes copied Objects through the same store and gets
Slabs and positions of its own. Copying in the source's position order keeps
bases before dependents, and lets the copy read whole Slabs rather than one
Object at a time. `completeFork` writes the copied refs' bitmaps.

**Import.** A Pack read by import goes through ingest unchanged; the branch's
bitmap is written when its ref is created, with the repository's shallow set.

**Memory.** Ingest: +1.5 MiB. Fetch: 3 MiB in place of 16 MiB. A bitmap in
memory is positions ÷ 8 bytes. A Repack turn: one Slab.

**Schema.** `objects.position`; `slabs` (`id`, `first_position`,
`last_position`, `entries`, `bytes`, `dead_bytes`, `dead`); a next-position
counter on `repository_state`; bitmaps as KV values `bm:<oid>` with a
`reachability_bitmaps` row per tip naming which ref retired it and when. Once
backfill has re-slabbed every representation, `compressed_size` and
`compressed_chunk_count` on `objects` and `object_deltas` are removed. The raw
Delta values `d:` become removable in the same step: the Slab holds the Delta,
and the two readers of the raw form — fork and the fallback writer — can
inflate it.

## Conflicts with earlier decisions

_Contradicts ADR-0002 (Git objects are chunked rows) in one spelling_: it keeps
a Delta as a raw `d:` value beside the resolved Object. The reason it gave —
the Delta passes through our hands exactly once — holds; the Slab is now where
that pass leaves it, compressed, and the raw copy becomes a second spelling of
the same fact. Worth reopening because the raw copy is 16,075 of this
repository's KV puts.

_Departs from ADR-0006 (resolved Objects and Pack representations form a
hybrid) in layout, not in principle_: the hybrid stands, resolved Objects remain
the authority, representations remain derived. What changes is that a
representation lives in a Slab rather than under `z:<oid>:<n>`, that an Object
keeps one representation rather than a full one and a Delta, and that
upload-pack's 16 MiB read budget becomes two Slabs. The paragraph reserving an
opportunistic whole-Pack cache is withdrawn as above.

_Extends ADR-0005 (sweeps checkpoint and restart)_: a second reachability
index appears beside the completed mark set, per tip and for a different
question. They do not disagree; whether the mark set should be derived from the
bitmaps is a later decision.

## Vocabulary

Three terms join `CONTEXT.md`: **Position**, **Slab**, and **Reachability
bitmap**. "Pack representation" keeps its definition; a Slab is where one
lives.
