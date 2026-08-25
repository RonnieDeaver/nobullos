/**
 * Dev-only migration runner.
 *
 * Background (Task #1702): the project's `migrations/` directory contains
 * raw SQL files (0000_…sql … 0068_…sql) but Drizzle's own migrator
 * journal (`migrations/meta/_journal.json`) is stale — only the first
 * 11 migrations were ever registered with `drizzle-kit generate`. The
 * deploy path uses `drizzle-kit push --force` plus a hand-curated list
 * of `psql -f` invocations inside `scripts/post-merge.sh`, but the dev
 * workflow had no equivalent. That's how migration 0067
 * (`user_notifications`) shipped with Task #1686 and never landed on
 * the dev Helium database — `notifyUser()`-touching tests failed with
 * "relation user_notifications does not exist" until someone applied
 * it by hand during Task #1688.
 *
 * This module fixes that hole. On every dev startup (and at the top of
 * the test runner bootstrap), it:
 *
 *   1. Ensures a `_dev_applied_migrations` ledger table exists.
 *   2. On first creation against an already-populated DB, backfills
 *      the ledger with every currently-present `migrations/*.sql`
 *      filename so legacy non-idempotent files (0000–0005) are NOT
 *      re-run against the existing dev DB.
 *   3. Applies every `migrations/*.sql` file not already in the ledger,
 *      in sort order, each inside its own transaction.
 *   4. Throws loudly if any apply fails OR if any migration files
 *      remain pending after the run (the regression check the task's
 *      "Done looks like" bullet calls for).
 *
 * This runner is a NO-OP when `NODE_ENV=production`. Deployed prod
 * continues to go through `scripts/post-merge.sh` / `predeploy.sh`,
 * which is the only place authorised to mutate the Neon schema.
 *
 * Task #1851: pool tenancy — this module is a background-style startup
 * task and therefore runs on the shared `workerPool` (the background
 * pool) rather than its own dedicated `pg.Pool`. Each DB hold is
 * labelled via `withDbAttribution()` under the `startup:dev-migrations:*`
 * namespace so the attribution dashboard can see exactly which phase
 * of the migration runner held a connection. The previous
 * implementation created its own `pg.Pool` and called `pool.query`
 * directly — that was the last remaining `pool.query(` caller under
 * `server/` and bypassed the three-pool architecture. We deliberately
 * still use a checked-out `PoolClient` (not Drizzle's `sql`-template
 * helper) for the actual queries because the migration files contain
 * multi-statement SQL and the backfill needs raw `$N` parameter
 * binding semantics that Drizzle's array-spread behaviour breaks.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool, PoolClient } from "pg";
import { workerPool, withDbAttribution } from "./db";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);
const LEDGER_TABLE = "_dev_applied_migrations";

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

async function ledgerExists(client: PoolClient): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [LEDGER_TABLE],
  );
  return Boolean(res.rows[0]?.exists);
}

async function coreSchemaExists(client: PoolClient): Promise<boolean> {
  // `clients` is the canonical "the schema has been bootstrapped" probe:
  // it's created in 0000 and has been present in every dev/prod DB
  // since day one.
  const res = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.clients') IS NOT NULL AS exists`,
  );
  return Boolean(res.rows[0]?.exists);
}

async function getAppliedFilenames(client: PoolClient): Promise<Set<string>> {
  const res = await client.query<{ filename: string }>(
    `SELECT filename FROM ${LEDGER_TABLE}`,
  );
  return new Set(res.rows.map((r) => r.filename));
}

async function ensureLedgerAndMaybeBackfill(
  client: PoolClient,
  files: string[],
): Promise<{ created: boolean; backfilled: number }> {
  const had = await ledgerExists(client);
  if (had) return { created: false, backfilled: 0 };

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // First creation of the ledger. If the DB already has the core
  // schema (i.e. this is the existing dev workspace, not a brand-new
  // empty DB), treat every current migration file as already applied
  // — re-running 0000–0005 against a populated DB would error
  // because those auto-generated files are not idempotent.
  if (!(await coreSchemaExists(client))) {
    return { created: true, backfilled: 0 };
  }

  if (files.length === 0) return { created: true, backfilled: 0 };

  const values = files.map((_, i) => `($${i + 1})`).join(", ");
  await client.query(
    `INSERT INTO ${LEDGER_TABLE}(filename) VALUES ${values}
     ON CONFLICT (filename) DO NOTHING`,
    files,
  );
  return { created: true, backfilled: files.length };
}

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Parse a migration's SQL for the unquoted/quoted names of every
 * `CREATE TABLE [IF NOT EXISTS] [schema.]name` it declares. Used by
 * the boot-time ledger reconciliation to detect "ledger says applied,
 * but the table the migration was supposed to create does not exist"
 * drift (Task #1940).
 *
 * The matcher is intentionally conservative: it only looks at
 * `CREATE TABLE …` (not `CREATE INDEX`, `ALTER TABLE`, etc.) because
 * those are the strongest "this object MUST exist if the file truly
 * ran" signals. Comment lines (`--`) are stripped first so the
 * regex doesn't pick up commented-out examples.
 */
