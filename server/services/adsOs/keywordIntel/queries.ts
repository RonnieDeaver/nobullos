/**
 * Read-only GAQL pulls for Keyword Intelligence
 * (port of backend/app/keyword_intel/queries.py).
 *
 * Same discipline as the audit's context layer: independent queries run
 * concurrently, and a failing query is isolated into a warning (empty result)
 * instead of sinking the run. Scoped to the labeled monitored campaigns by id,
 * regardless of status — a campaign paused/restructured today may still have
 * served (and wasted spend on) terms during the window, and its waste is
 * exactly what we want to surface. This matches the dashboard + pacing scope
 * (which also count labeled-campaign activity regardless of status); filtering
 * to ENABLED here silently returned zero candidates whenever the labeled
 * campaigns were paused.
 *
 * Datasets:
 *   - search terms (lookback window)            -> the candidates to review
 *   - active (positive) keyword texts           -> protected words
 *   - positive location targeting -> geo names  -> auto-derive the service area
 *
 * Note: we deliberately do NOT pull existing negatives. search_term_view only
 * contains terms that actually served an ad, so a term genuinely blocked by a
 * negative is already absent here. Terms that DID serve despite a negative
 * (wrong campaign, slipped through) are exactly the waste we want to surface.
 */

import { adsOsGaqlSearch, AdsOsCredsMissing, type SearchStreamRow } from "../googleAdsClient";
import { addDays, isoDate, plainToday } from "../dateRange";
import { mapPool } from "../singleflight";
import { tokenize } from "./safety";

export interface SearchTermRow {
  search_term: string;
  campaign: string;
  ad_group: string;
  matched_keyword: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  avg_cpc: number;
  cost_per_conv: number;
  campaign_id: string; // set by the keyword finder (to map to campaign CPA)
}

export interface KeywordFinderData {
  converting_terms: SearchTermRow[];
  campaign_cpa: Map<string, number>; // campaign_id -> avg CPA
  /** Token-join keys of active keywords (for "already a keyword" exclusion). */
  active_keyword_keys: Set<string>;
  // The account's LIVE negative keywords in the monitored campaigns (campaign +
  // ad-group + attached shared-set negatives), as [text, match_type-lowercase].
  // A converting term one of these blocks must not be recommended — the account
  // already suppresses it, so the "new keyword" could never serve.
  account_negatives: [string, string][];
  warnings: string[];
}

export interface KeywordIntelData {
  search_terms: SearchTermRow[];
  active_keyword_texts: string[];
  geo_location_names: string[];
  keyword_spend: number; // total keyword spend over the window (coverage denom)
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

/** Stable "already an active keyword" key (bundle: tuple(tokenize(text))). */
export function keywordTupleKey(text: string): string {
  return tokenize(text).join(" ");
}

/**
 * Run the labeled queries concurrently; a failing query becomes a warning
 * ("label: message") with an empty result, mirroring the bundle's
 * _fetch_concurrent. Creds-missing still fails the whole run (nothing would
 * succeed anyway, and the route turns it into a 503).
 */
async function fetchConcurrent(
  cid: string,
  queries: Record<string, string>,
): Promise<{ results: Record<string, SearchStreamRow[]>; warnings: string[] }> {
  const entries = Object.entries(queries);
  const warnings: string[] = [];
  const results: Record<string, SearchStreamRow[]> = {};
  const settled = await mapPool(entries, 6, async ([label, query]) => {
    try {
      return { label, rows: await adsOsGaqlSearch(cid, query), warn: null as string | null };
    } catch (err: any) {
      if (err instanceof AdsOsCredsMissing) throw err;
      return { label, rows: [] as SearchStreamRow[], warn: `${label}: ${err?.message ?? err}` };
    }
  });
  for (const { label, rows, warn } of settled) {
    results[label] = rows;
    if (warn) warnings.push(warn);
  }
  return { results, warnings };
}

function windowClauses(lookbackDays: number, campaignIds: string[]): { dateClause: string; campIn: string } {
  const end = plainToday();
  const start = addDays(end, -lookbackDays);
  return {
    dateClause: `segments.date BETWEEN '${isoDate(start)}' AND '${isoDate(end)}'`,
    campIn: `campaign.id IN (${campaignIds.join(", ")})`,
  };
}

/**
 * Merge duplicate search-term rows that differ only by keyword/ad-group segment.
 *
 * GAQL search_term_view returns one row per (search_term × keyword × ad_group)
 * combination, each carrying only a slice of the window's metrics. Without
 * aggregation, the last duplicate written into a Map (typically the cheapest
 * segment when rows are sorted cost-descending) wins — causing the suggestion
 * metrics to collapse to near-zero for terms served across multiple segments,
 * and wasting candidate-cap slots on duplicates.
 *
 * This function sums impressions/clicks/cost/conversions across all segments
 * for the same search_term, recomputes avg_cpc and cost_per_conv from the
 * summed values, and uses the highest-cost segment as the representative for
 * campaign/ad_group/matched_keyword display.
 *
 * Exported for direct unit-testing.
 */
export function aggregateSearchTerms(
  rows: SearchTermRow[],
  groupKey: (row: SearchTermRow) => string = (row) => row.search_term,
): SearchTermRow[] {
  // Group rows by search_term (preserving first-seen order for the key, which
  // is highest-cost-first since GAQL ORDER BY metrics.cost_micros DESC).
  const groups = new Map<string, SearchTermRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }

  const out: SearchTermRow[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      out.push(members[0]);
      continue;
    }
    // Representative: the segment with the highest cost (already first, since
    // rows arrive cost-descending, but sort defensively).
    const rep = [...members].sort((a, b) => b.cost - a.cost)[0];
    const impressions = members.reduce((s, r) => s + r.impressions, 0);
    const clicks = members.reduce((s, r) => s + r.clicks, 0);
    // Sum cost and conversions without early rounding — preserve GAQL precision
    // so downstream (converting-term caution, waste math, candidate ordering)
    // operates on the true cumulative values. Derived display fields are rounded.
    const cost = members.reduce((s, r) => s + r.cost, 0);
    const conversions = members.reduce((s, r) => s + r.conversions, 0);
    out.push({
      search_term: rep.search_term,
      campaign: rep.campaign,
      ad_group: rep.ad_group,
      matched_keyword: rep.matched_keyword,
      campaign_id: rep.campaign_id,
      impressions,
      clicks,
      cost,
      conversions,
      avg_cpc: clicks > 0 ? round2(cost / clicks) : 0.0,
      cost_per_conv: conversions > 0 ? round2(cost / conversions) : 0.0,
    });
  }
  return out;
}

/**
 * Finder CPA baselines are campaign-specific, so unlike the negative-keyword
 * analyzer the finder must never combine identical search terms from separate
 * campaigns. Normalize the term so capitalization/token-spacing variants from
 * the same campaign still become one cumulative decision row.
 */
export function keywordFinderTermAggregationKey(row: SearchTermRow): string {
  return `${row.campaign_id}\u0000${keywordTupleKey(row.search_term)}`;
}

/**
 * Pull the review datasets, scoped to the labeled campaigns only.
 *
 * `campaignIds` is the set of campaigns carrying the campaign label — the
 * engine resolves it (and gates on enrollment) before calling this.
 */
