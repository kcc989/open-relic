# HEAD is the literal Git file, not a default-branch column

Status: accepted

A repository object stores `HEAD` under a single key in the synchronous KV API,
holding exactly the bytes `.git/HEAD` holds — `ref: refs/heads/main\n` when
symbolic, a bare 40-hex SHA when detached. The `default_branch` column that
`repository_state` carried is removed: it stored a branch *name* where Git stores
a ref *path*, it could not express a detached HEAD at all, and having both left
the repository object with two candidate authorities for one fact.

## Consequences

`describe()` reads HEAD and parses the branch name out of it to answer the REST
API's `default_branch`. The registry's denormalized `repositories.default_branch`
is unaffected and stays what it already claims to be — a cache of the repository
object's HEAD, kept so that listing a namespace is one query rather than a fan-out.

A first push retargets HEAD, but only when the repository had no refs and the
push creates exactly one branch. That is what `git init && git push -u origin
master` should do against a repository created with a `main` default. Any other
push leaves HEAD alone.

The ref insert and the HEAD rewrite land in the same storage turn. KV and SQL are
the same SQLite database inside the object, so they commit together and a push
cannot leave a ref without its HEAD or the reverse.

Because nothing has run in production, the `repository_state` migration was
regenerated rather than superseded — there is no column-drop migration to carry
forward.
