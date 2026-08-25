/* test-registration
{
  "name": "Match-settings alert auto-retry give-up notification (Task #1137)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1137 — verify the auto-retry give-up notification.
 *
 * Task #1713 — Stage B migrated this from `storage.createNotification`
 * (legacy `notifications` table) to `notifyUser()` (per-user inbox via
 * `user_notifications`). The test now asserts:
 *   - Eligible role users receive a `user_notifications` row with
 *     category="system" and dedupeKey="match:giveup:<historyId>:<userId>".
 *   - No legacy `notifications` row is written for the same event.
 *   - A second tick is a no-op (the `autoRetryGiveupNotifiedAt` stamp
 *     suppresses retries; the dedupe key is a belt-and-suspenders guard).
 *
 * Strategy:
 *   - Run inside `runInTxSandbox` so we touch real storage code paths but
 *     leave no rows behind.
 *   - Seed real `users` rows so `notifyUser()`'s userExists() check
 *     passes. Override `storage.getAllUsers` to return only the seeded
 *     ids so the auto-retry recipient filter is deterministic.
 *   - Seed an `agent_match_setting_history` row at MAX_ATTEMPTS - 1
 *     with status="failed" so the next attempt exhausts the budget.
 *   - Override `broadcastMatchSettingChange` to return failed without
 *     touching real Slack/SendGrid.
 *
 * Registered in tests/run-all.ts as a regression test.
 */
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";

import { runInTxSandbox } from "./db-sandbox";
import { storage } from "../server/storage";
import {
  agentMatchSettingHistory,
  userNotifications,
  users,
  workQueue,
} from "@shared/schema";
import { getDb, db } from "../server/db";
import { sql } from "drizzle-orm";
import {
  __test_setBroadcastOverride,
  type AlertDeliveryOutcome,
} from "../server/services/matchSettingsAlerts";
import {
  runMatchSettingsAlertAutoRetryOnce,
  MAX_ATTEMPTS,
} from "../server/services/matchSettingsAlertAutoRetry";
import {
  upsertUserNotificationPreference,
  upsertUserSlackIdentity,
} from "../server/storage/userSlackPreferencesStorage";
import {
  setUserSlackDmGloballyEnabled,
  __resetUserSlackKillSwitchCacheForTests,
  USER_SLACK_DM_QUEUE,
} from "../server/services/notifications/userSlackSender";

