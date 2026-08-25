/* test-registration
{
  "name": "Prod-action background-drain consumers e2e (Task #2005)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 300000,
  "tier": "small"
}
test-registration */
/**
 * Task #2005 — End-to-end verification that each of the four real
 * consumers of the shared background-drain primitive
 * (`prodActionBackgroundDrain.startBackgroundDrain`) drains exactly the
 * rows its filter targets, and that the `prod_action_runs` audit row
 * records the same tally that `runChunk()` actually processed.
 *
 * For every action this test:
 *   1. seeds a small fixture (matching rows + negative-control rows that
 *      the filter must NOT touch) into an isolated Postgres schema,
 *   2. presses `apply()`,
 *   3. lets the fire-and-forget background drain finish (polls
 *      `getDrainState(...).finishedAt`),
 *   4. asserts the correct rows were updated/deleted/replayed and the
 *      negatives were left alone,
 *   5. asserts the `prod_action_runs` audit row shows `outcome_state`
 *      'applied' with `rows_affected` equal to what the drain processed,
 *   6. asserts `countPending()` (captured as `totalAtStart`) matches what
 *      `runChunk()` actually processed (`state.processed`).
 *
 * Isolation (Task #1929 pattern): everything runs inside
 * `runInIsolatedSchema` so the live `Start application` workers (default
 * search_path = public) can neither see, claim, nor race-write the rows
 * the test seeds. The dead-letter replay consumer reaches
 * `replayDeadLetteredJobsBatch` in `workScheduler.ts`, which Task #2005
 * migrated from the bare `workerDb` to `getDb()` so the override applies
 * to it too (production behavior unchanged — its only caller is this
 * drain, which always runs inside `runWithWorkerDb`).
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  isDrainRunning,
  startBackgroundDrain,
  __resetDrainsForTest,
  __acquireDrainLockForTest,
  __setDrainLockAcquireOverrideForTest,
  type DrainState,
  type DrainSpec,
} from "../server/services/prodActionBackgroundDrain";
import { runInIsolatedSchema } from "./db-sandbox";

const TABLES = ["work_queue", "source_event_log", "prod_action_runs"] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

/**
 * Await completion of the fire-and-forget background drain. The drain's
 * async continuations inherit the sandbox AsyncLocalStorage context (it
 * is launched from inside apply(), inside fn, inside sandboxStorage.run),
 * so the setTimeout yields here let it progress against the isolated db.
 */
async function awaitDrain(actionId: string, timeoutMs = 20_000): Promise<DrainState> {
  const start = Date.now();
  for (;;) {
    const st = getDrainState(actionId);
    if (st && st.finishedAt !== null) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `drain ${actionId} did not finish within ${timeoutMs}ms (state=${JSON.stringify(st)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Task #2234 — `runDrainLoop` now sets `state.finishedAt` (which `awaitDrain`
// keys off) only AFTER its terminal `finalizeAudit()` INSERT into
// `prod_action_runs` has completed. So once `awaitDrain` returns, the audit
// row is guaranteed to be present and a direct `auditRow(...)` read is safe —
// no polling helper needed.
async function seedWorkQueue(
  isoDb: IsoDb,
  row: {
    id: string;
    queueName: string;
    workloadClass: string;
    status: string;
    attemptCount?: number;
  },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO work_queue (id, queue_name, job_type, workload_class, status, attempt_count, payload, created_at, updated_at)
    VALUES (
      ${row.id},
      ${row.queueName},
      ${row.queueName},
      ${row.workloadClass},
      ${row.status},
      ${row.attemptCount ?? 0},
      ${JSON.stringify({ seed: row.id })}::jsonb,
      NOW(),
      NOW()
    )
  `);
}

async function workQueueField(
  isoDb: IsoDb,
  id: string,
  field: "workload_class" | "status" | "attempt_count",
): Promise<string | null> {
  const res: any = await isoDb.execute(
    sql`SELECT ${sql.raw(field)} AS v FROM work_queue WHERE id = ${id}`,
  );
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows.length ? String(rows[0].v) : null;
}

