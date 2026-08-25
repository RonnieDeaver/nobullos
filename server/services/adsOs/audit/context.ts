/**
 * Ads OS — audit shared-query layer (port of backend/app/audit/context.py).
 *
 * Pulls every dataset the checks need ONCE per audit and hands it to the check
 * modules via an AuditContext. This is the rate-limit / efficiency discipline —
 * no one-query-per-check.
 *
 * Each dataset is pulled through a per-query isolator: a failing query (bad
 * field path, or an account the MCC token can't fully read) becomes a recorded
 * warning instead of sinking the whole audit. Checks whose dataset failed simply
 * see empty data and return N/A. This doubles as the hardening for
 * partial-access accounts.
 *
 * All queries are read-only searchStream. Audits consider the
 * NBM_GADS_MONITOR_CAMPAIGN labeled campaigns that are ENABLED or have spent in
 * the last 7 days (paused-but-recently-active campaigns are included; dormant
 * paused ones are skipped) — every other dataset is dropped unless its campaign
 * is in `ctx.campaigns`, so restricting that set scopes the whole audit (we
 * never flag an issue on an unlabeled campaign). Ad-group / ad / keyword
 * queries stay ENABLED-only, so only live ad groups and ads are scanned even
 * inside a paused-but-recently-spent campaign.
 *
 * GAQL fields validated against the v24 reference (see ADS_OS.md). REST rows
 * come back camelCase with enums as plain strings and int64 metrics as strings.
 */

import { KI_CAMPAIGN_LABEL } from "../config";
import { addDays, isoDate, plainToday } from "../dateRange";
import { escGaql } from "../enrollment";
import { AdsOsCredsMissing, adsOsGaqlSearch } from "../googleAdsClient";
import { mapPool } from "../singleflight";

// ----------------------------- row types -----------------------------

export interface CampaignRow {
  id: string;
  name: string;
  channel_type: string;
  bidding_strategy_type: string;
  primary_status: string;
  primary_status_reasons: string[];
  positive_geo_target_type: string;
  budget_micros: number;
  optimization_score: number;
  target_cpa_micros: number;
  // network settings
  net_search: boolean;
  net_search_partners: boolean;
  net_content: boolean;
  // criteria presence
  has_positive_location: boolean;
  has_negative_location: boolean;
  has_language: boolean;
  has_ad_schedule: boolean;
  has_audience: boolean;
  has_negative_keyword_list: boolean;
  campaign_neg_count: number; // campaign-level negative keywords
  adgroup_neg_count: number; // total ad-group-level negative keywords in this campaign
  // metrics (lookback window)
  impressions: number;
  cost_micros: number;
  conversions: number;
  cost_per_conversion_micros: number;
  budget_lost_is: number;
  rank_lost_is: number;
}

function newCampaignRow(init: Partial<CampaignRow> & { id: string; name: string }): CampaignRow {
  return {
    channel_type: "",
    bidding_strategy_type: "",
    primary_status: "",
    primary_status_reasons: [],
    positive_geo_target_type: "",
    budget_micros: 0,
    optimization_score: 0,
    target_cpa_micros: 0,
    net_search: false,
    net_search_partners: false,
    net_content: false,
    has_positive_location: false,
    has_negative_location: false,
    has_language: false,
    has_ad_schedule: false,
    has_audience: false,
    has_negative_keyword_list: false,
    campaign_neg_count: 0,
    adgroup_neg_count: 0,
    impressions: 0,
    cost_micros: 0,
    conversions: 0,
    cost_per_conversion_micros: 0,
    budget_lost_is: 0,
    rank_lost_is: 0,
    ...init,
  };
}

export interface AdRow {
  ad_id: string;
  ad_group_id: string;
  campaign_id: string;
  ad_type: string;
  ad_strength: string;
  approval_status: string;
  is_rsa: boolean;
  headline_count: number;
  description_count: number;
  pinned_count: number;
  has_final_url: boolean;
}

