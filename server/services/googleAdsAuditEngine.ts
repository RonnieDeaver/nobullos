/**
 * Task #2784 — Google Ads Hygiene Audit engine.
 *
 * Fetches live, read-only data for one customer via
 * `googleAdsAuditQueries.ts`, evaluates every check in
 * `googleAdsAuditChecks.ts`, aggregates category + overall scores, applies
 * critical-gate capping, and persists the run + per-check results.
 *
 * Scoring math:
 *   - Each check contributes `score` (0-100) unless `not_applicable`.
 *   - A category's sub-score is the weighted average of its checks'
 *     scores (weights renormalized over only the applicable checks).
 *   - `H` (overall) is the weighted average of category sub-scores using
 *     `CHECK_CATEGORIES[].weight` (renormalized over categories that had
 *     at least one applicable check).
 *   - `H_final` = `H` capped at the MINIMUM `capAt` among every gate whose
 *     trigger check(s) landed in `critical` status. No gates fired -> `H_final
 *     === H`.
 */

import {
  AUDIT_CHECKS,
  AUDIT_GATES,
  CHECK_CATEGORIES,
  DISCRETE_STATUS_SCORE,
  type AuditCheckDef,
} from "../config/googleAdsAuditChecks";
import { buildSyncCustomerQueries } from "./googleAdsIntegration";
import {
  buildAdGroupCounts,
  fetchAccountStatus,
  fetchAdAuditRows,
  fetchAdPolicyTopics,
  fetchCampaignAssetLinks,
  fetchCampaignAuditRows,
  fetchCampaignGeoAndLanguage,
  fetchCampaignsWithAudienceSignals,
  fetchConversionCount,
  fetchKeywordAuditRows,
  fetchOpenRecommendations,
  fetchOptimizationScore,
  fetchSearchTerms,
  fetchSharedNegativeKeywordSetCount,
} from "./googleAdsAuditQueries";
import {
  createGoogleAdsAuditRun,
  insertGoogleAdsAuditCheckResults,
  updateGoogleAdsAuditRun,
} from "../storage/googleAdsAuditStorage";
import type {
  AuditCheckStatus,
  InsertGoogleAdsAuditCheckResult,
} from "@shared/schema";

export interface CheckEvalResult {
  status: AuditCheckStatus;
  score: number | null; // null only for not_applicable
  measuredValue: string | null;
  measuredNumeric: number | null;
  affectedEntities: string[];
}

export function bandFor(
  value: number,
  bands: { min: number; status: "good" | "okay" | "bad" | "critical"; score: number }[],
): { status: "good" | "okay" | "bad" | "critical"; score: number } {
  // Checks in googleAdsAuditChecks.ts order their bands two ways depending
  // on which direction is "better":
  //   - "lower is better" checks list bands ASCENDING by `min` (good first,
  //     smallest min) — the matching band is the LAST one whose min <= value.
  //   - "higher is better" checks list bands DESCENDING by `min` (good
  //     first, largest min) — the matching band is the FIRST one whose
  //     min <= value.
  // Detect direction from the array's own ordering so both layouts resolve
  // correctly instead of assuming one fixed order (a fixed-ascending
  // assumption silently mis-scores every descending config as critical/0).
  const ascending = bands.length < 2 || bands[0].min <= bands[bands.length - 1].min;
  if (ascending) {
    let chosen = bands[0];
    for (const b of bands) {
      if (value >= b.min) chosen = b;
    }
    return chosen;
  }
  for (const b of bands) {
    if (value >= b.min) return b;
  }
  return bands[bands.length - 1];
}

/** A small legal-services relevance heuristic for the search-term irrelevance
 * check: terms containing these tokens are flagged irrelevant. This is a
 * simple allowlist-free heuristic (the source app's own NLP relevance model
 * is out of scope for this foundation task) — good enough to surface
 * obviously wasted spend (jobs postings, free/DIY searches, unrelated
 * services) without a false sense of precision. */
const IRRELEVANT_TERM_TOKENS = [
  "job", "jobs", "career", "careers", "hiring", "salary", "internship",
  "free", "diy", "do it yourself", "template", "how to become a lawyer",
  "law school", "definition", "meaning of",
];