export function extractCreatedTableNames(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const re =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?/gi;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const schema = m[1];
    const table = m[2];
    if (!table) continue;
    if (schema && schema.toLowerCase() !== "public") continue;
    names.push(table);
  }
  return Array.from(new Set(names));
}

/**
 * Returns true when every schema-mutating statement in the migration
 * is guarded by `IF NOT EXISTS` (CREATE TABLE / CREATE INDEX /
 * CREATE UNIQUE INDEX / ALTER TABLE … ADD COLUMN / ADD CONSTRAINT /
 * CREATE TYPE). Used by the reconciler to decide whether a
 * drift-detected migration is safe to re-run automatically, or
 * whether we must refuse to start and let an operator intervene.
 *
 * The legacy 0000–0005 auto-generated files are NOT idempotent and
 * MUST fall into the "unsafe, abort" branch if they ever drift.
 */
export function isMigrationIdempotent(sql: string): boolean {
  const stripped = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const guardedCreateTable = /create\s+table\s+if\s+not\s+exists\b/gi;
  const bareCreateTable = /create\s+table\s+(?!if\s+not\s+exists\b)/gi;
  if (
    (stripped.match(bareCreateTable)?.length ?? 0) >
    (stripped.match(guardedCreateTable)?.length ?? 0) - 1
  ) {
    // Cheap structural check: every CREATE TABLE occurrence must be
    // the IF-NOT-EXISTS variant. Count bare ones and bail if any.
  }
  if (/create\s+table\s+(?!if\s+not\s+exists\b)/i.test(stripped)) return false;
  if (/create\s+(unique\s+)?index\s+(?!if\s+not\s+exists\b)/i.test(stripped))
    return false;
  if (/alter\s+table\s+[^;]*\badd\s+column\s+(?!if\s+not\s+exists\b)/i.test(stripped))
    return false;
  if (/create\s+type\s+(?!if\s+not\s+exists\b)/i.test(stripped)) {
    // CREATE TYPE has no IF NOT EXISTS in older PG; allow when wrapped
    // in a DO $$ … EXCEPTION block (common pattern in this repo).
    if (!/do\s+\$\$[\s\S]*exception[\s\S]*\$\$/i.test(stripped)) return false;
  }
  return true;
}

/**
 * Parse DROP TABLE statements (`DROP TABLE [IF EXISTS] [schema.]name`)
 * from a migration body. Used to keep the reconciler from flagging
 * tables that were intentionally removed by a later migration (e.g.
 * `notifications` created in 0000 and dropped in
 * 0069_drop_legacy_notifications.sql).
 */
export function extractDroppedTableNames(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const re =
    /drop\s+table\s+(?:if\s+exists\s+)?(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?/gi;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const schema = m[1];
    const table = m[2];
    if (!table) continue;
    if (schema && schema.toLowerCase() !== "public") continue;
    names.push(table);
  }
  return Array.from(new Set(names));
}

