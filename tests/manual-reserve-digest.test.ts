/* test-registration
{
  "name": "Manual reserve digest (Task #1182)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 300000,
  "tier": "small"
}
test-registration */
/**
 * Task #1182 — regression coverage for the reserve-pressure digest
 * (server/services/manualReserveDigest.ts).
 *
 * Pinned behavior:
 *  1. `planManualReserveDigest` returns `shouldSend: false` with the
 *     correct `reason` when the digest is disabled, snoozed, off-hour,
 *     off-weekday (weekly), or already-sent for the current period.
 *  2. `planManualReserveDigest` returns `shouldSend: true` and a
 *     formatted message when the schedule + idempotency gate align.
 *  3. `buildDigestSummary` aggregates `health_samples.alerts` rows into
 *     warning/critical counts and a peak value per manual-reserve metric,
 *     filters out non-manual-reserve alerts, sorts perMetric by critical
 *     desc / warning desc / metric asc, and emits backed_up/all_clear
 *     transitions oldest-first from the dispatch table.
 *  4. The daily idempotency key (`utcDateKey`) flips at the UTC midnight
 *     boundary; the weekly key (`utcIsoWeekKey`) respects ISO 8601 week
 *     boundaries (Sunday 2023-01-01 = 2022-W52, Monday 2023-01-02 = 2023-W01).
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  insertHealthSamples,
  insertManualReserveAlertDispatches,
} from "../server/storage/healthMetricsStorage";
import {
  planManualReserveDigest,
  buildDigestSummary,
  SETTING_ENABLED,
  SETTING_CADENCE,
  SETTING_HOUR,
  SETTING_WEEKDAY,
  SETTING_WINDOW_HOURS,
  SETTING_LAST_SENT,
  SETTING_SNOOZED,
  __testHelpers,
} from "../server/services/manualReserveDigest";

const SETTING_KEYS = [
  SETTING_ENABLED,
  SETTING_CADENCE,
  SETTING_HOUR,
  SETTING_WEEKDAY,
  SETTING_WINDOW_HOURS,
  SETTING_LAST_SENT,
  SETTING_SNOOZED,
];

async function clearAllDigestSettings(): Promise<void> {
  for (const k of SETTING_KEYS) {
    try {
      await deleteSystemSetting(k);
    } catch {
      /* ignore */
    }
  }
}

// Synthetic "now" in late-2023 so we can insert samples in a window that
// is otherwise guaranteed to be empty (avoids cross-talk with whatever
// real health samples happen to live in the test DB).
const SYNTH_NOW = Date.UTC(2023, 10, 15, 15, 0, 0); // Wed 2023-11-15 15:00 UTC
const WINDOW_HOURS = 24;
const WINDOW_START = SYNTH_NOW - WINDOW_HOURS * 3_600_000;

async function clearSyntheticWindow(): Promise<void> {
  await db.execute(
    sql`DELETE FROM health_samples WHERE timestamp >= ${WINDOW_START} AND timestamp <= ${SYNTH_NOW}`,
  );
  await db.execute(
    sql`DELETE FROM manual_reserve_alert_dispatches WHERE timestamp >= ${WINDOW_START} AND timestamp <= ${SYNTH_NOW}`,
  );
}

