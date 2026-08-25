/* test-registration
{
  "name": "Ris performance thresholds (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * RIS Performance Layer threshold engine + degrade-to-gray regression test
 * (Task #2371).
 *
 * The Performance Layer scores a single marketing-output metric into a
 * Green / Yellow / Red / Gray status from its period-over-period change vs
 * admin-tunable bands. `computePerformanceStatus` is pure (no DB / IO), so we
 * lock its contract directly here:
 *
 *   (1) volume (higher better): a drop past the yellow/red bands degrades.
 *   (2) cost   (lower  better): a RISE past the yellow/red bands degrades.
 *   (3) rate   (higher better): tighter default bands than volume.
 *   (4) budget (pacing): a single current value scored against the pacing
 *       window — no prior period, changePct stays null.
 *   (5) DEGRADE-TO-GRAY: missing current, missing/zero/too-low prior volume
 *       all park at Gray with a null changePct — NEVER a silent Green.
 *   (6) per-check override merges over the metric-type defaults.
 *   (7) the "red" status escalates exactly like a High/Critical Fail in the
 *       shared flag matrix (isFlagWorthy), and Green/Gray/N-A never flag.
 */

import assert from "node:assert/strict";

import { computePerformanceStatus, resolveBands } from "../server/services/ris/risThresholds";
import { isFlagWorthy } from "../server/services/ris/risFlagging";
import { isStatusValidForLayer } from "../shared/models/ris";

function runVolume() {
  // Healthy: flat or growing, and small drops inside the green band.
  assert.equal(computePerformanceStatus({ metricType: "volume", current: 110, previous: 100 }).status, "green");
  assert.equal(computePerformanceStatus({ metricType: "volume", current: 90, previous: 100 }).status, "green"); // -10%
  // Yellow: -15%..-25% drop.
  const y = computePerformanceStatus({ metricType: "volume", current: 80, previous: 100 });
  assert.equal(y.status, "yellow");
  assert.equal(y.changePct, -20);
  // Red: >25% drop.
  const r = computePerformanceStatus({ metricType: "volume", current: 70, previous: 100 });
  assert.equal(r.status, "red");
  assert.equal(r.changePct, -30);
  // Boundaries: a drop of EXACTLY the yellow/red band is the worse status
  // (green is strictly inside the yellow boundary; yellow includes the red edge).
  assert.equal(computePerformanceStatus({ metricType: "volume", current: 85, previous: 100 }).status, "yellow"); // -15% exactly
  assert.equal(computePerformanceStatus({ metricType: "volume", current: 75, previous: 100 }).status, "yellow"); // -25% exactly
  assert.equal(computePerformanceStatus({ metricType: "volume", current: 74, previous: 100 }).status, "red"); // -26%
  console.log("ris-perf volume bands: ok");
}

function runCost() {
  // Lower is better: a fall in cost is healthy.
  assert.equal(computePerformanceStatus({ metricType: "cost", current: 80, previous: 100 }).status, "green");
  // +15%..+30% rise -> yellow.
  assert.equal(computePerformanceStatus({ metricType: "cost", current: 125, previous: 100 }).status, "yellow");
  // >30% rise -> red.
  const r = computePerformanceStatus({ metricType: "cost", current: 140, previous: 100 });
  assert.equal(r.status, "red");
  assert.equal(r.changePct, 40);
  // Boundaries: +15% exactly is yellow (not green), +30% exactly is still
  // yellow, +31% tips to red.
  assert.equal(computePerformanceStatus({ metricType: "cost", current: 115, previous: 100 }).status, "yellow"); // +15%
  assert.equal(computePerformanceStatus({ metricType: "cost", current: 130, previous: 100 }).status, "yellow"); // +30%
  assert.equal(computePerformanceStatus({ metricType: "cost", current: 131, previous: 100 }).status, "red"); // +31%
  console.log("ris-perf cost bands: ok");
}

function runRate() {
  // Rate has tighter defaults: yellow at -10%, red at -20%.
  assert.equal(computePerformanceStatus({ metricType: "rate", current: 95, previous: 100 }).status, "green"); // -5%
  assert.equal(computePerformanceStatus({ metricType: "rate", current: 85, previous: 100 }).status, "yellow"); // -15%
  assert.equal(computePerformanceStatus({ metricType: "rate", current: 75, previous: 100 }).status, "red"); // -25%
  console.log("ris-perf rate bands: ok");
}

