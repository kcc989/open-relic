# Git reaches a repository over RPC, through an authorization seam

Status: accepted

A Git request arrives at the Worker, which resolves `namespace/repo` in the
registry, passes the request through an authorization seam, and then calls a
**named RPC method** on the repository's Durable Object — `advertiseReceivePack`
today, one method per Git operation as the rest lands. The object's `fetch`
handler is not part of the path and answers `501`.

## Why not forward the request

Forwarding the `Request` to the object is the shape Durable Objects are usually
shown in, and it is the wrong one here:

- The Worker is already in the path. Nothing addresses a repository object by
  name ([the registry owns naming](../../README.md#repositories)), so resolving
  the URL to an object id is a registry lookup that has to happen first. Having
  done it, handing the object a URL to parse again is asking a second component
  to re-derive what the first already knows.
- RPC methods are typed at the call site. `context.env.REPOSITORIES` is a
  `DurableObjectNamespace<RepositoryObject>`, so a method that changes shape is a
  compile error rather than a `404` from a router inside an object.
- The seam stays outside. Authorization, the v4 error envelope, and the HTTP
  status of a refusal are the Worker's; what the object owns is Git.

Streams cross the RPC boundary, so this costs nothing in buffering: the object
returns a `ReadableStream` of pkt-lines and the Worker makes it the response
body. A repository with many refs is never assembled in memory.

## The authorization seam

Every Git request passes `AuthorizeGitRequest` before the repository is
resolved, carrying the credential-bearing request and the `namespace/repository`
it is being spent against — the two things a token check needs.

Today the only implementation allows everyone, gated on the installation setting
`ALLOW_ANONYMOUS_WRITE="true"`. Absent or unrecognized configuration is a
refusal, not a default: an installation deployed without ever hearing of the
variable is closed rather than open to the world, and a typo in the value fails
the same way.

The refusal comes *before* the registry lookup, so whether a repository exists
is not something an unauthorized client can learn.

Repo-scoped tokens replace the implementation and remove the variable. The seam
is what makes that a one-file change.

## Consequences

`RepositoryObject` stays a thin RPC shell over `RepositoryStore`, which is what
lets the tests drive real queries against real migrations without a Workers
runtime — including the advertisement, since the encoding lives in the store
rather than in the shell.

Until tokens land, an installation that wants to accept pushes is one that
accepts them from anyone who can reach it. That is why the variable is spelled
out in full rather than defaulted, and why it is a deploy-time decision.
