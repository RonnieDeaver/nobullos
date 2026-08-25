/* test-registration
{
  "name": "Pool audit rollups dedupe-drop prune (Task #1938)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1938 — regression test for the `pruneTick` branch in
 * `server/services/poolAuditRollups.ts` that cleans up the
 * apply-layer dedupe drop tables.
 *
 * `pruneTick` deletes rows from:
 *   * `dedupe_drop_verdict_rollups` whose `date` is older than
 *     `DEDUPE_DROP_VERDICT_ROLLUP_RETENTION_DAYS` (90 days), and
 *   * `dedupe_drop_active_chains` whose `observed_at` has not advanced
 *     in `DEDUPE_DROP_ACTIVE_CHAIN_STALE_MS` (7 days).
 *
 * Without coverage, a refactor of `pruneTick` could silently drop one
 * of the DELETEs and the tables would just grow until somebody noticed.
 * This test seeds rows on both sides of each retention window using
 * sentinel keys/dates that cannot collide with real production data,
 * runs `__test.pruneTick()`, then asserts only the stale rows are
 * gone and the fresh rows remain.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { __test } from "../server/services/poolAuditRollups";
import {
  DEDUPE_DROP_VERDICT_ROLLUP_RETENTION_DAYS,
  DEDUPE_DROP_ACTIVE_CHAIN_STALE_MS,
} from "../server/services/frontRecoveryDedupeDropAlerts";

const SENTINEL = `t1938_${process.pid}_${Date.now()}`;
// Two windows so we can verify per-row retention rather than an
// "all or nothing" delete.
const STALE_WINDOW_KEY = `${SENTINEL}|stale`;
const FRESH_WINDOW_KEY = `${SENTINEL}|fresh`;
// Verdict-rollup `date` is a VARCHAR(10) ISO date, compared as a
// string against `utcDateString(now - 90d)`. Use a far-past date well
// outside the 90-day window and a far-future date well inside it so
// the assertion holds whatever today's date is.
const STALE_DATE = "1999-01-01";
const FRESH_DATE = "2999-12-31";
const STALE_VERDICT = `t1938_stale_${process.pid}`;
const FRESH_VERDICT = `t1938_fresh_${process.pid}`;

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`
    DELETE FROM dedupe_drop_active_chains
    WHERE window_key IN (${STALE_WINDOW_KEY}, ${FRESH_WINDOW_KEY})
  `);
  await workerDb.execute(sql`
    DELETE FROM dedupe_drop_verdict_rollups
    WHERE verdict IN (${STALE_VERDICT}, ${FRESH_VERDICT})
  `);
}

async function verdictRow(date: string, verdict: string): Promise<boolean> {
  const r = await workerDb.execute<any>(sql`
    SELECT 1 FROM dedupe_drop_verdict_rollups
    WHERE date = ${date} AND verdict = ${verdict}
  `);
  const rows = ((r as any).rows ?? r) as any[];
  return Array.isArray(rows) && rows.length > 0;
}

async function chainRow(windowKey: string): Promise<boolean> {
  const r = await workerDb.execute<any>(sql`
    SELECT 1 FROM dedupe_drop_active_chains WHERE window_key = ${windowKey}
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
  console.log("Pool audit rollups dedupe-drop prune (Task #1938)");

  await step(
    "pruneTick deletes stale verdict-rollup and active-chain rows, keeps fresh rows",
    async () => {
      const now = Date.now();
      // Active chains: one observed_at older than 7 days (stale), one
      // observed just now (fresh). Use a generous margin on each side
      // of the boundary so the test isn't sensitive to wall-clock
      // drift between seeding and the DELETE.
      const staleObservedAt = now - DEDUPE_DROP_ACTIVE_CHAIN_STALE_MS - 60_000;
      const freshObservedAt = now - 60_000;

      await workerDb.execute(sql`
        INSERT INTO dedupe_drop_active_chains
          (window_key, job_id, window_label, consecutive_pages,
           first_page_number, last_page_number, observed_at, alerted)
        VALUES
          (${STALE_WINDOW_KEY}, ${SENTINEL}, 'stale', 3, 1, 3, ${staleObservedAt}, TRUE),
          (${FRESH_WINDOW_KEY}, ${SENTINEL}, 'fresh', 3, 1, 3, ${freshObservedAt}, TRUE)
      `);

      await workerDb.execute(sql`
        INSERT INTO dedupe_drop_verdict_rollups
          (date, verdict, count, first_seen_at, last_seen_at)
        VALUES
          (${STALE_DATE}, ${STALE_VERDICT}, 1, ${staleObservedAt}, ${staleObservedAt}),
          (${FRESH_DATE}, ${FRESH_VERDICT}, 1, ${freshObservedAt}, ${freshObservedAt})
      `);

      // Sanity check: all four rows are present before pruning.
      assert.equal(await chainRow(STALE_WINDOW_KEY), true);
      assert.equal(await chainRow(FRESH_WINDOW_KEY), true);
      assert.equal(await verdictRow(STALE_DATE, STALE_VERDICT), true);
      assert.equal(await verdictRow(FRESH_DATE, FRESH_VERDICT), true);

      await __test.pruneTick();

      assert.equal(
        await chainRow(STALE_WINDOW_KEY),
        false,
        `active-chain row older than ${DEDUPE_DROP_ACTIVE_CHAIN_STALE_MS / 86400000}d must be deleted`,
      );
      assert.equal(
        await chainRow(FRESH_WINDOW_KEY),
        true,
        "recently-observed active-chain row must be preserved",
      );
      assert.equal(
        await verdictRow(STALE_DATE, STALE_VERDICT),
        false,
        `verdict-rollup row older than ${DEDUPE_DROP_VERDICT_ROLLUP_RETENTION_DAYS}d must be deleted`,
      );
      assert.equal(
        await verdictRow(FRESH_DATE, FRESH_VERDICT),
        true,
        "in-window verdict-rollup row must be preserved",
      );
    },
  );

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  }
  console.log("\nAll Task #1938 dedupe-drop prune tests passed");
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
