/* test-registration
{
  "name": "Prod-actions SEMrush cadence cutover (Task #1785)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression guard for the Task #1785 SEMrush demand-driven cadence
 * cutover registry action (`cutover_semrush_demand_driven_cadence`).
 *
 * Asserts:
 *  - Action is registered in PROD_ACTIONS.
 *  - status() is "pending" when sub-steps remain, and lists them.
 *  - apply() flips switches, seeds missing settings, unpauses queues.
 *  - apply() never clobbers an operator-set cadence override.
 *  - Re-apply collapses to "not-needed" (idempotency).
 *
 * Task #1929 — runs inside `runInIsolatedSchema` so the test's
 * `system_settings` writes live in a per-test schema invisible to the
 * `Start application` workers, eliminating the previous public-schema
 * race and restore-on-exit scaffolding.
 */

import assert from "node:assert/strict";

import { storage } from "../server/storage";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  ensureQueueDrainStateLoaded,
  isQueuePaused,
  setQueuePause,
} from "../server/services/queueDrainControl";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTOR = "test-prod-actions-semrush-cadence-cutover";

const SWITCH_KEYS = [
  "kill_switch_semrush_demand_driven_refresh",
  "kill_switch_semrush_auto_retry_backoff",
  "kill_switch_semrush_identical_result_apply_suppression",
];
const SETTING_KEYS = [
  "semrush_background_refresh_interval_ms",
  "semrush_refresh_staleness_threshold_hours",
  "semrush_active_client_window_days",
];
const QUEUE_KEYS = ["semrush_background_refresh", "semrush_report_refresh"];

async function snapshot(): Promise<Record<string, string | undefined>> {
  return storage.getSystemSettings([...SWITCH_KEYS, ...SETTING_KEYS]);
}

async function main() {
  const action = PROD_ACTIONS.find((a) => a.id === "cutover_semrush_demand_driven_cadence");
  assert.ok(action, "cutover_semrush_demand_driven_cadence must be registered in PROD_ACTIONS");

  await runInIsolatedSchema(
    async () => {
      // `runInIsolatedSchema` bypasses the process-shared Upstash cache
      // for the duration of this scope (see tests/db-sandbox.ts), so we
      // don't need to enumerate keys to invalidate — the settings
      // storage layer reads straight through to the isolated schema.

      // Force `queue_drain_state` to load from the isolated (empty)
      // schema so the queue-paused map starts clean for this test.
      await ensureQueueDrainStateLoaded();

      // ── Setup: pause both queues so every sub-step is pending. The
      // isolated schema starts with no system_settings rows, so we
      // only need to seed the queue-pause flags.
      for (const q of QUEUE_KEYS) await setQueuePause(q, true, ACTOR);

      let status = await action.status();
      assert.equal(status.state, "pending", "status should be pending when sub-steps remain");
      for (const n of [
        "semrush_demand_driven_refresh",
        "semrush_background_refresh_interval_ms",
        "semrush_background_refresh",
      ]) {
        assert.ok(status.detail.includes(n), `pending detail should mention ${n}: ${status.detail}`);
      }

      // ── Apply: flips switches, seeds settings, unpauses queues.
      const outcome = await action.apply(ACTOR);
      assert.equal(outcome.state, "applied", `expected applied, got ${JSON.stringify(outcome)}`);

      const after = await snapshot();
      for (const k of SWITCH_KEYS) {
        assert.equal((after[k] ?? "").toLowerCase(), "true", `${k} should be true after apply`);
      }
      for (const k of SETTING_KEYS) {
        assert.ok(after[k], `${k} should be seeded after apply`);
      }
      for (const q of QUEUE_KEYS) {
        assert.equal(isQueuePaused(q), false, `${q} should be unpaused after apply`);
      }

      // ── Idempotency: re-apply collapses to not-needed.
      const reapply = await action.apply(ACTOR);
      assert.equal(reapply.state, "not-needed", "re-apply should be not-needed");
      const restatus = await action.status();
      assert.equal(restatus.state, "not-needed", "re-status should be not-needed");

      // ── Operator-override preservation: pre-seed a custom value, clear
      // switches, re-apply, and confirm the custom value survives.
      const overrideKey = "semrush_active_client_window_days";
      const overrideValue = "21";
      await storage.setSystemSetting(overrideKey, overrideValue, ACTOR);
      for (const k of SWITCH_KEYS) {
        try { await storage.deleteSystemSetting(k); } catch {}
      }
      await action.apply(ACTOR);
      const final = await snapshot();
      assert.equal(
        final[overrideKey],
        overrideValue,
        `operator override on ${overrideKey} must not be clobbered`,
      );
      for (const k of SWITCH_KEYS) {
        assert.equal((final[k] ?? "").toLowerCase(), "true", `${k} should be true after re-apply`);
      }

      console.log("✓ prod-actions-semrush-cadence-cutover passed");
    },
    {
      tables: ["system_settings", "admin_setting_audit"],
    },
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {},
  (err) => {
    console.error("✗ prod-actions-semrush-cadence-cutover failed:", err);
    process.exitCode = 1;
  },
);
