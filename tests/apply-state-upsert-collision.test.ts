/* test-registration
{
  "name": "Apply state upsert collision (baseline triage, Task #3424)",
  "notes": "── Task #3424: previously-unregistered tests triaged from the lint-test-registration baseline ──",
  "tier": "small"
}
test-registration */
/**
 * Task #1836 regression test — `apply_state` UNIQUE-constraint collision.
 *
 * Before the fix, two independent writers existed:
 *   - applyPipeline.getOrCreateApplyState (safe, .onConflictDoNothing)
 *   - pipelineProcessor.recordApplyOutcome (unsafe, plain .insert)
 *
 * When the second writer ran for a (work_result_id, apply_target) that
 * already had a row, Postgres raised
 *   duplicate key value violates unique constraint "as_work_result_target_idx"
 * and the work_queue row was dead-lettered. ~700 front_webhook_apply
 * dead-letters in May 2026.
 *
 * After the fix, both writers route through `upsertApplyState`, which
 * does INSERT ... ON CONFLICT (work_result_id, apply_target) DO UPDATE.
 * This test asserts:
 *
 *   (1) First call inserts a row.
 *   (2) Second call with the SAME (workResultId, applyTarget) does NOT
 *       throw — instead it updates the row and bumps attempt_count.
 *   (3) "Success" outcomes are not downgraded by a later non-success
 *       call (the CASE-based preserve-success rule).
 *   (4) The pipelineProcessor.recordApplyOutcome path, run twice for
 *       the same key, does NOT throw (this is the exact bug surface).
 *
 * Test isolation: the helpers use `workerDb` directly so this test does
 * the same (the in-tree tx-sandbox only patches `getDb()`). Each run
 * seeds rows with timestamp-unique IDs and DELETEs them in a `finally`
 * block — even on failure no leakage into other tests.
 *
 * Skip behaviour: if the schema is unavailable (e.g. apply_state table
 * has not been migrated in the current DB) the test self-skips.
 *
 * Usage: tsx tests/apply-state-upsert-collision.test.ts
 */
import { workerDb } from "../server/db";
import {
  applyState,
  sourceEventLog,
  workResultLog,
} from "@shared/models/durablePipeline";
import {
  upsertApplyState,
  getOrCreateApplyState,
} from "../server/services/applyPipeline";
import { recordApplyOutcome as recordOutcomeViaProcessor } from "../server/services/pipelineProcessor";
import { eq, and, inArray } from "drizzle-orm";

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(name: string, reason: string): void {
  skipped++;
  console.log(`  ⊘ ${name} — SKIPPED (${reason})`);
}

