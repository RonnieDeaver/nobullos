/* test-registration
{
  "name": "Onboarding pool booking wired to the resolved assignee (Task #5296)",
  "scanPaths": [
    "server/services/onboardingBooking.ts",
    "shared/models/booking.ts"
  ],
  "tier": "small",
  "tierReason": "Pure source-level + runtime-shape contract test, no DB or network — same style as booking-saga.test.ts."
}
test-registration */
/**
 * Task #5296 — step 3 of the spec ("wire meeting creation to the resolved
 * assignee"): once `resolveOnboardingAssignee` picks exactly one person,
 * `bookOnboardingSlot` must create the meeting UNDER THAT PERSON — Zoom
 * host, Google Calendar event ownership, and the `scheduled_meetings`
 * AM/host field — the same way single-AM booking creation already does.
 *
 * `scheduler.bookSlot` already threads host identity purely through
 * `req.host.hostUserId` (confirmed by reading `createBookingTransactional`
 * — Zoom host resolution and the Google Calendar credential lookup both
 * key off `hostUser = storage.getUser(req.host.hostUserId)`, independent
 * of `req.page.accountManagerUserId`). So nothing inside
 * `bookingScheduler.ts` needed to change for this stage; what this test
 * pins is that the NEW onboarding orchestration layer actually passes the
 * resolved assignee — not the page owner, not a fixed AM — as that host.
 *
 * A real successful `bookSlot()` call is deliberately NOT exercised here
 * (that would create a live Zoom meeting with real service credentials —
 * see tests/onboarding-pool-availability.test.ts's header for why the
 * DB-backed suite stops at the pre-flight resolution guard instead).
 */

import * as fs from "fs";
import * as path from "path";

import { OnboardingAssignmentError } from "../server/services/onboardingBooking";

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
  path.join(process.cwd(), "server/services/onboardingBooking.ts"),
  "utf8",
);
const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "shared/models/booking.ts"),
  "utf8",
);

section("1. bookOnboardingSlot resolves BEFORE calling the scheduler");
{
  const resolveIdx = SRC.indexOf("resolveOnboardingAssignee(req.startTimeUtc");
  const bookSlotIdx = SRC.indexOf("scheduler.bookSlot(");
  assert(resolveIdx > 0, "calls resolveOnboardingAssignee");
  assert(bookSlotIdx > resolveIdx, "resolution happens before scheduler.bookSlot is called");
  assert(
    /if\s*\(!resolution\.ok\)/.test(SRC) &&
      /throw new OnboardingAssignmentError/.test(SRC),
    "throws OnboardingAssignmentError when resolution fails, never proceeds to book",
  );
}

section("2. The RESOLVED assignee — not the page owner, not a fixed AM — becomes the host");
{
  const bookSlotIdx = SRC.indexOf("scheduler.bookSlot(");
  assert(bookSlotIdx > 0, "scheduler.bookSlot call site found");
  const callWindow = SRC.slice(bookSlotIdx, bookSlotIdx + 700);
  assert(
    /hostUserId:\s*hostUser\.id/.test(callWindow),
    "host.hostUserId is set from the resolved assignee's own user record",
  );
  // hostUser must itself be loaded via resolution.userId, not a page or
  // roster default constant.
  const hostUserIdx = SRC.indexOf("storage.getUser(resolution.userId)");
  assert(hostUserIdx > 0 && hostUserIdx < bookSlotIdx, "hostUser is loaded from resolution.userId before booking");
  assert(
    /page:\s*resolution\.page/.test(callWindow),
    "the booking page passed to the scheduler is the RESOLVED assignee's own page",
  );
}

section("3. Booking source is recorded distinctly from single-AM sources");
{
  assert(
    /source:\s*["']onboarding_pool["']/.test(SRC),
    "bookOnboardingSlot tags the booking with source='onboarding_pool'",
  );
  assert(
    /"onboarding_pool"/.test(SCHEMA) && /bookingSources/.test(SCHEMA),
    "shared bookingSources union includes 'onboarding_pool'",
  );
  assert(
    /"client_profile"/.test(SCHEMA) &&
      /"public_link"/.test(SCHEMA) &&
      /"client_bound_public_link"/.test(SCHEMA),
    "the 3 pre-existing single-AM booking sources are still present (additive, not replaced)",
  );
}

section("4. resolvedUserId is sourced from the PERSISTED meeting row");
{
  // Task #5296 design: reading result.meeting.accountManagerUserId (with a
  // fallback to resolution.userId) rather than trusting the pre-call
  // resolution variable directly protects correctness under bookSlot's own
  // idempotency-key dedupe (a replayed call could resolve to someone else
  // in principle, but the actually-persisted row is ground truth).
  const returnIdx = SRC.lastIndexOf("resolvedUserId:");
  assert(returnIdx > 0, "bookOnboardingSlot returns a resolvedUserId field");
  const window = SRC.slice(returnIdx, returnIdx + 200);
  assert(
    /result\.meeting\.accountManagerUserId/.test(window),
    "resolvedUserId is read from the persisted meeting row (result.meeting.accountManagerUserId), not the pre-call variable alone",
  );
}

section("5. OnboardingAssignmentError shape (runtime)");
{
  const e = new OnboardingAssignmentError("nobody free", "none_available", [
    { userId: "u1", isDefault: true, available: false },
  ]);
  assert(e instanceof Error, "is an Error subclass");
  assert(e.name === "OnboardingAssignmentError", "name is set for legible stack traces");
  assert(e.reason === "none_available", "exposes the machine-readable reason");
  assert(Array.isArray(e.attempts) && e.attempts.length === 1, "exposes the per-candidate attempts for diagnostics");
  assert(
    e instanceof OnboardingAssignmentError,
    "instanceof check works after construction (distinct from scheduler.BookingError's fixed code union)",
  );
}

section("6. Calendar-unavailable candidates never silently count as available");
{
  assert(
    /CalendarBusyUnavailableError/.test(SRC),
    "resolveOnboardingAssignee imports/handles CalendarBusyUnavailableError",
  );
  const catchIdx = SRC.indexOf("if (err instanceof CalendarBusyUnavailableError)");
  assert(catchIdx > 0, "explicit catch branch for calendar failures during resolution");
  const catchWindow = SRC.slice(catchIdx, catchIdx + 400);
  assert(
    /available:\s*false/.test(catchWindow),
    "a calendar-check failure is recorded as unavailable (fail-closed for that candidate), not skipped as a false positive",
  );
  assert(
    /continue/.test(catchWindow),
    "resolution continues to the next candidate rather than aborting the whole pool on one calendar error",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