/**
 * Parse `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON
 * [schema.]table` statements, returning the index name plus the table
 * it sits on. Used (Task #1959) to catch the drift class where a
 * ledger row claims a migration ran but the index it was supposed to
 * create is missing — the failure would otherwise surface at query
 * time (slow scan / planner regression) instead of at boot.
 *
 * Comment lines are stripped first. Indexes declared on a non-public
 * schema are skipped to stay consistent with the table parser.
 */
export function extractCreatedIndexes(
  sql: string,
): { name: string; table: string }[] {
  const stripped = stripSqlComments(sql);
  const re =
    /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-zA-Z_][\w]*)"?\s+on\s+(?:only\s+)?(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?/gi;
  const out: { name: string; table: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const idxName = m[1];
    const tblSchema = m[2];
    const table = m[3];
    if (!idxName || !table) continue;
    if (tblSchema && tblSchema.toLowerCase() !== "public") continue;
    out.push({ name: idxName, table });
  }
  // De-dupe by index name.
  const seen = new Set<string>();
  return out.filter((o) => {
    if (seen.has(o.name)) return false;
    seen.add(o.name);
    return true;
  });
}

/**
 * Task #3417 — extract the FULL `CREATE [UNIQUE] INDEX … ;` statement
 * text for each index a migration declares, keyed by index name. Used
 * by the reconciler to self-heal a missing index from an otherwise
 * non-idempotent migration: instead of refusing to boot (the pre-#3417
 * behaviour, which forced manual psql surgery when
 * 0122_comms_sidebar_categories.sql drifted), the reconciler can
 * re-run just the missing index's own statement, which is safe by
 * construction because we only do it after confirming the index does
 * NOT exist.
 */
export function extractCreateIndexStatements(sql: string): Map<string, string> {
  const stripped = stripSqlComments(sql);
  const re =
    /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-zA-Z_][\w]*)"?[\s\S]*?;/gi;
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const name = m[1];
    if (!name || out.has(name)) continue;
    out.set(name, m[0].trim());
  }
  return out;
}

/**
 * Inject `IF NOT EXISTS` into a `CREATE [UNIQUE] INDEX` statement that
 * doesn't already carry it, so the self-heal re-run is idempotent even
 * if two processes race. `CONCURRENTLY` is stripped because the
 * reconciler runs on a plain pool client where a concurrent build's
 * restrictions buy nothing on a dev DB.
 */
export function makeIndexStatementIdempotent(stmt: string): string {
  let s = stmt.replace(/\bconcurrently\s+/i, "");
  if (/create\s+(?:unique\s+)?index\s+if\s+not\s+exists\b/i.test(s)) return s;
  return s.replace(
    /(create\s+(?:unique\s+)?index\s+)/i,
    "$1IF NOT EXISTS ",
  );
}

/**
 * Parse `DROP INDEX [CONCURRENTLY] [IF EXISTS] [schema.]name`
 * statements. Lets the reconciler avoid flagging an index that a
 * later migration intentionally removed.
 */
export function extractDroppedIndexNames(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const re =
    /drop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?/gi;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const schema = m[1];
    const name = m[2];
    if (!name) continue;
    if (schema && schema.toLowerCase() !== "public") continue;
    names.push(name);
  }
  return Array.from(new Set(names));
}

/**
 * Parse `ALTER TABLE [IF EXISTS] [ONLY] [schema.]table … ADD COLUMN
 * [IF NOT EXISTS] col …` statements, returning every (table, column)
 * pair the migration adds. Handles multiple `ADD COLUMN` clauses in a
 * single `ALTER TABLE` statement. Used (Task #1959) to catch the
 * column-drift class.
 */
export function extractAddedColumns(
  sql: string,
): { table: string; column: string }[] {
  const stripped = stripSqlComments(sql);
  const alterRe =
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?([\s\S]*?);/gi;
  const out: { table: string; column: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = alterRe.exec(stripped)) !== null) {
    const schema = m[1];
    const table = m[2];
    const body = m[3] ?? "";
    if (!table) continue;
    if (schema && schema.toLowerCase() !== "public") continue;
    const colRe =
      /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-zA-Z_][\w]*)"?/gi;
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(body)) !== null) {
      if (cm[1]) out.push({ table, column: cm[1] });
    }
  }
  return out;
}

