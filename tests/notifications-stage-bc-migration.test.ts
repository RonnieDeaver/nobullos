/* test-registration
{
  "name": "Notifications Stage B/C migration (Task #1713)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1713 — Stage B/C migration regression.
 *
 * For each migrated `storage.createNotification(...)` call site this
 * test drives the *real* exported entry point that the routes / workers
 * call into, then asserts:
 *   (a) the expected user_notifications row(s) were written
 *       (recipient set, category, dedupeKey, deepLink),
 *   (b) ZERO new rows were written into the legacy `notifications`
 *       table for the migrated event,
 *   (c) a second identical fire is deduplicated by the
 *       `user_notifications.dedupeKey` partial-unique index.
 *
 * Entry points exercised:
 *   - communications.ts → notifyOwnerOfCommSuggestions()
 *     (helper used by all 4 routes/communications.ts sites)
 *   - matchSettings.ts → notifyMatchSettingChange() (exported)
 *   - matchSettings.ts → notifyCommonFirstNamesChange() (exported)
 *   - reports.ts → notifyReportFinalizationBlocked() (helper)
 *   - settings.ts → notifyMonthlyReviewReminder() (helper)
 *   - zoomReviewQueueAlerts.ts →
 *     __test_createZoomReviewInAppNotifications() (test-aliased export
 *     of the internal createInAppNotifications used by runZoomReviewAlertCheck)
 *
 * The give-up notification path is covered separately by
 * tests/match-settings-alert-giveup-notification.test.ts which drives
 * runMatchSettingsAlertAutoRetryOnce() end-to-end.
 *
 * The external Slack/email fan-out inside notifyMatchSettingChange/
 * notifyCommonFirstNamesChange is mocked via __test_setBroadcastOverride
 * so we don't touch Slack/SendGrid.
 *
 * Usage: tsx tests/notifications-stage-bc-migration.test.ts
 * Registered in tests/run-all.ts as a regression test.
 */
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";

import { runInTxSandbox } from "./db-sandbox";
import { storage } from "../server/storage";
import { getDb } from "../server/db";
import {
  clients,
  userNotifications,
  users,
} from "@shared/schema";
import { notifyOwnerOfCommSuggestions } from "../server/services/notifications/commSuggestions";
import {
  notifyReportFinalizationBlocked,
  notifyMonthlyReviewReminder,
} from "../server/services/notifications/monthlyReview";
import {
  notifyMatchSettingChange,
  notifyCommonFirstNamesChange,
} from "../server/routes/matchSettings";
import {
  __test_setBroadcastOverride,
  type AlertDeliveryOutcome,
} from "../server/services/matchSettingsAlerts";
import { __test_createZoomReviewInAppNotifications } from "../server/services/zoomReviewQueueAlerts";

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

