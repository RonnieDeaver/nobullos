/* test-registration
{
  "name": "Notification history manual flush",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for manual-flush tagging in notification history
 * (task #626).
 *
 * `flushDigestNow({source, actorId})` records one row per alert × channel in
 * `rate_limit_alert_notifications`. The new contract:
 *   - source="scheduled" (default) → trigger_source='scheduled', trigger_actor_id=NULL
 *   - source="manual",   actorId=X → trigger_source='manual',    trigger_actor_id=X
 *
 * This test enqueues a digest alert, calls flushDigestNow twice (scheduled,
 * then manual with an actor), and inspects the resulting
 * `rate_limit_alert_notifications` rows.
 *
 * The notify config is set with email-only and no real mailer configured so
 * each attempt resolves to status='skipped' — but the trigger_source /
 * trigger_actor_id columns are still populated, which is what we're pinning.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  flushDigestNow,
  loadAlertNotifyConfig,
  notifyRateLimitAlert,
  setAlertNotifyConfig,
} from "../server/services/rateLimitAlertNotifier";
import {
  ensureRateLimitAlertNotificationsTable,
} from "../server/storage/rateLimitAlertNotificationsStorage";
import { ensurePendingDigestAlertsTable } from "../server/storage/pendingDigestAlertsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `nhmf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function clearTestRows(): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limit_alert_notifications WHERE category = ${TAG}`);
  await db.execute(sql`DELETE FROM pending_digest_alerts WHERE payload->>'category' = ${TAG}`);
}

function makeAlert(seed: number) {
  const now = Date.now();
  return {
    userId: `user-${TAG}-${seed}`,
    category: TAG,
    count: 80 + seed,
    max: 100,
    warningPercent: 80,
    windowStart: now - 30_000 - seed,
    windowMs: 60_000,
    triggeredAt: now,
  };
}

async function rowsForCategory(): Promise<Array<{
  triggerSource: string | null;
  triggerActorId: string | null;
  channel: string;
  destination: string;
  status: string;
}>> {
  const result: any = await db.execute(sql`
    SELECT trigger_source AS "triggerSource",
           trigger_actor_id AS "triggerActorId",
           channel, destination, status
    FROM rate_limit_alert_notifications
    WHERE category = ${TAG}
    ORDER BY attempted_at ASC
  `);
  return (result.rows ?? result) as any[];
}

async function waitForPendingFlush(expected: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r: any = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM pending_digest_alerts WHERE payload->>'category' = ${TAG}`,
    );
    const n = Number((r.rows ?? r)[0]?.n ?? 0);
    if (n >= expected) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${expected} pending digest alert(s)`);
}

async function main(): Promise<void> {
  await ensureRateLimitAlertNotificationsTable();
  await ensurePendingDigestAlertsTable();
  await clearTestRows();

  const before = await loadAlertNotifyConfig();
  const TEST_EMAIL = `nhmf-${TAG}@example.com`;
  // hourly cadence so notifyRateLimitAlert defers to the digest queue
  // instead of dispatching realtime.
  await setAlertNotifyConfig(
    { email: TEST_EMAIL, slackChannelId: null, cadence: "hourly", disabledCategories: [] },
    "system",
  );

  try {
    // ─── Scheduled flush ────────────────────────────────────────────────
    notifyRateLimitAlert(makeAlert(1));
    await waitForPendingFlush(1);
    await flushDigestNow({ source: "scheduled" });

    let rows = await rowsForCategory();
    assert(rows.length === 1, `expected 1 scheduled row, got ${rows.length}`);
    assert(rows[0].triggerSource === "scheduled",
      `scheduled row trigger_source should be 'scheduled', got ${rows[0].triggerSource}`);
    assert(rows[0].triggerActorId === null,
      `scheduled row trigger_actor_id should be NULL, got ${rows[0].triggerActorId}`);
    assert(rows[0].channel === "email",
      `expected email channel, got ${rows[0].channel}`);

    // ─── Manual flush with actor ────────────────────────────────────────
    notifyRateLimitAlert(makeAlert(2));
    await waitForPendingFlush(1);
    const actorId = `actor-${TAG}`;
    await flushDigestNow({ source: "manual", actorId });

    rows = await rowsForCategory();
    assert(rows.length === 2, `expected 2 rows total after manual flush, got ${rows.length}`);
    const manualRow = rows[1];
    assert(manualRow.triggerSource === "manual",
      `manual row trigger_source should be 'manual', got ${manualRow.triggerSource}`);
    assert(manualRow.triggerActorId === actorId,
      `manual row trigger_actor_id should be ${actorId}, got ${manualRow.triggerActorId}`);

    console.log("notification-history-manual-flush: PASSED");
  } finally {
    await setAlertNotifyConfig(
      {
        email: before.email ?? "",
        slackChannelId: before.slackChannelId ?? "",
        cadence: before.cadence,
        disabledCategories: before.disabledCategories,
      },
      "system",
    ).catch(() => undefined);
    await clearTestRows().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("notification-history-manual-flush: FAILED", err);
  await clearTestRows().catch(() => undefined);
  process.exitCode = 1;
});
