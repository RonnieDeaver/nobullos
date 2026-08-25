/**
 * Read-only GAQL pulls for the Pyramid Breakdown (campaign performance review)
 * — port of backend/app/pyramid/queries.py.
 *
 * Same discipline as the Keyword Intelligence / audit query layers: independent
 * queries run concurrently, and a failing query is isolated into
 * a warning (empty dataset) instead of sinking the run. Scoped to the labeled
 * monitored campaigns by id regardless of status — a campaign paused today may
 * still have spent during the window, and that spend is exactly what the review
 * judges. The window is the last N *complete* days (ends yesterday), matching the
 * dashboards: a partial today would depress every CPL the rules compare against.
 *
 * Datasets (the pyramid, top to bottom):
 *   - campaign attrs + windowed metrics (incl. the impression-share trio)
 *   - ad group attrs + windowed metrics
 *   - keywords (attrs + metrics in one query — only rows active in the window)
 *   - search terms (aggregated per (ad group, term); the keyword segment splits
 *     one term into a row per matched keyword)
 *   - geo targets -> location names (client-criteria service-area default)
 */

import { adsOsGaqlSearch, AdsOsCredsMissing, type SearchStreamRow } from "../googleAdsClient";
import { addDays, isoDate, plainToday } from "../dateRange";
import { mapPool } from "../singleflight";
import { resolveGeoNames } from "../keywordIntel/queries";

export interface CampaignPull {
  id: string;
  name: string;
  status: string;
  primary_status: string;
  channel_type: string;
  bidding_strategy_type: string;
  budget: number | null; // daily budget, account currency
  target_cpa: number | null; // tCPA (or maximize-conversions tCPA) if set
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
  // Impression-share trio, as percents 0-100 (null = not reported, e.g. PMax).
  search_is: number | null;
  lost_is_budget: number | null;
  lost_is_rank: number | null;
  top_is: number | null;
}

export interface AdGroupPull {
  id: string;
  name: string;
  status: string;
  campaign_id: string;
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
}

export interface KeywordPull {
  criterion_id: string;
  ad_group_id: string;
  campaign_id: string;
  text: string;
  match_type: string;
  status: string;
  quality_score: number; // 1-10; 0 = not reported
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
}

/** One search term per (ad group, term) — rows pre-aggregated across the
 * keyword segment. */
export interface TermPull {
  search_term: string;
  ad_group_id: string;
  campaign_id: string;
  targeting_status: string; // ADDED | EXCLUDED | ADDED_EXCLUDED | NONE
  matched_keywords: string[];
  cost: number;
  conversions: number;
  clicks: number;
  impressions: number;
}

export interface PyramidData {
  campaigns: Map<string, CampaignPull>;
  ad_groups: Map<string, AdGroupPull>;
  keywords: KeywordPull[];
  terms: TermPull[];
  geo_location_names: string[];
  start: string;
  end: string;
  failed_datasets: Set<string>;
  warnings: string[];
}

