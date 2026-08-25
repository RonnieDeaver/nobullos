/**
 * Ads OS — Main (combined) dashboard builder (port of
 * backend/app/combined_dashboard.py).
 *
 * One row per CLIENT: all of their GAds + LSA accounts merged, reusing the
 * standalone dashboards' metric functions so the combined numbers match the
 * per-product views exactly.
 *
 * Sourcing: the ClickUp Client List when live (incl. Off accounts, so a
 * recently-switched-off account still counts + shows on the profile); in auto
 * mode label-only accounts ClickUp has never heard of under either product are
 * unioned in, standing alone under their account name. Fallback (label mode /
 * ClickUp down): legacy account labels, each account standing alone.
 *
 * Resilience: transient Google Ads errors are retried (3 attempts, backoff);
 * an account that still fails is isolated as metrics_failed=true zeros rather
 * than sinking the overview — and such "partial" builds are cached only ~2 min
 * (for up to 3 consecutive partials) so the blip self-repairs quickly without
 * burning quota forever. Quota errors always propagate (clean 503, never a
 * silently-zero board).
 *
 * Phase 1: pacing overlay (budgets / MTD / pace %) is Phase 2 — fields stay
 * null and has_active_monitoring keeps its window-spend-based value. The
 * people overlay (canonical client name, Doer/Checker, LSA city) runs on every
 * request.
 */

import { AdsOsApiError, AdsOsCredsMissing } from "./googleAdsClient";
import {
  AUDIT_CACHE_TTL_SECONDS, KI_CAMPAIGN_LABEL, ACCOUNT_ENROLLMENT, isClickUpConfigured,
} from "./config";
import { normalizeRange } from "./dateRange";
import { KeyedLocks, mapPool } from "./singleflight";
import {
  mccEnabledAccounts, enrolledAccounts, labelCids, labeledCampaignIds,
  type MccAccounts,
} from "./enrollment";
import { accountMetrics } from "./dashboardService";
import { activeNonLsaCampaignIds } from "./labelCoverage";
import { loadCriteria } from "./criteriaService";
import { lsaAccountMetrics } from "./lsaDashboardService";
import * as directory from "./clickUpDirectory";
import { normClientName } from "./clickUpDirectory";
import { resolvePaidSearchRoleOverlays } from "./paidSearchRoleCutover";
import {
  budgetPacingStore,
  getStatusCheckDoc,
  loadAlertsMap,
  lsaBudgetPacingStore,
} from "./store";
import { normalizeClientAlertSummary } from "./clientAlertRollup";

// Task #5157 test seam: role-overlay resolver called through this indirection
// so a test can substitute a spy/fake without pulling the NoBull cutover DB in.
type RoleOverlayResolver = typeof resolvePaidSearchRoleOverlays;
let _roleOverlayResolver: RoleOverlayResolver = resolvePaidSearchRoleOverlays;
export function __setRoleOverlayResolverForTest(fn: RoleOverlayResolver | null): void {
  _roleOverlayResolver = fn ?? resolvePaidSearchRoleOverlays;
}
type AlertsMapLoader = typeof loadAlertsMap;
let _alertsMapLoader: AlertsMapLoader = loadAlertsMap;
export function __setAlertsMapLoaderForTest(fn: AlertsMapLoader | null): void {
  _alertsMapLoader = fn ?? loadAlertsMap;
}
import type { StatusCheckEntry } from "./statusCheck";
import type {
  AdsStatus, CombinedDashboardResponse, CombinedDashboardRow, CombinedMember, Product,
} from "./types";

// The Google Ads API intermittently returns transient INTERNAL/5xx errors.
// Retry such calls a few times before giving up. Quota exhaustion is NOT
// transient: it's re-raised immediately so it surfaces as the route's clean
// 503 rather than being retried or swallowed.
const FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isQuota(err: unknown): boolean {
  return err instanceof AdsOsApiError && err.kind === "quota_exceeded";
}

