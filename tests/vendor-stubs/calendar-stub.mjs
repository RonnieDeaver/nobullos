// Shared Google Calendar vendor test stub for
// `server/services/googleCalendarIntegration` (Task #5313 — shared vendor
// test stubs instead of one-off; promoted verbatim from the one-off stub
// built for Task #5298's onboarding end-to-end test).
//
// `bookingScheduler.bookSlot` REQUIRES a connected + configured Google
// Calendar (Task #5296/#4nnn saga) — not best-effort — so a real booking
// success needs `isGoogleCalendarConfigured()` to read true (no
// GOOGLE_CALENDAR_CLIENT_ID/SECRET exist in this environment) and
// `insertEvent` to succeed without a live Google API call. Once a test user
// has a `status: "connected"` credential row, `bookingAvailability.ts`'s
// `fetchCalendarBusy` ALSO starts calling `getFreeBusy` for that user on
// every availability/resolution check (and fail-CLOSED — throws, not []) —
// so `getFreeBusy` must be stubbed too, or every "connected" candidate
// looks calendar-unreachable and gets marked unavailable. Re-exports the
// real module verbatim and overrides just those three.
//
// See TESTING.md, "Shared vendor test stubs", for the convention and for
// how a suite's resolve-hook loader wires this in.
//
// Consuming suites:
//   - onboarding-e2e-full-chain.test.ts (Task #5298, stage 4 of the New
//     Client Onboarding epic)

export * from "../../server/services/googleCalendarIntegration";

let seq = 0;

export function isGoogleCalendarConfigured() {
  return true;
}

export async function getFreeBusy(_userId, _fromUtc, _toUtc, _calendarIds, _opts) {
  // No real Google Calendar exists for these test users — report no busy
  // intervals. `scheduled_meetings` (checked separately, for real) remains
  // the sole source of "busy" truth this test exercises.
  return [];
}

export async function insertEvent(_userId, _calendarId, _input) {
  seq += 1;
  const id = `stub-gcal-event-${seq}`;
  return {
    id,
    htmlLink: `https://calendar.onboarding-e2e.test/event/${id}`,
    iCalUID: null,
    raw: null,
  };
}
