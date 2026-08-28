/* test-registration
{
  "name": "Prod actions front discovered apply tail (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2089 — Verification for the `drain_stuck_front_discovered_apply_tail`
 * prod-action: drains the residual `front_sync_emails` rows stuck in
 * pipeline_state='discovered' for >24h (the inert tail of the 2026-04
 * apply-stall epic #1641/#1803/#1834/#1836, absorbs #1921).
 *
 * For each stuck row the action does a single deterministic reconcile:
 *   • raw_communication_records already has a row for the Front
 *     conversation id  → reconcile the mirror FORWARD to 'applied' and
 *     backfill ingested_record_id.
 *   • no raw_communication_records row  → terminally close the mirror to
 *     'failed' with the documented [task-2089] reason.
 *
 * Negative controls the chunk filter must NEVER touch:
 *   • a `discovered` row younger than 24h (live in-flight protection),
 *   • a row already in a terminal state ('applied' / 'failed').
 *
 * Isolation (Task #1929 pattern): everything runs inside
 * `runInIsolatedSchema` so the live `Start application` workers (default
 * search_path = public) can neither see, claim, nor race-write the rows
 * the test seeds.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  __resetDrainsForTest,
  type DrainState,
} from "../server/services/prodActionBackgroundDrain";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION_ID = "drain_stuck_front_discovered_apply_tail";
const TABLES = [
  "front_sync_emails",
  "raw_communication_records",
  "prod_action_runs",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

async function awaitDrain(timeoutMs = 20_000): Promise<DrainState> {
  const start = Date.now();
  for (;;) {
    const st = getDrainState(ACTION_ID);
    if (st && st.finishedAt !== null) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `drain ${ACTION_ID} did not finish within ${timeoutMs}ms (state=${JSON.stringify(st)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function getAction() {
  const action = PROD_ACTIONS.find((a) => a.id === ACTION_ID);
  if (!action) throw new Error(`${ACTION_ID} missing from PROD_ACTIONS registry`);
  return action;
}

async function seedSyncEmail(
  isoDb: IsoDb,
  row: { id: string; conversationId: string; pipelineState: string; ageHours: number },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO front_sync_emails
      (id, conversation_id, pipeline_state, state_changed_at, created_at)
    VALUES (
      ${row.id},
      ${row.conversationId},
      ${row.pipelineState},
      NOW() - (${row.ageHours} || ' hours')::interval,
      NOW() - (${row.ageHours} || ' hours')::interval
    )
  `);
}

async function seedRawRecord(
  isoDb: IsoDb,
  row: { id: string; conversationId: string },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO raw_communication_records
      (id, source_type, title, timestamp, external_source_id, created_at, updated_at)
    VALUES (
      ${row.id},
      'front_email',
      ${`seed ${row.conversationId}`},
      NOW(),
      ${row.conversationId},
      NOW(),
      NOW()
    )
  `);
}

async function readSyncEmail(
  isoDb: IsoDb,
  id: string,
): Promise<{ pipeline_state: string; ingested_record_id: string | null; pipeline_error: string | null; pipeline_attempts: number }> {
  const res: any = await isoDb.execute(sql`
    SELECT pipeline_state, ingested_record_id, pipeline_error, pipeline_attempts
    FROM front_sync_emails WHERE id = ${id}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  const r = rows[0];
  return {
    pipeline_state: String(r.pipeline_state),
    ingested_record_id: r.ingested_record_id === null ? null : String(r.ingested_record_id),
    pipeline_error: r.pipeline_error === null ? null : String(r.pipeline_error),
    pipeline_attempts: Number(r.pipeline_attempts),
  };
}

async function testReconcileOrClose(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    // Matching: stale discovered rows.
    //  - applied case: a raw_communication_record already exists.
    await seedSyncEmail(isoDb, { id: "fse-applied", conversationId: "cnv_applied", pipelineState: "discovered", ageHours: 720 });
    await seedRawRecord(isoDb, { id: "raw-applied", conversationId: "cnv_applied" });
    //  - terminal-close case: no raw record exists.
    await seedSyncEmail(isoDb, { id: "fse-orphan", conversationId: "cnv_orphan", pipelineState: "discovered", ageHours: 720 });

    // Negatives the filter must never touch.
    await seedSyncEmail(isoDb, { id: "fse-recent", conversationId: "cnv_recent", pipelineState: "discovered", ageHours: 2 });
    await seedSyncEmail(isoDb, { id: "fse-already-applied", conversationId: "cnv_already", pipelineState: "applied", ageHours: 720 });
    await seedSyncEmail(isoDb, { id: "fse-already-failed", conversationId: "cnv_failed", pipelineState: "failed", ageHours: 720 });

    const action = getAction();

    const pre = await action.status(null);
    assert.equal(pre.state, "pending", `expected pending status, got ${JSON.stringify(pre)}`);

    const out = await action.apply(null);
    assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

    const state = await awaitDrain();
    assert.equal(state.error, null, `drain errored — ${state.error}`);
    assert.equal(state.processed, 2, `expected 2 processed, got ${state.processed}`);
    assert.deepEqual(
      state.perKey,
      { reconciled_applied: 1, closed_terminal: 1 },
      `unexpected perKey ${JSON.stringify(state.perKey)}`,
    );

    // Reconciled-applied row.
    const applied = await readSyncEmail(isoDb, "fse-applied");
    assert.equal(applied.pipeline_state, "applied", "matched row should reconcile to applied");
    assert.equal(applied.ingested_record_id, "raw-applied", "ingested_record_id should be backfilled");
    assert.equal(applied.pipeline_error, null, "applied row should clear pipeline_error");

    // Terminally-closed row.
    const orphan = await readSyncEmail(isoDb, "fse-orphan");
    assert.equal(orphan.pipeline_state, "failed", "orphan row should be terminally failed");
    assert(orphan.pipeline_error?.startsWith("[task-2089]"), `orphan reason should carry the [task-2089] tag, got ${orphan.pipeline_error}`);
    assert.equal(orphan.pipeline_attempts, 1, "orphan pipeline_attempts should increment");

    // Negatives untouched.
    const recent = await readSyncEmail(isoDb, "fse-recent");
    assert.equal(recent.pipeline_state, "discovered", "recent (<24h) discovered row must be left alone");
    const alreadyApplied = await readSyncEmail(isoDb, "fse-already-applied");
    assert.equal(alreadyApplied.pipeline_state, "applied", "pre-applied row must be left alone");
    const alreadyFailed = await readSyncEmail(isoDb, "fse-already-failed");
    assert.equal(alreadyFailed.pipeline_state, "failed", "pre-failed row must be left alone");

    ok("reconciled 1 applied + closed 1 terminal; recent + terminal negatives untouched");
  }, { tables: TABLES });
}

async function testIdempotentSecondPress(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    await seedSyncEmail(isoDb, { id: "fse-orphan-2", conversationId: "cnv_orphan_2", pipelineState: "discovered", ageHours: 720 });

    const action = getAction();
    const out1 = await action.apply(null);
    assert.equal(out1.state, "applied", `first press should be applied, got ${JSON.stringify(out1)}`);
    await awaitDrain();

    // Second press: nothing left to do → not-needed.
    __resetDrainsForTest();
    const status2 = await action.status(null);
    assert.equal(status2.state, "not-needed", `after drain, status should be not-needed, got ${JSON.stringify(status2)}`);
    const out2 = await action.apply(null);
    assert.equal(out2.state, "not-needed", `second press should be not-needed, got ${JSON.stringify(out2)}`);

    // The already-failed row is not re-touched.
    const orphan = await readSyncEmail(isoDb, "fse-orphan-2");
    assert.equal(orphan.pipeline_state, "failed", "row should stay failed");
    assert.equal(orphan.pipeline_attempts, 1, "second press must not re-increment attempts");

    ok("second press is a safe not-needed no-op (idempotent)");
  }, { tables: TABLES });
}

async function main(): Promise<void> {
  await testReconcileOrClose();
  await testIdempotentSecondPress();
  console.log(`\n${passed} assertion group(s) passed`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
