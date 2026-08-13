import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core/async/db";

/**
 * A Durable Object's storage and `bun:sqlite` both extend this, so the query
 * classes are written once and run unchanged in both. The run result type is
 * all that differs between the drivers, and nothing reads it.
 */
export type SyncSqliteDatabase = SQLiteAsyncDatabase<"sync", unknown>;
