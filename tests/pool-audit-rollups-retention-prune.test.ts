/* test-registration
{
  "name": "Pool audit rollups retention prune (Task #1947)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1947 — regression test for the three retention-window DELETEs in
 * `pruneTick` in `server/services/poolAuditRollups.ts` that Task #1938 did
 * NOT cover:
 *
 *   * `external_call_audits` — raw rows whose `called_at` is older than
 *     `RAW_RETENTION_MS` (14 days),
 *   * `external_call_audit_daily_rollups` — rows whose `date` is older than
 *     `ROLLUP_RETENTION_DAYS` (90 days), and
 *   * `db_hold_label_rollups` — rows whose `date` is older than
 *     `ROLLUP_RETENTION_DAYS` (90 days).
 *
 * Without coverage, a refactor of `pruneTick` could silently drop one of
 * these DELETEs and the table would grow unnoticed until it caused pool
 * pressure. This test seeds rows on both sides of each retention window
 * using sentinel keys/dates that cannot collide with real production data,
 * runs `__test.pruneTick()`, then asserts only the stale rows are gone and
 * the fresh rows remain. Mirrors the pattern of
 * `tests/pool-audit-rollups-dedupe-drop-prune.test.ts`.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { __test } from "../server/services/poolAuditRollups";

const SENTINEL = `t1947_${process.pid}_${Date.now()}`;
// Unique, far-from-production sentinel values for the raw-audit rows.
const STALE_DEDUPE_KEY = `${SENTINEL}|stale`;
const FRESH_DEDUPE_KEY = `${SENTINEL}|fresh`;
const AUDIT_INTEGRATION = "t1947_test";
const AUDIT_ENDPOINT = `/t1947/${process.pid}`;

// `date` columns are VARCHAR(10) ISO dates compared as strings against
// `utcDateString(now - 90d)`. Use a far-past date well outside the 90-day
// window and a far-future date well inside it so the assertions hold
// whatever today's date is.
const STALE_DATE = "1999-01-01";
const FRESH_DATE = "2999-12-31";
// Sentinel integrations / pools / labels so cleanup + lookups can never
// collide with real rows.
const ROLLUP_INTEGRATION = `t1947_${process.pid}`;
const HOLD_POOL = `t1947_${process.pid}`;
const HOLD_LABEL = `t1947_label_${process.pid}`;

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`
    DELETE FROM external_call_audits
    WHERE request_dedupe_key IN (${STALE_DEDUPE_KEY}, ${FRESH_DEDUPE_KEY})
  `);
  await workerDb.execute(sql`
    DELETE FROM external_call_audit_daily_rollups
    WHERE integration = ${ROLLUP_INTEGRATION}
  `);
  await workerDb.execute(sql`
    DELETE FROM db_hold_label_rollups
    WHERE pool = ${HOLD_POOL}
  `);
}

async function rawAuditRow(dedupeKey: string): Promise<boolean> {
  const r = await workerDb.execute<any>(sql`
    SELECT 1 FROM external_call_audits WHERE request_dedupe_key = ${dedupeKey}
  `);
  const rows = ((r as any).rows ?? r) as any[];
  return Array.isArray(rows) && rows.length > 0;
}

async function rollupRow(date: string): Promise<boolean> {
  const r = await workerDb.execute<any>(sql`
    SELECT 1 FROM external_call_audit_daily_rollups
    WHERE integration = ${ROLLUP_INTEGRATION} AND date = ${date}
  `);
  const rows = ((r as any).rows ?? r) as any[];
  return Array.isArray(rows) && rows.length > 0;
}

async function holdRollupRow(date: string): Promise<boolean> {
  const r = await workerDb.execute<any>(sql`
    SELECT 1 FROM db_hold_label_rollups
    WHERE pool = ${HOLD_POOL} AND date = ${date}
  `);
  const rows = ((r as any).rows ?? r) as any[];
  return Array.isArray(rows) && rows.length > 0;
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await cleanup();
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await cleanup();
  }
}

async function main(): Promise<void> {
  console.log("Pool audit rollups retention prune (Task #1947)");

  await step(
    "pruneTick deletes stale raw-audit + rollup rows, keeps fresh rows",
    async () => {
      const now = Date.now();
      const RAW_RETENTION_MS = 14 * 24 * 60 * 60_000;
      // Raw external_call_audits: one called_at older than 14 days (stale),
      // one called just now (fresh). Generous margin on each side of the
      // boundary so the test isn't sensitive to wall-clock drift between
      // seeding and the DELETE.
      const staleCalledAt = now - RAW_RETENTION_MS - 60 * 60_000;
      const freshCalledAt = now - 60_000;

      await workerDb.execute(sql`
        INSERT INTO external_call_audits
          (integration, endpoint, method, called_at, request_dedupe_key)
        VALUES
          (${AUDIT_INTEGRATION}, ${AUDIT_ENDPOINT}, 'GET', ${staleCalledAt}, ${STALE_DEDUPE_KEY}),
          (${AUDIT_INTEGRATION}, ${AUDIT_ENDPOINT}, 'GET', ${freshCalledAt}, ${FRESH_DEDUPE_KEY})
      `);

      await workerDb.execute(sql`
        INSERT INTO external_call_audit_daily_rollups
          (date, integration, endpoint)
        VALUES
          (${STALE_DATE}, ${ROLLUP_INTEGRATION}, ${AUDIT_ENDPOINT}),
          (${FRESH_DATE}, ${ROLLUP_INTEGRATION}, ${AUDIT_ENDPOINT})
      `);

      await workerDb.execute(sql`
        INSERT INTO db_hold_label_rollups
          (date, pool, hold_label, first_seen_at, last_seen_at)
        VALUES
          (${STALE_DATE}, ${HOLD_POOL}, ${HOLD_LABEL}, ${staleCalledAt}, ${staleCalledAt}),
          (${FRESH_DATE}, ${HOLD_POOL}, ${HOLD_LABEL}, ${freshCalledAt}, ${freshCalledAt})
      `);

      // Sanity check: all six rows are present before pruning.
      assert.equal(await rawAuditRow(STALE_DEDUPE_KEY), true);
      assert.equal(await rawAuditRow(FRESH_DEDUPE_KEY), true);
      assert.equal(await rollupRow(STALE_DATE), true);
      assert.equal(await rollupRow(FRESH_DATE), true);
      assert.equal(await holdRollupRow(STALE_DATE), true);
      assert.equal(await holdRollupRow(FRESH_DATE), true);

      await __test.pruneTick();

      assert.equal(
        await rawAuditRow(STALE_DEDUPE_KEY),
        false,
        `external_call_audits row older than ${RAW_RETENTION_MS / 86400000}d must be deleted`,
      );
      assert.equal(
        await rawAuditRow(FRESH_DEDUPE_KEY),
        true,
        "recent external_call_audits row must be preserved",
      );
      assert.equal(
        await rollupRow(STALE_DATE),
        false,
        "external_call_audit_daily_rollups row older than 90d must be deleted",
      );
      assert.equal(
        await rollupRow(FRESH_DATE),
        true,
        "in-window external_call_audit_daily_rollups row must be preserved",
      );
      assert.equal(
        await holdRollupRow(STALE_DATE),
        false,
        "db_hold_label_rollups row older than 90d must be deleted",
      );
      assert.equal(
        await holdRollupRow(FRESH_DATE),
        true,
        "in-window db_hold_label_rollups row must be preserved",
      );
    },
  );

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  }
  console.log("\nAll Task #1947 retention prune tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error("Test runner crashed:", err);
    process.exitCode = 1;
  });