async function seedUser(suffix: string, role: string | null = null): Promise<string> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e9)}-${suffix}`;
  await getDb().insert(users).values({
    id,
    email: `${id}@test.local`,
    firstName: suffix,
    lastName: "Test",
    ...(role ? { role: role as any } : {}),
  });
  return id;
}

async function seedClient(ownerId: string, firmName: string): Promise<string> {
  const [row] = await getDb()
    .insert(clients)
    .values({ firmName, ownerId })
    .returning({ id: clients.id });
  return row.id;
}

async function inboxFor(userId: string) {
  return await getDb()
    .select()
    .from(userNotifications)
    .where(eq(userNotifications.userId, userId));
}

async function legacyFor(userId: string): Promise<unknown[]> {
  // Stage G (Task #1716) dropped the legacy `notifications` table.
  // Guard with `to_regclass` so this regression check still runs cleanly
  // post-drop: if the table is gone the assertion is trivially satisfied,
  // and if a future regression re-introduces it we still surface rows.
  const exists = await getDb().execute(
    sql`SELECT to_regclass('public.notifications') IS NOT NULL AS exists`,
  );
  const present = Boolean((exists as any).rows?.[0]?.exists);
  if (!present) return [];
  const rows = await getDb().execute(
    sql`SELECT id FROM notifications WHERE user_id = ${userId}`,
  );
  return (rows as any).rows ?? [];
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
  console.log("Task #1713 — Stage B/C migration regression");

  // Stop the match-settings broadcaster from reaching Slack/SendGrid.
  __test_setBroadcastOverride(async () => ({
    slack: { status: "skipped" } as AlertDeliveryOutcome,
    email: { status: "skipped" } as AlertDeliveryOutcome,
  }));

  try {
    await runInTxSandbox(async () => {
      // ────────────────────────────────────────────────────────────
      // Group 1: communications.ts — notifyOwnerOfCommSuggestions
      // (real helper that routes/communications.ts × 4 sites call)
      // ────────────────────────────────────────────────────────────
      console.log("\n[1] communications.ts → notifyOwnerOfCommSuggestions");
      const owner1 = await seedUser("own1");
      const clientId = await seedClient(owner1, "Acme Law");
      const recordId = `rec-${Date.now()}-1`;

      await notifyOwnerOfCommSuggestions({
        clientId,
        recordId,
        recordTitle: "Inbound voicemail",
        suggestionCount: 3,
      });

      const inbox1a = await inboxFor(owner1);
      check("comm suggestions writes a user_notifications row", inbox1a.length === 1);
      check(
        "comm suggestions category=system",
        inbox1a[0]?.category === "system",
      );
      check(
        "comm suggestions dedupeKey matches comms:suggestions:<recordId>:<userId>",
        inbox1a[0]?.dedupeKey === `comms:suggestions:${recordId}:${owner1}`,
      );
      check(
        "comm suggestions deepLink lands on /clients/<id>?tab=comm-log&recordId=<recordId>",
        inbox1a[0]?.deepLink ===
          `/clients/${clientId}?tab=comm-log&recordId=${encodeURIComponent(recordId)}`,
      );
      check(
        "comm suggestions writes ZERO legacy notifications rows",
        (await legacyFor(owner1)).length === 0,
      );

      await notifyOwnerOfCommSuggestions({
        clientId,
        recordId,
        recordTitle: "Inbound voicemail",
        suggestionCount: 4,
      });
      check(
        "comm suggestions second fire deduped (still 1 row)",
        (await inboxFor(owner1)).length === 1,
      );

      await notifyOwnerOfCommSuggestions({
        clientId,
        recordId: `rec-${Date.now()}-empty`,
        recordTitle: "x",
        suggestionCount: 0,
      });
      check(
        "comm suggestions with count=0 is a no-op",
        (await inboxFor(owner1)).length === 1,
      );

      // ────────────────────────────────────────────────────────────
      // Group 2: matchSettings.ts → notifyMatchSettingChange
      // (the real route handler PUT /api/admin/match-settings calls
      //  this exact function; we drive it with a single CEO recipient.)
      // ────────────────────────────────────────────────────────────
      console.log("\n[2] matchSettings.ts → notifyMatchSettingChange");
      const ceo2 = await seedUser("ceo2", "ceo");
      const am2 = await seedUser("am2", "account_manager");
      const actor2 = await seedUser("act2", "ceo");

      await withStubbedUsers(
        [
          { id: ceo2, role: "ceo", email: `${ceo2}@test.local`, firstName: "ceo2" },
          { id: am2, role: "account_manager", email: `${am2}@test.local`, firstName: "am2" },
          { id: actor2, role: "ceo", email: `${actor2}@test.local`, firstName: "act2" },
        ],
        async () => {
          await notifyMatchSettingChange({
            scope: "default",
            key: "AGENT_CONFIDENCE_THRESHOLD",
            oldValue: 0.7,
            newValue: 0.8,
            action: "updated",
            actorId: actor2,
            historyId: "hist-stagebc-1",
          });
        },
      );

      const inbox2a = await inboxFor(ceo2);
      const inbox2am = await inboxFor(am2);
      const inbox2actor = await inboxFor(actor2);
      check(
        "match_settings_change writes exactly 1 row for the eligible CEO",
        inbox2a.length === 1,
      );
      check(
        "match_settings_change does NOT notify non-CEO roles (account manager)",
        inbox2am.length === 0,
      );
      check(
        "match_settings_change does NOT notify the acting CEO themself",
        inbox2actor.length === 0,
      );
      check(
        "match_settings_change category=system",
        inbox2a[0]?.category === "system",
      );
      check(
        "match_settings_change deepLink is /admin/match-settings",
        inbox2a[0]?.deepLink === "/admin/match-settings",
      );
      check(
        "match_settings_change dedupeKey uses match:setting_change:<historyId>:<userId>",
        inbox2a[0]?.dedupeKey === `match:setting_change:hist-stagebc-1:${ceo2}`,
      );
      check(
        "match_settings_change writes ZERO legacy notifications rows",
        (await legacyFor(ceo2)).length === 0,
      );

      await withStubbedUsers(
        [
          { id: ceo2, role: "ceo", email: `${ceo2}@test.local`, firstName: "ceo2" },
          { id: actor2, role: "ceo", email: `${actor2}@test.local`, firstName: "act2" },
        ],
        async () => {
          await notifyMatchSettingChange({
            scope: "default",
            key: "AGENT_CONFIDENCE_THRESHOLD",
            oldValue: 0.7,
            newValue: 0.8,
            action: "updated",
            actorId: actor2,
            historyId: "hist-stagebc-1",
          });
        },
      );
      check(
        "match_settings_change second fire deduped (still 1 CEO row)",
        (await inboxFor(ceo2)).length === 1,
      );

      // ────────────────────────────────────────────────────────────
      // Group 3: matchSettings.ts → notifyCommonFirstNamesChange
      // (Zoom Guardrail Common First Names list edit notification.)
      // ────────────────────────────────────────────────────────────
      console.log("\n[3] matchSettings.ts → notifyCommonFirstNamesChange");
      const ceo3 = await seedUser("ceo3", "ceo");
      const actor3 = await seedUser("act3", "ceo");
      await withStubbedUsers(
        [
          { id: ceo3, role: "ceo", email: `${ceo3}@test.local`, firstName: "ceo3" },
          { id: actor3, role: "ceo", email: `${actor3}@test.local`, firstName: "act3" },
        ],
        async () => {
          await notifyCommonFirstNamesChange({
            oldCount: 40,
            newCount: 50,
            oldIsOverride: true,
            newIsOverride: true,
            action: "updated",
            actorId: actor3,
            historyId: "cfn-stagebc-1",
          });
        },
      );
      const inbox3a = await inboxFor(ceo3);
      check(
        "common_first_names_change writes a row for the eligible CEO",
        inbox3a.length === 1,
      );
      check(
        "common_first_names_change category=system",
        inbox3a[0]?.category === "system",
      );
      check(
        "common_first_names_change dedupeKey uses match:setting_change:<historyId>:<userId>",
        inbox3a[0]?.dedupeKey === `match:setting_change:cfn-stagebc-1:${ceo3}`,
      );
      check(
        "common_first_names_change writes ZERO legacy notifications rows",
        (await legacyFor(ceo3)).length === 0,
      );

      // ────────────────────────────────────────────────────────────
      // Group 4: zoomReviewQueueAlerts.ts → createInAppNotifications
      // (real fan-out used by runZoomReviewAlertCheck — recipient
      // filter must include CEO/team_lead/account_manager roles.)
      // ────────────────────────────────────────────────────────────
      console.log("\n[4] zoomReviewQueueAlerts.ts → createInAppNotifications");
      // Drive the real internal fan-out (exported under a __test_ alias).
      // We seed three users with distinct roles; the function pulls
      // `getAllUsers` from `../storage/clientStorage`, which hits the
      // DB inside this sandbox tx and so naturally sees the seeded rows.
      // We assert by role behaviour — eligible roles received a row,
      // ineligible role did not — rather than by exact recipient count,
      // because earlier groups also seeded CEO-role users that fall
      // within the alert's RECIPIENT_ROLES filter.
      const ceo4 = await seedUser("ceo4", "ceo");
      const tl4 = await seedUser("tl4", "team_lead");
      const sales4 = await seedUser("sales4", "specialist");

      const created4 = await __test_createZoomReviewInAppNotifications(
        "12 items pending; oldest 26h",
        "zoom_review_queue_backed_up",
        [
          { id: ceo4, role: "ceo" },
          { id: tl4, role: "team_lead" },
          { id: sales4, role: "specialist" },
        ],
      );
      check(
        "zoom backlog fans out to CEO + team_lead only (created=2)",
        created4 === 2,
        `created=${created4}`,
      );

      const inbox4ceo = await inboxFor(ceo4);
      const inbox4tl = await inboxFor(tl4);
      const inbox4sales = await inboxFor(sales4);
      check(
        "zoom backlog wrote a user_notifications row for CEO",
        inbox4ceo.length === 1,
      );
      check(
        "zoom backlog wrote a user_notifications row for team_lead",
        inbox4tl.length === 1,
      );
      check(
        "zoom backlog did NOT notify specialist role",
        inbox4sales.length === 0,
      );
      check(
        "zoom backlog category=queue_health",
        inbox4ceo[0]?.category === "queue_health",
      );
      check(
        "zoom backlog dedupeKey matches alert:queue.zoom_review.backlog:<userId>",
        inbox4ceo[0]?.dedupeKey === `alert:queue.zoom_review.backlog:${ceo4}`,
      );
      check(
        "zoom backlog deepLink is /admin/zoom/review",
        inbox4ceo[0]?.deepLink === "/admin/zoom/review",
      );
      check(
        "zoom backlog writes ZERO legacy notifications rows",
        (await legacyFor(ceo4)).length === 0,
      );

      // ────────────────────────────────────────────────────────────
      // Group 5: reports.ts → notifyReportFinalizationBlocked
      // ────────────────────────────────────────────────────────────
      console.log("\n[5] reports.ts → notifyReportFinalizationBlocked");
      const owner5 = await seedUser("own5");
      const reportId = `rep-${Date.now()}`;
      await notifyReportFinalizationBlocked({
        ownerId: owner5,
        reportId,
        clientId,
        firmName: "Acme Law",
        monthKey: "2026-05",
      });
      const inbox5a = await inboxFor(owner5);
      check(
        "monthly_review_blocked writes a user_notifications row",
        inbox5a.length === 1,
      );
      check(
        "monthly_review_blocked category=system",
        inbox5a[0]?.category === "system",
      );
      check(
        "monthly_review_blocked dedupeKey matches report:<reportId>:<userId>",
        inbox5a[0]?.dedupeKey === `report:${reportId}:${owner5}`,
      );
      check(
        "monthly_review_blocked deepLink lands on /clients/<id>",
        inbox5a[0]?.deepLink === `/clients/${clientId}`,
      );
      check(
        "monthly_review_blocked writes ZERO legacy notifications rows",
        (await legacyFor(owner5)).length === 0,
      );
      await notifyReportFinalizationBlocked({
        ownerId: owner5,
        reportId,
        clientId,
        firmName: "Acme Law",
        monthKey: "2026-05",
      });
      check(
        "monthly_review_blocked second fire deduped",
        (await inboxFor(owner5)).length === 1,
      );

      // ────────────────────────────────────────────────────────────
      // Group 6: settings.ts → notifyMonthlyReviewReminder
      // ────────────────────────────────────────────────────────────
      console.log("\n[6] settings.ts → notifyMonthlyReviewReminder");
      const owner6 = await seedUser("own6");
      const reminderClientId = await seedClient(owner6, "Beta Law");
      const monthKey = "2026-05";
      const wrote1 = await notifyMonthlyReviewReminder({
        userId: owner6,
        clientId: reminderClientId,
        firmName: "Beta Law",
        monthKey,
      });
      check("monthly_review_reminder first fire returns wrote=true", wrote1 === true);
      const inbox6a = await inboxFor(owner6);
      check(
        "monthly_review_reminder writes a user_notifications row",
        inbox6a.length === 1,
      );
      check(
        "monthly_review_reminder dedupeKey matches monthly_review:<monthKey>:<clientId>:<userId>",
        inbox6a[0]?.dedupeKey ===
          `monthly_review:${monthKey}:${reminderClientId}:${owner6}`,
      );
      check(
        "monthly_review_reminder writes ZERO legacy notifications rows",
        (await legacyFor(owner6)).length === 0,
      );
      const wrote2 = await notifyMonthlyReviewReminder({
        userId: owner6,
        clientId: reminderClientId,
        firmName: "Beta Law",
        monthKey,
      });
      check("monthly_review_reminder second fire returns wrote=false", wrote2 === false);
      check(
        "monthly_review_reminder second fire suppressed via dedupeKey",
        (await inboxFor(owner6)).length === 1,
      );
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
