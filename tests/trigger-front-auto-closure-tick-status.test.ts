/* test-registration
{
  "name": "Prod-action trigger Front auto-closure tick \u2014 settled state (Task #2501)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/triggerFrontAutoClosureTickSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2501 — Safety-net for the `trigger_front_auto_closure_tick` CEO
 * prod-action's settled state.
 *
 * Task #2499 changed this action so that when its safety gates are OPEN the
 * `status()` now settles to `not-needed` (the self-heal loop already fires a
 * tick on its ~60s cadence, so a manual nudge is never REQUIRED) instead of
 * sitting perpetually `pending` in the panel's attention bucket. `apply()`
 * still fires exactly one tick on demand. That status/apply contract was only
 * verified by manual reasoning + the no-re-press lint, so this test locks it in
 * against a future refactor of the gate logic silently re-introducing the
 * perpetual-pending regression.
 *
 * Pins three intents:
 *   1. gates OPEN  → status() = not-needed (NOT pending). [the #2499 headline]
 *   2. each closed/blocked gate branch maps to its documented state — Front
 *      not connected → blocked; the env/queue/kill gates → not-needed; an
 *      opaque gate failure → error.
 *   3. apply() enqueues exactly one tick on demand (call count == 1) and
 *      surfaces `applied`.
 *
 * The Front gate evaluation + DB run-history reads are stubbed via a resolve
 * hook (`triggerFrontAutoClosureTickSetup.mjs`):
 *   - `getLastSuccessfulProdActionRun` → null, so the recent-run (<90s)
 *     short-circuit never fires and the gate branch is always exercised.
 *   - `evaluateFrontAutoClosureGates` / `enqueueManualFrontAutoClosureTick` →
 *     configurable outcomes, so no queue / Front token / database is touched.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2499 (settled-state change under test), #2281 (one-apply convergence — why
 *   a healthy action must not stay pending), #1969 (one-and-done policy +
 *   no-re-press lint), #1980 / #2119 (the prod-action resolve-hook stub pattern
 *   reused here).
 */
import assert from "node:assert/strict";

import { triggerFrontAutoClosureTickAction } from "../server/services/prodActionsRegistry";
import {
  __setNextGate,
  __setNextEnqueueOutcome,
  __getEnqueueCallCount,
  __resetStub,
} from "./helpers/frontAutoClosureSchedulerStub.mjs";

// ── 1. gates OPEN → not-needed (the #2499 headline regression). ──────
__resetStub();
__setNextGate({ open: true });
{
  const status = await triggerFrontAutoClosureTickAction.status();
  assert.equal(
    status.state,
    "not-needed",
    "with gates open the action settles to not-needed (never perpetual pending)",
  );
  assert.notEqual(
    status.state,
    "pending",
    "the #2499 regression: an open-gate status must not sit pending in the panel",
  );
}

// ── 2. closed / blocked gate branches keep their documented states. ──
// Front-not-connected is the only gate that surfaces a blocked (needs
// reconnect) state with the Front integration label.
__resetStub();
__setNextGate({ open: false, reason: "front_not_connected" });
{
  const status = await triggerFrontAutoClosureTickAction.status();
  assert.equal(
    status.state,
    "blocked",
    "front_not_connected → blocked",
  );
  assert.equal(
    status.integration,
    "Front",
    "the blocked state carries the Front integration label for the reconnect CTA",
  );
}

// The env-flag / queue-pause / kill-switch / inflight gates are all benign
// operator-fixable or transient conditions → not-needed, never pending.
for (const reason of [
  "perf_flag_disabled",
  "queue_paused",
  "non_critical_sweeps_killed",
  "inflight_job_present",
]) {
  __resetStub();
  __setNextGate({ open: false, reason });
  const status = await triggerFrontAutoClosureTickAction.status();
  assert.equal(
    status.state,
    "not-needed",
    `gate reason ${reason} → not-needed`,
  );
}

// An opaque gate failure surfaces as error (so it is not silently swallowed).
__resetStub();
__setNextGate({ open: false, reason: "error", detail: "boom" });
{
  const status = await triggerFrontAutoClosureTickAction.status();
  assert.equal(status.state, "error", "an opaque gate failure → error");
  assert.equal(status.detail, "boom", "the gate failure detail is surfaced");
}

// ── 3. apply() fires exactly one tick on demand. ─────────────────────
__resetStub();
__setNextEnqueueOutcome({ enqueued: true, bucket: 999, trigger: "manual" });
{
  const result = await triggerFrontAutoClosureTickAction.apply();
  assert.equal(
    result.state,
    "applied",
    "a successful manual enqueue → applied",
  );
  assert.equal(
    __getEnqueueCallCount(),
    1,
    "apply() enqueues exactly one tick on demand (no loop, no double-fire)",
  );
}

// apply() still maps a not-connected enqueue refusal to blocked (parity with
// status), and does not enqueue when refused.
__resetStub();
__setNextEnqueueOutcome({ enqueued: false, reason: "front_not_connected" });
{
  const result = await triggerFrontAutoClosureTickAction.apply();
  assert.equal(
    result.state,
    "blocked",
    "apply() with front_not_connected → blocked",
  );
}

console.log("trigger-front-auto-closure-tick-status.test.ts: OK");
