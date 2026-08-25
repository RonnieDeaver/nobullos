import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // Task #1814 — exclude Postgres extension-owned objects from
  // drizzle-kit introspection. The dev workspace has the
  // `pg_stat_statements` extension installed (Task #1724 regression
  // scan) which auto-creates `pg_stat_statements` and
  // `pg_stat_statements_info` views in `public`. Without this filter
  // drizzle-kit's deploy-time diff treats them as app schema and emits
  // `CREATE VIEW` statements that fail on prod (where the extension
  // is not yet installed; see PROD_REMEDIATION.md § 3). Add new
  // patterns here if we install other system-view-bearing extensions.
  tablesFilter: ["!pg_stat_statements", "!pg_stat_statements_info"],
});
