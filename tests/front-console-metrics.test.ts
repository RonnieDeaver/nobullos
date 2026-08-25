/* test-registration
{
  "name": "Front console metric definitions (Task #2505)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2691: the Front console metric definitions are the single source of truth for every console figure, now including the \"Bring it to 100%\" reachable (plan-limited-honest) target math. It was flagged regression-only and never selected by the gate, so a drift in the headline %, match-rate denominator, reconciliation identity, or the new reachable-ceiling math would rot silently. Gate it — fast, pure, in-memory (no DB/network).",
  "tier": "small"
}
test-registration */
/**
 * Task #2505 — Unit tests for the Front console metric definitions
 * (`shared/frontConsoleMetrics.ts`).
 *
 * Task #2502 made that module the single source of truth for every Front
 * console figure, imported by BOTH the server overview endpoint and the client
 * UI so the numbers can't drift. It is a set of pure functions over plain
 * histograms (no DB, no network), so this test exercises them directly.
 *
 * It locks in the exact bug fixes the module exists to enforce:
 *
 *   Bug A — match rate must be matched / matchable, where the denominator
 *   EXCLUDES operational/spam/blocked dismissals. Counting those in the
 *   denominator is what produced the misleading "~1%" headline.
 *
 *   Bug B — backlog must EXCLUDE terminal-done pipeline states
 *   (`applied`, `triage_dismissed`), so already-done rows never inflate it,
 *   while genuinely stuck states (failed, dead_lettered) still count.
 */

import {
  computeFrontMatchableStats,
  computeFrontBacklogCount,
  computeFrontAppliedDoneCount,
  FRONT_TERMINAL_DONE_PIPELINE_STATES,
  frontPlanLimitedFallback,
  FRONT_PLAN_LIMITED_REASON,
  FRONT_CONSOLE_LENSES,
  frontConsoleLens,
  FRONT_CONSOLE_METRIC_REGISTRY,
  getFrontConsoleMetric,
  frontConsoleMetricsForLens,
  computeFrontCoverageReconciliation,
  frontReconciliationSentence,
  frontPlanLimitState,
  FRONT_PIPELINE_BRIDGE_NOTE,
  FRONT_PLAN_LIMITED_MEMO_NOTE,
  computeFrontBringTo100Target,
  isFrontMonthSearchRecoverable,
  frontPercentDisplay,
  frontPercentOutOfRangeTitle,
  FRONT_PERCENT_NEEDS_RECOUNT_LABEL,
  FRONT_PERCENT_MISSING_TEXT,
  FRONT_PERCENT_DISPLAY_EPSILON,
} from "@shared/frontConsoleMetrics";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// computeFrontMatchableStats
// ---------------------------------------------------------------------------
console.log("\n— computeFrontMatchableStats —");

{
  // A realistic histogram: a handful of real matches, one awaiting, and a LARGE
  // pile of non-matchable dismissals (the shape that produced the bogus "~1%").
  const stats = computeFrontMatchableStats({
    auto_matched: 40,
    manually_matched: 10,
    unmatched: 50,
    dismissed: 850,
    blocked: 50,
  });

  check("matched = auto_matched + manually_matched", stats.matched === 50, `got ${stats.matched}`);
  check("unmatched counts only unmatched", stats.unmatched === 50, `got ${stats.unmatched}`);
  check(
    "matchable = matched + unmatched (excludes dismissals)",
    stats.matchable === 100,
    `got ${stats.matchable}`,
  );
  check(
    "nonMatchable = dismissed + blocked",
    stats.nonMatchable === 900,
    `got ${stats.nonMatchable}`,
  );
  check("trackedTotal counts every status", stats.trackedTotal === 1000, `got ${stats.trackedTotal}`);
  check(
    "Bug A — matchRate = matched/matchable (50/100 = 50%), NOT diluted by 900 dismissals",
    stats.matchRate === 50,
    `got ${stats.matchRate}%`,
  );
}

{
  // Zero matchable rows must give 0%, never a divide-by-zero NaN/Infinity.
  const stats = computeFrontMatchableStats({
    dismissed: 25,
    blocked: 5,
  });
  check("zero-matchable → matchable = 0", stats.matchable === 0, `got ${stats.matchable}`);
  check(
    "zero-matchable → matchRate = 0% (no NaN/Infinity)",
    stats.matchRate === 0 && Number.isFinite(stats.matchRate),
    `got ${stats.matchRate}`,
  );
}

{
  // matchRate rounds to a whole percent: 1 matched of 3 matchable = 33%.
  const stats = computeFrontMatchableStats({ auto_matched: 1, unmatched: 2 });
  check("matchRate rounds to whole percent (1/3 → 33%)", stats.matchRate === 33, `got ${stats.matchRate}`);
}

{
  // Unknown / unexpected status keys and missing keys are tolerated.
  const stats = computeFrontMatchableStats({ auto_matched: 5, some_future_status: 7 });
  check("unknown status counted only in trackedTotal", stats.trackedTotal === 12, `got ${stats.trackedTotal}`);
  check("unknown status NOT counted as matchable", stats.matchable === 5, `got ${stats.matchable}`);
  check("100% when every matchable row is matched", stats.matchRate === 100, `got ${stats.matchRate}`);
}

{
  // Empty histogram is fully defined and safe.
  const stats = computeFrontMatchableStats({});
  check(
    "empty histogram → all zeros, matchRate 0",
    stats.matched === 0 &&
      stats.unmatched === 0 &&
      stats.matchable === 0 &&
      stats.nonMatchable === 0 &&
      stats.trackedTotal === 0 &&
      stats.matchRate === 0,
    JSON.stringify(stats),
  );
}

