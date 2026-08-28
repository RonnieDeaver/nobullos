/* test-registration
{
  "name": "Onboarding intake — client+booking+Intel sequencing, notes never client-facing, partial-failure contract (Task #5297)",
  "scanPaths": [
    "server/services/onboardingIntake.ts",
    "server/routes/onboardingIntake.ts",
    "server/services/clientIntake.ts"
  ],
  "tier": "small",
  "tierReason": "Pure source-level + runtime-shape contract test, no DB or network — same style as onboarding-booking-wiring.test.ts.",
  "smoke": true,
  "smokeReason": "The only test covering the new combined intake endpoint (client creation → pool booking → Intel logging); no other smoke suite scans onboardingIntake.ts/onboardingIntake route, so without this the new code path has zero routine-gate coverage."
}
test-registration */
/**
 * Task #5297 — stage 3 of the New Client Onboarding epic. This pins the
 * contract that a full DB/HTTP integration test would be expensive to
 * re-verify on every change:
 *
 *   1. Client creation happens BEFORE booking is attempted (never book
 *      against a client that doesn't exist yet).
 *   2. The sales rep's private notes are NEVER passed into the booking call
 *      (`bookOnboardingSlot`'s `notes` param is client/invitee-facing — see
 *      `server/services/bookingScheduler.ts`) — only into the Intel entry.
 *   3. A booking failure after client creation reports `clientId` +
 *      `clientCreated: true` so the caller can render a recoverable error
 *      instead of a bare failure (the task's explicit "no silent gap"
 *      requirement).
 *   4. The Intel entry is created with `entryType: "meeting_takeaway"` and
 *      is never blocked by (or blocking) `requireCommandCenterAccess`'s
 *      sales-role read-only gate on the separate raw route.
 *   5. The new POST route is authenticated and rate-limited like the
 *      sibling booking-write route; the GET slots route has no `clientId`
 *      param (there is no single client yet at slot-picking time).
 *
 * A real end-to-end run is deliberately NOT exercised here (that would
 * create a live Zoom meeting / real client row — see
 * tests/onboarding-pool-availability.test.ts's header for why this whole
 * epic's booking-adjacent suites stay source/runtime-shape level instead).
 */

import * as fs from "fs";
import * as path from "path";

import { OnboardingAssignmentError } from "../server/services/onboardingBooking";
import * as scheduler from "../server/services/bookingScheduler";
import { onboardingIntakeBodySchema } from "../shared/models/onboarding";

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

const INTAKE_SVC = fs.readFileSync(
  path.join(process.cwd(), "server/services/onboardingIntake.ts"),
  "utf8",
);
const INTAKE_ROUTE = fs.readFileSync(
  path.join(process.cwd(), "server/routes/onboardingIntake.ts"),
  "utf8",
);
const CLIENT_INTAKE_SVC = fs.readFileSync(
  path.join(process.cwd(), "server/services/clientIntake.ts"),
  "utf8",
);

