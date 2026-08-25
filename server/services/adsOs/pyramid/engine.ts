/**
 * Pyramid Breakdown engine: pull -> rules -> relevancy -> strategist -> guards
 * (port of backend/app/pyramid/engine.py).
 *
 * Mirrors the Keyword Intelligence engine (1-hour per-account cache, eligibility
 * gates inside the engine, per-account store snapshot) with one deliberate
 * deviation: AI trouble never fails the request. The deterministic rules engine is
 * independently valuable, so a missing key / dead model / failed batch degrades
 * the report (ai_status = partial | rules_only, with warnings) instead of a 5xx.
 *
 * Post-guards keep the model honest — the arithmetic always wins:
 *   * thin-data entities can never be told to pause/throttle (watch at most);
 *   * "scale" requires the rule-computed scale flag (real CPL + budget-lost IS);
 *   * pause/throttle requires at least one rule flag on the entity;
 *   * non-ENABLED entities are context, never targets;
 *   * a rule-flagged keyword keeps its flag — AI disagreement shows as dissent.
 */

import {
  AUDIT_CACHE_TTL_SECONDS,
  KI_CAMPAIGN_LABEL,
  PYRAMID_AG_HIGH_CPL_MULT,
  PYRAMID_AG_ZERO_CONV_MULT,
  PYRAMID_CAMP_HIGH_CPL_MULT,
  PYRAMID_CAMP_PAUSE_MULT,
  PYRAMID_CAMP_THROTTLE_MULT,
  PYRAMID_KW_HIGH_CPL_MULT,
  PYRAMID_KW_ONE_CONV_MULT,
  PYRAMID_KW_ZERO_CONV_MULT,
  PYRAMID_LOOKBACK_DAYS,
  PYRAMID_MAX_AD_GROUPS_IN_PROMPT,
  PYRAMID_MAX_FLAGGED_KEYWORDS,
  PYRAMID_MAX_TERMS,
  PYRAMID_MIN_CLICKS_FOR_CALL,
  PYRAMID_MIN_CONV_FOR_BASELINE,
  PYRAMID_MIN_SPEND_FOR_CALL,
  PYRAMID_RANK_LIMITED_IS_PCT,
  PYRAMID_SCALE_CPL_RATIO,
  PYRAMID_SCALE_LOST_IS_BUDGET_PCT,
  PYRAMID_THROTTLE_REDUCTION_PCT,
  getOpenAiModel,
  getPyramidOpenAiModel,
  isOpenAiConfigured,
} from "../config";
import {
  deriveDefaults,
  effectiveCriteria,
  loadCriteria,
  type ClientCriteria,
} from "../criteriaService";
import { enrolledAccounts, labeledCampaignIds, mccEnabledAccounts } from "../enrollment";
import { KeyedLocks } from "../singleflight";
import { pyramidBreakdownStore } from "../store";
import {
  runStrategist,
  scoreSearchTerms,
  type StrategistResponse,
  type TermScore,
} from "./ai";
import {
  emptyRollup,
  newPyramidReport,
  type PyramidAdGroup,
  type PyramidKeyword,
  type PyramidNextStep,
  type PyramidReport,
  type PyramidRollup,
  type PyramidSearchTerm,
} from "./models";
import { fetchPyramidData, termKey, type CampaignPull, type KeywordPull, type PyramidData } from "./queries";
import {
  computeBaselines,
  flagAdGroup,
  flagCampaign,
  flagKeyword,
  safeDiv,
  type Baselines,
  type EntityFlags,
  type Thresholds,
} from "./rules";

const CAMPAIGN_ACTIONS = new Set(["scale", "keep", "watch", "throttle", "pause"]);
const AD_GROUP_ACTIONS = new Set(["keep", "watch", "pause"]);

/** All thresholds are env-tunable (spec §9 names, parsed once in config.ts). */
function thresholdsFromConfig(): Thresholds {
  return {
    min_conv_for_baseline: PYRAMID_MIN_CONV_FOR_BASELINE,
    kw_zero_conv_mult: PYRAMID_KW_ZERO_CONV_MULT,
    kw_one_conv_mult: PYRAMID_KW_ONE_CONV_MULT,
    kw_high_cpl_mult: PYRAMID_KW_HIGH_CPL_MULT,
    ag_zero_conv_mult: PYRAMID_AG_ZERO_CONV_MULT,
    ag_high_cpl_mult: PYRAMID_AG_HIGH_CPL_MULT,
    camp_throttle_mult: PYRAMID_CAMP_THROTTLE_MULT,
    camp_pause_mult: PYRAMID_CAMP_PAUSE_MULT,
    camp_high_cpl_mult: PYRAMID_CAMP_HIGH_CPL_MULT,
    scale_cpl_ratio: PYRAMID_SCALE_CPL_RATIO,
    scale_lost_is_budget_pct: PYRAMID_SCALE_LOST_IS_BUDGET_PCT,
    rank_limited_is_pct: PYRAMID_RANK_LIMITED_IS_PCT,
    min_spend_for_call: PYRAMID_MIN_SPEND_FOR_CALL,
    min_clicks_for_call: PYRAMID_MIN_CLICKS_FOR_CALL,
    throttle_reduction_pct: PYRAMID_THROTTLE_REDUCTION_PCT,
  };
}

