/* test-registration
{
  "name": "Booking schema readiness alerts (Task #1103)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1103 regression tests: booking-schema readiness Slack alert.
 *
 * Stubs both the readiness probe and the dispatcher so no real DB
 * probe or Slack call is touched. Drives the watcher through:
 *   (a) first observation = baseline only, never alerts,
 *   (b) ready=true → false fires `unhealthy` with operatorAction +
 *       missing tables/constraints,
 *   (c) staying unhealthy across ticks does NOT re-fire,
 *   (d) ready=false → true fires `recovered`,
 *   (e) kill switch suppresses both directions but still moves the
 *       baseline so re-enabling doesn't fire a stale alert.
 *
 * Registered in tests/run-all.ts.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  checkBookingSchemaReadinessAlert,
  __testHelpers,
  SETTING_ENABLED,
} from "../server/services/bookingSchemaReadinessAlerts";
import type { BookingSchemaReadiness } from "../server/services/bookingSchemaReadiness";

interface DispatchCall {
  text: string;
  metadata: Record<string, unknown>;
}

async function cleanup(): Promise<void> {
  try {
    await storage.deleteSystemSetting(SETTING_ENABLED);
  } catch {}
  __testHelpers.resetForTests();
}

function readySnap(): BookingSchemaReadiness {
  return {
    tables: {
      bookingPages: true,
      bookingAvailabilityRules: true,
      bookingAvailabilityOverrides: true,
      scheduledMeetings: true,
      googleCalendarCredentials: true,
      bookingClientTokens: true,
    },
    constraints: {
      bookingPagesAccountManagerUnique: true,
      scheduledMeetingsNoOverlap: true,
    },
    ready: true,
    lastCheckedAt: new Date().toISOString(),
  };
}

function unhealthySnap(opts?: { lastError?: string }): BookingSchemaReadiness {
  return {
    tables: {
      bookingPages: false,
      bookingAvailabilityRules: true,
      bookingAvailabilityOverrides: true,
      scheduledMeetings: false,
      googleCalendarCredentials: true,
      bookingClientTokens: true,
    },
    constraints: {
      bookingPagesAccountManagerUnique: true,
      scheduledMeetingsNoOverlap: false,
    },
    ready: false,
    lastCheckedAt: new Date().toISOString(),
    lastError: opts?.lastError,
  };
}

/**
 * Constraint-only regression: every required table is still present
 * (so `BookingSchemaReadiness.ready` stays true) but one of the
 * EXCLUDE / UNIQUE constraints has disappeared. The watcher must
 * still treat this as unhealthy because the booking saga then runs
 * in a degraded mode (only the application-level advisory lock
 * prevents double-booking).
 */
function constraintOnlyRegressionSnap(): BookingSchemaReadiness {
  return {
    tables: {
      bookingPages: true,
      bookingAvailabilityRules: true,
      bookingAvailabilityOverrides: true,
      scheduledMeetings: true,
      googleCalendarCredentials: true,
      bookingClientTokens: true,
    },
    constraints: {
      bookingPagesAccountManagerUnique: true,
      scheduledMeetingsNoOverlap: false,
    },
    // `ready` here is `true` because the cached snapshot in
    // bookingSchemaReadiness.ts derives `ready` from table presence
    // only — this is the exact pre-Task-#1103-fix gap the watcher
    // must NOT inherit.
    ready: true,
    lastCheckedAt: new Date().toISOString(),
  };
}

function installDispatcherStub(calls: DispatchCall[]): void {
  __testHelpers.setDispatcherForTests(async (_id, payload, opts) => {
    calls.push({
      text: payload.text,
      metadata: (opts.metadata ?? {}) as Record<string, unknown>,
    });
    return { delivered: true, status: "sent" };
  });
}

