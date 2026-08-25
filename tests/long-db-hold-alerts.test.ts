/* test-registration
{
  "name": "Long DB hold runtime alerts (Task #1731 Phase 4.3)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1731 (Pool epic Phase 4, spec 4.3) — DB hold duration guard tests.
 *
 * Exercises `recordDbHoldDuration` directly so we don't need to wedge a
 * real connection open for 10+ seconds. Covers:
 *   1. Hold under 10s is silent (no event, no warn, no critical).
 *   2. Hold between 10–30s is recorded as a warn-tier event.
 *   3. Hold ≥ 30s is recorded as critical AND attempts a Slack dispatch.
 *   4. Per-(pool,label) cooldown suppresses follow-up critical Slack
 *      dispatches.
 *   5. Exception-prefix labels are silently suppressed regardless of
 *      duration.
 */
import assert from "node:assert/strict";
import {
  recordDbHoldDuration,
  getActiveLongHoldAlerts,
  getRecentLongHolds,
  getLongHoldCounters,
  isLongHoldException,
  EXCEPTION_PREFIXES,
  __testHelpers,
} from "../server/services/longDbHoldAlerts";

interface DispatchCall {
  id: string;
  metadata: Record<string, unknown>;
  text: string;
}

function installDispatcherStub(calls: DispatchCall[]): void {
  __testHelpers.setDispatcherForTests(async (id, payload, opts) => {
    calls.push({
      id,
      metadata: (opts.metadata ?? {}) as Record<string, unknown>,
      text: payload.text,
    });
    return { delivered: true, status: "sent" };
  });
}

