/* test-registration
{
  "name": "Ads OS keyword-intel engine + finder — eligibility gates, full negatives run (protected sets, downgrade, traffic-quality math, converting caution top-3+N), persistQuality window supersede/expiry/legacy-migration/incomplete, cache TTL/force/invalidate, 503 propagation, finder CPA rules + actioned overlay + cross-check union/held-back/dismiss + honesty warnings (Task #3600)",
  "regression": true,
  "sweepOnlyReason": "Task #3600: loader-hook stubs + DB pool warmup, slower orchestration suite; the fast safety-filter half (ads-os-keyword-intel-safety) gates in SMOKE_FILES instead",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-ki-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "KI_MAX_TERMS": "12"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS Phase 4 — Search Term Analyzer engine + keyword finder orchestration
 * tests (Task #3600).
 *
 * Runs the REAL engine/finder/safety/persist code with the impure collaborators
 * (Google Ads pulls, OpenAI review, enrollment, criteria store, traffic-quality
 * + actioned stores) redirected to in-memory stubs via the resolve hooks in
 * tests/ads-os-ki-hooks.mjs (harness: --import tests/ads-os-ki-setup.mjs).
 *
 * Covers, end to end at the orchestration layer:
 *   1. enrollment/label eligibility gates for both tools;
 *   2. a full negatives run: highest-cost-first candidates into the model,
 *      stem-aware protected words + geo handed to the reviewer, safety filter
 *      applied to the model output (protected drop, broad->phrase downgrade),
 *      traffic-quality/coverage math, and the CONVERTING-TERM CAUTION being
 *      provably correct — a kept "cheap" broad negative must list the top-3
 *      converting in-window terms it would block (terms the model itself
 *      KEPT, i.e. never flagged) plus the +N overflow count (#3145 was flaky
 *      in the broken module precisely here);
 *   3. persistQuality window mechanics: per-window pending negatives, W
 *      supersedes <=W, 30-day expiry, legacy flat-doc migration, incomplete
 *      flag when review batches failed;
 *   4. honesty warnings: KI_MAX_TERMS cap (set to 12 via env before import),
 *      sparse-criteria hint, per-query pull warnings, clean-100% rule;
 *   5. runKeywordIntelCached TTL/force/invalidate + OpenAI-not-configured
 *      propagation (routes map it to 503 — AI *is* the feature here);
 *   6. keyword finder rules: CPA <= campaign average, min-conversions floor,
 *      no-baseline skip, active-keyword skip (keywordTupleKey), live account
 *      negatives -> account_blocked, conv-desc sort, verbatim reason strings;
 *   7. finder overlay (live on a cached base): actioned hide/undo, the
 *      negatives cross-check union (largest window wins category/reason),
 *      held-back conflicts with Dismiss-= -actioned semantics, and the three
 *      honesty warnings (narrower window / incomplete review / never run).
 */

process.env.NODE_ENV = "test";
process.env.KI_MAX_TERMS = "12"; // before any import so config picks it up

import assert from "node:assert/strict";

type AnyRec = Record<string, any>;
const g: AnyRec = ((globalThis as any).__kiTest ??= {});

const engine = await import("../server/services/adsOs/keywordIntel/engine");
const finder = await import("../server/services/adsOs/keywordIntel/keywordFinder");
const kiStore = await import("../server/services/adsOs/keywordIntel/kiStore"); // -> stub (in-memory)
const { keywordTupleKey } = await import("../server/services/adsOs/keywordIntel/queries"); // stub re-exports real
const { emptyCriteria } = await import("../server/services/adsOs/criteriaService"); // stub re-exports real
const { AdsOsOpenAiNotConfigured } = await import("../server/services/adsOs/openAiHelper");

const CID = "111-222-3333"; // engine normalizes to 1112223333
const NCID = "1112223333";
const DAY = 86_400_000;

function term(search_term: string, cost: number, conversions = 0, over: AnyRec = {}): AnyRec {
  return {
    search_term,
    campaign: "Camp A",
    ad_group: "AG 1",
    matched_keyword: "kw",
    impressions: 100,
    clicks: 10,
    cost,
    conversions,
    avg_cpc: cost / 10,
    cost_per_conv: conversions > 0 ? cost / conversions : 0,
    campaign_id: "c1",
    ...over,
  };
}

