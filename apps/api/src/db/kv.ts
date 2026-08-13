/**
 * The synchronous key-value half of a Durable Object's storage.
 *
 * `DurableObjectStorage["kv"]` satisfies this structurally, and so does the
 * Map-backed double the tests use. It is the same SQLite database the SQL API
 * writes to, so a KV write and a SQL write in one storage turn commit together.
 *
 * Narrowed to `string` values: the only thing stored through it is the literal
 * contents of a Git file.
 */
export interface SyncKv {
  readonly get: (key: string) => string | undefined;
  readonly put: (key: string, value: string) => void;
  readonly delete: (key: string) => void;
}
