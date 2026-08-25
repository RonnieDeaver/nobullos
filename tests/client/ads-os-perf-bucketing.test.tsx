/* test-registration
{
  "name": "Ads OS P6 performance derivation — range presets (yesterday end, MTD guard, full-calendar-month windows), daily/weekly-Monday/monthly bucketing with partial edge flags, CPL null on zero leads, blended per-date sums (Task #3602); comparison windows (span-shift vs calendar-aware month presets, same-period-last-year, Feb 29 clamp) + delta real/% zero- and null-base edge cases (Task #3674); activity-based account visibility — status-blind, hide only on confirmed all-window idleness, uncertain-data (metrics_failed / comparison loading/failed/null side) and all-idle safeguards (Task #3900); shared account short-label convention — sole-GAds collapse, LSA city, 22-char truncated fallback, sole-GAds tag-echo skip (Task #3906); channel breakdown + battery aggregation — GAds-first grouping with combined per-channel series, spend/leads shares (0 on zero totals), comparison sums null when any member side is missing or a current series failed, inclusion composes with the visibility rule (Ads Status never filters; comparison-window-only spenders count), top-spender battery data (Task #3912)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3602: profile Performance section client-side derivation — presets, Monday-week/calendar-month bucketing with partial-edge flags, blended sums; a drift here mislabels chart buckets on every profile.",
  "extraEnv": {
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #3602 — Ads OS Phase 6: client-side performance derivation.
 * Task #3674 — comparison windows + delta figures for the Performance overview.
 * Task #3900 — activity-based account visibility in the Performance section.
 * Task #3906 — one shared account short-label convention (pacing + performance).
 * Task #3912 — "By channel" breakdown + battery-bar composition strips.
 *
 * The profile Performance section fetches ONE daily payload and derives
 * everything in the browser — presets, weekly/monthly buckets, blended
 * series — so timeframe switches never refetch. This locks the pure helpers:
 *
 *   (A) presetDates: "last N days" ends yesterday; MTD guards the 1st;
 *       last-month / 3-6-12mo are FULL calendar months ending last month;
 *       custom returns null (inputs own it).
 *   (B) toBuckets: daily passthrough, Monday-start weeks, calendar months;
 *       edge buckets not covering their full week/month flagged partial;
 *       CPL null (not 0 or Infinity) on zero-lead buckets; labels.
 *   (C) blendedPoints: per-date sum across accounts, sorted, tolerant of
 *       date axes that don't fully overlap.
 *   (D) compareDates: "previous period" shifts day-type ranges (day presets,
 *       MTD, custom) back by their own span, but month presets are
 *       calendar-aware — the N full months immediately before; "same period
 *       last year" shifts one year (whole months kept, Feb 29 clamped);
 *       "none" derives nothing.
 *   (E) deltaInfo: real + % change; % null when the previous value is 0;
 *       null (→ UI dash) when either side has no value (no-lead CPL).
 *   (F) accountVisibility: ClickUp Ads Status is NOT an input — visibility is
 *       activity-only; an account hides only when idleness is CONFIRMED in
 *       every applicable window (metrics_failed placeholders, a loading or
 *       failed comparison, and a null comparison side never hide); when every
 *       account is idle, filtering is bypassed so the section never blanks.
 *   (G) accountShortLabel / accountTagIsEcho: the ONE naming convention the
 *       profile's Budget pacing rows and Performance tables share — a sole
 *       GAds account collapses to "GAds" (and only that row skips its product
 *       tag), LSA reads its city, everything else falls back to the account
 *       name truncated past 22 chars.
 *   (H) channelBreakdown: groups the included accounts into GAds/LSA channel
 *       summaries — combined daily series, account counts, spend/leads share
 *       %, summed comparison totals that go null (chips suppressed) when any
 *       member's comparison side is missing or a member's current series
 *       failed; single-channel clients yield one entry (the UI renders no
 *       by-channel row). Inclusion is the caller's `shown` set, so it composes
 *       with (F): Ads Status never filters, and an account that spent only in
 *       the comparison window still counts.
 *   (I) spendBattery: battery-bar segments (zero-spend items skipped) + the
 *       top spender behind "X drives Y% of spend"; ties keep input (payload)
 *       order; no spend at all → no segments, no top.
 *
 * Hermetic: pure function imports only — no DOM, no fetch, no server.
 */

