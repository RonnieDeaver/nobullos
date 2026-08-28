/* test-registration
{
  "name": "Front auto closure overnight (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #1683 — Front auto-closure overnight aggressive mode tests.
 *
 * Covers:
 *   1. detectMode: daytime vs overnight, midnight wrap-around, empty
 *      window (start == end), disabled toggle, invalid timezone falls
 *      back to America/Chicago without throwing.
 *   2. getHourInTimezone: tz-aware hour extraction with explicit UTC
 *      anchor times.
 *   3. Tick: when `now` falls inside the overnight window the effective
 *      retry / ingest-recovery / apply-nudge budgets come from the
 *      overnight_* settings, the summary records `mode: "overnight"`,
 *      and `effectiveBudgets` matches the overnight overrides.
 *   4. Tick: when `now` falls outside the window the daytime budgets
 *      are used and `mode: "daytime"`.
 *   5. Tick: `overnight_enabled=false` stays in daytime budgets even
 *      during the configured overnight hour.
 *   6. Status: getFrontAutoClosureStatus exposes the live
 *      `currentMode` for the provided `now`.
 *   7. Safety: the master kill switch still short-circuits even during
 *      overnight hours (overnight never bypasses gates).
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { setQueuePause } from "../server/services/queueDrainControl";
import {
  runFrontAutoClosureTick,
  getFrontAutoClosureStatus,
  detectMode,
  getHourInTimezone,
  sanitizeTimezone,
  __setFrontAutoClosureDeadLetterCountOverride,
  SETTING_ENABLED,
  SETTING_RETRY_BUDGET,
  SETTING_INGEST_RECOVERY_BUDGET,
  SETTING_APPLY_NUDGE_BUDGET,
  SETTING_INGEST_GAP_COUNT,
  SETTING_INGEST_GAP_PCT,
  SETTING_APPLY_GAP_COUNT,
  SETTING_APPLY_GAP_PCT,
  SETTING_OVERNIGHT_ENABLED,
  SETTING_OVERNIGHT_TIMEZONE,
  SETTING_OVERNIGHT_START_HOUR,
  SETTING_OVERNIGHT_END_HOUR,
  SETTING_OVERNIGHT_RETRY_BUDGET,
  SETTING_OVERNIGHT_INGEST_RECOVERY_BUDGET,
  SETTING_OVERNIGHT_APPLY_NUDGE_BUDGET,
  SETTING_DEAD_LETTER_GROWTH_THRESHOLD,
  createInMemoryStateStore,
  type FrontAutoClosureConfig,
} from "../server/services/frontAutoClosure";
import { resetFrontAuthBreaker } from "../server/services/frontAuthBreaker";

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

// Task #2199 — orchestrator run-state is now driven through an injected
// in-memory store (reassigned to reset between scenarios), so these blocks
// no longer read, write, or delete the global `front_auto_closure_state`
// setting at all. Config is already supplied in-memory via configOverride
// (Task #2157), so there is no shared system_settings row left to back up.
const KEYS: string[] = [];

// Mutable so a scenario can reset the orchestrator baseline (the old
// `deleteSystemSetting(SETTING_STATE)`) by swapping in a fresh store.
// `runTick` / status calls read this binding at call time.
let stateStore = createInMemoryStateStore();

// Task #2157 — drive ticks with an explicit in-memory config rather than
// mutating the shared `front_auto_closure_*` system_settings rows. Gap
// thresholds are set astronomically high so no real dev coverage row
// qualifies as an ingest/apply candidate, and the overnight window is
// pinned to Chicago 00:00–05:00 with distinguishable budgets so the
// summary makes the active mode unambiguous.
const OVERNIGHT_BASE: Partial<FrontAutoClosureConfig> = {
  enabled: true,
  analyticsRefreshEnabled: true,
  retryBudget: 2,
  ingestRecoveryBudget: 1,
  applyNudgeBudget: 100,
  ingestGapCount: 999_999_999,
  ingestGapPct: 999_999,
  applyGapCount: 999_999_999,
  applyGapPct: 999_999,
  overnightEnabled: true,
  overnightTimezone: "America/Chicago",
  overnightStartHour: 0,
  overnightEndHour: 5,
  overnightRetryBudget: 10,
  overnightIngestRecoveryBudget: 3,
  overnightApplyNudgeBudget: 500,
  deadLetterGrowthThreshold: 100,
};

const runTick = (now: Date, cfg: Partial<FrontAutoClosureConfig> = {}) => {
  // Task #2100 added a process-global Front auth-breaker short-circuit that
  // skips the WHOLE tick (`skippedReason: "front_auth_dead"`, leaving
  // `effectiveBudgets` at its all-zero init). Another Front suite running
  // earlier in the same run can trip that breaker (its real not-connected
  // Front pull) and — via the durable `front_auth_breaker_state` mirror on
  // the shared hermetic DB — leave this suite starting auth-dead, which
  // would zero out the mode/budget/gate assertions here. This suite pins
  // overnight vs daytime budget selection and the safety gates, NOT the
  // auth-breaker deferral, so reset the breaker to a healthy baseline
  // before every scenario tick.
  resetFrontAuthBreaker();
  return runFrontAutoClosureTick({
    now,
    configOverride: { ...OVERNIGHT_BASE, ...cfg },
    stateStore,
  });
};

// ─────────────────────── 1+2. Pure-helper assertions ───────────────────────

// sanitizeTimezone: valid passes through, invalid falls back.
assert.equal(sanitizeTimezone("America/Chicago"), "America/Chicago");
assert.equal(sanitizeTimezone("UTC"), "UTC");
assert.equal(
  sanitizeTimezone("Not/A_Real_Zone"),
  "America/Chicago",
  "invalid timezone must fall back to America/Chicago",
);
assert.equal(
  sanitizeTimezone(""),
  "America/Chicago",
  "empty timezone must fall back to America/Chicago",
);

// getHourInTimezone: pick a date where the UTC vs Chicago hour clearly
// differ. June 15 2026 08:00 UTC is 03:00 in America/Chicago (CDT, UTC-5).
const earlyMorningUtc = new Date(Date.UTC(2026, 5, 15, 8, 0, 0));
assert.equal(getHourInTimezone(earlyMorningUtc, "UTC"), 8);
assert.equal(
  getHourInTimezone(earlyMorningUtc, "America/Chicago"),
  3,
  "UTC 08:00 on 2026-06-15 must be 03:00 in America/Chicago (CDT)",
);
// Invalid tz still returns a sensible hour via the fallback.
assert.equal(
  getHourInTimezone(earlyMorningUtc, "Not/A_Real_Zone"),
  3,
  "invalid tz must fall back to America/Chicago",
);

// detectMode: 08:00 UTC is outside the UTC 0..5 window → daytime.
assert.equal(
  detectMode({
    now: earlyMorningUtc,
    timezone: "UTC",
    startHour: 0,
    endHour: 5,
    overnightEnabled: true,
  }),
  "daytime",
  "UTC 08:00 is outside 0..5 window",
);
// Now with Chicago tz (hour=3), 0..5 covers it.
assert.equal(
  detectMode({
    now: earlyMorningUtc,
    timezone: "America/Chicago",
    startHour: 0,
    endHour: 5,
    overnightEnabled: true,
  }),
  "overnight",
  "Chicago 03:00 falls inside 0..5 → overnight",
);
// End hour is exclusive — hour 5 must be daytime under 0..5.
const fiveAmChicago = new Date(Date.UTC(2026, 5, 15, 10, 0, 0)); // 05:00 CDT
assert.equal(getHourInTimezone(fiveAmChicago, "America/Chicago"), 5);
assert.equal(
  detectMode({
    now: fiveAmChicago,
    timezone: "America/Chicago",
    startHour: 0,
    endHour: 5,
    overnightEnabled: true,
  }),
  "daytime",
  "end hour is exclusive — 05:00 is daytime",
);
// Wrap-around: 22..5. Both 23:00 and 02:00 must be overnight, 12:00 daytime.
const elevenPm = new Date(Date.UTC(2026, 5, 16, 4, 0, 0)); // 23:00 CDT prev day
assert.equal(getHourInTimezone(elevenPm, "America/Chicago"), 23);
assert.equal(
  detectMode({
    now: elevenPm,
    timezone: "America/Chicago",
    startHour: 22,
    endHour: 5,
    overnightEnabled: true,
  }),
  "overnight",
  "23:00 inside wrap-around 22..5 → overnight",
);
const twoAm = new Date(Date.UTC(2026, 5, 15, 7, 0, 0)); // 02:00 CDT
assert.equal(getHourInTimezone(twoAm, "America/Chicago"), 2);
assert.equal(
  detectMode({
    now: twoAm,
    timezone: "America/Chicago",
    startHour: 22,
    endHour: 5,
    overnightEnabled: true,
  }),
  "overnight",
  "02:00 inside wrap-around 22..5 → overnight",
);
const noon = new Date(Date.UTC(2026, 5, 15, 17, 0, 0)); // 12:00 CDT
assert.equal(
  detectMode({
    now: noon,
    timezone: "America/Chicago",
    startHour: 22,
    endHour: 5,
    overnightEnabled: true,
  }),
  "daytime",
  "12:00 outside wrap-around 22..5 → daytime",
);
// Empty window (start == end).
assert.equal(
  detectMode({
    now: earlyMorningUtc,
    timezone: "America/Chicago",
    startHour: 3,
    endHour: 3,
    overnightEnabled: true,
  }),
  "daytime",
  "empty window (start==end) is always daytime",
);
// overnight_enabled=false short-circuits regardless of time.
assert.equal(
  detectMode({
    now: earlyMorningUtc,
    timezone: "America/Chicago",
    startHour: 0,
    endHour: 5,
    overnightEnabled: false,
  }),
  "daytime",
  "overnight_enabled=false forces daytime",
);

// ─────────────────────── 3..7. Tick-level integration ──────────────────────

await withSettingsBackup(KEYS, async () => {
  stateStore = createInMemoryStateStore();

  // 3. Overnight tick: Chicago 02:00 → overnight budgets.
  const nightTick = await runTick(twoAm);
  assert.equal(nightTick.mode, "overnight", "tick at 02:00 CDT must be overnight");
  assert.deepEqual(
    nightTick.effectiveBudgets,
    { retry: 10, ingestRecovery: 3, applyNudge: 500 },
    "overnight tick must use overnight_* budgets",
  );

  // 4. Daytime tick: Chicago 12:00 → daytime budgets.
  const dayTick = await runTick(noon);
  assert.equal(dayTick.mode, "daytime", "tick at 12:00 CDT must be daytime");
  assert.deepEqual(
    dayTick.effectiveBudgets,
    { retry: 2, ingestRecovery: 1, applyNudge: 100 },
    "daytime tick must use daytime budgets",
  );

  // 5. overnight_enabled=false stays daytime even during the window.
  const disabledTick = await runTick(twoAm, { overnightEnabled: false });
  assert.equal(
    disabledTick.mode,
    "daytime",
    "overnight_enabled=false must force daytime mode",
  );
  assert.deepEqual(
    disabledTick.effectiveBudgets,
    { retry: 2, ingestRecovery: 1, applyNudge: 100 },
    "overnight_enabled=false must use daytime budgets",
  );

  // 6. Status surfaces live currentMode for the provided `now`. Drive it
  //    with the same in-memory config so the assertion does not depend on
  //    shared system_settings (Task #2157).
  const overnightStatus = await getFrontAutoClosureStatus({
    now: twoAm,
    configOverride: OVERNIGHT_BASE,
    stateStore,
  });
  assert.equal(overnightStatus.currentMode, "overnight");
  const daytimeStatus = await getFrontAutoClosureStatus({
    now: noon,
    configOverride: OVERNIGHT_BASE,
    stateStore,
  });
  assert.equal(daytimeStatus.currentMode, "daytime");
  // lastSummary.mode reflects the most recent tick (the disabled-tick
  // ran last and recorded daytime).
  assert.equal(
    daytimeStatus.lastSummary?.mode,
    "daytime",
    "lastSummary.mode must reflect the most recent tick",
  );

  // 7. Master kill switch still short-circuits during overnight hours
  //    (overnight never bypasses safety gates).
  const killedTick = await runTick(twoAm, { enabled: false });
  assert.equal(killedTick.enabled, false);
  assert.equal(
    killedTick.skippedReason,
    `${SETTING_ENABLED}=false`,
    "master kill switch must short-circuit even during overnight window",
  );
  // The short-circuit path runs before the mode computation so the
  // summary keeps the default daytime/0-budget initialization — the
  // important contract is that the tick stopped at the gate, not that
  // it computed a mode first.
  assert.equal(killedTick.ingestRecoveriesEnqueued, 0);
  assert.equal(killedTick.applyNudgesEnqueued, 0);
  assert.equal(killedTick.errorsRetried, 0);
});

// ─────────── 8. Overnight cutoffs: queue pause + dead-letter spike ───────────
//
// The previous block proved overnight uses bigger budgets when the path
// is clear. This block proves the safety gates still cut overnight ticks
// off when the pipeline is unhealthy — overnight aggressive mode must
// never bypass coverage-queue pause or dead-letter-growth.
const { QUEUE_NAME: COVERAGE_QUEUE_NAME } = await import(
  "../server/services/frontAnalyticsCoverage"
);
await withSettingsBackup(KEYS, async () => {
  stateStore = createInMemoryStateStore();

  // 8a. Overnight tick + coverage queue paused → short-circuit at the
  //     queue-drain gate. Overnight never bypasses operator pauses.
  await setQueuePause(COVERAGE_QUEUE_NAME, true, "test");
  try {
    const pausedOvernight = await runTick(twoAm);
    assert.equal(
      pausedOvernight.skippedReason,
      "coverage queue paused via queue_drain_state",
      "overnight tick must short-circuit when coverage queue is paused",
    );
    assert.equal(pausedOvernight.errorsRetried, 0);
    assert.equal(pausedOvernight.ingestRecoveriesEnqueued, 0);
    assert.equal(pausedOvernight.applyNudgesEnqueued, 0);
  } finally {
    await setQueuePause(COVERAGE_QUEUE_NAME, false, "test");
  }

  // 8b. Dead-letter spike during overnight → short-circuit with
  //     `front_dead_letter_growth:<delta>>threshold`. Use the
  //     count-override seam so we don't touch real work_result_log.
  stateStore = createInMemoryStateStore();
  let currentCount = 50;
  __setFrontAutoClosureDeadLetterCountOverride(async () => currentCount);
  try {
    // First overnight tick establishes the baseline (50). Must NOT gate
    // — there's no previous sample to compare against.
    const baseline = await runTick(twoAm);
    assert(
      !(baseline.skippedReason ?? "").startsWith("front_dead_letter_growth"),
      `baseline tick must not trip dead-letter gate, got: ${baseline.skippedReason}`,
    );

    // Small growth (50 → 130, delta=80, threshold=100) → must NOT gate.
    currentCount = 130;
    const smallGrowth = await runTick(twoAm);
    assert(
      !(smallGrowth.skippedReason ?? "").startsWith("front_dead_letter_growth"),
      `growth ≤ threshold must not gate, got: ${smallGrowth.skippedReason}`,
    );

    // Large growth (130 → 400, delta=270, threshold=100) → MUST gate
    // even during overnight aggressive mode.
    currentCount = 400;
    const spiked = await runTick(twoAm);
    assert.equal(
      spiked.skippedReason,
      "front_dead_letter_growth:270>100",
      "overnight tick must short-circuit on dead-letter spike",
    );
    assert.equal(spiked.errorsRetried, 0);
    assert.equal(spiked.ingestRecoveriesEnqueued, 0);
    assert.equal(spiked.applyNudgesEnqueued, 0);

    // After the spike the baseline rolls forward to 400; another tick at
    // the same count (delta=0) must clear the gate.
    const stabilized = await runTick(twoAm);
    assert(
      !(stabilized.skippedReason ?? "").startsWith("front_dead_letter_growth"),
      `stabilized count must not stay gated, got: ${stabilized.skippedReason}`,
    );
  } finally {
    __setFrontAutoClosureDeadLetterCountOverride(null);
  }
});

console.log("✓ front-auto-closure overnight tests passed");
// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own — no manual process.exit() needed (Task #2084).
