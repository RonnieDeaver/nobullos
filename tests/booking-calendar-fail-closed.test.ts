/* test-registration
{
  "name": "Booking calendar fail closed (baseline triage, Task #3424)",
  "scanPaths": [
    "server/routes/booking.ts",
    "server/services/bookingAvailability.ts",
    "server/services/bookingScheduler.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #840 — round-14 regression test.
 *
 * Failure mode this test guards against:
 *   `fetchCalendarBusy` in `server/services/bookingAvailability.ts` used to
 *   `return []` from its catch block whenever the Google Calendar
 *   free/busy lookup threw — including when the AM was actively
 *   connected and the failure was a transient Google outage. That made
 *   the slot-list (and, more dangerously, the saga's pre-insert
 *   re-check) fail OPEN: any window the AM had marked busy could be
 *   silently offered as bookable, double-booking real meetings.
 *
 * The fix has three coupled parts that this test verifies all stay in
 * place:
 *
 *   1. `bookingAvailability.ts` exports `CalendarBusyUnavailableError`
 *      and `fetchCalendarBusy` THROWS that error (it does NOT return [])
 *      when `cred.status === "connected"` but the Google call rejects.
 *      Returning [] is reserved for cases where the AM has no connected
 *      credential — i.e. there is no calendar to consult — which is the
 *      only safe fail-open.
 *
 *   2. `bookingScheduler.ts` (the saga) catches
 *      `CalendarBusyUnavailableError` from BOTH `isSlotAvailable`
 *      re-checks (pre-lock and inside the advisory lock) and re-throws
 *      a `BookingError("...", "calendar_failure")` so the booking is
 *      refused before any Zoom or Calendar mutation.
 *
 *   3. The public slots HTTP route in `server/routes/booking.ts`
 *      catches `CalendarBusyUnavailableError` and returns
 *      `503 { code: "calendar_unavailable", retriable: true }` instead
 *      of a generic 500, so the booking page can render a "try again
 *      shortly" UI rather than silently rendering an unsafe slot list.
 *
 * Plus a small runtime check that the exported error class has the
 * expected shape (instanceof Error, name set, message embeds userId +
 * cause), so consumers that do `err instanceof CalendarBusyUnavailableError`
 * keep working.
 */

import * as fs from "fs";
import * as path from "path";

import { CalendarBusyUnavailableError } from "../server/services/bookingAvailability";

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

const AVAIL = fs.readFileSync(
  path.join(process.cwd(), "server/services/bookingAvailability.ts"),
  "utf8",
);
const SAGA = fs.readFileSync(
  path.join(process.cwd(), "server/services/bookingScheduler.ts"),
  "utf8",
);
const ROUTES = fs.readFileSync(
  path.join(process.cwd(), "server/routes/booking.ts"),
  "utf8",
);

