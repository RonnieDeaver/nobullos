/**
 * Ads OS — LSA dashboard builder (port of backend/app/lsa/dashboard.py +
 * lsa/metrics.py).
 *
 * One row per MONITORED LSA account: current-window cost / charged leads / CPL
 * vs baseline, plus current-window answer rate (connected = a PHONE_CALL
 * conversation with call_duration_millis > min-seconds threshold).
 *
 * Scope: every LOCAL_SERVICES campaign (the LSA campaign label is honored by
 * scoping queries to the channel; labeled-campaign narrowing applies to GAds).
 * Four error-isolated queries per account (cost / leads / conversations /
 * status) — one failing query zeroes its own slice, never the whole row.
 *
 * Phase 1: hygiene / pacing / alerts fields ship null/[]; the live overlay is
 * people (client name, Doer, Checker) + LSA city from the ClickUp directory.
 */

import { adsOsGaqlSearch } from "./googleAdsClient";
import { AUDIT_CACHE_TTL_SECONDS, LSA_ANSWERED_CALL_MIN_SECONDS } from "./config";
import { rangeBounds, normalizeRange, isoDate } from "./dateRange";
import { KeyedLocks, mapPool } from "./singleflight";
import { enrolledAccounts, type EnrolledAccount } from "./enrollment";
import { isIsolableAdsError } from "./dashboardService";
import * as directory from "./clickUpDirectory";
import { adsStatusFor, normClientName } from "./clickUpDirectory";
import { getAlerts, getStatusCheckDoc, lsaAuditScoresStore, lsaBudgetPacingStore } from "./store";
import type { StatusCheckEntry } from "./statusCheck";
import { attachTaskRefs } from "./clickUpTasks";
import { loadCriteria } from "./criteriaService";
import { resolvePaidSearchRoleOverlays } from "./paidSearchRoleCutover";
import type { LsaDashboardResponse, LsaDashboardRow } from "./types";

