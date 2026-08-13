// Alchemy's bundler maps `.sql` to a text module, which is how the generated
// `migrations.js` imports migrations. This is the type checker's view of it.
declare module "*.sql" {
  const sql: string;
  export default sql;
}
