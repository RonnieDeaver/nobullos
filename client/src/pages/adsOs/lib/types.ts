/**
 * Ads OS frontend types — 1:1 with the server payloads (snake_case, ported from
 * the bundle's frontend/src/types.ts, trimmed to what Phase 1 renders).
 * Overlay fields owned by later phases (pacing/hygiene/quality/alerts) stay in
 * the shapes — the server sends them as null/[] until those phases land.
 */

export type Product = "gads" | "lsa";

/** ClickUp Ads Status; null = blank (treated as On). */
export type AdsStatus = "on" | "paused" | "off" | null;

/** Pointer to the ClickUp task created for an alert (Phase 6). */
export interface ClickUpTaskRef {
  task_id: string;
  url: string | null;
}

export interface Alert {
  code: string;
  severity: "critical" | "high" | "medium";
  title: string;
  detail: string;
  product: Product;
  campaign_id: string | null;
  deep_link: string | null;
  clickup_task: ClickUpTaskRef | null;
}

/** What every run-alerts endpoint actually returns (server RunAlertsSummary):
 *  enrolled-account counts per product (0 = product not requested, or
 *  enrollment resolved empty — the dashboards surface the latter as a notice),
 *  total alerts persisted, and the digest outcome (always skipped for
 *  dashboard-triggered runs — only the morning cron notifies). */
export interface RunAlertsSummary {
  gads_accounts: number;
  lsa_accounts: number;
  total_alerts: number;
  digest: Record<string, unknown>;
}

export interface DashboardRow {
  customer_id: string;
  descriptive_name: string;
  client_name: string | null;
  /** ClickUp-authoritative labels from the account's live parent client. */
  practice_areas: string[];
  currency_code: string | null;
  doer: string | null;
  checker: string | null;
  spend_30d: number;
  conversions_30d: number;
  cpa_30d: number | null;
  spend_prev: number;
  conversions_prev: number;
  cpa_prev: number | null;
  ads_running: boolean;
  // Phase 2+ overlays (null until those phases land)
  health_score: number | null;
  health_band: string | null;
  health_at: string | null;
  budget_pacing_pct: number | null;
  monthly_budget: number | null;
  mtd_spend: number | null;
  recommended_daily_budget: number | null;
  traffic_quality: number | null;
  quality_at: string | null;
  quality_window: number | null;
  quality_coverage: number | null;
  alerts: Alert[];
  alerts_at: string | null;
  /** The account's GAds schedule from criteria (empty = every day). Display
   *  only — shows which schedule the pacing figures assume. Optional: older
   *  cached payloads predate the field. */
  schedule_days?: string[];
  /** Where the applied schedule came from: "saved" criteria, "inferred" from
   *  recent daily spend, or "default" (every day). Task #3706. */
  schedule_source?: string | null;
  /** Scheduled days elapsed this month per the last pacing run. 0 + a budget +
   *  null pct = neutral "Not started" state (early-month weekend), not missing
   *  data. null/absent = unknown (older doc). Task #3706. */
  scheduled_days_elapsed?: number | null;
  /** Task #4865: ClickUp Ads Status (null = blank = On). Overlaid live.
   *  Optional — stale cached payloads predate this field. */
  ads_status?: AdsStatus;
  /** Morning Paused/Off verification verdict. Null for On accounts or unchecked. */
  status_check?: StatusCheck | null;
}

export interface DashboardResponse {
  rows: DashboardRow[];
  generated_at: string;
  from_cache: boolean;
  window: number;
  compare: string;
  clickup_live: boolean;
  /** ISO time of the directory bundle's last successful fetch when it is older
   *  than the staleness threshold (~20 min); null when fresh (Task #3608). */
  clickup_stale_since: string | null;
  /** One-line reason the ClickUp directory is not live (HTTP status / error
   *  class / unconfigured token), for the outage banner; null while healthy.
   *  Optional: older cached payloads predate the field. */
  clickup_reason?: string | null;
  /** Age of the ClickUp directory bundle in ms (null = never fetched). Drives
   *  the topbar "Reload directory" button (Task #3609). */
  clickup_bundle_age_ms: number | null;
  /** false when the Ads OS jsonb store (pacing/hygiene/criteria docs) is
   *  structurally broken — missing tables or persistent failures — so the
   *  overlay columns are blank for a KNOWN reason (Task #3706). Optional:
   *  older payloads predate the field. */
  store_ok?: boolean;
  /** Operator-facing explanation when store_ok is false; null while healthy. */
  store_reason?: string | null;
}

