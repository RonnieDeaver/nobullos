/**
 * Task #2784 — Google Ads Hygiene Audit checklist config.
 *
 * Typed rewrite of the source app's `config/checks.yaml` /
 * `config/weights.yaml` (its own README marks the older "Part 2" narrative
 * weights in the original spec doc as superseded — this config follows the
 * authoritative checks/weights files, not that narrative). Category
 * weights sum to 1.0; each check has an intra-category weight (also
 * summing to 1.0 within its category) so category and overall scores are
 * plain weighted averages. Gates are evaluated by the engine after
 * per-check scoring and cap `H_final` below `H` when they fire.
 *
 * Scoring bands (discrete checks): a check's status maps to a fixed score
 * (good=100, okay=70, bad=35, critical=0); `not_applicable` checks are
 * excluded from both the numerator and denominator of their category's
 * weighted average. Continuous checks compute a 0-100 score directly from
 * a measured ratio/value via the thresholds below, then derive a status
 * band from that score for display.
 */

export type CheckKind = "discrete" | "continuous";

export interface ContinuousBand {
  /** Inclusive lower bound of the measured value/ratio for this band. */
  min: number;
  status: "good" | "okay" | "bad" | "critical";
  score: number;
}

export interface AuditCheckDef {
  id: string;
  categoryId: string;
  label: string;
  kind: CheckKind;
  /** Intra-category weight; weights within a category should sum to 1.0. */
  weight: number;
  /** For continuous checks: bands ordered ascending by `min`. */
  bands?: ContinuousBand[];
  /** Gate id this check also feeds, if any (see AUDIT_GATES). */
  gateId?: string;
  description: string;
  fixTemplate: string;
}

export interface AuditCategoryDef {
  id: string;
  label: string;
  /** Category weight in the overall score; weights sum to 1.0. */
  weight: number;
}

export const DISCRETE_STATUS_SCORE: Record<
  "good" | "okay" | "bad" | "critical",
  number
> = {
  good: 100,
  okay: 70,
  bad: 35,
  critical: 0,
};

export const CHECK_CATEGORIES: AuditCategoryDef[] = [
  { id: "targeting_geo", label: "Targeting & Geo", weight: 0.15 },
  { id: "keywords", label: "Keywords", weight: 0.15 },
  { id: "bidding_budget", label: "Bidding & Budget", weight: 0.15 },
  { id: "ads_creative", label: "Ads & Creative", weight: 0.15 },
  { id: "assets", label: "Assets (Extensions)", weight: 0.1 },
  { id: "policy", label: "Policy & Compliance", weight: 0.1 },
  { id: "optimization_score", label: "Optimization Score", weight: 0.1 },
  { id: "account_structure", label: "Account Structure", weight: 0.1 },
];

/**
 * Critical gates. Each gate is triggered by one or more check ids landing
 * in a specific status; when triggered, `H_final` is capped at `capAt`
 * regardless of the uncapped weighted score `H`. Multiple triggered gates
 * apply the MINIMUM cap. Gates mirror the source app's account-suspension
 * / disapproved-ads / no-geo-targeting critical failures.
 */
export interface AuditGateDef {
  id: string;
  label: string;
  /** Check ids whose `critical` status triggers this gate. */
  triggerCheckIds: string[];
  capAt: number;
  explanation: string;
}

export const AUDIT_GATES: AuditGateDef[] = [
  {
    id: "account_suspended",
    label: "Account Suspended or Not Serving",
    triggerCheckIds: ["account_status_active"],
    capAt: 0,
    explanation:
      "The account is suspended, canceled, or otherwise not eligible to serve — no other score matters until this is resolved.",
  },
  {
    id: "disapproved_ads",
    label: "Disapproved Ads Present",
    triggerCheckIds: ["ads_disapproval_rate"],
    capAt: 40,
    explanation:
      "One or more ads are disapproved and cannot serve, directly reducing coverage and spend efficiency.",
  },
  {
    id: "no_geo_targeting",
    label: "No Geo Targeting Configured",
    triggerCheckIds: ["geo_targeting_present"],
    capAt: 30,
    explanation:
      "A law firm campaign with no location targeting can serve nationwide/worldwide, wasting spend on unreachable clients.",
  },
  {
    id: "no_conversion_tracking",
    label: "No Conversion Tracking",
    triggerCheckIds: ["conversion_tracking_present"],
    capAt: 50,
    explanation:
      "Without conversion tracking, bidding and budget decisions are made blind — every downstream optimization check is unreliable.",
  },
];

