/* test-registration
{
  "name": "Purge dead front_adoption_date setting prod-action (Task #2483)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2483 — the one-off `purge_dead_front_adoption_date_setting`
 * prod-action deletes the now-dead `system_settings.front_adoption_date`
 * row.
 *
 * Task #2481 made the Front coverage floor a hard-coded constant
 * (`FRONT_ADOPTION_DATE`), so the mutable `front_adoption_date` row is no
 * longer read or written by any code path. This action removes the leftover
 * row so the dead key stops surfacing in settings dumps.
 *
 * Asserts:
 *  - Action is registered in PROD_ACTIONS.
 *  - status()/apply() are not-needed when the row is absent.
 *  - status() is pending and apply() deletes the row when it exists.
 *  - apply() is idempotent (a second run is not-needed and the row stays gone).
 *
 * Runs inside `runInIsolatedSchema` so the test's `system_settings` writes
 * live in a per-test schema invisible to the `Start application` workers.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2481 (hard-coded floor constant + removed override route), #2436
 *   (sibling pre-floor coverage-row purge action), #1969 (one-and-done
 *   prod-action policy), #2281 (prod-action one-apply convergence).
 */

import assert from "node:assert/strict";

import { storage } from "../server/storage";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import { SETTING_ADOPTION_DATE } from "../server/services/frontAnalyticsCoverage";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTOR = "test-prod-actions-purge-dead-front-adoption-date";

async function main() {
  const action = PROD_ACTIONS.find(
    (a) => a.id === "purge_dead_front_adoption_date_setting",
  );
  assert.ok(
    action,
    "purge_dead_front_adoption_date_setting must be registered in PROD_ACTIONS",
  );
  assert.ok(
    action.selfHeal,
    "the one-off purge action opts into self-heal so prod converges without a manual press",
  );

  await runInIsolatedSchema(
    async () => {
      // ── Absent row → both status() and apply() are not-needed. ──────
      const status0 = await action.status();
      assert.equal(
        status0.state,
        "not-needed",
        `status should be not-needed with no row: ${JSON.stringify(status0)}`,
      );
      const apply0 = await action.apply(ACTOR);
      assert.equal(
        apply0.state,
        "not-needed",
        `apply should be not-needed with no row: ${JSON.stringify(apply0)}`,
      );

      // ── Seed the dead row → status() pending, apply() deletes it. ───
      await storage.setSystemSetting(SETTING_ADOPTION_DATE, "2025-07-01", ACTOR);
      const status1 = await action.status();
      assert.equal(status1.state, "pending", "status should be pending once the row exists");

      const apply1 = await action.apply(ACTOR);
      assert.equal(apply1.state, "applied", `apply should delete the row: ${JSON.stringify(apply1)}`);
      assert.equal(apply1.rowsAffected, 1, "exactly one row deleted");

      const after = await storage.getSystemSettingFresh(SETTING_ADOPTION_DATE);
      assert.equal(after, undefined, "the dead front_adoption_date row is gone after apply");

      // ── Idempotency: a second run finds nothing. ───────────────────
      const apply2 = await action.apply(ACTOR);
      assert.equal(apply2.state, "not-needed", "re-apply is not-needed (row already gone)");
      const status2 = await action.status();
      assert.equal(status2.state, "not-needed", "re-status is not-needed (row already gone)");

      console.log("✓ prod-actions-purge-dead-front-adoption-date passed");
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
    console.error("✗ prod-actions-purge-dead-front-adoption-date failed:", err);
    process.exitCode = 1;
  },
);