function isLikelyIrrelevant(term: string): boolean {
  const t = term.toLowerCase();
  return IRRELEVANT_TERM_TOKENS.some((token) => t.includes(token));
}

interface AuditDataBundle {
  accountStatus: Awaited<ReturnType<typeof fetchAccountStatus>>;
  optimizationScore: number | null;
  openRecommendations: Awaited<ReturnType<typeof fetchOpenRecommendations>>;
  campaigns: Awaited<ReturnType<typeof fetchCampaignAuditRows>>;
  geoLanguage: Awaited<ReturnType<typeof fetchCampaignGeoAndLanguage>>;
  negativeSetCount: number;
  searchTerms: Awaited<ReturnType<typeof fetchSearchTerms>>;
  keywords: Awaited<ReturnType<typeof fetchKeywordAuditRows>>;
  ads: Awaited<ReturnType<typeof fetchAdAuditRows>>;
  assetLinks: Awaited<ReturnType<typeof fetchCampaignAssetLinks>>;
  policyTopics: Awaited<ReturnType<typeof fetchAdPolicyTopics>>;
  audienceCampaignIds: Set<string>;
  conversionCount: number;
  /** The audit run's actual lookback window in days (metric queries are date-filtered to it). */
  lookbackDays: number;
}

async function fetchAuditData(
  customerId: string,
  lookbackDays: number,
): Promise<AuditDataBundle> {
  const { dateFilter } = buildSyncCustomerQueries(lookbackDays);
  const [
    accountStatus,
    optimizationScore,
    openRecommendations,
    campaigns,
    geoLanguage,
    negativeSetCount,
    searchTerms,
    keywords,
    ads,
    assetLinks,
    policyTopics,
    audienceCampaignIds,
    conversionCount,
  ] = await Promise.all([
    fetchAccountStatus(customerId),
    fetchOptimizationScore(customerId),
    fetchOpenRecommendations(customerId),
    fetchCampaignAuditRows(customerId, dateFilter),
    fetchCampaignGeoAndLanguage(customerId),
    fetchSharedNegativeKeywordSetCount(customerId),
    fetchSearchTerms(customerId, dateFilter),
    fetchKeywordAuditRows(customerId, dateFilter),
    fetchAdAuditRows(customerId),
    fetchCampaignAssetLinks(customerId),
    fetchAdPolicyTopics(customerId),
    fetchCampaignsWithAudienceSignals(customerId),
    fetchConversionCount(customerId, dateFilter),
  ]);
  return {
    accountStatus,
    optimizationScore,
    openRecommendations,
    campaigns,
    geoLanguage,
    negativeSetCount,
    searchTerms,
    keywords,
    ads,
    assetLinks,
    policyTopics,
    audienceCampaignIds,
    conversionCount,
    lookbackDays,
  };
}