async function seedUser(suffix: string, role: string): Promise<string> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${suffix}`;
  await getDb().insert(users).values({
    id,
    email: `${id}@test.local`,
    firstName: suffix.toUpperCase(),
    lastName: "Test",
    role: role as any,
  });
  return id;
}

async function withStubbedUsers<T>(
  userRows: Array<{ id: string; role: string; email: string }>,
  fn: () => Promise<T>,
): Promise<T> {
  const origGetAllUsers = storage.getAllUsers.bind(storage);
  (storage as any).getAllUsers = async () => userRows as any;
  try {
    return await fn();
  } finally {
    (storage as any).getAllUsers = origGetAllUsers;
  }
}

async function main() {
  // Ensure the new column exists on the live table before we open the
  // tx sandbox (DDL inside the sandbox would be rolled back, and the
  // resend-columns helper memoizes its ALTER so we can't rely on it
  // running inside this process).
  await db.execute(sql`
    ALTER TABLE "agent_match_setting_history"
      ADD COLUMN IF NOT EXISTS "auto_retry_giveup_notified_at" timestamp
  `);

  await runInTxSandbox(async () => {
    const failedDelivery = (): { slack: AlertDeliveryOutcome; email: AlertDeliveryOutcome } => ({
      slack: { status: "failed", failureReason: "Slack: channel_not_found" },
      email: { status: "skipped" },
    });
    __test_setBroadcastOverride(async () => failedDelivery());

    const ceoId = await seedUser("ceo", "ceo");
    const amId = await seedUser("am", "account_manager");
    const salesId = await seedUser("sales", "specialist");
    const userRows = [
      { id: ceoId, role: "ceo", email: `${ceoId}@test.local` },
      { id: amId, role: "account_manager", email: `${amId}@test.local` },
      { id: salesId, role: "specialist", email: `${salesId}@test.local` },
    ];

    // Task #1719 — per-user Slack DM forwarding coverage for the give-up
    // path. CEO opts into Slack DMs for category=system and has a linked
    // Slack identity → should receive a `user_slack_dm` work_queue job.
    // AM has no preference upsert (default slack_dm_enabled=false) and
    // no Slack identity → should NOT receive a DM job, demonstrating
    // suppression for the same event firing in the same tick.
    await setUserSlackDmGloballyEnabled(true, "test");
    __resetUserSlackKillSwitchCacheForTests();
    await upsertUserSlackIdentity({
      userId: ceoId,
      slackUserId: "U_CEO_GIVEUP",
      slackTeamId: "T_TEST",
      slackEmail: `${ceoId}@test.local`,
    });
    await upsertUserNotificationPreference({
      userId: ceoId,
      category: "system",
      inAppEnabled: true,
      slackDmEnabled: true,
    });

    // Seed a history row whose Slack attempts are one tick away from
    // exhausting the budget.
    const seed = await getDb()
      .insert(agentMatchSettingHistory)
      .values({
        source: "default",
        settingKey: "AGENT_CONFIDENCE_THRESHOLD",
        oldValue: 0.7,
        newValue: 0.8,
        changedBy: null,
        slackStatus: "failed",
        emailStatus: "delivered",
        slackFailureReason: "Slack: ratelimited",
        slackAttemptCount: MAX_ATTEMPTS - 1,
        emailAttemptCount: 0,
        lastAutoRetryAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .returning({ id: agentMatchSettingHistory.id });
    const rowId = seed[0].id;

    try {
      await withStubbedUsers(userRows, async () => {
        // Tick 1 — should detect exhaustion, fire give-up notifications,
        // stamp the column.
        const r1 = await runMatchSettingsAlertAutoRetryOnce();
        assert.equal(r1.scanned, 1, "scanned 1 row");
        assert.equal(r1.retried, 1, "retried 1 row");
        assert.equal(r1.exhausted, 1, "1 give-up exhaustion recorded");

        // CEO + AM should each receive a `user_notifications` row;
        // sales (non-admin role) should not.
        const ceoInbox = await getDb()
          .select()
          .from(userNotifications)
          .where(eq(userNotifications.userId, ceoId));
        const amInbox = await getDb()
          .select()
          .from(userNotifications)
          .where(eq(userNotifications.userId, amId));
        const salesInbox = await getDb()
          .select()
          .from(userNotifications)
          .where(eq(userNotifications.userId, salesId));
        assert.equal(ceoInbox.length, 1, "1 CEO inbox row");
        assert.equal(amInbox.length, 1, "1 AM inbox row");
        assert.equal(salesInbox.length, 0, "no sales inbox row");

        assert.equal(ceoInbox[0].category, "system", "category=system");
        assert.equal(
          ceoInbox[0].dedupeKey,
          `match:giveup:${rowId}:${ceoId}`,
          "dedupeKey follows match:giveup:<historyId>:<userId>",
        );
        assert.ok(
          (ceoInbox[0].body ?? "").includes("AGENT_CONFIDENCE_THRESHOLD"),
          "body names changed setting key",
        );
        assert.ok(
          /channel_not_found|ratelimited/.test(ceoInbox[0].body ?? ""),
          "body includes latest failure reason",
        );

        // Task #1719 — per-user Slack DM enqueue. The CEO opted into
        // Slack DMs for category=system with a linked Slack identity,
        // so `notifyUser()`'s post-persist hook should enqueue exactly
        // one `user_slack_dm` work_queue job for them. The AM (default
        // pref off, no identity) should NOT have one — this proves the
        // per-recipient gating works inside the same give-up tick.
        const ceoDmJobs = await getDb()
          .select({ id: workQueue.id, dedupeKey: workQueue.dedupeKey })
          .from(workQueue)
          .where(
            and(
              eq(workQueue.queueName, USER_SLACK_DM_QUEUE),
              sql`payload->>'userId' = ${ceoId}`,
            ),
          );
        assert.equal(
          ceoDmJobs.length,
          1,
          "1 user_slack_dm job enqueued for the opted-in CEO",
        );
        assert.ok(
          (ceoDmJobs[0].dedupeKey ?? "").startsWith("user_slack_dm:"),
          "DM job dedupe key follows user_slack_dm:<notificationId>",
        );
        const amDmJobs = await getDb()
          .select({ id: workQueue.id })
          .from(workQueue)
          .where(
            and(
              eq(workQueue.queueName, USER_SLACK_DM_QUEUE),
              sql`payload->>'userId' = ${amId}`,
            ),
          );
        assert.equal(
          amDmJobs.length,
          0,
          "no user_slack_dm job for the AM (default pref + no identity)",
        );

        // Legacy table must be untouched for this event. Stage G
        // (Task #1716) dropped the `notifications` table entirely, so
        // guard with `to_regclass` — the check is trivially satisfied
        // post-drop but still surfaces a regression if the table is
        // ever re-created.
        const tableProbe = await getDb().execute(
          sql`SELECT to_regclass('public.notifications') IS NOT NULL AS exists`,
        );
        const legacyTablePresent = Boolean(
          (tableProbe as any).rows?.[0]?.exists,
        );
        if (legacyTablePresent) {
          const legacyForCeo = await getDb().execute(
            sql`SELECT id FROM notifications WHERE user_id = ${ceoId} AND type = 'match_settings_alert_giveup'`,
          );
          assert.equal(
            ((legacyForCeo as any).rows ?? []).length,
            0,
            "no legacy notifications row written for give-up event",
          );
        }

        const [postRow] = await getDb()
          .select()
          .from(agentMatchSettingHistory)
          .where(eq(agentMatchSettingHistory.id, rowId));
        assert.equal(
          postRow.slackAttemptCount,
          MAX_ATTEMPTS,
          `slack attempt count should equal MAX_ATTEMPTS=${MAX_ATTEMPTS}`,
        );
        assert.ok(postRow.autoRetryGiveupNotifiedAt, "give-up timestamp stamped");

        // Tick 2 — no further rows added.
        const r2 = await runMatchSettingsAlertAutoRetryOnce();
        assert.equal(
          r2.scanned,
          0,
          `second tick should not re-scan the exhausted row, got scanned=${r2.scanned}`,
        );
        const ceoInbox2 = await getDb()
          .select()
          .from(userNotifications)
          .where(eq(userNotifications.userId, ceoId));
        assert.equal(
          ceoInbox2.length,
          1,
          "no additional inbox row on the second tick",
        );

        console.log(
          "✓ Task #1137 / Task #1713 — give-up notification fires once via notifyUser()",
        );
      });
    } finally {
      __test_setBroadcastOverride(null);
    }
  });
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