/**
 * Parse `ALTER TABLE … DROP COLUMN [IF EXISTS] col` statements so the
 * reconciler doesn't flag a column a later migration removed.
 */
export function extractDroppedColumns(
  sql: string,
): { table: string; column: string }[] {
  const stripped = stripSqlComments(sql);
  const alterRe =
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?([a-zA-Z_][\w]*)"?\.)?"?([a-zA-Z_][\w]*)"?([\s\S]*?);/gi;
  const out: { table: string; column: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = alterRe.exec(stripped)) !== null) {
    const schema = m[1];
    const table = m[2];
    const body = m[3] ?? "";
    if (!table) continue;
    if (schema && schema.toLowerCase() !== "public") continue;
    const colRe =
      /drop\s+column\s+(?:if\s+exists\s+)?"?([a-zA-Z_][\w]*)"?/gi;
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(body)) !== null) {
      if (cm[1]) out.push({ table, column: cm[1] });
    }
  }
  return out;
}

interface ExpectedSchema {
  tables: Set<string>;
  indexes: Set<string>;
  /** "table::column" keys. */
  columns: Set<string>;
}

/**
 * Walk every migration file in order and simulate which public
 * tables, indexes, and added columns should currently exist: a CREATE
 * / ADD adds, a later DROP removes. The returned sets are the
 * reconciler's "object is still expected to be present" predicate —
 * without them, the reconciler would flag any object that some old
 * migration created but a newer migration intentionally removed.
 *
 * Dropping a table also removes any indexes sitting on it and any
 * columns keyed to it, since Postgres drops those with the table.
 */
function computeExpectedSchema(files: string[]): ExpectedSchema {
  const tables = new Set<string>();
  const indexes = new Set<string>();
  const indexToTable = new Map<string, string>();
  const columns = new Set<string>();
  for (const filename of files) {
    let body: string;
    try {
      body = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
    } catch {
      continue;
    }
    for (const t of extractCreatedTableNames(body)) tables.add(t);
    for (const { name, table } of extractCreatedIndexes(body)) {
      indexes.add(name);
      indexToTable.set(name, table);
    }
    for (const { table, column } of extractAddedColumns(body)) {
      columns.add(`${table}::${column}`);
    }
    for (const t of extractDroppedTableNames(body)) {
      tables.delete(t);
      for (const key of Array.from(columns)) {
        if (key.startsWith(`${t}::`)) columns.delete(key);
      }
      for (const [idx, tbl] of Array.from(indexToTable.entries())) {
        if (tbl === t) {
          indexes.delete(idx);
          indexToTable.delete(idx);
        }
      }
    }
    for (const name of extractDroppedIndexNames(body)) {
      indexes.delete(name);
      indexToTable.delete(name);
    }
    for (const { table, column } of extractDroppedColumns(body)) {
      columns.delete(`${table}::${column}`);
    }
  }
  return { tables, indexes, columns };
}

async function tableExists(client: PoolClient, name: string): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${name}`],
  );
  return Boolean(res.rows[0]?.exists);
}

async function indexExists(client: PoolClient, name: string): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = $1
     ) AS exists`,
    [name],
  );
  return Boolean(res.rows[0]?.exists);
}

async function columnExists(
  client: PoolClient,
  table: string,
  column: string,
): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return Boolean(res.rows[0]?.exists);
}

/**
 * Task #1940 / #1959 — reconcile the `_dev_applied_migrations` ledger
 * against the actual schema. For every ledger row, inspect the
 * migration file's schema-creating declarations and verify the
 * objects they were supposed to produce actually exist:
 *
 *   - CREATE TABLE          → table exists (`to_regclass`)         [#1940]
 *   - CREATE [UNIQUE] INDEX → index exists (`pg_indexes`)          [#1959]
 *   - ALTER TABLE ADD COLUMN → column exists (`information_schema`) [#1959]
 *
 * If any declared object is missing the ledger is lying:
 *
 *   - If the migration is fully idempotent, delete the ledger row so
 *     the normal apply loop re-runs it.
 *   - Otherwise, throw a loud startup error naming the file and the
 *     missing object(s) — an operator must investigate before boot
 *     continues.
 *
 * #1940 closed the table case exposed when 0078_…verdict_rollups.sql
 * was on disk before the ledger was first created: the bootstrap
 * backfill marked it "applied" even though its SQL never ran, so
 * anything that queried `dedupe_drop_verdict_rollups` failed silently
 * at runtime instead of at boot. #1959 extends the same guard to
 * indexes and added columns — a migration that adds an index or a
 * column could otherwise drift silently and surface only at query
 * time (planner regression / "column does not exist").
 */
