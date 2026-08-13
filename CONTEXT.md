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

**Registry**:
The single store of every namespace in the installation and the index of their
repositories. It owns naming; a repository's contents are not in it.
_Avoid_: catalog, directory

**Token**:
A repo-scoped credential presented to the Git protocol, carrying a read or write
scope and an expiry.
_Avoid_: key, secret, credential

## Git data

**Object**:
An immutable blob, tree, commit, or tag, named by the SHA-1 of its contents. The
unit everything in a repository is made of.

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

## The wire

**Pack**:
The stream of objects a client sends on a push or receives on a fetch, in Git's
packfile encoding.
_Avoid_: bundle, archive

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

**Upload-pack**:
The server side of a fetch or clone: negotiate what the client is missing, then
send it.
_Avoid_: fetch handler, clone handler
