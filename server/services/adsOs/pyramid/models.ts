/**
 * Pyramid Breakdown — API-surface models (port of backend/app/pyramid/models.py).
 *
 * The report is nested like the account itself — campaigns own ad groups, ad
 * groups own keywords + search terms — plus flat rollups (killer keywords, worst
 * terms, action counts) so the UI's cross-campaign tables don't re-walk the tree.
 * The AI never emits these models directly; its private schemas live in ai.ts and
 * the engine merges verdicts in under deterministic guards.
 *
 * JSON stays snake_case end-to-end (mirrored 1:1 in client/src/pages/adsOs/lib/types.ts).
 */

export interface PyramidSearchTerm {
  search_term: string;
  targeting_status: string; // ADDED | EXCLUDED | ADDED_EXCLUDED | NONE
  matched_keywords: string[];
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
  relevancy: number | null; // 0-100; null = not scored (cap / AI failed / excluded)
  relevancy_label: string; // high_intent | relevant | adjacent | irrelevant | ""
  relevancy_reason: string;
}

export interface PyramidKeyword {
  criterion_id: string;
  text: string;
  match_type: string;
  status: string;
  quality_score: number; // 1-10; 0 = not reported
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
  cpl: number | null;
  flags: string[];
  action: string; // pause | watch | keep | none
  rationale: string;
  ai_agrees: boolean | null; // null = AI didn't comment; false = dissent (flag stays)
  insufficient_data: boolean;
  // For the flat killer-keywords rollup (set there only).
  campaign_name: string;
  ad_group_name: string;
}

export interface PyramidAdGroup {
  id: string;
  name: string;
  status: string;
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
  cpl: number | null;
  relevancy_avg: number | null; // cost-weighted avg over scored terms
  irrelevant_cost_pct: number | null;
  flags: string[];
  action: string; // pause | watch | keep | none
  rationale: string;
  insufficient_data: boolean;
  keywords: PyramidKeyword[];
  keywords_total: number; // before the display cap
  search_terms: PyramidSearchTerm[];
  search_terms_total: number;
}

export interface PyramidCampaign {
  id: string;
  name: string;
  status: string;
  channel_type: string;
  bidding_strategy_type: string;
  target_cpa: number | null;
  daily_budget: number | null;
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
  cpl: number | null;
  baseline_cpl: number | null; // what its children were judged against
  baseline_source: string; // campaign | account | none
  search_is: number | null; // percents 0-100
  lost_is_budget: number | null;
  lost_is_rank: number | null;
  flags: string[];
  action: string; // scale | keep | watch | throttle | pause | none
  rationale: string;
  confidence: number | null; // strategist confidence 0-1
  recommended_budget_change_pct: number | null; // +25 scale / -30 throttle
  insufficient_data: boolean;
  scale_candidate: boolean;
  ad_groups: PyramidAdGroup[];
}

export interface PyramidNextStep {
  priority: number;
  step: string;
}

export interface PyramidRollup {
  action_counts: Record<string, number>; // all levels combined
  campaign_actions: Record<string, number>;
  ad_group_actions: Record<string, number>;
  keyword_actions: Record<string, number>;
  flagged_keywords: number;
  flagged_keyword_cost: number; // spend on pause-flagged ("killer") keywords
  killer_keywords: PyramidKeyword[]; // top 15 by cost, flat
  worst_terms: PyramidSearchTerm[]; // top 15 irrelevant by cost
  scored_terms: number;
  scored_term_cost: number;
  irrelevant_term_cost: number;
  relevancy_avg: number | null; // cost-weighted, account-wide
}

export interface PyramidReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string; // ISO datetime
  lookback_days: number;
  window_start: string;
  window_end: string;

  account_cost: number;
  account_conversions: number;
  account_cpl: number | null;
  baseline_note: string; // e.g. "CPL rules disabled: too few conversions"

  executive_summary: string;
  next_steps: PyramidNextStep[];
  campaigns: PyramidCampaign[];
  rollup: PyramidRollup;

  ai_status: string; // full | partial | rules_only
  ai_model_used: string; // model that produced stage 2 ("" if none)

  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  has_criteria: boolean;
  warnings: string[];
  from_cache: boolean;
}

/** Pydantic default_factory equivalent for PyramidRollup. */
export function emptyRollup(): PyramidRollup {
  return {
    action_counts: {},
    campaign_actions: {},
    ad_group_actions: {},
    keyword_actions: {},
    flagged_keywords: 0,
    flagged_keyword_cost: 0.0,
    killer_keywords: [],
    worst_terms: [],
    scored_terms: 0,
    scored_term_cost: 0.0,
    irrelevant_term_cost: 0.0,
    relevancy_avg: null,
  };
}

/** PyramidReport with the models.py defaults; call sites override what they set. */
export function newPyramidReport(
  base: Pick<PyramidReport, "customer_id" | "account_name" | "currency_code"> &
    Partial<PyramidReport>,
): PyramidReport {
  return {
    generated_at: new Date().toISOString(),
    lookback_days: 30,
    window_start: "",
    window_end: "",
    account_cost: 0.0,
    account_conversions: 0.0,
    account_cpl: null,
    baseline_note: "",
    executive_summary: "",
    next_steps: [],
    campaigns: [],
    rollup: emptyRollup(),
    ai_status: "rules_only",
    ai_model_used: "",
    eligible: true,
    monitored_campaigns: 0,
    scope_note: "",
    has_criteria: false,
    warnings: [],
    from_cache: false,
    ...base,
  };
}
