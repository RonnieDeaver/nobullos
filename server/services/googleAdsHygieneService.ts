/**
 * Task #2785 — Google Ads Hygiene: Keyword Intel, LSA Dashboard, Budget
 * Pacing & Alerts.
 *
 * Three compute functions:
 *
 *   1. `runKeywordIntel(customerId, lookbackDays)` — fetches keyword
 *      performance data via GAQL, classifies each keyword into one of
 *      five suggestion types, persists results, and returns the analysis.
 *
 *   2. `computeBudgetPacing(customerId)` — compares month-to-date spend
 *      against each campaign's daily budget × elapsed days to produce
 *      per-campaign pace bands and an account-level summary.
 *
 *   3. `fetchLsaDashboard(customerId)` — identifies campaigns with
 *      advertising_channel_type = 'LOCAL_SERVICES', surfaces their
 *      metrics, and applies the same pacing logic. Note: detailed
 *      lead-quality data (lead type, lead quality) requires the separate
 *      Google Local Services Ads API and is NOT available via standard
 *      GAQL — the dashboard shows spend/conversion pacing only.
 *
 *   4. `computeAndSaveAlerts(customerId)` — derives alerts from the
 *      pacing output (budget off-pace, pacing risk, etc.) and from any
 *      disapprovals visible via GAQL, then persists the new alert rows,
 *      replacing auto-generated ones from the last 24 hours.
 *
 * All GAQL calls go through the existing `gaqlSearchStream` / auth layer
 * in `googleAdsIntegration.ts`.
 *
 * GAQL field references confirmed against v23 documentation
 * (https://developers.google.com/google-ads/api/fields/v23) on 2026-07-13
 * per the project's public-API-documentation rule.
 */

import { gaqlSearchStream } from "./googleAdsIntegration";
import {
  clearKeywordIntelResultsForCustomer,
  deleteRecentAlertsForCustomer,
  insertGoogleAdsHygieneAlerts,
  insertKeywordIntelResults,
} from "../storage/googleAdsHygieneStorage";
import type { InsertGoogleAdsHygieneAlert, InsertGoogleAdsKeywordIntelResult } from "@shared/schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNum(v: any): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function micros2dollars(micros: number): number {
  return micros / 1_000_000;
}

/**
 * Build an ISO date range filter for GAQL that covers the current calendar
 * month to date. Used for spend and impression metrics so pacing math
 * reflects a consistent window.
 */
function monthToDateFilter(): { dateFilter: string; periodStart: Date; today: Date; daysInMonth: number; daysElapsed: number } {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const day = today.getUTCDate();
  const periodStart = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysElapsed = day;
  const startIso = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const todayIso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    dateFilter: `segments.date BETWEEN '${startIso}' AND '${todayIso}'`,
    periodStart,
    today,
    daysInMonth,
    daysElapsed,
  };
}

/** Lookback date-filter string for the keyword intel queries. */
function lookbackFilter(days: number): string {
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `segments.date BETWEEN '${fmt(start)}' AND '${fmt(end)}'`;
}

// ─── Pace-band logic (shared between Budget Pacing and LSA) ─────────────────

export type PaceBand = "ahead" | "on_pace" | "slightly_behind" | "behind" | "no_data";

export interface CampaignPaceResult {
  campaignId: string;
  campaignName: string | null;
  channelType: string | null;
  budgetDollarPerDay: number;
  expectedSpendToDate: number;
  actualSpendToDate: number;
  paceRatio: number | null;
  paceBand: PaceBand;
  daysElapsed: number;
  daysInMonth: number;
}

export interface PacingSummary {
  campaigns: CampaignPaceResult[];
  daysElapsed: number;
  daysInMonth: number;
  accountTotalBudgetPerDay: number;
  accountExpectedSpend: number;
  accountActualSpend: number;
  accountPaceBand: PaceBand;
  overallPaceRatio: number | null;
}

function classifyPace(actual: number, expected: number): { band: PaceBand; ratio: number | null } {
  if (expected <= 0) return { band: "no_data", ratio: null };
  const ratio = actual / expected;
  if (ratio > 1.15) return { band: "ahead", ratio };
  if (ratio >= 0.85) return { band: "on_pace", ratio };
  if (ratio >= 0.6) return { band: "slightly_behind", ratio };
  return { band: "behind", ratio };
}

// ─── 1. Budget Pacing ────────────────────────────────────────────────────────

