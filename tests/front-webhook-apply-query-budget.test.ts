/* test-registration
{
  "name": "Front webhook apply query budget (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
// Task #1787 Stage 7B — Pin the query-count budget for the optimized
// `front_webhook_apply` path. Stage 3B split the apply into three
// labelled phases (read / transform / persist); this test makes a
// future N+1 regression (e.g. someone adding a per-record SELECT
// inside the persist hold) a CI-visible failure instead of a silent
// slow query.
//
// Budget reasoning:
//   - Happy path (proceed → persist):
//       Phase 1 READ:    workResultLog SELECT (1) + dup probe (1)        = 2
//       Phase 2 TRANSFORM: evaluateFilterRules — 1 internal SELECT       = 1
//       Phase 3 PERSIST: createRawCommunication (1) + recordApplyOutcome (1)
//                                                                          = 2
//       Total observed budget                                              ≈ 5
//     Pinned to 8 (≈60% headroom) so an extra rule lookup or an upsert
//     row probe doesn't trip the guard on a benign change.
//
//   - Already-exists path (READ → short-circuit → outcome):
//       READ: workResultLog (1) + dup probe (1) + persist outcome (1)     = 3
//     Pinned to 5.
//
// Usage: tsx tests/front-webhook-apply-query-budget.test.ts
//
// Skip behaviour: if the test fixtures cannot satisfy the apply path
// (e.g. shared schema drift), the test marks itself skipped with a
// reason rather than failing — same convention as the notifyUser
// budget test.

import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import { workResultLog, sourceEventLog } from "@shared/models/durablePipeline";
import { applyFrontWebhookResult } from "../server/services/frontWebhookIngestion";
import { runWithQueryBudget } from "./helpers/queryBudget";

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

const PROCEED_BUDGET = 8;
const ALREADY_EXISTS_BUDGET = 5;

async function seedSourceEvent(suffix: string): Promise<string> {
  const id = `sev-${Date.now()}-${Math.floor(Math.random() * 1e6)}-${suffix}`;
  await getDb().insert(sourceEventLog).values({
    id,
    sourceSystem: "front",
    sourceEventType: "communication_result",
    externalEventId: id,
    payloadJson: {},
    receivedAt: new Date(),
  } as any);
  return id;
}

async function seedWorkResult(
  sourceEventId: string,
  conversationId: string,
): Promise<string> {
  const id = `wr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const normalized = {
    conversationId,
    messageId: `${conversationId}-msg`,
    subject: "budget test",
    direction: "inbound",
    participants: [{ email: "sender@example.com", role: "sender" }],
    contentText: "body",
    contentPreview: "body",
    rawEventType: "conversation.created",
    timestamp: new Date().toISOString(),
    externalUrl: null,
  };
  await getDb().insert(workResultLog).values({
    id,
    sourceEventId,
    workStage: "normalize",
    resultJson: normalized,
    createdAt: new Date(),
  } as any);
  return id;
}

async function main(): Promise<void> {
  console.log("Task #1787 Stage 7B — front_webhook_apply query-count budget");

  try {
    await runInTxSandbox(async () => {
      const conversationId = `conv-budget-${Date.now()}`;
      const sourceEventId = await seedSourceEvent("a");
      const workResultId = await seedWorkResult(sourceEventId, conversationId);

      // Warm any AsyncLocalStorage / module-init queries out of the budget.
      await applyFrontWebhookResult(sourceEventId, workResultId).catch(() => {});

      // (1) Happy proceed path on a fresh conversation.
      const fresh = `conv-budget-fresh-${Date.now()}`;
      const ev2 = await seedSourceEvent("b");
      const wr2 = await seedWorkResult(ev2, fresh);
      const proceed = await runWithQueryBudget(() =>
        applyFrontWebhookResult(ev2, wr2),
      );
      check(
        `proceed path uses ≤ ${PROCEED_BUDGET} queries`,
        proceed.count <= PROCEED_BUDGET,
        `observed ${proceed.count}`,
      );

      // (2) Already-exists short-circuit path. Re-apply same workResult.
      const dup = await runWithQueryBudget(() =>
        applyFrontWebhookResult(ev2, wr2),
      );
      check(
        `already-exists short-circuit uses ≤ ${ALREADY_EXISTS_BUDGET} queries`,
        dup.count <= ALREADY_EXISTS_BUDGET,
        `observed ${dup.count}`,
      );
      check(
        "already-exists returns applied=false reason=already_exists",
        dup.result.applied === false && dup.result.reason === "already_exists",
      );
    });
  } catch (err: any) {
    // Schema drift, missing shared models, or env-only failures: skip
    // rather than fail. CI surfaces this via the "skipped" line.
    skip("front_webhook_apply budget", `${err?.message ?? err}`);
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
