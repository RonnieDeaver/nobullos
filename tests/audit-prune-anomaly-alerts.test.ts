/* test-registration
{
  "name": "Audit-prune anomaly alerts (Task #1220)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1220 — unit tests for `server/services/auditPruneAnomalyAlerts.ts`.
 *
 * Exercises the per-table evaluator (`evaluateAndAlertForTable`) and the
 * `computeBaseline` helper directly. The dispatcher is stubbed via the
 * exposed `__testHelpers.setDispatcherForTests` injection point so no Slack
 * traffic is generated and no DB / settings rows are touched (config is
 * passed in-line to the evaluator).
 *
 * Coverage:
 *   - disabled flag short-circuits
 *   - zero-removed skip
 *   - below-floor skip
 *   - baseline-absent path (floor-only -> alerts when ≥ floor)
 *   - ratio threshold above (alerts) and below (skip)
 *   - per-table cooldown suppresses a second alert
 *   - dispatcher-skipped (delivered=false) vs. dispatcher-error decisions
 *   - computeBaseline window/non-zero filter math
 */

import {
  computeBaseline,
  evaluateAndAlertForTable,
  __testHelpers,
  type AuditPruneAnomalyConfig,
  type PruneEvent,
  type PruneTable,
} from "../server/services/auditPruneAnomalyAlerts";

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const TABLE: PruneTable = "stale_lease_threshold_audit";

const BASE_CONFIG: AuditPruneAnomalyConfig = {
  enabled: true,
  minRows: 1_000,
  ratioMultiplier: 5,
  baselineWindow: 10,
  cooldownMinutes: 60,
};

function event(overrides: Partial<PruneEvent> = {}): PruneEvent {
  return {
    at: "2026-05-15T12:00:00.000Z",
    removed: 0,
    maxEntries: 0,
    maxAgeDays: 30,
    trigger: "scheduled",
    triggeredBy: null,
    auditEntryId: null,
    ...overrides,
  };
}

interface DispatchCall {
  id: string;
  text: string;
  metadata: Record<string, unknown> | undefined;
  bypassDedupe: boolean | undefined;
}

let dispatchCalls: DispatchCall[] = [];

function installDispatcher(
  result: { delivered: boolean; status?: string; skipReason?: string } | Error,
): void {
  __testHelpers.setDispatcherForTests(async (id, payload, opts) => {
    dispatchCalls.push({
      id,
      text: payload.text,
      metadata: opts?.metadata,
      bypassDedupe: opts?.bypassDedupe,
    });
    if (result instanceof Error) throw result;
    return result;
  });
}

function resetState(): void {
  __testHelpers.resetLastAlertCache();
  __testHelpers.setDispatcherForTests(null);
  dispatchCalls = [];
}

async function testComputeBaseline(): Promise<void> {
  // Empty input
  const empty = computeBaseline([], 10);
  assert(empty.sampleSize === 0 && empty.averageRemoved === 0 && empty.maxRemoved === 0,
    "empty events => zero baseline");

  // All-zero events filtered out
  const allZero = computeBaseline(
    [event({ removed: 0 }), event({ removed: 0 })],
    10,
  );
  assert(allZero.sampleSize === 0, "all-zero events skipped");

  // Mix: window respects size, non-zero filter applied
  const mixed = computeBaseline(
    [
      event({ removed: 100 }),
      event({ removed: 0 }),
      event({ removed: 50 }),
      event({ removed: 200 }),
      // Outside window of 3:
      event({ removed: 9999 }),
    ],
    3,
  );
  // Window = first 3 = [100, 0, 50] -> nonZero = [100, 50] -> avg=75, max=100
  assert(mixed.sampleSize === 2, `sampleSize=2, got ${mixed.sampleSize}`);
  assert(mixed.averageRemoved === 75, `avg=75, got ${mixed.averageRemoved}`);
  assert(mixed.maxRemoved === 100, `max=100, got ${mixed.maxRemoved}`);
  console.log("✓ computeBaseline window + non-zero math");
}

async function testDisabled(): Promise<void> {
  resetState();
  installDispatcher({ delivered: true });
  const r = await evaluateAndAlertForTable(
    TABLE,
    event({ removed: 100_000 }),
    {
      config: { ...BASE_CONFIG, enabled: false },
      loadEvents: async () => [],
    },
  );
  assert(r.decision === "skipped_disabled", `decision=skipped_disabled, got ${r.decision}`);
  assert(dispatchCalls.length === 0, "disabled => no dispatch");
  console.log("✓ disabled flag short-circuits");
}

