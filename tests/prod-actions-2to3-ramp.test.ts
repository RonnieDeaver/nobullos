/* test-registration
{
  "name": "Prod-actions 2\u21923 ramp gating (Task #1807)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1808 (companion) — unit-ish gating test for the Task #1807
 * "Ramp Front recovery ingest concurrency from 2 → 3" registry action.
 *
 * Covers the four gates inside `ramp2to3Action.status()`/`apply()`:
 *
 *   (a) current value != "2" → not-needed
 *   (b) current value == "2" AND no successful 1→2 audit row → not-needed
 *   (c) current value == "2" AND last 1→2 success < 24h old → not-needed
 *   (d) current value == "2" AND last 1→2 success ≥ 24h old → pending,
 *       and apply() flips the setting to "3" and writes its own audit row.
 *
 * To keep the test isolated:
 *   - `front_recovery_ingest_concurrency` is read/restored via the
 *     normal storage helpers (a snapshot is captured at the start).
 *   - The audit table is seeded with a fabricated `applied` row for the
 *     1→2 action whose `applied_at` we backdate via `UPDATE`.
 *   - All seeded rows are tagged with `actor_user_id = TAG_USER` so the
 *     cleanup is a single DELETE.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  ensureProdActionRunsTable,
  recordProdActionRun,
} from "../server/storage/prodActionRuns";

const TAG_USER = "test-prod-actions-1807";
const CONC_KEY = "front_recovery_ingest_concurrency";
const RAMP_1_TO_2_ID = "ramp_front_recovery_ingest_concurrency";
const RAMP_2_TO_3_ID = "ramp_front_recovery_ingest_concurrency_3";

function find(id: string) {
  const a = PROD_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`action ${id} not in PROD_ACTIONS`);
  return a;
}

async function snapshotConcurrency(): Promise<string | null> {
  const row = await storage.getSystemSetting(CONC_KEY);
  return row?.value ?? null;
}

async function restoreConcurrency(value: string | null): Promise<void> {
  if (value === null) {
    await storage.deleteSystemSetting(CONC_KEY);
  } else {
    await storage.setSystemSetting(CONC_KEY, value);
  }
}

async function ensureTagUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name)
    VALUES (${TAG_USER}, 'ceo', 'ceo', 'task-1807-tester')
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, authority_level = EXCLUDED.authority_level
  `);
}

async function clearTagAudit(): Promise<void> {
  await db.execute(sql`DELETE FROM prod_action_runs WHERE actor_user_id = ${TAG_USER}`);
}

async function deleteTagUser(): Promise<void> {
  try { await db.execute(sql`DELETE FROM users WHERE id = ${TAG_USER}`); } catch {}
}

async function seedRamp1to2Success(ageHours: number): Promise<void> {
  await recordProdActionRun({
    actionId: RAMP_1_TO_2_ID,
    actionTitle: "Ramp Front recovery ingest concurrency to 2",
    actorUserId: TAG_USER,
    outcomeState: "applied",
    detail: `seed for task-1808 (${ageHours}h ago)`,
    rowsAffected: null,
    errorMessage: null,
  });
  // Backdate the audit row to ageHours ago so the gate computes the
  // expected elapsed window.
  await db.execute(sql`
    UPDATE prod_action_runs
    SET applied_at = NOW() - (${ageHours} || ' hours')::interval
    WHERE actor_user_id = ${TAG_USER}
      AND action_id = ${RAMP_1_TO_2_ID}
  `);
}

async function main(): Promise<void> {
  await ensureProdActionRunsTable();
  await ensureTagUser();
  const originalConcurrency = await snapshotConcurrency();
  await clearTagAudit();

  const action = find(RAMP_2_TO_3_ID);

  try {
    // (a) current != "2" → not-needed (status + apply)
    await storage.setSystemSetting(CONC_KEY, "1", TAG_USER);
    let s = await action.status(TAG_USER);
    assert.equal(s.state, "not-needed", `(a) status with current=1: ${JSON.stringify(s)}`);
    let o = await action.apply(TAG_USER);
    assert.equal(o.state, "not-needed", `(a) apply with current=1: ${JSON.stringify(o)}`);
    let after = await snapshotConcurrency();
    assert.equal(after, "1", "(a) apply must NOT flip from 1");
    console.log("  ok  (a) not-needed when current != 2");

    // (b) current=="2" AND no audit row → not-needed
    await storage.setSystemSetting(CONC_KEY, "2", TAG_USER);
    await clearTagAudit();
    s = await action.status(TAG_USER);
    assert.equal(s.state, "not-needed", `(b) status w/o audit: ${JSON.stringify(s)}`);
    o = await action.apply(TAG_USER);
    assert.equal(o.state, "not-needed", `(b) apply w/o audit: ${JSON.stringify(o)}`);
    after = await snapshotConcurrency();
    assert.equal(after, "2", "(b) apply must NOT flip without prior 1→2 audit");
    console.log("  ok  (b) not-needed when no 1→2 success row exists");

    // (c) current=="2" AND last 1→2 success only 1h old → not-needed
    await clearTagAudit();
    await seedRamp1to2Success(1);
    s = await action.status(TAG_USER);
    assert.equal(s.state, "not-needed", `(c) status w/ 1h-old audit: ${JSON.stringify(s)}`);
    o = await action.apply(TAG_USER);
    assert.equal(o.state, "not-needed", `(c) apply w/ 1h-old audit: ${JSON.stringify(o)}`);
    after = await snapshotConcurrency();
    assert.equal(after, "2", "(c) apply must NOT flip inside watch window");
    console.log("  ok  (c) not-needed when 1→2 audit row is younger than 24h");

    // (d) current=="2" AND last 1→2 success 25h old → pending → apply flips to 3
    await clearTagAudit();
    await seedRamp1to2Success(25);
    s = await action.status(TAG_USER);
    assert.equal(s.state, "pending", `(d) status w/ 25h-old audit: ${JSON.stringify(s)}`);
    o = await action.apply(TAG_USER);
    assert.equal(o.state, "applied", `(d) apply w/ 25h-old audit: ${JSON.stringify(o)}`);
    after = await snapshotConcurrency();
    assert.equal(after, "3", "(d) apply must flip 2 → 3 once watch window elapses");
    // status() should now report "not-needed" because current is 3.
    s = await action.status(TAG_USER);
    assert.equal(s.state, "not-needed", `(d) status post-apply: ${JSON.stringify(s)}`);
    console.log("  ok  (d) pending → applied flips concurrency 2 → 3 once 24h elapses");
  } finally {
    await restoreConcurrency(originalConcurrency);
    await clearTagAudit();
    await deleteTagUser();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("prod-actions-2to3-ramp: all gates passed");
  },
  async (err) => {
    console.error("prod-actions-2to3-ramp: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