// ---------------------------------------------------------------------------
// computeFrontBacklogCount  (Bug B)
// ---------------------------------------------------------------------------
console.log("\n— computeFrontBacklogCount —");

{
  const backlogs = {
    discovered: 10,
    matched: 5,
    failed: 3,
    dead_lettered: 2,
    applied: 1000,
    triage_dismissed: 500,
  };
  check(
    "Bug B — backlog excludes applied + triage_dismissed (10+5+3+2 = 20)",
    computeFrontBacklogCount(backlogs) === 20,
    `got ${computeFrontBacklogCount(backlogs)}`,
  );
}

{
  // failed and dead_lettered DO count — they still need attention.
  check(
    "failed + dead_lettered count as backlog",
    computeFrontBacklogCount({ failed: 4, dead_lettered: 6 }) === 10,
  );
}

{
  // A corpus that is entirely terminal-done has zero backlog.
  check(
    "all terminal-done → backlog 0",
    computeFrontBacklogCount({ applied: 999, triage_dismissed: 1 }) === 0,
  );
}

check("empty backlog histogram → 0", computeFrontBacklogCount({}) === 0);

// ---------------------------------------------------------------------------
// computeFrontAppliedDoneCount
// ---------------------------------------------------------------------------
console.log("\n— computeFrontAppliedDoneCount —");

{
  const backlogs = {
    discovered: 10,
    failed: 3,
    applied: 1000,
    triage_dismissed: 500,
  };
  check(
    "appliedDone = applied + triage_dismissed (1000+500 = 1500)",
    computeFrontAppliedDoneCount(backlogs) === 1500,
    `got ${computeFrontAppliedDoneCount(backlogs)}`,
  );
  check(
    "appliedDone ignores non-terminal states",
    computeFrontAppliedDoneCount({ discovered: 99 }) === 0,
  );
}

{
  // backlog and appliedDone are complementary partitions of the same histogram.
  const backlogs = {
    discovered: 10,
    matched: 5,
    failed: 3,
    dead_lettered: 2,
    applied: 1000,
    triage_dismissed: 500,
  };
  const total = Object.values(backlogs).reduce((a, b) => a + b, 0);
  check(
    "backlog + appliedDone = total pipeline rows (no row double-counted or dropped)",
    computeFrontBacklogCount(backlogs) + computeFrontAppliedDoneCount(backlogs) === total,
    `${computeFrontBacklogCount(backlogs)} + ${computeFrontAppliedDoneCount(backlogs)} vs ${total}`,
  );
}

check(
  "terminal-done set is exactly applied + triage_dismissed",
  FRONT_TERMINAL_DONE_PIPELINE_STATES.length === 2 &&
    FRONT_TERMINAL_DONE_PIPELINE_STATES.includes("applied") &&
    FRONT_TERMINAL_DONE_PIPELINE_STATES.includes("triage_dismissed"),
  FRONT_TERMINAL_DONE_PIPELINE_STATES.join(","),
);

// ---------------------------------------------------------------------------
// frontPlanLimitedFallback  (Task #2669)
// ---------------------------------------------------------------------------
console.log("\n— frontPlanLimitedFallback —");

{
  // A genuinely plan-limited month: the memo is set AND the denominator is a
  // conversation count (search fallback). It must produce a labeled,
  // conversation-grain fallback built from the conversation pair only.
  const fb = frontPlanLimitedFallback({
    analyticsPlanLimitedAt: "2026-01-01T00:00:00.000Z",
    denominatorUnit: "conversations_all",
    fetchedIntoNobull: 4_960,
    frontTotalMessages: 5_000,
    fetchedCoveragePct: 99.2,
  });
  check("plan-limited conversation month → non-null fallback", fb !== null);
  check(
    "covered/total come from the conversation pair (fetched of frontTotal)",
    fb?.coveredConversations === 4_960 && fb?.totalConversations === 5_000,
    JSON.stringify(fb),
  );
  check(
    "pct is the fetched-coverage % (conversation grain), not the applied %",
    fb?.coveragePct === 99.2,
    `got ${fb?.coveragePct}`,
  );
  check(
    "label states the conversation count + the plan reason",
    fb?.label === `4,960 of 5,000 conversations — ${FRONT_PLAN_LIMITED_REASON}`,
    fb?.label,
  );
}

{
  // The memo is set but the denominator is already message grain — NOT a
  // conversation fallback. Must be null so the month renders its message %.
  const fb = frontPlanLimitedFallback({
    analyticsPlanLimitedAt: "2026-01-01T00:00:00.000Z",
    denominatorUnit: "messages_all",
    fetchedIntoNobull: 100,
    frontTotalMessages: 120,
    fetchedCoveragePct: 83.3,
  });
  check("plan-limited memo but message-grain denominator → null", fb === null);
}

{
  // A search-fallback (conversations_all) month with NO plan-limit memo must
  // stay null — Task #2603 keeps non-plan-limited rows message-grain-only and
  // never relabels them with conversation vocabulary.
  const fb = frontPlanLimitedFallback({
    analyticsPlanLimitedAt: null,
    denominatorUnit: "conversations_all",
    fetchedIntoNobull: 10,
    frontTotalMessages: 12,
    fetchedCoveragePct: 83.3,
  });
  check("conversations_all without plan-limit memo → null (no relabel)", fb === null);
}

{
  // A normal message-grain month is never a fallback.
  const fb = frontPlanLimitedFallback({
    analyticsPlanLimitedAt: null,
    denominatorUnit: "messages_all",
    fetchedIntoNobull: 9_100,
    frontTotalMessages: 13_000,
    fetchedCoveragePct: 70.0,
  });
  check("healthy message-grain month → null", fb === null);
}

// ---------------------------------------------------------------------------
// Task #2685 — lens vocabulary, metric registry, reconciliation, plan-limit state
// ---------------------------------------------------------------------------

