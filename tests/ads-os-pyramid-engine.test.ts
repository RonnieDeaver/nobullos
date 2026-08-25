/* test-registration
{
  "name": "Ads OS pyramid engine — eligibility notes, dormant drops, relevancy batching/clamps/cap warning, dirty-traffic escalation, strategist integer-ref payload, post-guards (unknown action/ref, thin, no-flag, scale, non-ENABLED), keyword dissent, GPT-5 param convention + strip-and-retry, ai_status full/partial/rules_only, snapshot keys, cache/force/single-flight (Task #3601)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3601: Ads OS Pyramid engine orchestration — post-guards (arithmetic beats AI), ai_status degradation ladder, GPT-5 param strip-and-retry, and snapshot persistence, all against in-memory stubs (DB-free, network-free). The guards are the safety property: a drift could let an AI verdict pause a thin-data campaign.",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-pyramid-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test",
    "PYRAMID_MAX_TERMS": "3",
    "PYRAMID_TERM_BATCH_SIZE": "2",
    "OPENAI_MODEL": "gpt-4o",
    "OPENAI_API_KEY": "sk-test-pyramid"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS Phase 5 — Pyramid Breakdown engine orchestration tests (Task #3601).
 *
 * Runs the REAL engine/ai/openAiHelper code with the impure collaborators
 * (Google Ads pull, enrollment, criteria store, snapshot store, and the
 * `openai` npm package itself) redirected to in-memory stubs via the resolve
 * hooks in tests/ads-os-pyramid-hooks.mjs (harness: --import
 * tests/ads-os-pyramid-setup.mjs).
 *
 * Covers, end to end at the orchestration layer:
 *   1. eligibility gates (enrollment, campaign label) with the verbatim notes;
 *   2. a FULL AI run: dormant drops (ENDED / zero-activity), rule passes,
 *      relevancy batching + post-parse clamps, the dirty-traffic (>=40%
 *      irrelevant spend) ad-group escalation, the compact integer-ref
 *      strategist payload (money rounding, tcpa/budget_day/IS presence rules),
 *      every post-guard (unknown action -> rules + warning, unknown ref
 *      ignored, thin never paused, pause needs a rule flag, scale needs the
 *      rule flag, non-ENABLED -> none), keyword AI-dissent annotation,
 *      action-count rollups, killer/worst rollups, snapshot persistence keys;
 *   3. the GPT-5 param convention (memory note gpt5-param-compatibility):
 *      strategist calls carry reasoning_effort and never temperature; the
 *      helper's strip-and-retry is exercised for BOTH knobs against the real
 *      openAiHelper code (a param-rejection 400 is retried without the knob);
 *   4. ai_status ladder: full / partial (stage-1 batch failure; model-swap
 *      fallback to OPENAI_MODEL with the swap warning; strategist hard fail
 *      with synthesized rules summary + next steps) / rules_only (no key — no
 *      OpenAI constructor touched), never a thrown 5xx for AI trouble;
 *   5. PYRAMID_MAX_TERMS cap warning (only when scoring ran);
 *   6. campaign-attrs-failed early return (empty review, warning, snapshot);
 *   7. runPyramidCached: 1h cache, force bypass, single-flight collapse.
 */

process.env.NODE_ENV = "test";
// Before any import so config module-load consts pick them up:
process.env.PYRAMID_MAX_TERMS = "3";
process.env.PYRAMID_TERM_BATCH_SIZE = "2";
process.env.OPENAI_MODEL = "gpt-4o";
delete process.env.OPENAI_REASONING_EFFORT; // base calls -> temperature: 0
delete process.env.PYRAMID_OPENAI_MODEL; // default gpt-5.5
delete process.env.PYRAMID_REASONING_EFFORT; // default medium
process.env.OPENAI_API_KEY = "sk-test-pyramid";
delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

import assert from "node:assert/strict";

type AnyRec = Record<string, any>;
const g: AnyRec = ((globalThis as any).__pyrTest ??= {});

const engine = await import("../server/services/adsOs/pyramid/engine");
const { emptyCriteria } = await import("../server/services/adsOs/criteriaService"); // stub re-exports real

const CID = "444-555-6666"; // engine normalizes to 4445556666
const NCID = "4445556666";

// ---------------------------------------------------------------------------
// Fixture: 6 campaigns (2 dormant), 6 ad groups (1 dormant), 5 keywords,
// 5 terms. Numbers hand-computed in the assertions below.
// ---------------------------------------------------------------------------

