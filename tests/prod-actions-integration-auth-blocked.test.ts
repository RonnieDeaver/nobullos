/* test-registration
{
  "name": "Prod-actions integration auth \u2192 blocked (Task #2123)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2123 — unit coverage for `classifyIntegrationAuthBlocked`, the
 * helper that reclassifies a thrown SEMrush / Zoom / Google Ads auth /
 * not-connected error into the amber "needs reconnect" (blocked) outcome,
 * mirroring Front's Task #2111 reclassification.
 *
 * Pure-function test: no DB, no network. We construct error objects with
 * the exact shapes the three integration modules throw (error-class `name`,
 * tagged `errorCategory` / `kind` / `terminal` fields, and the
 * integration-specific "not connected" / breaker messages) and assert the
 * classifier names the right integration — and returns null for genuine
 * (non-auth) failures and for transient Zoom refresh errors.
 */

import assert from "node:assert/strict";

import { classifyIntegrationAuthBlocked } from "../server/services/prodActionsRegistry";

function expectIntegration(err: unknown, integration: string, label: string) {
  const out = classifyIntegrationAuthBlocked(err);
  assert(out, `${label}: expected a blocked classification, got null`);
  assert.equal(out!.integration, integration, `${label}: integration name`);
  assert(
    typeof out!.detail === "string" && out!.detail.length > 0,
    `${label}: detail is a non-empty string`,
  );
  console.log(`  ok  ${label} → ${integration}`);
}

function expectNull(err: unknown, label: string) {
  const out = classifyIntegrationAuthBlocked(err);
  assert.equal(out, null, `${label}: expected null, got ${JSON.stringify(out)}`);
  console.log(`  ok  ${label} → null (stays red / not auth)`);
}

function main(): void {
  // ── SEMrush ────────────────────────────────────────────────────────
  {
    const e = new Error(
      "Semrush not connected — please authorize via Integrations Hub",
    );
    e.name = "SemrushAuthMissingError";
    (e as any).errorCategory = "auth_config";
    expectIntegration(e, "SEMrush", "SemrushAuthMissingError");
  }
  expectIntegration(
    new Error(
      "Semrush auth breaker open (semrush_not_connected), retry in 120s — re-authorize SEMrush in Settings → Integrations.",
    ),
    "SEMrush",
    "SEMrush auth-breaker message",
  );
  // errorCategory tag alone (defensive — class name stripped) still classifies.
  {
    const e: any = new Error("token expired");
    e.errorCategory = "auth_config";
    expectIntegration(e, "SEMrush", "SEMrush errorCategory tag only");
  }

  // ── Zoom ───────────────────────────────────────────────────────────
  {
    const e = new Error(
      "Zoom auth gate engaged — operator must reconnect (Invalid access token)",
    );
    e.name = "ZoomPermanentError";
    (e as any).kind = "auth";
    expectIntegration(e, "Zoom", "ZoomPermanentError (auth)");
  }
  {
    const e = new Error("Zoom API permanent scope failure: 400 ...");
    e.name = "ZoomPermanentError";
    (e as any).kind = "scope";
    expectIntegration(e, "Zoom", "ZoomPermanentError (scope)");
  }
  {
    const e = new Error("Zoom token refresh failed (terminal): 401 invalid_grant");
    e.name = "ZoomRefreshError";
    (e as any).terminal = true;
    expectIntegration(e, "Zoom", "terminal ZoomRefreshError");
  }
  expectIntegration(
    new Error("Zoom not connected. Please authorize via Settings → Integrations."),
    "Zoom",
    "Zoom not-connected guard",
  );
  // Transient (non-terminal) refresh failure must NOT be reclassified.
  {
    const e = new Error("Zoom token refresh failed (transient): 503 service unavailable");
    e.name = "ZoomRefreshError";
    (e as any).terminal = false;
    expectNull(e, "transient ZoomRefreshError");
  }

  // ── Google Ads ─────────────────────────────────────────────────────
  expectIntegration(
    new Error("Google Ads not connected"),
    "Google Ads",
    "Google Ads not-connected",
  );
  expectIntegration(
    new Error('Google Ads credential status is "disconnected"'),
    "Google Ads",
    "Google Ads credential status",
  );
  // Task #4008 retired the Google Ads auth breaker (unified GOOGLE_ADS_* env
  // model) — the current terminal message is "credential rejected by Google".
  expectIntegration(
    new Error(
      "Google Ads credential rejected by Google: invalid_grant — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md)",
    ),
    "Google Ads",
    "Google Ads credential rejected message",
  );

  // ── Non-auth / genuine failures stay red (null) ────────────────────
  expectNull(new Error("UPDATE failed: deadlock detected"), "generic DB error");
  expectNull(new Error("Failed to probe pg_extension: timeout"), "generic probe error");
  expectNull(new Error("ECONNRESET"), "network reset");
  expectNull(null, "null error");
  expectNull(undefined, "undefined error");
  // A SEMrush rate-limit (transient) is not an auth block.
  {
    const e = new Error("Semrush API rate limit exceeded");
    e.name = "SemrushRateLimitError";
    expectNull(e, "SemrushRateLimitError (transient)");
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
try {
  main();
  console.log("prod-actions-integration-auth-blocked: all scenarios passed");
} catch (err: any) {
  console.error(
    "prod-actions-integration-auth-blocked: FAILED —",
    err?.stack ?? err,
  );
  process.exitCode = 1;
}
