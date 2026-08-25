/* test-registration
{
  "name": "Refine chart-targeting guard (Task #2114)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Refine chart-targeting regression coverage (Task #2114).
 *
 * Task #2112 fixed "Refine This Visual" editing the wrong chart by number.
 * The deterministic targeting guard now lives in
 * server/services/chartTargeting.ts so it can be exercised without an HTTP
 * request or an OpenAI round-trip. This test pins that fix:
 *
 *   (a) An in-place edit that correctly changes only the named chart
 *       (Chart 3) is saved, and the confirmation names Chart 3 + its title.
 *   (b) An edit that lands on a DIFFERENT chart than the one the user named
 *       is REFUSED — the stored charts are reverted and the message is the
 *       honest "didn't land on Chart N" refusal.
 *   (c) An in-place edit (no add/remove/merge wording) that drifts the chart
 *       COUNT is REFUSED and reverted.
 *
 * It also covers the supporting helpers parseChartOrdinal / stableStringify
 * and a few guard edge cases (structural request bypass, out-of-range, no
 * ordinal reference).
 */

import assert from "node:assert/strict";
import {
  parseChartOrdinal,
  stableStringify,
  evaluateChartTargeting,
  buildTargetingMessage,
} from "../server/services/chartTargeting";

function chart(title: string, subtitle?: string) {
  return {
    type: "bar",
    title,
    data: [{ label: "A", value: 1 }],
    ...(subtitle !== undefined ? { subtitle } : {}),
  };
}

// A fixed three-chart base. Charts render in array order, so index 2 = "Chart 3".
function baseCharts() {
  return [chart("Lead Volume"), chart("Conversion"), chart("Lead Sources")];
}

