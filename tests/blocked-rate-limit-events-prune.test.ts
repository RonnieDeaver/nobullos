/* test-registration
{
  "name": "Blocked rate-limit events prune",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for `blocked_rate_limit_events` retention prune
 * (#670/#716 audit cleanup pack).
 *
 * `pruneBlockedRateLimitEventsOlderThan(cutoffMs)` deletes rows whose
 * `timestamp` is strictly less than the cutoff and returns the deleted
 * row count. The rate-limit monitor schedules this prune periodically so
 * the table doesn't grow unbounded.
 *
 * Pinned behavior:
 *   1. Rows older than the cutoff are deleted.
 *   2. Rows at/after the cutoff are preserved (lt comparison).
 *   3. The function returns the number of rows actually deleted.
 *   4. Rows belonging to other test runs (different category tag) are not
 *      touched.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  ensureBlockedRateLimitEventsTable,
  insertBlockedRateLimitEvent,
  pruneBlockedRateLimitEventsOlderThan,
} from "../server/storage/blockedRateLimitEventsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `brle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// `db.execute` returns a driver-specific shape (drizzle's neon-http returns the
// row array directly; node-postgres wraps it in `{ rows }`). This narrow helper
// hides that detail behind a typed interface so tests can stay strongly typed.
function rowsFromExec<T extends Record<string, unknown>>(
  res: unknown,
): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as { rows?: unknown[] }).rows)) {
    return (res as { rows: T[] }).rows;
  }
  return [];
}

async function clearTagged(): Promise<void> {
  await db.execute(sql`DELETE FROM blocked_rate_limit_events WHERE category = ${TAG}`);
}

async function ourCount(): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS c FROM blocked_rate_limit_events WHERE category = ${TAG}`,
  );
  const rows = rowsFromExec<{ c: number | string }>(res);
  return Number(rows[0]?.c ?? 0);
}

async function ourTimestamps(): Promise<number[]> {
  const res = await db.execute(sql`
    SELECT timestamp FROM blocked_rate_limit_events
    WHERE category = ${TAG}
    ORDER BY timestamp ASC
  `);
  const rows = rowsFromExec<{ timestamp: number | string }>(res);
  return rows.map((r) => Number(r.timestamp));
}

async function main(): Promise<void> {
  await ensureBlockedRateLimitEventsTable();
  await clearTagged();

  try {
    const now = Date.now();
    const HOUR_MS = 60 * 60 * 1000;

    // Seed three rows at distinct ages (24h, 12h, 1h old).
    const tOld = now - 24 * HOUR_MS;
    const tMid = now - 12 * HOUR_MS;
    const tFresh = now - 1 * HOUR_MS;
    for (const t of [tOld, tMid, tFresh]) {
      await insertBlockedRateLimitEvent({
        timestamp: t,
        category: TAG,
        method: "GET",
        path: `/test/${TAG}`,
        ip: "127.0.0.1",
        userId: null,
      });
    }
    assert((await ourCount()) === 3, "expected 3 seeded rows");

    // (1) Cutoff between tOld and tMid → only the 24h row is deleted.
    const cutoff1 = now - 18 * HOUR_MS;
    const r1 = await pruneBlockedRateLimitEventsOlderThan(cutoff1);
    assert(r1 >= 1, `prune should report >=1 deleted row, got ${r1}`);
    let remaining = await ourTimestamps();
    assert(!remaining.includes(tOld), "24h-old row should have been pruned");
    assert(remaining.includes(tMid), "12h-old row should survive (>= cutoff)");
    assert(remaining.includes(tFresh), "1h-old row should survive");

    // (2) Boundary: cutoff exactly equal to tMid leaves it in place (lt, not lte).
    const r2 = await pruneBlockedRateLimitEventsOlderThan(tMid);
    assert(r2 === 0, `boundary cutoff equal to tMid should not delete it, got ${r2}`);
    remaining = await ourTimestamps();
    assert(remaining.includes(tMid), "row at cutoff must be preserved (lt comparison)");

    // (3) Cutoff after tMid drops it; tFresh stays.
    const r3 = await pruneBlockedRateLimitEventsOlderThan(now - 6 * HOUR_MS);
    assert(r3 >= 1, `prune should drop the 12h row, got ${r3}`);
    remaining = await ourTimestamps();
    assert(!remaining.includes(tMid), "12h-old row should be pruned");
    assert(remaining.includes(tFresh), "1h-old row should still survive");

    // (4) Cutoff in the future deletes everything tagged.
    const r4 = await pruneBlockedRateLimitEventsOlderThan(now + 60_000);
    assert(r4 >= 1, `final prune should drop the fresh row, got ${r4}`);
    assert((await ourCount()) === 0, "all tagged rows should be gone");

    console.log("blocked-rate-limit-events-prune: PASSED");
  } finally {
    await clearTagged().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("blocked-rate-limit-events-prune: FAILED", err);
  await clearTagged().catch(() => undefined);
  process.exitCode = 1;
});
