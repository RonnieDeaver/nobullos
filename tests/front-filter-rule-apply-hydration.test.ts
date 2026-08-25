/* test-registration
{
  "name": "Front filter-rule apply hydration (Task #1265)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1265 — prove filter-rule apply progress survives a server restart.
 *
 * Task #824 made retroactive filter-rule apply jobs durable:
 *   - `/apply-status` (getFilterRuleApplyJobState) reads from
 *     `work_queue` + `cursor_json` when the in-memory mirror is gone.
 *   - A startup hook (`hydrateFilterRuleApplyJobs`) re-seeds the mirror
 *     and re-spawns a child-bulk-job watcher so terminal accounting
 *     (audit, affectedCount, cursor_json) eventually runs.
 *
 * None of that was covered by an automated test, so this suite exercises
 * both paths end-to-end against the real DB inside a tx sandbox:
 *
 *   1. hydrateFilterRuleApplyJobs() re-seeds the mirror for a parent
 *      whose cursor_json.result is `running` with a childBulkJobId,
 *      resumes the watcher, and once the child reaches a terminal state
 *      (durably visible via the child row's cursor_json.result) the
 *      parent ends up `complete` with audit + affectedCount + cursor_json
 *      all written.
 *
 *   2. getFilterRuleApplyJobState() returns the rebuilt state when the
 *      mirror is empty but the durable queue row exists, and returns
 *      `null` for a missing jobId.
 */

import { sql, eq } from "drizzle-orm";
import {
  frontFilterRules,
  workQueue,
  userActivityLogs,
} from "@shared/schema";
import { getDb } from "../server/db";
import { runInTxSandbox } from "./db-sandbox";
import {
  hydrateFilterRuleApplyJobs,
  getFilterRuleApplyJobState,
  frontFilterRuleApplyJobs,
  invalidateFilterRulesCache,
  normalizeRuleValue,
} from "../server/services/frontFilterRules";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${msg} — expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

async function seedTestUser(id: string): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${id}, ${`${id}@test.local`}, 'Test', 'User')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function seedRule(value: string): Promise<string> {
  const v = normalizeRuleValue("sender_email", value);
  const [row] = await getDb()
    .insert(frontFilterRules)
    .values({
      type: "block",
      scope: "sender_email",
      value: v,
      enabled: true,
      createdBy: null,
    })
    .returning({ id: frontFilterRules.id });
  invalidateFilterRulesCache();
  return row.id;
}

/**
 * Insert a `front_filter_rule_apply` parent row whose persisted result
 * looks like the server died mid-watch: status `running`, child bulk job
 * id present, no completedAt.
 */
async function seedRunningParent(opts: {
  ruleId: string;
  userId: string;
  childBulkJobId: string;
  totalSelected: number;
}): Promise<string> {
  const [row] = await getDb()
    .insert(workQueue)
    .values({
      queueName: "front_filter_rule_apply",
      jobType: "front_filter_rule_apply",
      workloadClass: "interactive_repair",
      status: "completed", // parent handler returned after delegating
      payload: { ruleId: opts.ruleId, userId: opts.userId },
      cursorJson: {
        result: {
          ruleId: opts.ruleId,
          status: "running",
          totalSelected: opts.totalSelected,
          totalProcessed: 0,
          succeeded: 0,
          failed: 0,
          childBulkJobId: opts.childBulkJobId,
          finalSummary: `Delegated to bulk job ${opts.childBulkJobId} — awaiting…`,
        },
      },
    })
    .returning({ id: workQueue.id });
  return row.id;
}

/**
 * Insert a `front_bulk_action` child row whose cursor_json.result is a
 * terminal `complete` state. `fetchChildTerminal()` will pick this up
 * via the durable lookup (the in-memory `bulkActionJobs` mirror is empty
 * across a restart).
 */
async function seedTerminalChild(opts: {
  succeeded: number;
  failed: number;
  totalProcessed: number;
  totalSelected: number;
}): Promise<string> {
  const [row] = await getDb()
    .insert(workQueue)
    .values({
      queueName: "front_bulk_action",
      jobType: "front_bulk_action",
      workloadClass: "interactive_repair",
      status: "completed",
      payload: {},
      cursorJson: {
        result: {
          status: "complete",
          succeeded: opts.succeeded,
          failed: opts.failed,
          totalProcessed: opts.totalProcessed,
          totalSelected: opts.totalSelected,
          finalSummary: `Bulk: ${opts.succeeded} succeeded / ${opts.failed} failed.`,
        },
      },
    })
    .returning({ id: workQueue.id });
  return row.id;
}

