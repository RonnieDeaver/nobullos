/**
 * Ads OS — LSA budget pacing (port of backend/app/lsa/pacing.py + the LSA
 * fetch_daily_spend query from lsa/queries.py).
 *
 * LSA budgets are paced MONTHLY, just like GAds; the only LSA-specific bit is
 * that an LSA account is configured with a *weekly* budget (not a daily one),
 * so the recommendation is expressed as the **weekly budget to set for the
 * rest of the month**. The monthly pacing math is shared with the GAds engine
 * (pacingEngine.computePacing); the LSA monthly budget comes from the budget
 * source's LSA column (the single source of truth — the per-account criteria
 * override was removed 2026-07). Pacing is schedule-aware via the criteria's
 * LSA schedule (lsa_schedule_days — separate from the GAds schedule_days); an
 * empty schedule paces over every calendar day, the original behavior.
 */

import { adsOsGaqlSearch, AdsOsApiError } from "./googleAdsClient";
import { AUDIT_CACHE_TTL_SECONDS } from "./config";
import { KeyedLocks, mapPool } from "./singleflight";
import {
  enrolledAccounts,
  lsaCampaignIds,
  mccEnabledAccounts,
  type MccAccounts,
} from "./enrollment";
import { getSheetBudgets, type SheetBudget } from "./budgetSource";
import { loadCriteria } from "./criteriaService";
import { lsaBudgetPacingStore } from "./store";
import type { PlainDate } from "./dateRange";
import { addDays, isoDate, plainToday } from "./dateRange";
import {
  baselineDailyBudget,
  computePacing,
  monthWindow,
  pyWeekday,
  scheduledIndices,
} from "./pacingEngine";
import type { LsaDayPoint, LsaPacingReport } from "./types";

const DAYS_PER_WEEK = 7;

