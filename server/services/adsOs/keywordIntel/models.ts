/**
 * Keyword Intelligence — report models (port of backend/app/keyword_intel/models.py).
 *
 * Field names stay snake_case to match the bundle's API surface (the frontend
 * consumes these shapes verbatim). ClientCriteria/DerivedDefaults already live
 * in criteriaService.ts (Phase 2); this file holds the analyzer report types.
 */

/** A converting search term a suggested negative would block (conflict caution). */
export interface BlockedConvertingTerm {
  search_term: string;
  conversions: number;
  cost: number;
  cpa: number;
}

/** One paste-ready negative keyword suggestion (match type baked into text). */
export interface NegativeSuggestion {
  negative: string; // paste-ready: broad=plain, "phrase", [exact]
  match_type: string; // broad | phrase | exact (for the UI filter)
  category: string; // competitor | wrong_service | wrong_intent | ...
  reason: string;
  confidence: number;
  system_note: string; // e.g. "covers 4 search terms" / fallback note
  covered_terms: number; // how many search terms this negative would catch

  // Cross-tool caution: converting terms in the window this negative would block
  // (top few by conversions). The negative still stands — a "conversion" can be
  // junk — but the team should double-check the criteria call before adding it.
  blocks_converting: BlockedConvertingTerm[];
  blocks_converting_more: number; // converting terms blocked beyond the listed cap

  // Representative (highest-cost) example term + summed metrics across covered terms
  search_term: string;
  campaign: string;
  ad_group: string;
  matched_keyword: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  avg_cpc: number;
}

/** One paste-ready keyword suggestion (a converting search term to add). */
export interface KeywordSuggestion {
  keyword: string; // paste-ready, match type baked in (e.g. "term")
  match_type: string; // phrase | exact | broad
  search_term: string;
  campaign: string;
  ad_group: string;
  conversions: number;
  cost: number;
  cpa: number; // this term's cost per conversion
  campaign_cpa: number; // campaign avg cost per conversion (the bar)
  reason: string;

  // Set only on rows in KeywordFinderReport.conflicts: the pending suggested
  // negative (from the Negative Keywords tool) that would block this term.
  blocked_by: string; // paste-ready negative text
  blocked_category: string; // its category (wrong_geo | competitor | ...)
  blocked_reason: string; // the negatives review's reason
}

export interface KeywordFinderReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string; // ISO
  lookback_days: number;

  converting_terms: number; // terms with >=1 conversion examined
  actioned_hidden: number; // suggestions hidden because they were marked added
  account_blocked: number; // terms skipped: the account's LIVE negatives already block them
  suggestions: KeywordSuggestion[];

  // Suggestions HELD BACK because a pending suggested negative (persisted by the
  // Negative Keywords tool's runs, per lookback window) would block them — the
  // negatives review is the side with client knowledge, so it wins until the
  // criteria say otherwise.
  conflicts: KeywordSuggestion[];
  negatives_checked: boolean; // was a fresh negatives snapshot available to check against?
  negatives_generated_at: string | null; // latest cross-checked negatives run (ISO)
  negatives_window_days: number | null; // widest window the negatives review covered

  eligible: boolean;
  monitored_campaigns: number;
  scope_note: string;
  warnings: string[];
  from_cache: boolean;
}

export interface KeywordIntelReport {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  generated_at: string; // ISO
  lookback_days: number;

  candidate_count: number; // all terms analyzed (sent to the model)
  reviewed_cost: number; // spend across all analyzed terms
  waste_terms: number; // distinct terms that produced a suggestion
  wasted_spend: number; // spend on those waste terms
  suggestions: NegativeSuggestion[];

  // Traffic quality = good (non-waste) share of the ANALYZED search-term spend.
  // coverage = analyzed term spend / total keyword spend (how much of the search
  // budget Google actually reports at the term level — the rest is hidden).
  keyword_spend: number; // total keyword spend over the window (coverage denom)
  traffic_quality: number | null; // 0-100, (reviewed - wasted) / reviewed
  coverage: number | null; // 0-100, reviewed / keyword_spend

  // Scope (label gating): only labeled accounts/campaigns are reviewed.
  eligible: boolean; // account enrolled AND has labeled campaigns?
  monitored_campaigns: number; // campaigns carrying the campaign label
  scope_note: string; // explanation when not eligible / scope summary

  has_criteria: boolean; // were saved criteria used?
  warnings: string[];
  from_cache: boolean;
}