async function testZeroRemoved(): Promise<void> {
  resetState();
  installDispatcher({ delivered: true });
  const r = await evaluateAndAlertForTable(
    TABLE,
    event({ removed: 0 }),
    { config: BASE_CONFIG, loadEvents: async () => [] },
  );
  assert(r.decision === "skipped_zero_removed", `got ${r.decision}`);
  assert(dispatchCalls.length === 0, "zero removed => no dispatch");
  console.log("✓ zero-removed skip");
}

async function testBelowFloor(): Promise<void> {
  resetState();
  installDispatcher({ delivered: true });
  const r = await evaluateAndAlertForTable(
    TABLE,
    event({ removed: 500 }),
    { config: BASE_CONFIG, loadEvents: async () => [] },
  );
  assert(r.decision === "skipped_below_floor", `got ${r.decision}`);
  assert(dispatchCalls.length === 0, "below floor => no dispatch");
  console.log("✓ below-floor skip");
}

async function testBaselineAbsentAlerts(): Promise<void> {
  // No prior non-zero events => ratio check is skipped, floor alone gates.
  // removed >= minRows => alert.
  resetState();
  installDispatcher({ delivered: true });
  const current = event({ removed: 5_000, at: "2026-05-15T12:00:00.000Z" });
  const r = await evaluateAndAlertForTable(TABLE, current, {
    config: BASE_CONFIG,
    // loadEvents returns the current event (mirrors production where
    // recordPruneEvent ran first) plus a zero-removed prior — both filtered
    // away, leaving no baseline.
    loadEvents: async () => [current, event({ removed: 0, at: "2026-05-14T12:00:00.000Z" })],
  });
  assert(r.decision === "alerted", `expected alerted, got ${r.decision} (${r.skipReason ?? ""})`);
  assert(r.baseline.sampleSize === 0, "no baseline samples");
  assert(dispatchCalls.length === 1, "one dispatch");
  assert(
    dispatchCalls[0].text.includes("no prior non-zero runs"),
    "alert text mentions floor-only path",
  );
  assert(dispatchCalls[0].bypassDedupe === true, "cooldown handles dedupe, bypass=true");
  assert((dispatchCalls[0].metadata as any)?.ratioObserved === null, "ratioObserved=null");
  console.log("✓ baseline-absent => floor-only alert");
}

async function testRatioBelowSkip(): Promise<void> {
  // Baseline avg = 1000, removed = 2000 => ratio 2x < 5x => skip.
  resetState();
  installDispatcher({ delivered: true });
  const current = event({ removed: 2_000, at: "2026-05-15T12:00:00.000Z" });
  const priors = [
    event({ removed: 1_000, at: "2026-05-14T12:00:00.000Z" }),
    event({ removed: 1_000, at: "2026-05-13T12:00:00.000Z" }),
  ];
  const r = await evaluateAndAlertForTable(TABLE, current, {
    config: BASE_CONFIG,
    loadEvents: async () => [current, ...priors],
  });
  assert(r.decision === "skipped_below_ratio", `got ${r.decision}`);
  assert(dispatchCalls.length === 0, "below ratio => no dispatch");
  console.log("✓ ratio-below skip");
}

async function testRatioAboveAlerts(): Promise<void> {
  // Baseline avg = 1000, removed = 10_000 => 10x >= 5x => alert.
  resetState();
  installDispatcher({ delivered: true });
  const current = event({ removed: 10_000, at: "2026-05-15T12:00:00.000Z" });
  const priors = [
    event({ removed: 1_000, at: "2026-05-14T12:00:00.000Z" }),
    event({ removed: 1_000, at: "2026-05-13T12:00:00.000Z" }),
  ];
  const r = await evaluateAndAlertForTable(TABLE, current, {
    config: BASE_CONFIG,
    loadEvents: async () => [current, ...priors],
  });
  assert(r.decision === "alerted", `expected alerted, got ${r.decision} (${r.skipReason ?? ""})`);
  assert(r.baseline.sampleSize === 2, `baseline samples=2, got ${r.baseline.sampleSize}`);
  assert(dispatchCalls.length === 1, "one dispatch");
  const meta = dispatchCalls[0].metadata as any;
  assert(meta?.ratioObserved === 10, `ratioObserved=10, got ${meta?.ratioObserved}`);
  assert(meta?.baselineSampleSize === 2, "baselineSampleSize=2 in metadata");
  console.log("✓ ratio-above alerts with baseline metadata");
}