function camp(over: AnyRec = {}): AnyRec {
  return {
    id: "c0",
    name: "Camp",
    status: "ENABLED",
    primary_status: "ELIGIBLE",
    channel_type: "SEARCH",
    bidding_strategy_type: "MAXIMIZE_CONVERSIONS",
    budget: null,
    target_cpa: null,
    cost: 0,
    conversions: 0,
    clicks: 0,
    impressions: 0,
    search_is: null,
    lost_is_budget: null,
    lost_is_rank: null,
    top_is: null,
    ...over,
  };
}
function ag(over: AnyRec = {}): AnyRec {
  return { id: "g0", name: "AG", status: "ENABLED", campaign_id: "c1", cost: 0, conversions: 0, clicks: 0, impressions: 0, ...over };
}
function kw(over: AnyRec = {}): AnyRec {
  return { criterion_id: "k0", ad_group_id: "g1", campaign_id: "c1", text: "kw", match_type: "EXACT", status: "ENABLED", quality_score: 7, cost: 0, conversions: 0, clicks: 0, impressions: 0, ...over };
}
function term(over: AnyRec = {}): AnyRec {
  return { search_term: "t", ad_group_id: "g1", campaign_id: "c1", targeting_status: "NONE", matched_keywords: ["kw"], cost: 0, conversions: 0, clicks: 0, impressions: 100, ...over };
}

function seedData(): AnyRec {
  return {
    campaigns: new Map<string, AnyRec>([
      ["c1", camp({ id: "c1", name: "Alpha Search", cost: 1000, conversions: 10, clicks: 200, impressions: 5000, budget: 40, search_is: 60.4, lost_is_budget: 5.2, lost_is_rank: 8.9 })],
      ["c2", camp({ id: "c2", name: "Beta Zero", cost: 700, conversions: 0, clicks: 100, impressions: 3000, target_cpa: 90 })],
      ["c3", camp({ id: "c3", name: "Gamma Thin", cost: 10, conversions: 0, clicks: 2, impressions: 50 })],
      ["c4", camp({ id: "c4", name: "Delta Paused", status: "PAUSED", primary_status: "PAUSED", cost: 300, conversions: 0, clicks: 50, impressions: 100 })],
      ["c5", camp({ id: "c5", name: "Omega Ended", primary_status: "ENDED", cost: 200, conversions: 1, clicks: 30, impressions: 900 })],
      ["c6", camp({ id: "c6", name: "Ghost", status: "PAUSED", primary_status: "PAUSED", cost: 0, conversions: 0, clicks: 0, impressions: 0 })],
    ]),
    ad_groups: new Map<string, AnyRec>([
      ["g1", ag({ id: "g1", name: "AG One", campaign_id: "c1", cost: 600, conversions: 6, clicks: 120, impressions: 2500 })],
      ["g2", ag({ id: "g2", name: "AG Dirty", campaign_id: "c1", cost: 300, conversions: 3, clicks: 60, impressions: 1200 })],
      ["g3", ag({ id: "g3", name: "AG Empty", campaign_id: "c2", cost: 0, conversions: 0, clicks: 0, impressions: 0 })],
      ["g4", ag({ id: "g4", name: "AG Two", campaign_id: "c2", cost: 690, conversions: 0, clicks: 95, impressions: 2900 })],
      ["g5", ag({ id: "g5", name: "AG Thin", campaign_id: "c3", cost: 10, conversions: 0, clicks: 2, impressions: 50 })],
      ["g6", ag({ id: "g6", name: "AG InPaused", campaign_id: "c4", cost: 300, conversions: 0, clicks: 50, impressions: 100 })],
    ]),
    keywords: [
      kw({ criterion_id: "k1", ad_group_id: "g1", campaign_id: "c1", text: "cheap divorce lawyer", quality_score: 2, cost: 250, conversions: 0, clicks: 30, impressions: 900 }),
      kw({ criterion_id: "k2", ad_group_id: "g1", campaign_id: "c1", text: "family lawyer", match_type: "PHRASE", quality_score: 8, cost: 60, conversions: 3, clicks: 20, impressions: 400 }),
      kw({ criterion_id: "k3", ad_group_id: "g4", campaign_id: "c2", text: "estate planning", match_type: "BROAD", quality_score: 5, cost: 300, conversions: 0, clicks: 40, impressions: 1500 }),
      kw({ criterion_id: "k4", ad_group_id: "g4", campaign_id: "c2", text: "free consultation lawyer", match_type: "BROAD", quality_score: 4, cost: 450, conversions: 0, clicks: 50, impressions: 1400 }),
      kw({ criterion_id: "k5", ad_group_id: "g5", campaign_id: "c3", text: "thin kw", quality_score: 0, cost: 10, conversions: 0, clicks: 2, impressions: 50 }),
    ],
    terms: [
      term({ search_term: "personal injury attorney", ad_group_id: "g2", campaign_id: "c1", cost: 120, clicks: 15, impressions: 800 }),
      term({ search_term: "divorce attorney near me", ad_group_id: "g2", campaign_id: "c1", targeting_status: "ADDED", cost: 100, conversions: 2, clicks: 12, impressions: 500, matched_keywords: ["divorce attorney", "attorney near me", "family law help", "extra kw"] }),
      term({ search_term: "divorce lawyer", ad_group_id: "g1", campaign_id: "c1", cost: 90, conversions: 1, clicks: 9, impressions: 400 }),
      term({ search_term: "estate lawyer", ad_group_id: "g4", campaign_id: "c2", cost: 80, clicks: 10, impressions: 300 }),
      term({ search_term: "free legal aid", ad_group_id: "g1", campaign_id: "c1", targeting_status: "EXCLUDED", cost: 30, clicks: 6, impressions: 200 }),
    ],
    geo_location_names: ["Denver"],
    start: "2026-06-26",
    end: "2026-07-25",
    failed_datasets: new Set<string>(),
    warnings: ["geo names query failed (kept going)"],
  };
}

