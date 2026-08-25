/* test-registration
{
  "name": "Notification config cadence-switch flush (Task #741)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for cadence-switch flush tagging in
 * `setAlertNotifyConfig` (Task #741).
 *
 * When the alert cadence is changed away from a digest mode (e.g.
 * "hourly" -> "realtime"), `setAlertNotifyConfig` must flush whatever is
 * sitting in the pending digest with:
 *   - source   = "config_change"
 *   - actorId  = the editing admin's user id
 *
 * Other config edits that don't change the cadence (e.g. only swapping the
 * email destination) must NOT trigger an extra flush.
 *
 * The notify config uses email-only with no real mailer wired up, so the
 * resulting `rate_limit_alert_notifications` rows resolve to status='skipped'.
 * That's fine — what we're pinning is `trigger_source` and `trigger_actor_id`.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
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

const TAG = `nccf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ADMIN_ID = `admin-${TAG}`;

async function clearTestRows(): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limit_alert_notifications WHERE category = ${TAG}`);
  await db.execute(sql`DELETE FROM pending_digest_alerts WHERE payload->>'category' = ${TAG}`);
}

async function ensureAdminUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${ADMIN_ID}, 'admin', ${"Task741 Admin"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupAdminUser(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM admin_setting_audit WHERE changed_by = ${ADMIN_ID}`);
  } catch {}
  try {
    await db.execute(sql`UPDATE system_settings SET updated_by = NULL WHERE updated_by = ${ADMIN_ID}`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN_ID}`);
  } catch {}
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
}>> {
  const result: any = await db.execute(sql`
    SELECT trigger_source AS "triggerSource",
           trigger_actor_id AS "triggerActorId",
           channel
    FROM rate_limit_alert_notifications
    WHERE category = ${TAG}
    ORDER BY attempted_at ASC
  `);
  return (result.rows ?? result) as any[];
}

async function pendingDigestCount(): Promise<number> {
  const r: any = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM pending_digest_alerts WHERE payload->>'category' = ${TAG}`,
  );
  return Number((r.rows ?? r)[0]?.n ?? 0);
}

async function waitForPendingFlush(expected: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pendingDigestCount() >= expected) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${expected} pending digest alert(s)`);
}

async function main(): Promise<void> {
  await ensureRateLimitAlertNotificationsTable();
  await ensurePendingDigestAlertsTable();
  await clearTestRows();
  await ensureAdminUser();

  const before = await loadAlertNotifyConfig();
  const TEST_EMAIL = `nccf-${TAG}@example.com`;

  // Start in hourly so notifyRateLimitAlert defers to the digest queue.
  await setAlertNotifyConfig(
    { email: TEST_EMAIL, slackChannelId: null, cadence: "hourly", disabledCategories: [] },
    "system",
  );

  try {
    // ─── Seed two pending digest alerts ────────────────────────────────
    notifyRateLimitAlert(makeAlert(1));
    notifyRateLimitAlert(makeAlert(2));
    await waitForPendingFlush(2);

    // ─── Non-cadence edit must NOT flush ───────────────────────────────
    // Switch only the email destination; cadence stays at "hourly".
    const OTHER_EMAIL = `nccf-other-${TAG}@example.com`;
    await setAlertNotifyConfig({ email: OTHER_EMAIL }, ADMIN_ID);

    let rows = await rowsForCategory();
    assert(
      rows.length === 0,
      `email-only edit should not flush; got ${rows.length} notification row(s)`,
    );
    assert(
      (await pendingDigestCount()) === 2,
      `email-only edit should leave the pending digest intact (expected 2)`,
    );

    // ─── Cadence switch hourly -> realtime must flush with admin actor ─
    await setAlertNotifyConfig({ cadence: "realtime" }, ADMIN_ID);

    rows = await rowsForCategory();
    assert(
      rows.length === 2,
      `cadence switch should flush both pending alerts; got ${rows.length} row(s)`,
    );
    for (const row of rows) {
      assert(
        row.triggerSource === "config_change",
        `flushed row trigger_source should be 'config_change', got ${row.triggerSource}`,
      );
      assert(
        row.triggerActorId === ADMIN_ID,
        `flushed row trigger_actor_id should be ${ADMIN_ID}, got ${row.triggerActorId}`,
      );
      assert(row.channel === "email", `expected email channel, got ${row.channel}`);
    }
    assert(
      (await pendingDigestCount()) === 0,
      `pending digest should be drained after the cadence-switch flush`,
    );

    console.log("notification-config-change-flush: PASSED");
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
    await cleanupAdminUser().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("notification-config-change-flush: FAILED", err);
  await clearTestRows().catch(() => undefined);
  await cleanupAdminUser().catch(() => undefined);
  process.exitCode = 1;
});