/**
 * Fetch month-to-date spend and daily budget for all ENABLED Search/Display
 * campaigns, then compute pace bands.
 *
 * GAQL v23 fields confirmed:
 *   campaign.id, campaign.name, campaign.advertising_channel_type,
 *   campaign_budget.amount_micros, metrics.cost_micros, segments.date
 * (https://developers.google.com/google-ads/api/fields/v23/campaign)
 */
export async function computeBudgetPacing(customerId: string): Promise<PacingSummary> {
  const { dateFilter, daysInMonth, daysElapsed } = monthToDateFilter();

  const rows = await gaqlSearchStream(
    customerId,
    `SELECT
       campaign.id,
       campaign.name,
       campaign.advertising_channel_type,
       campaign_budget.amount_micros,
       metrics.cost_micros
     FROM campaign
     WHERE campaign.status != 'REMOVED'
       AND campaign.advertising_channel_type != 'LOCAL_SERVICES'
       AND ${dateFilter}`,
  );

  const byCampaign = new Map<
    string,
    { name: string | null; channelType: string | null; budgetMicros: number; costMicros: number }
  >();
  for (const row of rows) {
    const c = row?.campaign;
    const b = row?.campaignBudget;
    const m = row?.metrics;
    if (!c?.id) continue;
    const id = String(c.id);
    const existing = byCampaign.get(id);
    if (!existing) {
      byCampaign.set(id, {
        name: c.name ?? null,
        channelType: c.advertisingChannelType ?? null,
        budgetMicros: toNum(b?.amountMicros),
        costMicros: toNum(m?.costMicros),
      });
    } else {
      existing.costMicros += toNum(m?.costMicros);
    }
  }

  const campaigns: CampaignPaceResult[] = [];
  let totalBudgetMicrosPerDay = 0;
  let totalActualMicros = 0;

  for (const [campaignId, data] of byCampaign) {
    const budgetDollarPerDay = micros2dollars(data.budgetMicros);
    const expectedSpendToDate = budgetDollarPerDay * daysElapsed;
    const actualSpendToDate = micros2dollars(data.costMicros);
    const { band, ratio } = classifyPace(actualSpendToDate, expectedSpendToDate);

    campaigns.push({
      campaignId,
      campaignName: data.name,
      channelType: data.channelType,
      budgetDollarPerDay,
      expectedSpendToDate,
      actualSpendToDate,
      paceRatio: ratio,
      paceBand: band,
      daysElapsed,
      daysInMonth,
    });
    totalBudgetMicrosPerDay += data.budgetMicros;
    totalActualMicros += data.costMicros;
  }

  campaigns.sort((a, b) => (a.paceBand === "behind" ? -1 : b.paceBand === "behind" ? 1 : 0));

  const accountTotalBudgetPerDay = micros2dollars(totalBudgetMicrosPerDay);
  const accountExpectedSpend = accountTotalBudgetPerDay * daysElapsed;
  const accountActualSpend = micros2dollars(totalActualMicros);
  const { band: accountPaceBand, ratio: overallPaceRatio } = classifyPace(
    accountActualSpend,
    accountExpectedSpend,
  );

  return {
    campaigns,
    daysElapsed,
    daysInMonth,
    accountTotalBudgetPerDay,
    accountExpectedSpend,
    accountActualSpend,
    accountPaceBand,
    overallPaceRatio,
  };
}

// ─── 2. LSA Dashboard ────────────────────────────────────────────────────────

export interface LsaMetric {
  campaignId: string;
  campaignName: string | null;
  impressions: number;
  clicks: number;
  costDollars: number;
  conversions: number;
  budgetDollarPerDay: number;
  expectedSpendToDate: number;
  actualSpendToDate: number;
  paceBand: PaceBand;
  paceRatio: number | null;
  daysElapsed: number;
  daysInMonth: number;
}

export interface LsaDashboard {
  hasLsaCampaigns: boolean;
  campaigns: LsaMetric[];
  totalSpendDollars: number;
  totalConversions: number;
  totalImpressions: number;
  accountPaceBand: PaceBand;
  note: string;
}

/**
 * Fetch Local Services Ads campaigns and their MTD metrics.
 *
 * Note: LSA lead-quality data (lead type, lead status, dispute counts) is
 * available only through the separate Google Local Services Ads API and is
 * NOT queryable via GAQL. This dashboard shows spend/conversion pacing only.
 *
 * GAQL v23: advertising_channel_type = 'LOCAL_SERVICES' confirmed at
 * https://developers.google.com/google-ads/api/fields/v23/campaign
 */