function evalCheck(check: AuditCheckDef, data: AuditDataBundle): CheckEvalResult {
  const activeCampaigns = data.campaigns.filter((c) => c.status === "ENABLED");
  const campaignNames = (ids: string[]) =>
    activeCampaigns
      .filter((c) => ids.includes(c.campaignId))
      .map((c) => c.campaignName || c.campaignId);

  switch (check.id) {
    case "account_status_active": {
      const status = data.accountStatus?.status ?? null;
      const ok = status === "ENABLED";
      return discrete(ok ? "good" : "critical", ok ? null : status, []);
    }
    case "geo_targeting_present": {
      const withGeo = new Set(
        data.geoLanguage.filter((g) => g.locationCount > 0).map((g) => g.campaignId),
      );
      const missing = activeCampaigns.filter((c) => !withGeo.has(c.campaignId));
      if (activeCampaigns.length === 0) return notApplicable();
      const status: AuditCheckStatus = missing.length === 0 ? "good" : "critical";
      return discrete(
        status,
        `${activeCampaigns.length - missing.length} of ${activeCampaigns.length} campaigns targeted`,
        missing.map((c) => c.campaignName || c.campaignId),
      );
    }
    case "location_targeting_setting": {
      const relevant = data.geoLanguage.filter((g) => g.presenceOnly !== null);
      if (relevant.length === 0) return notApplicable();
      const notPresence = relevant.filter((g) => g.presenceOnly === false);
      const status: AuditCheckStatus = notPresence.length === 0 ? "good" : "bad";
      return discrete(
        status,
        `${relevant.length - notPresence.length} of ${relevant.length} campaigns use Presence-only`,
        campaignNames(notPresence.map((g) => g.campaignId)),
      );
    }
    case "language_targeting_matches_market": {
      const withLang = data.geoLanguage.filter((g) => g.languageCount > 0);
      const missing = activeCampaigns.filter(
        (c) => !withLang.some((g) => g.campaignId === c.campaignId),
      );
      if (activeCampaigns.length === 0) return notApplicable();
      const status: AuditCheckStatus = missing.length === 0 ? "good" : "okay";
      return discrete(
        status,
        `${activeCampaigns.length - missing.length} of ${activeCampaigns.length} campaigns have explicit language targeting`,
        missing.map((c) => c.campaignName || c.campaignId),
      );
    }
    case "negative_keyword_coverage": {
      const status: AuditCheckStatus = data.negativeSetCount > 0 ? "good" : "bad";
      return discrete(status, `${data.negativeSetCount} shared negative list(s)`, []);
    }
    case "search_term_irrelevance_rate": {
      const totalCost = data.searchTerms.reduce((s, t) => s + t.costMicros, 0);
      if (totalCost === 0) return notApplicable();
      const irrelevantCost = data.searchTerms
        .filter((t) => isLikelyIrrelevant(t.searchTerm))
        .reduce((s, t) => s + t.costMicros, 0);
      const ratio = irrelevantCost / totalCost;
      return continuous(check, ratio, `${(ratio * 100).toFixed(1)}% of spend`, ratio, campaignNames(
        Array.from(new Set(data.searchTerms.filter((t) => isLikelyIrrelevant(t.searchTerm)).map((t) => t.campaignId))),
      ));
    }
    case "keyword_match_type_mix": {
      if (data.keywords.length === 0) return notApplicable();
      const broad = data.keywords.filter((k) => k.matchType === "BROAD").length;
      const ratio = broad / data.keywords.length;
      return continuous(check, ratio, `${(ratio * 100).toFixed(0)}% broad match`, ratio, []);
    }
    case "quality_score_health": {
      const scored = data.keywords.filter((k) => k.qualityScore != null && k.impressions > 0);
      if (scored.length === 0) return notApplicable();
      const totalImpr = scored.reduce((s, k) => s + k.impressions, 0);
      const weighted = scored.reduce((s, k) => s + (k.qualityScore as number) * k.impressions, 0) / totalImpr;
      return continuous(check, weighted, `avg QS ${weighted.toFixed(1)}/10`, weighted, []);
    }
    case "conversion_tracking_present": {
      const status: AuditCheckStatus = data.conversionCount > 0 ? "good" : "critical";
      return discrete(status, `${data.conversionCount.toFixed(0)} conversions in window`, []);
    }
    case "budget_lost_impression_share": {
      const withData = activeCampaigns.filter((c) => c.searchBudgetLostImpressionShare != null);
      if (withData.length === 0) return notApplicable();
      const avg =
        withData.reduce((s, c) => s + (c.searchBudgetLostImpressionShare as number), 0) / withData.length;
      const worst = withData.filter((c) => (c.searchBudgetLostImpressionShare as number) >= 0.3);
      return continuous(
        check,
        avg,
        `${(avg * 100).toFixed(0)}% lost to budget`,
        avg,
        worst.map((c) => c.campaignName || c.campaignId),
      );
    }
    case "bidding_strategy_appropriate": {
      const smartBidding = new Set([
        "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "TARGET_ROAS",
      ]);
      const lowVolume = data.conversionCount < 15; // Google's own Smart Bidding learning guidance floor
      const offenders = activeCampaigns.filter(
        (c) => lowVolume && c.biddingStrategyType && smartBidding.has(c.biddingStrategyType),
      );
      if (activeCampaigns.length === 0) return notApplicable();
      const status: AuditCheckStatus = offenders.length === 0 ? "good" : "bad";
      return discrete(
        status,
        lowVolume
          ? `${offenders.length} campaign(s) on Smart Bidding with only ${data.conversionCount.toFixed(0)} conversions`
          : "conversion volume supports Smart Bidding",
        offenders.map((c) => c.campaignName || c.campaignId),
      );
    }
    case "budget_utilization": {
      const withBudget = activeCampaigns.filter((c) => c.budgetMicros > 0);
      if (withBudget.length === 0) return notApplicable();
      const ratios = withBudget.map((c) => c.costMicros / (c.budgetMicros * data.lookbackDays));
      const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
      const low = withBudget.filter((c, i) => ratios[i] < 0.3);
      return continuous(
        check,
        avg,
        `${(avg * 100).toFixed(0)}% of budget spent`,
        avg,
        low.map((c) => c.campaignName || c.campaignId),
      );
    }
    case "ads_disapproval_rate": {
      const disapproved = data.ads.filter((a) => a.approvalStatus === "DISAPPROVED");
      const status: AuditCheckStatus = disapproved.length === 0 ? "good" : "critical";
      return discrete(
        status,
        `${disapproved.length} disapproved ad(s)`,
        campaignNames(Array.from(new Set(disapproved.map((a) => a.campaignId)))),
      );
    }
    case "rsa_ad_strength": {
      const rsas = data.ads.filter((a) => a.type === "RESPONSIVE_SEARCH_AD" && a.adStrength);
      if (rsas.length === 0) return notApplicable();
      const weak = rsas.filter((a) => a.adStrength === "POOR" || a.adStrength === "AVERAGE");
      const ratio = weak.length / rsas.length;
      return continuous(
        check,
        ratio,
        `${weak.length} of ${rsas.length} RSAs below GOOD`,
        ratio,
        campaignNames(Array.from(new Set(weak.map((a) => a.campaignId)))),
      );
    }
    case "ads_per_ad_group": {
      const counts = buildAdGroupCounts(data.keywords, data.ads);
      const withAds = counts.filter((c) => c.enabledAdCount > 0);
      if (withAds.length === 0) return notApplicable();
      const single = withAds.filter((c) => c.enabledAdCount < 2);
      const status: AuditCheckStatus = single.length === 0 ? "good" : single.length / withAds.length > 0.5 ? "bad" : "okay";
      return discrete(
        status,
        `${single.length} of ${withAds.length} ad groups have a single ad`,
        campaignNames(Array.from(new Set(single.map((c) => c.campaignId)))),
      );
    }
    case "call_extensions_in_ads": {
      // Foundation-tier proxy: presence of a call asset stands in for a
      // reviewed, consistent CTA (full ad-copy CTA text analysis is a
      // follow-on task). Treat as N/A here; scored via the dedicated
      // call_assets_present check instead to avoid double-counting the
      // same signal under two check ids.
      return notApplicable();
    }
    case "sitelink_assets_present": {
      return assetCoverageCheck(data, activeCampaigns, "SITELINK");
    }
    case "call_assets_present": {
      return assetCoverageCheck(data, activeCampaigns, "CALL");
    }
    case "structured_snippet_and_callout_assets": {
      const snippetCov = assetCoverageCheck(data, activeCampaigns, "STRUCTURED_SNIPPET");
      const calloutCov = assetCoverageCheck(data, activeCampaigns, "CALLOUT");
      if (snippetCov.status === "not_applicable" && calloutCov.status === "not_applicable") {
        return notApplicable();
      }
      const worst = [snippetCov, calloutCov].sort(
        (a, b) => (a.score ?? 100) - (b.score ?? 100),
      )[0];
      return worst;
    }
    case "location_assets_present": {
      return assetCoverageCheck(data, activeCampaigns, "LOCATION");
    }
    case "legal_certification_status": {
      // Not exposed via GAQL today — surfaced as N/A until a dedicated
      // certification-status data source is wired (follow-on task).
      return notApplicable();
    }
    case "policy_topic_warnings": {
      const warnings = data.policyTopics.filter((p) => p.type === "WARNING");
      const status: AuditCheckStatus = warnings.length === 0 ? "good" : "bad";
      return discrete(status, `${warnings.length} active warning(s)`, []);
    }
    case "trademark_complaint_exposure": {
      // Not exposed via GAQL today — surfaced as N/A until a dedicated
      // trademark-complaint data source is wired (follow-on task).
      return notApplicable();
    }
    case "optimization_score_value": {
      if (data.optimizationScore == null) return notApplicable();
      return continuous(
        check,
        data.optimizationScore,
        `${(data.optimizationScore * 100).toFixed(0)}%`,
        data.optimizationScore,
        [],
      );
    }
    case "high_impact_recommendations_open": {
      const count = data.openRecommendations.length;
      return continuous(check, count, `${count} open recommendation(s)`, count, []);
    }
    case "campaign_count_reasonable": {
      // Foundation heuristic: flag only the extreme case of a single
      // campaign carrying every ad group (likely bundling unrelated
      // practice areas). Finer practice-area mapping needs client-side
      // metadata this task doesn't have — N/A when there's too little
      // signal to judge.
      if (activeCampaigns.length === 0) return notApplicable();
      const status: AuditCheckStatus = activeCampaigns.length === 1 ? "okay" : "good";
      return discrete(status, `${activeCampaigns.length} active campaign(s)`, []);
    }
    case "ad_group_theming": {
      const counts = buildAdGroupCounts(data.keywords, data.ads).filter((c) => c.keywordCount > 0);
      if (counts.length === 0) return notApplicable();
      const avg = counts.reduce((s, c) => s + c.keywordCount, 0) / counts.length;
      const loose = counts.filter((c) => c.keywordCount >= 20);
      return continuous(
        check,
        avg,
        `avg ${avg.toFixed(0)} keywords/ad group`,
        avg,
        campaignNames(Array.from(new Set(loose.map((c) => c.campaignId)))),
      );
    }
    case "audience_signals_attached": {
      const missing = activeCampaigns.filter((c) => !data.audienceCampaignIds.has(c.campaignId));
      if (activeCampaigns.length === 0) return notApplicable();
      const status: AuditCheckStatus = missing.length === 0 ? "good" : "okay";
      return discrete(
        status,
        `${activeCampaigns.length - missing.length} of ${activeCampaigns.length} campaigns have audience signals`,
        missing.map((c) => c.campaignName || c.campaignId),
      );
    }
    case "network_settings_scoped": {
      const expanded = activeCampaigns.filter(
        (c) => c.networkSettingsContentNetwork,
      );
      const status: AuditCheckStatus = expanded.length === 0 ? "good" : "okay";
      return discrete(
        status,
        `${expanded.length} campaign(s) opted into Display Expansion`,
        expanded.map((c) => c.campaignName || c.campaignId),
      );
    }
    default:
      return notApplicable();
  }
}

