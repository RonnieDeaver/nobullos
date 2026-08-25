/* test-registration
{
  "name": "Booking page schema-not-ready 503 (Task #866)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #866 — Backend regression test for the Schedule tab's failure-mode
 * contract.
 *
 * Pins that GET /api/booking/me/page responds 503 with
 * `error: "booking_schema_not_ready"` when the cached readiness snapshot
 * reports the `booking_pages` table is missing. The Schedule panel
 * (ClientSchedulingPanel) keys its dedicated "Scheduling is temporarily
 * unavailable" card off this code, and the panel-level frontend test
 * (tests/client/scheduling-panel-failure-modes.test.tsx) asserts the same
 * contract from the other side. If either the status code or the error
 * string here changes, both surfaces must be updated together.
 *
 * The readiness module's module-level `cached` snapshot defaults to
 * "all tables missing". Because each tests/run-all.ts entry runs in its
 * own spawned process, this file deliberately does NOT call
 * `recheckBookingSchemaReadiness()` — leaving the cache in its default
 * "not ready" state — so the route's first guard fires and the 503
 * response we want is exercised on a real database without dropping any
 * tables.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  registerBookingRoutes,
} from "../server/routes/booking";
import {
  getBookingSchemaReadiness,
  recheckBookingSchemaReadiness,
} from "../server/services/bookingSchemaReadiness";

let failed = 0;
let passed = 0;
let baseUrl = "";
let server: import("node:http").Server | null = null;
const testUserId = `__probe_866_${Date.now()}`;

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

async function http(method: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method });
  const txt = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(txt);
  } catch {
    parsed = txt;
  }
  return { status: res.status, body: parsed };
}

async function setup(): Promise<void> {
  const app = express();
  app.use(express.json());
  // Clerk test seam (server/middlewares/requireAuth.ts): authenticate as the
  // seeded committed public-schema `users` row so requireAuth admits the
  // request, leaving the readiness guard as the next short-circuit.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = testUserId;
    next();
  });
  registerBookingRoutes(app);

  // Seed the probe user so loadCurrentUser() returns a real row and the
  // route's auth check passes — leaving the readiness guard as the next
  // (and the only) thing that can short-circuit the response.
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (
      ${testUserId},
      ${`${testUserId}@example.invalid`},
      'Probe', '866',
      'account_manager'
    )
    ON CONFLICT (id) DO NOTHING
  `);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function teardown(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${testUserId}`);
  } catch {
    /* tolerate */
  }
}

async function main(): Promise<void> {
  await setup();

  section("readiness cache defaults to 'not ready' before first probe");
  {
    const snap = getBookingSchemaReadiness();
    assert(
      snap.tables.bookingPages === false,
      `bookingPages table flag is false at start (got ${snap.tables.bookingPages})`,
    );
    assert(snap.ready === false, "snapshot.ready is false at start");
  }

  section("GET /api/booking/me/page returns 503 booking_schema_not_ready");
  {
    const r = await http("GET", "/api/booking/me/page");
    assert(r.status === 503, `status 503 (got ${r.status})`);
    assert(
      r.body?.error === "booking_schema_not_ready",
      `body.error === "booking_schema_not_ready" (got ${JSON.stringify(r.body?.error)})`,
    );
    assert(
      typeof r.body?.message === "string" && r.body.message.length > 0,
      "body.message is a non-empty string for operator readability",
    );
  }

  section("once readiness is re-probed against the real DB, the route stops 503'ing");
  {
    // The dev DB has the booking tables installed by ensureBookingTables
    // at server boot. After a real probe, the cached snapshot flips to
    // ready and the route no longer short-circuits with 503. (It may
    // still 401/500 on the auth-shaped probe user, which is fine — the
    // contract we're pinning is "no longer 503 booking_schema_not_ready".)
    const refreshed = await recheckBookingSchemaReadiness();
    assert(
      refreshed.tables.bookingPages === true,
      `bookingPages table flag flips to true after probe (got ${refreshed.tables.bookingPages})`,
    );
    const r = await http("GET", "/api/booking/me/page");
    assert(
      r.status !== 503 || r.body?.error !== "booking_schema_not_ready",
      `route no longer returns 503 booking_schema_not_ready (got status=${r.status}, error=${JSON.stringify(r.body?.error)})`,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Test crashed:", err);
    failed++;
  })
  .finally(async () => {
    await teardown().catch((err) => {
      console.error("Teardown error (non-fatal):", err);
    });
    process.exitCode = failed > 0 ? 1 : 0;
  });
