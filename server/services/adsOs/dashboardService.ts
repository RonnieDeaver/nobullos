/**
 * Ads OS — Google Ads dashboard builder (port of backend/app/dashboard.py).
 *
 * One row per MONITORED GAds account (On/Paused; Off dropped): current-window
 * spend / conversions / CPA vs baseline, scoped to the account's
 * NBM_GADS_MONITOR_CAMPAIGN-labeled campaigns only.
 *
 * Error posture (mirrors the bundle):
 *   - A "proper" Ads API error on one account's metrics (auth / permission /
 *     bad customer) isolates that account to zeros — never sinks the board.
 *   - Quota + transient (5xx) + network errors PROPAGATE so the route can map
 *     them (503 quota / 502 Ads error) instead of caching a silently-zero board.
 *
 * Phase 1: hygiene / pacing / traffic-quality / alerts overlays don't exist yet;
 * those fields ship null/[] and only the people overlay (client name, Doer,
 * Checker via ClickUp) runs on every request.
 */

import { adsOsGaqlSearch, AdsOsApiError } from "./googleAdsClient";
import { AUDIT_CACHE_TTL_SECONDS, KI_CAMPAIGN_LABEL } from "./config";
import { rangeBounds, normalizeRange, isoDate } from "./dateRange";
import { KeyedLocks, mapPool } from "./singleflight";
import { enrolledAccounts, labeledCampaignIds, type EnrolledAccount } from "./enrollment";
import * as directory from "./clickUpDirectory";
import { adsStatusFor, normClientName } from "./clickUpDirectory";
import { auditScoresStore, budgetPacingStore, getAlerts, getStatusCheckDoc, trafficQualityStore } from "./store";
import type { StatusCheckEntry } from "./statusCheck";
import { attachTaskRefs } from "./clickUpTasks";
import { loadCriteria } from "./criteriaService";
import { resolvePaidSearchRoleOverlays } from "./paidSearchRoleCutover";
import type { DashboardResponse, DashboardRow } from "./types";

// Task #5157 test seam: the role-overlay resolver is called through this
// indirection so a test can substitute a spy/fake (assert it runs ONCE per
// dashboard batch, and drive mode outputs deterministically) without pulling
// the NoBull cutover DB into the test. Production always uses the real import.
type RoleOverlayResolver = typeof resolvePaidSearchRoleOverlays;
let _roleOverlayResolver: RoleOverlayResolver = resolvePaidSearchRoleOverlays;
export function __setRoleOverlayResolverForTest(fn: RoleOverlayResolver | null): void {
  _roleOverlayResolver = fn ?? resolvePaidSearchRoleOverlays;
}

/** True when an Ads API error should isolate ONE account (show zeros) rather
 *  than fail the build — the port of `except GoogleAdsException: pass`. Quota
 *  and transient (5xx) errors mirror ResourceExhausted / GoogleAPICallError in
 *  the bundle: they propagate. */
export function isIsolableAdsError(err: unknown): boolean {
  return (
    err instanceof AdsOsApiError &&
    err.kind !== "quota_exceeded" &&
    err.kind !== "transient"
  );
}

/** True if at least one of the monitored campaigns is ENABLED — i.e. ads are
 *  still running. False when they're all paused/removed. On error we assume
 *  running (keeps the red-MBH behavior rather than wrongly greying it out). */
async function anyCampaignEnabled(cid: string, campaignIds: string[]): Promise<boolean> {
  if (!campaignIds.length) return false;
  const query =
    "SELECT campaign.id, campaign.status FROM campaign " +
    `WHERE campaign.id IN (${campaignIds.join(", ")})`;
  try {
    for (const row of await adsOsGaqlSearch(cid, query)) {
      if (row.campaign?.status === "ENABLED") return true;
    }
  } catch (err) {
    if (isIsolableAdsError(err)) return true; // can't tell -> assume running
    throw err;
  }
  return false;
}

