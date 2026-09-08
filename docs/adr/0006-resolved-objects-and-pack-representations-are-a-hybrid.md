# Resolved objects and Pack representations form a hybrid store

Status: accepted

Resolved Objects remain the durable authority for REST reads, delta resolution,
and arbitrary Git access. Each Object also keeps a derived, zlib-compressed full
Pack representation; a retained Delta keeps its compressed representation too.
Upload-pack composes its negotiated Pack from those immutable entry caches, so
fetch does not recompress object contents and the existing object-by-object
streaming design remains intact.

## Why not replace Objects with cached Packs

A whole cached Pack is excellent for one immutable ref snapshot and one fetch
shape, but Git negotiation can request any difference between wants, haves, and
shallow boundaries. Making whole Packs authoritative would put REST and random
object access behind a Pack index and would reintroduce the storage shape
rejected by [ADR-0002](./0002-git-objects-are-chunked-rows-in-the-repository-object.md).
Entry-level representations reuse the expensive compression work across every
negotiation while preserving streaming composition.

Whole immutable fetch Packs may later be added as an opportunistic cache keyed
by a stable ref version and negotiation shape. Such a cache must be discardable:
it may accelerate a common clone, but it cannot replace resolved Objects or be
required to serve a fetch.

## Consequences

Object ingestion pays compression once when publishing an Object, and a bounded
alarm-driven Repack backfills older Objects and selects useful shallow Deltas.
Pack ingestion retains the incoming compressed representation. An Object
resolved from a Delta defers its full compressed representation to that alarm:
ingest already holds the Delta instructions, base, and result.
Before loading a Repack base and target together, maintenance estimates the raw
objects, candidate Delta, and compressed Delta against a 96 MiB working-set
budget; it reads only the cached full-entry size and skips candidates over that
budget. This leaves 32 MiB of the Durable Object's 128 MiB ceiling for runtime
overhead.
Fork copies retained Delta metadata and bytes when the base belongs to the same
snapshot. Sweep's completed mark set remains as the current reachability index,
and parsed object edges let Upload-pack traverse ids without repeatedly loading
commit and tree contents.

Upload-pack limits active and queued representation reads to 16 MiB in total.
A representation above that budget runs alone. The reservation remains active
until its window finishes emitting. Indexed connectivity uses one SQLite graph
walk, with object reads as a fallback for missing indexes. Incremental fetches
subtract client-reachable objects as well as stopping at common commit tips.
