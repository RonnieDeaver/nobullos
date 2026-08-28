/* test-registration
{
  "name": "Last-edited badges (admin tools)",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for the "last edited by" helper used by admin-tools
 * settings panels.
 *
 * `resolveLastEditedUsers([...userIds])` and `buildLastEdited(updatedAt,
 * updatedBy, userMap)` together produce the badge payload the UI renders.
 *
 * Pinned behaviors:
 *   1. Unknown user ids must NOT crash and must produce a null `updatedBy`
 *      in the resulting LastEditedInfo.
 *   2. Known user ids hydrate into the full {id, firstName, lastName, email}
 *      object.
 *   3. ISO date strings round-trip; null `updatedAt` stays null.
 *   4. `getLastEditedFromAudit` returns the latest entry per scope and
 *      attributes it to the actor that wrote it.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  buildLastEdited,
  resolveLastEditedUsers,
  getLastEditedFromAudit,
} from "../server/routes/lastEditedHelper";
import {
  ensureAdminSettingAuditTable,
  recordAdminSettingChange,
} from "../server/storage/settingsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `leb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `actor-${TAG}`;
const SETTING_KEY = `test_setting_${TAG}`;

async function ensureActorUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'Last', 'Editor')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM admin_setting_audit WHERE setting_key = ${SETTING_KEY}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
}

async function main(): Promise<void> {
  await ensureAdminSettingAuditTable();
  await ensureActorUser();
  try {
    // (1) resolveLastEditedUsers tolerates unknown ids and hydrates known ones
    const map = await resolveLastEditedUsers([ACTOR_ID, "does-not-exist", null, undefined]);
    assert(map.size === 1, `expected exactly 1 hydrated user, got ${map.size}`);
    const u = map.get(ACTOR_ID);
    assert(u !== undefined, "actor should be present in user map");
    assert(u!.email === `${ACTOR_ID}@example.com`,
      `expected actor email, got ${u?.email}`);
    assert(u!.firstName === "Last" && u!.lastName === "Editor",
      `expected name 'Last Editor', got '${u?.firstName} ${u?.lastName}'`);

    // (2) buildLastEdited shape — known user
    const now = new Date();
    const info = buildLastEdited(now, ACTOR_ID, map);
    assert(info.updatedAt === now.toISOString(),
      `expected ISO updatedAt, got ${info.updatedAt}`);
    assert(info.updatedBy?.id === ACTOR_ID,
      `expected updatedBy.id=${ACTOR_ID}, got ${info.updatedBy?.id}`);

    // (3) buildLastEdited — unknown user should produce null updatedBy
    const unknownInfo = buildLastEdited(now, "ghost-user", map);
    assert(unknownInfo.updatedBy === null,
      `unknown user id should yield null updatedBy, got ${JSON.stringify(unknownInfo.updatedBy)}`);

    // (4) buildLastEdited — null updatedAt stays null
    const nullInfo = buildLastEdited(null, null, map);
    assert(nullInfo.updatedAt === null && nullInfo.updatedBy === null,
      `expected fully-null badge for null inputs, got ${JSON.stringify(nullInfo)}`);

    // (5) getLastEditedFromAudit returns latest per scope w/ correct attribution
    await recordAdminSettingChange({
      settingKey: SETTING_KEY,
      scope: "scope-A",
      changedBy: ACTOR_ID,
      oldValues: null,
      newValues: { v: 1 },
    });
    // Tiny delay so timestamps differ deterministically.
    await new Promise((r) => setTimeout(r, 25));
    await recordAdminSettingChange({
      settingKey: SETTING_KEY,
      scope: "scope-A",
      changedBy: ACTOR_ID,
      oldValues: { v: 1 },
      newValues: { v: 2 },
    });
    await recordAdminSettingChange({
      settingKey: SETTING_KEY,
      scope: "scope-B",
      changedBy: ACTOR_ID,
      oldValues: null,
      newValues: { v: 9 },
    });

    const auditMap = await getLastEditedFromAudit({
      settingKey: SETTING_KEY,
      scopes: ["scope-A", "scope-B"],
    });
    const a = auditMap.get("scope-A");
    const b = auditMap.get("scope-B");
    assert(a?.updatedBy?.id === ACTOR_ID,
      `scope-A latest editor should be ${ACTOR_ID}, got ${a?.updatedBy?.id}`);
    assert(b?.updatedBy?.id === ACTOR_ID,
      `scope-B latest editor should be ${ACTOR_ID}, got ${b?.updatedBy?.id}`);
    assert(typeof a?.updatedAt === "string" && typeof b?.updatedAt === "string",
      `both scopes should have ISO updatedAt strings`);

    console.log("last-edited-badges-admin-tools: PASSED");
  } finally {
    await cleanup().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("last-edited-badges-admin-tools: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