async function waitForParentTerminal(
  parentJobId: string,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await getDb()
      .select({ cursorJson: workQueue.cursorJson })
      .from(workQueue)
      .where(eq(workQueue.id, parentJobId))
      .limit(1);
    const r = (row?.cursorJson as any)?.result;
    if (
      r
      && (r.status === "complete" || r.status === "partial" || r.status === "failed")
      && r.completedAt
    ) {
      return r.status;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(
    `parent ${parentJobId} did not reach terminal cursor_json within ${timeoutMs}ms`,
  );
}

// ============================================================
// Case 1: hydration re-seeds the mirror AND resumes the watcher,
// which then runs terminal accounting against the durable child.
// ============================================================
async function testHydrationResumesWatcherToTerminal(): Promise<void> {
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    // `startedBy` on the rebuilt state is "system" because the payload's
    // userId is "system". writeAudit hits user_activity_logs with that id.
    await seedTestUser("system");

    const ruleId = await seedRule("victim@spammer.test");
    const childJobId = await seedTerminalChild({
      succeeded: 42,
      failed: 0,
      totalProcessed: 42,
      totalSelected: 42,
    });
    const parentJobId = await seedRunningParent({
      ruleId,
      userId: "system",
      childBulkJobId: childJobId,
      totalSelected: 42,
    });

    // Simulate restart: clear in-memory mirror.
    frontFilterRuleApplyJobs.clear();

    const result = await hydrateFilterRuleApplyJobs();
    assert(result.rehydrated >= 1, `expected >=1 rehydrated, got ${result.rehydrated}`);
    assert(
      result.watchersResumed >= 1,
      `expected >=1 watchersResumed, got ${result.watchersResumed}`,
    );

    // Mirror was re-seeded by hydration.
    const seeded = frontFilterRuleApplyJobs.get(parentJobId);
    assert(seeded != null, "mirror should be re-seeded for the running parent");
    assertEq(seeded!.ruleId, ruleId, "mirror entry carries the right ruleId");
    assertEq(
      seeded!.childBulkJobId,
      childJobId,
      "mirror entry carries the durable childBulkJobId",
    );
    // It starts as "running" (rebuilt from the persisted result.status);
    // the watcher will flip it to "complete" once it observes the child
    // terminal state.
    assertEq(seeded!.status, "running", "rebuilt parent starts as running");

    // Watcher poll is 5s; the very first iteration awaits fetchChildTerminal
    // which sees the durable child's terminal cursor_json and finalizes
    // the parent immediately. Wait for the persisted cursor_json to flip.
    const finalStatus = await waitForParentTerminal(parentJobId);
    assertEq(finalStatus, "complete", "watcher should finalize parent as complete");

    // Per-rule accounting was written (affectedCount += succeeded, lastAppliedAt set).
    const [ruleAfter] = await getDb()
      .select({
        affectedCount: frontFilterRules.affectedCount,
        lastAppliedAt: frontFilterRules.lastAppliedAt,
      })
      .from(frontFilterRules)
      .where(eq(frontFilterRules.id, ruleId))
      .limit(1);
    assertEq(
      ruleAfter?.affectedCount,
      42,
      "watcher should bump affectedCount by the child's succeeded count",
    );
    assert(
      ruleAfter?.lastAppliedAt != null,
      "watcher should stamp lastAppliedAt on terminal",
    );

    // Audit row written by the watcher.
    const auditRows = await getDb()
      .select({ id: userActivityLogs.id })
      .from(userActivityLogs)
      .where(sql`${userActivityLogs.actionType} = 'front_filter_rule_apply_completed'
        AND ${userActivityLogs.metadata} ->> 'jobId' = ${parentJobId}`)
      .limit(2);
    assert(
      auditRows.length === 1,
      `expected exactly 1 completion audit row, got ${auditRows.length}`,
    );

    // Mirror reflects the terminal state too.
    const mirrorAfter = frontFilterRuleApplyJobs.get(parentJobId);
    assert(mirrorAfter != null, "mirror entry should still exist after finalization");
    assertEq(mirrorAfter!.status, "complete", "mirror status should be complete");
    assertEq(mirrorAfter!.succeeded, 42, "mirror succeeded reflects child terminal");
  });
  console.log("  [PASS] hydration re-seeds mirror, resumes watcher, runs terminal accounting");
}

// ============================================================
// Case 2: getFilterRuleApplyJobState — durable fallback + missing
// ============================================================
async function testDurableLookupAndMissing(): Promise<void> {
  await runInTxSandbox(async () => {
    invalidateFilterRulesCache();
    await seedTestUser("system");

    const ruleId = await seedRule("lookup@spammer.test");
    const childJobId = await seedTerminalChild({
      succeeded: 7,
      failed: 1,
      totalProcessed: 8,
      totalSelected: 8,
    });
    const parentJobId = await seedRunningParent({
      ruleId,
      userId: "system",
      childBulkJobId: childJobId,
      totalSelected: 8,
    });

    // Mirror empty (post-restart, pre-hydration).
    frontFilterRuleApplyJobs.clear();

    const rebuilt = await getFilterRuleApplyJobState(parentJobId);
    assert(rebuilt != null, "should rebuild state from work_queue when mirror is empty");
    assertEq(rebuilt!.jobId, parentJobId, "rebuilt state carries the parent jobId");
    assertEq(rebuilt!.ruleId, ruleId, "rebuilt state carries the ruleId from cursor_json");
    assertEq(rebuilt!.status, "running", "rebuilt state carries the persisted status");
    assertEq(rebuilt!.childBulkJobId, childJobId, "rebuilt state carries the childBulkJobId");
    assertEq(rebuilt!.totalSelected, 8, "rebuilt state carries persisted totalSelected");

    // Subsequent call should hit the mirror (re-seeded by the previous call).
    assert(
      frontFilterRuleApplyJobs.has(parentJobId),
      "rebuilt state should be re-seeded into the mirror",
    );

    const missing = await getFilterRuleApplyJobState(
      "00000000-0000-0000-0000-000000000000",
    );
    assertEq(missing, null, "missing jobId returns null");
  });
  console.log("  [PASS] getFilterRuleApplyJobState rebuilds from durable row, returns null for missing");
}

async function main(): Promise<void> {
  console.log("\n=== Front filter-rule apply hydration (Task #1265) ===");
  await testHydrationResumesWatcherToTerminal();
  await testDurableLookupAndMissing();
  console.log("=== ALL FILTER-RULE APPLY HYDRATION TESTS PASSED ===\n");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
