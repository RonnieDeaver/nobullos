/* test-registration
{
  "name": "Stage B/C \u2192 per-user Slack DM enqueue (Task #1719)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1719 — Stage B/C events → per-user Slack DM forwarding regression.
 *
 * Stage B/C migrated six events to the per-user inbox via `notifyUser()`
 * (monthly-review-blocked, monthly-review-reminder, match-settings-change,
 * give-up, zoom-review backlog/cleared, comm-suggestions). `notifyUser()`
 * always invokes `maybeEnqueueUserSlackDm()` after the in-app row is
 * persisted (see userInbox.ts), so per-user Slack DM forwarding is wired
 * automatically — the only category-specific concern is whether the
 * recipient's per-category `user_notification_preferences.slack_dm_enabled`
 * is on and whether they have a linked Slack identity.
 *
 * This test exercises the two categories Stage B/C actually emits —
 * `system` (monthly-review-blocked, match-settings-change, comm-suggestions,
 * give-up) and `queue_health` (zoom-review backlog/cleared) — and asserts:
 *   (a) when the recipient has slack_dm_enabled=true for that category AND
 *       a linked Slack identity, a `user_slack_dm` work_queue row is
 *       enqueued with dedupe key `user_slack_dm:<notificationId>`,
 *   (b) with the default pref (slack_dm_enabled=false) no work_queue row
 *       is enqueued,
 *   (c) with the global kill switch off, no work_queue row is enqueued
 *       even when prefs are on.
 *
 * Usage: tsx tests/user-slack-dm-stage-bc.test.ts
 */
import { and, eq, sql } from "drizzle-orm";

