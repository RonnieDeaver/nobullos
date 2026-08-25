/**
 * Task #2784 — Google Ads Hygiene Audit read-only GAQL data fetch layer.
 *
 * Extends `googleAdsIntegration.ts`'s `gaqlSearchStream` with the
 * additional queries the audit checklist needs. Every field path below
 * was checked against the live Google Ads API field reference for the
 * API version this codebase runs
 * (`https://developers.google.com/google-ads/api/fields/{version}/...`,
 * confirmed for v23 during this task) before use, per the project's
 * public-API-documentation rule — field names are version-sensitive and
 * do drift release to release (see the Task #2508 GAQL regressions this
 * repo already hit once).
 *
 * All queries are plain `SELECT ... FROM <resource>` GAQL — no mutations,
 * matching the source app's read-only design and this task's explicit
 * "no write-back" scope.
 */

import { gaqlSearchStream } from "./googleAdsIntegration";

function toNumber(v: any): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

export interface AccountStatusRow {
  descriptiveName: string | null;
  status: string | null;
}

export async function fetchAccountStatus(
  customerId: string,
): Promise<AccountStatusRow | null> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT customer.descriptive_name, customer.status FROM customer LIMIT 1`,
  );
  const c = rows[0]?.customer;
  if (!c) return null;
  return { descriptiveName: c.descriptiveName ?? null, status: c.status ?? null };
}

// ---------------------------------------------------------------------------
// Optimization score (customer resource field)
// ---------------------------------------------------------------------------

export async function fetchOptimizationScore(
  customerId: string,
): Promise<number | null> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT customer.optimization_score FROM customer LIMIT 1`,
  );
  const score = rows[0]?.customer?.optimizationScore;
  return score != null ? toNumber(score) : null;
}

// ---------------------------------------------------------------------------
// Recommendations (open, non-dismissed)
// ---------------------------------------------------------------------------

export interface OpenRecommendation {
  type: string | null;
  campaignId: string | null;
  dismissed: boolean;
}

/**
 * `recommendation` is a queryable GAQL resource. It does not expose a
 * discrete HIGH/MEDIUM/LOW impact enum field, so this audit treats every
 * non-dismissed recommendation as "open" and lets the checklist band
 * thresholds (see googleAdsAuditChecks.ts) do the severity judgement by
 * count rather than by a Google-assigned priority label.
 */
export async function fetchOpenRecommendations(
  customerId: string,
): Promise<OpenRecommendation[]> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT recommendation.type, recommendation.campaign, recommendation.dismissed
     FROM recommendation
     WHERE recommendation.dismissed = FALSE`,
  );
  return rows.map((r) => ({
    type: r?.recommendation?.type ?? null,
    campaignId: r?.recommendation?.campaign
      ? String(r.recommendation.campaign).replace(/^customers\/\d+\/campaigns\//, "")
      : null,
    dismissed: !!r?.recommendation?.dismissed,
  }));
}

// ---------------------------------------------------------------------------
// Campaign-level criteria: geo targeting, language, network settings,
// bidding strategy, budget + impression-share-loss metrics
// ---------------------------------------------------------------------------

export interface CampaignAuditRow {
  campaignId: string;
  campaignName: string | null;
  status: string | null;
  biddingStrategyType: string | null;
  networkSettingsSearchPartners: boolean;
  networkSettingsContentNetwork: boolean;
  budgetMicros: number;
  costMicros: number;
  searchImpressionShare: number | null;
  searchBudgetLostImpressionShare: number | null;
  searchRankLostImpressionShare: number | null;
}

export async function fetchCampaignAuditRows(
  customerId: string,
  dateFilter: string,
): Promise<CampaignAuditRow[]> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT
       campaign.id,
       campaign.name,
       campaign.status,
       campaign.bidding_strategy_type,
       campaign.network_settings.target_search_network,
       campaign.network_settings.target_content_network,
       campaign_budget.amount_micros,
       metrics.cost_micros,
       metrics.search_impression_share,
       metrics.search_budget_lost_impression_share,
       metrics.search_rank_lost_impression_share
     FROM campaign
     WHERE campaign.status = 'ENABLED' AND ${dateFilter}`,
  );
  const byCampaign = new Map<string, CampaignAuditRow>();
  for (const row of rows) {
    const c = row?.campaign;
    const b = row?.campaignBudget;
    const m = row?.metrics;
    if (!c?.id) continue;
    const id = String(c.id);
    const existing = byCampaign.get(id);
    const costMicros = toNumber(m?.costMicros);
    if (!existing) {
      byCampaign.set(id, {
        campaignId: id,
        campaignName: c.name ?? null,
        status: c.status ?? null,
        biddingStrategyType: c.biddingStrategyType ?? null,
        networkSettingsSearchPartners: !!c.networkSettings?.targetSearchNetwork,
        networkSettingsContentNetwork: !!c.networkSettings?.targetContentNetwork,
        budgetMicros: toNumber(b?.amountMicros),
        costMicros,
        searchImpressionShare: m?.searchImpressionShare != null ? toNumber(m.searchImpressionShare) : null,
        searchBudgetLostImpressionShare:
          m?.searchBudgetLostImpressionShare != null ? toNumber(m.searchBudgetLostImpressionShare) : null,
        searchRankLostImpressionShare:
          m?.searchRankLostImpressionShare != null ? toNumber(m.searchRankLostImpressionShare) : null,
      });
    } else {
      existing.costMicros += costMicros;
    }
  }
  return Array.from(byCampaign.values());
}

