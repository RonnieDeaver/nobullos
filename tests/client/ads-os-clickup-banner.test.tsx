/* test-registration
{
  "name": "Ads OS ClickUp degradation banner — AdsOsShell renders the amber banner exactly when clickup_live === false (Task #3597)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3597: the amber ClickUp degradation banner renders exactly when a dashboard payload reports clickup_live === false (react-dom/server, no jsdom, no network) — the UI half of the liveness contract above.",
  "extraNodeArgs": [
    "--import",
    "./tests/client/ads-os-banner-setup.mjs"
  ],
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS — ClickUp degradation banner rendering (Task #3597).
 *
 * The dashboards pass each payload's `clickup_live` flag into AdsOsShell;
 * the amber banner must render exactly when the flag is `false` — not when
 * live (true) and not before the first payload arrives (null/undefined).
 * Server-side renderToString: no jsdom, no network. CSS imports are stubbed
 * by tests/client/ads-os-banner-setup.mjs.
 */

import { strict as assert } from "node:assert";
import React from "react";
import { renderToString } from "react-dom/server";
import { Router } from "wouter";

const { AdsOsShell } = await import("../../client/src/pages/adsOs/components/AdsOsShell");

// AdsOsShell calls the real use-auth hook to role-gate the CEO-only System
// Checks tab (Task #4375); react-query hooks throw without a provider, so the
// render wraps in a QueryClientProvider. The Clerk stub in the setup file is
// signed-OUT, which keeps use-auth's /api/auth/user query disabled — no fetch,
// user stays null, the tab stays hidden (irrelevant to the banner asserts).
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// Static location hook: wouter's default hook reads window.location, which
// does not exist under plain node.
const staticHook = (() => ["/ads-os", () => {}]) as any;

function render(
  clickupLive: boolean | null | undefined,
  clickupReason?: string | null,
): string {
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <Router hook={staticHook}>
        <AdsOsShell clickupLive={clickupLive} clickupReason={clickupReason}>
          <div>rows</div>
        </AdsOsShell>
      </Router>
    </QueryClientProvider>,
  );
}

const BANNER = "banner-clickup-degraded";

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

const degraded = render(false);
ok(degraded.includes(BANNER), "clickup_live=false renders the degradation banner");
ok(
  degraded.includes("legacy account"),
  "banner names the label fallback so operators know what they are looking at",
);

// Task #3655: the outage banner surfaces the persisted failure reason so
// "unreachable" is never opaque (HTTP status / error class / which list).
const reasoned = render(false, "Last fetch of list 901417549202 failed: HTTP 401 — Token invalid");
ok(
  reasoned.includes("text-clickup-reason") && reasoned.includes("HTTP 401"),
  "banner shows the persisted last-error detail when provided",
);
ok(
  !render(false).includes("text-clickup-reason"),
  "no reason line when the payload carries no detail (older cached payloads)",
);

ok(!render(true).includes(BANNER), "clickup_live=true renders no banner");
ok(!render(null).includes(BANNER), "clickup_live=null (no payload yet) renders no banner");
ok(!render(undefined).includes(BANNER), "clickup_live=undefined renders no banner");

// Task #4823: guard against re-adding the BrandMark bull icon or wordmark to
// the Ads OS topbar. They were removed by Task #4819 because the NBM OS global
// nav above already carries the brand identity; rendering them again produced a
// duplicate bull + wordmark directly under the global nav.
// The data-testid would be stamped by BrandMark's <img> element if re-added.
ok(
  !render(undefined).includes("img-adsos-brand-bull"),
  "topbar does not render the BrandMark bull icon (duplicate of global nav brand)",
);

console.log(`\nads-os-clickup-banner: ${passed} assertion(s) passed.`);