function micros(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n ? n / 1e6 : 0.0;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** A 0..1 share metric as a percent, null when the API reported nothing. */
function pct(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const f = Number(v);
  if (!Number.isFinite(f) || f <= 0) return null;
  return Math.round((f * 100 + Number.EPSILON) * 10) / 10; // round(f*100, 1)
}

// Severity order for a term's targeting status when its segment rows disagree.
const STATUS_RANK: Record<string, number> = { ADDED_EXCLUDED: 3, EXCLUDED: 2, ADDED: 1, NONE: 0 };

/** Stable Map key for a (ad_group_id, term) pair (Python tuple-key equivalent). */
export function termKey(adGroupId: string, term: string): string {
  return JSON.stringify([adGroupId, term]);
}

/**
 * Run the queries concurrently; a failure empties that dataset and records
 * which one failed (the engine needs to know *what* is missing). Creds-missing
 * still fails the whole run (nothing would succeed anyway; the route 503s it).
 */
async function fetchConcurrent(
  cid: string,
  queries: Record<string, string>,
): Promise<{ results: Record<string, SearchStreamRow[]>; warnings: string[]; failed: Set<string> }> {
  const entries = Object.entries(queries);
  const warnings: string[] = [];
  const failed = new Set<string>();
  const results: Record<string, SearchStreamRow[]> = {};
  const settled = await mapPool(entries, 7, async ([label, query]) => {
    try {
      return { label, rows: await adsOsGaqlSearch(cid, query), warn: null as string | null };
    } catch (err: any) {
      if (err instanceof AdsOsCredsMissing) throw err;
      return { label, rows: [] as SearchStreamRow[], warn: `${label}: ${err?.message ?? err}` };
    }
  });
  for (const { label, rows, warn } of settled) {
    results[label] = rows;
    if (warn) {
      warnings.push(warn);
      failed.add(label);
    }
  }
  return { results, warnings, failed };
}

/** Pull all four pyramid tiers, scoped to the labeled campaigns. Read-only. */
export async function fetchPyramidData(
  customerId: string,
  lookbackDays: number,
  campaignIds: string[],
): Promise<PyramidData> {
  const cid = customerId.replace(/-/g, "").trim();
  const end = addDays(plainToday(), -1); // complete days only
  const start = addDays(end, -(lookbackDays - 1));
  const dateClause = `segments.date BETWEEN '${isoDate(start)}' AND '${isoDate(end)}'`;
  const campIn = `campaign.id IN (${campaignIds.join(", ")})`;

  const queries: Record<string, string> = {
    // Attrs are pulled without a date segment so zero-activity entities still
    // resolve names/statuses; metrics queries only return active rows.
    "campaign attrs": `
        SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status,
               campaign.advertising_channel_type, campaign.bidding_strategy_type,
               campaign.target_cpa.target_cpa_micros,
               campaign.maximize_conversions.target_cpa_micros,
               campaign_budget.amount_micros
        FROM campaign
        WHERE ${campIn} AND campaign.status != 'REMOVED'
    `,
    "campaign metrics": `
        SELECT campaign.id, metrics.cost_micros, metrics.conversions, metrics.clicks,
               metrics.impressions, metrics.search_impression_share,
               metrics.search_budget_lost_impression_share,
               metrics.search_rank_lost_impression_share,
               metrics.search_top_impression_share
        FROM campaign
        WHERE ${campIn} AND ${dateClause}
    `,
    "ad group attrs": `
        SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id
        FROM ad_group
        WHERE ${campIn} AND ad_group.status != 'REMOVED'
    `,
    "ad group metrics": `
        SELECT ad_group.id, metrics.cost_micros, metrics.conversions, metrics.clicks,
               metrics.impressions
        FROM ad_group
        WHERE ${campIn} AND ${dateClause}
    `,
    "keywords": `
        SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
               ad_group_criterion.keyword.match_type, ad_group_criterion.status,
               ad_group_criterion.quality_info.quality_score,
               ad_group.id, campaign.id,
               metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions
        FROM keyword_view
        WHERE ${campIn} AND ${dateClause}
        ORDER BY metrics.cost_micros DESC
    `,
    "search terms": `
        SELECT search_term_view.search_term, search_term_view.status,
               segments.keyword.info.text, ad_group.id, campaign.id,
               metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions
        FROM search_term_view
        WHERE ${campIn} AND ${dateClause}
        ORDER BY metrics.cost_micros DESC
    `,
    "geo targets": `
        SELECT campaign_criterion.location.geo_target_constant FROM campaign_criterion
        WHERE campaign_criterion.type = 'LOCATION'
          AND campaign_criterion.negative = FALSE
          AND campaign_criterion.status = 'ENABLED'
          AND ${campIn}
    `,
  };

  const { results: raw, warnings, failed } = await fetchConcurrent(cid, queries);
  const data: PyramidData = {
    campaigns: new Map(),
    ad_groups: new Map(),
    keywords: [],
    terms: [],
    geo_location_names: [],
    start: isoDate(start),
    end: isoDate(end),
    failed_datasets: failed,
    warnings,
  };

  // --- Campaigns: attrs first, then merge windowed metrics ---
  for (const row of raw["campaign attrs"]) {
    const c = row.campaign ?? {};
    const tcpa =
      micros(c.targetCpa?.targetCpaMicros) || micros(c.maximizeConversions?.targetCpaMicros);
    const budget = round2(micros(row.campaignBudget?.amountMicros));
    data.campaigns.set(String(c.id), {
      id: String(c.id),
      name: String(c.name ?? ""),
      status: String(c.status ?? ""),
      primary_status: String(c.primaryStatus ?? ""),
      channel_type: String(c.advertisingChannelType ?? ""),
      bidding_strategy_type: String(c.biddingStrategyType ?? ""),
      budget: budget || null,
      target_cpa: tcpa ? round2(tcpa) : null,
      cost: 0.0,
      conversions: 0.0,
      clicks: 0,
      impressions: 0,
      search_is: null,
      lost_is_budget: null,
      lost_is_rank: null,
      top_is: null,
    });
  }
  for (const row of raw["campaign metrics"]) {
    const c = data.campaigns.get(String(row.campaign?.id));
    if (!c) continue;
    const m = row.metrics ?? {};
    c.cost = round2(micros(m.costMicros));
    c.conversions = num(m.conversions);
    c.clicks = Math.trunc(num(m.clicks));
    c.impressions = Math.trunc(num(m.impressions));
    // IS only means something on Search; PMax/Display report nothing useful.
    if (c.channel_type === "SEARCH") {
      c.search_is = pct(m.searchImpressionShare);
      c.lost_is_budget = pct(m.searchBudgetLostImpressionShare);
      c.lost_is_rank = pct(m.searchRankLostImpressionShare);
      c.top_is = pct(m.searchTopImpressionShare);
    }
  }

  // --- Ad groups ---
  for (const row of raw["ad group attrs"]) {
    const g = row.adGroup ?? {};
    data.ad_groups.set(String(g.id), {
      id: String(g.id),
      name: String(g.name ?? ""),
      status: String(g.status ?? ""),
      campaign_id: String(row.campaign?.id ?? ""),
      cost: 0.0,
      conversions: 0.0,
      clicks: 0,
      impressions: 0,
    });
  }
  for (const row of raw["ad group metrics"]) {
    const g = data.ad_groups.get(String(row.adGroup?.id));
    if (!g) continue;
    const m = row.metrics ?? {};
    g.cost = round2(micros(m.costMicros));
    g.conversions = num(m.conversions);
    g.clicks = Math.trunc(num(m.clicks));
    g.impressions = Math.trunc(num(m.impressions));
  }

  // --- Keywords (only rows with window activity appear — exactly the ones the
  //     rules can judge; keyword_view has no negatives by definition) ---
  for (const row of raw["keywords"]) {
    const crit = row.adGroupCriterion ?? {};
    const m = row.metrics ?? {};
    data.keywords.push({
      criterion_id: String(crit.criterionId ?? ""),
      ad_group_id: String(row.adGroup?.id ?? ""),
      campaign_id: String(row.campaign?.id ?? ""),
      text: String(crit.keyword?.text ?? ""),
      match_type: String(crit.keyword?.matchType ?? ""),
      status: String(crit.status ?? ""),
      quality_score: Math.trunc(num(crit.qualityInfo?.qualityScore)),
      cost: round2(micros(m.costMicros)),
      conversions: num(m.conversions),
      clicks: Math.trunc(num(m.clicks)),
      impressions: Math.trunc(num(m.impressions)),
    });
  }

  // --- Search terms, aggregated per (ad group, term): the keyword segment
  //     splits one term into a row per matched keyword ---
  const agg = new Map<string, TermPull>();
  for (const row of raw["search terms"]) {
    const term = String(row.searchTermView?.searchTerm ?? "");
    const agId = String(row.adGroup?.id ?? "");
    const key = termKey(agId, term);
    let t = agg.get(key);
    if (!t) {
      t = {
        search_term: term,
        ad_group_id: agId,
        campaign_id: String(row.campaign?.id ?? ""),
        targeting_status: "NONE",
        matched_keywords: [],
        cost: 0.0,
        conversions: 0.0,
        clicks: 0,
        impressions: 0,
      };
      agg.set(key, t);
    }
    const m = row.metrics ?? {};
    t.cost = round2(t.cost + micros(m.costMicros));
    t.conversions += num(m.conversions);
    t.clicks += Math.trunc(num(m.clicks));
    t.impressions += Math.trunc(num(m.impressions));
    const status = String(row.searchTermView?.status ?? "NONE");
    if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[t.targeting_status] ?? 0)) {
      t.targeting_status = status;
    }
    const kw = String(row.segments?.keyword?.info?.text ?? "");
    if (kw && !t.matched_keywords.includes(kw)) t.matched_keywords.push(kw);
  }
  data.terms = [...agg.values()].sort((a, b) => b.cost - a.cost);

  // --- Geo targeting -> human location names (criteria service-area default) ---
  const geoIds: string[] = [];
  for (const row of raw["geo targets"]) {
    const res = String(row.campaignCriterion?.location?.geoTargetConstant ?? "");
    if (res && res.includes("/")) geoIds.push(res.slice(res.lastIndexOf("/") + 1));
  }
  if (geoIds.length) {
    data.geo_location_names = await resolveGeoNames(cid, [...new Set(geoIds)].sort());
  }

  return data;
}