export interface LsaDashboardRow {
  customer_id: string;
  descriptive_name: string;
  client_name: string | null;
  lsa_city: string | null;
  /** ClickUp-authoritative labels from the account's live parent client. */
  practice_areas: string[];
  currency_code: string | null;
  doer: string | null;
  checker: string | null;
  cost_30d: number;
  charged_leads_30d: number;
  cpl_30d: number | null;
  cost_prev: number;
  charged_leads_prev: number;
  cpl_prev: number | null;
  answer_rate_30d: number | null;
  answer_calls_30d: number;
  answer_connected_30d: number;
  ads_running: boolean;
  // Phase 2+ overlays. LSA is paced MONTHLY (like GAds) — the account is merely
  // configured with a weekly budget, so only the recommendation is weekly.
  pacing_pct: number | null;
  monthly_budget: number | null;
  mtd_spend: number | null;
  recommended_weekly_budget: number | null;
  health_score: number | null;
  health_band: string | null;
  health_at: string | null;
  alerts: Alert[];
  alerts_at: string | null;
  /** The account's LSA schedule from criteria (empty = every day). Display
   *  only — shows which schedule the pacing figures assume. Optional: older
   *  cached payloads predate the field. */
  lsa_schedule_days?: string[];
  /** Task #4865: ClickUp Ads Status (null = blank = On). Overlaid live.
   *  Optional — stale cached payloads predate this field. */
  ads_status?: AdsStatus;
  /** Morning Paused/Off verification verdict. Null for On accounts or unchecked. */
  status_check?: StatusCheck | null;
}

export interface LsaDashboardResponse {
  rows: LsaDashboardRow[];
  generated_at: string;
  from_cache: boolean;
  window: number;
  compare: string;
  clickup_live: boolean;
  /** ISO time of the directory bundle's last successful fetch when it is older
   *  than the staleness threshold (~20 min); null when fresh (Task #3608). */
  clickup_stale_since: string | null;
  /** One-line reason the ClickUp directory is not live (HTTP status / error
   *  class / unconfigured token), for the outage banner; null while healthy.
   *  Optional: older cached payloads predate the field. */
  clickup_reason?: string | null;
  /** Age of the ClickUp directory bundle in ms (null = never fetched). Drives
   *  the topbar "Reload directory" button (Task #3609). */
  clickup_bundle_age_ms: number | null;
  /** Ads OS store health (Task #3706) — see DashboardResponse.store_ok. */
  store_ok?: boolean;
  store_reason?: string | null;
}

export interface CombinedMember {
  product: Product;
  customer_id: string;
  descriptive_name: string;
  city: string | null;
  ads_status: string | null;
  spend_30d: number;
  leads_30d: number;
  metrics_failed: boolean;
  /** Task #4964: account has ACTIVE non-LSA campaigns but ZERO monitor labels —
   *  its $0.00 is a setup gap, not real spend or a fetch failure. Optional —
   *  stale cached payloads predate this field. */
  zero_label?: boolean;
  // Phase 2 pacing overlay
  pacing_pct: number | null;
  pacing_budget: number | null;
  pacing_mtd: number | null;
  /** Whether this account contributes to the client aggregate. Optional for
   * session-cached payloads created before the field existed. */
  pacing_included?: boolean;
  // Task #3897: reconciliation context for the pill breakdown. Optional —
  // rows cached in sessionStorage before these fields shipped won't carry
  // them; null = unknown (older store doc / failed criteria read).
  pacing_expected?: number | null; // expected-to-date spend from the last pacing run
  pacing_budget_source?: string | null; // "clickup" | "sheet"
  pacing_schedule_days?: string[] | null; // applied schedule; [] = every day
  pacing_schedule_source?: string | null; // "saved" | "inferred" | "default"
  pacing_generated_at?: string | null; // ISO time of the account's last pacing run
  /** Task #4878: Morning Paused/Off verification verdict. Null for On accounts or unchecked.
   *  Optional — stale cached payloads predate this field. */
  status_check?: StatusCheck | null;
}