function normCid(customerId: string): string {
  return customerId.replace(/-/g, "").trim().replace(/[^0-9]/g, "");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function micros(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n ? n / 1e6 : 0;
}

/**
 * (monthly_budget, source) from the ClickUp budget map's LSA column. No
 * positive per-product value = no budget.
 */
export function resolveLsaBudget(
  budgets: Map<string, SheetBudget>,
  cid: string,
): { budget: number | null; source: string } {
  const sb = budgets.get(cid);
  if (sb && sb.lsa > 0) {
    return { budget: round2(sb.lsa), source: "clickup" };
  }
  return { budget: null, source: "none" };
}

/** Recommended weekly budget = recommended daily × the days per week LSA
 *  actually serves (= remaining budget ÷ the weeks left in the month). With no
 *  schedule that's ×7, exactly the pre-schedule behavior. Exported for the
 *  pacing-math test. */
export function weeklyFromDaily(
  recommendedDaily: number | null,
  daysPerWeek: number = DAYS_PER_WEEK,
): number | null {
  return recommendedDaily !== null ? round2(recommendedDaily * daysPerWeek) : null;
}

/** Scheduled LSA serving days per week (empty/unrecognised schedule → 7, so
 *  existing clients keep today's ×7 weekly math). Exported for the test. */
export function scheduledDaysPerWeek(scheduleDays: string[]): number {
  return scheduledIndices(scheduleDays).size;
}

/**
 * Baseline weekly budget = (monthly budget ÷ total scheduled days) × scheduled
 * serving days per week — the weekly budget the LSA platform SHOULD be set to
 * from the monthly budget alone (Task #3903). Mirrors the weeklyFromDaily /
 * scheduledDaysPerWeek semantics, so an every-day account gets
 * (monthly ÷ days in month) × 7. Never depends on MTD spend; null without a
 * budget or scheduled days. Exported for the pacing-math test.
 */
export function baselineWeeklyBudget(
  monthlyBudget: number | null,
  totalScheduledDays: number,
  daysPerWeek: number,
): number | null {
  return weeklyFromDaily(baselineDailyBudget(monthlyBudget, totalScheduledDays), daysPerWeek);
}

/**
 * Per-day LSA spend (iso date -> spend) over [start, end] — every
 * LOCAL_SERVICES campaign, spend counted regardless of status. Best-effort:
 * an Ads error yields an empty map (port of lsa/queries.fetch_daily_spend).
 */
export async function fetchLsaDailySpend(
  customerId: string,
  start: PlainDate,
  end: PlainDate,
): Promise<Map<string, number>> {
  const cid = normCid(customerId);
  const query =
    "SELECT segments.date, metrics.cost_micros FROM campaign " +
    "WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES' " +
    `AND segments.date BETWEEN '${isoDate(start)}' AND '${isoDate(end)}'`;
  const out = new Map<string, number>();
  try {
    for (const row of await adsOsGaqlSearch(cid, query)) {
      const d = String(row.segments?.date ?? "");
      if (!d) continue;
      out.set(d, (out.get(d) ?? 0) + micros(row.metrics?.costMicros));
    }
  } catch (err) {
    if (err instanceof AdsOsApiError) return new Map();
    throw err;
  }
  for (const [k, v] of out) out.set(k, round2(v));
  return out;
}

async function isAccountEnrolled(cid: string, mcc: MccAccounts): Promise<boolean> {
  const accounts = await enrolledAccounts("lsa", mcc);
  return accounts.some((a) => a.cid === cid);
}

// ---------------------------------------------------------------------------
// Full report
// ---------------------------------------------------------------------------

export async function runLsaPacing(customerId: string): Promise<LsaPacingReport> {
  const cid = normCid(customerId);

  const mcc = await mccEnabledAccounts(); // creds/Ads errors propagate to the route
  const acct = mcc.get(cid);
  const accountName = acct?.name ?? cid;
  const currency = acct?.currency ?? null;

  const ineligible = (note: string, campaigns = 0): LsaPacingReport => ({
    customer_id: cid,
    account_name: accountName,
    currency_code: currency,
    generated_at: new Date().toISOString(),
    monthly_budget: null,
    budget_source: "none",
    budget_authoritative: false,
    mtd_spend: 0,
    on_off_track_pct: null,
    recommended_weekly_budget: null,
    baseline_weekly_budget: null,
    avg_daily_spend_mtd: 0,
    expected_to_date: null,
    weeks_remaining: null,
    schedule_days: [],
    spend_last_30d: 0,
    days_elapsed: 0,
    total_scheduled_days: 0,
    days_in_month: 0,
    daily_spend: [],
    eligible: false,
    monitored_campaigns: campaigns,
    scope_note: note,
    has_criteria: false,
    warnings: [],
    from_cache: false,
  });

  if (!(await isAccountEnrolled(cid, mcc))) {
    return ineligible(
      "This account isn't enrolled. Add it to the ClickUp Client List (an LSA " +
        "subtask with this account's Google CID) to include it in LSA Budget Pacing.",
    );
  }
  // Resolve the configured budget BEFORE the campaign gate (Task #4975,
  // mirroring the GAds engine): an enrolled account with no Local Services
  // campaigns yet still surfaces its ClickUp/sheet budget as a budget-only
  // persisted row instead of "no budget configured".
  const {
    budgets: sheetBudgets,
    warning: sheetWarning,
    authoritative: budgetAuthoritative,
  } = await getSheetBudgets();
  const { budget: monthlyBudget, source } = resolveLsaBudget(sheetBudgets, cid);

  const campaignIds = await lsaCampaignIds(cid);
  if (!campaignIds.length) {
    return {
      ...ineligible("No Local Services campaigns found in this account."),
      monthly_budget: monthlyBudget,
      budget_source: source,
      budget_authoritative: budgetAuthoritative,
    };
  }

  const { criteria, hasSaved } = await loadCriteria(cid);
  const lsaSchedule = criteria.lsa_schedule_days;

  const { monthStart, endDate } = monthWindow();
  const dailyMap = await fetchLsaDailySpend(cid, monthStart, endDate);
  let mtdSpend = 0;
  for (const v of dailyMap.values()) mtdSpend += v;
  mtdSpend = round2(mtdSpend);
  // Pace over the client's LSA schedule days (empty = every calendar day).
  const math = computePacing(monthlyBudget, mtdSpend, lsaSchedule);
  const daysPerWeek = scheduledDaysPerWeek(lsaSchedule);
  const remainingDays = math.total_scheduled_days - math.scheduled_days_elapsed;
  const weeksRemaining = remainingDays > 0 ? round2(remainingDays / daysPerWeek) : null;

  // 30-day spend (drives the hygiene scale/underspend signal — BUD-02).
  const today = plainToday();
  const spend30Map = await fetchLsaDailySpend(cid, addDays(today, -30), addDays(today, -1));
  let spendLast30d = 0;
  for (const v of spend30Map.values()) spendLast30d += v;
  spendLast30d = round2(spendLast30d);

  // Daily spend vs schedule-aware target (month-start..yesterday) — non-
  // scheduled days get a zero target, mirroring the GAds chart. With no
  // schedule every day is scheduled, so this stays the flat monthly target.
  const sched = scheduledIndices(lsaSchedule);
  const perSchedTarget =
    monthlyBudget !== null && math.total_scheduled_days > 0
      ? monthlyBudget / math.total_scheduled_days
      : null;
  const dailyPoints: LsaDayPoint[] = [];
  for (let day = monthStart; isoDate(day) <= isoDate(endDate); day = addDays(day, 1)) {
    const iso = isoDate(day);
    let target: number | null = null;
    if (perSchedTarget !== null) {
      target = sched.has(pyWeekday(day.y, day.m, day.d)) ? round2(perSchedTarget) : 0;
    }
    dailyPoints.push({ date: iso, spend: dailyMap.get(iso) ?? 0, target });
  }

  const warnings: string[] = [];
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
    recommended_weekly_budget: weeklyFromDaily(math.recommended_daily_budget, daysPerWeek),
    baseline_weekly_budget: baselineWeeklyBudget(
      monthlyBudget,
      math.total_scheduled_days,
      daysPerWeek,
    ),
    avg_daily_spend_mtd: math.avg_daily_spend_mtd,
    expected_to_date: math.expected_to_date,
    weeks_remaining: weeksRemaining,
    schedule_days: lsaSchedule,
    spend_last_30d: spendLast30d,
    days_elapsed: math.scheduled_days_elapsed,
    total_scheduled_days: math.total_scheduled_days,
    days_in_month: math.days_in_month,
    daily_spend: dailyPoints,
    eligible: true,
    monitored_campaigns: campaignIds.length,
    scope_note: `Tracking ${campaignIds.length} Local Services campaign(s).`,
    has_criteria: hasSaved,
    warnings,
    from_cache: false,
  };
}

