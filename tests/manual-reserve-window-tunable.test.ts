/* test-registration
{
  "name": "Manual reserve window tunable (Task #1174)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Verifies the admin-tunable manual-reserve window (Task #712) wired through
 * `evaluateManualReserveAlerts` and `evaluatePerEntryPointManualReserveAlerts`:
 *
 *   (a) shrinking `manualReserveWindowSamples` drops older samples on the next
 *       sampler tick so the delta baseline jumps forward,
 *   (b) widening it leaves older samples in scope so the delta baseline stays
 *       anchored to the original oldest sample,
 *   (c) the rendered alert message's "in last ~Xmin" string reflects the live
 *       window (samples * 30s / 60s, rounded), and
 *   (d) `updateThresholds` rejects out-of-range / non-integer values
 *       (1, 121, 5.5, "10").
 *
 * Uses the existing `__resetManualReserveWindowForTest` and
 * `__setOriginMetricsProviderForTest` hooks for isolation.
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

async function main() {
  const hm = await import("../server/services/healthMetrics");

  let stubManualTimeoutCount = 0;
  let stubWorkerTimeoutCount = 0;
  (hm as any).__setOriginMetricsProviderForTest(() => ({
    manualAcquires: 100,
    manualDelayedByBackgroundCount: 0,
    manualTimeoutCount: stubManualTimeoutCount,
    backgroundIngestionSaturationCount: 0,
    manualWait: { count: 0, avgMs: null, maxMs: null, p95Ms: null },
    byWorker: [
      {
        worker: "test_worker",
        workloadClass: "interactive",
        manualAcquires: 100,
        manualDelayedByBackgroundCount: 0,
        manualTimeoutCount: stubWorkerTimeoutCount,
        manualWait: { count: 0, avgMs: null, maxMs: null, p95Ms: null },
      },
    ],
  }));

  // Make any non-zero delta trip the warning so we always see a window message.
  hm.updateThresholds({
    manualTimeoutWindowWarning: 1,
    manualTimeoutWindowCritical: 9999,
    perEntryPointManualTimeoutWindowWarning: 1,
    perEntryPointManualTimeoutWindowCritical: 9999,
    manualReserveWindowSamples: 10,
  });
  (hm as any).__resetManualReserveWindowForTest();

  // ---- Build up a 5-sample history (counts 100..104) under window=10. ----
  for (let i = 0; i < 5; i++) {
    stubManualTimeoutCount = 100 + i;
    stubWorkerTimeoutCount = 100 + i;
    const s = await (hm as any).__test_collectSample();
    if (i === 0) {
      // First tick: only one sample in history → no delta-window alert yet.
      assertNoMetric(s.alerts, "manual_timeout_window");
    }
    if (i === 4) {
      // 5 samples → oldest=100, current=104, delta=4, windowMin=round(5*30/60)=3.
      assertAlertWithMessage(
        s.alerts,
        "manual_timeout_window",
        "warning",
        4,
        /in last ~3min/,
      );
      assertAlertWithMessage(
        s.alerts,
        "manual_entrypoint_timeout_window:test_worker",
        "warning",
        4,
        /in last ~3min/,
      );
    }
  }

  // ---- (b) Widen window to 30. Older samples must remain in scope. ----
  hm.updateThresholds({ manualReserveWindowSamples: 30 });
  stubManualTimeoutCount = 105;
  stubWorkerTimeoutCount = 105;
  let sample = await (hm as any).__test_collectSample();
  // History: [100,101,102,103,104,105] — len=6, cap=30, no trim.
  // delta from oldest (100) = 5, windowMin = round(6*30/60) = 3.
  assertAlertWithMessage(
    sample.alerts,
    "manual_timeout_window",
    "warning",
    5,
    /in last ~3min/,
  );
  assertAlertWithMessage(
    sample.alerts,
    "manual_entrypoint_timeout_window:test_worker",
    "warning",
    5,
    /in last ~3min/,
  );

  // ---- (a) Shrink window to 3. Older samples must be dropped on next tick. ----
  hm.updateThresholds({ manualReserveWindowSamples: 3 });
  stubManualTimeoutCount = 106;
  stubWorkerTimeoutCount = 106;
  sample = await (hm as any).__test_collectSample();
  // After push, history len=7; trimmed to last 3 → [104,105,106].
  // delta = 106-104 = 2 (NOT 6, which is what it would be without trimming).
  // windowMin = round(3*30/60) = 2.
  assertAlertWithMessage(
    sample.alerts,
    "manual_timeout_window",
    "warning",
    2,
    /in last ~2min/,
  );
  assertAlertWithMessage(
    sample.alerts,
    "manual_entrypoint_timeout_window:test_worker",
    "warning",
    2,
    /in last ~2min/,
  );

  // ---- (d) Validation: out-of-range and non-integer values must reject. ----
  assertRejects(
    () => hm.updateThresholds({ manualReserveWindowSamples: 1 }),
    "below MIN (1)",
  );
  assertRejects(
    () => hm.updateThresholds({ manualReserveWindowSamples: 121 }),
    "above MAX (121)",
  );
  assertRejects(
    () => hm.updateThresholds({ manualReserveWindowSamples: 5.5 }),
    "non-integer (5.5)",
  );
  assertRejects(
    () => hm.updateThresholds({ manualReserveWindowSamples: "10" as any }),
    "non-number string",
  );

  // Boundary values should be accepted.
  hm.updateThresholds({ manualReserveWindowSamples: 2 });
  hm.updateThresholds({ manualReserveWindowSamples: 120 });

  console.log("manual-reserve-window-tunable: all cases passed");
}

function assertAlertWithMessage(
  alerts: any[],
  metric: string,
  severity: string,
  value: number,
  messagePattern: RegExp,
) {
  const found = alerts.find((a) => a.metric === metric && a.severity === severity);
  if (!found) {
    throw new Error(
      `expected ${severity} alert on ${metric}; got: ${JSON.stringify(alerts)}`,
    );
  }
  if (found.value !== value) {
    throw new Error(`expected ${metric} value ${value}, got ${found.value}`);
  }
  if (!messagePattern.test(found.message)) {
    throw new Error(
      `expected ${metric} message to match ${messagePattern}; got: ${found.message}`,
    );
  }
}

function assertNoMetric(alerts: any[], metric: string) {
  const found = alerts.find((a) => a.metric === metric);
  if (found) {
    throw new Error(`unexpected ${metric} alert: ${JSON.stringify(found)}`);
  }
}

function assertRejects(fn: () => unknown, label: string) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(`expected updateThresholds to reject ${label}`);
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