export interface CombinedDashboardRow {
  client: string;
  doer: string | null;
  checker: string | null;
  /** Canonical-order union across the row's member account CIDs. */
  practice_areas: string[];
  currency_code: string | null;
  has_gads: boolean;
  has_lsa: boolean;
  has_active_monitoring: boolean;
  spend_30d: number;
  leads_30d: number;
  cpl_30d: number | null;
  spend_prev: number;
  leads_prev: number;
  cpl_prev: number | null;
  gads_spend_30d: number;
  gads_leads_30d: number;
  lsa_spend_30d: number;
  lsa_leads_30d: number;
  members: CombinedMember[];
  metrics_partial: boolean;
  // Phase 2 pacing overlay
  pacing_pct: number | null;
  pacing_budget: number | null;
  pacing_mtd: number | null;
  /** Combined schedule-aware expected-to-date target. Optional for cached
   * payloads created before the field existed. */
  pacing_expected?: number | null;
  pacing_hit: boolean;
  /** Live server overlay. Optional for rows restored from pre-field
   * sessionStorage; downstream UI must treat absence as an empty summary. */
  alerts?: ClientAlertSummary;
}

export interface CombinedDashboardResponse {
  rows: CombinedDashboardRow[];
  generated_at: string;
  from_cache: boolean;
  window: number;
  compare: string;
  clickup_live: boolean;
  /** ISO time of the directory bundle's last successful fetch when it is older
   *  than the staleness threshold (~20 min); null when fresh (Task #3608). */
  clickup_stale_since: string | null;
  /** One-line reason the ClickUp directory is not live (HTTP status / error
   *  class / unconfigured token), for the outage banner; null while healthy.
   *  Optional: older cached payloads predate the field. */
  clickup_reason?: string | null;
  /** Age of the ClickUp directory bundle in ms (null = never fetched). Drives
   *  the topbar "Reload directory" button (Task #3609). */
  clickup_bundle_age_ms: number | null;
  /** Ads OS store health (Task #3706) — see DashboardResponse.store_ok. */
  store_ok?: boolean;
  store_reason?: string | null;
}

export interface MonitoredAccount {
  customer_id: string;
  descriptive_name: string;
  currency_code: string | null;
  city?: string | null;
}

export interface ClientRef {
  name: string;
  has_gads: boolean;
  has_lsa: boolean;
}

export interface ClientsResponse {
  clients: ClientRef[];
  clickup_live: boolean;
  /** ISO time of the directory bundle's last successful fetch when it is older
   *  than the staleness threshold (~20 min); null when fresh (Task #3608). */
  clickup_stale_since: string | null;
  /** One-line reason the ClickUp directory is not live (HTTP status / error
   *  class / unconfigured token), for the outage banner; null while healthy.
   *  Optional: older cached payloads predate the field. */
  clickup_reason?: string | null;
}

// ---- Budget pacing (Phase 2 — mirrors server/services/adsOs/types.ts) ----

export interface DayPoint {
  date: string;
  spend: number;
  target: number | null;
}

export interface CampaignPacingRow {
  campaign_id: string;
  name: string;
  status: string; // ENABLED | PAUSED | REMOVED — spend is counted regardless
  current_daily_budget: number;
  mtd_spend: number;
  avg_daily_spend_mtd: number;
  impr_share: number | null;
  search_lost_is_budget: number | null;
  search_lost_is_rank: number | null;
}

export interface BudgetPacingReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string;
  monthly_budget: number | null;
  budget_source: string; // "clickup" | "sheet" | "none"
  mtd_spend: number;
  on_off_track_pct: number | null;
  recommended_daily_budget: number | null;
  /** Monthly budget ÷ total scheduled days — the platform daily budget from
   *  the monthly budget alone; never moves with MTD spend. Optional: cached
   *  reports may predate the field (Task #3903) — the tile derives it from
   *  monthly_budget/total_scheduled_days then. */
  baseline_daily_budget?: number | null;
  avg_daily_spend_mtd: number;
  expected_to_date: number | null;
  /** APPLIED schedule (empty = every day). */
  schedule_days: string[];
  /** "saved" criteria, "inferred" from recent spend, or "default" (every day).
   *  Optional: cached reports may predate the field (Task #3706). */
  schedule_source?: "saved" | "inferred" | "default";
  scheduled_days_elapsed: number;
  total_scheduled_days: number;
  days_in_month: number;
  campaigns: CampaignPacingRow[];
  daily_spend: DayPoint[];
  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  has_criteria: boolean;
  warnings: string[];
  from_cache: boolean;
}

