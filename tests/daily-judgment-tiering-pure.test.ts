/* test-registration
{
  "name": "Daily judgment tiering pure helpers — tier decision, score honesty, carry-forward fingerprint, basis labels, availability manifest (Task #3697)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3697: Daily judgment tier/carry-forward policy core — comms→full, any-other-source→operational, truly-empty→skip; weekly-bucketed silence in the inputs fingerprint (quiet clients re-judge ~weekly, not daily); score sanitization (garbage → null, never a made-up mid-range); the manifest rules (missing ≠ evidence, silence = staleness risk, null ungroundable scores, operational confidence cap). Pure functions, DB-free, fast; a drift here mis-tiers or mis-fingerprints every client's daily health judgment and silently poisons the churn tools.",
  "tier": "small"
}
test-registration */
/**
 * Task #3697 — data-availability-aware daily judgments: pure helper rules.
 *
 * These four exported helpers are the policy core of "client health from
 * whatever data exists". A silent drift in any of them mis-tiers or
 * mis-fingerprints EVERY client's daily judgment:
 *
 *   1. `decideJudgmentTier` — comms in 30d → "full"; otherwise ANY of
 *      report / command panel / agent memory / open asks / RIS engagement
 *      → "operational"; literally nothing → null (the only true "No data").
 *   2. `sanitizeScoreValue` — sub-scores must be honest: only finite numbers
 *      pass; garbage/strings/NaN/Infinity/null/undefined persist as null,
 *      never a made-up mid-range number.
 *   3. `computeInputsFingerprint` — the carry-forward change detector. Same
 *      inputs → same hash (no daily AI burn for quiet clients); any source
 *      change → new hash; silence is bucketed WEEKLY so a quiet client still
 *      re-judges about once a week (15d vs 16d same bucket; 20d vs 21d
 *      crosses the 7-day boundary → different).
 *   4. `buildJudgmentBasis` / `buildDataAvailabilityManifest` — the stored
 *      "Based on / Missing" labels and the prompt manifest rules: missing
 *      data is never evidence, silence is a staleness risk (not a sentiment
 *      source), ungroundable scores must be null, confidence tied to basis
 *      completeness, and the operational-basis paragraph forbids fabricated
 *      relationship/sentiment findings (Task #98 guard, prompt side).
 *
 * DB-free logic, but importing the service module warms the pg pools through
 * its storage imports, so the suite closes them for a natural drain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import {
  decideJudgmentTier,
  sanitizeScoreValue,
  computeInputsFingerprint,
  deriveJudgmentRatingFacts,
  buildJudgmentBasis,
  buildDataAvailabilityManifest,
  type JudgmentSourceSignals,
  type JudgmentDataInventory,
} from "../server/services/dailyJudgment";
import { closeDbPools } from "../server/db";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Baseline: a client with nothing at all. */
function emptySources(): JudgmentSourceSignals {
  return {
    comms: { count24h: 0, count7d: 0, count30d: 0, lastCommAt: null },
    report: null,
    commandPanel: null,
    knowledge: { totalFacts: 0, latestFactSeenAt: null },
    openAsks: { activeCount: 0, latestUpdatedAt: null },
    ris: { resultCount: 0, latest: [] },
    // Task #4292 lifetime-context fields — empty here: the tier decision
    // never reads them, and "nothing at all" now includes no lifetime
    // history, no trajectory, no report history and no operator intel.
    lifetime: null,
    trajectory: [],
    reportHistory: [],
    intel: { count90d: 0, latestAt: null },
  };
}

function withComms(n: number): JudgmentSourceSignals {
  const s = emptySources();
  s.comms = { count24h: 1, count7d: Math.min(n, 3), count30d: n, lastCommAt: "2026-07-30T12:00:00.000Z" };
  return s;
}

function inventoryFor(sources: JudgmentSourceSignals, silenceDays: number | null, tier: "full" | "operational"): JudgmentDataInventory {
  const { basedOn, missing } = buildJudgmentBasis(sources, silenceDays);
  return {
    version: 2,
    tier,
    generatedAt: "2026-08-01T00:00:00.000Z",
    inputsFingerprint: computeInputsFingerprint(sources, silenceDays),
    basedOn,
    missing,
    silenceDays,
    sources,
    carriedForward: null,
  };
}