async function run(): Promise<void> {
  __testHelpers.resetState();
  // Force the kill switch ON so dispatch path actually runs in tests.
  __testHelpers.setKillSwitchForTests(() => true);

  // Use real wall-clock so getActiveLongHoldAlerts's 15-minute window
  // (computed against Date.now()) actually contains our test events.
  const T0 = Date.now();

  // ── Case 1: under 10s → silent ────────────────────────────────────
  let calls: DispatchCall[] = [];
  installDispatcherStub(calls);
  let r = recordDbHoldDuration({
    pool: "api",
    label: "route:GET /api/clients",
    durationMs: 5_000,
    now: T0,
  });
  assert.equal(r.tier, null);
  assert.equal(r.suppressedReason, "below_threshold");
  assert.equal(getRecentLongHolds().length, 0);
  assert.equal(getActiveLongHoldAlerts().length, 0);
  assert.equal(calls.length, 0);

  // ── Case 2: 10–30s → warn tier, no Slack ──────────────────────────
  r = recordDbHoldDuration({
    pool: "api",
    label: "route:GET /api/clients",
    durationMs: 15_000,
    callerLabel: "route:GET /api/clients",
    requestId: "req-abc",
    now: T0 + 1_000,
  });
  assert.equal(r.tier, "warn");
  assert.equal(getRecentLongHolds().length, 1);
  assert.equal(getRecentLongHolds()[0]!.tier, "warn");
  assert.equal(getActiveLongHoldAlerts().length, 0, "warn tier must not appear as active critical alert");
  assert.equal(calls.length, 0, "warn tier must not page Slack");
  let counters = getLongHoldCounters();
  assert.equal(counters.warn, 1);
  assert.equal(counters.critical, 0);

  // ── Case 3: ≥30s → critical + Slack dispatch ──────────────────────
  // Wait a microtask after the synchronous record path so the
  // fire-and-forget dispatch (Promise) has had a chance to resolve.
  r = recordDbHoldDuration({
    pool: "api",
    label: "route:POST /api/keywords/bulk",
    durationMs: 35_000,
    callerLabel: "route:POST /api/keywords/bulk",
    requestId: "req-xyz",
    now: T0 + 2_000,
  });
  assert.equal(r.tier, "critical");
  assert.equal(r.suppressedReason, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1, "critical tier must dispatch one Slack message");
  assert.equal(calls[0]!.id, "infra.database.hold_duration_critical");
  assert.equal(calls[0]!.metadata.tier, "critical");
  assert.equal(calls[0]!.metadata.pool, "api");
  assert.equal(calls[0]!.metadata.label, "route:POST /api/keywords/bulk");
  assert.equal(calls[0]!.metadata.durationMs, 35_000);
  assert.match(calls[0]!.text, /35\.0s/);
  assert.equal(getActiveLongHoldAlerts().length, 1);
  counters = getLongHoldCounters();
  assert.equal(counters.critical, 1);
  assert.equal(counters.slackDispatched, 1);

  // ── Case 4: cooldown suppresses follow-up critical for same key ──
  r = recordDbHoldDuration({
    pool: "api",
    label: "route:POST /api/keywords/bulk",
    durationMs: 40_000,
    now: T0 + 32_000, // 30s later, well within 5min cooldown
  });
  assert.equal(r.tier, "critical");
  assert.equal(r.suppressedReason, "cooldown");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "second critical within cooldown must NOT dispatch");
  counters = getLongHoldCounters();
  assert.equal(counters.slackSuppressedCooldown, 1);

  // After the cooldown window the same key fires again.
  r = recordDbHoldDuration({
    pool: "api",
    label: "route:POST /api/keywords/bulk",
    durationMs: 31_000,
    now: T0 + 2_000 + __testHelpers.COOLDOWN_MS + 1_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.tier, "critical");
  assert.equal(r.suppressedReason, undefined);
  assert.equal(calls.length, 2, "past cooldown the same key dispatches again");

  // ── Case 5: exception-prefix label suppresses both tiers ──────────
  // The "probe" prefix is always exempt; verify the helper agrees and
  // the record path counts it as suppressed.
  const probeException = isLongHoldException("probe:health-roundtrip");
  assert.ok(probeException, "probe prefix must match the exception list");
  const beforeException = getLongHoldCounters().exceptionSuppressed;
  r = recordDbHoldDuration({
    pool: "probe",
    label: "probe:health-roundtrip",
    durationMs: 45_000,
    now: T0 + 10_000,
  });
  assert.equal(r.tier, null);
  assert.equal(r.suppressedReason, "exception");
  assert.equal(r.exception?.prefix, "probe");
  assert.equal(getLongHoldCounters().exceptionSuppressed, beforeException + 1);

  // Exception override: install a fake exception list and confirm a
  // previously-non-exempt label now bypasses the guard.
  const fakeException = [
    {
      prefix: "test:long-by-design",
      reason: "test fixture",
      expectedMaxMs: 60_000,
      owner: "test",
      reviewDate: "2099-01-01",
    },
  ];
  __testHelpers.setExceptionsForTests(fakeException);
  r = recordDbHoldDuration({
    pool: "api",
    label: "test:long-by-design",
    durationMs: 60_000,
    now: T0 + 20_000,
  });
  assert.equal(r.tier, null);
  assert.equal(r.suppressedReason, "exception");

  // ── Case 6: kill switch OFF disables Slack but still records event ─
  __testHelpers.setExceptionsForTests(null);
  __testHelpers.setKillSwitchForTests(() => false);
  const slackDispatchedBefore = getLongHoldCounters().slackDispatched;
  const callsBefore = calls.length;
  r = recordDbHoldDuration({
    pool: "worker",
    label: "worker:rollup",
    durationMs: 33_000,
    now: T0 + 30_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.tier, "critical");
  // The event is recorded (and the structured-critical log is emitted)
  // but the Slack dispatch is suppressed because the kill switch is OFF.
  assert.equal(calls.length, callsBefore, "kill switch OFF must suppress dispatch");
  assert.equal(getLongHoldCounters().slackDispatched, slackDispatchedBefore);
  assert.ok(getLongHoldCounters().slackSuppressedDisabled >= 1);

  // ── Sanity: hard-coded exception list documents every entry ───────
  for (const ex of EXCEPTION_PREFIXES) {
    assert.ok(ex.prefix.length > 0, "exception prefix must not be empty");
    assert.ok(ex.reason.length > 0, "every exception must document why");
    assert.ok(ex.owner.length > 0, "every exception must name an owner");
    assert.ok(ex.expectedMaxMs > 0, "every exception must declare an expected upper bound");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(ex.reviewDate), "review date must be YYYY-MM-DD");
  }

  __testHelpers.resetState();
  console.log("long-db-hold-alerts.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
