/* test-registration
{
  "name": "scoreColor hex guard — exact hex output at every band boundary (39/40/59/60/74/75/100) for the standalone HTML + PDF report export (Task #4857)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4857: scoreColor() in client/src/pages/adsOs/lib/theme.ts is the sole source of hex colors in the standalone HTML export (reportHtml.ts) and the PDF pipeline. A mis-edit ships wrong colors to clients in their downloaded reports without any existing guard. Pure function, DB-free, network-free.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4857 — scoreColor hex guard.
 *
 * scoreColor() in client/src/pages/adsOs/lib/theme.ts returns hard-coded hex
 * strings used in the standalone HTML export (server/services/adsOs/reportHtml.ts)
 * and the PDF export pipeline. This test pins every boundary value so a
 * mis-edit is caught before it ships wrong colors to clients.
 *
 * Bands (thresholds: 75 / 60 / 40):
 *   score >= 75  → "#16a34a"  (green)
 *   score >= 60  → "#ca8a04"  (amber/yellow)
 *   score >= 40  → "#ea7317"  (orange)
 *   score <  40  → "#b91c1c"  (red)
 *
 * Boundary values tested: 39, 40, 59, 60, 74, 75, 100.
 *
 * Pure function — DB-free, network-free, no DOM required.
 */

import { strict as assert } from "node:assert";

const { scoreColor } = await import("../../client/src/pages/adsOs/lib/theme");

let passed = 0;

function eq(a: unknown, b: unknown, label: string): void {
  assert.equal(a, b, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ── Red band: score < 40 ────────────────────────────────────────────────────
eq(scoreColor(39), "#b91c1c", "39 → red  (#b91c1c) — just below orange threshold");
eq(scoreColor(0), "#b91c1c", " 0 → red  (#b91c1c) — lowest possible score");

// ── Orange band: 40 ≤ score < 60 ────────────────────────────────────────────
eq(scoreColor(40), "#ea7317", "40 → orange (#ea7317) — inclusive lower bound");
eq(scoreColor(59), "#ea7317", "59 → orange (#ea7317) — just below amber threshold");

// ── Amber/yellow band: 60 ≤ score < 75 ──────────────────────────────────────
eq(scoreColor(60), "#ca8a04", "60 → amber (#ca8a04) — inclusive lower bound");
eq(scoreColor(74), "#ca8a04", "74 → amber (#ca8a04) — just below green threshold");

// ── Green band: score ≥ 75 ──────────────────────────────────────────────────
eq(scoreColor(75), "#16a34a", " 75 → green (#16a34a) — inclusive lower bound");
eq(scoreColor(100), "#16a34a", "100 → green (#16a34a) — maximum score");

console.log(`\n✓ All ${passed} assertions passed.`);
