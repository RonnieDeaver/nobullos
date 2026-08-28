/* test-registration
{
  "name": "Audit-table prune (admin_setting / queue_timing)",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for admin-tunable audit table prunes.
 *
 * Two prunes are pinned here (stale_lease_threshold has its own existing
 * test):
 *
 *   - `pruneAdminSettingAuditPerScope({settingKey, maxEntriesPerScope})`
 *     keeps the N most-recent rows PER SCOPE. NULL scopes form their own
 *     bucket. Other settingKeys are untouched.
 *
 *   - `pruneQueueTimingAudit({maxEntries, maxAgeDays})`:
 *       * `maxEntries=N` keeps only the N newest rows globally.
 *       * `maxAgeDays=D` deletes rows older than now - D days.
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  ensureAdminSettingAuditTable,
  ensureQueueTimingAuditTable,
  recordAdminSettingChange,
  recordQueueTimingChange,
  pruneAdminSettingAuditPerScope,
  pruneQueueTimingAudit,
  listQueueTimingAudit,
  listAdminSettingAudit,
} from "../server/storage/settingsStorage";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `atp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SETTING_KEY = `test_setting_${TAG}`;
const OTHER_SETTING_KEY = `other_setting_${TAG}`;
const ACTOR_ID = `actor-${TAG}`;
const DAY_MS = 24 * 60 * 60 * 1000;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'Audit', 'Pruner')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM admin_setting_audit WHERE setting_key IN (${SETTING_KEY}, ${OTHER_SETTING_KEY})`);
  await db.execute(sql`DELETE FROM queue_timing_audit WHERE changed_by = ${ACTOR_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
}

async function main(): Promise<void> {
  await ensureAdminSettingAuditTable();
  await ensureQueueTimingAuditTable();
  await ensureUser();

  try {
    // ── pruneAdminSettingAuditPerScope ──────────────────────────────────
    // Seed 4 rows in scope-A, 4 in scope-B, 1 NULL-scope, plus 2 in a
    // different settingKey that must NOT be touched.
    for (let i = 0; i < 4; i++) {
      await recordAdminSettingChange({
        settingKey: SETTING_KEY, scope: "A",
        changedBy: ACTOR_ID, oldValues: null, newValues: { i },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    for (let i = 0; i < 4; i++) {
      await recordAdminSettingChange({
        settingKey: SETTING_KEY, scope: "B",
        changedBy: ACTOR_ID, oldValues: null, newValues: { i },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    await recordAdminSettingChange({
      settingKey: SETTING_KEY, scope: null,
      changedBy: ACTOR_ID, oldValues: null, newValues: { v: "null-scope" },
    });
    for (let i = 0; i < 2; i++) {
      await recordAdminSettingChange({
        settingKey: OTHER_SETTING_KEY, scope: "A",
        changedBy: ACTOR_ID, oldValues: null, newValues: { i },
      });
    }

    const pruned = await pruneAdminSettingAuditPerScope({
      settingKey: SETTING_KEY, maxEntriesPerScope: 2,
    });
    // Each of A and B had 4 rows → 2 deleted per bucket → 4 total.
    // NULL-scope had 1 → nothing deleted (within the cap).
    assert(pruned === 4,
      `expected 4 rows pruned (2 from each of A and B), got ${pruned}`);

    const remainA = await listAdminSettingAudit({ settingKey: SETTING_KEY, scope: "A", limit: 100 });
    const remainB = await listAdminSettingAudit({ settingKey: SETTING_KEY, scope: "B", limit: 100 });
    assert(remainA.length === 2, `scope A should retain 2 rows, got ${remainA.length}`);
    assert(remainB.length === 2, `scope B should retain 2 rows, got ${remainB.length}`);

    const otherRows = await listAdminSettingAudit({ settingKey: OTHER_SETTING_KEY, limit: 100 });
    assert(otherRows.length === 2,
      `unrelated settingKey should be untouched (had 2), got ${otherRows.length}`);

    // ── pruneQueueTimingAudit (maxEntries) ──────────────────────────────
    for (let i = 0; i < 5; i++) {
      await recordQueueTimingChange({
        changedBy: ACTOR_ID, oldValues: null, newValues: { i },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const before = (await listQueueTimingAudit(50)).filter((r) => r.changedBy === ACTOR_ID);
    assert(before.length === 5, `seeded 5 rows, listed ${before.length}`);

    const prunedQ = await pruneQueueTimingAudit({ maxEntries: 2 });
    // We could prune rows from other test runs too, so just assert >= 3.
    assert(prunedQ >= 3, `maxEntries=2 should prune at least our 3 oldest, got ${prunedQ}`);
    const afterMax = (await listQueueTimingAudit(50)).filter((r) => r.changedBy === ACTOR_ID);
    assert(afterMax.length <= 2,
      `expected <=2 of our queue audit rows after maxEntries=2, got ${afterMax.length}`);

    // ── pruneQueueTimingAudit (maxAgeDays) ──────────────────────────────
    // Insert one fresh row, then forcibly age one row to 10 days ago.
    const inserted = await recordQueueTimingChange({
      changedBy: ACTOR_ID, oldValues: null, newValues: { mark: "fresh" },
    });
    const aged = await recordQueueTimingChange({
      changedBy: ACTOR_ID, oldValues: null, newValues: { mark: "old" },
    });
    await db.execute(sql`
      UPDATE queue_timing_audit
      SET changed_at = now() - interval '10 days'
      WHERE id = ${aged.id}
    `);

    await pruneQueueTimingAudit({ maxAgeDays: 7 });
    const after = (await listQueueTimingAudit(50)).filter((r) => r.changedBy === ACTOR_ID);
    const afterIds = after.map((r) => r.id);
    assert(!afterIds.includes(aged.id),
      "10-day-old queue audit row should be pruned at maxAgeDays=7");
    assert(afterIds.includes(inserted.id),
      "fresh queue audit row should survive maxAgeDays=7");

    console.log("audit-table-prune: PASSED");
  } finally {
    await cleanup().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("audit-table-prune: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
