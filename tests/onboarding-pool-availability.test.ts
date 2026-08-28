/* test-registration
{
  "name": "Onboarding pool availability & assignment resolution (Task #5296)",
  "regression": true,
  "scanPaths": [
    "tests/onboarding-pool-availability.test.ts",
    "migrations/20260827190001_onboarding_roster_role_assignments_cutover.sql"
  ],
  "sweepOnlyReason": "Task #5296 — pool availability/assignment: DB-heavy (runInIsolatedSchema: users, onboarding_assignees, booking_pages, booking_availability_rules, scheduled_meetings).",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small",
  "tierReason": "Isolated-schema (5-table clone) service-layer test with no HTTP harness, mirroring the same-shaped onboarding-roster-route.test.ts's 'small' tier."
}
test-registration */
/**
 * Task #5296 — Onboarding pool availability & assignment (stage 2 of the
 * New Client Onboarding epic).
 *
 * Exercises the real service layer (no mocks, real Postgres via an
 * isolated schema clone) end to end for the two read-only steps of the
 * spec:
 *
 *   (A) `computeAvailableSlotsForPool` (bookingAvailability.ts) — unions
 *       per-candidate availability by exact slot start time, and forces
 *       a uniform duration across all candidates regardless of each
 *       candidate's own page duration.
 *   (B) `computeOnboardingAvailability` / `resolveOnboardingAssignee`
 *       (onboardingBooking.ts) — only ACTIVE roster members are pool
 *       candidates; default-first resolution; fallback to the next
 *       active+available member when the default is busy; a clear
 *       "none_available" result (not a crash or a wrong guess) when
 *       nobody is free; a clear "empty_pool" result when the roster is
 *       empty.
 *
 * `bookOnboardingSlot` (the write path — step 3 of the spec) is
 * deliberately NOT invoked here with a real slot: doing so would run the
 * live Zoom/Google Calendar creation path with real service credentials,
 * which is out of bounds for a hermetic test (see booking-saga.test.ts /
 * booking-calendar-fail-closed.test.ts, which pin that same saga via
 * source assertions rather than a real successful create). This test DOES
 * exercise `bookOnboardingSlot`'s pre-flight resolution guard — it must
 * throw before ever reaching the scheduler when nobody can be resolved —
 * which is real behavior, not mocked.
 *
 * `skipCalendar: true` throughout: no Google Calendar credentials are
 * seeded (none of the test users are "connected"), so the calendar-busy
 * lookup would safely no-op anyway (see fetchCalendarBusy's "no
 * credential" fail-open branch) — skipCalendar just keeps the test fast
 * and independent of `isGoogleCalendarConfigured()`'s env state.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getGlobalDispatcher } from "undici";

import { runInIsolatedSchema } from "./db-sandbox";
import {
  computeAvailableSlotsForPool,
  type PoolCandidate,
} from "../server/services/bookingAvailability";
import {
  computeOnboardingAvailability,
  resolveOnboardingAssignee,
  bookOnboardingSlot,
  OnboardingAssignmentError,
  ONBOARDING_MEETING_DURATION_MINUTES,
} from "../server/services/onboardingBooking";
import { upsertOnboardingAssignee, setOnboardingDefault } from "../server/services/onboardingRoster";
import { ensureBookingPage } from "../server/routes/booking";

const RUN = Math.random().toString(36).slice(2, 8);
const DEFAULT_ID = `test-5296-default-${RUN}`;
const OTHER_ID = `test-5296-other-${RUN}`;
const INACTIVE_ID = `test-5296-inactive-${RUN}`;

const TABLES = [
  "users",
  "sd_departments",
  "sd_department_members",
  "onboarding_assignees",
  "booking_pages",
  "booking_availability_rules",
  "scheduled_meetings",
] as const;

// A fixed future Wednesday at 10:00 UTC — well inside the Mon–Fri
// 09:00–17:00 default availability window seeded by `ensureBookingPage`,
// far enough out to never collide with lead-time guards.
const TARGET_SLOT_UTC = new Date("2031-01-08T10:00:00.000Z");

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed 3 users, all timezone=UTC so the default 09:00–17:00
      // Mon–Fri rules map 1:1 onto UTC without a tz conversion detour.
      await db.execute(sql`
        INSERT INTO users (id, role, first_name, timezone)
        VALUES
          (${DEFAULT_ID}, 'account_manager', 'Default 5296', 'UTC'),
          (${OTHER_ID}, 'account_manager', 'Other 5296', 'UTC'),
          (${INACTIVE_ID}, 'account_manager', 'Inactive 5296', 'UTC')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `);
      await db.execute(sql`
        INSERT INTO sd_departments (id, name, active, assignment_scope, sort_order)
        VALUES (${`test-onboarding-dept-${RUN}`}, 'Onboarding', true, 'company', 1)
      `);

      // ── (0) Empty roster → empty_pool, not a crash or false availability.
      const emptyAvail = await computeOnboardingAvailability({
        fromUtc: new Date(TARGET_SLOT_UTC.getTime() - 60 * 60_000),
        toUtc: new Date(TARGET_SLOT_UTC.getTime() + 60 * 60_000),
        skipCalendar: true,
      });
      assert.equal(emptyAvail.poolSize, 0, "0: empty roster reports poolSize=0");
      assert.deepEqual(emptyAvail.slots, [], "0: empty roster reports zero slots");

      const emptyResolve = await resolveOnboardingAssignee(TARGET_SLOT_UTC, { skipCalendar: true });
      assert.equal(emptyResolve.ok, false, "0: resolution fails on an empty roster");
      if (!emptyResolve.ok) {
        assert.equal(emptyResolve.reason, "empty_pool", "0: reason is empty_pool");
      }

      let emptyBookThrew: unknown;
      try {
        await bookOnboardingSlot({
          startTimeUtc: TARGET_SLOT_UTC,
          invitee: { email: `invitee-${RUN}@test.local` },
        });
      } catch (err) {
        emptyBookThrew = err;
      }
      assert.ok(
        emptyBookThrew instanceof OnboardingAssignmentError,
        "0: bookOnboardingSlot throws OnboardingAssignmentError on an empty roster",
      );
      assert.equal(
        (emptyBookThrew as OnboardingAssignmentError).reason,
        "empty_pool",
        "0: thrown error carries reason=empty_pool",
      );
      console.log("  ✓ 0: empty roster ⇒ empty_pool everywhere (availability, resolution, booking guard)");

      // Seed only the previously deployed authority, then run the real
      // idempotent cutover migration. This is the production-shaped upgrade
      // path: no Role Assignments Onboarding department exists beforehand.
      await db.execute(sql`
        INSERT INTO onboarding_assignees (user_id, active, is_default)
        VALUES
          (${DEFAULT_ID}, true, true),
          (${OTHER_ID}, true, false),
          (${INACTIVE_ID}, false, false)
      `);
      const cutoverSql = readFileSync(
        join(process.cwd(), "migrations/20260827190001_onboarding_roster_role_assignments_cutover.sql"),
        "utf8",
      );
      await db.execute(sql.raw(cutoverSql));

      const migratedDepartment = await db.execute(sql`
        SELECT assignment_scope, default_primary_user_id
        FROM sd_departments
        WHERE lower(trim(name)) = 'onboarding'
      `);
      assert.equal(migratedDepartment.rows.length, 1, "upgrade creates exactly one Onboarding department");
      assert.equal(migratedDepartment.rows[0]?.assignment_scope, "company", "upgrade makes Onboarding company-scoped");
      assert.equal(migratedDepartment.rows[0]?.default_primary_user_id, DEFAULT_ID, "upgrade transfers the legacy default");

      // ── Build/reaffirm the roster: DEFAULT (default), OTHER (active), INACTIVE (inactive).
      await upsertOnboardingAssignee(DEFAULT_ID);
      await upsertOnboardingAssignee(OTHER_ID);
      await upsertOnboardingAssignee(INACTIVE_ID);
      const setDefault = await setOnboardingDefault(DEFAULT_ID);
      assert.equal(setDefault.ok, true, "setup: setOnboardingDefault must succeed");
      const inactiveRow = await db.execute(sql`
        UPDATE sd_department_members SET active = false WHERE user_id = ${INACTIVE_ID}
      `);
      void inactiveRow;

      // ── (1) Pool availability: only ACTIVE members appear; both DEFAULT
      // and OTHER are free at TARGET_SLOT_UTC (no scheduled_meetings yet).
      const avail1 = await computeOnboardingAvailability({
        fromUtc: new Date(TARGET_SLOT_UTC.getTime() - 60 * 60_000),
        toUtc: new Date(TARGET_SLOT_UTC.getTime() + 60 * 60_000),
        skipCalendar: true,
      });
      assert.equal(avail1.poolSize, 2, `1: only active members counted (got poolSize=${avail1.poolSize})`);
      const slotAt1 = avail1.slots.find((s) => s.startUtc.getTime() === TARGET_SLOT_UTC.getTime());
      assert.ok(slotAt1, "1: the target slot is reported as available for the pool");
      assert.deepEqual(
        [...slotAt1!.availableUserIds].sort(),
        [DEFAULT_ID, OTHER_ID].sort(),
        "1: both active members are free at the target slot",
      );
      console.log("  ✓ 1: pool availability excludes inactive members, unions active ones by slot start");

      // ── (2) Resolution: default is free ⇒ resolves to DEFAULT.
      const resolve1 = await resolveOnboardingAssignee(TARGET_SLOT_UTC, { skipCalendar: true });
      assert.equal(resolve1.ok, true, "2: resolution succeeds when the default is free");
      if (resolve1.ok) {
        assert.equal(resolve1.userId, DEFAULT_ID, "2: default-first — resolves to the default person");
      }
      console.log("  ✓ 2: default-first resolution picks the default when they're free");

      // ── (3) Make DEFAULT busy at the target slot ⇒ resolution falls
      // back to OTHER (still active + available).
      const defaultPage = await ensureBookingPage({ id: DEFAULT_ID, timezone: "UTC" });
      const busyEnd = new Date(TARGET_SLOT_UTC.getTime() + ONBOARDING_MEETING_DURATION_MINUTES * 60_000);
      await db.execute(sql`
        INSERT INTO scheduled_meetings
          (account_manager_user_id, booking_page_id, booking_source, invitee_email,
           start_time_utc, end_time_utc, timezone, status)
        VALUES
          (${DEFAULT_ID}, ${defaultPage.id}, 'client_profile', ${`busy-${RUN}@test.local`},
           ${TARGET_SLOT_UTC.toISOString()}::timestamp, ${busyEnd.toISOString()}::timestamp, 'UTC', 'confirmed')
      `);

      const resolve2 = await resolveOnboardingAssignee(TARGET_SLOT_UTC, { skipCalendar: true });
      assert.equal(resolve2.ok, true, "3: resolution still succeeds via fallback");
      if (resolve2.ok) {
        assert.equal(resolve2.userId, OTHER_ID, "3: falls back to the first other available active member");
      }
      const defaultAttempt = resolve2.ok
        ? resolve2.attempts.find((a) => a.userId === DEFAULT_ID)
        : undefined;
      assert.equal(defaultAttempt?.available, false, "3: the busy default is recorded as unavailable, not skipped silently");
      console.log("  ✓ 3: default busy ⇒ deterministic fallback to the next active+available member");

      // ── (4) Make OTHER busy too ⇒ nobody available (never guesses, never
      // double-assigns) — and bookOnboardingSlot must refuse BEFORE the
      // scheduler is ever invoked.
      const otherPage = await ensureBookingPage({ id: OTHER_ID, timezone: "UTC" });
      await db.execute(sql`
        INSERT INTO scheduled_meetings
          (account_manager_user_id, booking_page_id, booking_source, invitee_email,
           start_time_utc, end_time_utc, timezone, status)
        VALUES
          (${OTHER_ID}, ${otherPage.id}, 'client_profile', ${`busy2-${RUN}@test.local`},
           ${TARGET_SLOT_UTC.toISOString()}::timestamp, ${busyEnd.toISOString()}::timestamp, 'UTC', 'confirmed')
      `);

      const resolve3 = await resolveOnboardingAssignee(TARGET_SLOT_UTC, { skipCalendar: true });
      assert.equal(resolve3.ok, false, "4: nobody available ⇒ ok=false");
      if (!resolve3.ok) {
        assert.equal(resolve3.reason, "none_available", "4: reason is none_available (not empty_pool)");
        assert.equal(resolve3.attempts.length, 2, "4: both active members recorded an attempt");
        assert.ok(
          resolve3.attempts.every((a) => a.available === false),
          "4: every attempt is marked unavailable — no ambiguous or accidental match",
        );
      }

      const avail2 = await computeOnboardingAvailability({
        fromUtc: new Date(TARGET_SLOT_UTC.getTime() - 60 * 60_000),
        toUtc: new Date(TARGET_SLOT_UTC.getTime() + 60 * 60_000),
        skipCalendar: true,
      });
      const slotAt2 = avail2.slots.find((s) => s.startUtc.getTime() === TARGET_SLOT_UTC.getTime());
      assert.equal(slotAt2, undefined, "4: the fully-booked slot no longer appears in pool availability at all");

      let noneBookThrew: unknown;
      const beforeCount = await db.execute(sql`SELECT COUNT(*)::int AS n FROM scheduled_meetings WHERE booking_source = 'onboarding_pool'`);
      try {
        await bookOnboardingSlot({
          startTimeUtc: TARGET_SLOT_UTC,
          invitee: { email: `invitee2-${RUN}@test.local` },
        });
      } catch (err) {
        noneBookThrew = err;
      }
      assert.ok(
        noneBookThrew instanceof OnboardingAssignmentError,
        "4: bookOnboardingSlot throws OnboardingAssignmentError when nobody is available",
      );
      assert.equal(
        (noneBookThrew as OnboardingAssignmentError).reason,
        "none_available",
        "4: thrown error carries reason=none_available",
      );
      const afterCount = await db.execute(sql`SELECT COUNT(*)::int AS n FROM scheduled_meetings WHERE booking_source = 'onboarding_pool'`);
      const before = ((beforeCount as any).rows ?? beforeCount)[0].n;
      const after = ((afterCount as any).rows ?? afterCount)[0].n;
      assert.equal(after, before, "4: no meeting row was created — the refusal happens BEFORE the scheduler runs");
      console.log("  ✓ 4: nobody available ⇒ clear refusal, zero side effects, no ambiguous booking");

      // ── (5) computeAvailableSlotsForPool forces a UNIFORM duration
      // across candidates, overriding each candidate's own page duration.
      await db.execute(sql`UPDATE booking_pages SET duration_minutes = 90 WHERE id = ${defaultPage.id}`);
      const patchedPage = { ...defaultPage, durationMinutes: 90 };
      const candidates: PoolCandidate[] = [{ userId: DEFAULT_ID, page: patchedPage }];
      // Probe a slot beyond DEFAULT's busy block above so it's genuinely free.
      const probeStart = new Date(TARGET_SLOT_UTC.getTime() + 3 * 60 * 60_000); // +3h, still within 09-17 UTC
      const forced = await computeAvailableSlotsForPool(candidates, {
        fromUtc: probeStart,
        toUtc: new Date(probeStart.getTime() + 60 * 60_000),
        durationMinutes: ONBOARDING_MEETING_DURATION_MINUTES,
        skipCalendar: true,
      });
      assert.equal(forced.unresolvedCandidates.length, 0, "5: no calendar failures for this probe");
      const forcedSlot = forced.slots.find((s) => s.startUtc.getTime() === probeStart.getTime());
      assert.ok(forcedSlot, "5: forced-duration probe slot is available");
      assert.equal(
        forcedSlot!.endUtc.getTime() - forcedSlot!.startUtc.getTime(),
        ONBOARDING_MEETING_DURATION_MINUTES * 60_000,
        "5: slot length uses the forced pool duration (30m), not the candidate's own page duration (90m)",
      );
      console.log("  ✓ 5: computeAvailableSlotsForPool forces a uniform duration across all candidates");
    },
    { tables: [...TABLES] },
  );

  await getGlobalDispatcher().close();
  console.log("\nonboarding-pool-availability: all sections passed (Task #5296).");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("onboarding-pool-availability: FAILED —", err?.stack ?? err, err?.cause ?? "");
    process.exit(1);
  },
);
