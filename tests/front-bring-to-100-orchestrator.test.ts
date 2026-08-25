/* test-registration
{
  "name": "Front 'Bring it to 100%' orchestration wiring — includes recover_plan_limited step (Task #2705)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2705: the \"Bring it to 100%\" orchestration must keep driving the new plan-limited recovery step (`4.recover_plan_limited`) between reach and attribution. Stubbed, fast, pure, in-memory (no DB/network). Gate it so a regression in the step wiring / ordering can't rot silently.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/frontBringTo100OrchestratorSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
// Task #2705 — "Bring it to 100%" orchestration wiring.
//
// Asserts that `startFrontBringTo100` drives the existing recovery drivers in the
// right order AND now includes the new plan-limited recovery step
// (`4.recover_plan_limited`) BETWEEN the reach step and the attribution backfill,
// so the conversation-search recovery of plan-limited months is actually part of
// the one-button flow (and not duplicated Front I/O — it reuses the registry's
// convergent driver). Also covers the breaker-blocked short-circuit and the
// Queue-Drain-paused branch (historical recovery skipped, drivers still run).
//
// Runs with the resolve hook registered via `--import
// ./tests/helpers/frontBringTo100OrchestratorSetup.mjs`, which redirects every
// module the orchestrator dynamically imports to an in-memory stub. The stub
// records driver invocations into `globalThis.__frontBringTo100Calls` and reads
// `globalThis.__frontStub*` gate flags.

import assert from "node:assert/strict";
import { startFrontBringTo100 } from "../server/services/frontBringTo100";

type G = typeof globalThis & {
  __frontBringTo100Calls?: string[];
  __frontStubAuthBlocked?: boolean;
  __frontStubRecoveryPaused?: boolean;
  __frontStubRecoveryConcurrencyCap?: boolean;
};

const g = globalThis as G;

function resetStub(): void {
  g.__frontBringTo100Calls = [];
  g.__frontStubAuthBlocked = false;
  g.__frontStubRecoveryPaused = false;
  g.__frontStubRecoveryConcurrencyCap = false;
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    resetStub();
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.error(`  \u2717 ${name}`);
    console.error(err);
  }
}

await test(
  "happy path drives all 5 drivers in order, including 4.recover_plan_limited",
  async () => {
    const result = await startFrontBringTo100("actor-1");

    assert.equal(result.started, true, "should report started");
    assert.equal(result.blocked, false, "should not be blocked");

    const labels = result.steps.map((s) => s.label);
    assert.deepEqual(
      labels,
      [
        "1.historical_recovery_repull",
        "2.finish_message_grain",
        "3.reach_full_coverage",
        "4.recover_plan_limited",
        "5.attribution_backfill",
      ],
      "step labels must appear in the documented order",
    );

    // The recover step must sit BETWEEN reach and attribution.
    const reachIdx = labels.indexOf("3.reach_full_coverage");
    const recoverIdx = labels.indexOf("4.recover_plan_limited");
    const attribIdx = labels.indexOf("5.attribution_backfill");
    assert.ok(
      reachIdx < recoverIdx && recoverIdx < attribIdx,
      "recover_plan_limited must run after reach and before attribution",
    );

    // Every step actually applied (stub returns applied) — no silent skips.
    for (const s of result.steps) {
      assert.equal(s.state, "applied", `${s.label} should be applied`);
    }

    // The underlying drivers were invoked in the same order.
    assert.deepEqual(g.__frontBringTo100Calls, [
      "runHistoricalRecovery",
      "applyFinishFrontMessageGrainCoverage",
      "applyReachFrontCoverageFull",
      "applyRecoverFrontPlanLimitedMessages",
      "applyBackfillFrontMessageAttribution",
    ]);
  },
);

await test(
  "Front auth dead → short-circuits blocked, no steps, no drivers invoked",
  async () => {
    g.__frontStubAuthBlocked = true;
    const result = await startFrontBringTo100("actor-1");

    assert.equal(result.started, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.steps, []);
    assert.deepEqual(
      g.__frontBringTo100Calls,
      [],
      "no driver should run when Front auth is dead",
    );
  },
);

await test(
  "Queue-Drain paused → historical recovery skipped, the 4 drivers (incl. recover) still run",
  async () => {
    g.__frontStubRecoveryPaused = true;
    const result = await startFrontBringTo100("actor-1");

    assert.equal(result.started, true);
    assert.equal(result.blocked, false);

    const repull = result.steps.find(
      (s) => s.label === "1.historical_recovery_repull",
    );
    assert.equal(repull?.state, "skipped", "re-pull must be skipped when paused");

    // Historical recovery driver NOT invoked; the recover-plan-limited step still is.
    assert.ok(
      !g.__frontBringTo100Calls!.includes("runHistoricalRecovery"),
      "paused recovery must not call runHistoricalRecovery",
    );
    assert.ok(
      g.__frontBringTo100Calls!.includes("applyRecoverFrontPlanLimitedMessages"),
      "recover_plan_limited must still run while recovery is paused",
    );
    assert.deepEqual(
      result.steps.map((s) => s.label),
      [
        "1.historical_recovery_repull",
        "2.finish_message_grain",
        "3.reach_full_coverage",
        "4.recover_plan_limited",
        "5.attribution_backfill",
      ],
    );
  },
);

await test(
  "historical-recovery already in flight → step is not-needed, drivers still run",
  async () => {
    g.__frontStubRecoveryConcurrencyCap = true;
    const result = await startFrontBringTo100("actor-1");

    assert.equal(result.started, true);
    const repull = result.steps.find(
      (s) => s.label === "1.historical_recovery_repull",
    );
    assert.equal(repull?.state, "not-needed");
    assert.ok(
      g.__frontBringTo100Calls!.includes("applyRecoverFrontPlanLimitedMessages"),
    );
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