export interface AccountMetrics {
  spend_30d: number;
  spend_prev: number;
  conversions_30d: number;
  conversions_prev: number;
  cpa_30d: number | null;
  cpa_prev: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Current-window vs baseline spend/conversions/CPA, scoped to the labeled
 *  campaigns (any status — a campaign paused mid-window still spent). No
 *  labeled campaigns -> zeros. Field names keep the `_30d`/`_prev` shape; they
 *  mean current vs baseline for the selected window (see dateRange.ts). */
export async function accountMetrics(
  cid: string,
  campaignIds: string[],
  window: number = 30,
  compare: string = "previous",
): Promise<AccountMetrics> {
  const { curStart, curEnd, baseStart, divisor } = rangeBounds(window, compare);
  const curStartIso = isoDate(curStart);
  const baseStartIso = isoDate(baseStart);
  let curCost = 0, curConv = 0, baseCost = 0, baseConv = 0;

  if (campaignIds.length) {
    const query =
      "SELECT segments.date, metrics.cost_micros, metrics.conversions FROM campaign " +
      `WHERE campaign.id IN (${campaignIds.join(", ")}) ` +
      `AND segments.date BETWEEN '${baseStartIso}' AND '${isoDate(curEnd)}'`;
    try {
      for (const row of await adsOsGaqlSearch(cid, query)) {
        const dt = String(row.segments?.date ?? "");
        const cost = Number(row.metrics?.costMicros ?? 0);
        const conv = Number(row.metrics?.conversions ?? 0);
        if (dt >= curStartIso) {
          curCost += cost;
          curConv += conv;
        } else if (dt >= baseStartIso) {
          baseCost += cost;
          baseConv += conv;
        }
      }
    } catch (err) {
      if (!isIsolableAdsError(err)) throw err;
      // isolate a partial-access account; it shows zeros
    }
  }

  const curSpend = curCost / 1e6;
  const baseSpend = baseCost / 1e6 / divisor; // normalize the baseline to one window
  const baseConvN = baseConv / divisor;
  return {
    spend_30d: round2(curSpend),
    spend_prev: round2(baseSpend),
    conversions_30d: round2(curConv),
    conversions_prev: round2(baseConvN),
    cpa_30d: curConv > 0 ? round2(curSpend / curConv) : null,
    cpa_prev: baseConvN > 0 ? round2(baseSpend / baseConvN) : null,
  };
}

async function buildDashboard(window: number, compare: string): Promise<DashboardResponse> {
  // Task #4865: enrolledAccounts (not monitoredAccounts) so Off accounts also
  // get a row — the Paused/Off chip needs a row to render on.
  const accounts = await enrolledAccounts("gads");

  const rowFor = async (acct: EnrolledAccount): Promise<DashboardRow> => {
    // All performance metrics are scoped to the account's labeled monitored
    // campaigns only (resolve the id set once, share it). Phase 1: no pacing
    // seeding / hygiene — those stores land in Phases 2-3.
    const campaignIds = await labeledCampaignIds(acct.cid, KI_CAMPAIGN_LABEL);
    const [running, metrics] = await Promise.all([
      anyCampaignEnabled(acct.cid, campaignIds),
      accountMetrics(acct.cid, campaignIds, window, compare),
    ]);
    return {
      customer_id: acct.cid,
      descriptive_name: acct.name,
      practice_areas: [],
      currency_code: acct.currency,
      ...metrics,
      health_score: null,
      health_band: null,
      health_at: null,
      monthly_budget: null,
      mtd_spend: null,
      budget_pacing_pct: null,
      recommended_daily_budget: null,
      ads_running: running,
      traffic_quality: null,
      quality_coverage: null,
      quality_window: null,
      quality_at: null,
      alerts: [],
      alerts_at: null,
      client_name: null,
      doer: null,
      checker: null,
      schedule_days: [],
      schedule_source: null,
      scheduled_days_elapsed: null,
      ads_status: null,
      status_check: null,
    };
  };

  const rows = accounts.length ? await mapPool(accounts, 10, rowFor) : [];
  rows.sort((a, b) => a.descriptive_name.toLowerCase().localeCompare(b.descriptive_name.toLowerCase()));
  return { rows, generated_at: new Date().toISOString() };
}

/** Live overlay on EVERY request — never frozen in the 1-hour metrics cache:
 *  canonical client name + Doer/Checker from the ClickUp directory (cached
 *  ~10 min) resolved through the paid-search role cutover resolver (Task #5157),
 *  hygiene score + budget pacing + traffic quality from their stores, so a
 *  just-run audit, pacing report, or search-term review — or the morning
 *  refresh job — shows up immediately even on a cached metrics response.
 *  Alerts ride the same overlay (with their open ClickUp ticket refs) so the
 *  ⚠ badge tracks the store, not the metrics cache. */
async function overlayLive(resp: DashboardResponse): Promise<void> {
  // Task #4865: ONE read for the status-check verdicts — same pattern as the
  // AM Dashboard (amDashboard.ts). Two reads of the same document can tear;
  // fetching it once here avoids N concurrent reads inside the row loop.
  const checkDoc = await getStatusCheckDoc();
  const checks = (checkDoc.checks ?? {}) as Record<string, StatusCheckEntry>;

  // Task #5157: fetch each row's ClickUp people once (directory is cached
  // ~10 min), then batch-resolve role overlays in ONE call — not one DB read
  // per row. Preserve legacy doer/checker when the resolver returns no entry.
  const [peopleArr, practiceAreasArr] = await Promise.all([
    Promise.all(resp.rows.map((row) => directory.peopleFor("gads", row.customer_id))),
    Promise.all(
      resp.rows.map((row) => directory.dashboardPracticeAreasForCids([row.customer_id])),
    ),
  ]);
  const resolverInputs = resp.rows.map((_row, i) => ({
    clientName: peopleArr[i].client_name ?? "",
    legacyDoer: peopleArr[i].doer,
    legacyChecker: peopleArr[i].checker,
  }));
  const overlays = await _roleOverlayResolver(resolverInputs);

  await Promise.all(
    resp.rows.map(async (row, i) => {
      const people = peopleArr[i];
      row.client_name = people.client_name;
      row.practice_areas = practiceAreasArr[i];
      const overlay = overlays.get(normClientName(people.client_name ?? ""));
      row.doer = overlay ? overlay.doer : people.doer;
      row.checker = overlay ? overlay.checker : people.checker;

      const alertsDoc = ((await getAlerts("gads", row.customer_id)) ?? {}) as Record<string, any>;
      const alerts = Array.isArray(alertsDoc.alerts) ? alertsDoc.alerts : [];
      row.alerts = await attachTaskRefs("gads", row.customer_id, alerts);
      row.alerts_at = alertsDoc.generated_at ?? null;

      const score = (await auditScoresStore.get(row.customer_id)) ?? {};
      row.health_score = score.final_score ?? null;
      row.health_band = score.band ?? null;
      row.health_at = score.generated_at ?? null;

      // Task #3682: schedule context for the pacing column — read from the
      // criteria store (no Ads API call), live like the pacing overlay so a
      // just-saved schedule shows on the next reload. Best-effort: a store
      // blip leaves the default (empty = every day) rather than sinking the row.
      try {
        const { criteria } = await loadCriteria(row.customer_id);
        row.schedule_days = criteria.schedule_days;
        row.schedule_source = criteria.schedule_days.length ? "saved" : "default";
      } catch {
        row.schedule_days = [];
        row.schedule_source = null;
      }

      const pacing = (await budgetPacingStore.get(row.customer_id)) ?? {};
      row.monthly_budget = pacing.monthly_budget ?? null;
      row.mtd_spend = pacing.mtd_spend ?? null;
      row.budget_pacing_pct = pacing.budget_pacing_pct ?? null;
      row.recommended_daily_budget = pacing.recommended_daily_budget ?? null;
      // Task #3706: the APPLIED schedule from the last pacing run wins over
      // raw criteria — they differ when the schedule was inferred from spend.
      // scheduled_days_elapsed drives the neutral "not started yet" column
      // state (0 elapsed + budget + null pct); docs predating the field give
      // null = unknown, keeping older rows on the plain "—".
      if (Array.isArray(pacing.schedule_days)) {
        row.schedule_days = pacing.schedule_days.map((d: unknown) => String(d));
        row.schedule_source =
          typeof pacing.schedule_source === "string" ? pacing.schedule_source : row.schedule_source;
      }
      row.scheduled_days_elapsed =
        typeof pacing.scheduled_days_elapsed === "number" ? pacing.scheduled_days_elapsed : null;

      // Persisted by every Search Term Analyzer negatives run (Phase 4).
      const quality = (await trafficQualityStore.get(row.customer_id)) ?? {};
      row.traffic_quality = quality.traffic_quality ?? null;
      row.quality_coverage = quality.coverage ?? null;
      row.quality_window = quality.lookback_days ?? null;
      row.quality_at = quality.generated_at ?? null;

      // Task #4865: ClickUp Ads Status + morning verification, same as the AM
      // Dashboard chip — overlaid live so a ClickUp edit shows without a
      // metrics cache bust. null → "on" (running is the norm).
      const adsStatus = (await adsStatusFor("gads", row.customer_id)) ?? "on";
      row.ads_status = adsStatus;
      const key = `gads:${row.customer_id}`;
      row.status_check =
        adsStatus === "paused" || adsStatus === "off" ? (checks[key] ?? null) : null;
    }),
  );
}

// --- 1-hour cache, single-flighted per {window}:{compare} ---
const _cache = new Map<string, { at: number; resp: DashboardResponse }>();
const _locks = new KeyedLocks();

export async function buildDashboardCached(
  force: boolean = false,
  window: unknown = 30,
  compare: unknown = "previous",
): Promise<{ resp: DashboardResponse; fromCache: boolean }> {
  const [win, cmp] = normalizeRange(window, compare);
  const key = `${win}:${cmp}`;
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): DashboardResponse | null => {
    const cached = _cache.get(key);
    return cached && Date.now() - cached.at < ttlMs ? cached.resp : null;
  };

  let resp = force ? null : hit();
  let fromCache = resp !== null;
  if (resp === null) {
    // Single-flight the (quota-costed) rebuild so the morning stampede of
    // concurrent loads doesn't trigger one full account sweep per request.
    const out = await _locks.withLock(key, async () => {
      let r = force ? null : hit();
      const fc = r !== null;
      if (r === null) {
        r = await buildDashboard(win, cmp);
        _cache.set(key, { at: Date.now(), resp: r });
      }
      return { r, fc };
    });
    resp = out.r;
    fromCache = out.fc;
  }
  await overlayLive(resp);
  return { resp, fromCache };
}

/** Test hook: reset the metrics cache. */
export function __testResetDashboardCache(): void {
  _cache.clear();
}
