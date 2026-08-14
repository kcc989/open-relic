# Sweeps checkpoint and restart their mark when refs change

Status: accepted

A repository sweeps in bounded alarm turns, persisting both its work queue and
its mark set in the repository object. Receive-pack, one sweep turn and its
alarm re-arm, and repository destruction share an in-memory operation gate.
Every accepted ref transaction increments a durable version; before each turn,
a sweep compares that version with the one it marked. If they differ, it clears
the stale mark set and walks from the current refs before deleting another
object.

## Why not hold a maintenance lock for the whole sweep

A large repository can take many turns to walk. A durable lock held across
those turns would reject or indefinitely delay pushes when an alarm is retried,
the object is evicted, or a deployment interrupts the sweep. A creation epoch
on objects is not sufficient either: a push may make a previously orphaned
object reachable without rewriting it, so its old epoch would still make it a
deletion candidate.

The short operation gate closes the dangerous interval inside a push — after
objects are written but before refs move. The durable ref version closes the
interval between sweep turns. Together they let pushes proceed between batches
without letting deletion rely on a stale reachability snapshot.

Destruction waits through any active turn's alarm re-arm, then `deleteAll()`
removes both data and that alarm. A suspended sweep therefore cannot repopulate
an otherwise empty, deleted repository object.

## Consequences

The sweep is a persisted two-phase mark-and-sweep. Its checkpoint survives
eviction and alarms resume one bounded batch at a time. A push that lands during
a long sweep may make some marking work repeat, but never makes reachable data
eligible for deletion.

Completed state is retained as the latest reclamation report: reachable object
count and reclaimed object, chunk, and payload-byte totals. Object and delta
chunks, their SQL metadata, and those totals update in the same storage
transaction. The completed mark set remains as the repository's reachability
index for that ref version. A later ref version clears and rebuilds it before
another object can be reclaimed.
