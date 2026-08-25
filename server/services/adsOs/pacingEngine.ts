/**
 * Ads OS — Budget Pacing engine (port of backend/app/budget_pacing/engine.py
 * + queries.py, and the refresh orchestrators from dashboard.py).
 *
 * Gate -> resolve budget -> pull spend -> compute pacing. Mirrors the dashboard
 * discipline: a 1-hour per-account cache with per-key single-flight. Pacing is
 * schedule-aware — only the weekdays ads are set to run count toward the month
 * fraction, so a weekday-only client isn't judged as if it spends 7 days a week.
 *
 * Every cached run persists a dashboard-facing summary to the pacing store
 * (ads_os_budget_pacing), which the dashboards overlay LIVE on each request.
 */

import { adsOsGaqlSearch, AdsOsApiError } from "./googleAdsClient";
import { AUDIT_CACHE_TTL_SECONDS, KI_CAMPAIGN_LABEL } from "./config";
import { KeyedLocks, mapPool } from "./singleflight";
import {
  enrolledAccounts,
  labeledCampaignIds,
  mccEnabledAccounts,
  type MccAccounts,
} from "./enrollment";
import { getSheetBudgets, type SheetBudget } from "./budgetSource";
import { loadCriteria } from "./criteriaService";
import { budgetPacingStore } from "./store";
import type { PlainDate } from "./dateRange";
import { addDays, isoDate, plainToday } from "./dateRange";
import type { BudgetPacingReport, CampaignPacingRow, DayPoint } from "./types";

