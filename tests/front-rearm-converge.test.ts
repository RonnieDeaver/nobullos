/* test-registration
{
  "name": "Front re-arm convergence \u2014 still_empty terminal",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Convergence regression for the operator one-press re-arm of parked
// Front recovery windows. A `still_empty` re-arm outcome (the search
// strategy also dead-ran with 0 ingested) must make the window
// PERMANENTLY ineligible for re-arm — otherwise the status/countPending
// caller, which passes a *fresh* `sinceIso` on every poll, would keep
// re-offering it and the `rearm_parked_front_recovery_windows`
// prod-action could never settle to "not needed".
//
// `error` outcomes, by contrast, are transient: excluded only within the
// epoch that stamped them, retried on a later press (newer `sinceIso`).
//
// Pure test against the private `isReArmEligible` exposed via the
// test-helper bag — no DB / state I/O.
// Usage: tsx tests/front-rearm-converge.test.ts
import assert from "node:assert/strict";
import { __frontAutoClosureTestHelpers } from "../server/services/frontAutoClosure";

const { isReArmEligible } = __frontAutoClosureTestHelpers;

function run(): void {
  const now = "2026-06-01T00:00:00.000Z";
  const earlier = "2026-05-01T00:00:00.000Z";
  const later = "2026-07-01T00:00:00.000Z";

  // No prior outcome → eligible.
  assert.equal(
    isReArmEligible({} as any, now),
    true,
    "a never-re-armed parked window is eligible",
  );

  // still_empty → terminal, ineligible regardless of source or sinceIso.
  assert.equal(
    isReArmEligible(
      { reArmOutcome: { kind: "still_empty", at: earlier, source: "operator_rearm" } } as any,
      later,
    ),
    false,
    "still_empty (operator_rearm) is permanently ineligible even with a fresh, later sinceIso",
  );
  assert.equal(
    isReArmEligible(
      { reArmOutcome: { kind: "still_empty", at: now, source: "auto_escalation" } } as any,
      now,
    ),
    false,
    "still_empty (auto_escalation) is permanently ineligible too",
  );

  // error → transient: excluded within the stamping epoch, retried later.
  assert.equal(
    isReArmEligible(
      { reArmOutcome: { kind: "error", at: now, source: "operator_rearm" } } as any,
      now,
    ),
    false,
    "error stamped in this epoch (at >= sinceIso) is excluded so one press terminates",
  );
  assert.equal(
    isReArmEligible(
      { reArmOutcome: { kind: "error", at: earlier, source: "operator_rearm" } } as any,
      now,
    ),
    true,
    "error from an older epoch (at < sinceIso) is retried on a fresh press",
  );

  // Non-terminal informational outcomes never block a future epoch.
  assert.equal(
    isReArmEligible(
      { reArmOutcome: { kind: "ingested", at: earlier, source: "operator_rearm" } } as any,
      now,
    ),
    true,
    "ingested outcome does not block (window would be unparked anyway)",
  );

  console.log("front re-arm convergence: all assertions passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run();
// Mirror the sibling auto-closure tests: exit so the DB pools / scheduler
// timers booted by importing frontAutoClosure don't keep the event loop
// alive past the assertions.
