/* test-registration
{
  "name": "statusMeta hex cross-guard — client theme.ts statusMeta and server reportHtml.ts STATUS return identical hex for every shared status key (good, okay, bad, critical, na)",
  "regression": true,
  "smoke": true,
  "smokeReason": "client/src/pages/adsOs/lib/theme.ts statusMeta and server/services/adsOs/reportHtml.ts STATUS each carry independent hex literals for per-check status chip colors. A drift between them silently ships different chip colors in the on-screen report vs the downloaded HTML/PDF export. Pure object comparison, DB-free, network-free.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Cross-guard: client statusMeta vs server STATUS.
 *
 * client/src/pages/adsOs/lib/theme.ts exports statusMeta (a record mapping
 * good/okay/bad/critical/na → { color, label }) and
 * server/services/adsOs/reportHtml.ts exports STATUS (a record mapping the
 * same keys → [hex, label]).
 *
 * A mismatch between the two would cause check-status chip colors to differ
 * between the on-screen report and the downloaded HTML/PDF export — silently,
 * without any existing guard.
 *
 * Shared status keys asserted: good, okay, bad, critical, na.
 *
 * Pure object comparison — DB-free, network-free, no DOM required.
 */

import { strict as assert } from "node:assert";

const { statusMeta } = await import("../client/src/pages/adsOs/lib/theme");
const { STATUS } = await import("../server/services/adsOs/reportHtml");

const SHARED_KEYS = ["good", "okay", "bad", "critical", "na"] as const;

let passed = 0;

for (const key of SHARED_KEYS) {
  const clientHex = statusMeta[key].color;
  const serverHex = STATUS[key][0];
  assert.equal(
    clientHex,
    serverHex,
    `statusMeta["${key}"].color: client returned ${clientHex} but server STATUS["${key}"][0] returned ${serverHex}`,
  );
  passed++;
  console.log(`  ✓ "${key}" → ${clientHex} (both copies agree)`);
}

console.log(
  `\n✓ All ${passed} cross-guard assertions passed — client statusMeta and server STATUS hex colors are in sync.`,
);