const REL_RESPONSE = {
  results: [
    { search_term: "personal injury attorney", reason: "Injury, not family law", relevancy: 10, label: "irrelevant" },
    { search_term: "divorce attorney near me", reason: "Core divorce intent", relevancy: 95.7, label: "high_intent" }, // non-int -> trunc 95
    { search_term: "divorce lawyer", reason: "Direct service match", relevancy: 80, label: "bogus_label" }, // -> adjacent
  ],
};

const STRAT_RESPONSE = {
  executive_summary: "  Beta Zero burns $700 with zero conversions — pause it and reinvest in Alpha Search.  ",
  campaigns: [
    { ref: 0, rationale: "Alpha has headroom.", action: "scale", confidence: 0.9 }, // guard: no rule scale flag
    { ref: 1, rationale: "Kill it.", action: "obliterate", confidence: 1.5 }, // unknown action -> rules
    { ref: 2, rationale: "Pause it.", action: "pause", confidence: 0.4 }, // non-ENABLED -> none
    { ref: 3, rationale: "Too weak.", action: "pause", confidence: 0.2 }, // thin -> watch
    { ref: 99, rationale: "Ghost.", action: "pause", confidence: 0.5 }, // unknown ref -> ignored
  ],
  ad_groups: [
    { ref: 1, rationale: "Dump it.", action: "pause" }, // g1 healthy, no flags -> watch
    { ref: 0, rationale: "Agreed, no conversions.", action: "pause" }, // g4 rule pause -> stands
    { ref: 2, rationale: "", action: "watch" }, // g2 -> falls back to rule notes
  ],
  keywords: [
    { ref: 0, rationale: "Yes, waste.", agree: true }, // k4
    { ref: 1, rationale: "Brand-adjacent, keep it.", agree: false }, // k1 dissent
  ],
  next_steps: [
    { priority: 3, step: "   " }, // blank after trim -> dropped
    { priority: 1, step: "Pause Beta Zero" },
    { priority: 2, step: "Add negatives to AG Dirty" },
  ],
};

interface CallLog {
  name: string;
  model: string;
  temperature: unknown;
  reasoning_effort: unknown;
  user: string;
}
let calls: CallLog[] = [];

function respond(json: unknown): AnyRec {
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(json) } }] };
}

/** Per-scenario OpenAI transport; the default routes by schema name. */
let onCreate: (kwargs: AnyRec) => AnyRec | Promise<AnyRec> = () => {
  throw new Error("onCreate not configured");
};
(globalThis as any).__pyrOpenAiCreate = async (kwargs: AnyRec) => {
  calls.push({
    name: kwargs?.response_format?.json_schema?.name ?? "?",
    model: kwargs?.model,
    temperature: kwargs?.temperature,
    reasoning_effort: kwargs?.reasoning_effort,
    user: String(kwargs?.messages?.[1]?.content ?? ""),
  });
  return onCreate(kwargs);
};

function routeByName(kwargs: AnyRec): AnyRec {
  const name = kwargs?.response_format?.json_schema?.name;
  if (name === "pyramid_relevancy") return respond(REL_RESPONSE);
  if (name === "pyramid_strategist") return respond(STRAT_RESPONSE);
  throw new Error(`unexpected schema ${name}`);
}

function resetScenario(): void {
  g.enrolled = [{ cid: NCID }];
  g.campaignIds = ["1", "2", "3", "4", "5", "6"];
  g.accounts = { [NCID]: { name: "NoBull Law", currency: "USD" } };
  g.criteria = { ...emptyCriteria(), practice_areas: ["family law"], service_area: "Denver, CO" };
  g.hasSaved = true;
  g.pyrData = seedData();
  g.fetchCalls = [];
  g.store = {};
  calls = [];
  process.env.OPENAI_API_KEY = "sk-test-pyramid";
  delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  onCreate = routeByName;
  engine.__testResetPyramidCache();
}