function runBudget() {
  // Budget pacing: single current value vs the pacing window. No prior, so
  // changePct is null for every verdict.
  const onPace = computePerformanceStatus({ metricType: "budget", current: 100 });
  assert.equal(onPace.status, "green");
  assert.equal(onPace.changePct, null);
  assert.equal(computePerformanceStatus({ metricType: "budget", current: 75 }).status, "yellow"); // modest under
  assert.equal(computePerformanceStatus({ metricType: "budget", current: 50 }).status, "red"); // material miss
  assert.equal(computePerformanceStatus({ metricType: "budget", current: 140 }).status, "red"); // material over
  console.log("ris-perf budget pacing: ok");
}

function runDegradeToGray() {
  // No current observation at all -> gray, never green.
  for (const mt of ["volume", "cost", "rate", "budget"] as const) {
    const v = computePerformanceStatus({ metricType: mt, current: null, previous: 100 });
    assert.equal(v.status, "gray", `${mt} with null current must be gray`);
    assert.equal(v.changePct, null);
  }
  // Missing / zero prior volume -> gray (can't trust a percentage), for the
  // change-based metrics.
  for (const mt of ["volume", "cost", "rate"] as const) {
    assert.equal(computePerformanceStatus({ metricType: mt, current: 100, previous: null }).status, "gray");
    assert.equal(computePerformanceStatus({ metricType: mt, current: 100, previous: 0 }).status, "gray");
  }
  // A NaN current is treated as no observation.
  assert.equal(computePerformanceStatus({ metricType: "volume", current: NaN, previous: 100 }).status, "gray");
  console.log("ris-perf degrade-to-gray: ok");
}

function runOverrideMerge() {
  // Override only the yellow boundary; red + budget bands keep defaults.
  const merged = resolveBands("volume", { yellow: 5 });
  assert.equal(merged.yellow, 5, "override yellow applied");
  assert.equal(merged.red, 25, "non-overridden red keeps default");
  // With a tighter yellow, a -10% drop now lands in yellow rather than green.
  const v = computePerformanceStatus({ metricType: "volume", current: 90, previous: 100, bands: { yellow: 5 } });
  assert.equal(v.status, "yellow");
  // minVolume override gates the comparison: prior at/below it -> gray.
  assert.equal(
    computePerformanceStatus({ metricType: "volume", current: 100, previous: 4, bands: { minVolume: 5 } }).status,
    "gray",
    "prior <= minVolume override must be gray",
  );
  console.log("ris-perf override merge: ok");
}

function runFlagSemantics() {
  // "red" escalates exactly like a High/Critical Fail.
  assert.equal(isFlagWorthy("red", "high"), true, "high red must flag");
  assert.equal(isFlagWorthy("red", "critical"), true, "critical red must flag");
  assert.equal(isFlagWorthy("red", "low"), false, "low red must not flag");
  assert.equal(isFlagWorthy("red", "medium"), false, "medium red must not flag");
  // Healthy / no-data statuses never flag.
  for (const status of ["green", "yellow", "gray", "na", null, undefined]) {
    assert.equal(isFlagWorthy(status, "critical"), false, `status=${status} must never flag`);
  }
  console.log("ris-perf flag semantics: ok");
}

function runLayerGuard() {
  // The result-save route accepts the wide risAllStatuses union, so the layer
  // guard (`isStatusValidForLayer`) is the only thing stopping a manual save
  // from cross-writing a status into the wrong layer. Lock its decisions.
  // Performance checks accept only the color statuses.
  for (const s of ["green", "yellow", "red", "gray", "na"]) {
    assert.equal(isStatusValidForLayer("performance", s), true, `performance must accept ${s}`);
  }
  // ...and reject QA vocabulary.
  for (const s of ["pass", "fail", "blocked", "needs_review", "n/a"]) {
    assert.equal(isStatusValidForLayer("performance", s), false, `performance must reject QA status ${s}`);
  }
  // QA checks accept the QA vocabulary and reject the color statuses.
  assert.equal(isStatusValidForLayer("qa", "pass"), true);
  assert.equal(isStatusValidForLayer("qa", "fail"), true);
  for (const s of ["green", "red", "yellow"]) {
    assert.equal(isStatusValidForLayer("qa", s), false, `qa must reject performance status ${s}`);
  }
  console.log("ris-perf layer guard: ok");
}

runVolume();
runCost();
runRate();
runBudget();
runDegradeToGray();
runOverrideMerge();
runFlagSemantics();
runLayerGuard();
console.log("ris-performance-thresholds: all cases passed");