function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Python `f"{x:,.0f}"` equivalent (whole dollars with thousands separators). */
function fmtComma0(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Python `f"{x:g}"` equivalent for our plain numbers. */
function fmtG(n: number): string {
  return String(n);
}

function sentence(notes: string[]): string {
  if (!notes.length) return "";
  const s = notes.join("; ");
  return s[0].toUpperCase() + s.slice(1) + (s.endsWith(".") ? "" : ".");
}

interface RelAgg {
  rel_avg: number;
  irr_pct: number;
  worst_terms: string[];
}

export async function runPyramid(customerId: string): Promise<PyramidReport> {
  const cid = customerId.replace(/-/g, "").trim();
  const lookback = PYRAMID_LOOKBACK_DAYS;

  let accountName = cid;
  let currency: string | null = null;
  try {
    const acct = (await mccEnabledAccounts()).get(cid);
    if (acct) {
      accountName = acct.name;
      currency = acct.currency;
    }
  } catch {
    // Account-name lookup is cosmetic — an MCC listing failure must not block the run.
  }

  const ineligible = (note: string, campaigns = 0): PyramidReport =>
    newPyramidReport({
      customer_id: cid,
      account_name: accountName,
      currency_code: currency,
      lookback_days: lookback,
      eligible: false,
      monitored_campaigns: campaigns,
      scope_note: note,
    });

  // Scope gates (same two stages as the analyzer): enrollment, then the
  // campaign label.
  const enrolled = await enrolledAccounts("gads");
  if (!enrolled.some((a) => a.cid === cid)) {
    return ineligible(
      "This account isn't enrolled. Add it to the ClickUp Client List (a subtask " +
        "with this account's Google CID) to include it in the Pyramid Breakdown.",
    );
  }
  const campaignIds = await labeledCampaignIds(cid, KI_CAMPAIGN_LABEL);
  if (!campaignIds.length) {
    return ineligible(
      `No campaigns carry the '${KI_CAMPAIGN_LABEL}' label in this ` +
        "account. Label the campaigns you want reviewed.",
    );
  }

  const data = await fetchPyramidData(cid, lookback, campaignIds);

  // Drop dormant entities: ENDED campaigns, and anything not ENABLED with zero
  // window activity (nothing to review, nothing to act on). Paused-with-spend
  // stays — its window spend is exactly what the review judges.
  data.campaigns = new Map(
    [...data.campaigns].filter(
      ([, c]) => c.primary_status !== "ENDED" && (c.status === "ENABLED" || c.impressions > 0),
    ),
  );
  // Ad groups need window ACTIVITY to be reviewable — a zero-impression ad
  // group (enabled or not) has no performance to judge and only adds noise
  // ("enabled but not serving" is the hygiene audit's finding, not this tool's).
  data.ad_groups = new Map(
    [...data.ad_groups].filter(
      ([, g]) => data.campaigns.has(g.campaign_id) && (g.impressions > 0 || g.cost > 0),
    ),
  );
  data.keywords = data.keywords.filter((k) => data.ad_groups.has(k.ad_group_id));
  data.terms = data.terms.filter((t) => data.ad_groups.has(t.ad_group_id));

  const th = thresholdsFromConfig();
  const baselines = computeBaselines(data.campaigns, th);

  const report = newPyramidReport({
    customer_id: cid,
    account_name: accountName,
    currency_code: currency,
    lookback_days: lookback,
    window_start: data.start,
    window_end: data.end,
    account_cost: baselines.account_cost,
    account_conversions: baselines.account_conversions,
    account_cpl: baselines.account_cpl,
    eligible: true,
    monitored_campaigns: campaignIds.length,
    scope_note: `Reviewing ${campaignIds.length} labeled campaign(s), last ${lookback} full days.`,
    warnings: [...data.warnings],
  });
  if (baselines.account_cpl === null) {
    report.baseline_note =
      `The account recorded fewer than ${fmtG(th.min_conv_for_baseline)} conversions in the ` +
      "window, so there is no trustworthy CPL baseline — all CPL-relative pause rules are " +
      "disabled this run (data-sufficiency guard).";
  }
  if (data.failed_datasets.has("campaign attrs") || data.campaigns.size === 0) {
    if (data.failed_datasets.has("campaign attrs")) {
      report.warnings.push(
        "Campaign data didn't load — the review below is empty. Re-run to retry.",
      );
    }
    report.executive_summary = rulesSummary(report, emptyRollup());
    await persistSnapshot(report);
    return report;
  }

  // --- Deterministic rule passes ---
  const campFlags = new Map<string, EntityFlags>(
    [...data.campaigns].map(([k, c]) => [k, flagCampaign(c, baselines, th)]),
  );
  const agFlags = new Map<string, EntityFlags>(
    [...data.ad_groups].map(([k, g]) => [
      k,
      flagAdGroup(g, baselines.campaign_baseline.get(g.campaign_id), th),
    ]),
  );
  const kwFlags: EntityFlags[] = data.keywords.map((kw) =>
    flagKeyword(kw, baselines.campaign_baseline.get(kw.campaign_id), th),
  );

  // --- Stage 1: search-term relevancy (skipped when AI is off or terms failed) ---
  const { criteria: stored, hasSaved } = await loadCriteria(cid);
  const derived = deriveDefaults(accountName, data.geo_location_names);
  const crit = effectiveCriteria(stored, derived);
  report.has_criteria = hasSaved;

  let scores = new Map<string, TermScore>();
  let stage1Warned = false;
  const scorableAll = data.terms.filter(
    (t) => t.targeting_status !== "EXCLUDED" && t.targeting_status !== "ADDED_EXCLUDED",
  );
  const scorable = scorableAll.slice(0, PYRAMID_MAX_TERMS);
  if (isOpenAiConfigured() && scorable.length && !data.failed_datasets.has("search terms")) {
    const termsByAg = new Map<string, typeof scorable>();
    for (const t of scorable) {
      const list = termsByAg.get(t.ad_group_id) ?? [];
      list.push(t);
      termsByAg.set(t.ad_group_id, list);
    }
    const kwsByAg = new Map<string, string[]>();
    for (const kw of [...data.keywords].sort((a, b) => b.cost - a.cost)) {
      const list = kwsByAg.get(kw.ad_group_id) ?? [];
      list.push(kw.text);
      kwsByAg.set(kw.ad_group_id, list);
    }
    const names = new Map<string, string>([...data.ad_groups].map(([k, g]) => [k, g.name]));
    try {
      const s1 = await scoreSearchTerms(crit, termsByAg, kwsByAg, names);
      scores = s1.scores;
      stage1Warned = s1.warnings.length > 0;
      report.warnings.push(...s1.warnings);
    } catch (exc: any) {
      // Degrade, never 5xx.
      stage1Warned = true;
      report.warnings.push(
        `Search-term relevancy scoring failed (${exc?.message ?? exc}); terms show without scores.`,
      );
    }
  }
  const droppedTerms = scorableAll.length - scorable.length;
  if (scores.size && droppedTerms > 0) {
    // The cap only matters when scoring actually ran.
    report.warnings.push(
      `Scored the ${scorable.length} highest-cost search terms; ${droppedTerms} lower-cost ` +
        "term(s) were not scored this run (raise PYRAMID_MAX_TERMS to include them).",
    );
  }

  // Per-ad-group relevancy aggregates (+ the dirty-traffic flag for the AI).
  const relByAg = new Map<string, RelAgg>();
  for (const [agId] of data.ad_groups) {
    const scored: Array<[(typeof data.terms)[number], TermScore]> = [];
    for (const t of data.terms) {
      if (t.ad_group_id !== agId) continue;
      const s = scores.get(termKey(agId, t.search_term));
      if (s) scored.push([t, s]);
    }
    if (!scored.length) continue;
    const totalCost = scored.reduce((s, [t]) => s + t.cost, 0);
    let relAvg: number;
    let irrPct: number;
    if (totalCost > 0) {
      relAvg = scored.reduce((s, [t, sc]) => s + t.cost * sc.relevancy, 0) / totalCost;
      irrPct =
        (100 *
          scored.reduce((s, [t, sc]) => s + (sc.label === "irrelevant" ? t.cost : 0), 0)) /
        totalCost;
    } else {
      relAvg = scored.reduce((s, [, sc]) => s + sc.relevancy, 0) / scored.length;
      irrPct = (100 * scored.filter(([, sc]) => sc.label === "irrelevant").length) / scored.length;
    }
    const worst = [...scored]
      .sort((a, b) => b[0].cost - a[0].cost)
      .filter(([, sc]) => sc.label === "irrelevant" || sc.label === "adjacent")
      .slice(0, 5)
      .map(([t]) => t.search_term);
    relByAg.set(agId, {
      rel_avg: round1(relAvg),
      irr_pct: round1(irrPct),
      worst_terms: worst,
    });
    if (irrPct >= 40) {
      const f = agFlags.get(agId)!;
      f.flags.push("AG_IRRELEVANT_TRAFFIC");
      f.notes.push(
        `${irrPct.toFixed(0)}% of scored search spend is on irrelevant terms — the traffic ` +
          "mix needs negatives/targeting work",
      );
      if (f.suggested_action === "keep" && !f.insufficient_data) {
        f.suggested_action = "watch";
      }
    }
  }

  // --- Stage 2: the strategist (one advanced-model call) ---
  const campOrder = [...data.campaigns.values()].sort((a, b) => b.cost - a.cost);
  const agOrder = [...data.ad_groups.values()].sort((a, b) => b.cost - a.cost);
  const flaggedKws: Array<[KeywordPull, EntityFlags]> = [];
  data.keywords.forEach((kw, i) => {
    if (kwFlags[i].suggested_action === "pause") flaggedKws.push([kw, kwFlags[i]]);
  });
  flaggedKws.sort((a, b) => b[0].cost - a[0].cost);
  const promptKws = flaggedKws.slice(0, PYRAMID_MAX_FLAGGED_KEYWORDS);
  const promptAgs = agOrder.slice(0, PYRAMID_MAX_AD_GROUPS_IN_PROMPT);

  let verdicts: StrategistResponse | null = null;
  let modelUsed = "";
  if (isOpenAiConfigured()) {
    const payload = buildStrategistPayload(
      report,
      baselines,
      crit,
      campOrder,
      campFlags,
      promptAgs,
      agFlags,
      relByAg,
      promptKws,
      agOrder.slice(PYRAMID_MAX_AD_GROUPS_IN_PROMPT),
    );
    try {
      const s2 = await runStrategist(payload);
      verdicts = s2.verdicts;
      modelUsed = s2.modelUsed;
      report.warnings.push(...s2.warnings);
    } catch (exc: any) {
      // runStrategist only throws NotConfigured (key vanished between gates —
      // dynamic env reads make that race possible here, unlike the bundle's
      // cached settings). Same degradation as a strategist failure.
      report.warnings.push(
        `AI strategist failed (${exc?.message ?? exc}); showing the rules-based verdicts only.`,
      );
    }
    report.ai_model_used = modelUsed;
  } else {
    report.warnings.push(
      "OPENAI_API_KEY is not set — showing the rules-based review only " +
        "(no relevancy scores or AI verdicts).",
    );
  }

  // --- Merge + guards + assembly ---
  const guardNotes = assemble(
    report,
    data,
    baselines,
    campOrder,
    campFlags,
    agFlags,
    kwFlags,
    scores,
    relByAg,
    verdicts,
    promptAgs,
    promptKws,
  );
  if (guardNotes.length) report.warnings.push(...guardNotes);

  // ai_status: what actually powered this report.
  const requested = getPyramidOpenAiModel().trim() || getOpenAiModel();
  if (!isOpenAiConfigured()) {
    report.ai_status = "rules_only";
  } else if (verdicts !== null && !stage1Warned && modelUsed === requested) {
    report.ai_status = "full";
  } else if (verdicts !== null || scores.size) {
    report.ai_status = "partial";
  } else {
    report.ai_status = "rules_only";
  }

  if (verdicts === null) {
    report.executive_summary = rulesSummary(report, report.rollup);
  }

  await persistSnapshot(report);
  return report;
}

/** The compact JSON the strategist sees: integer refs, whole-dollar rounding,
 * flags included — everything it needs, nothing it doesn't. */
function buildStrategistPayload(
  report: PyramidReport,
  baselines: Baselines,
  crit: ClientCriteria,
  campOrder: CampaignPull[],
  campFlags: Map<string, EntityFlags>,
  promptAgs: Array<PyramidData["ad_groups"] extends Map<string, infer V> ? V : never>,
  agFlags: Map<string, EntityFlags>,
  relByAg: Map<string, RelAgg>,
  promptKws: Array<[KeywordPull, EntityFlags]>,
  omittedAgs: Array<PyramidData["ad_groups"] extends Map<string, infer V> ? V : never>,
): Record<string, unknown> {
  const campRef = new Map(campOrder.map((c, i) => [c.id, i]));
  const agRef = new Map(promptAgs.map((g, i) => [g.id, i]));

  const money = (v: number | null | undefined): number | null =>
    v === null || v === undefined ? null : Math.round(v);

  const account: Record<string, unknown> = {
    cost: money(baselines.account_cost),
    conv: round1(baselines.account_conversions),
    cpl: money(baselines.account_cpl),
    window: `${report.window_start}..${report.window_end}`,
  };
  if (report.baseline_note) account.baseline_note = report.baseline_note;
  if (baselines.single_campaign) account.single_campaign = true;
  if (omittedAgs.length) {
    account.ad_groups_omitted = {
      count: omittedAgs.length,
      cost: money(omittedAgs.reduce((s, g) => s + g.cost, 0)),
    };
  }

  const campaigns: Array<Record<string, unknown>> = [];
  for (const c of campOrder) {
    const fl = campFlags.get(c.id)!;
    const row: Record<string, unknown> = {
      ref: campRef.get(c.id),
      name: c.name,
      status: c.status,
      chan: c.channel_type,
      bid: c.bidding_strategy_type,
      cost: money(c.cost),
      conv: round1(c.conversions),
      cpl: money(safeDiv(c.cost, c.conversions)),
      flags: fl.flags,
      thin: fl.insufficient_data,
    };
    if (c.target_cpa) row.tcpa = money(c.target_cpa);
    if (c.budget) row.budget_day = money(c.budget);
    if (c.search_is !== null) row.is = Math.round(c.search_is);
    if (c.lost_is_budget !== null) row.lost_b = Math.round(c.lost_is_budget);
    if (c.lost_is_rank !== null) row.lost_r = Math.round(c.lost_is_rank);
    campaigns.push(row);
  }

  const adGroups: Array<Record<string, unknown>> = [];
  for (const g of promptAgs) {
    const fl = agFlags.get(g.id)!;
    const row: Record<string, unknown> = {
      ref: agRef.get(g.id),
      camp: campRef.get(g.campaign_id) ?? null,
      name: g.name,
      status: g.status,
      cost: money(g.cost),
      conv: round1(g.conversions),
      cpl: money(safeDiv(g.cost, g.conversions)),
      flags: fl.flags,
      thin: fl.insufficient_data,
    };
    const rel = relByAg.get(g.id);
    if (rel) Object.assign(row, rel);
    adGroups.push(row);
  }

  const keywords: Array<Record<string, unknown>> = [];
  promptKws.forEach(([kw, fl], i) => {
    keywords.push({
      ref: i,
      ag: agRef.get(kw.ad_group_id) ?? null,
      text: kw.text,
      mt: kw.match_type,
      cost: money(kw.cost),
      conv: round1(kw.conversions),
      cpl: money(safeDiv(kw.cost, kw.conversions)),
      qs: kw.quality_score || null,
      flags: fl.flags,
    });
  });

  const clientBlock = {
    practice_areas: crit.practice_areas,
    service_area: crit.service_area,
    services_not_offered: crit.services_not_offered,
    notes: crit.notes,
  };
  return {
    account,
    client: clientBlock,
    campaigns,
    ad_groups: adGroups,
    keywords,
  };
}

/** Merge AI verdicts onto the rule flags under the guards, then build the
 * nested report + rollups. Returns guard warnings. */
function assemble(
  report: PyramidReport,
  data: PyramidData,
  baselines: Baselines,
  campOrder: CampaignPull[],
  campFlags: Map<string, EntityFlags>,
  agFlags: Map<string, EntityFlags>,
  kwFlags: EntityFlags[],
  scores: Map<string, TermScore>,
  relByAg: Map<string, RelAgg>,
  verdicts: StrategistResponse | null,
  promptAgs: Array<{ id: string }>,
  promptKws: Array<[KeywordPull, EntityFlags]>,
): string[] {
  const guardNotes: string[] = [];
  const campV = new Map(verdicts ? verdicts.campaigns.map((v) => [v.ref, v]) : []);
  const agV = new Map(verdicts ? verdicts.ad_groups.map((v) => [v.ref, v]) : []);
  const kwV = new Map(verdicts ? verdicts.keywords.map((v) => [v.ref, v]) : []);
  const campRef = new Map(campOrder.map((c, i) => [c.id, i]));
  const agRef = new Map(promptAgs.map((g, i) => [g.id, i]));
  // Object-identity ref map (the same KeywordPull objects flow through both lists).
  const kwPromptRef = new Map<KeywordPull, number>(promptKws.map(([kw], i) => [kw, i]));
  let badVerdicts = 0;

  /** (final action, guard note). Deterministic arithmetic always wins. */
  const guarded = (
    action: string,
    fl: EntityFlags,
    allowed: Set<string>,
    status: string,
  ): [string, string] => {
    let note = "";
    if (!allowed.has(action)) {
      badVerdicts += 1;
      action = fl.suggested_action;
    }
    if (status !== "ENABLED") {
      return ["none", ""];
    }
    if ((action === "pause" || action === "throttle") && fl.insufficient_data) {
      action = "watch";
      note = "guard: not enough data for a pause call";
    } else if ((action === "pause" || action === "throttle") && !fl.flags.length) {
      action = "watch";
      note = "guard: no rule flag supports a pause here";
    } else if (action === "scale" && !fl.scale_candidate) {
      action = "keep";
      note = "guard: no rule-verified scaling headroom";
    }
    return [action, note];
  };

  // --- Keywords by ad group (rules decide the action; AI is annotation) ---
  const kwsByAg = new Map<string, PyramidKeyword[]>();
  const keywordActions: Record<string, number> = {};
  const killer: PyramidKeyword[] = [];
  data.keywords.forEach((kw, i) => {
    const fl = kwFlags[i];
    const m: PyramidKeyword = {
      criterion_id: kw.criterion_id,
      text: kw.text,
      match_type: kw.match_type,
      status: kw.status,
      quality_score: kw.quality_score,
      cost: kw.cost,
      conversions: round2(kw.conversions),
      clicks: kw.clicks,
      impressions: kw.impressions,
      cpl: safeDiv(kw.cost, kw.conversions),
      flags: fl.flags,
      action: fl.suggested_action,
      rationale: sentence(fl.notes),
      ai_agrees: null,
      insufficient_data: fl.insufficient_data,
      campaign_name: "",
      ad_group_name: "",
    };
    const ref = kwPromptRef.get(kw);
    const v = ref !== undefined ? kwV.get(ref) : undefined;
    if (v !== undefined) {
      m.ai_agrees = v.agree;
      if (v.rationale) m.rationale = v.rationale;
    }
    const list = kwsByAg.get(kw.ad_group_id) ?? [];
    list.push(m);
    kwsByAg.set(kw.ad_group_id, list);
    keywordActions[m.action] = (keywordActions[m.action] ?? 0) + 1;
    if (m.action === "pause") {
      const ag = data.ad_groups.get(kw.ad_group_id);
      const camp = data.campaigns.get(kw.campaign_id);
      killer.push({
        ...m,
        ad_group_name: ag ? ag.name : "",
        campaign_name: camp ? camp.name : "",
      });
    }
  });

  // --- Search terms by ad group ---
  const termsByAg = new Map<string, PyramidSearchTerm[]>();
  const worstTerms: PyramidSearchTerm[] = [];
  let scoredTerms = 0;
  let scoredCost = 0.0;
  let irrelevantCost = 0.0;
  let relWeighted = 0.0;
  for (const t of data.terms) {
    const s = scores.get(termKey(t.ad_group_id, t.search_term));
    const m: PyramidSearchTerm = {
      search_term: t.search_term,
      targeting_status: t.targeting_status,
      matched_keywords: t.matched_keywords.slice(0, 3),
      cost: t.cost,
      conversions: round2(t.conversions),
      clicks: t.clicks,
      impressions: t.impressions,
      relevancy: null,
      relevancy_label: "",
      relevancy_reason: "",
    };
    if (s !== undefined) {
      m.relevancy = s.relevancy;
      m.relevancy_label = s.label;
      m.relevancy_reason = s.reason;
      scoredTerms += 1;
      scoredCost += t.cost;
      relWeighted += t.cost * s.relevancy;
      if (s.label === "irrelevant") {
        irrelevantCost += t.cost;
        worstTerms.push(m);
      }
    }
    const list = termsByAg.get(t.ad_group_id) ?? [];
    list.push(m);
    termsByAg.set(t.ad_group_id, list);
  }

  // --- Ad groups by campaign (guarded AI action) ---
  const agsByCamp = new Map<string, PyramidAdGroup[]>();
  const adGroupActions: Record<string, number> = {};
  const agOrderAll = [...data.ad_groups.values()].sort((a, b) => b.cost - a.cost);
  for (const g of agOrderAll) {
    const fl = agFlags.get(g.id)!;
    const ref = agRef.get(g.id);
    const v = ref !== undefined ? agV.get(ref) : undefined;
    const [action, note] = guarded(
      v ? v.action : fl.suggested_action,
      fl,
      AD_GROUP_ACTIONS,
      g.status,
    );
    let rationale = v && v.rationale ? v.rationale : sentence(fl.notes);
    if (note) rationale = rationale ? `${rationale} (${note})` : note;
    const kws = [...(kwsByAg.get(g.id) ?? [])].sort((a, b) => b.cost - a.cost);
    const kwsShown = [
      ...kws.filter((k) => k.action === "pause"),
      ...kws.filter((k) => k.action !== "pause").slice(0, 50),
    ];
    const terms = [...(termsByAg.get(g.id) ?? [])].sort((a, b) => b.cost - a.cost);
    const termsShown = [
      ...terms.filter((t) => t.relevancy_label === "irrelevant" || t.relevancy_label === "adjacent"),
      ...terms
        .filter((t) => t.relevancy_label !== "irrelevant" && t.relevancy_label !== "adjacent")
        .slice(0, 25),
    ];
    const rel = relByAg.get(g.id);
    const row: PyramidAdGroup = {
      id: g.id,
      name: g.name,
      status: g.status,
      cost: g.cost,
      conversions: round2(g.conversions),
      clicks: g.clicks,
      impressions: g.impressions,
      cpl: safeDiv(g.cost, g.conversions),
      relevancy_avg: rel ? rel.rel_avg : null,
      irrelevant_cost_pct: rel ? rel.irr_pct : null,
      flags: fl.flags,
      action,
      rationale,
      insufficient_data: fl.insufficient_data,
      keywords: [...kwsShown].sort((a, b) => b.cost - a.cost),
      keywords_total: kws.length,
      search_terms: [...termsShown].sort((a, b) => b.cost - a.cost),
      search_terms_total: terms.length,
    };
    const list = agsByCamp.get(g.campaign_id) ?? [];
    list.push(row);
    agsByCamp.set(g.campaign_id, list);
    adGroupActions[action] = (adGroupActions[action] ?? 0) + 1;
  }

  // --- Campaigns (guarded AI action) ---
  const campaignActions: Record<string, number> = {};
  for (const c of campOrder) {
    const fl = campFlags.get(c.id)!;
    const v = campV.get(campRef.get(c.id)!);
    const [action, note] = guarded(
      v ? v.action : fl.suggested_action,
      fl,
      CAMPAIGN_ACTIONS,
      c.status,
    );
    let rationale = v && v.rationale ? v.rationale : sentence(fl.notes);
    if (note) rationale = rationale ? `${rationale} (${note})` : note;
    const budgetChange =
      action === "scale" || action === "throttle" ? fl.recommended_budget_change_pct : null;
    report.campaigns.push({
      id: c.id,
      name: c.name,
      status: c.status,
      channel_type: c.channel_type,
      bidding_strategy_type: c.bidding_strategy_type,
      target_cpa: c.target_cpa,
      daily_budget: c.budget,
      cost: c.cost,
      conversions: round2(c.conversions),
      clicks: c.clicks,
      impressions: c.impressions,
      cpl: safeDiv(c.cost, c.conversions),
      baseline_cpl: baselines.campaign_baseline.get(c.id) ?? null,
      baseline_source: baselines.campaign_baseline_source.get(c.id) ?? "none",
      search_is: c.search_is,
      lost_is_budget: c.lost_is_budget,
      lost_is_rank: c.lost_is_rank,
      flags: fl.flags,
      action,
      rationale,
      confidence: v ? round2(Math.min(1.0, Math.max(0.0, v.confidence))) : null,
      recommended_budget_change_pct: budgetChange,
      insufficient_data: fl.insufficient_data,
      scale_candidate: fl.scale_candidate,
      ad_groups: agsByCamp.get(c.id) ?? [],
    });
    campaignActions[action] = (campaignActions[action] ?? 0) + 1;
  }

  if (badVerdicts) {
    guardNotes.push(
      `${badVerdicts} AI verdict(s) used an unknown action and fell back to the rules.`,
    );
  }

  // --- Rollups ---
  killer.sort((a, b) => b.cost - a.cost);
  worstTerms.sort((a, b) => b.cost - a.cost);
  // Level-agnostic counts for the summary chips. Keyword keeps/nones are
  // excluded — "Keep 1880" (every healthy keyword) would drown the counts that
  // matter; keywords only register when they demand attention (pause/watch).
  const actionCounts: Record<string, number> = {};
  for (const d of [campaignActions, adGroupActions]) {
    for (const [k, n] of Object.entries(d)) {
      actionCounts[k] = (actionCounts[k] ?? 0) + n;
    }
  }
  for (const k of ["pause", "watch"]) {
    if (keywordActions[k]) {
      actionCounts[k] = (actionCounts[k] ?? 0) + keywordActions[k];
    }
  }
  report.rollup = {
    action_counts: actionCounts,
    campaign_actions: campaignActions,
    ad_group_actions: adGroupActions,
    keyword_actions: keywordActions,
    flagged_keywords: killer.length,
    flagged_keyword_cost: round2(killer.reduce((s, k) => s + k.cost, 0)),
    killer_keywords: killer.slice(0, 15),
    worst_terms: worstTerms.slice(0, 15),
    scored_terms: scoredTerms,
    scored_term_cost: round2(scoredCost),
    irrelevant_term_cost: round2(irrelevantCost),
    relevancy_avg: scoredCost > 0 ? round1(relWeighted / scoredCost) : null,
  };

  // --- Summary + next steps ---
  if (verdicts !== null) {
    report.executive_summary = verdicts.executive_summary.trim();
    const steps = [...verdicts.next_steps].sort((a, b) => a.priority - b.priority).slice(0, 8);
    report.next_steps = steps
      .map((s, i) => ({ priority: i + 1, step: s.step.trim() }))
      .filter((s) => s.step);
  }
  if (!report.next_steps.length) {
    report.next_steps = rulesNextSteps(report);
  }
  return guardNotes;
}

function rulesSummary(report: PyramidReport, rollup: PyramidRollup): string {
  const bits: string[] = [
    `Rules-based review of the last ${report.lookback_days} days: ` +
      `$${fmtComma0(report.account_cost)} spent, ${fmtG(report.account_conversions)} conversions` +
      (report.account_cpl ? ` ($${fmtComma0(report.account_cpl)} CPL).` : "."),
  ];
  const ca = rollup.campaign_actions;
  for (const action of ["pause", "throttle", "scale", "watch"]) {
    if (ca[action]) {
      bits.push(`${ca[action]} campaign(s) to ${action}.`);
    }
  }
  if (rollup.flagged_keywords) {
    bits.push(
      `${rollup.flagged_keywords} killer keyword(s) burning ` +
        `$${fmtComma0(rollup.flagged_keyword_cost)}.`,
    );
  }
  if (report.baseline_note) bits.push(report.baseline_note);
  return bits.join(" ");
}

/** Synthesized priorities when the strategist is unavailable: biggest money
 * moves first, straight from the guarded actions. */
function rulesNextSteps(report: PyramidReport): PyramidNextStep[] {
  const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
  const steps: Array<[number, string]> = [];
  for (const c of report.campaigns) {
    if (c.action === "pause" || c.action === "throttle" || c.action === "scale") {
      steps.push([c.cost, `${capitalize(c.action)} campaign \u201C${c.name}\u201D — ${c.rationale}`]);
    }
    for (const g of c.ad_groups) {
      if (g.action === "pause") {
        steps.push([g.cost, `Pause ad group \u201C${g.name}\u201D (${c.name}) — ${g.rationale}`]);
      }
    }
  }
  for (const k of report.rollup.killer_keywords.slice(0, 3)) {
    steps.push([k.cost, `Pause keyword \u201C${k.text}\u201D (${k.ad_group_name}) — ${k.rationale}`]);
  }
  steps.sort((a, b) => b[0] - a[0]);
  return steps.slice(0, 8).map(([, s], i) => ({ priority: i + 1, step: s }));
}

/** Best-effort compact snapshot (dashboard/profile-sized, never the full tree). */
async function persistSnapshot(report: PyramidReport): Promise<void> {
  const top: Array<Record<string, string>> = [];
  for (const c of report.campaigns) {
    if (c.action === "pause" || c.action === "throttle" || c.action === "scale") {
      top.push({
        level: "campaign",
        name: c.name,
        action: c.action,
        rationale: c.rationale.slice(0, 140),
      });
    }
  }
  for (const k of report.rollup.killer_keywords) {
    if (top.length >= 5) break;
    top.push({
      level: "keyword",
      name: k.text,
      action: "pause",
      rationale: k.rationale.slice(0, 140),
    });
  }
  // Store put is already log-and-swallow (best-effort by design).
  await pyramidBreakdownStore.put(report.customer_id, {
    action_counts: report.rollup.action_counts,
    campaign_actions: report.rollup.campaign_actions,
    flagged_keywords: report.rollup.flagged_keywords,
    flagged_keyword_cost: report.rollup.flagged_keyword_cost,
    irrelevant_term_cost: report.rollup.irrelevant_term_cost,
    top_recommendations: top.slice(0, 5),
    ai_status: report.ai_status,
    lookback_days: report.lookback_days,
    generated_at: report.generated_at,
  });
}

// --- 1-hour per-account cache (house discipline; window is fixed so the key is
//     just the account) ---
const cache = new Map<string, { at: number; report: PyramidReport }>();
const locks = new KeyedLocks(); // single-flight the Ads pulls + OpenAI calls per account

/** Criteria (including ClickUp-authoritative practice areas) feed the report's
 * AI context, so any successful criteria save must evict this account. */
export function invalidatePyramid(customerId: string): void {
  cache.delete(customerId.replace(/-/g, "").trim());
}

export async function runPyramidCached(
  customerId: string,
  force = false,
): Promise<{ report: PyramidReport; fromCache: boolean }> {
  const key = customerId.replace(/-/g, "").trim();
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): PyramidReport | null => {
    const cached = cache.get(key);
    return cached && Date.now() - cached.at < ttlMs ? cached.report : null;
  };

  if (!force) {
    const report = hit();
    if (report !== null) return { report, fromCache: true };
  }
  return locks.withLock(key, async () => {
    if (!force) {
      const report = hit();
      if (report !== null) return { report, fromCache: true };
    }
    const report = await runPyramid(customerId);
    cache.set(key, { at: Date.now(), report });
    return { report, fromCache: false };
  });
}

/** Test hook: reset the module cache between scenarios. */
export function __testResetPyramidCache(): void {
  cache.clear();
}
