/* test-registration
{
  "name": "Front Analytics finalized-month completeness alert opt-in (Task #2184)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.8s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2184 — Confirm the finalized-month completeness gap alert
 * actually fires once the opt-in toggle is turned on (and stays silent
 * when it is off).
 *
 * Task #2090 added the alerting logic and Task #2140 added the operator
 * toggle (`front_analytics_completeness_alerts_enabled`, default OFF),
 * but nothing pinned the end-to-end behavior: flipping the switch ON
 * must cause `runFrontAnalyticsCoverageAlertCheck` to fire for a
 * finalized month classified `ingest-gap` / `apply-gap` / `not-measured`,
 * and flipping it OFF must keep that path silent.
 *
 * Strategy: drive `runFrontAnalyticsCoverageAlertCheck` directly via the
 * `__frontAnalyticsCoverageAlertsTestHelpers` summary + dispatcher
 * overrides so no Front HTTP / real coverage rows are touched. We
 * isolate the completeness path from the drop / below-floor paths by:
 *   - keeping all-time applied coverage constant across ticks (no drop), and
 *   - pinning the month floor to 0 (no below-floor alert can fire),
 * so the ONLY thing that can produce an alert is the completeness path.
 *
 * Pinned behavior:
 *   1. Switch ON: a covered finalized month seeds the baseline (no
 *      alert), then the same month flipping to a masked gap fires
 *      exactly one `alerted_completeness` alert whose text names the
 *      month and the gap.
 *   2. Switch OFF (default): the identical covered → masked-gap
 *      transition produces no completeness alert.
 *   3. Switch ON re-tick with the same status dedupes (no re-alert);
 *      a status change (ingest-gap → apply-gap) re-fires.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  __frontAnalyticsCoverageAlertsTestHelpers,
  runFrontAnalyticsCoverageAlertCheck,
  SETTING_ENABLED,
  SETTING_DROP_DELTA_PCT,
  SETTING_MONTH_FLOOR_PCT,
  SETTING_COMPLETENESS_ALERTS_ENABLED,
  SETTING_PREVIOUS_SNAPSHOT,
} from "../server/services/frontAnalyticsCoverageAlerts";
import type { CoverageCompletenessStatus } from "../server/services/frontAnalyticsCoverage";

const TEST_MONTH = "2999-07";

const SETTING_KEYS_TO_RESTORE = [
  SETTING_ENABLED,
  SETTING_DROP_DELTA_PCT,
  SETTING_MONTH_FLOOR_PCT,
  SETTING_COMPLETENESS_ALERTS_ENABLED,
  SETTING_PREVIOUS_SNAPSHOT,
];

async function withSettingsBackup<T>(
  keys: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | null>();
  for (const k of keys) {
    const row = await storage.getSystemSetting(k).catch(() => null);
    saved.set(k, row?.value ?? null);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === null) {
        await storage.deleteSystemSetting(k);
      } else {
        await storage.setSystemSetting(k, v, "system");
      }
    }
  }
}

/**
 * Build a CoverageSummary with a single finalized month whose
 * completeness status we control directly. All-time applied coverage is
 * fixed so the drop path never fires; the month's appliedCoveragePct is
 * 100 so the (floor-0) below-floor path never fires either — leaving the
 * completeness path as the only possible alert source.
 */
function fakeSummary(status: CoverageCompletenessStatus): any {
  return {
    adoptionDate: "2024-01-15",
    allTime: {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 900,
      appliedIntoNobull: 900,
      ingestGap: 100,
      applyGap: 0,
      fetchedCoveragePct: 90,
      appliedCoveragePct: 90,
    },
    byMonth: [
      {
        month: TEST_MONTH,
        frontTotalMessages: 100,
        fetchedIntoNobull: 100,
        appliedIntoNobull: 100,
        ingestGap: 0,
        applyGap: 0,
        fetchedCoveragePct: 100,
        appliedCoveragePct: 100,
        pulledAt: new Date().toISOString(),
        isFinalizedMonth: true,
        frontAnalyticsStatus: "ok",
        frontAnalyticsError: null,
        completenessStatus: status,
        completenessReason: `synthetic ${status} for test`,
      },
    ],
    months: [],
    thresholds: { monthFloorPct: 0, dropDeltaPct: 50 },
    lastRefreshedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
  };
}

