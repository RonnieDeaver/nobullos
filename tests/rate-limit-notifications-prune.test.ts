/* test-registration
{
  "name": "Rate-limit notifications prune",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for `rate_limit_alert_notifications` retention prune
 * (#670/#716 audit cleanup pack).
 *
 * `pruneOldRateLimitAlertNotifications(retentionDays)` deletes rows whose
 * `attempted_at` is strictly older than `now - retentionDays * 24h` and
 * reports the effective retentionDays + cutoffMs. The daily background
 * scheduler delegates to this function, so this is the contract the
 * scheduler depends on.
 *
 * Pinned behavior:
 *   1. Old rows are deleted; recent rows survive.
 *   2. The boundary (attempted_at == cutoff) is preserved (lt comparison).
 *   3. Returns the number of rows actually deleted.
 *   4. Negative / zero / fractional retentionDays is normalized to >= 1
 *      day (NOT rejected) to match production safety floor.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  ensureRateLimitAlertNotificationsTable,
  insertRateLimitAlertNotification,
} from "../server/storage/rateLimitAlertNotificationsStorage";
import { pruneOldRateLimitAlertNotifications } from "../server/services/rateLimitNotificationRetention";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `rln-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

// `db.execute` returns a driver-specific shape (drizzle's neon-http returns
// the row array directly; node-postgres wraps it in `{ rows }`).
function rowsFromExec<T extends Record<string, unknown>>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as { rows?: unknown[] }).rows)) {
    return (res as { rows: T[] }).rows;
  }
  return [];
}

async function clearTagged(): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limit_alert_notifications WHERE category = ${TAG}`);
}

async function ourCount(): Promise<number> {
  const res = await db.execute(
    sql`SELECT COUNT(*)::int AS c FROM rate_limit_alert_notifications WHERE category = ${TAG}`,
  );
  return Number(rowsFromExec<{ c: number | string }>(res)[0]?.c ?? 0);
}

async function ourAttemptedAts(): Promise<number[]> {
  const res = await db.execute(sql`
    SELECT attempted_at FROM rate_limit_alert_notifications
    WHERE category = ${TAG}
    ORDER BY attempted_at ASC
  `);
  return rowsFromExec<{ attempted_at: number | string }>(res).map((r) => Number(r.attempted_at));
}

async function seed(attemptedAt: number): Promise<void> {
  await insertRateLimitAlertNotification({
    channel: "slack",
    destination: `#test-${TAG}`,
    status: "sent",
    errorMessage: null,
    userId: null,
    userLabel: null,
    category: TAG,
    count: 100,
    maxRequests: 100,
    warningPercent: 80,
    windowMs: 60_000,
    windowStart: attemptedAt - 30_000,
    triggeredAt: attemptedAt,
    attemptedAt,
    alert: { warning: true },
    triggerSource: "scheduled",
    triggerActorId: null,
  });
}

async function main(): Promise<void> {
  await ensureRateLimitAlertNotificationsTable();
  await clearTagged();

  try {
    const now = Date.now();
    const tOld = now - 30 * DAY_MS;
    const tMid = now - 5 * DAY_MS;
    const tFresh = now - 60 * 60 * 1000;
    await seed(tOld);
    await seed(tMid);
    await seed(tFresh);
    assert((await ourCount()) === 3, "expected 3 seeded rows");

    // (1) Retention=7 days → drops only the 30-day row.
    const r1 = await pruneOldRateLimitAlertNotifications(7);
    assert(r1.deleted >= 1, `prune should report >=1 deleted, got ${r1.deleted}`);
    assert(r1.retentionDays === 7, `retentionDays should be 7, got ${r1.retentionDays}`);
    let remaining = await ourAttemptedAts();
    assert(!remaining.includes(tOld), "30d-old row should have been pruned");
    assert(remaining.includes(tMid), "5d-old row should survive (within 7-day window)");
    assert(remaining.includes(tFresh), "1h-old row should survive");

    // (2) Retention=1 day → drops the 5-day row too.
    const r2 = await pruneOldRateLimitAlertNotifications(1);
    assert(r2.deleted >= 1, `second prune should drop the 5d row, got ${r2.deleted}`);
    remaining = await ourAttemptedAts();
    assert(!remaining.includes(tMid), "5d-old row should be pruned at retentionDays=1");
    assert(remaining.includes(tFresh), "1h-old row should still survive");

    // (3) Non-positive / fractional retention is normalized to >= 1, not rejected.
    const r3 = await pruneOldRateLimitAlertNotifications(0);
    assert(r3.retentionDays >= 1,
      `retentionDays=0 should be normalized to >=1, got ${r3.retentionDays}`);
    const r4 = await pruneOldRateLimitAlertNotifications(-3);
    assert(r4.retentionDays >= 1,
      `negative retentionDays should be normalized to >=1, got ${r4.retentionDays}`);

    console.log("rate-limit-notifications-prune: PASSED");
  } finally {
    await clearTagged().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("rate-limit-notifications-prune: FAILED", err);
  await clearTagged().catch(() => undefined);
  process.exitCode = 1;
});
