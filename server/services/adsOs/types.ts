/**
 * Ads OS — dashboard payload shapes (port of backend/app/models.py +
 * backend/app/lsa/models.py, matching frontend/src/types.ts 1:1).
 *
 * Snake_case field names are kept deliberately so the payloads match the
 * source bundle byte-for-byte — the frontend types mirror these.
 *
 * Phase 1: hygiene / pacing / traffic-quality / alerts fields exist in the
 * shapes but are always null/empty — those overlays land in Phases 2-6.
 */

export type AdsStatus = "on" | "paused" | "off" | null;
export type Product = "gads" | "lsa";
export type KnownAlertSeverity = "critical" | "high" | "medium";

// Alert shape (Phase 6 computes these; Phase 1 always sends []).
export interface Alert {
  code: string;
  severity: "critical" | "high" | "medium";
  title: string;
  detail: string;
  product: Product;
  campaign_id: string | null;
  deep_link: string | null;
  clickup_task: { task_id: string; url: string } | null;
}

/** One normalized account-alert detail in a client-level rollup. Unknown
 * severities remain listable (as strings) but never contribute to the known
 * severity counts. */
export interface ClientAlertItem {
  severity: string | null;
  title: string;
  detail: string;
  product: Product;
  customer_id: string;
  account: string;
  deep_link: string | null;
  alerts_at: string | null;
}

/** Per-account freshness survives even when a stored document has no alerts,
 * so a zero-count rollup can still distinguish fresh-empty from never-run. */
export interface ClientAlertAccountFreshness {
  product: Product;
  customer_id: string;
  account: string;
  alerts_at: string | null;
}

/** Canonical client-level account-alert rollup shared by Main, client profile,
 * and AM Dashboard. Counts cover the full stored alert set; only item details
 * are capped. */
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

// ---- GAds dashboard (models.py DashboardRow) ----

export interface DashboardRow {
  customer_id: string;
  descriptive_name: string;
  /** ClickUp-authoritative labels from the account's live parent client. */
  practice_areas: string[];
  currency_code: string | null;
  spend_30d: number;
  spend_prev: number;
  conversions_30d: number;
  conversions_prev: number;
  cpa_30d: number | null;
  cpa_prev: number | null;
  health_score: number | null;
  health_band: string | null;
  health_at: string | null;
  monthly_budget: number | null;
  mtd_spend: number | null;
  budget_pacing_pct: number | null;
  recommended_daily_budget: number | null;
  ads_running: boolean;
  traffic_quality: number | null;
  quality_coverage: number | null;
  quality_window: number | null;
  quality_at: string | null;
  alerts: Alert[];
  alerts_at: string | null;
  client_name: string | null;
  doer: string | null;
  checker: string | null;
  // Task #3682: the account's GAds schedule (criteria schedule_days; empty =
  // every day) so operators can see which schedule the pacing figures assume
  // without opening the per-account pacing tool. Display only — pacing math is
  // untouched. Overlaid live (like pacing), never baked into the metrics cache.
  schedule_days: string[];
  // Task #3706: where that schedule came from — "saved" (criteria), "inferred"
  // (derived from recent daily spend when nothing is saved) or "default"
  // (every day). Overlaid from the pacing store when present; null for rows
  // whose stored doc predates the field.
  schedule_source: string | null;
  // Task #3706: scheduled days elapsed this month from the pacing store doc.
  // 0 + a real budget + null pct = the neutral "not started yet" column state
  // (early-month weekend), NOT a data problem. null = unknown/older doc.
  scheduled_days_elapsed: number | null;
  // Task #4865: ClickUp Ads Status + morning verification (same as AM Dashboard).
  // Overlaid live so a ClickUp edit shows on the next reload without a metrics
  // cache bust. null = blank / "on" (running is the norm; chip only for Paused/Off).
  ads_status: AdsStatus;
  // null for On accounts, null when check hasn't run yet; non-null only for Paused/Off.
  status_check: import("./statusCheck").StatusCheckEntry | null;
}

export interface DashboardResponse {
  rows: DashboardRow[];
  generated_at: string;
  from_cache?: boolean;
}

// ---- LSA dashboard (lsa/models.py LsaDashboardRow) ----

export interface LsaDashboardRow {
  customer_id: string;
  descriptive_name: string;
  /** ClickUp-authoritative labels from the account's live parent client. */
  practice_areas: string[];
  currency_code: string | null;
  cost_30d: number;
  cost_prev: number;
  charged_leads_30d: number;
  charged_leads_prev: number;
  cpl_30d: number | null;
  cpl_prev: number | null;
  answer_rate_30d: number | null;
  answer_calls_30d: number;
  answer_connected_30d: number;
  health_score: number | null;
  health_band: string | null;
  health_at: string | null;
  monthly_budget: number | null;
  mtd_spend: number | null;
  pacing_pct: number | null;
  recommended_weekly_budget: number | null;
  ads_running: boolean;
  alerts: Alert[];
  alerts_at: string | null;
  client_name: string | null;
  doer: string | null;
  checker: string | null;
  lsa_city: string | null;
  // Task #3676: the account's LSA schedule (criteria lsa_schedule_days; empty =
  // every day) so operators can see which schedule the pacing figures assume
  // without opening the per-account pacing tool. Display only — pacing math is
  // untouched. Overlaid live (like pacing), never baked into the metrics cache.
  lsa_schedule_days: string[];
  // Task #4865: ClickUp Ads Status + morning verification (same as AM Dashboard).
  ads_status: AdsStatus;
  status_check: import("./statusCheck").StatusCheckEntry | null;
}