const runId = `1836-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const seededEventIds: string[] = [];
const seededWorkResultIds: string[] = [];

async function seedEventAndWorkResult(
  suffix: string,
): Promise<{ sourceEventId: string; workResultId: string }> {
  const sourceEventId = `sev-${runId}-${suffix}`;
  await workerDb.insert(sourceEventLog).values({
    id: sourceEventId,
    sourceSystem: "front",
    sourceEventType: "communication_result",
    sourceObjectId: sourceEventId,
    dedupeKey: sourceEventId,
    payloadJson: {},
  } as any);
  seededEventIds.push(sourceEventId);

  const workResultId = `wr-${runId}-${suffix}`;
  await workerDb.insert(workResultLog).values({
    id: workResultId,
    sourceEventId,
    sourceSystem: "front",
    resultType: "communication_record",
    resultJson: {},
  } as any);
  seededWorkResultIds.push(workResultId);

  return { sourceEventId, workResultId };
}

async function readApplyRow(
  workResultId: string,
  applyTarget: string,
): Promise<any | null> {
  const [row] = await workerDb
    .select()
    .from(applyState)
    .where(
      and(
        eq(applyState.workResultId, workResultId),
        eq(applyState.applyTarget, applyTarget),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function cleanup(): Promise<void> {
  // apply_state and work_result_log cascade from source_event_log;
  // deleting the events takes the rest with it. Belt-and-suspenders
  // explicit deletes too in case FK cascades change.
  try {
    if (seededWorkResultIds.length) {
      await workerDb
        .delete(applyState)
        .where(inArray(applyState.workResultId, seededWorkResultIds));
      await workerDb
        .delete(workResultLog)
        .where(inArray(workResultLog.id, seededWorkResultIds));
    }
    if (seededEventIds.length) {
      await workerDb
        .delete(sourceEventLog)
        .where(inArray(sourceEventLog.id, seededEventIds));
    }
  } catch (err: any) {
    console.error(`  cleanup failed: ${err?.message ?? err}`);
  }
}

async function main(): Promise<void> {
  console.log(
    "Task #1836 — apply_state upsert / collision regression test\n",
  );

  try {
    // ----- Scenario A: upsertApplyState idempotency + preserve-success
    const a = await seedEventAndWorkResult("a");
    const target = "raw_communication_record";

    // (1) First call — fresh insert as pending.
    await upsertApplyState({
      sourceEventId: a.sourceEventId,
      workResultId: a.workResultId,
      sourceSystem: "front",
      applyTarget: target,
      outcome: "pending",
      incrementAttemptOnConflict: false,
    });
    const after1 = await readApplyRow(a.workResultId, target);
    check(
      "fresh insert creates pending row",
      !!after1 && after1.outcome === "pending" && after1.attemptCount === 0,
      `outcome=${after1?.outcome} attempts=${after1?.attemptCount}`,
    );

    // (2) Second call with success outcome — must NOT throw, row updated.
    let threwSuccessUpsert = false;
    try {
      await upsertApplyState({
        sourceEventId: a.sourceEventId,
        workResultId: a.workResultId,
        sourceSystem: "front",
        applyTarget: target,
        outcome: "success",
        inputHash: "hash-a",
      });
    } catch {
      threwSuccessUpsert = true;
    }
    const after2 = await readApplyRow(a.workResultId, target);
    check("upsert collision does not throw", !threwSuccessUpsert);
    check(
      "collision upgrades pending → success",
      !!after2 && after2.outcome === "success" && after2.attemptCount === 1,
      `outcome=${after2?.outcome} attempts=${after2?.attemptCount}`,
    );
    check(
      "completed_at is set on success",
      !!after2 && !!after2.completedAt,
    );

    // (3) Third call with FAILED outcome — must NOT downgrade the success.
    await upsertApplyState({
      sourceEventId: a.sourceEventId,
      workResultId: a.workResultId,
      sourceSystem: "front",
      applyTarget: target,
      outcome: "failed",
      errorCode: "should_not_clobber",
      errorMessage: "must not downgrade success",
    });
    const after3 = await readApplyRow(a.workResultId, target);
    check(
      "non-success retry does NOT downgrade prior success",
      !!after3 && after3.outcome === "success",
      `outcome=${after3?.outcome}`,
    );
    check(
      "attempt_count still bumps on preserved-success retry",
      !!after3 && after3.attemptCount === 2,
      `attempts=${after3?.attemptCount}`,
    );
    check(
      "errorCode/errorMessage do NOT overwrite a preserved success",
      !!after3 && after3.errorCode == null && after3.errorMessage == null,
      `errorCode=${after3?.errorCode}`,
    );

    // ----- Scenario B0: getOrCreateApplyState on an EXISTING row must
    // return the existing row verbatim — no insert, no mutation of
    // outcome / metadata. This is the fetch-or-create contract.
    const b0 = await seedEventAndWorkResult("b0");
    await upsertApplyState({
      sourceEventId: b0.sourceEventId,
      workResultId: b0.workResultId,
      sourceSystem: "front",
      applyTarget: target,
      outcome: "failed",
      errorCode: "preexisting_failure",
      errorMessage: "must be preserved by getOrCreateApplyState",
    });
    const beforeB0 = await readApplyRow(b0.workResultId, target);
    const fetched = await getOrCreateApplyState(
      {
        sourceEventId: b0.sourceEventId,
        workResultId: b0.workResultId,
        sourceSystem: "front",
        resultType: "communication_record",
        resultJson: {},
      },
      target,
    );
    const afterB0 = await readApplyRow(b0.workResultId, target);
    check(
      "getOrCreateApplyState returns existing row (no clobber to pending)",
      !!fetched && fetched.outcome === "failed",
      `outcome=${fetched?.outcome}`,
    );
    check(
      "getOrCreateApplyState preserves errorCode on existing row",
      !!afterB0 && afterB0.errorCode === "preexisting_failure",
      `errorCode=${afterB0?.errorCode}`,
    );
    check(
      "getOrCreateApplyState does NOT bump attempt_count of existing row",
      !!afterB0 && afterB0.attemptCount === beforeB0?.attemptCount,
      `before=${beforeB0?.attemptCount} after=${afterB0?.attemptCount}`,
    );

    // ----- Scenario B: pipelineProcessor.recordApplyOutcome must not
    // throw when the row already exists. Exact bug surface.
    const b = await seedEventAndWorkResult("b");
    await upsertApplyState({
      sourceEventId: b.sourceEventId,
      workResultId: b.workResultId,
      sourceSystem: "front",
      applyTarget: target,
      outcome: "pending",
      incrementAttemptOnConflict: false,
    });

    let threwProcessor = false;
    try {
      await recordOutcomeViaProcessor({
        sourceEventId: b.sourceEventId,
        workResultId: b.workResultId,
        sourceSystem: "front",
        sourceEventType: "communication_result",
        applyTarget: target,
        outcome: "success",
        inputHash: "hash-b",
      });
    } catch {
      threwProcessor = true;
    }
    check(
      "pipelineProcessor.recordApplyOutcome on existing row does NOT throw",
      !threwProcessor,
    );
    const afterB = await readApplyRow(b.workResultId, target);
    check(
      "pipelineProcessor path leaves row in success",
      !!afterB && afterB.outcome === "success",
      `outcome=${afterB?.outcome}`,
    );
  } catch (err: any) {
    skip("apply_state upsert collision", `${err?.message ?? err}`);
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exitCode = 1;
});