async function auditRow(
  isoDb: IsoDb,
  actionId: string,
): Promise<{ outcome_state: string; rows_affected: number; error_message: string | null } | null> {
  const res: any = await isoDb.execute(sql`
    SELECT outcome_state, rows_affected, error_message
    FROM prod_action_runs
    WHERE action_id = ${actionId}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  if (rows.length === 0) return null;
  assert.equal(rows.length, 1, `${actionId}: expected exactly one audit row, got ${rows.length}`);
  return {
    outcome_state: String(rows[0].outcome_state),
    rows_affected: Number(rows[0].rows_affected),
    error_message: rows[0].error_message === null ? null : String(rows[0].error_message),
  };
}

/** Shared assertion: drain finished cleanly, countPending == processed == expected, audit matches. */
function assertDrainTally(
  state: DrainState,
  audit: { outcome_state: string; rows_affected: number } | null,
  actionId: string,
  expectedProcessed: number,
): void {
  assert.equal(state.error, null, `${actionId}: drain errored — ${state.error}`);
  assert.equal(
    state.processed,
    expectedProcessed,
    `${actionId}: expected runChunk to process ${expectedProcessed}, got ${state.processed}`,
  );
  assert.equal(
    state.totalAtStart,
    state.processed,
    `${actionId}: countPending (${state.totalAtStart}) must match what runChunk processed (${state.processed})`,
  );
  assert(audit, `${actionId}: no prod_action_runs audit row was written`);
  assert.equal(
    audit.outcome_state,
    "applied",
    `${actionId}: expected audit outcome_state 'applied', got '${audit.outcome_state}'`,
  );
  assert.equal(
    audit.rows_affected,
    expectedProcessed,
    `${actionId}: audit rows_affected (${audit.rows_affected}) must equal processed (${expectedProcessed})`,
  );
}

function getAction(id: string) {
  const action = PROD_ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error(`${id} missing from PROD_ACTIONS registry`);
  return action;
}

/**
 * Shared assertion for the empty-backlog path (Task #2032): with ZERO
 * matching rows seeded, apply() must report `not-needed`, the early
 * `nothing-to-do` return inside startBackgroundDrain must fire (so no
 * background drain is ever launched — `getDrainState` stays undefined),
 * and crucially NO `prod_action_runs` audit row may be written.
 */
async function assertEmptyBacklogNoAudit(
  isoDb: IsoDb,
  out: { state: string; detail?: string },
  actionId: string,
): Promise<void> {
  assert.equal(
    out.state,
    "not-needed",
    `${actionId}: empty backlog must report 'not-needed', got ${JSON.stringify(out)}`,
  );
  assert.equal(
    getDrainState(actionId),
    undefined,
    `${actionId}: nothing-to-do must return before any drain state is created`,
  );
  const audit = await auditRow(isoDb, actionId);
  assert.equal(
    audit,
    null,
    `${actionId}: empty backlog must NOT write a prod_action_runs row (got ${JSON.stringify(audit)})`,
  );
}

// ─── Consumer 1: rewrite_pending_front_backlog_to_ingestion ──────────
async function testFrontBacklogReclassify(): Promise<void> {
  const ACTION = "rewrite_pending_front_backlog_to_ingestion";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Matching: pending + maintenance on the two reclassify queues.
    await seedWorkQueue(isoDb, { id: "r-match-apply", queueName: "front_webhook_apply", workloadClass: "maintenance", status: "pending" });
    await seedWorkQueue(isoDb, { id: "r-match-norm", queueName: "front_webhook_normalize", workloadClass: "maintenance", status: "pending" });
    // Negatives: wrong status / already-ingestion / wrong queue.
    await seedWorkQueue(isoDb, { id: "r-neg-processing", queueName: "front_webhook_apply", workloadClass: "maintenance", status: "processing" });
    await seedWorkQueue(isoDb, { id: "r-neg-ingestion", queueName: "front_webhook_apply", workloadClass: "ingestion", status: "pending" });
    await seedWorkQueue(isoDb, { id: "r-neg-queue", queueName: "front_reconciliation", workloadClass: "maintenance", status: "pending" });

    const out = await getAction(ACTION).apply(null);
    assert.equal(out.state, "applied", `${ACTION}: expected applied, got ${JSON.stringify(out)}`);
    const state = await awaitDrain(ACTION);
    assertDrainTally(state, await auditRow(isoDb, ACTION), ACTION, 2);

    assert.equal(await workQueueField(isoDb, "r-match-apply", "workload_class"), "ingestion");
    assert.equal(await workQueueField(isoDb, "r-match-norm", "workload_class"), "ingestion");
    assert.equal(await workQueueField(isoDb, "r-neg-processing", "workload_class"), "maintenance");
    assert.equal(await workQueueField(isoDb, "r-neg-ingestion", "status"), "pending");
    assert.equal(await workQueueField(isoDb, "r-neg-queue", "workload_class"), "maintenance");
    ok(`${ACTION}: reclassified 2 matching rows, 3 negatives untouched, audit tally correct`);
  }, { tables: TABLES });
}

// ─── Consumer 2: front_warp_class_backfill ───────────────────────────
async function testFrontWarpClassBackfill(): Promise<void> {
  const ACTION = "front_warp_class_backfill";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Matching: ingestion class, eligible statuses, the three front queues.
    await seedWorkQueue(isoDb, { id: "w-match-pending", queueName: "front_webhook_apply", workloadClass: "ingestion", status: "pending" });
    await seedWorkQueue(isoDb, { id: "w-match-dead", queueName: "front_reconciliation", workloadClass: "ingestion", status: "dead_letter" });
    await seedWorkQueue(isoDb, { id: "w-match-failed", queueName: "front_webhook_normalize", workloadClass: "ingestion", status: "failed" });
    // Negatives: terminal status / already front_ingestion / wrong queue.
    await seedWorkQueue(isoDb, { id: "w-neg-completed", queueName: "front_webhook_apply", workloadClass: "ingestion", status: "completed" });
    await seedWorkQueue(isoDb, { id: "w-neg-already", queueName: "front_webhook_apply", workloadClass: "front_ingestion", status: "pending" });
    await seedWorkQueue(isoDb, { id: "w-neg-queue", queueName: "zoom_recording_match", workloadClass: "ingestion", status: "pending" });

    const out = await getAction(ACTION).apply(null);
    assert.equal(out.state, "applied", `${ACTION}: expected applied, got ${JSON.stringify(out)}`);
    const state = await awaitDrain(ACTION);
    assertDrainTally(state, await auditRow(isoDb, ACTION), ACTION, 3);

    assert.equal(await workQueueField(isoDb, "w-match-pending", "workload_class"), "front_ingestion");
    assert.equal(await workQueueField(isoDb, "w-match-dead", "workload_class"), "front_ingestion");
    assert.equal(await workQueueField(isoDb, "w-match-failed", "workload_class"), "front_ingestion");
    assert.equal(await workQueueField(isoDb, "w-neg-completed", "workload_class"), "ingestion");
    assert.equal(await workQueueField(isoDb, "w-neg-already", "workload_class"), "front_ingestion");
    assert.equal(await workQueueField(isoDb, "w-neg-queue", "workload_class"), "ingestion");
    ok(`${ACTION}: promoted 3 matching rows → front_ingestion, 3 negatives untouched, audit tally correct`);
  }, { tables: TABLES });
}

// ─── Consumer 3: backfill_front_recovery_dedupe_keys ─────────────────
async function seedSourceEvent(
  isoDb: IsoDb,
  row: { id: string; sourceSystem: string; dedupeKey: string; lastMessageId: string },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO source_event_log
      (id, source_system, source_event_type, source_object_id, dedupe_key, payload_json, status, received_at, created_at, updated_at)
    VALUES (
      ${row.id},
      ${row.sourceSystem},
      'conversation',
      ${row.id},
      ${row.dedupeKey},
      ${JSON.stringify({ last_message: { id: row.lastMessageId } })}::jsonb,
      'received',
      NOW(), NOW(), NOW()
    )
  `);
}

async function dedupeKeyOf(isoDb: IsoDb, id: string): Promise<string | null> {
  const res: any = await isoDb.execute(sql`SELECT dedupe_key FROM source_event_log WHERE id = ${id}`);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows.length ? String(rows[0].dedupe_key) : null;
}

