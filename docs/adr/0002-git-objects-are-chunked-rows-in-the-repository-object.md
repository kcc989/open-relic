# Git objects are chunked rows in the repository object

Status: accepted

Git object bytes live in the repository's own Durable Object: metadata in a
Drizzle SQL table, raw bytes in the synchronous KV API (`ctx.storage.kv`) under
`o:<sha>:<n>`, split into 1.5 MiB chunks because Durable Object storage caps a
key and value together at 2 MB. Cloudflare's own Artifacts does exactly this —
_"Files are stored in the underlying Durable Object's SQLite database. Durable
Object storage has a 2MB max row size, so large Git objects are chunked and
stored across multiple rows"_ — and compatibility ([ADR-0001](./0001-wire-compatible-with-cloudflare-artifacts.md))
makes their shape the one to follow.

## Considered options

Keeping the received packfile whole in R2 with a generated `.idx`, and serving
reads as ranged GETs, is git's own on-disk design and was the obvious
alternative. It was rejected because it puts every object read behind a network
hop, and because it forecloses the property below.

## Consequences

**Storage is the random-access structure.** Because every resolved object is
written the moment it is complete, a delta resolves by reading its base back out
of storage rather than by holding the pack in memory. Peak residency is one
object plus one base plus one chunk, independent of pack size — which is what
makes a streaming single-pass parser possible inside a 128 MB Durable Object.
This is the reason for the decision, not a side effect of it.

**Objects are written before the push is accepted, and orphans are kept.** A push
that fails halfway leaves objects no ref points at. They are invisible — a ref is
the only thing that makes an object reachable — so this is a storage-cost problem
and not a correctness one. Quarantining every byte and promoting on success would
double the writes to avoid garbage that a sweep can collect later.

**Deltas are persisted alongside the resolved object**, with their base hash,
even though nothing reads them until fetch lands. Artifacts does the same, and
for the same reason: the delta passes through our hands exactly once, during the
parse. Discarding it means a migration _and_ re-deriving data from packs we no
longer keep.

**A metadata row is not visibility.** New object rows begin incomplete, and
reads ignore them until every resolved chunk, optional retained-delta row, and
retained-delta chunk has been written. Storage exhaustion reports a repository-
storage failure and removes that pending representation in one storage
transaction. If cleanup itself is interrupted, the hidden row remains so a
retry or Sweep can finish it. Objects completed earlier in the same failed Pack
remain ordinary Orphans for the Sweep to reclaim.

Resolved Objects are stored inflated so reads and delta-base lookups do not pay
an inflate. They remain the authority, while derived zlib Pack representations
are cached beside them so fetch does not repeatedly recompress the same bytes;
[ADR-0006](./0006-resolved-objects-and-pack-representations-are-a-hybrid.md)
records that hybrid rather than replacing this random-access structure.