function assetCoverageCheck(
  data: AuditDataBundle,
  activeCampaigns: AuditDataBundle["campaigns"],
  assetType: string,
): CheckEvalResult {
  if (activeCampaigns.length === 0) return notApplicable();
  const withAsset = new Set(
    data.assetLinks.filter((a) => a.assetType === assetType && a.campaignId).map((a) => a.campaignId as string),
  );
  const missing = activeCampaigns.filter((c) => !withAsset.has(c.campaignId));
  const status: AuditCheckStatus = missing.length === 0 ? "good" : missing.length === activeCampaigns.length ? "critical" : "bad";
  return discrete(
    status,
    `${activeCampaigns.length - missing.length} of ${activeCampaigns.length} campaigns have ${assetType.toLowerCase()} assets`,
    missing.map((c) => c.campaignName || c.campaignId),
  );
}

function notApplicable(): CheckEvalResult {
  return { status: "not_applicable", score: null, measuredValue: null, measuredNumeric: null, affectedEntities: [] };
}

function discrete(
  status: AuditCheckStatus,
  measuredValue: string | null,
  affectedEntities: string[],
): CheckEvalResult {
  const score = status === "not_applicable" ? null : DISCRETE_STATUS_SCORE[status as "good" | "okay" | "bad" | "critical"];
  return { status, score, measuredValue, measuredNumeric: null, affectedEntities };
}

