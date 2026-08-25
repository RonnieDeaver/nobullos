/* test-registration
{
  "name": "Test size-tier policy classifier, ceilings, and smoke membership guard (Task #5031)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure, DB-free policy guard for size-tier semantics. It prevents browser/dev-server resource suites or measured heavyweights from silently returning to the routine smoke gate, while exercising the explicit owner exception seam.",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import {
  KEEP_BLOCKING_EXCEPTIONS,
  TIER_CEILING_MS,
  TIER_MEASUREMENT_HEADROOM,
  classifyHarness,
  recommendTier,
  validateTierPolicy,
} from "./sizeTiers";
import { selectBlastRadiusExpansion } from "./relatedSmokeSelection";

assert.equal(recommendTier("export const x = 1;", 30_000), "small");
assert.equal(recommendTier("export const x = 1;", 30_001), "medium");
assert.equal(recommendTier("export const x = 1;", 90_001), "large");
assert.equal(recommendTier("export const x = 1;", null), "medium", "small must be earned by measurement");
const browserSource = 'const p = await import("puppeteer-' + 'core");';
const playwrightSource = 'import { chromium } from "play' + 'wright";';
const devServerSource = `execFile("npm", ["run", "${["d", "e", "v"].join("")}"]);`;
assert.equal(
  recommendTier(browserSource, 1),
  "large",
  "browser harness wins over a fast last-green time",
);
assert.equal(
  recommendTier(playwrightSource, 1),
  "large",
  "Playwright imports are browser harnesses too",
);
assert.equal(
  recommendTier(devServerSource, 1),
  "large",
  "self-booted dev server wins over a fast last-green time",
);
assert.deepEqual(classifyHarness(browserSource), {
  browser: true,
  devServer: false,
});
assert.equal(KEEP_BLOCKING_EXCEPTIONS.length, 0, "initial owner-approved keep-blocking list is empty");
assert.equal(TIER_CEILING_MS.small, 30_000);
assert.equal(TIER_CEILING_MS.medium, 90_000);
assert.equal(TIER_MEASUREMENT_HEADROOM, 1.25);

const base = {
  file: "tests/example.test.ts",
  source: "export const x = 1;",
  durationMs: 1_000,
};
assert.ok(
  validateTierPolicy({ ...base, registration: { name: "X" } }).some((message) => /required/.test(message)),
  "every registration needs an explicit tier",
);
assert.ok(
  validateTierPolicy({
    ...base,
    durationMs: 38_000,
    registration: { name: "X", tier: "small" },
  }).some((message) => /exceeds/.test(message)),
  "measured small-tier overage fails after the approved headroom",
);
assert.ok(
  validateTierPolicy({
    ...base,
    source: browserSource,
    registration: { name: "X", tier: "small" },
  }).some((message) => /browser\/dev-server/.test(message)),
  "browser suite cannot masquerade as small",
);
assert.ok(
  validateTierPolicy({
    ...base,
    registration: { name: "X", tier: "large", smoke: true, tierReason: "slow" },
  }).some((message) => /cannot declare "smoke"/.test(message)),
  "large suite is excluded from unrelated smoke selection",
);
assert.equal(
  validateTierPolicy({
    ...base,
    registration: { name: "X", tier: "small" },
  }).length,
  0,
  "valid measured small suite passes",
);

const demotedSuite = "tests/website-inquiry-forms.test.ts";
const expansion = await selectBlastRadiusExpansion(
  [{ file: demotedSuite, scanPaths: ["website/public"] }],
  ["website/public/index.html"],
  {
    traceFn: async () => ({
      ok: true,
      closures: new Map([[demotedSuite, new Set<string>()]]),
      unresolved: new Map(),
    }),
  },
);
assert.deepEqual(
  expansion.selected,
  [{
    file: demotedSuite,
    reason: "fs-scans changed website/public/index.html (declared scanPath website/public)",
    hitCount: 1,
  }],
  "a demoted browser suite is re-added to the blocking run when its declared website bundle input changes",
);

console.log("size-tier-policy: PASS");