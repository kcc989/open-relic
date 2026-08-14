/**
 * The synchronous key-value half of a Durable Object's storage. `ctx.storage.kv`
 * satisfies it structurally, and so does the `Map` the tests use.
 *
 * Most of what goes in here is a Git file, so `string` is the reading without
 * asking. Object chunks are raw bytes, and name what they want.
 */
export interface SyncKv {
  get(key: string): string | undefined;
  get<T>(key: string): T | undefined;
  /** SQLite-backed Durable Objects can fetch up to 128 explicit keys in one await. */
  getMany?<T>(keys: readonly string[]): Promise<ReadonlyMap<string, T>>;
  put(key: string, value: string): void;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
}
