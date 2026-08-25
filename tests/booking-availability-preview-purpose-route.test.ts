/* test-registration
{
  "name": "Booking availability preview routes use non-authoritative calendar purpose (Task #2375)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2375 — Confirm the booking availability PREVIEW routes never
 * falsely disconnect a still-valid Google Calendar, while the real
 * booking WRITE path still commits a disconnect when the calendar is
 * genuinely dead.
 *
 * Background
 * ----------
 * Task #2286/#2360 added purpose-gating INSIDE the Google Calendar
 * service (`getFreeBusy` → `calendarRequest`): a NON-authoritative read
 * (purpose `probe`/`proactive`) that hits a terminal `invalid_grant`
 * 401/403 fails-closed (throws) but must NOT persist
 * `status:"disconnected"` on the credential row — otherwise a single
 * availability-preview view, racing a refresh-token rotation, would force
 * the AM to reconnect a perfectly healthy calendar. Only an authoritative,
 * on-demand caller (a real booking saga re-check — the default purpose)
 * may commit the disconnect. The service-level companion
 * (`tests/google-calendar-health-check-no-disconnect.test.ts`) pins that
 * gating directly on `getFreeBusy`.
 *
 * That protection only helps if the actual ROUTE call sites genuinely
 * pass a non-authoritative purpose down to `getFreeBusy`. There was no
 * test pinning that contract at the route layer — a future refactor could
 * drop the purpose and silently re-introduce the false-disconnect bug
 * even though the service-level gating stays correct.
 *
 * What this test pins
 * -------------------
 * Rather than reaching into the service to read the literal purpose string
 * (there is no test seam for that, and module-mocking is not yet supported
 * by the runner), this exercises each route end-to-end and asserts the
 * BEHAVIOR that "non-authoritative purpose" actually means: a transient
 * auth blip during the preview leaves the credential connected.
 *
 *   1. Public slots preview         GET /api/book/:slug/slots
 *   2. AM/settings slots preview    GET /api/booking/me/slots-preview
 *   3. AM client slots preview      GET /api/booking/clients/:clientId/slots
 *
 *      Each is driven against a CONNECTED credential whose live free/busy
 *      call returns a terminal 403 `invalid_grant`. The route must
 *      fail-closed (no 200 slot list) AND make a real free/busy call, but
 *      MUST NOT write any credential status — proving it passed a
 *      non-authoritative purpose to `getFreeBusy`.
 *
 *   4. Real write path              bookSlot(...) saga re-check
 *
 *      Conversely, the booking saga's pre-insert availability re-check
 *      uses the DEFAULT (authoritative) purpose. The same 403 blip MUST
 *      flip the credential to `status:"disconnected"` (and the saga must
 *      refuse the booking with a `calendar_failure` BookingError).
 *
 * Setup is pure in-memory: the `storage` singleton's booking/credential
 * methods are swapped for stubs and `fetch` is intercepted for the Google
 * Calendar free/busy endpoint. The authenticated AM routes' schema-readiness
 * gate is cleared via the test-only `__setBookingSchemaReadinessForTest`
 * seam, so the whole test runs with zero DB dependency.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.GOOGLE_CALENDAR_CLIENT_ID =
  process.env.GOOGLE_CALENDAR_CLIENT_ID || "test_gcal_client_id";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET =
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "test_gcal_client_secret";

import express from "express";
import type { AddressInfo } from "net";

import { registerBookingRoutes } from "../server/routes/booking";
import { bookSlot, BookingError } from "../server/services/bookingScheduler";
import { __setBookingSchemaReadinessForTest } from "../server/services/bookingSchemaReadiness";
import { storage } from "../server/storage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { encryptToken } from "../server/utils/tokenCrypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

const USER_ID = "user-2375-availability-preview";
const SLUG = "am-2375";
const CLIENT_ID = "client-2375";

const PAGE = {
  id: "page-2375",
  accountManagerUserId: USER_ID,
  slug: SLUG,
  timezone: "America/Chicago",
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  active: true,
  allowRecurring: false,
  title: null,
  description: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as any;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory stubs
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const s = storage as any;
const originals: Record<string, any> = {};

/** Captured `updateGoogleCalendarCredential` patches for the case under run. */
let updates: Array<Record<string, any>> = [];
/** How many times the live Google free/busy endpoint was actually hit. */
let freeBusyHits = 0;

function saveOriginal(name: string): void {
  if (!(name in originals)) originals[name] = s[name];
}