function continuous(
  check: AuditCheckDef,
  rawValue: number,
  measuredValue: string,
  measuredNumeric: number,
  affectedEntities: string[],
): CheckEvalResult {
  const bands = check.bands!;
  const { status, score } = bandFor(rawValue, bands);
  return { status, score, measuredValue, measuredNumeric, affectedEntities };
}

export interface AuditReportCheck {
  checkId: string;
  categoryId: string;
  label: string;
  status: AuditCheckStatus;
  score: number | null;
  weight: number;
  measuredValue: string | null;
  affectedEntities: string[];
  recommendedFix: string | null;
  isGate: string | null;
  impactRank: number;
}

/**
 * Ranks checks by impact so the report surfaces the most important problems
 * first: lowest score first (worst issues), tie-broken by highest
 * category-weight * check-weight (bigger blind spots first), with
 * `not_applicable` checks (score === null) always pushed to the end since
 * they represent nothing actionable.
 */
function rankByImpact<T extends { score: number | null; weight: number; categoryId: string }>(
  checks: T[],
): (T & { impactRank: number })[] {
  const categoryWeight = new Map(CHECK_CATEGORIES.map((c) => [c.id, c.weight]));
  const sorted = [...checks].sort((a, b) => {
    if (a.score == null && b.score == null) return 0;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    if (a.score !== b.score) return a.score - b.score;
    const aPriority = a.weight * (categoryWeight.get(a.categoryId) ?? 0);
    const bPriority = b.weight * (categoryWeight.get(b.categoryId) ?? 0);
    return bPriority - aPriority;
  });
  return sorted.map((c, idx) => ({ ...c, impactRank: idx + 1 }));
}

