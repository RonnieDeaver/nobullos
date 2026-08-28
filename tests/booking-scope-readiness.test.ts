/* test-registration
{
  "name": "Booking scope readiness (baseline triage, Task #3424)",
  "scanPaths": [
    "server/services/zoomIntegration.ts"
  ],
  "tier": "medium",
  "tierReason": "Covers booking scope readiness across account and calendar configuration branches."
}
test-registration */
/**
 * Task #840 — Zoom scope readiness for booking write/delete.
 *
 * Zoom's granular-scopes regime (post-2024) treats `meeting:read`,
 * `meeting:write`, and `meeting:delete` as DISTINCT scopes. A token can be
 * granted `meeting:read` without `meeting:write` / `meeting:delete`, in
 * which case the booking saga's create/cancel calls will fail at runtime
 * even though the existing read-probe in `checkBookingScopeReadiness`
 * passes. This regression would surface to admins as "scopes valid"
 * while every booking attempt fails — exactly the pathology the task
 * spec calls out as unacceptable.
 *
 * This test pins two protections:
 *   1. Static — `checkBookingScopeReadiness` source must reference both
 *      `meeting:write:meeting:admin` and `meeting:delete:meeting:admin`,
 *      and the storage must be wired to persist `zoom_granted_scopes`.
 *   2. Runtime — `getGrantedZoomScopes` correctly round-trips a
 *      space-separated `scope` field from Zoom's OAuth response, and the
 *      readiness check reports the booking write/delete scopes as missing
 *      when they are absent from the granted set, distinctly listed in
 *      `missing` so the admin UI can prompt re-authorization.
 */

import * as fs from "node:fs";
import * as path from "node:path";

let failed = 0;
let passed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

async function main(): Promise<void> {
  section("1. Static — readiness function references booking write/delete scopes");
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/zoomIntegration.ts"),
    "utf8",
  );

  assert(
    /checkBookingScopeReadiness/.test(src),
    "checkBookingScopeReadiness export exists",
  );
  assert(
    src.includes("meeting:write:meeting:admin"),
    "source references meeting:write:meeting:admin (booking create scope)",
  );
  assert(
    src.includes("meeting:delete:meeting:admin"),
    "source references meeting:delete:meeting:admin (booking rollback scope)",
  );
  assert(
    src.includes("zoom_granted_scopes"),
    "source persists zoom_granted_scopes from OAuth response",
  );
  assert(
    /getGrantedZoomScopes/.test(src),
    "getGrantedZoomScopes helper is exported for introspection",
  );
  // The two storeTokens callers (exchangeCodeForToken + refreshAccessToken)
  // must both forward `data.scope` so the granted-scope set stays fresh.
  const storeTokensCalls = [...src.matchAll(/storeTokens\(/g)];
  assert(
    storeTokensCalls.length >= 2,
    `storeTokens is invoked at least twice (got ${storeTokensCalls.length})`,
  );
  const scopeForwards = [
    ...src.matchAll(/typeof data\.scope === "string" \? data\.scope : undefined/g),
  ];
  assert(
    scopeForwards.length >= 2,
    `both token call sites forward data.scope to storeTokens (got ${scopeForwards.length})`,
  );

  section("2. Runtime — getGrantedZoomScopes parses persisted scope set");
  const { storage } = await import("../server/storage");
  const { getGrantedZoomScopes, checkBookingScopeReadiness } = await import(
    "../server/services/zoomIntegration"
  );

  // Snapshot any existing setting so we restore it afterward.
  const snapshot = await storage.getSystemSetting("zoom_granted_scopes");
  const restore = snapshot?.value;

  try {
    // Case A: empty / unset → returns null (caller should report
    // "no introspection data" rather than false-positive "ready").
    await storage.setSystemSetting("zoom_granted_scopes", "", "system");
    const empty = await getGrantedZoomScopes();
    assert(
      empty === null,
      "getGrantedZoomScopes returns null when nothing is persisted",
    );

    // Case B: full scope set → returns Set<string> with the scopes parsed.
    const fullScope = [
      "user:read:user:admin",
      "meeting:read:meeting:admin",
      "meeting:write:meeting:admin",
      "meeting:delete:meeting:admin",
      "recording:read:list_user_recordings:admin",
    ].join(" ");
    await storage.setSystemSetting("zoom_granted_scopes", fullScope, "system");
    const parsed = await getGrantedZoomScopes();
    assert(
      parsed !== null && parsed.has("meeting:write:meeting:admin"),
      "parsed granted-scope set includes meeting:write:meeting:admin",
    );
    assert(
      parsed !== null && parsed.has("meeting:delete:meeting:admin"),
      "parsed granted-scope set includes meeting:delete:meeting:admin",
    );

    // Case C: granted set missing the booking write scope → readiness check
    // reports it as missing (distinctly, so the UI can render it). We don't
    // assert overall ready=false here because the read probes may also fail
    // in this offline test environment; the assertion is "the booking
    // write/delete miss is surfaced when the granted set lacks them".
    await storage.setSystemSetting(
      "zoom_granted_scopes",
      ["user:read:user:admin", "meeting:read:meeting:admin"].join(" "),
      "system",
    );
    let result;
    try {
      result = await checkBookingScopeReadiness();
    } catch (err) {
      // checkBookingScopeReadiness itself shouldn't throw — but if Zoom
      // isn't even configured in the test env, the read probes inside
      // throw at a lower layer. We still want to verify the booking-scope
      // contribution comes through, so synthesize a stub by calling the
      // granted-scope branch directly.
      result = { ready: false, missing: [] as string[], errors: {} };
    }
    const missingHasWrite = result.missing.includes("meeting:write:meeting:admin");
    const missingHasDelete = result.missing.includes(
      "meeting:delete:meeting:admin",
    );
    assert(
      missingHasWrite,
      "readiness reports meeting:write:meeting:admin as missing when granted set lacks it",
    );
    assert(
      missingHasDelete,
      "readiness reports meeting:delete:meeting:admin as missing when granted set lacks it",
    );
  } finally {
    // Restore.
    await storage.setSystemSetting(
      "zoom_granted_scopes",
      restore ?? "",
      "system",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("Test crashed:", err);
  process.exitCode = 1;
});
