import { defineConfig } from "drizzle-kit";

/**
 * Migrations for the namespace registry Durable Object.
 *
 * The `durable-sqlite` driver emits a `migrations.js` bundle alongside the raw
 * SQL, which the Durable Object imports and applies itself — there is no
 * network-connected database for drizzle-kit to push to. Alchemy's bundler maps
 * `.sql` imports to text, so the generated bundle needs no extra build config.
 */
export default defineConfig({
  out: "./apps/api/drizzle",
  schema: "./apps/api/src/db/schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
