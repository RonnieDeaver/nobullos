/* test-registration
{
  "name": "New Client Onboarding — full chain: roster resolution (default + fallback) through a real booked meeting, client, and Intel entry (Task #5298, stage 4)",
  "regression": true,
  "sweepOnlyReason": "Task #5298 — full-chain onboarding E2E: DB-heavy (runInIsolatedSchema: users, onboarding_assignees, booking_pages, booking_availability_rules, scheduled_meetings, google_calendar_credentials, clients, intelligence_feed_entries) + real HTTP server + resolve-hook stubbed Zoom/Calendar.",
  "extraNodeArgs": [
    "--import",
    "./tests/onboarding-e2e-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small",
  "tierReason": "Same shape as onboarding-roster-route.test.ts / onboarding-pool-availability.test.ts (isolated-schema clone + a lightweight in-process HTTP server, no heavy harness); a handful of requests against real Postgres complete in low single-digit seconds locally."
}
test-registration */
/**
 * Task #5298 — stage 4 of the New Client Onboarding epic: end-to-end
 * verification that the whole chain (stages 1-3) actually works together,
 * not just in isolation.
 *
 * Earlier tests in this epic (onboarding-roster-route, onboarding-pool-
 * availability, onboarding-booking-wiring, onboarding-intake-wiring)
 * deliberately stop short of a real successful `bookSlot()` call — a
 * genuine booking requires live Zoom meeting creation and a connected
 * Google Calendar credential (REQUIRED, not best-effort — see
 * bookingScheduler.ts), neither of which any existing test infra stubs.
 * This test closes that gap via a resolve-hook loader
 * (onboarding-e2e-setup.mjs → onboarding-e2e-loader.mjs) that redirects
 * `server/services/zoomIntegration` and
 * `server/services/googleCalendarIntegration` to in-memory stubs — the
 * SAME pattern already used for ClickUp in
 * service-desk-import-departments-route.test.ts. Every other module
 * (onboardingRoster, onboardingBooking, bookingScheduler, clientIntake,
 * onboardingIntake, storage) runs completely for real against a real
 * isolated-schema Postgres clone.
 *
 * Sections:
 *   (A) Roster set up with a default person + one fallback member, both
 *       with a connected Google Calendar credential.
 *   (B) A full POST /api/onboarding/intake submission when the default is
 *       free resolves to the default, and produces a real client row, a
 *       real linked `scheduled_meetings` row under that default's
 *       identity, and a real Intel entry containing the submitted notes.
 *   (C) The default is made busy at a second slot; a second full intake
 *       submission at that slot falls back to the other roster member —
 *       proving the fallback path (not just the default path) survives
 *       the entire chain, not only the isolated resolver.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { registerOnboardingIntakeRoutes } from "../server/routes/onboardingIntake";
import { upsertOnboardingAssignee, setOnboardingDefault } from "../server/services/onboardingRoster";
import { ensureBookingPage } from "../server/routes/booking";
import { runInIsolatedSchema } from "./db-sandbox";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

const RUN = Math.random().toString(36).slice(2, 8);
const SALES_ID = `test-5298-sales-${RUN}`;
const DEFAULT_ID = `test-5298-default-${RUN}`;
const OTHER_ID = `test-5298-other-${RUN}`;

const TABLES = [
  "users",
  "sd_departments",
  "sd_department_members",
  "booking_pages",
  "booking_availability_rules",
  "scheduled_meetings",
  "google_calendar_credentials",
  "clients",
  "command_panels",
  "intelligence_feed_entries",
] as const;

// Fixed future Wednesdays at fixed UTC hours — well inside the Mon-Fri
// 09:00-17:00 default availability window seeded by `ensureBookingPage`,
// all users timezone=UTC so no tz-conversion detour, far enough out to
// never collide with lead-time guards.
const SLOT_A_UTC = new Date("2031-02-05T10:00:00.000Z");
const SLOT_B_UTC = new Date("2031-02-05T14:00:00.000Z");

let activeUserId: string | null = SALES_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerOnboardingIntakeRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postIntake(baseUrl: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/onboarding/intake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── (A) Seed users + roster + connected Google Calendar creds ─────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name, email, timezone)
        VALUES
          (${SALES_ID}, 'account_manager', 'Sales 5298', ${`sales-${RUN}@onboarding-e2e.test`}, 'UTC'),
          (${DEFAULT_ID}, 'account_manager', 'Default 5298', ${`default-${RUN}@onboarding-e2e.test`}, 'UTC'),
          (${OTHER_ID}, 'account_manager', 'Other 5298', ${`other-${RUN}@onboarding-e2e.test`}, 'UTC')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO sd_departments (id, name, active, assignment_scope, sort_order)
        VALUES (${`test-onboarding-dept-${RUN}`}, 'Onboarding', true, 'company', 1)
      `);
      __test_markUserReconciled(SALES_ID, {
        id: SALES_ID,
        role: "account_manager",
        firstName: "Sales 5298",
        email: `sales-${RUN}@onboarding-e2e.test`,
      });

      await upsertOnboardingAssignee(DEFAULT_ID);
      await upsertOnboardingAssignee(OTHER_ID);
      const setDefault = await setOnboardingDefault(DEFAULT_ID);
      assert.equal(setDefault.ok, true, "setup: setOnboardingDefault must succeed");

      // Real booking pages for both roster members (lazy-created the same
      // way `loadOnboardingPool` creates them on first use).
      const defaultPage = await ensureBookingPage({ id: DEFAULT_ID, timezone: "UTC" });
      await ensureBookingPage({ id: OTHER_ID, timezone: "UTC" });

      // A real booking requires a connected Google Calendar credential
      // (bookingScheduler.ts: REQUIRED, not best-effort) — seed both
      // roster members as connected so either can become the resolved
      // host across the two cases below.
      await db.execute(sql`
        INSERT INTO google_calendar_credentials (user_id, calendar_id, status)
        VALUES
          (${DEFAULT_ID}, 'primary', 'connected'),
          (${OTHER_ID}, 'primary', 'connected')
      `);
      console.log("  ✓ A: roster (default + fallback), booking pages, and connected Calendar credentials seeded");

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // ── (B) Default-available: full intake submission resolves to
        // the default person and produces a real client + meeting + Intel
        // entry. ─────────────────────────────────────────────────────────
        activeUserId = SALES_ID;
        const notesA = `Called about GBP onboarding — priced webinar add-on, run ${RUN}.`;
        const submitA = await postIntake(baseUrl, {
          firmName: `Acme Legal ${RUN}-A`,
          contactEmail: `acme-a-${RUN}@client-onboarding-e2e.test`,
          contactName: "Alex Client",
          products: ["gbp"],
          gbpPlannedLocationCount: 1,
          gbpPlannedLocationCities: ["Dallas"],
          notes: notesA,
          startTimeUtc: SLOT_A_UTC.toISOString(),
        });
        assert.equal(
          submitA.status,
          201,
          `B: default-available intake submission must be 201 (got ${submitA.status}: ${JSON.stringify(submitA.body)})`,
        );
        assert.equal(submitA.body?.resolvedUserId, DEFAULT_ID, "B: resolves to the default person when they're free");
        assert.equal(submitA.body?.status, "confirmed", "B: response reports a confirmed booking");
        assert.ok(submitA.body?.client?.id, "B: response includes the created client");
        assert.equal(submitA.body?.client?.firmName, `Acme Legal ${RUN}-A`, "B: created client carries the submitted firm name");
        assert.ok(submitA.body?.meeting?.id, "B: response includes the booked meeting");
        assert.equal(submitA.body?.meeting?.accountManagerUserId, DEFAULT_ID, "B: meeting is attached to the default person, not the sales rep");
        assert.equal(submitA.body?.meeting?.clientId, submitA.body.client.id, "B: meeting is linked to the created client");
        assert.equal(submitA.body?.meeting?.bookingSource, "onboarding_pool", "B: meeting is tagged as onboarding_pool, not client_profile");
        assert.ok(submitA.body?.intelEntry?.id, "B: response includes the created Intel entry");
        assert.equal(submitA.body?.intelWarning, null, "B: no Intel warning on a clean run");

        const clientAId = submitA.body.client.id as string;
        const meetingAId = submitA.body.meeting.id as string;
        const intelAId = submitA.body.intelEntry.id as string;

        const [clientARow] = (
          await db.execute(sql`SELECT * FROM clients WHERE id = ${clientAId}`)
        ).rows as any[];
        assert.ok(clientARow, "B: the client row must actually exist in the database");
        assert.equal(clientARow.contact_email, `acme-a-${RUN}@client-onboarding-e2e.test`, "B: persisted client carries the submitted contact email");
        const [panelARow] = (
          await db.execute(sql`SELECT * FROM command_panels WHERE client_id = ${clientAId}`)
        ).rows as any[];
        assert.deepEqual(panelARow.product_types, ["gbp"], "B: Command Panel stores selected products");
        assert.equal(panelARow.gbp_planned_location_count, 1, "B: Command Panel stores planned GBP count");
        assert.deepEqual(panelARow.gbp_planned_location_cities, ["Dallas"], "B: Command Panel stores planned GBP cities");

        const [meetingARow] = (
          await db.execute(sql`SELECT * FROM scheduled_meetings WHERE id = ${meetingAId}`)
        ).rows as any[];
        assert.ok(meetingARow, "B: the meeting row must actually exist in the database");
        assert.equal(meetingARow.status, "confirmed", "B: persisted meeting is confirmed");
        assert.equal(meetingARow.client_id, clientAId, "B: persisted meeting is linked to the client row");
        assert.equal(meetingARow.account_manager_user_id, DEFAULT_ID, "B: persisted meeting's host is the default person");
        assert.equal(meetingARow.booking_page_id, defaultPage.id, "B: persisted meeting rides the default person's own booking page");
        assert.equal(new Date(meetingARow.start_time_utc).getTime(), SLOT_A_UTC.getTime(), "B: persisted meeting starts at the requested slot");

        const [intelARow] = (
          await db.execute(sql`SELECT * FROM intelligence_feed_entries WHERE id = ${intelAId}`)
        ).rows as any[];
        assert.ok(intelARow, "B: the Intel entry row must actually exist in the database");
        assert.equal(intelARow.client_id, clientAId, "B: persisted Intel entry is linked to the client row");
        assert.equal(intelARow.entry_type, "meeting_takeaway", "B: persisted Intel entry uses the meeting_takeaway type");
        assert.equal(intelARow.body, notesA, "B: persisted Intel entry contains the exact submitted sales notes");
        assert.equal(intelARow.created_by, SALES_ID, "B: persisted Intel entry is attributed to the sales rep who took the call");
        console.log("  ✓ B: default-available submission ⇒ resolved to the default person, with a real client + meeting + Intel entry all linked together");

        // ── (C) Make the default busy at a second slot; a second
        // submission at that slot must fall back to the OTHER roster
        // member — proving the fallback path survives end to end, not
        // just in the isolated resolver test. ─────────────────────────
        const busyEnd = new Date(SLOT_B_UTC.getTime() + 30 * 60_000);
        await db.execute(sql`
          INSERT INTO scheduled_meetings
            (account_manager_user_id, booking_page_id, booking_source, invitee_email,
             start_time_utc, end_time_utc, timezone, status)
          VALUES
            (${DEFAULT_ID}, ${defaultPage.id}, 'client_profile', ${`busy-${RUN}@test.local`},
             ${SLOT_B_UTC.toISOString()}::timestamp, ${busyEnd.toISOString()}::timestamp, 'UTC', 'confirmed')
        `);

        const notesB = `Fallback-path call notes, run ${RUN}.`;
        const submitB = await postIntake(baseUrl, {
          firmName: `Acme Legal ${RUN}-B`,
          contactEmail: `acme-b-${RUN}@client-onboarding-e2e.test`,
          products: ["gbp"],
          gbpPlannedLocationCount: 1,
          gbpPlannedLocationCities: ["Austin"],
          notes: notesB,
          startTimeUtc: SLOT_B_UTC.toISOString(),
        });
        assert.equal(
          submitB.status,
          201,
          `C: fallback intake submission must be 201 (got ${submitB.status}: ${JSON.stringify(submitB.body)})`,
        );
        assert.equal(submitB.body?.resolvedUserId, OTHER_ID, "C: falls back to the other roster member when the default is busy");
        assert.equal(submitB.body?.meeting?.accountManagerUserId, OTHER_ID, "C: meeting is attached to the fallback person, not the busy default");

        const clientBId = submitB.body.client.id as string;
        const meetingBId = submitB.body.meeting.id as string;
        const intelBId = submitB.body.intelEntry.id as string;

        const [meetingBRow] = (
          await db.execute(sql`SELECT * FROM scheduled_meetings WHERE id = ${meetingBId}`)
        ).rows as any[];
        assert.ok(meetingBRow, "C: the fallback meeting row must actually exist in the database");
        assert.equal(meetingBRow.account_manager_user_id, OTHER_ID, "C: persisted fallback meeting's host is the other roster member");
        assert.equal(meetingBRow.client_id, clientBId, "C: persisted fallback meeting is linked to its own client row");
        assert.notEqual(meetingBRow.id, meetingARow.id, "C: the two submissions produced two distinct meetings");

        const [intelBRow] = (
          await db.execute(sql`SELECT * FROM intelligence_feed_entries WHERE id = ${intelBId}`)
        ).rows as any[];
        assert.ok(intelBRow, "C: the fallback Intel entry row must actually exist in the database");
        assert.equal(intelBRow.body, notesB, "C: persisted fallback Intel entry contains its own submitted notes (not run A's)");
        assert.equal(intelBRow.client_id, clientBId, "C: fallback Intel entry is linked to its own client, not run A's");
        console.log("  ✓ C: default-busy submission ⇒ deterministic fallback to the other roster member, with its own correctly linked client + meeting + Intel entry");
      } finally {
        server.close();
        __test_resetReconciledUsers();
      }
    },
    { tables: [...TABLES], pinGetDbForCrossAsync: true },
  );

  await getGlobalDispatcher().close();
  console.log("\nonboarding-e2e-full-chain: all sections passed (Task #5298).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("onboarding-e2e-full-chain: FAILED —", err?.stack ?? err, err?.cause ?? "");
    process.exit(1);
  },
);
