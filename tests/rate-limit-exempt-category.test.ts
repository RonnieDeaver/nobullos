/* test-registration
{
  "name": "Exempt rate-limit categories keep auto-tuner protection (Task #2848)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2848: the exempt-category contract from Task #2841 — the monitor carries `{ exempt, note }` through getLimiterConfigs / getRateLimitSummary / computeEffectiveLimits, the auto-tuner skips exempt categories in getTuningSuggestions and rejects them in applySuggestion, and server/index.ts still registers notifications_sse with exempt: true (source guard). Nothing else covers this: a refactor of either module could quietly drop the skip/reject and let the tuner propose a real limit for the intentionally unlimited SSE endpoint. Fast, in-memory, no writes (rejection paths only).",
  "tier": "small"
}
test-registration */
/**
 * Task #2848 — Exempt rate-limit categories must keep their auto-tuner
 * protection.
 *
 * Task #2841 made `notifications_sse` an explicitly exempt rate-limit
 * category: `registerLimiterConfig` accepts `{ exempt, note }`, the
 * auto-tuner skips exempt categories in `getTuningSuggestions` and rejects
 * them in `applySuggestion`, and the dashboard renders an "Exempt" badge.
 * A refactor of the monitor or auto-tuner could quietly drop the skip/reject
 * behavior and let the tuner propose a real limit for an intentionally
 * unlimited SSE endpoint. This test locks the server-side contract:
 *
 *   1. `registerLimiterConfig(..., { exempt: true, note })` flows into
 *      `getLimiterConfigs`, `getRateLimitSummary`, and
 *      `computeEffectiveLimits` (exempt flag + note present in each).
 *   2. `getTuningSuggestions` never returns a suggestion for an exempt
 *      category (control: a non-exempt category registered the same way IS
 *      suggested, proving the filter is the exempt flag).
 *   3. `applySuggestion` for an exempt category returns a rejection error and
 *      records no adjustment.
 *   4. The REAL `notifications_sse` registration in server/index.ts still
 *      passes `exempt: true` with a note (static source guard — the module
 *      map in this process is fresh, so the live registration is asserted
 *      from source).
 *
 * Server-side only by design (the 2,900-line RateLimitDashboard.tsx is never
 * mounted). In-memory limiter maps are per-process, so registering synthetic
 * categories here touches nothing shared. No success-path applySuggestion is
 * ever invoked, so the persistence side effects (system_settings history /
 * overrides keys) are never written.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  registerLimiterConfig,
  getLimiterConfigs,
  getRateLimitSummary,
  computeEffectiveLimits,
} from "../server/services/rateLimitMonitor";
import {
  getTuningSuggestions,
  applySuggestion,
  getAdjustmentHistory,
} from "../server/services/rateLimitAutoTuner";

const EXEMPT_CAT = "test_exempt_sse_2848";
const CONTROL_CAT = "test_control_cat_2848";
const NOTE = "Exempt test category — long-lived SSE style, never rate limited (Task #2848 fixture)";

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS ${label}`);
  } catch (err: any) {
    failures++;
    console.error(`  FAIL ${label}`);
    console.error(`       ${err?.message ?? err}`);
  }
}

console.log("=== Rate-limit exempt category protection (Task #2848) ===");

// ---------------------------------------------------------------------------
// Section 1 — registration flows into every read surface
// ---------------------------------------------------------------------------
console.log("\n[1] registerLimiterConfig({ exempt, note }) flows into read surfaces");

registerLimiterConfig(EXEMPT_CAT, 15 * 60 * 1000, 0, false, {
  exempt: true,
  note: NOTE,
});
registerLimiterConfig(CONTROL_CAT, 15 * 60 * 1000, 100, true);

check("getLimiterConfigs carries exempt + note for the exempt category", () => {
  const cfg = getLimiterConfigs().get(EXEMPT_CAT);
  assert.ok(cfg, `expected ${EXEMPT_CAT} in getLimiterConfigs`);
  assert.equal(cfg!.exempt, true, "exempt flag lost in getLimiterConfigs");
  assert.equal(cfg!.note, NOTE, "note lost in getLimiterConfigs");
});

check("getLimiterConfigs defaults exempt=false for a plain registration", () => {
  const cfg = getLimiterConfigs().get(CONTROL_CAT);
  assert.ok(cfg, `expected ${CONTROL_CAT} in getLimiterConfigs`);
  assert.equal(cfg!.exempt, false, "control category must not be exempt");
  assert.equal(cfg!.note, undefined, "control category must have no note");
});

check("getRateLimitSummary exposes exempt + note (dashboard badge source)", () => {
  const summary = getRateLimitSummary();
  const metrics = summary.categories[EXEMPT_CAT];
  assert.ok(metrics, `expected ${EXEMPT_CAT} in getRateLimitSummary categories`);
  assert.equal(metrics.exempt, true, "exempt flag lost in getRateLimitSummary");
  assert.equal(metrics.note, NOTE, "note lost in getRateLimitSummary");
  const control = summary.categories[CONTROL_CAT];
  assert.ok(control, `expected ${CONTROL_CAT} in getRateLimitSummary categories`);
  assert.equal(control.exempt, false, "control category exempt in summary");
});

check("computeEffectiveLimits exposes exempt + note per category", () => {
  const effective = computeEffectiveLimits({ admin: 2, account_manager: 1.5 });
  const cat = effective.categories[EXEMPT_CAT];
  assert.ok(cat, `expected ${EXEMPT_CAT} in computeEffectiveLimits categories`);
  assert.equal(cat.exempt, true, "exempt flag lost in computeEffectiveLimits");
  assert.equal(cat.note, NOTE, "note lost in computeEffectiveLimits");
  assert.equal(cat.base, 0, "exempt category base max is 0 (no limiter applies)");
  const control = effective.categories[CONTROL_CAT];
  assert.ok(control, `expected ${CONTROL_CAT} in computeEffectiveLimits categories`);
  assert.equal(control.exempt, false, "control category exempt in effective limits");
});

// ---------------------------------------------------------------------------
// Section 2 — the auto-tuner skips exempt categories in suggestions
// ---------------------------------------------------------------------------
console.log("\n[2] getTuningSuggestions skips exempt categories");

check("no suggestion is ever produced for the exempt category", () => {
  const { suggestions } = getTuningSuggestions();
  const exemptSuggestion = suggestions.find((s) => s.category === EXEMPT_CAT);
  assert.equal(
    exemptSuggestion,
    undefined,
    `getTuningSuggestions produced a suggestion for exempt category ${EXEMPT_CAT}: ` +
      JSON.stringify(exemptSuggestion),
  );
});

check("the non-exempt control category IS analyzed (filter is the exempt flag)", () => {
  const { suggestions } = getTuningSuggestions();
  const controlSuggestion = suggestions.find((s) => s.category === CONTROL_CAT);
  assert.ok(
    controlSuggestion,
    `getTuningSuggestions produced no suggestion for non-exempt ${CONTROL_CAT} — ` +
      "the exempt skip cannot be verified if analysis is broken for all categories",
  );
});

// ---------------------------------------------------------------------------
// Section 3 — the auto-tuner rejects applySuggestion for exempt categories
// ---------------------------------------------------------------------------
console.log("\n[3] applySuggestion rejects exempt categories");

check("applySuggestion returns a rejection error for the exempt category", () => {
  const historyBefore = getAdjustmentHistory().length;
  const result = applySuggestion(EXEMPT_CAT, 50, "task-2848-test");
  assert.equal(result.success, false, "applySuggestion succeeded for an exempt category");
  assert.ok(result.error, "rejection carries no error message");
  assert.match(
    result.error!,
    /exempt/i,
    `rejection error does not mention exemption: "${result.error}"`,
  );
  const cfgAfter = getLimiterConfigs().get(EXEMPT_CAT);
  assert.equal(cfgAfter!.max, 0, "exempt category max was mutated by a rejected applySuggestion");
  assert.equal(
    getAdjustmentHistory().length,
    historyBefore,
    "rejected applySuggestion recorded an adjustment in history",
  );
});

check("applySuggestion still rejects unknown categories distinctly", () => {
  const result = applySuggestion("test_no_such_category_2848", 50, "task-2848-test");
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /unknown/i);
});

// ---------------------------------------------------------------------------
// Section 4 — the real notifications_sse registration keeps exempt: true
// ---------------------------------------------------------------------------
console.log("\n[4] server/index.ts registers notifications_sse as exempt (source guard)");

check("registerLimiterConfig(\"notifications_sse\", ...) passes exempt: true + note", () => {
  // Task #3787: server/index.ts is a thin orchestrator over server/boot/*;
  // startup wiring may live in either, so scan the combined boot surface.
  const src = [
    "server/index.ts",
    ...fs.readdirSync(path.resolve("server/boot")).filter((n) => n.endsWith(".ts")).sort()
      .map((n) => `server/boot/${n}`),
  ].map((p) => fs.readFileSync(path.resolve(p), "utf-8")).join("\n");
  const callMatch = src.match(
    /registerLimiterConfig\(\s*["']notifications_sse["'][\s\S]*?\)\s*;/,
  );
  assert.ok(
    callMatch,
    "server/index.ts no longer registers a notifications_sse limiter config",
  );
  const call = callMatch[0];
  assert.match(
    call,
    /exempt:\s*true/,
    "notifications_sse registration lost `exempt: true` — the auto-tuner could now propose a real limit for the SSE endpoint",
  );
  assert.match(
    call,
    /note:\s*["'`]/,
    "notifications_sse registration lost its explanatory note",
  );
});

console.log("");
if (failures > 0) {
  console.error(`FAIL — ${failures} assertion group(s) failed.`);
  process.exit(1);
}
console.log("PASS — exempt categories keep their auto-tuner protection across all read surfaces.");
process.exit(0);
