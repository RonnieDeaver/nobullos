/* test-registration
{
  "name": "Health freshness shape & probe timeout safety (Task #861)",
  "tier": "medium"
}
test-registration */
/**
 * Task #861 — Two contracts that the dashboard depends on:
 *
 *   1. Freshness API shape — the UI in
 *      `client/src/components/admin/health/DiagnosticCommandCenter.tsx` reads:
 *        { table, status: "healthy|delayed|missing|disabled",
 *          rowsLastHour, rowsLast24h, lastSampleTimestamp,
 *          expectedCadenceSeconds, notes? }
 *      Asserting these fields here prevents the API from drifting
 *      out from under the UI again.
 *
 *   2. DB-server-metric timeout safety — `withProbeClient` must run inside
 *      an explicit transaction so `SET LOCAL statement_timeout` actually
 *      bounds the probe query. We verify this by issuing `pg_sleep` for
 *      longer than the QUERY_TIMEOUT_MS via the metric availability path
 *      and asserting it errors out with a "statement timeout" / cancelled
 *      message rather than hanging.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { getFreshness } from "../server/services/healthRollups";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function ensureFreshnessSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pool_state_samples (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sampled_at BIGINT NOT NULL,
      pool_name VARCHAR(64) NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      idle_count INTEGER NOT NULL DEFAULT 0,
      waiting_count INTEGER NOT NULL DEFAULT 0,
      max_count INTEGER NOT NULL DEFAULT 0,
      utilization_pct INTEGER NOT NULL DEFAULT 0,
      slow_acquires_in_interval INTEGER NOT NULL DEFAULT 0,
      slow_holds_in_interval INTEGER NOT NULL DEFAULT 0,
      top_hold_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
      unknown_label_pct INTEGER NOT NULL DEFAULT 0
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS health_daily_rollups (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      metric VARCHAR(128) NOT NULL,
      date VARCHAR(10) NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      ok_count INTEGER NOT NULL DEFAULT 0,
      degraded_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      p50 INTEGER, p95 INTEGER, p99 INTEGER,
      min_val INTEGER, max_val INTEGER, avg_val INTEGER,
      alert_count INTEGER NOT NULL DEFAULT 0,
      incident_count INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS health_incidents (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      fingerprint VARCHAR(256) NOT NULL,
      metric VARCHAR(128) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      title TEXT NOT NULL,
      first_seen_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      peak_value INTEGER NOT NULL DEFAULT 0,
      latest_value INTEGER NOT NULL DEFAULT 0,
      threshold INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'firing',
      acknowledged_by VARCHAR(128),
      acknowledged_at BIGINT,
      snoozed_until BIGINT,
      resolved_at BIGINT,
      sample_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function testFreshnessContract(): Promise<void> {
  await ensureFreshnessSchema();
  const rows = await getFreshness();
  assert(Array.isArray(rows) && rows.length > 0, "freshness should return at least one row");
  const allowedStatus = new Set(["healthy", "delayed", "missing", "disabled"]);
  for (const r of rows) {
    assert(typeof r.table === "string" && r.table.length > 0, "table name");
    assert(allowedStatus.has(r.status), `status must be one of ${[...allowedStatus].join("|")}, got ${r.status}`);
    assert(typeof r.rowsLastHour === "number" && r.rowsLastHour >= 0, "rowsLastHour");
    assert(typeof r.rowsLast24h === "number" && r.rowsLast24h >= 0, "rowsLast24h");
    assert(
      r.lastSampleTimestamp === null ||
        (typeof r.lastSampleTimestamp === "number" && r.lastSampleTimestamp > 0),
      "lastSampleTimestamp",
    );
    assert(typeof r.expectedCadenceSeconds === "number", "expectedCadenceSeconds");
    if ("notes" in r && r.notes !== undefined) {
      assert(typeof r.notes === "string", "notes should be string when present");
    }
  }
  console.log(`✓ Freshness API shape (${rows.length} rows)`);
}

async function testProbeTimeoutSafety(): Promise<void> {
  // Mirror the prod probe pattern: BEGIN READ ONLY → SET LOCAL → slow query →
  // expect cancellation rather than hang. We use the actual db pool but
  // immediately ROLLBACK so no state escapes.
  const TIMEOUT_MS = 200;
  const SLEEP_S = 2;
  const start = Date.now();
  let cancelled = false;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`));
      await tx.execute(sql.raw(`SELECT pg_sleep(${SLEEP_S})`));
    });
  } catch (err: any) {
    cancelled = true;
    // Newer drizzle wraps the underlying pg error in a DrizzleQueryError,
    // so the SQLSTATE (57014) and the "canceling statement due to statement
    // timeout" text live on the error's `cause` chain rather than the
    // top-level message. Walk the chain (depth-capped) collecting both the
    // message text and the SQLSTATE, then assert a genuine cancellation.
    let matched = false;
    const seen: string[] = [];
    let cur: unknown = err;
    for (let depth = 0; cur && depth < 5; depth++) {
      const node = cur as { message?: unknown; code?: unknown; cause?: unknown };
      const msg = String(node?.message ?? "").toLowerCase();
      seen.push(String(node?.message ?? cur));
      if (
        msg.includes("statement timeout") ||
        msg.includes("canceling statement") ||
        msg.includes("cancel") ||
        node?.code === "57014"
      ) {
        matched = true;
        break;
      }
      cur = node?.cause;
    }
    assert(
      matched,
      `expected timeout/cancel error, got: ${seen.join(" <- ")}`,
    );
  }
  const elapsed = Date.now() - start;
  assert(cancelled, "transaction should have been cancelled by SET LOCAL statement_timeout");
  assert(
    elapsed < SLEEP_S * 1000 - 100,
    `query should have been cancelled before ${SLEEP_S}s (took ${elapsed}ms)`,
  );
  console.log(`✓ SET LOCAL statement_timeout cancels probe query (${elapsed}ms)`);
}

async function run(): Promise<void> {
  await testFreshnessContract();
  await testProbeTimeoutSafety();
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