async function testBackfillDedupeKeys(): Promise<void> {
  const ACTION = "backfill_front_recovery_dedupe_keys";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Matching legacy (trailing-empty-colon) rows → rewritten to versioned shape.
    await seedSourceEvent(isoDb, { id: "d-rewrite-1", sourceSystem: "front", dedupeKey: "front:recovery:cnv_1:", lastMessageId: "msg_1" });
    await seedSourceEvent(isoDb, { id: "d-rewrite-2", sourceSystem: "front", dedupeKey: "front:reconcile:cnv_2:", lastMessageId: "msg_2" });
    // Collision case: legacy row whose rewritten key already exists → legacy row DELETEd.
    await seedSourceEvent(isoDb, { id: "d-collide-legacy", sourceSystem: "front", dedupeKey: "front:backfill:cnv_3:", lastMessageId: "msg_3" });
    await seedSourceEvent(isoDb, { id: "d-collide-target", sourceSystem: "front", dedupeKey: "front:backfill:cnv_3:msg_3", lastMessageId: "msg_3" });
    // Negatives: already versioned (no trailing colon) / non-front / non-legacy prefix.
    await seedSourceEvent(isoDb, { id: "d-neg-versioned", sourceSystem: "front", dedupeKey: "front:recovery:cnv_9:msg_9", lastMessageId: "msg_9" });
    await seedSourceEvent(isoDb, { id: "d-neg-zoom", sourceSystem: "zoom", dedupeKey: "front:recovery:cnv_z:", lastMessageId: "msg_z" });
    await seedSourceEvent(isoDb, { id: "d-neg-prefix", sourceSystem: "front", dedupeKey: "other:cnv_x:", lastMessageId: "msg_x" });

    const out = await getAction(ACTION).apply(null);
    assert.equal(out.state, "applied", `${ACTION}: expected applied, got ${JSON.stringify(out)}`);
    const state = await awaitDrain(ACTION);
    // processed = rewritten(2) + deletedConflict(1) = 3.
    assertDrainTally(state, await auditRow(isoDb, ACTION), ACTION, 3);
    assert.deepEqual(
      state.perKey,
      { rewritten: 2, deletedConflict: 1 },
      `${ACTION}: unexpected perKey tally ${JSON.stringify(state.perKey)}`,
    );

    assert.equal(await dedupeKeyOf(isoDb, "d-rewrite-1"), "front:recovery:cnv_1:msg_1");
    assert.equal(await dedupeKeyOf(isoDb, "d-rewrite-2"), "front:reconcile:cnv_2:msg_2");
    assert.equal(await dedupeKeyOf(isoDb, "d-collide-legacy"), null, "collided legacy row should be DELETEd");
    assert.equal(await dedupeKeyOf(isoDb, "d-collide-target"), "front:backfill:cnv_3:msg_3", "pre-existing target row must survive");
    assert.equal(await dedupeKeyOf(isoDb, "d-neg-versioned"), "front:recovery:cnv_9:msg_9");
    assert.equal(await dedupeKeyOf(isoDb, "d-neg-zoom"), "front:recovery:cnv_z:");
    assert.equal(await dedupeKeyOf(isoDb, "d-neg-prefix"), "other:cnv_x:");
    ok(`${ACTION}: 2 rewritten + 1 collision-deleted, 3 negatives + target untouched, audit tally correct`);
  }, { tables: TABLES });
}

// ─── Consumer 4: replay_front_webhook_apply_dead_letter ──────────────
async function testReplayDeadLetter(): Promise<void> {
  const ACTION = "replay_front_webhook_apply_dead_letter";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Matching: dead_letter rows on the front_webhook_apply queue.
    await seedWorkQueue(isoDb, { id: "rd-match-1", queueName: "front_webhook_apply", workloadClass: "front_ingestion", status: "dead_letter", attemptCount: 3 });
    await seedWorkQueue(isoDb, { id: "rd-match-2", queueName: "front_webhook_apply", workloadClass: "front_ingestion", status: "dead_letter", attemptCount: 5 });
    // Negatives: wrong status / wrong queue.
    await seedWorkQueue(isoDb, { id: "rd-neg-failed", queueName: "front_webhook_apply", workloadClass: "front_ingestion", status: "failed", attemptCount: 2 });
    await seedWorkQueue(isoDb, { id: "rd-neg-queue", queueName: "front_webhook_normalize", workloadClass: "front_ingestion", status: "dead_letter", attemptCount: 4 });

    const out = await getAction(ACTION).apply(null);
    assert.equal(out.state, "applied", `${ACTION}: expected applied, got ${JSON.stringify(out)}`);
    const state = await awaitDrain(ACTION);
    assertDrainTally(state, await auditRow(isoDb, ACTION), ACTION, 2);

    // Replayed rows: dead_letter → pending with attempt_count reset to 0.
    assert.equal(await workQueueField(isoDb, "rd-match-1", "status"), "pending");
    assert.equal(await workQueueField(isoDb, "rd-match-1", "attempt_count"), "0");
    assert.equal(await workQueueField(isoDb, "rd-match-2", "status"), "pending");
    assert.equal(await workQueueField(isoDb, "rd-match-2", "attempt_count"), "0");
    // Negatives untouched.
    assert.equal(await workQueueField(isoDb, "rd-neg-failed", "status"), "failed");
    assert.equal(await workQueueField(isoDb, "rd-neg-failed", "attempt_count"), "2");
    assert.equal(await workQueueField(isoDb, "rd-neg-queue", "status"), "dead_letter");
    ok(`${ACTION}: replayed 2 dead_letter rows → pending (attempt_count reset), 2 negatives untouched, audit tally correct`);
  }, { tables: TABLES });
}

// ════════════════════════════════════════════════════════════════════
// Task #2032 — empty-backlog path: countPending() === 0 returns
// `nothing-to-do`, apply() reports `not-needed`, and NO prod_action_runs
// row is written. Each test seeds ONLY negative-control rows the filter
// must never match, so the COUNT is genuinely zero, and asserts those
// negatives are left untouched.
// ════════════════════════════════════════════════════════════════════

// ─── Empty Consumer 1: rewrite_pending_front_backlog_to_ingestion ────
async function testFrontBacklogReclassifyEmpty(): Promise<void> {
  const ACTION = "rewrite_pending_front_backlog_to_ingestion";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Negatives only — nothing the maintenance/pending filter can match.
    await seedWorkQueue(isoDb, { id: "re-neg-processing", queueName: "front_webhook_apply", workloadClass: "maintenance", status: "processing" });
    await seedWorkQueue(isoDb, { id: "re-neg-ingestion", queueName: "front_webhook_apply", workloadClass: "ingestion", status: "pending" });
    await seedWorkQueue(isoDb, { id: "re-neg-queue", queueName: "front_reconciliation", workloadClass: "maintenance", status: "pending" });

    const out = await getAction(ACTION).apply(null);
    await assertEmptyBacklogNoAudit(isoDb, out, ACTION);

    assert.equal(await workQueueField(isoDb, "re-neg-processing", "workload_class"), "maintenance");
    assert.equal(await workQueueField(isoDb, "re-neg-ingestion", "status"), "pending");
    assert.equal(await workQueueField(isoDb, "re-neg-queue", "workload_class"), "maintenance");
    ok(`${ACTION}: empty backlog → not-needed, no audit row, 3 negatives untouched`);
  }, { tables: TABLES });
}

// ─── Empty Consumer 2: front_warp_class_backfill ─────────────────────
async function testFrontWarpClassBackfillEmpty(): Promise<void> {
  const ACTION = "front_warp_class_backfill";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Negatives only — terminal status / already front_ingestion / wrong queue.
    await seedWorkQueue(isoDb, { id: "we-neg-completed", queueName: "front_webhook_apply", workloadClass: "ingestion", status: "completed" });
    await seedWorkQueue(isoDb, { id: "we-neg-already", queueName: "front_webhook_apply", workloadClass: "front_ingestion", status: "pending" });
    await seedWorkQueue(isoDb, { id: "we-neg-queue", queueName: "zoom_recording_match", workloadClass: "ingestion", status: "pending" });

    const out = await getAction(ACTION).apply(null);
    await assertEmptyBacklogNoAudit(isoDb, out, ACTION);

    assert.equal(await workQueueField(isoDb, "we-neg-completed", "workload_class"), "ingestion");
    assert.equal(await workQueueField(isoDb, "we-neg-already", "workload_class"), "front_ingestion");
    assert.equal(await workQueueField(isoDb, "we-neg-queue", "workload_class"), "ingestion");
    ok(`${ACTION}: empty backlog → not-needed, no audit row, 3 negatives untouched`);
  }, { tables: TABLES });
}