export interface AuditReport {
  runId: string;
  customerId: string;
  scoreH: number;
  scoreHFinal: number;
  categoryScores: Record<string, number | null>;
  triggeredGates: { id: string; label: string; capAt: number; explanation: string }[];
  checks: AuditReportCheck[];
}

function fillFixTemplate(check: AuditCheckDef, result: CheckEvalResult): string | null {
  if (result.status === "good" || result.status === "not_applicable") return null;
  return check.fixTemplate
    .replace("{entities}", result.affectedEntities.length > 0 ? result.affectedEntities.slice(0, 3).join(", ") : "the affected campaigns")
    .replace("{measuredValue}", result.measuredValue ?? "the flagged amount");
}

export async function runGoogleAdsAudit(
  customerId: string,
  opts: { lookbackDays?: number; triggeredBy?: string | null } = {},
): Promise<AuditReport> {
  const lookbackDays = opts.lookbackDays ?? 30;
  const run = await createGoogleAdsAuditRun({
    customerId,
    status: "running",
    triggeredBy: opts.triggeredBy ?? null,
    metadata: { lookbackDays },
  });

  try {
    const data = await fetchAuditData(customerId, lookbackDays);

    const evaluations = AUDIT_CHECKS.map((check) => ({
      check,
      result: evalCheck(check, data),
    }));

    // Category sub-scores: weighted average over applicable checks only,
    // renormalized so a category with some N/A checks isn't penalized.
    const categoryScores: Record<string, number | null> = {};
    for (const cat of CHECK_CATEGORIES) {
      const inCat = evaluations.filter((e) => e.check.categoryId === cat.id && e.result.score != null);
      if (inCat.length === 0) {
        categoryScores[cat.id] = null;
        continue;
      }
      const totalWeight = inCat.reduce((s, e) => s + e.check.weight, 0) || 1;
      const weighted = inCat.reduce((s, e) => s + (e.result.score as number) * e.check.weight, 0);
      categoryScores[cat.id] = weighted / totalWeight;
    }

    const applicableCats = CHECK_CATEGORIES.filter((c) => categoryScores[c.id] != null);
    const totalCatWeight = applicableCats.reduce((s, c) => s + c.weight, 0) || 1;
    const scoreH =
      applicableCats.reduce((s, c) => s + (categoryScores[c.id] as number) * c.weight, 0) / totalCatWeight;

    const triggeredGates = AUDIT_GATES.filter((gate) =>
      gate.triggerCheckIds.some((checkId) => {
        const ev = evaluations.find((e) => e.check.id === checkId);
        return ev?.result.status === "critical";
      }),
    );
    const scoreHFinal =
      triggeredGates.length === 0
        ? scoreH
        : Math.min(scoreH, ...triggeredGates.map((g) => g.capAt));

    const checkResults: InsertGoogleAdsAuditCheckResult[] = evaluations.map(({ check, result }) => ({
      runId: run.id,
      checkId: check.id,
      categoryId: check.categoryId,
      status: result.status,
      score: result.score,
      weight: check.weight,
      measuredValue: result.measuredValue,
      measuredNumeric: result.measuredNumeric,
      affectedEntities: result.affectedEntities,
      recommendedFix: fillFixTemplate(check, result),
      isGate: check.gateId ?? null,
    }));
    await insertGoogleAdsAuditCheckResults(checkResults);

    await updateGoogleAdsAuditRun(run.id, {
      status: "completed",
      finishedAt: new Date(),
      scoreH,
      scoreHFinal,
      categoryScores,
      triggeredGates: triggeredGates.map((g) => ({ id: g.id, label: g.label, capAt: g.capAt, explanation: g.explanation })),
    });

    // Rank checks by impact (worst score + biggest weighted blind spot
    // first) so the report surfaces the highest-priority problems first,
    // per the audit's ranked-report requirement.
    const rankedChecks = rankByImpact(
      evaluations.map(({ check, result }) => ({
        checkId: check.id,
        categoryId: check.categoryId,
        label: check.label,
        status: result.status,
        score: result.score,
        weight: check.weight,
        measuredValue: result.measuredValue,
        affectedEntities: result.affectedEntities,
        recommendedFix: fillFixTemplate(check, result),
        isGate: check.gateId ?? null,
      })),
    );

    return {
      runId: run.id,
      customerId,
      scoreH,
      scoreHFinal,
      categoryScores,
      triggeredGates: triggeredGates.map((g) => ({ id: g.id, label: g.label, capAt: g.capAt, explanation: g.explanation })),
      checks: rankedChecks,
    };
  } catch (err: any) {
    await updateGoogleAdsAuditRun(run.id, {
      status: "failed",
      finishedAt: new Date(),
      error: err?.message ?? String(err),
    });
    throw err;
  }
}

