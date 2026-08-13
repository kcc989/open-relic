import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";

import type { SyncSqliteDatabase } from "../../src/db/database.ts";
import type { SyncKv } from "../../src/db/kv.ts";

const migrationsFolder = (durableObject: "registry" | "repository"): string =>
  fileURLToPath(new URL(`../../drizzle/${durableObject}`, import.meta.url));

export interface TestDatabase {
  readonly db: SyncSqliteDatabase;
  readonly close: () => void;
}

/**
 * A repository object's storage: its SQL database and its KV side.
 *
 * They are one storage in a Durable Object, so the two are handed out together
 * and torn down together here as well.
 */
export interface TestRepositoryStorage extends TestDatabase {
  readonly kv: SyncKv;
}

/**
 * A Map standing in for `ctx.storage.kv` — the synchronous KV API, which is a
 * plain string-keyed map with no semantics beyond `get`, `put`, and `delete`.
 */
export const createTestKv = (): SyncKv => {
  const entries = new Map<string, string>();

  return {
    get: (key) => entries.get(key),
    put: (key, value) => {
      entries.set(key, value);
    },
    delete: (key) => {
      entries.delete(key);
    },
  };
};

/**
 * An in-memory drizzle database migrated from the same `drizzle/` folder the
 * matching Durable Object applies at startup.
 *
 * `bun:sqlite` and a Durable Object's storage are both synchronous SQLite, and
 * drizzle presents them through the same query builder, so the query classes
 * and the generated schema are exercised for real here — the only thing the
 * tests skip is the RPC hop.
 *
 * Foreign keys are enabled explicitly because Durable Object SQLite enforces
 * them and `bun:sqlite` does not by default; without the pragma the tests
 * would be looser than production.
 */
const createDatabase = (
  durableObject: "registry" | "repository",
): TestDatabase => {
  const client = new Database(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  const db = drizzle({ client });

  migrate(db, { migrationsFolder: migrationsFolder(durableObject) });

  return {
    db,
    close: () => {
      client.close();
    },
  };
};

/** The namespace registry's database: namespaces and the repository index. */
export const createTestDatabase = (): TestDatabase => createDatabase("registry");

/** One repository object's storage, SQL and KV. */
export const createTestRepositoryStorage = (): TestRepositoryStorage => ({
  ...createDatabase("repository"),
  kv: createTestKv(),
});