// ---------------------------------------------------------------------------
// Geo + language criteria per campaign
// ---------------------------------------------------------------------------

export interface CampaignGeoRow {
  campaignId: string;
  locationCount: number;
  presenceOnly: boolean | null; // null = mixed/unknown
  languageCount: number;
}

export async function fetchCampaignGeoAndLanguage(
  customerId: string,
): Promise<CampaignGeoRow[]> {
  const geoRows = await gaqlSearchStream(
    customerId,
    `SELECT
       campaign.id,
       campaign_criterion.type,
       campaign_criterion.location.geo_target_constant,
       campaign_criterion.negative
     FROM campaign_criterion
     WHERE campaign_criterion.type = 'LOCATION' AND campaign_criterion.negative = FALSE`,
  );
  const geoByCampaign = new Map<string, number>();
  for (const row of geoRows) {
    const id = row?.campaign?.id ? String(row.campaign.id) : null;
    if (!id) continue;
    geoByCampaign.set(id, (geoByCampaign.get(id) ?? 0) + 1);
  }

  const langRows = await gaqlSearchStream(
    customerId,
    `SELECT campaign.id, campaign_criterion.type, campaign_criterion.language.language_constant
     FROM campaign_criterion
     WHERE campaign_criterion.type = 'LANGUAGE'`,
  );
  const langByCampaign = new Map<string, number>();
  for (const row of langRows) {
    const id = row?.campaign?.id ? String(row.campaign.id) : null;
    if (!id) continue;
    langByCampaign.set(id, (langByCampaign.get(id) ?? 0) + 1);
  }

  // `campaign.geo_target_type_setting.positive_geo_target_type` carries
  // the PRESENCE vs PRESENCE_OR_INTEREST setting.
  const settingRows = await gaqlSearchStream(
    customerId,
    `SELECT campaign.id, campaign.geo_target_type_setting.positive_geo_target_type
     FROM campaign
     WHERE campaign.status = 'ENABLED'`,
  );
  const presenceByCampaign = new Map<string, boolean>();
  for (const row of settingRows) {
    const id = row?.campaign?.id ? String(row.campaign.id) : null;
    if (!id) continue;
    const setting = row?.campaign?.geoTargetTypeSetting?.positiveGeoTargetType;
    presenceByCampaign.set(id, setting === "PRESENCE");
  }

  const campaignIds = new Set<string>([
    ...geoByCampaign.keys(),
    ...langByCampaign.keys(),
    ...presenceByCampaign.keys(),
  ]);
  return Array.from(campaignIds).map((id) => ({
    campaignId: id,
    locationCount: geoByCampaign.get(id) ?? 0,
    presenceOnly: presenceByCampaign.has(id) ? presenceByCampaign.get(id)! : null,
    languageCount: langByCampaign.get(id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Shared negative keyword sets
// ---------------------------------------------------------------------------

export async function fetchSharedNegativeKeywordSetCount(
  customerId: string,
): Promise<number> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT shared_set.id FROM shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`,
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Search terms (irrelevance rate proxy: terms with zero conversions and
// zero clicks relative to spend is out of scope for a heuristic law-firm
// relevance test, so this surfaces raw search-term rows for the engine to
// classify against a simple legal-relevance keyword allowlist).
// ---------------------------------------------------------------------------

export interface SearchTermRow {
  searchTerm: string;
  costMicros: number;
  campaignId: string;
}

export async function fetchSearchTerms(
  customerId: string,
  dateFilter: string,
): Promise<SearchTermRow[]> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT search_term_view.search_term, campaign.id, metrics.cost_micros
     FROM search_term_view
     WHERE ${dateFilter}`,
  );
  return rows
    .filter((r) => r?.searchTermView?.searchTerm)
    .map((r) => ({
      searchTerm: String(r.searchTermView.searchTerm),
      costMicros: toNumber(r?.metrics?.costMicros),
      campaignId: r?.campaign?.id ? String(r.campaign.id) : "",
    }));
}

// ---------------------------------------------------------------------------
// Keyword view: match type + quality score (impression-weighted)
// ---------------------------------------------------------------------------

export interface KeywordAuditRow {
  campaignId: string;
  adGroupId: string;
  matchType: string | null;
  qualityScore: number | null;
  impressions: number;
}

export async function fetchKeywordAuditRows(
  customerId: string,
  dateFilter: string,
): Promise<KeywordAuditRow[]> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT
       campaign.id,
       ad_group.id,
       ad_group_criterion.keyword.match_type,
       ad_group_criterion.quality_info.quality_score,
       ad_group_criterion.status,
       metrics.impressions
     FROM keyword_view
     WHERE ad_group_criterion.status = 'ENABLED' AND ${dateFilter}`,
  );
  return rows
    .filter((r) => r?.campaign?.id && r?.adGroup?.id)
    .map((r) => ({
      campaignId: String(r.campaign.id),
      adGroupId: String(r.adGroup.id),
      matchType: r?.adGroupCriterion?.keyword?.matchType ?? null,
      qualityScore:
        r?.adGroupCriterion?.qualityInfo?.qualityScore != null
          ? Number(r.adGroupCriterion.qualityInfo.qualityScore)
          : null,
      impressions: toNumber(r?.metrics?.impressions),
    }));
}

// ---------------------------------------------------------------------------
// Ads: approval status, ad strength, ads-per-ad-group
// ---------------------------------------------------------------------------

export interface AdAuditRow {
  adGroupId: string;
  campaignId: string;
  status: string | null;
  approvalStatus: string | null;
  adStrength: string | null; // RSA-only
  type: string | null;
}

export async function fetchAdAuditRows(customerId: string): Promise<AdAuditRow[]> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT
       campaign.id,
       ad_group.id,
       ad_group_ad.status,
       ad_group_ad.policy_summary.approval_status,
       ad_group_ad.ad_strength,
       ad_group_ad.ad.type
     FROM ad_group_ad
     WHERE ad_group_ad.status = 'ENABLED'`,
  );
  return rows
    .filter((r) => r?.adGroup?.id && r?.campaign?.id)
    .map((r) => ({
      adGroupId: String(r.adGroup.id),
      campaignId: String(r.campaign.id),
      status: r?.adGroupAd?.status ?? null,
      approvalStatus: r?.adGroupAd?.policySummary?.approvalStatus ?? null,
      adStrength: r?.adGroupAd?.adStrength ?? null,
      type: r?.adGroupAd?.ad?.type ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Assets: customer/campaign asset links (sitelink, call, callout,
// structured snippet, location) + policy summary
// ---------------------------------------------------------------------------

export interface AssetLinkRow {
  campaignId: string | null;
  assetType: string | null;
  policyApprovalStatus: string | null;
}

export async function fetchCampaignAssetLinks(
  customerId: string,
): Promise<AssetLinkRow[]> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT
       campaign.id,
       campaign_asset.asset,
       campaign_asset.field_type,
       campaign_asset.status,
       asset.type,
       asset.policy_summary.approval_status
     FROM campaign_asset
     WHERE campaign_asset.status = 'ENABLED'`,
  );
  return rows.map((r) => ({
    campaignId: r?.campaign?.id ? String(r.campaign.id) : null,
    assetType: r?.campaignAsset?.fieldType ?? r?.asset?.type ?? null,
    policyApprovalStatus: r?.asset?.policySummary?.approvalStatus ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Policy: account-level policy topic warnings surfaced via ad + asset
// policy summaries (Google Ads has no separate "policy manager" GAQL
// resource; disapprovals/warnings are read off the entity's own
// `policy_summary.policy_topic_entries`).
// ---------------------------------------------------------------------------

export interface PolicyTopicRow {
  entity: "ad" | "asset";
  topic: string | null;
  type: string | null; // policy topic entry type, e.g. WARNING / DISAPPROVAL
}

export async function fetchAdPolicyTopics(customerId: string): Promise<PolicyTopicRow[]> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT ad_group_ad.policy_summary.policy_topic_entries
     FROM ad_group_ad
     WHERE ad_group_ad.status = 'ENABLED'`,
  );
  const out: PolicyTopicRow[] = [];
  for (const r of rows) {
    const entries = r?.adGroupAd?.policySummary?.policyTopicEntries;
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      out.push({ entity: "ad", topic: e?.topic ?? null, type: e?.type ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audience signals attached to campaigns
// ---------------------------------------------------------------------------

export async function fetchCampaignsWithAudienceSignals(
  customerId: string,
): Promise<Set<string>> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT campaign.id, campaign_criterion.type
     FROM campaign_criterion
     WHERE campaign_criterion.type IN ('AUDIENCE', 'USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE')
       AND campaign_criterion.negative = FALSE`,
  );
  const set = new Set<string>();
  for (const r of rows) {
    if (r?.campaign?.id) set.add(String(r.campaign.id));
  }
  return set;
}

// ---------------------------------------------------------------------------
// Conversion actions (for the conversion-tracking-present gate)
// ---------------------------------------------------------------------------

export async function fetchConversionCount(
  customerId: string,
  dateFilter: string,
): Promise<number> {
  const rows = await gaqlSearchStream(
    customerId,
    `SELECT metrics.conversions FROM customer WHERE ${dateFilter}`,
  );
  return rows.reduce((sum, r) => sum + toNumber(r?.metrics?.conversions), 0);
}

// ---------------------------------------------------------------------------
// Ad group -> keyword counts (theming) and ad counts (per-ad-group)
// ---------------------------------------------------------------------------

export interface AdGroupCountsRow {
  adGroupId: string;
  campaignId: string;
  keywordCount: number;
  enabledAdCount: number;
}

export function buildAdGroupCounts(
  keywordRows: KeywordAuditRow[],
  adRows: AdAuditRow[],
): AdGroupCountsRow[] {
  const map = new Map<string, AdGroupCountsRow>();
  for (const k of keywordRows) {
    const row = map.get(k.adGroupId) ?? {
      adGroupId: k.adGroupId,
      campaignId: k.campaignId,
      keywordCount: 0,
      enabledAdCount: 0,
    };
    row.keywordCount++;
    map.set(k.adGroupId, row);
  }
  for (const a of adRows) {
    if (a.status !== "ENABLED") continue;
    const row = map.get(a.adGroupId) ?? {
      adGroupId: a.adGroupId,
      campaignId: a.campaignId,
      keywordCount: 0,
      enabledAdCount: 0,
    };
    row.enabledAdCount++;
    map.set(a.adGroupId, row);
  }
  return Array.from(map.values());
}
