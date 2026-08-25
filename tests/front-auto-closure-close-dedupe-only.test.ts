/* test-registration
{
  "name": "Front auto closure close dedupe only (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #1905 — auto-close dedupe-only resolved recovery windows.
 *
 * Verifies the close-path preconditions and side-effects of
 * `maybeCloseDedupeOnlyWindow`:
 *
 *   1. Low cumulative dedupe pct → no close, decision.reason explains.
 *   2. Cumulative dedupe pct OK but apply-layer sample below the
 *      minimum size → no close.
 *   3. Apply-layer applied/total ratio below the configured floor →
 *      no close.
 *   4. All preconditions met → row is updated with
 *      `closed_via='webhook_dedupe'`, dead-run streak is cleared, and
 *      `isIngestCandidate` subsequently rejects the row.
 *   5. `unparkRecoveryWindow` clears `closed_via` so the row is
 *      eligible for recovery again.
 *
 * Lives in its own file (mirrors front-auto-closure-park-window.test.ts)
 * so it isn't blocked by unrelated pre-existing failures in
 * tests/front-auto-closure.test.ts.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { frontAnalyticsMonthlyCoverage } from "@shared/schema";
import {
  __setFrontAutoClosureApplyLayerSampleOverride,
  unparkRecoveryWindow,
  __frontAutoClosureTestHelpers,
  SETTING_CLOSE_AFTER_DEDUPE_ONLY_RUNS,
} from "../server/services/frontAutoClosure";
import { cacheDel } from "../server/services/cache/redisCache";

const FUTURE_YEAR = 2997;

async function setCumulativeDedupePct(
  month: string,
  pct: number,
): Promise<void> {
  // Reach into the same system_settings key
  // (`front_recovery_cumulative`) the recovery worker writes so
  // `maybeCloseDedupeOnlyWindow` reads our synthetic pct via the real
  // `getRecoveryCumulative` accessor — no test-only seam needed.
  const KEY = "front_recovery_cumulative";
  const raw = await db.execute(
    sql`SELECT value FROM system_settings WHERE key = ${KEY} LIMIT 1`,
  );
  const cur = ((raw as any).rows ?? (raw as any))[0]?.value as
    | string
    | undefined;
  let store: { months: Record<string, any> } = { months: {} };
  if (cur) {
    try {
      const parsed = JSON.parse(cur);
      if (parsed && typeof parsed === "object" && parsed.months) {
        store = parsed;
      }
    } catch {
      /* fall through */
    }
  }
  store.months[month] = {
    scanned: 25000,
    ingested: 0,
    dedupe_skipped: Math.floor(25000 * pct),
    same_response_skipped: 0,
    inactive_inbox_skipped: 0,
    pages_walked: 500,
    last_advanced_at: new Date().toISOString(),
    last_observed_dedupe_pct: pct,
  };
  await db.execute(sql`
    INSERT INTO system_settings (key, value)
    VALUES (${KEY}, ${JSON.stringify(store)})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value
  `);
  // settingsStorage wraps reads in a Redis (or in-memory fallback)
  // cache; invalidate the entry so the next getRecoveryCumulative
  // observes our synthetic write rather than a stale sentinel.
  await cacheDel("system_settings", KEY);
}

