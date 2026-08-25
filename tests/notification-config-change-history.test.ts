/* test-registration
{
  "name": "Notification config change history",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for "config change history" tagging on
 * `admin_setting_audit` (task #626).
 *
 * `setAlertNotifyConfig(patch, actorId)` must:
 *   - Insert one row into `admin_setting_audit` per changed field
 *     (slackChannelId, email, cadence, disabledCategories).
 *   - Set `changedBy = actorId` (or null when actorId is "system").
 *   - Set `oldValues` to the previous config snapshot and `newValues` to the
 *     new value for that field.
 *   - Skip rows when the field is unchanged (no audit spam).
 *
 * We exercise three transitions and assert the audit shape after each.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  loadAlertNotifyConfig,
  setAlertNotifyConfig,
} from "../server/services/rateLimitAlertNotifier";
import {
  ensureAdminSettingAuditTable,
} from "../server/storage/settingsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `nch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `actor-${TAG}`;

async function ensureActorUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'Audit', 'Tester')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanupActorRows(): Promise<void> {
  await db.execute(sql`DELETE FROM admin_setting_audit WHERE changed_by = ${ACTOR_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
}

async function rowsForActor(settingKey: string): Promise<Array<{
  settingKey: string;
  changedBy: string | null;
  oldValues: any;
  newValues: any;
}>> {
  const r: any = await db.execute(sql`
    SELECT setting_key AS "settingKey",
           changed_by AS "changedBy",
           old_values AS "oldValues",
           new_values AS "newValues"
    FROM admin_setting_audit
    WHERE changed_by = ${ACTOR_ID} AND setting_key = ${settingKey}
    ORDER BY changed_at ASC
  `);
  return (r.rows ?? r) as any[];
}

async function main(): Promise<void> {
  await ensureAdminSettingAuditTable();
  await ensureActorUser();

  const before = await loadAlertNotifyConfig();
  try {
    // ─── Transition 1: change email + cadence ──────────────────────────
    const newEmail = `${TAG}@example.com`;
    await setAlertNotifyConfig({ email: newEmail, cadence: "hourly" }, ACTOR_ID);

    const emailRows = await rowsForActor("rate_limit_alert_email");
    const cadenceRows = await rowsForActor("rate_limit_alert_cadence");
    assert(emailRows.length === 1,
      `expected one audit row for email change, got ${emailRows.length}`);
    assert(cadenceRows.length === 1,
      `expected one audit row for cadence change, got ${cadenceRows.length}`);
    assert(emailRows[0].changedBy === ACTOR_ID,
      `email audit row should attribute to actor ${ACTOR_ID}, got ${emailRows[0].changedBy}`);
    assert(emailRows[0].newValues?.email === newEmail,
      `email audit newValues.email should be ${newEmail}, got ${JSON.stringify(emailRows[0].newValues)}`);
    assert(cadenceRows[0].newValues?.cadence === "hourly",
      `cadence audit newValues.cadence should be 'hourly', got ${JSON.stringify(cadenceRows[0].newValues)}`);

    // ─── Transition 2: identical patch should NOT add a new row ────────
    await setAlertNotifyConfig({ email: newEmail, cadence: "hourly" }, ACTOR_ID);
    const emailRows2 = await rowsForActor("rate_limit_alert_email");
    const cadenceRows2 = await rowsForActor("rate_limit_alert_cadence");
    assert(emailRows2.length === 1,
      `unchanged email should not write a new audit row, got ${emailRows2.length}`);
    assert(cadenceRows2.length === 1,
      `unchanged cadence should not write a new audit row, got ${cadenceRows2.length}`);

    // ─── Transition 3: change disabledCategories ───────────────────────
    await setAlertNotifyConfig(
      { disabledCategories: [`cat-${TAG}`] },
      ACTOR_ID,
    );
    const dcRows = await rowsForActor("rate_limit_alert_disabled_categories");
    assert(dcRows.length === 1,
      `expected one audit row for disabledCategories change, got ${dcRows.length}`);
    const newDC = dcRows[0].newValues?.disabledCategories;
    assert(Array.isArray(newDC) && newDC.includes(`cat-${TAG}`),
      `disabledCategories audit newValues should include cat-${TAG}, got ${JSON.stringify(newDC)}`);

    console.log("notification-config-change-history: PASSED");
  } finally {
    // Restore prior config best-effort.
    await setAlertNotifyConfig(
      {
        email: before.email ?? "",
        slackChannelId: before.slackChannelId ?? "",
        cadence: before.cadence,
        disabledCategories: before.disabledCategories,
      },
      "system",
    ).catch(() => undefined);
    await cleanupActorRows().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("notification-config-change-history: FAILED", err);
  await cleanupActorRows().catch(() => undefined);
  process.exitCode = 1;
});