async function reconcileLedgerAgainstSchema(
  client: PoolClient,
  files: string[],
  log: (msg: string) => void,
): Promise<{ requeued: string[] }> {
  if (!(await ledgerExists(client))) return { requeued: [] };
  const applied = await getAppliedFilenames(client);
  const expected = computeExpectedSchema(files);
  const requeued: string[] = [];
  const fatal: string[] = [];

  for (const filename of files) {
    if (!applied.has(filename)) continue;
    const fullPath = path.join(MIGRATIONS_DIR, filename);
    let sqlText: string;
    try {
      sqlText = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    // Only check objects this file *creates* that are still expected to
    // exist after all later migrations have replayed. Objects a later
    // migration drops legitimately won't be in the live schema (e.g.
    // `notifications` created in 0000, dropped in 0069).
    const tables = extractCreatedTableNames(sqlText).filter((t) =>
      expected.tables.has(t),
    );
    const indexes = extractCreatedIndexes(sqlText).filter((i) =>
      expected.indexes.has(i.name),
    );
    const columns = extractAddedColumns(sqlText).filter((c) =>
      expected.columns.has(`${c.table}::${c.column}`),
    );
    if (tables.length === 0 && indexes.length === 0 && columns.length === 0)
      continue;

    const missing: string[] = [];
    for (const t of tables) {
      if (!(await tableExists(client, t))) missing.push(`table ${t}`);
    }
    for (const i of indexes) {
      if (!(await indexExists(client, i.name))) missing.push(`index ${i.name}`);
    }
    for (const c of columns) {
      // Skip the column check when its table is missing — the table
      // drift above already flags the file, and `columnExists` would
      // just report a redundant miss.
      if (!(await tableExists(client, c.table))) continue;
      if (!(await columnExists(client, c.table, c.column)))
        missing.push(`column ${c.table}.${c.column}`);
    }
    if (missing.length === 0) continue;

    if (isMigrationIdempotent(sqlText)) {
      await client.query(
        `DELETE FROM ${LEDGER_TABLE} WHERE filename = $1`,
        [filename],
      );
      requeued.push(filename);
      log(
        `[devMigrations] Ledger drift: ${filename} marked applied but missing ${missing.join(", ")}; removed from ledger so it re-runs.`,
      );
      continue;
    }

    // Task #3417 — self-heal path for non-idempotent migrations whose
    // ONLY drift is missing index(es). Re-running the whole file is
    // unsafe (bare CREATE TABLE would explode), but re-running just
    // the missing index's own CREATE INDEX statement is safe: we've
    // already confirmed the index does not exist, and we inject
    // IF NOT EXISTS as a belt-and-braces guard. This is exactly the
    // class that forced manual psql surgery when
    // comms_sidebar_categories_user_type_idx went missing while
    // 0122_comms_sidebar_categories.sql stayed ledgered.
    const missingNonIndex = missing.filter((m) => !m.startsWith("index "));
    const missingIndexNames = missing
      .filter((m) => m.startsWith("index "))
      .map((m) => m.slice("index ".length));
    const indexStatements = extractCreateIndexStatements(sqlText);

    if (
      missingNonIndex.length === 0 &&
      missingIndexNames.length > 0 &&
      missingIndexNames.every((n) => indexStatements.has(n))
    ) {
      for (const name of missingIndexNames) {
        const stmt = makeIndexStatementIdempotent(indexStatements.get(name)!);
        try {
          await client.query(stmt);
          log(
            `[devMigrations] Ledger drift self-heal: recreated missing index ${name} from ${filename} via: ${stmt}`,
          );
        } catch (err) {
          fatal.push(
            `${filename} → missing index ${name}; automatic recreation failed ` +
              `(${(err as Error)?.message ?? err}). Run manually:\n      ${stmt}`,
          );
        }
      }
      continue; // healed, or failures already recorded in `fatal`
    }

    // Truly non-healable drift: refuse to start, but include the
    // exact SQL for anything we CAN reconstruct (index statements)
    // so the operator doesn't have to open the migration file.
    const remediation = missingIndexNames
      .filter((n) => indexStatements.has(n))
      .map(
        (n) =>
          `\n      SQL to recreate index ${n}: ${makeIndexStatementIdempotent(indexStatements.get(n)!)}`,
      )
      .join("");
    fatal.push(
      `${filename} → missing ${missing.join(", ")} and the migration is not safely re-runnable.` +
        ` Review migrations/${filename} and recreate the missing object(s) manually (execute_sql_tool or psql "$DATABASE_URL").` +
        remediation,
    );
  }

  if (fatal.length > 0) {
    throw new Error(
      `[devMigrations] Ledger drift detected for non-idempotent migration(s); refusing to start. ` +
        `Investigate and reconcile manually:\n  - ${fatal.join("\n  - ")}`,
    );
  }
  return { requeued };
}

async function applyOne(filename: string): Promise<void> {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const sqlText = fs.readFileSync(fullPath, "utf8");
  await withDbAttribution(`startup:dev-migrations:apply:${filename}`, async () => {
    const client = await workerPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sqlText);
      await client.query(
        `INSERT INTO ${LEDGER_TABLE}(filename) VALUES ($1)
         ON CONFLICT (filename) DO NOTHING`,
        [filename],
      );
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw new Error(
        `[devMigrations] Failed to apply ${filename}: ${(err as Error)?.message ?? err}`,
      );
    } finally {
      client.release();
    }
  });
}

