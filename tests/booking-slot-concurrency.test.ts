/* test-registration
{
  "name": "Booking slot concurrency (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #840 — DB-level enforcement: two concurrent bookings for the same AM
 * cannot end up with overlapping scheduled_meetings.
 *
 * The booking saga uses a Postgres advisory lock as a fast-path serial gate
 * to avoid wasted Zoom API calls when two callers race for the same slot.
 * However, the *correctness* guarantee for "no double-bookings ever" is the
 * `scheduled_meetings_no_overlap` EXCLUDE-tsrange constraint installed by
 * `ensureBookingDbConstraints`. This test exercises that DB guarantee
 * directly:
 *
 *   1. Confirms the EXCLUDE constraint is present in pg_constraint.
 *   2. Inserts the first scheduled_meetings row for an AM at [10:00, 10:30)
 *      with status='creating' — this should succeed.
 *   3. Concurrently fires N inserts for the same AM that all overlap
 *      [10:00, 10:30) — exactly one should succeed, the rest should be
 *      rejected by Postgres with SQLSTATE 23P01 (exclusion_violation),
 *      not by application code.
 *   4. Verifies that across all rows, only ONE confirmed/creating row
 *      remains in the AM's [10:00, 10:30) window.
 *
 * This protects the core acceptance criterion of the task ("AMs and clients
 * can never end up with overlapping bookings") even if the advisory lock
 * implementation is somehow disabled, broken, or bypassed.
 */

import { sql } from "drizzle-orm";
import { ensureBookingDbConstraints } from "../server/services/bookingDbConstraints";
import { db, apiPool } from "../server/db";

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

async function main(): Promise<void> {
  await ensureBookingDbConstraints();

  section("1. The EXCLUDE constraint exists in pg_constraint");
  const found = await db.execute(sql`
    SELECT contype
    FROM pg_constraint
    WHERE conname = 'scheduled_meetings_no_overlap'
  `);
  const foundRows = ((found as any).rows ?? found) as Array<{ contype: string }>;
  assert(
    foundRows.length === 1 && foundRows[0]?.contype === "x",
    "scheduled_meetings_no_overlap is installed as an EXCLUDE constraint",
  );

  section("2. Concurrent overlapping inserts: exactly one wins");

  // Pick a real AM id. We don't insert one ourselves because users has FK
  // constraints we can't reliably satisfy across environments.
  const anyAm = await db.execute(sql`SELECT id FROM users LIMIT 1`);
  const amRows = ((anyAm as any).rows ?? anyAm) as Array<{ id: string }>;
  if (!amRows || amRows.length === 0) {
    console.error("  ✗ No users in DB — skipping concurrency test");
    failed++;
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }
  const amId = amRows[0].id;

  // Use a far-future slot so it never collides with real bookings, and a
  // unique millisecond offset so re-runs don't interfere.
  const now = Date.now();
  const baseStart = new Date(now + 365 * 24 * 60 * 60 * 1000); // ~1 year out
  baseStart.setUTCMinutes(0, 0, 0);
  const startUtc = baseStart;
  const endUtc = new Date(startUtc.getTime() + 30 * 60 * 1000);

  // Clean any leftovers from a prior run inside the probe window.
  await db.execute(sql`
    DELETE FROM scheduled_meetings
    WHERE account_manager_user_id = ${amId}
      AND start_time_utc >= ${startUtc.toISOString()}::timestamp
      AND start_time_utc < ${new Date(startUtc.getTime() + 60 * 60 * 1000).toISOString()}::timestamp
  `);

  // Fire 5 concurrent inserts that all overlap the [start, start+30m) window.
  // Each uses a different sub-range so we also verify "any overlap" not just
  // "exact match" is caught:
  // IMPORTANT: every range must overlap every other range (they all
  // contain [00:20, 00:25)), otherwise a subset of mutually
  // non-overlapping ranges can legitimately ALL win depending on commit
  // order and "exactly one winner" would be a wrong assertion. The
  // original offsets (#2 [00:00,00:15), #3 [00:15,00:25), #4
  // [00:25,00:55)) had exactly that flaw.
  //   #0 [00:00, 00:30)  — exact
  //   #1 [00:10, 00:40)  — overlaps right
  //   #2 [00:05, 00:25)  — overlaps left
  //   #3 [00:15, 00:35)  — inside/right
  //   #4 [00:20, 00:55)  — overlaps tail
  const offsets: Array<[number, number]> = [
    [0, 30],
    [10, 40],
    [5, 25],
    [15, 35],
    [20, 55],
  ];

  // Use the same apiPool that production uses so each insert gets its own
  // pooled connection — that's what "concurrent inserts" means in practice.
  async function attemptInsert(
    offsetStart: number,
    offsetEnd: number,
    label: string,
  ): Promise<{ ok: boolean; code: string | null }> {
    const client = await apiPool.connect();
    try {
      const s = new Date(startUtc.getTime() + offsetStart * 60 * 1000);
      const e = new Date(startUtc.getTime() + offsetEnd * 60 * 1000);
      try {
        await client.query(
          `INSERT INTO scheduled_meetings
             (account_manager_user_id, booking_source, invitee_email,
              start_time_utc, end_time_utc, timezone, status)
           VALUES ($1, 'public_link', $2, $3, $4, 'UTC', 'creating')`,
          [amId, `${label}@probe.test`, s.toISOString(), e.toISOString()],
        );
        return { ok: true, code: null };
      } catch (err: any) {
        return { ok: false, code: err?.code || null };
      }
    } finally {
      client.release();
    }
  }

  const results = await Promise.all(
    offsets.map(([s, e], i) => attemptInsert(s, e, `probe-${now}-${i}`)),
  );

  const winners = results.filter((r) => r.ok).length;
  const losers = results.filter((r) => !r.ok);
  // Concurrent EXCLUDE-constraint checks can also resolve a race as a
  // deadlock (40P01) instead of an exclusion violation (23P01). Either
  // way the insert is REJECTED by Postgres and the no-overlap invariant
  // holds — so accept both SQLSTATEs for losers.
  const rejectedLosers = losers.filter(
    (r) => r.code === "23P01" || r.code === "40P01",
  ).length;

  assert(
    winners === 1,
    `exactly one insert succeeds (got ${winners} of ${results.length})`,
  );
  assert(
    rejectedLosers === losers.length,
    `every losing insert is rejected by Postgres with 23P01/40P01 (got ${rejectedLosers} of ${losers.length}; codes=${JSON.stringify(losers.map((l) => l.code))})`,
  );

  // Final check: the DB now contains exactly ONE active row in this window.
  const surviving = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM scheduled_meetings
    WHERE account_manager_user_id = ${amId}
      AND status IN ('creating', 'confirmed')
      AND tsrange(start_time_utc, end_time_utc, '[)')
          && tsrange(${startUtc.toISOString()}::timestamp,
                     ${endUtc.toISOString()}::timestamp, '[)')
  `);
  const survivingRows = ((surviving as any).rows ?? surviving) as Array<{ n: number }>;
  assert(
    survivingRows[0]?.n === 1,
    `exactly one active scheduled_meetings row remains in the contested window (got ${survivingRows[0]?.n})`,
  );

  // Cleanup
  await db.execute(sql`
    DELETE FROM scheduled_meetings
    WHERE account_manager_user_id = ${amId}
      AND start_time_utc >= ${startUtc.toISOString()}::timestamp
      AND start_time_utc < ${new Date(startUtc.getTime() + 60 * 60 * 1000).toISOString()}::timestamp
  `);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("Test crashed:", err);
  process.exitCode = 1;
});