export interface LsaDayPoint {
  date: string;
  spend: number;
  target: number | null;
}

export interface LsaPacingReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string;
  monthly_budget: number | null;
  budget_source: string; // "clickup" | "sheet" | "none"
  mtd_spend: number;
  on_off_track_pct: number | null;
  recommended_weekly_budget: number | null;
  /** (Monthly budget ÷ total scheduled days) × serving days/wk — the platform
   *  weekly budget from the monthly budget alone; never moves with MTD spend.
   *  Optional: cached reports may predate the field (Task #3903). */
  baseline_weekly_budget?: number | null;
  avg_daily_spend_mtd: number;
  expected_to_date: number | null;
  weeks_remaining: number | null;
  schedule_days: string[]; // applied LSA schedule (empty = every day)
  spend_last_30d: number;
  days_elapsed: number;
  /** Scheduled days in the whole month. Optional: pre-#3903 cached reports. */
  total_scheduled_days?: number;
  days_in_month: number;
  daily_spend: LsaDayPoint[];
  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  has_criteria: boolean;
  warnings: string[];
  from_cache: boolean;
}

// ---- Client criteria (Phase 2 — spec §6.11 modal payloads) ----

export interface ClientCriteria {
  business_name: string;
  website: string;
  practice_areas: string[];
  service_area: string;
  services_offered: string;
  services_not_offered: string;
  competitors: string;
  extra_protected_terms: string;
  notes: string;
  // Budgets are NOT part of criteria — the ClickUp Client List ("Paid Search
  // Budget" per account) is the source of truth. schedule_days is the GOOGLE
  // ADS schedule (name predates the LSA split); lsa_schedule_days is the LSA
  // schedule. Empty = every day.
  schedule_days: string[];
  lsa_schedule_days: string[];
}

export interface DerivedDefaults {
  business_name: string;
  service_area: string;
}

export interface CriteriaResponse {
  customer_id: string;
  account_name: string;
  has_saved: boolean;
  criteria: ClientCriteria;
  derived: DerivedDefaults;
  updated_at: string | null;
  /** Canonical ClickUp Practice Area labels in ClickUp option order. */
  practice_area_options: string[];
  /** True only when this CID maps to one live parent under a successfully
   * loaded canonical ClickUp field contract. */
  practice_area_sync_available: boolean;
  /** Operator-facing recovery detail when practice-area editing is unavailable. */
  practice_area_sync_reason: string | null;
}

// ---- Hygiene audit (Phase 3 — mirrors server/services/adsOs/audit/models.ts,
// ported from the bundle's frontend/src/types.ts) ----

export type Status = "good" | "okay" | "bad" | "critical" | "na";

export interface Evidence {
  name: string;
  id: string | null;
  detail: string | null;
}

export interface CheckResult {
  id: string;
  category: string;
  name: string;
  status: Status;
  score: number | null;
  weight: number;
  impact: "critical" | "high" | "medium" | "low";
  value: string;
  evidence: Evidence[];
  recommendation: string;
}

export interface CategoryResult {
  code: string;
  name: string;
  weight: number;
  score: number;
  checks: CheckResult[];
}

export interface GateTriggered {
  id: string;
  source: string;
  cap: number;
  reason: string;
}

export interface NextStep {
  title: string;
  detail: string;
  source: string;
  points: string[];
}

export interface NextSteps {
  critical: NextStep[];
  easy_wins: NextStep[];
  long_term: NextStep[];
}

/** One stored score snapshot from the audit-history trail (newest first). */
export interface ScoreHistoryEntry {
  final_score: number;
  band: string;
  generated_at: string;
}

export interface ScoreHistoryResponse {
  customer_id: string;
  history: ScoreHistoryEntry[];
}

export interface AuditReport {
  customer_id: string;
  account_name: string;
  generated_at: string;
  lookback_days: number;
  raw_score: number;
  final_score: number;
  band: string;
  band_color: string;
  /** Set when the account has no scannable labeled campaigns (band "Inactive"). */
  scope_note?: string | null;
  gates_triggered: GateTriggered[];
  next_steps: NextSteps;
  categories: CategoryResult[];
  from_cache?: boolean;
  /** Task #5332: the account's current Account Alerts (same store the combined
   *  dashboard badge reads) — a separate real-time signal from this score. */
  alerts?: Alert[];
  alerts_at?: string | null;
}

