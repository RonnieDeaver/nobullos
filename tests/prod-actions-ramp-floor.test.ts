/* test-registration
{
  "name": "Prod-actions ramp-ladder floor \u2014 no perpetual-pending / no downgrade",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Ramp-ladder floor (one-and-done) regression test.
 *
 * Bug: the lower rungs of the two ramp ladders used EXACT-match
 * equality, so once a higher rung (or the force-ramp) overshot the
 * target during "Apply all", the lower rung re-flagged as `pending`
 * forever — and pressing it would actively DOWNGRADE the live setting.
 *
 * Fix: ramp-up rungs treat their target as a numeric FLOOR.
 *
 *   - `ramp_front_recovery_ingest_concurrency` (target 2, via the
 *     `systemSettingAction({ satisfiedWhenAtLeast: true })` helper)
 *   - `ramp_ingestion_class_concurrency_4` (target 4, bespoke action)
 *
 * For each: when the current value is ABOVE the target,
 *   (1) status() must report `not-needed` (not `pending`), and
 *   (2) apply() must NOT downgrade the value back to the target.
 * And when BELOW the target, apply() still raises it to the target.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getIngestionClassConcurrency,
  setIngestionClassConcurrency,
} from "../server/services/workloadManager";

const TAG_USER = "test-prod-actions-ramp-floor";
const RECOVERY_KEY = "front_recovery_ingest_concurrency";
const RECOVERY_RAMP_2_ID = "ramp_front_recovery_ingest_concurrency";
const INGESTION_KEY = "workload_class_ingestion_max_concurrency";
const INGESTION_RAMP_4_ID = "ramp_ingestion_class_concurrency_4";

function find(id: string) {
  const a = PROD_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`action ${id} not in PROD_ACTIONS`);
  return a;
}

async function snapshot(key: string): Promise<string | null> {
  const row = await storage.getSystemSetting(key);
  return row?.value ?? null;
}

async function restore(key: string, value: string | null): Promise<void> {
  if (value === null) await storage.deleteSystemSetting(key);
  else await storage.setSystemSetting(key, value);
}

async function ensureTagUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name)
    VALUES (${TAG_USER}, 'ceo', 'ceo', 'ramp-floor-tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
  `);
}

async function deleteTagUser(): Promise<void> {
  try { await db.execute(sql`DELETE FROM users WHERE id = ${TAG_USER}`); } catch {}
}

async function main(): Promise<void> {
  await ensureTagUser();
  const originalRecovery = await snapshot(RECOVERY_KEY);
  const originalIngestionPersisted = await snapshot(INGESTION_KEY);
  const originalIngestionLive = getIngestionClassConcurrency();

  const recoveryRamp = find(RECOVERY_RAMP_2_ID);
  const ingestionRamp = find(INGESTION_RAMP_4_ID);

  try {
    // ── Recovery ramp-to-2 (systemSettingAction floor) ──────────────
    // Already above target (3 > 2): not-needed, and apply must NOT
    // downgrade to 2.
    await storage.setSystemSetting(RECOVERY_KEY, "3", TAG_USER);
    let s = await recoveryRamp.status(TAG_USER);
    assert.equal(
      s.state,
      "not-needed",
      `recovery@3 status should be not-needed: ${JSON.stringify(s)}`,
    );
    let o = await recoveryRamp.apply(TAG_USER);
    assert.equal(
      o.state,
      "not-needed",
      `recovery@3 apply should be not-needed: ${JSON.stringify(o)}`,
    );
    assert.equal(
      await snapshot(RECOVERY_KEY),
      "3",
      "recovery ramp-to-2 must NOT downgrade 3 → 2",
    );
    console.log("  ok  recovery ramp-to-2 is a no-op once already at 3 (no downgrade)");

    // Exactly at target (2): not-needed.
    await storage.setSystemSetting(RECOVERY_KEY, "2", TAG_USER);
    s = await recoveryRamp.status(TAG_USER);
    assert.equal(s.state, "not-needed", `recovery@2 status: ${JSON.stringify(s)}`);
    console.log("  ok  recovery ramp-to-2 not-needed when exactly at 2");

    // Below target (1): pending, and apply raises to 2.
    await storage.setSystemSetting(RECOVERY_KEY, "1", TAG_USER);
    s = await recoveryRamp.status(TAG_USER);
    assert.equal(s.state, "pending", `recovery@1 status: ${JSON.stringify(s)}`);
    o = await recoveryRamp.apply(TAG_USER);
    assert.equal(o.state, "applied", `recovery@1 apply: ${JSON.stringify(o)}`);
    assert.equal(await snapshot(RECOVERY_KEY), "2", "recovery ramp-to-2 must raise 1 → 2");
    console.log("  ok  recovery ramp-to-2 still raises 1 → 2 when below target");

    // Non-numeric current value must NOT be treated as satisfied by the
    // floor comparison (Number("abc") is NaN) — it stays pending.
    await storage.setSystemSetting(RECOVERY_KEY, "abc", TAG_USER);
    s = await recoveryRamp.status(TAG_USER);
    assert.equal(s.state, "pending", `recovery@abc status: ${JSON.stringify(s)}`);
    console.log("  ok  recovery ramp-to-2 stays pending for a non-numeric value");

    // ── Ingestion ramp-to-4 (bespoke floor) ─────────────────────────
    // Already above target (persisted=5, live=5): not-needed, and apply
    // must NOT downgrade either the persisted or live value to 4.
    await storage.setSystemSetting(INGESTION_KEY, "5", TAG_USER);
    setIngestionClassConcurrency(5);
    s = await ingestionRamp.status(TAG_USER);
    assert.equal(
      s.state,
      "not-needed",
      `ingestion@5 status should be not-needed: ${JSON.stringify(s)}`,
    );
    o = await ingestionRamp.apply(TAG_USER);
    assert.equal(
      o.state,
      "not-needed",
      `ingestion@5 apply should be not-needed: ${JSON.stringify(o)}`,
    );
    assert.equal(
      await snapshot(INGESTION_KEY),
      "5",
      "ingestion ramp-to-4 must NOT downgrade persisted 5 → 4",
    );
    assert.equal(
      getIngestionClassConcurrency(),
      5,
      "ingestion ramp-to-4 must NOT downgrade live 5 → 4",
    );
    console.log("  ok  ingestion ramp-to-4 is a no-op once already at 5 (no downgrade)");
  } finally {
    await restore(RECOVERY_KEY, originalRecovery);
    await restore(INGESTION_KEY, originalIngestionPersisted);
    setIngestionClassConcurrency(originalIngestionLive);
    try {
      await db.execute(sql`DELETE FROM prod_action_runs WHERE actor_user_id = ${TAG_USER}`);
    } catch {}
    await deleteTagUser();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("prod-actions-ramp-floor: all cases passed");
  },
  (err) => {
    console.error("prod-actions-ramp-floor: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