export interface KeywordRow {
  campaign_id: string;
  ad_group_id: string;
  text: string;
  match_type: string;
  quality_score: number; // 1-10, 0 if none
  qs_below_average: number; // count of BELOW_AVERAGE components (0-3)
  qs_components: number; // components with a rating (for ratio denom)
  // individual QS component ratings (ABOVE_AVERAGE / AVERAGE / BELOW_AVERAGE / "")
  ad_relevance: string; // creative_quality_score
  landing_page: string; // post_click_quality_score
  expected_ctr: string; // search_predicted_ctr
}

export class AuditContext {
  customer_id: string;
  account_name: string;
  currency_code: string | null;
  lookback_days: number;
  start_date: string;
  end_date: string;

  customer_status = "";
  customer_optimization_score = 0;

  campaigns = new Map<string, CampaignRow>();
  ad_group_ids_by_campaign = new Map<string, Set<string>>();
  enabled_ad_group_ids = new Set<string>();
  serving_ad_group_ids = new Set<string>(); // enabled ad groups with >=1 enabled ad
  ad_group_campaign = new Map<string, string>();
  ad_group_names = new Map<string, string>();
  ads: AdRow[] = [];
  keywords: KeywordRow[] = [];

  // asset field_type -> count
  account_assets = new Map<string, number>();
  campaign_assets = new Map<string, Map<string, number>>();
  ad_group_assets = new Map<string, Map<string, number>>(); // ad_group_id -> {field_type: count}
  // [campaign_id, field_type, primary_status] for limited/disapproved asset links
  limited_assets: Array<[string, string, string]> = [];
  account_location_assets = 0; // assets with asset.type = LOCATION (account-wide)

  recommendation_types: string[] = [];
  recommendations_available = false; // query succeeded?

  /**
   * True when the campaign-label query succeeded and the labeled set resolved
   * to ZERO scannable campaigns (all paused/ended/dormant). The account is
   * intentionally inactive — the engine reports band "Inactive" instead of a
   * 0/Critical score. Never set for partial-access accounts (labeled set
   * unknown) — those keep the ENABLED-campaign safety net.
   */
  scope_empty = false;

  warnings: string[] = [];

  constructor(init: {
    customer_id: string;
    account_name: string;
    currency_code: string | null;
    lookback_days: number;
    start_date: string;
    end_date: string;
  }) {
    this.customer_id = init.customer_id;
    this.account_name = init.account_name;
    this.currency_code = init.currency_code;
    this.lookback_days = init.lookback_days;
    this.start_date = init.start_date;
    this.end_date = init.end_date;
  }

  campaignName(cid: string): string {
    return this.campaigns.get(cid)?.name ?? cid;
  }

  adGroupName(agid: string): string {
    return this.ad_group_names.get(agid) ?? `Ad group ${agid}`;
  }
}

// ----------------------------- helpers -----------------------------