await withSettingsBackup(SETTING_KEYS_TO_RESTORE, async () => {
  const dispatched: Array<{ id: string; text: string }> = [];
  __frontAnalyticsCoverageAlertsTestHelpers.setDispatcherForTests(
    async (id, payload) => {
      dispatched.push({ id, text: payload.text });
      return { delivered: true } as any;
    },
  );

  try {
    // Master alert switch ON; isolate the completeness path: floor=0 so
    // no below-floor alert, large drop delta so no drop alert.
    await storage.setSystemSetting(SETTING_ENABLED, "true", "system");
    await storage.setSystemSetting(SETTING_DROP_DELTA_PCT, "50", "system");
    await storage.setSystemSetting(SETTING_MONTH_FLOOR_PCT, "0", "system");

    // ───────────────────────────────────────────────────────────────────
    // 1. Switch OFF (default) — no completeness alert across the same
    //    covered → masked-gap transition.
    // ───────────────────────────────────────────────────────────────────
    await storage.deleteSystemSetting(SETTING_PREVIOUS_SNAPSHOT);
    await storage.setSystemSetting(
      SETTING_COMPLETENESS_ALERTS_ENABLED,
      "false",
      "system",
    );

    // Tick A — covered month seeds the baseline.
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary("covered"),
    );
    let res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_baseline_seeded",
      `OFF tick A should seed baseline, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "OFF tick A must not dispatch");

    // Tick B — month flips to ingest-gap, but switch is OFF: silent.
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary("ingest-gap"),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `OFF tick B must stay silent, got ${res.decision}`,
    );
    assert.equal(
      res.completenessAlertMonths.length,
      0,
      "OFF tick B must surface no completeness months",
    );
    assert.equal(dispatched.length, 0, "OFF tick B must not dispatch");

    // ───────────────────────────────────────────────────────────────────
    // 2. Switch ON — the same transition fires exactly one completeness
    //    alert naming the month and the gap.
    // ───────────────────────────────────────────────────────────────────
    await storage.deleteSystemSetting(SETTING_PREVIOUS_SNAPSHOT);
    await storage.setSystemSetting(
      SETTING_COMPLETENESS_ALERTS_ENABLED,
      "true",
      "system",
    );

    // Tick A — covered month seeds the baseline (no pre-existing-gap alert).
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary("covered"),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_baseline_seeded",
      `ON tick A should seed baseline, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "ON tick A must not dispatch");

    // Tick B — month flips to ingest-gap: completeness alert fires.
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary("ingest-gap"),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_completeness",
      `ON tick B should fire completeness alert, got ${res.decision}`,
    );
    assert.equal(
      res.completenessAlertMonths.length,
      1,
      "ON tick B must surface exactly one completeness month",
    );
    assert.equal(res.completenessAlertMonths[0].month, TEST_MONTH);
    assert.equal(res.completenessAlertMonths[0].status, "ingest-gap");
    assert.equal(dispatched.length, 1, "ON tick B dispatches exactly one alert");
    assert.ok(
      dispatched[0].text.includes(TEST_MONTH),
      "alert text names the gap month",
    );
    assert.ok(
      /ingest gap/i.test(dispatched[0].text),
      "alert text describes the ingest gap",
    );

    // Tick C — identical status dedupes (no re-alert).
    dispatched.length = 0;
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `ON tick C (same status) must dedupe, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "ON tick C must not re-dispatch");

    // Tick D — status changes (ingest-gap → apply-gap): re-fires.
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary("apply-gap"),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_completeness",
      `ON tick D (status change) should re-fire, got ${res.decision}`,
    );
    assert.equal(res.completenessAlertMonths[0].status, "apply-gap");
    assert.equal(dispatched.length, 1, "ON tick D dispatches the status-change alert");

    console.log("front-analytics-completeness-alert.test.ts: OK");
  } finally {
    __frontAnalyticsCoverageAlertsTestHelpers.setDispatcherForTests(null);
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(null);
  }
});

process.exit(0);