// ---------------------------------------------------------------------------
// Dashboard summary + persistence
// ---------------------------------------------------------------------------

export interface LsaPacingSummary {
  budget: number | null;
  /** Where the budget came from — "clickup" | "sheet" | "none" (Task #3897:
   *  persisted so the combined pill can name the source per account). */
  budget_source: string;
  mtd: number | null;
  pct: number | null;
  recommendedWeekly: number | null;
  expected: number | null;
}

const NULL_SUMMARY: LsaPacingSummary = {
  budget: null,
  budget_source: "none",
  mtd: null,
  pct: null,
  recommendedWeekly: null,
  expected: null,
};

/**
 * Lightweight (budget, mtd, pct, recommended_weekly, expected_to_date) for the
 * dashboard column. `expected` lets the Main Dashboard blend LSA pacing with
 * GAds by summing each product's expected spend. Schedule-aware: paces over
 * the criteria's LSA schedule, like the full report. Best-effort: any failure
 * yields all-null.
 */
export async function computeLsaPacingSummary(
  customerId: string,
  sheetBudgets: Map<string, SheetBudget>,
): Promise<LsaPacingSummary> {
  const cid = normCid(customerId);
  try {
    const { criteria } = await loadCriteria(cid);
    const lsaSchedule = criteria.lsa_schedule_days;
    const { budget, source } = resolveLsaBudget(sheetBudgets, cid);
    if (budget === null) return { ...NULL_SUMMARY };
    const { monthStart, endDate } = monthWindow();
    const dailyMap = await fetchLsaDailySpend(cid, monthStart, endDate);
    let mtd = 0;
    for (const v of dailyMap.values()) mtd += v;
    mtd = round2(mtd);
    const math = computePacing(budget, mtd, lsaSchedule);
    return {
      budget,
      budget_source: source,
      mtd,
      pct: math.on_off_track_pct,
      recommendedWeekly: weeklyFromDaily(
        math.recommended_daily_budget,
        scheduledDaysPerWeek(lsaSchedule),
      ),
      expected: math.expected_to_date,
    };
  } catch {
    return { ...NULL_SUMMARY }; // never let one account break the dashboard
  }
}

