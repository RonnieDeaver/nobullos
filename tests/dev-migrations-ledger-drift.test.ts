/* test-registration
{
  "name": "Dev migrations ledger-drift reconciler (Task #1940 / #1959)",
  "regression": true,
  "sweepOnlyReason": "Task #4096 triage of the migrated no-reason boilerplate: too slow for the routine gate (~7.2s in the 2026-08-07 nightly sweep); still runs in the full suite and the nightly --regression sweep.",
  "scanPaths": [
    "migrations"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1940 — ledger-drift regression guard.
 *
 * Scenario: a row in `_dev_applied_migrations` claims a migration is
 * applied, but the table the migration was supposed to create does
 * not exist in the live schema. This is the silent-drift class that
 * exposed 0078_add_dedupe_drop_verdict_rollups.sql — the bootstrap
 * backfill marked the file as applied (because `clients` existed) even
 * though its SQL had never actually run, so any caller that touched
 * `dedupe_drop_verdict_rollups` failed at query time instead of at
 * boot.
 *
 * The reconciler added to server/devMigrations.ts must:
 *   1. Detect the drift on boot.
 *   2. Re-queue the migration when its SQL is fully idempotent
 *      (every CREATE TABLE / INDEX / ADD COLUMN guarded by
 *      IF NOT EXISTS) so the normal apply loop re-runs it.
 *   3. After apply, the previously-missing table exists and the
 *      ledger row is back in place.
 *
 * Also asserts that a synthetic ledger row pointing at a
 * non-idempotent migration body causes the runner to throw a clear
 * startup error instead of silently boot-completing on a broken DB.
 *
 * Implementation note: to keep this test hermetic and fast, both
 * drift scenarios use temporary synthetic migration files written to
 * `migrations/9999_*` rather than dropping tables created by real
 * migrations. Dropping a real table CASCADE on a populated dev DB
 * pulls in too many dependents and the re-apply path can take
 * minutes; the synthetic approach exercises the same code paths in a
 * few hundred ms.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { workerPool } from "../server/db";
import {
  applyPendingDevMigrations,
  extractAddedColumns,
  extractCreateIndexStatements,
  extractCreatedIndexes,
  extractCreatedTableNames,
  extractDroppedColumns,
  extractDroppedIndexNames,
  extractDroppedTableNames,
  isMigrationIdempotent,
  makeIndexStatementIdempotent,
} from "../server/devMigrations";

const LEDGER_TABLE = "_dev_applied_migrations";
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function withClient<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const c = await workerPool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

async function cleanupSynthetic(filenames: string[], tables: string[]): Promise<void> {
  for (const f of filenames) {
    try {
      fs.unlinkSync(path.join(MIGRATIONS_DIR, f));
    } catch {
      /* ignore */
    }
  }
  await withClient(async (c) => {
    for (const f of filenames) {
      await c.query(`DELETE FROM ${LEDGER_TABLE} WHERE filename = $1`, [f]);
    }
    for (const t of tables) {
      await c.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
  });
}

