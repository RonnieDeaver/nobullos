/* test-registration
{
  "name": "Manual reserve alert history fallback (Task #1186)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1186 — pin behavior of the in-memory fallback path inside
 * `getRecentManualReserveAlertDispatches`. The function reads from the DB
 * and silently falls back to an in-memory ring buffer when the DB read
 * throws. A regression here would silently degrade the audit trail (Task
 * #722). Two paths are covered:
 *   1. DB throws → buffer fallback returned newest-first and capped by limit.
 *   2. DB succeeds → rows mapped through into ManualReserveAlertDispatch shape.
 */

import {
  getRecentManualReserveAlertDispatches,
  __resetManualReserveAlertDispatchesForTest,
  __pushManualReserveDispatchForTest,
  __test_setListManualReserveAlertDispatchesOverride,
  type ManualReserveAlertDispatch,
} from "../server/services/manualReserveAlerts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`Assertion failed: ${msg} (got ${String(a)}, expected ${String(b)})`);
}

function makeBufferEntry(ts: number, suffix: string): ManualReserveAlertDispatch {
  return {
    timestamp: ts,
    eventType: "alert",
    metric: `metric_${suffix}`,
    severity: "warning",
    message: `msg ${suffix}`,
    value: 1,
    threshold: 0,
    status: "sent",
    detail: null,
  };
}

async function testFallback(): Promise<void> {
  __resetManualReserveAlertDispatchesForTest();

  // Seed buffer in chronological insertion order: A < B < C < D < E.
  const base = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) {
    __pushManualReserveDispatchForTest(makeBufferEntry(base + i * 1000, String.fromCharCode(65 + i)));
  }

  // Force the DB-list helper to throw so the fallback runs.
  let calledWith: any = null;
  __test_setListManualReserveAlertDispatchesOverride(async (opts) => {
    calledWith = opts;
    throw new Error("simulated DB failure");
  });

  try {
    const result = await getRecentManualReserveAlertDispatches(3);

    // Override was actually invoked (otherwise the test would be vacuous).
    assert(calledWith !== null, "override should be called");
    assertEq(calledWith.limit, 3, "limit should be forwarded to DB helper");

    // Fallback returns the *most recent* entries, *newest-first*, capped by limit.
    assertEq(result.length, 3, "fallback should respect limit");
    assertEq(result[0].metric, "metric_E", "newest entry first");
    assertEq(result[1].metric, "metric_D", "second-newest entry next");
    assertEq(result[2].metric, "metric_C", "third-newest entry last");

    // Default limit (50) returns the entire buffer also reversed.
    const all = await getRecentManualReserveAlertDispatches();
    assertEq(all.length, 5, "default returns all 5 buffered entries");
    assertEq(all[0].metric, "metric_E", "default order also newest-first");
    assertEq(all[4].metric, "metric_A", "oldest buffered entry last");
  } finally {
    __test_setListManualReserveAlertDispatchesOverride(null);
    __resetManualReserveAlertDispatchesForTest();
  }
}

async function testHappyPath(): Promise<void> {
  __resetManualReserveAlertDispatchesForTest();

  // Seed a single buffer entry that should *not* be returned — DB success
  // wins.
  __pushManualReserveDispatchForTest(makeBufferEntry(1, "BUFFER_ONLY"));

  // Stub returns two rows in newest-first order (matching the real DB
  // helper's ORDER BY desc(timestamp)).
  const dbRows = [
    {
      id: 2,
      timestamp: 2_000n as unknown as number, // exercise BIGINT-as-bigint coercion
      eventType: "alert",
      metric: "manual_wait_p95_ms",
      severity: "critical",
      message: "p95 critical",
      value: 6000,
      threshold: 5000,
      status: "sent",
      detail: "delivered to #ops",
      mutedBy: null,
      muteReason: null,
      triggeredBy: "user_42",
      triggerSource: "admin_ui",
      isResend: true,
    },
    {
      id: 1,
      timestamp: 1_500,
      eventType: "transition",
      metric: "reserve_pressure_started",
      severity: "info",
      message: "pressure started",
      value: 0,
      threshold: 0,
      status: "transition",
      detail: null,
      mutedBy: null,
      muteReason: null,
      triggeredBy: null,
      triggerSource: null,
      isResend: false,
    },
  ];

  __test_setListManualReserveAlertDispatchesOverride(async () => dbRows as any);

  try {
    const result = await getRecentManualReserveAlertDispatches({ limit: 10, metric: "manual_wait_p95_ms" });

    assertEq(result.length, 2, "happy path returns DB rows, not buffer");
    // Order preserved from DB (newest-first).
    assertEq(result[0].metric, "manual_wait_p95_ms", "first row mapped from DB");
    assertEq(result[1].metric, "reserve_pressure_started", "second row mapped from DB");

    // Mapping shape matches ManualReserveAlertDispatch.
    const r0 = result[0];
    assertEq(typeof r0.timestamp, "number", "timestamp coerced to number");
    assertEq(r0.timestamp, 2000, "bigint timestamp value preserved");
    assertEq(r0.severity, "critical", "severity passes through");
    assertEq(r0.value, 6000, "value passes through");
    assertEq(r0.threshold, 5000, "threshold passes through");
    assertEq(r0.detail, "delivered to #ops", "detail passes through");
    assertEq(r0.triggeredBy, "user_42", "triggeredBy passes through");
    assertEq(r0.triggerSource, "admin_ui", "triggerSource passes through");
    assertEq(r0.isResend, true, "isResend passes through");

    const r1 = result[1];
    assertEq(r1.detail, null, "null detail preserved");
    assertEq(r1.triggeredBy, null, "null triggeredBy preserved");
    assertEq(r1.isResend, false, "isResend false preserved");

    // Buffer-only entry must NOT leak through on the happy path.
    assert(
      !result.some((r) => r.metric === "metric_BUFFER_ONLY"),
      "buffer entry should not appear when DB returns rows",
    );
  } finally {
    __test_setListManualReserveAlertDispatchesOverride(null);
    __resetManualReserveAlertDispatchesForTest();
  }
}

async function main(): Promise<void> {
  await testFallback();
  await testHappyPath();
  console.log("manual-reserve alert history fallback: OK");
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
