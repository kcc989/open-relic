import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";

import type { SyncSqliteDatabase } from "../../src/db/database.ts";
import type { SyncKv } from "../../src/db/kv.ts";
import { refs } from "../../src/db/repository-schema.ts";

const migrationsFolder = (durableObject: "registry" | "repository"): string =>
  fileURLToPath(new URL(`../../drizzle/${durableObject}`, import.meta.url));

export interface TestDatabase {
  readonly db: SyncSqliteDatabase;
  readonly close: () => void;
}

export interface TestRepositoryStorage extends TestDatabase {
  readonly kv: SyncKv;
}

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

/**
 * Refs written straight into a repository's storage. A push is what will put
 * them there; until it can, this is how a test gets a repository that holds
 * something to advertise.
 */
export const seedRefs = async (
  db: SyncSqliteDatabase,
  entries: Readonly<Record<string, string>>,
): Promise<void> => {
  const rows = Object.entries(entries).map(([name, objectId]) => ({
    name,
    objectId,
  }));

  if (rows.length > 0) {
    await db.insert(refs).values(rows);
  }
};