// --- Lens disambiguation ---------------------------------------------------
console.log("\n— FRONT_CONSOLE_LENSES (lens disambiguation) —");

{
  const lenses = [1, 2, 3] as const;
  for (const l of lenses) {
    check(`lens ${l} is registered`, FRONT_CONSOLE_LENSES[l]?.lens === l);
  }
  // The whole point: the three lenses ask three DIFFERENT questions and never
  // reuse the same "done" noun, so the same word can't mean two things on one
  // screen.
  const questions = lenses.map((l) => FRONT_CONSOLE_LENSES[l].question);
  check(
    "each lens asks a distinct question",
    new Set(questions).size === 3,
    questions.join(" | "),
  );
  const nouns = lenses.map((l) => FRONT_CONSOLE_LENSES[l].completenessNoun);
  check(
    "each lens uses a distinct completeness noun",
    new Set(nouns).size === 3,
    nouns.join(","),
  );
  check(
    "frontConsoleLens() resolves the same descriptor",
    frontConsoleLens(2).title === FRONT_CONSOLE_LENSES[2].title,
  );
  // Lens 1 (processing pipeline) and Lens 2 (ingestion coverage) must not
  // borrow each other's vocabulary — that overlap is the original bug.
  check(
    "lens 1 owns 'drained', not 'covered'",
    FRONT_CONSOLE_LENSES[1].completenessNoun === "drained",
  );
  check(
    "lens 2 owns 'covered', not 'drained'",
    FRONT_CONSOLE_LENSES[2].completenessNoun === "covered",
  );
}

// --- Metric registry -------------------------------------------------------
console.log("\n— FRONT_CONSOLE_METRIC_REGISTRY —");

{
  check("registry is non-empty", FRONT_CONSOLE_METRIC_REGISTRY.length > 0, `${FRONT_CONSOLE_METRIC_REGISTRY.length} metrics`);

  const ids = FRONT_CONSOLE_METRIC_REGISTRY.map((m) => m.id);
  check("every metric id is unique", new Set(ids).size === ids.length);

  // Every descriptor is fully specified — a half-filled descriptor is how a
  // figure silently drifts off its source/lens.
  const complete = FRONT_CONSOLE_METRIC_REGISTRY.every(
    (m) =>
      typeof m.id === "string" && m.id.length > 0 &&
      typeof m.question === "string" && m.question.length > 0 &&
      (m.lens === 1 || m.lens === 2 || m.lens === 3) &&
      typeof m.grain === "string" && m.grain.length > 0 &&
      typeof m.sourceTable === "string" && m.sourceTable.length > 0 &&
      typeof m.numerator === "string" && m.numerator.length > 0 &&
      typeof m.denominator === "string" && m.denominator.length > 0 &&
      typeof m.timeWindow === "string" && m.timeWindow.length > 0,
  );
  check("every descriptor is fully specified (no empty fields)", complete);

  // id namespace must match its lens so a renamed figure can't quietly land in
  // the wrong lens bucket.
  const NS: Record<number, string> = {
    1: "front.pipeline.",
    2: "front.coverage.",
    3: "front.recovery.",
  };
  const nsOk = FRONT_CONSOLE_METRIC_REGISTRY.every((m) => m.id.startsWith(NS[m.lens]));
  check("each metric id is namespaced by its lens", nsOk);

  check(
    "getFrontConsoleMetric() resolves a known id",
    getFrontConsoleMetric(ids[0]).id === ids[0],
  );
  let threw = false;
  try {
    getFrontConsoleMetric("front.does.not.exist");
  } catch {
    threw = true;
  }
  check("getFrontConsoleMetric() throws on an unknown id", threw);

  // frontConsoleMetricsForLens partitions the registry with no overlap/loss.
  const byLensTotal =
    frontConsoleMetricsForLens(1).length +
    frontConsoleMetricsForLens(2).length +
    frontConsoleMetricsForLens(3).length;
  check(
    "frontConsoleMetricsForLens partitions the whole registry",
    byLensTotal === FRONT_CONSOLE_METRIC_REGISTRY.length,
    `${byLensTotal} vs ${FRONT_CONSOLE_METRIC_REGISTRY.length}`,
  );
  check(
    "frontConsoleMetricsForLens(2) returns only lens-2 metrics",
    frontConsoleMetricsForLens(2).every((m) => m.lens === 2),
  );
}

// --- Coverage reconciliation identity --------------------------------------
console.log("\n— computeFrontCoverageReconciliation —");

{
  // The real all-time shape that confused operators: pipeline fully drained
  // (apply gap 0) yet only ~25% covered (huge ingest gap). Both true at once.
  const r = computeFrontCoverageReconciliation({
    frontTotal: 206_235,
    fetched: 51_405,
    applied: 51_405,
  });
  check("apply gap = fetched − applied (0 here)", r.applyGap === 0, `got ${r.applyGap}`);
  check(
    "ingest gap = frontTotal − fetched",
    r.ingestGap === 206_235 - 51_405,
    `got ${r.ingestGap}`,
  );
  check(
    "notInNobull = frontTotal − applied",
    r.notInNobull === 206_235 - 51_405,
    `got ${r.notInNobull}`,
  );
  check(
    "identity holds: applied + applyGap + ingestGap === frontTotal",
    r.applied + r.applyGap + r.ingestGap === r.frontTotal && r.identityHolds,
  );
  check(
    "appliedPct ≈ 24.9 (drained pipeline, low coverage — both consistent)",
    Math.abs(r.appliedPct - 24.92) < 0.1,
    `got ${r.appliedPct.toFixed(2)}`,
  );
}

