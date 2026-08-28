/* test-registration
{
  "name": "Booking db constraint status (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Tests for the booking DB-constraint readiness surface added in the
 * twelfth-round code-review remediation:
 *
 *   - `ensureBookingDbConstraints` returns a structured
 *     `BookingDbConstraintStatus` describing which DB-level guards are
 *     installed (the previous version returned void).
 *   - `getBookingDbConstraintStatus` exposes the cached most-recent
 *     result so the admin health endpoint can surface it without
 *     re-running the DDL probe.
 *   - After the bootstrap runs against a healthy DB, both critical
 *     constraints (`scheduled_meetings_no_overlap` EXCLUDE and
 *     `booking_pages_account_manager_user_id_unique` UNIQUE) are
 *     reported as `installed: true` and the aggregate `ready` is true.
 *
 * Run with `npx tsx tests/booking-db-constraint-status.test.ts`.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  ensureBookingDbConstraints,
  getBookingDbConstraintStatus,
} from "../server/services/bookingDbConstraints";

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  const symbol = ok ? "✓" : "✗";
  console.log(
    `  ${symbol} ${name}${detail ? ` (${detail})` : ""}`,
  );
}

async function main(): Promise<void> {
  console.log("\n— 1. ensureBookingDbConstraints returns structured status —");
  const status = await ensureBookingDbConstraints();
  check(
    "result has scheduledMeetingsNoOverlap.installed boolean",
    typeof status.scheduledMeetingsNoOverlap.installed === "boolean",
  );
  check(
    "result has bookingPagesAccountManagerUnique.installed boolean",
    typeof status.bookingPagesAccountManagerUnique.installed === "boolean",
  );
  check(
    "result has btreeGistExtension.installed boolean",
    typeof status.btreeGistExtension.installed === "boolean",
  );
  check(
    "result has aggregate `ready` boolean",
    typeof status.ready === "boolean",
  );

  console.log("\n— 2. After bootstrap, constraints are present in pg_constraint —");
  const result: any = await db.execute(sql`
    SELECT conname FROM pg_constraint
    WHERE conname IN (
      'scheduled_meetings_no_overlap',
      'booking_pages_account_manager_user_id_unique'
    )
  `);
  const rows: Array<{ conname: string }> = Array.isArray(result)
    ? result
    : (result as any).rows ?? [];
  const present = new Set(rows.map((r) => r.conname));
  check(
    "scheduled_meetings_no_overlap is present",
    present.has("scheduled_meetings_no_overlap"),
  );
  check(
    "booking_pages_account_manager_user_id_unique is present",
    present.has("booking_pages_account_manager_user_id_unique"),
  );

  console.log("\n— 3. Status reflects DB reality (verification probe ran) —");
  check(
    "status.scheduledMeetingsNoOverlap.installed === true",
    status.scheduledMeetingsNoOverlap.installed === true,
    `installed=${status.scheduledMeetingsNoOverlap.installed}`,
  );
  check(
    "status.bookingPagesAccountManagerUnique.installed === true",
    status.bookingPagesAccountManagerUnique.installed === true,
    `installed=${status.bookingPagesAccountManagerUnique.installed}`,
  );
  check(
    "aggregate status.ready === true",
    status.ready === true,
    `ready=${status.ready}`,
  );

  console.log("\n— 4. getBookingDbConstraintStatus returns cached result —");
  const cached = getBookingDbConstraintStatus();
  check(
    "cached status matches the bootstrap return value",
    cached.ready === status.ready &&
      cached.scheduledMeetingsNoOverlap.installed ===
        status.scheduledMeetingsNoOverlap.installed &&
      cached.bookingPagesAccountManagerUnique.installed ===
        status.bookingPagesAccountManagerUnique.installed,
  );

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch((err) => {
    console.error("FATAL:", err);
    process.exitCode = 1;
  });
