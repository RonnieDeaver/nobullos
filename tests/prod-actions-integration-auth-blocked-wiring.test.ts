/* test-registration
{
  "name": "Prod-actions integration auth \u2192 blocked wiring e2e (Task #2155)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2155 — end-to-end wiring coverage for the Task #2123 "needs
 * reconnect" amber state.
 *
 * The sibling unit test (`prod-actions-integration-auth-blocked.test.ts`)
 * only exercises the pure `classifyIntegrationAuthBlocked()` helper. This
 * test proves the two CENTRAL CATCH BLOCKS in `prodActionsRegistry.ts`
 * actually consume that classifier:
 *
 *   - `getProdActionStatuses()` — a registered action whose `status()`
 *     throws a SEMrush / Zoom / Google Ads auth error comes back as
 *     `state:"blocked"` naming the integration (NOT `state:"error"`),
 *     while a generic throw still comes back `state:"error"`.
 *   - `applyAllProdActions()` — same reclassification on the apply path.
 *
 * Strategy: like `prod-actions-registry.test.ts`, we reach into the live
 * `PROD_ACTIONS` array — but instead of inspecting one real action's gate
 * we *temporarily replace the whole registry* with synthetic throwing
 * actions, run the two entry points, assert on the catch-path outcomes,
 * then restore the registry. Swapping the registry contents (rather than
 * appending) keeps the run fast and side-effect free: no real action's
 * `status()`/`apply()` fires.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  PROD_ACTIONS,
  getProdActionStatuses,
  applyAllProdActions,
  type ProdAction,
} from "../server/services/prodActionsRegistry";

// Unique id prefix so cleanup never touches real audit rows.
const PREFIX = "__task2155_wiring__";
const SEMRUSH_ID = `${PREFIX}semrush`;
const ZOOM_ID = `${PREFIX}zoom`;
const GOOGLE_ADS_ID = `${PREFIX}google_ads`;
const GENERIC_ID = `${PREFIX}generic`;

function semrushAuthError(): Error {
  const e = new Error(
    "Semrush not connected — please authorize via Integrations Hub",
  );
  e.name = "SemrushAuthMissingError";
  (e as any).errorCategory = "auth_config";
  return e;
}

function zoomAuthError(): Error {
  const e = new Error(
    "Zoom auth gate engaged — operator must reconnect (Invalid access token)",
  );
  e.name = "ZoomPermanentError";
  (e as any).kind = "auth";
  return e;
}

function googleAdsAuthError(): Error {
  return new Error("Google Ads not connected");
}

function genericError(): Error {
  return new Error("UPDATE failed: deadlock detected");
}

function throwingAction(id: string, makeError: () => Error): ProdAction {
  return {
    id,
    title: `Task #2155 synthetic ${id}`,
    description: "Synthetic action that throws to exercise the central catch.",
    change: "none (test fixture)",
    // Task #4054 — the registry reads action.convergence.kind unconditionally.
    convergence: { kind: "converging" },
    async status() {
      throw makeError();
    },
    async apply() {
      throw makeError();
    },
  };
}

async function cleanupAuditRows(): Promise<void> {
  // applyAllProdActions() writes one audit row per action (including our
  // synthetic blocked/error outcomes). Scrub them by our unique prefix so
  // the History panel / other tests never see fixtures.
  await db.execute(
    sql`DELETE FROM prod_action_runs WHERE action_id LIKE ${`${PREFIX}%`}`,
  );
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function main(): Promise<void> {
  const testActions: ProdAction[] = [
    throwingAction(SEMRUSH_ID, semrushAuthError),
    throwingAction(ZOOM_ID, zoomAuthError),
    throwingAction(GOOGLE_ADS_ID, googleAdsAuthError),
    throwingAction(GENERIC_ID, genericError),
  ];

  // Swap the whole registry out for our fixtures (saved verbatim so we can
  // restore exactly, even if other tests in-process mutated it earlier).
  const saved = PROD_ACTIONS.splice(0, PROD_ACTIONS.length, ...testActions);

  try {
    await cleanupAuditRows();

    // ── status() catch path ────────────────────────────────────────────
    {
      const result = await getProdActionStatuses();
      const byId = new Map(result.actions.map((a) => [a.id, a]));

      const semrush = byId.get(SEMRUSH_ID);
      assert(semrush, "status: SEMrush fixture present");
      assertEq(semrush!.status.state, "blocked", "status: SEMrush ⇒ blocked");
      assertEq(
        (semrush!.status as any).integration,
        "SEMrush",
        "status: SEMrush integration name",
      );

      const zoom = byId.get(ZOOM_ID);
      assert(zoom, "status: Zoom fixture present");
      assertEq(zoom!.status.state, "blocked", "status: Zoom ⇒ blocked");
      assertEq(
        (zoom!.status as any).integration,
        "Zoom",
        "status: Zoom integration name",
      );

      const googleAds = byId.get(GOOGLE_ADS_ID);
      assert(googleAds, "status: Google Ads fixture present");
      assertEq(
        googleAds!.status.state,
        "blocked",
        "status: Google Ads ⇒ blocked",
      );
      assertEq(
        (googleAds!.status as any).integration,
        "Google Ads",
        "status: Google Ads integration name",
      );

      const generic = byId.get(GENERIC_ID);
      assert(generic, "status: generic fixture present");
      assertEq(
        generic!.status.state,
        "error",
        "status: generic throw stays error (red)",
      );
      assert(
        generic!.status.detail.includes("deadlock"),
        `status: generic detail preserves the message: ${generic!.status.detail}`,
      );

      // The three blocked + one error rows must all land in `active` (the
      // operator-attention bucket), never silently dropped.
      const activeIds = new Set(result.active.map((a) => a.id));
      for (const id of [SEMRUSH_ID, ZOOM_ID, GOOGLE_ADS_ID, GENERIC_ID]) {
        assert(activeIds.has(id), `status: ${id} surfaces in active rows`);
      }
      console.log(
        "  ok  status() catch → SEMrush/Zoom/Google Ads blocked, generic error, all active",
      );
    }

    // ── apply() catch path ─────────────────────────────────────────────
    {
      const results = await applyAllProdActions(null);
      const byId = new Map(results.map((r) => [r.id, r]));

      const semrush = byId.get(SEMRUSH_ID);
      assert(semrush, "apply: SEMrush fixture present");
      assertEq(semrush!.outcome.state, "blocked", "apply: SEMrush ⇒ blocked");
      assertEq(
        (semrush!.outcome as any).integration,
        "SEMrush",
        "apply: SEMrush integration name",
      );

      const zoom = byId.get(ZOOM_ID);
      assert(zoom, "apply: Zoom fixture present");
      assertEq(zoom!.outcome.state, "blocked", "apply: Zoom ⇒ blocked");
      assertEq(
        (zoom!.outcome as any).integration,
        "Zoom",
        "apply: Zoom integration name",
      );

      const googleAds = byId.get(GOOGLE_ADS_ID);
      assert(googleAds, "apply: Google Ads fixture present");
      assertEq(
        googleAds!.outcome.state,
        "blocked",
        "apply: Google Ads ⇒ blocked",
      );
      assertEq(
        (googleAds!.outcome as any).integration,
        "Google Ads",
        "apply: Google Ads integration name",
      );

      const generic = byId.get(GENERIC_ID);
      assert(generic, "apply: generic fixture present");
      assertEq(
        generic!.outcome.state,
        "error",
        "apply: generic throw stays error (red)",
      );
      assert(
        generic!.outcome.detail.includes("deadlock"),
        `apply: generic detail preserves the message: ${generic!.outcome.detail}`,
      );
      console.log(
        "  ok  apply() catch → SEMrush/Zoom/Google Ads blocked, generic error",
      );
    }
  } finally {
    // Restore the registry exactly, then scrub our audit rows.
    PROD_ACTIONS.splice(0, PROD_ACTIONS.length, ...saved);
    await cleanupAuditRows();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(
  () => {
    console.log("prod-actions-integration-auth-blocked-wiring: all scenarios passed");
  },
  (err) => {
    console.error(
      "prod-actions-integration-auth-blocked-wiring: FAILED —",
      err?.stack ?? err,
    );
    process.exitCode = 1;
  },
);