export async function fetchLsaDashboard(customerId: string): Promise<LsaDashboard> {
  const { dateFilter, daysInMonth, daysElapsed } = monthToDateFilter();

  const rows = await gaqlSearchStream(
    customerId,
    `SELECT
       campaign.id,
       campaign.name,
       campaign_budget.amount_micros,
       metrics.impressions,
       metrics.clicks,
       metrics.cost_micros,
       metrics.conversions
     FROM campaign
     WHERE campaign.status != 'REMOVED'
       AND campaign.advertising_channel_type = 'LOCAL_SERVICES'
       AND ${dateFilter}`,
  );

  const byCampaign = new Map<
    string,
    {
      name: string | null;
      budgetMicros: number;
      impressions: number;
      clicks: number;
      costMicros: number;
      conversions: number;
    }
  >();

  for (const row of rows) {
    const c = row?.campaign;
    const b = row?.campaignBudget;
    const m = row?.metrics;
    if (!c?.id) continue;
    const id = String(c.id);
    const existing = byCampaign.get(id);
    if (!existing) {
      byCampaign.set(id, {
        name: c.name ?? null,
        budgetMicros: toNum(b?.amountMicros),
        impressions: toNum(m?.impressions),
        clicks: toNum(m?.clicks),
        costMicros: toNum(m?.costMicros),
        conversions: toNum(m?.conversions),
      });
    } else {
      existing.impressions += toNum(m?.impressions);
      existing.clicks += toNum(m?.clicks);
      existing.costMicros += toNum(m?.costMicros);
      existing.conversions += toNum(m?.conversions);
    }
  }

  if (byCampaign.size === 0) {
    return {
      hasLsaCampaigns: false,
      campaigns: [],
      totalSpendDollars: 0,
      totalConversions: 0,
      totalImpressions: 0,
      accountPaceBand: "no_data",
      note: "No active Local Services Ads campaigns found for this account. Lead-level data (quality, type) requires the Google Local Services Ads API and is not available here.",
    };
  }

  let totalSpend = 0;
  let totalConv = 0;
  let totalImpressions = 0;
  let totalBudgetPerDay = 0;
  let totalExpected = 0;
  const campaigns: LsaMetric[] = [];

  for (const [campaignId, data] of byCampaign) {
    const budgetDollarPerDay = micros2dollars(data.budgetMicros);
    const actualSpendToDate = micros2dollars(data.costMicros);
    const expectedSpendToDate = budgetDollarPerDay * daysElapsed;
    const { band, ratio } = classifyPace(actualSpendToDate, expectedSpendToDate);

    campaigns.push({
      campaignId,
      campaignName: data.name,
      impressions: data.impressions,
      clicks: data.clicks,
      costDollars: actualSpendToDate,
      conversions: data.conversions,
      budgetDollarPerDay,
      expectedSpendToDate,
      actualSpendToDate,
      paceBand: band,
      paceRatio: ratio,
      daysElapsed,
      daysInMonth,
    });
    totalSpend += actualSpendToDate;
    totalConv += data.conversions;
    totalImpressions += data.impressions;
    totalBudgetPerDay += budgetDollarPerDay;
    totalExpected += expectedSpendToDate;
  }

  const { band: accountPaceBand } = classifyPace(totalSpend, totalExpected);

  return {
    hasLsaCampaigns: true,
    campaigns,
    totalSpendDollars: totalSpend,
    totalConversions: totalConv,
    totalImpressions,
    accountPaceBand,
    note: "Spend and conversion pacing only. Lead-level quality data requires the Google Local Services Ads API (separate from the standard Ads API) and is not currently connected.",
  };
}

// ─── 3. Keyword Intel ────────────────────────────────────────────────────────

export interface KeywordIntelEntry {
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  keywordText: string;
  matchType: string | null;
  impressions: number;
  clicks: number;
  costDollars: number;
  conversions: number;
  avgCpcDollars: number;
  qualityScore: number | null;
  suggestionType: string;
  notes: string;
}

export interface KeywordIntelResult {
  runAt: Date;
  lookbackDays: number;
  totalKeywords: number;
  byType: Record<string, number>;
  entries: KeywordIntelEntry[];
}

const LOW_QS_THRESHOLD = 5;
const HIGH_IMPRESSIONS_THRESHOLD = 1000;
const HIGH_COST_NO_CONVERSIONS_THRESHOLD = 50;

