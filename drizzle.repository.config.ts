import { defineConfig } from "drizzle-kit";

/**
 * Migrations for a repository's own Durable Object. One `RepositoryObject`
 * exists per repository and each has its own SQLite database, so it needs a
 * schema and a migrations bundle separate from the registry's — see
 * `drizzle.config.ts`.
 */
export default defineConfig({
  out: "./apps/api/drizzle/repository",
  schema: "./apps/api/src/db/repository-schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