// ─── Empty Consumer 3: backfill_front_recovery_dedupe_keys ───────────
async function testBackfillDedupeKeysEmpty(): Promise<void> {
  const ACTION = "backfill_front_recovery_dedupe_keys";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Negatives only — already versioned / non-front / non-legacy prefix.
    await seedSourceEvent(isoDb, { id: "de-neg-versioned", sourceSystem: "front", dedupeKey: "front:recovery:cnv_9:msg_9", lastMessageId: "msg_9" });
    await seedSourceEvent(isoDb, { id: "de-neg-zoom", sourceSystem: "zoom", dedupeKey: "front:recovery:cnv_z:", lastMessageId: "msg_z" });
    await seedSourceEvent(isoDb, { id: "de-neg-prefix", sourceSystem: "front", dedupeKey: "other:cnv_x:", lastMessageId: "msg_x" });

    const out = await getAction(ACTION).apply(null);
    await assertEmptyBacklogNoAudit(isoDb, out, ACTION);

    assert.equal(await dedupeKeyOf(isoDb, "de-neg-versioned"), "front:recovery:cnv_9:msg_9");
    assert.equal(await dedupeKeyOf(isoDb, "de-neg-zoom"), "front:recovery:cnv_z:");
    assert.equal(await dedupeKeyOf(isoDb, "de-neg-prefix"), "other:cnv_x:");
    ok(`${ACTION}: empty backlog → not-needed, no audit row, 3 negatives untouched`);
  }, { tables: TABLES });
}

// ─── Empty Consumer 4: replay_front_webhook_apply_dead_letter ────────
async function testReplayDeadLetterEmpty(): Promise<void> {
  const ACTION = "replay_front_webhook_apply_dead_letter";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Negatives only — wrong status / wrong queue.
    await seedWorkQueue(isoDb, { id: "rde-neg-failed", queueName: "front_webhook_apply", workloadClass: "front_ingestion", status: "failed", attemptCount: 2 });
    await seedWorkQueue(isoDb, { id: "rde-neg-queue", queueName: "front_webhook_normalize", workloadClass: "front_ingestion", status: "dead_letter", attemptCount: 4 });

    const out = await getAction(ACTION).apply(null);
    await assertEmptyBacklogNoAudit(isoDb, out, ACTION);

    assert.equal(await workQueueField(isoDb, "rde-neg-failed", "status"), "failed");
    assert.equal(await workQueueField(isoDb, "rde-neg-failed", "attempt_count"), "2");
    assert.equal(await workQueueField(isoDb, "rde-neg-queue", "status"), "dead_letter");
    ok(`${ACTION}: empty backlog → not-needed, no audit row, 2 negatives untouched`);
  }, { tables: TABLES });
}

