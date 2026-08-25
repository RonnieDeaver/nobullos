/* test-registration
{
  "name": "Manual reserve alerts",
  "tier": "medium"
}
test-registration */
/**
 * Verifies that manual-reserve thresholds in healthMetrics.evaluateAlerts /
 * collectSample produce alert entries on the currentAlerts list when manual
 * sync timeouts, p95 wait, or background-ingestion saturation breach the
 * configured thresholds. Also verifies validation enforces warn < critical.
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

async function main() {
  const hm = await import("../server/services/healthMetrics");

  // Stub origin metrics so collectSample sees deterministic counters across
  // simulated sampler ticks.
  let stubP95: number | null = null;
  let stubManualTimeoutCount = 0;
  let stubSaturationCount = 0;
  let stubDelayedCount = 0;
  (hm as any).__setOriginMetricsProviderForTest(() => ({
    manualAcquires: 100,
    manualDelayedByBackgroundCount: stubDelayedCount,
    manualTimeoutCount: stubManualTimeoutCount,
    backgroundIngestionSaturationCount: stubSaturationCount,
    manualWait: { count: 1, avgMs: stubP95, maxMs: stubP95, p95Ms: stubP95 },
  }));

  // Lower thresholds to make this fast and deterministic.
  hm.updateThresholds({
    manualTimeoutWindowWarning: 1,
    manualTimeoutWindowCritical: 3,
    manualWaitP95WarningMs: 1000,
    manualWaitP95CriticalMs: 5000,
    backgroundIngestionSaturationWindowWarning: 2,
    backgroundIngestionSaturationWindowCritical: 10,
    manualDelayedByBackgroundWindowWarning: 2,
    manualDelayedByBackgroundWindowCritical: 6,
  });
  (hm as any).__resetManualReserveWindowForTest();

  // Tick 1: baseline counters, no p95 → no manual reserve alerts.
  let history = await callCollectAndGetLatest(hm);
  assertNoMetric(history.alerts, "manual_wait_p95_ms");
  assertNoMetric(history.alerts, "manual_timeout_window");
  assertNoMetric(history.alerts, "background_ingestion_saturation_window");

  // Tick 2: breach p95 wait at warning.
  stubP95 = 1500;
  history = await callCollectAndGetLatest(hm);
  assertAlert(history.alerts, "manual_wait_p95_ms", "warning", 1500);

  // Tick 3: breach p95 wait at critical.
  stubP95 = 6000;
  history = await callCollectAndGetLatest(hm);
  assertAlert(history.alerts, "manual_wait_p95_ms", "critical", 6000);

  // Tick 4: counter delta — bump manual timeouts past warning.
  stubP95 = null;
  stubManualTimeoutCount = 2; // delta from baseline (0) over window = 2 ≥ 1
  history = await callCollectAndGetLatest(hm);
  assertAlert(history.alerts, "manual_timeout_window", "warning", 2);

  // Tick 5: bump past critical.
  stubManualTimeoutCount = 5; // delta = 5 ≥ 3
  history = await callCollectAndGetLatest(hm);
  assertAlert(history.alerts, "manual_timeout_window", "critical", 5);

  // Tick 6: bump background saturation delta past warning.
  stubSaturationCount = 4; // delta from 0 = 4 ≥ 2
  history = await callCollectAndGetLatest(hm);
  assertAlert(history.alerts, "background_ingestion_saturation_window", "warning", 4);

  // Tick 7: bump past critical.
  stubSaturationCount = 12;
  history = await callCollectAndGetLatest(hm);
  assertAlert(history.alerts, "background_ingestion_saturation_window", "critical", 12);

  // Tick 8: bump delayed-by-background delta past warning.
  stubDelayedCount = 3; // delta from 0 = 3 ≥ 2
  history = await callCollectAndGetLatest(hm);
  assertAlert(history.alerts, "manual_delayed_by_background_window", "warning", 3);

  // Tick 9: bump delayed-by-background past critical.
  stubDelayedCount = 8; // delta = 8 ≥ 6
  history = await callCollectAndGetLatest(hm);
  assertAlert(history.alerts, "manual_delayed_by_background_window", "critical", 8);

  // Validation: warning >= critical must reject.
  let threw = false;
  try {
    hm.updateThresholds({ manualTimeoutWindowWarning: 10, manualTimeoutWindowCritical: 5 });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected updateThresholds to reject warn >= critical");

  let threwDelayed = false;
  try {
    hm.updateThresholds({
      manualDelayedByBackgroundWindowWarning: 20,
      manualDelayedByBackgroundWindowCritical: 10,
    });
  } catch {
    threwDelayed = true;
  }
  if (!threwDelayed) {
    throw new Error("expected updateThresholds to reject delayed warn >= critical");
  }

  console.log("manual-reserve-alerts: all cases passed");
}

async function callCollectAndGetLatest(hm: any): Promise<{ alerts: any[] }> {
  // collectSample is internal; trigger via the public sampler hook by directly
  // invoking it. The module exports getHealthHistory after sampling.
  // Re-export collectSample via a test-only path by using the internal symbol
  // through dynamic require — fall back to seeding via startHealthSampler.
  const fn = (hm as any).__test_collectSample;
  if (typeof fn === "function") {
    const sample = await fn();
    return { alerts: sample.alerts };
  }
  // Fallback: drive through the sampler by importing exposed evaluators.
  // Not available — require __test_collectSample to be exported.
  throw new Error("healthMetrics must expose __test_collectSample for this test");
}

function assertAlert(alerts: any[], metric: string, severity: string, value: number) {
  const found = alerts.find(a => a.metric === metric && a.severity === severity);
  if (!found) {
    throw new Error(
      `expected ${severity} alert on ${metric}; got: ${JSON.stringify(alerts)}`,
    );
  }
  if (found.value !== value) {
    throw new Error(`expected ${metric} value ${value}, got ${found.value}`);
  }
}

function assertNoMetric(alerts: any[], metric: string) {
  const found = alerts.find(a => a.metric === metric);
  if (found) {
    throw new Error(`unexpected ${metric} alert: ${JSON.stringify(found)}`);
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
