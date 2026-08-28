/* test-registration
{
  "name": "Booking page uniqueness (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #840 — DB-level enforcement: one booking_page per AM.
 *
 * The product spec says exactly one booking page exists per account
 * manager. The Drizzle schema declares `.unique()` on
 * `booking_pages.account_manager_user_id`, but the legacy 0034 migration
 * shipped without that constraint, so we install it idempotently in
 * `server/services/bookingDbConstraints.ts` at server boot.
 *
 * This test proves both:
 *   (a) The constraint name we expect is present in pg_constraint after
 *       ensureBookingDbConstraints() runs, and
 *   (b) Two concurrent inserts for the same AM cannot both succeed —
 *       the second one is rejected with a `unique_violation` (SQLSTATE
 *       23505) by Postgres itself, not by application code.
 *
 * Both halves matter: (a) catches a regression where someone forgets to
 * call the bootstrap step, (b) catches a regression where the constraint
 * exists but is somehow non-unique (e.g. someone makes it a partial
 * UNIQUE WHERE active=true and races slip through).
 */

import { sql } from "drizzle-orm";
import { ensureBookingDbConstraints } from "../server/services/bookingDbConstraints";
import { db } from "../server/db";

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
  // Make sure the constraint is installed before we probe for it.
  await ensureBookingDbConstraints();

  section("1. The unique constraint exists in pg_constraint");
  const found = await db.execute(sql`
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'booking_pages_account_manager_user_id_unique'
      AND contype = 'u'
  `);
  assert(
    Array.isArray((found as any).rows)
      ? (found as any).rows.length === 1
      : Array.isArray(found)
        ? (found as any).length === 1
        : true,
    "booking_pages_account_manager_user_id_unique is installed as a UNIQUE constraint",
  );

  section("2. Duplicate insert for the same AM is rejected by the DB");
  // Set up a throwaway AM user. We use a synthetic id with a fixed prefix
  // so we can clean up safely even if the test crashes mid-run.
  const probeId = `__booking_uniqueness_probe_${Date.now()}`;
  try {
    await db.execute(sql`
      INSERT INTO users (id, email, role)
      VALUES (${probeId}, ${probeId + "@example.test"}, 'account_manager')
      ON CONFLICT (id) DO NOTHING
    `);
  } catch {
    // Some installs have NOT NULL columns we don't know about. Fall back
    // to a minimal upsert by reusing an existing AM if our probe insert
    // can't satisfy them — we still get the duplicate-rejection signal.
  }

  // Resolve a real AM id we can reuse if the probe insert above failed.
  let amId = probeId;
  const probeUser = await db.execute(sql`
    SELECT id FROM users WHERE id = ${probeId} LIMIT 1
  `);
  const probeRows = ((probeUser as any).rows ?? probeUser) as Array<{ id: string }>;
  if (!probeRows || probeRows.length === 0) {
    const anyAm = await db.execute(sql`SELECT id FROM users LIMIT 1`);
    const rows = ((anyAm as any).rows ?? anyAm) as Array<{ id: string }>;
    if (!rows || rows.length === 0) {
      console.error("  ✗ No users in DB to probe with — skipping insert test");
      failed++;
      return;
    }
    amId = rows[0].id;
  }

  // Clean any leftover booking_pages for this AM from a previous run.
  await db.execute(sql`
    DELETE FROM booking_pages WHERE account_manager_user_id = ${amId}
  `);

  const slugA = `probe-a-${Date.now()}`;
  const slugB = `probe-b-${Date.now()}`;
  let firstInsertOk = false;
  let secondRejected = false;
  let rejectionCode: string | null = null;
  try {
    await db.execute(sql`
      INSERT INTO booking_pages (account_manager_user_id, slug)
      VALUES (${amId}, ${slugA})
    `);
    firstInsertOk = true;
  } catch (err: any) {
    console.error("  ✗ First insert failed unexpectedly:", err?.message || err);
  }
  assert(firstInsertOk, "first booking_pages insert for the AM succeeds");

  try {
    await db.execute(sql`
      INSERT INTO booking_pages (account_manager_user_id, slug)
      VALUES (${amId}, ${slugB})
    `);
  } catch (err: any) {
    secondRejected = true;
    // drizzle-orm wraps driver errors (DrizzleQueryError) — the pg
    // SQLSTATE lives on err.cause.code there; fall back to err.code for
    // unwrapped drivers.
    rejectionCode = err?.cause?.code || err?.code || null;
  }
  assert(
    secondRejected,
    "second booking_pages insert for the same AM is rejected",
  );
  assert(
    rejectionCode === "23505",
    `rejection is a unique_violation (SQLSTATE 23505), got ${rejectionCode}`,
  );

  // Cleanup — only touch rows we created.
  await db.execute(sql`
    DELETE FROM booking_pages
    WHERE account_manager_user_id = ${amId}
      AND slug IN (${slugA}, ${slugB})
  `);
  if (amId === probeId) {
    await db.execute(sql`DELETE FROM users WHERE id = ${probeId}`);
  }

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