async function run(): Promise<void> {
  await cleanup();
  await storage.setSystemSetting(SETTING_ENABLED, "true", "system");

  // ── (a) First observation seeds baseline, no alert ───────────────
  let snap: BookingSchemaReadiness = readySnap();
  __testHelpers.setProbeForTests(async () => snap);
  const calls: DispatchCall[] = [];
  installDispatcherStub(calls);

  let r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_baseline_seeded", "first tick must seed baseline");
  assert.equal(calls.length, 0, "no Slack call on baseline seeding");
  assert.equal(__testHelpers.getLastReady(), true);

  // ── No transition while ready stays true ──────────────────────────
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_no_transition");
  assert.equal(calls.length, 0);

  // ── (b) ready=true → false fires unhealthy ────────────────────────
  snap = unhealthySnap({ lastError: 'relation "booking_pages" does not exist' });
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "alerted_unhealthy");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.text, /Booking schema is unhealthy/);
  assert.match(calls[0]!.text, /Apply booking migrations 0034-0036\./);
  assert.match(calls[0]!.text, /booking_pages/);
  assert.match(calls[0]!.text, /scheduled_meetings/);
  assert.match(calls[0]!.text, /scheduled_meetings_no_overlap/);
  assert.match(calls[0]!.text, /relation "booking_pages" does not exist/);
  assert.equal(calls[0]!.metadata.event, "unhealthy");
  assert.equal(calls[0]!.metadata.ready, false);
  assert.equal(calls[0]!.metadata.previousReady, true);
  assert.deepEqual(calls[0]!.metadata.missingTables, [
    "booking_pages",
    "scheduled_meetings",
  ]);
  assert.deepEqual(calls[0]!.metadata.missingConstraints, [
    "scheduled_meetings_no_overlap",
  ]);
  assert.equal(__testHelpers.getLastReady(), false);

  // ── (c) Staying unhealthy across ticks does NOT re-fire ───────────
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_no_transition");
  assert.equal(calls.length, 1, "must not re-fire while still unhealthy");

  // ── (d) ready=false → true fires recovered ────────────────────────
  snap = readySnap();
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "alerted_recovered");
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.text, /Booking schema recovered/);
  assert.equal(calls[1]!.metadata.event, "recovered");
  assert.equal(__testHelpers.getLastReady(), true);

  // ── (e) Kill switch suppresses but still advances baseline ────────
  await cleanup();
  await storage.setSystemSetting(SETTING_ENABLED, "false", "system");
  snap = readySnap();
  __testHelpers.setProbeForTests(async () => snap);
  const callsB: DispatchCall[] = [];
  installDispatcherStub(callsB);

  // Seed baseline.
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_baseline_seeded");

  // Flip to unhealthy with kill switch off — must skip + advance baseline.
  snap = unhealthySnap();
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_disabled");
  assert.equal(callsB.length, 0);
  assert.equal(__testHelpers.getLastReady(), false);

  // Re-enable; ready stays false → no transition, no stale alert.
  await storage.setSystemSetting(SETTING_ENABLED, "true", "system");
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_no_transition");
  assert.equal(callsB.length, 0, "must not fire a stale alert when re-enabled");

  // Flip back to ready while enabled → fires recovered.
  snap = readySnap();
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "alerted_recovered");
  assert.equal(callsB.length, 1);
  assert.match(callsB[0]!.text, /Booking schema recovered/);

  // ── Constraint-only regression must also fire unhealthy ──────────
  // This is the gap the code review caught: `BookingSchemaReadiness.ready`
  // is computed from table presence only, so a missing EXCLUDE / UNIQUE
  // constraint would NOT flip `snap.ready`. The watcher must apply its
  // own stricter "fully healthy" predicate.
  await cleanup();
  await storage.setSystemSetting(SETTING_ENABLED, "true", "system");
  snap = readySnap();
  __testHelpers.setProbeForTests(async () => snap);
  const callsD: DispatchCall[] = [];
  installDispatcherStub(callsD);

  // Seed baseline = fully healthy.
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_baseline_seeded");
  assert.equal(__testHelpers.getLastReady(), true);

  // Drop only `scheduled_meetings_no_overlap` — `snap.ready` stays
  // true but the watcher must fire because the constraint is gone.
  snap = constraintOnlyRegressionSnap();
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "alerted_unhealthy", "constraint-only regression must fire unhealthy");
  assert.equal(callsD.length, 1);
  assert.match(callsD[0]!.text, /Booking schema is unhealthy/);
  assert.match(callsD[0]!.text, /scheduled_meetings_no_overlap/);
  assert.deepEqual(callsD[0]!.metadata.missingTables, []);
  assert.deepEqual(callsD[0]!.metadata.missingConstraints, [
    "scheduled_meetings_no_overlap",
  ]);
  assert.equal(__testHelpers.getLastReady(), false);

  // No re-fire while constraint stays missing.
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_no_transition");
  assert.equal(callsD.length, 1);

  // Restoring the constraint must fire `recovered`.
  snap = readySnap();
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "alerted_recovered", "constraint restore must fire recovered");
  assert.equal(callsD.length, 2);
  assert.match(callsD[1]!.text, /Booking schema recovered/);
  assert.equal(__testHelpers.getLastReady(), true);

  // ── Dispatcher failure on unhealthy keeps lastReady=true so we retry
  await cleanup();
  await storage.setSystemSetting(SETTING_ENABLED, "true", "system");
  snap = readySnap();
  __testHelpers.setProbeForTests(async () => snap);
  __testHelpers.setDispatcherForTests(async () => ({
    delivered: false,
    status: "failed",
    skipReason: "channel_not_configured",
  }));
  await checkBookingSchemaReadinessAlert(); // seed baseline
  snap = unhealthySnap();
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "skipped_dispatcher_skipped");
  assert.equal(__testHelpers.getLastReady(), true, "must keep retrying unhealthy");

  // Now succeed on next tick.
  const callsC: DispatchCall[] = [];
  installDispatcherStub(callsC);
  r = await checkBookingSchemaReadinessAlert();
  assert.equal(r.decision, "alerted_unhealthy");
  assert.equal(callsC.length, 1);
  assert.equal(__testHelpers.getLastReady(), false);

  await cleanup();
  console.log("booking-schema-readiness-alerts.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {}
    process.exitCode = 1;
  });