export const AUDIT_CHECKS: AuditCheckDef[] = [
  // -------------------- Targeting & Geo --------------------
  {
    id: "account_status_active",
    categoryId: "targeting_geo",
    label: "Account is active and serving",
    kind: "discrete",
    weight: 0.3,
    gateId: "account_suspended",
    description:
      "The Google Ads account status must be ENABLED (not SUSPENDED, CANCELED, or CLOSED) for any ads to serve.",
    fixTemplate:
      "Resolve the account suspension/billing issue in Google Ads before any other optimization can take effect.",
  },
  {
    id: "geo_targeting_present",
    categoryId: "targeting_geo",
    label: "Location targeting configured on every active campaign",
    kind: "discrete",
    weight: 0.3,
    gateId: "no_geo_targeting",
    description:
      "Every active campaign should target specific geographies (state/city/radius) relevant to where the firm practices — not the default \"all locations\".",
    fixTemplate:
      "Add explicit location targets (state, city, or radius around the office) to {entities} and remove default all-location targeting.",
  },
  {
    id: "location_targeting_setting",
    categoryId: "targeting_geo",
    label: "\"Presence\" location targeting setting used, not \"Presence or Interest\"",
    kind: "discrete",
    weight: 0.2,
    description:
      "Law firm campaigns should target people physically in the service area (\"Presence\"), not people merely searching about the area (\"Presence or Interest\"), which leaks budget to irrelevant searchers.",
    fixTemplate:
      "Switch the location targeting option to \"Presence: People in or regularly in your targeted locations\" on {entities}.",
  },
  {
    id: "language_targeting_matches_market",
    categoryId: "targeting_geo",
    label: "Language targeting matches the served market",
    kind: "discrete",
    weight: 0.2,
    description:
      "Language targeting should reflect the languages the firm actually serves (commonly English + Spanish for consumer legal), not left as an unreviewed default.",
    fixTemplate:
      "Review and adjust language targeting on {entities} to match the languages the firm's intake team can serve.",
  },

  // -------------------- Keywords --------------------
  {
    id: "negative_keyword_coverage",
    categoryId: "keywords",
    label: "Shared negative keyword lists applied",
    kind: "discrete",
    weight: 0.3,
    description:
      "Campaigns should use at least one shared negative keyword list (e.g. \"jobs/careers\", \"free\", competitor names not being targeted intentionally) to block irrelevant clicks.",
    fixTemplate:
      "Attach a shared negative keyword list to {entities}; build one from search term review if none exists.",
  },
  {
    id: "search_term_irrelevance_rate",
    categoryId: "keywords",
    label: "Low share of spend on irrelevant search terms",
    kind: "continuous",
    weight: 0.3,
    bands: [
      { min: 0, status: "good", score: 100 },
      { min: 0.05, status: "okay", score: 70 },
      { min: 0.15, status: "bad", score: 35 },
      { min: 0.3, status: "critical", score: 0 },
    ],
    description:
      "Share of the lookback window's cost spent on search terms with no topical relation to legal services offered (e.g. \"jobs\", \"free\", unrelated practice areas).",
    fixTemplate:
      "Add {measuredValue} of irrelevant search-term spend as negative keywords across {entities}.",
  },
  {
    id: "keyword_match_type_mix",
    categoryId: "keywords",
    label: "Healthy match-type mix (not all broad match)",
    kind: "continuous",
    weight: 0.2,
    bands: [
      { min: 0, status: "good", score: 100 },
      { min: 0.6, status: "okay", score: 70 },
      { min: 0.85, status: "bad", score: 35 },
      { min: 0.97, status: "critical", score: 0 },
    ],
    description:
      "Share of active keywords that are broad match with no Smart Bidding safety net (e.g. no conversion tracking or new campaign). High broad-match concentration without guardrails risks budget leakage.",
    fixTemplate:
      "Diversify match types on {entities} — add phrase/exact variants for top-performing broad terms.",
  },
  {
    id: "quality_score_health",
    categoryId: "keywords",
    label: "Keyword Quality Scores are healthy",
    kind: "continuous",
    weight: 0.2,
    bands: [
      { min: 7, status: "good", score: 100 },
      { min: 5, status: "okay", score: 70 },
      { min: 3, status: "bad", score: 35 },
      { min: 0, status: "critical", score: 0 },
    ],
    description:
      "Impression-weighted average Quality Score (1-10) across active keywords with recorded QS.",
    fixTemplate:
      "Improve ad relevance and landing page experience for {entities} to lift Quality Score.",
  },

  // -------------------- Bidding & Budget --------------------
  {
    id: "conversion_tracking_present",
    categoryId: "bidding_budget",
    label: "Conversion tracking is active",
    kind: "discrete",
    weight: 0.3,
    gateId: "no_conversion_tracking",
    description:
      "At least one active, non-test conversion action must have recorded conversions in the lookback window.",
    fixTemplate:
      "Verify the conversion tracking tag/call-tracking integration is firing correctly; no conversions were recorded in the lookback window.",
  },
  {
    id: "budget_lost_impression_share",
    categoryId: "bidding_budget",
    label: "Low budget-constrained lost impression share",
    kind: "continuous",
    weight: 0.3,
    bands: [
      { min: 0, status: "good", score: 100 },
      { min: 0.1, status: "okay", score: 70 },
      { min: 0.3, status: "bad", score: 35 },
      { min: 0.5, status: "critical", score: 0 },
    ],
    description:
      "Search impression share lost specifically due to budget (not rank) — high values mean the campaign is under-funded relative to demand.",
    fixTemplate:
      "Increase daily budget on {entities}, currently losing {measuredValue} of impression share to budget constraints.",
  },
  {
    id: "bidding_strategy_appropriate",
    categoryId: "bidding_budget",
    label: "Bidding strategy fits the account's conversion volume",
    kind: "discrete",
    weight: 0.2,
    description:
      "Smart Bidding strategies (Maximize Conversions/tCPA/tROAS) need enough conversion volume to learn from; accounts with too little history should use manual/enhanced CPC until volume builds.",
    fixTemplate:
      "Switch {entities} to a bidding strategy appropriate for its conversion volume (manual/eCPC while volume is low, Smart Bidding once conversions are sufficient).",
  },
  {
    id: "budget_utilization",
    categoryId: "bidding_budget",
    label: "Daily budgets are being spent, not stranded",
    kind: "continuous",
    weight: 0.2,
    bands: [
      { min: 0.85, status: "good", score: 100 },
      { min: 0.6, status: "okay", score: 70 },
      { min: 0.3, status: "bad", score: 35 },
      { min: 0, status: "critical", score: 0 },
    ],
    description:
      "Average share of daily budget actually spent across active campaigns in the lookback window — low utilization signals a rank/targeting problem stranding budget unspent.",
    fixTemplate:
      "Investigate why {entities} are under-spending budget — check bids, targeting breadth, and ad approval status.",
  },

  // -------------------- Ads & Creative --------------------
  {
    id: "ads_disapproval_rate",
    categoryId: "ads_creative",
    label: "No disapproved ads",
    kind: "discrete",
    weight: 0.3,
    gateId: "disapproved_ads",
    description:
      "Any ad with approval status DISAPPROVED cannot serve at all.",
    fixTemplate:
      "Fix the policy violation and resubmit {entities} for review.",
  },
  {
    id: "rsa_ad_strength",
    categoryId: "ads_creative",
    label: "Responsive Search Ad strength is good/excellent",
    kind: "continuous",
    weight: 0.3,
    bands: [
      { min: 0, status: "good", score: 100 },
      { min: 0.2, status: "okay", score: 70 },
      { min: 0.5, status: "bad", score: 35 },
      { min: 0.8, status: "critical", score: 0 },
    ],
    description:
      "Share of enabled RSAs with ad strength POOR or AVERAGE (worse the higher the value).",
    fixTemplate:
      "Add more distinct headlines/descriptions to {entities} to raise ad strength above AVERAGE.",
  },
  {
    id: "ads_per_ad_group",
    categoryId: "ads_creative",
    label: "At least 2-3 active ads per ad group",
    kind: "discrete",
    weight: 0.2,
    description:
      "Each active ad group should have 2-3 enabled ads to allow effective A/B testing; single-ad ad groups have no comparison baseline.",
    fixTemplate:
      "Add at least one more ad variant to {entities} — currently running a single ad.",
  },
  {
    id: "call_extensions_in_ads",
    categoryId: "ads_creative",
    label: "Ads reference call-to-action consistent with intake flow",
    kind: "discrete",
    weight: 0.2,
    description:
      "Ad copy should include a clear, consistent call to action (\"Call Now\", \"Free Consultation\") matching the firm's intake process.",
    fixTemplate:
      "Align ad copy CTAs on {entities} with the firm's actual intake call-to-action.",
  },

  // -------------------- Assets (Extensions) --------------------
  {
    id: "sitelink_assets_present",
    categoryId: "assets",
    label: "Sitelink assets configured",
    kind: "discrete",
    weight: 0.3,
    description:
      "Every active campaign should have at least 4 sitelink assets to increase SERP real estate and click-through options.",
    fixTemplate: "Add at least 4 sitelink assets to {entities}.",
  },
  {
    id: "call_assets_present",
    categoryId: "assets",
    label: "Call assets configured",
    kind: "discrete",
    weight: 0.3,
    description:
      "Call assets are especially important for law firm intake — most legal searches convert via phone call.",
    fixTemplate: "Add a call asset with the firm's intake line to {entities}.",
  },
  {
    id: "structured_snippet_and_callout_assets",
    categoryId: "assets",
    label: "Structured snippet and callout assets configured",
    kind: "discrete",
    weight: 0.2,
    description:
      "Callout assets (e.g. \"Free Consultation\", \"No Fee Unless We Win\") and structured snippets (practice areas) add trust signals and coverage.",
    fixTemplate:
      "Add callout and structured snippet assets highlighting the firm's practice areas and value props to {entities}.",
  },
  {
    id: "location_assets_present",
    categoryId: "assets",
    label: "Location asset linked (Google Business Profile)",
    kind: "discrete",
    weight: 0.2,
    description:
      "A linked location asset surfaces the firm's address and map pin alongside the ad, building local trust.",
    fixTemplate: "Link the firm's Google Business Profile as a location asset on {entities}.",
  },

  // -------------------- Policy & Compliance --------------------
  {
    id: "legal_certification_status",
    categoryId: "policy",
    label: "Legal services certification in good standing",
    kind: "discrete",
    weight: 0.4,
    description:
      "Google requires legal-services advertiser verification/certification in applicable regions; a lapsed certification can limit or disapprove ad serving.",
    fixTemplate:
      "Renew/complete the legal services advertiser certification for the account.",
  },
  {
    id: "policy_topic_warnings",
    categoryId: "policy",
    label: "No active policy topic warnings",
    kind: "discrete",
    weight: 0.3,
    description:
      "Policy manager warnings (even non-disapproving ones) signal risk of future ad limitation and should be reviewed.",
    fixTemplate: "Review and resolve the policy topic warning(s) on {entities}.",
  },
  {
    id: "trademark_complaint_exposure",
    categoryId: "policy",
    label: "No unresolved trademark complaints",
    kind: "discrete",
    weight: 0.3,
    description:
      "Unresolved third-party trademark complaints can restrict keyword/ad usage in affected regions.",
    fixTemplate: "Resolve or contest the outstanding trademark complaint(s) affecting {entities}.",
  },

  // -------------------- Optimization Score --------------------
  {
    id: "optimization_score_value",
    categoryId: "optimization_score",
    label: "Google's account Optimization Score",
    kind: "continuous",
    weight: 0.6,
    bands: [
      { min: 0.8, status: "good", score: 100 },
      { min: 0.6, status: "okay", score: 70 },
      { min: 0.4, status: "bad", score: 35 },
      { min: 0, status: "critical", score: 0 },
    ],
    description:
      "Google Ads' own account-level Optimization Score (0-100%), taken as-is from the API.",
    fixTemplate:
      "Review the top recommendations Google is surfacing for this account to raise Optimization Score.",
  },
  {
    id: "high_impact_recommendations_open",
    categoryId: "optimization_score",
    label: "Few unaddressed high-impact recommendations",
    kind: "continuous",
    weight: 0.4,
    bands: [
      { min: 0, status: "good", score: 100 },
      { min: 2, status: "okay", score: 70 },
      { min: 5, status: "bad", score: 35 },
      { min: 10, status: "critical", score: 0 },
    ],
    description:
      "Count of open Google Ads recommendations flagged HIGH impact.",
    fixTemplate:
      "Triage the {measuredValue} open high-impact recommendations Google Ads is surfacing for this account.",
  },

  // -------------------- Account Structure --------------------
  {
    id: "campaign_count_reasonable",
    categoryId: "account_structure",
    label: "Campaign count matches practice area count",
    kind: "discrete",
    weight: 0.3,
    description:
      "Campaigns should be organized roughly one-per-practice-area (or per intent tier); too few campaigns bundle unrelated practice areas under one budget/bid strategy, too many fragments data.",
    fixTemplate:
      "Restructure campaigns so each practice area has a dedicated campaign — {entities} currently mix unrelated practice areas.",
  },
  {
    id: "ad_group_theming",
    categoryId: "account_structure",
    label: "Ad groups are tightly themed (SKAG-adjacent)",
    kind: "continuous",
    weight: 0.3,
    bands: [
      { min: 0, status: "good", score: 100 },
      { min: 8, status: "okay", score: 70 },
      { min: 20, status: "bad", score: 35 },
      { min: 40, status: "critical", score: 0 },
    ],
    description:
      "Average number of keywords per ad group across active ad groups — high counts mean loosely themed ad groups with weak keyword-to-ad relevance.",
    fixTemplate:
      "Split {entities} into tighter, single-theme ad groups (aim for under ~15 closely related keywords each).",
  },
  {
    id: "audience_signals_attached",
    categoryId: "account_structure",
    label: "Audience signals attached to campaigns",
    kind: "discrete",
    weight: 0.2,
    description:
      "Observation/targeting audience signals (in-market, affinity, remarketing, customer match) should be attached to give Smart Bidding useful signal.",
    fixTemplate: "Attach relevant audience signals to {entities}.",
  },
  {
    id: "network_settings_scoped",
    categoryId: "account_structure",
    label: "Search Partners / Display Expansion scoped intentionally",
    kind: "discrete",
    weight: 0.2,
    description:
      "Search campaigns opted into Search Partners and/or Display Network Expansion without a deliberate reason often waste budget on lower-intent placements.",
    fixTemplate:
      "Review whether Search Partners / Display Expansion is intentional on {entities}; disable if it was left on by default.",
  },
];

export function getCategoryDef(categoryId: string): AuditCategoryDef {
  const cat = CHECK_CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) throw new Error(`Unknown audit category id: ${categoryId}`);
  return cat;
}

export function getChecksForCategory(categoryId: string): AuditCheckDef[] {
  return AUDIT_CHECKS.filter((c) => c.categoryId === categoryId);
}
