/* test-registration
{
  "name": "lint-work-queue-producer-handlers guard (Task #2833)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2833: producer-without-handler guard. Task #2637 deleted the retroactive_reprocess handler while three producers stayed live — ~50k jobs/week failed silently at dequeue for months (#2824), because the startup assert only warns and the required-handlers smoke test covers only the hardcoded startup list. This test's first assertion runs the lint over the REAL server/ tree, so ANY enqueue site referencing a queue with no registered handler fails the routine gate. The managed Long validation workflow runs the reviewed routine-gate profile, including this lint and SMOKE_FILES coverage. Fast, DB-free, deterministic (static source scan + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Task #2833: gate for scripts/lint-work-queue-producer-handlers.ts.
 *
 * The bug class (Task #2637 → incident Task #2824): a refactor deletes a
 * queue HANDLER while leaving its PRODUCERS live. The startup assert is
 * warn-and-continue, and tests/work-queue-required-handlers.test.ts only
 * covers the hardcoded required list in server/index.ts — a producer for a
 * queue NOT on that list still fails silently at dequeue ("No handler
 * registered", ~50k jobs/week for months).
 *
 * The managed Long validation workflow runs the reviewed routine-gate profile, including this lint;
 * this test adds the real-tree and fixture coverage:
 *
 *  1. FIRST assertion runs runLint() against the REAL server/ tree — any
 *     enqueue site referencing a queue with no registered handler, any
 *     unrecorded dynamic producer site, or any stale baseline entry fails
 *     the routine validation gate.
 *  2. Asserts the scanner actually SEES the #2824 incident queue on both
 *     sides (producer + handler), so a scanner regression that silently
 *     stops finding sites can't fake a pass.
 *  3. Fixture trees prove the lint FAILS on a producer-without-handler
 *     (the #2637 shape), resolves imported constants, flags unrecorded
 *     dynamic sites, and reports stale baseline entries.
 *
 * Fast, DB-free, deterministic: pure static source scanning.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runLint,
  maskComments,
  collectRegisteredHandlers,
  collectProducerSites,
  type SourceTree,
} from "../scripts/lint-work-queue-producer-handlers";

let passed = 0;
const ok = (cond: boolean, msg: string) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ok  ${msg}`);
};

const NO_BASELINE = path.join(tmpdir(), "does-not-exist-baseline.txt");

function fixtureTree(files: Record<string, string>): SourceTree {
  const tree: SourceTree = new Map();
  for (const [p, content] of Object.entries(files)) {
    tree.set(p, maskComments(content));
  }
  return tree;
}

// ---------------------------------------------------------------------------
// 1. The real tree must pass — this is the routine gate.
// ---------------------------------------------------------------------------
const real = runLint();
ok(
  real.ok,
  `REAL server/ tree passes: every enqueued queue has a registered handler, all dynamic sites baselined ` +
    `(missing: [${real.missingHandlers.map((f) => `${f.queue}@${f.file}:${f.line}`).join(", ")}]; ` +
    `unrecorded: [${real.unrecordedDynamic.map((s) => `${s.file}:${s.line}`).join(", ")}]; ` +
    `stale: [${real.staleBaseline.join(", ")}])`,
);

// ---------------------------------------------------------------------------
// 2. Scanner liveness: it must SEE the #2824 incident queue on both sides.
// A scanner that finds nothing would trivially return ok=true.
// ---------------------------------------------------------------------------
const producedQueues = new Set<string>();
for (const s of real.producerSites) for (const q of s.resolved ?? []) producedQueues.add(q);
ok(
  producedQueues.has("retroactive_reprocess"),
  "scanner finds a live producer for retroactive_reprocess (the #2824 incident queue)",
);
ok(
  real.registeredHandlers.includes("retroactive_reprocess"),
  "scanner finds the registered retroactive_reprocess handler",
);
ok(
  real.producerSites.filter((s) => s.resolved).length >= 30 &&
    real.registeredHandlers.length >= 30,
  `scanner sees a plausible corpus (${real.producerSites.filter((s) => s.resolved).length} resolved producer sites, ` +
    `${real.registeredHandlers.length} handler queues) — a collapse to near-zero means the scan regexes rotted`,
);

// ---------------------------------------------------------------------------
// 3. Fixture: producer with NO handler — the exact #2637 failure shape.
// ---------------------------------------------------------------------------
{
  const tree = fixtureTree({
    "server/services/ghostProducer.ts": `
      import { enqueueJob } from "./workScheduler";
      export async function kick(): Promise<void> {
        await enqueueJob({
          queueName: "ghost_queue",
          workloadClass: "maintenance",
        });
      }
    `,
    "server/services/workQueueHandlers.ts": `
      import { registerHandler } from "./workScheduler";
      export function registerAllHandlers(): void {
        registerHandler("some_other_queue", async () => {});
      }
    `,
  });
  const r = runLint({ tree, baselinePath: NO_BASELINE });
  ok(
    !r.ok && r.missingHandlers.some((f) => f.queue === "ghost_queue"),
    "fixture: enqueue of a queue with no registered handler FAILS the lint (#2637 shape)",
  );
}

// ---------------------------------------------------------------------------
// 4. Fixture: constant resolution across an import + handler via constant.
// ---------------------------------------------------------------------------
{
  const tree = fixtureTree({
    "server/services/myDriver.ts": `
      export const QUEUE_NAME = "fixture_queue";
    `,
    "server/routes/kicker.ts": `
      import { QUEUE_NAME } from "../services/myDriver";
      import { enqueueJob } from "../services/workScheduler";
      export async function kick(): Promise<void> {
        await enqueueJob({ queueName: QUEUE_NAME, workloadClass: "maintenance" });
      }
    `,
    "server/services/workQueueHandlers.ts": `
      import { registerHandler } from "./workScheduler";
      import { QUEUE_NAME } from "./myDriver";
      export function registerAllHandlers(): void {
        registerHandler(QUEUE_NAME, async () => {});
      }
    `,
  });
  const r = runLint({ tree, baselinePath: NO_BASELINE });
  ok(
    r.ok && r.registeredHandlers.includes("fixture_queue"),
    "fixture: imported-constant queue name resolves on BOTH producer and handler sides",
  );
}

// ---------------------------------------------------------------------------
// 5. Fixture: dynamic-import destructure resolution (the routes pattern).
// ---------------------------------------------------------------------------
{
  const tree = fixtureTree({
    "server/services/myDriver.ts": `
      export const QUEUE_NAME = "dynamic_import_queue";
    `,
    "server/routes/kicker.ts": `
      export async function kick(): Promise<void> {
        const { QUEUE_NAME } = await import(
          "../services/myDriver"
        );
        const { enqueueJob } = await import("../services/workScheduler");
        await enqueueJob({ queueName: QUEUE_NAME, workloadClass: "maintenance" });
      }
    `,
  });
  const r = runLint({ tree, baselinePath: NO_BASELINE });
  ok(
    !r.ok && r.missingHandlers.some((f) => f.queue === "dynamic_import_queue"),
    "fixture: `const { QUEUE_NAME } = await import(...)` resolves — and its missing handler is caught",
  );
}

// ---------------------------------------------------------------------------
// 6. Fixture: unresolvable dynamic site must be baselined.
// ---------------------------------------------------------------------------
{
  const tree = fixtureTree({
    "server/services/dynamic.ts": `
      import { enqueueJob } from "./workScheduler";
      export async function requeue(row: { queueName: string }): Promise<void> {
        await enqueueJob({ queueName: row.queueName, workloadClass: "maintenance" });
      }
    `,
  });
  const unrecorded = runLint({ tree, baselinePath: NO_BASELINE });
  ok(
    !unrecorded.ok && unrecorded.unrecordedDynamic.length === 1,
    "fixture: unresolvable dynamic enqueue site FAILS when not recorded in the baseline",
  );

  const dir = mkdtempSync(path.join(tmpdir(), "wq-lint-"));
  try {
    const baselinePath = path.join(dir, "baseline.txt");
    writeFileSync(
      baselinePath,
      "server/services/dynamic.ts :: row.queueName # requeue pass-through\n",
    );
    const recorded = runLint({ tree, baselinePath });
    ok(
      recorded.ok && recorded.dynamicBaselinedCount === 1,
      "fixture: the same dynamic site PASSES once recorded in the baseline",
    );

    writeFileSync(
      baselinePath,
      "server/services/dynamic.ts :: row.queueName # requeue pass-through\n" +
        "server/services/deleted.ts :: gone.queueName # no longer exists\n",
    );
    const stale = runLint({ tree, baselinePath });
    ok(
      !stale.ok && stale.staleBaseline.length === 1,
      "fixture: a stale baseline entry FAILS the lint (baseline stays honest)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 7. Fixture: comment masking — commented-out registrations must NOT count
// as handlers, and a regex literal containing a quote must not derail the
// scanner (documented scanner lesson).
// ---------------------------------------------------------------------------
{
  const tree = fixtureTree({
    "server/services/handlers.ts": `
      import { registerHandler } from "./workScheduler";
      export function escapeXml(s: string): string {
        return s.replace(/"/g, "&quot;");
      }
      export function registerAllHandlers(): void {
        // registerHandler("dead_queue", async () => {});
        registerHandler("live_queue", async () => {});
      }
    `,
  });
  const handlers = collectRegisteredHandlers(tree);
  ok(
    handlers.has("live_queue") && !handlers.has("dead_queue"),
    "fixture: commented-out registerHandler is ignored; a regex literal with a quote does not derail the scan",
  );

  const producers = collectProducerSites(
    fixtureTree({
      "server/services/p.ts": `
        import { enqueueJob } from "./workScheduler";
        // await enqueueJob({ queueName: "commented_queue", workloadClass: "x" });
        export async function go(): Promise<void> {
          await enqueueJob({ queueName: "real_queue", workloadClass: "maintenance" });
        }
      `,
    }),
  );
  ok(
    producers.length === 1 && producers[0].resolved?.[0] === "real_queue",
    "fixture: commented-out enqueue site is ignored; the live one is found",
  );
}

console.log(`lint-work-queue-producer-handlers: ${passed} assertion(s) passed`);