import assert from "node:assert/strict";
import {
  presetDates,
  toBuckets,
  blendedPoints,
  compareDates,
  deltaInfo,
  accountVisibility,
  channelBreakdown,
  spendBattery,
  totals,
  type AccountActivity,
  type CompareState,
  type RangeTotals,
} from "../../client/src/pages/adsOs/components/PerformanceSection";
import {
  accountShortLabel,
  accountTagIsEcho,
  formatCpl,
} from "../../client/src/pages/adsOs/lib/format";
import type { PerfPoint, PerfSeries } from "../../client/src/pages/adsOs/lib/types";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// Local mirrors of the component's date conventions, for expected values.
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const now = new Date();
const yest = new Date(now);
yest.setDate(yest.getDate() - 1);
function spanDays(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
}

// ── (A) presetDates ─────────────────────────────────────────────────────────
{
  for (const [key, n] of [
    ["30d", 30],
    ["14d", 14],
    ["7d", 7],
  ] as const) {
    const r = presetDates(key);
    assert.ok(r, `${key} resolves`);
    assert.equal(r!.end, ymd(yest), `${key} ends yesterday`);
    assert.equal(spanDays(r!.start, r!.end), n, `${key} spans ${n} days`);
  }
  ok("last-N-days presets end yesterday with exact spans");

  const mtd = presetDates("mtd");
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  if (ymd(first) > ymd(yest)) {
    assert.equal(mtd, null); // the 1st — no complete day yet
  } else {
    assert.ok(mtd);
    assert.equal(mtd!.start, ymd(first));
    assert.equal(mtd!.end, ymd(yest));
  }
  ok("month-to-date starts on the 1st and guards the no-complete-day case");

  const lastDayPrev = new Date(now.getFullYear(), now.getMonth(), 0);
  for (const [key, n] of [
    ["last_month", 1],
    ["3mo", 3],
    ["6mo", 6],
    ["12mo", 12],
  ] as const) {
    const r = presetDates(key);
    assert.ok(r, `${key} resolves`);
    assert.equal(r!.end, ymd(lastDayPrev), `${key} ends the last day of the previous month`);
    assert.equal(
      r!.start,
      ymd(new Date(now.getFullYear(), now.getMonth() - n, 1)),
      `${key} starts on the 1st, ${n} months back`,
    );
    assert.equal(r!.start.slice(8, 10), "01");
  }
  ok("full-calendar-month presets exclude the current month");

  assert.equal(presetDates("custom"), null);
  ok("custom is owned by the date inputs");
}