{
  // A row where some fetched messages are not yet applied: both gaps positive.
  const r = computeFrontCoverageReconciliation({
    frontTotal: 1_000,
    fetched: 800,
    applied: 600,
  });
  check("applyGap = 200", r.applyGap === 200);
  check("ingestGap = 200", r.ingestGap === 200);
  check("identity holds with both gaps positive", r.identityHolds);
}

{
  // frontTotal 0 → no divide-by-zero, identity still holds trivially.
  const r = computeFrontCoverageReconciliation({ frontTotal: 0, fetched: 0, applied: 0 });
  check(
    "all-zero → 0% with no NaN, identity holds",
    r.appliedPct === 0 && r.fetchedPct === 0 && Number.isFinite(r.appliedPct) && r.identityHolds,
  );
}

{
  // Property: for any 0 ≤ applied ≤ fetched ≤ frontTotal the identity must hold.
  let allHold = true;
  for (let i = 0; i < 200; i++) {
    const frontTotal = Math.floor(Math.random() * 100_000);
    const fetched = Math.floor(Math.random() * (frontTotal + 1));
    const applied = Math.floor(Math.random() * (fetched + 1));
    const r = computeFrontCoverageReconciliation({ frontTotal, fetched, applied });
    if (!(r.identityHolds && r.applied + r.applyGap + r.ingestGap === r.frontTotal)) {
      allHold = false;
      break;
    }
  }
  check("property: identity holds across 200 random valid triples", allHold);
}

{
  // The plain-English sentence must be message-grain only (no "conversation"
  // vocabulary) so it can render unconditionally on the message-grain console.
  const sentence = frontReconciliationSentence(
    computeFrontCoverageReconciliation({ frontTotal: 206_235, fetched: 51_405, applied: 51_405 }),
  );
  check("sentence mentions the front total", sentence.includes("206,235"));
  check("sentence names the ingest gap", /ingest gap/i.test(sentence));
  check("sentence names the apply gap", /apply gap/i.test(sentence));
  check(
    "reconciliation sentence has NO conversation vocabulary",
    !/conversation/i.test(sentence),
    sentence,
  );
  check(
    "pipeline bridge note has NO conversation vocabulary",
    !/conversation/i.test(FRONT_PIPELINE_BRIDGE_NOTE),
  );
  check(
    "plan-limit memo note has NO conversation vocabulary",
    !/conversation/i.test(FRONT_PLAN_LIMITED_MEMO_NOTE),
  );
}

// --- Plan-limit state ------------------------------------------------------
console.log("\n— frontPlanLimitState —");

{
  check(
    "no memo → 'none'",
    frontPlanLimitState({ analyticsPlanLimitedAt: null, denominatorUnit: "messages_all" }) === "none",
  );
  check(
    "memo + conversation denominator → 'conversation-fallback'",
    frontPlanLimitState({
      analyticsPlanLimitedAt: "2026-01-01T00:00:00.000Z",
      denominatorUnit: "conversations_all",
    }) === "conversation-fallback",
  );
  check(
    "memo + message-grain denominator → 'message-grain-memoized'",
    frontPlanLimitState({
      analyticsPlanLimitedAt: "2026-01-01T00:00:00.000Z",
      denominatorUnit: "messages_all",
    }) === "message-grain-memoized",
  );
  check(
    "memo + inbound_messages denominator → 'message-grain-memoized'",
    frontPlanLimitState({
      analyticsPlanLimitedAt: "2026-01-01T00:00:00.000Z",
      denominatorUnit: "inbound_messages",
    }) === "message-grain-memoized",
  );
}

// --- Task #2691: "Bring it to 100%" reachable-target math -----------------
console.log("\n— computeFrontBringTo100Target —");

