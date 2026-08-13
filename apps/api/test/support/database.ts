import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";

import type { NamespaceDatabase } from "../../src/namespace-registry.ts";

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/**
 * An in-memory drizzle database migrated from the same `drizzle/` folder the
 * Durable Object applies at startup.
 *
 * `bun:sqlite` and a Durable Object's storage are both synchronous SQLite, and
 * drizzle presents them through the same query builder, so the registry's
 * queries and the generated schema are exercised for real here — the only
 * thing the tests skip is the RPC hop.
 */
export const createTestDatabase = (): {
  readonly db: NamespaceDatabase;
  readonly close: () => void;
} => {
  const client = new Database(":memory:");
  const db = drizzle({ client });

  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    close: () => {
      client.close();
    },
  };
};