export interface LsaDashboardResponse {
  rows: LsaDashboardRow[];
  generated_at: string;
  from_cache?: boolean;
}

// ---- Combined client overview (models.py CombinedMember / CombinedDashboardRow) ----

export interface CombinedMember {
  product: Product;
  customer_id: string;
  descriptive_name: string;
  currency_code: string | null;
  ads_status: AdsStatus; // ClickUp Ads Status; null = blank (treated as On)
  spend_30d: number;
  spend_prev: number;
  leads_30d: number;
  leads_prev: number;
  cpl_30d: number | null;
  city: string | null;
  pacing_budget: number | null;
  pacing_mtd: number | null;
  pacing_pct: number | null;
  // True when this account contributes to the client-level aggregate. Off
  // accounts contribute only while their stored MTD is from the current month.
  // The frontend uses this to keep the account breakdown equal to the totals.
  pacing_included: boolean;
  // Task #3897: reconciliation context behind the member's pacing figures for
  // the combined pill's breakdown — read live from the pacing stores (LSA
  // schedule from the criteria store, the same read the LSA dashboard makes).
  // Display-only: the blend math above is untouched. null = unknown (older
  // store doc predates the field / criteria read failed).
  pacing_expected: number | null; // expected-to-date spend from the last pacing run
  pacing_budget_source: string | null; // "clickup" or legacy "sheet"; null = unknown
  pacing_schedule_days: string[] | null; // applied schedule; [] = every day
  pacing_schedule_source: string | null; // "saved" | "inferred" | "default"
  pacing_generated_at: string | null; // ISO timestamp of the account's last pacing run
  metrics_failed: boolean; // metrics couldn't load this build (0s are placeholders)
  // Task #4964: the account has ACTIVE non-LSA campaigns but ZERO of them carry
  // the monitor label — every label-scoped metric renders $0.00 that is NOT a
  // real zero and NOT a fetch failure. "Setup needed" state. Optional — stale
  // cached payloads and LSA members predate/skip this field.
  zero_label?: boolean;
  // Task #4878: Paused/Off verification verdict. Same shape as DashboardRow.status_check.
  // Null for On accounts or unchecked. Optional — stale cached payloads predate this field.
  status_check?: import("./statusCheck").StatusCheckEntry | null;
}

export interface CombinedDashboardRow {
  client: string;
  /** Canonical-order union across the row's member account CIDs. */
  practice_areas: string[];
  currency_code: string | null;
  spend_30d: number;
  spend_prev: number;
  leads_30d: number;
  leads_prev: number;
  cpl_30d: number | null;
  cpl_prev: number | null;
  gads_spend_30d: number;
  gads_leads_30d: number;
  lsa_spend_30d: number;
  lsa_leads_30d: number;
  has_gads: boolean;
  has_lsa: boolean;
  // False = fully switched-off client (no On/Paused account, no Off account still
  // spending) — hidden from the Main board but still reachable via the client profile.
  has_active_monitoring: boolean;
  pacing_budget: number | null;
  pacing_mtd: number | null;
  // Sum of schedule-aware expected-to-date targets from included, budgeted
  // accounts. Kept on the shared aggregate so the client profile does not
  // recalculate a second version of the same totals.
  pacing_expected: number | null;
  pacing_pct: number | null;
  pacing_hit: boolean;
  doer: string | null;
  checker: string | null;
  metrics_partial: boolean; // a member's metrics failed to load — totals are understated
  // Live account-alert overlay. Deliberately excluded from the metrics cache:
  // every request rebuilds it from one bulk store read.
  alerts: ClientAlertSummary;
  members: CombinedMember[];
}

export interface CombinedDashboardResponse {
  rows: CombinedDashboardRow[];
  generated_at: string;
  from_cache?: boolean;
  /** Task #3648: whether this build's rows are grouped as designed — true when
   *  built from a live ClickUp bundle's client blocks, OR when ClickUp is
   *  deliberately not the grouping source (label mode / unconfigured). False =
   *  degraded per-account fallback grouping: cached only briefly and surfaced
   *  to the UI as a ClickUp-outage banner. Optional so pre-field cached
   *  payloads (undefined) are treated as grouped. */
  clickup_grouped?: boolean;
}

// ---- Budget pacing (budget_pacing/models.py) ----