/**
 * 403 = terminal auth blip that lands directly in `calendarRequest`'s
 * 401/403 block (no retry-on-401 recursion), isolating the live
 * auth-blip handler a preview / re-check triggers. The token endpoint
 * must never be hit because the seeded access token is still valid.
 */
function installStubs(): void {
  updates = [];
  freeBusyHits = 0;

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith(GOOGLE_FREEBUSY_URL)) {
      freeBusyHits++;
      return new Response(
        JSON.stringify({ error: { errors: [{ reason: "invalid_grant" }] } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      throw new Error(
        "token refresh endpoint must not be hit (valid access token expected)",
      );
    }
    return originalFetch(input, init);
  }) as any;

  // Connected credential with a still-valid access token so the refresh
  // path is skipped and only the live 403 handler runs.
  saveOriginal("getGoogleCalendarCredential");
  s.getGoogleCalendarCredential = async () => ({
    userId: USER_ID,
    status: "connected",
    accessTokenEncrypted: encryptToken("at-live-valid"),
    refreshTokenEncrypted: encryptToken("rt-live"),
    tokenExpiry: new Date(Date.now() + 60 * 60_000),
    calendarId: "primary",
    lastError: null,
  });
  saveOriginal("updateGoogleCalendarCredential");
  s.updateGoogleCalendarCredential = async (
    _userId: string,
    patch: Record<string, any>,
  ) => {
    updates.push(patch);
  };

  // Booking-page / user / client lookups — return ready-made rows so no
  // DB write ever happens (ensureBookingPage short-circuits on the
  // existing-page branch).
  saveOriginal("getBookingPageBySlug");
  s.getBookingPageBySlug = async (slug: string) =>
    slug === SLUG ? PAGE : undefined;
  saveOriginal("getBookingPageByUserId");
  s.getBookingPageByUserId = async (id: string) =>
    id === USER_ID ? PAGE : undefined;
  saveOriginal("getUser");
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "am-2375@test.local",
          firstName: "Avail",
          lastName: "Preview",
          role: "account_manager",
          timezone: "America/Chicago",
        }
      : undefined;
  saveOriginal("getClient");
  s.getClient = async (id: string) =>
    id === CLIENT_ID
      ? { id: CLIENT_ID, ownerId: USER_ID, isDemo: false }
      : undefined;

  // computeAvailableSlots reads these in parallel with the free/busy
  // lookup; empty is fine — we only care that the calendar branch runs.
  saveOriginal("listAvailabilityRules");
  s.listAvailabilityRules = async () => [];
  saveOriginal("listAvailabilityOverrides");
  s.listAvailabilityOverrides = async () => [];
  saveOriginal("listScheduledMeetingsForAm");
  s.listScheduledMeetingsForAm = async () => [];
}

function restoreStubs(): void {
  globalThis.fetch = originalFetch;
  for (const [name, fn] of Object.entries(originals)) {
    s[name] = fn;
  }
}

function statusWrites(): Array<Record<string, any>> {
  return updates.filter((p) => "status" in p);
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

let currentUserId: string | null = null;

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    req.__test_clerkUserId = currentUserId;
    next();
  });
  registerBookingRoutes(app);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const addr = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Shared assertions for a preview route: free/busy was consulted, the
// route fails-closed (no 200), and NO credential status was written.
// ---------------------------------------------------------------------------
function assertPreviewPreservesConnection(
  label: string,
  httpStatus: number,
): void {
  check(
    `[${label}] consulted live free/busy (purpose plumbed to getFreeBusy)`,
    freeBusyHits >= 1,
    `freeBusyHits=${freeBusyHits}`,
  );
  check(
    `[${label}] fails closed on the auth blip (not a 200 slot list)`,
    httpStatus >= 400,
    `status=${httpStatus}`,
  );
  check(
    `[${label}] NON-authoritative: NO credential status written (no false disconnect)`,
    statusWrites().length === 0,
    `statusWrites=${JSON.stringify(statusWrites())}`,
  );
}

// ---------------------------------------------------------------------------
// 1. Public slots preview — GET /api/book/:slug/slots
// ---------------------------------------------------------------------------
async function testPublicSlotsPreview(): Promise<void> {
  console.log("\n— 1. Public slots preview never disconnects the calendar —");
  installStubs();
  currentUserId = null;
  try {
    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/book/${SLUG}/slots`);
      assertPreviewPreservesConnection("public", r.status);
    });
  } finally {
    restoreStubs();
  }
}

// ---------------------------------------------------------------------------
// 2. AM/settings slots preview — GET /api/booking/me/slots-preview
// ---------------------------------------------------------------------------
async function testAmSelfSlotsPreview(): Promise<void> {
  console.log("\n— 2. AM self slots preview never disconnects the calendar —");
  installStubs();
  currentUserId = USER_ID;
  try {
    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/booking/me/slots-preview`);
      assertPreviewPreservesConnection("am-self", r.status);
    });
  } finally {
    currentUserId = null;
    restoreStubs();
  }
}