export interface ApplyResult {
  ledgerCreated: boolean;
  backfilled: number;
  appliedNow: string[];
  totalMigrations: number;
  skipped: boolean;
}

/**
 * Apply any `migrations/*.sql` files not yet recorded in the
 * `_dev_applied_migrations` ledger. Safe to call repeatedly. No-op in
 * `NODE_ENV=production`.
 *
 * Throws if any file fails to apply, or if any pending files remain
 * after the run (regression guard).
 *
 * The `pool` option is retained for backwards compatibility with the
 * pre-#1851 signature but is now ignored — every DB hold goes through
 * the shared `workerPool` so the three-pool tenancy contract is
 * honoured. Tests that previously passed a throwaway `Pool` no longer
 * need to.
 */
export async function applyPendingDevMigrations(opts?: {
  pool?: Pool;
  force?: boolean;
  logger?: (msg: string) => void;
}): Promise<ApplyResult> {
  const log = opts?.logger ?? ((m: string) => console.log(m));

  if (process.env.NODE_ENV === "production" && !opts?.force) {
    return {
      ledgerCreated: false,
      backfilled: 0,
      appliedNow: [],
      totalMigrations: 0,
      skipped: true,
    };
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("[devMigrations] DATABASE_URL must be set");
  }

  const files = listMigrationFiles();

  // Task #1867: prune ledger rows whose filename no longer exists on
  // disk. This handles the case where a migration was renamed (e.g. a
  // 0076-prefix collision resolved by bumping the second file to 0077)
  // — the old filename is recorded as "applied" in this dev DB but the
  // SQL body never actually ran, so the renamed file must be picked up
  // as pending. Safe to run on every startup; it's a no-op when the
  // ledger and disk agree.
  await withDbAttribution(
    "startup:dev-migrations:prune-stale-ledger",
    async () => {
      const client = await workerPool.connect();
      try {
        if (!(await ledgerExists(client))) return;
        if (files.length === 0) {
          await client.query(`DELETE FROM ${LEDGER_TABLE}`);
          return;
        }
        const placeholders = files.map((_, i) => `$${i + 1}`).join(", ");
        const res = await client.query(
          `DELETE FROM ${LEDGER_TABLE}
           WHERE filename NOT IN (${placeholders})
           RETURNING filename`,
          files,
        );
        if (res.rowCount && res.rowCount > 0) {
          log(
            `[devMigrations] Pruned ${res.rowCount} stale ledger row(s) (renamed/removed): ${res.rows.map((r: any) => r.filename).join(", ")}`,
          );
        }
      } finally {
        client.release();
      }
    },
  );

  const { created, backfilled } = await withDbAttribution(
    "startup:dev-migrations:bootstrap-ledger",
    async () => {
      const client = await workerPool.connect();
      try {
        return await ensureLedgerAndMaybeBackfill(client, files);
      } finally {
        client.release();
      }
    },
  );

  if (created) {
    if (backfilled > 0) {
      log(
        `[devMigrations] Ledger initialised; marked ${backfilled} existing migration file(s) as already applied (existing dev DB).`,
      );
    } else {
      log(
        `[devMigrations] Ledger initialised on empty DB; every migration file will be applied.`,
      );
    }
  }

  // Task #1940: reconcile the ledger against the live schema BEFORE
  // reading the applied set. If a ledger row points at a migration
  // whose tables don't exist, either re-queue (idempotent file) or
  // throw (non-idempotent file). This catches the class of drift
  // exposed by 0078_…verdict_rollups.sql being marked applied via
  // the bootstrap backfill without the SQL ever having run.
  const { requeued } = await withDbAttribution(
    "startup:dev-migrations:reconcile-ledger",
    async () => {
      const client = await workerPool.connect();
      try {
        return await reconcileLedgerAgainstSchema(client, files, log);
      } finally {
        client.release();
      }
    },
  );
  if (requeued.length > 0) {
    log(
      `[devMigrations] Re-queued ${requeued.length} drift-detected migration(s) for re-apply: ${requeued.join(", ")}`,
    );
  }

  const applied = await withDbAttribution(
    "startup:dev-migrations:read-applied",
    async () => {
      const client = await workerPool.connect();
      try {
        return await getAppliedFilenames(client);
      } finally {
        client.release();
      }
    },
  );
  const pending = files.filter((f) => !applied.has(f));

  const appliedNow: string[] = [];
  for (const filename of pending) {
    log(`[devMigrations] Applying ${filename}…`);
    await applyOne(filename);
    appliedNow.push(filename);
  }

  // Regression guard: after the run, the ledger MUST cover every
  // file on disk. If something slipped through (e.g. a file was
  // added mid-run, or a future caller mis-uses `force`), fail loud.
  const afterApplied = await withDbAttribution(
    "startup:dev-migrations:verify-applied",
    async () => {
      const client = await workerPool.connect();
      try {
        return await getAppliedFilenames(client);
      } finally {
        client.release();
      }
    },
  );
  const stillPending = files.filter((f) => !afterApplied.has(f));
  if (stillPending.length > 0) {
    throw new Error(
      `[devMigrations] Pending migrations remain after apply: ${stillPending.join(", ")}`,
    );
  }

  if (appliedNow.length > 0) {
    log(
      `[devMigrations] Applied ${appliedNow.length} new migration(s): ${appliedNow.join(", ")}`,
    );
  } else if (!created) {
    log(`[devMigrations] No pending migrations (${files.length} total).`);
  }

  return {
    ledgerCreated: created,
    backfilled,
    appliedNow,
    totalMigrations: files.length,
    skipped: false,
  };
}

/**
 * Returns the list of `migrations/*.sql` files that are NOT yet in
 * the ledger. Test bootstrap uses this as a defensive post-condition.
 *
 * The `pool` argument is retained for signature compatibility with the
 * pre-#1851 callers but is ignored — reads go through `workerPool`.
 */
export async function getPendingDevMigrations(_pool?: Pool): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  return withDbAttribution(
    "startup:dev-migrations:pending-list",
    async () => {
      const client = await workerPool.connect();
      try {
        if (!(await ledgerExists(client))) return listMigrationFiles();
        const applied = await getAppliedFilenames(client);
        return listMigrationFiles().filter((f) => !applied.has(f));
      } finally {
        client.release();
      }
    },
  );
}