section(
  "1. fetchCalendarBusy fails CLOSED on connected-but-errored Google free/busy",
);
{
  // The error class must be exported so the saga + HTTP routes can do
  // `err instanceof CalendarBusyUnavailableError` to translate it.
  assert(
    /export\s+class\s+CalendarBusyUnavailableError\s+extends\s+Error/.test(
      AVAIL,
    ),
    "exports CalendarBusyUnavailableError extends Error",
  );

  // Locate the fetchCalendarBusy function body and assert that:
  //   a) it returns [] for "no credential" / "not connected" (those are
  //      the only safe fail-open cases — there is no calendar to read);
  //   b) it THROWS CalendarBusyUnavailableError from the catch path
  //      (which can only be reached after we've confirmed the AM IS
  //      connected) instead of swallowing the error.
  const fnStart = AVAIL.indexOf("async function fetchCalendarBusy");
  assert(fnStart > 0, "fetchCalendarBusy function still present");

  // Heuristic: take the next ~2000 chars after the signature as the body
  // for substring checks (the function is small).
  const body = AVAIL.slice(fnStart, fnStart + 2000);

  assert(
    /cred\.status\s*!==\s*["']connected["']/.test(body) &&
      /return\s*\[\]/.test(body),
    "returns [] for not-connected credentials (safe fail-open)",
  );

  // The catch block must throw — NOT return [] — when the connected
  // AM's free/busy lookup errors. This is the actual regression bar:
  // a single `return [];` survival inside the try/catch would re-open
  // the original bug.
  const catchIdx = body.indexOf("} catch");
  assert(catchIdx > 0, "catch block exists in fetchCalendarBusy");
  const catchBlock = body.slice(catchIdx, catchIdx + 500);
  assert(
    /throw\s+new\s+CalendarBusyUnavailableError/.test(catchBlock),
    "catch path THROWS CalendarBusyUnavailableError (does not return [])",
  );
  assert(
    !/return\s*\[\]/.test(catchBlock),
    "catch path does NOT silently return [] on connected-AM failure",
  );
}

section("2. Booking saga translates the error to BookingError(calendar_failure)");
{
  assert(
    /CalendarBusyUnavailableError/.test(SAGA),
    "saga imports CalendarBusyUnavailableError",
  );

  // The saga must catch it from BOTH isSlotAvailable call sites — the
  // pre-lock check AND the post-lock recheck — otherwise a transient
  // Google outage between the two reads could still let the booking
  // through.
  const catches = SAGA.match(
    /err\s+instanceof\s+CalendarBusyUnavailableError/g,
  );
  assert(
    catches !== null && catches.length >= 2,
    "saga catches CalendarBusyUnavailableError from BOTH isSlotAvailable rechecks",
  );

  // Each catch must rethrow as BookingError with code 'calendar_failure'
  // so the route layer maps it to the same envelope as other calendar
  // failures (and so the AM-book + public-confirm endpoints both surface
  // a uniform "try again" response).
  const calendarFailureThrows = SAGA.match(
    /throw\s+new\s+BookingError\([^)]*"calendar_failure"/g,
  );
  assert(
    calendarFailureThrows !== null && calendarFailureThrows.length >= 2,
    "saga rethrows as BookingError(code='calendar_failure') in both branches",
  );
}

section("3. Public slots HTTP route returns 503 calendar_unavailable");
{
  assert(
    /CalendarBusyUnavailableError/.test(ROUTES),
    "booking routes import CalendarBusyUnavailableError",
  );

  // The slots route catch block must check for the typed error and
  // return a 503 with an explicit `code: "calendar_unavailable"`
  // payload so the booking page knows it's a transient calendar issue
  // (and can show a "try again shortly" UI), not a generic server
  // error.
  const slotsRouteIdx = ROUTES.indexOf("/api/public/booking/:slug/slots");
  assert(slotsRouteIdx > 0, "public slots route still registered");

  // Take a generous window around the route handler. (8000 chars: the
  // handler grew the endpoint_misrouted / calendar_reauth_required
  // branches ahead of the transient-503 branch, which pushed the 503
  // payload past the original 4000-char window.)
  const window = ROUTES.slice(slotsRouteIdx, slotsRouteIdx + 8000);
  assert(
    /err\s+instanceof\s+CalendarBusyUnavailableError/.test(window),
    "slots route catches CalendarBusyUnavailableError",
  );
  assert(
    /status\(503\)/.test(window) &&
      /code:\s*["']calendar_unavailable["']/.test(window),
    "slots route returns 503 with code='calendar_unavailable'",
  );
  assert(
    /retriable:\s*true/.test(window),
    "slots route flags the failure as retriable",
  );
}

section("4. CalendarBusyUnavailableError shape (runtime)");
{
  const cause = new Error("kaboom from google");
  const e = new CalendarBusyUnavailableError("user-abc", cause);
  assert(e instanceof Error, "is an Error subclass");
  assert(
    e instanceof CalendarBusyUnavailableError,
    "instanceof CalendarBusyUnavailableError still works after construction",
  );
  assert(
    e.name === "CalendarBusyUnavailableError",
    "name is CalendarBusyUnavailableError (stack traces stay legible)",
  );
  assert(
    e.userId === "user-abc",
    "userId is preserved on the error instance for log correlation",
  );
  assert(
    e.message.includes("user-abc") && e.message.includes("kaboom from google"),
    "message includes both the userId and the underlying cause text",
  );
}

console.log(`\nResult: ${passed} passed, ${failed} failed.`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
