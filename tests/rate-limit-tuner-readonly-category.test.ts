/* test-registration
{
  "name": "Tuner-read-only rate-limit categories are invisible to the auto-tuner (Task #2883)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2883: background_polling is a real (enforcing) limiter that the auto-tuner must never suggest for or mutate — it is a non-interactive safety-net bucket whose steady polling traffic would mislead interactive tuning heuristics. Locks the tunerReadOnly flag across getLimiterConfigs / summary / effective-limits, the getTuningSuggestions skip, the applySuggestion reject, and the real registration in server/index.ts (source guard). Fast, in-memory, rejection paths only (no persistence).",
  "scanPaths": [
    "server/boot",
    "server/index.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2883 — The auto-tuner must never treat the background_polling bucket
 * as an interactive bucket.
 *
 * Task #2880 moved the bell/activity polling endpoints into their own
 * `background_polling` limiter, but the bucket was registered like any
 * interactive bucket, so the auto-tuner would analyze its steady polling
 * traffic with interactive heuristics and could suggest or apply limit
 * changes. Task #2883 adds `tunerReadOnly` to `registerLimiterConfig`:
 * the limit is still enforced (unlike `exempt`), but the tuner skips the
 * category in `getTuningSuggestions` and rejects it in `applySuggestion`.
 * This test locks the server-side contract:
 *
 *   1. `registerLimiterConfig(..., { tunerReadOnly: true, note })` flows into
 *      `getLimiterConfigs`, `getRateLimitSummary`, and
 *      `computeEffectiveLimits` (flag + note present in each; exempt stays
 *      false so the limit remains enforced).
 *   2. `getTuningSuggestions` never returns a suggestion for a
 *      tuner-read-only category (control: a plain category registered the
 *      same way IS suggested, proving the filter is the flag).
 *   3. `applySuggestion` for a tuner-read-only category returns a rejection
 *      error, mutates nothing, and records no adjustment.
 *   4. The REAL `background_polling` registration in server/index.ts still
 *      passes `tunerReadOnly: true` with a note (static source guard).
 *
 * Server-side only by design (the RateLimitDashboard is never mounted).
 * In-memory limiter maps are per-process, so registering synthetic
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

const READONLY_CAT = "test_tuner_readonly_2883";
const CONTROL_CAT = "test_control_cat_2883";
const NOTE = "Tuner-read-only test category — enforced limit, never auto-tuned (Task #2883 fixture)";

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

console.log("=== Rate-limit tuner-read-only category protection (Task #2883) ===");

// ---------------------------------------------------------------------------
// Section 1 — registration flows into every read surface
// ---------------------------------------------------------------------------
console.log("\n[1] registerLimiterConfig({ tunerReadOnly, note }) flows into read surfaces");

registerLimiterConfig(READONLY_CAT, 15 * 60 * 1000, 120, true, {
  tunerReadOnly: true,
  note: NOTE,
});
registerLimiterConfig(CONTROL_CAT, 15 * 60 * 1000, 100, true);

check("getLimiterConfigs carries tunerReadOnly + note (and exempt stays false)", () => {
  const cfg = getLimiterConfigs().get(READONLY_CAT);
  assert.ok(cfg, `expected ${READONLY_CAT} in getLimiterConfigs`);
  assert.equal(cfg!.tunerReadOnly, true, "tunerReadOnly flag lost in getLimiterConfigs");
  assert.equal(cfg!.exempt, false, "tuner-read-only category must NOT be exempt — its limit is enforced");
  assert.equal(cfg!.max, 120, "tuner-read-only category keeps a real max (limit still enforced)");
  assert.equal(cfg!.note, NOTE, "note lost in getLimiterConfigs");
});

check("getLimiterConfigs defaults tunerReadOnly=false for a plain registration", () => {
  const cfg = getLimiterConfigs().get(CONTROL_CAT);
  assert.ok(cfg, `expected ${CONTROL_CAT} in getLimiterConfigs`);
  assert.equal(cfg!.tunerReadOnly, false, "control category must not be tuner-read-only");
});

check("getRateLimitSummary exposes tunerReadOnly + note (dashboard badge source)", () => {
  const summary = getRateLimitSummary();
  const metrics = summary.categories[READONLY_CAT];
  assert.ok(metrics, `expected ${READONLY_CAT} in getRateLimitSummary categories`);
  assert.equal(metrics.tunerReadOnly, true, "tunerReadOnly flag lost in getRateLimitSummary");
  assert.equal(metrics.exempt, false, "tuner-read-only must not read as exempt in summary");
  assert.equal(metrics.maxRequests, 120, "summary must show the enforced limit for the bucket");
  assert.equal(metrics.note, NOTE, "note lost in getRateLimitSummary");
  const control = summary.categories[CONTROL_CAT];
  assert.ok(control, `expected ${CONTROL_CAT} in getRateLimitSummary categories`);
  assert.equal(control.tunerReadOnly, false, "control category tunerReadOnly in summary");
});

check("computeEffectiveLimits exposes tunerReadOnly + note per category", () => {
  const effective = computeEffectiveLimits({ admin: 2, account_manager: 1.5 });
  const cat = effective.categories[READONLY_CAT];
  assert.ok(cat, `expected ${READONLY_CAT} in computeEffectiveLimits categories`);
  assert.equal(cat.tunerReadOnly, true, "tunerReadOnly flag lost in computeEffectiveLimits");
  assert.equal(cat.exempt, false, "tuner-read-only must not read as exempt in effective limits");
  assert.equal(cat.base, 120, "base max must remain the enforced limit");
  assert.equal(cat.note, NOTE, "note lost in computeEffectiveLimits");
});

// ---------------------------------------------------------------------------
// Section 2 — the auto-tuner skips tuner-read-only categories in suggestions
// ---------------------------------------------------------------------------
console.log("\n[2] getTuningSuggestions skips tuner-read-only categories");

check("no suggestion is ever produced for the tuner-read-only category", () => {
  const { suggestions } = getTuningSuggestions();
  const suggestion = suggestions.find((s) => s.category === READONLY_CAT);
  assert.equal(
    suggestion,
    undefined,
    `getTuningSuggestions produced a suggestion for tuner-read-only category ${READONLY_CAT}: ` +
      JSON.stringify(suggestion),
  );
});

check("the plain control category IS analyzed (filter is the tunerReadOnly flag)", () => {
  const { suggestions } = getTuningSuggestions();
  const controlSuggestion = suggestions.find((s) => s.category === CONTROL_CAT);
  assert.ok(
    controlSuggestion,
    `getTuningSuggestions produced no suggestion for plain ${CONTROL_CAT} — ` +
      "the tuner-read-only skip cannot be verified if analysis is broken for all categories",
  );
});

// ---------------------------------------------------------------------------
// Section 3 — the auto-tuner rejects applySuggestion for tuner-read-only
// ---------------------------------------------------------------------------
console.log("\n[3] applySuggestion rejects tuner-read-only categories");

check("applySuggestion returns a rejection error for the tuner-read-only category", () => {
  const historyBefore = getAdjustmentHistory().length;
  const result = applySuggestion(READONLY_CAT, 200, "task-2883-test");
  assert.equal(result.success, false, "applySuggestion succeeded for a tuner-read-only category");
  assert.ok(result.error, "rejection carries no error message");
  assert.match(
    result.error!,
    /read-only/i,
    `rejection error does not mention read-only: "${result.error}"`,
  );
  const cfgAfter = getLimiterConfigs().get(READONLY_CAT);
  assert.equal(cfgAfter!.max, 120, "tuner-read-only category max was mutated by a rejected applySuggestion");
  assert.equal(
    getAdjustmentHistory().length,
    historyBefore,
    "rejected applySuggestion recorded an adjustment in history",
  );
});

// ---------------------------------------------------------------------------
// Section 4 — the real background_polling registration keeps tunerReadOnly
// ---------------------------------------------------------------------------
console.log("\n[4] server/index.ts registers background_polling as tuner-read-only (source guard)");

check("registerLimiterConfig(\"background_polling\", ...) passes tunerReadOnly: true + note", () => {
  // Task #3787: server/index.ts is a thin orchestrator over server/boot/*;
  // startup wiring may live in either, so scan the combined boot surface.
  const src = [
    "server/index.ts",
    ...fs.readdirSync(path.resolve("server/boot")).filter((n) => n.endsWith(".ts")).sort()
      .map((n) => `server/boot/${n}`),
  ].map((p) => fs.readFileSync(path.resolve(p), "utf-8")).join("\n");
  const callMatch = src.match(
    /registerLimiterConfig\(\s*["']background_polling["'][\s\S]*?\)\s*;/,
  );
  assert.ok(
    callMatch,
    "server/index.ts no longer registers a background_polling limiter config",
  );
  const call = callMatch[0];
  assert.match(
    call,
    /tunerReadOnly:\s*true/,
    "background_polling registration lost `tunerReadOnly: true` — the auto-tuner could now treat the non-interactive polling bucket as an interactive one",
  );
  assert.match(
    call,
    /note:\s*["'`]/,
    "background_polling registration lost its explanatory note",
  );
  assert.doesNotMatch(
    call,
    /exempt:\s*true/,
    "background_polling must NOT be exempt — its 120 req/15min limit is enforced",
  );
});

console.log("");
if (failures > 0) {
  console.error(`FAIL — ${failures} assertion group(s) failed.`);
  process.exit(1);
}
console.log("PASS — tuner-read-only categories are invisible to the auto-tuner across all surfaces.");
process.exit(0);