let failures = 0;
async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}\n    ${err?.stack ?? err}`);
  }
}

const byName = (r: AnyRec, name: string): AnyRec => {
  const c = r.campaigns.find((x: AnyRec) => x.name === name);
  assert.ok(c, `campaign ${name} missing`);
  return c;
};
const agOf = (c: AnyRec, name: string): AnyRec => {
  const a = c.ad_groups.find((x: AnyRec) => x.name === name);
  assert.ok(a, `ad group ${name} missing`);
  return a;
};

// ---------------------------------------------------------------------------
console.log("eligibility gates");
// ---------------------------------------------------------------------------

await t("not enrolled -> ineligible, verbatim note, no pull", async () => {
  resetScenario();
  g.enrolled = [];
  const r = await engine.runPyramid(CID);
  assert.equal(r.eligible, false);
  assert.equal(
    r.scope_note,
    "This account isn't enrolled. Add it to the ClickUp Client List (a subtask " +
      "with this account's Google CID) to include it in the Pyramid Breakdown.",
  );
  assert.equal(g.fetchCalls.length, 0);
  assert.equal(r.account_name, "NoBull Law"); // MCC cosmetic lookup still applies
});

await t("no labeled campaigns -> ineligible", async () => {
  resetScenario();
  g.campaignIds = [];
  const r = await engine.runPyramid(CID);
  assert.equal(r.eligible, false);
  assert.match(r.scope_note, /label in this account\. Label the campaigns you want reviewed\.$/);
  assert.equal(g.fetchCalls.length, 0);
});

// ---------------------------------------------------------------------------
console.log("full AI run — drops, rules, batching, guards, rollups, snapshot");
// ---------------------------------------------------------------------------

await t("full run end-to-end", async () => {
  resetScenario();
  // Exercise the REAL strip-and-retry both ways (memory: gpt5-param-compatibility):
  // first relevancy call gets a temperature-rejection 400, first strategist call
  // gets a reasoning_effort-rejection 400; each must be retried without the knob.
  let relRejected = false;
  let stratRejected = false;
  onCreate = (kwargs) => {
    const name = kwargs?.response_format?.json_schema?.name;
    if (name === "pyramid_relevancy" && !relRejected && "temperature" in kwargs) {
      relRejected = true;
      throw new Error("Unsupported value: 'temperature' does not support 0 with this model.");
    }
    if (name === "pyramid_strategist" && !stratRejected && "reasoning_effort" in kwargs) {
      stratRejected = true;
      throw new Error("Unsupported parameter: 'reasoning_effort' is not supported with this model.");
    }
    return routeByName(kwargs);
  };

  const r = await engine.runPyramid(CID);

  // Window + scope.
  assert.equal(r.eligible, true);
  assert.equal(r.lookback_days, 30);
  assert.equal(r.window_start, "2026-06-26");
  assert.equal(r.window_end, "2026-07-25");
  assert.equal(r.monitored_campaigns, 6);
  assert.equal(r.scope_note, "Reviewing 6 labeled campaign(s), last 30 full days.");
  assert.equal(r.currency_code, "USD");
  assert.equal(r.has_criteria, true);
  assert.ok(r.warnings.includes("geo names query failed (kept going)")); // pull warnings propagate

  // Dormant drops: ENDED (c5) and zero-activity non-ENABLED (c6, g3) are gone;
  // paused-with-activity (c4, g6) stays. Cost-desc order.
  assert.deepEqual(
    r.campaigns.map((c: AnyRec) => c.name),
    ["Alpha Search", "Beta Zero", "Delta Paused", "Gamma Thin"],
  );
  assert.equal(byName(r, "Beta Zero").ad_groups.length, 1); // g3 dropped

  // Baselines: 2010 cost / 10 conv (dropped campaigns excluded).
  assert.equal(r.account_cost, 2010);
  assert.equal(r.account_conversions, 10);
  assert.equal(r.account_cpl, 201);
  assert.equal(r.baseline_note, "");

  // --- Campaign guards ---
  const c1 = byName(r, "Alpha Search");
  assert.equal(c1.action, "keep"); // AI said scale; no rule flag
  assert.equal(c1.rationale, "Alpha has headroom. (guard: no rule-verified scaling headroom)");
  assert.equal(c1.confidence, 0.9);
  assert.equal(c1.baseline_cpl, 100);
  assert.equal(c1.baseline_source, "campaign");
  assert.equal(c1.cpl, 100);
  assert.equal(c1.daily_budget, 40);
  assert.equal(c1.search_is, 60.4);
  assert.equal(c1.recommended_budget_change_pct, null);

  const c2 = byName(r, "Beta Zero");
  assert.equal(c2.action, "pause"); // unknown AI action fell back to the rule pause
  assert.equal(c2.rationale, "Kill it.");
  assert.equal(c2.confidence, 1); // 1.5 clamped
  assert.deepEqual(c2.flags, ["CAMP_PAUSE_ZERO_CONV"]);
  assert.equal(c2.baseline_source, "account");

  const c4 = byName(r, "Delta Paused");
  assert.equal(c4.action, "none"); // non-ENABLED is context, never a target
  assert.equal(c4.confidence, 0.4);

  const c3 = byName(r, "Gamma Thin");
  assert.equal(c3.action, "watch"); // AI pause on thin data downgraded
  assert.equal(c3.rationale, "Too weak. (guard: not enough data for a pause call)");
  assert.equal(c3.insufficient_data, true);

  assert.ok(
    r.warnings.includes("1 AI verdict(s) used an unknown action and fell back to the rules."),
    `guard warning missing: ${JSON.stringify(r.warnings)}`,
  );

  // --- Ad-group guards + dirty traffic ---
  const g1r = agOf(c1, "AG One");
  assert.equal(g1r.action, "watch"); // AI pause without a rule flag
  assert.equal(g1r.rationale, "Dump it. (guard: no rule flag supports a pause here)");

  const g2r = agOf(c1, "AG Dirty");
  assert.deepEqual(g2r.flags, ["AG_IRRELEVANT_TRAFFIC"]);
  assert.equal(g2r.action, "watch"); // keep escalated by >=40% irrelevant spend
  assert.equal(g2r.relevancy_avg, 48.6); // (120*10 + 100*95) / 220
  assert.equal(g2r.irrelevant_cost_pct, 54.5); // 100*120/220
  assert.equal(
    g2r.rationale,
    "55% of scored search spend is on irrelevant terms — the traffic mix needs negatives/targeting work.",
  );

  const g4r = agOf(c2, "AG Two");
  assert.equal(g4r.action, "pause");
  assert.equal(g4r.rationale, "Agreed, no conversions.");

  const g6r = agOf(c4, "AG InPaused");
  assert.equal(g6r.action, "watch"); // no verdict -> rule action
  assert.equal(g6r.rationale, "$300 spent with 0 conversions — approaching the pause line ($402).");

  const g5r = agOf(c3, "AG Thin");
  assert.equal(g5r.action, "keep");
  assert.equal(g5r.insufficient_data, true);
  assert.equal(g5r.rationale, "Below the data floor ($10 spend, 2 clicks).");

  // --- Keywords: rules decide, AI annotates ---
  const k1 = g1r.keywords.find((k: AnyRec) => k.text === "cheap divorce lawyer");
  assert.equal(k1.action, "pause");
  assert.equal(k1.ai_agrees, false); // dissent is annotation, never a downgrade
  assert.equal(k1.rationale, "Brand-adjacent, keep it.");
  assert.deepEqual(k1.flags, ["KW_PAUSE_ZERO_CONV", "KW_LOW_QS"]);
  const k2 = g1r.keywords.find((k: AnyRec) => k.text === "family lawyer");
  assert.equal(k2.ai_agrees, null);
  const k4 = g4r.keywords.find((k: AnyRec) => k.text === "free consultation lawyer");
  assert.equal(k4.ai_agrees, true);
  assert.equal(k4.rationale, "Yes, waste.");

  // --- Terms: clamps, exclusions, cap ---
  const g1terms = g1r.search_terms;
  const excluded = g1terms.find((x: AnyRec) => x.search_term === "free legal aid");
  assert.equal(excluded.targeting_status, "EXCLUDED");
  assert.equal(excluded.relevancy, null); // excluded terms are never scored
  const t3 = g1terms.find((x: AnyRec) => x.search_term === "divorce lawyer");
  assert.equal(t3.relevancy, 80);
  assert.equal(t3.relevancy_label, "adjacent"); // bogus label clamped
  const g2terms = agOf(c1, "AG Dirty").search_terms;
  const t2 = g2terms.find((x: AnyRec) => x.search_term === "divorce attorney near me");
  assert.equal(t2.relevancy, 95); // 95.7 truncated
  assert.deepEqual(t2.matched_keywords, ["divorce attorney", "attorney near me", "family law help"]); // slice(0,3)
  const t5 = g4r.search_terms.find((x: AnyRec) => x.search_term === "estate lawyer");
  assert.equal(t5.relevancy, null); // dropped by PYRAMID_MAX_TERMS=3
  assert.ok(
    r.warnings.includes(
      "Scored the 3 highest-cost search terms; 1 lower-cost term(s) were not scored this run " +
        "(raise PYRAMID_MAX_TERMS to include them).",
    ),
    `cap warning missing: ${JSON.stringify(r.warnings)}`,
  );

  // --- Rollups ---
  assert.deepEqual(r.rollup.action_counts, { keep: 2, pause: 4, none: 1, watch: 5 });
  assert.deepEqual(r.rollup.campaign_actions, { keep: 1, pause: 1, none: 1, watch: 1 });
  assert.deepEqual(r.rollup.ad_group_actions, { pause: 1, watch: 3, keep: 1 });
  assert.deepEqual(r.rollup.keyword_actions, { pause: 2, keep: 2, watch: 1 });
  assert.equal(r.rollup.flagged_keywords, 2);
  assert.equal(r.rollup.flagged_keyword_cost, 700);
  assert.deepEqual(
    r.rollup.killer_keywords.map((k: AnyRec) => [k.text, k.ad_group_name, k.campaign_name]),
    [
      ["free consultation lawyer", "AG Two", "Beta Zero"],
      ["cheap divorce lawyer", "AG One", "Alpha Search"],
    ],
  );
  assert.deepEqual(r.rollup.worst_terms.map((x: AnyRec) => x.search_term), ["personal injury attorney"]);
  assert.equal(r.rollup.scored_terms, 3);
  assert.equal(r.rollup.scored_term_cost, 310);
  assert.equal(r.rollup.irrelevant_term_cost, 120);
  assert.equal(r.rollup.relevancy_avg, 57.7); // (120*10+100*95+90*80)/310

  // --- Summary + steps ---
  assert.equal(
    r.executive_summary,
    "Beta Zero burns $700 with zero conversions — pause it and reinvest in Alpha Search.",
  );
  assert.deepEqual(r.next_steps, [
    { priority: 1, step: "Pause Beta Zero" },
    { priority: 2, step: "Add negatives to AG Dirty" },
  ]);

  // --- ai_status ---
  assert.equal(r.ai_status, "full");
  assert.equal(r.ai_model_used, "gpt-5.5");

  // --- Strategist payload (compact integer refs) ---
  const stratCalls = calls.filter((c) => c.name === "pyramid_strategist");
  assert.equal(stratCalls.length, 2); // rejection + retry
  assert.equal(stratCalls[0].model, "gpt-5.5");
  assert.equal(stratCalls[0].reasoning_effort, "medium"); // GPT-5 convention:
  assert.equal(stratCalls[0].temperature, undefined); // effort, never temperature
  assert.equal(stratCalls[1].reasoning_effort, undefined); // stripped on retry
  assert.equal(stratCalls[1].temperature, undefined);
  const payload = JSON.parse(stratCalls[0].user);
  assert.deepEqual(payload.account, { cost: 2010, conv: 10, cpl: 201, window: "2026-06-26..2026-07-25" });
  assert.deepEqual(payload.client, {
    practice_areas: ["family law"],
    service_area: "Denver, CO",
    services_not_offered: g.criteria.services_not_offered,
    notes: g.criteria.notes,
  });
  const pc1 = payload.campaigns[0];
  assert.equal(pc1.ref, 0);
  assert.equal(pc1.name, "Alpha Search");
  assert.equal(pc1.cost, 1000);
  assert.equal(pc1.cpl, 100);
  assert.equal(pc1.budget_day, 40);
  assert.equal(pc1.is, 60); // Math.round(60.4)
  assert.equal(pc1.lost_b, 5);
  assert.equal(pc1.lost_r, 9);
  assert.ok(!("tcpa" in pc1));
  const pc2 = payload.campaigns[1];
  assert.equal(pc2.tcpa, 90);
  assert.ok(!("is" in pc2) && !("lost_b" in pc2) && !("budget_day" in pc2));
  const pg2 = payload.ad_groups.find((x: AnyRec) => x.name === "AG Dirty");
  assert.equal(pg2.rel_avg, 48.6);
  assert.equal(pg2.irr_pct, 54.5);
  assert.deepEqual(pg2.worst_terms, ["personal injury attorney"]);
  assert.ok(pg2.flags.includes("AG_IRRELEVANT_TRAFFIC"));
  assert.deepEqual(
    payload.keywords.map((x: AnyRec) => [x.ref, x.text, x.ag, x.qs]),
    [
      [0, "free consultation lawyer", 0, 4], // g4 = ag ref 0 (cost order)
      [1, "cheap divorce lawyer", 1, 2], // g1 = ag ref 1
    ],
  );
  assert.ok(!("single_campaign" in payload.account));
  assert.ok(!("ad_groups_omitted" in payload.account));

  // --- Relevancy calls: base model, temperature convention + strip-retry ---
  const relCalls = calls.filter((c) => c.name === "pyramid_relevancy");
  assert.equal(relCalls.length, 3); // 2 batches + 1 rejected-then-retried
  assert.ok(relCalls.every((c) => c.model === "gpt-4o"));
  assert.ok(relCalls.every((c) => c.reasoning_effort === undefined)); // effort "" -> temperature 0
  const retried = relCalls.filter((c) => c.temperature === undefined);
  assert.equal(retried.length, 1); // exactly the strip-and-retry replay

  // --- Snapshot ---
  const snap = g.store[NCID];
  assert.ok(snap, "snapshot missing");
  assert.deepEqual(Object.keys(snap).sort(), [
    "action_counts",
    "ai_status",
    "campaign_actions",
    "flagged_keyword_cost",
    "flagged_keywords",
    "generated_at",
    "irrelevant_term_cost",
    "lookback_days",
    "top_recommendations",
  ]);
  assert.equal(snap.ai_status, "full");
  assert.equal(snap.lookback_days, 30);
  assert.equal(snap.flagged_keywords, 2);
  assert.equal(snap.flagged_keyword_cost, 700);
  assert.equal(snap.irrelevant_term_cost, 120);
  assert.deepEqual(
    snap.top_recommendations.map((x: AnyRec) => [x.level, x.name, x.action]),
    [
      ["campaign", "Beta Zero", "pause"],
      ["keyword", "free consultation lawyer", "pause"],
      ["keyword", "cheap divorce lawyer", "pause"],
    ],
  );
  assert.ok(snap.top_recommendations.every((x: AnyRec) => x.rationale.length <= 140));
});

// ---------------------------------------------------------------------------
console.log("cache / force / single-flight");
// ---------------------------------------------------------------------------

await t("concurrent calls collapse; cache serves; force and criteria invalidation re-pull", async () => {
  resetScenario();
  const [a, b] = await Promise.all([engine.runPyramidCached(CID), engine.runPyramidCached(CID)]);
  assert.equal(g.fetchCalls.length, 1); // single-flight: one pull for both
  assert.equal(a.fromCache || b.fromCache, true); // loser re-checked inside the lock
  assert.equal(a.fromCache && b.fromCache, false); // exactly one did the work
  const c = await engine.runPyramidCached(CID);
  assert.equal(c.fromCache, true);
  assert.equal(g.fetchCalls.length, 1);
  const d = await engine.runPyramidCached(CID, true);
  assert.equal(d.fromCache, false);
  assert.equal(g.fetchCalls.length, 2);
  engine.invalidatePyramid(CID);
  const e = await engine.runPyramidCached(CID);
  assert.equal(e.fromCache, false);
  assert.equal(g.fetchCalls.length, 3);
});

// ---------------------------------------------------------------------------
console.log("degraded modes — partial / rules_only / empty pull");
// ---------------------------------------------------------------------------

await t("stage-1 batch failure -> partial + incomplete warning, dirty flag survives", async () => {
  resetScenario();
  onCreate = (kwargs) => {
    const name = kwargs?.response_format?.json_schema?.name;
    // Fail only the g1 batch (the one without the injury term).
    if (name === "pyramid_relevancy" && !kwargs.messages[1].content.includes("personal injury attorney")) {
      throw new Error("boom relevancy");
    }
    return routeByName(kwargs);
  };
  const r = await engine.runPyramid(CID);
  assert.equal(r.ai_status, "partial");
  assert.ok(
    r.warnings.includes(
      "Search-term relevancy scoring was incomplete: 1 of 2 batches failed; unscored terms " +
        "show without a relevancy score. Re-run to retry.",
    ),
    `incomplete warning missing: ${JSON.stringify(r.warnings)}`,
  );
  const c1 = byName(r, "Alpha Search");
  const t3 = agOf(c1, "AG One").search_terms.find((x: AnyRec) => x.search_term === "divorce lawyer");
  assert.equal(t3.relevancy, null); // its batch failed
  const g2r = agOf(c1, "AG Dirty");
  assert.ok(g2r.flags.includes("AG_IRRELEVANT_TRAFFIC")); // surviving batch still aggregates
  assert.equal(r.rollup.scored_terms, 2);
});

await t("strategist model unavailable -> one retry on OPENAI_MODEL + swap note, partial", async () => {
  resetScenario();
  onCreate = (kwargs) => {
    if (kwargs?.response_format?.json_schema?.name === "pyramid_strategist" && kwargs.model === "gpt-5.5") {
      throw new Error("The model `gpt-5.5` does not exist or you do not have access to it.");
    }
    return routeByName(kwargs);
  };
  const r = await engine.runPyramid(CID);
  assert.equal(r.ai_status, "partial");
  assert.equal(r.ai_model_used, "gpt-4o");
  assert.ok(
    r.warnings.includes(
      "Advanced model 'gpt-5.5' is unavailable to this API key — the review used 'gpt-4o' instead.",
    ),
    `swap warning missing: ${JSON.stringify(r.warnings)}`,
  );
  // Verdicts still applied on the fallback model.
  assert.equal(byName(r, "Beta Zero").rationale, "Kill it.");
  const fallback = calls.filter((c) => c.name === "pyramid_strategist" && c.model === "gpt-4o");
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].temperature, 0); // base effort "" -> temperature 0
  assert.equal(fallback[0].reasoning_effort, undefined);
});

await t("strategist hard failure -> rules verdicts + synthesized summary/steps, partial", async () => {
  resetScenario();
  onCreate = (kwargs) => {
    if (kwargs?.response_format?.json_schema?.name === "pyramid_strategist") {
      throw new Error("boom 500");
    }
    return routeByName(kwargs);
  };
  const r = await engine.runPyramid(CID);
  assert.equal(r.ai_status, "partial"); // relevancy scores still landed
  assert.ok(
    r.warnings.includes(
      "AI strategist failed (OpenAI call failed: boom 500); showing the rules-based verdicts only.",
    ),
    `strategist warning missing: ${JSON.stringify(r.warnings)}`,
  );
  // Rules-only verdicts: c1 keep (no AI scale attempt to guard).
  const c1 = byName(r, "Alpha Search");
  assert.equal(c1.action, "keep");
  assert.equal(c1.confidence, null);
  assert.equal(
    r.executive_summary,
    "Rules-based review of the last 30 days: $2,010 spent, 10 conversions ($201 CPL). " +
      "1 campaign(s) to pause. 2 killer keyword(s) burning $700.",
  );
  assert.equal(r.next_steps.length, 4); // c2, g4, k4, k1 by cost
  assert.equal(
    r.next_steps[0].step,
    "Pause campaign \u201CBeta Zero\u201D — $700 spent with 0 conversions vs a $201 account CPL — " +
      "reallocate this budget to converting campaigns.",
  );
  assert.equal(
    r.next_steps[1].step,
    "Pause ad group \u201CAG Two\u201D (Beta Zero) — $690 spent with 0 conversions vs a $201 baseline " +
      "CPL — redirect this budget to converting ad groups.",
  );
  assert.deepEqual(r.next_steps.map((s: AnyRec) => s.priority), [1, 2, 3, 4]);
});

await t("no key -> rules_only, no OpenAI construction, synthesized outputs", async () => {
  resetScenario();
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  onCreate = () => {
    throw new Error("OpenAI must not be called without a key");
  };
  const r = await engine.runPyramid(CID);
  assert.equal(calls.length, 0);
  assert.equal(r.ai_status, "rules_only");
  assert.ok(
    r.warnings.includes(
      "OPENAI_API_KEY is not set — showing the rules-based review only " +
        "(no relevancy scores or AI verdicts).",
    ),
    `rules-only warning missing: ${JSON.stringify(r.warnings)}`,
  );
  assert.match(r.executive_summary, /^Rules-based review of the last 30 days: \$2,010 spent/);
  assert.equal(r.next_steps.length, 4);
  // No scores anywhere; no dirty-traffic escalation without stage 1.
  const c1 = byName(r, "Alpha Search");
  assert.deepEqual(agOf(c1, "AG Dirty").flags, []);
  assert.equal(agOf(c1, "AG Dirty").relevancy_avg, null);
  assert.equal(r.rollup.relevancy_avg, null);
  assert.equal(r.rollup.scored_terms, 0);
  assert.equal(r.rollup.flagged_keywords, 2); // rules run regardless of AI
  assert.deepEqual(r.rollup.action_counts, { keep: 5, pause: 4, none: 1, watch: 2 });
  assert.equal(g.store[NCID].ai_status, "rules_only");
});

await t("campaign-attrs failure -> empty review, warning, snapshot still lands", async () => {
  resetScenario();
  g.pyrData = {
    campaigns: new Map(),
    ad_groups: new Map(),
    keywords: [],
    terms: [],
    geo_location_names: [],
    start: "2026-06-26",
    end: "2026-07-25",
    failed_datasets: new Set(["campaign attrs"]),
    warnings: ["campaign attrs query failed (503)"],
  };
  const r = await engine.runPyramid(CID);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.campaigns, []);
  assert.ok(r.warnings.includes("campaign attrs query failed (503)"));
  assert.ok(
    r.warnings.includes("Campaign data didn't load — the review below is empty. Re-run to retry."),
  );
  assert.equal(r.ai_status, "rules_only");
  assert.equal(calls.length, 0); // early return: no AI stages
  // $0 summary + the baseline-note guard sentence (no conversions in an empty window).
  assert.equal(
    r.executive_summary,
    "Rules-based review of the last 30 days: $0 spent, 0 conversions. " +
      "The account recorded fewer than 3 conversions in the window, so there is no trustworthy " +
      "CPL baseline — all CPL-relative pause rules are disabled this run (data-sufficiency guard).",
  );
  assert.equal(r.baseline_note.length > 0, true);
  assert.ok(g.store[NCID], "snapshot missing on the degraded path");
});

// ---------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll pyramid engine tests passed");