// ---- Search Term Analyzer (mirrors backend keywordIntel/models.ts) ----

// A converting search term a suggested negative would block (conflict caution).
export interface BlockedConvertingTerm {
  search_term: string;
  conversions: number;
  cost: number;
  cpa: number;
}

export interface NegativeSuggestion {
  negative: string;
  match_type: "broad" | "phrase" | "exact";
  category: string;
  reason: string;
  confidence: number;
  system_note: string;
  covered_terms: number;
  search_term: string;
  campaign: string;
  ad_group: string;
  matched_keyword: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  avg_cpc: number;
  blocks_converting: BlockedConvertingTerm[];
  blocks_converting_more: number;
}

export interface KeywordSuggestion {
  keyword: string;
  match_type: "phrase" | "exact" | "broad";
  search_term: string;
  campaign: string;
  ad_group: string;
  conversions: number;
  cost: number;
  cpa: number;
  campaign_cpa: number;
  reason: string;
  // Set only on rows in KeywordFinderReport.conflicts: the pending suggested
  // negative that would block this term.
  blocked_by: string;
  blocked_category: string;
  blocked_reason: string;
}

export interface KeywordFinderReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string;
  lookback_days: number;
  converting_terms: number;
  actioned_hidden: number;
  account_blocked: number;
  suggestions: KeywordSuggestion[];
  // Held back: a pending suggested negative (from the Negative Keywords tool's
  // runs) would block these — shown separately, never silently dropped.
  conflicts: KeywordSuggestion[];
  negatives_checked: boolean;
  negatives_generated_at: string | null;
  negatives_window_days: number | null;
  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  warnings: string[];
  from_cache?: boolean;
}

export interface KeywordIntelReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string;
  lookback_days: number;
  candidate_count: number;
  reviewed_cost: number;
  waste_terms: number;
  wasted_spend: number;
  keyword_spend: number;
  traffic_quality: number | null;
  coverage: number | null;
  suggestions: NegativeSuggestion[];
  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  has_criteria: boolean;
  warnings: string[];
  from_cache?: boolean;
}

// ----------------------------- Pyramid Breakdown -----------------------------
// Mirrors server/services/adsOs/pyramid/models.ts.

export type PyramidAction = "scale" | "keep" | "watch" | "throttle" | "pause" | "none";

export interface PyramidSearchTerm {
  search_term: string;
  targeting_status: string; // ADDED | EXCLUDED | ADDED_EXCLUDED | NONE
  matched_keywords: string[];
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
  relevancy: number | null; // 0-100; null = not scored
  relevancy_label: string; // high_intent | relevant | adjacent | irrelevant | ""
  relevancy_reason: string;
}

export interface PyramidKeyword {
  criterion_id: string;
  text: string;
  match_type: string;
  status: string;
  quality_score: number; // 0 = not reported
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
  cpl: number | null;
  flags: string[];
  action: PyramidAction;
  rationale: string;
  ai_agrees: boolean | null;
  insufficient_data: boolean;
  campaign_name: string; // set on the killer-keywords rollup only
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
  relevancy_avg: number | null;
  irrelevant_cost_pct: number | null;
  flags: string[];
  action: PyramidAction;
  rationale: string;
  insufficient_data: boolean;
  keywords: PyramidKeyword[];
  keywords_total: number;
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
  baseline_cpl: number | null;
  baseline_source: string; // campaign | account | none
  search_is: number | null; // percents 0-100
  lost_is_budget: number | null;
  lost_is_rank: number | null;
  flags: string[];
  action: PyramidAction;
  rationale: string;
  confidence: number | null;
  recommended_budget_change_pct: number | null;
  insufficient_data: boolean;
  scale_candidate: boolean;
  ad_groups: PyramidAdGroup[];
}

export interface PyramidNextStep {
  priority: number;
  step: string;
}