export interface DayPoint {
  /** ISO date (YYYY-MM-DD) */
  date: string;
  /** monitored-campaign spend that day */
  spend: number;
  /** what we should spend that day (schedule-aware); null if no budget */
  target: number | null;
}

export interface CampaignPacingRow {
  campaign_id: string;
  name: string;
  status: string; // ENABLED | PAUSED | REMOVED — spend is counted regardless
  current_daily_budget: number; // campaign_budget.amount_micros
  mtd_spend: number; // spend month-start..yesterday
  avg_daily_spend_mtd: number; // mtd_spend / scheduled days elapsed
  impr_share: number | null; // 0-1 (null when no search impressions)
  search_lost_is_budget: number | null; // 0-1
  search_lost_is_rank: number | null; // 0-1
}

export interface BudgetPacingReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string;
  // Tiles
  monthly_budget: number | null; // resolved GAds monthly budget
  budget_source: string; // "clickup" | "none"
  /** Latest ClickUp fetch succeeded. A null budget is final only when true. */
  budget_authoritative: boolean;
  mtd_spend: number; // monitored-campaign spend to yesterday
  on_off_track_pct: number | null; // + ahead of pace / - behind; null if no budget
  recommended_daily_budget: number | null;
  // Task #3903: monthly budget ÷ total scheduled days — what the platform's
  // daily budget SHOULD be set to from the monthly budget alone. Unlike the
  // corrective recommended_daily it never moves with MTD spend. Null without
  // a budget.
  baseline_daily_budget: number | null;
  avg_daily_spend_mtd: number;
  expected_to_date: number | null;
  // Schedule context (for the math + the UI explainer). schedule_days is the
  // APPLIED schedule; schedule_source says whether it was saved criteria,
  // inferred from recent spend, or the every-day default (Task #3706).
  schedule_days: string[];
  schedule_source: "saved" | "inferred" | "default";
  scheduled_days_elapsed: number;
  total_scheduled_days: number;
  days_in_month: number;
  campaigns: CampaignPacingRow[];
  daily_spend: DayPoint[]; // daily spend vs target chart
  // Scope (label gating), mirrors the Search Term Analyzer.
  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  has_criteria: boolean;
  warnings: string[];
  from_cache: boolean;
}

// ---- LSA budget pacing (lsa/models.py) ----

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
  // Tiles — paced MONTHLY (like GAds); recommendation expressed weekly because
  // LSA accounts are configured with a weekly budget.
  monthly_budget: number | null;
  budget_source: string; // "clickup" | "none"
  /** Latest ClickUp fetch succeeded. A null budget is final only when true. */
  budget_authoritative: boolean;
  mtd_spend: number;
  on_off_track_pct: number | null;
  recommended_weekly_budget: number | null;
  // Task #3903: (monthly budget ÷ total scheduled days) × scheduled serving
  // days per week — the weekly budget the LSA platform SHOULD be set to from
  // the monthly budget alone (every-day account: (monthly ÷ days in month) ×
  // 7). Never moves with MTD spend. Null without a budget.
  baseline_weekly_budget: number | null;
  avg_daily_spend_mtd: number;
  expected_to_date: number | null;
  weeks_remaining: number | null; // scheduled weeks left (no schedule → calendar weeks)
  // Schedule context (criteria lsa_schedule_days; empty = every day)
  schedule_days: string[];
  // 30-day signal (the BUD-02 underspend/scale signal)
  spend_last_30d: number;
  // Month context
  days_elapsed: number; // through yesterday, this month
  total_scheduled_days: number; // scheduled days in the whole month (Task #3903)
  days_in_month: number;
  daily_spend: LsaDayPoint[];
  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  has_criteria: boolean;
  warnings: string[];
  from_cache: boolean;
}

// ---- Client criteria (spec §6.11 modal payloads) ----

export interface CriteriaPayload {
  business_name: string;
  website: string;
  practice_areas: string[];
  service_area: string;
  services_offered: string;
  services_not_offered: string;
  competitors: string;
  extra_protected_terms: string;
  notes: string;
  schedule_days: string[];
}

export interface CriteriaResponse {
  customer_id: string;
  account_name: string;
  has_saved: boolean;
  criteria: CriteriaPayload;
  derived: { business_name: string; service_area: string };
  updated_at: string | null;
}

// ---- Account lists ----

export interface MonitoredAccount {
  customer_id: string;
  descriptive_name: string;
  currency_code: string | null;
  city?: string | null; // LSA only: location from the ClickUp directory
}

export interface AccountSummary {
  customer_id: string;
  descriptive_name: string;
  currency_code: string | null;
  time_zone: string | null;
  is_manager: boolean;
  is_test_account: boolean;
  status: string | null;
  level: number;
}

// Lightweight client entry for /api/ads-os/clients (profile switcher / palette).
export interface ClientRef {
  name: string;
  has_gads: boolean;
  has_lsa: boolean;
}
