/* test-registration
{
  "name": "Onboarding tool nav entries — sales intake + roster admin reachable from QuicklinksBar (Task #5298, stage 4)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5298 (stage 4 of the New Client Onboarding epic): if the QUICKLINKS_MANIFEST entries for the sales intake page or the roster admin page silently disappeared, sales staff/team leads would have no discoverable way to reach either tool short of typing the URL by hand. Source-level regex guard (same pattern as comms-smoke.test.ts §6) — DB-free, network-free, fast.",
  "tier": "small",
  "tierReason": "Deliberately small, overriding the mechanical unmeasured default of medium: this suite only reads two source files (QuicklinksBar.tsx, App.tsx) and runs plain synchronous string/regex assertions — no DB, network, or child process — and completes in well under 1s. No measured baseline exists yet (unmeasured suites mechanically default to medium), hence this explicit override.",
  "scanPaths": [
    "client/src/components/QuicklinksBar.tsx",
    "client/src/App.tsx"
  ]
}
test-registration */
/**
 * Task #5298 — stage 4 of the New Client Onboarding epic: navigation
 * discoverability guard.
 *
 *   (A) The sales intake tool ("Onboarding Call") is registered in
 *       QUICKLINKS_MANIFEST, points at /onboarding-intake, and is visible
 *       to any authenticated staff member (matches the "add-client" gate
 *       — any signed-in rep can place a sales call).
 *   (B) Role Assignments is the only discoverable roster authority.
 *   (C) The legacy roster URL redirects to Role Assignments.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function main(): void {
  const quicklinksSrc = readFileSync(
    join(process.cwd(), "client/src/components/QuicklinksBar.tsx"),
    "utf-8",
  );

  // ── (A) Sales intake entry point ─────────────────────────────────────
  assert.ok(
    quicklinksSrc.includes('id: "onboarding-intake"'),
    'A: QUICKLINKS_MANIFEST must contain id: "onboarding-intake"',
  );
  assert.ok(
    quicklinksSrc.includes('href: "/onboarding-intake"'),
    'A: the onboarding-intake manifest item must link to /onboarding-intake',
  );
  const intakeLine = quicklinksSrc
    .split("\n")
    .find((l) => l.includes('id: "onboarding-intake"'));
  assert.ok(intakeLine, "A: onboarding-intake manifest line must exist");
  assert.match(
    intakeLine!,
    /isVisible:\s*\(\)\s*=>\s*true/,
    "A: onboarding-intake must be visible to any authenticated staff member (no role gate)",
  );
  console.log("  ✓ A: sales intake tool is a discoverable, ungated nav entry pointing at /onboarding-intake");

  assert.ok(!quicklinksSrc.includes('id: "onboarding-roster"'), "B: no competing onboarding roster nav entry remains");
  assert.ok(quicklinksSrc.includes('id: "role-assignments"'), "B: Role Assignments remains discoverable");
  console.log("  ✓ B: Role Assignments is the sole discoverable roster authority");

  // ── (C) Routes still registered in App.tsx ────────────────────────────
  const appSrc = readFileSync(join(process.cwd(), "client/src/App.tsx"), "utf-8");
  assert.ok(
    /path=["']\/onboarding-intake["']/.test(appSrc),
    "C: App.tsx must still register the /onboarding-intake route",
  );
  assert.ok(
    /path=["']\/admin\/onboarding-roster["'][\s\S]{0,120}Redirect to=["']\/admin\/role-assignments["']/.test(appSrc),
    "C: the legacy roster URL redirects to Role Assignments",
  );
  console.log("  ✓ C: legacy roster URL stays compatible through a redirect");

  console.log("\nonboarding-nav-entries: all sections passed (Task #5298).");
}

main();