/** Run an Ads-API call, retrying on a transient error with a short backoff.
 *  Quota + creds-missing are never retried. Re-raises the last error if every
 *  attempt fails. */
export async function retryTransient<T>(fn: () => Promise<T>, what: string): Promise<T> {
  let last: unknown = null;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isQuota(err) || err instanceof AdsOsCredsMissing) throw err;
      last = err;
      if (attempt + 1 < FETCH_ATTEMPTS) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  console.warn(
    `[AdsOs/combined] ${what} failed after ${FETCH_ATTEMPTS} attempts:`,
    (last as any)?.message ?? last,
  );
  throw last;
}

function zeroMember(
  product: Product, cid: string, name: string, currency: string | null,
  adsStatus: AdsStatus, metricsFailed: boolean,
): CombinedMember {
  return {
    product, customer_id: cid, descriptive_name: name, currency_code: currency,
    ads_status: adsStatus, spend_30d: 0, spend_prev: 0, leads_30d: 0, leads_prev: 0,
    cpl_30d: null, city: null, pacing_budget: null, pacing_mtd: null, pacing_pct: null,
    pacing_included: false,
    pacing_expected: null, pacing_budget_source: null, pacing_schedule_days: null,
    pacing_schedule_source: null, pacing_generated_at: null,
    metrics_failed: metricsFailed,
  };
}

/** Pull one account's current-window-vs-baseline metrics, reusing the
 *  standalone dashboards' queries so the combined numbers match the
 *  per-product views exactly (incl. their own CPL/CPA, computed from
 *  unrounded values — matches to the cent). */
async function memberMetrics(
  product: Product, cid: string, name: string, currency: string | null,
  campaignLabel: string, adsStatus: AdsStatus, window: number, compare: string,
): Promise<CombinedMember> {
  const fetch = async (): Promise<CombinedMember> => {
    const member = zeroMember(product, cid, name, currency, adsStatus, false);
    if (product === "gads") {
      const campaignIds = await labeledCampaignIds(cid, campaignLabel);
      if (campaignIds.length === 0) {
        // Task #4964: zero labeled campaigns — every label-scoped metric below
        // is $0.00 by construction. Distinguish "Setup needed" (account HAS
        // active campaigns, none labeled) from a genuinely idle account with
        // ONE extra query, only on this rare path. A failure here leaves the
        // flag unset (unknown) — never guessed.
        try {
          const active = await activeNonLsaCampaignIds(cid);
          if (active.length > 0) member.zero_label = true;
        } catch {
          /* cannot tell — leave zero_label unset rather than mislabeling */
        }
      }
      const m = await accountMetrics(cid, campaignIds, window, compare);
      member.spend_30d = m.spend_30d;
      member.spend_prev = m.spend_prev;
      member.leads_30d = m.conversions_30d;
      member.leads_prev = m.conversions_prev;
      member.cpl_30d = m.cpa_30d; // GAds CPA = cost per primary conversion; matches the GAds dashboard
    } else {
      const m = await lsaAccountMetrics(cid, window, compare);
      member.spend_30d = m.cost_30d;
      member.spend_prev = m.cost_prev;
      member.leads_30d = m.charged_leads_30d;
      member.leads_prev = m.charged_leads_prev;
      member.cpl_30d = m.cpl_30d; // matches the LSA dashboard
    }
    return member;
  };

  try {
    return await retryTransient(fetch, `${product} metrics for ${cid}`);
  } catch (err) {
    if (isQuota(err) || err instanceof AdsOsCredsMissing) throw err; // surface — don't mask as a zero account
    // Persistent failure on one account: return it FLAGGED (metrics are 0 as a
    // placeholder, not a real zero) so the rest of the overview still loads,
    // the UI can mark it, and the cache holds this partial result only briefly.
    return zeroMember(product, cid, name, currency, adsStatus, true);
  }
}

/** Whether a member counts toward the client's active view + product tags.
 *  On/Paused always count; an Off account counts only while it still has spend
 *  in the window. (Phase 2's pacing overlay additionally counts MTD spend.) */
