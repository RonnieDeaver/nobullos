/* test-registration
{
  "name": "Built link-preview guard — scripts/verify-built-link-preview.ts must catch a build-time rewrite of og:image/twitter:image in dist/public/index.html, and script/build.ts must invoke it right after the Vite client build (Task #4670)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4670: sub-second hermetic check (string fixtures + one source-scan read, no DB/network/build). Task #4664's source guard cannot see build-time HTML transforms; this checker is the only thing standing between a re-introduced rewrite plugin (Task #4641 class) and shipping a Replit-domain link preview. If the checker goes blind or build.ts drops the call, nothing else fails. Deliberately does NOT run a Vite build — it pins the checker logic and the build-seam wiring only, keeping the L1 gate build-free per the task contract. scanPaths keeps it gate-selected only when the checker, the build seam, or this guard changes.",
  "scanPaths": [
    "scripts/verify-built-link-preview.ts",
    "script/build.ts",
    "tests/built-link-preview-guard.test.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4670 — pin the built-output link-preview checker.
 *
 * Two halves:
 *   1. Checker logic (pure fixtures): checkBuiltHtml() passes the canonical
 *      shape and fails every regression class — rewritten URL, Replit-domain
 *      host, duplicate/missing tags, quoting/casing evasion variants a
 *      rewrite plugin could emit, gutted head.
 *   2. Wiring (source scan): script/build.ts still imports and calls
 *      assertBuiltLinkPreview() — the checker is worthless if the build seam
 *      silently drops it, and no other guard watches that call site.
 *
 * NO Vite build runs here (too slow for L1 — task contract). The real
 * artifact is asserted in the deploy lane itself: script/build.ts throws
 * mid-build if dist/public/index.html drifts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkBuiltHtml,
  CANONICAL_OG_IMAGE,
} from "../scripts/verify-built-link-preview";

const ROOT = new URL("..", import.meta.url).pathname;

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const GOOD_HTML = `<!doctype html><html><head>
<meta charset="utf-8" />
<meta property="og:image" content="${CANONICAL_OG_IMAGE}" />
<meta name="twitter:image" content="${CANONICAL_OG_IMAGE}" />
<meta property="og:title" content="NoBull OS" />
</head><body></body></html>`;

// ---------------------------------------------------------------------------
// 1. Canonical built shape passes.
// ---------------------------------------------------------------------------
assert.deepEqual(
  checkBuiltHtml(GOOD_HTML),
  [],
  "the canonical built shape (one og:image + one twitter:image = NoBull card, no Replit hosts) must pass cleanly",
);
ok("canonical built HTML passes with zero problems");

// ---------------------------------------------------------------------------
// 2. Every regression class fails. Each fixture is a valid-HTML variant a
//    build-time rewrite plugin could emit (single-quoted, unquoted,
//    uppercase — mirroring the review-hardened source-guard self-test).
// ---------------------------------------------------------------------------
const failingFixtures: Array<[string, string]> = [
  [
    "og:image rewritten to a Replit-domain URL",
    GOOD_HTML.replace(
      `property="og:image" content="${CANONICAL_OG_IMAGE}"`,
      `property="og:image" content="https://my-app.replit.dev/opengraph.png"`,
    ),
  ],
  [
    "og:image rewritten to a non-canonical (non-Replit) URL",
    GOOD_HTML.replace(
      `property="og:image" content="${CANONICAL_OG_IMAGE}"`,
      `property="og:image" content="https://example.com/other.png"`,
    ),
  ],
  [
    "plugin-prepended duplicate og:image (scrapers take the first tag)",
    GOOD_HTML.replace(
      "<meta charset",
      `<meta property='og:image' content='https://x.replit.app/og.png' /><meta charset`,
    ),
  ],
  [
    "twitter:image tag dropped entirely",
    GOOD_HTML.replace(/<meta name="twitter:image"[^>]*>/, ""),
  ],
  [
    "unquoted Replit host in a secondary meta variant (og:image:secure_url)",
    GOOD_HTML.replace(
      "</head>",
      `<META PROPERTY="og:image:secure_url" CONTENT=https://evil.replit.com/og.png></head>`,
    ),
  ],
  ["gutted head (zero meta tags)", "<!doctype html><html><head></head><body></body></html>"],
];

for (const [label, fixture] of failingFixtures) {
  const problems = checkBuiltHtml(fixture);
  assert.ok(
    problems.length > 0,
    `checker went blind: expected a failure for fixture "${label}" but got zero problems — a build-time rewrite of this class would ship silently`,
  );
}
ok(`checker fails every regression-class fixture (${failingFixtures.length} fixtures)`);

// ---------------------------------------------------------------------------
// 3. Wiring: script/build.ts still calls the checker right after the client
//    build. Source scan, not execution — running the real build is a
//    multi-minute Vite job and belongs only in the deploy lane.
// ---------------------------------------------------------------------------
const buildSource = readFileSync(join(ROOT, "script/build.ts"), "utf8");
assert.match(
  buildSource,
  /from\s+["']\.\.\/scripts\/verify-built-link-preview["']/,
  "script/build.ts no longer imports scripts/verify-built-link-preview — the built-output link-preview check has been unwired from the deploy build (Task #4670)",
);
assert.match(
  buildSource,
  /assertBuiltLinkPreview\(\s*["']dist\/public\/index\.html["']\s*\)/,
  "script/build.ts no longer calls assertBuiltLinkPreview(\"dist/public/index.html\") — a build-time meta rewrite would ship unchecked (Task #4670)",
);
ok("script/build.ts imports and invokes assertBuiltLinkPreview on dist/public/index.html");

console.log(`built link-preview guard: ${passed} checks passed`);