function testDecideJudgmentTier(): void {
  console.log("\ndecideJudgmentTier:");

  check("comms in 30d → full", decideJudgmentTier(withComms(5)) === "full");

  const commsAndReport = withComms(2);
  commsAndReport.report = { reportId: "r1", month: "2026-06", updatedAt: null };
  check("comms + report → still full (comms dominate)", decideJudgmentTier(commsAndReport) === "full");

  const reportOnly = emptySources();
  reportOnly.report = { reportId: "r1", month: "2026-06", updatedAt: null };
  check("report only → operational", decideJudgmentTier(reportOnly) === "operational");

  const panelOnly = emptySources();
  panelOnly.commandPanel = { lastUpdatedAt: null, lastReviewedAt: null };
  check("command panel only → operational", decideJudgmentTier(panelOnly) === "operational");

  const factsOnly = emptySources();
  factsOnly.knowledge = { totalFacts: 3, latestFactSeenAt: "2026-07-01T00:00:00.000Z" };
  check("agent memory only → operational", decideJudgmentTier(factsOnly) === "operational");

  const asksOnly = emptySources();
  asksOnly.openAsks = { activeCount: 1, latestUpdatedAt: "2026-07-01T00:00:00.000Z" };
  check("open asks only → operational", decideJudgmentTier(asksOnly) === "operational");

  const risOnly = emptySources();
  risOnly.ris = { resultCount: 1, latest: [{ key: "k", label: "L", status: "pass", period: "2026-07", notes: null }] };
  check("RIS engagement only → operational", decideJudgmentTier(risOnly) === "operational");

  check("nothing at all → null (true No data)", decideJudgmentTier(emptySources()) === null);
}

function testSanitizeScoreValue(): void {
  console.log("\nsanitizeScoreValue:");
  check("finite number passes", sanitizeScoreValue(42) === 42);
  check("zero passes (0 is a real score)", sanitizeScoreValue(0) === 0);
  check("negative passes", sanitizeScoreValue(-30) === -30);
  check("null → null", sanitizeScoreValue(null) === null);
  check("undefined → null", sanitizeScoreValue(undefined) === null);
  check("numeric string → null (never coerced)", sanitizeScoreValue("50") === null);
  check("NaN → null", sanitizeScoreValue(Number.NaN) === null);
  check("Infinity → null", sanitizeScoreValue(Number.POSITIVE_INFINITY) === null);
  check("object → null", sanitizeScoreValue({ score: 10 }) === null);
}

function testFingerprint(): void {
  console.log("\ncomputeInputsFingerprint:");

  const a = computeInputsFingerprint(withComms(4), 2);
  const b = computeInputsFingerprint(withComms(4), 2);
  check("identical inputs → identical hash", a === b);
  check("hash looks like sha256 hex", /^[0-9a-f]{64}$/.test(a));

  const c = computeInputsFingerprint(withComms(5), 2);
  check("comm count change → different hash", a !== c);

  const withReport = withComms(4);
  withReport.report = { reportId: "r1", month: "2026-06", updatedAt: "2026-07-01T00:00:00.000Z" };
  check("new report → different hash", computeInputsFingerprint(withReport, 2) !== a);

  const withNewFact = withComms(4);
  withNewFact.knowledge = { totalFacts: 1, latestFactSeenAt: "2026-07-15T00:00:00.000Z" };
  check("new agent-memory fact → different hash", computeInputsFingerprint(withNewFact, 2) !== a);

  // Silence bucketing: weekly. floor(15/7)=2 == floor(16/7)=2, but
  // floor(20/7)=2 != floor(21/7)=3 — a quiet client re-judges ~weekly.
  const quiet = emptySources();
  quiet.report = { reportId: "r1", month: "2026-06", updatedAt: null };
  check(
    "silence 15d vs 16d — same weekly bucket → same hash",
    computeInputsFingerprint(quiet, 15) === computeInputsFingerprint(quiet, 16),
  );
  check(
    "silence 20d vs 21d — crosses weekly bucket → different hash",
    computeInputsFingerprint(quiet, 20) !== computeInputsFingerprint(quiet, 21),
  );
  check(
    "never-any-comms (null) vs silence 0d → different hash",
    computeInputsFingerprint(quiet, null) !== computeInputsFingerprint(quiet, 0),
  );

  const cadenceSources = withComms(4);
  cadenceSources.lifetime = {
    firstCommAt: "2026-01-01T00:00:00.000Z",
    totalComms: 20,
    inboundComms: 10,
    outboundComms: 10,
    comms90d: 12,
    longestGapDays: 15,
  };
  const beforeThreshold = deriveJudgmentRatingFacts(cadenceSources, 15, 10, "2026-08-19");
  const afterThreshold = deriveJudgmentRatingFacts(cadenceSources, 16, 11, "2026-08-20");
  check("cadence fact is false at the historical baseline", beforeThreshold.silenceExceeded === false);
  check("cadence fact flips immediately after the historical baseline", afterThreshold.silenceExceeded === true);
  check(
    "threshold flip breaks carry-forward even inside one weekly silence bucket",
    computeInputsFingerprint(cadenceSources, 15, beforeThreshold) !==
      computeInputsFingerprint(cadenceSources, 16, afterThreshold),
  );

  // RIS results are keyed by key:status:period and sorted — array order noise
  // must not force a spurious regeneration.
  const risA = emptySources();
  risA.ris = {
    resultCount: 2,
    latest: [
      { key: "k1", label: "One", status: "pass", period: "2026-07", notes: null },
      { key: "k2", label: "Two", status: "fail", period: "2026-07", notes: "x" },
    ],
  };
  const risB = emptySources();
  risB.ris = {
    resultCount: 2,
    latest: [
      { key: "k2", label: "Two", status: "fail", period: "2026-07", notes: "different note" },
      { key: "k1", label: "One", status: "pass", period: "2026-07", notes: null },
    ],
  };
  check(
    "RIS order/notes noise → same hash (status matters, order doesn't)",
    computeInputsFingerprint(risA, 10) === computeInputsFingerprint(risB, 10),
  );
  const risC = emptySources();
  risC.ris = {
    resultCount: 2,
    latest: [
      { key: "k1", label: "One", status: "fail", period: "2026-07", notes: null },
      { key: "k2", label: "Two", status: "fail", period: "2026-07", notes: null },
    ],
  };
  check(
    "RIS status flip → different hash",
    computeInputsFingerprint(risA, 10) !== computeInputsFingerprint(risC, 10),
  );
}