{
  // Empty input → all zeros, at target (nothing to do).
  const empty = computeFrontBringTo100Target([]);
  check("empty → 0 frontTotal", empty.frontTotal === 0);
  check("empty → loggedPct 0", empty.loggedPct === 0);
  check("empty → atReachableTarget true", empty.atReachableTarget === true);

  // Fully logged, no gaps → 100% logged, nothing remaining.
  const full = computeFrontBringTo100Target([
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 1000,
      appliedIntoNobull: 1000,
      ingestGap: 0,
      applyGap: 0,
      planLimited: false,
    },
  ]);
  check("full → 100% logged", Math.round(full.loggedPct) === 100);
  check("full → reachable 100%", Math.round(full.reachableTargetPct) === 100);
  check("full → no remaining work", full.reachableRemainingWork === 0, `${full.reachableRemainingWork}`);
  check("full → atReachableTarget", full.atReachableTarget === true);

  // Apply gap only (fetched > applied): always reachable (pure DB drain).
  const applyGap = computeFrontBringTo100Target([
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 800,
      appliedIntoNobull: 600,
      ingestGap: 200,
      applyGap: 200,
      planLimited: false,
    },
  ]);
  check("applyGap → logged 60%", Math.round(applyGap.loggedPct) === 60);
  check("applyGap → applyGap=200", applyGap.applyGap === 200, `${applyGap.applyGap}`);
  check(
    "applyGap → reachable ingest gap 200 (not plan-limited)",
    applyGap.reachableIngestGap === 200,
    `${applyGap.reachableIngestGap}`,
  );
  check(
    "applyGap → reachable 100% (apply+ingest both reachable)",
    Math.round(applyGap.reachableTargetPct) === 100,
    `${applyGap.reachableTargetPct}`,
  );
  check("applyGap → not at target", applyGap.atReachableTarget === false);

  // Plan-limited ingest gap caps the reachable ceiling below 100%.
  const planLimited = computeFrontBringTo100Target([
    // reachable month: fully logged
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 1000,
      appliedIntoNobull: 1000,
      ingestGap: 0,
      applyGap: 0,
      planLimited: false,
    },
    // plan-limited month: only 200 of 1000 fetched; 800 unreachable
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 200,
      appliedIntoNobull: 200,
      ingestGap: 800,
      applyGap: 0,
      planLimited: true,
    },
  ]);
  check("planLimited → frontTotal 2000", planLimited.frontTotal === 2000);
  check("planLimited → applied 1200", planLimited.applied === 1200);
  check("planLimited → logged 60%", Math.round(planLimited.loggedPct) === 60);
  check(
    "planLimited → remainder 800",
    planLimited.planLimitedRemainder === 800,
    `${planLimited.planLimitedRemainder}`,
  );
  check(
    "planLimited → reachable ingest gap 0 (gap is plan-limited)",
    planLimited.reachableIngestGap === 0,
  );
  check(
    "planLimited → reachable ceiling 60% (cannot exceed without Front upgrade)",
    Math.round(planLimited.reachableTargetPct) === 60,
    `${planLimited.reachableTargetPct}`,
  );
  check(
    "planLimited → no reachable work remains (don't spin forever)",
    planLimited.atReachableTarget === true,
  );
  check(
    "planLimited → remainder pct 40%",
    Math.round(planLimited.planLimitedRemainderPct) === 40,
    `${planLimited.planLimitedRemainderPct}`,
  );

  // Mixed: reachable ingest gap on a non-plan-limited month + plan-limited gap.
  const mixed = computeFrontBringTo100Target([
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 700,
      appliedIntoNobull: 700,
      ingestGap: 300,
      applyGap: 0,
      planLimited: false,
    },
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 100,
      appliedIntoNobull: 100,
      ingestGap: 900,
      applyGap: 0,
      planLimited: true,
    },
  ]);
  check(
    "mixed → reachable ingest gap 300",
    mixed.reachableIngestGap === 300,
    `${mixed.reachableIngestGap}`,
  );
  check(
    "mixed → plan-limited remainder 900",
    mixed.planLimitedRemainder === 900,
  );
  check(
    "mixed → reachable target (800+300)/2000 = 55%",
    Math.round(mixed.reachableTargetPct) === 55,
    `${mixed.reachableTargetPct}`,
  );
  check("mixed → reachable work remaining 300", mixed.reachableRemainingWork === 300);
  check("mixed → not at target", mixed.atReachableTarget === false);

  // Task #2705 — a plan-limited month whose conversation search can still
  // enumerate its messages (searchRecoverable:true) is reachable work the button
  // chases, NOT a plan-upgrade remainder. It must roll into
  // reachableRemainingWork / reachableTargetPct and OUT of planLimitedRemainder.
  const searchRecoverable = computeFrontBringTo100Target([
    // reachable month: fully logged
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 1000,
      appliedIntoNobull: 1000,
      ingestGap: 0,
      applyGap: 0,
      planLimited: false,
    },
    // plan-limited month, but search CAN still enumerate it → recoverable gap 800
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 200,
      appliedIntoNobull: 200,
      ingestGap: 800,
      applyGap: 0,
      planLimited: true,
      searchRecoverable: true,
    },
  ]);
  check(
    "searchRecoverable → searchRecoverableRemainder 800",
    searchRecoverable.searchRecoverableRemainder === 800,
    `${searchRecoverable.searchRecoverableRemainder}`,
  );
  check(
    "searchRecoverable → planLimitedRemainder 0 (not a plan-upgrade wall)",
    searchRecoverable.planLimitedRemainder === 0,
    `${searchRecoverable.planLimitedRemainder}`,
  );
  check(
    "searchRecoverable → reachable work remaining 800 (button chases it)",
    searchRecoverable.reachableRemainingWork === 800,
    `${searchRecoverable.reachableRemainingWork}`,
  );
  check(
    "searchRecoverable → reachable ceiling 100% (1200+800)/2000",
    Math.round(searchRecoverable.reachableTargetPct) === 100,
    `${searchRecoverable.reachableTargetPct}`,
  );
  check(
    "searchRecoverable → searchRecoverableRemainderPct 40%",
    Math.round(searchRecoverable.searchRecoverableRemainderPct) === 40,
    `${searchRecoverable.searchRecoverableRemainderPct}`,
  );
  check(
    "searchRecoverable → not at target (work remains)",
    searchRecoverable.atReachableTarget === false,
  );

  // Task #2705 — a plan-limited month split: part search-recoverable, part
  // genuinely unreachable (search itself plan-limits). Each gap lands in its own
  // bucket; only the truly-unreachable part needs a Front plan upgrade.
  const splitRemainder = computeFrontBringTo100Target([
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 600,
      appliedIntoNobull: 600,
      ingestGap: 400,
      applyGap: 0,
      planLimited: true,
      searchRecoverable: true,
    },
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 100,
      appliedIntoNobull: 100,
      ingestGap: 900,
      applyGap: 0,
      planLimited: true,
      searchRecoverable: false,
    },
  ]);
  check(
    "splitRemainder → searchRecoverableRemainder 400",
    splitRemainder.searchRecoverableRemainder === 400,
    `${splitRemainder.searchRecoverableRemainder}`,
  );
  check(
    "splitRemainder → planLimitedRemainder 900 (only the unreachable part)",
    splitRemainder.planLimitedRemainder === 900,
    `${splitRemainder.planLimitedRemainder}`,
  );
  check(
    "splitRemainder → reachable work remaining 400 (search-recoverable only)",
    splitRemainder.reachableRemainingWork === 400,
    `${splitRemainder.reachableRemainingWork}`,
  );

  // Task #2705 — backward-compat: a plan-limited month WITHOUT searchRecoverable
  // (field omitted) stays in planLimitedRemainder (conservative default).
  const planLimitedDefault = computeFrontBringTo100Target([
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 200,
      appliedIntoNobull: 200,
      ingestGap: 800,
      applyGap: 0,
      planLimited: true,
    },
  ]);
  check(
    "planLimitedDefault → planLimitedRemainder 800 (omitted searchRecoverable defaults unreachable)",
    planLimitedDefault.planLimitedRemainder === 800,
    `${planLimitedDefault.planLimitedRemainder}`,
  );
  check(
    "planLimitedDefault → searchRecoverableRemainder 0",
    planLimitedDefault.searchRecoverableRemainder === 0,
    `${planLimitedDefault.searchRecoverableRemainder}`,
  );
  check(
    "planLimitedDefault → at target (nothing reachable)",
    planLimitedDefault.atReachableTarget === true,
  );

  // Task #2745 — a NON-plan-limited month whose deep per-message search walk is
  // proven exhausted (deepSearchExhausted:true). Its residual ingest gap is
  // genuinely un-fetchable, so it lands in searchExhaustedRemainder and is
  // EXCLUDED from reachableRemainingWork — the button converges instead of
  // spinning forever on a gap no driver can close.
  const deepSearchExhausted = computeFrontBringTo100Target([
    // reachable month: fully logged
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 1000,
      appliedIntoNobull: 1000,
      ingestGap: 0,
      applyGap: 0,
      planLimited: false,
    },
    // non-plan-limited month, deep search exhausted → 800 un-fetchable
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 200,
      appliedIntoNobull: 200,
      ingestGap: 800,
      applyGap: 0,
      planLimited: false,
      deepSearchExhausted: true,
    },
  ]);
  check(
    "deepSearchExhausted → searchExhaustedRemainder 800",
    deepSearchExhausted.searchExhaustedRemainder === 800,
    `${deepSearchExhausted.searchExhaustedRemainder}`,
  );
  check(
    "deepSearchExhausted → NOT counted in reachable work (400? no — 0)",
    deepSearchExhausted.reachableRemainingWork === 0,
    `${deepSearchExhausted.reachableRemainingWork}`,
  );
  check(
    "deepSearchExhausted → planLimitedRemainder 0 (not a plan wall)",
    deepSearchExhausted.planLimitedRemainder === 0,
    `${deepSearchExhausted.planLimitedRemainder}`,
  );
  check(
    "deepSearchExhausted → searchRecoverableRemainder 0",
    deepSearchExhausted.searchRecoverableRemainder === 0,
    `${deepSearchExhausted.searchRecoverableRemainder}`,
  );
  check(
    "deepSearchExhausted → searchExhaustedRemainderPct 40%",
    Math.round(deepSearchExhausted.searchExhaustedRemainderPct) === 40,
    `${deepSearchExhausted.searchExhaustedRemainderPct}`,
  );
  check(
    "deepSearchExhausted → reachable ceiling 60% (can't exceed without the un-fetchable gap)",
    Math.round(deepSearchExhausted.reachableTargetPct) === 60,
    `${deepSearchExhausted.reachableTargetPct}`,
  );
  check(
    "deepSearchExhausted → at reachable target (don't spin on it)",
    deepSearchExhausted.atReachableTarget === true,
  );

  // Task #2745 — backward-compat: a NON-plan-limited month WITHOUT
  // deepSearchExhausted (field omitted) keeps its ingest gap in
  // reachableIngestGap (the button still chases it — default reachable).
  const deepSearchDefault = computeFrontBringTo100Target([
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 200,
      appliedIntoNobull: 200,
      ingestGap: 800,
      applyGap: 0,
      planLimited: false,
    },
  ]);
  check(
    "deepSearchDefault → searchExhaustedRemainder 0 (omitted defaults reachable)",
    deepSearchDefault.searchExhaustedRemainder === 0,
    `${deepSearchDefault.searchExhaustedRemainder}`,
  );
  check(
    "deepSearchDefault → reachable work remaining 800 (button still chases)",
    deepSearchDefault.reachableRemainingWork === 800,
    `${deepSearchDefault.reachableRemainingWork}`,
  );

  // Task #2745 — a plan-limited month that ALSO carries deepSearchExhausted is
  // still classified by the plan-limited branch (searchRecoverable), NOT
  // searchExhaustedRemainder — plan-limited precedence is preserved.
  const planLimitedTakesPrecedence = computeFrontBringTo100Target([
    {
      frontTotalMessages: 1000,
      fetchedIntoNobull: 200,
      appliedIntoNobull: 200,
      ingestGap: 800,
      applyGap: 0,
      planLimited: true,
      searchRecoverable: false,
      deepSearchExhausted: true,
    },
  ]);
  check(
    "planLimitedTakesPrecedence → planLimitedRemainder 800 (plan branch wins)",
    planLimitedTakesPrecedence.planLimitedRemainder === 800,
    `${planLimitedTakesPrecedence.planLimitedRemainder}`,
  );
  check(
    "planLimitedTakesPrecedence → searchExhaustedRemainder 0 (not double-classified)",
    planLimitedTakesPrecedence.searchExhaustedRemainder === 0,
    `${planLimitedTakesPrecedence.searchExhaustedRemainder}`,
  );

  // Reachable applied never exceeds frontTotal (clamp).
  const clamp = computeFrontBringTo100Target([
    {
      frontTotalMessages: 100,
      fetchedIntoNobull: 100,
      appliedIntoNobull: 50,
      ingestGap: 0,
      applyGap: 50,
      planLimited: false,
    },
  ]);
  check("clamp → reachableApplied ≤ frontTotal", clamp.reachableApplied <= clamp.frontTotal);
  check("clamp → reachable 100%", Math.round(clamp.reachableTargetPct) === 100);

  // Task #2705 — isFrontMonthSearchRecoverable: a plan-limited month is still
  // recoverable via conversation search UNLESS search itself hard-failed.
  check(
    "searchRecoverable helper → healthy row recoverable",
    isFrontMonthSearchRecoverable({
      frontAnalyticsStatus: "search",
      frontAnalyticsError: null,
    }) === true,
  );
  check(
    "searchRecoverable helper → null status recoverable",
    isFrontMonthSearchRecoverable({}) === true,
  );
  check(
    "searchRecoverable helper → auth_blocked NOT recoverable",
    isFrontMonthSearchRecoverable({
      frontAnalyticsStatus: "auth_blocked",
    }) === false,
  );
  check(
    "searchRecoverable helper → error status NOT recoverable",
    isFrontMonthSearchRecoverable({ frontAnalyticsStatus: "error" }) === false,
  );
  check(
    "searchRecoverable helper → search_failed error NOT recoverable",
    isFrontMonthSearchRecoverable({
      frontAnalyticsStatus: "search",
      frontAnalyticsError: "front_analytics_search_failed: 429 rate limited",
    }) === false,
  );

  // Task #2743 — a TRANSIENT transport abort/timeout is REACHABLE, not a plan
  // wall. This must hold even when it was persisted with status='error', both
  // for the going-forward `front_analytics_transport_failed` code AND for the
  // legacy `front_analytics_search_failed: ...transport error...` string that
  // the stuck Nov-2025 row carries. Otherwise the "Bring it to 100%" ceiling
  // stays parked at ~97% forever.
  check(
    "searchRecoverable helper → transport_failed code IS recoverable despite error status",
    isFrontMonthSearchRecoverable({
      frontAnalyticsStatus: "error",
      frontAnalyticsError:
        "front_analytics_transport_failed: Front search transport error after 4 retries on page 3: This operation was aborted",
    }) === true,
  );
  check(
    "searchRecoverable helper → legacy search_failed transport-abort string IS recoverable (Nov-2025 row)",
    isFrontMonthSearchRecoverable({
      frontAnalyticsStatus: "error",
      frontAnalyticsError:
        "front_analytics_search_failed: Front search transport error: This operation was aborted",
    }) === true,
  );
  check(
    "searchRecoverable helper → rate_limited code IS recoverable despite error status",
    isFrontMonthSearchRecoverable({
      frontAnalyticsStatus: "error",
      frontAnalyticsError: "front_analytics_rate_limited: 429 exhausted",
    }) === true,
  );
  check(
    "searchRecoverable helper → genuine query-shape 4xx (no transport phrase) stays NOT recoverable",
    isFrontMonthSearchRecoverable({
      frontAnalyticsStatus: "error",
      frontAnalyticsError:
        "front_analytics_search_failed: Front search failed (400): bad query",
    }) === false,
  );

  // ── Task #2722 — conversation-grain months must not double-count a long
  // conversation across the months it spans. A conversation active in, say,
  // April AND May is returned by BOTH months' /conversations/search, so each
  // month's conversation-grain denominator counts it. Summing those months
  // would count that one conversation twice in the aggregate ceiling. The
  // ceiling therefore EXCLUDES conversation-grain months (denominatorUnit =
  // conversations_all / inbound_conversations) and reports them as an honest
  // excluded-count, leaving only message-grain months in frontTotal.
  {
    // Two adjacent conversation-grain months, each whose search returned the
    // SAME long conversation (reflected in overlapping denominators). Neither
    // month may contribute to the message-grain ceiling.
    const twoConvMonths = computeFrontBringTo100Target([
      {
        frontTotalMessages: 8052, // April search _total (conversations)
        fetchedIntoNobull: 8011,
        appliedIntoNobull: 2136,
        ingestGap: 5916,
        applyGap: 5875,
        planLimited: false,
        denominatorUnit: "conversations_all",
      },
      {
        frontTotalMessages: 8314, // May search _total (conversations)
        fetchedIntoNobull: 8399,
        appliedIntoNobull: 1575,
        ingestGap: 6739,
        applyGap: 6824,
        planLimited: false,
        denominatorUnit: "conversations_all",
      },
    ]);
    check(
      "twoConvMonths → frontTotal 0 (both excluded, no cross-month double-count)",
      twoConvMonths.frontTotal === 0,
      `${twoConvMonths.frontTotal}`,
    );
    check(
      "twoConvMonths → applied 0 (conversation-grain numerators excluded)",
      twoConvMonths.applied === 0,
      `${twoConvMonths.applied}`,
    );
    check(
      "twoConvMonths → 2 conversation-grain months excluded",
      twoConvMonths.conversationGrainExcludedMonths === 2,
      `${twoConvMonths.conversationGrainExcludedMonths}`,
    );
    check(
      "twoConvMonths → excluded conversation count is the per-month sum, NOT folded into frontTotal",
      twoConvMonths.conversationGrainExcludedConversations === 8052 + 8314,
      `${twoConvMonths.conversationGrainExcludedConversations}`,
    );
    check(
      "twoConvMonths → no reachable work from excluded months (don't chase a double-counted ceiling)",
      twoConvMonths.reachableRemainingWork === 0,
      `${twoConvMonths.reachableRemainingWork}`,
    );

    // A message-grain month MIXED with the two conversation-grain months: only
    // the message-grain month feeds the ceiling; the conversation-grain pair is
    // still excluded (and still tallied), so the headline reflects message grain
    // exactly once.
    const mixedGrain = computeFrontBringTo100Target([
      {
        frontTotalMessages: 14994, // June, message grain
        fetchedIntoNobull: 14539,
        appliedIntoNobull: 14539,
        ingestGap: 455,
        applyGap: 0,
        planLimited: false,
        denominatorUnit: "messages_all",
      },
      {
        frontTotalMessages: 8052,
        fetchedIntoNobull: 8011,
        appliedIntoNobull: 2136,
        ingestGap: 5916,
        applyGap: 5875,
        planLimited: false,
        denominatorUnit: "conversations_all",
      },
      {
        frontTotalMessages: 8314,
        fetchedIntoNobull: 8399,
        appliedIntoNobull: 1575,
        ingestGap: 6739,
        applyGap: 6824,
        planLimited: false,
        denominatorUnit: "inbound_conversations",
      },
    ]);
    check(
      "mixedGrain → frontTotal is ONLY the message-grain month",
      mixedGrain.frontTotal === 14994,
      `${mixedGrain.frontTotal}`,
    );
    check(
      "mixedGrain → applied is ONLY the message-grain month",
      mixedGrain.applied === 14539,
      `${mixedGrain.applied}`,
    );
    check(
      "mixedGrain → 2 conversation-grain months still excluded",
      mixedGrain.conversationGrainExcludedMonths === 2,
      `${mixedGrain.conversationGrainExcludedMonths}`,
    );

    // Backward-compat: months WITHOUT a denominatorUnit (legacy callers / the
    // other unit tests above) are treated as message grain and count normally —
    // the exclusion only triggers on an explicit conversation-grain unit.
    const legacyNoUnit = computeFrontBringTo100Target([
      {
        frontTotalMessages: 1000,
        fetchedIntoNobull: 1000,
        appliedIntoNobull: 1000,
        ingestGap: 0,
        applyGap: 0,
        planLimited: false,
      },
    ]);
    check(
      "legacyNoUnit → counts normally (no denominatorUnit ⇒ message grain)",
      legacyNoUnit.frontTotal === 1000 &&
        legacyNoUnit.conversationGrainExcludedMonths === 0,
      `${legacyNoUnit.frontTotal}/${legacyNoUnit.conversationGrainExcludedMonths}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task #4367 — frontPercentDisplay: the clamped percent DISPLAY gate (audit
// P1-5: the console rendered a raw "903.6%"). Presentation only — these cases
// lock the display contract, not any computation.
// ---------------------------------------------------------------------------
console.log("\nfrontPercentDisplay (Task #4367):");
{
  // The audit's exact bug: an impossible ratio is flagged, never rendered raw.
  const bug = frontPercentDisplay(903.6, 1);
  check(
    "903.6 → out_of_range, text is the needs-recount label",
    bug.state === "out_of_range" && bug.text === FRONT_PERCENT_NEEDS_RECOUNT_LABEL,
    JSON.stringify(bug),
  );
  check(
    "903.6 → tooltip carries the raw value as evidence",
    bug.state === "out_of_range" && bug.title.includes("903.6"),
  );
  check(
    "903.6 → raw value preserved for diagnostics",
    bug.state === "out_of_range" && bug.raw === 903.6,
  );
  check(
    "out-of-range title helper names the raw value",
    frontPercentOutOfRangeTitle(903.6).includes("903.6"),
  );

  const negative = frontPercentDisplay(-3, 1);
  check(
    "-3 → out_of_range (a negative share is impossible)",
    negative.state === "out_of_range",
  );

  // Serialized-rounding slack: a hair over 100 clamps to 100, NOT flagged…
  const slack = frontPercentDisplay(100.04, 1);
  check(
    "100.04 (≤ epsilon) → ok, clamps to '100.0%'",
    slack.state === "ok" && slack.text === "100.0%" && slack.value === 100,
    JSON.stringify(slack),
  );
  // …but beyond the slack it is a real corruption signal.
  check(
    "100.06 (> epsilon) → out_of_range",
    frontPercentDisplay(100.06, 1).state === "out_of_range",
  );
  const negSlack = frontPercentDisplay(-0.02, 1);
  check(
    "-0.02 (≥ -epsilon) → ok, clamps to '0.0%'",
    negSlack.state === "ok" && negSlack.text === "0.0%" && negSlack.value === 0,
  );

  // Missing values render the console's "—" convention, never a fake 0%.
  for (const [label, v] of [
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const) {
    const d = frontPercentDisplay(v as number | null | undefined, 1);
    check(
      `${label} → missing '—'`,
      d.state === "missing" && d.text === FRONT_PERCENT_MISSING_TEXT,
    );
  }

  // In-range values render byte-identically to the pre-#4367 console at each
  // call site's precision: KPI tiles 0 digits, hero 1, coverage tables 2.
  check("80 @ 1 digit → '80.0%' (hero)", frontPercentDisplay(80, 1).text === "80.0%");
  check("67 @ 0 digits → '67%' (KPI tile)", frontPercentDisplay(67, 0).text === "67%");
  check(
    "6.5 @ 2 digits → '6.50%' (coverage table)",
    frontPercentDisplay(6.5, 2).text === "6.50%",
  );
  check("0 @ 1 digit → '0.0%'", frontPercentDisplay(0, 1).text === "0.0%");
  check("100 @ 1 digit → '100.0%'", frontPercentDisplay(100, 1).text === "100.0%");

  // Numeric strings (pg numeric columns serialize as strings) parse; junk is
  // missing, never coerced to a fake figure.
  check("'42.5' @ 1 digit → '42.5%'", frontPercentDisplay("42.5", 1).text === "42.5%");
  check("'903.6' string → out_of_range", frontPercentDisplay("903.6", 1).state === "out_of_range");
  check("'' → missing", frontPercentDisplay("", 1).state === "missing");
  check("'abc' → missing", frontPercentDisplay("abc", 1).state === "missing");

  // The epsilon itself is part of the display contract.
  check("epsilon = 0.05", FRONT_PERCENT_DISPLAY_EPSILON === 0.05);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
