/**
 * Ads OS — Account Alerts engine (port of backend/app/alerts/engine.py).
 *
 * Compute critical issues per account, persist, digest. Strictly read-only.
 * Mirrors the legacy MCC monitor script's checks (and adds a few the official
 * API makes easy), but runs from our one MCC client. The GAds checks exclude
 * nothing extra — they're already scoped to the account's labeled
 * NBM_GADS_MONITOR_CAMPAIGN campaigns (LSA lives in its own accounts).
 *
 * Severity tiers:  critical -> red,  high -> amber,  medium -> grey.
 * Only critical + high are sent to Slack; medium is dashboard-only (keeps the
 * channel quiet). `runAlerts` does compute + persist for every enrolled
 * account (GAds + LSA) and, when notify=true, sends the only-on-change Slack
 * digest.
 */

import { scannableCampaignIds } from "./audit/context";
import * as directory from "./clickUpDirectory";
import {
  ALERTS_CPL_LOOKBACK_DAYS,
  ALERTS_CPL_THRESHOLD_DOLLARS,
  ALERTS_NO_CONV_DAYS,
  ALERTS_SPEND_SPIKE_PCT,
  KI_CAMPAIGN_LABEL,
} from "./config";
import { loadCriteria } from "./criteriaService";
import { addDays, isoDate, PlainDate, plainToday } from "./dateRange";
import { enrolledAccounts, labeledCampaignIds, EnrolledAccount } from "./enrollment";
import { scheduledIndices } from "./pacingEngine";
import { mapPool } from "./singleflight";
import { putAlerts } from "./store";
import { Alert, Product } from "./types";
import {
  fetchCustomerStatus,
  fetchGadsAlertRows,
  fetchLsaCampaigns,
  fetchLsaCost,
  fetchLsaLeads,
  fetchLsaVerificationArtifacts,
  LsaVerificationArtifactRow,
} from "./alertsQueries";

// customer.status values that mean the account has stopped serving. v24
// CustomerStatus: ENABLED / SUSPENDED / CANCELED / CLOSED (CLOSED = permanent).
const DEAD_STATUSES = new Set(["SUSPENDED", "CANCELED", "CLOSED"]);

