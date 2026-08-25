/* test-registration
{
  "name": "Health dashboard api_pool_wait windowed alert (Task #1261)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~3.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1261 — Regression test for the windowed `api_pool_wait` alert.
 *
 * Holds every API-pool connection long enough to force consecutive sampler
 * ticks to record `apiPoolWaitMs` above a low test-only threshold, and
 * asserts:
 *
 *   (a) a single saturated sample does NOT fire the alert (windowing
 *       requires a *full* window of breaching samples, so one noisy spike
 *       cannot page),
 *   (b) once `apiPoolWaitWindowSamples` consecutive saturated samples are
 *       collected, an `api_pool_wait` alert appears in the returned
 *       sample's `alerts` array, and
 *   (c) the rendered message reflects the configured window cap and
 *       severity (`warning`).
 *
 * Holds three of three API-pool slots (`DB_API_POOL_MAX` is asserted >= 2,
 * matches the existing pool-saturation isolation test pattern) and uses the
 * `__test_collectSample` hook to drive sampling synchronously.
 */
import assert from "node:assert";
import { apiPool } from "../server/db";
import {
  __test_collectSample,
  __resetManualReserveWindowForTest,
  updateThresholds,
  resetThresholds,
  getThresholds,
  type Alert,
} from "../server/services/healthMetrics";
import { PERF } from "../server/perfConfig";

// Slack delivery is best-effort and gated by Slack/notification config; we
// don't want this test to attempt any external dispatch.
delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

const HOLD_BEFORE_RELEASE_MS = 1500;
const WINDOW_SAMPLES = 2;
// Pool-acquire wait should easily clear 200ms when the pool is fully held
// for ~1.5s. Keep the warning threshold low and critical well above the
// expected wait so we exercise the warning path deterministically.
const WARNING_MS = 200;
const CRITICAL_MS = 60_000;

function alertsOfMetric(alerts: Alert[], metric: string): Alert[] {
  return alerts.filter((a) => a.metric === metric);
}

async function collectSaturatedSample(): Promise<Awaited<ReturnType<typeof __test_collectSample>>> {
  const max = PERF.DB_API_POOL_MAX;
  assert.ok(max >= 2, `expected DB_API_POOL_MAX >= 2, got ${max}`);

  const held: Array<Awaited<ReturnType<typeof apiPool.connect>>> = [];
  try {
    for (let i = 0; i < max; i++) {
      held.push(await apiPool.connect());
    }
    const samplePromise = __test_collectSample();
    setTimeout(() => {
      const c = held.shift();
      if (c) c.release();
    }, HOLD_BEFORE_RELEASE_MS);
    const sample = await samplePromise;
    assert.notEqual(sample.apiPoolWaitMs, null, "apiPoolWaitMs must be captured");
    return sample;
  } finally {
    while (held.length > 0) {
      const c = held.shift();
      try {
        c?.release();
      } catch {
        /* already released */
      }
    }
  }
}

async function run() {
  resetThresholds();
  __resetManualReserveWindowForTest();
  updateThresholds({
    apiPoolWaitWarningMs: WARNING_MS,
    apiPoolWaitCriticalMs: CRITICAL_MS,
    apiPoolWaitWindowSamples: WINDOW_SAMPLES,
  });
  const t = getThresholds();
  assert.equal(t.apiPoolWaitWarningMs, WARNING_MS);
  assert.equal(t.apiPoolWaitCriticalMs, CRITICAL_MS);
  assert.equal(t.apiPoolWaitWindowSamples, WINDOW_SAMPLES);

  // (a) First saturated sample only — window not yet full, no alert.
  const first = await collectSaturatedSample();
  assert.ok(
    (first.apiPoolWaitMs ?? 0) >= WARNING_MS,
    `first saturated apiPoolWaitMs must exceed warning threshold, got ${first.apiPoolWaitMs}ms`,
  );
  assert.equal(
    alertsOfMetric(first.alerts, "api_pool_wait").length,
    0,
    `single saturated sample must NOT fire api_pool_wait alert (windowed). alerts=${JSON.stringify(first.alerts)}`,
  );

  // (b) Second consecutive saturated sample — window now full, alert fires.
  const second = await collectSaturatedSample();
  assert.ok(
    (second.apiPoolWaitMs ?? 0) >= WARNING_MS,
    `second saturated apiPoolWaitMs must exceed warning threshold, got ${second.apiPoolWaitMs}ms`,
  );
  const firing = alertsOfMetric(second.alerts, "api_pool_wait");
  assert.equal(
    firing.length,
    1,
    `expected exactly one api_pool_wait alert after full window. alerts=${JSON.stringify(second.alerts)}`,
  );

  // (c) Severity + windowing reflected in the message.
  const alert = firing[0];
  assert.equal(alert.severity, "warning", `expected warning severity, got ${alert.severity}`);
  assert.equal(alert.threshold, WARNING_MS);
  assert.ok(
    alert.value >= WARNING_MS,
    `alert value (${alert.value}) must be at or above warning threshold (${WARNING_MS})`,
  );
  assert.ok(
    /across\s+2\s+consecutive samples/.test(alert.message),
    `alert message should reflect window cap, got: ${alert.message}`,
  );

  // Cleanup so subsequent tests in the suite start from defaults.
  resetThresholds();
  __resetManualReserveWindowForTest();

  console.log(
    `[health-api-pool-wait-alert] first=${first.apiPoolWaitMs}ms (no alert) | ` +
      `second=${second.apiPoolWaitMs}ms (alert: ${alert.severity}, value=${alert.value}ms)`,
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {
    console.log("PASS: api_pool_wait windowed alert fires after sustained saturation");
  })
  .catch((err) => {
    console.error("FAIL:", err);
    process.exitCode = 1;
  });