// Deep clone so a mutated "AI output" copy can't alias the input.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function run() {
  // ---- helper: parseChartOrdinal -----------------------------------------
  assert.equal(parseChartOrdinal("update chart 3 subtitle"), 3, "chart 3");
  assert.equal(parseChartOrdinal("change {{chart-2}} color"), 2, "{{chart-2}}");
  assert.equal(parseChartOrdinal("edit the third chart"), 3, "the third chart");
  assert.equal(parseChartOrdinal("tweak the 1st chart"), 1, "1st chart");
  assert.equal(parseChartOrdinal("chart #4 please"), 4, "chart #4");
  assert.equal(parseChartOrdinal("make it pop"), null, "no ordinal");
  assert.equal(parseChartOrdinal(""), null, "empty");

  // ---- helper: stableStringify (key-order independent) --------------------
  assert.equal(
    stableStringify({ b: 1, a: 2 }),
    stableStringify({ a: 2, b: 1 }),
    "key order should not affect equality",
  );
  assert.notEqual(
    stableStringify({ a: 1 }),
    stableStringify({ a: 2 }),
    "different values must differ",
  );

  // ---- (a) correct in-place edit of Chart 3 lands + is named -------------
  {
    const inputCharts = baseCharts();
    const aiCharts = clone(inputCharts);
    aiCharts[2].subtitle = "Where leads came from"; // only Chart 3 changed

    const result = evaluateChartTargeting({
      message: "update chart 3 subtitle",
      graphsEnabled: true,
      inputCharts,
      charts: aiCharts,
      chartWasModified: true,
    });

    assert.equal(result.chartWasModified, true, "(a) edit should be kept");
    assert.equal(result.targetingMismatchNumber, null, "(a) no mismatch");
    assert.ok(result.targetedChart, "(a) targetedChart set");
    assert.equal(result.targetedChart!.number, 3, "(a) names Chart 3");
    assert.equal(result.targetedChart!.title, "Lead Sources", "(a) names title");
    assert.equal(result.charts[2].subtitle, "Where leads came from", "(a) edit persists");

    const msg = buildTargetingMessage(result);
    assert.ok(msg && msg.includes("Chart 3"), "(a) confirmation names Chart 3");
    assert.ok(msg!.includes("Lead Sources"), "(a) confirmation names the title");
    assert.ok(/Updated Chart 3/.test(msg!), "(a) confirmation is an Updated message");
  }

  // ---- (b) edit lands on the WRONG chart -> refused + reverted -----------
  {
    const inputCharts = baseCharts();
    const aiCharts = clone(inputCharts);
    aiCharts[0].subtitle = "Oops, edited Chart 1 instead"; // wrong chart changed

    const result = evaluateChartTargeting({
      message: "update chart 3 subtitle",
      graphsEnabled: true,
      inputCharts,
      charts: aiCharts,
      chartWasModified: true,
    });

    assert.equal(result.chartWasModified, false, "(b) mis-targeted edit not kept");
    assert.equal(result.targetingMismatchNumber, 3, "(b) mismatch flags Chart 3");
    assert.equal(result.targetedChart, null, "(b) no targetedChart");
    // Reverted to the original, untouched charts.
    assert.equal(
      stableStringify(result.charts),
      stableStringify(inputCharts),
      "(b) charts reverted to input (nothing saved)",
    );

    const msg = buildTargetingMessage(result);
    assert.ok(msg && msg.includes("didn't land on Chart 3"), "(b) honest refusal");
    assert.ok(msg!.includes("nothing was saved"), "(b) states nothing saved");
    assert.ok(!/Updated Chart/.test(msg!), "(b) not an Updated confirmation");
  }

  // ---- (c) in-place edit drifts the chart COUNT -> refused + reverted ----
  {
    const inputCharts = baseCharts();
    const aiCharts = clone(inputCharts);
    aiCharts.push(chart("Surprise extra chart")); // count drifted 3 -> 4

    const result = evaluateChartTargeting({
      message: "update chart 3 subtitle", // NOT a structural (add/remove) request
      graphsEnabled: true,
      inputCharts,
      charts: aiCharts,
      chartWasModified: true,
    });

    assert.equal(result.chartWasModified, false, "(c) count-drift edit not kept");
    assert.equal(result.targetingMismatchNumber, 3, "(c) mismatch flags Chart 3");
    assert.equal(result.targetedChart, null, "(c) no targetedChart");
    assert.equal(result.charts.length, inputCharts.length, "(c) count reverted");
    assert.equal(
      stableStringify(result.charts),
      stableStringify(inputCharts),
      "(c) charts reverted to input",
    );

    const msg = buildTargetingMessage(result);
    assert.ok(msg && msg.includes("didn't land on Chart 3"), "(c) honest refusal");
  }

  // ---- edge: structural request legitimately changes count, guard skips --
  {
    const inputCharts = baseCharts();
    const aiCharts = clone(inputCharts);
    aiCharts.push(chart("Newly added chart")); // count change is intended

    const result = evaluateChartTargeting({
      message: "add a new chart after chart 3",
      graphsEnabled: true,
      inputCharts,
      charts: aiCharts,
      chartWasModified: true,
    });

    // Structural ("add") request: positional guard does not run, edit stands.
    assert.equal(result.chartWasModified, true, "(edge) structural add kept");
    assert.equal(result.targetingMismatchNumber, null, "(edge) no mismatch");
    assert.equal(result.charts.length, 4, "(edge) added chart preserved");
    assert.equal(buildTargetingMessage(result), null, "(edge) no targeting message");
  }

  // ---- edge: no chart number referenced -> guard is inert ---------------
  {
    const inputCharts = baseCharts();
    const aiCharts = clone(inputCharts);
    aiCharts[0].subtitle = "changed something"; // unnamed chart

    const result = evaluateChartTargeting({
      message: "make the visuals pop more",
      graphsEnabled: true,
      inputCharts,
      charts: aiCharts,
      chartWasModified: true,
    });

    assert.equal(result.chartWasModified, true, "(edge) no-ordinal edit kept");
    assert.equal(result.targetingMismatchNumber, null, "(edge) no mismatch");
    assert.equal(result.targetedChart, null, "(edge) no targetedChart");
  }

  // ---- edge: referenced chart number out of range -> guard inert --------
  {
    const inputCharts = baseCharts();
    const aiCharts = clone(inputCharts);
    aiCharts[0].subtitle = "changed Chart 1";

    const result = evaluateChartTargeting({
      message: "update chart 9 subtitle", // only 3 charts exist
      graphsEnabled: true,
      inputCharts,
      charts: aiCharts,
      chartWasModified: true,
    });

    assert.equal(result.chartWasModified, true, "(edge) out-of-range guard inert");
    assert.equal(result.targetingMismatchNumber, null, "(edge) no mismatch");
  }

  console.log("refine-chart-targeting: all assertions passed");
}

run();
