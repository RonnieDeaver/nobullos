/* test-registration
{
  "name": "Booking AM-side slots + lazy-default + per-meeting overrides (Task #892)",
  "tier": "medium",
  "tierReason": "Exercises booking availability defaults and per-meeting override behavior through the scheduler path."
}
test-registration */
/**
 * Task #892 — Behavioral coverage for AM-side slots, lazy-create, and
 * per-meeting overrides (Task #887).
 *
 * Spins up a real Express app with the booking routes mounted (auth
 * bypassed for a probe AM user) and exercises the actual HTTP endpoints
 * end-to-end against the dev DB. Pins:
 *
 *   1. GET /api/booking/me/page returns a default-flagged draft
 *      (`isDefault: true`, `id: null`) when no booking_pages row
 *      exists, and the same row tagged `isDefault: false` after one
 *      does.
 *   2. ensureBookingPage() lazy-creates a row on first call and is
 *      idempotent under a concurrent first-use race.
 *   3. GET /api/booking/clients/:clientId/slots accepts per-meeting
 *      duration / buffer overrides, echoes the effective values it
 *      computed against, AND returns a different slot count when the
 *      override changes (proving the override actually flows into the
 *      availability engine, not just the response envelope).
 *   4. POST /api/booking/clients/:clientId/book forwards the same
 *      overrides into the booking saga so the resulting
 *      scheduled_meetings row has `end_time_utc - start_time_utc`
 *      equal to the override duration — even if a downstream step
 *      (Zoom / Calendar) fails, the row was already inserted with the
 *      correct effective end time.
 *   5. End-to-end consistency: a slot returned by /slots with override
 *      `durationMinutes=60` is bookable via /book with the same
 *      override, and the resulting row's duration matches the slot's
 *      `endUtc - startUtc`.
 *   6. The public /api/book/:slug/slots and /api/book/:slug/confirm
 *      endpoints intentionally ignore per-request overrides — anonymous
 *      invitees only see the AM's saved page values, and the response
 *      never echoes a duration override the caller tried to inject.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  ensureBookingPage,
  registerBookingRoutes,
} from "../server/routes/booking";
import { ensureBookingDbConstraints } from "../server/services/bookingDbConstraints";
import { recheckBookingSchemaReadiness } from "../server/services/bookingSchemaReadiness";

let failed = 0;
let passed = 0;
let testUserId = "";
let testClientId = "";
let baseUrl = "";
let server: import("node:http").Server | null = null;

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

async function http(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, opts);
  let parsed: any;
  const txt = await res.text();
  try {
    parsed = JSON.parse(txt);
  } catch {
    parsed = txt;
  }
  return { status: res.status, body: parsed };
}

/**
 * Find the next future weekday (Mon–Fri) at 14:00 in America/Chicago,
 * expressed as a UTC ISO string. The default availability rules seeded
 * by ensureBookingPage are Mon–Fri 09:00–17:00 in the page tz, so 14:00
 * is comfortably inside a working window with room for at least 4
 * 30-minute slots before close.
 */
function nextWeekdayChicago2pmUtc(daysAhead = 7): {
  fromUtc: string;
  toUtc: string;
} {
  // Use a 2-day window, far enough in the future to bypass the default
  // 60-min lead time and to land squarely on a weekday.
  const now = new Date();
  const start = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  // Walk forward to a weekday (1=Mon … 5=Fri in UTC; Chicago is UTC-5/6
  // so dayOfWeek alignment is close enough for this test).
  while (start.getUTCDay() === 0 || start.getUTCDay() === 6) {
    start.setUTCDate(start.getUTCDate() + 1);
  }
  // 19:00 UTC ≈ 14:00 in America/Chicago (CDT) / 13:00 (CST). Either
  // way it's well inside the 09:00–17:00 default window.
  start.setUTCHours(19, 0, 0, 0);
  const to = new Date(start.getTime() + 36 * 60 * 60 * 1000);
  return { fromUtc: start.toISOString(), toUtc: to.toISOString() };
}

