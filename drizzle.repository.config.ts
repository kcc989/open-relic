import { defineConfig } from "drizzle-kit";

/**
 * Migrations for a repository's own Durable Object, separate from the
 * registry's because each object class has its own storage. See
 * `drizzle.config.ts`.
 */
export default defineConfig({
  out: "./apps/api/drizzle/repository",
  schema: "./apps/api/src/db/repository-schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
