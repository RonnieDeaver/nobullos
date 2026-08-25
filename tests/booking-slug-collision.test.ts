/* test-registration
{
  "name": "Booking page slug uniqueness across same-named AMs (Task #967)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #967 — Cross-AM slug collision regression for ensureBookingPage.
 *
 * The lazy-create path in `server/routes/booking.ts` derives a public
 * slug from the AM's first/last name (or email local part) and then
 * tries up to 6 random `-XXXX` suffixes if a *different* AM already
 * owns that base slug. The Task #892 suite (`tests/booking-am-overrides.test.ts`)
 * pins the same-AM race on the `account_manager_user_id` unique
 * constraint, but never exercises the cross-AM case where two distinct
 * users derive the *same* base slug.
 *
 * If that suffix loop ever regresses (short-circuits to 0 attempts,
 * tries the same suffix twice, or hands the unique-violation back to
 * the caller) then the second AM's first visit to the Schedule panel
 * would 500 on `booking_pages_slug_unique`.
 *
 * This test:
 *   1. Seeds two AMs with identical first/last names (so
 *      `suggestSlugForUser` returns the same base slug for both).
 *   2. Calls `ensureBookingPage` for them back-to-back, then asserts
 *      both rows exist with the same base prefix but distinct slugs.
 *   3. Seeds a third pair of identically-named AMs and races
 *      `ensureBookingPage` for both concurrently — both promises must
 *      resolve to distinct rows with distinct slugs (no unhandled
 *      unique-violation, no shared row).
 */

import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { ensureBookingPage } from "../server/routes/booking";
import { ensureBookingDbConstraints } from "../server/services/bookingDbConstraints";

let failed = 0;
let passed = 0;
const seededUserIds: string[] = [];

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

async function seedAm(stamp: string, suffix: string, first: string, last: string): Promise<{
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
}> {
  const id = `__probe_am_967_${stamp}_${suffix}`;
  const email = `probe-am-967-${stamp}-${suffix}@example.invalid`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, timezone)
    VALUES (
      ${id}, ${email}, ${first}, ${last},
      'account_manager', 'America/Chicago'
    )
  `);
  seededUserIds.push(id);
  return { id, email, firstName: first, lastName: last, timezone: "America/Chicago" };
}

async function cleanup(): Promise<void> {
  if (seededUserIds.length === 0) return;
  for (const id of seededUserIds) {
    await db.execute(sql`
      DELETE FROM booking_availability_rules
      WHERE booking_page_id IN (
        SELECT id FROM booking_pages WHERE account_manager_user_id = ${id}
      )
    `);
    await db.execute(sql`DELETE FROM booking_pages WHERE account_manager_user_id = ${id}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
  }
}