async function run() {
  // ── Unit-level: parser + idempotency heuristic ──────────────────────
  const parsed = extractCreatedTableNames(`
    -- create table not_this_one (...);
    CREATE TABLE IF NOT EXISTS "foo" ("id" int);
    create table public.bar (id int);
    CREATE TABLE other_schema.skip_me (id int);
  `);
  check(
    "parser extracts public CREATE TABLE names and skips comments + other schemas",
    parsed.includes("foo") &&
      parsed.includes("bar") &&
      !parsed.includes("not_this_one") &&
      !parsed.includes("skip_me"),
    `got [${parsed.join(", ")}]`,
  );

  const dropped = extractDroppedTableNames(`
    -- drop table not_this_one;
    DROP TABLE IF EXISTS "foo";
    drop table public.bar;
    DROP TABLE other_schema.skip_me;
  `);
  check(
    "drop parser extracts public DROP TABLE names",
    dropped.includes("foo") &&
      dropped.includes("bar") &&
      !dropped.includes("not_this_one") &&
      !dropped.includes("skip_me"),
    `got [${dropped.join(", ")}]`,
  );

  const idx = extractCreatedIndexes(`
    -- create index not_this on x(y);
    CREATE INDEX IF NOT EXISTS "ix_foo" ON "foo" ("a");
    CREATE UNIQUE INDEX ix_bar ON public.bar (b);
    CREATE INDEX CONCURRENTLY ix_baz ON only public.baz (c);
    CREATE INDEX ix_skip ON other_schema.qux (d);
  `);
  check(
    "index parser extracts public CREATE INDEX names + tables, skips comments + other schemas",
    idx.some((i) => i.name === "ix_foo" && i.table === "foo") &&
      idx.some((i) => i.name === "ix_bar" && i.table === "bar") &&
      idx.some((i) => i.name === "ix_baz" && i.table === "baz") &&
      !idx.some((i) => i.name === "ix_skip" || i.name === "not_this"),
    `got [${idx.map((i) => `${i.name}->${i.table}`).join(", ")}]`,
  );

  const droppedIdx = extractDroppedIndexNames(`
    -- drop index not_this;
    DROP INDEX IF EXISTS "ix_foo";
    DROP INDEX CONCURRENTLY public.ix_bar;
    DROP INDEX other_schema.ix_skip;
  `);
  check(
    "drop-index parser extracts public DROP INDEX names",
    droppedIdx.includes("ix_foo") &&
      droppedIdx.includes("ix_bar") &&
      !droppedIdx.includes("ix_skip") &&
      !droppedIdx.includes("not_this"),
    `got [${droppedIdx.join(", ")}]`,
  );

  const cols = extractAddedColumns(`
    -- alter table not_this add column z int;
    ALTER TABLE "foo" ADD COLUMN IF NOT EXISTS "a" int, ADD COLUMN b text;
    ALTER TABLE public.bar ADD COLUMN c int;
    ALTER TABLE other_schema.qux ADD COLUMN skip int;
  `);
  check(
    "add-column parser extracts (table, column) pairs incl. multi-clause, skips other schemas",
    cols.some((c) => c.table === "foo" && c.column === "a") &&
      cols.some((c) => c.table === "foo" && c.column === "b") &&
      cols.some((c) => c.table === "bar" && c.column === "c") &&
      !cols.some((c) => c.column === "skip" || c.column === "z"),
    `got [${cols.map((c) => `${c.table}.${c.column}`).join(", ")}]`,
  );

  const droppedCols = extractDroppedColumns(`
    ALTER TABLE "foo" DROP COLUMN IF EXISTS "a", DROP COLUMN b;
    ALTER TABLE other_schema.qux DROP COLUMN skip;
  `);
  check(
    "drop-column parser extracts (table, column) pairs, skips other schemas",
    droppedCols.some((c) => c.table === "foo" && c.column === "a") &&
      droppedCols.some((c) => c.table === "foo" && c.column === "b") &&
      !droppedCols.some((c) => c.column === "skip"),
    `got [${droppedCols.map((c) => `${c.table}.${c.column}`).join(", ")}]`,
  );

  check(
    "idempotency: fully-guarded body returns true",
    isMigrationIdempotent(
      `CREATE TABLE IF NOT EXISTS x (id int);
       CREATE INDEX IF NOT EXISTS ix ON x(id);
       ALTER TABLE x ADD COLUMN IF NOT EXISTS y int;`,
    ) === true,
  );
  check(
    "idempotency: bare CREATE TABLE returns false",
    isMigrationIdempotent(`CREATE TABLE x (id int);`) === false,
  );
  check(
    "idempotency: bare ADD COLUMN returns false",
    isMigrationIdempotent(`ALTER TABLE x ADD COLUMN y int;`) === false,
  );

  // ── Task #3417: index-statement extraction + IF NOT EXISTS injection ─
  const stmts = extractCreateIndexStatements(`
    -- create index not_this on x(y);
    CREATE TABLE foo (id int, a int, b int);
    CREATE INDEX ix_plain ON foo (a);
    CREATE UNIQUE INDEX ix_partial
      ON foo (a, b)
      WHERE b IN (1, 2);
  `);
  check(
    "index-statement extractor captures full statement incl. multi-line partial index",
    stmts.get("ix_plain") === "CREATE INDEX ix_plain ON foo (a);" &&
      (stmts.get("ix_partial")?.includes("WHERE b IN (1, 2);") ?? false) &&
      !stmts.has("not_this"),
    `got keys [${Array.from(stmts.keys()).join(", ")}]`,
  );
  check(
    "IF NOT EXISTS injected into bare CREATE INDEX",
    makeIndexStatementIdempotent("CREATE INDEX ix ON foo (a);") ===
      "CREATE INDEX IF NOT EXISTS ix ON foo (a);",
  );
  check(
    "IF NOT EXISTS injected into UNIQUE index + CONCURRENTLY stripped",
    makeIndexStatementIdempotent(
      "CREATE UNIQUE INDEX CONCURRENTLY ix ON foo (a);",
    ) === "CREATE UNIQUE INDEX IF NOT EXISTS ix ON foo (a);",
  );
  check(
    "already-guarded statement left unchanged",
    makeIndexStatementIdempotent(
      "CREATE INDEX IF NOT EXISTS ix ON foo (a);",
    ) === "CREATE INDEX IF NOT EXISTS ix ON foo (a);",
  );

  // ── Idempotent drift: re-apply path ─────────────────────────────────
  const idempotentName = `9999_drift_guard_idempotent_${Date.now()}.sql`;
  const idempotentTable = `__drift_guard_idem_${Date.now()}`;
  fs.writeFileSync(
    path.join(MIGRATIONS_DIR, idempotentName),
    `CREATE TABLE IF NOT EXISTS "${idempotentTable}" ("id" INT PRIMARY KEY);\n`,
  );

  const createdFiles: string[] = [idempotentName];
  const createdTables: string[] = [idempotentTable];

  try {
    // Apply pending so the synthetic file lands and ledger row exists.
    await applyPendingDevMigrations({ logger: () => undefined });
    await withClient(async (c) => {
      const exists = await c.query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${idempotentTable}`],
      );
      assert.ok(exists.rows[0]?.exists, "precondition: synthetic table should exist");
      const ledger = await c.query(
        `SELECT 1 FROM ${LEDGER_TABLE} WHERE filename = $1`,
        [idempotentName],
      );
      assert.equal(ledger.rowCount, 1, "precondition: ledger row should be present");
      // Induce drift: drop the table but leave the ledger row in place.
      await c.query(`DROP TABLE IF EXISTS "${idempotentTable}" CASCADE`);
    });

    const logged: string[] = [];
    const result = await applyPendingDevMigrations({
      logger: (m) => logged.push(m),
    });

    check(
      "runner re-applies the drift-detected migration",
      result.appliedNow.includes(idempotentName),
      `appliedNow=[${result.appliedNow.join(", ")}]`,
    );
    check(
      "runner logs drift reconciliation",
      logged.some(
        (m) => m.includes("Ledger drift") && m.includes(idempotentName),
      ),
    );

    await withClient(async (c) => {
      const exists = await c.query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${idempotentTable}`],
      );
      check(
        "table restored after re-apply",
        Boolean(exists.rows[0]?.exists),
      );
      const ledger = await c.query(
        `SELECT 1 FROM ${LEDGER_TABLE} WHERE filename = $1`,
        [idempotentName],
      );
      check(
        "ledger row for re-applied file is back in place",
        ledger.rowCount === 1,
      );
    });
  } finally {
    await cleanupSynthetic([idempotentName], [idempotentTable]);
  }

  // ── Index drift: ledger says applied but the index is gone ──────────
  const idxFileName = `9999_drift_guard_index_${Date.now()}.sql`;
  const idxTable = `__drift_guard_idx_tbl_${Date.now()}`;
  const idxName = `__drift_guard_idx_${Date.now()}`;
  fs.writeFileSync(
    path.join(MIGRATIONS_DIR, idxFileName),
    `CREATE TABLE IF NOT EXISTS "${idxTable}" ("id" INT PRIMARY KEY, "v" INT);\n` +
      `CREATE INDEX IF NOT EXISTS "${idxName}" ON "${idxTable}" ("v");\n`,
  );

  try {
    await applyPendingDevMigrations({ logger: () => undefined });
    await withClient(async (c) => {
      const exists = await c.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1) AS exists`,
        [idxName],
      );
      assert.ok(exists.rows[0]?.exists, "precondition: synthetic index should exist");
      // Induce index-only drift: drop the index but keep the table and
      // the ledger row in place.
      await c.query(`DROP INDEX IF EXISTS "${idxName}"`);
    });

    const logged: string[] = [];
    const result = await applyPendingDevMigrations({
      logger: (m) => logged.push(m),
    });

    check(
      "runner re-applies a migration whose index drifted",
      result.appliedNow.includes(idxFileName),
      `appliedNow=[${result.appliedNow.join(", ")}]`,
    );
    check(
      "drift log names the missing index",
      logged.some((m) => m.includes("Ledger drift") && m.includes(idxName)),
    );

    await withClient(async (c) => {
      const exists = await c.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1) AS exists`,
        [idxName],
      );
      check("index restored after re-apply", Boolean(exists.rows[0]?.exists));
    });
  } finally {
    await cleanupSynthetic([idxFileName], [idxTable]);
  }

  // ── Column drift: ledger says applied but the added column is gone ───
  const colFileName = `9999_drift_guard_column_${Date.now()}.sql`;
  const colTable = `__drift_guard_col_tbl_${Date.now()}`;
  const colName = `__drift_col`;
  fs.writeFileSync(
    path.join(MIGRATIONS_DIR, colFileName),
    `CREATE TABLE IF NOT EXISTS "${colTable}" ("id" INT PRIMARY KEY);\n` +
      `ALTER TABLE "${colTable}" ADD COLUMN IF NOT EXISTS "${colName}" INT;\n`,
  );

  try {
    await applyPendingDevMigrations({ logger: () => undefined });
    await withClient(async (c) => {
      const exists = await c.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS exists`,
        [colTable, colName],
      );
      assert.ok(exists.rows[0]?.exists, "precondition: synthetic column should exist");
      // Induce column-only drift: drop the column but keep the table and
      // the ledger row in place.
      await c.query(`ALTER TABLE "${colTable}" DROP COLUMN IF EXISTS "${colName}"`);
    });

    const logged: string[] = [];
    const result = await applyPendingDevMigrations({
      logger: (m) => logged.push(m),
    });

    check(
      "runner re-applies a migration whose added column drifted",
      result.appliedNow.includes(colFileName),
      `appliedNow=[${result.appliedNow.join(", ")}]`,
    );
    check(
      "drift log names the missing column",
      logged.some(
        (m) =>
          m.includes("Ledger drift") && m.includes(`${colTable}.${colName}`),
      ),
    );

    await withClient(async (c) => {
      const exists = await c.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS exists`,
        [colTable, colName],
      );
      check("column restored after re-apply", Boolean(exists.rows[0]?.exists));
    });
  } finally {
    await cleanupSynthetic([colFileName], [colTable]);
  }

  // ── Non-idempotent drift: must throw, not silently re-apply ─────────
  const unsafeName = `9999_drift_guard_unsafe_${Date.now()}.sql`;
  const unsafeTable = `__drift_guard_unsafe_${Date.now()}`;
  fs.writeFileSync(
    path.join(MIGRATIONS_DIR, unsafeName),
    `CREATE TABLE "${unsafeTable}" ("id" INT PRIMARY KEY);\n`,
  );

  try {
    // Insert ledger row WITHOUT creating the table — that's the drift.
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO ${LEDGER_TABLE}(filename) VALUES ($1)
         ON CONFLICT (filename) DO NOTHING`,
        [unsafeName],
      );
    });

    let threw = false;
    let errMsg = "";
    try {
      await applyPendingDevMigrations({ logger: () => undefined });
    } catch (err) {
      threw = true;
      errMsg = (err as Error).message ?? String(err);
    }

    check(
      "runner refuses to start when a non-idempotent migration has drifted",
      threw,
      errMsg.slice(0, 120),
    );
    check(
      "error message names the offending file and the missing table",
      threw && errMsg.includes(unsafeName) && errMsg.includes(unsafeTable),
      errMsg.slice(0, 200),
    );
  } finally {
    await cleanupSynthetic([unsafeName], [unsafeTable]);
  }

  // ── Task #3417: non-idempotent file, index-only drift → self-heal ────
  // The 0122_comms_sidebar_categories.sql class: ledger says applied,
  // the table exists, but an index is missing and the file has bare
  // CREATE TABLE so it can't be requeued wholesale. The reconciler must
  // recreate just the index and boot normally — no throw, no manual psql.
  const healName = `9999_drift_guard_selfheal_${Date.now()}.sql`;
  const healTable = `__drift_guard_heal_tbl_${Date.now()}`;
  const healIdx = `__drift_guard_heal_idx_${Date.now()}`;
  fs.writeFileSync(
    path.join(MIGRATIONS_DIR, healName),
    `CREATE TABLE "${healTable}" ("id" INT PRIMARY KEY, "v" INT, "w" INT);\n` +
      `CREATE UNIQUE INDEX "${healIdx}"\n  ON "${healTable}" ("v", "w")\n  WHERE "w" IN (1, 2);\n`,
  );

  try {
    await applyPendingDevMigrations({ logger: () => undefined });
    await withClient(async (c) => {
      const exists = await c.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1) AS exists`,
        [healIdx],
      );
      assert.ok(exists.rows[0]?.exists, "precondition: self-heal index should exist");
      await c.query(`DROP INDEX IF EXISTS "${healIdx}"`);
    });

    const logged: string[] = [];
    let threw = false;
    let result: Awaited<ReturnType<typeof applyPendingDevMigrations>> | undefined;
    try {
      result = await applyPendingDevMigrations({ logger: (m) => logged.push(m) });
    } catch {
      threw = true;
    }

    check(
      "non-idempotent index-only drift does NOT block startup",
      !threw,
    );
    check(
      "self-heal does not requeue the whole non-idempotent file",
      !threw && !(result?.appliedNow ?? []).includes(healName),
      `appliedNow=[${(result?.appliedNow ?? []).join(", ")}]`,
    );
    check(
      "self-heal log names the recreated index and its SQL",
      logged.some(
        (m) =>
          m.includes("self-heal") &&
          m.includes(healIdx) &&
          m.includes("IF NOT EXISTS"),
      ),
      logged.filter((m) => m.includes("self-heal")).join(" | ").slice(0, 200),
    );
    await withClient(async (c) => {
      const exists = await c.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1) AS exists`,
        [healIdx],
      );
      check(
        "missing index recreated by self-heal (incl. partial WHERE clause body)",
        Boolean(exists.rows[0]?.exists),
      );
      const isUnique = await c.query<{ indisunique: boolean }>(
        `SELECT i.indisunique FROM pg_index i
           JOIN pg_class c2 ON c2.oid = i.indexrelid
          WHERE c2.relname = $1`,
        [healIdx],
      );
      check(
        "recreated index preserved UNIQUE",
        Boolean(isUnique.rows[0]?.indisunique),
      );
    });
  } finally {
    await cleanupSynthetic([healName], [healTable]);
  }

  // ── Task #3417: real 0122 file is now idempotent ─────────────────────
  const real0122 = path.join(MIGRATIONS_DIR, "0122_comms_sidebar_categories.sql");
  if (fs.existsSync(real0122)) {
    check(
      "0122_comms_sidebar_categories.sql is fully IF NOT EXISTS-guarded",
      isMigrationIdempotent(fs.readFileSync(real0122, "utf8")),
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own once run() settles — no manual process.exit() (Task #2084).
run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