// ─── Period-key helpers (pure, no DB) ───────────────────────────────────
async function casePeriodKeyBoundaries(): Promise<void> {
  // Daily key flips at UTC midnight.
  const beforeMidnight = Date.UTC(2024, 5, 14, 23, 59, 59); // 2024-06-14 23:59:59 UTC
  const afterMidnight = Date.UTC(2024, 5, 15, 0, 0, 0); // 2024-06-15 00:00:00 UTC
  assert.equal(__testHelpers.utcDateKey(beforeMidnight), "2024-06-14");
  assert.equal(__testHelpers.utcDateKey(afterMidnight), "2024-06-15");
  assert.equal(
    __testHelpers.periodKey("daily", beforeMidnight),
    "2024-06-14",
  );
  assert.equal(__testHelpers.periodKey("daily", afterMidnight), "2024-06-15");

  // Weekly ISO-week key respects ISO 8601: Sunday 2023-01-01 falls in the
  // last ISO week of 2022 (W52); Monday 2023-01-02 starts 2023-W01.
  const sunJan1 = Date.UTC(2023, 0, 1, 12, 0, 0);
  const monJan2 = Date.UTC(2023, 0, 2, 12, 0, 0);
  assert.equal(__testHelpers.utcIsoWeekKey(sunJan1), "2022-W52");
  assert.equal(__testHelpers.utcIsoWeekKey(monJan2), "2023-W01");
  assert.equal(__testHelpers.periodKey("weekly", sunJan1), "2022-W52");
  assert.equal(__testHelpers.periodKey("weekly", monJan2), "2023-W01");

  // Within a single ISO week, the weekly key is stable across days.
  const tueJan3 = Date.UTC(2023, 0, 3, 0, 0, 0);
  const sunJan8 = Date.UTC(2023, 0, 8, 23, 59, 0);
  assert.equal(__testHelpers.utcIsoWeekKey(tueJan3), "2023-W01");
  assert.equal(__testHelpers.utcIsoWeekKey(sunJan8), "2023-W01");

  console.log("[manual-reserve-digest] period-key boundaries: OK");
}

// ─── planManualReserveDigest gating ─────────────────────────────────────
async function casePlanGating(): Promise<void> {
  await clearAllDigestSettings();

  // 1. Default = disabled.
  const disabled = await planManualReserveDigest(SYNTH_NOW);
  assert.equal(disabled.shouldSend, false);
  assert.match(disabled.reason, /disabled/i);

  // Enable for the rest of the gating cases.
  await setSystemSetting(SETTING_ENABLED, "true", "system");
  await setSystemSetting(SETTING_CADENCE, "daily", "system");
  await setSystemSetting(SETTING_HOUR, "15", "system");
  await setSystemSetting(SETTING_WINDOW_HOURS, String(WINDOW_HOURS), "system");

  // 2. Snoozed window in the future suppresses.
  await setSystemSetting(
    SETTING_SNOOZED,
    String(SYNTH_NOW + 3_600_000),
    "system",
  );
  const snoozed = await planManualReserveDigest(SYNTH_NOW);
  assert.equal(snoozed.shouldSend, false);
  assert.match(snoozed.reason, /snoozed/i);
  await deleteSystemSetting(SETTING_SNOOZED);

  // 3. Wrong hour: now=15:00 UTC but target=14.
  await setSystemSetting(SETTING_HOUR, "14", "system");
  const wrongHour = await planManualReserveDigest(SYNTH_NOW);
  assert.equal(wrongHour.shouldSend, false);
  assert.match(wrongHour.reason, /not at digest hour/i);

  // Reset target hour back to 15 (matches SYNTH_NOW).
  await setSystemSetting(SETTING_HOUR, "15", "system");

  // 4. Weekly cadence + wrong weekday. SYNTH_NOW is Wed (UTC day 3);
  //    target weekday=1 (Mon) should be rejected.
  await setSystemSetting(SETTING_CADENCE, "weekly", "system");
  await setSystemSetting(SETTING_WEEKDAY, "1", "system");
  const wrongDay = await planManualReserveDigest(SYNTH_NOW);
  assert.equal(wrongDay.shouldSend, false);
  assert.match(wrongDay.reason, /not at digest weekday/i);

  // 4b. Weekly cadence + correct weekday (3 = Wed for SYNTH_NOW) and the
  //     idempotency key already matches the current ISO week → suppressed.
  await setSystemSetting(SETTING_WEEKDAY, "3", "system");
  const weeklyKey = __testHelpers.periodKey("weekly", SYNTH_NOW);
  await setSystemSetting(SETTING_LAST_SENT, weeklyKey, "system");
  const weeklyAlreadySent = await planManualReserveDigest(SYNTH_NOW);
  assert.equal(weeklyAlreadySent.shouldSend, false);
  assert.match(weeklyAlreadySent.reason, /already sent for/i);
  assert.ok(weeklyAlreadySent.reason.includes(weeklyKey));
  await deleteSystemSetting(SETTING_LAST_SENT);

  // 5. Daily cadence + already-sent for today's date key → suppressed.
  await setSystemSetting(SETTING_CADENCE, "daily", "system");
  const dailyKey = __testHelpers.periodKey("daily", SYNTH_NOW);
  await setSystemSetting(SETTING_LAST_SENT, dailyKey, "system");
  const dailyAlreadySent = await planManualReserveDigest(SYNTH_NOW);
  assert.equal(dailyAlreadySent.shouldSend, false);
  assert.match(dailyAlreadySent.reason, /already sent for/i);
  assert.ok(dailyAlreadySent.reason.includes(dailyKey));
  await deleteSystemSetting(SETTING_LAST_SENT);

  // 6. All gates aligned + no prior send → shouldSend=true with a
  //    formatted message and a non-null summary.
  await clearSyntheticWindow();
  const ready = await planManualReserveDigest(SYNTH_NOW);
  assert.equal(ready.shouldSend, true, `expected pending, got ${ready.reason}`);
  assert.ok(ready.message && ready.message.length > 0);
  assert.ok(ready.summary);
  assert.equal(ready.summary!.windowHours, WINDOW_HOURS);
  assert.equal(ready.summary!.windowEnd, SYNTH_NOW);
  assert.equal(ready.summary!.totalAlerts, 0);

  await clearAllDigestSettings();
  console.log("[manual-reserve-digest] plan gating: OK");
}

