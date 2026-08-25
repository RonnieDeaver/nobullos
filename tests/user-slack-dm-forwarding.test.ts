/* test-registration
{
  "name": "Per-user Slack DM forwarding (Task #1687)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1687 — Per-user Slack DM forwarding regression.
//
// Covers everything that can be tested without monkey-patching the
// Slack HTTP client (ESM bindings make that impossible without a
// refactor that's out of scope for this task):
//
//   (1) preferences API: defaults + upsert
//   (2) global kill switch gating in maybeEnqueueUserSlackDm
//   (3) per-category preference gating
//   (4) "no identity" gating: enabled category + no link → no enqueue
//   (5) notifyUser succeeds and is unaffected by the Slack hook
//       (the hook short-circuits because no identity is linked)
//   (6) handleUserSlackDmJob with invalid payload → invalid_payload
//   (7) handleUserSlackDmJob with kill switch off → records skip
//       without touching Slack
//   (8) handleUserSlackDmJob with no identity → records no_identity
//       without touching Slack
//
// Usage: tsx tests/user-slack-dm-forwarding.test.ts

import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { users, type WorkQueueJob } from "@shared/schema";
import { notifyUser } from "../server/services/notifications/userInbox";
import {
  getUserNotificationPreferences,
  upsertUserNotificationPreference,
  getUserSlackIdentity,
  upsertUserSlackIdentity,
} from "../server/storage/userSlackPreferencesStorage";
import * as sender from "../server/services/notifications/userSlackSender";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function seedUser(suffix: string, email?: string): Promise<string> {
  const id = `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${suffix}`;
  await getDb()
    .insert(users)
    .values({ id, email: email ?? `${id}@test.local` });
  return id;
}

async function main(): Promise<void> {
  console.log("Task #1687 — per-user Slack DM forwarding");

  await runInTxSandbox(async () => {
    // Migration 0067 (Task #1686) may not be applied in the test DB;
    // re-create the user_notifications table inline so this test is
    // self-contained. Idempotent — no-op when the table already exists.
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
    // Mirror migration 0067_add_user_notifications.sql: collapse any
    // pre-existing duplicate unread rows (user_id, dedupe_key) before
    // creating the partial unique index. Without this, leaked rows
    // from prior non-sandboxed seeds in the dev DB (e.g. legacy
    // notifyUser callers from pre-Stage-B+C alerters) block the index
    // from being built and the test aborts at setup. Idempotent: a
    // no-op when there are no duplicates.
    await getDb().execute(sql`
      DELETE FROM user_notifications u
      USING (
        SELECT id
        FROM (
          SELECT id,
                 row_number() OVER (
                   PARTITION BY user_id, dedupe_key
                   ORDER BY created_at DESC, id DESC
                 ) AS rn
          FROM user_notifications
          WHERE dedupe_key IS NOT NULL
            AND read_at IS NULL
            AND archived_at IS NULL
        ) ranked
        WHERE ranked.rn > 1
      ) dups
      WHERE u.id = dups.id
    `);
    await getDb().execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_user_dedupe_unread_uniq
        ON user_notifications (user_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND read_at IS NULL AND archived_at IS NULL
    `);

    // ─── (1) preferences defaults + upsert ─────────────────────────
    const alice = await seedUser("a", "alice@test.local");
    const defaults = await getUserNotificationPreferences(alice);
    check(
      "preferences default to in-app=true, slack=false for every category",
      defaults.length > 0 &&
        defaults.every((r) => r.inAppEnabled === true && r.slackDmEnabled === false),
    );
    await upsertUserNotificationPreference({
      userId: alice,
      category: "comms.sms",
      inAppEnabled: true,
      slackDmEnabled: true,
    });
    const after = await getUserNotificationPreferences(alice);
    const sms = after.find((r) => r.category === "comms.sms");
    check("upsert flips slack_dm_enabled to true", sms?.slackDmEnabled === true);
    // Categories the user never touched still report defaults.
    const untouched = after.find((r) => r.category !== "comms.sms");
    check(
      "other categories still report defaults after upsert",
      untouched?.inAppEnabled === true && untouched?.slackDmEnabled === false,
    );

    // ─── (2) kill switch gating ───────────────────────────────────
    // Link alice so the "no identity" gate doesn't short-circuit ahead of
    // the kill switch check.
    await upsertUserSlackIdentity({
      userId: alice,
      slackUserId: "U_ALICE",
      slackTeamId: "T_TEST",
      slackEmail: "alice@test.local",
    });

    await sender.setUserSlackDmGloballyEnabled(false, alice);
    sender.__resetUserSlackKillSwitchCacheForTests();
    const gated = await sender.maybeEnqueueUserSlackDm({
      userId: alice,
      category: "comms.sms",
      notificationId: "n-killswitch",
      content: { title: "blocked" },
    });
    check("kill switch off → skipped_killswitch", gated === "skipped_killswitch");
    await sender.setUserSlackDmGloballyEnabled(true, alice);
    sender.__resetUserSlackKillSwitchCacheForTests();

    // ─── (3) per-category preference gating ────────────────────────
    // alice's "system" preference still defaults to slack_dm_enabled=false.
    const gatedByPref = await sender.maybeEnqueueUserSlackDm({
      userId: alice,
      category: "system",
      notificationId: "n-pref",
      content: { title: "no system DM" },
    });
    check("category slack-dm disabled → skipped_disabled", gatedByPref === "skipped_disabled");

    // ─── (4) "no identity" gating ──────────────────────────────────
    const bob = await seedUser("b", "bob@test.local");
    await upsertUserNotificationPreference({
      userId: bob,
      category: "comms.sms",
      inAppEnabled: true,
      slackDmEnabled: true,
    });
    const noIdent = await sender.maybeEnqueueUserSlackDm({
      userId: bob,
      category: "comms.sms",
      notificationId: "n-no-ident",
      content: { title: "no identity" },
    });
    check("no identity → skipped_no_identity", noIdent === "skipped_no_identity");

    // ─── (5) notifyUser is never broken by the Slack hook ─────────
    // Bob has slack-DM enabled for comms.sms but no identity, so the
    // hook short-circuits silently and the in-app row still lands.
    const inserted = await notifyUser(bob, {
      category: "comms.sms",
      title: "in-app must land regardless of Slack",
    });
    check(
      "notifyUser returns the in-app row even with Slack-DM-enabled category",
      !!inserted && !inserted!.deduped,
    );

    // ─── (6) handler with invalid payload ─────────────────────────
    const badJob = {
      id: "bad",
      queueName: "user_slack_dm",
      payload: null,
    } as unknown as WorkQueueJob;
    const badResult = await sender.handleUserSlackDmJob(badJob);
    check(
      "invalid payload returns invalid_payload cursor (no throw)",
      (badResult as any)?.cursor === "invalid_payload",
    );

    // ─── (7) handler with kill switch off ─────────────────────────
    await sender.setUserSlackDmGloballyEnabled(false, alice);
    sender.__resetUserSlackKillSwitchCacheForTests();
    const ksJob = {
      id: "ks",
      queueName: "user_slack_dm",
      payload: {
        userId: alice,
        notificationId: "n-handler-killswitch",
        category: "comms.sms",
        content: { title: "blocked at handler" },
      },
    } as unknown as WorkQueueJob;
    const ksResult = await sender.handleUserSlackDmJob(ksJob);
    check(
      "kill switch off at execution time → handler returns skipped_killswitch cursor",
      (ksResult as any)?.cursor === "skipped_killswitch",
    );
    const ksIdentity = await getUserSlackIdentity(alice);
    check(
      "kill switch off at execution time → last_dm_status records skipped_killswitch",
      ksIdentity?.lastDmStatus === "skipped_killswitch",
    );
    await sender.setUserSlackDmGloballyEnabled(true, alice);
    sender.__resetUserSlackKillSwitchCacheForTests();

    // ─── (8) handler with no identity ─────────────────────────────
    const noIdentJob = {
      id: "noident",
      queueName: "user_slack_dm",
      payload: {
        userId: bob,
        notificationId: "n-handler-no-ident",
        category: "comms.sms",
        content: { title: "no identity at handler" },
      },
    } as unknown as WorkQueueJob;
    const noIdentResult = await sender.handleUserSlackDmJob(noIdentJob);
    check(
      "no identity at execution time → handler returns no_identity cursor",
      (noIdentResult as any)?.cursor === "no_identity",
    );
  });

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
