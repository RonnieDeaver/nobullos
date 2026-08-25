/* test-registration
{
  "name": "Prod-actions one-apply convergence (Task #2281)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2281 — every CEO prod-action settles after one apply.
 *
 * The two background-drain actions that could otherwise sit perpetually
 * in the panel's "remaining/active" bucket after a single "Apply all"
 * press now (a) opt into the self-heal scheduler so one press hands off
 * to the auto-healer, and (b) surface a `blocked` (needs-reconnect)
 * outcome — not a misleading red/manual "pending" or a failing drain —
 * while Front auth is dead, detected cheaply via the in-memory auth
 * breaker (no `/me` probe on every panel poll).
 *
 * Units (nested in one describe so node:test runs them sequentially —
 * they share the global Front auth breaker + `system_settings`):
 *   1. Both actions carry a valid `selfHeal` cadence/backoff.
 *   2. `unblock_poisoned_front_recovery_checkpoints` status(): a seeded
 *      poisoned checkpoint reports `blocked`(Front) while the breaker is
 *      open, `pending` once it is healthy.
 *   3. `reach_front_coverage_full_message_grain` apply(): with the search
 *      strategy switch ON and the breaker open, returns `blocked`(Front)
 *      and never starts a background drain.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  tripFrontAuthBreaker,
  __resetFrontAuthBreakerForTest,
} from "../server/services/frontAuthBreaker";
import {
  setPoolEpicSwitch,
  isPoolEpicSwitchEnabled,
} from "../server/services/poolEpicKillSwitches";
import { isDrainRunning } from "../server/services/prodActionBackgroundDrain";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

const UNBLOCK_ID = "unblock_poisoned_front_recovery_checkpoints";
const REACH_ID = "reach_front_coverage_full_message_grain";
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";
const SEEDED_CHECKPOINT_KEY = "front_recovery_checkpoint_task2281_converge_test";

function actionById(id: string) {
  const a = PROD_ACTIONS.find((x) => x.id === id);
  assert(a, `prod-action "${id}" must exist in the registry`);
  return a!;
}

describe("Task #2281 — prod-actions settle after one apply", () => {
  test("both newly-enrolled actions carry a valid selfHeal cadence/backoff", () => {
    for (const id of [UNBLOCK_ID, REACH_ID]) {
      const a = actionById(id);
      assert(a.selfHeal, `${id}: must opt into self-heal`);
      assert(
        Number.isFinite(a.selfHeal!.cadenceMs) && a.selfHeal!.cadenceMs > 0,
        `${id}: cadenceMs must be a positive number`,
      );
      assert(
        Number.isFinite(a.selfHeal!.backoffMs) && a.selfHeal!.backoffMs > 0,
        `${id}: backoffMs must be a positive number`,
      );
      assert(
        a.selfHeal!.backoffMs >= a.selfHeal!.cadenceMs,
        `${id}: backoff (after a no-op/error) should not be shorter than cadence`,
      );
      console.log(`  ok  ${id} selfHeal cadence/backoff valid`);
    }
  });

  test("unblock status(): seeded poison → blocked while Front auth dead, pending once healthy", async () => {
    const action = actionById(UNBLOCK_ID);
    await setSystemSetting(
      SEEDED_CHECKPOINT_KEY,
      JSON.stringify({
        status: "blocked",
        statusReason: "front_not_connected",
        windowLabel: "task2281_converge_test",
      }),
    );
    try {
      tripFrontAuthBreaker("front_not_connected");
      const blocked = await action.status!();
      assert.equal(blocked.state, "blocked", "breaker open → blocked");
      assert.equal(
        (blocked as { integration?: string }).integration,
        "Front",
        "blocked outcome names Front",
      );
      console.log("  ok  breaker open → blocked(Front)");

      __resetFrontAuthBreakerForTest();
      const healthy = await action.status!();
      assert.equal(
        healthy.state,
        "pending",
        "breaker healthy with poison present → pending (work to do)",
      );
      console.log("  ok  breaker healthy → pending");
    } finally {
      __resetFrontAuthBreakerForTest();
      await deleteSystemSetting(SEEDED_CHECKPOINT_KEY);
    }
  });

  test("reach apply(): switch ON + Front auth dead → blocked(Front), no drain started", async () => {
    const action = actionById(REACH_ID);
    const prior = isPoolEpicSwitchEnabled(SEARCH_SWITCH);
    await setPoolEpicSwitch(SEARCH_SWITCH, true);
    try {
      tripFrontAuthBreaker("front_not_connected");
      const out = await action.apply!(null);
      assert.equal(out.state, "blocked", "breaker open → blocked, not a drain");
      assert.equal(
        (out as { integration?: string }).integration,
        "Front",
        "blocked outcome names Front",
      );
      assert.equal(
        isDrainRunning(REACH_ID),
        false,
        "no background drain may start while Front auth is dead",
      );
      console.log("  ok  breaker open → blocked(Front), no drain");
    } finally {
      __resetFrontAuthBreakerForTest();
      await setPoolEpicSwitch(SEARCH_SWITCH, prior);
    }
  });
});