// ─── buildDigestSummary aggregation ─────────────────────────────────────
async function caseBuildSummaryAggregation(): Promise<void> {
  await clearSyntheticWindow();

  const t1 = WINDOW_START + 3_600_000; // +1h
  const t2 = WINDOW_START + 7_200_000; // +2h
  const t3 = WINDOW_START + 10_800_000; // +3h
  const t4 = WINDOW_START + 14_400_000; // +4h (highest peak for wait p95)

  // Sample 1: warning on manual_wait_p95_ms + a non-manual-reserve alert
  // (must be ignored by the aggregator).
  await insertHealthSamples([
    {
      timestamp: t1,
      status: "ok",
      dbConnected: true,
      alerts: [
        {
          metric: "manual_wait_p95_ms",
          severity: "warning",
          value: 800,
          threshold: 500,
          message: "p95 warn",
        },
        {
          metric: "db_round_trip_ms", // not a manual-reserve metric
          severity: "critical",
          value: 999,
          threshold: 100,
          message: "db slow",
        },
      ] as any,
    },
    // Sample 2: critical on manual_wait_p95_ms (peak) + warning on
    // manual_timeout_window. Same sample = breachSamples increments once.
    {
      timestamp: t2,
      status: "degraded",
      dbConnected: true,
      alerts: [
        {
          metric: "manual_wait_p95_ms",
          severity: "critical",
          value: 1500,
          threshold: 1000,
          message: "p95 crit",
        },
        {
          metric: "manual_timeout_window",
          severity: "warning",
          value: 4,
          threshold: 3,
          message: "timeouts",
        },
      ] as any,
    },
    // Sample 3: entrypoint-prefixed metric (matches via prefix list).
    {
      timestamp: t3,
      status: "degraded",
      dbConnected: true,
      alerts: [
        {
          metric: "manual_entrypoint_timeout_window:foo",
          severity: "critical",
          value: 7,
          threshold: 3,
          message: "ep timeout crit",
        },
      ] as any,
    },
    // Sample 4: another critical on manual_wait_p95_ms with a NEW peak.
    {
      timestamp: t4,
      status: "degraded",
      dbConnected: true,
      alerts: [
        {
          metric: "manual_wait_p95_ms",
          severity: "critical",
          value: 2500, // new peak
          threshold: 1000,
          message: "p95 crit again",
        },
      ] as any,
    },
    // Sample 5: NO alerts → must NOT count as a breach sample.
    {
      timestamp: t4 + 60_000,
      status: "ok",
      dbConnected: true,
      alerts: [] as any,
    },
  ]);

  // Two transitions out of three dispatch rows; the plain "alert" row
  // must be ignored. Insert in non-chronological order to verify sorting.
  await insertManualReserveAlertDispatches([
    {
      timestamp: t3,
      eventType: "all_clear",
      metric: "manual_wait_p95_ms",
      severity: "info",
      message: "all clear",
      value: 0,
      threshold: 0,
      status: "sent",
    },
    {
      timestamp: t1,
      eventType: "backed_up",
      metric: "manual_wait_p95_ms",
      severity: "critical",
      message: "backed up",
      value: 0,
      threshold: 0,
      status: "sent",
    },
    {
      timestamp: t2,
      eventType: "alert",
      metric: "manual_wait_p95_ms",
      severity: "warning",
      message: "regular alert (not a transition)",
      value: 800,
      threshold: 500,
      status: "sent",
    },
  ]);

  const summary = await buildDigestSummary(WINDOW_HOURS, SYNTH_NOW);

  assert.equal(summary.windowHours, WINDOW_HOURS);
  assert.equal(summary.windowEnd, SYNTH_NOW);
  assert.equal(summary.windowStart, WINDOW_START);

  // 4 samples carried at least one manual-reserve alert; the empty-alerts
  // sample must NOT be counted.
  assert.equal(summary.breachSamples, 4);

  // Totals across all manual-reserve alerts (db_round_trip_ms excluded):
  //   warning: t1 p95 + t2 timeout = 2
  //   critical: t2 p95 + t3 ep + t4 p95 = 3
  assert.equal(summary.totalWarning, 2);
  assert.equal(summary.totalCritical, 3);
  assert.equal(summary.totalAlerts, 5);

  // Three distinct metrics aggregated.
  assert.equal(summary.perMetric.length, 3);

  // Sort: critical desc → warning desc → metric asc. Both
  // manual_wait_p95_ms (2 crit, 1 warn) and
  // manual_entrypoint_timeout_window:foo (1 crit, 0 warn) are critical-led;
  // p95 has more crits so it sorts first.
  assert.equal(summary.perMetric[0]!.metric, "manual_wait_p95_ms");
  assert.equal(summary.perMetric[0]!.critical, 2);
  assert.equal(summary.perMetric[0]!.warning, 1);
  assert.equal(summary.perMetric[0]!.total, 3);
  assert.equal(summary.perMetric[0]!.firstSeenAt, t1);
  assert.equal(summary.perMetric[0]!.lastSeenAt, t4);
  // Peak should be the t4 critical (2500), not the earlier 1500.
  assert.equal(summary.perMetric[0]!.peakValue, 2500);
  assert.equal(summary.perMetric[0]!.peakThreshold, 1000);

  assert.equal(
    summary.perMetric[1]!.metric,
    "manual_entrypoint_timeout_window:foo",
  );
  assert.equal(summary.perMetric[1]!.critical, 1);
  assert.equal(summary.perMetric[1]!.warning, 0);

  assert.equal(summary.perMetric[2]!.metric, "manual_timeout_window");
  assert.equal(summary.perMetric[2]!.critical, 0);
  assert.equal(summary.perMetric[2]!.warning, 1);

  // Transitions: only backed_up + all_clear, oldest first; "alert" rows
  // are filtered out.
  assert.equal(summary.transitions.length, 2);
  assert.equal(summary.transitions[0]!.eventType, "backed_up");
  assert.equal(summary.transitions[0]!.at, t1);
  assert.equal(summary.transitions[1]!.eventType, "all_clear");
  assert.equal(summary.transitions[1]!.at, t3);

  await clearSyntheticWindow();
  console.log("[manual-reserve-digest] buildDigestSummary aggregation: OK");
}

async function main(): Promise<void> {
  try {
    await casePeriodKeyBoundaries();
    await casePlanGating();
    await caseBuildSummaryAggregation();
    console.log("manual-reserve-digest.test.ts: OK");
  } finally {
    await clearAllDigestSettings();
    await clearSyntheticWindow();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
