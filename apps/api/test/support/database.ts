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

export interface TestRepositoryStorage extends TestDatabase {
  readonly kv: SyncKv;
}

/**
 * Durable Object KV structured-clones what it is given, so the fake does too —
 * otherwise a caller could hand over a buffer, reuse it, and see the store
 * change underneath it in tests but not in production.
 */
export const createTestKv = (): SyncKv => {
  const entries = new Map<string, unknown>();

  return {
    get: <T>(key: string): T | undefined => entries.get(key) as T | undefined,
    put: (key: string, value: unknown): void => {
      entries.set(key, structuredClone(value));
    },
    delete: (key: string): void => {
      entries.delete(key);
    },
  };
};

/**
 * An in-memory database migrated from the same `drizzle/` folder the matching
 * Durable Object applies at startup, so the queries and the generated schema
 * are exercised for real — the only thing the tests skip is the RPC hop.
 *
 * Foreign keys are enabled explicitly because Durable Object SQLite enforces
 * them and `bun:sqlite` does not; without the pragma the tests would be looser
 * than production.
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