const CRIT = (): AnyRec => ({
  ...emptyCriteria(),
  business_name: "Chesapeake Plumbing Co",
  website: "https://www.chesapeake-plumbing.com",
  service_area: "Baltimore and Annapolis, MD",
  practice_areas: ["plumbing repair"],
  services_offered: "drain cleaning, water heater repair",
});

function resetState(opts: { criteria?: AnyRec; hasSaved?: boolean } = {}) {
  g.enrolled = [{ cid: NCID }];
  g.campaignIds = ["111", "222"];
  g.accounts = { [NCID]: { name: "Chesapeake Plumbing", currency: "USD" } };
  g.criteria = opts.criteria ?? CRIT();
  g.hasSaved = opts.hasSaved ?? true;
  g.tq = new Map();
  g.actioned = new Map();
  g.kiData = null;
  g.kfData = null;
  g.suggestImpl = null;
  g.lastSuggestArgs = null;
  engine.__testResetKeywordIntelCache();
  finder.__testResetKeywordFinderCache();
}

// ── 1. eligibility gates ──
{
  resetState();
  g.enrolled = [];
  const r = await engine.runKeywordIntel(CID, 7);
  assert.equal(r.eligible, false);
  assert.match(r.scope_note, /isn't enrolled/);
  assert.deepEqual(r.suggestions, []);

  resetState();
  g.campaignIds = [];
  const r2 = await engine.runKeywordIntel(CID, 7);
  assert.equal(r2.eligible, false);
  assert.match(r2.scope_note, /No campaigns carry/);

  resetState();
  g.enrolled = [];
  const r3 = await finder.runKeywordFinder(CID, 30);
  assert.equal(r3.eligible, false);
  assert.match(r3.scope_note, /isn't enrolled/);
}

// ── 2. full negatives run: safety wiring + math + converting caution ──
{
  resetState();
  g.kiData = {
    search_terms: [
      term("emergency plumber baltimore", 40, 2),
      term("plumbing jobs near me", 30),
      term("diy drain cleaning video", 20),
      term("cheap wallpaper hangers", 8),
      term("plumber salary maryland", 4),
      // five converting "cheap …" terms the model KEEPS (never flagged) —
      // the caution must still catch them all via the match simulator
      term("cheap drain fix", 3, 5),
      term("cheap water heater", 2.5, 4),
      term("cheap plumber annapolis", 2, 3),
      term("cheap emergency plumber", 1.5, 2),
      term("cheap plumbing quote", 1, 1),
    ],
    active_keyword_texts: ["plumber near me", "emergency plumbing"],
    geo_location_names: ["Baltimore, Maryland"],
    keyword_spend: 224,
    warnings: [],
  };
  g.suggestImpl = (
    _crit: AnyRec, candidates: AnyRec[], pWords: Set<string>, pGeo: Set<string>,
  ): [AnyRec[], string[]] => {
    g.lastSuggestArgs = { candidates: candidates.map((c) => c.search_term), pWords, pGeo };
    return [[
      { search_term: "plumbing jobs near me", category: "job_seeker", reason: "employment intent",
        negatives: [{ text: "jobs", match_type: "broad", confidence: 0.9 }] },
      { search_term: "diy drain cleaning video", category: "wrong_intent", reason: "DIY research",
        negatives: [{ text: "diy", match_type: "broad", confidence: 0.7 }] }, // < 0.8 -> downgrade
      { search_term: "plumber salary maryland", category: "job_seeker", reason: "salary lookup",
        negatives: [
          { text: "salary", match_type: "broad", confidence: 0.95 },
          { text: "maryland", match_type: "broad", confidence: 0.9 }, // protected geo -> dropped
        ] },
      { search_term: "cheap wallpaper hangers", category: "other", reason: "different trade",
        negatives: [{ text: "cheap", match_type: "broad", confidence: 0.9 }] },
    ], []];
  };

  const rep = await engine.runKeywordIntel(CID, 7);
  assert.equal(rep.eligible, true);
  assert.equal(rep.account_name, "Chesapeake Plumbing");
  assert.equal(rep.currency_code, "USD");
  assert.equal(rep.has_criteria, true);
  assert.equal(rep.lookback_days, 7);
  assert.equal(rep.candidate_count, 10);
  assert.equal(rep.reviewed_cost, 112);
  assert.deepEqual(rep.warnings, []);

  // model input: highest-cost-first
  assert.deepEqual(g.lastSuggestArgs.candidates.slice(0, 3),
    ["emergency plumber baltimore", "plumbing jobs near me", "diy drain cleaning video"]);
  // protected sets: stem-aware words (from name/site/services/practice/active kws) + geo
  for (const w of ["plumber", "plumbing", "chesapeake", "drain", "cleaning", "emergency", "repair"]) {
    assert.ok(g.lastSuggestArgs.pWords.has(w), `protected word "${w}"`);
  }
  for (const w of ["baltimore", "annapoli", "md", "maryland"]) {
    assert.ok(g.lastSuggestArgs.pGeo.has(w), `protected geo "${w}"`);
  }

  // safety filter outcome, cost-desc: protected "maryland" gone, "diy" downgraded
  assert.deepEqual(
    rep.suggestions.map((s: AnyRec) => [s.negative, s.match_type, s.system_note]),
    [
      ["jobs", "broad", ""],
      ['"diy drain cleaning video"', "phrase", "downgraded from broad"],
      ["cheap", "broad", ""],
      ["salary", "broad", ""],
    ],
  );

  // traffic quality: wasted = 30+20+8+4 = 62 of 112 reviewed -> 44.6; coverage 112/224 -> 50
  assert.equal(rep.waste_terms, 4);
  assert.equal(rep.wasted_spend, 62);
  assert.equal(rep.traffic_quality, 44.6);
  assert.equal(rep.coverage, 50);
  assert.equal(rep.keyword_spend, 224);

  // CONVERTING CAUTION — "cheap" broad blocks all five converting cheap-terms;
  // top-3 by conversions desc (then cost), +2 overflow; cpa = cost/conv
  const cheap = rep.suggestions.find((s: AnyRec) => s.negative === "cheap");
  assert.ok(cheap, "cheap suggestion present");
  assert.deepEqual(cheap.blocks_converting, [
    { search_term: "cheap drain fix", conversions: 5, cost: 3, cpa: 0.6 },
    { search_term: "cheap water heater", conversions: 4, cost: 2.5, cpa: 0.63 },
    { search_term: "cheap plumber annapolis", conversions: 3, cost: 2, cpa: 0.67 },
  ]);
  assert.equal(cheap.blocks_converting_more, 2);
  for (const s of rep.suggestions as AnyRec[]) {
    if (s.negative !== "cheap") {
      assert.deepEqual([s.blocks_converting, s.blocks_converting_more], [[], 0],
        `${s.negative} blocks no converting terms`);
    }
  }

  // persisted traffic-quality doc incl. pending negatives for the window
  const doc = g.tq.get(NCID);
  assert.ok(doc, "traffic quality persisted");
  assert.equal(doc.traffic_quality, 44.6);
  assert.equal(doc.coverage, 50);
  assert.equal(doc.lookback_days, 7);
  assert.equal(doc.reviewed_cost, 112);
  assert.equal(doc.wasted_spend, 62);
  assert.equal(doc.keyword_spend, 224);
  assert.equal(doc.generated_at, rep.generated_at);
  assert.deepEqual(Object.keys(doc.negatives_by_window), ["7"]);
  const w7 = doc.negatives_by_window["7"];
  assert.equal(w7.incomplete, false);
  assert.equal(w7.negatives.length, 4);
  assert.deepEqual(w7.negatives[0],
    { negative: "jobs", match_type: "broad", category: "job_seeker", reason: "employment intent" });
}

// ── 3. persistQuality window mechanics ──
{
  // supersede <= window, drop expired, keep larger fresh windows, incomplete flag
  resetState();
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 31 * DAY).toISOString();
  g.tq.set(NCID, {
    traffic_quality: 90, lookback_days: 7, generated_at: fresh,
    negatives_by_window: {
      "7": { negatives: [{ negative: "old7", match_type: "broad", category: "other", reason: "r" }], generated_at: fresh, incomplete: false },
      "21": { negatives: [{ negative: "keep21", match_type: "broad", category: "other", reason: "r" }], generated_at: fresh, incomplete: false },
      "30": { negatives: [{ negative: "stale30", match_type: "broad", category: "other", reason: "r" }], generated_at: stale, incomplete: false },
    },
  });
  g.kiData = {
    search_terms: [term("some junk", 5)],
    active_keyword_texts: [], geo_location_names: [], keyword_spend: 10, warnings: [],
  };
  g.suggestImpl = (): [AnyRec[], string[]] => [
    [{ search_term: "some junk", category: "other", reason: "r",
       negatives: [{ text: "junkword", match_type: "broad", confidence: 0.9 }] }],
    ["1 of 1 review batches failed; results may be incomplete."],
  ];
  const rep = await engine.runKeywordIntel(CID, 14);
  assert.ok(rep.warnings.includes("1 of 1 review batches failed; results may be incomplete."),
    "batch-failure warning surfaces on the report");
  const doc = g.tq.get(NCID);
  assert.deepEqual(Object.keys(doc.negatives_by_window).sort(), ["14", "21"],
    "14 supersedes 7, expired 30 dropped, fresh 21 kept");
  assert.equal(doc.negatives_by_window["14"].incomplete, true, "failed batches -> incomplete");
  assert.equal(doc.negatives_by_window["21"].negatives[0].negative, "keep21");

  // legacy flat doc migrates under its own lookback window
  resetState();
  g.tq.set(NCID, {
    negatives: [{ negative: "legacy", match_type: "broad", category: "other", reason: "r" }],
    lookback_days: 30, generated_at: fresh, traffic_quality: 80,
  });
  g.kiData = { search_terms: [], active_keyword_texts: [], geo_location_names: [], keyword_spend: 50, warnings: [] };
  g.suggestImpl = () => { throw new Error("no candidates -> model must not be called"); };
  const rep2 = await engine.runKeywordIntel(CID, 7);
  assert.equal(rep2.traffic_quality, 100, "no candidates -> clean 100%");
  assert.equal(rep2.coverage, null);
  assert.deepEqual(rep2.suggestions, []);
  const doc2 = g.tq.get(NCID);
  assert.deepEqual(Object.keys(doc2.negatives_by_window).sort(), ["30", "7"].sort());
  assert.equal(doc2.negatives_by_window["30"].negatives[0].negative, "legacy",
    "legacy flat list migrated under its stored lookback window");
  assert.deepEqual(doc2.negatives_by_window["7"].negatives, []);
}

// ── 4. cap + sparse-criteria honesty warnings ──
{
  resetState();
  g.kiData = {
    search_terms: Array.from({ length: 14 }, (_, i) => term(`filler term ${i}`, 14 - i)),
    active_keyword_texts: [], geo_location_names: [], keyword_spend: 0,
    warnings: ["Search terms pull failed; continuing without it."],
  };
  g.suggestImpl = (): [AnyRec[], string[]] => [[], []];
  const rep = await engine.runKeywordIntel(CID, 7);
  assert.equal(rep.candidate_count, 12, "KI_MAX_TERMS=12 cap applied");
  assert.ok(rep.warnings.includes("Search terms pull failed; continuing without it."),
    "per-query pull warnings pass through");
  assert.ok(rep.warnings.includes(
    "Reviewed the 12 highest-cost search terms; 2 lower-cost term(s) were not reviewed this run (raise KI_MAX_TERMS to include them)."));
  assert.equal(rep.traffic_quality, 100, "no wasteful terms -> clean 100%");
  assert.equal(rep.coverage, null, "keyword_spend 0 -> coverage n/a");

  // sparse saved criteria -> hint; unsaved criteria -> no hint, has_criteria false
  resetState({ criteria: { ...emptyCriteria(), business_name: "X Law" }, hasSaved: true });
  g.kiData = { search_terms: [term("a b", 1)], active_keyword_texts: [], geo_location_names: [], keyword_spend: 10, warnings: [] };
  g.suggestImpl = (): [AnyRec[], string[]] => [[], []];
  const rep2 = await engine.runKeywordIntel(CID, 7);
  assert.ok(rep2.warnings.some((w: string) => w.startsWith("Client criteria are sparse")));
  assert.equal(rep2.has_criteria, true);

  resetState({ criteria: emptyCriteria(), hasSaved: false });
  g.kiData = { search_terms: [term("a b", 1)], active_keyword_texts: [], geo_location_names: [], keyword_spend: 10, warnings: [] };
  g.suggestImpl = (): [AnyRec[], string[]] => [[], []];
  const rep3 = await engine.runKeywordIntel(CID, 7);
  assert.equal(rep3.has_criteria, false);
  assert.ok(!rep3.warnings.some((w: string) => w.startsWith("Client criteria are sparse")),
    "sparse hint only nags once criteria were actually saved");
}

// ── 5. cache TTL/force/invalidate + OpenAI-not-configured propagation ──
{
  resetState();
  g.kiData = { search_terms: [term("x y", 1)], active_keyword_texts: [], geo_location_names: [], keyword_spend: 10, warnings: [] };
  let calls = 0;
  g.suggestImpl = (): [AnyRec[], string[]] => { calls++; return [[], []]; };

  const a1 = await engine.runKeywordIntelCached(CID, 7);
  assert.equal(a1.fromCache, false);
  const a2 = await engine.runKeywordIntelCached(CID, 7);
  assert.equal(a2.fromCache, true);
  assert.equal(calls, 1, "cached hit doesn't re-run");
  const a3 = await engine.runKeywordIntelCached(CID, 7, true);
  assert.equal(a3.fromCache, false);
  assert.equal(calls, 2, "force re-runs");
  engine.invalidateKeywordIntel(CID);
  const a4 = await engine.runKeywordIntelCached(CID, 7);
  assert.equal(a4.fromCache, false);
  assert.equal(calls, 3, "invalidate (criteria save) clears the cache");
  const a5 = await engine.runKeywordIntelCached(CID, 14);
  assert.equal(a5.fromCache, false);
  assert.equal(calls, 4, "window is part of the cache key");

  g.suggestImpl = () => { throw new AdsOsOpenAiNotConfigured(); };
  await assert.rejects(engine.runKeywordIntel(CID, 7), AdsOsOpenAiNotConfigured,
    "AI-not-configured must propagate (route turns it into the 503)");
}

// ── 6. keyword finder rules ──
{
  resetState();
  g.kfData = {
    converting_terms: [
      term("sump pump install", 20, 2, { campaign_id: "c1" }),   // cpa 10 <= avg 15 -> suggest
      term("water heater replace", 40, 1, { campaign_id: "c1" }), // cpa 40 > 15 -> skip
      term("cheap lawyer", 5, 1, { campaign_id: "c2" }),          // cpa 5 <= 10 -> suggest (conflicts later)
      term("emergency plumber", 5, 1, { campaign_id: "c3" }),     // campaign avg 0 -> skip (no baseline)
      term("drain cleaning", 1, 0.5, { campaign_id: "c1" }),      // conv < KI_MIN_CONVERSIONS(1) -> skip
      term("plumber near me", 9, 3, { campaign_id: "c1" }),       // already an active keyword -> skip
      term("sewer line repair", 10, 2, { campaign_id: "c1" }),    // blocked by live account negative
    ],
    campaign_cpa: new Map([["c1", 15], ["c2", 10], ["c3", 0]]),
    active_keyword_keys: new Set([keywordTupleKey("plumber near me")]),
    account_negatives: [["sewer", "broad"]],
    warnings: [],
  };
  const base = await finder.runKeywordFinder(CID, 30);
  assert.equal(base.eligible, true);
  assert.equal(base.lookback_days, 30);
  assert.equal(base.converting_terms, 7);
  assert.equal(base.account_blocked, 1, "live negatives (campaign+ad group+shared) skip with a count");
  assert.deepEqual(base.suggestions.map((s: AnyRec) => s.search_term),
    ["sump pump install", "cheap lawyer"], "conv desc sort");
  const f1 = base.suggestions[0];
  assert.equal(f1.keyword, '"sump pump install"');
  assert.equal(f1.match_type, "phrase");
  assert.equal(f1.cpa, 10);
  assert.equal(f1.campaign_cpa, 15);
  assert.equal(f1.reason, "2 conv at 10 CPA vs campaign avg 15");
  assert.equal(base.suggestions[1].reason, "1 conv at 5 CPA vs campaign avg 10");
  assert.equal(base.negatives_checked, false);

  // ── 7. overlay: actioned + cross-check union + held-back + dismiss ──
  const freshA = new Date(Date.now() - 3600_000).toISOString();
  const freshB = new Date().toISOString();
  g.tq.set(NCID, {
    negatives_by_window: {
      // same pending negative in two windows with different category/reason —
      // the union must keep the LARGER window's fields
      "7": { negatives: [{ negative: "cheap", match_type: "broad", category: "other", reason: "r7" }], generated_at: freshB, incomplete: false },
      "30": { negatives: [{ negative: "cheap", match_type: "broad", category: "competitor", reason: "r30" }], generated_at: freshA, incomplete: false },
    },
  });
  const o1 = await finder.runKeywordFinderCached(CID, 30);
  assert.equal(o1.fromCache, false);
  assert.deepEqual(o1.report.suggestions.map((s: AnyRec) => s.search_term), ["sump pump install"]);
  assert.equal(o1.report.conflicts.length, 1);
  const c = o1.report.conflicts[0];
  assert.equal(c.search_term, "cheap lawyer");
  assert.deepEqual([c.blocked_by, c.blocked_category, c.blocked_reason],
    ["cheap", "competitor", "r30"], "largest window wins the union");
  assert.equal(o1.report.negatives_checked, true);
  assert.equal(o1.report.negatives_window_days, 30);
  assert.equal(o1.report.negatives_generated_at, freshB, "max generated_at across windows");
  assert.deepEqual(o1.report.warnings, [], "fresh full-window snapshot -> no honesty warnings");

  // actioned overlay applies LIVE over the cached base
  await kiStore.setActioned(CID, finder.normTerm("Sump  Pump install"), true);
  const o2 = await finder.runKeywordFinderCached(CID, 30);
  assert.equal(o2.fromCache, true, "base report cached");
  assert.deepEqual(o2.report.suggestions, []);
  assert.equal(o2.report.actioned_hidden, 1);
  assert.equal(o2.report.conflicts.length, 1, "other term's actioned doesn't touch the conflict");

  // Dismiss on a held-back row = mark actioned -> row leaves conflicts too
  await kiStore.setActioned(CID, finder.normTerm("cheap lawyer"), true);
  const o3 = await finder.runKeywordFinderCached(CID, 30);
  assert.equal(o3.report.conflicts.length, 0);
  assert.equal(o3.report.actioned_hidden, 2);

  // undo resurfaces both
  await kiStore.setActioned(CID, finder.normTerm("sump pump install"), false);
  await kiStore.setActioned(CID, finder.normTerm("cheap lawyer"), false);
  const o4 = await finder.runKeywordFinderCached(CID, 30);
  assert.deepEqual(o4.report.suggestions.map((s: AnyRec) => s.search_term), ["sump pump install"]);
  assert.equal(o4.report.conflicts.length, 1);
  assert.equal(o4.report.actioned_hidden, 0);

  // ── honesty warnings on the overlay ──
  const stale = new Date(Date.now() - 31 * DAY).toISOString();
  // (a) narrower window than the finder lookback
  g.tq.set(NCID, { negatives_by_window: { "7": { negatives: [], generated_at: freshB, incomplete: false } } });
  const w1 = await finder.runKeywordFinderCached(CID, 30);
  assert.ok(w1.report.warnings.includes(
    "The negatives review has only covered the last 7 day(s) — run the Negative Keywords tool at 30 days to fully vet these suggestions."));
  assert.equal(w1.report.negatives_window_days, 7);
  // (b) incomplete review
  g.tq.set(NCID, { negatives_by_window: { "30": { negatives: [], generated_at: freshB, incomplete: true } } });
  const w2 = await finder.runKeywordFinderCached(CID, 30);
  assert.ok(w2.report.warnings.includes(
    "The latest negatives review was incomplete (some review batches failed), so this cross-check may be missing clashes — re-run the Negative Keywords tool."));
  // (c) never run at all
  g.tq.delete(NCID);
  const w3 = await finder.runKeywordFinderCached(CID, 30);
  assert.ok(w3.report.warnings.includes(
    "Not cross-checked against the Negative Keywords review yet — run that tool once for this account so clashing suggestions can be held back."));
  assert.equal(w3.report.negatives_checked, false);
  assert.equal(w3.report.negatives_window_days, null);
  // (d) expired snapshot = unchecked, expired pending negatives never hold back
  g.tq.set(NCID, { negatives_by_window: { "30": { negatives: [{ negative: "cheap", match_type: "broad", category: "x", reason: "r" }], generated_at: stale, incomplete: false } } });
  const w4 = await finder.runKeywordFinderCached(CID, 30);
  assert.equal(w4.report.negatives_checked, false);
  assert.equal(w4.report.conflicts.length, 0, "expired snapshot never holds suggestions back");
  // (e) legacy flat snapshot still cross-checks (transitional)
  g.tq.set(NCID, { negatives: [{ negative: "cheap", match_type: "broad", category: "other", reason: "legacy" }], lookback_days: "30", generated_at: freshB });
  const w5 = await finder.runKeywordFinderCached(CID, 30);
  assert.equal(w5.report.conflicts.length, 1);
  assert.equal(w5.report.conflicts[0].blocked_reason, "legacy");
  assert.equal(w5.report.negatives_window_days, 30);
}

// ── 8. no suggestions + no snapshot -> no unvetted nag ──
{
  resetState();
  g.kfData = { converting_terms: [], campaign_cpa: new Map(), active_keyword_keys: new Set(), account_negatives: [], warnings: [] };
  const w = await finder.runKeywordFinderCached(CID, 30);
  assert.deepEqual(w.report.warnings, [], "nothing to vet -> no cross-check warning");
  assert.deepEqual(w.report.suggestions, []);
}

// ── 9. duplicate segment rows aggregate before candidate selection ──
//
// GAQL search_term_view emits one row per (search_term × keyword × ad_group)
// segment. The same search term served across two ad groups arrives as two
// rows each carrying only a slice of the window's metrics. Without aggregation
// the engine would see four raw rows; with aggregation it must see three
// distinct terms whose cost/conversions are the sum across their segments.
// candidate_count, reviewed_cost, and the converting-term caution must all
// reflect the aggregated values.
{
  resetState();
  g.kiData = {
    search_terms: [
      // "cheap drain service" appears in two segments — these should be collapsed.
      term("cheap drain service", 30, 2, { ad_group: "AG Brand" }),
      term("cheap drain service", 10, 1, { ad_group: "AG Generic" }), // dup segment
      // Two other distinct terms.
      term("plumbing near me", 20, 0),
      term("emergency call fee",  5, 0),
    ],
    active_keyword_texts: [],
    geo_location_names: [],
    keyword_spend: 100,
    warnings: [],
  };
  g.suggestImpl = (
    _crit: AnyRec, candidates: AnyRec[],
  ): [AnyRec[], string[]] => {
    // Model receives the AGGREGATED view: 3 distinct terms, not 4 raw rows.
    assert.equal(candidates.length, 3, "model receives 3 distinct aggregated terms");
    const top = candidates[0];
    assert.equal(top.search_term, "cheap drain service", "highest-cost aggregated term is first");
    assert.equal(top.cost, 40, "cost is summed across segments (30+10)");
    assert.equal(top.conversions, 3, "conversions summed across segments (2+1)");
    return [[
      {
        search_term: "cheap drain service",
        category: "other",
        reason: "price-sensitive",
        negatives: [{ text: "cheap", match_type: "broad", confidence: 0.9 }],
      },
      {
        search_term: "plumbing near me",
        category: "other",
        reason: "generic intent",
        negatives: [{ text: "plumbing near me", match_type: "phrase", confidence: 0.9 }],
      },
    ], []];
  };

  const rep = await engine.runKeywordIntel(CID, 7);

  // candidate_count = 3 distinct terms (NOT 4 raw rows).
  assert.equal(rep.candidate_count, 3, "candidate_count reflects distinct terms after aggregation");
  // reviewed_cost = 40 (aggregated) + 20 + 5 = 65, not the raw-row sum.
  assert.equal(rep.reviewed_cost, 65, "reviewed_cost uses aggregated per-term cost");

  // The "cheap" broad negative should flag "cheap drain service" (conv=3) as a
  // blocked converting term.  The caution values must use the AGGREGATED totals
  // (cost=40, conversions=3, cpa≈13.33), not the individual segment values.
  const cheapSug = rep.suggestions.find((s: AnyRec) => s.negative === "cheap");
  assert.ok(cheapSug, "cheap suggestion present");
  assert.equal(cheapSug.blocks_converting.length, 1, "one converting term blocked by cheap");
  const blocked = cheapSug.blocks_converting[0];
  assert.equal(blocked.search_term, "cheap drain service", "aggregated term appears in caution");
  assert.equal(blocked.conversions, 3, "caution shows aggregated conversion total");
  assert.equal(blocked.cost, 40, "caution shows aggregated cost total");
  assert.equal(blocked.cpa, 13.33, "cpa derived from aggregated cost/conversions");
}

// ── 10. finder duplicate segments aggregate within campaign CPA boundaries ──
//
// The finder uses the same GAQL resource. Its converting rows must collapse
// before applying its conversion floor and live account-negative guard, but
// campaign CPA baselines are per campaign. The same term in separate campaigns
// must therefore remain separate decisions; otherwise a combined metric could
// be compared with the wrong campaign's baseline.
{
  resetState();
  g.kfData = {
    converting_terms: [
      // c1's duplicate segments -> 10 cost / 1 conv -> CPA 10 <= c1 avg 15.
      term("sump pump install", 6, 0.6, {
        campaign_id: "c1", campaign: "Camp 1", ad_group: "AG Brand",
      }),
      term("sump pump install", 4, 0.4, {
        campaign_id: "c1", campaign: "Camp 1", ad_group: "AG Generic",
      }),
      // The same term in c2 is also segmented, but CPA 30 > c2 avg 20.
      // It must not merge with c1 and suppress c1's qualifying suggestion.
      term("sump pump install", 40, 1, {
        campaign_id: "c2", campaign: "Camp 2", ad_group: "AG Brand",
      }),
      term("sump pump install", 20, 1, {
        campaign_id: "c2", campaign: "Camp 2", ad_group: "AG Generic",
      }),
      // "sewer line repair": 2 segments -> one cumulative term, blocked once.
      term("sewer line repair", 8, 1, { campaign_id: "c1", ad_group: "AG Brand" }),
      term("sewer line repair", 2, 1, { campaign_id: "c1", ad_group: "AG Generic" }),
      // One distinct term that fails the campaign-CPA rule.
      term("water heater replace", 40, 1, { campaign_id: "c1" }),
    ],
    campaign_cpa: new Map([["c1", 15], ["c2", 20]]),
    active_keyword_keys: new Set(),
    account_negatives: [["sewer", "broad"]],
    warnings: [],
  };

  const rep = await finder.runKeywordFinder(CID, 30);
  assert.equal(rep.converting_terms, 4,
    "two campaign-specific sump terms stay distinct alongside sewer and water-heater terms");
  assert.equal(rep.account_blocked, 1,
    "the aggregated sewer term is blocked once, rather than once per GAQL segment");
  assert.deepEqual(rep.suggestions.map((s: AnyRec) => s.search_term), ["sump pump install"]);
  const suggestion = rep.suggestions[0];
  assert.deepEqual(
    [suggestion.conversions, suggestion.cost, suggestion.cpa, suggestion.campaign_cpa],
    [1, 10, 10, 15],
    "finder CPA uses cumulative duplicate-segment metrics without crossing campaign baselines",
  );
  assert.equal(suggestion.campaign, "Camp 1",
    "qualifying campaign remains the suggestion's display campaign");
  assert.equal(suggestion.reason, "1 conv at 10 CPA vs campaign avg 15");
}

console.log("ads-os-keyword-intel-engine: all assertions passed");