export interface PyramidRollup {
  action_counts: Record<string, number>;
  campaign_actions: Record<string, number>;
  ad_group_actions: Record<string, number>;
  keyword_actions: Record<string, number>;
  flagged_keywords: number;
  flagged_keyword_cost: number;
  killer_keywords: PyramidKeyword[];
  worst_terms: PyramidSearchTerm[];
  scored_terms: number;
  scored_term_cost: number;
  irrelevant_term_cost: number;
  relevancy_avg: number | null;
}

export interface PyramidReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string;
  lookback_days: number;
  window_start: string;
  window_end: string;
  account_cost: number;
  account_conversions: number;
  account_cpl: number | null;
  baseline_note: string;
  executive_summary: string;
  next_steps: PyramidNextStep[];
  campaigns: PyramidCampaign[];
  rollup: PyramidRollup;
  ai_status: string; // full | partial | rules_only
  ai_model_used: string;
  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  has_criteria: boolean;
  warnings: string[];
  from_cache: boolean;
}

// ---- Client profile (Phase 6 — mirrors server/services/adsOs/clientProfile.ts) ----

export interface ProfileAccount {
  product: Product;
  customer_id: string;
  name: string;
  city: string | null;
  ads_status: AdsStatus;
  /** Morning Paused/Off verification verdict (Task #3989 — same doc the AM
   *  board reads). Guarded optional: a stale pre-feature payload during a
   *  rolling deploy may omit it; null for On accounts / never-checked. */
  status_check?: StatusCheck | null;
  /** Task #4964: account has ACTIVE non-LSA campaigns but ZERO monitor labels —
   *  its $0.00 metrics are a setup gap ("Setup needed"), not real spend or a
   *  fetch failure. Optional — stale cached payloads predate this field. */
  zero_label?: boolean;
  currency: string | null;
  spend_30d: number;
  spend_prev: number;
  leads_30d: number;
  leads_prev: number;
  cpl_30d: number | null;
  cpl_prev: number | null;
}

export interface ProfilePacingRow {
  product: Product;
  customer_id: string;
  name: string;
  city: string | null;
  budget: number | null;
  mtd: number | null;
  used_pct: number | null;
  expected_pct: number | null;
  pace_pct: number | null;
  budget_hit: boolean;
  recommended: number | null;
  recommended_per: "day" | "week";
}

export interface ProfileCombinedPacing {
  budget: number;
  mtd: number;
  used_pct: number | null;
  expected_pct: number | null;
  pace_pct: number | null;
  budget_hit: boolean;
}

export interface ProfileNextStepItem {
  title: string;
  detail: string;
}

export interface ProfileNextSteps {
  critical: ProfileNextStepItem[];
  important: ProfileNextStepItem[];
  minor: ProfileNextStepItem[];
  counts: { critical: number; important: number; minor: number };
}

export interface ProfileHygiene {
  product: Product;
  customer_id: string;
  name: string;
  city: string | null;
  score: number | null;
  band: string | null;
  at: string | null;
  next_steps: ProfileNextSteps | null;
}

export interface ProfileQuality {
  customer_id: string;
  name: string;
  score: number | null;
  coverage: number | null;
  window_days: number | null;
  at: string | null;
}

export interface ProfilePyramid {
  customer_id: string;
  name: string;
  action_counts: Record<string, number> | null;
  flagged_keywords: number | null;
  flagged_keyword_cost: number | null;
  irrelevant_term_cost: number | null;
  top_recommendations:
    | { action: string; name: string; rationale?: string | null }[]
    | null;
  ai_status: string | null;
  lookback_days: number | null;
  at: string | null;
}

export interface ClientProfile {
  client: string;
  doer: string | null;
  checker: string | null;
  currency_code: string | null;
  has_gads: boolean;
  has_lsa: boolean;
  /** Fixed 30-day KPI block — still served (payload stability), but the hero no
   *  longer renders it: range-driven KPIs live in the Performance section. */
  kpis: {
    spend_30d: number;
    spend_prev: number;
    leads_30d: number;
    leads_prev: number;
    cpl_30d: number | null;
    cpl_prev: number | null;
  };
  alerts: ClientAlertSummary;
  accounts: ProfileAccount[];
  pacing: { rows: ProfilePacingRow[]; combined: ProfileCombinedPacing | null };
  hygiene: ProfileHygiene[];
  quality: ProfileQuality[];
  /** Guarded optional — a stale pre-feature payload during a rolling deploy
   *  may omit it. */
  pyramid?: ProfilePyramid[];
  log_url: string | null;
  has_log: boolean;
  criteria_account: { customer_id: string; name: string } | null;
  generated_at: string;
  from_cache: boolean;
}

