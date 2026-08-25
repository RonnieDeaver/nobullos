/**
 * Ads OS — GAds Hygiene Audit check catalog.
 *
 * Verbatim port of the source bundle's `config/checks.yaml` (generated from
 * law-firm-google-ads-hygiene-spec.md Part 1). The YAML is tuned product — the
 * ids, rules, api_source notes and recommendations are copied as-is; only the
 * container format changed (YAML -> TS data, parsed at runtime by the loader).
 *
 *   scoring: discrete | continuous
 *     discrete   -> module returns a status (good|okay|bad|critical|na); mapped via weights.status_scores
 *     continuous -> module returns score 0-100 directly (formula in the module / scoring.ts)
 *   law_firm: especially important for legal lead-gen accounts
 *   gate: if true, the check can trigger a score cap (see weights.caps)
 *   api_source: primary GAQL resource(s); field paths validated against the v24 reference
 */

export interface CheckDef {
  id: string;
  name: string;
  scoring: "discrete" | "continuous";
  rule: string;
  api_source: string;
  recommendation: string;
  law_firm?: boolean;
  gate?: boolean;
}

/** Category code -> ordered check definitions (mirrors checks.yaml top level). */
export const CHECKS_BY_CATEGORY: Record<string, CheckDef[]> = {
  GEO: [
    {
      id: "GEO-01",
      name: "Location targeting set",
      scoring: "discrete",
      law_firm: true,
      gate: true,
      rule: "good: explicit positive locations. critical: defaulting to all/global.",
      api_source: "campaign_criterion (type LOCATION)",
      recommendation:
        "Set explicit positive location targets for every campaign; remove the all/global default.",
    },
    {
      id: "GEO-02",
      name: "Geo target type = Presence",
      scoring: "discrete",
      law_firm: true,
      rule: "good: PRESENCE. critical: PRESENCE_OR_INTEREST (or interest-based).",
      api_source: "campaign.geo_target_type_setting.positive_geo_target_type",
      recommendation: "Switch positive geo target type to Presence ('people in').",
    },
    // GEO-03 removed per team review.
    {
      id: "GEO-04",
      name: "Language targeting sane",
      scoring: "discrete",
      rule: "good: appropriate languages set. bad: none/contradictory.",
      api_source: "campaign_criterion (type LANGUAGE)",
      recommendation: "Target the languages your audience actually searches in.",
    },
  ],

  KWS: [
    {
      id: "KWS-01",
      name: "Average Quality Score",
      scoring: "continuous",
      rule: "s = (avg_QS / 10) * 100. good >=7, okay 5-6.9, bad <5.",
      api_source: "ad_group_criterion.quality_info.quality_score",
      recommendation:
        "Improve ad relevance, expected CTR, and landing page experience on low-QS keywords.",
    },
    {
      id: "KWS-02",
      name: "QS component breakdown",
      scoring: "discrete",
      rule: "flag count of BELOW_AVERAGE across expected CTR / ad relevance / LP experience.",
      api_source:
        "quality_info.creative_quality_score, .post_click_quality_score, .search_predicted_ctr",
      recommendation:
        "Address the weakest QS component first (usually landing page or ad relevance).",
    },
    {
      id: "KWS-03",
      name: "Negative keyword lists applied",
      scoring: "discrete",
      law_firm: true,
      rule: "good: shared negative set(s) attached. bad: none.",
      api_source: "shared_set, campaign_shared_set, shared_criterion",
      recommendation: "Attach a shared negative keyword list to every search campaign.",
    },
    // KWS-04/05/07 removed per team review.
    {
      id: "KWS-06",
      name: "Match-type / broad-match risk",
      scoring: "discrete",
      rule: "flag broad-heavy ad groups lacking tCPA + negatives.",
      api_source: "ad_group_criterion.keyword.match_type",
      recommendation: "Pair broad match only with Smart Bidding and a strong negative list.",
    },
    {
      id: "KWS-08",
      name: "Duplicate keywords",
      scoring: "discrete",
      rule: "flag same keyword/match across ad groups (cannibalization).",
      api_source: "ad_group_criterion dedupe",
      recommendation: "De-duplicate keywords competing across ad groups.",
    },
  ],

  BID: [
    {
      id: "BID-01",
      name: "Bid strategy not limited",
      scoring: "discrete",
      law_firm: true,
      rule: "good: no limiting status. bad: limited (budget/target/volume).",
      api_source: "campaign.primary_status, .primary_status_reasons; bidding strategy status",
      recommendation: "Resolve the limiting reason — raise budget or adjust the target.",
    },
    {
      id: "BID-02",
      name: "Search IS lost to budget",
      scoring: "continuous",
      rule: "s = (1 - search_budget_lost_impression_share) * 100. good <10%, okay 10-25%, bad >25%.",
      api_source: "metrics.search_budget_lost_impression_share",
      recommendation: "Increase budget on campaigns losing impression share to budget.",
    },
    {
      id: "BID-03",
      name: "Search IS lost to rank",
      scoring: "continuous",
      rule: "s = (1 - search_rank_lost_impression_share) * 100. good <20%, okay 20-40%, bad >40%.",
      api_source: "metrics.search_rank_lost_impression_share",
      recommendation: "Improve Quality Score / bids to recover rank-lost impression share.",
    },
    {
      id: "BID-04",
      name: "Bid strategy type appropriate",
      scoring: "discrete",
      law_firm: true,
      rule: "good: tCPA/MaxConv or tROAS/MaxConvValue. bad: Manual CPC / Max Clicks on a campaign with >=15 conversions in the lookback window.",
      api_source: "campaign.bidding_strategy_type",
      recommendation:
        "Move any Manual CPC / Max Clicks campaign with 15+ conversions to a conversion-based Smart Bidding strategy (Max Conversions / tCPA).",
    },
    {
      id: "BID-05",
      name: "Target (tCPA/tROAS) sanity",
      scoring: "discrete",
      rule: "good: target set, actual within sane band. bad: target so low it starves delivery.",
      api_source: "bidding strategy targets vs metrics.cost_per_conversion",
      recommendation: "Set the tCPA/tROAS target to a realistic value near actual performance.",
    },
    // BID-06/07 removed per team review.
  ],

  ADS: [
    {
      id: "ADS-01",
      name: "Ad strength of active ads",
      scoring: "continuous",
      rule: "weighted avg {EXCELLENT:100, GOOD:85, AVERAGE:55, POOR:20}.",
      api_source: "ad_group_ad.ad_strength",
      recommendation:
        "Strengthen RSAs (more distinct headlines/descriptions) to raise ad strength.",
    },
    {
      id: "ADS-02",
      name: "Active ads per ad group",
      scoring: "continuous",
      rule: "0 ads -> 0; 1 -> 60; 2+ -> 100; averaged across ad groups.",
      api_source: "ad_group_ad count per active ad group",
      recommendation: "Run at least two active ads per ad group for rotation and testing.",
    },
    // ADS-03 removed per team review (overlaps ADS-02).
    // ADS-04 (RSA asset utilization) removed per team review.
    {
      id: "ADS-05",
      name: "Over-pinning",
      scoring: "discrete",
      rule: "bad: most headlines/descriptions pinned (caps strength & learning).",
      api_source: "pinned_field on RSA assets",
      recommendation:
        "Pin sparingly — leave most assets unpinned so the system can optimize.",
    },
    // ADS-06 removed per team review.
    {
      id: "ADS-07",
      name: "Deprecated formats",
      scoring: "discrete",
      rule: "bad: legacy call-only CallAd present (removed v23).",
      api_source: "ad.type audit",
      recommendation: "Replace deprecated call-only ads with RSAs plus call assets.",
    },
  ],

  AST: [
    {
      id: "AST-01",
      name: "Sitelinks",
      scoring: "continuous",
      rule: "0 -> 20; 1-3 -> 45; 4-5 -> 70; 6+ -> 100.",
      api_source: "campaign_asset / asset type SITELINK",
      recommendation: "Add sitelinks until each campaign has at least 6.",
    },
    {
      id: "AST-02",
      name: "Call asset",
      scoring: "discrete",
      law_firm: true,
      rule: "bad: 0. good: >=1.",
      api_source: "asset type CALL",
      recommendation: "Add a call asset so prospects can phone the firm directly.",
    },
    {
      id: "AST-03",
      name: "Location asset",
      scoring: "discrete",
      law_firm: true,
      rule: "bad: 0. good: >=1 (campaign or account).",
      api_source: "location asset / Business Profile link",
      recommendation: "Link the Business Profile / add a location asset.",
    },
    {
      id: "AST-04",
      name: "Structured snippet",
      scoring: "discrete",
      rule: "bad: 0. good: >=1.",
      api_source: "asset type STRUCTURED_SNIPPET",
      recommendation: "Add structured snippets (e.g. practice areas).",
    },
    {
      id: "AST-05",
      name: "Callout",
      scoring: "discrete",
      rule: "bad: 0. good: >=1.",
      api_source: "asset type CALLOUT",
      recommendation:
        "Add callouts highlighting differentiators (free consult, 24/7, no fee unless we win).",
    },
    {
      id: "AST-06",
      name: "Image asset",
      scoring: "continuous",
      rule: "0 -> 20; 1-2 -> 60; 3+ -> 100.",
      api_source: "asset type IMAGE",
      recommendation: "Add at least 3 image assets per campaign.",
    },
    // AST-08 removed per team review (surfaces via POL-03/04).
  ],

  // POL (Policy & Compliance) removed from the hygiene audit per team review — these
  // serving/policy failures are now owned by the Account Alerts engine (real-time,
  // only-on-change): POL-01 disapproved ads, POL-03 disapproved assets, POL-04
  // limited/under-review, POL-05 account standing. (POL-02/06/07 were never exposed.)

  OPT: [
    {
      id: "OPT-01",
      name: "Optimization score",
      scoring: "continuous",
      rule: "s = optimization_score (already 0-100). good >=85, okay 70-84, bad <70.",
      api_source: "customer.optimization_score, campaign.optimization_score",
      recommendation:
        "Review high-impact recommendations — but vet each against lead-gen goals.",
    },
    // OPT-02 (pending recs) removed per team review; OPT-03 not readable via GAQL.
  ],

  STR: [
    {
      id: "STR-01",
      name: "Network settings",
      scoring: "discrete",
      rule: "good: Display expansion off. okay: Search Partners on. bad: Display expansion on (lead gen).",
      api_source: "campaign.network_settings",
      recommendation: "Turn off Display expansion on lead-gen search campaigns.",
    },
    // STR-02 (ad schedule) and STR-04 (audiences) removed per team review.
    // STR-03 and STR-05 removed earlier.
  ],

  // Informational only (0 weight, surfaced as upsell flags):
  //   lead-form asset, promotion asset, price assets, sitelink description completeness.
};
