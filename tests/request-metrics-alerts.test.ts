/* test-registration
{
  "name": "Request-metrics regression alerts: consecutive-breach streaks, dedupe keys, recovery (Task #3816)",
  "smoke": true,
  "smokeReason": "Guards the sustained per-route p95/error-rate regression alert: streak gating (no single-blip pages), per-route dedupe keys through the dispatcher, error-rate-over-p95 classification, minCount floor, disable switch, and recovery marking. A regression either pages on noise or never pages on real sustained regressions.",
  "tier": "small"
}
test-registration */
/**
 * Task #3816 — requestMetricsAlerts (sustained per-route regression alert).
 *
 * Hermetic: aggregator seeded via recordRequestSample with pinned `now`
 * values; dispatcher + markRecovered stubbed via the service's test seams;
 * config injected via setConfigForTests (which also short-circuits the
 * system_settings read). Asserts:
 *
 *  - a breaching route (p95 over band, >= minCount req) does NOT alert on
 *    evaluations 1..N-1 ("building"), and alerts exactly once on the Nth
 *    consecutive breach with dedupeKey `api_route_regression:<route>` and
 *    failureType p95;
 *  - a route both slow AND failing classifies as error_rate (5xxs explain
 *    the latency);
 *  - fewer than minCount requests never breach, however slow;
 *  - after an alert, a healthy window marks recovery with the SAME dedupe
 *    key and clears the streak; traffic stopping entirely also recovers;
 *  - `enabled: false` short-circuits the evaluator;
 *  - the notification id is registered + implemented in the registry;
 *  - getAlertStateSnapshot surfaces building/alerted routes for the panel.
 */
import assert from "node:assert/strict";
import {
  recordRequestSample,
  __testHelpers as metricsHelpers,
} from "../server/services/requestMetrics";
import {
  evaluateOnce,
  getAlertStateSnapshot,
  NOTIFICATION_ID,
  __testHelpers as alertHelpers,
} from "../server/services/requestMetricsAlerts";
import { getNotification } from "../server/services/notifications/registry";

interface DispatchCall {
  id: string;
  text: string;
  options: Record<string, any>;
}