async function testCooldownSuppresses(): Promise<void> {
  resetState();
  installDispatcher({ delivered: true });
  const t0 = Date.UTC(2026, 4, 15, 12, 0, 0);
  const first = event({ removed: 5_000, at: "2026-05-15T12:00:00.000Z" });
  const r1 = await evaluateAndAlertForTable(TABLE, first, {
    config: BASE_CONFIG,
    loadEvents: async () => [first],
    now: t0,
  });
  assert(r1.decision === "alerted", "first => alerted");
  assert(dispatchCalls.length === 1, "one dispatch on first");

  // 10 minutes later — would otherwise alert (well above floor + ratio),
  // but cooldown (60min) should suppress.
  const second = event({ removed: 40_000, at: "2026-05-15T12:10:00.000Z" });
  const r2 = await evaluateAndAlertForTable(TABLE, second, {
    config: BASE_CONFIG,
    loadEvents: async () => [second, first],
    now: t0 + 10 * 60_000,
  });
  assert(r2.decision === "skipped_cooldown", `got ${r2.decision}`);
  assert(dispatchCalls.length === 1, "no extra dispatch during cooldown");

  // 65 minutes after the first alert — cooldown elapsed => alert again.
  // Use a high enough removed count to clear the 5x ratio against the
  // baseline (which now includes `first`@5000 -> avg=5000).
  const third = event({ removed: 30_000, at: "2026-05-15T13:05:00.000Z" });
  const r3 = await evaluateAndAlertForTable(TABLE, third, {
    config: BASE_CONFIG,
    loadEvents: async () => [third, first],
    now: t0 + 65 * 60_000,
  });
  assert(r3.decision === "alerted", `expected alerted after cooldown, got ${r3.decision}`);
  assert(dispatchCalls.length === 2, "second dispatch after cooldown elapsed");
  console.log("✓ per-table cooldown suppresses then releases");
}

async function testDispatcherSkipped(): Promise<void> {
  // Dispatcher returns delivered=false (e.g. notification disabled in
  // notification_settings) => decision=skipped_dispatcher_skipped, cooldown
  // is NOT armed (no successful delivery).
  resetState();
  installDispatcher({ delivered: false, skipReason: "notif_disabled" });
  const current = event({ removed: 5_000, at: "2026-05-15T12:00:00.000Z" });
  const r = await evaluateAndAlertForTable(TABLE, current, {
    config: BASE_CONFIG,
    loadEvents: async () => [current],
  });
  assert(
    r.decision === "skipped_dispatcher_skipped",
    `got ${r.decision} (${r.skipReason ?? ""})`,
  );
  assert(r.skipReason === "notif_disabled", `skipReason carried, got ${r.skipReason}`);
  assert(dispatchCalls.length === 1, "dispatcher invoked once");

  // A second call right after should still attempt dispatch (no cooldown
  // armed because nothing was delivered).
  const r2 = await evaluateAndAlertForTable(TABLE, current, {
    config: BASE_CONFIG,
    loadEvents: async () => [current],
  });
  assert(
    r2.decision === "skipped_dispatcher_skipped",
    `second call also dispatcher-skipped, got ${r2.decision}`,
  );
  assert(dispatchCalls.length === 2, "no cooldown armed -> 2nd dispatch attempted");
  console.log("✓ dispatcher-skipped (delivered=false) does not arm cooldown");
}

async function testDispatcherError(): Promise<void> {
  // Dispatcher throws => decision=skipped_send_failed, skipReason starts
  // with "dispatch_error:".
  resetState();
  installDispatcher(new Error("slack 500"));
  const current = event({ removed: 5_000, at: "2026-05-15T12:00:00.000Z" });
  const r = await evaluateAndAlertForTable(TABLE, current, {
    config: BASE_CONFIG,
    loadEvents: async () => [current],
  });
  assert(
    r.decision === "skipped_send_failed",
    `got ${r.decision} (${r.skipReason ?? ""})`,
  );
  assert(
    (r.skipReason ?? "").startsWith("dispatch_error:"),
    `skipReason prefix, got ${r.skipReason}`,
  );
  assert(dispatchCalls.length === 1, "dispatcher invoked once before throwing");
  console.log("✓ dispatcher-error => skipped_send_failed");
}

async function main(): Promise<void> {
  try {
    await testComputeBaseline();
    await testDisabled();
    await testZeroRemoved();
    await testBelowFloor();
    await testBaselineAbsentAlerts();
    await testRatioBelowSkip();
    await testRatioAboveAlerts();
    await testCooldownSuppresses();
    await testDispatcherSkipped();
    await testDispatcherError();
    console.log("\nALL AUDIT-PRUNE ANOMALY ALERT TESTS PASSED");
  } finally {
    resetState();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
