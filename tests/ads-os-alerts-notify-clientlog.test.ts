/* test-registration
{
  "name": "Ads OS P6 alerts + digest + client log — severity matrix (schedule/served-history no-impressions, spend spike vs active-day avg, rolling 30-day GAds/LSA CPL boundaries and failures, policy splits, SEARCH can't-serve/SDA, PMax serving states, LSA paused/verification/leads), Paused/Off suppression, only-on-change fingerprints (clear self-heal, null untouched, webhook-unset pending, delivery-failure retry), paginate packing, client-log date formats + state codes + stale last-good (Task #3602, #5199)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3602: Ads OS Phase 6 — alerts severity/suppression matrix, Slack digest only-on-change fingerprints, client-log state codes. The digest fingerprint rules are the safety property: a drift could re-nag the team every morning or silently drop a critical alert after a failed run.",
  "extraNodeArgs": [
    "--import",
    "./tests/ads-os-p6-setup.mjs"
  ],
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3602 — Ads OS Phase 6: alerts engine severity/suppression, Slack
 * digest only-on-change, and client-log parsing/state codes.
 *
 * What this locks in:
 *   (A) gadsRanges window math (fixed date): yesterday, 29-day daily window,
 *       7-day spend baseline ending day-before-yesterday, no-conv window,
 *       prior 4 same-weekdays, fixed 30-complete-day CPL window.
 *   (B) failingVerificationTypes: PASSED supersedes, PENDING isn't a failure,
 *       CANCELLED excluded from the latest-pool unless all cancelled,
 *       latest-by-creation decides.
 *   (C) applyStatus: Off clears everything; Paused drops only the expected-
 *       while-paused codes and keeps hard failures; On/blank unchanged.
 *   (D) computeGadsAlerts severity matrix against stubbed Ads rows:
 *       account_suspended (+ campaign-scoped early return), no_impressions
 *       honoring the criteria schedule with the served-history fallback,
 *       spend_spike strict > threshold vs 7-day active-day average,
 *       no_conversions with ENDED exclusion, rolling CPL strict boundary +
 *       labeled-vs-health scope + failed inputs, disapproved/limited/under-review
 *       ads with topic reasons, SEARCH can't-serve (ads/keywords, SDA exempt),
 *       PMax asset-group serving state (all-bad / mixed / PENDING-only /
 *       failed-query skip / all-removed), disapproved vs limited assets.
 *   (E) computeLsaAlerts: suspended, lsa_paused, verification via (B),
 *       lsa_no_leads charged-only with the 7-day boundary, rolling CPL strict
 *       boundary + Local Services cost/charged-lead failure behavior.
 *   (F) sendAlertDigest: critical+high only, escaped Block Kit body with
 *       deep links, fingerprint advance on success only, nothing-new skip,
 *       cleared-account self-heal + re-alert, failed-run (null) untouched,
 *       campaign-scoped fingerprints, webhook-unset keeps alerts pending,
 *       Slack failure retries next run, medium-only commits empty snapshot;
 *       paginate page/header/footer packing.
 *   (G) clientLog pure parsing: sheetIdFromUrl, cellDate formats + yearless
 *       rollback, capLines both-ends trim + char budget, recentLines window
 *       + undated-continuation rows.
 *   (H) getLogSummary state codes via stubbed token/store + scripted fetch:
 *       no_log, no_credentials, fetch_failed, api_disabled vs no_access,
 *       not_found, tab_missing, empty/no_recent persisted, no_openai,
 *       fresh-cache short-circuit, stale last-good on failed refresh.
 *
 * Hermetic: ads-os-p6-setup.mjs redirects alertsQueries/criteriaService/
 * slackWebhook/store/googleDriveIntegration to tests/p6Stubs/* (in-memory,
 * network-free); the Sheets fetch is a scripted global fetch stub filtered to
 * sheets.googleapis.com. No DB, no Slack, no Google, no OpenAI calls.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

const S = (): any => ((globalThis as any).__p6 ??= {});

function resetState(): void {
  (globalThis as any).__p6 = {};
}

const {
  gadsRanges,
  computeGadsAlerts,
  computeLsaAlerts,
  applyStatus,
  failingVerificationTypes,
  runAlerts,
} = await import("../server/services/adsOs/alertsEngine");
const { sendAlertDigest, paginate } = await import("../server/services/adsOs/alertsNotify");
const { sheetIdFromUrl, cellDate, capLines, recentLines, getLogSummary } = await import(
  "../server/services/adsOs/clientLog"
);
const { plainToday, addDays, isoDate } = await import("../server/services/adsOs/dateRange");
const { WEEKDAYS } = await import("../server/services/adsOs/pacingEngine");
const {
  ALERTS_CPL_THRESHOLD_DOLLARS,
  ALERTS_SPEND_SPIKE_PCT,
} = await import("../server/services/adsOs/config");

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function codes(alerts: any[]): string[] {
  return alerts.map((a: any) => a.code).sort();
}
function byCode(alerts: any[], code: string): any {
  const a = alerts.find((x: any) => x.code === code);
  assert.ok(a, `alert ${code} present in [${codes(alerts).join(", ")}]`);
  return a;
}

// ── Fixture builders (GAQL camelCase row shapes) ─────────────────────────────

const camp = (id: string, o: any = {}) => ({
  campaign: {
    id,
    name: o.name ?? `Camp ${id}`,
    status: o.status ?? "ENABLED",
    primaryStatus: o.primaryStatus ?? "ELIGIBLE",
    advertisingChannelType: o.type ?? "SEARCH",
    advertisingChannelSubType: o.sub ?? "",
  },
});
const dailyRow = (date: string, id: string, costMicros: number, impressions: number) => ({
  segments: { date },
  campaign: { id },
  metrics: { costMicros, impressions },
});
const weeklyRow = (id: string, costMicros: number, conversions: number) => ({
  campaign: { id },
  metrics: { costMicros, conversions },
});
const cplRow = (id: string, costMicros: number, conversions: number) => ({
  campaign: { id },
  metrics: { costMicros, conversions },
});
const adRow = (id: string, policySummary: any) => ({ campaign: { id }, adGroupAd: { policySummary } });
const agRow = (id: string, primaryStatus: string) => ({ campaign: { id }, assetGroup: { primaryStatus } });
const assetRow = (id: string, primaryStatus: string) => ({ campaign: { id }, campaignAsset: { primaryStatus } });

function gadsData(over: Record<string, any[]> = {}, warnings: string[] = []): any {
  return {
    data: {
      customer: [{ customer: { status: "ENABLED" } }],
      campaigns: [],
      daily: [],
      weekly: [],
      cpl: [],
      ads_policy: [],
      has_keywords: [],
      asset_groups: [],
      asset_policy: [],
      ...over,
    },
    warnings,
  };
}

/** Campaign 1 serving normally: enabled SEARCH, ads + keywords, converting. */
function healthy1(): Record<string, any[]> {
  return {
    campaigns: [camp("1")],
    weekly: [weeklyRow("1", 10_000_000, 2)],
    ads_policy: [adRow("1", { approvalStatus: "APPROVED" })],
    has_keywords: [{ campaign: { id: "1" } }],
  };
}

