/* test-registration
{
  "name": "Manual reserve per-entry-point alerts",
  "tier": "medium"
}
test-registration */
/**
 * Verifies that per-entry-point manual-reserve thresholds in healthMetrics
 * produce alert entries on the currentAlerts list when a single worker (e.g.
 * zoom_sync) breaches the configured timeout/delayed-by-background window
 * thresholds. Also verifies validation enforces warn < critical.
 */

delete process.env.HEALTH_ALERTS_SLACK_CHANNEL_ID;

async function main() {
  const hm = await import("../server/services/healthMetrics");

  let zoomTimeout = 0;
  let zoomDelayed = 0;
  let semrushTimeout = 0;
  let semrushDelayed = 0;
  let zoomAvg: number | null = null;
  let zoomP95: number | null = null;

  (hm as any).__setOriginMetricsProviderForTest(() => ({
    manualAcquires: 100,
    manualDelayedByBackgroundCount: zoomDelayed + semrushDelayed,
    manualTimeoutCount: zoomTimeout + semrushTimeout,
    backgroundIngestionSaturationCount: 0,
    manualWait: { count: 0, avgMs: null, maxMs: null, p95Ms: null },
    byWorker: [
      {
        worker: "zoom_sync",
        workloadClass: "ingestion",
        manualAcquires: 50,
        manualDelayedByBackgroundCount: zoomDelayed,
        manualTimeoutCount: zoomTimeout,
        manualWait: { count: 1, avgMs: zoomAvg, maxMs: zoomP95, p95Ms: zoomP95 },
      },
      {
        worker: "semrush_inventory_sync",
        workloadClass: "ingestion",
        manualAcquires: 30,
        manualDelayedByBackgroundCount: semrushDelayed,
        manualTimeoutCount: semrushTimeout,
        manualWait: { count: 1, avgMs: null, maxMs: null, p95Ms: null },
      },
    ],
  }));

  hm.updateThresholds({
    perEntryPointManualTimeoutWindowWarning: 1,
    perEntryPointManualTimeoutWindowCritical: 3,
    perEntryPointManualDelayedByBackgroundWindowWarning: 2,
    perEntryPointManualDelayedByBackgroundWindowCritical: 5,
  });
  (hm as any).__resetManualReserveWindowForTest();

  // Tick 1: baseline — no alerts (need at least 2 samples for delta).
  let sample = await (hm as any).__test_collectSample();
  assertNoMetricPrefix(sample.alerts, "manual_entrypoint_");

  // Tick 2: zoom timeouts breach warning, semrush quiet.
  zoomTimeout = 2;
  sample = await (hm as any).__test_collectSample();
  assertAlert(sample.alerts, "manual_entrypoint_timeout_window:zoom_sync", "warning", 2);
  assertNoMetric(sample.alerts, "manual_entrypoint_timeout_window:semrush_inventory_sync");

  // Tick 3: zoom timeouts breach critical and message includes wait stats.
  zoomTimeout = 5;
  zoomAvg = 2500;
  zoomP95 = 7000;
  sample = await (hm as any).__test_collectSample();
  const critTimeout = findAlert(
    sample.alerts,
    "manual_entrypoint_timeout_window:zoom_sync",
    "critical",
  );
  if (critTimeout.value !== 5) throw new Error("expected zoom timeout value=5");
  if (!critTimeout.message.includes("zoom_sync")) {
    throw new Error("alert message must name the entry point");
  }
  if (!critTimeout.message.includes("p95 7000ms") || !critTimeout.message.includes("avg 2500ms")) {
    throw new Error(`alert must include avg/p95 wait, got: ${critTimeout.message}`);
  }

  // Tick 4: semrush delayed-by-background breaches warning independently.
  semrushDelayed = 3;
  sample = await (hm as any).__test_collectSample();
  assertAlert(
    sample.alerts,
    "manual_entrypoint_delayed_window:semrush_inventory_sync",
    "warning",
    3,
  );

  // Tick 5: semrush delayed-by-background breaches critical.
  semrushDelayed = 9;
  sample = await (hm as any).__test_collectSample();
  assertAlert(
    sample.alerts,
    "manual_entrypoint_delayed_window:semrush_inventory_sync",
    "critical",
    9,
  );

  // Validation: warn >= critical must reject.
  let threwTimeout = false;
  try {
    hm.updateThresholds({
      perEntryPointManualTimeoutWindowWarning: 5,
      perEntryPointManualTimeoutWindowCritical: 3,
    });
  } catch {
    threwTimeout = true;
  }
  if (!threwTimeout) {
    throw new Error("expected per-entry-point timeout warn >= critical to reject");
  }

  let threwDelayed = false;
  try {
    hm.updateThresholds({
      perEntryPointManualDelayedByBackgroundWindowWarning: 10,
      perEntryPointManualDelayedByBackgroundWindowCritical: 5,
    });
  } catch {
    threwDelayed = true;
  }
  if (!threwDelayed) {
    throw new Error("expected per-entry-point delayed warn >= critical to reject");
  }

  console.log("manual-reserve-per-entrypoint-alerts: all cases passed");
}

function findAlert(alerts: any[], metric: string, severity: string) {
  const found = alerts.find((a) => a.metric === metric && a.severity === severity);
  if (!found) {
    throw new Error(
      `expected ${severity} alert on ${metric}; got: ${JSON.stringify(alerts)}`,
    );
  }
  return found;
}

function assertAlert(alerts: any[], metric: string, severity: string, value: number) {
  const found = findAlert(alerts, metric, severity);
  if (found.value !== value) {
    throw new Error(`expected ${metric} value ${value}, got ${found.value}`);
  }
}

function assertNoMetric(alerts: any[], metric: string) {
  const found = alerts.find((a) => a.metric === metric);
  if (found) {
    throw new Error(`unexpected ${metric} alert: ${JSON.stringify(found)}`);
  }
}

function assertNoMetricPrefix(alerts: any[], prefix: string) {
  const found = alerts.find((a) => typeof a.metric === "string" && a.metric.startsWith(prefix));
  if (found) {
    throw new Error(`unexpected alert with prefix ${prefix}: ${JSON.stringify(found)}`);
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
