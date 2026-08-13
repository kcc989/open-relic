/**
 * drizzle-kit's generated `drizzle/migrations.js` imports each migration's
 * `.sql` file and hands the text to the Durable Object migrator. Alchemy's
 * bundler maps `.sql` to a text module for exactly this case, so the import
 * resolves to the file's contents at runtime — this declaration is how the
 * type checker sees the same thing.
 */
declare module "*.sql" {
  const sql: string;
  export default sql;
}