const today = plainToday();
const R = gadsRanges(today);
const yesterdayWd = (new Date(R.yesterday + "T00:00:00Z").getUTCDay() + 6) % 7; // Mon=0

// ═════════════════════════════════════════════════════════════════════════════
console.log("A) gadsRanges window math");
{
  const r = gadsRanges({ y: 2026, m: 7, d: 27 });
  assert.equal(r.yesterday, "2026-07-26");
  assert.equal(r.daily_start, "2026-06-28");
  assert.equal(r.daily_end, "2026-07-26");
  assert.equal(r.spend_base_start, "2026-07-19");
  assert.equal(r.spend_base_end, "2026-07-25");
  assert.equal(r.week_start, "2026-07-20"); // ALERTS_NO_CONV_DAYS=7
  assert.equal(r.week_end, "2026-07-26");
  assert.equal(r.cpl_start, "2026-06-27");
  assert.equal(r.cpl_end, "2026-07-26");
  assert.deepEqual(r.prior_weekdays, ["2026-07-19", "2026-07-12", "2026-07-05", "2026-06-28"]);
  ok("fixed-date ranges: yesterday/daily/spend-base/no-conv/prior-weekdays");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("B) failingVerificationTypes");
{
  const art = (artifactType: string, status: string, creationDateTime: string) => ({
    artifactType,
    status,
    creationDateTime,
  });
  // A current PASSED supersedes any older failed submission for that type.
  assert.deepEqual(
    failingVerificationTypes([
      art("LICENSE", "FAILED", "2026-01-01 00:00:00"),
      art("LICENSE", "PASSED", "2026-02-01 00:00:00"),
    ]),
    [],
  );
  // PENDING (in progress) is not a failure.
  assert.deepEqual(failingVerificationTypes([art("INSURANCE", "PENDING", "2026-03-01 00:00:00")]), []);
  // CANCELLED is excluded from the pool when newer non-cancelled entries exist.
  assert.deepEqual(
    failingVerificationTypes([
      art("INSURANCE", "CANCELLED", "2026-04-01 00:00:00"),
      art("INSURANCE", "REJECTED", "2026-03-01 00:00:00"),
    ]),
    ["INSURANCE"],
  );
  // All-cancelled -> latest is CANCELLED, which is not a bad status.
  assert.deepEqual(failingVerificationTypes([art("LICENSE", "CANCELLED", "2026-01-01 00:00:00")]), []);
  // Latest-by-creation decides: newest REJECTED beats older PENDING.
  assert.deepEqual(
    failingVerificationTypes([
      art("BACKGROUND_CHECK", "PENDING", "2026-01-01 00:00:00"),
      art("BACKGROUND_CHECK", "REJECTED", "2026-02-01 00:00:00"),
    ]),
    ["BACKGROUND_CHECK"],
  );
  // Mixed types: only the failing type is reported.
  assert.deepEqual(
    failingVerificationTypes([
      art("INSURANCE", "FAILED", "2026-01-05 00:00:00"),
      art("LICENSE", "PASSED", "2026-01-01 00:00:00"),
    ]),
    ["INSURANCE"],
  );
  ok("PASSED supersedes / PENDING ok / CANCELLED pool rules / latest wins");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("C) applyStatus suppression");
{
  const mkA = (code: string, severity = "high"): any => ({
    code,
    severity,
    title: code,
    detail: "",
    product: "gads",
    campaign_id: null,
    deep_link: null,
    clickup_task: null,
  });
  const all = [
    mkA("account_suspended", "critical"),
    mkA("no_impressions", "critical"),
    mkA("spend_spike", "medium"),
    mkA("no_conversions"),
    mkA("high_cpl"),
    mkA("no_eligible_ads", "critical"),
    mkA("disapproved_ads"),
    mkA("lsa_paused", "critical"),
    mkA("lsa_no_leads"),
    mkA("lsa_verification_failed", "critical"),
  ];
  assert.deepEqual(applyStatus(all, "off"), []);
  assert.deepEqual(
    codes(applyStatus(all, "paused")),
    ["account_suspended", "disapproved_ads", "lsa_verification_failed"].sort(),
  );
  assert.deepEqual(applyStatus(all, "on"), all);
  assert.deepEqual(applyStatus(all, null), all);
  ok("off clears; paused keeps hard failures only; on/blank unchanged");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("D) computeGadsAlerts severity matrix");

// D1 — healthy account: no alerts.
{
  resetState();
  S().gads = gadsData(healthy1());
  const alerts = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(alerts, []);
  ok("healthy account -> no alerts");
}

// D2 — suspended account + campaign-scoped early return.
{
  resetState();
  S().gads = gadsData({ customer: [{ customer: { status: "SUSPENDED" } }] });
  const alerts = await computeGadsAlerts("111", "Acme", []);
  assert.deepEqual(codes(alerts), ["account_suspended"]);
  const a = byCode(alerts, "account_suspended");
  assert.equal(a.severity, "critical");
  assert.equal(a.title, "Account suspended");
  assert.equal(S().lastGadsArgs.campaignIds.length, 0);
  ok("SUSPENDED -> critical account_suspended; empty campaign set early-returns");
}

// D3 — no impressions on a criteria-scheduled day.
{
  resetState();
  S().criteria = { schedule_days: [WEEKDAYS[yesterdayWd]] };
  S().gads = gadsData(healthy1()); // no daily rows -> 0 impressions yesterday
  const alerts = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(codes(alerts), ["no_impressions"]);
  assert.equal(byCode(alerts, "no_impressions").severity, "critical");
  ok("scheduled day + 0 impressions -> critical no_impressions");
}

// D4 — schedule excludes yesterday: never flagged.
{
  resetState();
  S().criteria = { schedule_days: [WEEKDAYS[(yesterdayWd + 1) % 7]] };
  S().gads = gadsData(healthy1());
  const alerts = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(alerts, []);
  ok("unscheduled day -> no no_impressions");
}

// D5/D6 — no schedule: served-history fallback (prior same-weekdays).
{
  resetState();
  S().gads = gadsData({
    ...healthy1(),
    daily: [dailyRow(R.prior_weekdays[1], "1", 5_000_000, 40)], // served 2 weeks back
  });
  const fired = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(codes(fired), ["no_impressions"]);

  resetState();
  S().gads = gadsData(healthy1()); // no serving history at all
  const quiet = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(quiet, []);
  ok("history fallback: prior-weekday serving fires, no history stays quiet");
}

// D6b — weekend serving-day safety (§13.6): the account serves on OTHER
// weekdays inside the daily window, but none of the prior 4 same-weekdays as
// yesterday ever served — yesterday is not a serving day, so 0 impressions
// yesterday stays quiet (a Mon–Fri account is never flagged on a weekend).
{
  resetState();
  S().gads = gadsData({
    ...healthy1(),
    daily: [
      // today-3 / today-4 are never one of yesterday's prior same-weekdays
      // (those are yesterday-7/-14/-21/-28), so this is other-weekday serving.
      dailyRow(isoDate(addDays(today, -3)), "1", 5_000_000, 80),
      dailyRow(isoDate(addDays(today, -4)), "1", 5_000_000, 80),
    ],
  });
  const quiet = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(quiet, []);
  ok("weekend safety: other-weekday serving only -> yesterday not a serving day");
}

// D7 — spend spike vs 7-day active-day average (strict >, medium).
{
  const base = [
    dailyRow(isoDate(addDays(today, -3)), "1", 10_000_000, 100),
    dailyRow(isoDate(addDays(today, -4)), "1", 10_000_000, 100),
    dailyRow(isoDate(addDays(today, -5)), "1", 10_000_000, 100),
  ];
  resetState();
  S().gads = gadsData({
    ...healthy1(),
    daily: [...base, dailyRow(R.yesterday, "1", 10_000_000 * (1 + (ALERTS_SPEND_SPIKE_PCT + 100) / 100), 100)],
  });
  const spiked = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(codes(spiked), ["spend_spike"]);
  const a = byCode(spiked, "spend_spike");
  assert.equal(a.severity, "medium");
  assert.ok(a.title.startsWith("Spend spike +"), a.title);

  resetState();
  S().gads = gadsData({
    ...healthy1(),
    daily: [...base, dailyRow(R.yesterday, "1", 10_000_000 * (1 + ALERTS_SPEND_SPIKE_PCT / 100), 100)],
  });
  const atThreshold = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(atThreshold, []);
  ok("spike fires only strictly above the threshold vs active-day average");
}

// D8 — no conversions in the window; ENDED campaigns excluded.
{
  resetState();
  S().gads = gadsData({ ...healthy1(), weekly: [weeklyRow("1", 50_000_000, 0)] });
  const alerts = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(codes(alerts), ["no_conversions"]);
  const a = byCode(alerts, "no_conversions");
  assert.equal(a.severity, "high");
  assert.ok(a.detail.includes("$50"), a.detail);

  resetState();
  S().gads = gadsData({
    ...healthy1(),
    campaigns: [camp("1"), camp("3", { primaryStatus: "ENDED" })],
    weekly: [weeklyRow("3", 99_000_000, 0)], // all spend on the ENDED trial
  });
  const quiet = await computeGadsAlerts("111", "Acme", ["1", "3"]);
  assert.deepEqual(quiet, []);
  ok("weekly spend w/o conversions -> high; ENDED campaign spend excluded");
}

// D8b — rolling CPL: strict boundary, evidence, deep link, and monitored scope.
{
  const thresholdMicros = ALERTS_CPL_THRESHOLD_DOLLARS * 2 * 1e6;
  const link = "https://ads.google.com/aw/overview?ocid=test";

  resetState();
  S().gads = gadsData({ ...healthy1(), cpl: [cplRow("1", thresholdMicros - 10_000, 2)] });
  assert.deepEqual(await computeGadsAlerts("111", "Acme", ["1"], ["1"], link), []);

  resetState();
  S().gads = gadsData({ ...healthy1(), cpl: [cplRow("1", thresholdMicros, 2)] });
  assert.deepEqual(await computeGadsAlerts("111", "Acme", ["1"], ["1"], link), []);

  resetState();
  S().gads = gadsData({ ...healthy1(), cpl: [cplRow("2", thresholdMicros + 20_000, 2)] });
  const alerts = await computeGadsAlerts("111", "Acme", [], ["1", "2"], link);
  assert.deepEqual(codes(alerts), ["high_cpl"]);
  const high = byCode(alerts, "high_cpl");
  assert.equal(high.severity, "high");
  assert.equal(high.deep_link, link);
  assert.equal(high.title, "30-day CPL $350.01");
  assert.ok(high.detail.includes(`${R.cpl_start} through ${R.cpl_end}`), high.detail);
  assert.ok(high.detail.includes("$700.02 spend"), high.detail);
  assert.ok(high.detail.includes("2 primary conversions"), high.detail);
  assert.ok(high.detail.includes("CPL $350.01"), high.detail);
  assert.deepEqual(S().lastGadsArgs.campaignIds, []);
  assert.deepEqual(S().lastGadsArgs.cplCampaignIds, ["1", "2"]);
  assert.equal(S().lastGadsArgs.cplStart, R.cpl_start);
  assert.equal(S().lastGadsArgs.cplEnd, R.cpl_end);
  ok("GAds CPL: below/exact quiet; above high with evidence/link despite empty health scope");
}

// D8c — zero denominator and failed/invalid metric inputs never become high CPL.
{
  resetState();
  S().gads = gadsData({ ...healthy1(), cpl: [cplRow("1", 900_000_000, 0)] });
  assert.deepEqual(await computeGadsAlerts("111", "Acme", ["1"]), []);

  resetState();
  S().gads = gadsData(
    { ...healthy1(), cpl: [cplRow("1", 900_000_000, 1)] },
    ["cpl: HTTP 500"],
  );
  assert.deepEqual(await computeGadsAlerts("111", "Acme", ["1"]), []);

  resetState();
  S().gads = gadsData({ ...healthy1(), cpl: [cplRow("1", Number.NaN, 1)] });
  assert.deepEqual(await computeGadsAlerts("111", "Acme", ["1"]), []);
  ok("GAds CPL: zero conversions, query warning, and invalid metrics fail quiet");
}

// D9 — disapproved / limited / under-review ads with topic reasons.
{
  resetState();
  S().gads = gadsData({
    ...healthy1(),
    campaigns: [camp("1"), camp("3", { primaryStatus: "ENDED" })],
    ads_policy: [
      adRow("1", { approvalStatus: "APPROVED" }),
      adRow("1", { approvalStatus: "DISAPPROVED", policyTopicEntries: [{ topic: "MISREPRESENTATION" }] }),
      adRow("1", { approvalStatus: "DISAPPROVED", policyTopicEntries: [{ topic: "DESTINATION_NOT_WORKING" }] }),
      adRow("1", { approvalStatus: "APPROVED_LIMITED", policyTopicEntries: [{ topic: "HEALTHCARE" }] }),
      adRow("1", { approvalStatus: "APPROVED", reviewStatus: "REVIEW_IN_PROGRESS" }),
      adRow("3", { approvalStatus: "DISAPPROVED" }), // ENDED campaign — skipped
    ],
  });
  const alerts = await computeGadsAlerts("111", "Acme", ["1", "3"]);
  assert.deepEqual(codes(alerts), ["disapproved_ads", "limited_ads", "under_review_ads"]);
  const dis = byCode(alerts, "disapproved_ads");
  assert.equal(dis.severity, "high");
  assert.equal(dis.title, "2 disapproved ad(s)");
  assert.ok(dis.detail.includes("Destination Not Working"), dis.detail);
  assert.ok(dis.detail.includes("Misrepresentation"), dis.detail);
  assert.equal(byCode(alerts, "limited_ads").severity, "medium");
  const ur = byCode(alerts, "under_review_ads");
  assert.equal(ur.severity, "medium");
  assert.equal(ur.title, "1 ad(s) under review");
  ok("policy split: 2 disapproved (reasons) / limited / under-review; ENDED skipped");
}

// D10 — SEARCH can't-serve variants.
{
  resetState();
  S().gads = gadsData({ campaigns: [camp("1")], weekly: [weeklyRow("1", 10_000_000, 2)] });
  const both = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(codes(both), ["no_eligible_ads"]);
  assert.equal(byCode(both, "no_eligible_ads").severity, "critical");
  assert.ok(byCode(both, "no_eligible_ads").detail.includes("no eligible ads or keywords"));

  resetState();
  S().gads = gadsData({
    campaigns: [camp("1")],
    weekly: [weeklyRow("1", 10_000_000, 2)],
    ads_policy: [adRow("1", { approvalStatus: "APPROVED" })],
  });
  const noKw = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.ok(byCode(noKw, "no_eligible_ads").detail.includes("no eligible keywords"));

  resetState();
  S().gads = gadsData({
    campaigns: [camp("1", { sub: "SEARCH_DYNAMIC_ADS" })],
    weekly: [weeklyRow("1", 10_000_000, 2)],
    ads_policy: [adRow("1", { approvalStatus: "APPROVED" })],
  });
  const sda = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(sda, []);
  ok("SEARCH no-ads/no-keywords critical; SDA exempt from the keyword check");
}

// D11 — PMax asset-group serving state.
{
  const pmax = () => ({
    campaigns: [camp("2", { type: "PERFORMANCE_MAX" })],
    weekly: [weeklyRow("2", 10_000_000, 2)],
  });
  resetState();
  S().gads = gadsData({ ...pmax(), asset_groups: [agRow("2", "NOT_ELIGIBLE"), agRow("2", "NOT_ELIGIBLE")] });
  const allBad = await computeGadsAlerts("111", "Acme", ["2"]);
  assert.deepEqual(codes(allBad), ["no_eligible_ads"]);
  assert.ok(byCode(allBad, "no_eligible_ads").detail.includes("no eligible asset group"));

  resetState();
  S().gads = gadsData({
    ...pmax(),
    asset_groups: [agRow("2", "ELIGIBLE"), agRow("2", "NOT_ELIGIBLE"), agRow("2", "LIMITED")],
  });
  const mixed = await computeGadsAlerts("111", "Acme", ["2"]);
  assert.deepEqual(codes(mixed), ["pmax_asset_group_disapproved", "pmax_asset_group_limited"]);
  assert.equal(byCode(mixed, "pmax_asset_group_disapproved").severity, "high");
  assert.equal(byCode(mixed, "pmax_asset_group_limited").severity, "medium");

  resetState();
  S().gads = gadsData({ ...pmax(), asset_groups: [agRow("2", "PENDING"), agRow("2", "PENDING")] });
  assert.deepEqual(await computeGadsAlerts("111", "Acme", ["2"]), []);

  resetState();
  S().gads = gadsData(pmax(), ["asset_groups: HTTP 500"]);
  assert.deepEqual(await computeGadsAlerts("111", "Acme", ["2"]), []);

  resetState();
  S().gads = gadsData(pmax());
  const removed = await computeGadsAlerts("111", "Acme", ["2"]);
  assert.deepEqual(codes(removed), ["no_eligible_ads"]);
  ok("PMax: all-bad flags, mixed splits dis/limited, PENDING-only + failed-query quiet, empty = removed");
}

// D12 — disapproved vs limited campaign assets.
{
  resetState();
  S().gads = gadsData({
    ...healthy1(),
    asset_policy: [assetRow("1", "NOT_ELIGIBLE"), assetRow("1", "NOT_ELIGIBLE"), assetRow("1", "LIMITED")],
  });
  const alerts = await computeGadsAlerts("111", "Acme", ["1"]);
  assert.deepEqual(codes(alerts), ["disapproved_assets", "limited_assets"]);
  const dis = byCode(alerts, "disapproved_assets");
  assert.equal(dis.severity, "high");
  assert.equal(dis.title, "2 disapproved asset(s)");
  assert.equal(byCode(alerts, "limited_assets").severity, "medium");
  ok("assets: NOT_ELIGIBLE high / LIMITED medium");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("E) computeLsaAlerts");

const lead = (daysAgo: number, charged: boolean) => ({
  creationDateTime: isoDate(addDays(today, -daysAgo)) + " 09:30:00",
  charged,
});
const lsaCost = (costMicros: number) => ({ costMicros });

// E1 — suspended.
{
  resetState();
  S().customerStatus = "SUSPENDED";
  const alerts = await computeLsaAlerts("222", "Beta");
  assert.deepEqual(codes(alerts), ["account_suspended"]);
  assert.equal(byCode(alerts, "account_suspended").product, "lsa");
  ok("SUSPENDED -> critical account_suspended (lsa)");
}

// E2 — lsa_paused.
{
  resetState();
  S().lsaCampaigns = [{ id: "9", status: "PAUSED" }];
  assert.deepEqual(codes(await computeLsaAlerts("222", "Beta")), ["lsa_paused"]);

  resetState();
  S().lsaCampaigns = [
    { id: "9", status: "ENABLED" },
    { id: "8", status: "PAUSED" },
  ];
  assert.deepEqual(await computeLsaAlerts("222", "Beta"), []);

  resetState(); // no LOCAL_SERVICES campaigns at all -> not flagged
  assert.deepEqual(await computeLsaAlerts("222", "Beta"), []);
  ok("paused-only flags; any ENABLED or an empty campaign list stays quiet");
}

// E3 — verification failed.
{
  resetState();
  S().lsaArtifacts = [
    { artifactType: "INSURANCE", status: "FAILED", creationDateTime: "2026-01-05 00:00:00" },
    { artifactType: "LICENSE", status: "PASSED", creationDateTime: "2026-01-01 00:00:00" },
  ];
  const alerts = await computeLsaAlerts("222", "Beta");
  assert.deepEqual(codes(alerts), ["lsa_verification_failed"]);
  const a = byCode(alerts, "lsa_verification_failed");
  assert.equal(a.severity, "critical");
  assert.ok(a.detail.includes("Insurance"), a.detail);
  assert.ok(!a.detail.includes("License"), a.detail);
  ok("failing type prettified in detail; passing type omitted");
}

// E4 — no charged leads in 7 days (established accounts only).
{
  resetState();
  S().lsaLeads = [lead(20, true), lead(25, true), lead(31, true), lead(3, false)];
  const alerts = await computeLsaAlerts("222", "Beta");
  assert.deepEqual(codes(alerts), ["lsa_no_leads"]);
  const a = byCode(alerts, "lsa_no_leads");
  assert.equal(a.severity, "high");
  assert.ok(a.detail.includes("≈3"), a.detail);

  resetState();
  S().lsaLeads = [lead(20, true), lead(7, true)]; // charged exactly on the boundary day
  assert.deepEqual(await computeLsaAlerts("222", "Beta"), []);

  resetState();
  S().lsaLeads = [lead(20, false), lead(25, false)]; // never-charged history
  assert.deepEqual(await computeLsaAlerts("222", "Beta"), []);
  ok("prior-charged + none-in-7d fires; boundary-day lead or no history stays quiet");
}

// E5 — rolling LSA CPL: strict boundary, evidence, link, and complete-day ranges.
{
  const thresholdMicros = ALERTS_CPL_THRESHOLD_DOLLARS * 2 * 1e6;
  const link = "https://ads.google.com/localservices/overview?cid=test";

  resetState();
  S().lsaLeads = [lead(3, true), lead(20, true)];
  S().lsaCost = [lsaCost(thresholdMicros - 10_000)];
  assert.deepEqual(await computeLsaAlerts("222", "Beta", link), []);

  resetState();
  S().lsaLeads = [lead(3, true), lead(20, true)];
  S().lsaCost = [lsaCost(thresholdMicros)];
  assert.deepEqual(await computeLsaAlerts("222", "Beta", link), []);

  resetState();
  S().lsaLeads = [lead(3, true), lead(20, true)];
  S().lsaCost = [lsaCost(thresholdMicros + 20_000)];
  const alerts = await computeLsaAlerts("222", "Beta", link);
  assert.deepEqual(codes(alerts), ["high_cpl"]);
  const high = byCode(alerts, "high_cpl");
  assert.equal(high.severity, "high");
  assert.equal(high.deep_link, link);
  assert.equal(high.title, "30-day CPL $350.01");
  assert.ok(high.detail.includes(`${R.cpl_start} through ${R.cpl_end}`), high.detail);
  assert.ok(high.detail.includes("$700.02 spend"), high.detail);
  assert.ok(high.detail.includes("2 charged leads"), high.detail);
  assert.equal(S().lastLsaCostRange.startIso, R.cpl_start);
  assert.equal(S().lastLsaCostRange.endIso, R.cpl_end);
  assert.equal(S().lastLeadRange.endIso, R.cpl_end);
  ok("LSA CPL: below/exact quiet; above high with evidence/link and 30 complete days");
}

// E6 — zero denominator and either failed/invalid input suppress the CPL alert.
{
  resetState();
  S().lsaCost = [lsaCost(900_000_000)];
  assert.deepEqual(await computeLsaAlerts("222", "Beta"), []);

  resetState();
  S().lsaLeads = [lead(3, true)];
  S().lsaCost = [lsaCost(900_000_000)];
  S().lsaCostWarning = "cost: HTTP 500";
  assert.deepEqual(await computeLsaAlerts("222", "Beta"), []);

  resetState();
  S().lsaLeads = [lead(3, true)];
  S().lsaLeadsWarning = "leads: HTTP 500";
  S().lsaCost = [lsaCost(900_000_000)];
  assert.deepEqual(await computeLsaAlerts("222", "Beta"), []);

  resetState();
  S().lsaLeads = [lead(3, true)];
  S().lsaCost = [lsaCost(-1)];
  assert.deepEqual(await computeLsaAlerts("222", "Beta"), []);
  ok("LSA CPL: zero leads, cost/lead warnings, and invalid spend fail quiet");
}

// E7 — orchestration retains Off fast-clear/no-Ads-call and canonical persistence.
{
  resetState();
  let labeledCalls = 0;
  let scannableCalls = 0;
  let refreshedTaskResults: any[] | null = null;
  const enrolled = {
    gads: [{ cid: "111", name: "Acme", currency: "USD" }],
    lsa: [{ cid: "222", name: "Beta", currency: "USD" }],
  };
  const statuses: Record<string, string> = { "gads:111": "off", "lsa:222": "off" };
  let links = { gads: {} as Record<string, string>, lsa: {} as Record<string, string> };
  let labeledByCid: Record<string, string[]> = {};
  let scannableByCid: Record<string, string[]> = {};
  const deps = {
    enrolledAccounts: async (product: "gads" | "lsa") => enrolled[product],
    labeledCampaignIds: async (cid: string) => {
      labeledCalls += 1;
      return labeledByCid[cid] ?? [];
    },
    scannableCampaignIds: async (cid: string, labeled: string[]) => {
      scannableCalls += 1;
      return scannableByCid[cid] ?? labeled;
    },
    adsStatusFor: async (product: "gads" | "lsa", cid: string) =>
      statuses[`${product}:${cid}`] ?? null,
    clickUpDeepLinks: async () => links,
    refreshTaskStates: async (results: any[]) => {
      refreshedTaskResults = results;
    },
  };
  const offSummary = await runAlerts(false, ["gads", "lsa"], deps);
  assert.equal(offSummary.total_alerts, 0);
  assert.equal(S().gadsCalls ?? 0, 0);
  assert.equal(S().lsaApiCalls ?? 0, 0);
  assert.equal(labeledCalls, 0);
  assert.equal(scannableCalls, 0);
  assert.deepEqual(S().stores.alerts.get("gads:111").alerts, []);
  assert.deepEqual(S().stores.alerts.get("lsa:222").alerts, []);

  resetState();
  const link = "https://ads.google.com/aw/overview?ocid=persisted";
  statuses["gads:111"] = "on";
  links = { gads: { "111": link }, lsa: {} };
  labeledByCid = { "111": ["9"] };
  scannableByCid = { "111": [] };
  S().gads = gadsData({ cpl: [cplRow("9", 351_000_000, 1)] });
  const activeSummary = await runAlerts(false, ["gads"], deps);
  assert.equal(activeSummary.total_alerts, 1);
  assert.equal(S().gadsCalls, 1);
  const persisted = S().stores.alerts.get("gads:111");
  assert.deepEqual(codes(persisted.alerts), ["high_cpl"]);
  assert.equal(byCode(persisted.alerts, "high_cpl").deep_link, link);
  assert.deepEqual(refreshedTaskResults?.[0]?.[3]?.map((a: any) => a.code), ["high_cpl"]);
  ok("runAlerts: Off clears without Ads calls; active CPL persists with directory deep link");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("F) sendAlertDigest only-on-change + paginate");

const mk = (code: string, severity: string, over: any = {}): any => ({
  code,
  severity,
  title: over.title ?? `T ${code}`,
  detail: over.detail ?? "",
  product: over.product ?? "gads",
  campaign_id: over.campaign_id ?? null,
  deep_link: over.deep_link ?? null,
  clickup_task: null,
});
const notifiedFps = (product: string, cid: string): string[] =>
  S().stores?.notified?.get(`${product}:${cid}`)?.fingerprints ?? [];
const posts = (): any[] => S().slackPosts ?? [];
const pageBody = (page: any): string =>
  page.blocks
    .filter((b: any) => b.type === "section")
    .map((b: any) => b.text.text)
    .join("\n");

const SLACK_URL_BACKUP = process.env.SLACK_WEBHOOK_URL;
process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/p6test";
resetState();

const acmeAlerts = [
  mk("account_suspended", "critical", {
    title: "Account <suspended> & closed",
    deep_link: "https://ads.google.com/x",
  }),
  mk("no_conversions", "high"),
  mk("spend_spike", "medium"),
];

// F1 — first run posts critical+high only, advances fingerprints.
{
  const d = await sendAlertDigest([["111", "Acme", "gads", acmeAlerts]] as any);
  assert.equal(d.sent, true);
  assert.equal(d.messages, 1);
  assert.equal(d.new_alerts, 2);
  assert.equal(d.accounts, 1);
  assert.equal(posts().length, 1);
  const page = posts()[0];
  assert.equal(page.blocks[0].type, "header");
  assert.ok(page.blocks[0].text.text.includes("Google Ads Pulse"));
  const body = pageBody(page);
  assert.ok(body.includes("*Acme* · Google Ads"), body);
  assert.ok(body.includes("🚨"));
  assert.ok(body.includes("&lt;suspended&gt; &amp; closed"), "title escaped");
  assert.ok(body.includes("<https://ads.google.com/x|Open in Google Ads>"), "deep link rendered");
  assert.ok(!body.includes("T spend_spike"), "medium stays out of Slack");
  const foot = page.blocks[page.blocks.length - 1];
  assert.equal(foot.type, "context");
  assert.ok(foot.elements[0].text.includes("2 new alert(s) across 1 account(s)"));
  assert.deepEqual(notifiedFps("gads", "111"), ["account_suspended:", "no_conversions:"]);
  ok("first run: critical+high posted, escaped, deep-linked; fingerprints advanced");
}

// F2 — unchanged alerts: nothing new, no re-nag.
{
  const d = await sendAlertDigest([["111", "Acme", "gads", acmeAlerts]] as any);
  assert.equal(d.sent, false);
  assert.equal(d.new_alerts, 0);
  assert.equal(posts().length, 1);
  ok("same alerts next run: silent (sent once, never re-nagged)");
}

// F3 — campaign-scoped fingerprint distinguishes a new instance of an old code.
{
  const scoped = [acmeAlerts[0], mk("no_conversions", "high", { campaign_id: "777" })];
  const d = await sendAlertDigest([["111", "Acme", "gads", scoped]] as any);
  assert.equal(d.sent, true);
  assert.equal(d.new_alerts, 1);
  assert.deepEqual(notifiedFps("gads", "111"), ["account_suspended:", "no_conversions:777"]);
  ok("code:campaign fingerprint — campaign-scoped repeat counts as fresh");
}

// F4 — cleared account: snapshot wiped silently (clean book sends nothing).
{
  const before = posts().length;
  const d = await sendAlertDigest([["111", "Acme", "gads", []]] as any);
  assert.equal(d.sent, false);
  assert.equal(posts().length, before);
  assert.deepEqual(notifiedFps("gads", "111"), []);
  ok("cleared alerts: no post, fingerprints self-heal to empty");
}

// F5 — the same alert re-fires after a clear: alerted again.
{
  const d = await sendAlertDigest([["111", "Acme", "gads", acmeAlerts]] as any);
  assert.equal(d.sent, true);
  assert.equal(d.new_alerts, 2);
  ok("re-alert after self-heal");
}

// F6 — failed run (alerts null) leaves the snapshot untouched.
{
  const before = notifiedFps("gads", "111");
  const d = await sendAlertDigest([["111", "Acme", "gads", null]] as any);
  assert.equal(d.sent, false);
  assert.deepEqual(notifiedFps("gads", "111"), before);
  const d2 = await sendAlertDigest([["111", "Acme", "gads", acmeAlerts]] as any);
  assert.equal(d2.sent, false); // still nothing new — snapshot preserved through the failure
  ok("null result never wipes or advances the snapshot");
}

// F7 — webhook unset: badges-only mode; alerts stay pending until configured.
{
  delete process.env.SLACK_WEBHOOK_URL;
  const beta = [["222", "Beta Legal", "lsa", [mk("lsa_paused", "critical", { product: "lsa" })]]] as any;
  const d = await sendAlertDigest(beta);
  assert.equal(d.sent, false);
  assert.equal(d.reason, "no webhook configured");
  assert.equal(d.new_alerts, 1);
  assert.equal(S().stores?.notified?.has("lsa:222") ?? false, false);

  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/p6test";
  const d2 = await sendAlertDigest(beta);
  assert.equal(d2.sent, true);
  assert.ok(pageBody(posts()[posts().length - 1]).includes("*Beta Legal* · LSA"));
  assert.deepEqual(notifiedFps("lsa", "222"), ["lsa_paused:"]);
  ok("no webhook: pending (not swallowed); sends once configured; LSA tag");
}

// F8 — Slack delivery failure: retried next run.
{
  S().slackFail = true;
  const gamma = [["333", "Gamma", "gads", [mk("no_impressions", "critical")]]] as any;
  const d = await sendAlertDigest(gamma);
  assert.equal(d.sent, false);
  assert.deepEqual(notifiedFps("gads", "333"), []);
  S().slackFail = false;
  const d2 = await sendAlertDigest(gamma);
  assert.equal(d2.sent, true);
  ok("failed delivery leaves alerts pending; next run retries");
}

// F9 — medium-only account: nothing notable, snapshot committed empty.
{
  const d = await sendAlertDigest([["444", "Delta", "gads", [mk("spend_spike", "medium")]]] as any);
  assert.equal(d.sent, false);
  assert.equal(d.new_alerts, 0);
  assert.deepEqual(notifiedFps("gads", "444"), []);
  ok("medium-only: dashboard-only, empty snapshot recorded");
}

// F10 — paginate packing.
{
  const sections = Array.from({ length: 24 }, (_, i) => [`Acct ${i}`, "gads", [mk("x", "critical")]] as const);
  const pages = paginate(sections as any, 5);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].length, 48); // header + 23 accounts × 2 + footer
  assert.equal(pages[1].length, 4); // header + 1 account × 2 + footer
  assert.ok(pages[0][0].text.text.includes("(1/2)"));
  assert.ok(pages[1][0].text.text.includes("(2/2)"));
  assert.ok(pages[0][pages[0].length - 1].elements[0].text.includes("5 new alert(s) across 24 account(s)"));
  const single = paginate([sections[0]] as any, 1);
  assert.equal(single.length, 1);
  assert.ok(!single[0][0].text.text.includes("(1/"));
  ok("pages stay under the block cap; titles numbered only when split");
}

if (SLACK_URL_BACKUP === undefined) delete process.env.SLACK_WEBHOOK_URL;
else process.env.SLACK_WEBHOOK_URL = SLACK_URL_BACKUP;

// ═════════════════════════════════════════════════════════════════════════════
console.log("G) client-log parsing");

// G1 — sheetIdFromUrl.
{
  assert.equal(
    sheetIdFromUrl("https://docs.google.com/spreadsheets/d/abc_DEF-123/edit#gid=0"),
    "abc_DEF-123",
  );
  assert.equal(sheetIdFromUrl("https://docs.google.com/spreadsheets/d/xyz"), "xyz");
  assert.equal(sheetIdFromUrl("https://example.com/doc"), null);
  assert.equal(sheetIdFromUrl(null), null);
  assert.equal(sheetIdFromUrl(""), null);
  ok("sheet id extraction");
}

// G2 — cellDate formats (fixed 'now' = 2026-07-27 UTC).
{
  const NOW = new Date(Date.UTC(2026, 6, 27));
  const at = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d);
  const t = (s: string) => cellDate(s, NOW)?.getTime() ?? null;
  assert.equal(t("2026-03-29"), at(2026, 3, 29));
  assert.equal(t("3/29/2026"), at(2026, 3, 29));
  assert.equal(t("3/29/26"), at(2026, 3, 29));
  assert.equal(t("29.Mar.26"), at(2026, 3, 29));
  assert.equal(t("29.Mar.2026"), at(2026, 3, 29));
  assert.equal(t("29 Mar 26"), at(2026, 3, 29));
  assert.equal(t("29 Mar 2026"), at(2026, 3, 29));
  assert.equal(t("Mar 29, 2026"), at(2026, 3, 29));
  assert.equal(t("Mar 29 2026"), at(2026, 3, 29));
  assert.equal(t(" 29.Mar.26. "), at(2026, 3, 29)); // whitespace + trailing period
  // Yearless: current year, rolled back when far-future.
  assert.equal(t("Mar 29"), at(2026, 3, 29));
  assert.equal(t("29 Mar"), at(2026, 3, 29));
  assert.equal(t("29.Mar"), at(2026, 3, 29));
  assert.equal(t("3/29"), at(2026, 3, 29));
  assert.equal(t("Aug 15"), at(2026, 8, 15)); // near-future stays this year
  assert.equal(t("Sep 30"), at(2025, 9, 30)); // far-future rolls back
  assert.equal(t("12/25"), at(2025, 12, 25));
  // Invalid.
  assert.equal(t("Feb 30 2026"), null);
  assert.equal(t("2026-13-05"), null);
  assert.equal(t("32 Mar 26"), null);
  assert.equal(t("Foo 10 2026"), null);
  assert.equal(t("hello"), null);
  assert.equal(t(""), null);
  assert.equal(t("x".repeat(25)), null);
  ok("all spec formats parse; yearless rollback; invalids null");
}

// G3 — capLines.
{
  const many = Array.from({ length: 200 }, (_, i) => `L${i}`);
  const capped = capLines(many);
  assert.equal(capped.length, 121); // 60 + marker + 60
  assert.equal(capped[0], "L0");
  assert.equal(capped[60], "[… middle rows omitted …]");
  assert.equal(capped[capped.length - 1], "L199");

  const long = Array.from({ length: 150 }, (_, i) => `${i}:` + "x".repeat(500));
  const budget = capLines(long);
  const total = budget.reduce((a, l) => a + l.length + 1, 0);
  assert.ok(total <= 60_000, `char budget respected (${total})`);
  assert.equal(budget[0], long[0]);
  assert.equal(budget[budget.length - 1], long[long.length - 1]);
  assert.ok(budget.includes("[… middle rows omitted …]"));
  ok("both-ends trim with middle marker; char budget keeps both ends");
}

// G4 — recentLines.
{
  const dIso = (ago: number) => isoDate(addDays(plainToday(), -ago));
  const rows = [
    ["Date", "Entry"], // undated header before any dated row
    [dIso(5), "tuned bids"],
    ["", "second line of the same entry"],
    [dIso(45), "ancient change"],
    ["", "ancient tail"],
    [dIso(30), "window-edge row"], // exactly windowDays back — kept (>= cutoff)
    [dIso(0), "today row"],
  ];
  const r = recentLines(rows, 30);
  assert.equal(r.datedAny, true);
  assert.equal(r.lines.length, 4);
  assert.ok(r.lines[0].includes("tuned bids"));
  assert.equal(r.lines[1], "second line of the same entry");
  assert.ok(r.lines[2].includes("window-edge row"));
  assert.ok(r.lines[3].includes("today row"));

  const undated = recentLines([["hello"], ["world"]], 30);
  assert.deepEqual(undated, { lines: [], datedAny: false });
  ok("window filter + undated continuation rows + datedAny flag");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("H) getLogSummary state codes");

{
  resetState();
  const realFetch = globalThis.fetch;
  let script: () => any = () => {
    throw new Error("unexpected sheets fetch");
  };
  let fetchCalls = 0;
  const resp = (status: number, body: any): any => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  globalThis.fetch = (async (input: any) => {
    const url = String(typeof input === "string" ? input : (input?.url ?? input));
    if (!url.includes("sheets.googleapis.com")) throw new Error(`unexpected fetch to ${url}`);
    fetchCalls += 1;
    return script();
  }) as any;

  const urlFor = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
  const dIso = (ago: number) => isoDate(addDays(plainToday(), -ago));
  const logDoc = (id: string): any => S().stores?.clientlog?.get(id) ?? null;

  try {
    // no_log — no URL / non-sheet URL, no fetch.
    assert.deepEqual(await getLogSummary("Acme", null), { state: "no_log" });
    assert.deepEqual(await getLogSummary("Acme", "https://example.com/x"), { state: "no_log" });
    assert.equal(fetchCalls, 0);
    ok("no_log without touching the network");

    // no_credentials — token mint fails before any fetch.
    S().tokenError = "Google Drive integration not configured";
    const nc = await getLogSummary("Acme", urlFor("sheetA"));
    assert.equal(nc.state, "no_credentials");
    assert.equal(nc.log_url, urlFor("sheetA"));
    assert.equal(fetchCalls, 0);
    S().tokenError = null;
    ok("no_credentials from a failed token mint");

    // fetch_failed — network error on every attempt (initial + 2 retries).
    script = () => {
      throw new Error("socket hang up");
    };
    let before = fetchCalls;
    // getLogSummary wraps the thrown fetch: the stub's throw happens inside fetch().
    assert.equal((await getLogSummary("Acme", urlFor("sheetA"))).state, "fetch_failed");
    assert.equal(fetchCalls - before, 3);

    // HTTP status mapping — deterministic 403/404/400 are NOT retried.
    script = () => resp(403, { error: { message: "Google Sheets API has not been used in project 1 before or it is disabled" } });
    before = fetchCalls;
    assert.equal((await getLogSummary("Acme", urlFor("sheetA"))).state, "api_disabled");
    assert.equal(fetchCalls - before, 1);
    script = () => resp(403, { error: { message: "The caller does not have permission" } });
    before = fetchCalls;
    assert.equal((await getLogSummary("Acme", urlFor("sheetA"))).state, "no_access");
    assert.equal(fetchCalls - before, 1);
    script = () => resp(404, { error: { message: "Requested entity was not found." } });
    before = fetchCalls;
    assert.equal((await getLogSummary("Acme", urlFor("sheetA"))).state, "not_found");
    assert.equal(fetchCalls - before, 1);
    script = () => resp(400, { error: { message: "Unable to parse range: 'Optimizations & Ideas'" } });
    before = fetchCalls;
    assert.equal((await getLogSummary("Acme", urlFor("sheetA"))).state, "tab_missing");
    assert.equal(fetchCalls - before, 1);
    script = () => resp(500, { error: { message: "backend error" } });
    before = fetchCalls;
    assert.equal((await getLogSummary("Acme", urlFor("sheetA"))).state, "fetch_failed");
    assert.equal(fetchCalls - before, 3); // 5xx IS retried before giving up
    ok("fetch_failed / api_disabled vs no_access / not_found / tab_missing mapping (+retry counts)");

    // Transient 503 blip — first attempt fails, retry succeeds → normal flow
    // continues (here: lands on no_recent from the old-dated row).
    {
      let attempt = 0;
      script = () =>
        ++attempt === 1
          ? resp(503, { error: { message: "The service is currently unavailable." } })
          : resp(200, { values: [[dIso(100), "old entry"]] });
      before = fetchCalls;
      assert.equal((await getLogSummary("Acme", urlFor("sheetT"))).state, "no_recent");
      assert.equal(fetchCalls - before, 2);
      ok("transient 503 recovered on retry");
    }

    // empty — persisted so the profile can render it cheaply.
    script = () => resp(200, { values: [["", "  "], []] });
    const empty = await getLogSummary("Acme", urlFor("sheetE"));
    assert.equal(empty.state, "empty");
    assert.equal(logDoc("sheetE")?.state, "empty");
    ok("empty tab persisted");

    // no_recent — dated rows, all outside the window.
    script = () => resp(200, { values: [[dIso(100), "old entry"]] });
    const noRecent = await getLogSummary("Acme", urlFor("sheetR"));
    assert.equal(noRecent.state, "no_recent");
    assert.equal(noRecent.window_days, 30);
    assert.equal(logDoc("sheetR")?.state, "no_recent");
    ok("no_recent persisted with window_days");

    // no_openai — recent rows but no key configured (never calls the model).
    const keyBackup = process.env.OPENAI_API_KEY;
    const aiKeyBackup = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    try {
      script = () => resp(200, { values: [[dIso(3), "raised budgets on Camp A"]] });
      assert.equal((await getLogSummary("Acme", urlFor("sheetO"))).state, "no_openai");
      assert.equal(logDoc("sheetO"), null); // config gaps are not persisted
    } finally {
      if (keyBackup !== undefined) process.env.OPENAI_API_KEY = keyBackup;
      if (aiKeyBackup !== undefined) process.env.AI_INTEGRATIONS_OPENAI_API_KEY = aiKeyBackup;
    }
    ok("no_openai config gap, not persisted");

    // Fresh cached ok summary short-circuits (no fetch).
    const seeded = {
      state: "ok",
      entries: [{ date: "Jul 20", text: "seeded summary" }],
      row_count: 1,
      window_days: 30,
      generated_at: new Date().toISOString(),
    };
    ((S().stores ??= {}).clientlog ??= new Map()).set("sheetB", seeded);
    const beforeCalls = fetchCalls;
    const cached = await getLogSummary("Acme", urlFor("sheetB"));
    assert.equal(cached.state, "ok");
    assert.equal(cached.entries?.[0]?.text, "seeded summary");
    assert.equal(cached.log_url, urlFor("sheetB"));
    assert.equal(fetchCalls, beforeCalls);
    ok("fresh cache served without a fetch");

    // Regenerate (force) hitting a dead sheet: last good summary marked stale.
    script = () => resp(500, { error: { message: "backend error" } });
    const stale = await getLogSummary("Acme", urlFor("sheetB"), true);
    assert.equal(stale.state, "ok");
    assert.equal(stale.stale, true);
    assert.equal(stale.refresh_error, "fetch_failed");
    assert.equal(stale.entries?.[0]?.text, "seeded summary");
    assert.equal(logDoc("sheetB")?.state, "ok");
    assert.equal(logDoc("sheetB")?.stale, undefined); // stale flag never persisted
    ok("failed refresh returns last good summary marked stale");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\nAll Phase 6 alert/notify/client-log checks passed (${passed} groups).`);
