/* test-registration
{
  "name": "Ads OS hygiene audit — config lockstep (25 checks, POL removed), impact-weighted scoring/dynamic caps/bands, next-steps tiers + QS step, LSA VER/POL/BUD/PERF semantics + gates, stale-audit 7d boundary, HTML export escaping (Task #3599)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3599: Ads OS hygiene audit engine — checks.yaml/weights.yaml port lockstep (every configured check implemented, POL stays removed), the impact-weighted scoring + dynamic critical caps + bands, next-steps tier placement, and the LSA VER-01 \"only real failures gate\" semantics. Pure functions, DB-free; a drift silently mis-scores every account's audit.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS Phase 3 — hygiene audit engine, pure unit tests (Task #3599).
 *
 * Guards the pieces ported verbatim from the bundle's backend/app/audit/* and
 * backend/app/lsa/hygiene.py:
 *   (a) config lockstep — every configured check (checks.yaml port) has an
 *       implementation in ALL_CHECKS and an explicit impact tier in the
 *       weights (weights.yaml port); POL stays removed on both sides;
 *   (b) scoring math — status→score map, N/A exclusion, impact-weighted
 *       category/overall averages, dynamic critical caps (65/−10/floor 10),
 *       cap application, band thresholds;
 *   (c) next-steps summary — SPECS tier placement fires on the right
 *       statuses, and the KWS-01/02 Quality Score step aggregates the three
 *       QS factors worst-first;
 *   (d) LSA checks — VER-01 (only FAILED/NO_SUBMISSION are real failures;
 *       blank/legacy statuses stay informational), POL-01, BUD-02 scale vs
 *       underspend advice, PERF-01/PERF-02 thresholds, LSA gates and fixed
 *       next-step placement (OKAY on a critical check files as FYI);
 *   (e) stale-audit staleness boundary (7 days);
 *   (f) standalone HTML export — score colors, file-name sanitizing, HTML
 *       escaping of account-supplied strings.
 *
 * DB-free, network-free (pure functions over synthetic inputs).
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

// Dynamic imports so the env pin above lands before module-load-time env reads.
const { ALL_CHECKS } = await import("../server/services/adsOs/audit/checks/index");
const { CHECKS_BY_CATEGORY } = await import("../server/services/adsOs/audit/checksConfig");
const { WEIGHTS } = await import("../server/services/adsOs/audit/weightsConfig");
const { dynamicCap, impactLevel, impactWeight, isCriticalImpact } = await import(
  "../server/services/adsOs/audit/configLoader"
);
const { applyCaps, bandFor, buildCategories, categoryScore, evaluateCaps, overallScore, statusToScore } =
  await import("../server/services/adsOs/audit/scoring");
const { Status } = await import("../server/services/adsOs/audit/models");
type CheckResultT = import("../server/services/adsOs/audit/models").CheckResult;
type StatusT = import("../server/services/adsOs/audit/models").Status;
const { buildNextSteps } = await import("../server/services/adsOs/audit/summary");
type AuditContextT = import("../server/services/adsOs/audit/context").AuditContext;
const lsa = await import("../server/services/adsOs/lsaHygieneEngine");
const { isInactiveScore, isStale, STALE_DAYS } = await import("../server/services/adsOs/staleAudits");
const { renderReportHtml, safeFileName, scoreColor } = await import(
  "../server/services/adsOs/reportHtml"
);
const { LSA_ANSWER_RATE_GOOD, LSA_LEAD_QUALITY_GOOD } = await import(
  "../server/services/adsOs/config"
);

function chk(id: string, status: StatusT, over: Partial<CheckResultT> = {}): CheckResultT {
  const na = status === Status.NA;
  return {
    id,
    category: id.split("-")[0],
    name: `${id} name`,
    status,
    score: statusToScore(status),
    weight: na ? 0 : impactWeight(id),
    impact: impactLevel(id),
    value: `${id} value`,
    evidence: [],
    recommendation: "",
    ...over,
  };
}

// ── (a) Config lockstep: checks.yaml port ⇄ implementations ⇄ weights.yaml port ──
{
  const configured = new Set<string>();
  for (const items of Object.values(CHECKS_BY_CATEGORY)) {
    for (const item of items as Array<{ id: string }>) configured.add(item.id);
  }
  const implemented = new Set(ALL_CHECKS.map(([id]) => id));
  assert.equal(implemented.size, ALL_CHECKS.length, "no duplicate check registrations");
  assert.deepEqual(
    [...implemented].sort(),
    [...configured].sort(),
    "every configured check is implemented and vice versa"
  );
  assert.equal(configured.size, 25, "25 checks after the POL removal (team re-tier)");

  for (const id of implemented) {
    assert.ok(id in WEIGHTS.impact, `${id} has an explicit impact tier in the weights config`);
    const cat = id.split("-")[0];
    assert.ok(WEIGHTS.categories[cat], `${id}'s category ${cat} has a display name`);
    assert.ok(!id.startsWith("POL"), "POL checks stay removed (owned by the alerts engine)");
  }
  assert.ok(!("POL" in WEIGHTS.categories), "POL category removed from weights");
  console.log("  ✓ config lockstep: 25 checks, ids ⇄ impls ⇄ impact tiers, POL removed");
}

// ── (b) Scoring math ─────────────────────────────────────────────────────────
{
  // status→score straight from the weights config
  assert.equal(statusToScore(Status.GOOD), 100);
  assert.equal(statusToScore(Status.OKAY), 60);
  assert.equal(statusToScore(Status.BAD), 20);
  assert.equal(statusToScore(Status.CRITICAL), 0);
  assert.equal(statusToScore(Status.NA), null);

  // N/A is excluded from the average entirely (weight 0 AND status filter)
  assert.equal(categoryScore([chk("GEO-01", Status.GOOD), chk("GEO-02", Status.NA)]), 100);
  assert.equal(categoryScore([chk("GEO-01", Status.NA)]), 0, "all-NA category scores 0");

  // Impact-weighted: GEO-01 critical(12)×100 + KWS-01 high(6)×20 → 1320/18 = 73.3
  const mixed = [chk("GEO-01", Status.GOOD), chk("KWS-01", Status.BAD)];
  assert.equal(overallScore(mixed), 73.3, "flat impact-weighted average, round1");

  // buildCategories: worst-first ordering + weight = category share of total
  const cats = buildCategories(mixed);
  assert.deepEqual(
    cats.map((c) => c.code),
    ["KWS", "GEO"],
    "worst category first"
  );
  assert.equal(cats[0].score, 20);
  assert.equal(cats[1].weight, Math.round((12 / 18) * 10000) / 10000, "share of total weight");
  assert.equal(cats[1].name, WEIGHTS.categories.GEO.name, "display name from weights");

  // Dynamic caps: 65 base, −10 per additional failing critical, floor 10
  assert.equal(dynamicCap([]), null);
  assert.equal(dynamicCap(["GEO-01"]), 65);
  assert.equal(dynamicCap(["GEO-01", "STR-01"]), 55);
  assert.equal(dynamicCap(["a", "b", "c", "d", "e", "f", "g"]), 10, "floored at 10");

  // evaluateCaps: only critical-IMPACT checks failing (bad/critical status) gate;
  // okay never gates; non-critical impact never gates.
  assert.ok(isCriticalImpact("BID-01") && !isCriticalImpact("KWS-01"), "impact tiers sane");
  const byId = new Map<string, CheckResultT>([
    ["STR-01", chk("STR-01", Status.BAD)], // critical impact, failing → gates
    ["GEO-01", chk("GEO-01", Status.CRITICAL)], // critical impact, failing → gates
    ["BID-01", chk("BID-01", Status.OKAY)], // critical impact but OKAY → no gate
    ["KWS-01", chk("KWS-01", Status.BAD)], // high impact → no gate
  ]);
  const [issues, cap] = evaluateCaps(byId);
  assert.equal(cap, 55, "two failing criticals → 65 − 10");
  assert.deepEqual(
    issues.map((g) => g.id),
    ["GEO-01", "STR-01"],
    "sorted by source for display"
  );
  assert.equal(issues[0].cap, 55, "each issue carries the shared effective cap");
  assert.equal(issues[0].reason, "GEO-01 value", "reason is the check's measured value");

  // applyCaps + bands
  assert.equal(applyCaps(83.4, 65), 65);
  assert.equal(applyCaps(52.34, null), 52.3);
  assert.deepEqual(bandFor(95), ["Excellent", "green"]);
  assert.deepEqual(bandFor(75), ["Healthy", "green"]);
  assert.deepEqual(bandFor(74.9), ["Needs Attention", "yellow"]);
  assert.deepEqual(bandFor(59.9), ["At Risk", "orange"]);
  assert.deepEqual(bandFor(0), ["Critical", "red"]);
  console.log("  ✓ scoring: status map, N/A exclusion, weighted avgs, caps 65/−10/10, bands");
}

// ── (c) Next-steps summary (SPECS tiers + QS factor step) ────────────────────
{
  const byId = new Map<string, CheckResultT>([
    ["GEO-01", chk("GEO-01", Status.CRITICAL)], // fires critical: "Set location targeting"
    ["GEO-02", chk("GEO-02", Status.GOOD)], // healthy → no step
    ["ADS-01", chk("ADS-01", Status.OKAY)], // fires easy on OKAY too
    ["BID-02", chk("BID-02", Status.BAD)], // fires week (long_term)
    ["ADS-02", chk("ADS-02", Status.CRITICAL)], // week spec fires on CRITICAL as well
  ]);
  const ctxNoQs = { keywords: [] } as unknown as AuditContextT;
  const steps = buildNextSteps(byId, ctxNoQs);
  assert.deepEqual(
    steps.critical.map((s) => s.title),
    ["Set location targeting"]
  );
  assert.equal(steps.critical[0].source, "GEO-01");
  assert.equal(steps.critical[0].detail, "GEO-01 value", "detail is the measured value");
  assert.deepEqual(steps.easy_wins.map((s) => s.source), ["ADS-01"]);
  assert.deepEqual(steps.long_term.map((s) => s.source).sort(), ["ADS-02", "BID-02"]);

  // QS step: avg < 7 over scored keywords → unshifted into long_term with the
  // three factors worst-first and zero-count factors dropped.
  const kw = (qs: number, lp: string, ctr: string, rel: string) => ({
    quality_score: qs,
    landing_page: lp,
    expected_ctr: ctr,
    ad_relevance: rel,
  });
  const ctxQs = {
    keywords: [
      kw(4, "BELOW_AVERAGE", "AVERAGE", "AVERAGE"),
      kw(5, "BELOW_AVERAGE", "BELOW_AVERAGE", "AVERAGE"),
      kw(0, "AVERAGE", "AVERAGE", "AVERAGE"), // unscored: excluded from the avg
    ],
  } as unknown as AuditContextT;
  const withQs = buildNextSteps(byId, ctxQs);
  const qsStep = withQs.long_term[0];
  assert.equal(qsStep.title, "Raise Quality Score (avg 4.5/10)", "avg over scored kws only");
  assert.equal(qsStep.source, "KWS-01 · KWS-02", "chip navigates to both QS checks");
  assert.equal(qsStep.points.length, 2, "zero-count ad-relevance factor dropped");
  assert.match(qsStep.points[0], /^Landing page experience — 2 keyword/);
  assert.match(qsStep.points[1], /^Expected CTR — 1 keyword/);

  // avg ≥ 7 → no QS step
  const ctxHealthy = {
    keywords: [kw(8, "AVERAGE", "AVERAGE", "AVERAGE")],
  } as unknown as AuditContextT;
  assert.equal(
    buildNextSteps(new Map(), ctxHealthy).long_term.length,
    0,
    "healthy QS adds nothing"
  );
  console.log("  ✓ next steps: SPECS tier placement + QS factor step (worst-first, avg-gated)");
}

// ── (d) LSA hygiene checks ───────────────────────────────────────────────────
{
  type Artifact = import("../server/services/adsOs/lsaHygieneEngine").VerificationArtifact;
  const art = (over: Partial<Artifact>): Artifact => ({
    artifact_id: "1",
    artifact_type: "LICENSE",
    status: "PASSED",
    creation_ms: 1,
    expiration: null,
    license_type: null,
    rejection_reason: null,
    ...over,
  });

  // VER-01: no artifacts → informational OKAY (never a gate)
  const none = lsa.checkVerification([]);
  assert.equal(none.status, Status.OKAY);
  assert.equal(none.value, "No verification artifacts found");

  // Real failure (FAILED / NO_SUBMISSION) → CRITICAL (this is the only gate path)
  const failed = lsa.checkVerification([
    art({ status: "FAILED", rejection_reason: "DOCUMENT_EXPIRED", license_type: "Bar License" }),
  ]);
  assert.equal(failed.status, Status.CRITICAL);
  assert.match(failed.value, /not passing/);
  assert.match(failed.evidence[0].detail ?? "", /status FAILED · document expired/);

  // A current PASSED supersedes older failed/cancelled submissions of the same type
  const superseded = lsa.checkVerification([
    art({ status: "FAILED", creation_ms: 1 }),
    art({ status: "PASSED", creation_ms: 2, artifact_id: "2" }),
  ]);
  assert.equal(superseded.status, Status.GOOD);
  assert.match(superseded.value, /All verification passing \(License\)/);

  // Latest current submission decides: newer PENDING outranks older FAILED
  const pending = lsa.checkVerification([
    art({ status: "FAILED", creation_ms: 1 }),
    art({ status: "PENDING", creation_ms: 2, artifact_id: "2" }),
  ]);
  assert.equal(pending.status, Status.OKAY, "pending is a monitor-note, not a failure");
  assert.match(pending.value, /verification pending/);

  // Blank/legacy status (UNSPECIFIED) → informational note, never critical
  const blank = lsa.checkVerification([art({ status: "UNSPECIFIED" })]);
  assert.equal(blank.status, Status.OKAY);
  assert.match(blank.value, /status not reported by the API/);

  // Only superseded (CANCELLED) submissions on file → informational note
  const cancelledOnly = lsa.checkVerification([art({ status: "CANCELLED" })]);
  assert.equal(cancelledOnly.status, Status.OKAY);
  assert.equal(cancelledOnly.evidence[0].detail, "only superseded (cancelled) submissions on file");

  // POL-01: primary_status of ENABLED campaigns
  type Camp = import("../server/services/adsOs/lsaHygieneEngine").LsaCampaignRow;
  const camp = (over: Partial<Camp>): Camp => ({
    campaign_id: "9",
    name: "LSA",
    status: "ENABLED",
    primary_status: "ELIGIBLE",
    primary_status_reasons: [],
    ...over,
  });
  assert.equal(lsa.checkPolicy([]).status, Status.NA, "no enabled campaign → N/A");
  assert.equal(lsa.checkPolicy([camp({ status: "PAUSED", primary_status: "NOT_ELIGIBLE" })]).status, Status.NA);
  const notEligible = lsa.checkPolicy([
    camp({ primary_status: "NOT_ELIGIBLE", primary_status_reasons: ["BUDGET_CONSTRAINED"] }),
  ]);
  assert.equal(notEligible.status, Status.BAD);
  assert.match(notEligible.evidence[0].detail ?? "", /NOT_ELIGIBLE: budget constrained/);
  assert.equal(lsa.checkPolicy([camp({ primary_status: "UNDER_REVIEW" })]).status, Status.OKAY);
  assert.equal(lsa.checkPolicy([camp({})]).status, Status.GOOD);

  // BUD-02: spend vs monthly budget (≥90% scale · ≥60% ease · <60% underspend)
  assert.equal(lsa.checkMonthlySpend(1000, null, "USD").status, Status.NA);
  const scale = lsa.checkMonthlySpend(950, 1000, "USD");
  assert.equal(scale.status, Status.GOOD);
  assert.match(scale.recommendation, /budget increase/);
  assert.match(scale.value, /spent 950 USD of 1,000 USD \(95%\)/);
  assert.equal(lsa.checkMonthlySpend(700, 1000, "USD").status, Status.OKAY);
  const under = lsa.checkMonthlySpend(300, 1000, "USD");
  assert.equal(under.status, Status.BAD);
  assert.match(under.recommendation, /Underspending/);

  // PERF-01: answer rate (green when the ROUNDED % ≥ threshold, default 95)
  assert.equal(lsa.checkAnswerRate({ rate: null, connected: 0, calls: 0 }).status, Status.NA);
  assert.equal(
    lsa.checkAnswerRate({ rate: LSA_ANSWER_RATE_GOOD, connected: 19, calls: 20 }).status,
    Status.GOOD
  );
  const nearThresholdAnswer = lsa.checkAnswerRate({ rate: 94.7, connected: 36, calls: 38 });
  assert.equal(
    nearThresholdAnswer.status,
    Status.GOOD,
    "94.7% rounds to 95% → matches the 95% threshold, should pass"
  );
  assert.match(nearThresholdAnswer.value, /^95% answered/);
  const lowAnswer = lsa.checkAnswerRate({ rate: LSA_ANSWER_RATE_GOOD - 5, connected: 18, calls: 20 });
  assert.equal(lowAnswer.status, Status.OKAY);
  assert.match(lowAnswer.recommendation, new RegExp(`below ${Math.round(LSA_ANSWER_RATE_GOOD)}%`));

  // PERF-02: charged ÷ total leads (green when the ROUNDED % ≥ threshold, default 80)
  type Lead = import("../server/services/adsOs/lsaHygieneEngine").LeadRow;
  const leads = (charged: number, total: number): Lead[] =>
    Array.from({ length: total }, (_, i) => ({
      lead_id: String(i),
      charged: i < charged,
      lead_type: "PHONE_CALL",
      creation_dt: "",
    }));
  assert.equal(lsa.checkLeadQuality([], 0, "USD").status, Status.OKAY, "no leads → advisory");
  assert.equal(lsa.checkLeadQuality(leads(9, 10), 900, "USD").status, Status.GOOD, "90% > 80%");
  const atThreshold = lsa.checkLeadQuality(leads(8, 10), 800, "USD");
  assert.equal(atThreshold.status, Status.GOOD, `exactly ${LSA_LEAD_QUALITY_GOOD}% matches the threshold → passes`);
  assert.match(atThreshold.value, /80% billable \(8 charged of 10 leads\) · CPL 100 USD/);
  const nearThresholdLeads = lsa.checkLeadQuality(leads(83, 104), 8300, "USD");
  assert.equal(
    nearThresholdLeads.status,
    Status.GOOD,
    "83/104 = 79.8% rounds to 80% → matches the 80% threshold, should pass"
  );
  assert.match(nearThresholdLeads.value, /^80% billable/);

  // LSA gates: only critical-impact failing checks trip; OKAY never does
  const verCrit = lsa.checkVerification([art({ status: "FAILED" })]);
  const polBad = lsa.checkPolicy([camp({ primary_status: "SUSPENDED" })]);
  const [gates, cap] = lsa.lsaGates([verCrit, polBad, lsa.checkMonthlySpend(300, 1000, "USD")]);
  assert.equal(cap, 55, "two failing criticals → 65 − 10 (BUD-02 bad is high impact, no gate)");
  assert.deepEqual(gates.map((g) => g.id).sort(), ["POL-01", "VER-01"]);
  assert.deepEqual(lsa.lsaGates([lsa.checkVerification([art({ status: "PENDING" })])]), [[], null]);

  // LSA next steps: fixed placement; OKAY on a critical check is an FYI (long_term)
  const steps = lsa.lsaNextSteps([
    verCrit, // critical status → Critical tier
    lsa.checkVerification([art({ status: "PENDING" })]), // OKAY → long_term (FYI)
    under, // BUD-02 → easy wins
    lsa.checkAnswerRate({ rate: 99, connected: 99, calls: 100 }), // GOOD, no rec → nowhere
  ]);
  assert.deepEqual(steps.critical.map((s) => s.source), ["VER-01"]);
  assert.deepEqual(steps.easy_wins.map((s) => s.source), ["BUD-02"]);
  assert.deepEqual(steps.long_term.map((s) => s.source), ["VER-01"]);

  // Category assembly: manual/all-NA categories sort last, otherwise worst-first
  const cats = lsa.buildLsaCategories([
    lsa.checkVerification([art({})]), // VER good (100)
    lsa.checkPolicy([]), // POL N/A
    under, // BUD bad (20)
  ]);
  assert.deepEqual(cats.map((c) => c.code), ["BUD", "VER", "POL"], "worst first, all-NA last");
  assert.equal(cats.find((c) => c.code === "POL")!.score, 0);
  console.log("  ✓ LSA: VER-01 failure semantics, POL/BUD/PERF thresholds, gates, step tiers");
}

// ── (e) Stale-audit staleness ────────────────────────────────────────────────
{
  const now = Date.parse("2026-07-27T12:00:00Z");
  const days = (n: number) => new Date(now - n * 86400_000).toISOString();
  assert.equal(STALE_DAYS, 7);
  assert.equal(isStale(null, now), true, "never audited → stale");
  assert.equal(isStale("not-a-date", now), true, "unparseable → stale");
  assert.equal(isStale(days(6), now), false);
  assert.equal(isStale(days(7), now), false, "exactly 7 days is NOT yet stale (strict >)");
  assert.equal(isStale(days(7.01), now), true);
  console.log("  ✓ staleness: 7-day boundary, null/garbage → stale");

  // Inactive scores (fully-paused account) are treated as always-fresh by the
  // stale sweep — nothing scannable to audit (Task #3623).
  assert.equal(isInactiveScore({ band: "Inactive", generated_at: days(30) }), true);
  assert.equal(isInactiveScore({ band: "Critical" }), false);
  assert.equal(isInactiveScore({}), false);
  console.log("  ✓ staleness: Inactive scores skipped by the stale sweep");

  // LSA fully-paused scope (Task #3627): campaigns exist but none is ENABLED
  // → Inactive; an errored (empty) campaign pull must NOT read as inactive,
  // and any ENABLED campaign keeps the account scannable.
  const camp = (status: string) => ({ status });
  assert.equal(lsa.lsaScopeInactive([camp("PAUSED"), camp("REMOVED")]), true, "all paused/removed → inactive");
  assert.equal(lsa.lsaScopeInactive([]), false, "empty pull (errored/none) is NOT inactive");
  assert.equal(lsa.lsaScopeInactive([camp("PAUSED"), camp("ENABLED")]), false, "one enabled → scannable");
  console.log("  ✓ LSA: fully-paused scope → Inactive band; empty pull excluded");
}

// ── (f) Standalone HTML export ───────────────────────────────────────────────
{
  assert.equal(scoreColor(75), "#16a34a");
  assert.equal(scoreColor(60), "#ca8a04");
  assert.equal(scoreColor(40), "#ea7317");
  assert.equal(scoreColor(39.9), "#b91c1c");

  assert.equal(safeFileName("Smith & Wesson, PLLC", "123"), "Smith  Wesson PLLC");
  assert.equal(safeFileName("///", "1234567890"), "1234567890", "all-symbols → cid fallback");

  const report: import("../server/services/adsOs/audit/models").AuditReport = {
    customer_id: "1234567890",
    account_name: `Smith & Co <Law>`,
    generated_at: "2026-07-27T14:02:00Z",
    lookback_days: 30,
    raw_score: 83.4,
    final_score: 65,
    band: "Needs Attention",
    band_color: "yellow",
    gates_triggered: [
      { id: "GEO-01", source: "GEO-01", cap: 65, reason: `No location targeting & "open" geo` },
    ],
    next_steps: {
      critical: [{ title: "Set location targeting", detail: "d", source: "GEO-01", points: [] }],
      easy_wins: [],
      long_term: [],
    },
    categories: [
      {
        code: "GEO",
        name: "Targeting & Geo Integrity",
        weight: 1,
        score: 40,
        checks: [chk("GEO-01", Status.CRITICAL, { value: `bad & <script>` })],
      },
    ],
  };
  const html = renderReportHtml(report);
  assert.match(html, /Smith &amp; Co &lt;Law&gt;/, "account name HTML-escaped");
  assert.match(html, /bad &amp; &lt;script&gt;/, "check values HTML-escaped");
  assert.ok(!html.includes("<script>"), "no raw account-supplied HTML");
  assert.match(html, /<svg/, "gauge SVG present");
  assert.match(html, /capped at 65/, "binding gate banner");
  assert.match(html, /Jul 27, 2026 14:02 UTC/, "generated-at formatting");
  assert.match(html, /123-456-7890/, "customer id formatted");
  assert.match(html, /Set location targeting/, "next steps rendered");
  console.log("  ✓ HTML export: colors, safe filenames, escaping, gauge, gate banner");

  // Inactive (fully-paused) account: no gauge/score — a plain "Inactive"
  // label plus the scope note (Task #3623).
  const inactive: import("../server/services/adsOs/audit/models").AuditReport = {
    ...report,
    raw_score: 0,
    final_score: 0,
    band: "Inactive",
    band_color: "slate",
    scope_note: "No active labeled campaigns in scope — all labeled campaigns are paused, ended, or dormant.",
    gates_triggered: [],
  };
  const inactiveHtml = renderReportHtml(inactive);
  assert.match(inactiveHtml, />Inactive</, "Inactive band label rendered");
  assert.match(inactiveHtml, /No active labeled campaigns in scope/, "scope note rendered");
  // Only the header logo SVG remains — the score gauge SVG is not rendered.
  assert.equal(inactiveHtml.split("<svg").length - 1, 1, "no score gauge for an inactive account");
  console.log("  ✓ HTML export: Inactive account renders scope note, no gauge");
}

console.log("ads-os-hygiene-audit: all assertions passed");