import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  clients,
  users,
  workQueue,
} from "@shared/schema";
import { storage } from "../server/storage";
import { notifyOwnerOfCommSuggestions } from "../server/services/notifications/commSuggestions";
import {
  notifyReportFinalizationBlocked,
  notifyMonthlyReviewReminder,
} from "../server/services/notifications/monthlyReview";
import {
  notifyMatchSettingChange,
} from "../server/routes/matchSettings";
import {
  __test_setBroadcastOverride,
  type AlertDeliveryOutcome,
} from "../server/services/matchSettingsAlerts";
import { __test_createZoomReviewInAppNotifications } from "../server/services/zoomReviewQueueAlerts";
import {
  upsertUserNotificationPreference,
  upsertUserSlackIdentity,
} from "../server/storage/userSlackPreferencesStorage";
import {
  setUserSlackDmGloballyEnabled,
  __resetUserSlackKillSwitchCacheForTests,
  USER_SLACK_DM_QUEUE,
} from "../server/services/notifications/userSlackSender";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function seedUser(
  suffix: string,
  role: string | null = null,
): Promise<{ id: string; email: string }> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e9)}-${suffix}`;
  const email = `${id}@test.local`;
  await getDb().insert(users).values({
    id,
    email,
    firstName: suffix,
    lastName: "Test",
    ...(role ? { role: role as any } : {}),
  });
  return { id, email };
}

async function seedClient(ownerId: string, firmName: string): Promise<string> {
  const [row] = await getDb()
    .insert(clients)
    .values({ firmName, ownerId })
    .returning({ id: clients.id });
  return row.id;
}

async function linkSlackForUser(
  userId: string,
  email: string,
  slackUserId: string,
): Promise<void> {
  await upsertUserSlackIdentity({
    userId,
    slackUserId,
    slackTeamId: "T_TEST",
    slackEmail: email,
  });
}

async function enableSlackPref(userId: string, category: string): Promise<void> {
  await upsertUserNotificationPreference({
    userId,
    category,
    inAppEnabled: true,
    slackDmEnabled: true,
  });
}

async function userSlackDmJobsFor(userId: string): Promise<
  Array<{ id: string; dedupeKey: string | null; payload: any }>
> {
  const rows = await getDb()
    .select({
      id: workQueue.id,
      dedupeKey: workQueue.dedupeKey,
      payload: workQueue.payload,
    })
    .from(workQueue)
    .where(
      and(
        eq(workQueue.queueName, USER_SLACK_DM_QUEUE),
        sql`payload->>'userId' = ${userId}`,
      ),
    );
  return rows as any;
}

async function ensureUserNotificationsTable(): Promise<void> {
  // Idempotent guard for sandboxes that haven't applied migration 0067
  // (Task #1686). When the table already exists with the unique index
  // and live rows, both statements are no-ops.
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category varchar NOT NULL,
      title text NOT NULL,
      body text,
      deep_link text,
      metadata jsonb,
      dedupe_key varchar,
      read_at timestamp,
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  // Note: we deliberately do NOT (re-)create the partial unique index
  // here. It is owned by migration 0067 and recreating inside the
  // sandbox tx aborts the tx if pre-existing rows in the dev DB happen
  // to collide on (user_id, dedupe_key). Our assertions only depend on
  // work_queue rows and scope to freshly-seeded user ids, so the
  // user_notifications dedupe index is immaterial here.
}

async function withStubbedUsers<T>(
  userRows: Array<{ id: string; role: string | null; email: string; firstName?: string }>,
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

async function main(): Promise<void> {
  console.log("Task #1719 — Stage B/C → user_slack_dm enqueue");

  __test_setBroadcastOverride(async () => ({
    slack: { status: "skipped" } as AlertDeliveryOutcome,
    email: { status: "skipped" } as AlertDeliveryOutcome,
  }));

  try {
    await runInTxSandbox(async () => {
      await ensureUserNotificationsTable();

      // Make sure the global kill switch is on for the body of the test;
      // the suppression case explicitly flips it off and back.
      await setUserSlackDmGloballyEnabled(true, "test");
      __resetUserSlackKillSwitchCacheForTests();

      // ─── (1) system category — monthly-review-blocked ───────────────
      console.log("\n[1] system: notifyReportFinalizationBlocked enqueues DM job");
      const owner1 = await seedUser("own1");
      const clientId1 = await seedClient(owner1.id, "Acme Law");
      await linkSlackForUser(owner1.id, owner1.email, "U_OWN1");
      await enableSlackPref(owner1.id, "system");

      await notifyReportFinalizationBlocked({
        ownerId: owner1.id,
        reportId: "rep-1719-1",
        clientId: clientId1,
        firmName: "Acme Law",
        monthKey: "2026-05",
      });
      const jobs1 = await userSlackDmJobsFor(owner1.id);
      check("system + pref ON + identity → exactly 1 user_slack_dm job", jobs1.length === 1);
      check(
        "job dedupe key uses user_slack_dm:<notificationId>",
        !!jobs1[0]?.dedupeKey?.startsWith("user_slack_dm:"),
        jobs1[0]?.dedupeKey ?? "<none>",
      );
      check(
        "job payload carries category=system",
        jobs1[0]?.payload?.category === "system",
      );

      // ─── (2) queue_health category — zoom-review backlog ────────────
      console.log("\n[2] queue_health: zoom backlog enqueues DM job");
      const ceo2 = await seedUser("ceo2", "ceo");
      await linkSlackForUser(ceo2.id, ceo2.email, "U_CEO2");
      await enableSlackPref(ceo2.id, "queue_health");
      const tl2 = await seedUser("tl2", "team_lead"); // default pref off, no identity

      await __test_createZoomReviewInAppNotifications(
        "12 items pending; oldest 26h",
        "zoom_review_queue_backed_up",
        [
          { id: ceo2.id, role: "ceo" },
          { id: tl2.id, role: "team_lead" },
        ],
      );
      const jobs2 = await userSlackDmJobsFor(ceo2.id);
      check(
        "queue_health + pref ON + identity → exactly 1 user_slack_dm job",
        jobs2.length === 1,
      );
      check(
        "queue_health job payload carries category=queue_health",
        jobs2[0]?.payload?.category === "queue_health",
      );
      const jobs2tl = await userSlackDmJobsFor(tl2.id);
      check(
        "queue_health recipient with default pref (off) → no user_slack_dm job",
        jobs2tl.length === 0,
      );

      // ─── (3) queue_health cleared → also enqueues DM job ────────────
      console.log("\n[3] queue_health: zoom cleared enqueues DM job");
      const ceo3 = await seedUser("ceo3", "ceo");
      await linkSlackForUser(ceo3.id, ceo3.email, "U_CEO3");
      await enableSlackPref(ceo3.id, "queue_health");
      await __test_createZoomReviewInAppNotifications(
        "queue cleared",
        "zoom_review_queue_cleared",
        [{ id: ceo3.id, role: "ceo" }],
      );
      const jobs3 = await userSlackDmJobsFor(ceo3.id);
      check("queue_health cleared event → exactly 1 user_slack_dm job", jobs3.length === 1);

      // ─── (4) match-settings-change (system) ────────────────────────
      console.log("\n[4] system: notifyMatchSettingChange enqueues DM job");
      const ceo4 = await seedUser("ceo4", "ceo");
      const actor4 = await seedUser("act4", "ceo");
      await linkSlackForUser(ceo4.id, ceo4.email, "U_CEO4");
      await enableSlackPref(ceo4.id, "system");
      await withStubbedUsers(
        [
          { id: ceo4.id, role: "ceo", email: ceo4.email, firstName: "ceo4" },
          { id: actor4.id, role: "ceo", email: actor4.email, firstName: "act4" },
        ],
        async () => {
          await notifyMatchSettingChange({
            scope: "default",
            key: "AGENT_CONFIDENCE_THRESHOLD",
            oldValue: 0.7,
            newValue: 0.8,
            action: "updated",
            actorId: actor4.id,
            historyId: "hist-1719-4",
          });
        },
      );
      const jobs4 = await userSlackDmJobsFor(ceo4.id);
      check("match_settings_change + pref ON → exactly 1 user_slack_dm job", jobs4.length === 1);
      check(
        "match_settings_change job payload carries category=system",
        jobs4[0]?.payload?.category === "system",
      );

      // ─── (5) comm-suggestions (system) ──────────────────────────────
      console.log("\n[5] system: notifyOwnerOfCommSuggestions enqueues DM job");
      const owner5 = await seedUser("own5");
      const clientId5 = await seedClient(owner5.id, "Beta Law");
      await linkSlackForUser(owner5.id, owner5.email, "U_OWN5");
      await enableSlackPref(owner5.id, "system");
      await notifyOwnerOfCommSuggestions({
        clientId: clientId5,
        recordId: "rec-1719-5",
        recordTitle: "Inbound voicemail",
        suggestionCount: 3,
      });
      const jobs5 = await userSlackDmJobsFor(owner5.id);
      check("comm_suggestions + pref ON → exactly 1 user_slack_dm job", jobs5.length === 1);

      // ─── (6) monthly-review-reminder (system) ───────────────────────
      console.log("\n[6] system: notifyMonthlyReviewReminder enqueues DM job");
      const owner6 = await seedUser("own6");
      const clientId6 = await seedClient(owner6.id, "Gamma Law");
      await linkSlackForUser(owner6.id, owner6.email, "U_OWN6");
      await enableSlackPref(owner6.id, "system");
      await notifyMonthlyReviewReminder({
        userId: owner6.id,
        clientId: clientId6,
        firmName: "Gamma Law",
        monthKey: "2026-05",
      });
      const jobs6 = await userSlackDmJobsFor(owner6.id);
      check("monthly_review_reminder + pref ON → exactly 1 user_slack_dm job", jobs6.length === 1);

      // ─── (7) default pref (slack_dm_enabled=false) suppresses ───────
      console.log("\n[7] default pref (off) suppresses Slack DM");
      const owner7 = await seedUser("own7");
      const clientId7 = await seedClient(owner7.id, "Delta Law");
      await linkSlackForUser(owner7.id, owner7.email, "U_OWN7");
      // No upsert of pref → defaults: in_app=true, slack_dm=false.
      await notifyReportFinalizationBlocked({
        ownerId: owner7.id,
        reportId: "rep-1719-7",
        clientId: clientId7,
        firmName: "Delta Law",
        monthKey: "2026-05",
      });
      const jobs7 = await userSlackDmJobsFor(owner7.id);
      check(
        "default pref (slack_dm_enabled=false) → no user_slack_dm job enqueued",
        jobs7.length === 0,
      );

      // ─── (8) global kill switch off suppresses even with pref on ───
      console.log("\n[8] global kill switch off suppresses Slack DM");
      const owner8 = await seedUser("own8");
      const clientId8 = await seedClient(owner8.id, "Epsilon Law");
      await linkSlackForUser(owner8.id, owner8.email, "U_OWN8");
      await enableSlackPref(owner8.id, "system");
      await setUserSlackDmGloballyEnabled(false, "test");
      __resetUserSlackKillSwitchCacheForTests();
      try {
        await notifyReportFinalizationBlocked({
          ownerId: owner8.id,
          reportId: "rep-1719-8",
          clientId: clientId8,
          firmName: "Epsilon Law",
          monthKey: "2026-05",
        });
        const jobs8 = await userSlackDmJobsFor(owner8.id);
        check(
          "global kill switch OFF + pref ON → no user_slack_dm job enqueued",
          jobs8.length === 0,
        );
      } finally {
        await setUserSlackDmGloballyEnabled(true, "test");
        __resetUserSlackKillSwitchCacheForTests();
      }
    });
  } finally {
    __test_setBroadcastOverride(null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
