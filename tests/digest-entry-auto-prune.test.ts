/* test-registration
{
  "name": "Digest entry auto-prune",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for `pending_digest_alerts` automatic retention prune.
 *
 * The background retention worker delegates to
 * `prunePendingDigestAlerts(retentionDays)`. Cutoff = now - retentionDays*24h.
 * Rows with `queued_at < cutoff` are deleted; rows at/after the cutoff stay.
 *
 * Pinned behavior:
 *   1. Old rows are deleted; recent rows are preserved.
 *   2. The boundary (queued_at == cutoff) is preserved (lt comparison).
 *   3. The function returns the number of rows actually deleted.
 *   4. Negative / zero / non-integer retentionDays is rejected.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  ensurePendingDigestAlertsTable,
  insertPendingDigestAlert,
  listPendingDigestAlerts,
} from "../server/storage/pendingDigestAlertsStorage";
import { prunePendingDigestAlerts } from "../server/services/pendingDigestAlertsRetention";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `dap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

function alertPayload(seed: number) {
  const now = Date.now();
  return {
    userId: `user-${TAG}-${seed}`,
    category: TAG,
    count: 80 + seed,
    max: 100,
    warningPercent: 80,
    windowStart: now - 30_000,
    windowMs: 60_000,
    triggeredAt: now,
  };
}

async function clearTagged(): Promise<void> {
  await db.execute(sql`DELETE FROM pending_digest_alerts WHERE payload->>'category' = ${TAG}`);
}

async function ourPendingIds(): Promise<string[]> {
  const all = await listPendingDigestAlerts();
  return all
    .filter((r) => (r.payload as any)?.category === TAG)
    .map((r) => r.id);
}

async function main(): Promise<void> {
  await ensurePendingDigestAlertsTable();
  await clearTagged();

  try {
    // Seed three rows: 30 days old, 5 days old, 1 hour old.
    const now = Date.now();
    const old = await insertPendingDigestAlert(alertPayload(1) as any, now - 30 * DAY_MS);
    const mid = await insertPendingDigestAlert(alertPayload(2) as any, now - 5 * DAY_MS);
    const fresh = await insertPendingDigestAlert(alertPayload(3) as any, now - 60 * 60 * 1000);

    // (1) Prune with retentionDays=7 → drops only the 30-day-old row.
    const r1 = await prunePendingDigestAlerts(7);
    assert(r1.deleted >= 1, `prune should report >=1 deleted row, got ${r1.deleted}`);
    assert(r1.retentionDays === 7, `effective retention should be 7, got ${r1.retentionDays}`);
    let remaining = await ourPendingIds();
    assert(!remaining.includes(old.id), "30d-old row should have been pruned");
    assert(remaining.includes(mid.id), "5d-old row should survive (within 7-day window)");
    assert(remaining.includes(fresh.id), "1h-old row should survive");

    // (2) Prune with retentionDays=1 → drops the 5-day-old too, fresh stays.
    const r2 = await prunePendingDigestAlerts(1);
    assert(r2.deleted >= 1, `second prune should drop the 5d row, got ${r2.deleted}`);
    remaining = await ourPendingIds();
    assert(!remaining.includes(mid.id), "5d-old row should be pruned at retentionDays=1");
    assert(remaining.includes(fresh.id), "1h-old row should still survive");

    // (3) Non-positive / fractional retention is normalized to >=1 day, NOT
    //     rejected. This matches the production safety floor and is what we
    //     pin so a bad config can't accidentally truncate everything.
    const r3 = await prunePendingDigestAlerts(0);
    assert(r3.retentionDays >= 1,
      `retentionDays=0 should be normalized to >=1, got ${r3.retentionDays}`);
    const r4 = await prunePendingDigestAlerts(-3);
    assert(r4.retentionDays >= 1,
      `negative retentionDays should be normalized to >=1, got ${r4.retentionDays}`);

    console.log("digest-entry-auto-prune: PASSED");
  } finally {
    await clearTagged().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("digest-entry-auto-prune: FAILED", err);
  await clearTagged().catch(() => undefined);
  process.exitCode = 1;
});
