/* test-registration
{
  "name": "Front Analytics status normalization (Task #1783)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1783 — Front Analytics status normalization regression test.
 *
 * The dashboard badge only treats `"ok" | "search" | "search_truncated"`
 * as success states. Front's Analytics API returns `"done" | "partial"`,
 * which previously fell through to the rose "error" badge even on a
 * successful Retry.
 *
 * This test pins the fix in `refreshMonth`'s Analytics success path:
 *
 *   1. A `"done"` response persists `front_analytics_status = "ok"`
 *      (not "done"), the API response echoes "ok", and the row's
 *      `front_analytics_error` is null.
 *   2. A `"partial"` response also persists `"ok"` — partial still
 *      returns a numeric denominator, so we treat it as a success the
 *      badge can render.
 *
 * Uses the `setPullOverride` test hook so no Front HTTP calls happen.
 * Cleans up the rows it creates by a far-future month prefix so it
 * doesn't disturb the rest of the suite.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  __frontAnalyticsClientTestHelpers,
  type MonthlyMetricResult,
} from "../server/services/frontAnalyticsClient";
import {
  refreshMonth,
  getExistingMonth,
  SETTING_ADOPTION_DATE,
} from "../server/services/frontAnalyticsCoverage";

const FUTURE_YEAR = 2997;

async function cleanupTestRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month LIKE ${`${FUTURE_YEAR}-%`}
  `);
}

function utcMonth(year: number, mIdx: number): {
  start: Date;
  end: Date;
  label: string;
} {
  return {
    start: new Date(Date.UTC(year, mIdx, 1)),
    end: new Date(Date.UTC(year, mIdx + 1, 1)),
    label: `${year}-${String(mIdx + 1).padStart(2, "0")}`,
  };
}

const savedAdoption =
  (await storage.getSystemSetting(SETTING_ADOPTION_DATE).catch(() => null))
    ?.value ?? null;
await storage.setSystemSetting(SETTING_ADOPTION_DATE, "2024-01-15", "system");

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
try {
  await cleanupTestRows();

  // ─────────────────────────────────────────────────────────────────────
  // 1. status="done" must be persisted as "ok".
  // ─────────────────────────────────────────────────────────────────────
  const jan = utcMonth(FUTURE_YEAR, 0);
  __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
    return {
      reportId: "test-done",
      value: 250,
      status: "done",
      metric: "num_messages_received",
    } as MonthlyMetricResult;
  });
  const rDone = await refreshMonth({
    month: jan.label,
    monthStart: jan.start,
    monthEnd: jan.end,
    isCurrentMonth: false,
  });
  assert.equal(rDone.outcome, "ok", "status=done returns ok outcome");
  assert.equal(
    rDone.frontAnalyticsStatus,
    "ok",
    'API response echoes normalized "ok" status',
  );
  assert.equal(rDone.frontAnalyticsError, null);
  const rowDone = await getExistingMonth(jan.label);
  assert.ok(rowDone, "Jan row persisted");
  assert.equal(
    rowDone!.frontAnalyticsStatus,
    "ok",
    "persisted column is normalized to ok (not done)",
  );
  assert.equal(rowDone!.frontAnalyticsError, null);
  // Task #2290 — the headline denominator is now the per-direction message
  // sum (inbound + outbound). `pullMonthlyMessagesByDirection` issues two
  // `pullMonthlyMessageCountResolved` calls (num_messages_received +
  // num_messages_sent), both of which the metric-agnostic pull override
  // answers with the same value, so the stored `front_total_messages` is
  // 250 + 250 = 500 (this suite pins status normalization, not the value).
  assert.equal(rowDone!.frontTotalMessages, 250 + 250);

  // ─────────────────────────────────────────────────────────────────────
  // 2. status="partial" still numeric — also normalized to "ok".
  // ─────────────────────────────────────────────────────────────────────
  const feb = utcMonth(FUTURE_YEAR, 1);
  __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
    return {
      reportId: "test-partial",
      value: 17,
      status: "partial",
      metric: "num_messages_received",
    } as MonthlyMetricResult;
  });
  const rPartial = await refreshMonth({
    month: feb.label,
    monthStart: feb.start,
    monthEnd: feb.end,
    isCurrentMonth: false,
  });
  assert.equal(rPartial.outcome, "ok");
  assert.equal(
    rPartial.frontAnalyticsStatus,
    "ok",
    'partial response also normalized to "ok" in the API response',
  );
  const rowPartial = await getExistingMonth(feb.label);
  assert.ok(rowPartial, "Feb row persisted");
  assert.equal(
    rowPartial!.frontAnalyticsStatus,
    "ok",
    "partial-status row persists as ok so the UI badge renders as final",
  );
  assert.equal(rowPartial!.frontAnalyticsError, null);
  // Task #2290 — per-direction sum (see the "done" case above): 17 + 17.
  assert.equal(rowPartial!.frontTotalMessages, 17 + 17);

  console.log("✓ Front Analytics status normalization (Task #1783) passed");
} finally {
  __frontAnalyticsClientTestHelpers.setPullOverride(null);
  await cleanupTestRows();
  if (savedAdoption === null) {
    await storage.deleteSystemSetting(SETTING_ADOPTION_DATE);
  } else {
    await storage.setSystemSetting(
      SETTING_ADOPTION_DATE,
      savedAdoption,
      "system",
    );
  }
}
