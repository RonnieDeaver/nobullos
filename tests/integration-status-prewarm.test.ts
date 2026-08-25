/* test-registration
{
  "name": "Integration-status boot prewarm loader identity + wiring (Task #3341)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3341: integration-status boot prewarm. Asserts the route and the boot prewarm invoke the IDENTICAL shared loaders (front/zoom/semrush + the rest of the badge keys; googleAds retired from the prewarm by Task #4008 — env-derived status, no boot probe) for the same cache keys, that the prewarm goes through getCachedIntegrationStatus, and that server/index.ts awaits the Redis boot flush BEFORE prewarming (flush can't wipe fresh prewarm writes), deployment-gated. Fast, DB-free, no network (static source analysis).",
  "scanPaths": [
    "server/boot",
    "server/index.ts",
    "server/routes/integrations/hub.ts",
    "server/services/integrationStatusLoaders.ts"
  ],
  "tier": "small"
}
test-registration */
// Regression guard for the Task #3341 integration-status boot prewarm.
//
// After the env-namespace fix (Task #3338), the prod
// nobull:prod:integration_status:* namespace starts EMPTY on every new
// deploy, so all Integrations Hub badges painted "Checking…" until each
// background probe landed (up to a full poll + probe round-trip per
// instance, inconsistent across an autoscale fleet). The fix fires the
// critical probes (Front, Zoom, SEMrush, …) at boot via
// prewarmCriticalIntegrationStatuses(). Google Ads left the prewarm set
// with Task #4008: its status derives from env presence + the env-trio
// mint's in-process auth snapshot — no probe, no shared cache entry.
//
// The load-bearing invariant is IDENTITY: the prewarm and the
// /api/integrations/all-status route must invoke the SAME loader for the
// SAME cache key, or the two paths drift (different outcome
// classification, different freshTtl, split cache entries).
//
// Groups (all static source analysis — DB-free, network-free; importing
// the loaders module would pull in server/db and open pools):
//   A. Route uses the shared loaders for front / zoom and the shared
//      semrushCachedProbeLoader for semrush.
//   B. The loaders module prewarns exactly those eight keys and routes them
//      through getCachedIntegrationStatus (single-flight + Redis commit).
//   C. server/index.ts wiring — flush awaited BEFORE prewarm (so the boot
//      flush can't wipe fresh prewarm writes), deployment-gated with the
//      INTEGRATION_STATUS_PREWARM_FORCE_ENABLE dev override.
//
// Usage: tsx tests/integration-status-prewarm.test.ts

import { readFileSync, readdirSync } from "node:fs";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const routeSrc = readFileSync("server/routes/integrations/hub.ts", "utf8");
const loadersSrc = readFileSync("server/services/integrationStatusLoaders.ts", "utf8");
const indexSrc = [
  "server/index.ts",
  ...readdirSync("server/boot").filter((f) => f.endsWith(".ts")).sort()
    .map((f) => `server/boot/${f}`),
].map((p) => readFileSync(p, "utf8")).join("\n");

// Task #3388 extended the prewarm to the remaining Hub badge probes
// (slack / pandadoc / stripe). Task #3406 added twilio (the Hub's Twilio
// card gained a real connection badge). Google Calendar (per-user) is
// deliberately excluded; googleAds retired by Task #4008 and googleDrive
// by Task #4084. HighLevel's global badge adds the eighth prewarmed key.

