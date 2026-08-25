/* test-registration
{
  "name": "Front auto-closure regression alerts (Task #1684)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1684 — Front auto-closure regression alerts.
 *
 * Locks in:
 *   1. Kill switch off → skipped_disabled, no dispatch.
 *   2. First observation → baseline seeded, no dispatch.
 *   3. Ingest gap growth across N consecutive ticks fires once and
 *      dedupes on the next tick.
 *   4. Same-gate skip streak fires after N consecutive ticks with the
 *      same `skippedReason` and clears the streak when the reason
 *      changes.
 *   5. Silent loop fires when `lastSummary.ranAt` is older than the
 *      configured silence threshold.
 *   6. Recovery not converging fires after N enqueues (detected via
 *      cooldown transitions) with no ingest-gap shrink.
 *   7. Unrecovered monthly errors fire after N consecutive ticks with
 *      a non-unrecoverable error.
 *   8. Send-failure does NOT arm dedupe — next tick retries the same
 *      condition.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  __frontAutoClosureRegressionAlertsTestHelpers as helpers,
  DEFAULTS,
  NOTIFICATION_ID,
  runFrontAutoClosureRegressionAlertCheck,
} from "../server/services/frontAutoClosureRegressionAlerts";

const FUTURE_YEAR = 2997;
const TEST_MONTH = `${FUTURE_YEAR}-08`;

// Task #2200 — config is driven through the in-memory
// `setConfigOverrideForTests` override instead of shared `system_settings`
// rows, so this suite writes NO config/state/snapshot settings and is
// immune to the always-on `Start application` scheduler that reads/writes
// those same rows. Coverage rows stay in the DB but are isolated under
// FUTURE_YEAR, which the live worker never writes.
type AlerterConfig = {
  enabled: boolean;
  gapGrowthTicks: number;
  silentMinutes: number;
  sameGateSkipTicks: number;
  noConvergenceRuns: number;
  unrecoveredRetryAttempts: number;
  selfErrorTicks: number;
  overnightWindowHours: number;
  overnightEnabled: boolean;
  parkedEnabled: boolean;
  parkedReminderHours: number;
};

function makeConfig(): AlerterConfig {
  return {
    enabled: true,
    // Small thresholds keep the test fast and deterministic.
    gapGrowthTicks: 3,
    silentMinutes: DEFAULTS.silentMinutes,
    sameGateSkipTicks: 3,
    noConvergenceRuns: 3,
    unrecoveredRetryAttempts: 3,
    selfErrorTicks: 3,
    overnightWindowHours: DEFAULTS.overnightWindowHours,
    overnightEnabled: true,
    parkedEnabled: DEFAULTS.parkedEnabled,
    parkedReminderHours: DEFAULTS.parkedReminderHours,
  };
}

let currentCfg = makeConfig();
function applyConfig(patch: Partial<AlerterConfig> = {}): void {
  currentCfg = { ...currentCfg, ...patch };
  helpers.setConfigOverrideForTests(currentCfg);
}

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function makeDispatcher(
  outcome: { delivered: boolean; skipReason?: string } = { delivered: true },
): { fn: any; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const fn = async (id: string, payload: any, options: any) => {
    calls.push({ id, text: payload.text, metadata: options.metadata });
    return {
      delivered: outcome.delivered,
      status: outcome.delivered ? "success" : "skipped",
      skipReason: outcome.skipReason,
    };
  };
  return { fn, calls };
}

async function cleanupRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month LIKE ${`${FUTURE_YEAR}-%`}
  `);
}

async function upsertCoverage(opts: {
  month: string;
  frontTotal: number;
  fetched: number;
  ingestGap: number;
  applyGap: number;
  error?: string | null;
  unrecoverable?: boolean;
}): Promise<void> {
  const [y, m] = opts.month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  await db.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end, front_total_messages, fetched_into_nobull,
       applied_into_nobull, ingest_gap, apply_gap, fetched_coverage_pct,
       applied_coverage_pct, front_analytics_error, unrecoverable,
       front_analytics_status, is_finalized_month, pulled_at)
    VALUES
      (${opts.month}, ${start.toISOString()}, ${end.toISOString()},
       ${opts.frontTotal}, ${opts.fetched}, 0,
       ${opts.ingestGap}, ${opts.applyGap},
       0, 0,
       ${opts.error ?? null}, ${opts.unrecoverable ?? false},
       ${opts.error ? "error" : "ok"}, true, NOW())
    ON CONFLICT (month) DO UPDATE SET
      front_total_messages = EXCLUDED.front_total_messages,
      fetched_into_nobull = EXCLUDED.fetched_into_nobull,
      ingest_gap = EXCLUDED.ingest_gap,
      apply_gap = EXCLUDED.apply_gap,
      front_analytics_error = EXCLUDED.front_analytics_error,
      unrecoverable = EXCLUDED.unrecoverable,
      front_analytics_status = EXCLUDED.front_analytics_status
  `);
}

interface SummaryOpts {
  ranAt: string;
  monthsActed?: string[];
  skippedReason?: string | null;
  cooldowns?: Record<string, string>;
  lastSelfError?: string | null;
  mode?: "daytime" | "overnight";
  ingestRecoveriesEnqueued?: number;
  applyNudgesEnqueued?: number;
  errorRetrySuccesses?: number;
  lastOvernightRanAt?: string | null;
}

// Task #2200 — feed the auto-closure snapshot through the in-memory
// `setSnapshotOverrideForTests` override instead of writing the shared
// auto-closure state row. (Supersedes Task #2083's `buildSnapshotPayload`
// + `setAutoClosureSnapshotOverride` split — same in-memory override hook,
// folded back into one helper now that no scenario writes the DB row.)
function setAutoClosureSnapshot(opts: SummaryOpts): void {
  const lastSummary = {
    ranAt: opts.ranAt,
    enabled: true,
    monthsInspected: 1,
    errorsRetried: 0,
    errorRetrySuccesses: opts.errorRetrySuccesses ?? 0,
    ingestRecoveriesEnqueued: opts.ingestRecoveriesEnqueued ?? 0,
    applyNudgesEnqueued: opts.applyNudgesEnqueued ?? 0,
    recoveryDailyCounter: 0,
    skips: {
      unrecoverable: 0,
      cooldown: 0,
      budget: 0,
      in_flight: 0,
      threshold: 0,
      queue_paused: 0,
      auth_failed: 0,
      no_work_items: 0,
    },
    errorsByReason: {},
    lastSelfError: opts.lastSelfError ?? null,
    monthsActed: opts.monthsActed ?? [],
    skippedReason: opts.skippedReason ?? undefined,
    mode: opts.mode ?? "daytime",
    effectiveBudgets: { retry: 0, ingestRecovery: 0, applyNudge: 0 },
  };
  helpers.setSnapshotOverrideForTests({
    lastSummary: lastSummary as any,
    cooldowns: opts.cooldowns ?? {},
    lastOvernightRanAt:
      opts.lastOvernightRanAt === undefined ? null : opts.lastOvernightRanAt,
    parkedWindows: {},
  } as any);
}

// Task #2200 — reset alerter persisted state via the in-memory override
// (a fresh empty state) instead of deleting the shared state row.
function clearState(): void {
  helpers.setStateOverrideForTests(helpers.emptyStateForTests());
}

// Task #2200 — config/state/snapshot all live in in-memory overrides, so
// there is no shared `system_settings` row left for the live
// `front_analytics_coverage_refresh` worker to race. This supersedes Task
// #2083's queue-pause + settings-backup machinery (which paused both
// `front_analytics_coverage_refresh` and `front_auto_closure_tick` and
// backed up SETTING_KEYS): with no shared rows written or read, the dev
// scheduler's concurrent writes are simply ignored, so the suite passes
// standalone without disabling it.
{
  await cleanupRows();
  applyConfig();
  clearState();

  // Use a fixed `now` baseline well in the future so the coverage rows
  // we manage are isolated from real data.
  const T0 = Date.UTC(FUTURE_YEAR, 7, 15, 12, 0, 0);
  const TICK_MS = 30 * 60_000; // simulated coverage-worker cadence

  // ────────────────────────────────────────────────────────────────────
  // 1. Kill switch off → skipped_disabled, no dispatch.
  // ────────────────────────────────────────────────────────────────────
  {
    applyConfig({ enabled: false });
    const d = makeDispatcher();
    helpers.setDispatcherForTests(d.fn);
    const r = await runFrontAutoClosureRegressionAlertCheck(T0);
    assert.equal(r.decision, "skipped_disabled");
    assert.equal(d.calls.length, 0);
  }

  // Re-enable with the small, deterministic thresholds from makeConfig().
  applyConfig({ enabled: true });

  // ────────────────────────────────────────────────────────────────────
  // 2. First observation seeds baseline, no dispatch.
  // ────────────────────────────────────────────────────────────────────
  {
    await clearState();
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 10_000,
      fetched: 8_000,
      ingestGap: 2_000,
      applyGap: 0,
    });
    await setAutoClosureSnapshot({ ranAt: new Date(T0).toISOString() });
    const d = makeDispatcher();
    helpers.setDispatcherForTests(d.fn);
    const r = await runFrontAutoClosureRegressionAlertCheck(T0 + 1_000);
    assert.equal(r.decision, "skipped_baseline_seeded");
    assert.equal(d.calls.length, 0);
  }

  // ────────────────────────────────────────────────────────────────────
  // 3. Ingest gap growth across 3 ticks → fires once; second tick at
  //    the same gap is deduped.
  // ────────────────────────────────────────────────────────────────────
  {
    // Tick 2: gap grew.
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 10_000,
      fetched: 7_000,
      ingestGap: 3_000,
      applyGap: 0,
    });
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + TICK_MS).toISOString(),
    });
    const d2 = makeDispatcher();
    helpers.setDispatcherForTests(d2.fn);
    const r2 = await runFrontAutoClosureRegressionAlertCheck(T0 + TICK_MS + 1);
    assert.equal(r2.fired.length, 0, "no fire on second tick yet");
    assert.equal(d2.calls.length, 0);

    // Tick 3: gap grew again — now 3 monotonically growing entries.
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 10_000,
      fetched: 6_000,
      ingestGap: 4_000,
      applyGap: 0,
    });
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 2 * TICK_MS).toISOString(),
    });
    const d3 = makeDispatcher();
    helpers.setDispatcherForTests(d3.fn);
    const r3 = await runFrontAutoClosureRegressionAlertCheck(
      T0 + 2 * TICK_MS + 1,
    );
    assert.equal(r3.decision, "alerted");
    const ingestFire = r3.fired.find((f) => f.condition === "ingest_growth");
    assert.ok(ingestFire, "ingest_growth fired");
    assert.equal(ingestFire?.month, TEST_MONTH);
    // Task #3785 — the check scans ALL months, so real shared-dev-DB rows
    // (e.g. genuinely stuck historical months) can fire their own alerts in
    // the same tick. Scope the dispatcher assertions to the fixture month.
    const d3TestCalls = d3.calls.filter((c) => c.metadata?.month === TEST_MONTH);
    assert.equal(d3TestCalls.length, 1);
    assert.equal(d3TestCalls[0].id, NOTIFICATION_ID);
    assert.match(d3TestCalls[0].text, /ingest_growth/);

    // Tick 4: gap still grew, but cooldown should suppress.
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 10_000,
      fetched: 5_000,
      ingestGap: 5_000,
      applyGap: 0,
    });
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 3 * TICK_MS).toISOString(),
    });
    const d4 = makeDispatcher();
    helpers.setDispatcherForTests(d4.fn);
    const r4 = await runFrontAutoClosureRegressionAlertCheck(
      T0 + 3 * TICK_MS + 1,
    );
    // Scope dedupe assertion to TEST_MONTH: real coverage rows in the dev
    // DB (left over by other suite tests) can legitimately surface alerts
    // for unrelated months on tick 4. The contract we're locking in here
    // is that ingest_growth for TEST_MONTH must be suppressed by the 6h
    // per-month dedupe — not that the whole dispatcher is silent.
    const testMonthIngestFires = r4.fired.filter(
      (f) => f.month === TEST_MONTH && f.condition === "ingest_growth",
    );
    assert.equal(
      testMonthIngestFires.length,
      0,
      "duplicate ingest_growth for TEST_MONTH suppressed by 6h dedupe",
    );
    const testMonthCalls = d4.calls.filter(
      (c) => (c.metadata as Record<string, unknown> | undefined)?.month === TEST_MONTH,
    );
    assert.equal(
      testMonthCalls.length,
      0,
      "no TEST_MONTH dispatches when only ingest_growth would have fired",
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // 4. Same-gate skip streak: 3 consecutive ticks with the same
  //    skippedReason → fire same_gate_skip. Changing the reason resets
  //    the streak.
  // ────────────────────────────────────────────────────────────────────
  {
    await clearState();
    await cleanupRows();
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 100,
      fetched: 100,
      ingestGap: 0,
      applyGap: 0,
    });
    const d = makeDispatcher();
    helpers.setDispatcherForTests(d.fn);

    // Baseline tick.
    await setAutoClosureSnapshot({
      ranAt: new Date(T0).toISOString(),
      skippedReason: "queue paused",
    });
    await runFrontAutoClosureRegressionAlertCheck(T0 + 1);

    // Two more identical skips (streak=3).
    for (let i = 1; i <= 2; i++) {
      await setAutoClosureSnapshot({
        ranAt: new Date(T0 + i * TICK_MS).toISOString(),
        skippedReason: "queue paused",
      });
      await runFrontAutoClosureRegressionAlertCheck(T0 + i * TICK_MS + 1);
    }
    const fired = d.calls.find((c) => c.text.includes("same_gate_skip"));
    assert.ok(fired, "same_gate_skip should fire on the 3rd identical skip");
    assert.equal(
      (fired!.metadata as any)?.condition,
      "same_gate_skip",
    );

    // Reason change resets the streak; no new fire next tick.
    const before = d.calls.length;
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 3 * TICK_MS).toISOString(),
      skippedReason: "api_pool_under_pressure",
    });
    await runFrontAutoClosureRegressionAlertCheck(T0 + 3 * TICK_MS + 1);
    assert.equal(
      d.calls.length,
      before,
      "streak should reset on skip reason change",
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // 5. Silent loop: lastSummary.ranAt older than silentMinutes fires.
  // ────────────────────────────────────────────────────────────────────
  {
    await clearState();
    await cleanupRows();
    // Seed baseline at T0.
    await setAutoClosureSnapshot({ ranAt: new Date(T0).toISOString() });
    const dSeed = makeDispatcher();
    helpers.setDispatcherForTests(dSeed.fn);
    await runFrontAutoClosureRegressionAlertCheck(T0 + 1);
    assert.equal(dSeed.calls.length, 0, "baseline does not fire");

    // Re-evaluate far in the future — lastSummary is now silentMinutes+ old.
    const d = makeDispatcher();
    helpers.setDispatcherForTests(d.fn);
    const silentAt = T0 + (DEFAULTS.silentMinutes + 5) * 60_000;
    const r = await runFrontAutoClosureRegressionAlertCheck(silentAt);
    const silentFire = r.fired.find((f) => f.condition === "silent");
    assert.ok(silentFire, "silent loop fires");
    assert.equal(d.calls.length, 1);
    assert.match(d.calls[0].text, /silent/);
  }

  // ────────────────────────────────────────────────────────────────────
  // 6. Recovery not converging — 3 cooldown transitions (= enqueues)
  //    with non-shrinking ingest gap fires no_convergence.
  // ────────────────────────────────────────────────────────────────────
  {
    await clearState();
    await cleanupRows();
    const d = makeDispatcher();
    helpers.setDispatcherForTests(d.fn);

    // Baseline + 3 ticks each with a fresh cooldown timestamp and a
    // non-shrinking ingest gap. monthsActed only carries the enqueue
    // signal indirectly — the alerter detects enqueues via the
    // cooldown timestamp transition.
    const seed = async (i: number, gap: number) => {
      await upsertCoverage({
        month: TEST_MONTH,
        frontTotal: 10_000,
        fetched: 10_000 - gap,
        ingestGap: gap,
        applyGap: 0,
      });
      await setAutoClosureSnapshot({
        ranAt: new Date(T0 + i * TICK_MS).toISOString(),
        cooldowns: {
          [TEST_MONTH]: new Date(T0 + i * TICK_MS + 60_000).toISOString(),
        },
      });
      await runFrontAutoClosureRegressionAlertCheck(T0 + i * TICK_MS + 1);
    };
    await seed(0, 4_000); // baseline (no fire — first observation)
    await seed(1, 4_000); // enqueue #1
    await seed(2, 4_100); // enqueue #2 (slight growth — still no shrink)
    await seed(3, 4_100); // enqueue #3 — convergence threshold reached

    const fired = d.calls.find((c) => c.text.includes("no_convergence"));
    assert.ok(fired, "no_convergence fires after 3 non-converging enqueues");
  }

  // ────────────────────────────────────────────────────────────────────
  // 7. Unrecovered monthly errors — 3 ticks with a non-unrecoverable
  //    error fire unrecovered_errors.
  // ────────────────────────────────────────────────────────────────────
  {
    await clearState();
    await cleanupRows();
    const d = makeDispatcher();
    helpers.setDispatcherForTests(d.fn);
    for (let i = 0; i < 3; i++) {
      await upsertCoverage({
        month: TEST_MONTH,
        frontTotal: 100,
        fetched: 0,
        ingestGap: 0,
        applyGap: 0,
        error: "front_analytics_report_failed: persistent",
        unrecoverable: false,
      });
      await setAutoClosureSnapshot({
        ranAt: new Date(T0 + i * TICK_MS).toISOString(),
      });
      await runFrontAutoClosureRegressionAlertCheck(T0 + i * TICK_MS + 1);
    }
    const fired = d.calls.find((c) => c.text.includes("unrecovered_errors"));
    assert.ok(fired, "unrecovered_errors fires after 3 consecutive error ticks");
  }

  // ────────────────────────────────────────────────────────────────────
  // 8. Send-failure does NOT arm dedupe — next tick retries.
  // ────────────────────────────────────────────────────────────────────
  {
    await clearState();
    await cleanupRows();
    // Seed baseline.
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 10_000,
      fetched: 8_000,
      ingestGap: 2_000,
      applyGap: 0,
    });
    await setAutoClosureSnapshot({ ranAt: new Date(T0).toISOString() });
    helpers.setDispatcherForTests(makeDispatcher().fn);
    await runFrontAutoClosureRegressionAlertCheck(T0 + 1);

    // Two more growth ticks to satisfy gap_growth_ticks=3.
    for (let i = 1; i <= 2; i++) {
      await upsertCoverage({
        month: TEST_MONTH,
        frontTotal: 10_000,
        fetched: 8_000 - i * 500,
        ingestGap: 2_000 + i * 500,
        applyGap: 0,
      });
      await setAutoClosureSnapshot({
        ranAt: new Date(T0 + i * TICK_MS).toISOString(),
      });
      if (i === 1) {
        await runFrontAutoClosureRegressionAlertCheck(T0 + i * TICK_MS + 1);
      }
    }
    // The 3rd tick is where the condition trips. First dispatcher
    // returns delivered: false → dedupe should NOT arm.
    const dFail = makeDispatcher({ delivered: false, skipReason: "slack_500" });
    helpers.setDispatcherForTests(dFail.fn);
    const rFail = await runFrontAutoClosureRegressionAlertCheck(
      T0 + 2 * TICK_MS + 1,
    );
    assert.equal(rFail.decision, "skipped_send_failed");
    assert.ok(rFail.fired.length >= 1);
    assert.equal(dFail.calls.length, rFail.fired.length);

    // Next tick (gap still growing) — dispatcher works; alert MUST
    // re-fire because dedupe was rolled back.
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 10_000,
      fetched: 6_500,
      ingestGap: 3_500,
      applyGap: 0,
    });
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 3 * TICK_MS).toISOString(),
    });
    const dOk = makeDispatcher({ delivered: true });
    helpers.setDispatcherForTests(dOk.fn);
    const rOk = await runFrontAutoClosureRegressionAlertCheck(
      T0 + 3 * TICK_MS + 1,
    );
    assert.equal(rOk.decision, "alerted");
    assert.ok(
      dOk.calls.some((c) => c.text.includes("ingest_growth")),
      "ingest_growth re-fires after a failed send",
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Task #1696 — self_error_persistent: N consecutive ticks with a
  // non-null `lastSelfError` fire the self-healer-misbehaving alert.
  // A clean tick clears both the streak and the dedupe stamp.
  // ────────────────────────────────────────────────────────────────────
  {
    // self_error_persistent: three CONSECUTIVE ticks each with a non-null
    // `lastSelfError` fire the alert; a clean tick clears both the streak
    // and the dedupe stamp. The snapshot + alert state both run through the
    // in-memory overrides (see setAutoClosureSnapshot / clearState), so this
    // streak-sensitive scenario is immune to concurrent dev-DB writers.
    await clearState();
    await cleanupRows();
    applyConfig({ selfErrorTicks: 3 });
    const d = makeDispatcher();
    helpers.setDispatcherForTests(d.fn);

    // Baseline tick at T0 — first observation; no fire.
    await setAutoClosureSnapshot({
      ranAt: new Date(T0).toISOString(),
      lastSelfError: "load_state: kaboom",
    });
    await runFrontAutoClosureRegressionAlertCheck(T0 + 1);
    assert.equal(d.calls.length, 0, "baseline does not fire");

    // Two more ticks each with a self error — streak hits 3 on the 3rd.
    for (let i = 1; i <= 2; i++) {
      await setAutoClosureSnapshot({
        ranAt: new Date(T0 + i * TICK_MS).toISOString(),
        lastSelfError: `tick: kaboom #${i}`,
      });
      await runFrontAutoClosureRegressionAlertCheck(T0 + i * TICK_MS + 1);
    }
    const fired = d.calls.find((c) =>
      c.text.includes("self_error_persistent"),
    );
    assert.ok(
      fired,
      "self_error_persistent fires after 3 consecutive ticks with lastSelfError",
    );
    assert.equal(
      (fired!.metadata as any)?.condition,
      "self_error_persistent",
    );

    // A clean tick clears the streak and dedupe stamp; subsequent error
    // ticks must start a fresh streak.
    const before = d.calls.length;
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 3 * TICK_MS).toISOString(),
      lastSelfError: null,
    });
    await runFrontAutoClosureRegressionAlertCheck(T0 + 3 * TICK_MS + 1);
    assert.equal(d.calls.length, before, "clean tick does not re-fire");

    // Two more error ticks alone are not enough — streak only at 2.
    for (let i = 4; i <= 5; i++) {
      await setAutoClosureSnapshot({
        ranAt: new Date(T0 + i * TICK_MS).toISOString(),
        lastSelfError: `tick: again #${i}`,
      });
      await runFrontAutoClosureRegressionAlertCheck(T0 + i * TICK_MS + 1);
    }
    assert.equal(
      d.calls.length,
      before,
      "streak resets — 2 error ticks alone do not re-fire",
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Task #1696 — overnight_window_idle: an overnight window ends with
  // zero progress while coverage gaps remain → fire on the
  // overnight→daytime transition. Same window with progress does NOT
  // fire.
  // ────────────────────────────────────────────────────────────────────
  {
    await clearState();
    await cleanupRows();
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 10_000,
      fetched: 8_000,
      ingestGap: 2_000,
      applyGap: 0,
    });
    const d = makeDispatcher();
    helpers.setDispatcherForTests(d.fn);

    // Baseline daytime tick.
    await setAutoClosureSnapshot({
      ranAt: new Date(T0).toISOString(),
      mode: "daytime",
    });
    await runFrontAutoClosureRegressionAlertCheck(T0 + 1);

    // Two overnight ticks with zero progress (gaps remain).
    for (let i = 1; i <= 2; i++) {
      await setAutoClosureSnapshot({
        ranAt: new Date(T0 + i * TICK_MS).toISOString(),
        mode: "overnight",
        ingestRecoveriesEnqueued: 0,
        applyNudgesEnqueued: 0,
        errorRetrySuccesses: 0,
      });
      await runFrontAutoClosureRegressionAlertCheck(T0 + i * TICK_MS + 1);
    }
    assert.equal(
      d.calls.filter((c) => c.text.includes("overnight_window_idle")).length,
      0,
      "no fire mid-window",
    );

    // Daytime transition — should fire.
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 3 * TICK_MS).toISOString(),
      mode: "daytime",
    });
    const r = await runFrontAutoClosureRegressionAlertCheck(
      T0 + 3 * TICK_MS + 1,
    );
    const idleFire = r.fired.find((f) => f.condition === "overnight_window_idle");
    assert.ok(idleFire, "overnight_window_idle fires on overnight→daytime");
    assert.equal(idleFire?.month, null);
    assert.ok(
      d.calls.some((c) => c.text.includes("overnight_window_idle")),
      "dispatcher received the idle alert",
    );

    // A subsequent overnight window with progress must NOT fire.
    await clearState();
    await cleanupRows();
    await upsertCoverage({
      month: TEST_MONTH,
      frontTotal: 10_000,
      fetched: 8_000,
      ingestGap: 2_000,
      applyGap: 0,
    });
    const d2 = makeDispatcher();
    helpers.setDispatcherForTests(d2.fn);
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 4 * TICK_MS).toISOString(),
      mode: "daytime",
    });
    await runFrontAutoClosureRegressionAlertCheck(T0 + 4 * TICK_MS + 1);
    for (let i = 5; i <= 6; i++) {
      await setAutoClosureSnapshot({
        ranAt: new Date(T0 + i * TICK_MS).toISOString(),
        mode: "overnight",
        applyNudgesEnqueued: i === 5 ? 3 : 0, // some progress
      });
      await runFrontAutoClosureRegressionAlertCheck(T0 + i * TICK_MS + 1);
    }
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 7 * TICK_MS).toISOString(),
      mode: "daytime",
    });
    await runFrontAutoClosureRegressionAlertCheck(T0 + 7 * TICK_MS + 1);
    assert.equal(
      d2.calls.filter((c) => c.text.includes("overnight_window_idle")).length,
      0,
      "no fire when overnight window made progress",
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // 9. Task #1694 — overnight aggressive window missed.
  //    - Overnight enabled + lastOvernightRanAt older than the window
  //      → fire overnight_missed.
  //    - Dedupes within the cooldown window.
  //    - Disabling overnight clears the dedupe stamp and silences the
  //      condition even when the timestamp would otherwise trip it.
  //    - Recording a fresh overnight tick (lastOvernightRanAt updated)
  //      clears the dedupe so a future stall can re-fire.
  // ────────────────────────────────────────────────────────────────────
  {
    await clearState();
    await cleanupRows();

    applyConfig({ overnightEnabled: true, overnightWindowHours: 24 });

    // Seed: baseline observation with a stale lastOvernightRanAt
    // (48h before T0 — well past the 24h window).
    const overnightStaleIso = new Date(
      T0 - 48 * 60 * 60_000,
    ).toISOString();
    await setAutoClosureSnapshot({
      ranAt: new Date(T0).toISOString(),
      mode: "daytime",
      lastOvernightRanAt: overnightStaleIso,
    });
    const dSeed = makeDispatcher();
    helpers.setDispatcherForTests(dSeed.fn);
    const rSeed = await runFrontAutoClosureRegressionAlertCheck(T0 + 1);
    assert.equal(
      rSeed.decision,
      "skipped_baseline_seeded",
      "first observation does not fire overnight_missed",
    );

    // Next tick — baseline established, condition trips.
    const dFire = makeDispatcher();
    helpers.setDispatcherForTests(dFire.fn);
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + TICK_MS).toISOString(),
      mode: "daytime",
      lastOvernightRanAt: overnightStaleIso,
    });
    const rFire = await runFrontAutoClosureRegressionAlertCheck(
      T0 + TICK_MS + 1,
    );
    const overnightFire = rFire.fired.find(
      (f) => f.condition === "overnight_missed",
    );
    assert.ok(overnightFire, "overnight_missed fires when window exceeded");
    assert.equal(overnightFire?.month, null);
    assert.equal(rFire.decision, "alerted");
    assert.ok(
      dFire.calls.some((c) => c.text.includes("overnight_missed")),
      "dispatched payload mentions overnight_missed",
    );

    // Dedupe — condition still true on the next tick, no re-fire.
    const dDup = makeDispatcher();
    helpers.setDispatcherForTests(dDup.fn);
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 2 * TICK_MS).toISOString(),
      mode: "daytime",
      lastOvernightRanAt: overnightStaleIso,
    });
    const rDup = await runFrontAutoClosureRegressionAlertCheck(
      T0 + 2 * TICK_MS + 1,
    );
    assert.equal(
      dDup.calls.filter((c) => c.text.includes("overnight_missed")).length,
      0,
      "overnight_missed is deduped within the cooldown window",
    );
    // Task #3785 — ambient shared-dev-DB months can legitimately alert in
    // the same tick, flipping the overall decision; assert only that OUR
    // condition did not re-fire.
    assert.equal(
      rDup.fired.filter((f: any) => f.condition === "overnight_missed").length,
      0,
      "overnight_missed did not re-fire within cooldown",
    );

    // Disable overnight mode — condition silences even though the
    // timestamp would still trip it.
    applyConfig({ overnightEnabled: false });
    const dDisabled = makeDispatcher();
    helpers.setDispatcherForTests(dDisabled.fn);
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 3 * TICK_MS).toISOString(),
      mode: "daytime",
      lastOvernightRanAt: overnightStaleIso,
    });
    const rDisabled = await runFrontAutoClosureRegressionAlertCheck(
      T0 + 3 * TICK_MS + 1,
    );
    assert.equal(
      dDisabled.calls.filter((c) => c.text.includes("overnight_missed"))
        .length,
      0,
      "disabling overnight mode silences overnight_missed",
    );
    assert.equal(rDisabled.fired.length, 0);

    // Re-enable overnight + fresh overnight tick stamped within the
    // window — the dedupe stamp from the earlier fire should already
    // be cleared (by the disable path), and a fresh stamp means the
    // condition is healthy now.
    applyConfig({ overnightEnabled: true });
    const freshOvernightIso = new Date(T0 + 4 * TICK_MS).toISOString();
    await setAutoClosureSnapshot({
      ranAt: new Date(T0 + 4 * TICK_MS).toISOString(),
      mode: "overnight",
      lastOvernightRanAt: freshOvernightIso,
    });
    const dHealthy = makeDispatcher();
    helpers.setDispatcherForTests(dHealthy.fn);
    const rHealthy = await runFrontAutoClosureRegressionAlertCheck(
      T0 + 4 * TICK_MS + 1,
    );
    assert.equal(
      dHealthy.calls.filter((c) => c.text.includes("overnight_missed"))
        .length,
      0,
      "fresh overnight tick suppresses overnight_missed",
    );
    assert.equal(rHealthy.fired.length, 0);
  }

  helpers.setDispatcherForTests(null);
  await cleanupRows();
  // Task #2200 — restore production behavior: drop all in-memory overrides
  // so the module reads config/state/snapshot from `system_settings` again.
  helpers.setConfigOverrideForTests(null);
  helpers.setStateOverrideForTests(null);
  helpers.setSnapshotOverrideForTests(null);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
console.log("✓ front-auto-closure-regression-alerts tests passed");
