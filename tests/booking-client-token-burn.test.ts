/* test-registration
{
  "name": "Booking client token burn (baseline triage, Task #3424)",
  "scanPaths": [
    "server/routes/booking.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #840 — client-bound token "burn after successful booking" semantics.
 *
 * Failure mode this test guards against:
 *   The public confirm endpoint used to call `markBookingClientTokenUsed`
 *   eagerly, BEFORE invoking the booking saga. If the saga then failed
 *   (slot race, Zoom failure, Calendar failure, validation conflict), the
 *   token was already burned and the client could not retry — they had to
 *   ask the AM for a brand new link. That violated the durable-link
 *   guarantee the spec promises.
 *
 * The fix has two parts that this test verifies:
 *   1. `markBookingClientTokenUsed` is now atomic: it only sets `usedAt`
 *      WHERE `usedAt IS NULL`. Calling it a second time returns
 *      undefined, which is what tells the route to roll back a
 *      simultaneously-confirmed booking instead of silently overwriting
 *      another request's claim.
 *   2. The route in `server/routes/booking.ts` calls
 *      `markBookingClientTokenUsed` ONLY after `scheduler.bookSlot(...)`
 *      returns successfully — never before. (Static source check, since
 *      spinning up a full saga w/ Zoom + Calendar mocks here would be
 *      flaky and expensive.)
 */

import * as fs from "fs";
import * as path from "path";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  createBookingClientToken,
  markBookingClientTokenUsed,
} from "../server/storage/bookingStorage";

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
  section("1. markBookingClientTokenUsed is atomic (single-burn)");
  // Set up the minimum DAG required for a token row: user → client →
  // page → token. Use stable __probe_ prefixes so we can clean up safely.
  const stamp = Date.now();
  const userId = `__probe_user_${stamp}`;
  const clientId = `__probe_client_${stamp}`;
  const pageId = `__probe_page_${stamp}`;
  const slug = `probe-${stamp}`;

  let setupOk = false;
  try {
    await db.execute(sql`
      INSERT INTO users (id, email, role)
      VALUES (${userId}, ${userId + "@example.test"}, 'account_manager')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO clients (id, name, owner_id)
      VALUES (${clientId}, ${"Probe Client " + stamp}, ${userId})
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO booking_pages (id, account_manager_user_id, slug)
      VALUES (${pageId}, ${userId}, ${slug})
      ON CONFLICT (id) DO NOTHING
    `);
    setupOk = true;
  } catch (err: any) {
    console.warn(
      "  ⚠ Could not seed probe rows (likely missing NOT NULL columns in this env):",
      err?.message || err,
    );
  }

  if (!setupOk) {
    console.log("  • Skipping live-DB burn check; static check below still runs.");
  } else {
    const tokenHash = `__probe_hash_${stamp}`;
    const token = await createBookingClientToken({
      tokenHash,
      clientId,
      accountManagerUserId: userId,
      bookingPageId: pageId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdByUserId: userId,
    });
    assert(!!token?.id && token.usedAt === null, "fresh token starts unused");

    const firstBurn = await markBookingClientTokenUsed(token.id);
    assert(
      !!firstBurn && firstBurn.usedAt instanceof Date,
      "first burn succeeds and stamps usedAt",
    );

    const secondBurn = await markBookingClientTokenUsed(token.id);
    assert(
      secondBurn === undefined,
      "second burn returns undefined (atomic single-claim)",
    );

    // Cleanup — only rows we created.
    await db.execute(sql`DELETE FROM booking_client_tokens WHERE id = ${token.id}`);
    await db.execute(sql`DELETE FROM booking_pages WHERE id = ${pageId}`);
    await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  }

  section("2. Route burns the token only AFTER bookSlot succeeds");
  const ROUTES = fs.readFileSync(
    path.join(process.cwd(), "server/routes/booking.ts"),
    "utf8",
  );
  // Find the public-confirm handler block.
  const confirmIdx = ROUTES.indexOf('"/api/public/booking/:slug/confirm"');
  assert(confirmIdx >= 0, "public confirm handler is registered");

  // Within that handler, the relative ordering must be:
  //   bookSlot(...)    →    markBookingClientTokenUsed(...)
  // i.e. mark-used must NOT appear before bookSlot.
  const handlerSlice = ROUTES.slice(confirmIdx);
  const bookSlotIdx = handlerSlice.indexOf("scheduler.bookSlot");
  const burnIdx = handlerSlice.indexOf("markBookingClientTokenUsed");
  assert(bookSlotIdx > 0, "handler invokes scheduler.bookSlot");
  assert(burnIdx > 0, "handler invokes markBookingClientTokenUsed");
  assert(
    burnIdx > bookSlotIdx,
    "markBookingClientTokenUsed runs AFTER scheduler.bookSlot (no eager pre-burn)",
  );

  // And on a failed burn (lost the race) the handler must roll back the
  // booking it just confirmed — otherwise we'd leak a meeting.
  assert(
    /cancelBooking\([^)]*result\.meeting\.id/.test(handlerSlice),
    "handler cancels the booking when the token burn loses the concurrency race",
  );

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