async function main(): Promise<void> {
  await ensureBookingDbConstraints();

  const stamp = String(Date.now());
  // Use a deliberately unusual surname so the derived slug is unlikely
  // to collide with anything else in the dev DB. The first+last pair
  // resolves to slug "qa-collisionprobe967<stamp>".
  const first = "QA";
  const last = `CollisionProbe967${stamp}`;
  const expectedBase = `qa-collisionprobe967${stamp}`.slice(0, 32);

  // -----------------------------------------------------------------------
  section("1. Sequential ensureBookingPage for two same-named AMs");
  // -----------------------------------------------------------------------
  const u1 = await seedAm(stamp, "seqA", first, last);
  const u2 = await seedAm(stamp, "seqB", first, last);

  const p1 = await ensureBookingPage(u1);
  const p2 = await ensureBookingPage(u2);

  assert(!!p1?.id && !!p2?.id, "both calls returned a persisted booking_pages row");
  assert(p1.id !== p2.id, `each AM owns a distinct row id (${p1.id} vs ${p2.id})`);
  assert(
    p1.accountManagerUserId === u1.id && p2.accountManagerUserId === u2.id,
    "each row is owned by the requesting AM",
  );
  assert(
    p1.slug !== p2.slug,
    `slugs differ across AMs (got "${p1.slug}" vs "${p2.slug}")`,
  );
  assert(
    p1.slug === expectedBase,
    `first AM keeps the base slug (got "${p1.slug}", expected "${expectedBase}")`,
  );
  assert(
    p2.slug.startsWith(`${expectedBase}-`) && p2.slug.length > expectedBase.length + 1,
    `second AM gets the base slug + random suffix (got "${p2.slug}")`,
  );

  // Idempotent re-call returns the same row, doesn't drift to a new slug.
  const p1b = await ensureBookingPage(u1);
  const p2b = await ensureBookingPage(u2);
  assert(p1b.id === p1.id && p1b.slug === p1.slug, "re-calling for AM1 is stable");
  assert(p2b.id === p2.id && p2b.slug === p2.slug, "re-calling for AM2 is stable");

  // -----------------------------------------------------------------------
  section("2. Concurrent ensureBookingPage for two same-named AMs");
  // -----------------------------------------------------------------------
  const u3 = await seedAm(stamp, "raceA", first, last);
  const u4 = await seedAm(stamp, "raceB", first, last);

  const settled = await Promise.allSettled([
    ensureBookingPage(u3),
    ensureBookingPage(u4),
  ]);
  const fulfilled = settled.filter((s) => s.status === "fulfilled") as Array<
    PromiseFulfilledResult<Awaited<ReturnType<typeof ensureBookingPage>>>
  >;
  const rejected = settled.filter((s) => s.status === "rejected") as Array<
    PromiseRejectedResult
  >;

  assert(
    fulfilled.length === 2,
    `both concurrent calls resolved (got ${fulfilled.length} fulfilled, ${rejected.length} rejected${
      rejected.length ? `: ${String((rejected[0] as any).reason).slice(0, 200)}` : ""
    })`,
  );

  if (fulfilled.length === 2) {
    const [r3, r4] = fulfilled.map((s) => s.value);
    assert(r3.id !== r4.id, `concurrent racers got distinct row ids (${r3.id} vs ${r4.id})`);
    assert(
      r3.slug !== r4.slug,
      `concurrent racers got distinct slugs (got "${r3.slug}" vs "${r4.slug}")`,
    );
    // Each concurrent racer either kept the base slug outright (one
    // can win the no-collision branch if its getBookingPageBySlug
    // probe completes before the other's insert) or got the base slug
    // plus a `-XXXX` suffix. Anything else (a totally different base,
    // a truncated base) means the suffix loop drifted.
    const expectsExact = (s: string) => s === expectedBase;
    const expectsSuffix = (s: string) =>
      s.startsWith(`${expectedBase}-`) && s.length > expectedBase.length + 1;
    assert(
      (expectsExact(r3.slug) || expectsSuffix(r3.slug)) &&
        (expectsExact(r4.slug) || expectsSuffix(r4.slug)),
      `both slugs are either the exact base or base + suffix (got "${r3.slug}", "${r4.slug}", base="${expectedBase}")`,
    );
    assert(
      r3.accountManagerUserId === u3.id && r4.accountManagerUserId === u4.id,
      "each concurrent winner is owned by the requesting AM",
    );

    // The DB row count must agree — exactly two new pages, never one
    // shared row (which would signal the race collapsed silently) and
    // never three (which would signal a duplicate insert).
    const countRes = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM booking_pages
      WHERE account_manager_user_id IN (${u3.id}, ${u4.id})
    `);
    const countRows = ((countRes as any).rows ?? countRes) as Array<{ n: number }>;
    assert(
      countRows[0]?.n === 2,
      `exactly two booking_pages rows persisted for the concurrent pair (got ${countRows[0]?.n})`,
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
    await cleanup().catch((err) => {
      console.error("Cleanup error (non-fatal):", err);
    });
    process.exitCode = failed > 0 ? 1 : 0;
  });