// ---------------------------------------------------------------------------
// 3. AM client slots preview — GET /api/booking/clients/:clientId/slots
// ---------------------------------------------------------------------------
async function testAmClientSlotsPreview(): Promise<void> {
  console.log("\n— 3. AM client slots preview never disconnects the calendar —");
  installStubs();
  currentUserId = USER_ID;
  try {
    await withApp(async (baseUrl) => {
      const r = await fetch(
        `${baseUrl}/api/booking/clients/${CLIENT_ID}/slots`,
      );
      assertPreviewPreservesConnection("am-client", r.status);
    });
  } finally {
    currentUserId = null;
    restoreStubs();
  }
}

// ---------------------------------------------------------------------------
// 4. Real booking WRITE path — bookSlot(...) saga re-check uses the
//    DEFAULT (authoritative) purpose, so the same blip MUST disconnect.
// ---------------------------------------------------------------------------
async function testWritePathAuthoritativeDisconnects(): Promise<void> {
  console.log(
    "\n— 4. Real booking write path IS authoritative (commits the disconnect) —",
  );
  installStubs();
  try {
    let thrown: unknown;
    try {
      await bookSlot({
        page: PAGE,
        host: { hostUserId: USER_ID, hostDisplayName: "Avail Preview" },
        invitee: { email: "invitee-2375@test.local", name: "Invitee" },
        startTimeUtc: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        source: "client_profile",
      });
      check("write path must refuse the booking on the auth blip", false);
    } catch (err) {
      thrown = err;
    }

    check(
      "write path consulted live free/busy",
      freeBusyHits >= 1,
      `freeBusyHits=${freeBusyHits}`,
    );
    check(
      "write path refuses with BookingError(calendar_failure)",
      thrown instanceof BookingError &&
        (thrown as BookingError).code === "calendar_failure",
      thrown instanceof Error ? thrown.message : String(thrown),
    );
    const writes = statusWrites();
    check(
      "AUTHORITATIVE: exactly one credential status written",
      writes.length === 1,
      `statusWrites=${JSON.stringify(writes)}`,
    );
    check(
      'AUTHORITATIVE: credential flipped to status:"disconnected"',
      writes.length === 1 && writes[0].status === "disconnected",
      writes.length ? String(writes[0].status) : "none",
    );
  } finally {
    restoreStubs();
  }
}

async function main(): Promise<void> {
  // The authenticated AM preview routes gate on a cached booking-schema
  // readiness snapshot (default all-false in a fresh process). Instead of
  // probing the real DB, force the cached snapshot to "ready" via the
  // test-only seam so those two routes clear the gate and reach the
  // calendar branch with zero DB dependency.
  const restoreReadiness = __setBookingSchemaReadinessForTest({
    tables: {
      bookingPages: true,
      bookingAvailabilityRules: true,
      bookingAvailabilityOverrides: true,
      scheduledMeetings: true,
      googleCalendarCredentials: true,
      bookingClientTokens: true,
    },
    ready: true,
  });

  // requireAuth resolves the acting identity against its ambient public-schema
  // `db` import; this suite seeds the user only in the in-memory storage stub,
  // so pre-register the profile in the module registry to keep the real
  // middleware in the loop without a JIT-provisioned public row.
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "am-2375@test.local",
    firstName: "Avail",
    lastName: "Preview",
    role: "account_manager",
  });

  try {
    await testPublicSlotsPreview();
    await testAmSelfSlotsPreview();
    await testAmClientSlotsPreview();
    await testWritePathAuthoritativeDisconnects();
  } finally {
    restoreReadiness();
    __test_resetReconciledUsers();
  }

  // The local-server route fetches above go through Node's global `undici`
  // dispatcher, which keeps ref'd keep-alive sockets open to 127.0.0.1 after
  // each request. Those linger past `server.close()` and would keep the event
  // loop alive (a drain hang the run-all harness scores as a timeout SIGKILL).
  // Close the dispatcher so the process exits naturally once pools drain.
  try {
    const undici = await import("undici");
    await undici.getGlobalDispatcher().close();
  } catch {
    // Best-effort: if undici isn't resolvable, fall through to natural drain.
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit(),
// so a leaked handle now surfaces as a real hang instead of being masked.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
