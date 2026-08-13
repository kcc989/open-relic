import { defineConfig } from "drizzle-kit";

/**
 * Migrations for the namespace registry Durable Object — namespaces and the
 * index of repositories that points at each `RepositoryObject`.
 *
 * The `durable-sqlite` driver emits a `migrations.js` bundle alongside the raw
 * SQL, which the Durable Object imports and applies itself — there is no
 * network-connected database for drizzle-kit to push to. Alchemy's bundler maps
 * `.sql` imports to text, so the generated bundle needs no extra build config.
 *
 * Each Durable Object class has its own storage, so each gets its own schema
 * and its own output folder; see `drizzle.repository.config.ts` for the other.
 */
export default defineConfig({
  out: "./apps/api/drizzle/registry",
  schema: "./apps/api/src/db/registry-schema.ts",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