async function clearCumulativeMonth(month: string): Promise<void> {
  const KEY = "front_recovery_cumulative";
  const raw = await db.execute(
    sql`SELECT value FROM system_settings WHERE key = ${KEY} LIMIT 1`,
  );
  const cur = ((raw as any).rows ?? (raw as any))[0]?.value as
    | string
    | undefined;
  if (!cur) return;
  try {
    const parsed = JSON.parse(cur);
    if (parsed?.months?.[month]) {
      delete parsed.months[month];
      await db.execute(sql`
        UPDATE system_settings SET value = ${JSON.stringify(parsed)} WHERE key = ${KEY}
      `);
      await cacheDel("system_settings", KEY);
    }
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  const {
    maybeCloseDedupeOnlyWindow,
    loadConfig,
    isIngestCandidate,
    loadState,
    saveState,
  } = __frontAutoClosureTestHelpers;

  const month = `${FUTURE_YEAR}-09`;
  const monthStart = new Date(Date.UTC(FUTURE_YEAR, 8, 1));
  const monthEnd = new Date(Date.UTC(FUTURE_YEAR, 9, 1));

  // Seed coverage row with a ~10k ingest_gap so it's a real candidate.
  await db.execute(sql`DELETE FROM front_analytics_monthly_coverage WHERE month = ${month}`);
  await db.insert(frontAnalyticsMonthlyCoverage).values({
    month,
    monthStart,
    monthEnd,
    frontTotalMessages: 25000,
    fetchedIntoNobull: 15000,
    appliedIntoNobull: 15000,
    ingestGap: 10000,
    applyGap: 0,
    fetchedCoveragePct: 60,
    appliedCoveragePct: 60,
    isFinalizedMonth: true,
  });

  // Pin the close-threshold setting for the duration of the run: the
  // shared dev DB can carry an operator override (e.g. 0 = disabled)
  // which would otherwise fail the "> 0" precondition below. Restore
  // the original value (or delete the row) in the finally block.
  const THRESHOLD_KEY = SETTING_CLOSE_AFTER_DEDUPE_ONLY_RUNS;
  const prevThresholdRaw = await db.execute(
    sql`SELECT value FROM system_settings WHERE key = ${THRESHOLD_KEY} LIMIT 1`,
  );
  const prevThreshold = ((prevThresholdRaw as any).rows ??
    (prevThresholdRaw as any))[0]?.value as string | undefined;
  await db.execute(sql`
    INSERT INTO system_settings (key, value)
    VALUES (${THRESHOLD_KEY}, ${"2"})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
  await cacheDel("system_settings", THRESHOLD_KEY);

  const cfg = await loadConfig();
  assert.ok(cfg.closeAfterDedupeOnlyRuns > 0, "close threshold pinned > 0");

  // Snapshot original state so we can restore on cleanup.
  const originalState = await loadState();

  try {
    // ── 1. Low dedupe pct → no close. ─────────────────────────────────
    await setCumulativeDedupePct(month, 0.5);
    __setFrontAutoClosureApplyLayerSampleOverride(async () => ({
      total: 200,
      applied: 200,
    }));
    let state: any = { ...originalState, deadRunStreak: {}, cooldowns: {} };
    let row: any = (
      await db
        .select()
        .from(frontAnalyticsMonthlyCoverage)
        .where(sql`month = ${month}` as any)
    )[0];
    let dec = await maybeCloseDedupeOnlyWindow(state, row, cfg);
    assert.equal(dec.closed, false, "low dedupe pct → not closed");
    assert.match(
      dec.reason,
      /dedupe_pct_below_min/,
      "reason explains low dedupe pct",
    );

    // ── 2. Dedupe OK, sample too small → no close. ────────────────────
    await setCumulativeDedupePct(month, 1.0);
    __setFrontAutoClosureApplyLayerSampleOverride(async () => ({
      total: 5,
      applied: 5,
    }));
    dec = await maybeCloseDedupeOnlyWindow(state, row, cfg);
    assert.equal(dec.closed, false, "tiny sample → not closed");
    assert.match(dec.reason, /sample_too_small/, "reason explains sample size");

    // ── 3. Apply pct below floor → no close. ──────────────────────────
    __setFrontAutoClosureApplyLayerSampleOverride(async () => ({
      total: 200,
      applied: 100, // 50% applied — well below default 0.95
    }));
    dec = await maybeCloseDedupeOnlyWindow(state, row, cfg);
    assert.equal(dec.closed, false, "low applied pct → not closed");
    assert.match(
      dec.reason,
      /apply_pct_below_min/,
      "reason explains low applied pct",
    );

    // ── 4. All preconditions met → close. ─────────────────────────────
    __setFrontAutoClosureApplyLayerSampleOverride(async () => ({
      total: 200,
      applied: 199,
    }));
    state.deadRunStreak[month] = { count: 2, lastCheckpointAt: "x" };
    state.cooldowns[month] = new Date(Date.now() + 60_000).toISOString();
    dec = await maybeCloseDedupeOnlyWindow(state, row, cfg);
    assert.equal(dec.closed, true, "all preconditions met → closed");
    assert.equal(
      state.deadRunStreak[month],
      undefined,
      "close clears dead-run streak",
    );
    assert.equal(
      state.cooldowns[month],
      undefined,
      "close clears per-month cooldown",
    );

    // Verify the coverage row now carries `closed_via='webhook_dedupe'`
    // and that `isIngestCandidate` rejects it.
    const after: any = (
      await db
        .select()
        .from(frontAnalyticsMonthlyCoverage)
        .where(sql`month = ${month}` as any)
    )[0];
    assert.equal(
      after.closedVia,
      "webhook_dedupe",
      "row has closed_via='webhook_dedupe'",
    );
    assert.equal(
      isIngestCandidate(after, cfg),
      false,
      "closed row is no longer an ingest candidate",
    );

    // ── 5. unparkRecoveryWindow clears closed_via. ────────────────────
    // saveState first so the cooldown delete from step 4 survives the
    // round-trip; unpark loads from storage and writes back.
    await saveState(state);
    const unparkRes = await unparkRecoveryWindow(month);
    assert.equal(unparkRes.unparked, true, "unpark reports a change");
    const afterUnpark: any = (
      await db
        .select()
        .from(frontAnalyticsMonthlyCoverage)
        .where(sql`month = ${month}` as any)
    )[0];
    assert.equal(
      afterUnpark.closedVia,
      null,
      "unpark clears closed_via on the row",
    );
    assert.equal(
      isIngestCandidate(afterUnpark, cfg),
      true,
      "row is eligible again after unpark",
    );
  } finally {
    __setFrontAutoClosureApplyLayerSampleOverride(null);
    await db.execute(
      sql`DELETE FROM front_analytics_monthly_coverage WHERE month = ${month}`,
    );
    await clearCumulativeMonth(month);
    await saveState(originalState);
    if (prevThreshold === undefined) {
      await db.execute(
        sql`DELETE FROM system_settings WHERE key = ${THRESHOLD_KEY}`,
      );
    } else {
      await db.execute(sql`
        UPDATE system_settings SET value = ${prevThreshold} WHERE key = ${THRESHOLD_KEY}
      `);
    }
    await cacheDel("system_settings", THRESHOLD_KEY);
  }

  console.log("✓ front-auto-closure close-dedupe-only tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
