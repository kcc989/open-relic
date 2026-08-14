# Git reaches a repository over RPC, through an authorization seam

Status: accepted

A Git request arrives at the Worker, which resolves `namespace/repo` in the
registry, passes the request through an authorization seam, and then calls a
**named RPC method** on the repository's Durable Object — `advertiseReceivePack`,
`receivePack`, `advertiseUploadPack`, or `uploadPack`. The object's `fetch`
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

The implementation hashes the presented token secret and checks the registry's
Git token row for namespace, repository, scope, revocation, and expiry.
The Bearer spelling carries the full token; HTTP Basic carries its secret half
as the password and ignores the username, matching Artifacts.

The refusal comes _before_ the registry lookup, so whether a repository exists
is not something an unauthorized client can learn.

## Consequences

Repository operations are implemented once as inherited class methods. A
`RepositoryObject` inherits them over Durable Object storage; a
`RepositoryStore` inherits the same methods over local storage, which lets tests
drive real queries against real migrations without a Workers runtime. The
object itself adds only durable import scheduling, alarm arming, and
destruction. The client type is derived from that implementation rather than
restating every method.

The inheritance is load-bearing: Workers RPC exposes methods declared on class
prototypes, not function-valued instance properties. The shared implementation
therefore preserves named RPC methods and does not replace them with a forwarded
request, an object of closures, or runtime-installed delegates.

There is no anonymous-write mode. Upload-pack requires read scope (which a write
token also grants); receive-pack requires write scope. A missing, malformed,
expired, revoked, or insufficiently scoped token is refused before the
repository lookup, so it cannot reveal whether another repository exists.

The REST control plane is separately protected by the API token.
Without that boundary, an anonymous caller could mint its own write Token and
make this Git check ceremonial; token issue, list, and revoke never sit outside
the control-plane gate.
