import { defineConfig } from "drizzle-kit";

/**
 * Migrations for the namespace registry Durable Object. The `durable-sqlite`
 * driver emits a `migrations.js` bundle alongside the raw SQL, which the object
 * imports and applies itself — there is no network-connected database for
 * drizzle-kit to push to.
 *
 * Each Durable Object class has its own storage, so each gets its own schema
 * and output folder; see `drizzle.repository.config.ts` for the other.
 */
export default defineConfig({
  out: "./apps/api/drizzle/registry",
  schema: "./apps/api/src/db/registry-schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