section("1. Client creation happens before booking is attempted");
{
  const createIdx = INTAKE_SVC.indexOf("createValidatedClient(");
  const bookIdx = INTAKE_SVC.indexOf("bookOnboardingSlot(");
  assert(createIdx > 0, "calls createValidatedClient");
  assert(bookIdx > createIdx, "createValidatedClient runs before bookOnboardingSlot");
  assert(
    /if\s*\(!clientResult\.ok\)\s*\{\s*return/.test(INTAKE_SVC),
    "a failed client creation returns immediately — never proceeds to book",
  );
}

section("1b. Product setup is initialized before booking, with recoverable failure");
{
  const createIdx = INTAKE_SVC.indexOf("createValidatedClient(");
  const setupIdx = INTAKE_SVC.indexOf("storage.upsertCommandPanel(");
  const bookIdx = INTAKE_SVC.indexOf("bookOnboardingSlot(");
  assert(setupIdx > createIdx && bookIdx > setupIdx, "Command Panel setup runs after client creation and before booking");
  assert(/code:\s*"onboarding_setup_failed"/.test(INTAKE_SVC), "setup failure has a machine-readable code");
  assert(/clientCreated:\s*true/.test(INTAKE_SVC.slice(setupIdx, bookIdx)), "setup failure exposes the saved client");
}

section("1c. Conditional setup validation is product-specific");
{
  const base = {
    firmName: "Example",
    contactEmail: "owner@example.test",
    notes: "Ready",
    startTimeUtc: "2031-01-01T12:00:00.000Z",
  };
  const invalid = onboardingIntakeBodySchema.safeParse({
    ...base,
    products: ["google_ads", "lsa", "webinar", "gbp"],
    gbpPlannedLocationCount: 2,
    gbpPlannedLocationCities: ["Dallas"],
  });
  assert(!invalid.success, "selected products reject missing budgets and incomplete GBP cities");
  if (!invalid.success) {
    const fields = invalid.error.flatten().fieldErrors;
    assert(!!fields.googleAdsBudget, "Google Ads budget error is tied to its field");
    assert(!!fields.lsaBudget, "LSA budget error is tied to its field");
    assert(!!fields.webinarBudget, "Webinar budget error is tied to its field");
    assert(!!fields.gbpPlannedLocationCities, "GBP city error is tied to its field");
  }
  const valid = onboardingIntakeBodySchema.safeParse({
    ...base,
    products: ["google_ads", "lsa", "webinar", "gbp"],
    googleAdsBudget: 1000,
    lsaBudget: 500,
    webinarBudget: 250,
    gbpPlannedLocationCount: 2,
    gbpPlannedLocationCities: ["Dallas", "Austin"],
  });
  assert(valid.success, "complete positive product setup passes validation");
}

section("2. Sales notes are NEVER passed to the booking call (client-facing field)");
{
  const bookIdx = INTAKE_SVC.indexOf("bookOnboardingSlot({");
  assert(bookIdx > 0, "bookOnboardingSlot call site found");
  const closeIdx = INTAKE_SVC.indexOf("});", bookIdx);
  const callWindow = INTAKE_SVC.slice(bookIdx, closeIdx);
  assert(
    !/\bnotes:\s*input\.notes/.test(callWindow),
    "the booking call does not forward input.notes (that field becomes the Zoom agenda / calendar description)",
  );
  assert(
    /invitee:\s*\{\s*email:\s*input\.contactEmail/.test(callWindow),
    "the booking call sets the invitee from the client's contact email",
  );
}

section("3. Intel entry uses the sales notes, tagged meeting_takeaway, tied to the new client");
{
  const parseIdx = INTAKE_SVC.indexOf("insertIntelligenceFeedEntrySchema.parse(");
  assert(parseIdx > 0, "parses an Intel entry via the shared insert schema");
  const closeIdx = INTAKE_SVC.indexOf("});", parseIdx);
  const window = INTAKE_SVC.slice(parseIdx, closeIdx);
  assert(/entryType:\s*["']meeting_takeaway["']/.test(window), "entryType is meeting_takeaway");
  assert(/body:\s*input\.notes/.test(window), "body is the sales rep's private notes");
  assert(/clientId:\s*client\.id/.test(window), "tied to the just-created client");
  assert(
    INTAKE_SVC.indexOf("storage.createIntelligenceFeedEntry(") > parseIdx,
    "actually persists the parsed entry",
  );
}

section("4. Booking failure after client creation reports clientId + clientCreated (recoverable, not silent)");
{
  const assignmentCatchIdx = INTAKE_SVC.indexOf("if (err instanceof OnboardingAssignmentError)");
  assert(assignmentCatchIdx > 0, "explicit catch branch for assignment-resolution failure");
  const assignmentWindow = INTAKE_SVC.slice(assignmentCatchIdx, assignmentCatchIdx + 500);
  assert(/clientId:\s*client\.id/.test(assignmentWindow), "assignment-failure body carries clientId");
  assert(/clientCreated:\s*true/.test(assignmentWindow), "assignment-failure body flags clientCreated: true");

  const bookingErrCatchIdx = INTAKE_SVC.indexOf("if (err instanceof scheduler.BookingError)");
  assert(bookingErrCatchIdx > 0, "explicit catch branch for scheduler.BookingError");
  const bookingErrWindow = INTAKE_SVC.slice(bookingErrCatchIdx, bookingErrCatchIdx + 500);
  assert(/clientId:\s*client\.id/.test(bookingErrWindow), "scheduler-error body carries clientId");
  assert(/clientCreated:\s*true/.test(bookingErrWindow), "scheduler-error body flags clientCreated: true");
}

section("5. A failed Intel write degrades to a warning, not a total failure (client+meeting already real)");
{
  const catchIdx = INTAKE_SVC.lastIndexOf("} catch (err: any) {");
  assert(catchIdx > 0, "Intel creation is wrapped in try/catch");
  const window = INTAKE_SVC.slice(catchIdx, catchIdx + 400);
  assert(/intelWarning\s*=/.test(window), "sets an intelWarning on failure");
  assert(
    /return\s*\{[\s\S]*ok:\s*true/.test(INTAKE_SVC.slice(catchIdx)),
    "still returns ok: true after an Intel failure (client + meeting stand)",
  );
}

section("6. Route auth/rate-limit gating matches the sibling booking-write route");
{
  const postIdx = INTAKE_ROUTE.indexOf('app.post("/api/onboarding/intake"');
  assert(postIdx > 0, "POST /api/onboarding/intake registered");
  const postLine = INTAKE_ROUTE.slice(postIdx, INTAKE_ROUTE.indexOf("\n", postIdx));
  assert(/isAuthenticated/.test(postLine), "POST requires isAuthenticated");
  assert(/writeLimiter/.test(postLine), "POST is rate-limited like the sibling booking route");

  const getIdx = INTAKE_ROUTE.indexOf('app.get("/api/onboarding/intake/slots"');
  assert(getIdx > 0, "GET /api/onboarding/intake/slots registered");
  const getLine = INTAKE_ROUTE.slice(getIdx, INTAKE_ROUTE.indexOf("\n", getIdx));
  assert(/isAuthenticated/.test(getLine), "GET requires isAuthenticated");
  assert(
    !/:clientId/.test(getIdx >= 0 ? INTAKE_ROUTE.slice(getIdx, getIdx + 60) : ""),
    "the slots route takes no clientId param — there is no single client yet at slot-picking time",
  );
}

section("7. Fail-closed on an unreachable calendar, mirroring the single-AM slots route");
{
  assert(
    /CalendarBusyUnavailableError/.test(INTAKE_ROUTE) && /503/.test(INTAKE_ROUTE),
    "calendar-unavailable during pool availability compute returns 503, not a false-empty slot list",
  );
}

section("8. Shared client-creation helper is reused, not duplicated");
{
  assert(
    /export async function createValidatedClient/.test(CLIENT_INTAKE_SVC),
    "clientIntake.ts exports the shared creation function",
  );
  assert(
    /import\s*\{\s*createValidatedClient\s*\}\s*from\s*["']\.\/clientIntake["']/.test(INTAKE_SVC),
    "onboardingIntake.ts imports the SAME function rather than reimplementing client creation",
  );
}

section("9. Error class shapes used by the orchestration (runtime)");
{
  const assignErr = new OnboardingAssignmentError("nobody free", "none_available", []);
  assert(assignErr instanceof Error, "OnboardingAssignmentError is an Error subclass");
  const bookingErr = new scheduler.BookingError("taken", "slot_taken");
  assert(bookingErr instanceof Error, "scheduler.BookingError is an Error subclass");
  assert(bookingErr.code === "slot_taken", "BookingError exposes a machine-readable code");
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
