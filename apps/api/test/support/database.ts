import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";

import type { SyncSqliteDatabase } from "../../src/db/database.ts";

const migrationsFolder = (durableObject: "registry" | "repository"): string =>
  fileURLToPath(new URL(`../../drizzle/${durableObject}`, import.meta.url));

export interface TestDatabase {
  readonly db: SyncSqliteDatabase;
  readonly close: () => void;
}

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

/** One repository object's database. */
export const createTestRepositoryDatabase = (): TestDatabase =>
  createDatabase("repository");