function memberCounts(m: CombinedMember): boolean {
  return m.ads_status !== "off" || m.spend_30d > 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assembleRow(clientName: string, members: CombinedMember[]): CombinedDashboardRow {
  const gads = members.filter((m) => m.product === "gads");
  const lsa = members.filter((m) => m.product === "lsa");
  const sum = (xs: CombinedMember[], f: (m: CombinedMember) => number) =>
    xs.reduce((acc, m) => acc + f(m), 0);
  const spend = sum(members, (m) => m.spend_30d);
  const spendPrev = sum(members, (m) => m.spend_prev);
  const leads = sum(members, (m) => m.leads_30d);
  const leadsPrev = sum(members, (m) => m.leads_prev);
  // Same client, so currencies match in practice; prefer GAds, fall back to LSA.
  const currency =
    (gads.length ? gads[0].currency_code : null) ?? (lsa.length ? lsa[0].currency_code : null);
  const membersSorted = [...members].sort((a, b) => {
    const pa = a.product === "gads" ? 0 : 1;
    const pb = b.product === "gads" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.descriptive_name.toLowerCase().localeCompare(b.descriptive_name.toLowerCase());
  });
  // Client name is canonicalized + Doer/Checker attached live in overlayPeople
  // (so it tracks the ClickUp directory's 10-min TTL, not the 1-hour cache).
  return {
    client: clientName,
    practice_areas: [],
    currency_code: currency,
    spend_30d: round2(spend),
    spend_prev: round2(spendPrev),
    leads_30d: round2(leads),
    leads_prev: round2(leadsPrev),
    cpl_30d: leads > 0 ? round2(spend / leads) : null,
    cpl_prev: leadsPrev > 0 ? round2(spendPrev / leadsPrev) : null,
    gads_spend_30d: round2(sum(gads, (m) => m.spend_30d)),
    gads_leads_30d: round2(sum(gads, (m) => m.leads_30d)),
    lsa_spend_30d: round2(sum(lsa, (m) => m.spend_30d)),
    lsa_leads_30d: round2(sum(lsa, (m) => m.leads_30d)),
    has_gads: gads.some(memberCounts),
    has_lsa: lsa.some(memberCounts),
    has_active_monitoring: members.some(memberCounts),
    pacing_budget: null,
    pacing_mtd: null,
    pacing_expected: null,
    pacing_pct: null,
    pacing_hit: false,
    doer: null,
    checker: null,
    metrics_partial: members.some((m) => m.metrics_failed),
    alerts: normalizeClientAlertSummary([]),
    members: membersSorted,
  };
}

interface CombinedTask {
  product: Product;
  group: string;
  cid: string;
  name: string;
  currency: string | null;
  status: AdsStatus;
}

/** Every account to show on the Main dashboard: (product, client_group, cid,
 *  name, currency, ads_status). ClickUp Client List (incl. Off) when live;
 *  otherwise legacy account labels, each standing alone. Only accounts that
 *  exist ENABLED under the MCC are included (closed accounts drop out); each
 *  (product, CID) is added once so a duplicate subtree can't double-count. */
async function combinedTasks(
  mcc: MccAccounts,
): Promise<{ tasks: CombinedTask[]; clickupGrouped: boolean }> {
  const mode = ACCOUNT_ENROLLMENT;
  const tasks: CombinedTask[] = [];
  const seen = new Set<string>();

  // Task #3648: refresh/kick the directory BEFORE reading liveness. Without
  // this, a cold boot (fresh autoscale instance) evaluates bundleIsLive()
  // before ANY fetch has ever run, falls back to per-account grouping, and
  // that wrongly-grouped build gets cached — even though ClickUp is healthy.
  // getClientDirectory() is a no-op when unconfigured, TTL-cached, and
  // single-flight, so this adds no calls on the warm path.
  if (mode !== "label") await directory.getClientDirectory();

  const add = (product: Product, group: string | null, cid: string, status: AdsStatus) => {
    const acct = mcc.get(cid);
    if (!acct || seen.has(`${product}:${cid}`)) return;
    seen.add(`${product}:${cid}`);
    tasks.push({ product, group: group || acct.name, cid, name: acct.name, currency: acct.currency, status });
  };

  if (mode !== "label" && directory.bundleIsLive()) {
    // ClickUp is the source: one row-group per client task, all of its ENABLED accounts.
    const blocks = await directory.clientBlocks();
    for (const blk of blocks) {
      for (const { product, cids } of [
        { product: "gads" as Product, cids: blk.gads_cids },
        { product: "lsa" as Product, cids: blk.lsa_cids },
      ]) {
        for (const cid of cids) {
          add(product, blk.name || "", cid, await directory.adsStatusFor(product, cid));
        }
      }
    }
    if (mode === "auto") {
      // Migration gap: accounts still enrolled only via the Google label and
      // absent from ClickUp across BOTH products stand alone under their account
      // name. The cross-product set includes offboarded/unlinked CIDs and stops
      // a stale label from inventing a second product for a known account.
      const known = await directory.knownCidsAcrossProducts();
      for (const product of ["gads", "lsa"] as Product[]) {
        for (const cid of await labelCids(product)) {
          if (!known.has(cid)) add(product, null, cid, null);
        }
      }
    }
    return { tasks, clickupGrouped: true };
  }

  // Fallback (label mode, or auto with ClickUp not live): legacy labels, each
  // account standing alone by name. (The bundle's budget-sheet grouping is
  // deliberately not ported — the sheet is retired.)
  for (const product of ["gads", "lsa"] as Product[]) {
    for (const acct of await enrolledAccounts(product, mcc)) {
      add(product, null, acct.cid, null);
    }
  }
  // "Grouped as designed" unless ClickUp was SUPPOSED to group this build:
  // label mode and unconfigured-ClickUp deployments are not degraded.
  return { tasks, clickupGrouped: mode === "label" || !isClickUpConfigured() };
}

async function buildCombinedDashboard(
  window: number, compare: string,
): Promise<CombinedDashboardResponse> {
  const campaignLabel = KI_CAMPAIGN_LABEL;
  // One MCC-ENABLED fetch (id/name/currency) reused for both products, giving
  // discovery its display names + the "still exists ENABLED" filter. Retried on
  // a transient blip; a genuine outage propagates so the route returns cleanly.
  const mcc = await retryTransient(() => mccEnabledAccounts(), "MCC accounts");
  const { tasks, clickupGrouped } = await combinedTasks(mcc);

  const membersByClient = new Map<string, CombinedMember[]>();
  if (tasks.length) {
    const results = await mapPool(tasks, 10, async (t) => ({
      group: t.group,
      member: await memberMetrics(
        t.product, t.cid, t.name, t.currency, campaignLabel, t.status, window, compare,
      ),
    }));
    for (const { group, member } of results) {
      const arr = membersByClient.get(group) ?? [];
      arr.push(member);
      membersByClient.set(group, arr);
    }
  }

  const rows = [...membersByClient.entries()].map(([name, members]) => assembleRow(name, members));
  rows.sort((a, b) => a.client.toLowerCase().localeCompare(b.client.toLowerCase()));
  return { rows, generated_at: new Date().toISOString(), clickup_grouped: clickupGrouped };
}

/** Overlay each client's canonical name + Doer/Checker (and each LSA member's
 *  city) live from the ClickUp directory (cached ~10 min). Role overlays are
 *  resolved once per request via the paid-search role cutover resolver
 *  (Task #5157) — one batched call, not one DB read per client. Runs on every
 *  request — even a metrics-cache hit — so it tracks the directory's TTL and
 *  self-heals after a transient ClickUp outage. Idempotent. */
async function overlayPeople(resp: CombinedDashboardResponse): Promise<void> {
  // Task #5157: fetch ClickUp people for every row in parallel (directory is
  // cached ~10 min), then batch-resolve role overlays in ONE call. Legacy
  // doer/checker are preserved when the resolver returns no entry for a client.
  const [peopleArr, practiceAreasArr] = await Promise.all([
    Promise.all(resp.rows.map((row) => directory.peopleForClient(row.client))),
    Promise.all(
      resp.rows.map((row) =>
        directory.dashboardPracticeAreasForCids(
          row.members.map((member) => member.customer_id),
        ),
      ),
    ),
  ]);
  const resolverInputs = resp.rows.map((row, i) => ({
    clientName: peopleArr[i].client_name ?? row.client,
    legacyDoer: peopleArr[i].doer,
    legacyChecker: peopleArr[i].checker,
  }));
  const overlays = await _roleOverlayResolver(resolverInputs);

  for (let i = 0; i < resp.rows.length; i++) {
    const row = resp.rows[i];
    const people = peopleArr[i];
    // Keep ClickUp client_name canonical; fall back to the existing name when
    // the directory has no record (unknown/unlinked client).
    row.client = people.client_name || row.client;
    row.practice_areas = practiceAreasArr[i];
    const overlay = overlays.get(normClientName(people.client_name ?? row.client));
    row.doer = overlay ? overlay.doer : people.doer;
    row.checker = overlay ? overlay.checker : people.checker;
    // Append each LSA account's city so a client's multiple same-named LSA
    // accounts are distinguishable in the expanded member list.
    for (const m of row.members) {
      if (m.product === "lsa") m.city = await directory.lsaCityFor(m.customer_id);
    }
  }
}

// --- 1-hour cache (mirrors the standalone dashboards) ---
const _cache = new Map<string, { at: number; resp: CombinedDashboardResponse }>();
const _locks = new KeyedLocks();
// A DEGRADED build — some account's metrics failed ("partial"), or the rows
// were fallback-grouped per account because the ClickUp bundle wasn't live at
// build time (Task #3648) — is cached only this long (not the full hour) so it
// self-repairs on the next visit once the blip clears. But that short TTL is
// used for at most MAX_QUICK_RETRIES consecutive degraded builds per key: a
// PERSISTENT failure (dead account / genuinely-down ClickUp) would otherwise
// pin the cache at 120s forever, re-querying the whole portfolio every 2 min
// and burning the shared Ads daily quota. After the quick retries it falls
// back to the full TTL (still flagged partial / non-grouped for the UI).
const PARTIAL_TTL_MS = 120_000;
const MAX_QUICK_RETRIES = 3;
const _degradedStreak = new Map<string, number>();

/** Whether a cached build should self-repair quickly: partial metrics, or
 *  grouped without a live ClickUp bundle when ClickUp should have grouped it. */
function isDegraded(resp: CombinedDashboardResponse): boolean {
  return resp.rows.some((r) => r.metrics_partial) || resp.clickup_grouped === false;
}

export async function buildCombinedDashboardCached(
  force: boolean = false,
  window: unknown = 30,
  compare: unknown = "previous",
): Promise<{ resp: CombinedDashboardResponse; fromCache: boolean }> {
  const [win, cmp] = normalizeRange(window, compare);
  const key = `${win}:${cmp}`;
  const ttlMs = AUDIT_CACHE_TTL_SECONDS * 1000;

  const hit = (): CombinedDashboardResponse | null => {
    const cached = _cache.get(key);
    if (!cached) return null;
    const age = Date.now() - cached.at;
    const quick = isDegraded(cached.resp) && (_degradedStreak.get(key) ?? 0) <= MAX_QUICK_RETRIES;
    const effTtl = quick ? PARTIAL_TTL_MS : ttlMs;
    return age < effTtl ? cached.resp : null;
  };

  let resp = force ? null : hit();
  let fromCache = resp !== null;
  if (resp === null) {
    const out = await _locks.withLock(key, async () => {
      let r = force ? null : hit();
      const fc = r !== null;
      if (r === null) {
        r = await buildCombinedDashboard(win, cmp);
        // Track consecutive degraded builds so a persistent failure stops churning.
        if (isDegraded(r)) {
          _degradedStreak.set(key, (_degradedStreak.get(key) ?? 0) + 1);
        } else {
          _degradedStreak.set(key, 0);
        }
        _cache.set(key, { at: Date.now(), resp: r });
      }
      return { r, fc };
    });
    resp = out.r;
    fromCache = out.fc;
  }
  await overlayPacing(resp); // combined pacing is always current (live store overlay)
  await overlayStatusChecks(resp); // Paused/Off chip verification verdicts, live from store
  await overlayPeople(resp); // canonical client name + Doer/Checker, live from ClickUp
  await overlayAlerts(resp); // account alerts are live and independent of the metrics cache
  return { resp, fromCache };
}

/** Overlay every client's canonical alert rollup from ONE bounded store read.
 * Runs after people so LSA city labels match the profile, and on every request
 * (including a metrics-cache hit) so a just-finished alert refresh is visible
 * without changing the metrics cache or making a vendor call. */
async function overlayAlerts(resp: CombinedDashboardResponse): Promise<void> {
  const members = resp.rows.flatMap((row) => row.members);
  const alertMap = await _alertsMapLoader(
    members.map((member) => ({ product: member.product, cid: member.customer_id })),
  );
  for (const row of resp.rows) {
    row.alerts = normalizeClientAlertSummary(
      row.members.map((member) => ({
        product: member.product,
        customer_id: member.customer_id,
        account:
          member.product === "lsa" && member.city
            ? member.city
            : member.descriptive_name,
        document:
          alertMap[
            `${member.product}:${member.customer_id.replace(/[^0-9]/g, "")}`
          ] ?? null,
      })),
    );
  }
}

/** Whether a stored pacing summary's timestamp falls in the current calendar
 *  month. Used to decide if an Off account's month-to-date spend still counts:
 *  a wound-down Off account whose pacing later became ineligible (labeled
 *  campaigns removed / budget cleared) stops being persisted (persistSummary
 *  skips when monthly_budget is null), so its stored `mtd_spend` would
 *  otherwise freeze at last month's value and leak into the client total
 *  forever. Requiring the record to be from this month lets that value reset
 *  at the month boundary. Coarse UTC year-month match — a few hours' boundary
 *  slop is fine for this guard (On/Paused accounts don't use it). */
export function isCurrentMonth(generatedAt: unknown): boolean {
  if (typeof generatedAt !== "string" || !generatedAt) return false;
  const dt = new Date(generatedAt);
  if (Number.isNaN(dt.getTime())) return false;
  const now = new Date();
  return dt.getUTCFullYear() === now.getUTCFullYear() && dt.getUTCMonth() === now.getUTCMonth();
}

interface CombinedPacingInput {
  adsStatus: AdsStatus;
  budget: number | null;
  mtd: number | null;
  expected: number | null;
  generatedAt: unknown;
}

interface CombinedPacingAggregate {
  included: boolean[];
  budget: number | null;
  mtd: number | null;
  expected: number | null;
  pacePct: number | null;
  budgetHit: boolean;
}

/**
 * Canonical client-level pacing aggregate.
 *
 * Eligible MTD spend is independent of budget configuration: an included
 * account with spend but no ClickUp budget still contributes to total MTD.
 * Budgets and schedule-aware expected targets contribute only when that
 * account has a configured budget. Product dashboards intentionally do not
 * use this reducer; they continue to show each product/account in isolation.
 */
export function aggregateCombinedPacing(inputs: CombinedPacingInput[]): CombinedPacingAggregate {
  let totalBudget = 0;
  let totalMtd = 0;
  let totalExpected = 0;
  let hasBudget = false;
  const included = inputs.map((input) => {
    const offSpending =
      (input.mtd ?? 0) > 0 && isCurrentMonth(input.generatedAt);
    const counts = input.adsStatus !== "off" || offSpending;
    if (!counts) return false;

    // Spend is an independent contribution. Do not hide it merely because
    // ClickUp has no positive budget for this product/account.
    totalMtd += input.mtd ?? 0;
    if (input.budget !== null) {
      hasBudget = true;
      totalBudget += input.budget;
      totalExpected += input.expected ?? 0;
    }
    return true;
  });

  if (!hasBudget) {
    return {
      included,
      budget: null,
      mtd: null,
      expected: null,
      pacePct: null,
      budgetHit: false,
    };
  }

  const budget = round2(totalBudget);
  const mtd = round2(totalMtd);
  const expected = round2(totalExpected);
  return {
    included,
    budget,
    mtd,
    expected,
    pacePct:
      expected > 0
        ? Math.round((mtd / expected - 1) * 1000) / 10
        : null,
    budgetHit: budget > 0 && mtd >= budget,
  };
}

/** Overlay each client's combined budget pacing live from the per-product
 *  pacing stores (GAds + LSA), the same way the standalone dashboards overlay
 *  their own pacing — so it reflects the morning refresh / a just-run pacing
 *  report and never goes stale. Adds ZERO Google Ads API calls: it only reads
 *  the stores the per-product dashboards and the morning cron already keep
 *  current (plus, per LSA member, the criteria store's schedule — the same
 *  read the LSA dashboard makes per row).
 *
 *  The combined pace % blends the two products by expected-to-date (each
 *  product's expected spend already encodes its own schedule), so the client
 *  is judged ahead/behind on its TOTAL monthly budget. Per-account pacing is
 *  attached to each member for the dashboard's hover breakdown. */
async function overlayPacing(resp: CombinedDashboardResponse): Promise<void> {
  await Promise.all(
    resp.rows.map(async (row) => {
      let active = false;
      let hasG = false;
      let hasL = false;
      const pacingInputs: CombinedPacingInput[] = [];
      for (const m of row.members) {
        const pacing =
          (m.product === "gads"
            ? await budgetPacingStore.get(m.customer_id)
            : await lsaBudgetPacingStore.get(m.customer_id)) ?? {};
        const budget: number | null = pacing.monthly_budget ?? null;
        const mtd: number | null = pacing.mtd_spend ?? null;
        const expected: number | null = pacing.expected_to_date ?? null;
        // GAds store key is "budget_pacing_pct"; LSA store key is "pacing_pct".
        m.pacing_pct =
          (m.product === "gads" ? pacing.budget_pacing_pct : pacing.pacing_pct) ?? null;
        m.pacing_budget = budget;
        m.pacing_mtd = mtd;
        // Task #3897: reconciliation context for the pill's breakdown — the
        // inputs behind the stored figures (expected-to-date, budget source,
        // applied schedule, run time), so a disagreement with the original app
        // is explainable per account without opening its pacing tool. Older
        // docs that predate a field stay null (the UI omits the line).
        // Display-only: none of this feeds the blend below.
        m.pacing_expected = expected;
        m.pacing_budget_source =
          typeof pacing.budget_source === "string" && pacing.budget_source !== "none"
            ? pacing.budget_source
            : null;
        m.pacing_generated_at =
          typeof pacing.generated_at === "string" && pacing.generated_at !== ""
            ? pacing.generated_at
            : null;
        if (m.product === "gads") {
          m.pacing_schedule_days = Array.isArray(pacing.schedule_days)
            ? pacing.schedule_days.filter((d: unknown): d is string => typeof d === "string")
            : null;
          m.pacing_schedule_source =
            typeof pacing.schedule_source === "string" ? pacing.schedule_source : null;
        } else {
          // The LSA pacing store doesn't carry the schedule; read it from the
          // criteria store exactly like the LSA dashboard's Schedule column
          // (saved days, or the every-day default — the LSA engine never
          // infers). Best-effort: unknown beats mislabeled.
          try {
            const { criteria } = await loadCriteria(m.customer_id);
            m.pacing_schedule_days = criteria.lsa_schedule_days;
            m.pacing_schedule_source = criteria.lsa_schedule_days.length ? "saved" : "default";
          } catch {
            m.pacing_schedule_days = null;
            m.pacing_schedule_source = null;
          }
        }
        // An Off account counts toward the client's budget only while it still
        // has spend THIS MONTH (recently switched off); On/Paused always count.
        // Keyed on the monthly store's MTD (not the selected window's spend, so
        // a fresh-month 90-day view can't inject a budget with no month-to-date
        // spend) AND that the stored figure is from the current month (so a
        // frozen, no-longer-refreshed Off account doesn't leak a stale budget
        // forever).
        const offSpending = (mtd ?? 0) > 0 && isCurrentMonth(pacing.generated_at);
        pacingInputs.push({
          adsStatus: m.ads_status,
          budget,
          mtd,
          expected,
          generatedAt: pacing.generated_at,
        });
        // "Shown" drives has_active_monitoring + the per-product tags: an Off
        // account is visible while it has recent window spend OR current-month
        // MTD. Recomputed here (not left at assembleRow's window-only value) so
        // has_gads/has_lsa stay consistent with has_active_monitoring — else a
        // just-switched-off GAds-only client with MTD-but-no-window-spend would
        // show yet be mislabeled "LSA".
        const shown = m.ads_status !== "off" || m.spend_30d > 0 || offSpending;
        if (shown) {
          active = true;
          if (m.product === "gads") hasG = true;
          else hasL = true;
        }
      }
      const aggregate = aggregateCombinedPacing(pacingInputs);
      row.members.forEach((member, index) => {
        member.pacing_included = aggregate.included[index] ?? false;
      });
      row.has_active_monitoring = active;
      row.has_gads = hasG;
      row.has_lsa = hasL;
      row.pacing_budget = aggregate.budget;
      row.pacing_mtd = aggregate.mtd;
      row.pacing_expected = aggregate.expected;
      row.pacing_pct = aggregate.pacePct;
      row.pacing_hit = aggregate.budgetHit;
    }),
  );
}

// ---------------------------------------------------------------------------
// Status-check overlay (Task #4878)
// ---------------------------------------------------------------------------

/** Test seam: inject a pre-built status-check doc so tests don't need the DB. */
let _statusCheckDocOverride: Record<string, any> | null = null;
export function __setStatusCheckDocOverrideForTest(doc: Record<string, any> | null): void {
  _statusCheckDocOverride = doc;
}

/** Overlay Paused/Off verification verdicts onto each member from the same
 *  status-check store doc the AM Dashboard reads. ONE doc read per request —
 *  reading it outside the member loop avoids N concurrent store reads. */
async function overlayStatusChecks(resp: CombinedDashboardResponse): Promise<void> {
  const doc = _statusCheckDocOverride ?? await getStatusCheckDoc();
  const checks = (doc.checks ?? {}) as Record<string, StatusCheckEntry>;
  for (const row of resp.rows) {
    for (const m of row.members) {
      const key = `${m.product}:${m.customer_id}`;
      m.status_check =
        m.ads_status === "paused" || m.ads_status === "off"
          ? (checks[key] ?? null)
          : null;
    }
  }
}

/** Test hook: reset the metrics cache + degraded streaks. */
export function __testResetCombinedDashboardCache(): void {
  _cache.clear();
  _degradedStreak.clear();
}

/** Task #4964 — drop every cached combined-dashboard build on THIS instance.
 *  Called by the one-press monitor-label apply action after it labels
 *  zero-label accounts, so the fixed accounts show real numbers on the next
 *  dashboard read instead of waiting out the ~1h TTL. (In-process cache: on
 *  autoscale, sibling instances age out via TTL — acceptable, the action is a
 *  rare operator repair.) */
export function invalidateCombinedDashboardCache(): void {
  _cache.clear();
}

/** Test hook: age every cached combined build by `ms` (simulates time passing). */
export function __testAgeCombinedDashboardCache(ms: number): void {
  for (const entry of _cache.values()) entry.at -= ms;
}