// ─── Task #2033: double-press while draining is a safe no-op ──────────
//
// The drain primitive is single-flight per actionId (in-memory Map). An
// operator re-pressing while a drain is in flight must get a safe no-op:
// the second press returns state 'applied' with an "already running"
// detail, it must NOT start a second concurrent drain, and the seeded
// backlog must be processed exactly once (no double-counting). We seed a
// backlog larger than one chunk (BATCH_SIZE = 5000) so the drain genuinely
// spans multiple chunks and is still in flight when the second press lands.
async function testDoublePressIsSafeNoop(): Promise<void> {
  const ACTION = "rewrite_pending_front_backlog_to_ingestion";
  const BACKLOG = 12_000; // > BATCH_SIZE(5000) → at least 3 chunks
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    // Bulk-seed a multi-chunk backlog of matching rows in one statement.
    await isoDb.execute(sql`
      INSERT INTO work_queue
        (id, queue_name, job_type, workload_class, status, attempt_count, payload, created_at, updated_at)
      SELECT
        'bulk-' || g,
        'front_webhook_apply',
        'front_webhook_apply',
        'maintenance',
        'pending',
        0,
        '{}'::jsonb,
        NOW(),
        NOW()
      FROM generate_series(1, ${BACKLOG}) AS g
    `);

    const action = getAction(ACTION);

    // Press once → starts the background drain. Then press again in quick
    // succession (sequential await mirrors an operator re-clicking the
    // button). The drain is fire-and-forget and spans multiple awaited DB
    // chunks, so it is still running (finishedAt === null) when the second
    // press performs its synchronous single-flight check.
    const out1 = await action.apply(null);
    assert.equal(out1.state, "applied", `${ACTION}: first press expected applied, got ${JSON.stringify(out1)}`);

    assert.equal(
      isDrainRunning(ACTION),
      true,
      `${ACTION}: drain must still be in flight when the second press lands`,
    );

    const out2 = await action.apply(null);
    assert.equal(out2.state, "applied", `${ACTION}: second press expected applied (safe no-op), got ${JSON.stringify(out2)}`);
    assert.match(
      out2.detail,
      /already running/i,
      `${ACTION}: second press detail must say the drain is already running, got "${out2.detail}"`,
    );

    // Let the single in-flight drain finish.
    const state = await awaitDrain(ACTION);

    // No double-processing: exactly the seeded backlog, across >1 chunk.
    assert.equal(state.error, null, `${ACTION}: drain errored — ${state.error}`);
    assert.equal(
      state.processed,
      BACKLOG,
      `${ACTION}: expected exactly ${BACKLOG} processed (no double counting), got ${state.processed}`,
    );
    assert.equal(
      state.totalAtStart,
      BACKLOG,
      `${ACTION}: countPending (${state.totalAtStart}) must match the seeded backlog (${BACKLOG})`,
    );
    assert(
      state.chunks >= 2,
      `${ACTION}: backlog must span multiple chunks, got ${state.chunks} chunk(s)`,
    );

    // Exactly ONE audit row — the second press did not start a second drain.
    const audit = await auditRow(isoDb, ACTION);
    assert(audit, `${ACTION}: no prod_action_runs audit row was written`);
    assert.equal(audit.outcome_state, "applied", `${ACTION}: expected audit outcome_state 'applied', got '${audit.outcome_state}'`);
    assert.equal(
      audit.rows_affected,
      BACKLOG,
      `${ACTION}: audit rows_affected (${audit.rows_affected}) must equal the seeded backlog (${BACKLOG})`,
    );

    // Every matching row reclassified exactly once.
    const remaining: any = await isoDb.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM work_queue
      WHERE workload_class = 'maintenance' AND status = 'pending'
    `);
    const remRows = Array.isArray(remaining) ? remaining : remaining?.rows ?? [];
    assert.equal(Number(remRows[0]?.n ?? -1), 0, `${ACTION}: no maintenance rows should remain after the drain`);

    ok(`${ACTION}: double-press is a safe no-op — one drain, ${BACKLOG} rows processed once across ${state.chunks} chunks, single audit row`);
  }, { tables: TABLES });
}

// ─── Task #2056: two SIMULTANEOUS presses both starting a drain ───────
//
// Task #2033 (above) covers a *sequential* double-press: the operator
// clicks, awaits the response, then clicks again. The single-flight check
// in `startBackgroundDrain` used to read the `drains` Map, then `await
// spec.countPending()`, and only afterwards `drains.set(...)`. Two
// genuinely concurrent presses (`Promise.all([apply(), apply()])`) could
// therefore BOTH pass the `existing?.finishedAt === null` check during the
// `countPending` await — before either wrote to the Map — and both start a
// drain, double-processing rows and writing two `prod_action_runs` rows.
//
// The fix reserves the Map slot synchronously (no await between the read
// and the set), so the loser observes the winner's running placeholder and
// returns the safe `already running` no-op. This test fires both presses
// with `Promise.all` against a multi-chunk backlog and asserts exactly one
// press starts the drain, the other is the no-op, the backlog is processed
// exactly once, and exactly one audit row is written.
async function testConcurrentDoublePressGuard(): Promise<void> {
  const ACTION = "rewrite_pending_front_backlog_to_ingestion";
  const BACKLOG = 12_000; // > BATCH_SIZE(5000) → multi-chunk drain
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    await isoDb.execute(sql`
      INSERT INTO work_queue
        (id, queue_name, job_type, workload_class, status, attempt_count, payload, created_at, updated_at)
      SELECT
        'conc-' || g,
        'front_webhook_apply',
        'front_webhook_apply',
        'maintenance',
        'pending',
        0,
        '{}'::jsonb,
        NOW(),
        NOW()
      FROM generate_series(1, ${BACKLOG}) AS g
    `);

    const action = getAction(ACTION);

    // Fire two genuinely concurrent presses. Both enter startBackgroundDrain
    // and read the same (empty) drains Map; the synchronous slot reservation
    // is what makes exactly one of them win.
    const [out1, out2] = await Promise.all([action.apply(null), action.apply(null)]);

    assert.equal(out1.state, "applied", `${ACTION}: press 1 expected applied, got ${JSON.stringify(out1)}`);
    assert.equal(out2.state, "applied", `${ACTION}: press 2 expected applied, got ${JSON.stringify(out2)}`);

    const details = [out1.detail ?? "", out2.detail ?? ""];
    const startedCount = details.filter((d) => /Background drain started/i.test(d)).length;
    const alreadyCount = details.filter((d) => /already running/i.test(d)).length;
    assert.equal(
      startedCount,
      1,
      `${ACTION}: exactly ONE concurrent press may start the drain, got ${startedCount} (details: ${JSON.stringify(details)})`,
    );
    assert.equal(
      alreadyCount,
      1,
      `${ACTION}: exactly ONE concurrent press must be the already-running no-op, got ${alreadyCount} (details: ${JSON.stringify(details)})`,
    );

    const state = await awaitDrain(ACTION);

    // No double-processing: exactly the seeded backlog, across >1 chunk.
    assert.equal(state.error, null, `${ACTION}: drain errored — ${state.error}`);
    assert.equal(
      state.processed,
      BACKLOG,
      `${ACTION}: expected exactly ${BACKLOG} processed (no double counting), got ${state.processed}`,
    );
    assert.equal(
      state.totalAtStart,
      BACKLOG,
      `${ACTION}: countPending (${state.totalAtStart}) must match the seeded backlog (${BACKLOG})`,
    );
    assert(
      state.chunks >= 2,
      `${ACTION}: backlog must span multiple chunks, got ${state.chunks} chunk(s)`,
    );

    // Exactly ONE audit row — the loser did not start a second drain. The
    // explicit COUNT catches a racing second drain that writes its row late.
    const audit = await auditRow(isoDb, ACTION);
    assert(audit, `${ACTION}: no prod_action_runs audit row was written`);
    assert.equal(audit.outcome_state, "applied", `${ACTION}: expected audit outcome_state 'applied', got '${audit.outcome_state}'`);
    assert.equal(
      audit.rows_affected,
      BACKLOG,
      `${ACTION}: audit rows_affected (${audit.rows_affected}) must equal the seeded backlog (${BACKLOG})`,
    );
    const auditCountRes: any = await isoDb.execute(sql`
      SELECT COUNT(*)::int AS n FROM prod_action_runs WHERE action_id = ${ACTION}
    `);
    const auditCountRows = Array.isArray(auditCountRes) ? auditCountRes : auditCountRes?.rows ?? [];
    assert.equal(
      Number(auditCountRows[0]?.n ?? -1),
      1,
      `${ACTION}: exactly one prod_action_runs row must exist, got ${JSON.stringify(auditCountRows[0])}`,
    );

    // Every matching row reclassified exactly once.
    const remaining: any = await isoDb.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM work_queue
      WHERE workload_class = 'maintenance' AND status = 'pending'
    `);
    const remRows = Array.isArray(remaining) ? remaining : remaining?.rows ?? [];
    assert.equal(Number(remRows[0]?.n ?? -1), 0, `${ACTION}: no maintenance rows should remain after the drain`);

    ok(`${ACTION}: concurrent double-press → one drain, ${BACKLOG} rows processed once across ${state.chunks} chunks, single audit row`);
  }, { tables: TABLES });
}

// ─── Task #2049: drain ran but found nothing (not-needed + 0 rows) ───
//
// The shared primitive has a SECOND, distinct empty outcome from the
// early `nothing-to-do` return (Task #2032): when a drain actually starts
// (countPending() > 0) but the FIRST runChunk() returns processed=0 —
// e.g. because rows were claimed/changed by another process between the
// count and the chunk — `finalizeAudit` writes a `prod_action_runs` row
// with outcome_state='not-needed' and rows_affected=0. The four real
// consumers can't reach this path (their count and chunk share the same
// filter, so count>0 implies chunk>0), so this needs a SYNTHETIC DrainSpec
// driven straight into `startBackgroundDrain`.
async function testDrainRanButFoundNothing(): Promise<void> {
  const ACTION = "synthetic_drain_count_then_empty_chunk";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    let countCalls = 0;
    let chunkCalls = 0;
    const out = await startBackgroundDrain(
      {
        actionId: ACTION,
        actionTitle: "Synthetic count>0 then empty chunk",
        attributionLabel: "maintenance:synthetic-drain-empty-chunk",
        // count>0 so the early nothing-to-do return does NOT fire and a
        // real drain is launched.
        countPending: async () => {
          countCalls += 1;
          return 5;
        },
        // First (and only) chunk reports nothing processed — mimics rows
        // having been claimed/changed between count and chunk. processed=0
        // ends the drain immediately.
        runChunk: async () => {
          chunkCalls += 1;
          return { processed: 0 };
        },
        unit: "row(s)",
      },
      null,
    );

    // The press itself must report `started` (count>0), NOT nothing-to-do.
    assert.equal(
      out.state,
      "started",
      `${ACTION}: count>0 must launch a drain (state 'started'), got ${JSON.stringify(out)}`,
    );
    assert.equal(out.totalAtStart, 5, `${ACTION}: totalAtStart must reflect countPending()`);

    const state = await awaitDrain(ACTION);
    assert.equal(state.error, null, `${ACTION}: drain must finish cleanly — ${state.error}`);
    assert.equal(state.processed, 0, `${ACTION}: empty first chunk must leave processed=0, got ${state.processed}`);
    assert.equal(state.chunks, 0, `${ACTION}: a processed=0 chunk does not count as a chunk, got ${state.chunks}`);
    assert.equal(state.totalAtStart, 5, `${ACTION}: totalAtStart must be the >0 count, got ${state.totalAtStart}`);
    assert.equal(countCalls, 1, `${ACTION}: countPending must be called exactly once, got ${countCalls}`);
    assert.equal(chunkCalls, 1, `${ACTION}: runChunk must be called exactly once before the empty-chunk break, got ${chunkCalls}`);

    // The distinguishing assertion: this path DOES write a single audit
    // row — outcome_state='not-needed', rows_affected=0 — unlike the early
    // nothing-to-do path (Task #2032) which writes none.
    const audit = await auditRow(isoDb, ACTION);
    assert(audit, `${ACTION}: drain-ran-but-found-nothing must write a prod_action_runs row`);
    assert.equal(
      audit.outcome_state,
      "not-needed",
      `${ACTION}: expected audit outcome_state 'not-needed', got '${audit.outcome_state}'`,
    );
    assert.equal(
      audit.rows_affected,
      0,
      `${ACTION}: expected audit rows_affected 0, got ${audit.rows_affected}`,
    );

    ok(`${ACTION}: count>0 + empty first chunk → single 'not-needed' audit row with rows_affected=0`);
  }, { tables: TABLES });
}

// ─── Task #2049 (#2292): a chunk throws mid-drain (error outcome) ─────
//
// The FOURTH distinct audit outcome of the shared primitive: when a
// `runChunk()` throws after some rows have already been processed,
// `runDrainLoop` captures the message into `state.error`, breaks the
// loop, and `finalizeAudit` writes a SINGLE `prod_action_runs` row with
// outcome_state='error', rows_affected equal to whatever was processed
// before the throw, and the captured message in error_message. The four
// real consumers can't deterministically reach this path, so this needs
// a SYNTHETIC DrainSpec whose runChunk processes a few rows across one or
// more chunks and then throws. This pins the CEO History "why did the
// press fail" row so a future refactor can't silently stop writing it.
async function testDrainChunkThrowsRecordsError(): Promise<void> {
  const ACTION = "synthetic_drain_chunk_throws_mid_drain";
  const PROCESSED_PER_CHUNK = 3;
  const CHUNKS_BEFORE_THROW = 2; // → 6 rows processed, then a throw
  const THROW_MESSAGE = "synthetic chunk failure: downstream write blew up";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    let countCalls = 0;
    let chunkCalls = 0;
    const out = await startBackgroundDrain(
      {
        actionId: ACTION,
        actionTitle: "Synthetic chunk throws mid-drain",
        attributionLabel: "maintenance:synthetic-drain-chunk-throws",
        // count>0 so a real drain is launched (not the early nothing-to-do).
        countPending: async () => {
          countCalls += 1;
          return 100;
        },
        // Process a few rows across the first CHUNKS_BEFORE_THROW chunks,
        // then throw on the next chunk to mimic a mid-drain failure.
        runChunk: async () => {
          chunkCalls += 1;
          if (chunkCalls > CHUNKS_BEFORE_THROW) {
            throw new Error(THROW_MESSAGE);
          }
          return { processed: PROCESSED_PER_CHUNK };
        },
        unit: "row(s)",
      },
      null,
    );

    assert.equal(
      out.state,
      "started",
      `${ACTION}: count>0 must launch a drain (state 'started'), got ${JSON.stringify(out)}`,
    );

    const state = await awaitDrain(ACTION);
    const expectedProcessed = PROCESSED_PER_CHUNK * CHUNKS_BEFORE_THROW; // 6

    // The drain recorded the throw, processed only the pre-throw rows, and
    // counted only the chunks that succeeded (the throwing chunk does not).
    assert.equal(
      state.error,
      THROW_MESSAGE,
      `${ACTION}: state.error must hold the thrown message, got ${JSON.stringify(state.error)}`,
    );
    assert.equal(
      state.processed,
      expectedProcessed,
      `${ACTION}: only pre-throw rows count — expected ${expectedProcessed}, got ${state.processed}`,
    );
    assert.equal(
      state.chunks,
      CHUNKS_BEFORE_THROW,
      `${ACTION}: only successful chunks count — expected ${CHUNKS_BEFORE_THROW}, got ${state.chunks}`,
    );
    assert.equal(
      chunkCalls,
      CHUNKS_BEFORE_THROW + 1,
      `${ACTION}: runChunk must be called once more (the throwing call), got ${chunkCalls}`,
    );
    assert.equal(countCalls, 1, `${ACTION}: countPending must be called exactly once, got ${countCalls}`);

    // The distinguishing assertion: exactly ONE audit row with
    // outcome_state='error', rows_affected = rows processed before the
    // throw, and a non-null error_message recording the failure. Without
    // this row the CEO History panel could not show WHY the press failed.
    const audit = await auditRow(isoDb, ACTION);
    assert(audit, `${ACTION}: a thrown chunk must still write a prod_action_runs row`);
    assert.equal(
      audit.outcome_state,
      "error",
      `${ACTION}: expected audit outcome_state 'error', got '${audit.outcome_state}'`,
    );
    assert.equal(
      audit.rows_affected,
      expectedProcessed,
      `${ACTION}: audit rows_affected (${audit.rows_affected}) must equal rows processed before the throw (${expectedProcessed})`,
    );
    assert(
      audit.error_message !== null && audit.error_message.length > 0,
      `${ACTION}: error audit row must record a non-null error_message, got ${JSON.stringify(audit.error_message)}`,
    );
    assert.match(
      audit.error_message ?? "",
      /synthetic chunk failure/i,
      `${ACTION}: error_message must record the thrown failure, got ${JSON.stringify(audit.error_message)}`,
    );

    // Defensive: exactly one row — the error path must not also write an
    // 'applied' or 'not-needed' row.
    const countRes: any = await isoDb.execute(sql`
      SELECT COUNT(*)::int AS n FROM prod_action_runs WHERE action_id = ${ACTION}
    `);
    const countRows = Array.isArray(countRes) ? countRes : countRes?.rows ?? [];
    assert.equal(
      Number(countRows[0]?.n ?? -1),
      1,
      `${ACTION}: exactly one prod_action_runs row must exist, got ${JSON.stringify(countRows[0])}`,
    );

    ok(`${ACTION}: mid-drain throw → single 'error' audit row, rows_affected=${expectedProcessed}, error_message recorded`);
  }, { tables: TABLES });
}

// ─── Task #2359: countPending() itself throws (pre-launch count failure) ─
//
// The shared primitive has a FIFTH distinct code path that the four post-
// launch outcomes (applied / early not-needed / drain-ran-nothing / error)
// don't cover: when `countPending()` itself THROWS — a DB blip while sizing
// the backlog — `startBackgroundDrain` deletes the reserved single-flight
// slot and re-raises the error WITHOUT launching a drain or writing any
// `prod_action_runs` row. This must leave NO stale drain reservation behind
// (otherwise a later press would be blocked by a phantom "already running")
// and NO misleading audit row. The four real consumers can't deterministically
// reach this path, so this needs a SYNTHETIC DrainSpec whose countPending
// rejects, driven straight into `startBackgroundDrain`.
async function testCountPendingThrowsNoDrainNoAudit(): Promise<void> {
  const ACTION = "synthetic_drain_count_pending_throws";
  const THROW_MESSAGE = "synthetic count failure: DB blip while sizing backlog";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    let countCalls = 0;
    let chunkCalls = 0;

    // The press must REJECT with the same error countPending threw — the
    // primitive re-raises it to the caller after releasing the reservation.
    await assert.rejects(
      () =>
        startBackgroundDrain(
          {
            actionId: ACTION,
            actionTitle: "Synthetic countPending throws",
            attributionLabel: "maintenance:synthetic-count-pending-throws",
            countPending: async () => {
              countCalls += 1;
              throw new Error(THROW_MESSAGE);
            },
            // Must never run — the drain is never launched.
            runChunk: async () => {
              chunkCalls += 1;
              return { processed: 0 };
            },
            unit: "row(s)",
          },
          null,
        ),
      (err: any) => {
        assert.match(
          String(err?.message ?? err),
          /synthetic count failure/i,
          `${ACTION}: rejection must carry the thrown countPending message, got ${JSON.stringify(err?.message ?? err)}`,
        );
        return true;
      },
      `${ACTION}: startBackgroundDrain must reject when countPending throws`,
    );

    assert.equal(countCalls, 1, `${ACTION}: countPending must be called exactly once, got ${countCalls}`);
    assert.equal(chunkCalls, 0, `${ACTION}: runChunk must never run when the count fails, got ${chunkCalls}`);

    // The single-flight reservation must be released so a later press can
    // start fresh — a leaked reservation would block every later press with
    // a phantom "already running".
    assert.equal(
      getDrainState(ACTION),
      undefined,
      `${ACTION}: count-failure must release the reservation (getDrainState stays undefined)`,
    );
    assert.equal(
      isDrainRunning(ACTION),
      false,
      `${ACTION}: no drain may be left running after a count failure`,
    );

    // No misleading audit row may be written for a press that never launched.
    const audit = await auditRow(isoDb, ACTION);
    assert.equal(
      audit,
      null,
      `${ACTION}: count-failure must NOT write a prod_action_runs row (got ${JSON.stringify(audit)})`,
    );

    ok(`${ACTION}: countPending throw → rejects, reservation released, no audit row`);
  }, { tables: TABLES });
}

// ─── Task #2374: cross-instance lock acquisition itself throws ────────
//
// Sibling of Task #2359 (countPending throws). There is a SECOND pre-launch
// failure path: after a successful count>0, `startBackgroundDrain` calls
// `acquireCrossInstanceDrainLock(...)` to take the cluster-wide advisory
// lock BEFORE launching the loop. That call is wrapped in a try/catch that,
// if the `pg_try_advisory_lock` query itself THROWS (a DB blip), deletes the
// reserved single-flight slot and re-raises WITHOUT launching a drain or
// writing any `prod_action_runs` row. This must leave NO stale reservation
// behind (otherwise every later press is blocked by a phantom "already
// running") and NO misleading audit row. The four real consumers can't
// deterministically reach this path, so this drives a SYNTHETIC DrainSpec
// (count>0 so the early nothing-to-do return does NOT fire) and forces the
// lock acquisition to throw via the `__setDrainLockAcquireOverrideForTest`
// seam.
async function testLockAcquireThrowsNoDrainNoAudit(): Promise<void> {
  const ACTION = "synthetic_drain_lock_acquire_throws";
  const THROW_MESSAGE = "synthetic lock failure: DB blip during pg_try_advisory_lock";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    let countCalls = 0;
    let chunkCalls = 0;
    let lockCalls = 0;

    // Force the cross-instance lock acquisition to throw, mimicking the
    // advisory-lock query failing on a DB blip.
    __setDrainLockAcquireOverrideForTest(async () => {
      lockCalls += 1;
      throw new Error(THROW_MESSAGE);
    });

    try {
      // The press must REJECT with the same error the lock acquire threw —
      // the primitive re-raises it after releasing the reservation.
      await assert.rejects(
        () =>
          startBackgroundDrain(
            {
              actionId: ACTION,
              actionTitle: "Synthetic lock acquire throws",
              attributionLabel: "maintenance:synthetic-lock-acquire-throws",
              // count>0 so the early nothing-to-do return does NOT fire and
              // the code reaches the lock-acquire step.
              countPending: async () => {
                countCalls += 1;
                return 5;
              },
              // Must never run — the drain is never launched.
              runChunk: async () => {
                chunkCalls += 1;
                return { processed: 0 };
              },
              unit: "row(s)",
            },
            null,
          ),
        (err: any) => {
          assert.match(
            String(err?.message ?? err),
            /synthetic lock failure/i,
            `${ACTION}: rejection must carry the thrown lock message, got ${JSON.stringify(err?.message ?? err)}`,
          );
          return true;
        },
        `${ACTION}: startBackgroundDrain must reject when the lock acquire throws`,
      );
    } finally {
      // Always restore real behavior so the override never leaks to later
      // tests in the serial runner.
      __setDrainLockAcquireOverrideForTest(null);
    }

    assert.equal(countCalls, 1, `${ACTION}: countPending must be called exactly once, got ${countCalls}`);
    assert.equal(lockCalls, 1, `${ACTION}: lock acquire must be reached exactly once, got ${lockCalls}`);
    assert.equal(chunkCalls, 0, `${ACTION}: runChunk must never run when the lock acquire fails, got ${chunkCalls}`);

    // The single-flight reservation must be released so a later press can
    // start fresh — a leaked reservation would block every later press with
    // a phantom "already running".
    assert.equal(
      getDrainState(ACTION),
      undefined,
      `${ACTION}: lock-acquire failure must release the reservation (getDrainState stays undefined)`,
    );
    assert.equal(
      isDrainRunning(ACTION),
      false,
      `${ACTION}: no drain may be left running after a lock-acquire failure`,
    );

    // No misleading audit row may be written for a press that never launched.
    const audit = await auditRow(isoDb, ACTION);
    assert.equal(
      audit,
      null,
      `${ACTION}: lock-acquire failure must NOT write a prod_action_runs row (got ${JSON.stringify(audit)})`,
    );

    ok(`${ACTION}: lock-acquire throw → rejects, reservation released, no drain, no audit row`);
  }, { tables: TABLES });
}

// ─── Task #2293: cross-instance single-flight (advisory lock) ─────────
//
// The in-memory `drains` Map only collapses concurrent presses on ONE
// process. The deploy target is `autoscale` (multiple instances), so two
// presses routed to two different instances each pass their own (empty)
// in-memory check and would both start a drain — double-processing rows
// and writing two `prod_action_runs` rows. The fix is a Postgres
// session-level advisory lock keyed by actionId, held on a dedicated
// worker-pool connection for the whole drain.
//
// To simulate two instances inside a single test process we hold ONLY the
// DB advisory lock for "instance A" (via __acquireDrainLockForTest, which
// does NOT touch the in-memory Map) — modelling instance A's drain
// running in a *different* process whose in-memory state is invisible
// here. "Instance B" is a real startBackgroundDrain call whose in-memory
// Map is empty, so it clears the same-instance check and must then lose on
// the shared advisory lock. We assert B starts no drain, runs no chunk,
// and writes no audit row; then release A's lock (proving release is
// self-healing) and confirm a fresh press wins and writes exactly one
// audit row.
async function testCrossInstanceLockGuard(): Promise<void> {
  const ACTION = "synthetic_cross_instance_drain_lock";
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    const makeSpec = (onChunk: () => number): DrainSpec => ({
      actionId: ACTION,
      actionTitle: "Synthetic cross-instance drain lock",
      attributionLabel: "maintenance:synthetic-cross-instance-lock",
      countPending: async () => 3,
      runChunk: async () => ({ processed: onChunk() }),
      unit: "row(s)",
    });

    // Instance A: hold the cross-instance lock only (no in-memory state).
    const instanceALock = await __acquireDrainLockForTest(ACTION);
    assert(instanceALock, `${ACTION}: setup — instance A should win the advisory lock`);

    // Instance B presses concurrently. Empty in-memory Map → passes the
    // same-instance check, then the shared advisory lock must block it.
    let bChunkCalls = 0;
    const outB = await startBackgroundDrain(
      makeSpec(() => {
        bChunkCalls += 1;
        return 3;
      }),
      null,
    );

    assert.equal(
      outB.state,
      "already-running",
      `${ACTION}: instance B must be the cross-instance no-op, got ${JSON.stringify(outB)}`,
    );
    assert.match(
      outB.detail,
      /already running/i,
      `${ACTION}: instance B detail must say already running, got "${outB.detail}"`,
    );
    assert.equal(
      bChunkCalls,
      0,
      `${ACTION}: instance B must NOT process any chunk, got ${bChunkCalls}`,
    );
    assert.equal(
      getDrainState(ACTION),
      undefined,
      `${ACTION}: instance B must start no drain (in-memory reservation released)`,
    );
    assert.equal(
      await auditRow(isoDb, ACTION),
      null,
      `${ACTION}: instance B must write no prod_action_runs row`,
    );

    // Instance A finishes and releases the lock — proves the release path
    // frees the cluster-wide lock so a later press can take over.
    await instanceALock!.release();
    __resetDrainsForTest();

    let cChunkCalls = 0;
    const outC = await startBackgroundDrain(
      makeSpec(() => {
        cChunkCalls += 1;
        // First chunk drains all 3; second reports 0 to end the drain.
        return cChunkCalls === 1 ? 3 : 0;
      }),
      null,
    );
    assert.equal(
      outC.state,
      "started",
      `${ACTION}: after release a fresh press must win and start, got ${JSON.stringify(outC)}`,
    );

    const state = await awaitDrain(ACTION);
    assert.equal(state.error, null, `${ACTION}: post-release drain errored — ${state.error}`);
    assert.equal(
      state.processed,
      3,
      `${ACTION}: post-release drain must process exactly 3, got ${state.processed}`,
    );

    // Exactly ONE audit row across the whole scenario — instance B wrote
    // none, only the single winning drain did.
    const auditCountRes: any = await isoDb.execute(sql`
      SELECT COUNT(*)::int AS n FROM prod_action_runs WHERE action_id = ${ACTION}
    `);
    const auditCountRows = Array.isArray(auditCountRes) ? auditCountRes : auditCountRes?.rows ?? [];
    assert.equal(
      Number(auditCountRows[0]?.n ?? -1),
      1,
      `${ACTION}: exactly one prod_action_runs row must exist, got ${JSON.stringify(auditCountRows[0])}`,
    );

    ok(`${ACTION}: cross-instance lock blocks a second instance — one drain, 3 rows once, single audit row`);
  }, { tables: TABLES });
}

async function main(): Promise<void> {
  await testFrontBacklogReclassify();
  await testFrontWarpClassBackfill();
  await testBackfillDedupeKeys();
  await testReplayDeadLetter();
  // Task #2032 — empty-backlog (nothing-to-do) path for each consumer.
  await testFrontBacklogReclassifyEmpty();
  await testFrontWarpClassBackfillEmpty();
  await testBackfillDedupeKeysEmpty();
  await testReplayDeadLetterEmpty();
  await testDoublePressIsSafeNoop();
  await testConcurrentDoublePressGuard();
  // Task #2049 — drain starts (count>0) but the first chunk processes
  // nothing → a single 'not-needed' / rows_affected=0 audit row.
  await testDrainRanButFoundNothing();
  // Task #2292 — a chunk throws mid-drain → a single 'error' audit row
  // with rows_affected = rows processed before the throw + error_message.
  await testDrainChunkThrowsRecordsError();
  // Task #2293 — cross-instance advisory lock blocks a second instance.
  await testCrossInstanceLockGuard();
  // Task #2359 — countPending() itself throws → rejects, releases the
  // single-flight reservation, and writes no prod_action_runs row.
  await testCountPendingThrowsNoDrainNoAudit();
  // Task #2374 — the cross-instance lock acquisition itself throws → rejects,
  // releases the single-flight reservation, launches no drain, and writes no
  // prod_action_runs row.
  await testLockAcquireThrowsNoDrainNoAudit();
  console.log(`\nprod-actions-background-drain-consumers: ${passed} assertions passed`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("prod-actions-background-drain-consumers: all four consumers verified");
  },
  (err) => {
    console.error("prod-actions-background-drain-consumers: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
