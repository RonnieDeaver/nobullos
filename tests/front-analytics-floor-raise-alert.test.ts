/* test-registration
{
  "name": "Front Analytics denominator floor-raise alert (Task #2819)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2819 — Confirm the denominator floor-raise alert fires when a
 * coverage refresh corrects a Front month's message denominator upward
 * (Task #2795 floor invariant), deduped once per month per raise.
 *
 * Strategy: drive `runFrontAnalyticsCoverageAlertCheck` directly via the
 * `__frontAnalyticsCoverageAlertsTestHelpers` summary + dispatcher
 * overrides so no Front HTTP / real coverage rows are touched. We
 * isolate the floor-raise path from the drop / below-floor /
 * completeness paths by:
 *   - keeping all-time applied coverage constant across ticks (no drop),
 *   - pinning the month floor to 0 (no below-floor alert), and
 *   - keeping the completeness switch OFF with a `covered` month,
 * so the ONLY thing that can produce an alert is the floor-raise path.
 *
 * Pinned behavior:
 *   1. Baseline seed with a pre-existing excess: no alert (first run
 *      never alerts on an already-raised month).
 *   2. A month gaining a NEW excess fires exactly one alert on the
 *      dedicated `integration.front.coverage_denominator_floor_raise`
 *      id, whose text names the month, the excess, and the
 *      reconciliation note.
 *   3. A refresh tick re-writing the same excess dedupes (silent).
 *   4. Sub-threshold growth (< regrowth %) stays silent; material
 *      regrowth (≥ regrowth % past the last-ALERTED excess) re-fires.
 *   5. Excess clearing prunes the dedupe entry so a later fresh raise
 *      alerts again.
 *   6. Sub-switch `front_analytics_floor_raise_alerts_enabled=false`
 *      keeps the identical new-raise transition silent.
 *   7. OFF → ON transition seeds raises that appeared while OFF (no
 *      catch-up alerts on re-enable); regrowth past the seed still fires.
 *   8. A legacy snapshot without `alertedFloorRaiseMonths` seeds from
 *      current raises on the first post-deploy tick (no catch-up).
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  __frontAnalyticsCoverageAlertsTestHelpers,
  runFrontAnalyticsCoverageAlertCheck,
  FLOOR_RAISE_NOTIFICATION_ID,
  SETTING_ENABLED,
  SETTING_DROP_DELTA_PCT,
  SETTING_MONTH_FLOOR_PCT,
  SETTING_COMPLETENESS_ALERTS_ENABLED,
  SETTING_FLOOR_RAISE_ALERTS_ENABLED,
  SETTING_FLOOR_RAISE_REGROWTH_PCT,
  SETTING_PREVIOUS_SNAPSHOT,
} from "../server/services/frontAnalyticsCoverageAlerts";

const TEST_MONTH = "2999-08";
const TEST_NOTE =
  "Front Analytics reported 90 messages but 100 local messages exist; denominator raised to the local count (synthetic note for test)";

const SETTING_KEYS_TO_RESTORE = [
  SETTING_ENABLED,
  SETTING_DROP_DELTA_PCT,
  SETTING_MONTH_FLOOR_PCT,
  SETTING_COMPLETENESS_ALERTS_ENABLED,
  SETTING_FLOOR_RAISE_ALERTS_ENABLED,
  SETTING_FLOOR_RAISE_REGROWTH_PCT,
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
 * denominator floor excess we control directly. All-time applied
 * coverage is fixed so the drop path never fires; the month's
 * appliedCoveragePct is 100 with floor 0 so below-floor never fires; the
 * month is `covered` with the completeness switch OFF — leaving the
 * floor-raise path as the only possible alert source.
 */
