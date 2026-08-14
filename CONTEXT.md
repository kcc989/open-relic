# Open Relic

A self-hostable Git service, wire-compatible with Cloudflare Artifacts. One
bounded context: the vocabulary below is shared by the REST API, the Git
protocol, and the storage beneath both.

## The service

**Installation**:
One deployment of Open Relic, owned by whoever runs it. Single-tenant — there is
no account above it.
_Avoid_: instance, tenant, account

**Namespace**:
The owner of a set of repositories, the way a GitHub user or organization owns
them. Identified by its slug.
_Avoid_: organization, owner, project

**Repository**:
A bare Git repository inside a namespace, identified by `namespace/name`.
_Avoid_: artifact, project

**Read-only repository**:
A repository whose Git data may be read but whose refs may not be changed by a
push. Read-only does not prevent control-plane operations such as deletion.
_Avoid_: read-only token, immutable repository

**Repository status**:
The repository's availability phase: creating, importing, forking, or ready.
Only a ready repository may serve its Git data.
_Avoid_: lifecycle state, repository state

**Import**:
Creation of a repository from one branch of a public HTTPS Git remote. The
branch is named by the request or discovered from the remote's HEAD; its history
may be complete or shallow.
_Avoid_: mirror, clone

**Registry**:
The single store of every namespace in the installation and the index of their
repositories. It owns naming; a repository's contents are not in it.
_Avoid_: catalog, directory

**Git token**:
A repository-scoped credential presented to the Git protocol, carrying a read
or write scope and an expiry.
_Avoid_: repository token, token, key, secret, credential

**API token**:
An installation-wide credential presented to the REST API. It authorizes use of
the whole Open Relic service rather than access to one repository's Git data.
_Avoid_: master token, installation token, token

## Git data

**Object**:
An immutable blob, tree, commit, or tag, named by the SHA-1 of its contents. The
unit everything in a repository is made of.

**Logical usage**:
The sum of the inflated sizes of the unique objects stored by a repository.
Orphans count until collected; pack compression, chunks, and retained delta
representations do not change the total.
_Avoid_: repository size, physical storage, billed storage

**Storage quota**:
The maximum logical usage a storage boundary permits.
_Avoid_: disk limit, object limit, storage size

**Chunk**:
A slice of one object's bytes, sized to fit a single storage row. An object is
one or more chunks; nothing but storage knows about them.
_Avoid_: block, segment, page

**Ref**:
A named pointer to an object — `refs/heads/main`, `refs/tags/v1`. Use _ref_ for
the general case and _branch_ only for `refs/heads/*`.
_Avoid_: reference, pointer

**HEAD**:
The repository's current pointer: either symbolic, naming a ref, or detached,
naming an object directly. What a fresh clone checks out.
_Avoid_: default branch, main branch

**Orphan**:
An object no ref can reach. Invisible to every reader, and collectable.
_Avoid_: dangling object, garbage

**Sweep**:
A repository's resumable walk from every ref that marks reachable objects and reclaims its orphans.
_Avoid_: garbage collection, cleanup

**Fast-forward**:
A ref update whose old value is an ancestor of its new one, so nothing that was
reachable stops being reachable. A plain Git client sends only this kind of
update; replacing history requires a force update.
_Avoid_: forward update, non-destructive update

**Force update**:
A ref update the client explicitly sends even though it is not a fast-forward.
It is still conditional on the ref holding the old value the client saw.
_Avoid_: forced push, overwrite

**Connectivity**:
That every object a ref can reach is present. Checked before a push moves a ref,
because a ref naming an object that is not there is a repository no client can
read and nothing after the fact can repair.
_Avoid_: integrity, validation

## The wire

**Pack**:
The stream of objects a client sends on a push or receives on a fetch, in Git's
packfile encoding.
_Avoid_: bundle, archive

**Thin pack**:
A Pack whose ref-delta omits a base Object the receiver already holds.
_Avoid_: partial pack

**Delta**:
An object expressed as edits against another object, its _base_, rather than in
full.

**Advertisement**:
The server's opening reply to a Git client, listing the refs it holds and the
capabilities it supports.
_Avoid_: ref discovery, handshake

**Capability**:
One named protocol feature the server tells the client it supports. Advertising
one is a promise to honor it.
_Avoid_: feature, option, extension

**Receive-pack**:
The server side of a push: read the client's ref update commands and pack, then
accept or reject each command.
_Avoid_: push handler, ingest

**Command**:
One line of a push: move this ref from this object to that one. A create spells
its old value as the zero id and a delete its new one.
_Avoid_: ref update request, instruction

**Report-status**:
The server's answer to a push: whether the pack could be read, and then one
accepted-or-rejected line per command, in the order the client sent them.
_Avoid_: push result, status report

**Atomic push**:
A push whose Commands either all move their Refs or all fail together.
_Avoid_: transaction

**Push option**:
An opaque value a client sends between the Commands and Pack for receive hooks.
Open Relic accepts and validates these even though it has no hook consumer yet.
_Avoid_: flag, argument

**Upload-pack**:
The server side of a fetch or clone: negotiate what the client is missing, then
send it.
_Avoid_: fetch handler, clone handler
