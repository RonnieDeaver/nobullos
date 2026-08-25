/* test-registration
{
  "name": "Front Analytics all-time coverage (Task #1643)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 300000,
  "tier": "small"
}
test-registration */
/**
 * Task #1643 — Front Analytics all-time coverage regression test.
 *
 * Covers:
 *   1. `ensureFrontAdoptionDate()` derives from earliest
 *      `source_event_log` row on first run, then NEVER auto-advances.
 *   2. `computeCoverage()` math (ingest gap / apply gap / pcts).
 *   3. `refreshMonth()` cache rules:
 *        - completed-month happy path persists finalized row
 *        - finalized completed month is skipped on next tick
 *        - current month is upserted on every tick
 *        - Front error persists typed error code and DOES NOT finalize
 *   4. `getFrontAnalyticsCoverageSummary()` aggregation totals + thresholds.
 *   5. `runFrontAnalyticsCoverageAlertCheck()`:
 *        - baseline-seeded on first run
 *        - drop alert fires when applied pct dips > delta
 *        - new-month below-floor alert fires; previously-alerted month
 *          is deduped on the next tick.
 *
 * Uses the `__frontAnalyticsClientTestHelpers.setPullOverride` hook so
 * no Front HTTP calls happen. Cleans up rows it creates by month-label
 * prefix so other tests aren't disturbed.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { frontAnalyticsMonthlyCoverage, workQueue } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  __frontAnalyticsClientTestHelpers,
  FrontAnalyticsError,
  type MonthlyMetricResult,
} from "../server/services/frontAnalyticsClient";
import {
  ensureFrontAdoptionDate,
  FRONT_ADOPTION_DATE,
  refreshMonth,
  getExistingMonth,
  getFrontAnalyticsCoverageSummary,
  QUEUE_NAME as COVERAGE_QUEUE_NAME,
  SETTING_ADOPTION_DATE,
  SETTING_MEASUREMENT_REFRESH_ENABLED,
  SETTING_REFRESH_ENABLED,
  __frontAnalyticsCoverageTestHelpers,
} from "../server/services/frontAnalyticsCoverage";
import {
  __frontAnalyticsCoverageAlertsTestHelpers,
  runFrontAnalyticsCoverageAlertCheck,
  SETTING_DROP_DELTA_PCT,
  SETTING_ENABLED as ALERT_SETTING_ENABLED,
  SETTING_MONTH_FLOOR_PCT,
  SETTING_COMPLETENESS_ALERTS_ENABLED,
  SETTING_PREVIOUS_SNAPSHOT,
} from "../server/services/frontAnalyticsCoverageAlerts";
import { getRegisteredHandler } from "../server/services/workScheduler";
import { registerAllHandlers } from "../server/services/workQueueHandlers";
import type { WorkQueueJob } from "@shared/schema";

// All settings writes/deletes flow through `storage.setSystemSetting` /
// `storage.deleteSystemSetting` so the in-process settings cache + the
// Redis read-through cache stay consistent with the row. The Task #1855
// raw-SQL ban applies here too.
async function rawDeleteSetting(key: string): Promise<void> {
  await storage.deleteSystemSetting(key);
}

// Unique month prefix so we can clean up without colliding with other tests.
// We use far-future months (2999-*) so they never overlap a real adoption.
const FUTURE_YEAR = 2999;
const TEST_MONTHS = [
  `${FUTURE_YEAR}-01`,
  `${FUTURE_YEAR}-02`,
  `${FUTURE_YEAR}-03`,
];

async function cleanupTestRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month LIKE ${`${FUTURE_YEAR}-%`}
  `);
}

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
        await rawDeleteSetting(k);
      } else {
        await storage.setSystemSetting(k, v, "system");
      }
    }
  }
}

function utcMonth(year: number, mIdx: number): { start: Date; end: Date; label: string } {
  return {
    start: new Date(Date.UTC(year, mIdx, 1)),
    end: new Date(Date.UTC(year, mIdx + 1, 1)),
    label: `${year}-${String(mIdx + 1).padStart(2, "0")}`,
  };
}

const SETTING_KEYS_TO_RESTORE = [
  SETTING_ADOPTION_DATE,
  SETTING_PREVIOUS_SNAPSHOT,
  ALERT_SETTING_ENABLED,
  SETTING_DROP_DELTA_PCT,
  SETTING_MONTH_FLOOR_PCT,
  SETTING_MEASUREMENT_REFRESH_ENABLED,
  // Task #2366 — the legacy emergency master `front_analytics_refresh_enabled`
  // and the completeness-alerts opt-in are global system_settings this suite
  // reads. A sibling test (e.g. front-analytics-trigger-blocked-reasons /
  // front-auto-closure) flips REFRESH_ENABLED to "false"; if that sibling is
  // SIGKILL'd on timeout before its `finally` restore runs, the durable "false"
  // leaks into the shared dev DB and the handler section below reads "refresh
  // disabled in system_settings" (pullCalls=0). Back up + pin to "true" so this
  // suite is deterministic regardless of leftover global state.
  SETTING_REFRESH_ENABLED,
  SETTING_COMPLETENESS_ALERTS_ENABLED,
];

await withSettingsBackup(SETTING_KEYS_TO_RESTORE, async () => {
  await cleanupTestRows();

  // Task #2366 — pin the legacy emergency refresh master ON for the whole
  // suite so the section-6b handler test (runCoverageRefreshTick) is never
  // short-circuited by a "false" left behind in the shared dev DB by a
  // concurrently-killed sibling test.
  await storage.setSystemSetting(SETTING_REFRESH_ENABLED, "true", "test");

  // ───────────────────────────────────────────────────────────────────────
  // 1. ensureFrontAdoptionDate — Task #2481: returns the hard-coded
  //    FRONT_ADOPTION_DATE constant. It performs NO source_event_log query
  //    and NO system_settings read/write, so any lingering
  //    `system_settings.front_adoption_date` row is DEAD/IGNORED. The
  //    floor is fixed and never auto-advances regardless of DB state — the
  //    exact regression class Task #2481 was written to eliminate.
  // ───────────────────────────────────────────────────────────────────────
  // Writing a divergent system_settings value must NOT change the result:
  // the function ignores the row entirely.
  await storage.setSystemSetting(SETTING_ADOPTION_DATE, "2024-01-15", "system");
  let adoption = await ensureFrontAdoptionDate();
  assert.equal(
    adoption,
    FRONT_ADOPTION_DATE,
    "adoption date is the hard-coded constant, ignoring system_settings",
  );

  // Deleting the row must ALSO leave the result unchanged (never null,
  // never derived from source_event_log) — proving the dead-row contract.
  await rawDeleteSetting(SETTING_ADOPTION_DATE);
  adoption = await ensureFrontAdoptionDate();
  assert.equal(
    adoption,
    FRONT_ADOPTION_DATE,
    "adoption date stays the constant even with no system_settings row",
  );

  // ───────────────────────────────────────────────────────────────────────
  // 2. computeCoverage math.
  // ───────────────────────────────────────────────────────────────────────
  const { computeCoverage } = __frontAnalyticsCoverageTestHelpers;
  const c1 = computeCoverage({ frontTotal: 100, fetched: 80, applied: 60 });
  assert.equal(c1.ingestGap, 20);
  assert.equal(c1.applyGap, 20);
  assert.equal(c1.fetchedCoveragePct, 80);
  assert.equal(c1.appliedCoveragePct, 60);
  // Local counts exceed Front — gap clamps to 0, pct caps at 100.
  const c2 = computeCoverage({ frontTotal: 50, fetched: 60, applied: 70 });
  assert.equal(c2.ingestGap, 0);
  assert.equal(c2.applyGap, 0);
  assert.equal(c2.fetchedCoveragePct, 100);
  assert.equal(c2.appliedCoveragePct, 100);
  // Zero denom.
  const c3 = computeCoverage({ frontTotal: 0, fetched: 0, applied: 0 });
  assert.equal(c3.fetchedCoveragePct, 0);
  assert.equal(c3.appliedCoveragePct, 0);

  // ───────────────────────────────────────────────────────────────────────
  // 3. refreshMonth cache rules. We stub the Front pull so it never hits
  //    the network. Each call returns the next scripted value.
  // ───────────────────────────────────────────────────────────────────────
  const scripted: Array<
    | { kind: "ok"; value: number }
    | { kind: "throw"; err: Error }
  > = [];
  __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
    const next = scripted.shift();
    if (!next) throw new Error("test: scripted pull queue empty");
    if (next.kind === "throw") throw next.err;
    return {
      reportId: `test-${Math.random().toString(36).slice(2, 8)}`,
      value: next.value,
      status: "done",
      metric: "num_messages_received",
    } as MonthlyMetricResult;
  });

  try {
    const jan = utcMonth(FUTURE_YEAR, 0);
    const feb = utcMonth(FUTURE_YEAR, 1);
    const mar = utcMonth(FUTURE_YEAR, 2);

    // 3a — completed-month happy path.
    scripted.push({ kind: "ok", value: 100 });
    const r1 = await refreshMonth({
      month: jan.label,
      monthStart: jan.start,
      monthEnd: jan.end,
      isCurrentMonth: false,
    });
    assert.equal(r1.outcome, "ok");
    let row = await getExistingMonth(jan.label);
    assert.ok(row, "row persisted for Jan");
    assert.equal(row!.frontTotalMessages, 100);
    assert.equal(row!.isFinalizedMonth, true);
    assert.ok(row!.pulledAt, "pulledAt set");
    assert.equal(row!.frontAnalyticsError, null);

    // 3b — finalized completed month is skipped on next tick (no pull
    // consumed from the queue).
    const r2 = await refreshMonth({
      month: jan.label,
      monthStart: jan.start,
      monthEnd: jan.end,
      isCurrentMonth: false,
    });
    assert.equal(r2.outcome, "skipped_existing_finalized");
    assert.equal(scripted.length, 0, "no pull was consumed for finalized month");

    // 3c — current month is upserted every tick (consumes a pull both
    // times) and is NOT finalized.
    scripted.push({ kind: "ok", value: 50 });
    const r3 = await refreshMonth({
      month: mar.label,
      monthStart: mar.start,
      monthEnd: mar.end,
      isCurrentMonth: true,
    });
    assert.equal(r3.outcome, "ok_current_upsert");
    row = await getExistingMonth(mar.label);
    assert.equal(row!.isFinalizedMonth, false, "current month NOT finalized");
    assert.equal(row!.frontTotalMessages, 50);

    scripted.push({ kind: "ok", value: 55 });
    const r3b = await refreshMonth({
      month: mar.label,
      monthStart: mar.start,
      monthEnd: mar.end,
      isCurrentMonth: true,
    });
    assert.equal(r3b.outcome, "ok_current_upsert");
    row = await getExistingMonth(mar.label);
    assert.equal(row!.frontTotalMessages, 55, "current month re-pulled and updated");

    // 3d — Front error persists typed error code and does NOT finalize.
    class FakeFrontErr extends Error {
      code = "front_analytics_rate_limited";
      constructor() { super("rate limited"); }
    }
    // The refreshMonth code uses `instanceof FrontAnalyticsError`; an
    // arbitrary error therefore lands as the generic
    // `front_analytics_report_failed` code. That is the documented
    // fallback. Assert that fallback path here.
    scripted.push({ kind: "throw", err: new FakeFrontErr() });
    const r4 = await refreshMonth({
      month: feb.label,
      monthStart: feb.start,
      monthEnd: feb.end,
      isCurrentMonth: false,
    });
    assert.equal(r4.outcome, "front_error");
    assert.equal(r4.errorCode, "front_analytics_report_failed");
    row = await getExistingMonth(feb.label);
    assert.ok(row, "row persisted even on error");
    assert.equal(row!.isFinalizedMonth, false, "errored month NOT finalized");
    assert.equal(row!.frontAnalyticsStatus, "error");
    assert.ok(
      row!.frontAnalyticsError?.startsWith("front_analytics_report_failed:"),
      `expected typed error prefix, got: ${row!.frontAnalyticsError}`,
    );

    // ─────────────────────────────────────────────────────────────────────
    // 4. Summary aggregation — totals across the two rows we wrote
    //    (jan=100, mar=55, feb=0 because the pull errored).
    // ─────────────────────────────────────────────────────────────────────
    // To make aggregation deterministic regardless of *other* rows present
    // in the dev DB, scope our assertion to just our future-year rows.
    const futureRows = await db
      .select()
      .from(frontAnalyticsMonthlyCoverage)
      .where(sql`month LIKE ${`${FUTURE_YEAR}-%`}`);
    const sumFront = futureRows.reduce((a, r) => a + r.frontTotalMessages, 0);
    assert.equal(sumFront, 100 + 55 + 0, "future-year rows sum to expected total");

    // Full summary helper exposes both `byMonth` and `months` alias,
    // plus thresholds.
    const summary = await getFrontAnalyticsCoverageSummary();
    assert.equal(
      summary.byMonth.length,
      summary.months.length,
      "months is an alias of byMonth",
    );
    assert.equal(typeof summary.thresholds.monthFloorPct, "number");
    assert.equal(typeof summary.thresholds.dropDeltaPct, "number");
    assert.ok(
      typeof summary.allTime.appliedCoveragePct === "number",
      "applied coverage is numeric",
    );
    // Task #2250 — the summary exposes the shared trigger-gate state so
    // the panel can disable refresh-month / reprobe-month / recompute
    // with an inline reason before the press. Shape contract:
    assert.equal(
      typeof summary.triggerGates.refreshEnabled,
      "boolean",
      "triggerGates.refreshEnabled is a boolean",
    );
    assert.equal(
      typeof summary.triggerGates.queuePaused,
      "boolean",
      "triggerGates.queuePaused is a boolean",
    );
    assert.equal(
      typeof summary.triggerGates.killSwitchNonCriticalSweeps,
      "boolean",
      "triggerGates.killSwitchNonCriticalSweeps is a boolean",
    );
    assert.ok(
      summary.triggerGates.blockedReason === null ||
        typeof summary.triggerGates.blockedReason === "string",
      "triggerGates.blockedReason is null or a string",
    );

    // ─────────────────────────────────────────────────────────────────────
    // 5. Alert check: baseline → drop → below-floor → dedupe.
    // ─────────────────────────────────────────────────────────────────────
    await rawDeleteSetting(SETTING_PREVIOUS_SNAPSHOT);
    await storage.setSystemSetting(ALERT_SETTING_ENABLED, "true", "system");
    await storage.setSystemSetting(SETTING_DROP_DELTA_PCT, "2.0", "system");
    await storage.setSystemSetting(SETTING_MONTH_FLOOR_PCT, "95.0", "system");

    const fakeSummary = (allTime: number, monthRows: Array<{ month: string; pct: number }>) => ({
      adoptionDate: "2024-01-15",
      allTime: {
        frontTotalMessages: 1000,
        fetchedIntoNobull: Math.round((allTime / 100) * 1000),
        appliedIntoNobull: Math.round((allTime / 100) * 1000),
        ingestGap: 5,
        applyGap: 10,
        fetchedCoveragePct: allTime,
        appliedCoveragePct: allTime,
      },
      byMonth: monthRows.map((m) => ({
        month: m.month,
        frontTotalMessages: 100,
        fetchedIntoNobull: 100,
        appliedIntoNobull: Math.round(m.pct),
        ingestGap: 0,
        applyGap: 100 - Math.round(m.pct),
        fetchedCoveragePct: 100,
        appliedCoveragePct: m.pct,
        pulledAt: new Date().toISOString(),
        isFinalizedMonth: true,
        frontAnalyticsStatus: "ok",
        frontAnalyticsError: null,
      })),
      months: [] as any[],
      thresholds: { monthFloorPct: 95.0, dropDeltaPct: 2.0 },
      lastRefreshedAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
    });

    const dispatched: Array<{ id: string; text: string }> = [];
    __frontAnalyticsCoverageAlertsTestHelpers.setDispatcherForTests(
      async (id, payload) => {
        dispatched.push({ id, text: payload.text });
        return { delivered: true } as any;
      },
    );

    // First tick — baseline seeded, no alert.
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(99.0, [{ month: "2025-01", pct: 99.0 }]) as any,
    );
    let res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_baseline_seeded");
    assert.equal(dispatched.length, 0);

    // Second tick — drop > delta fires the drop alert.
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () => fakeSummary(95.0, [{ month: "2025-01", pct: 95.0 }]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.ok(
      res.decision === "alerted_drop" || res.decision === "alerted_drop_and_floor",
      `expected drop alert, got ${res.decision}`,
    );
    assert.ok(dispatched.length >= 1, "drop alert dispatched");

    // Third tick — new below-floor month surfaces alert; previously
    // alerted month is deduped.
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        fakeSummary(95.0, [
          { month: "2025-01", pct: 95.0 }, // no longer below floor
          { month: "2025-02", pct: 80.0 }, // NEW below floor
        ]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "alerted_floor", `expected floor alert, got ${res.decision}`);
    assert.equal(dispatched.length, 1);
    assert.ok(dispatched[0].text.includes("2025-02"), "alert mentions new month");

    // Fourth tick — same below-floor set, no alert (dedupe).
    dispatched.length = 0;
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_no_change");
    assert.equal(dispatched.length, 0);

    // ─────────────────────────────────────────────────────────────────────
    // 6. Task #1644 — queue path: the scheduler enqueues a job (vs.
    //    running the tick inline), and the registered handler runs
    //    both `runCoverageRefreshTick` and
    //    `runFrontAnalyticsCoverageAlertCheck` end-to-end.
    // ─────────────────────────────────────────────────────────────────────

    // 6a — enqueueScheduledTick honors the Task #1787 Stage 1 cadence
    //      gate: when nothing is due it inserts zero rows; when at
    //      least one month is due it inserts a single `work_queue` row
    //      with the expected queue name, workload class, and bucketed
    //      dedupe key; a second call in the same bucket is deduped.
    const { enqueueScheduledTick } = __frontAnalyticsCoverageTestHelpers;
    const bucketBefore = Math.floor(Date.now() / (30 * 60_000));
    const expectedDedupeKey = `${COVERAGE_QUEUE_NAME}:scheduled:${bucketBefore}`;
    // Clean any stale row for the current bucket left by a prior run.
    await db
      .delete(workQueue)
      .where(eq(workQueue.dedupeKey, expectedDedupeKey));

    // 6a.i — "nothing due" branch: flipping the Stage 1 measurement
    //         master switch OFF makes `anyMonthDueForRefresh()` return
    //         false unconditionally, so the scheduler must skip the
    //         enqueue and insert zero rows for this bucket.
    await storage.setSystemSetting(
      SETTING_MEASUREMENT_REFRESH_ENABLED,
      "false",
      "system",
    );
    await enqueueScheduledTick();
    let queued = await db
      .select()
      .from(workQueue)
      .where(eq(workQueue.dedupeKey, expectedDedupeKey));
    assert.equal(
      queued.length,
      0,
      "cadence gate (no month due) must enqueue zero rows",
    );
    void queued;

    // 6a.ii — "due" branch: re-enable measurement and force the
    //          current calendar month's coverage row into a "stale"
    //          state by backdating `pulled_at` so the Stage 1 cadence
    //          gate (`currentMonthIntervalMs`, default 6h) classifies
    //          it as due. We snapshot the prior `pulled_at` and
    //          restore it after the assertion so this test does not
    //          mutate observable coverage state for other tests.
    await storage.setSystemSetting(
      SETTING_MEASUREMENT_REFRESH_ENABLED,
      "true",
      "system",
    );
    const currentMonthLabelStr = (() => {
      const n = new Date();
      return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`;
    })();
    const priorCurrentRow = await getExistingMonth(currentMonthLabelStr);
    const priorPulledAt = priorCurrentRow?.pulledAt ?? null;
    if (priorCurrentRow) {
      await db.execute(sql`
        UPDATE front_analytics_monthly_coverage
        SET pulled_at = ${new Date("2000-01-01T00:00:00Z").toISOString()}
        WHERE month = ${currentMonthLabelStr}
      `);
    }

    // Task #1789 — keep the backdated pulled_at in place across BOTH
    // the enqueueScheduledTick assertions AND the handler invocation
    // below (line ~569). The handler re-runs the same cadence gate
    // (currentDue) inside runCoverageRefreshTick; restoring pulled_at
    // before the handler runs would make the gate skip the current
    // month and pullCalls would stay 0. The finally that restores the
    // prior pulled_at now spans through `await handler!(mockJob)`.
    let restoredPulledAt = false;
    const restorePulledAt = async () => {
      if (restoredPulledAt) return;
      restoredPulledAt = true;
      if (!priorCurrentRow) return;
      if (priorPulledAt) {
        await db.execute(sql`
          UPDATE front_analytics_monthly_coverage
          SET pulled_at = ${priorPulledAt.toISOString()}
          WHERE month = ${currentMonthLabelStr}
        `);
      } else {
        await db.execute(sql`
          UPDATE front_analytics_monthly_coverage
          SET pulled_at = NULL
          WHERE month = ${currentMonthLabelStr}
        `);
      }
    };
    try {
      await enqueueScheduledTick();
    } catch (err) {
      await restorePulledAt();
      throw err;
    }
    const bucketAfter = Math.floor(Date.now() / (30 * 60_000));
    assert.equal(
      bucketAfter,
      bucketBefore,
      "test must not straddle a 30-minute bucket boundary",
    );

    queued = await db
      .select()
      .from(workQueue)
      .where(eq(workQueue.dedupeKey, expectedDedupeKey));
    assert.equal(queued.length, 1, "scheduled tick must enqueue exactly one row");
    assert.equal(queued[0].queueName, COVERAGE_QUEUE_NAME);
    assert.equal(queued[0].workloadClass, "maintenance");
    assert.equal(queued[0].dedupeKey, expectedDedupeKey);
    assert.ok(
      queued[0].status === "pending" ||
        queued[0].status === "leased" ||
        queued[0].status === "processing",
      `expected open status, got ${queued[0].status}`,
    );
    const queuedPayload = queued[0].payload as
      | { trigger?: string; bucket?: number }
      | null;
    assert.equal(queuedPayload?.trigger, "scheduled", "payload records trigger");
    assert.equal(queuedPayload?.bucket, bucketBefore, "payload records bucket id");

    // Second call in the same bucket dedupes: still one row.
    await enqueueScheduledTick();
    queued = await db
      .select()
      .from(workQueue)
      .where(eq(workQueue.dedupeKey, expectedDedupeKey));
    assert.equal(
      queued.length,
      1,
      "second scheduled tick in the same bucket must dedupe",
    );

    // 6b — handler runs `runCoverageRefreshTick` AND
    //      `runFrontAnalyticsCoverageAlertCheck` end-to-end. We assert
    //      this via observable side effects: the pull override fires
    //      (only `runCoverageRefreshTick` reaches the Front client),
    //      and the alert summary override fires (only
    //      `runFrontAnalyticsCoverageAlertCheck` calls it).
    registerAllHandlers();
    const handler = getRegisteredHandler(COVERAGE_QUEUE_NAME);
    assert.ok(
      handler,
      "registerAllHandlers must register the front_analytics_coverage_refresh handler",
    );

    // Unlimited pull override (the section-3 scripted override has
    // since been drained); counts every invocation made by the tick.
    let pullCalls = 0;
    __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
      pullCalls++;
      return {
        reportId: `handler-${pullCalls}`,
        value: 1,
        status: "done",
        metric: "num_messages_received",
      } as MonthlyMetricResult;
    });

    // Summary override the alert check will read. Counts invocations
    // so we know the alert path executed inside the handler.
    let summaryCalls = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(async () => {
      summaryCalls++;
      return fakeSummary(99.0, [{ month: "2025-01", pct: 99.0 }]) as any;
    });

    const mockJob: WorkQueueJob = {
      id: queued[0].id,
      queueName: COVERAGE_QUEUE_NAME,
      jobType: COVERAGE_QUEUE_NAME,
      workloadClass: "maintenance",
      priority: 200,
      status: "processing",
      payload: queuedPayload,
      payloadJson: null,
      dedupeKey: expectedDedupeKey,
      cursor: null,
      cursorJson: null,
      attemptCount: 0,
      maxAttempts: 2,
      retryAt: null,
      leasedAt: new Date(),
      leaseOwner: "test",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      heartbeatAt: new Date(),
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };

    try {
      await handler!(mockJob);
    } finally {
      await restorePulledAt();
    }

    assert.ok(
      pullCalls > 0,
      "handler must invoke runCoverageRefreshTick (Front pull was never called)",
    );
    assert.ok(
      summaryCalls > 0,
      "handler must invoke runFrontAnalyticsCoverageAlertCheck (summary override was never called)",
    );

    // Clean up the queue row so subsequent runs don't see stale state.
    await db
      .delete(workQueue)
      .where(eq(workQueue.dedupeKey, expectedDedupeKey));

    // ─────────────────────────────────────────────────────────────────────
    // 7. Task #1780 — manual `forceRerun` bypasses the finalized-row
    //    short-circuit; worker tick (no forceRerun) still skips clean
    //    finalized rows.
    // ─────────────────────────────────────────────────────────────────────
    // Reset the scripted Analytics override (the handler test above
    // installed an unlimited override; replace it with a counted one
    // so we can assert pulls happened or didn't).
    let t1780Calls = 0;
    __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
      t1780Calls += 1;
      return {
        reportId: `t1780-${t1780Calls}`,
        value: 200 + t1780Calls,
        status: "done",
        metric: "num_messages_received",
      } as MonthlyMetricResult;
    });

    const apr = utcMonth(FUTURE_YEAR, 3); // YYYY-04 (clean finalized below)

    // Seed a clean finalized row by running once with isCurrentMonth=false.
    const seed = await refreshMonth({
      month: apr.label,
      monthStart: apr.start,
      monthEnd: apr.end,
      isCurrentMonth: false,
    });
    assert.equal(seed.outcome, "ok");
    const seededCalls = t1780Calls;
    // Task #1974 — a single refreshMonth now consumes MORE than one
    // Analytics pull: the headline `num_messages_received` metric plus the
    // per-direction inbound/outbound companion pulls all route through the
    // overridden client. Measure that per-refresh pull count from the seed
    // (which created the row from scratch with exactly one refresh's worth of
    // pulls) so the forceRerun assertions below track "one rerun's worth of
    // pulls" instead of the stale hard-coded +1.
    assert.ok(
      seededCalls > 0,
      "seed refreshMonth must consume at least one Analytics pull",
    );
    const pullsPerRefresh = seededCalls;

    // (a) Worker tick on a clean finalized row still short-circuits.
    const workerTick = await refreshMonth({
      month: apr.label,
      monthStart: apr.start,
      monthEnd: apr.end,
      isCurrentMonth: false,
    });
    assert.equal(
      workerTick.outcome,
      "skipped_existing_finalized",
      "worker tick must still short-circuit clean finalized rows",
    );
    assert.equal(
      t1780Calls,
      seededCalls,
      "worker short-circuit must not consume an Analytics pull",
    );

    // (b) Operator forceRerun on the same clean finalized row re-runs
    //     the pull and produces a fresh outcome.
    const operatorClean = await refreshMonth({
      month: apr.label,
      monthStart: apr.start,
      monthEnd: apr.end,
      isCurrentMonth: false,
      forceRerun: true,
    });
    assert.notEqual(
      operatorClean.outcome,
      "skipped_existing_finalized",
      "operator forceRerun must not return skipped_existing_finalized",
    );
    assert.equal(operatorClean.outcome, "ok");
    assert.equal(
      t1780Calls,
      seededCalls + pullsPerRefresh,
      "operator forceRerun must consume one refresh's worth of Analytics pulls",
    );
    assert.ok(operatorClean.pulledAt, "result must expose pulled-at for UI");
    // Task #1783 normalizes the Analytics success status to "ok" on
    // persist + API echo (raw Front values "done" / "partial" both map
    // to "ok" so the UI badge can render them as success).
    assert.equal(operatorClean.frontAnalyticsStatus, "ok");
    assert.equal(operatorClean.frontAnalyticsError, null);

    // (c) Operator forceRerun on a finalized row with a stale error
    //     clears the error on success.
    await db.execute(sql`
      UPDATE front_analytics_monthly_coverage
      SET front_analytics_error = 'stale: something old',
          front_analytics_status = 'error'
      WHERE month = ${apr.label}
    `);
    const staleErrCallsBefore = t1780Calls;
    const operatorStale = await refreshMonth({
      month: apr.label,
      monthStart: apr.start,
      monthEnd: apr.end,
      isCurrentMonth: false,
      forceRerun: true,
    });
    assert.notEqual(operatorStale.outcome, "skipped_existing_finalized");
    assert.equal(operatorStale.outcome, "ok");
    assert.equal(
      t1780Calls,
      staleErrCallsBefore + pullsPerRefresh,
      "stale-error row must re-run the pull",
    );
    const aprRow = await getExistingMonth(apr.label);
    assert.equal(aprRow!.frontAnalyticsError, null, "stale error must clear on success");

    // ─────────────────────────────────────────────────────────────────────
    // 8. Task #1780 — fresh failure attempt MUST update the row's
    //    `pulledAt` timestamp (and write a fresh error) so the
    //    dashboard's "Last refreshed" reflects the latest retry click,
    //    not the last successful pull.
    // ─────────────────────────────────────────────────────────────────────
    const may = utcMonth(FUTURE_YEAR, 4); // YYYY-05

    // Seed a clean finalized Analytics-sourced row first.
    __frontAnalyticsClientTestHelpers.setPullOverride(async () => ({
      reportId: "t1780-seed",
      value: 1234,
      status: "done",
      metric: "num_messages_received",
    } as MonthlyMetricResult));
    const seedMay = await refreshMonth({
      month: may.label,
      monthStart: may.start,
      monthEnd: may.end,
      isCurrentMonth: false,
    });
    assert.equal(seedMay.outcome, "ok");
    const seededMayRow = await getExistingMonth(may.label);
    const seededPulledAt = seededMayRow!.pulledAt!;
    assert.ok(seededPulledAt instanceof Date, "seed: pulledAt persisted");
    // Force >1ms gap so we can prove the timestamp moved.
    await new Promise((r) => setTimeout(r, 25));

    // Override fails — simulate front-side error.
    __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
      throw new FrontAnalyticsError(
        "front_analytics_report_failed",
        "simulated failure for Task #1780 timestamp test",
        500,
      );
    });
    const failedRetry = await refreshMonth({
      month: may.label,
      monthStart: may.start,
      monthEnd: may.end,
      isCurrentMonth: false,
      forceRerun: true,
    });
    assert.equal(failedRetry.outcome, "front_error");
    assert.equal(failedRetry.errorCode, "front_analytics_report_failed");
    assert.ok(failedRetry.pulledAt, "failure response must include fresh pulledAt");
    assert.ok(
      new Date(failedRetry.pulledAt!).getTime() > seededPulledAt.getTime(),
      `failure pulledAt (${failedRetry.pulledAt}) must be newer than seed (${seededPulledAt.toISOString()})`,
    );

    const failedRow = await getExistingMonth(may.label);
    assert.ok(failedRow!.pulledAt, "row pulledAt must be persisted on failure");
    assert.ok(
      failedRow!.pulledAt!.getTime() > seededPulledAt.getTime(),
      "persisted row pulledAt must advance on a failed retry",
    );
    assert.equal(failedRow!.frontAnalyticsStatus, "error");
    assert.ok(
      failedRow!.frontAnalyticsError?.includes("front_analytics_report_failed"),
      "fresh error message must be persisted on failure",
    );

    // ─────────────────────────────────────────────────────────────────────
    // 9. Task #2090 — completeness-driven alerts. A finalized month the
    //    Task #2087 completeness deriver classifies as ingest-gap /
    //    apply-gap / not-measured must proactively alert operators —
    //    but ONLY when the opt-in switch is on, deduped per (month,
    //    status), re-firing on a status change.
    // ─────────────────────────────────────────────────────────────────────
    // Builder that exposes per-month completenessStatus/Reason + finalized
    // flag (the alert path reads these directly via the summary override).
    // appliedCoveragePct is held at/above the floor and the all-time pct is
    // held flat so neither the drop nor the below-floor path fires — the
    // ONLY signal under test is completeness.
    const completenessSummary = (
      monthRows: Array<{
        month: string;
        status: CoverageCompletenessStatus;
        reason?: string | null;
        frontTotal?: number;
        isFinalized?: boolean;
      }>,
    ) => ({
      adoptionDate: "2024-01-15",
      allTime: {
        frontTotalMessages: 1000,
        fetchedIntoNobull: 990,
        appliedIntoNobull: 990,
        ingestGap: 5,
        applyGap: 10,
        fetchedCoveragePct: 99.0,
        appliedCoveragePct: 99.0,
      },
      byMonth: monthRows.map((m) => ({
        month: m.month,
        frontTotalMessages: m.frontTotal ?? 100,
        fetchedIntoNobull: 100,
        appliedIntoNobull: 99,
        ingestGap: 0,
        applyGap: 1,
        fetchedCoveragePct: 100,
        appliedCoveragePct: 99.0, // >= floor (95) → no floor alert
        pulledAt: new Date().toISOString(),
        isFinalizedMonth: m.isFinalized ?? true,
        completenessStatus: m.status,
        completenessReason: m.reason ?? null,
        frontAnalyticsStatus: "ok",
        frontAnalyticsError: null,
      })),
      months: [] as any[],
      thresholds: { monthFloorPct: 95.0, dropDeltaPct: 2.0 },
      lastRefreshedAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
    });

    // 9a — default-OFF guard: with the completeness switch OFF, a
    //      finalized ingest-gap month must NOT fire a completeness alert.
    await rawDeleteSetting(SETTING_PREVIOUS_SNAPSHOT);
    await rawDeleteSetting(SETTING_COMPLETENESS_ALERTS_ENABLED); // default OFF
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([{ month: "2025-06", status: "covered" }]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_baseline_seeded", "9a baseline seed");
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([
          { month: "2025-06", status: "ingest-gap", reason: "front_gt_fetched" },
        ]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `9a: switch OFF must not fire completeness alert, got ${res.decision}`,
    );
    assert.equal(res.completenessAlertMonths.length, 0, "9a no completeness months");
    assert.equal(dispatched.length, 0, "9a no dispatch when switch OFF");

    // 9b — enable the switch; seed a covered baseline so a pre-existing
    //      gap doesn't fire on first run (symmetric with the floor seed).
    await rawDeleteSetting(SETTING_PREVIOUS_SNAPSHOT);
    await storage.setSystemSetting(
      SETTING_COMPLETENESS_ALERTS_ENABLED,
      "true",
      "system",
    );
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([{ month: "2025-06", status: "covered" }]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_baseline_seeded", "9b baseline seed");
    assert.equal(dispatched.length, 0);

    // 9c — finalized ingest-gap month now appears → completeness alert
    //      fires and names the month + plain-English status.
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([
          { month: "2025-06", status: "ingest-gap", reason: "front_gt_fetched" },
        ]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_completeness",
      `9c: expected completeness alert, got ${res.decision}`,
    );
    assert.equal(res.completenessAlertMonths.length, 1);
    assert.equal(res.completenessAlertMonths[0].month, "2025-06");
    assert.equal(res.completenessAlertMonths[0].status, "ingest-gap");
    assert.equal(dispatched.length, 1, "9c one dispatch");
    assert.ok(dispatched[0].text.includes("2025-06"), "9c names month");
    assert.ok(
      dispatched[0].text.toLowerCase().includes("ingest gap"),
      "9c names status in plain English",
    );

    // 9d — same month, same status → deduped (no re-alert).
    dispatched.length = 0;
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `9d: unchanged status must dedupe, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "9d no re-dispatch on unchanged status");

    // 9e — status changes (ingest-gap → apply-gap) → re-alerts.
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([
          { month: "2025-06", status: "apply-gap", reason: "fetched_gt_applied" },
        ]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_completeness",
      `9e: status change must re-fire, got ${res.decision}`,
    );
    assert.equal(res.completenessAlertMonths[0].status, "apply-gap");
    assert.equal(dispatched.length, 1, "9e re-dispatch on status change");

    // 9f — a not-measured finalized month (denominator missing,
    //      frontTotal 0 so it never trips the floor path) also alerts.
    await rawDeleteSetting(SETTING_PREVIOUS_SNAPSHOT);
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([{ month: "2025-07", status: "covered" }]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_baseline_seeded", "9f baseline seed");
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([
          {
            month: "2025-07",
            status: "not-measured",
            reason: "denominator_missing",
            frontTotal: 0,
          },
        ]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "alerted_completeness",
      `9f: not-measured must alert, got ${res.decision}`,
    );
    assert.equal(res.completenessAlertMonths[0].status, "not-measured");

    // 9g — an in-progress (non-finalized) gap month must NOT alert even
    //      with the switch on (still settling).
    await rawDeleteSetting(SETTING_PREVIOUS_SNAPSHOT);
    dispatched.length = 0;
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([{ month: "2025-08", status: "covered" }]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(res.decision, "skipped_baseline_seeded", "9g baseline seed");
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(
      async () =>
        completenessSummary([
          {
            month: "2025-08",
            status: "ingest-gap",
            reason: "front_gt_fetched",
            isFinalized: false, // not finalized → excluded
          },
        ]) as any,
    );
    res = await runFrontAnalyticsCoverageAlertCheck();
    assert.equal(
      res.decision,
      "skipped_no_change",
      `9g: non-finalized gap must not alert, got ${res.decision}`,
    );
    assert.equal(dispatched.length, 0, "9g no dispatch for non-finalized gap");

    // Clean up the Task #2090 switch so other suites see the default.
    await rawDeleteSetting(SETTING_COMPLETENESS_ALERTS_ENABLED);
    await rawDeleteSetting(SETTING_PREVIOUS_SNAPSHOT);

    console.log("front-analytics-coverage.test.ts: OK");
  } finally {
    __frontAnalyticsClientTestHelpers.setPullOverride(null);
    __frontAnalyticsCoverageAlertsTestHelpers.setDispatcherForTests(null);
    __frontAnalyticsCoverageAlertsTestHelpers.setSummaryForTests(null);
    await cleanupTestRows();
  }
});

// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the process
// exits on its own once the test settles — no manual process.exit() (Task #2084).