function fakeSummary(excess: number | null): any {
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
        completenessStatus: "covered",
        completenessReason: null,
        denominatorFloorExcess: excess,
        denominatorFloorReconciliationNote:
          excess != null && excess > 0 ? TEST_NOTE : null,
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
    // Master alert switch ON; isolate the floor-raise path: floor=0 so
    // no below-floor alert, large drop delta so no drop alert,
    // completeness OFF, regrowth threshold pinned at 25%.
    await storage.setSystemSetting(SETTING_ENABLED, "true", "system");
    await storage.setSystemSetting(SETTING_DROP_DELTA_PCT, "50", "system");
    await storage.setSystemSetting(SETTING_MONTH_FLOOR_PCT, "0", "system");
    await storage.setSystemSetting(
      SETTING_COMPLETENESS_ALERTS_ENABLED,
      "false",
      "system",
    );
    await storage.setSystemSetting(
      SETTING_FLOOR_RAISE_ALERTS_ENABLED,
      "true",
      "system",
    );
    await storage.setSystemSetting(
      SETTING_FLOOR_RAISE_REGROWTH_PCT,
      "25",
      "system",
    );

    // ───────────────────────────────────────────────────────────────────
    // 1. Baseline seed with a PRE-EXISTING excess: first run must not
    //    alert on it (seeded into the dedupe map instead).
    // ───────────────────────────────────────────────────────────────────
    await storage.deleteSystemSetting(SETTING_PREVIOUS_SNAPSHOT);
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(40),
    );
    let res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_baseline_seeded",
      `pre-existing excess tick should seed baseline, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "baseline seed must not dispatch");

    // Same excess next tick — still silent (seeded, not new).
    dispatched.length = 0;
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `seeded excess re-tick must dedupe, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "seeded excess re-tick must not dispatch");

    // ───────────────────────────────────────────────────────────────────
    // 2. Fresh baseline with NO excess, then the month gains one: fires
    //    exactly one alert on the dedicated notification id, naming the
    //    month, the excess, and the reconciliation note.
    // ───────────────────────────────────────────────────────────────────
    await storage.deleteSystemSetting(SETTING_PREVIOUS_SNAPSHOT);
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(null),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_baseline_seeded");

    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(100),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_floor_raise",
      `new excess should fire the floor-raise alert, got ${res.decision}`,
    );
    assert.equal(
      res.floorRaiseAlertMonths.length,
      1,
      "exactly one floor-raise month surfaced",
    );
    assert.equal(res.floorRaiseAlertMonths[0].month, TEST_MONTH);
    assert.equal(res.floorRaiseAlertMonths[0].excess, 100);
    assert.equal(res.floorRaiseAlertMonths[0].previousAlertedExcess, null);
    assert.equal(dispatched.length, 1, "exactly one dispatch for the new raise");
    assert.equal(
      dispatched[0].id,
      FLOOR_RAISE_NOTIFICATION_ID,
      "floor raise dispatches on its dedicated notification id",
    );
    assert.ok(
      dispatched[0].text.includes(TEST_MONTH),
      "alert text names the month",
    );
    assert.ok(
      dispatched[0].text.includes("100"),
      "alert text names the excess",
    );
    assert.ok(
      dispatched[0].text.includes(TEST_NOTE),
      "alert text carries the reconciliation note",
    );

    // ───────────────────────────────────────────────────────────────────
    // 3. Refresh tick re-writes the same excess: deduped (silent).
    // ───────────────────────────────────────────────────────────────────
    dispatched.length = 0;
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `same-excess refresh tick must dedupe, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "same-excess tick must not dispatch");

    // ───────────────────────────────────────────────────────────────────
    // 4. Sub-threshold growth (100 → 110, +10% < 25%) stays silent;
    //    material regrowth (100 → 125, +25%) re-fires with the growth
    //    framing.
    // ───────────────────────────────────────────────────────────────────
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(110),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `sub-threshold growth must stay silent, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "sub-threshold growth must not dispatch");

    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(125),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_floor_raise",
      `material regrowth should re-fire, got ${res.decision}`,
    );
    assert.equal(res.floorRaiseAlertMonths[0].excess, 125);
    assert.equal(
      res.floorRaiseAlertMonths[0].previousAlertedExcess,
      100,
      "regrowth compares against the last-ALERTED excess (100), not the last-seen (110)",
    );
    assert.equal(dispatched.length, 1, "regrowth dispatches exactly once");
    assert.ok(
      /grew from 100 to 125/.test(dispatched[0].text),
      "regrowth text names the previous and current excess",
    );

    // ───────────────────────────────────────────────────────────────────
    // 5. Excess clears (denominator no longer floored) → entry pruned →
    //    a later fresh raise alerts again as NEW.
    // ───────────────────────────────────────────────────────────────────
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(null),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_no_change");
    assert.equal(dispatched.length, 0);

    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(10),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_floor_raise",
      `fresh raise after clearing should fire as NEW, got ${res.decision}`,
    );
    assert.equal(
      res.floorRaiseAlertMonths[0].previousAlertedExcess,
      null,
      "cleared month re-raises as a NEW raise (pruned dedupe entry)",
    );
    assert.equal(dispatched.length, 1);

    // ───────────────────────────────────────────────────────────────────
    // 6. Sub-switch OFF: the identical no-excess → new-excess transition
    //    stays silent.
    // ───────────────────────────────────────────────────────────────────
    await storage.deleteSystemSetting(SETTING_PREVIOUS_SNAPSHOT);
    await storage.setSystemSetting(
      SETTING_FLOOR_RAISE_ALERTS_ENABLED,
      "false",
      "system",
    );
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(null),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_baseline_seeded");

    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(100),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `sub-switch OFF must keep a new raise silent, got ${res.decision}`,
    );
    assert.equal(
      res.floorRaiseAlertMonths.length,
      0,
      "sub-switch OFF surfaces no floor-raise months",
    );
    assert.equal(dispatched.length, 0, "sub-switch OFF must not dispatch");

    // ───────────────────────────────────────────────────────────────────
    // 7. OFF → ON transition: raises that appeared during the disabled
    //    window are SEEDED, so re-enabling never fires catch-up alerts
    //    for them — but material regrowth past the seeded value still
    //    alerts afterward.
    // ───────────────────────────────────────────────────────────────────
    await storage.setSystemSetting(
      SETTING_FLOOR_RAISE_ALERTS_ENABLED,
      "true",
      "system",
    );
    dispatched.length = 0;
    // Same excess (100) that appeared while the switch was OFF.
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `re-enabling must not catch-up-alert on a raise seeded while OFF, got ${res.decision}`,
    );
    assert.equal(
      dispatched.length,
      0,
      "OFF→ON with unchanged excess must not dispatch",
    );

    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(130),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_floor_raise",
      `material regrowth past the OFF-window seed must still alert, got ${res.decision}`,
    );
    assert.equal(
      res.floorRaiseAlertMonths[0].previousAlertedExcess,
      100,
      "regrowth compares against the excess seeded during the OFF window",
    );
    assert.equal(dispatched.length, 1);

    // ───────────────────────────────────────────────────────────────────
    // 8. Legacy-snapshot migration: a persisted snapshot that PREDATES
    //    the floor-raise feature (no alertedFloorRaiseMonths field) must
    //    SEED from current raises on the first post-deploy tick — never
    //    fire catch-up alerts for pre-existing excesses. Material
    //    regrowth past the seeded value still alerts afterward.
    // ───────────────────────────────────────────────────────────────────
    await storage.setSystemSetting(
      SETTING_PREVIOUS_SNAPSHOT,
      JSON.stringify({
        appliedCoveragePct: 90,
        takenAt: new Date().toISOString(),
        alertedBelowFloorMonths: [],
        alertedCompletenessMonths: {},
        // no alertedFloorRaiseMonths — pre-Task-#2819 snapshot shape
      }),
      "system",
    );
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(100),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `legacy snapshot + pre-existing excess must stay silent (seed, not catch-up), got ${res.decision}`,
    );
    assert.equal(
      dispatched.length,
      0,
      "legacy-snapshot upgrade tick must not dispatch",
    );

    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(130),
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_floor_raise",
      `regrowth past the migration-seeded excess must alert, got ${res.decision}`,
    );
    assert.equal(
      res.floorRaiseAlertMonths[0].previousAlertedExcess,
      100,
      "regrowth compares against the migration-seeded excess",
    );
    assert.equal(dispatched.length, 1);

    console.log("front-analytics-floor-raise-alert.test.ts: OK");
  } finally {
    __frontAnalyticsCoverageAlertsTestHelpers.setDispatcherForTests(null);
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(null);
  }
});

process.exit(0);
