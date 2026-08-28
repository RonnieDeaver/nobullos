/* test-registration
{
  "name": "DB attribution endpoint shape (Task #836 P8)",
  "tier": "small"
}
test-registration */
import assert from "node:assert";
import {
  __recordDbHoldEventForTest as recordDbHoldEvent,
  getTopDbHoldLabels,
  getDbHoldLabelCounters,
  getApiPoolSnapshot,
  getWorkerPoolSnapshot,
  isApiPoolUnderPressure,
  recordApiFallbackLabelHit,
  getApiFallbackLabelCount,
} from "../server/db";
import {
  getBackgroundConcurrencySnapshot,
  getKillSwitchStatus,
} from "../server/services/workloadManager";

async function run() {
  recordDbHoldEvent("api", "api:GET /api/clients/:id", 25);
  recordDbHoldEvent("api", "api:GET /api/clients/:id", 31);
  recordDbHoldEvent("api", "unknown", 12);
  recordDbHoldEvent("worker", "worker:retroactive_reprocess", 88);

  // Task #836 Phase 1 (post-review): every fallback hit must increment
  // the dedicated counter so the dashboard can flag attribution gaps
  // even when the label isn't literally "unknown".
  const fallbackBefore = getApiFallbackLabelCount();
  recordApiFallbackLabelHit();
  recordApiFallbackLabelHit();
  assert.equal(
    getApiFallbackLabelCount(),
    fallbackBefore + 2,
    "fallback counter must increment per call",
  );

  const apiTop = getTopDbHoldLabels("api", 15);
  const workerTop = getTopDbHoldLabels("worker", 15);
  const counters = getDbHoldLabelCounters();
  const apiSnapshot = getApiPoolSnapshot();
  const workerSnapshot = getWorkerPoolSnapshot();
  const pressure = isApiPoolUnderPressure();
  const concurrency = getBackgroundConcurrencySnapshot();
  const killSwitches = getKillSwitchStatus();

  for (const top of [apiTop, workerTop]) {
    assert.ok(Array.isArray(top.byCount), "byCount must be an array");
    assert.ok(Array.isArray(top.byTotalMs), "byTotalMs must be an array");
    assert.ok(Array.isArray(top.byMaxMs), "byMaxMs must be an array");
    assert.equal(typeof top.unknownPct, "number", "unknownPct must be a number");
    for (const row of top.byCount) {
      assert.equal(typeof row.label, "string");
      assert.equal(typeof row.count, "number");
      assert.equal(typeof row.totalMs, "number");
      assert.equal(typeof row.maxMs, "number");
    }
  }

  const withAvg = (
    rows: Array<{ label: string; count: number; totalMs: number; maxMs: number }>,
  ) =>
    rows.map((r) => ({
      ...r,
      avgMs: r.count > 0 ? Math.round((r.totalMs / r.count) * 10) / 10 : 0,
    }));

  const apiFallbackLabelCount = getApiFallbackLabelCount();

  const payload = {
    api: {
      topByCount: withAvg(apiTop.byCount),
      topByTotalMs: withAvg(apiTop.byTotalMs),
      topByMaxMs: withAvg(apiTop.byMaxMs),
      fallbackLabelCount: apiFallbackLabelCount,
      unknownCount: counters.api.unknown,
      unknownPct: apiTop.unknownPct,
      poolSnapshot: apiSnapshot,
    },
    worker: {
      topByCount: withAvg(workerTop.byCount),
      topByTotalMs: withAvg(workerTop.byTotalMs),
      topByMaxMs: withAvg(workerTop.byMaxMs),
      unknownCount: counters.worker.unknown,
      unknownPct: workerTop.unknownPct,
      poolSnapshot: workerSnapshot,
    },
    pressure,
    concurrency,
    killSwitches,
  };

  const json = JSON.parse(JSON.stringify(payload));

  assert.ok(Array.isArray(json.api.topByCount), "api.topByCount must serialise as an array");
  assert.ok(json.api.topByCount.length > 0, "api.topByCount must contain the labels we recorded");
  for (const row of json.api.topByCount) {
    assert.equal(typeof row.avgMs, "number", "every row must include avgMs for the dashboard");
  }
  assert.ok(json.api.topByCount.some((r: any) => r.label === "api:GET /api/clients/:id"));

  assert.equal(typeof json.api.unknownPct, "number");
  assert.ok(json.api.unknownPct >= 0 && json.api.unknownPct <= 100, "unknownPct in [0,100]");
  assert.equal(typeof json.api.unknownCount, "number");
  assert.equal(typeof json.api.fallbackLabelCount, "number", "fallbackLabelCount must surface");
  assert.ok(json.api.fallbackLabelCount >= fallbackBefore + 2, "fallback count must reflect recorded hits");

  assert.equal(typeof json.api.poolSnapshot.total, "number");
  assert.equal(typeof json.api.poolSnapshot.idle, "number");
  assert.equal(typeof json.api.poolSnapshot.waiting, "number");

  assert.equal(typeof json.pressure.underPressure, "boolean");
  assert.ok(Array.isArray(json.pressure.reasons));

  assert.equal(typeof json.concurrency.totalActive, "number");
  assert.equal(typeof json.concurrency.totalBudget, "number");
  assert.ok(Array.isArray(json.concurrency.byClass));

  for (const k of [
    "retroactive_reprocess",
    "front_sync_reprocess",
    "auto_retry",
    "non_critical_sweeps",
    "large_backfills",
  ]) {
    assert.equal(typeof json.killSwitches[k], "boolean", `kill switch ${k} must be a boolean`);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {
    console.log("db-attribution-endpoint.test.ts: OK");
  })
  .catch((e) => {
    console.error("db-attribution-endpoint.test.ts: FAIL", e);
    process.exitCode = 1;
  });