// ── Group A: route → shared loaders ────────────────────────────────────
console.log("Group A — route uses the shared loaders");
assert(
  /getCachedIntegrationStatus[^;]*?\(\s*"front",\s*statusLoadersMod\.frontStatusLoader/s.test(routeSrc),
  "A1: route 'front' cache key uses statusLoadersMod.frontStatusLoader",
);
assert(
  /getCachedIntegrationStatus[^;]*?\(\s*"zoom",\s*statusLoadersMod\.zoomStatusLoader/s.test(routeSrc),
  "A2: route 'zoom' cache key uses statusLoadersMod.zoomStatusLoader",
);
assert(
  !/getCachedIntegrationStatus[^;]*?\(\s*"googleAds"/s.test(routeSrc),
  "A3: route no longer probes a 'googleAds' cache key (Task #4008 — env-derived status, no cached probe)",
);
assert(
  /"semrush",\s*semrushMod\.semrushCachedProbeLoader/s.test(routeSrc),
  "A4: route 'semrush' cache key uses the shared semrushCachedProbeLoader",
);
assert(
  routeSrc.includes('await import("../../services/integrationStatusLoaders")'),
  "A5: route lazy-imports the shared loaders module",
);
assert(
  /getCachedIntegrationStatus[^;]*?\(\s*"slack",\s*statusLoadersMod\.slackStatusLoader/s.test(routeSrc),
  "A7: route 'slack' cache key uses statusLoadersMod.slackStatusLoader",
);
assert(
  /getCachedIntegrationStatus[^;]*?\(\s*"pandadoc",\s*statusLoadersMod\.pandadocStatusLoader/s.test(routeSrc),
  "A8: route 'pandadoc' cache key uses statusLoadersMod.pandadocStatusLoader",
);
assert(
  !/getCachedIntegrationStatus[^;]*?\(\s*"googleDrive"/s.test(routeSrc),
  "A9: route no longer probes a 'googleDrive' cache key (Task #4084 — Drive integration retired)",
);
assert(
  /getCachedIntegrationStatus[^;]*?\(\s*"stripe",\s*statusLoadersMod\.stripeStatusLoader/s.test(routeSrc),
  "A10: route 'stripe' cache key uses statusLoadersMod.stripeStatusLoader",
);
assert(
  /getCachedIntegrationStatus[^;]*?\(\s*"twilio",\s*statusLoadersMod\.twilioStatusLoader/s.test(routeSrc),
  "A11: route 'twilio' cache key uses statusLoadersMod.twilioStatusLoader",
);
assert(
  /getCachedIntegrationStatus[^;]*?\(\s*"ghl",\s*statusLoadersMod\.ghlStatusLoader/s.test(routeSrc),
  "A12: route 'ghl' cache key uses statusLoadersMod.ghlStatusLoader",
);
// No inline re-definitions left behind for the extracted integrations.
assert(
  !/getCachedIntegrationStatus[^;]*?\(\s*"front",\s*async\s*\(\)/s.test(routeSrc) &&
    !/getCachedIntegrationStatus[^;]*?\(\s*"zoom",\s*async\s*\(\)/s.test(routeSrc) &&
    !/getCachedIntegrationStatus[^;]*?\(\s*"googleAds",\s*async\s*\(\)/s.test(routeSrc) &&
    !/getCachedIntegrationStatus[^;]*?\(\s*"slack",\s*async\s*\(\)/s.test(routeSrc) &&
    !/getCachedIntegrationStatus[^;]*?\(\s*"pandadoc",\s*async\s*\(\)/s.test(routeSrc) &&
    !/getCachedIntegrationStatus[^;]*?\(\s*"stripe",\s*async\s*\(\)/s.test(routeSrc) &&
    !/getCachedIntegrationStatus[^;]*?\(\s*"twilio",\s*async\s*\(\)/s.test(routeSrc) &&
    !/getCachedIntegrationStatus[^;]*?\(\s*"ghl",\s*async\s*\(\)/s.test(routeSrc),
  "A6: no inline loader closures remain in the route for any prewarmed key",
);

// ── Group B: prewarm contract ──────────────────────────────────────────
console.log("Group B — prewarm covers all eight badge keys via the cache");
assert(
  /PREWARM_INTEGRATIONS\s*=\s*\[\s*"front",\s*"zoom",\s*"semrush",\s*"slack",\s*"pandadoc",\s*"stripe",\s*"twilio",\s*"ghl",?\s*\]\s*as\s*const/.test(loadersSrc),
  'B1: PREWARM_INTEGRATIONS is exactly the eight badge keys (front, zoom, semrush, slack, pandadoc, stripe, twilio, ghl — googleAds and googleDrive retired)',
);
assert(
  /prewarmCriticalIntegrationStatuses[\s\S]*?getCachedIntegrationStatus\(/.test(loadersSrc),
  "B2: prewarm routes through getCachedIntegrationStatus (single-flight + Redis commit path)",
);
assert(
  /front:\s*frontStatusLoader/.test(loadersSrc) &&
    /zoom:\s*zoomStatusLoader/.test(loadersSrc) &&
    /semrush:\s*semrushMod\.semrushCachedProbeLoader/.test(loadersSrc) &&
    /slack:\s*slackStatusLoader/.test(loadersSrc) &&
    /pandadoc:\s*pandadocStatusLoader/.test(loadersSrc) &&
    /stripe:\s*stripeStatusLoader/.test(loadersSrc) &&
    /twilio:\s*twilioStatusLoader/.test(loadersSrc) &&
    /ghl:\s*ghlStatusLoader/.test(loadersSrc),
  "B3: prewarm maps each key to the same loader the route uses",
);
assert(
  !/googleAdsStatusLoader/.test(loadersSrc) && !/"googleAds"/.test(loadersSrc),
  "B5: no googleAds loader/prewarm key remains in the loaders module (Task #4008 — env-derived lane, not a cached probe)",
);
assert(
  !/googleDriveStatusLoader/.test(loadersSrc) && !/"googleDrive"/.test(loadersSrc),
  "B6: no googleDrive loader/prewarm key remains in the loaders module (Task #4084 — Drive integration retired)",
);
assert(
  /outcome:\s*"preserve"/.test(loadersSrc) && /probe_failed/.test(loadersSrc),
  "B4: extracted loaders keep the preserve-on-probe_failed outcome contract (Task #1861)",
);

// ── Group C: bootstrap wiring ──────────────────────────────────────────
console.log("Group C — server/index.ts wiring");
const flushIdx = indexSrc.indexOf("await flushEnvNamespacesOnBoot()");
const prewarmIdx = indexSrc.indexOf("prewarmCriticalIntegrationStatuses");
assert(flushIdx !== -1, "C1: boot flush is awaited (not fire-and-forget) so ordering is guaranteed");
assert(
  prewarmIdx !== -1 && flushIdx !== -1 && prewarmIdx > flushIdx,
  "C2: prewarm runs AFTER the awaited boot flush (flush can't wipe prewarm writes)",
);
const gateBlock = indexSrc.slice(flushIdx, prewarmIdx);
assert(
  gateBlock.includes("isRunningInDeployment()"),
  "C3: prewarm is deployment-gated via isRunningInDeployment()",
);
assert(
  gateBlock.includes("INTEGRATION_STATUS_PREWARM_FORCE_ENABLE"),
  "C4: dev override env INTEGRATION_STATUS_PREWARM_FORCE_ENABLE is honored",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
