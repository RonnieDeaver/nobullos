/* test-registration
{
  "name": "Chart-targeting parseChartOrdinal phrasings (Task #2147)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2147 — direct unit coverage for `parseChartOrdinal`
 * (server/services/chartTargeting.ts).
 *
 * The chart-targeting guard that powers the CEO Pulse "Refine This Visual"
 * flow decides which chart the user named by parsing a 1-based chart
 * reference out of their free-text request. The existing route-level test
 * (tests/ceo-pulse-refine-mis-targeted-chart.test.ts, Task #2117) only
 * exercises the numeric "Chart 2" phrasing end to end. But the parser
 * accepts several other shapes a real user will type:
 *
 *   - the placeholder form the panel renders:  "{{chart-3}}"
 *   - the "#N" form:                            "chart #2"
 *   - the "number N" form:                      "chart number 2"
 *   - the ordinal-suffix form:                  "3rd chart"
 *   - the spelled-out ordinal form:             "second chart"
 *
 * None of those branches had direct coverage, so a regex tweak could
 * silently stop recognizing a phrasing real users type — making the guard
 * either over- or under-fire. This test calls `parseChartOrdinal`
 * directly and pins each accepted form to its correct 1-based number, plus
 * the no-reference case returning null.
 */
import { parseChartOrdinal } from "../server/services/chartTargeting";

let passed = 0;
let failed = 0;

function expectEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

console.log("chart-targeting parseChartOrdinal: numeric 'Chart N' form");
{
  expectEq(parseChartOrdinal("Chart 2"), 2, '"Chart 2" → 2');
  expectEq(parseChartOrdinal("make chart 1 navy"), 1, '"make chart 1 navy" → 1 (mid-sentence, case-insensitive)');
  expectEq(parseChartOrdinal("CHART 10 needs a fix"), 10, '"CHART 10 ..." → 10 (multi-digit, uppercase)');
}

console.log("chart-targeting parseChartOrdinal: '#N' and 'number N' forms");
{
  expectEq(parseChartOrdinal("chart #2"), 2, '"chart #2" → 2');
  expectEq(parseChartOrdinal("recolor chart # 3"), 3, '"chart # 3" (space after #) → 3');
  expectEq(parseChartOrdinal("chart number 4"), 4, '"chart number 4" → 4');
}

console.log("chart-targeting parseChartOrdinal: placeholder '{{chart-N}}' form");
{
  expectEq(parseChartOrdinal("{{chart-3}}"), 3, '"{{chart-3}}" → 3');
  expectEq(parseChartOrdinal("please update {{ chart-5 }} for me"), 5, '"{{ chart-5 }}" (inner spaces) → 5');
}

console.log("chart-targeting parseChartOrdinal: ordinal-suffix 'Nth chart' form");
{
  expectEq(parseChartOrdinal("3rd chart"), 3, '"3rd chart" → 3');
  expectEq(parseChartOrdinal("change the 1st chart"), 1, '"1st chart" → 1');
  expectEq(parseChartOrdinal("tweak the 2nd chart"), 2, '"2nd chart" → 2');
  expectEq(parseChartOrdinal("the 4th chart looks off"), 4, '"4th chart" → 4');
}

console.log("chart-targeting parseChartOrdinal: spelled-out ordinal 'second chart' form");
{
  expectEq(parseChartOrdinal("second chart"), 2, '"second chart" → 2');
  expectEq(parseChartOrdinal("make the first chart navy"), 1, '"first chart" → 1');
  expectEq(parseChartOrdinal("recolor the third chart"), 3, '"third chart" → 3');
  expectEq(parseChartOrdinal("the tenth chart"), 10, '"tenth chart" → 10');
}

console.log("chart-targeting parseChartOrdinal: no chart reference → null");
{
  expectEq(parseChartOrdinal("make it navy"), null, '"make it navy" (no reference) → null');
  expectEq(parseChartOrdinal(""), null, 'empty string → null');
  expectEq(parseChartOrdinal(undefined as unknown as string), null, "undefined → null (guarded)");
  expectEq(parseChartOrdinal("add a new chart"), null, '"add a new chart" (no number/ordinal) → null');
  expectEq(parseChartOrdinal("the second one"), null, '"the second one" (ordinal without the word "chart") → null');
}

if (failed > 0) {
  console.error(`chart-targeting parseChartOrdinal: FAILED (${failed} of ${passed + failed})`);
  process.exit(1);
}
console.log(`chart-targeting parseChartOrdinal: PASSED (${passed} assertions)`);