async function run(): Promise<void> {
  const dispatched: DispatchCall[] = [];
  const recovered: Array<{ id: string; dedupeKey: string }> = [];
  alertHelpers.setDispatcherForTests(async (id, payload, options) => {
    dispatched.push({ id, text: payload.text, options });
    return { delivered: true };
  });
  alertHelpers.setMarkRecoveredForTests(async (id, dedupeKey) => {
    recovered.push({ id, dedupeKey });
  });
  alertHelpers.setConfigForTests({
    enabled: true,
    windowMs: 10 * 60_000,
    p95Ms: 200,
    errorRatePct: 25,
    minCount: 10,
    consecutiveBreaches: 3,
  });

  try {
    // ── Registry wiring ────────────────────────────────────────────────
    const entry = getNotification(NOTIFICATION_ID);
    assert.ok(entry, `registry must contain ${NOTIFICATION_ID}`);
    assert.equal(entry!.implemented, true);
    assert.equal(entry!.category, "infra");
    assert.equal(entry!.defaultEnabled, true);

    // ── Streak gating: building → building → alert on 3rd ─────────────
    metricsHelpers.resetForTests();
    alertHelpers.resetStateForTests();
    const t0 = Date.now();
    const seedSlow = (now: number) => {
      for (let i = 0; i < 20; i++) {
        recordRequestSample({ method: "GET", route: "/api/slowroute", status: 200, durationMs: 900, now });
      }
    };
    seedSlow(t0);
    const e1 = await evaluateOnce(t0 + 1);
    assert.equal(e1.ran, true);
    const b1 = e1.evaluations.find((e) => e.route === "GET /api/slowroute");
    assert.ok(b1, "breaching route must be evaluated");
    assert.equal(b1!.decision, "building");
    assert.equal(b1!.streak, 1);
    assert.equal(dispatched.length, 0, "no alert before consecutiveBreaches evaluations");

    const e2 = await evaluateOnce(t0 + 2);
    assert.equal(e2.evaluations.find((e) => e.route === "GET /api/slowroute")!.decision, "building");
    assert.equal(dispatched.length, 0);

    const e3 = await evaluateOnce(t0 + 3);
    const a3 = e3.evaluations.find((e) => e.route === "GET /api/slowroute");
    assert.equal(a3!.decision, "alerted");
    assert.equal(a3!.streak, 3);
    assert.equal(dispatched.length, 1, "alert fires exactly on the Nth consecutive breach");
    const call = dispatched[0];
    assert.equal(call.id, NOTIFICATION_ID);
    assert.equal(call.options.dedupeKey, "api_route_regression:GET /api/slowroute");
    assert.equal(call.options.failureType, "p95");
    assert.equal(call.options.triggerSource, "alert_service");
    assert.match(call.text, /p95 is \*\d+ms\*/);
    assert.equal(call.options.metadata.route, "GET /api/slowroute");
    assert.ok(call.options.metadata.p95Ms >= 900);

    // Snapshot surfaces the alerted route for the console panel.
    const snap = getAlertStateSnapshot();
    const snapRow = snap.breaching.find((b) => b.route === "GET /api/slowroute");
    assert.ok(snapRow && snapRow.alerted, "snapshot must show the alerted route");

    // ── Recovery: healthy window → markRecovered with same dedupe key ──
    // Jump past the window so the slow samples age out, then seed fast ones.
    const t1 = t0 + 30 * 60_000;
    for (let i = 0; i < 15; i++) {
      recordRequestSample({ method: "GET", route: "/api/slowroute", status: 200, durationMs: 20, now: t1 });
    }
    const e4 = await evaluateOnce(t1 + 1);
    const r4 = e4.evaluations.find((e) => e.route === "GET /api/slowroute");
    assert.equal(r4!.decision, "recovered");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].dedupeKey, "api_route_regression:GET /api/slowroute");
    assert.equal(recovered[0].id, NOTIFICATION_ID);
    assert.equal(
      getAlertStateSnapshot().breaching.find((b) => b.route === "GET /api/slowroute"),
      undefined,
      "recovered route leaves the breaching snapshot",
    );

    // ── error_rate takes priority over p95 when both breach ────────────
    metricsHelpers.resetForTests();
    alertHelpers.resetStateForTests();
    dispatched.length = 0;
    alertHelpers.setConfigForTests({
      enabled: true,
      p95Ms: 200,
      errorRatePct: 25,
      minCount: 10,
      consecutiveBreaches: 1,
    });
    const t2 = Date.now();
    for (let i = 0; i < 12; i++) {
      recordRequestSample({
        method: "POST",
        route: "/api/failing",
        status: i % 2 === 0 ? 500 : 200,
        durationMs: 999,
        now: t2,
      });
    }
    const e5 = await evaluateOnce(t2 + 1);
    const f5 = e5.evaluations.find((e) => e.route === "POST /api/failing");
    assert.equal(f5!.decision, "alerted");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].options.failureType, "error_rate");
    assert.match(dispatched[0].text, /5xx rate is \*\d+(\.\d+)?%\*/);

    // ── minCount floor: slow but sparse traffic never breaches ─────────
    metricsHelpers.resetForTests();
    alertHelpers.resetStateForTests();
    dispatched.length = 0;
    const t3 = Date.now();
    for (let i = 0; i < 5; i++) {
      recordRequestSample({ method: "GET", route: "/api/sparse", status: 200, durationMs: 5000, now: t3 });
    }
    const e6 = await evaluateOnce(t3 + 1);
    assert.equal(
      e6.evaluations.find((e) => e.route === "GET /api/sparse"),
      undefined,
      "below minCount there is no breach state at all",
    );
    assert.equal(dispatched.length, 0);

    // ── traffic stopping entirely recovers an alerted route ────────────
    metricsHelpers.resetForTests();
    alertHelpers.resetStateForTests();
    dispatched.length = 0;
    recovered.length = 0;
    const t4 = Date.now();
    for (let i = 0; i < 12; i++) {
      recordRequestSample({ method: "GET", route: "/api/vanishing", status: 200, durationMs: 800, now: t4 });
    }
    await evaluateOnce(t4 + 1);
    assert.equal(dispatched.length, 1, "consecutiveBreaches=1 alerts immediately");
    // No new samples; jump past the window so the route drops out of summary.
    metricsHelpers.resetForTests();
    const e7 = await evaluateOnce(t4 + 30 * 60_000);
    const v7 = e7.evaluations.find((e) => e.route === "GET /api/vanishing");
    assert.equal(v7!.decision, "recovered", "alerted route with no traffic left must recover");
    assert.equal(recovered.length, 1);

    // ── enabled:false short-circuits ────────────────────────────────────
    alertHelpers.setConfigForTests({ enabled: false });
    const e8 = await evaluateOnce();
    assert.equal(e8.ran, false);
    assert.equal(e8.skippedReason, "disabled");
  } finally {
    alertHelpers.setDispatcherForTests(null);
    alertHelpers.setMarkRecoveredForTests(null);
    alertHelpers.setConfigForTests(null);
    alertHelpers.resetStateForTests();
    metricsHelpers.resetForTests();
  }

  console.log("request-metrics-alerts: PASSED");
}

run().catch((err) => {
  console.error("request-metrics-alerts: FAILED", err);
  process.exitCode = 1;
});
