/* test-registration
{
  "name": "Prod-actions self-heal status readout threading (Task #2126)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2126 — Cover the auto-healer status panel data with an automated
 * test.
 *
 * Task #2095 added a `selfHealLastRun` tick summary to the prod-actions
 * status response and renders it in the CEO panel. The service-level
 * readout (`getProdActionSelfHealReadout`) is unit-tested in
 * `tests/prod-action-self-heal.test.ts`, but nothing asserted that
 * `getProdActionStatuses()` — the function backing
 * `GET /api/admin/prod-actions` — actually threads `selfHealEnabled` and
 * `selfHealLastRun` through to the route payload. A regression there
 * would silently blank the panel even though the underlying readout is
 * correct.
 *
 * This test seeds a persisted self-heal last-run summary (the exact JSON
 * shape `persistLastRun()` writes) plus the master-switch setting, then
 * calls `getProdActionStatuses()` and asserts the tick summary is present
 * on the result with the expected `ranAt` + applied / not-needed / errors
 * counts and the eligible/due counts derived from the seeded arrays.
 *
 * Everything runs inside `runInIsolatedSchema(...)` so the seeded
 * `system_settings` rows (especially `prod_action_self_heal_enabled`) are
 * invisible to the live `Start application` workers — flipping the real
 * master switch on the shared `public` schema would actually arm the
 * auto-healer against live state.
 */

import assert from "node:assert/strict";

import { setSystemSetting } from "../server/storage/settingsStorage";
import {
  SETTING_ENABLED,
  SETTING_LAST_RUN,
  type ProdActionSelfHealTickResult,
} from "../server/services/prodActionSelfHeal";
import { getProdActionStatuses } from "../server/services/prodActionsRegistry";
import { runInIsolatedSchema } from "./db-sandbox";

const RAN_AT = "2026-06-01T12:00:00.000Z";

// A persisted tick summary in the exact shape `persistLastRun()` writes
// (a `ProdActionSelfHealTickResult` serialized as JSON). The readout
// derives `eligibleCount` / `dueCount` from the array lengths and copies
// the applied / not-needed / errors counts straight through.
const SEEDED_TICK: ProdActionSelfHealTickResult = {
  ranAt: RAN_AT,
  enabled: true,
  paused: false,
  maxPerTick: 3,
  eligibleActionIds: ["alpha", "bravo", "charlie", "delta"],
  dueActionIds: ["alpha", "bravo"],
  attempted: [],
  applied: 2,
  notNeeded: 1,
  errors: 1,
  blocked: 0,
  failureAlertsSent: [],
  schedule: {},
};

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async () => {
      // Seed the master switch ON and the persisted last-run summary
      // through the real persistence path (the same `setSystemSetting`
      // calls `persistLastRun()` / the enable toggle use). Inside the
      // isolated schema these land in the cloned `system_settings` table.
      await setSystemSetting(SETTING_ENABLED, "true");
      await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(SEEDED_TICK));

      const result = await getProdActionStatuses();

      // (1) The master-switch state is threaded through verbatim.
      assert.equal(
        result.selfHealEnabled,
        true,
        "selfHealEnabled must reflect the seeded master switch",
      );

      // (1b) Task #2198 — a readable persisted summary classifies as "ok"
      //      and never carries an error.
      assert.equal(
        result.selfHealLastRunStatus,
        "ok",
        "selfHealLastRunStatus must be ok for a readable seeded summary",
      );
      assert.ok(
        !("selfHealLastRunError" in result),
        "an ok readout must not carry a selfHealLastRunError",
      );

      // (2) The tick summary is present (not null) — the panel renders it.
      assert.ok(
        result.selfHealLastRun,
        "selfHealLastRun must be threaded through, not null",
      );
      const lastRun = result.selfHealLastRun!;

      // (3) Field-by-field: ranAt verbatim, counts copied through, and
      //     eligible/due counts derived from the seeded array lengths.
      assert.equal(lastRun.ranAt, RAN_AT, "ranAt copied verbatim");
      assert.equal(
        lastRun.eligibleCount,
        SEEDED_TICK.eligibleActionIds.length,
        "eligibleCount derived from eligibleActionIds length",
      );
      assert.equal(
        lastRun.dueCount,
        SEEDED_TICK.dueActionIds.length,
        "dueCount derived from dueActionIds length",
      );
      assert.equal(lastRun.applied, SEEDED_TICK.applied, "applied copied through");
      assert.equal(
        lastRun.notNeeded,
        SEEDED_TICK.notNeeded,
        "notNeeded copied through",
      );
      assert.equal(lastRun.errors, SEEDED_TICK.errors, "errors copied through");

      console.log(
        "  ok  getProdActionStatuses threads selfHealEnabled + selfHealLastRun",
      );
    },
    {
      // `getProdActionStatuses()` reads the seeded settings, runs each
      // action's `status()` (best-effort; uncloned tables surface as
      // `error` rows we do not assert on), and reads recent runs for any
      // completed action. Clone the tables those paths touch directly so
      // they resolve inside the isolated schema rather than racing the
      // live `public` workers.
      tables: ["system_settings", "prod_action_runs", "work_queue"],
    },
  );
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("prod-actions-self-heal-status-readout: all sections passed");
  },
  (err) => {
    console.error(
      "prod-actions-self-heal-status-readout: FAILED —",
      err?.stack ?? err,
    );
    process.exitCode = 1;
  },
);