// Python date.weekday(): Mon=0 .. Sun=6 (the bundle's convention; JS getDay()
// is Sun=0 .. Sat=6, converted in pyWeekday below).
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function normCid(customerId: string): string {
  return customerId.replace(/-/g, "").trim().replace(/[^0-9]/g, "");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function micros(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n ? n / 1e6 : 0;
}

/** Python-style weekday (Mon=0..Sun=6) for a PlainDate. */
export function pyWeekday(y: number, m: number, d: number): number {
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

function daysInMonthOf(y: number, m: number): number {
  return new Date(y, m, 0).getDate(); // day 0 of the NEXT month (m is 1-based)
}

/** Weekday indices ads run. Empty/unrecognised -> every day (so math is defined). */
export function scheduledIndices(scheduleDays: string[]): Set<number> {
  const nameToIdx = new Map(WEEKDAYS.map((n, i) => [n.toLowerCase(), i]));
  const idx = new Set<number>();
  for (const d of scheduleDays) {
    const i = nameToIdx.get(d.trim().toLowerCase());
    if (i !== undefined) idx.add(i);
  }
  return idx.size > 0 ? idx : new Set([0, 1, 2, 3, 4, 5, 6]);
}

export interface PacingMath {
  expected_to_date: number | null;
  on_off_track_pct: number | null;
  recommended_daily_budget: number | null;
  avg_daily_spend_mtd: number;
  scheduled_days_elapsed: number;
  total_scheduled_days: number;
  days_in_month: number;
}

/**
 * Pure pacing math, shared by the full report, the LSA engine and the dashboard
 * column. Window is month-start..yesterday (today's partial day excluded). On
 * the 1st, nothing has elapsed yet, so pace % is undefined but the recommended
 * daily and totals are still meaningful.
 */
export function computePacing(
  monthlyBudget: number | null,
  mtdSpend: number,
  scheduleDays: string[],
  today?: PlainDate,
): PacingMath {
  const t = today ?? plainToday();
  const daysInMonth = daysInMonthOf(t.y, t.m);
  const sched = scheduledIndices(scheduleDays);
  const isSched = (day: number): boolean => sched.has(pyWeekday(t.y, t.m, day));

  let totalScheduled = 0;
  for (let d = 1; d <= daysInMonth; d++) if (isSched(d)) totalScheduled++;
  const elapsedLast = t.d - 1; // through yesterday, this month
  let scheduledElapsed = 0;
  for (let d = 1; d <= elapsedLast; d++) if (isSched(d)) scheduledElapsed++;

  const avgDaily = scheduledElapsed > 0 ? mtdSpend / scheduledElapsed : 0;

  let expected: number | null = null;
  let pct: number | null = null;
  let recommended: number | null = null;
  if (monthlyBudget !== null && totalScheduled > 0) {
    expected = (monthlyBudget * scheduledElapsed) / totalScheduled;
    if (expected > 0) pct = (mtdSpend / expected - 1) * 100;
    const remaining = totalScheduled - scheduledElapsed;
    recommended = remaining > 0 ? (monthlyBudget - mtdSpend) / remaining : null;
  }

  return {
    expected_to_date: expected !== null ? round2(expected) : null,
    on_off_track_pct: pct !== null ? round1(pct) : null,
    recommended_daily_budget: recommended !== null ? round2(recommended) : null,
    avg_daily_spend_mtd: round2(avgDaily),
    scheduled_days_elapsed: scheduledElapsed,
    total_scheduled_days: totalScheduled,
    days_in_month: daysInMonth,
  };
}

/**
 * Baseline daily budget = monthly budget ÷ total scheduled days in the month —
 * what the platform's daily budget SHOULD be set to from the monthly budget
 * alone (Task #3903). Unlike recommended_daily (corrective: remaining budget ÷
 * remaining scheduled days) the baseline never depends on MTD spend, so it's
 * stable on the 1st of the month when pacing itself reads "Not started".
 * Pure; null without a budget or scheduled days (never a fake $0).
 */
export function baselineDailyBudget(
  monthlyBudget: number | null,
  totalScheduledDays: number,
): number | null {
  if (monthlyBudget === null || totalScheduledDays <= 0) return null;
  return round2(monthlyBudget / totalScheduledDays);
}

/**
 * (monthly_budget, source). Budgets come from the ClickUp Client List map
 * returned by getSheetBudgets. No positive per-product value = no budget.
 */
export function resolveBudget(
  budgets: Map<string, SheetBudget>,
  cid: string,
): { budget: number | null; source: string } {
  const sb = budgets.get(cid);
  if (sb && sb.gads > 0) {
    return { budget: round2(sb.gads), source: "clickup" };
  }
  return { budget: null, source: "none" };
}

/** Month window: [month-start, yesterday]. On the 1st, end < start (empty). */
export function monthWindow(today?: PlainDate): { monthStart: PlainDate; endDate: PlainDate } {
  const t = today ?? plainToday();
  return { monthStart: { y: t.y, m: t.m, d: 1 }, endDate: addDays(t, -1) };
}

// ---------------------------------------------------------------------------
// Schedule inference (Task #3706)
//
// Most accounts never save criteria, so their schedule defaulted to "every
// day" — and a weekday-only account read −100% "far behind" every weekend and
// month-start weekend (Aug 1–2 2026 was the trigger). When no schedule is
// saved, infer the serving days from the last ~4 weeks of actual daily spend;
// saved criteria always win, and an ambiguous pattern falls back to every day.
// ---------------------------------------------------------------------------

export type ScheduleSource = "saved" | "inferred" | "default";

export interface ResolvedSchedule {
  /** WEEKDAYS names; empty = every day (the store's canonical "no restriction"). */
  days: string[];
  source: ScheduleSource;
}

/** How far back the inference looks (days, ending yesterday). */
export const INFERENCE_WINDOW_DAYS = 28;
/** Minimum observed days (from first spend) before trusting a pattern. */
export const INFERENCE_MIN_ACTIVE_DAYS = 14;
/** A weekday is "on" when it spent on at least this share of its occurrences. */
export const INFERENCE_DAY_RATIO = 0.5;
/** Ignore sub-cent noise when deciding whether a day "spent". */
const INFERENCE_MIN_DAY_SPEND = 0.01;

/**
 * Infer serving days from per-day spend over [windowStart, windowEnd]. Pure.
 *
 * - No spend at all, or fewer than INFERENCE_MIN_ACTIVE_DAYS observed days
 *   (counted from the first spend day, so a brand-new account's pre-launch
 *   zeros don't read as "scheduled off") → default (every day).
 * - A weekday is ON when it spent ≥$0.01 on ≥50% of its occurrences. Losing
 *   every weekday to that bar (e.g. spend so sparse nothing qualifies) →
 *   default. All 7 qualifying → inferred every-day (canonical empty list).
 */
export function inferScheduleDays(
  daily: Map<string, number>,
  windowStart: PlainDate,
  windowEnd: PlainDate,
): ResolvedSchedule {
  const everyDay: ResolvedSchedule = { days: [], source: "default" };
  const startIso = isoDate(windowStart);
  const endIso = isoDate(windowEnd);
  if (endIso < startIso) return everyDay;

  let firstSpendIso: string | null = null;
  for (const [iso, v] of daily) {
    if (v >= INFERENCE_MIN_DAY_SPEND && iso >= startIso && iso <= endIso) {
      if (firstSpendIso === null || iso < firstSpendIso) firstSpendIso = iso;
    }
  }
  if (firstSpendIso === null) return everyDay;

  const occurrences = new Array<number>(7).fill(0);
  const spendDays = new Array<number>(7).fill(0);
  let observed = 0;
  for (let day = windowStart; isoDate(day) <= endIso; day = addDays(day, 1)) {
    const iso = isoDate(day);
    if (iso < firstSpendIso) continue;
    const wd = pyWeekday(day.y, day.m, day.d);
    occurrences[wd]++;
    observed++;
    if ((daily.get(iso) ?? 0) >= INFERENCE_MIN_DAY_SPEND) spendDays[wd]++;
  }
  if (observed < INFERENCE_MIN_ACTIVE_DAYS) return everyDay;

  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (occurrences[i] > 0 && spendDays[i] / occurrences[i] >= INFERENCE_DAY_RATIO) {
      days.push(WEEKDAYS[i]);
    }
  }
  if (days.length === 0) return everyDay;
  if (days.length === 7) return { days: [], source: "inferred" };
  return { days, source: "inferred" };
}

/** Saved schedule wins; otherwise infer from spend. */
export function resolveSchedule(
  savedDays: string[],
  daily: Map<string, number>,
  windowStart: PlainDate,
  windowEnd: PlainDate,
): ResolvedSchedule {
  if (savedDays.length > 0) return { days: savedDays, source: "saved" };
  return inferScheduleDays(daily, windowStart, windowEnd);
}

/**
 * Dashboard-column status for a persisted pacing-store doc. "not_started" is
 * the neutral early-month state: a real budget, pace % undefined, and the doc
 * SAYS zero scheduled days have elapsed — as opposed to a doc that predates
 * the elapsed field or a failed pull (both stay "unknown" / "—").
 */
export type PacingDocStatus =
  | "mbh"
  | "overspend"
  | "on_track"
  | "underspend"
  | "not_started"
  | "unknown";

export function pacingDocStatus(doc: Record<string, any>): PacingDocStatus {
  const budget = typeof doc.monthly_budget === "number" ? doc.monthly_budget : null;
  const mtd = typeof doc.mtd_spend === "number" ? doc.mtd_spend : null;
  const pct = typeof doc.budget_pacing_pct === "number" ? doc.budget_pacing_pct : null;
  if (budget !== null && budget > 0 && mtd !== null && mtd >= budget) return "mbh";
  if (pct === null) {
    return budget !== null && doc.scheduled_days_elapsed === 0 ? "not_started" : "unknown";
  }
  if (pct > 0) return "overspend";
  if (pct >= -5) return "on_track";
  return "underspend";
}

/** Membership test against the ENROLLED set (incl. Off — see refreshAllPacing). */
async function isAccountEnrolled(cid: string, mcc: MccAccounts): Promise<boolean> {
  const accounts = await enrolledAccounts("gads", mcc);
  return accounts.some((a) => a.cid === cid);
}

// ---------------------------------------------------------------------------
// GAQL pulls (port of budget_pacing/queries.py) — read-only, scoped to the
// labeled campaigns. Independent queries run concurrently; a failing query is
// isolated into a warning instead of sinking the run.
// ---------------------------------------------------------------------------

interface CampaignBudgetRow {
  campaign_id: string;
  name: string;
  daily_budget: number;
  status: string;
}

interface CampaignMetricRow {
  campaign_id: string;
  cost: number;
  impressions: number;
  impr_share: number | null;
  lost_is_budget: number | null;
  lost_is_rank: number | null;
}

interface PacingData {
  budgets: CampaignBudgetRow[];
  metrics: CampaignMetricRow[];
  warnings: string[];
}

/** Run one labeled query; an Ads API error becomes a "label: msg" warning. */
async function tryQuery(
  cid: string,
  label: string,
  query: string,
): Promise<{ rows: any[]; warning: string | null }> {
  try {
    return { rows: await adsOsGaqlSearch(cid, query), warning: null };
  } catch (err) {
    if (err instanceof AdsOsApiError) {
      return { rows: [], warning: `${label}: ${err.message}` };
    }
    throw err; // creds-missing / non-Ads errors propagate
  }
}

/**
 * Current daily budgets + MTD spend/impression-share for the labeled campaigns.
 * Spend is pulled for the labeled campaigns REGARDLESS of status: a campaign
 * paused mid-month still spent money this month, and that spend must count.
 */
export async function fetchPacingData(
  customerId: string,
  campaignIds: string[],
  monthStart: PlainDate,
  endDate: PlainDate,
): Promise<PacingData> {
  const cid = normCid(customerId);
  const campIn = `campaign.id IN (${campaignIds.join(", ")})`;
  const dateClause = `segments.date BETWEEN '${isoDate(monthStart)}' AND '${isoDate(endDate)}'`;

  const [budgetsQ, metricsQ] = await Promise.all([
    tryQuery(
      cid,
      "budgets",
      "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros " +
        `FROM campaign WHERE ${campIn}`,
    ),
    // IS metrics aggregate over the date range when segments.date isn't selected.
    tryQuery(
      cid,
      "metrics",
      "SELECT campaign.id, metrics.cost_micros, metrics.impressions, " +
        "metrics.search_impression_share, metrics.search_budget_lost_impression_share, " +
        "metrics.search_rank_lost_impression_share " +
        `FROM campaign WHERE ${campIn} AND ${dateClause}`,
    ),
  ]);

  const data: PacingData = { budgets: [], metrics: [], warnings: [] };
  for (const w of [budgetsQ.warning, metricsQ.warning]) if (w) data.warnings.push(w);

  for (const row of budgetsQ.rows) {
    data.budgets.push({
      campaign_id: String(row.campaign?.id ?? ""),
      name: String(row.campaign?.name ?? ""),
      daily_budget: micros(row.campaignBudget?.amountMicros),
      status: row.campaign?.status ? String(row.campaign.status) : "UNKNOWN",
    });
  }

  for (const row of metricsQ.rows) {
    const m = row.metrics ?? {};
    const impressions = Number(m.impressions ?? 0);
    // search_impression_share is only meaningful with search impressions.
    const hasIs = impressions > 0;
    data.metrics.push({
      campaign_id: String(row.campaign?.id ?? ""),
      cost: micros(m.costMicros),
      impressions,
      impr_share: hasIs ? Number(m.searchImpressionShare ?? 0) : null,
      lost_is_budget: hasIs ? Number(m.searchBudgetLostImpressionShare ?? 0) : null,
      lost_is_rank: hasIs ? Number(m.searchRankLostImpressionShare ?? 0) : null,
    });
  }

  return data;
}

/**
 * Just the month-to-date spend across the labeled campaigns — one query. Used
 * by the dashboard pacing column (spend counts regardless of campaign status).
 * Errors propagate (computePacingSummary wraps them into all-null).
 */
export async function fetchMtdSpend(
  customerId: string,
  campaignIds: string[],
  monthStart: PlainDate,
  endDate: PlainDate,
): Promise<number> {
  const cid = normCid(customerId);
  const query =
    "SELECT campaign.id, metrics.cost_micros FROM campaign " +
    `WHERE campaign.id IN (${campaignIds.join(", ")}) ` +
    `AND segments.date BETWEEN '${isoDate(monthStart)}' AND '${isoDate(endDate)}'`;
  let total = 0;
  for (const row of await adsOsGaqlSearch(cid, query)) total += micros(row.metrics?.costMicros);
  return round2(total);
}

/**
 * Per-day monitored-campaign spend (iso date -> spend) for the daily chart and
 * schedule inference. Best-effort by default: an Ads error yields {} so the
 * chart just renders empty. Pass `{strict: true}` when the caller must be able
 * to tell "no spend" apart from "pull failed" (the dashboard summary does — a
 * swallowed error must not become a fake $0 month, Task #3706).
 */
export async function fetchDailySpend(
  customerId: string,
  campaignIds: string[],
  monthStart: PlainDate,
  endDate: PlainDate,
  opts?: { strict?: boolean },
): Promise<Map<string, number>> {
  const cid = normCid(customerId);
  const query =
    "SELECT segments.date, metrics.cost_micros FROM campaign " +
    `WHERE campaign.id IN (${campaignIds.join(", ")}) ` +
    `AND segments.date BETWEEN '${isoDate(monthStart)}' AND '${isoDate(endDate)}'`;
  const out = new Map<string, number>();
  try {
    for (const row of await adsOsGaqlSearch(cid, query)) {
      const d = String(row.segments?.date ?? "");
      if (!d) continue;
      out.set(d, (out.get(d) ?? 0) + micros(row.metrics?.costMicros));
    }
  } catch (err) {
    if (err instanceof AdsOsApiError && !opts?.strict) return new Map();
    throw err;
  }
  for (const [k, v] of out) out.set(k, round2(v));
  return out;
}

// ---------------------------------------------------------------------------
// Full report
// ---------------------------------------------------------------------------

export async function runBudgetPacing(customerId: string): Promise<BudgetPacingReport> {
  const cid = normCid(customerId);

  const mcc = await mccEnabledAccounts(); // creds/Ads errors propagate to the route
  const acct = mcc.get(cid);
  const accountName = acct?.name ?? cid;
  const currency = acct?.currency ?? null;

  const ineligible = (note: string, campaigns = 0): BudgetPacingReport => ({
    customer_id: cid,
    account_name: accountName,
    currency_code: currency,
    generated_at: new Date().toISOString(),
    monthly_budget: null,
    budget_source: "none",
    budget_authoritative: false,
    mtd_spend: 0,
    on_off_track_pct: null,
    recommended_daily_budget: null,
    baseline_daily_budget: null,
    avg_daily_spend_mtd: 0,
    expected_to_date: null,
    schedule_days: [],
    schedule_source: "default",
    scheduled_days_elapsed: 0,
    total_scheduled_days: 0,
    days_in_month: 0,
    campaigns: [],
    daily_spend: [],
    eligible: false,
    monitored_campaigns: campaigns,
    scope_note: note,
    has_criteria: false,
    warnings: [],
    from_cache: false,
  });

  // Scope gate (same enrollment as the dashboards). Off accounts stay eligible
  // on demand — the pacing refresh runs them so a recently-off account's budget
  // still counts on the Main dashboard while it has spend.
  if (!(await isAccountEnrolled(cid, mcc))) {
    return ineligible(
      "This account isn't enrolled. Add it to the ClickUp Client List (a subtask " +
        "with this account's Google CID) to include it in Budget Pacing.",
    );
  }
  // Resolve the configured budget BEFORE the label gate (Task #4975): an
  // enrolled account with no labeled campaigns yet (onboarding — e.g. a
  // ClickUp Google Ads subtask sharing its LSA sibling's CID) still has a
  // real ClickUp/sheet budget. The ineligible report must carry it so
  // persistSummary writes a budget-only row and the dashboards show the
  // budget (with dashes for spend) instead of "no budget configured".
  const {
    budgets: sheetBudgets,
    warning: sheetWarning,
    authoritative: budgetAuthoritative,
  } = await getSheetBudgets();
  const { budget: monthlyBudget, source } = resolveBudget(sheetBudgets, cid);

  const campaignIds = await labeledCampaignIds(cid, KI_CAMPAIGN_LABEL);
  if (!campaignIds.length) {
    return {
      ...ineligible(
        `No campaigns carry the '${KI_CAMPAIGN_LABEL}' label in this ` +
          "account. Label the monitored campaigns to track their pacing.",
      ),
      monthly_budget: monthlyBudget,
      budget_source: source,
      budget_authoritative: budgetAuthoritative,
    };
  }

  const { criteria, hasSaved } = await loadCriteria(cid);

  const { monthStart, endDate } = monthWindow();
  // Daily spend feeds the chart AND schedule inference, so pull it over the
  // wider of the month window and the inference window (Task #3706). Stays
  // best-effort here: a swallowed Ads error empties the chart and leaves the
  // schedule on the every-day default (the run already carries warnings).
  const today = plainToday();
  const infStart = addDays(today, -INFERENCE_WINDOW_DAYS);
  const infEnd = endDate; // yesterday
  const fetchStart = isoDate(infStart) < isoDate(monthStart) ? infStart : monthStart;
  const [data, dailyMap] = await Promise.all([
    fetchPacingData(cid, campaignIds, monthStart, endDate),
    fetchDailySpend(cid, campaignIds, fetchStart, endDate),
  ]);
  const metricsById = new Map(data.metrics.map((m) => [m.campaign_id, m]));

  // No saved schedule → infer serving days from recent actual spend, so a
  // weekday-only account isn't judged as if it spends 7 days a week (#3706).
  const schedule = resolveSchedule(criteria.schedule_days, dailyMap, infStart, infEnd);

  const mtdSpend = round2(data.metrics.reduce((acc, m) => acc + m.cost, 0));
  const math = computePacing(monthlyBudget, mtdSpend, schedule.days);
  const elapsed = math.scheduled_days_elapsed;

  const campaigns: CampaignPacingRow[] = [];
  for (const b of data.budgets) {
    const m = metricsById.get(b.campaign_id);
    const spend = m ? round2(m.cost) : 0;
    const impressions = m ? m.impressions : 0;
    // Show every currently-enabled campaign, plus any campaign (paused/removed)
    // that actually spent or served this month. Skip idle non-enabled ones so
    // the table isn't cluttered with long-dormant campaigns.
    if (b.status !== "ENABLED" && spend <= 0 && impressions <= 0) continue;
    campaigns.push({
      campaign_id: b.campaign_id,
      name: b.name,
      status: b.status,
      current_daily_budget: round2(b.daily_budget),
      mtd_spend: spend,
      avg_daily_spend_mtd: elapsed > 0 ? round2(spend / elapsed) : 0,
      impr_share: m ? m.impr_share : null,
      search_lost_is_budget: m ? m.lost_is_budget : null,
      search_lost_is_rank: m ? m.lost_is_rank : null,
    });
  }
  campaigns.sort((a, b) => b.mtd_spend - a.mtd_spend);

  // Daily spend vs schedule-aware target (month to date; dailyMap may reach
  // back further for inference — the loop below only walks the month window).
  const sched = scheduledIndices(schedule.days);
  const perSchedTarget =
    monthlyBudget !== null && math.total_scheduled_days > 0
      ? monthlyBudget / math.total_scheduled_days
      : null;
  const dailyPoints: DayPoint[] = [];
  for (let day = monthStart; isoDate(day) <= isoDate(endDate); day = addDays(day, 1)) {
    const iso = isoDate(day);
    let target: number | null = null;
    if (perSchedTarget !== null) {
      target = sched.has(pyWeekday(day.y, day.m, day.d)) ? round2(perSchedTarget) : 0;
    }
    dailyPoints.push({ date: iso, spend: dailyMap.get(iso) ?? 0, target });
  }

  const warnings = [...data.warnings];
  if (sheetWarning) warnings.push(sheetWarning);

  return {
    customer_id: cid,
    account_name: accountName,
    currency_code: currency,
    generated_at: new Date().toISOString(),
    monthly_budget: monthlyBudget,
    budget_source: source,
    budget_authoritative: budgetAuthoritative,
    mtd_spend: mtdSpend,
    on_off_track_pct: math.on_off_track_pct,
    recommended_daily_budget: math.recommended_daily_budget,
    baseline_daily_budget: baselineDailyBudget(monthlyBudget, math.total_scheduled_days),
    avg_daily_spend_mtd: math.avg_daily_spend_mtd,
    expected_to_date: math.expected_to_date,
    schedule_days: schedule.days,
    schedule_source: schedule.source,
    scheduled_days_elapsed: math.scheduled_days_elapsed,
    total_scheduled_days: math.total_scheduled_days,
    days_in_month: math.days_in_month,
    campaigns,
    daily_spend: dailyPoints,
    eligible: true,
    monitored_campaigns: campaignIds.length,
    scope_note: `Tracking ${campaignIds.length} labeled campaign(s).`,
    has_criteria: hasSaved,
    warnings,
    from_cache: false,
  };
}

// ---------------------------------------------------------------------------
// Dashboard summary + persistence
// ---------------------------------------------------------------------------

export interface PacingSummary {
  budget: number | null;
  /** Where the budget came from — "clickup" | "sheet" | "none" (Task #3897:
   *  persisted so the combined pill can name the source per account). */
  budget_source: string;
  mtd: number | null;
  pct: number | null;
  recommended: number | null;
  expected: number | null;
  /** Applied schedule (empty = every day) + where it came from (Task #3706). */
  schedule_days: string[];
  schedule_source: ScheduleSource;
  /** null = unknown (failed/ineligible pull) — distinct from a real 0 ("no
   *  scheduled day has elapsed yet"), which drives the neutral column state. */
  scheduled_days_elapsed: number | null;
  total_scheduled_days: number | null;
}

const NULL_SUMMARY: PacingSummary = {
  budget: null,
  budget_source: "none",
  mtd: null,
  pct: null,
  recommended: null,
  expected: null,
  schedule_days: [],
  schedule_source: "default",
  scheduled_days_elapsed: null,
  total_scheduled_days: null,
};

/**
 * Lightweight (budget, mtd, pct, recommended_daily, expected_to_date) for the
 * dashboard column + hover. `expected` is the schedule-aware spend a client
 * should have reached by now; the Main Dashboard blends GAds + LSA pacing by
 * summing each product's expected. Shares the already-fetched budget map; one
 * extra metrics query per account. Pass `campaignIds` to reuse an already-
 * resolved labeled-campaign set. Best-effort: any failure yields all-null.
 */
export async function computePacingSummary(
  customerId: string,
  sheetBudgets: Map<string, SheetBudget>,
  campaignIds?: string[],
): Promise<PacingSummary> {
  const cid = normCid(customerId);
  try {
    const { criteria } = await loadCriteria(cid);
    const { budget, source } = resolveBudget(sheetBudgets, cid);
    if (budget === null) return { ...NULL_SUMMARY };
    const ids = campaignIds ?? (await labeledCampaignIds(cid, KI_CAMPAIGN_LABEL));
    if (!ids.length) return { ...NULL_SUMMARY, budget, budget_source: source };
    const { monthStart, endDate } = monthWindow();

    let schedule: ResolvedSchedule = { days: criteria.schedule_days, source: "saved" };
    let mtd: number;
    if (criteria.schedule_days.length > 0) {
      // Saved schedule: one cheap aggregate query, as before.
      mtd = await fetchMtdSpend(cid, ids, monthStart, endDate);
    } else {
      // No saved schedule: pull per-day spend (strict — a swallowed Ads error
      // must yield all-null like fetchMtdSpend does, never a fake $0 month)
      // and infer the serving days from it (Task #3706).
      const today = plainToday();
      const infStart = addDays(today, -INFERENCE_WINDOW_DAYS);
      const infEnd = addDays(today, -1);
      const fetchStart = isoDate(infStart) < isoDate(monthStart) ? infStart : monthStart;
      const daily = await fetchDailySpend(cid, ids, fetchStart, infEnd, { strict: true });
      schedule = inferScheduleDays(daily, infStart, infEnd);
      let sum = 0;
      const monthStartIso = isoDate(monthStart);
      const endIso = isoDate(endDate);
      for (const [iso, v] of daily) if (iso >= monthStartIso && iso <= endIso) sum += v;
      mtd = round2(sum);
    }

    const math = computePacing(budget, mtd, schedule.days);
    return {
      budget,
      budget_source: source,
      mtd,
      pct: math.on_off_track_pct,
      recommended: math.recommended_daily_budget,
      expected: math.expected_to_date,
      schedule_days: schedule.days,
      schedule_source: schedule.source,
      scheduled_days_elapsed: math.scheduled_days_elapsed,
      total_scheduled_days: math.total_scheduled_days,
    };
  } catch {
    return { ...NULL_SUMMARY }; // never let one account break the dashboard
  }
}

/**
 * Save the dashboard-facing summary so the column reflects this run live.
 *
 * A null monthly_budget is persisted only when the latest ClickUp read was
 * authoritative. That all-null snapshot clears a removed/blank budget across
 * every store-backed surface. During a ClickUp outage, the directory may serve
 * stale data but budget_authoritative=false prevents an ambiguous absence from
 * wiping the last-known summary.
 * Ineligible runs DO carry a resolved budget when ClickUp/sheet has one
 * (Task #4975), so a no-labeled-campaigns account persists a budget-only row
 * (mtd/expected null via the `eligible` guards below).
 */
async function persistSummary(report: BudgetPacingReport): Promise<void> {
  if (report.monthly_budget === null && !report.budget_authoritative) return;
  await budgetPacingStore.put(report.customer_id, {
    monthly_budget: report.monthly_budget,
    // Task #3897: name the budget's origin so the combined pill can show it.
    budget_source: report.budget_source,
    mtd_spend: report.eligible ? report.mtd_spend : null,
    budget_pacing_pct: report.on_off_track_pct,
    recommended_daily_budget: report.recommended_daily_budget,
    expected_to_date: report.eligible ? report.expected_to_date : null,
    // Applied schedule + neutral-state inputs (Task #3706). Elapsed counts are
    // only real for an eligible run — null keeps "unknown" distinct from the
    // genuine "no scheduled day has elapsed yet" 0.
    schedule_days: report.schedule_days,
    schedule_source: report.schedule_source,
    scheduled_days_elapsed: report.eligible ? report.scheduled_days_elapsed : null,
    total_scheduled_days: report.eligible ? report.total_scheduled_days : null,
    generated_at: report.generated_at,
  });
}

// --- 1-hour per-account cache (same discipline as the dashboard builders) ---
const _cache = new Map<string, { at: number; report: BudgetPacingReport }>();
const _locks = new KeyedLocks(); // single-flight the Ads pull per account

export async function runBudgetPacingCached(
  customerId: string,
  force = false,
): Promise<{ report: BudgetPacingReport; fromCache: boolean }> {
  const key = normCid(customerId);
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): BudgetPacingReport | null => {
    const cached = _cache.get(key);
    return cached && Date.now() - cached.at < ttlMs ? cached.report : null;
  };

  if (!force) {
    const report = hit();
    if (report !== null) return { report, fromCache: true };
  }
  return _locks.withLock(key, async () => {
    if (!force) {
      const report = hit();
      if (report !== null) return { report, fromCache: true };
    }
    const report = await runBudgetPacing(customerId);
    _cache.set(key, { at: Date.now(), report });
    await persistSummary(report); // dashboard column reflects every run, live
    return { report, fromCache: false };
  });
}

