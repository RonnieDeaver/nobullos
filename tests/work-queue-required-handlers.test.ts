/* test-registration
{
  "name": "Work-queue startup required-handler registration (Task #2824)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2824: the startup required-handler registration guard. The #2637 removal deleted the retroactive_reprocess handler while its producers stayed live — the startup assert only warns, so every boot logged \"STARTUP ASSERT FAILED\" and ~50k jobs/week failed at dequeue in prod with \"No handler registered\". This test parses the REAL required list out of server/index.ts and runs the REAL registerAllHandlers(), so a deleted/renamed handler fails the routine gate instead of only warning at runtime. Fast, DB-free, in-process.",
  "tier": "small"
}
test-registration */
/**
 * Task #2824: startup required-handler registration guard.
 *
 * Production incident this locks down: Task #2637 deleted the agent
 * matching engine — and with it the `retroactive_reprocess` handler —
 * but left the queue's producers live. Every boot then logged
 * "[WorkScheduler] STARTUP ASSERT FAILED — required queue handlers not
 * registered: retroactive_reprocess" and ~50k jobs/week failed at
 * dequeue with "No handler registered". The startup assert is
 * warn-and-continue by design, so nothing failed loudly enough to stop
 * a deploy.
 *
 * This test makes that failure mode a routine-gate failure instead:
 *  1. It parses the REAL required-handler list out of server/index.ts
 *     (the literal array passed to assertRequiredHandlersRegistered),
 *     so the test can never drift from what startup actually checks.
 *  2. It runs the REAL registerAllHandlers() and asserts the assert
 *     passes — a deleted/renamed handler or a forgotten registration
 *     line fails here, before it ships.
 *
 * Fast, DB-free, deterministic: registration is pure in-process Map
 * writes; no scheduler is started and no jobs are enqueued.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { registerAllHandlers } from "../server/services/workQueueHandlers";
import {
  assertRequiredHandlersRegistered,
  isHandlerRegistered,
} from "../server/services/workScheduler";

function extractRequiredListFromIndexTs(): string[] {
  // Task #3787: the assertRequiredHandlersRegistered([...]) call moved into
  // server/boot/ (thin-orchestrator split); scan index + boot modules.
  const bootDir = path.join(process.cwd(), "server", "boot");
  const source = [
    path.join(process.cwd(), "server", "index.ts"),
    ...readdirSync(bootDir).filter((f) => f.endsWith(".ts")).sort()
      .map((f) => path.join(bootDir, f)),
  ].map((p) => readFileSync(p, "utf8")).join("\n");
  const match = source.match(
    /assertRequiredHandlersRegistered\(\[\s*([\s\S]*?)\]\)/,
  );
  assert.ok(
    match,
    "server/index.ts + server/boot/* must contain the assertRequiredHandlersRegistered([...]) startup call",
  );
  const entries = [...match![1].matchAll(/["']([a-z0-9_]+)["']/g)].map(
    (m) => m[1],
  );
  assert.ok(
    entries.length > 0,
    "the startup required-handler list must not be empty",
  );
  return entries;
}

async function run(): Promise<void> {
  let passed = 0;
  const ok = (cond: boolean, msg: string) => {
    assert.ok(cond, msg);
    passed++;
    console.log(`  ok  ${msg}`);
  };

  const required = extractRequiredListFromIndexTs();
  ok(
    required.includes("retroactive_reprocess"),
    "startup required list still contains retroactive_reprocess (silencing the assert by deleting the entry is not a fix)",
  );

  registerAllHandlers();

  const result = assertRequiredHandlersRegistered(required);
  ok(
    result.missing.length === 0,
    `every startup-required handler is registered (missing: [${result.missing.join(", ")}])`,
  );
  ok(result.ok, "assertRequiredHandlersRegistered reports ok=true");

  ok(
    isHandlerRegistered("retroactive_reprocess"),
    "retroactive_reprocess handler is registered (Task #2824 incident queue)",
  );

  console.log(`work-queue-required-handlers: ${passed} assertion(s) passed`);
}

// Importing workQueueHandlers initializes the DB pools (test mode sets
// idleTimeoutMillis=0), so the process drains once run() settles and the
// warmed clients are reaped; no explicit teardown needed.
run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