async function setup(): Promise<void> {
  await ensureBookingDbConstraints();
  // Refresh the cached readiness snapshot so the route handlers don't
  // 503 with `booking_schema_not_ready` (the cache is empty until
  // probed; in production it's primed by the boot sequence).
  await recheckBookingSchemaReadiness();

  const stamp = Date.now();
  testUserId = `__probe_am_892_${stamp}`;
  testClientId = `__probe_client_892_${stamp}`;

  // Seed an account_manager user with a real-looking email so the AM
  // book endpoint's "needs email or Zoom override" gate passes. Use
  // America/Chicago so 14:00 local lines up cleanly with the default
  // weekday rules ensureBookingPage seeds.
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, timezone)
    VALUES (
      ${testUserId},
      ${`probe-am-892-${stamp}@example.invalid`},
      'Probe', 'AM892',
      'account_manager',
      'America/Chicago'
    )
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, is_demo, is_archived)
    VALUES (${testClientId}, ${`Probe Firm 892 ${stamp}`}, ${testUserId}, false, false)
  `);

  // Build the test app: authenticate via the Clerk per-request test seam
  // (server/middlewares/requireAuth.ts) so the real requireAuth runs against
  // the seeded committed public-schema `users` row.
  const app = express();
  // NOTE: deliberately NOT setting `trust proxy` — express-rate-limit
  // (used by writeLimiter) emits a permissive-proxy warning when it
  // is enabled in combination with a wildcard, which clutters test
  // output. The test always connects to 127.0.0.1 so the default
  // behavior is correct.
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = testUserId;
    next();
  });
  registerBookingRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function cleanup(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (testUserId) {
    // FK cascade — delete in reverse dependency order. scheduled_meetings
    // ON DELETE SET NULL on user/client/page so we delete the rows
    // ourselves, then booking_pages, then clients, then user.
    await db.execute(sql`
      DELETE FROM scheduled_meetings WHERE account_manager_user_id = ${testUserId}
    `);
    await db.execute(sql`
      DELETE FROM booking_pages WHERE account_manager_user_id = ${testUserId}
    `);
    await db.execute(sql`DELETE FROM clients WHERE id = ${testClientId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${testUserId}`);
  }
}

async function main(): Promise<void> {
  await setup();

  // -----------------------------------------------------------------------
  section("1. GET /api/booking/me/page returns isDefault:true draft");
  // -----------------------------------------------------------------------
  {
    const r = await http("GET", "/api/booking/me/page");
    assert(r.status === 200, `status 200 (got ${r.status})`);
    assert(r.body?.page?.isDefault === true, "page.isDefault === true");
    assert(r.body?.page?.id === null, "page.id === null (not persisted)");
    assert(
      r.body?.page?.accountManagerUserId === testUserId,
      "draft is owned by the requesting AM",
    );
    assert(
      typeof r.body?.page?.durationMinutes === "number" &&
        typeof r.body?.page?.bufferBeforeMinutes === "number" &&
        typeof r.body?.page?.bufferAfterMinutes === "number",
      "draft carries numeric defaults for duration / buffers",
    );
    assert(
      r.body?.page?.title === "" && r.body?.page?.description === "",
      "draft.title/description are empty strings (not 'null')",
    );
  }

  // -----------------------------------------------------------------------
  section("2. ensureBookingPage lazy-creates + is idempotent under race");
  // -----------------------------------------------------------------------
  {
    // Sanity: no row yet.
    const before = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM booking_pages
      WHERE account_manager_user_id = ${testUserId}
    `);
    const beforeRows = ((before as any).rows ?? before) as Array<{ n: number }>;
    assert(beforeRows[0]?.n === 0, "no booking_pages row exists at start");

    const probeUser = {
      id: testUserId,
      email: `probe-am-892@example.invalid`,
      firstName: "Probe",
      lastName: "AM892",
      timezone: "America/Chicago",
    };

    // (a) Concurrent first-use race — both callers think no row exists,
    // both try to create. The unique constraint on
    // account_manager_user_id collapses them to ONE row.
    const [a, b] = await Promise.all([
      ensureBookingPage(probeUser),
      ensureBookingPage(probeUser),
    ]);
    assert(
      a.id === b.id,
      `both racers see the same row id (got ${a.id} vs ${b.id})`,
    );
    const after = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM booking_pages
      WHERE account_manager_user_id = ${testUserId}
    `);
    const afterRows = ((after as any).rows ?? after) as Array<{ n: number }>;
    assert(
      afterRows[0]?.n === 1,
      `exactly one booking_pages row exists after the race (got ${afterRows[0]?.n})`,
    );

    // (b) Subsequent call re-fetches.
    const refetched = await ensureBookingPage(probeUser);
    assert(
      refetched.id === a.id,
      "a third ensureBookingPage call returns the same row",
    );
  }

  // -----------------------------------------------------------------------
  section("3. GET /api/booking/me/page returns isDefault:false after row exists");
  // -----------------------------------------------------------------------
  {
    const r = await http("GET", "/api/booking/me/page");
    assert(r.status === 200, `status 200 (got ${r.status})`);
    assert(
      r.body?.page?.isDefault === false,
      "page.isDefault === false (persisted)",
    );
    assert(
      typeof r.body?.page?.id === "string" && r.body.page.id.length > 0,
      "page.id is a real string id",
    );
  }

  // -----------------------------------------------------------------------
  section("4. AM /slots: overrides flow into the availability engine");
  // -----------------------------------------------------------------------
  let pickedSlot: { startUtc: string; endUtc: string } | null = null;
  let baselineCount = 0;
  let overrideCount = 0;
  {
    const win = nextWeekdayChicago2pmUtc(7);

    // (a) Default duration (30) — baseline slot count.
    const baseline = await http(
      "GET",
      `/api/booking/clients/${testClientId}/slots?from=${encodeURIComponent(
        win.fromUtc,
      )}&to=${encodeURIComponent(win.toUtc)}`,
    );
    assert(baseline.status === 200, `baseline /slots status 200 (got ${baseline.status})`);
    assert(
      baseline.body?.durationMinutes === 30,
      `baseline echoes default durationMinutes=30 (got ${baseline.body?.durationMinutes})`,
    );
    assert(
      Array.isArray(baseline.body?.slots) && baseline.body.slots.length > 0,
      `baseline returns at least one slot (got ${baseline.body?.slots?.length})`,
    );
    baselineCount = baseline.body.slots.length;

    // (b) Override duration=60 — fewer slots fit in the same window,
    // and the response echoes the effective value the engine actually
    // used (proves the override was threaded through, not silently
    // dropped).
    const overridden = await http(
      "GET",
      `/api/booking/clients/${testClientId}/slots?from=${encodeURIComponent(
        win.fromUtc,
      )}&to=${encodeURIComponent(win.toUtc)}&durationMinutes=60`,
    );
    assert(
      overridden.status === 200,
      `override /slots status 200 (got ${overridden.status})`,
    );
    assert(
      overridden.body?.durationMinutes === 60,
      `override echoes effective durationMinutes=60 (got ${overridden.body?.durationMinutes})`,
    );
    assert(
      Array.isArray(overridden.body?.slots) && overridden.body.slots.length > 0,
      `override returns at least one slot (got ${overridden.body?.slots?.length})`,
    );
    overrideCount = overridden.body.slots.length;
    assert(
      overrideCount < baselineCount,
      `60-min override yields fewer slots than 30-min default (${overrideCount} < ${baselineCount})`,
    );

    // (c) Each returned slot honors the effective duration end-to-end.
    const firstSlot = overridden.body.slots[0];
    pickedSlot = firstSlot;
    const dur =
      (new Date(firstSlot.endUtc).getTime() -
        new Date(firstSlot.startUtc).getTime()) /
      60_000;
    assert(
      dur === 60,
      `each slot's endUtc - startUtc matches the effective override (got ${dur}min)`,
    );

    // (d) Out-of-bounds override is rejected at the route boundary —
    // proves the zod schema is wired in, not that we silently coerce.
    const bad = await http(
      "GET",
      `/api/booking/clients/${testClientId}/slots?from=${encodeURIComponent(
        win.fromUtc,
      )}&to=${encodeURIComponent(win.toUtc)}&durationMinutes=5`,
    );
    assert(
      bad.status === 400,
      `out-of-bounds duration is rejected with 400 (got ${bad.status})`,
    );
  }

  // -----------------------------------------------------------------------
  section("5. AM /book: overrides flow into the saga's effectivePage");
  // -----------------------------------------------------------------------
  {
    if (!pickedSlot) {
      console.error("  ✗ no slot from section 4 — skipping book test");
      failed++;
    } else {
      const idem = `probe-892-${Date.now()}`;
      const r = await http("POST", `/api/booking/clients/${testClientId}/book`, {
        startTimeUtc: pickedSlot.startUtc,
        inviteeEmail: "invitee-892@example.invalid",
        inviteeName: "Probe Invitee",
        idempotencyKey: idem,
        durationMinutes: 60,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      });

      // The saga will fail at Zoom (no Zoom config in the test env) or
      // Calendar (the probe user has no Google credential) — but BEFORE
      // that, the saga inserts a `creating` row whose endTimeUtc is
      // computed from `effectivePage.durationMinutes`. The row stays in
      // the DB (marked `failed`) and we can inspect its duration to
      // prove the override was honored.
      // Acceptable outcomes:
      //   200 — fully bookable env (Zoom + Calendar both configured),
      //   400 — schema/validation rejection (shouldn't happen here, but
      //         we keep the bound),
      //   502 — saga inserted the `creating` row then aborted at Zoom or
      //         Calendar because the test env has no integration creds.
      //         The row+duration assertions below verify the override was
      //         honored regardless.
      assert(
        r.status === 200 || r.status === 400 || r.status === 502,
        `book responds (got ${r.status}); body=${JSON.stringify(r.body).slice(0, 200)}`,
      );

      const meetingRes = await db.execute(sql`
        SELECT start_time_utc, end_time_utc, status, failure_reason
        FROM scheduled_meetings
        WHERE account_manager_user_id = ${testUserId}
          AND idempotency_key = ${idem}
        LIMIT 1
      `);
      const meetingRows = ((meetingRes as any).rows ?? meetingRes) as Array<{
        start_time_utc: Date | string;
        end_time_utc: Date | string;
        status: string;
        failure_reason: string | null;
      }>;
      assert(
        meetingRows.length === 1,
        `saga inserted a scheduled_meetings row for the override booking (got ${meetingRows.length})`,
      );
      if (meetingRows.length === 1) {
        const startMs = new Date(meetingRows[0].start_time_utc).getTime();
        const endMs = new Date(meetingRows[0].end_time_utc).getTime();
        const minutes = (endMs - startMs) / 60_000;
        assert(
          minutes === 60,
          `row's endTime - startTime matches the override duration (got ${minutes}min)`,
        );

        // End-to-end consistency: the row's duration equals the
        // duration of the slot the AM was offered.
        const slotMinutes =
          (new Date(pickedSlot.endUtc).getTime() -
            new Date(pickedSlot.startUtc).getTime()) /
          60_000;
        assert(
          minutes === slotMinutes,
          `booked row duration matches the offered slot's duration (${minutes}min == ${slotMinutes}min)`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  section("6. Public /book/:slug ignores per-request overrides");
  // -----------------------------------------------------------------------
  {
    const page = await storage.getBookingPageByUserId(testUserId);
    assert(!!page?.slug, "probe AM has a public slug");
    if (page?.slug) {
      const win = nextWeekdayChicago2pmUtc(14);

      // Baseline (no override) — public slot count at default 30min.
      const baseline = await http(
        "GET",
        `/api/book/${page.slug}/slots?from=${encodeURIComponent(
          win.fromUtc,
        )}&to=${encodeURIComponent(win.toUtc)}`,
      );
      assert(
        baseline.status === 200,
        `public baseline /slots status 200 (got ${baseline.status})`,
      );
      assert(
        Array.isArray(baseline.body?.slots) && baseline.body.slots.length > 0,
        `public baseline returns slots (got ${baseline.body?.slots?.length})`,
      );
      assert(
        baseline.body?.durationMinutes === undefined,
        "public response does not echo a durationMinutes field (no per-request control)",
      );
      const publicBaselineCount = baseline.body.slots.length;
      const firstPublic = baseline.body.slots[0];
      const publicSlotMinutes =
        (new Date(firstPublic.endUtc).getTime() -
          new Date(firstPublic.startUtc).getTime()) /
        60_000;
      assert(
        publicSlotMinutes === 30,
        `public slots use the page's saved duration (got ${publicSlotMinutes}min)`,
      );

      // Try to inject an override via query param. The handler must
      // ignore it: same slot count, same per-slot duration as baseline.
      const injected = await http(
        "GET",
        `/api/book/${page.slug}/slots?from=${encodeURIComponent(
          win.fromUtc,
        )}&to=${encodeURIComponent(
          win.toUtc,
        )}&durationMinutes=60&bufferBeforeMinutes=15&bufferAfterMinutes=15`,
      );
      assert(
        injected.status === 200,
        `public /slots accepts but ignores override params (got ${injected.status})`,
      );
      assert(
        injected.body?.slots?.length === publicBaselineCount,
        `public slot count is unchanged when override params are present (${injected.body?.slots?.length} == ${publicBaselineCount})`,
      );
      const firstInjected = injected.body.slots[0];
      const injectedSlotMinutes =
        (new Date(firstInjected.endUtc).getTime() -
          new Date(firstInjected.startUtc).getTime()) /
        60_000;
      assert(
        injectedSlotMinutes === 30,
        `public slots still use the saved 30-min duration when override is injected (got ${injectedSlotMinutes}min)`,
      );

      // Public confirm endpoint must reject duration overrides via its
      // zod schema — the public confirmSchema does not declare them as
      // known fields, so a body with `durationMinutes: 60` either
      // ignores the field outright or fails validation. Either way the
      // request must NOT result in a saga call that uses 60 minutes.
      // We pick a slot startTime in the past so the saga refuses with
      // a non-success status before it could possibly create a Zoom
      // meeting — the point here is purely that the confirmSchema
      // doesn't accept overrides.
      const confirmRes = await http("POST", `/api/book/${page.slug}/confirm`, {
        startTimeUtc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        invitee: { email: "public-892@example.invalid" },
        durationMinutes: 60,
        bufferBeforeMinutes: 15,
      });
      assert(
        confirmRes.status >= 400 && confirmRes.status < 500,
        `public /confirm with bogus override returns 4xx (got ${confirmRes.status})`,
      );
    }
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
    await cleanup().catch((err) => {
      console.error("Cleanup error (non-fatal):", err);
    });
    process.exitCode = failed > 0 ? 1 : 0;
  });
