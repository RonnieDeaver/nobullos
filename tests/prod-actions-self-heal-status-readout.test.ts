/* test-registration
{
  "name": "Prod-actions self-heal status readout threading (Task #2126)",
  "regression": true,
  "sweepOnlyReason": "Its published green baseline measures 303215ms, making this a resource-heavy large suite that must remain in the regression sweep rather than the routine smoke gate.",
  "tier": "large",
  "tierReason": "Its published green baseline measures 303215ms, above the medium ceiling; the large tier records that measured execution cost."
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

import { closeDbPools } from "../server/db";
import { setSystemSetting } from "../server/storage/settingsStorage";
import {
  SETTING_ENABLED,
  SETTING_LAST_RUN,
  type ProdActionSelfHealTickResult,
} from "../server/services/prodActionSelfHeal";
import {
  getProdActionStatuses,
  PROD_ACTIONS,
} from "../server/services/prodActionsRegistry";
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
  // This contract concerns the registry-level readout fields, not the many
  // unrelated action.status() implementations. Keep the real engine path but
  // temporarily empty the mutable registry, matching the isolation pattern
  // used by the prod-actions registry wiring suites.
  const savedActions = PROD_ACTIONS.splice(0, PROD_ACTIONS.length);
  try {
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
        tables: ["system_settings", "prod_action_runs"],
      },
    );
  } finally {
    PROD_ACTIONS.splice(0, PROD_ACTIONS.length, ...savedActions);
  }
}

try {
  await main();
  console.log("prod-actions-self-heal-status-readout: all sections passed");
} catch (err: any) {
  console.error(
    "prod-actions-self-heal-status-readout: FAILED —",
    err?.stack ?? err,
  );
  process.exitCode = 1;
} finally {
  // This suite imports the full prod-actions registry, whose transitive
  // services may keep unrelated handles alive. Close the pools explicitly:
  // waiting for beforeExit is circular when another handle prevents it.
  await closeDbPools();
}