// ---- Client performance (Phase 6 — daily per-account series) ----

export interface PerfPoint {
  date: string; // ISO YYYY-MM-DD
  spend: number;
  leads: number;
}

export interface PerfSeries {
  product: Product;
  customer_id: string;
  name: string;
  city: string | null;
  ads_status: AdsStatus;
  /** Series couldn't load — points are placeholder zeros, not real spend. */
  metrics_failed: boolean;
  points: PerfPoint[];
}

export interface ClientPerformance {
  client: string;
  currency_code: string | null;
  start: string;
  end: string;
  accounts: PerfSeries[];
  generated_at: string;
  from_cache?: boolean;
}

// ---- Client log AI summary (Phase 6) ----

export interface ClientLogEntry {
  date: string;
  text: string;
}

export interface ClientLogSummary {
  /** "ok" or one of the spec's failure state codes (rendered as plain English
   *  by the profile's LOG_STATE_COPY map). */
  state: string;
  entries?: ClientLogEntry[];
  row_count?: number;
  window_days?: number;
  generated_at?: string;
  log_url?: string | null;
  /** True when a forced refresh failed and this is the last good summary. */
  stale?: boolean;
  refresh_error?: string;
}

// ---- Sibling lookup (breadcrumbs "Also: GAds/LSA" pill) ----

export interface SiblingResponse {
  client_name?: string | null;
  sibling_cid?: string | null;
  sibling_product?: Product | null;
}

// ---- AM Dashboard (Task #3988: per-ads-manager launch cards) ----

// The morning verification of a Paused/Off Ads Status claim (statusCheck.ts):
// does the account's real state match what ClickUp says? Drives the chip's ✓/✗.
export interface StatusCheck {
  expected: "paused" | "off";
  matches?: boolean; // absent when the check errored
  enabled_campaigns?: number; // how many campaigns could still serve (the mismatch evidence)
  enabled_campaign_names?: string[]; // which ones (first few) — named in the ✗ tooltip
  checked_at: string;
  error?: string;
}

export interface AmAccount {
  product: "gads" | "lsa";
  customer_id: string;
  label: string; // "Google Ads" | "LSA - City" | plain "LSA" when no city is known
  ads_status: "on" | "paused" | "off";
  deep_link: string | null; // null = no launch URL captured yet (not derivable from CID)
  status_check: StatusCheck | null; // morning verification of a Paused/Off claim
}

export interface ClientAlertItem {
  severity: string | null;
  title: string;
  detail: string;
  product: "gads" | "lsa";
  customer_id: string;
  account: string; // the account's card label ("Google Ads" | "LSA - Miami")
  deep_link: string | null;
  alerts_at: string | null;
}
export interface ClientAlertItem {
  severity: string | null;
  title: string;
  detail: string;
  product: "gads" | "lsa";
  customer_id: string;
  account: string; // the account's card label ("Google Ads" | "LSA - Miami")
  deep_link: string | null;
  alerts_at: string | null;
}
export interface ClientAlertAccountFreshness {
  product: "gads" | "lsa";
  customer_id: string;
  account: string;
  alerts_at: string | null;
}

export interface ClientAlertSummary {
  critical: number;
  high: number;
  medium: number;
  total: number;
  needs_attention: boolean;
  items: ClientAlertItem[];
  items_truncated: number;
  accounts: ClientAlertAccountFreshness[];
}

export interface AmClient {
  client: string;
  doer: string | null;
  checker: string | null;
  log_url: string | null;
  accounts: AmAccount[];
  // Rolled up across the client's accounts. critical+high = "needs attention" (the
  // same rule the GAds/LSA boards flag rows by); medium shows but doesn't flag.
  alerts: ClientAlertSummary;
}

export interface AmDashboardData {
  clients: AmClient[];
  managers: string[]; // distinct doers, for the ads-manager selector
  checkers: string[];
  clickup_ok: boolean;
  // When the Paused/Off verification last ran; null = never, so every chip is bare
  // and the board says so rather than looking broken.
  status_checked_at: string | null;
  generated_at: string;
}