function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function estr(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** REST AdTextAsset: pinnedField is absent unless the asset is pinned. */
function isPinned(asset: any): boolean {
  const name = estr(asset?.pinnedField);
  return name !== "" && name !== "UNSPECIFIED" && name !== "UNKNOWN";
}

/**
 * Of the labeled campaigns, the ones worth scanning by the hygiene audit: a
 * campaign is IN if it is currently ENABLED (serving) OR it spent something in
 * the last `spendLookbackDays` (7 by default). A campaign that is
 * paused/removed AND has not spent in that window is DROPPED (dormant —
 * nothing to act on). ENDED campaigns (terminal experiments/trials that still
 * read status ENABLED but no longer serve) are always dropped.
 *
 * Note: this gates which *campaigns* are in scope. Ad-group / ad / keyword
 * scoping stays ENABLED-only in the callers — we still only scan live ad
 * groups and ads, even inside a paused-but-recently-spent campaign.
 *
 * Read-only. Best-effort: on any Ads API error it falls back to the full
 * `labeledIds` so a transient failure widens (never silently empties) the
 * scope. (Port of keyword_intel/queries.py scannable_campaign_ids.)
 */
export async function scannableCampaignIds(
  customerId: string,
  labeledIds: string[],
  spendLookbackDays = 7,
): Promise<string[]> {
  if (!labeledIds.length) return [];
  const cid = customerId.replace(/-/g, "").trim();
  const campIn = `campaign.id IN (${labeledIds.join(", ")})`;
  const end = addDays(plainToday(), -1); // through yesterday (complete days only)
  const start = addDays(end, -(spendLookbackDays - 1));
  const status = new Map<string, string>();
  const ended = new Set<string>();
  const spent = new Set<string>();
  try {
    // Status for every labeled campaign (no date segment -> all rows returned,
    // including zero-activity ones). primary_status flags ENDED experiments.
    for (const r of await adsOsGaqlSearch(
      cid,
      `SELECT campaign.id, campaign.status, campaign.primary_status FROM campaign WHERE ${campIn}`,
    )) {
      const gid = estr(r.campaign?.id);
      status.set(gid, estr(r.campaign?.status));
      if (estr(r.campaign?.primaryStatus) === "ENDED") ended.add(gid);
    }
    // Spend over the window (date-segmented -> only campaigns with activity appear).
    for (const r of await adsOsGaqlSearch(
      cid,
      `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE ${campIn} ` +
        `AND segments.date BETWEEN '${isoDate(start)}' AND '${isoDate(end)}'`,
    )) {
      if (num(r.metrics?.costMicros) > 0) spent.add(estr(r.campaign?.id));
    }
  } catch (err) {
    if (err instanceof AdsOsCredsMissing) throw err;
    return [...labeledIds]; // never silently empty the scope on a transient error
  }
  return labeledIds.filter(
    (c) => !ended.has(c) && (status.get(c) === "ENABLED" || spent.has(c)),
  );
}

/**
 * Run all dataset queries concurrently and return {label: rows}.
 *
 * The queries are independent GAQL (no query depends on another's results), so
 * they're fetched in parallel — the audit is I/O-bound on the API. Processing
 * of the returned rows stays single-threaded and ordered (campaigns first), so
 * nothing races on the shared context. A failing query is isolated into
 * ctx.warnings and yields an empty list (its checks -> N/A). Missing
 * credentials still propagate — with no token there is nothing to audit.
 */
async function fetchAll(
  customerId: string,
  queries: Record<string, string>,
  ctx: AuditContext,
): Promise<Record<string, any[]>> {
  const entries = Object.entries(queries);
  const results: Record<string, any[]> = {};
  await mapPool(entries, 8, async ([label, query]) => {
    try {
      results[label] = await adsOsGaqlSearch(customerId, query);
    } catch (err) {
      if (err instanceof AdsOsCredsMissing) throw err;
      results[label] = [];
      ctx.warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return results;
}

// ----------------------------- builder -----------------------------

export async function buildContext(
  customerId: string,
  accountName: string,
  currencyCode: string | null,
  lookbackDays: number,
): Promise<AuditContext> {
  const cid = customerId.replace(/-/g, "").trim();
  const end = plainToday();
  const start = addDays(end, -lookbackDays);
  const ctx = new AuditContext({
    customer_id: cid,
    account_name: accountName,
    currency_code: currencyCode,
    lookback_days: lookbackDays,
    start_date: isoDate(start),
    end_date: isoDate(end),
  });
  const dateClause = `segments.date BETWEEN '${ctx.start_date}' AND '${ctx.end_date}'`;

  // Resolve the monitored-campaign scope up front: the labeled campaigns that
  // are ENABLED or spent in the last 7 days (paused-but-recently-active ones
  // included; dormant paused ones dropped). campScope restricts every
  // campaign-scoped query below to that set; the entity-level filters
  // (ad_group / ad_group_ad / ad_group_criterion = ENABLED) are kept, so we
  // still scan only live ad groups and ads — even inside a
  // paused-but-recently-spent campaign.
  const label = escGaql(KI_CAMPAIGN_LABEL);
  let campScope: string;
  let labeledIds: string[] | null = null;
  try {
    const rows = await adsOsGaqlSearch(
      cid,
      `SELECT campaign.id FROM campaign_label WHERE label.name = '${label}'`,
    );
    labeledIds = [];
    for (const r of rows) {
      const id = r.campaign?.id;
      if (id !== undefined && id !== null) labeledIds.push(String(id));
    }
  } catch (err) {
    if (err instanceof AdsOsCredsMissing) throw err;
    labeledIds = null; // label query failed (partial-access account)
  }

  if (labeledIds === null) {
    // Partial-access account (the MCC can't read campaign_label): preserve the
    // prior safety net — audit all currently-enabled campaigns rather than nothing.
    campScope = "campaign.status = 'ENABLED'";
  } else {
    const scannable = await scannableCampaignIds(cid, labeledIds);
    // No scannable labeled campaigns -> match nothing (empty/NA audit); never
    // silently widen to unlabeled campaigns.
    campScope = scannable.length ? `campaign.id IN (${scannable.join(", ")})` : "campaign.id IN (0)";
    ctx.scope_empty = scannable.length === 0;
  }

  // All dataset queries — fetched concurrently, then processed in order below.
  const queries: Record<string, string> = {
    customer: "SELECT customer.status, customer.optimization_score FROM customer LIMIT 1",
    "campaign settings": `
      SELECT
        campaign.id, campaign.name,
        campaign.advertising_channel_type, campaign.bidding_strategy_type,
        campaign.primary_status, campaign.primary_status_reasons,
        campaign.geo_target_type_setting.positive_geo_target_type,
        campaign.optimization_score,
        campaign.network_settings.target_search_network,
        campaign.network_settings.target_content_network,
        campaign.network_settings.target_partner_search_network,
        campaign.maximize_conversions.target_cpa_micros,
        campaign.target_cpa.target_cpa_micros,
        campaign_budget.amount_micros
      FROM campaign WHERE ${campScope}
    `,
    "campaign metrics": `
      SELECT campaign.id, metrics.impressions, metrics.cost_micros,
             metrics.conversions, metrics.cost_per_conversion,
             metrics.search_budget_lost_impression_share,
             metrics.search_rank_lost_impression_share
      FROM campaign WHERE ${campScope} AND ${dateClause}
    `,
    "location criteria": `
      SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative
      FROM campaign_criterion
      WHERE campaign_criterion.type IN ('LOCATION', 'PROXIMITY')
        AND campaign_criterion.status = 'ENABLED'
    `,
    "language/schedule/audience criteria": `
      SELECT campaign.id, campaign_criterion.type
      FROM campaign_criterion
      WHERE campaign_criterion.type IN ('LANGUAGE', 'AD_SCHEDULE', 'USER_LIST')
        AND campaign_criterion.status = 'ENABLED' AND campaign_criterion.negative = FALSE
    `,
    campaign_shared_set: `
      SELECT campaign.id, shared_set.type FROM campaign_shared_set
      WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND campaign_shared_set.status = 'ENABLED'
    `,
    "campaign negatives": `
      SELECT campaign.id, campaign_criterion.criterion_id FROM campaign_criterion
      WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE
    `,
    "ad group negatives": `
      SELECT campaign.id, ad_group_criterion.criterion_id FROM ad_group_criterion
      WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = TRUE
        AND ${campScope}
    `,
    "ad groups": `
      SELECT ad_group.id, ad_group.name, campaign.id FROM ad_group
      WHERE ad_group.status = 'ENABLED' AND ${campScope}
    `,
    ads: `
      SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad_strength,
             ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.final_urls,
             ad_group_ad.ad.responsive_search_ad.headlines,
             ad_group_ad.ad.responsive_search_ad.descriptions,
             ad_group.id, campaign.id
      FROM ad_group_ad
      WHERE ad_group_ad.status = 'ENABLED'
        AND ad_group.status = 'ENABLED' AND ${campScope}
    `,
    keywords: `
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group_criterion.quality_info.quality_score,
             ad_group_criterion.quality_info.creative_quality_score,
             ad_group_criterion.quality_info.post_click_quality_score,
             ad_group_criterion.quality_info.search_predicted_ctr,
             ad_group.id, campaign.id
      FROM ad_group_criterion
      WHERE ad_group_criterion.type = 'KEYWORD'
        AND ad_group_criterion.status = 'ENABLED' AND ad_group_criterion.negative = FALSE
        AND ad_group.status = 'ENABLED' AND ${campScope}
    `,
    customer_asset: `
      SELECT customer_asset.field_type FROM customer_asset
      WHERE customer_asset.status = 'ENABLED'
    `,
    campaign_asset: `
      SELECT campaign.id, campaign_asset.field_type FROM campaign_asset
      WHERE campaign_asset.status = 'ENABLED' AND ${campScope}
    `,
    ad_group_asset: `
      SELECT campaign.id, ad_group.id, ad_group.status, ad_group_asset.field_type
      FROM ad_group_asset
      WHERE ad_group_asset.status = 'ENABLED'
        AND ad_group.status = 'ENABLED' AND ${campScope}
    `,
    "asset policy": `
      SELECT campaign.id, campaign_asset.field_type, campaign_asset.primary_status
      FROM campaign_asset
      WHERE campaign_asset.status = 'ENABLED'
        AND campaign_asset.primary_status IN ('LIMITED', 'NOT_ELIGIBLE')
        AND ${campScope}
    `,
    "location assets": "SELECT asset.id FROM asset WHERE asset.type = 'LOCATION'",
    recommendations: "SELECT recommendation.type FROM recommendation",
  };
  const data = await fetchAll(cid, queries, ctx);

  // --- Customer (status, optimization score) ---
  for (const row of data["customer"]) {
    ctx.customer_status = estr(row.customer?.status);
    ctx.customer_optimization_score = num(row.customer?.optimizationScore);
  }

  // --- Campaign settings (processed first: builds ctx.campaigns). The query is
  //     already scoped to the monitored set via campScope; we still drop ENDED
  //     and LSA campaigns here. ---
  for (const row of data["campaign settings"]) {
    const c = row.campaign ?? {};
    if (estr(c.primaryStatus) === "ENDED") {
      continue; // ENDED campaigns can still read status ENABLED — drop them
    }
    if (estr(c.advertisingChannelType) === "LOCAL_SERVICES") {
      continue; // exclude Local Services Ads (LSA) — separate product, no search hygiene signals
    }
    const ns = c.networkSettings ?? {};
    const id = estr(c.id);
    ctx.campaigns.set(
      id,
      newCampaignRow({
        id,
        name: estr(c.name),
        channel_type: estr(c.advertisingChannelType),
        bidding_strategy_type: estr(c.biddingStrategyType),
        primary_status: estr(c.primaryStatus),
        primary_status_reasons: Array.isArray(c.primaryStatusReasons)
          ? c.primaryStatusReasons.map((r: unknown) => estr(r))
          : [],
        positive_geo_target_type: estr(c.geoTargetTypeSetting?.positiveGeoTargetType),
        optimization_score: num(c.optimizationScore),
        target_cpa_micros:
          num(c.targetCpa?.targetCpaMicros) || num(c.maximizeConversions?.targetCpaMicros),
        net_search: Boolean(ns.targetSearchNetwork),
        net_search_partners: Boolean(ns.targetPartnerSearchNetwork),
        net_content: Boolean(ns.targetContentNetwork),
        budget_micros: num(row.campaignBudget?.amountMicros),
      }),
    );
  }

  // --- Campaign metrics (lookback) ---
  for (const row of data["campaign metrics"]) {
    const c = ctx.campaigns.get(estr(row.campaign?.id));
    if (!c) continue;
    const m = row.metrics ?? {};
    c.impressions = num(m.impressions);
    c.cost_micros = num(m.costMicros);
    c.conversions = num(m.conversions);
    c.cost_per_conversion_micros = num(m.costPerConversion);
    c.budget_lost_is = num(m.searchBudgetLostImpressionShare);
    c.rank_lost_is = num(m.searchRankLostImpressionShare);
  }

  // --- Location targeting: LOCATION + PROXIMITY. Radius ("X mi around Y")
  //     targets are PROXIMITY criteria, not LOCATION, and count as positive
  //     targeting — a campaign can target purely by radius. ---
  for (const row of data["location criteria"]) {
    const c = ctx.campaigns.get(estr(row.campaign?.id));
    if (!c) continue;
    if (row.campaignCriterion?.negative) c.has_negative_location = true;
    else c.has_positive_location = true;
  }

  // --- Language / ad-schedule / audience criteria ---
  for (const row of data["language/schedule/audience criteria"]) {
    const c = ctx.campaigns.get(estr(row.campaign?.id));
    if (!c) continue;
    const t = estr(row.campaignCriterion?.type);
    if (t === "LANGUAGE") c.has_language = true;
    else if (t === "AD_SCHEDULE") c.has_ad_schedule = true;
    else if (t === "USER_LIST") c.has_audience = true;
  }

  // --- Negative keyword lists attached to campaigns ---
  for (const row of data["campaign_shared_set"]) {
    const c = ctx.campaigns.get(estr(row.campaign?.id));
    if (c) c.has_negative_keyword_list = true;
  }

  // --- Negative keyword counts (campaign + ad group) for coverage ---
  for (const row of data["campaign negatives"]) {
    const c = ctx.campaigns.get(estr(row.campaign?.id));
    if (c) c.campaign_neg_count += 1;
  }
  for (const row of data["ad group negatives"]) {
    const c = ctx.campaigns.get(estr(row.campaign?.id));
    if (c) c.adgroup_neg_count += 1;
  }

  // --- Ad groups (enabled) ---
  for (const row of data["ad groups"]) {
    const camp = estr(row.campaign?.id);
    if (!ctx.campaigns.has(camp)) continue;
    const agid = estr(row.adGroup?.id);
    ctx.enabled_ad_group_ids.add(agid);
    ctx.ad_group_campaign.set(agid, camp);
    ctx.ad_group_names.set(agid, estr(row.adGroup?.name));
    let set = ctx.ad_group_ids_by_campaign.get(camp);
    if (!set) {
      set = new Set<string>();
      ctx.ad_group_ids_by_campaign.set(camp, set);
    }
    set.add(agid);
  }

  // --- Ads (enabled) incl. RSA detail ---
  for (const row of data["ads"]) {
    if (!ctx.campaigns.has(estr(row.campaign?.id))) continue;
    const a = row.adGroupAd ?? {};
    const ad = a.ad ?? {};
    const rsa = ad.responsiveSearchAd ?? {};
    const isRsa = estr(ad.type) === "RESPONSIVE_SEARCH_AD";
    const heads: any[] = Array.isArray(rsa.headlines) ? rsa.headlines : [];
    const descs: any[] = Array.isArray(rsa.descriptions) ? rsa.descriptions : [];
    ctx.ads.push({
      ad_id: estr(ad.id),
      ad_group_id: estr(row.adGroup?.id),
      campaign_id: estr(row.campaign?.id),
      ad_type: estr(ad.type),
      ad_strength: estr(a.adStrength),
      approval_status: estr(a.policySummary?.approvalStatus),
      is_rsa: isRsa,
      headline_count: heads.length,
      description_count: descs.length,
      pinned_count:
        heads.filter((h) => isPinned(h)).length + descs.filter((d) => isPinned(d)).length,
      has_final_url: Array.isArray(ad.finalUrls) && ad.finalUrls.length > 0,
    });
  }

  // --- Keywords + QS + components + match type ---
  const RATED = new Set(["BELOW_AVERAGE", "AVERAGE", "ABOVE_AVERAGE"]);
  for (const row of data["keywords"]) {
    if (!ctx.campaigns.has(estr(row.campaign?.id))) continue;
    const qi = row.adGroupCriterion?.qualityInfo ?? {};
    const adRel = estr(qi.creativeQualityScore);
    const lp = estr(qi.postClickQualityScore);
    const ctr = estr(qi.searchPredictedCtr);
    const rated = [adRel, lp, ctr].filter((c) => RATED.has(c));
    ctx.keywords.push({
      campaign_id: estr(row.campaign?.id),
      ad_group_id: estr(row.adGroup?.id),
      text: estr(row.adGroupCriterion?.keyword?.text),
      match_type: estr(row.adGroupCriterion?.keyword?.matchType),
      quality_score: num(qi.qualityScore),
      qs_below_average: rated.filter((c) => c === "BELOW_AVERAGE").length,
      qs_components: rated.length,
      ad_relevance: RATED.has(adRel) ? adRel : "",
      landing_page: RATED.has(lp) ? lp : "",
      expected_ctr: RATED.has(ctr) ? ctr : "",
    });
  }

  // --- Assets: account-level (inherited) ---
  for (const row of data["customer_asset"]) {
    const ft = estr(row.customerAsset?.fieldType);
    ctx.account_assets.set(ft, (ctx.account_assets.get(ft) ?? 0) + 1);
  }

  // --- Assets: campaign-level ---
  for (const row of data["campaign_asset"]) {
    const camp = estr(row.campaign?.id);
    if (!ctx.campaigns.has(camp)) continue;
    const ft = estr(row.campaignAsset?.fieldType);
    let per = ctx.campaign_assets.get(camp);
    if (!per) {
      per = new Map<string, number>();
      ctx.campaign_assets.set(camp, per);
    }
    per.set(ft, (per.get(ft) ?? 0) + 1);
  }

  // --- Assets: ad-group-level. These serve only for their ad group, on top of
  //     the campaign + account assets every ad already inherits. Omitting them
  //     undercounts (and falsely flags) campaigns whose sitelinks/callouts/
  //     images live at the ad-group level. The query is already scoped to
  //     enabled ad groups in labeled campaigns; keyed by ad_group_id (mapped to
  //     campaigns in the AST checks). ---
  for (const row of data["ad_group_asset"]) {
    const agid = estr(row.adGroup?.id);
    const ft = estr(row.adGroupAsset?.fieldType);
    let per = ctx.ad_group_assets.get(agid);
    if (!per) {
      per = new Map<string, number>();
      ctx.ad_group_assets.set(agid, per);
    }
    per.set(ft, (per.get(ft) ?? 0) + 1);
  }

  // --- Asset policy issues (isolated so failure doesn't drop asset counts) ---
  for (const row of data["asset policy"]) {
    const camp = estr(row.campaign?.id);
    if (!ctx.campaigns.has(camp)) continue;
    ctx.limited_assets.push([
      camp,
      estr(row.campaignAsset?.fieldType),
      estr(row.campaignAsset?.primaryStatus),
    ]);
  }

  // --- Account-level location assets (asset.type LOCATION) — these are linked
  //     via Business Profile and don't appear as customer_asset field_types,
  //     so AST-03 falls back to this when no campaign location asset is found. ---
  ctx.account_location_assets = data["location assets"].length;

  // --- Recommendations ---
  if (!ctx.warnings.some((w) => w.startsWith("recommendations:"))) {
    ctx.recommendations_available = true;
  }
  ctx.recommendation_types = data["recommendations"].map((r) => estr(r.recommendation?.type));

  // Ad groups that actually serve (>=1 enabled ad). Ad-group-level assets only
  // serve where an ad runs, so asset-coverage checks judge a campaign over
  // these — an enabled but ad-less shell ad group must not drag effective
  // counts down (ctx.ads already holds only ENABLED ads in ENABLED ad groups).
  ctx.serving_ad_group_ids = new Set(ctx.ads.map((a) => a.ad_group_id));

  return ctx;
}