// ── (B) toBuckets ───────────────────────────────────────────────────────────
{
  // 2026-06-28 (Sun) .. 2026-07-08 (Wed): spans a Monday boundary and a month
  // boundary. Fixed historic dates keep the weekday math deterministic.
  const days: PerfPoint[] = [];
  const d0 = new Date(Date.UTC(2026, 5, 28));
  for (let i = 0; i < 11; i++) {
    const d = new Date(d0.getTime() + i * 86400000);
    days.push({ date: d.toISOString().slice(0, 10), spend: 10, leads: i === 0 ? 0 : 2 });
  }

  const daily = toBuckets(days, "daily");
  assert.equal(daily.length, 11);
  assert.ok(daily.every((b) => !b.partial), "every daily bucket is complete");
  assert.equal(daily[0].key, "2026-06-28");
  assert.equal(daily[0].label, "Jun 28");
  assert.equal(daily[0].cpl, null); // zero leads -> null, never 0/Infinity
  assert.equal(daily[1].cpl, 5);
  ok("daily: passthrough buckets, CPL null on zero leads, 'Jun 28' labels");

  const weekly = toBuckets(days, "weekly");
  assert.deepEqual(
    weekly.map((b) => b.key),
    ["2026-06-22", "2026-06-29", "2026-07-06"], // Monday keys
  );
  assert.deepEqual(
    weekly.map((b) => b.days),
    [1, 7, 3],
  );
  assert.deepEqual(
    weekly.map((b) => b.partial),
    [true, false, true], // edge weeks dimmed "(partial)"
  );
  assert.equal(weekly[1].spend, 70);
  assert.equal(weekly[1].leads, 14);
  assert.equal(weekly[1].cpl, 5);
  ok("weekly: Monday-start keys, partial edges, summed metrics");

  const monthly = toBuckets(days, "monthly");
  assert.deepEqual(
    monthly.map((b) => b.key),
    ["2026-06", "2026-07"],
  );
  assert.deepEqual(
    monthly.map((b) => b.partial),
    [true, true], // 3 of 30 June days, 8 of 31 July days
  );
  assert.equal(monthly[0].label, "Jun '26");
  ok("monthly: calendar keys, partial months, \"Jun '26\" labels");

  // A complete month is not partial.
  const june: PerfPoint[] = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}`,
    spend: 1,
    leads: 1,
  }));
  const fullMonth = toBuckets(june, "monthly");
  assert.equal(fullMonth.length, 1);
  assert.equal(fullMonth[0].partial, false);
  assert.equal(fullMonth[0].days, 30);
  ok("a full calendar month buckets as complete");
}

// ── (C) blendedPoints ───────────────────────────────────────────────────────
{
  const series = (id: string, pts: PerfPoint[]): PerfSeries =>
    ({
      product: "gads",
      customer_id: id,
      descriptive_name: `A${id}`,
      ads_status: null,
      failed: false,
      points: pts,
    }) as any;
  const a = series("1", [
    { date: "2026-07-02", spend: 10, leads: 1 },
    { date: "2026-07-01", spend: 4, leads: 0 },
  ]);
  const b = series("2", [
    { date: "2026-07-02", spend: 2.5, leads: 3 },
    { date: "2026-07-03", spend: 7, leads: 2 },
  ]);
  const blended = blendedPoints([a, b]);
  assert.deepEqual(blended, [
    { date: "2026-07-01", spend: 4, leads: 0 },
    { date: "2026-07-02", spend: 12.5, leads: 4 },
    { date: "2026-07-03", spend: 7, leads: 2 },
  ]);
  assert.deepEqual(blendedPoints([]), []);
  ok("per-date sums across accounts, sorted, non-overlapping axes tolerated");
}

// ── (D) compareDates ────────────────────────────────────────────────────────
{
  // Previous period, day-type ranges: shift back by the range's own span, landing
  // flush against the current window (comparison end = day before current start).
  assert.deepEqual(
    compareDates("30d", { start: "2026-07-04", end: "2026-08-02" }, "prev"),
    { start: "2026-06-04", end: "2026-07-03" },
  );
  assert.deepEqual(
    compareDates("custom", { start: "2026-03-10", end: "2026-03-14" }, "prev"),
    { start: "2026-03-05", end: "2026-03-09" },
  );
  // MTD is day-type too: a 2-day window compares to the 2 days before it, across
  // the month boundary.
  assert.deepEqual(
    compareDates("mtd", { start: "2026-08-01", end: "2026-08-02" }, "prev"),
    { start: "2026-07-30", end: "2026-07-31" },
  );
  ok("previous period: day presets / custom / MTD shift back by the range's span");

  // Month presets are calendar-aware: the N full months immediately before — never
  // a day-count shift (May–Jul spans 92 days; a naive shift would start Jan 30, and
  // June's 30 days vs July's 31 would misalign last_month).
  assert.deepEqual(
    compareDates("3mo", { start: "2026-05-01", end: "2026-07-31" }, "prev"),
    { start: "2026-02-01", end: "2026-04-30" },
  );
  assert.deepEqual(
    compareDates("last_month", { start: "2026-07-01", end: "2026-07-31" }, "prev"),
    { start: "2026-06-01", end: "2026-06-30" },
  );
  assert.deepEqual(
    compareDates("12mo", { start: "2025-08-01", end: "2026-07-31" }, "prev"),
    { start: "2024-08-01", end: "2025-07-31" },
  );
  ok("previous period: month presets take the N full calendar months before");

  // Same period last year: month presets keep whole calendar months one year back;
  // day-type ranges shift both dates by a year; Feb 29 clamps to Feb 28.
  assert.deepEqual(
    compareDates("3mo", { start: "2026-05-01", end: "2026-07-31" }, "yoy"),
    { start: "2025-05-01", end: "2025-07-31" },
  );
  assert.deepEqual(
    compareDates("30d", { start: "2026-07-04", end: "2026-08-02" }, "yoy"),
    { start: "2025-07-04", end: "2025-08-02" },
  );
  assert.deepEqual(
    compareDates("custom", { start: "2024-02-29", end: "2024-03-05" }, "yoy"),
    { start: "2023-02-28", end: "2023-03-05" },
  );
  // A 12-month window's "previous period" IS the same window last year — the two
  // presets agree by construction.
  assert.deepEqual(
    compareDates("12mo", { start: "2025-08-01", end: "2026-07-31" }, "prev"),
    compareDates("12mo", { start: "2025-08-01", end: "2026-07-31" }, "yoy"),
  );
  ok("same period last year: one-year shift, whole months kept, Feb 29 clamped");

  assert.equal(compareDates("30d", { start: "2026-07-04", end: "2026-08-02" }, "none"), null);
  ok("compare 'none' derives no window (nothing extra fetches or renders)");
}

// ── (E) deltaInfo ───────────────────────────────────────────────────────────
{
  assert.deepEqual(deltaInfo(150, 100), { real: 50, pct: 50 });
  const down = deltaInfo(80, 100)!;
  assert.equal(down.real, -20);
  assert.equal(Math.round(down.pct!), -20);
  ok("real + % change for normal pairs, both directions");

  // Zero previous value: the real change stands alone — a % against a 0 base is
  // meaningless (never Infinity/NaN).
  assert.deepEqual(deltaInfo(12, 0), { real: 12, pct: null });
  assert.deepEqual(deltaInfo(0, 0), { real: 0, pct: null });
  ok("zero previous: real change only, % suppressed");

  // A side with no value (a window with no leads has CPL = null) yields null — the
  // UI renders a dash, not a bogus %.
  assert.equal(deltaInfo(null, 50), null);
  assert.equal(deltaInfo(50, null), null);
  assert.equal(deltaInfo(null, null), null);
  ok("null sides (no-lead CPL) yield null → dash, never a fake %");
}

// ── (F) accountVisibility — activity-based, status-blind (Task #3900) ───────
{
  const T = (spend: number, leads: number) => ({ spend, leads });
  const acct = (
    current: { spend: number; leads: number },
    compare: { spend: number; leads: number } | null = null,
    metricsFailed = false,
  ): AccountActivity => ({ current, compare, metricsFailed });

  // ClickUp status plays no role: the input shape has no status field, so the
  // rule CANNOT read it — an extra ads_status smuggled onto the objects changes
  // nothing. Off/Paused/On accounts with the same activity get the same flags.
  const withStatus = (ads_status: string): AccountActivity[] =>
    [
      { ...acct(T(9, 0)), ads_status },
      { ...acct(T(0, 0)), ads_status },
    ] as AccountActivity[];
  for (const status of ["off", "paused", "on"]) {
    assert.deepEqual(accountVisibility(withStatus(status), "none"), [true, false]);
  }
  ok("status is not an input — off/paused/on with identical activity flag identically");

  // Any activity in the SELECTED range keeps an account visible in every
  // comparison state — spend-only and leads-only both count as activity.
  for (const state of ["none", "loading", "failed", "loaded"] as CompareState[]) {
    const flags = accountVisibility(
      [acct(T(120.5, 0), T(0, 0)), acct(T(0, 3), T(0, 0)), acct(T(1500, 40), T(900, 22))],
      state,
    );
    assert.deepEqual(flags, [true, true, true], `state=${state}`);
  }
  ok("spend-only or leads-only activity in the range always shows the account");

  // Comparison "none": the selected range alone decides — idle hides (when a
  // sibling is visible), active shows.
  assert.deepEqual(accountVisibility([acct(T(10, 2)), acct(T(0, 0))], "none"), [true, false]);
  ok("compare 'none': only the selected range decides");

  // Comparison loading or failed: uncertain data NEVER hides — the same idle
  // account stays visible until the comparison actually loads.
  assert.deepEqual(accountVisibility([acct(T(10, 2)), acct(T(0, 0))], "loading"), [true, true]);
  assert.deepEqual(accountVisibility([acct(T(10, 2)), acct(T(0, 0))], "failed"), [true, true]);
  ok("comparison loading/failed: nothing hides on uncertain data");

  // Comparison loaded: active only in the comparison period → visible (spend-
  // or leads-only both count); idle in BOTH windows → hidden.
  assert.deepEqual(
    accountVisibility(
      [
        acct(T(10, 2), T(8, 1)), // active both windows
        acct(T(0, 0), T(55, 0)), // comparison spend only → visible
        acct(T(0, 0), T(0, 4)),  // comparison leads only → visible
        acct(T(0, 0), T(0, 0)),  // confirmed idle in both → hidden
      ],
      "loaded",
    ),
    [true, true, true, false],
  );
  ok("loaded comparison: active-in-comparison shows; idle-in-both hides");

  // Loaded comparison but THIS account's comparison side is null (its series
  // failed to load / is absent from the payload): uncertain → visible.
  assert.deepEqual(
    accountVisibility([acct(T(10, 0), T(0, 0)), acct(T(0, 0), null)], "loaded"),
    [true, true],
  );
  ok("a null comparison side (failed/absent series) keeps the account visible");

  // metrics_failed: the current range's zeros are placeholders, not confirmed
  // idleness — visible regardless of comparison state.
  assert.deepEqual(
    accountVisibility([acct(T(10, 0), T(5, 0)), acct(T(0, 0), T(0, 0), true)], "loaded"),
    [true, true],
  );
  assert.deepEqual(accountVisibility([acct(T(10, 0)), acct(T(0, 0), null, true)], "none"), [
    true,
    true,
  ]);
  ok("metrics_failed placeholder zeros never count as idleness");

  // All-idle bypass: when the rule would hide EVERY account, filtering is
  // skipped — the section renders as today, and a single-account client always
  // shows its one card.
  assert.deepEqual(accountVisibility([acct(T(0, 0)), acct(T(0, 0))], "none"), [true, true]);
  assert.deepEqual(
    accountVisibility([acct(T(0, 0), T(0, 0)), acct(T(0, 0), T(0, 0))], "loaded"),
    [true, true],
  );
  assert.deepEqual(accountVisibility([acct(T(0, 0))], "none"), [true]);
  assert.deepEqual(accountVisibility([], "none"), []);
  ok("all-idle bypasses filtering (never a blank section); single idle account stays");

  // Flags align with input order — the caller keys colors to the payload index,
  // so order preservation is what keeps colors stable when hiding/revealing.
  const flags = accountVisibility(
    [acct(T(0, 0)), acct(T(3, 0)), acct(T(0, 0)), acct(T(0, 1))],
    "none",
  );
  assert.deepEqual(flags, [false, true, false, true]);
  ok("flags align 1:1 with the input (payload) order");
}

// ── (G) accountShortLabel / accountTagIsEcho — shared name convention (#3906) ─
{
  // 41 chars — a real-shaped "Client | LSA - City" store name that must truncate.
  const LONG = "April Jones Law | LSA - Greenwood Village";

  // A client's sole GAds account collapses to the bare "GAds"…
  assert.equal(
    accountShortLabel({ product: "gads", name: "April Jones Law | Search", city: null }, 1),
    "GAds",
  );
  // …and exactly that row treats its product tag as an echo (never "GAds GAds");
  // multi-GAds rows and LSA rows keep the tag.
  assert.equal(accountTagIsEcho({ product: "gads" }, 1), true);
  assert.equal(accountTagIsEcho({ product: "gads" }, 2), false);
  assert.equal(accountTagIsEcho({ product: "lsa" }, 1), false);
  assert.equal(accountTagIsEcho({ product: "lsa" }, 0), false);
  ok('sole GAds collapses to "GAds"; only that row skips its product tag');

  // Several GAds accounts: each keeps a distinguishing (truncated) name.
  assert.equal(accountShortLabel({ product: "gads", name: "Short Name", city: null }, 2), "Short Name");
  assert.equal(
    accountShortLabel({ product: "gads", name: LONG, city: null }, 2),
    "April Jones Law | LSA…",
  );
  ok("multi-GAds falls back to the account name, truncated");

  // LSA reads its city whenever one exists — however many GAds accounts there are.
  for (const gadsCount of [0, 1, 3]) {
    assert.equal(accountShortLabel({ product: "lsa", name: LONG, city: "Aurora" }, gadsCount), "Aurora");
  }
  ok("LSA city wins whenever present");

  // LSA without a city gets the same truncated-name fallback.
  assert.equal(accountShortLabel({ product: "lsa", name: LONG, city: null }, 1), "April Jones Law | LSA…");
  assert.equal(accountShortLabel({ product: "lsa", name: "LSA - Aurora", city: null }, 1), "LSA - Aurora");
  ok("LSA missing its city truncates the store name");

  // Truncation boundary: 22 chars fit whole; 23+ become 21 chars + ellipsis (22 total).
  const n22 = "x".repeat(22);
  assert.equal(accountShortLabel({ product: "gads", name: n22, city: null }, 2), n22);
  assert.equal(
    accountShortLabel({ product: "gads", name: "x".repeat(23), city: null }, 2),
    `${"x".repeat(21)}…`,
  );
  ok("22-char names stay whole; longer ones truncate to 21 + ellipsis");
}

// ── (H) channelBreakdown — GAds vs all-LSA-combined (Task #3912) ─────────────
{
  const mkSeries = (
    product: PerfSeries["product"],
    cid: string,
    pts: [string, number, number][],
    opts: { ads_status?: PerfSeries["ads_status"]; metrics_failed?: boolean } = {},
  ): PerfSeries => ({
    product,
    customer_id: cid,
    name: `Acct ${cid}`,
    city: null,
    ads_status: opts.ads_status ?? null,
    metrics_failed: opts.metrics_failed ?? false,
    points: pts.map(([date, spend, leads]) => ({ date, spend, leads })),
  });
  const RT = (spend: number, leads: number): RangeTotals => ({
    spend,
    leads,
    cpl: leads > 0 ? spend / leads : null,
  });
  const noCmp = (series: PerfSeries) => ({ series, compare: null });

  // Grouping, counts, combined series and shares. The LSA members carry Off and
  // Paused ClickUp statuses — the helper has no status logic, so they aggregate
  // exactly like an On account (statuses ride along untouched).
  const g1 = mkSeries("gads", "g-1", [
    ["2026-07-01", 100, 1],
    ["2026-07-02", 100, 1],
  ]);
  const l1 = mkSeries(
    "lsa",
    "l-1",
    [
      ["2026-07-01", 300, 6],
      ["2026-07-02", 100, 2],
    ],
    { ads_status: "paused" },
  );
  const l2 = mkSeries(
    "lsa",
    "l-2",
    [
      ["2026-07-01", 200, 5],
      ["2026-07-02", 200, 5],
    ],
    { ads_status: "off" },
  );
  const chans = channelBreakdown([g1, l1, l2].map(noCmp));
  assert.equal(chans.length, 2);
  const [gc, lc] = chans;
  assert.equal(gc.product, "gads");
  assert.equal(gc.label, "Google Ads");
  assert.equal(gc.short, "GAds");
  assert.equal(gc.accounts, 1);
  assert.deepEqual(gc.current, { spend: 200, leads: 2, cpl: 100 });
  assert.equal(lc.product, "lsa");
  assert.equal(lc.label, "LSA");
  assert.equal(lc.accounts, 2); // Off + Paused both counted
  assert.deepEqual(lc.current, { spend: 800, leads: 18, cpl: 800 / 18 });
  assert.deepEqual(lc.points, [
    { date: "2026-07-01", spend: 500, leads: 11 },
    { date: "2026-07-02", spend: 300, leads: 7 },
  ]);
  assert.equal(gc.spendShare, 20);
  assert.equal(lc.spendShare, 80);
  assert.equal(gc.leadsShare, 10);
  assert.equal(lc.leadsShare, 90);
  assert.equal(gc.compare, null); // no comparison passed → chips suppressed
  assert.equal(lc.compare, null);
  assert.equal(gc.anyFailed, false);
  ok("channels group by product with counts, combined daily series and shares");

  // Channel order is GAds-then-LSA regardless of input order (payload order).
  assert.deepEqual(
    channelBreakdown([l1, g1, l2].map(noCmp)).map((c) => c.product),
    ["gads", "lsa"],
  );
  ok("GAds-first channel order, independent of input order");

  // One channel only → one summary (the UI renders the row only for 2+); empty in,
  // empty out; all-zero totals give 0% shares, never NaN.
  assert.equal(channelBreakdown([l1, l2].map(noCmp)).length, 1);
  assert.deepEqual(channelBreakdown([]), []);
  const zero = channelBreakdown([
    noCmp(mkSeries("gads", "g-z", [["2026-07-01", 0, 0]])),
    noCmp(mkSeries("lsa", "l-z", [["2026-07-01", 0, 0]])),
  ]);
  assert.deepEqual(
    zero.map((c) => [c.spendShare, c.leadsShare]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  ok("single-channel/empty inputs and 0% shares on zero totals (never NaN)");

  // Comparison totals sum across members (CPL re-derived, null on zero leads)…
  const [gCmp, lCmp] = channelBreakdown([
    { series: g1, compare: RT(50, 2) },
    { series: l1, compare: RT(100, 4) },
    { series: l2, compare: RT(20, 0) },
  ]);
  assert.deepEqual(gCmp.compare, { spend: 50, leads: 2, cpl: 25 });
  assert.deepEqual(lCmp.compare, { spend: 120, leads: 4, cpl: 30 });
  const [gZeroLeads] = channelBreakdown([{ series: g1, compare: RT(50, 0) }]);
  assert.deepEqual(gZeroLeads.compare, { spend: 50, leads: 0, cpl: null });
  ok("comparison sums per channel with re-derived CPL (null on zero leads)");

  // …but ONE member with a missing comparison side nulls only ITS channel — a
  // partial sum would understate the channel, so its chips are suppressed while
  // the other channel keeps its deltas (mirrors the section's degrade rule).
  const [gKeep, lNull] = channelBreakdown([
    { series: g1, compare: RT(50, 2) },
    { series: l1, compare: RT(100, 4) },
    { series: l2, compare: null },
  ]);
  assert.deepEqual(gKeep.compare, { spend: 50, leads: 2, cpl: 25 });
  assert.equal(lNull.compare, null);
  ok("a missing member comparison side suppresses only that channel's deltas");

  // A member whose CURRENT series failed poisons its channel: anyFailed (the
  // "data didn't load" treatment) + deltas suppressed even with comparison data
  // present — its placeholder zeros would fake the change figures.
  const lFail = mkSeries("lsa", "l-3", [["2026-07-01", 0, 0]], { metrics_failed: true });
  const [gOkC, lFailC] = channelBreakdown([
    { series: g1, compare: RT(50, 2) },
    { series: l1, compare: RT(100, 4) },
    { series: lFail, compare: RT(30, 1) },
  ]);
  assert.equal(lFailC.anyFailed, true);
  assert.equal(lFailC.compare, null);
  assert.equal(lFailC.accounts, 2); // still counted — failed ≠ excluded
  assert.equal(gOkC.anyFailed, false);
  assert.deepEqual(gOkC.compare, { spend: 50, leads: 2, cpl: 25 });
  ok("a metrics-failed member flags its channel and suppresses its deltas only");

  // Composition with the (F) visibility rule — exactly how the component feeds
  // it: Ads Status never filters, an Off account that spent ONLY in the
  // comparison window stays included (counts + comparison totals), a
  // confirmed-idle account drops with the reveal off and rejoins the counts
  // with the reveal on WITHOUT changing totals or shares (idle = zeros).
  const gOn = mkSeries("gads", "g-a", [["2026-07-01", 90, 3]]);
  const lOff = mkSeries("lsa", "l-off", [["2026-07-01", 0, 0]], { ads_status: "off" });
  const lIdle = mkSeries("lsa", "l-idle", [["2026-07-01", 0, 0]], { ads_status: "paused" });
  const accounts = [gOn, lOff, lIdle];
  const cmpByKey = new Map<string, RangeTotals>([
    ["gads:g-a", RT(80, 2)],
    ["lsa:l-off", RT(55, 0)], // comparison-window-only spender
    ["lsa:l-idle", RT(0, 0)], // confirmed idle in both windows
  ]);
  const cmpFor = (s: PerfSeries) => cmpByKey.get(`${s.product}:${s.customer_id}`) ?? null;
  const flags2 = accountVisibility(
    accounts.map((s) => ({
      current: totals(s.points),
      compare: cmpFor(s),
      metricsFailed: s.metrics_failed,
    })),
    "loaded",
  );
  assert.deepEqual(flags2, [true, true, false]);
  const hidden = channelBreakdown(
    accounts.filter((_, i) => flags2[i] !== false).map((s) => ({ series: s, compare: cmpFor(s) })),
  );
  const lsaHidden = hidden.find((c) => c.product === "lsa")!;
  assert.equal(hidden.length, 2); // both channels present — the Off account keeps LSA alive
  assert.equal(lsaHidden.accounts, 1);
  assert.deepEqual(lsaHidden.current, { spend: 0, leads: 0, cpl: null });
  assert.deepEqual(lsaHidden.compare, { spend: 55, leads: 0, cpl: null });
  const revealed = channelBreakdown(accounts.map((s) => ({ series: s, compare: cmpFor(s) })));
  const lsaRevealed = revealed.find((c) => c.product === "lsa")!;
  assert.equal(lsaRevealed.accounts, 2); // reveal adds the idle account to the counts…
  assert.deepEqual(lsaRevealed.current, lsaHidden.current); // …but totals don't move
  assert.deepEqual(lsaRevealed.compare, lsaHidden.compare);
  assert.deepEqual(
    revealed.map((c) => c.spendShare),
    hidden.map((c) => c.spendShare),
  );
  ok("visibility-rule composition: status-blind, comparison-only spenders count, reveal only moves counts");
}

// ── (I) spendBattery — battery segments + top spender (Task #3912) ──────────
{
  const bat = spendBattery([
    { id: "a", label: "Greenwood", color: "c1", spend: 740 },
    { id: "b", label: "Canton", color: "c2", spend: 0 },
    { id: "c", label: "Dayton", color: "c3", spend: 260 },
  ]);
  assert.deepEqual(
    bat.segments.map((s) => s.id),
    ["a", "c"], // zero-spend items render no sliver
  );
  assert.equal(bat.segments[0].pct, 74);
  assert.equal(bat.segments[1].pct, 26);
  assert.equal(bat.segments[0].color, "c1");
  assert.deepEqual(bat.top, { id: "a", label: "Greenwood", color: "c1", pct: 74 });
  ok("segments share out spend (zero-spend skipped); top spender identified");

  // Ties keep the first in input order — payload order, so the "X drives Y%"
  // line can't flip between renders; totals of the pcts cover the whole bar.
  const tie = spendBattery([
    { id: "a", label: "A", color: "x", spend: 50 },
    { id: "b", label: "B", color: "y", spend: 50 },
  ]);
  assert.equal(tie.top!.id, "a");
  assert.equal(
    Math.round(tie.segments.reduce((s, x) => s + x.pct, 0)),
    100,
  );
  ok("spend ties keep payload order; segment pcts cover the full bar");

  // No spend anywhere → no segments and no top (headers omit battery + summary).
  assert.deepEqual(spendBattery([{ id: "a", label: "A", color: "x", spend: 0 }]), {
    segments: [],
    top: null,
  });
  assert.deepEqual(spendBattery([]), { segments: [], top: null });
  ok("all-zero or empty input yields no battery and no top-spender line");
}

// ── (J) client-profile CPL precision — display-only whole dollars ───────────
{
  // Values immediately below/at the rounding boundary pin nearest-dollar
  // behavior; the report-shaped fractional example must agree with the
  // Marketing report's existing Math.round convention.
  assert.equal(formatCpl(201.49), "$201");
  assert.equal(formatCpl(201.5), "$202");
  assert.equal(formatCpl(201.89), "$202");
  assert.equal(formatCpl(null), "—");

  // Formatting must not mutate the underlying ratio or comparison math.
  const fractional = totals([{ date: "2026-08-01", spend: 201.89, leads: 1 }]);
  assert.equal(fractional.cpl, 201.89);
  const fractionalDelta = deltaInfo(fractional.cpl, 100.51)!;
  assert.ok(Math.abs(fractionalDelta.real - 101.38) < 1e-9);
  assert.ok(
    Math.abs(fractionalDelta.pct! - ((201.89 / 100.51 - 1) * 100)) < 1e-9,
  );
  ok("CPL rounds only at display time; null stays a dash and raw ratio/delta precision is preserved");
}

console.log(`\nAll Phase 6 performance-derivation checks passed (${passed} groups).`);
