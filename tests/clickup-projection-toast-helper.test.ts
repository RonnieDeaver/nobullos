/* test-registration
{
  "name": "ClickUp projection toast helper — projectionToastLabel label contracts (Task #5156)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Pure-function unit test for projectionToastLabel. Guards the invariant that 'ClickUp synced' is never shown for pending/ambiguous states. No DB, no network.",
  "tier": "small",
  "tierReason": "Pure function evaluation via string extraction and eval — no DB, no HTTP, no transpilation. Completes in <1s.",
  "scanPaths": [
    "client/src/components/ui/ClickUpProjectionStatus.tsx"
  ]
}
test-registration */
/**
 * Task #5156 — projectionToastLabel unit tests.
 *
 * The core invariant: "ClickUp synced" must NEVER be returned for
 * pending or ambiguous states. Any regression here would mislead
 * operators into thinking ClickUp is current when it isn't.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// We test the helper via source extraction since it's a client-side TS file
// that can't be imported directly in the Node test runner without transpiling.
// We verify structural invariants + exercise the logic via eval of a
// stripped-down version of the function. This is the same approach used
// by existing client-side smoke tests in this repo.

const helperSrc = readFileSync(
  resolve("client/src/components/ui/ClickUpProjectionStatus.tsx"),
  "utf8",
);

// Extract the projectionToastLabel function body.
// Find the function start and end by counting braces.
const fnMarker = "export function projectionToastLabel(";
const fnStart = helperSrc.indexOf(fnMarker);
assert.ok(fnStart >= 0, "projectionToastLabel must exist in the helper file");

// Walk forward from the opening brace to find the matching closing brace
const bodyStart = helperSrc.indexOf("{", fnStart);
let depth = 0;
let fnEnd = bodyStart;
for (let i = bodyStart; i < helperSrc.length; i++) {
  if (helperSrc[i] === "{") depth++;
  if (helperSrc[i] === "}") {
    depth--;
    if (depth === 0) { fnEnd = i; break; }
  }
}
const fnSrc = helperSrc.slice(fnStart, fnEnd + 1);

// Build a standalone evaluatable version (strip export, type annotations)
const fnBody = fnSrc
  .replace("export function projectionToastLabel(projection: unknown)", "function projectionToastLabel(projection)")
  .replace(/: string \| null/g, "")
  .replace(/: Record<string, unknown>/g, "")
  .replace(/const p = projection as Record<string, unknown>;/g, "const p = (projection && typeof projection === 'object') ? projection : {};");

// eslint-disable-next-line no-new-func
const projectionToastLabel: (p: unknown) => string | null = new Function(
  `${fnBody}; return projectionToastLabel;`,
)();

// ─── Tests ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// Null / missing input
check("null returns null", projectionToastLabel(null) === null);
check("undefined returns null", projectionToastLabel(undefined) === null);
check("empty object returns null", projectionToastLabel({}) === null);
check("non-object returns null", projectionToastLabel("string") === null);

// NoBull-only: no staged, no blocked, nobullOnly > 0
check(
  "nobull_only returns NoBull-only label",
  (projectionToastLabel({ staged: 0, nobullOnly: 1, blocked: 0, disabled: 0 }) ?? "")
    .includes("NoBull-only"),
);

// Pending state
check(
  "state=pending returns ClickUp pending",
  projectionToastLabel({ state: "pending", staged: 1 }) === "ClickUp pending",
);
check(
  "staged>0 with no state returns ClickUp pending",
  projectionToastLabel({ staged: 2, nobullOnly: 0, blocked: 0, disabled: 0 }) === "ClickUp pending",
);

// Synced state — the critical invariant
check(
  "state=synced AND staged>0 returns ClickUp synced",
  projectionToastLabel({ state: "synced", staged: 1 }) === "ClickUp synced",
);
check(
  "state=synced but staged=0 does NOT return ClickUp synced",
  projectionToastLabel({ state: "synced", staged: 0 }) !== "ClickUp synced",
);

// CRITICAL: pending must never return synced
check(
  "CRITICAL: state=pending must not return synced",
  projectionToastLabel({ state: "pending", staged: 1 }) !== "ClickUp synced",
);

// CRITICAL: ambiguous must never return synced
check(
  "CRITICAL: state=ambiguous must not return synced",
  projectionToastLabel({ state: "ambiguous", staged: 1 }) !== "ClickUp synced",
);

// Ambiguous state
check(
  "state=ambiguous returns ambiguous label",
  (projectionToastLabel({ state: "ambiguous", staged: 1 }) ?? "").includes("ambiguous"),
);

// Failed state
check(
  "state=failed returns failed label",
  (projectionToastLabel({ state: "failed", staged: 1 }) ?? "").includes("failed"),
);

// Blocked state
check(
  "state=blocked returns blocked/NoBull saved label",
  (projectionToastLabel({ state: "blocked", staged: 0, blocked: 1 }) ?? "").includes("blocked"),
);
check(
  "all blocked with no state returns blocked/NoBull saved",
  (projectionToastLabel({ staged: 0, nobullOnly: 0, blocked: 2, disabled: 0 }) ?? "").includes("blocked"),
);

// Disabled state
check(
  "state=disabled returns paused/disabled label",
  (projectionToastLabel({ state: "disabled", staged: 0 }) ?? "").includes("paused") ||
    (projectionToastLabel({ state: "disabled", staged: 0 }) ?? "").includes("disabled"),
);
check(
  "all disabled with no state returns paused label",
  (projectionToastLabel({ staged: 0, nobullOnly: 0, blocked: 0, disabled: 1 }) ?? "").includes("paused") ||
    (projectionToastLabel({ staged: 0, nobullOnly: 0, blocked: 0, disabled: 1 }) ?? "").includes("disabled"),
);

// Drift state
check(
  "state=drift returns drift label",
  (projectionToastLabel({ state: "drift", staged: 1 }) ?? "").includes("drift"),
);

// Unknown/garbage state → fallback
const unknownResult = projectionToastLabel({ state: "unknown_garbage", staged: 0 });
check(
  "unknown state with staged=0 returns null or NoBull-only",
  unknownResult === null || (unknownResult ?? "").includes("NoBull-only"),
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}

console.log("clickup-projection-toast-helper: all tests passed (Task #5156).");