/** Persist authoritative nulls to clear removed budgets; skip ambiguous nulls
 *  while ClickUp is unavailable so a transient outage preserves last-known
 *  pacing. Mirrors the GAds persistSummary guard. */
async function persistSummary(report: LsaPacingReport): Promise<void> {
  if (report.monthly_budget === null && !report.budget_authoritative) return;
  await lsaBudgetPacingStore.put(report.customer_id, {
    monthly_budget: report.monthly_budget,
    // Task #3897: name the budget's origin so the combined pill can show it.
    budget_source: report.budget_source,
    mtd_spend: report.eligible ? report.mtd_spend : null,
    pacing_pct: report.on_off_track_pct,
    recommended_weekly_budget: report.recommended_weekly_budget,
    expected_to_date: report.eligible ? report.expected_to_date : null,
    generated_at: report.generated_at,
  });
}

// --- 1-hour per-account cache (same discipline as the other engines) ---
const _cache = new Map<string, { at: number; report: LsaPacingReport }>();
const _locks = new KeyedLocks(); // single-flight the Ads pull per account

export async function runLsaPacingCached(
  customerId: string,
  force = false,
): Promise<{ report: LsaPacingReport; fromCache: boolean }> {
  const key = normCid(customerId);
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): LsaPacingReport | null => {
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
    const report = await runLsaPacing(customerId);
    _cache.set(key, { at: Date.now(), report });
    await persistSummary(report);
    return { report, fromCache: false };
  });
}

/** Drop a cached report (called when criteria change). */
export function invalidateLsaPacing(customerId: string): void {
  _cache.delete(normCid(customerId));
}

/**
 * Recompute + persist ONE account's LSA pacing summary so the dashboard column
 * reflects an LSA schedule change immediately (no wait for the morning job or
 * the next tool run). Best-effort — never raises into the caller. (Like the
 * GAds refreshAccountPacing: writes the summary as computed — including
 * nulls — it's a user-initiated criteria save, not an unattended cron run.)
 */
export async function refreshAccountLsaPacing(customerId: string): Promise<void> {
  try {
    const cid = normCid(customerId);
    const { budgets, authoritative } = await getSheetBudgets();
    if (!authoritative) return;
    const s = await computeLsaPacingSummary(cid, budgets);
    await lsaBudgetPacingStore.put(cid, {
      monthly_budget: s.budget,
      budget_source: s.budget_source,
      mtd_spend: s.mtd,
      pacing_pct: s.pct,
      recommended_weekly_budget: s.recommendedWeekly,
      expected_to_date: s.expected,
      generated_at: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }
}

/**
 * Run LSA pacing for every ENROLLED LSA account (incl. Off) and persist each
 * summary. One morning job refreshes both products (see the cron endpoint).
 */
export async function refreshAllLsaPacing(): Promise<{ requested: number; ran: number }> {
  const accounts = await enrolledAccounts("lsa");
  let ran = 0;
  if (accounts.length) {
    const results = await mapPool(accounts, 4, async (a) => {
      try {
        await runLsaPacingCached(a.cid, true); // runs + persists
        return true;
      } catch {
        return false; // one bad account shouldn't stop the rest
      }
    });
    ran = results.filter(Boolean).length;
  }
  return { requested: accounts.length, ran };
}

/** Test hook: reset the report cache. */
export function __testResetLsaPacingCache(): void {
  _cache.clear();
}