export async function fetchData(
  customerId: string,
  lookbackDays: number,
  campaignIds: string[],
): Promise<KeywordIntelData> {
  const cid = customerId.replace(/-/g, "").trim();
  const { dateClause, campIn } = windowClauses(lookbackDays, campaignIds);

  const queries: Record<string, string> = {
    "search terms": `
        SELECT search_term_view.search_term, campaign.name, ad_group.name,
               segments.keyword.info.text,
               metrics.impressions, metrics.clicks, metrics.cost_micros,
               metrics.conversions, metrics.average_cpc, metrics.cost_per_conversion
        FROM search_term_view
        WHERE ${dateClause} AND ${campIn}
        ORDER BY metrics.cost_micros DESC
    `,
    "active keywords": `
        SELECT ad_group_criterion.keyword.text FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = FALSE
          AND ad_group_criterion.status != 'REMOVED'
          AND ${campIn}
    `,
    "keyword spend": `
        SELECT metrics.cost_micros FROM keyword_view
        WHERE ${dateClause} AND ${campIn}
    `,
    "geo targets": `
        SELECT campaign_criterion.location.geo_target_constant FROM campaign_criterion
        WHERE campaign_criterion.type = 'LOCATION'
          AND campaign_criterion.negative = FALSE
          AND campaign_criterion.status = 'ENABLED'
          AND ${campIn}
    `,
  };

  const { results: raw, warnings } = await fetchConcurrent(cid, queries);
  const data: KeywordIntelData = {
    search_terms: [],
    active_keyword_texts: [],
    geo_location_names: [],
    keyword_spend: 0,
    warnings,
  };

  // --- Search terms (candidates) ---
  // GAQL search_term_view segments by keyword/ad-group, so the same search term
  // can appear as multiple rows each carrying only a slice of the metrics.
  // Aggregate them here so every downstream step (selectCandidates,
  // candidatesByTerm, waste math, converting-term caution) works on one
  // complete row per term with window-cumulative metrics.
  const rawTermRows: SearchTermRow[] = [];
  for (const row of raw["search terms"]) {
    const kw = row.segments?.keyword?.info?.text ?? "";
    const m = row.metrics ?? {};
    rawTermRows.push({
      search_term: String(row.searchTermView?.searchTerm ?? ""),
      campaign: String(row.campaign?.name ?? ""),
      ad_group: String(row.adGroup?.name ?? ""),
      matched_keyword: String(kw),
      impressions: Math.trunc(num(m.impressions)),
      clicks: Math.trunc(num(m.clicks)),
      cost: micros(m.costMicros),
      conversions: num(m.conversions),
      avg_cpc: micros(m.averageCpc),
      cost_per_conv: micros(m.costPerConversion),
      campaign_id: "",
    });
  }
  data.search_terms = aggregateSearchTerms(rawTermRows);

  // --- Active keyword texts (protected words) ---
  data.active_keyword_texts = raw["active keywords"]
    .map((row) => String(row.adGroupCriterion?.keyword?.text ?? ""))
    .filter((t) => t !== "");

  // --- Total keyword spend (coverage denominator: search-term spend is only a
  //     fraction of this — Google hides low-volume terms) ---
  data.keyword_spend = round2(
    raw["keyword spend"].reduce((s, r) => s + micros(r.metrics?.costMicros), 0),
  );

  // --- Geo targeting -> human location names (auto service-area default) ---
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

/** Look up human names for geo_target_constant ids (best-effort). Shared with
 * the Pyramid Breakdown's query layer (bundle: pyramid/queries.py imports
 * _resolve_geo_names from keyword_intel.queries). */
export async function resolveGeoNames(customerId: string, geoIds: string[]): Promise<string[]> {
  const inClause = geoIds.map((gid) => `'${gid}'`).join(", ");
  const query =
    "SELECT geo_target_constant.name, geo_target_constant.target_type " +
    `FROM geo_target_constant WHERE geo_target_constant.id IN (${inClause})`;
  const names: string[] = [];
  const seen = new Set<string>();
  try {
    for (const row of await adsOsGaqlSearch(customerId, query)) {
      const name = String(row.geoTargetConstant?.name ?? "");
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
  } catch {
    return [];
  }
  return names;
}

// ----------------------------- New-keyword finder -----------------------------

/**
 * Converting search terms + per-campaign CPA baseline + existing keywords.
 *
 * Scoped to the labeled campaigns. Read-only. Used by the rules-based new
 * keyword finder (no AI).
 */
export async function fetchKeywordFinderData(
  customerId: string,
  lookbackDays: number,
  campaignIds: string[],
): Promise<KeywordFinderData> {
  const cid = customerId.replace(/-/g, "").trim();
  const { dateClause, campIn } = windowClauses(lookbackDays, campaignIds);

  const queries: Record<string, string> = {
    "converting terms": `
        SELECT search_term_view.search_term, campaign.id, campaign.name, ad_group.name,
               metrics.cost_micros, metrics.conversions
        FROM search_term_view
        WHERE ${dateClause} AND ${campIn}
          AND metrics.conversions > 0
        ORDER BY metrics.conversions DESC
    `,
    "campaign metrics": `
        SELECT campaign.id, metrics.cost_micros, metrics.conversions
        FROM campaign
        WHERE ${dateClause} AND ${campIn}
    `,
    "active keywords": `
        SELECT ad_group_criterion.keyword.text FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = FALSE
          AND ad_group_criterion.status != 'REMOVED'
          AND ${campIn}
    `,
    "ad group negatives": `
        SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.negative = TRUE
          AND ad_group_criterion.status != 'REMOVED'
          AND ${campIn}
    `,
    "campaign negatives": `
        SELECT campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'KEYWORD'
          AND campaign_criterion.negative = TRUE
          AND campaign_criterion.status != 'REMOVED'
          AND ${campIn}
    `,
    "negative shared sets": `
        SELECT campaign_shared_set.shared_set FROM campaign_shared_set
        WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
          AND campaign_shared_set.status = 'ENABLED'
          AND ${campIn}
    `,
  };

  const { results: raw, warnings } = await fetchConcurrent(cid, queries);
  const data: KeywordFinderData = {
    converting_terms: [],
    campaign_cpa: new Map(),
    active_keyword_keys: new Set(),
    account_negatives: [],
    warnings,
  };

  // Like the negative-keyword candidate pull above, GAQL can return separate
  // keyword/ad-group segments for one converting search term. Aggregate before
  // the finder applies its conversion floor, CPA rule, and live-negative check
  // so each uses the cumulative window metrics exactly once.
  const rawConvertingTermRows: SearchTermRow[] = [];
  for (const row of raw["converting terms"]) {
    const m = row.metrics ?? {};
    rawConvertingTermRows.push({
      search_term: String(row.searchTermView?.searchTerm ?? ""),
      campaign: String(row.campaign?.name ?? ""),
      ad_group: String(row.adGroup?.name ?? ""),
      matched_keyword: "",
      impressions: 0,
      clicks: 0,
      cost: micros(m.costMicros),
      conversions: num(m.conversions),
      avg_cpc: 0.0,
      cost_per_conv: 0.0,
      campaign_id: String(row.campaign?.id ?? ""),
    });
  }
  data.converting_terms = aggregateSearchTerms(
    rawConvertingTermRows,
    keywordFinderTermAggregationKey,
  );

  for (const row of raw["campaign metrics"]) {
    const m = row.metrics ?? {};
    const conv = num(m.conversions);
    data.campaign_cpa.set(
      String(row.campaign?.id ?? ""),
      conv > 0 ? round2(micros(m.costMicros) / conv) : 0.0,
    );
  }

  for (const row of raw["active keywords"]) {
    data.active_keyword_keys.add(keywordTupleKey(String(row.adGroupCriterion?.keyword?.text ?? "")));
  }

  // Live negatives: ad-group + campaign level, plus the negative keywords in
  // shared sets attached to the monitored campaigns (a follow-up query — it
  // needs the set resource names from the concurrent batch above).
  for (const row of raw["ad group negatives"]) {
    const kw = row.adGroupCriterion?.keyword ?? {};
    data.account_negatives.push([String(kw.text ?? ""), String(kw.matchType ?? "").toLowerCase()]);
  }
  for (const row of raw["campaign negatives"]) {
    const kw = row.campaignCriterion?.keyword ?? {};
    data.account_negatives.push([String(kw.text ?? ""), String(kw.matchType ?? "").toLowerCase()]);
  }
  const setNames = [...new Set(
    raw["negative shared sets"].map((row) => String(row.campaignSharedSet?.sharedSet ?? "")).filter(Boolean),
  )].sort();
  if (setNames.length) {
    const inClause = setNames.map((s) => `'${s}'`).join(", ");
    try {
      const rows = await adsOsGaqlSearch(
        cid,
        "SELECT shared_criterion.keyword.text, shared_criterion.keyword.match_type " +
          "FROM shared_criterion WHERE shared_criterion.type = 'KEYWORD' " +
          `AND shared_criterion.shared_set IN (${inClause})`,
      );
      for (const row of rows) {
        const kw = row.sharedCriterion?.keyword ?? {};
        data.account_negatives.push([String(kw.text ?? ""), String(kw.matchType ?? "").toLowerCase()]);
      }
    } catch (err: any) {
      if (err instanceof AdsOsCredsMissing) throw err;
      data.warnings.push(`shared-set negatives: ${err?.message ?? err}`);
    }
  }

  return data;
}