/** Drop a cached report (called when criteria change). */
export function invalidatePacing(customerId: string): void {
  _cache.delete(normCid(customerId));
}

// ---------------------------------------------------------------------------
// Refresh orchestrators (dashboard.py ports) — the cron + criteria-save hooks
// ---------------------------------------------------------------------------

/**
 * Run the budget-pacing report for every ENROLLED account (incl. Off) and
 * persist each summary to the pacing store. Drives the morning background
 * refresh (cron endpoint + internal scheduler); the dashboards' live overlay
 * then shows fresh numbers.
 *
 * Off accounts are refreshed too (not just monitored ones): the Main dashboard
 * still counts a recently-switched-off account's budget while it has spend, and
 * that reads the pacing store — which would otherwise freeze the moment it went
 * Off.
 */
export async function refreshAllPacing(): Promise<{ requested: number; ran: number }> {
  // One forced source read before fan-out makes the existing fleet refresh the
  // rollout/reconciliation mechanism: every account sees the same fresh
  // ClickUp snapshot, without multiplying vendor calls by account count. A
  // failed read is non-throwing/non-authoritative, so the runs below preserve
  // last-known summaries rather than destructively clearing them.
  await getSheetBudgets(true);
  const accounts = await enrolledAccounts("gads");
  let ran = 0;
  if (accounts.length) {
    const results = await mapPool(accounts, 4, async (a) => {
      try {
        await runBudgetPacingCached(a.cid, true); // runs + persists
        return true;
      } catch {
        return false; // one bad account shouldn't stop the rest
      }
    });
    ran = results.filter(Boolean).length;
  }
  return { requested: accounts.length, ran };
}

/**
 * Recompute + persist ONE account's pacing summary so the dashboard column
 * reflects a budget/schedule change immediately (no wait for the morning job
 * or the next dashboard rebuild). Best-effort — never raises into the caller.
 * (Unlike persistSummary, this writes the summary as computed — including
 * nulls — mirroring the bundle: it's a user-initiated criteria save, not an
 * unattended cron run.)
 */
export async function refreshAccountPacing(customerId: string): Promise<void> {
  try {
    const cid = normCid(customerId);
    const { budgets, authoritative } = await getSheetBudgets();
    if (!authoritative) return;
    const s = await computePacingSummary(cid, budgets);
    await budgetPacingStore.put(cid, {
      monthly_budget: s.budget,
      budget_source: s.budget_source,
      mtd_spend: s.mtd,
      budget_pacing_pct: s.pct,
      recommended_daily_budget: s.recommended,
      expected_to_date: s.expected,
      schedule_days: s.schedule_days,
      schedule_source: s.schedule_source,
      scheduled_days_elapsed: s.scheduled_days_elapsed,
      total_scheduled_days: s.total_scheduled_days,
      generated_at: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }
}

/** Test hook: reset the report cache. */
export function __testResetPacingCache(): void {
  _cache.clear();
}
