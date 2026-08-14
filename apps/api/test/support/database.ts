import { Database, SQLiteError } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";

import type { SyncSqliteDatabase } from "../../src/db/database.ts";
import type { SyncKv } from "../../src/db/kv.ts";
import { refs, shallowCommits } from "../../src/db/repository-schema.ts";

const migrationsFolder = (durableObject: "registry" | "repository"): string =>
  fileURLToPath(new URL(`../../drizzle/${durableObject}`, import.meta.url));

export interface TestDatabase {
  readonly db: SyncSqliteDatabase;
  readonly client: Database;
  readonly close: () => void;
}

export interface TestRepositoryStorage extends TestDatabase {
  readonly kv: SyncKv;
}

interface TestDatabaseOptions {
  /** Reject queries that the target SQLite runtime could not execute. */
  readonly maxBoundValues?: number;
  readonly onQuery?: (query: string, params: unknown[]) => void;
}

/**
 * Durable Object KV structured-clones what it is given, so the fake does too —
 * otherwise a caller could hand over a buffer, reuse it, and see the store
 * change underneath it in tests but not in production.
 */
export const createTestKv = (): SyncKv => {
  const entries = new Map();

  return {
    get: <T>(key: string): T | undefined => entries.get(key),
    getMany: async <T>(keys: readonly string[]): Promise<ReadonlyMap<string, T>> => {
      const found = new Map<string, T>();
      for (const key of keys) {
        if (entries.has(key)) {
          found.set(key, entries.get(key));
        }
      }
      return found;
    },
    put: <T>(key: string, value: T): void => {
      entries.set(key, structuredClone(value));
    },
    delete: (key: string): void => {
      entries.delete(key);
    },
  };
};

/** A real driver error, not a message-shaped stand-in for one. */
export const createSqliteFullError = (): SQLiteError => {
  const client = new Database(":memory:");

  try {
    client.run("PRAGMA max_page_count = 1");
    client.run("CREATE TABLE exhausts_the_database (value text)");
  } catch (error) {
    if (error instanceof SQLiteError && error.code === "SQLITE_FULL") {
      return error;
    }
    throw error;
  } finally {
    client.close();
  }

  throw new Error("The test database did not exhaust its storage.");
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
  options: TestDatabaseOptions = {},
): TestDatabase => {
  const client = new Database(":memory:");
  client.run("PRAGMA foreign_keys = ON");
  const maxBoundValues = options.maxBoundValues ?? 100;
  const db = drizzle({
    client,
    logger: {
      logQuery(query, params) {
        options.onQuery?.(query, params);
        if (params.length > maxBoundValues) {
          throw new RangeError(
            `SQLite statement binds ${params.length} values; the configured maximum is ${maxBoundValues}.`,
          );
        }
      },
    },
  });

  migrate(db, { migrationsFolder: migrationsFolder(durableObject) });

  return {
    db,
    client,
    close: () => {
      client.close();
    },
  };
};

/** The namespace registry's database: namespaces and the repository index. */
export const createTestDatabase = (options: TestDatabaseOptions = {}): TestDatabase =>
  createDatabase("registry", options);

/** One repository object's storage, SQL and KV. */
export const createTestRepositoryStorage = (
  options: TestDatabaseOptions = {},
): TestRepositoryStorage => ({
  ...createDatabase("repository", options),
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

/** Shallow boundaries written as import would persist them. */
export const seedShallowCommits = async (
  db: SyncSqliteDatabase,
  oids: readonly string[],
): Promise<void> => {
  if (oids.length > 0) {
    await db.insert(shallowCommits).values(oids.map((oid) => ({ oid })));
  }
};