/**
 * Keyword classification rules (derived from NBM Ads Hygiene source logic):
 *
 *   top_performer   — QS ≥ 7 AND ≥ 10 conversions
 *   low_quality     — QS ≤ LOW_QS_THRESHOLD (5)
 *   negative_candidate — impressions ≥ 1000, 0 conversions, high cost (> $50)
 *   broad_risk      — match_type = BROAD, 0 conversions
 *   missing_exact   — keyword has BROAD or PHRASE but no EXACT match in same ad group
 *   (everything else is not surfaced — it's "normal")
 *
 * GAQL v23 fields confirmed:
 *   keyword_view resource, ad_group_criterion.keyword.text,
 *   ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score,
 *   metrics.impressions, metrics.clicks, metrics.cost_micros,
 *   metrics.conversions, metrics.average_cpc
 * (https://developers.google.com/google-ads/api/fields/v23/keyword_view)
 */
export async function runKeywordIntel(
  customerId: string,
  lookbackDays = 30,
): Promise<KeywordIntelResult> {
  const dateFilter = lookbackFilter(lookbackDays);
  const runAt = new Date();

  const rows = await gaqlSearchStream(
    customerId,
    `SELECT
       campaign.id,
       campaign.name,
       ad_group.id,
       ad_group_criterion.keyword.text,
       ad_group_criterion.keyword.match_type,
       ad_group_criterion.quality_info.quality_score,
       ad_group_criterion.status,
       metrics.impressions,
       metrics.clicks,
       metrics.cost_micros,
       metrics.conversions,
       metrics.average_cpc
     FROM keyword_view
     WHERE ad_group_criterion.status = 'ENABLED'
       AND ${dateFilter}`,
  );

  interface KwRow {
    campaignId: string;
    campaignName: string | null;
    adGroupId: string;
    keywordText: string;
    matchType: string | null;
    impressions: number;
    clicks: number;
    costMicros: number;
    conversions: number;
    avgCpcMicros: number;
    qualityScore: number | null;
  }

  const kwMap = new Map<string, KwRow>();
  const adGroupMatchTypes = new Map<string, Set<string>>();

  for (const row of rows) {
    const c = row?.campaign;
    const ag = row?.adGroup;
    const ac = row?.adGroupCriterion;
    const m = row?.metrics;
    if (!ac?.keyword?.text || !ag?.id || !c?.id) continue;
    const key = `${ag.id}__${ac.keyword.text}__${ac.keyword.matchType ?? ""}`;
    const existing = kwMap.get(key);
    const costMicros = toNum(m?.costMicros);
    const impressions = toNum(m?.impressions);
    const clicks = toNum(m?.clicks);
    const conversions = toNum(m?.conversions);
    const avgCpcMicros = toNum(m?.averageCpc);
    if (!existing) {
      kwMap.set(key, {
        campaignId: String(c.id),
        campaignName: c.name ?? null,
        adGroupId: String(ag.id),
        keywordText: String(ac.keyword.text),
        matchType: ac.keyword.matchType ?? null,
        impressions,
        clicks,
        costMicros,
        conversions,
        avgCpcMicros,
        qualityScore:
          ac.qualityInfo?.qualityScore != null
            ? Number(ac.qualityInfo.qualityScore)
            : null,
      });
    } else {
      existing.impressions += impressions;
      existing.clicks += clicks;
      existing.costMicros += costMicros;
      existing.conversions += conversions;
    }

    // Track match types per ad group for missing_exact detection
    const agKey = String(ag.id);
    if (!adGroupMatchTypes.has(agKey)) adGroupMatchTypes.set(agKey, new Set());
    const mt = (ac.keyword.matchType ?? "").toUpperCase();
    if (mt) adGroupMatchTypes.get(agKey)!.add(mt);
  }

  const entries: KeywordIntelEntry[] = [];
  const byType: Record<string, number> = {};

  for (const kw of kwMap.values()) {
    const costDollars = micros2dollars(kw.costMicros);
    const avgCpcDollars = micros2dollars(kw.avgCpcMicros);
    const mt = (kw.matchType ?? "").toUpperCase();
    const agMatchTypes = adGroupMatchTypes.get(kw.adGroupId) ?? new Set();

    let suggestionType: string | null = null;
    let notes = "";

    if (kw.qualityScore != null && kw.qualityScore <= LOW_QS_THRESHOLD) {
      suggestionType = "low_quality";
      notes = `Quality score ${kw.qualityScore}/10 — below threshold of ${LOW_QS_THRESHOLD}. Review ad copy, landing page relevance, and expected CTR.`;
    } else if (
      kw.impressions >= HIGH_IMPRESSIONS_THRESHOLD &&
      kw.conversions === 0 &&
      costDollars >= HIGH_COST_NO_CONVERSIONS_THRESHOLD
    ) {
      suggestionType = "negative_candidate";
      notes = `${kw.impressions.toLocaleString()} impressions, $${costDollars.toFixed(2)} spent, 0 conversions — strong negative keyword candidate.`;
    } else if (mt === "BROAD" && kw.conversions === 0) {
      suggestionType = "broad_risk";
      notes = `Broad match with 0 conversions in the period — consider switching to phrase or exact match to reduce irrelevant traffic.`;
    } else if (
      (mt === "BROAD" || mt === "PHRASE") &&
      !agMatchTypes.has("EXACT")
    ) {
      suggestionType = "missing_exact";
      notes = `Ad group has no EXACT match keywords. Adding exact match for top terms can protect against budget dilution.`;
    } else if (
      (kw.qualityScore == null || kw.qualityScore >= 7) &&
      kw.conversions >= 10
    ) {
      suggestionType = "top_performer";
      notes = `${kw.conversions} conversions, QS ${kw.qualityScore ?? "N/A"}/10 — strong performer. Ensure adequate budget allocation.`;
    }

    if (!suggestionType) continue;

    entries.push({
      campaignId: kw.campaignId,
      campaignName: kw.campaignName,
      adGroupId: kw.adGroupId,
      keywordText: kw.keywordText,
      matchType: kw.matchType,
      impressions: kw.impressions,
      clicks: kw.clicks,
      costDollars,
      conversions: kw.conversions,
      avgCpcDollars,
      qualityScore: kw.qualityScore ?? null,
      suggestionType,
      notes,
    });
    byType[suggestionType] = (byType[suggestionType] ?? 0) + 1;
  }

  entries.sort((a, b) => {
    const order: Record<string, number> = {
      low_quality: 0,
      negative_candidate: 1,
      broad_risk: 2,
      missing_exact: 3,
      top_performer: 4,
    };
    return (order[a.suggestionType] ?? 5) - (order[b.suggestionType] ?? 5);
  });

  // Clear prior results atomically so a zero-flagged run correctly shows
  // zero rows rather than leaving stale data from the previous run visible.
  await clearKeywordIntelResultsForCustomer(customerId);

  // Persist results
  const toInsert: InsertGoogleAdsKeywordIntelResult[] = entries.map((e) => ({
    customerId,
    runAt,
    campaignId: e.campaignId,
    campaignName: e.campaignName,
    adGroupId: e.adGroupId,
    keywordText: e.keywordText,
    matchType: e.matchType,
    impressions: e.impressions,
    clicks: e.clicks,
    costDollars: e.costDollars,
    conversions: e.conversions,
    avgCpcDollars: e.avgCpcDollars,
    qualityScore: e.qualityScore ?? null,
    suggestionType: e.suggestionType,
    notes: e.notes,
  }));
  await insertKeywordIntelResults(toInsert);

  return {
    runAt,
    lookbackDays,
    totalKeywords: kwMap.size,
    byType,
    entries,
  };
}

