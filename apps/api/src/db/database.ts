import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core/async/db";

/**
 * Any synchronous SQLite database drizzle can drive.
 *
 * `DrizzleSqliteDODatabase` (a Durable Object's storage) and `SQLiteBunDatabase`
 * (`bun:sqlite`, used by the tests) both extend this, so the query classes are
 * written once and run unchanged in both places. The run result type is the
 * only thing that differs between the two drivers and nothing reads it.
 */
export type SyncSqliteDatabase = SQLiteAsyncDatabase<"sync", unknown>;