/** DESTINATION_NOT_WORKING -> 'Destination Not Working'. */
function prettify(code: string): string {
  return String(code)
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A short, human list of the affected campaigns for an alert detail, so the
 *  team can find them (e.g. ads disapproved in a specific trial campaign). */
function campSummary(campName: Record<string, string>, campIds: Iterable<string>, limit = 2): string {
  const ids = [...campIds];
  const nm = (cid: string): string => {
    const n = campName[cid] || cid;
    return n.length <= 52 ? n : n.slice(0, 51).trimEnd() + "…";
  };
  let names = ids.slice(0, limit).map(nm).join(", ");
  if (ids.length > limit) names += ` +${ids.length - limit} more`;
  return names;
}

function money(micros: number): string {
  return "$" + (micros / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function makeAlert(
  code: string,
  severity: Alert["severity"],
  title: string,
  detail: string,
  product: Product,
  deepLink: string | null = null,
): Alert {
  return { code, severity, title, detail, product, campaign_id: null, deep_link: deepLink, clickup_task: null };
}

function formatMetricCount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatDollars(value: number): string {
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function highCplAlert(
  product: Product,
  startIso: string,
  endIso: string,
  costMicros: number,
  count: number,
  countLabel: string,
  deepLink: string | null,
): Alert | null {
  if (!Number.isFinite(costMicros) || costMicros < 0 || !Number.isFinite(count) || count <= 0) return null;
  const spend = costMicros / 1e6;
  const cpl = spend / count;
  if (!Number.isFinite(cpl) || cpl <= ALERTS_CPL_THRESHOLD_DOLLARS) return null;
  return makeAlert(
    "high_cpl",
    "high",
    `30-day CPL ${formatDollars(cpl)}`,
    `${startIso} through ${endIso}: ${formatDollars(spend)} spend, ` +
      `${formatMetricCount(count)} ${countLabel}, CPL ${formatDollars(cpl)}.`,
    product,
    deepLink,
  );
}

// Verification artifact statuses that mean "actively not passing". CANCELLED = a
// superseded older submission; PENDING = in progress — neither is a failure.
const BAD_VERIFY = new Set(["FAILED", "EXPIRED", "NO_SUBMISSION", "REJECTED"]);

/** Artifact types with NO currently-passing artifact and a genuinely bad latest
 *  one. Mirrors the LSA hygiene verification check: a current PASSED supersedes
 *  older CANCELLED/failed submissions, and PENDING ('in progress') is not a
 *  failure — so an account that re-submitted and passed isn't flagged for its
 *  old rejected artifact. */
export function failingVerificationTypes(artifacts: LsaVerificationArtifactRow[]): string[] {
  const byType = new Map<string, LsaVerificationArtifactRow[]>();
  for (const a of artifacts) {
    const list = byType.get(a.artifactType) ?? [];
    list.push(a);
    byType.set(a.artifactType, list);
  }
  const bad: string[] = [];
  for (const [atype, items] of byType) {
    if (items.some((a) => a.status === "PASSED")) continue;
    const nonCancelled = items.filter((a) => a.status !== "CANCELLED");
    const pool = nonCancelled.length ? nonCancelled : items;
    // "YYYY-MM-DD HH:MM:SS" strings sort chronologically; blank sorts first.
    const latest = pool.reduce((best, a) =>
      (a.creationDateTime || "") >= (best.creationDateTime || "") ? a : best,
    );
    if (BAD_VERIFY.has(latest.status)) bad.push(atype);
  }
  return bad;
}

// ============================================================================
//  GOOGLE ADS
// ============================================================================

interface GadsRanges {
  yesterday: string;
  daily_start: string;
  daily_end: string;
  spend_base_start: string;
  spend_base_end: string;
  week_start: string;
  week_end: string;
  cpl_start: string;
  cpl_end: string;
  prior_weekdays: string[];
}

export function gadsRanges(today: PlainDate): GadsRanges {
  const yesterday = addDays(today, -1);
  const noConvDays = ALERTS_NO_CONV_DAYS;
  return {
    yesterday: isoDate(yesterday),
    // 29-day daily window: covers the spend-spike baseline AND the prior 4
    // same-weekdays used to infer serving days when criteria has no schedule.
    daily_start: isoDate(addDays(today, -29)),
    daily_end: isoDate(yesterday),
    // spend-spike baseline: 7 days ending the day BEFORE yesterday.
    spend_base_start: isoDate(addDays(today, -8)),
    spend_base_end: isoDate(addDays(today, -2)),
    // no-conversions window.
    week_start: isoDate(addDays(today, -noConvDays)),
    week_end: isoDate(yesterday),
    // Fixed rolling window: 30 complete calendar days through yesterday.
    cpl_start: isoDate(addDays(today, -ALERTS_CPL_LOOKBACK_DAYS)),
    cpl_end: isoDate(yesterday),
    // Same weekday as yesterday, 1–4 weeks back — the data-driven schedule fallback.
    prior_weekdays: [1, 2, 3, 4].map((w) => isoDate(addDays(yesterday, -7 * w))),
  };
}

/** Python-convention weekday (Mon=0..Sun=6) for an ISO date string. */
function pyWeekdayOfIso(iso: string): number {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export async function computeGadsAlerts(
  customerId: string,
  _accountName: string,
  campaignIds: string[],
  cplCampaignIds: string[] = campaignIds,
  deepLink: string | null = null,
): Promise<Alert[]> {
  const cid = customerId.replace(/-/g, "").trim();
  const r = gadsRanges(plainToday());
  const { data, warnings } = await fetchGadsAlertRows(
    cid,
    campaignIds,
    cplCampaignIds,
    r.daily_start,
    r.daily_end,
    r.week_start,
    r.week_end,
    r.cpl_start,
    r.cpl_end,
  );
  const alerts: Alert[] = [];

  // --- Account status / billing (account level) ---
  let status = "";
  for (const row of data.customer ?? []) {
    status = String(row.customer?.status ?? "");
  }
  if (DEAD_STATUSES.has(status)) {
    alerts.push(makeAlert(
      "account_suspended", "critical",
      `Account ${status.toLowerCase()}`,
      "The whole account has stopped serving — check Billing & Payments.",
      "gads",
    ));
  }

  // --- Rolling 30-complete-day CPL (all labeled monitored campaigns) ---
  // This deliberately uses cplCampaignIds rather than the narrower serving-
  // health campaignIds set. A campaign paused during the window still belongs
  // in the same historical performance scope shown on the dashboards.
  if (cplCampaignIds.length && !warnings.some((w) => w.startsWith("cpl:"))) {
    let cplCost = 0;
    let cplConversions = 0;
    let valid = true;
    for (const row of data.cpl ?? []) {
      const cost = Number(row.metrics?.costMicros ?? 0);
      const conversions = Number(row.metrics?.conversions ?? 0);
      if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(conversions) || conversions < 0) {
        valid = false;
        break;
      }
      cplCost += cost;
      cplConversions += conversions;
    }
    if (valid) {
      const alert = highCplAlert(
        "gads", r.cpl_start, r.cpl_end, cplCost, cplConversions, "primary conversions", deepLink,
      );
      if (alert) alerts.push(alert);
    }
  }

  if (!campaignIds.length) {
    return alerts; // nothing campaign-scoped to check
  }

  const campRows = data.campaigns ?? [];
  const campName: Record<string, string> = {};
  const chan: Record<string, string> = {};
  const sub: Record<string, string> = {};
  for (const row of campRows) {
    const id = String(row.campaign?.id ?? "");
    campName[id] = String(row.campaign?.name ?? "");
    chan[id] = String(row.campaign?.advertisingChannelType ?? "");
    sub[id] = String(row.campaign?.advertisingChannelSubType ?? "");
  }
  // Ended campaigns — including ended experiments/trials — keep campaign.status
  // ENABLED but report primary_status ENDED. Exclude them from every check so we
  // never flag a campaign that no longer serves (mirrors the hygiene audit).
  const ended = new Set(
    campRows
      .filter((row) => String(row.campaign?.primaryStatus ?? "") === "ENDED")
      .map((row) => String(row.campaign?.id ?? "")),
  );
  const enabled = new Set(
    campRows
      .filter((row) => String(row.campaign?.status ?? "") === "ENABLED" && !ended.has(String(row.campaign?.id ?? "")))
      .map((row) => String(row.campaign?.id ?? "")),
  );

  // --- Daily cost (all scanned campaigns) + ENABLED-only impressions ---
  // Impressions are counted for ENABLED campaigns only, so the "no impressions
  // yesterday" rule reflects only campaigns that are supposed to be serving — a
  // paused (but recently-active) campaign never suppresses or triggers it. Cost
  // spans every scanned campaign (the spend-spike baseline wants total spend).
  const imprByDate: Record<string, number> = {}; // ENABLED campaigns only
  const costByDate: Record<string, number> = {};
  for (const row of data.daily ?? []) {
    const d = String(row.segments?.date ?? "");
    costByDate[d] = (costByDate[d] ?? 0) + Number(row.metrics?.costMicros ?? 0);
    if (enabled.has(String(row.campaign?.id ?? ""))) {
      imprByDate[d] = (imprByDate[d] ?? 0) + Number(row.metrics?.impressions ?? 0);
    }
  }

  // --- No impressions yesterday (respects the client's criteria schedule) ---
  // Only flag a day the account is supposed to run. If the client criteria has a
  // schedule, honor it exactly (Mon–Sun; e.g. a Mon–Fri client is never flagged
  // on a weekend). If no schedule is set, infer the serving days from history —
  // did it serve this same weekday in the prior 4 weeks? — so weekday-only
  // accounts still aren't flagged on weekends. Impressions here are ENABLED-only
  // and the `enabled` guard requires ≥1 enabled campaign, so this fires solely
  // for enabled campaigns.
  const { criteria } = await loadCriteria(cid);
  let isServingDay: boolean;
  if (criteria.schedule_days.length) {
    isServingDay = scheduledIndices(criteria.schedule_days).has(pyWeekdayOfIso(r.yesterday));
  } else {
    isServingDay = r.prior_weekdays.some((d) => (imprByDate[d] ?? 0) > 0);
  }
  if (enabled.size && isServingDay && (imprByDate[r.yesterday] ?? 0) === 0) {
    alerts.push(makeAlert(
      "no_impressions", "critical",
      "No impressions yesterday",
      "A scheduled day with 0 impressions while campaigns are enabled — " +
        "check for a billing error, suspension, or disapprovals.",
      "gads",
    ));
  }

  // --- Spend spike (vs trailing 7-day active-day average) ---
  const base = Object.entries(costByDate)
    .filter(([d, v]) => d >= r.spend_base_start && d <= r.spend_base_end && v > 0)
    .map(([, v]) => v);
  if (base.length) {
    const avg = base.reduce((a, b) => a + b, 0) / base.length;
    const y = costByDate[r.yesterday] ?? 0;
    if (avg > 0 && y > 0) {
      const pct = ((y - avg) / avg) * 100;
      if (pct > ALERTS_SPEND_SPIKE_PCT) {
        alerts.push(makeAlert(
          "spend_spike", "medium",
          `Spend spike +${Math.round(pct)}%`,
          `Yesterday ${money(y)} vs 7-day avg ${money(avg)}.`,
          "gads",
        ));
      }
    }
  }

  // --- Weekly aggregate: spend with no conversions ---
  let wkCost = 0;
  let wkConv = 0;
  for (const row of data.weekly ?? []) {
    if (ended.has(String(row.campaign?.id ?? ""))) continue;
    wkCost += Number(row.metrics?.costMicros ?? 0);
    wkConv += Number(row.metrics?.conversions ?? 0);
  }
  if (wkCost > 0 && wkConv === 0) {
    alerts.push(makeAlert(
      "no_conversions", "high",
      `No conversions in ${ALERTS_NO_CONV_DAYS} days`,
      `Spent ${money(wkCost)} with 0 conversions — check conversion tracking.`,
      "gads",
    ));
  }

  // --- Disapproved / limited / under-review ads ---
  // The ads_policy query is scoped to ENABLED ads in ENABLED ad groups within the
  // scannable labeled campaigns (enabled OR spent in the last 7d), so a recently-
  // active but now-paused campaign's live ads still get checked, while its
  // ad-group/ad scoping stays ENABLED-only. We also skip ENDED campaigns.
  const disByCamp: Record<string, number> = {};
  const limByCamp: Record<string, number> = {};
  const urByCamp: Record<string, number> = {};
  const disTopics = new Set<string>();
  const limTopics = new Set<string>();
  const hasAds = new Set<string>();
  for (const row of data.ads_policy ?? []) {
    const cc = String(row.campaign?.id ?? "");
    if (ended.has(cc)) continue;
    hasAds.add(cc); // any ENABLED ad in an ENABLED group/campaign
    const ps = row.adGroupAd?.policySummary ?? {};
    const appr = String(ps.approvalStatus ?? "");
    if (appr === "DISAPPROVED") {
      disByCamp[cc] = (disByCamp[cc] ?? 0) + 1;
      for (const entry of ps.policyTopicEntries ?? []) {
        const t = String(entry?.topic ?? "");
        if (t) disTopics.add(prettify(t));
      }
    } else if (appr === "APPROVED_LIMITED") {
      limByCamp[cc] = (limByCamp[cc] ?? 0) + 1;
      for (const entry of ps.policyTopicEntries ?? []) {
        const t = String(entry?.topic ?? "");
        if (t) limTopics.add(prettify(t));
      }
    } else if (["REVIEW_IN_PROGRESS", "UNDER_APPEAL"].includes(String(ps.reviewStatus ?? ""))) {
      urByCamp[cc] = (urByCamp[cc] ?? 0) + 1;
    }
  }
  if (Object.keys(disByCamp).length) {
    const total = Object.values(disByCamp).reduce((a, b) => a + b, 0);
    let detail = `${total} ad(s) in ${campSummary(campName, Object.keys(disByCamp))}.`;
    if (disTopics.size) {
      detail += " Reasons: " + [...disTopics].sort().slice(0, 3).join(", ") + ".";
    }
    alerts.push(makeAlert("disapproved_ads", "high", `${total} disapproved ad(s)`, detail, "gads"));
  }
  if (Object.keys(limByCamp).length) {
    const total = Object.values(limByCamp).reduce((a, b) => a + b, 0);
    let detail = `${total} ad(s) in ${campSummary(campName, Object.keys(limByCamp))} — approved with restrictions (limited reach).`;
    if (limTopics.size) {
      detail += " Reasons: " + [...limTopics].sort().slice(0, 3).join(", ") + ".";
    }
    alerts.push(makeAlert("limited_ads", "medium", `${total} limited ad(s)`, detail, "gads"));
  }
  if (Object.keys(urByCamp).length) {
    const total = Object.values(urByCamp).reduce((a, b) => a + b, 0);
    alerts.push(makeAlert(
      "under_review_ads", "medium",
      `${total} ad(s) under review`,
      `${total} ad(s) in ${campSummary(campName, Object.keys(urByCamp))} awaiting Google review.`,
      "gads",
    ));
  }

  // --- Can't serve: SEARCH/SHOPPING (ads + keywords) or PMax (asset groups) ---
  // SEARCH/SHOPPING serve via ads + keywords; PERFORMANCE_MAX serves via asset
  // groups, so it's judged on asset_group.primary_status instead. A PMax campaign
  // can serve when >=1 asset group is ELIGIBLE or LIMITED; if none are (all
  // NOT_ELIGIBLE / paused) it can't serve at all → no_eligible_ads. Asset groups
  // still PENDING review don't count as a failure (a brand-new campaign isn't
  // broken). Display/Video are left out.
  const hasKw = new Set((data.has_keywords ?? []).map((row) => String(row.campaign?.id ?? "")));
  const agStatus: Record<string, string[]> = {}; // PMax campaign id -> asset-group primary_status names
  for (const row of data.asset_groups ?? []) {
    const cc = String(row.campaign?.id ?? "");
    (agStatus[cc] = agStatus[cc] ?? []).push(String(row.assetGroup?.primaryStatus ?? ""));
  }
  // Only trust "no asset group => can't serve" when the asset_groups query
  // actually succeeded. If it errored, every PMax campaign would look empty and
  // we'd flag a false "can't serve" storm — so on failure we skip the can't-serve
  // check entirely (the disapproved/limited sub-checks below already require
  // positive data).
  const agOk = !warnings.some((w) => w.startsWith("asset_groups:"));

  const noServe: string[] = [];
  const disAgByCamp: Record<string, number> = {}; // disapproved asset groups in a still-serving PMax campaign
  const limAgByCamp: Record<string, number> = {}; // limited (reduced-reach) asset groups
  for (const ccid of campaignIds) {
    if (!enabled.has(ccid)) continue;
    const ct = chan[ccid] ?? "";
    const st = sub[ccid] ?? "";
    if (ct === "PERFORMANCE_MAX") {
      const statuses = agStatus[ccid] ?? [];
      if (statuses.some((s) => s === "ELIGIBLE" || s === "LIMITED")) {
        // Campaign serves — surface any disapproved / limited asset groups it
        // still carries (won't stop it, but wastes creative / limits reach).
        const nd = statuses.filter((s) => s === "NOT_ELIGIBLE").length;
        const nl = statuses.filter((s) => s === "LIMITED").length;
        if (nd) disAgByCamp[ccid] = nd;
        if (nl) limAgByCamp[ccid] = nl;
      } else if (agOk && !(statuses.length && statuses.every((s) => s === "PENDING"))) {
        // Query succeeded and nothing can serve (all NOT_ELIGIBLE / paused, or
        // every asset group removed → empty). A brand-new campaign whose only
        // asset groups are still PENDING review is left alone; PMax requires >=1
        // asset group at creation, so a truly empty set means they were all
        // removed → can't serve.
        noServe.push(`${campName[ccid] || ccid} (no eligible asset group)`);
      }
      continue;
    }
    if (ct !== "SEARCH" && ct !== "SHOPPING") continue;
    const noAds = !hasAds.has(ccid);
    const noKw = ct === "SEARCH" && st !== "SEARCH_DYNAMIC_ADS" && !hasKw.has(ccid);
    if (noAds || noKw) {
      const issue =
        noAds && noKw ? "no eligible ads or keywords" : noAds ? "no eligible ads" : "no eligible keywords";
      noServe.push(`${campName[ccid] || ccid} (${issue})`);
    }
  }
  if (noServe.length) {
    alerts.push(makeAlert(
      "no_eligible_ads", "critical",
      `${noServe.length} campaign(s) can't serve`,
      noServe.slice(0, 3).join(", ") + (noServe.length > 3 ? " …" : "") + ".",
      "gads",
    ));
  }
  if (Object.keys(disAgByCamp).length) {
    const total = Object.values(disAgByCamp).reduce((a, b) => a + b, 0);
    alerts.push(makeAlert(
      "pmax_asset_group_disapproved", "high",
      `${total} disapproved PMax asset group(s)`,
      `${total} asset group(s) not eligible to serve in ` +
        `${campSummary(campName, Object.keys(disAgByCamp))} — the campaign still serves ` +
        "via its other asset groups.",
      "gads",
    ));
  }
  if (Object.keys(limAgByCamp).length) {
    const total = Object.values(limAgByCamp).reduce((a, b) => a + b, 0);
    alerts.push(makeAlert(
      "pmax_asset_group_limited", "medium",
      `${total} limited PMax asset group(s)`,
      `${total} asset group(s) serving with limited reach in ` +
        `${campSummary(campName, Object.keys(limAgByCamp))}.`,
      "gads",
    ));
  }

  // --- Limited vs disapproved assets (sitelinks, callouts, images) ---
  // The asset_policy query returns ENABLED campaign assets whose primary_status
  // is LIMITED or NOT_ELIGIBLE. Split them: NOT_ELIGIBLE = can't serve at all
  // (high — needs attention + Slack); LIMITED = reduced reach (medium,
  // dashboard-only).
  const limAssets: Record<string, number> = {};
  const disAssets: Record<string, number> = {};
  for (const row of data.asset_policy ?? []) {
    const cc = String(row.campaign?.id ?? "");
    if (ended.has(cc)) continue;
    const ps = String(row.campaignAsset?.primaryStatus ?? "");
    if (ps === "NOT_ELIGIBLE") {
      disAssets[cc] = (disAssets[cc] ?? 0) + 1;
    } else if (ps === "LIMITED") {
      limAssets[cc] = (limAssets[cc] ?? 0) + 1;
    }
  }
  if (Object.keys(disAssets).length) {
    const total = Object.values(disAssets).reduce((a, b) => a + b, 0);
    alerts.push(makeAlert(
      "disapproved_assets", "high",
      `${total} disapproved asset(s)`,
      `${total} sitelink/callout/image asset(s) in ${campSummary(campName, Object.keys(disAssets))} ` +
        "not eligible to serve.",
      "gads",
    ));
  }
  if (Object.keys(limAssets).length) {
    const total = Object.values(limAssets).reduce((a, b) => a + b, 0);
    alerts.push(makeAlert(
      "limited_assets", "medium",
      `${total} limited asset(s)`,
      `${total} sitelink/callout/image asset(s) in ${campSummary(campName, Object.keys(limAssets))} ` +
        "approved with limited reach.",
      "gads",
    ));
  }

  return alerts;
}

// ============================================================================
//  LOCAL SERVICES ADS
// ============================================================================

export async function computeLsaAlerts(
  customerId: string,
  _accountName: string,
  deepLink: string | null = null,
): Promise<Alert[]> {
  const cid = customerId.replace(/-/g, "").trim();
  const today = plainToday();
  const yesterday = addDays(today, -1);
  const last7Start = isoDate(addDays(today, -7));
  const priorStart = isoDate(addDays(today, -37));
  const cplStart = isoDate(addDays(today, -ALERTS_CPL_LOOKBACK_DAYS));
  const periodEnd = isoDate(yesterday);
  const alerts: Alert[] = [];

  // --- Account status ---
  const status = await fetchCustomerStatus(cid);
  if (DEAD_STATUSES.has(status)) {
    alerts.push(makeAlert(
      "account_suspended", "critical",
      `Account ${status.toLowerCase()}`,
      "The LSA account has stopped serving — check Billing & Payments.",
      "lsa",
    ));
  }

  // --- LSA paused (no LOCAL_SERVICES campaign ENABLED) ---
  const { rows: campaigns } = await fetchLsaCampaigns(cid);
  if (campaigns.length && !campaigns.some((c) => c.status === "ENABLED")) {
    alerts.push(makeAlert(
      "lsa_paused", "critical",
      "LSA paused",
      "No Local Services campaign is enabled — the LSA isn't running.",
      "lsa",
    ));
  }

  // --- Verification failed (license / insurance / background check) ---
  // Per-type: a current PASSED supersedes old rejected/cancelled submissions, so
  // a re-verified account isn't flagged for a stale artifact (mirrors LSA hygiene).
  const { rows: artifacts } = await fetchLsaVerificationArtifacts(cid);
  const failed = failingVerificationTypes(artifacts).map(prettify).sort();
  if (failed.length) {
    alerts.push(makeAlert(
      "lsa_verification_failed", "critical",
      "Verification not passing",
      `${failed.join(", ")} not passing. The LSA can be suspended until resolved.`,
      "lsa",
    ));
  }

  // --- No charged leads in 7 days (established accounts only) ---
  const [{ rows: leads, warning: leadsWarning }, { rows: costRows, warning: costWarning }] =
    await Promise.all([
      fetchLsaLeads(cid, priorStart, periodEnd),
      fetchLsaCost(cid, cplStart, periodEnd),
    ]);
  let last7 = 0;
  let prior = 0;
  let cplCharged = 0;
  let cplLeadDatesValid = true;
  for (const ld of leads) {
    if (!ld.charged) continue;
    const leadDate = ld.creationDateTime.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(leadDate)) {
      cplLeadDatesValid = false;
      continue;
    }
    if (leadDate >= last7Start) last7 += 1;
    else prior += 1;
    if (leadDate >= cplStart && leadDate <= periodEnd) cplCharged += 1;
  }
  if (last7 === 0 && prior > 0) {
    alerts.push(makeAlert(
      "lsa_no_leads", "high",
      "No charged leads in 7 days",
      `0 charged leads in the last 7 days (≈${prior} in the prior 30) — ` +
        "check status, budget or verification.",
      "lsa",
    ));
  }

  // --- Rolling 30-complete-day CPL (Local Services spend / charged leads) ---
  if (!leadsWarning && !costWarning && cplLeadDatesValid) {
    let cplCost = 0;
    let valid = true;
    for (const row of costRows) {
      const cost = Number(row.costMicros);
      if (!Number.isFinite(cost) || cost < 0) {
        valid = false;
        break;
      }
      cplCost += cost;
    }
    if (valid) {
      const alert = highCplAlert(
        "lsa", cplStart, periodEnd, cplCost, cplCharged, "charged leads", deepLink,
      );
      if (alert) alerts.push(alert);
    }
  }

  return alerts;
}

// ============================================================================
//  ORCHESTRATION
// ============================================================================
// Alert codes that are EXPECTED while an account is deliberately Paused (ClickUp
// Ads Status = Paused) — the account isn't meant to be serving, so these are
// noise. Hard failures (suspension/billing, verification, disapproved/limited
// ads + assets, under review) are NOT suppressed: those still need attention
// even on a paused account.
const SUPPRESS_WHEN_PAUSED = new Set([
  "no_impressions", "spend_spike", "no_conversions", "high_cpl", // GAds performance family
  "no_eligible_ads",                                 // GAds can't-serve
  "lsa_paused", "lsa_no_leads",                      // LSA "not serving" family
]);

/** Filter a freshly-computed alert list by the account's ClickUp Ads Status.
 *  Off -> [] (cleared — Off accounts never alert). Paused -> drop the expected-
 *  while-paused codes, keep hard failures. On / blank -> unchanged. */
export function applyStatus(alerts: Alert[], status: string | null): Alert[] {
  if (status === "off") return [];
  if (status === "paused") return alerts.filter((a) => !SUPPRESS_WHEN_PAUSED.has(a.code));
  return alerts;
}

async function saveAlertsDoc(cid: string, name: string, product: Product, alerts: Alert[]): Promise<void> {
  const counts: Record<string, number> = {};
  for (const a of alerts) {
    counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  }
  await putAlerts(product, cid, {
    account_name: name,
    product,
    alerts,
    counts,
    generated_at: new Date().toISOString(),
  });
}

/** results entry: [cid, name, product, alerts | null] (null = failed run). */
export type AlertRunResult = [string, string, Product, Alert[] | null];

export interface RunAlertsSummary {
  gads_accounts: number;
  lsa_accounts: number;
  total_alerts: number;
  digest: Record<string, any>;
}

interface RunAlertsDeps {
  enrolledAccounts: typeof enrolledAccounts;
  labeledCampaignIds: typeof labeledCampaignIds;
  scannableCampaignIds: typeof scannableCampaignIds;
  adsStatusFor: typeof directory.adsStatusFor;
  clickUpDeepLinks: typeof directory.clickUpDeepLinks;
  refreshTaskStates: (results: AlertRunResult[]) => Promise<void>;
}

const DEFAULT_RUN_ALERTS_DEPS: RunAlertsDeps = {
  enrolledAccounts,
  labeledCampaignIds,
  scannableCampaignIds,
  adsStatusFor: directory.adsStatusFor,
  clickUpDeepLinks: directory.clickUpDeepLinks,
  refreshTaskStates: async (results) => {
    const { refreshTaskStates } = await import("./clickUpTasks");
    await refreshTaskStates(results);
  },
};

/**
 * Compute + persist alerts for the ENROLLED accounts of each product in
 * `products`, then (if notify) send the only-on-change Slack digest.
 *
 * Enrollment + the per-account Ads Status come from ClickUp (see enrollment.ts):
 *   - On     -> compute + persist as usual.
 *   - Paused -> compute, then drop the expected-while-paused alerts (keep hard failures).
 *   - Off    -> persist EMPTY (clears any stale alerts from when it was On; no Ads
 *               calls), so an Off account never shows phantom alerts on its client
 *               profile.
 * Iterating the enrolled set (not just monitored) is what lets Off accounts get
 * cleared.
 *
 * `products` lets a single dashboard's Refresh recompute just its own accounts
 * (the morning cron runs both). Synchronous + concurrent; each account is
 * isolated — one failure never stops the rest.
 */
export async function runAlerts(
  notify = true,
  products: Product[] = ["gads", "lsa"],
  deps: RunAlertsDeps = DEFAULT_RUN_ALERTS_DEPS,
): Promise<RunAlertsSummary> {
  const campaignLabel = KI_CAMPAIGN_LABEL;
  const gadsAccts = products.includes("gads") ? await deps.enrolledAccounts("gads") : [];
  const lsaAccts = products.includes("lsa") ? await deps.enrolledAccounts("lsa") : [];
  let deepLinks: { gads: Record<string, string>; lsa: Record<string, string> } = { gads: {}, lsa: {} };
  try {
    deepLinks = await deps.clickUpDeepLinks();
  } catch (err: any) {
    // A missing launch URL must never block alert computation/persistence.
    console.warn(`[AdsOsV2] alert deep links unavailable: ${err?.message ?? err}`);
  }
  // §14.4 diagnosability: an empty enrolled set (ClickUp directory down, labels
  // missing) makes the whole run a silent no-op — log the resolved count per
  // requested product so "0 need attention" is traceable to enrollment.
  console.log(
    `[AdsOsV2] alerts run: products=${products.join("+")}` +
      (products.includes("gads") ? ` gads_accounts=${gadsAccts.length}` : "") +
      (products.includes("lsa") ? ` lsa_accounts=${lsaAccts.length}` : "") +
      ` notify=${notify}`,
  );

  const doGads = async (acct: EnrolledAccount): Promise<AlertRunResult> => {
    const { cid, name } = acct;
    try {
      const status = await deps.adsStatusFor("gads", cid);
      if (status === "off") {
        await saveAlertsDoc(cid, name, "gads", []); // clear stale alerts; no Ads calls
        return [cid, name, "gads", []];
      }
      // Scan labeled campaigns that are enabled OR spent in the last 7 days
      // (skip dormant paused ones). Ad-group/ad scoping stays ENABLED-only.
      // Dashboard performance scope: every labeled campaign, regardless of
      // current status. Serving-health checks retain their narrower recently-
      // scannable subset, while rolling CPL uses the full monitored set.
      const monitoredCampaignIds = await deps.labeledCampaignIds(cid, campaignLabel);
      const campaignIds = await deps.scannableCampaignIds(cid, monitoredCampaignIds);
      const alerts = applyStatus(
        await computeGadsAlerts(
          cid,
          name,
          campaignIds,
          monitoredCampaignIds,
          deepLinks.gads[cid] ?? null,
        ),
        status,
      );
      await saveAlertsDoc(cid, name, "gads", alerts);
      return [cid, name, "gads", alerts];
    } catch (err: any) {
      console.warn(`[AdsOsV2] gads alerts failed for ${cid}: ${err?.message ?? err}`);
      return [cid, name, "gads", null];
    }
  };

  const doLsa = async (acct: EnrolledAccount): Promise<AlertRunResult> => {
    const { cid, name } = acct;
    try {
      const status = await deps.adsStatusFor("lsa", cid);
      if (status === "off") {
        await saveAlertsDoc(cid, name, "lsa", []); // clear stale alerts; no Ads calls
        return [cid, name, "lsa", []];
      }
      const alerts = applyStatus(
        await computeLsaAlerts(cid, name, deepLinks.lsa[cid] ?? null),
        status,
      );
      await saveAlertsDoc(cid, name, "lsa", alerts);
      return [cid, name, "lsa", alerts];
    } catch (err: any) {
      console.warn(`[AdsOsV2] lsa alerts failed for ${cid}: ${err?.message ?? err}`);
      return [cid, name, "lsa", null];
    }
  };

  let results: AlertRunResult[] = [];
  if (gadsAccts.length) results = results.concat(await mapPool(gadsAccts, 6, doGads));
  if (lsaAccts.length) results = results.concat(await mapPool(lsaAccts, 6, doLsa));

  // Reconcile ClickUp ticket state for the accounts just recomputed — a closed/
  // deleted ticket reverts its dashboard button to "Create". Best-effort; never
  // blocks alerts.
  try {
    await deps.refreshTaskStates(results);
  } catch (err: any) {
    console.warn(`[AdsOsV2] clickup task refresh failed: ${err?.message ?? err}`);
  }

  const total = results.reduce((n, [, , , a]) => n + (a ? a.length : 0), 0);
  const { sendAlertDigest } = await import("./alertsNotify");
  const digest = notify ? await sendAlertDigest(results) : { sent: false, skipped: true };
  return {
    gads_accounts: gadsAccts.length,
    lsa_accounts: lsaAccts.length,
    total_alerts: total,
    digest,
  };
}