const VALID_CHECK_STATUSES: ReadonlySet<string> = new Set<AuditCheckStatus>([
  "good", "okay", "bad", "critical", "not_applicable",
]);

/** Runtime-safe parse of a persisted status string; unknown values degrade to "not_applicable". */
function parseCheckStatus(value: string): AuditCheckStatus {
  return VALID_CHECK_STATUSES.has(value) ? (value as AuditCheckStatus) : "not_applicable";
}

/** Runtime-safe parse of a persisted jsonb string array. */
function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Runtime-safe parse of the persisted categoryScores jsonb object. */
function parseCategoryScores(value: unknown): Record<string, number | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" || v === null) out[k] = v;
  }
  return out;
}

/** Runtime-safe parse of the persisted triggeredGates jsonb array. */
function parseTriggeredGates(value: unknown): AuditReport["triggeredGates"] {
  if (!Array.isArray(value)) return [];
  const gates: AuditReport["triggeredGates"] = [];
  for (const g of value) {
    if (typeof g !== "object" || g === null) continue;
    const gate = g as Record<string, unknown>;
    if (
      typeof gate.id === "string" &&
      typeof gate.label === "string" &&
      typeof gate.capAt === "number" &&
      typeof gate.explanation === "string"
    ) {
      gates.push({ id: gate.id, label: gate.label, capAt: gate.capAt, explanation: gate.explanation });
    }
  }
  return gates;
}

export function buildAuditReportFromRun(
  run: { id: string; customerId: string; scoreH: number | null; scoreHFinal: number | null; categoryScores: unknown; triggeredGates: unknown },
  checkRows: { checkId: string; categoryId: string; status: string; score: number | null; weight: number; measuredValue: string | null; affectedEntities: unknown; recommendedFix: string | null; isGate: string | null }[],
): Promise<AuditReport> {
  const labelFor = (checkId: string) => AUDIT_CHECKS.find((c) => c.id === checkId)?.label ?? checkId;
  const rankedChecks = rankByImpact(
    checkRows.map((r) => ({
      checkId: r.checkId,
      categoryId: r.categoryId,
      label: labelFor(r.checkId),
      status: parseCheckStatus(r.status),
      score: r.score,
      weight: r.weight,
      measuredValue: r.measuredValue,
      affectedEntities: parseStringArray(r.affectedEntities),
      recommendedFix: r.recommendedFix,
      isGate: r.isGate,
    })),
  );
  return Promise.resolve({
    runId: run.id,
    customerId: run.customerId,
    scoreH: run.scoreH ?? 0,
    scoreHFinal: run.scoreHFinal ?? 0,
    categoryScores: parseCategoryScores(run.categoryScores),
    triggeredGates: parseTriggeredGates(run.triggeredGates),
    checks: rankedChecks,
  });
}