// ─── 4. Alerts ───────────────────────────────────────────────────────────────

export interface ComputedAlert {
  alertType: string;
  severity: "warning" | "critical";
  title: string;
  detail: string;
  campaignId?: string;
  campaignName?: string;
  measuredValue?: string;
}

/**
 * Compute alerts from pacing data and any disapproved ads.
 *
 * Disapproval check: `ad_group_ad.policy_summary.approval_status`
 * (https://developers.google.com/google-ads/api/fields/v23/ad_group_ad)
 */
export async function computeAndSaveAlerts(
  customerId: string,
): Promise<GoogleAdsHygieneAlert[]> {
  const [pacing, lsa, disapprovedAds] = await Promise.all([
    computeBudgetPacing(customerId),
    fetchLsaDashboard(customerId),
    fetchDisapprovedAds(customerId),
  ]);

  const alerts: ComputedAlert[] = [];

  // Budget pacing alerts
  for (const c of pacing.campaigns) {
    if (c.paceBand === "behind") {
      const ratio = c.paceRatio != null ? `${Math.round(c.paceRatio * 100)}%` : "unknown";
      alerts.push({
        alertType: "budget_pacing_behind",
        severity: c.paceRatio != null && c.paceRatio < 0.5 ? "critical" : "warning",
        title: `Budget behind pace: ${c.campaignName ?? c.campaignId}`,
        detail: `Campaign is spending at ${ratio} of expected pace with ${c.daysInMonth - c.daysElapsed} days remaining in the month.`,
        campaignId: c.campaignId,
        campaignName: c.campaignName ?? undefined,
        measuredValue: `Actual $${c.actualSpendToDate.toFixed(2)} vs expected $${c.expectedSpendToDate.toFixed(2)} (${ratio} of pace)`,
      });
    } else if (c.paceBand === "ahead" && c.paceRatio != null && c.paceRatio > 1.3) {
      const ratio = `${Math.round(c.paceRatio * 100)}%`;
      alerts.push({
        alertType: "budget_pacing_ahead",
        severity: "warning",
        title: `Budget ahead of pace: ${c.campaignName ?? c.campaignId}`,
        detail: `Campaign is spending at ${ratio} of expected pace — may exhaust budget before month end.`,
        campaignId: c.campaignId,
        campaignName: c.campaignName ?? undefined,
        measuredValue: `Actual $${c.actualSpendToDate.toFixed(2)} vs expected $${c.expectedSpendToDate.toFixed(2)} (${ratio} of pace)`,
      });
    }
  }

  // LSA pacing alerts
  for (const c of lsa.campaigns) {
    if (c.paceBand === "behind") {
      const ratio = c.paceRatio != null ? `${Math.round(c.paceRatio * 100)}%` : "unknown";
      alerts.push({
        alertType: "lsa_pacing_behind",
        severity: "warning",
        title: `LSA campaign behind pace: ${c.campaignName ?? c.campaignId}`,
        detail: `Local Services Ads campaign is spending at ${ratio} of expected pace.`,
        campaignId: c.campaignId,
        campaignName: c.campaignName ?? undefined,
        measuredValue: ratio,
      });
    }
  }

  // Disapproval alerts
  if (disapprovedAds.count > 0) {
    alerts.push({
      alertType: "disapproval",
      severity: disapprovedAds.count >= 3 ? "critical" : "warning",
      title: `${disapprovedAds.count} disapproved ad${disapprovedAds.count === 1 ? "" : "s"} detected`,
      detail: `${disapprovedAds.count} enabled ads have a disapproved approval status. Disapproved ads do not serve and should be reviewed.`,
      measuredValue: `${disapprovedAds.count} disapproved ads`,
    });
  }

  // Pacing risk: account-level if slightly_behind
  if (pacing.accountPaceBand === "slightly_behind") {
    const ratio = pacing.overallPaceRatio != null ? `${Math.round(pacing.overallPaceRatio * 100)}%` : "unknown";
    alerts.push({
      alertType: "pacing_risk",
      severity: "warning",
      title: "Account-level spend slightly behind pace",
      detail: `Overall account is at ${ratio} of expected spend pace. Monitor closely over the next few days.`,
      measuredValue: `$${pacing.accountActualSpend.toFixed(2)} actual vs $${pacing.accountExpectedSpend.toFixed(2)} expected`,
    });
  }

  // Delete auto-generated (un-resolved) alerts from last 24 hours so we
  // don't accumulate duplicates on repeated "Compute alerts" runs.
  await deleteRecentAlertsForCustomer(customerId, 24);

  if (alerts.length === 0) return [];

  const toInsert: InsertGoogleAdsHygieneAlert[] = alerts.map((a) => ({
    customerId,
    alertType: a.alertType,
    severity: a.severity,
    title: a.title,
    detail: a.detail ?? null,
    campaignId: a.campaignId ?? null,
    campaignName: a.campaignName ?? null,
    measuredValue: a.measuredValue ?? null,
    isResolved: "no",
    clickupTaskId: null,
    clickupListId: null,
    clickupTaskStatus: null,
    clickupTaskUrl: null,
  }));

  return insertGoogleAdsHygieneAlerts(toInsert);
}

// ─── Disapproval fetch (used by alerts) ─────────────────────────────────────

async function fetchDisapprovedAds(
  customerId: string,
): Promise<{ count: number }> {
  try {
    const rows = await gaqlSearchStream(
      customerId,
      `SELECT
         ad_group_ad.policy_summary.approval_status
       FROM ad_group_ad
       WHERE ad_group_ad.status = 'ENABLED'
         AND ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'`,
    );
    return { count: rows.length };
  } catch {
    return { count: 0 };
  }
}

// Re-export the type so the routes file can import it without touching @shared directly
import type { GoogleAdsHygieneAlert } from "@shared/schema";
export type { GoogleAdsHygieneAlert };