function testBasisLabels(): void {
  console.log("\nbuildJudgmentBasis:");

  const rich = withComms(14);
  rich.report = { reportId: "r1", month: "2025-12", updatedAt: null };
  rich.knowledge = { totalFacts: 6, latestFactSeenAt: "2026-07-01T00:00:00.000Z" };
  rich.openAsks = { activeCount: 2, latestUpdatedAt: null };
  const richBasis = buildJudgmentBasis(rich, 0);
  check("14 comms label", richBasis.basedOn.includes("14 comms (30d)"), JSON.stringify(richBasis.basedOn));
  check("report month humanized (Dec 2025)", richBasis.basedOn.includes("Dec 2025 report"));
  check("agent memory label with fact count", richBasis.basedOn.includes("agent memory (6 facts)"));
  check("open asks on basedOn side", richBasis.basedOn.includes("2 open asks"));
  check("missing lists panel + RIS but NEVER open asks", richBasis.missing.includes("no command panel") && richBasis.missing.includes("no RIS engagement checks") && !richBasis.missing.some(m => m.includes("ask")));

  const quiet = emptySources();
  quiet.commandPanel = { lastUpdatedAt: null, lastReviewedAt: null };
  const quietBasis = buildJudgmentBasis(quiet, 45);
  check("silent client missing label carries silence days", quietBasis.missing.includes("no comms in 30d (silent 45d)"));
  const neverBasis = buildJudgmentBasis(quiet, null);
  check("never-matched client says so", neverBasis.missing.includes("no comms ever matched"));
  check("zero open asks → absent from BOTH sides", !quietBasis.basedOn.some(b => b.includes("ask")) && !quietBasis.missing.some(m => m.includes("ask")));
}

function testManifest(): void {
  console.log("\nbuildDataAvailabilityManifest:");

  const ops = emptySources();
  ops.report = { reportId: "r1", month: "2026-06", updatedAt: null };
  ops.commandPanel = { lastUpdatedAt: null, lastReviewedAt: null };
  const opsManifest = buildDataAvailabilityManifest(inventoryFor(ops, 60, "operational"));

  check("lists available report", opsManifest.includes("Latest monthly report: Jun 2026"));
  check("lists available command panel", opsManifest.includes("Command panel (strategic context): present"));
  check("missing block: treat as UNKNOWN, never as evidence", opsManifest.includes("treat as UNKNOWN — never as evidence of a problem"));
  check("missing-data-never-evidence rule", opsManifest.includes("Missing data is never itself evidence of a problem."));
  // Task #4292 recalibrated the silence wording: still staleness-not-
  // sentiment, now judged against the client's own cadence baseline.
  check("silence weighed as staleness risk, not sentiment", opsManifest.includes("no matched communications for 60 calendar days") && opsManifest.includes("disengagement risk") && opsManifest.includes("Never invent sentiment or motive from silence"));
  check("null-score honesty rule", opsManifest.includes("Output null for any score you cannot ground"));
  check("confidence tied to basis completeness", opsManifest.includes("Set confidenceLevel by basis completeness"));
  check("operational paragraph forbids fabricated relationship/sentiment", opsManifest.includes("THIS IS AN OPERATIONAL-BASIS JUDGMENT") && opsManifest.includes("Do NOT fabricate relationship or sentiment findings"));
  check("operational confidence capped below High", opsManifest.includes("confidenceLevel must be Low or Medium"));

  const never = emptySources();
  never.report = { reportId: "r1", month: "2026-06", updatedAt: null };
  const neverManifest = buildDataAvailabilityManifest(inventoryFor(never, null, "operational"));
  check("never-matched client gets operational-only framing", neverManifest.includes("never had matched communications"));

  const full = withComms(14);
  const fullManifest = buildDataAvailabilityManifest(inventoryFor(full, 0, "full"));
  check("full tier lists comm windows", fullManifest.includes("14 matched in last 30 days"));
  check("full tier has NO operational paragraph", !fullManifest.includes("OPERATIONAL-BASIS JUDGMENT"));
  check("full tier has NO silence block", !fullManifest.includes("relationship-staleness"));
}

async function main(): Promise<void> {
  testDecideJudgmentTier();
  testSanitizeScoreValue();
  testFingerprint();
  testBasisLabels();
  testManifest();

  // Importing the service module warms the pg pools via its storage imports;
  // close them so the suite drains naturally.
  await closeDbPools();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err);
  try { await closeDbPools(); } catch { /* best-effort */ }
  process.exitCode = 1;
});
