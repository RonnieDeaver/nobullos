/* test-registration
{
  "name": "svgSafeId gradient-id sanitization (Task #4430) — every dynamic SVG gradient id strips to url()-safe [A-Za-z0-9-] via the shared svgSafeId helper; free text with spaces, commas, apostrophes, or parentheses (location names, labels) must never reach a url(#id) paint reference, and the chart components that build gradient ids from dynamic values must route them through svgSafeId",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4430: fast, pure unit + source contract; a drift here re-ships the invalid-url(#id) paint bug class where a punctuated dynamic value renders a client-facing chart plot as a SOLID BLACK rectangle (the Task #4274 '(BETA)' regression, previously live on the shared-report Map Coverage Trend chart).",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/publicReport/TrendsSection.tsx",
    "client/src/components/LocalDominanceDashboard.tsx",
    "client/src/components/LiveDataTab.tsx"
  ],
  "tier": "small"
}
test-registration */
// Task #4430 — lock the sanitized-gradient-id rule.
//
// Background (memory: svg-gradient-id-url-safety.md): an SVG gradient id
// built from human text produces an INVALID url(#id) paint reference on any
// character outside [A-Za-z0-9-] — a ')' terminates url() early, a space or
// comma breaks the fragment — and an invalid paint renders the fill as
// OPAQUE BLACK, not transparent. Stroke/dots still render, so it survives
// casual QA; SSR tests never render the SVG.
//
// Two layers of defense locked here:
//   (a) unit contract of the shared svgSafeId helper (and trendGradientId,
//       which must delegate to it);
//   (b) a source scan of the components that build gradient ids from dynamic
//       values, asserting every `<linearGradient id={\`...${expr}\`}` and its
//       matching url(#...) fill wrap the dynamic part in svgSafeId(...).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { svgSafeId } from "../../client/src/lib/svgSafeId";
import { trendGradientId } from "../../client/src/pages/PublicReport";

let passed = 0;
const ok = (msg: string) => {
  passed++;
  console.log(`  ✓ ${msg}`);
};

// (1) Helper strips every url()-unsafe character; hyphens survive.
{
  assert.equal(svgSafeId("Cedar Rapids, IA"), "CedarRapidsIA");
  assert.equal(svgSafeId("O'Fallon"), "OFallon");
  assert.equal(svgSafeId("Pipeline Momentum (BETA)"), "PipelineMomentumBETA");
  assert.equal(svgSafeId("Winston-Salem"), "Winston-Salem");
  assert.equal(svgSafeId("Consults→Cases"), "ConsultsCases");
  // Safe identifiers pass through unchanged (UUIDs, metric keys).
  assert.equal(
    svgSafeId("0b47dcf9-1f2e-4a5b-9c3d-8e7f6a5b4c3d"),
    "0b47dcf9-1f2e-4a5b-9c3d-8e7f6a5b4c3d",
  );
  const nasty = `id with "quotes" & <tags> #fragments 'apostrophes' (parens) 100%`;
  assert.match(svgSafeId(nasty), /^[A-Za-z0-9-]*$/);
  ok("svgSafeId strips to url()-safe [A-Za-z0-9-] and is identity on safe ids");
}

// (2) trendGradientId keeps its exact historical outputs while delegating.
{
  assert.equal(trendGradientId("light", "Pipeline Momentum (BETA)"), "gradient-light-PipelineMomentumBETA");
  assert.equal(trendGradientId("dark", "Consults→Cases"), "gradient-dark-ConsultsCases");
  assert.match(trendGradientId("light", "Avg. Time to Human-Answer (p50)"), /^[A-Za-z0-9-]+$/);
  const src = readFileSync("client/src/pages/publicReport/TrendsSection.tsx", "utf8");
  assert.match(src, /svgSafeId\(label\)/, "trendGradientId must delegate to the shared svgSafeId helper");
  ok("trendGradientId output unchanged and delegates to svgSafeId");
}

// (3) Source contract: every dynamic gradient id in the chart components is
// wrapped in svgSafeId(...) at BOTH the <linearGradient id> and the url(#…)
// fill site (they must stay in lockstep or the fill dangles).
{
  const guarded: Array<[file: string, expr: string, prefix: string]> = [
    ["client/src/components/LocalDominanceDashboard.tsx", "campaignId", "sovGrad-"],
    ["client/src/components/LiveDataTab.tsx", "metricKey", "grad-"],
  ];
  for (const [file, expr, prefix] of guarded) {
    const src = readFileSync(file, "utf8");
    assert.ok(
      src.includes(`id={\`${prefix}\${svgSafeId(${expr})}\`}`),
      `${file}: <linearGradient id> must wrap ${expr} in svgSafeId()`,
    );
    assert.ok(
      src.includes(`url(#${prefix}\${svgSafeId(${expr})})`),
      `${file}: url(#…) fill must wrap ${expr} in svgSafeId()`,
    );
    assert.ok(
      !src.includes(`\`${prefix}\${${expr}}\``),
      `${file}: no unsanitized \`${prefix}\${${expr}}\` id may remain`,
    );
  }
  ok("chart components route dynamic gradient ids through svgSafeId at id AND fill sites");
}

console.log(`\nsvgSafeId gradient-id sanitization: ${passed} checks passed`);
