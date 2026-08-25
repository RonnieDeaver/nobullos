/* test-registration
{
  "name": "scoreColor hex cross-guard — client theme.ts and server reportHtml.ts return identical hex at every band boundary (0/39/40/59/60/74/75/100)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Two independent copies of scoreColor() live in client/src/pages/adsOs/lib/theme.ts and server/services/adsOs/reportHtml.ts. A drift between them silently ships different colors in the on-screen report vs the downloaded HTML/PDF export. Pure function, DB-free, network-free.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Cross-guard: client scoreColor vs server scoreColor.
 *
 * client/src/pages/adsOs/lib/theme.ts and server/services/adsOs/reportHtml.ts
 * each contain an independent copy of the same hex-threshold function.  A
 * mismatch between them would cause the on-screen report and the downloaded
 * HTML / PDF export to display different colors for the same score — silently,
 * without any existing guard.
 *
 * This test imports both copies and asserts they return identical hex strings
 * at every band boundary:
 *
 *   Bands (thresholds: 75 / 60 / 40):
 *     score >= 75  → "#16a34a"  (green)
 *     score >= 60  → "#ca8a04"  (amber/yellow)
 *     score >= 40  → "#ea7317"  (orange)
 *     score <  40  → "#b91c1c"  (red)
 *
 *   Boundary values: 0, 39, 40, 59, 60, 74, 75, 100.
 *
 * Pure function — DB-free, network-free, no DOM required.
 */

import { strict as assert } from "node:assert";

const { scoreColor: clientScoreColor } = await import(
  "../client/src/pages/adsOs/lib/theme"
);
const { scoreColor: serverScoreColor } = await import(
  "../server/services/adsOs/reportHtml"
);

let passed = 0;

function check(score: number): void {
  const client = clientScoreColor(score);
  const server = serverScoreColor(score);
  assert.equal(
    client,
    server,
    `scoreColor(${score}): client returned ${client} but server returned ${server}`,
  );
  passed++;
  console.log(`  ✓ scoreColor(${String(score).padStart(3)}) → ${client} (both copies agree)`);
}

// ── Red band: score < 40 ────────────────────────────────────────────────────
check(0);
check(39);

// ── Orange band: 40 ≤ score < 60 ────────────────────────────────────────────
check(40);
check(59);

// ── Amber/yellow band: 60 ≤ score < 75 ──────────────────────────────────────
check(60);
check(74);

// ── Green band: score ≥ 75 ──────────────────────────────────────────────────
check(75);
check(100);

console.log(`\n✓ All ${passed} cross-guard assertions passed — client and server scoreColor are in sync.`);
