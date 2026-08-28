/* test-registration
{
  "name": "AuthGate redirect decision core — notApproved/revoked/sign-in precedence (Task #5330)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure-function test of client/src/lib/authGateRedirect.ts (no React/Clerk/DOM, no DB) — fast and deterministic, earns a routine-gate slot.",
  "scanPaths": [
    "client/src/lib/authGateRedirect.ts"
  ],
  "tier": "small",
  "tierReason": "Pure-function, import-light redirect coverage is deliberately kept in the small tier: it has no React/Clerk/DOM, database, network, or worker resources and is fast and deterministic."
}
test-registration */
/**
 * Task #5330 QA fix — a soft-deleted (revoked) user's Clerk session stayed
 * valid, but the client's redirect logic had no `revoked` branch and fell
 * through to a generic /sign-in loop instead of the dedicated
 * /access-revoked page (mirroring the existing notApproved handling from
 * Task #4554).
 *
 * client/src/App.tsx's AuthGate is heavy to mount directly (Clerk, Comms
 * context, lazy route tree), so the redirect DECISION is extracted into a
 * pure, import-light function (client/src/lib/authGateRedirect.ts) and
 * pinned here directly — this is the exact logic AuthGate's effect calls.
 */

import assert from "node:assert/strict";
import { resolveAuthGateRedirect } from "../client/src/lib/authGateRedirect";

function assertRedirect(
  label: string,
  state: Parameters<typeof resolveAuthGateRedirect>[0],
  expected: ReturnType<typeof resolveAuthGateRedirect>,
): void {
  const actual = resolveAuthGateRedirect(state);
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
  console.log(`  ✓ ${label}`);
}

function main(): void {
  console.log("AuthGate redirect decision core:");

  assertRedirect(
    "still loading → no redirect",
    { isLoading: true, user: null, notApproved: false, revoked: false, location: "/dashboard" },
    null,
  );

  assertRedirect(
    "authenticated user → no redirect",
    { isLoading: false, user: { id: "u1" }, notApproved: false, revoked: false, location: "/dashboard" },
    null,
  );

  assertRedirect(
    "already on a public path → no redirect, even when unauthenticated",
    { isLoading: false, user: null, notApproved: false, revoked: false, location: "/sign-in" },
    null,
  );

  assertRedirect(
    "notApproved (Task #4554) → /not-approved, never /sign-in",
    { isLoading: false, user: null, notApproved: true, revoked: false, location: "/dashboard" },
    "/not-approved",
  );

  assertRedirect(
    "revoked (Task #5330 fix) → /access-revoked, never /sign-in",
    { isLoading: false, user: null, notApproved: false, revoked: true, location: "/dashboard" },
    "/access-revoked",
  );

  assertRedirect(
    "notApproved takes precedence over revoked if somehow both are set",
    { isLoading: false, user: null, notApproved: true, revoked: true, location: "/dashboard" },
    "/not-approved",
  );

  assertRedirect(
    "plain unauthenticated, protected path → /sign-in",
    { isLoading: false, user: null, notApproved: false, revoked: false, location: "/dashboard" },
    "/sign-in",
  );

  assertRedirect(
    "revoked user already sitting on /access-revoked → no redirect (public path short-circuits first)",
    { isLoading: false, user: null, notApproved: false, revoked: true, location: "/access-revoked" },
    null,
  );

  console.log("auth-gate-revoked-redirect: PASSED");
}

try {
  main();
} catch (err) {
  console.error("auth-gate-revoked-redirect: FAILED");
  console.error(err);
  process.exitCode = 1;
}