// Task #5157 test seam: role-overlay resolver called through this indirection
// so a test can substitute a spy/fake without pulling the NoBull cutover DB in.
type RoleOverlayResolver = typeof resolvePaidSearchRoleOverlays;
let _roleOverlayResolver: RoleOverlayResolver = resolvePaidSearchRoleOverlays;
export function __setRoleOverlayResolverForTest(fn: RoleOverlayResolver | null): void {
  _roleOverlayResolver = fn ?? resolvePaidSearchRoleOverlays;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cost per charged lead; null when nothing was charged (lsa/metrics.py cpl). */
export function cpl(cost: number, charged: number): number | null {
  return charged > 0 ? round2(cost / charged) : null;
}

export interface ConversationRow {
  channel: string;
  durationMillis: number;
}

export interface AnswerRate {
  rate: number | null;
  calls: number;
  connected: number;
}

/** Share of current-window PHONE_CALL conversations with a connected call —
 *  duration STRICTLY greater than the configured minimum (default 0s: any
 *  duration counts). No calls -> null rate (lsa/metrics.py answer_rate). */
export function answerRate(convs: ConversationRow[], minSeconds: number): AnswerRate {
  const minMs = Math.max(0, minSeconds) * 1000;
  const calls = convs.filter((c) => c.channel === "PHONE_CALL");
  if (!calls.length) return { rate: null, calls: 0, connected: 0 };
  const connected = calls.filter((c) => c.durationMillis > minMs).length;
  return { rate: round1((connected / calls.length) * 100), calls: calls.length, connected };
}

/** "YYYY-MM-DD HH:MM:SS[.ffffff]" -> "YYYY-MM-DD", or null when unparseable
 *  (unparseable timestamps skip the row, mirroring _parse_dt -> None). */
function dtDate(value: unknown): string | null {
  const s = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? s.slice(0, 10) : null;
}

export interface LsaAccountMetrics {
  cost_30d: number;
  cost_prev: number;
  charged_leads_30d: number;
  charged_leads_prev: number;
  cpl_30d: number | null;
  cpl_prev: number | null;
  answer_rate_30d: number | null;
  answer_calls_30d: number;
  answer_connected_30d: number;
  ads_running: boolean;
}

/** Current-window vs baseline cost + charged leads, and current-window answer
 *  rate. Field names keep the `_30d`/`_prev` shape but mean current vs baseline
 *  for the selected window (see dateRange.ts). */
export async function lsaAccountMetrics(
  customerId: string,
  window: number = 30,
  compare: string = "previous",
): Promise<LsaAccountMetrics> {
  const { curStart, curEnd, baseStart, divisor } = rangeBounds(window, compare);
  const curStartIso = isoDate(curStart);
  const curEndIso = isoDate(curEnd);
  const baseStartIso = isoDate(baseStart);
  const dateDt = (s: string, e: string) => `BETWEEN '${s} 00:00:00' AND '${e} 23:59:59'`;

  const queries: Record<string, string> = {
    cost:
      "SELECT campaign.id, segments.date, metrics.cost_micros FROM campaign " +
      "WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES' " +
      `AND segments.date BETWEEN '${baseStartIso}' AND '${curEndIso}'`,
    leads:
      "SELECT local_services_lead.lead_type, local_services_lead.lead_charged, " +
      "local_services_lead.creation_date_time FROM local_services_lead " +
      `WHERE local_services_lead.creation_date_time ${dateDt(baseStartIso, curEndIso)}`,
    conversations:
      "SELECT local_services_lead_conversation.conversation_channel, " +
      "local_services_lead_conversation.phone_call_details.call_duration_millis, " +
      "local_services_lead_conversation.event_date_time FROM local_services_lead_conversation " +
      `WHERE local_services_lead_conversation.event_date_time ${dateDt(curStartIso, curEndIso)} ` +
      "AND local_services_lead_conversation.conversation_channel = 'PHONE_CALL'",
    status:
      "SELECT campaign.id, campaign.status FROM campaign " +
      "WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES'",
  };

  // Four concurrent, error-ISOLATED queries: a proper Ads error zeroes its own
  // slice only; quota/transient/network errors propagate (fail the build, per
  // the bundle's posture).
  const run = async (query: string): Promise<any[]> => {
    try {
      return await adsOsGaqlSearch(customerId, query);
    } catch (err) {
      if (isIsolableAdsError(err)) return [];
      throw err;
    }
  };
  const [costRows, leadRows, convRows, statusRows] = await Promise.all([
    run(queries.cost), run(queries.leads), run(queries.conversations), run(queries.status),
  ]);

  let curCost = 0, prevCost = 0, curCharged = 0, prevCharged = 0;

  for (const row of costRows) {
    const dt = String(row.segments?.date ?? "");
    const amt = Number(row.metrics?.costMicros ?? 0) / 1e6;
    if (dt >= curStartIso) curCost += amt;
    else prevCost += amt; // baseline region (before the current window)
  }

  for (const row of leadRows) {
    const lead = row.localServicesLead ?? {};
    const cdt = dtDate(lead.creationDateTime);
    if (!cdt) continue;
    if (lead.leadCharged) {
      // REST omits lead_charged when false; truthy check covers both.
      if (cdt >= curStartIso) curCharged += 1;
      else prevCharged += 1;
    }
  }

  const curConvs: ConversationRow[] = convRows.map((row: any) => {
    const c = row.localServicesLeadConversation ?? {};
    return {
      channel: String(c.conversationChannel ?? ""),
      durationMillis: Number(c.phoneCallDetails?.callDurationMillis ?? 0),
    };
  });

  // "LSA paused" = no LOCAL_SERVICES campaign is ENABLED (all paused/removed).
  const adsRunning = statusRows.some((r: any) => r.campaign?.status === "ENABLED");

  const ar = answerRate(curConvs, LSA_ANSWERED_CALL_MIN_SECONDS);
  curCost = round2(curCost);
  prevCost = round2(prevCost);
  // CPL is a ratio, so the baseline divisor cancels — compute it from the raw
  // baseline; report cost_prev / charged_leads_prev normalized to one window.
  return {
    cost_30d: curCost,
    cost_prev: round2(prevCost / divisor),
    charged_leads_30d: curCharged,
    charged_leads_prev: round2(prevCharged / divisor),
    cpl_30d: cpl(curCost, curCharged),
    cpl_prev: cpl(prevCost, prevCharged),
    answer_rate_30d: ar.rate,
    answer_calls_30d: ar.calls,
    answer_connected_30d: ar.connected,
    ads_running: adsRunning,
  };
}

async function buildLsaDashboard(window: number, compare: string): Promise<LsaDashboardResponse> {
  // Task #4865: enrolledAccounts (not monitoredAccounts) so Off accounts also
  // get a row — the Paused/Off chip needs a row to render on.
  const accounts = await enrolledAccounts("lsa");

  const rowFor = async (acct: EnrolledAccount): Promise<LsaDashboardRow> => {
    // Phase 1: no pacing seeding / hygiene stores — those land in Phases 2-3.
    const m = await lsaAccountMetrics(acct.cid, window, compare);
    return {
      customer_id: acct.cid,
      descriptive_name: acct.name,
      practice_areas: [],
      currency_code: acct.currency,
      ...m,
      health_score: null,
      health_band: null,
      health_at: null,
      monthly_budget: null,
      mtd_spend: null,
      pacing_pct: null,
      recommended_weekly_budget: null,
      alerts: [],
      alerts_at: null,
      client_name: null,
      doer: null,
      checker: null,
      lsa_city: null,
      lsa_schedule_days: [],
      ads_status: null,
      status_check: null,
    };
  };

  const rows = accounts.length ? await mapPool(accounts, 8, rowFor) : [];
  rows.sort((a, b) => a.descriptive_name.toLowerCase().localeCompare(b.descriptive_name.toLowerCase()));
  return { rows, generated_at: new Date().toISOString() };
}

/** Live overlay on every request (tracks the directory's 10-min TTL and the
 *  pacing store, not the 1-hour metrics cache): people + LSA city from the
 *  ClickUp directory, role overlays resolved once via the paid-search role
 *  cutover resolver (Task #5157), weekly budget pacing from the store — so a
 *  just-run pacing report or the morning refresh shows up immediately. */
async function overlayLive(resp: LsaDashboardResponse): Promise<void> {
  // Task #4865: ONE read for the status-check verdicts — same pattern as the
  // AM Dashboard (amDashboard.ts). Fetching once avoids N concurrent reads.
  const checkDoc = await getStatusCheckDoc();
  const checks = (checkDoc.checks ?? {}) as Record<string, StatusCheckEntry>;

  // Task #5157: fetch each row's ClickUp people once (directory is cached
  // ~10 min), then batch-resolve role overlays in ONE call — not one DB read
  // per row. Preserve legacy doer/checker when the resolver returns no entry.
  const [peopleArr, practiceAreasArr] = await Promise.all([
    Promise.all(resp.rows.map((row) => directory.peopleFor("lsa", row.customer_id))),
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
      row.lsa_city = await directory.lsaCityFor(row.customer_id);

      const alertsDoc = ((await getAlerts("lsa", row.customer_id)) ?? {}) as Record<string, any>;
      const alerts = Array.isArray(alertsDoc.alerts) ? alertsDoc.alerts : [];
      row.alerts = await attachTaskRefs("lsa", row.customer_id, alerts);
      row.alerts_at = alertsDoc.generated_at ?? null;

      const score = (await lsaAuditScoresStore.get(row.customer_id)) ?? {};
      row.health_score = score.final_score ?? null;
      row.health_band = score.band ?? null;
      row.health_at = score.generated_at ?? null;

      // Task #3676: schedule context for the pacing column — read from the
      // criteria store (no Ads API call), live like the pacing overlay so a
      // just-saved schedule shows on the next reload. Best-effort: a store
      // blip leaves the default (empty = every day) rather than sinking the row.
      try {
        const { criteria } = await loadCriteria(row.customer_id);
        row.lsa_schedule_days = criteria.lsa_schedule_days;
      } catch {
        row.lsa_schedule_days = [];
      }

      const pacing = (await lsaBudgetPacingStore.get(row.customer_id)) ?? {};
      row.monthly_budget = pacing.monthly_budget ?? null;
      row.mtd_spend = pacing.mtd_spend ?? null;
      row.pacing_pct = pacing.pacing_pct ?? null;
      row.recommended_weekly_budget = pacing.recommended_weekly_budget ?? null;

      // Task #4865: ClickUp Ads Status + morning verification.
      const adsStatus = (await adsStatusFor("lsa", row.customer_id)) ?? "on";
      row.ads_status = adsStatus;
      const key = `lsa:${row.customer_id}`;
      row.status_check =
        adsStatus === "paused" || adsStatus === "off" ? (checks[key] ?? null) : null;
    }),
  );
}

// --- 1-hour cache, single-flighted per {window}:{compare} ---
const _cache = new Map<string, { at: number; resp: LsaDashboardResponse }>();
const _locks = new KeyedLocks();

export async function buildLsaDashboardCached(
  force: boolean = false,
  window: unknown = 30,
  compare: unknown = "previous",
): Promise<{ resp: LsaDashboardResponse; fromCache: boolean }> {
  const [win, cmp] = normalizeRange(window, compare);
  const key = `${win}:${cmp}`;
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): LsaDashboardResponse | null => {
    const cached = _cache.get(key);
    return cached && Date.now() - cached.at < ttlMs ? cached.resp : null;
  };

  let resp = force ? null : hit();
  let fromCache = resp !== null;
  if (resp === null) {
    const out = await _locks.withLock(key, async () => {
      let r = force ? null : hit();
      const fc = r !== null;
      if (r === null) {
        r = await buildLsaDashboard(win, cmp);
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
export function __testResetLsaDashboardCache(): void {
  _cache.clear();
}
