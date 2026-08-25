/* test-registration
{
  "name": "Prod actions recover frozen front mirror (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2172 regression coverage for the `recover_frozen_front_mirror`
 * registry action.
 *
 * The action auto-recovers a frozen Front email mirror by re-enabling
 * the `front_sync_emails_mirror_enabled` pool-epic kill switch — but
 * ONLY when the shared detection core
 * (`evaluateFrontMirrorFreshness`) reports state="frozen" with live
 * webhooks AND the switch is currently OFF. It opts into the Task #2086
 * self-heal scheduler.
 *
 * Locks the following behavior in place:
 *
 *   1. Frozen mirror + switch OFF + detection enabled → status pending;
 *      apply() flips the switch ON (applied) and a re-status / second
 *      apply is not-needed (idempotent).
 *   2. Frozen mirror + switch already ON (broken writer, not disabled)
 *      → not-needed; the switch is left ON for human investigation.
 *   3. Fresh mirror keeping up with live intake → not-needed regardless
 *      of the switch.
 *   4. No live Front webhook traffic (quiet period) + switch OFF →
 *      not-needed; never flips during a quiet period.
 *   5. Detection disabled (front_mirror_freshness_alert_enabled=false,
 *      the planned-maintenance lever) + frozen + switch OFF →
 *      not-needed; the switch is left OFF (never fights an intentional
 *      disable).
 *
 * Runs inside `runInIsolatedSchema` so seeded rows + settings live in a
 * per-test schema invisible to the live `Start application` workers.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { storage } from "../server/storage";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  SETTING_COOLDOWN_MINUTES,
  SETTING_ENABLED,
  SETTING_LAG_MINUTES,
} from "../server/services/frontMirrorFreshnessAlerts";
import {
  __resetPoolEpicSwitchesForTest,
  isPoolEpicSwitchEnabled,
  setPoolEpicSwitch,
} from "../server/services/poolEpicKillSwitches";
import { runInIsolatedSchema } from "./db-sandbox";

const MARKER = `t2172_rfm_${process.pid}_${Date.now()}`;
const LAG_MIN = 180;
const COOLDOWN_MIN = 360;
const ACTION_ID = "recover_frozen_front_mirror";
const SWITCH = "front_sync_emails_mirror_enabled";

let failures = 0;

async function insertMirrorRow(
  isoDb: { execute: (q: any) => Promise<any> },
  opts: { createdAgeMinutes: number },
): Promise<void> {
  const tag = `${MARKER}_${Math.random().toString(36).slice(2)}`;
  const ts = new Date(Date.now() - opts.createdAgeMinutes * 60_000).toISOString();
  await isoDb.execute(sql`
    INSERT INTO front_sync_emails
      (conversation_id, pipeline_state, match_status, state_changed_at, created_at)
    VALUES
      (${tag}, 'applied', 'unmatched', ${ts}, ${ts})
  `);
}

async function insertWebhookEvent(
  isoDb: { execute: (q: any) => Promise<any> },
  opts: { receivedAgeMinutes: number },
): Promise<void> {
  const tag = `${MARKER}_${Math.random().toString(36).slice(2)}`;
  const ts = new Date(Date.now() - opts.receivedAgeMinutes * 60_000).toISOString();
  await isoDb.execute(sql`
    INSERT INTO source_event_log
      (source_system, source_event_type, source_object_id, dedupe_key,
       payload_json, status, received_at, created_at, updated_at)
    VALUES
      ('front', 'message.created', ${tag}, ${tag},
       '{}'::jsonb, 'received', ${ts}, ${ts}, ${ts})
  `);
}

async function configureDetection(enabled: boolean): Promise<void> {
  await storage.setSystemSetting(SETTING_ENABLED, enabled ? "true" : "false", "system");
  await storage.setSystemSetting(SETTING_LAG_MINUTES, String(LAG_MIN), "system");
  await storage.setSystemSetting(SETTING_COOLDOWN_MINUTES, String(COOLDOWN_MIN), "system");
}

async function setSwitch(value: boolean): Promise<void> {
  __resetPoolEpicSwitchesForTest();
  await setPoolEpicSwitch(SWITCH, value, "system");
}

async function resetRows(isoDb: { execute: (q: any) => Promise<any> }): Promise<void> {
  await isoDb.execute(sql`DELETE FROM front_sync_emails`);
  await isoDb.execute(sql`DELETE FROM source_event_log`);
}

async function step(
  isoDb: { execute: (q: any) => Promise<any> },
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  await resetRows(isoDb);
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } finally {
    await resetRows(isoDb);
    __resetPoolEpicSwitchesForTest();
  }
}

async function main(): Promise<void> {
  console.log("recover_frozen_front_mirror prod-action regression (Task #2172)");

  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      const action = PROD_ACTIONS.find((a) => a.id === ACTION_ID);
      if (!action) throw new Error(`${ACTION_ID} missing from registry`);
      assert.ok(action.selfHeal, "action must opt into self-heal");

      await step(
        isoDb,
        "Group 1 — frozen + switch OFF → pending → apply flips ON → idempotent",
        async () => {
          await configureDetection(true);
          await setSwitch(false);
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 120 });

          const s = await action.status();
          assert.equal(s.state, "pending", `status=${JSON.stringify(s)}`);
          assert.match(s.detail, /re-enable/i);

          const outcome = await action.apply("system");
          assert.equal(outcome.state, "applied", `outcome=${JSON.stringify(outcome)}`);
          assert.equal(isPoolEpicSwitchEnabled(SWITCH), true, "switch should now be ON");

          // Idempotent: switch ON now, re-status / re-apply must not-needed.
          const s2 = await action.status();
          assert.equal(s2.state, "not-needed", `re-status=${JSON.stringify(s2)}`);
          const outcome2 = await action.apply("system");
          assert.equal(outcome2.state, "not-needed", `re-apply=${JSON.stringify(outcome2)}`);
          assert.equal(isPoolEpicSwitchEnabled(SWITCH), true, "switch stays ON");
        },
      );

      await step(
        isoDb,
        "Group 2 — frozen + switch already ON (broken writer) → not-needed",
        async () => {
          await configureDetection(true);
          await setSwitch(true);
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 120 });

          const s = await action.status();
          assert.equal(s.state, "not-needed", `status=${JSON.stringify(s)}`);
          assert.match(s.detail, /already ON|broken/i);

          const outcome = await action.apply("system");
          assert.equal(outcome.state, "not-needed", `outcome=${JSON.stringify(outcome)}`);
          assert.equal(isPoolEpicSwitchEnabled(SWITCH), true, "switch left ON");
        },
      );

      await step(
        isoDb,
        "Group 3 — fresh mirror keeping up → not-needed",
        async () => {
          await configureDetection(true);
          await setSwitch(false);
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: 10 });

          const s = await action.status();
          assert.equal(s.state, "not-needed", `status=${JSON.stringify(s)}`);
          assert.match(s.detail, /keeping up/i);
          // Must NOT flip a healthy mirror's switch.
          const outcome = await action.apply("system");
          assert.equal(outcome.state, "not-needed");
          assert.equal(isPoolEpicSwitchEnabled(SWITCH), false, "switch left OFF");
        },
      );

      await step(
        isoDb,
        "Group 4 — no live webhook traffic (quiet) + switch OFF → not-needed",
        async () => {
          await configureDetection(true);
          await setSwitch(false);
          // Ancient mirror, zero Front traffic → quiet period.
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 600 });

          const s = await action.status();
          assert.equal(s.state, "not-needed", `status=${JSON.stringify(s)}`);
          assert.match(s.detail, /quiet period|upstream stall|no live/i);
          const outcome = await action.apply("system");
          assert.equal(outcome.state, "not-needed");
          assert.equal(isPoolEpicSwitchEnabled(SWITCH), false, "switch left OFF in quiet period");
        },
      );

      await step(
        isoDb,
        "Group 5 — detection disabled (planned maintenance) + frozen + OFF → stands down",
        async () => {
          await configureDetection(false);
          await setSwitch(false);
          await insertWebhookEvent(isoDb, { receivedAgeMinutes: 5 });
          await insertMirrorRow(isoDb, { createdAgeMinutes: LAG_MIN + 120 });

          const s = await action.status();
          assert.equal(s.state, "not-needed", `status=${JSON.stringify(s)}`);
          assert.match(s.detail, /maintenance|disabled/i);
          const outcome = await action.apply("system");
          assert.equal(outcome.state, "not-needed");
          assert.equal(
            isPoolEpicSwitchEnabled(SWITCH),
            false,
            "switch left OFF — never fights an intentional disable",
          );
        },
      );

      if (failures > 0) {
        throw new Error(`${failures} test(s) failed`);
      }
      console.log("\nAll recover_frozen_front_mirror regression tests passed");
    },
    {
      tables: [
        "front_sync_emails",
        "source_event_log",
        "system_settings",
        "admin_setting_audit",
      ],
    },
  );
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
