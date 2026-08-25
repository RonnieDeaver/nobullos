/* test-registration
{
  "name": "Booking preview routes return 503 booking_schema_not_ready when schema missing (Task #2404)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2404 — Verify the two authenticated AM booking-preview routes show
 * a clear "not set up yet" message when the booking schema isn't installed.
 *
 * Background
 * ----------
 * Task #860/#866 translate a missing-booking-table 500 into an actionable
 * 503 `booking_schema_not_ready` response so the Schedule tab can render a
 * friendly "apply booking migrations" message instead of a server error.
 * Each authenticated AM preview route gates on the cached booking-schema
 * readiness snapshot (`getBookingSchemaReadiness().tables.bookingPages`):
 *
 *   1. AM self preview     GET /api/booking/me/slots-preview      → 503 `code`
 *   2. AM client preview   GET /api/booking/clients/:clientId/slots → 503 `error`
 *
 * Task #2402 added the test-only seam `__setBookingSchemaReadinessForTest`
 * that lets a test set the cached snapshot WITHOUT touching the database.
 * The existing route test (`booking-availability-preview-purpose-route`)
 * only ever CLEARS the gate (ready=true). The opposite branch — the gate
 * actually tripping and returning the 503 — had no coverage, so a future
 * refactor could silently drop the gate and regress the friendly message.
 *
 * What this test pins
 * -------------------
 * Trip the gate via `__setBookingSchemaReadinessForTest({ tables: {
 * bookingPages: false }, ready: false })` and assert both authenticated
 * routes return HTTP 503 carrying the `booking_schema_not_ready` code.
 * Setup is pure in-memory: the `storage` singleton's user/client lookups
 * (which run BEFORE the readiness gate) are swapped for stubs, so the whole
 * test runs with zero DB dependency, consistent with the #2402 approach.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express from "express";
import type { AddressInfo } from "net";

import { registerBookingRoutes } from "../server/routes/booking";
import { __setBookingSchemaReadinessForTest } from "../server/services/bookingSchemaReadiness";
import { storage } from "../server/storage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const USER_ID = "user-2404-preview";
const CLIENT_ID = "client-2404";

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
// In-memory stubs — only the lookups that run BEFORE the readiness gate.
// ---------------------------------------------------------------------------
const s = storage as any;
const originals: Record<string, any> = {};

function saveOriginal(name: string): void {
  if (!(name in originals)) originals[name] = s[name];
}

function installStubs(): void {
  saveOriginal("getUser");
  s.getUser = async (id: string) =>
    id === USER_ID
      ? {
          id: USER_ID,
          email: "am-2404@test.local",
          firstName: "Schema",
          lastName: "Notready",
          role: "account_manager",
          timezone: "America/Chicago",
        }
      : undefined;
  saveOriginal("getClient");
  s.getClient = async (id: string) =>
    id === CLIENT_ID
      ? { id: CLIENT_ID, ownerId: USER_ID, isDemo: false }
      : undefined;
}

function restoreStubs(): void {
  for (const [name, fn] of Object.entries(originals)) {
    s[name] = fn;
  }
}

// ---------------------------------------------------------------------------
// HTTP harness — authenticates every request as the AM under test.
// ---------------------------------------------------------------------------
async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. This suite has no DB dependency, so the
    // acting user is pre-registered via __test_markUserReconciled below.
    req.__test_clerkUserId = USER_ID;
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
// 1. AM self preview — GET /api/booking/me/slots-preview → 503 (code field)
// ---------------------------------------------------------------------------
async function testAmSelfSlotsPreview(): Promise<void> {
  console.log(
    "\n— 1. AM self slots preview returns 503 booking_schema_not_ready —",
  );
  installStubs();
  try {
    await withApp(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/booking/me/slots-preview`);
      const body = await r.json().catch(() => ({}));
      check(
        "[am-self] HTTP 503 (schema not ready, not a server error)",
        r.status === 503,
        `status=${r.status}`,
      );
      check(
        "[am-self] code === booking_schema_not_ready",
        (body as any).code === "booking_schema_not_ready",
        `body=${JSON.stringify(body)}`,
      );
    });
  } finally {
    restoreStubs();
  }
}

// ---------------------------------------------------------------------------
// 2. AM client preview — GET /api/booking/clients/:clientId/slots → 503
//    (this route carries the code in the `error` field).
// ---------------------------------------------------------------------------
async function testAmClientSlotsPreview(): Promise<void> {
  console.log(
    "\n— 2. AM client slots preview returns 503 booking_schema_not_ready —",
  );
  installStubs();
  try {
    await withApp(async (baseUrl) => {
      const r = await fetch(
        `${baseUrl}/api/booking/clients/${CLIENT_ID}/slots`,
      );
      const body = await r.json().catch(() => ({}));
      check(
        "[am-client] HTTP 503 (schema not ready, not a server error)",
        r.status === 503,
        `status=${r.status}`,
      );
      check(
        "[am-client] error === booking_schema_not_ready",
        (body as any).error === "booking_schema_not_ready",
        `body=${JSON.stringify(body)}`,
      );
    });
  } finally {
    restoreStubs();
  }
}

async function main(): Promise<void> {
  // Trip the schema-readiness gate WITHOUT touching the DB: force the
  // cached snapshot so `bookingPages` is missing and `ready` is false.
  // Both authenticated preview routes must then short-circuit to the
  // friendly 503 before reaching any DB-backed booking work.
  const restoreReadiness = __setBookingSchemaReadinessForTest({
    tables: {
      bookingPages: false,
      bookingAvailabilityRules: false,
      bookingAvailabilityOverrides: false,
      scheduledMeetings: false,
      googleCalendarCredentials: false,
      bookingClientTokens: false,
    },
    ready: false,
  });

  // This suite is DB-free (storage lookups are stubbed), so pre-register the
  // acting user in the requireAuth registry — the middleware uses this profile
  // directly instead of hitting the public-schema users table.
  __test_markUserReconciled(USER_ID, {
    id: USER_ID,
    email: "am-2404@test.local",
    firstName: "Schema",
    lastName: "Notready",
    role: "account_manager",
  });

  try {
    await testAmSelfSlotsPreview();
    await testAmClientSlotsPreview();
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
