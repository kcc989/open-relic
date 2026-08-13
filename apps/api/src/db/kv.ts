/**
 * The synchronous key-value half of a Durable Object's storage, narrowed to the
 * `string` values Git files are. `ctx.storage.kv` satisfies it structurally,
 * and so does the `Map` the tests use.
 */
export interface SyncKv {
  readonly get: (key: string) => string | undefined;
  readonly put: (key: string, value: string) => void;
  readonly delete: (key: string) => void;
}
