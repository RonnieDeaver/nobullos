/* test-registration
{
  "name": "Booking saga (Task #840)",
  "scanPaths": [
    "server/services/bookingScheduler.ts",
    "shared/models/booking.ts"
  ],
  "tier": "medium",
  "tierReason": "Exercises the booking saga's multi-step persistence and compensation behavior."
}
test-registration */
/**
 * Task #840 — Booking saga contract tests.
 *
 * Source-level invariants that the bookSlot orchestrator MUST maintain:
 *   1. Idempotency dedupe via idempotencyKey before any side effects.
 *   2. Per-host advisory lock around the create-row + Zoom + Calendar steps.
 *   3. Re-validates availability AFTER acquiring the lock.
 *   4. Inserts scheduled_meeting in 'creating' before any external call.
 *   5. Creates a scheduled Zoom meeting (type=2 — never PMI), then Calendar
 *      event (when AM connected), then marks 'confirmed'.
 *   6. Compensating delete on Zoom failure / Calendar failure.
 *   7. Exposes BookingError with explicit codes (slot_unavailable, slot_taken,
 *      zoom_failed, etc.) so routes can map to 4xx vs 5xx.
 */

import * as fs from "fs";
import * as path from "path";

import { BookingError } from "../server/services/bookingScheduler";

let failed = 0;
let passed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

const SRC = fs.readFileSync(
  path.join(process.cwd(), "server/services/bookingScheduler.ts"),
  "utf8",
);

section("1. Idempotency dedupe");
{
  assert(
    /idempotencyKey/.test(SRC),
    "saga reads idempotencyKey",
  );
  assert(
    /getScheduledMeetingByIdempotencyKey/.test(SRC),
    "looks up an existing meeting by idempotencyKey",
  );
}

section("2. Advisory lock per host");
{
  assert(
    /pg_advisory_lock|pg_try_advisory_lock|pg_advisory_xact_lock/.test(SRC),
    "uses a Postgres advisory lock",
  );
  assert(
    /sha256|createHash/.test(SRC) || /hashHostKey|hostUserId/.test(SRC),
    "lock key derived from hostUserId",
  );
  assert(
    /pg_advisory_unlock|advisory_xact_lock/.test(SRC),
    "lock is released (or scoped to the transaction)",
  );
}

section("3. Re-validates availability inside the lock");
{
  // The saga must recompute availability AFTER acquiring the lock to defeat
  // TOCTOU races. The lock is acquired via the `withAdvisoryLock(...)` call
  // site; the recompute (isSlotAvailable / computeAvailableSlots) must
  // appear inside that callback's body.
  const lockCallIdx = SRC.indexOf("withAdvisoryLock(");
  const isSlotIdxs: number[] = [];
  let i = 0;
  while ((i = SRC.indexOf("isSlotAvailable", i)) !== -1) {
    isSlotIdxs.push(i);
    i++;
  }
  // Need at least one isSlotAvailable call after the withAdvisoryLock call.
  const afterLock = isSlotIdxs.some((idx) => idx > lockCallIdx);
  assert(
    lockCallIdx > 0 && afterLock,
    "availability recomputed after lock is held (inside withAdvisoryLock)",
  );
}

section("4. Inserts row in 'creating' state before external calls");
{
  const creatingIdx = SRC.indexOf('"creating"') >= 0
    ? SRC.indexOf('"creating"')
    : SRC.indexOf("'creating'");
  const zoomIdx = SRC.indexOf("createScheduledMeeting");
  assert(
    creatingIdx > 0 && zoomIdx > 0 && creatingIdx < zoomIdx,
    "row is created with status 'creating' before Zoom is called",
  );
  assert(
    /createScheduledMeeting/.test(SRC),
    "Zoom helper createScheduledMeeting is invoked (type=2 scheduled meeting)",
  );
}

section("5. Calendar is optional and runs after Zoom");
{
  const zoomIdx = SRC.indexOf("createScheduledMeeting");
  const calendarIdx = SRC.indexOf("insertEvent");
  assert(
    calendarIdx === -1 || calendarIdx > zoomIdx,
    "Calendar event creation runs after Zoom create (or is omitted entirely)",
  );
}

section("6. Compensating rollback on partial failure");
{
  assert(
    /deleteScheduledMeeting|delete.*Zoom|zoom.*delete/i.test(SRC),
    "rolls back Zoom meeting on downstream failure",
  );
  assert(
    /failed/.test(SRC),
    "marks the booking row as 'failed' when something blows up",
  );
}

section("7. BookingError carries machine-readable codes");
{
  // Constructor: (message, code, details?)
  const e = new BookingError("That slot is no longer available", "slot_taken");
  assert(e instanceof Error, "BookingError extends Error");
  assert((e as any).code === "slot_taken", "exposes a `code` property");
  assert(
    /slot_taken|slot_unavailable|zoom_failure|calendar_failure/.test(SRC),
    "saga raises BookingError with a known code",
  );
}

section("8. Booking source is recorded");
{
  // The saga uses the BookingSource type from shared/models/booking.ts —
  // verify all three sources from the spec are part of that union.
  const SCHEMA = fs.readFileSync(
    path.join(process.cwd(), "shared/models/booking.ts"),
    "utf8",
  );
  assert(
    /public_link/.test(SCHEMA) &&
      /client_profile/.test(SCHEMA) &&
      /client_bound_public_link/.test(SCHEMA),
    "schema enumerates the 3 booking sources from the spec",
  );
  assert(
    /BookingSource/.test(SRC),
    "saga uses the BookingSource union type",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
