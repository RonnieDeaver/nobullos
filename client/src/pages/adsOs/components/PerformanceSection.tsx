// Client-profile Performance overview — spend / leads / CPL over time, one chart card
// per account plus a blended card (when >1 account). The backend returns a DAILY series
// per account for the selected dates (incl. Ads Status = Off accounts — reporting covers
// everything); this component derives the blended series, the weekly/monthly buckets and
// per-bucket CPL locally, so switching timeframe is instant and free (no refetch).
// The section is also where the range's headline numbers live (the hero shows identity
// only): blended totals on the top card plus explicit per-account spend/leads/CPL — the
// Overview strip for multi-account clients, the single card's headline otherwise.
//
// Range semantics (locked with the team):
//   · "Last N days" ends YESTERDAY (today's partial day never charts — app convention).
//   · "Month to date" = 1st of this month → yesterday.
//   · "Last month" = the previous full calendar month.
//   · "Last 3/6/12 months" = the N most recent FULL calendar months (current excluded).
//   · Custom = any start/end up to yesterday, max ~13 months.
// Weeks bucket Monday-start; a first/last bucket not covering its full week/month is
// kept but marked "(partial)" and drawn dimmed.
//
// Comparison ("Compare" select, default none — nothing extra renders):
//   · Previous period — day presets, MTD and custom shift back by the range's span
//     (contiguous); month presets are calendar-aware: the N full months immediately
//     before (never a naive day-count shift across unequal months).
//   · Same period last year — one year earlier; month presets keep whole calendar
//     months, day ranges shift both dates (Feb 29 clamps to Feb 28).
// Deltas render as "▲/▼ real · %" chips on every spend/leads/CPL readout; no % when
// the previous value is 0, a dash when a side has no CPL. The comparison fetch is
// separate — a failure degrades to a note and never touches the primary charts.
//
// Overview layout (mirrors the team's mock): three big KPI tiles (blended totals,
// metric-colored, each carrying its delta + the comparison value), the composition
// donuts/bars, a "By account · this range" table (value with its delta stacked
// beneath), then the blended trend.
//
// Account visibility (Task #3900) is ACTIVITY-based, never status-based: ClickUp Ads
// Status can't hide an account — an Off/Paused account with any spend or leads in the
// selected range or the loaded comparison period always renders (with its chip). Only
// accounts confirmed idle in every applicable window tuck behind a muted "N accounts
// with no activity — show" reveal; uncertain data (comparison loading/failed,
// metrics_failed placeholder zeros) never hides, and an all-idle client renders
// unfiltered (see accountVisibility). Blended figures still sum EVERY account (idle
// ones contribute zeros), and colors stay keyed to payload order so hiding/revealing
// never reshuffles them.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { ClientPerformance, PerfPoint, PerfSeries, Product } from "../lib/types";
import {
  accountShortLabel,
  accountTagIsEcho,
  formatCpl,
  formatId,
  money,
  moneyWhole,
} from "../lib/format";
import { METRIC_COLORS, TrendRow, type PerfBucket } from "./PerfChart";
import { ACCOUNT_PALETTE, CompositionRow, type CompositionItem } from "./PerfComposition";

type RangeKey =
  | "30d" | "14d" | "7d" | "mtd" | "last_month" | "3mo" | "6mo" | "12mo" | "custom";
type Timeframe = "daily" | "weekly" | "monthly";

const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "30d", label: "Last 30 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "7d", label: "Last 7 days" },
  { value: "mtd", label: "Month to date" },
  { value: "last_month", label: "Last month" },
  { value: "3mo", label: "Last 3 months" },
  { value: "6mo", label: "Last 6 months" },
  { value: "12mo", label: "Last 12 months" },
  { value: "custom", label: "Custom range" },
];

const MAX_SPAN_DAYS = 400;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---- date math (local calendar, ISO strings; display via string slicing = TZ-safe) ----

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}
function monthDay(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}
function monthYear(key: string): string {
  // key = YYYY-MM
  return `${MONTHS[Number(key.slice(5, 7)) - 1]} '${key.slice(2, 4)}`;
}
function spanDays(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
}
// "Jul 4 – Aug 2, 2026" (start year shown only when it differs) — the range note
// format, reused for the resolved comparison window.
function rangeLabel(d: { start: string; end: string }): string {
  const startYear = d.start.slice(0, 4) !== d.end.slice(0, 4) ? `, ${d.start.slice(0, 4)}` : "";
  return `${monthDay(d.start)}${startYear} – ${monthDay(d.end)}, ${d.end.slice(0, 4)}`;
}

// Resolved [start, end] ISO pair for a preset — or null when the range has no complete
// day yet (Month to date on the 1st). Exported for tests.
export function presetDates(key: RangeKey): { start: string; end: string } | null {
  const now = new Date();
  const yest = yesterday();
  const days = (n: number) => {
    const s = new Date(yest);
    s.setDate(s.getDate() - (n - 1));
    return { start: ymd(s), end: ymd(yest) };
  };
  const fullMonths = (n: number) => {
    const end = new Date(now.getFullYear(), now.getMonth(), 0);        // last day prev month
    const start = new Date(now.getFullYear(), now.getMonth() - n, 1);  // 1st, n months back
    return { start: ymd(start), end: ymd(end) };
  };
  switch (key) {
    case "30d": return days(30);
    case "14d": return days(14);
    case "7d": return days(7);
    case "mtd": {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      if (ymd(first) > ymd(yest)) return null; // the 1st: no complete day yet
      return { start: ymd(first), end: ymd(yest) };
    }
    case "last_month": return fullMonths(1);
    case "3mo": return fullMonths(3);
    case "6mo": return fullMonths(6);
    case "12mo": return fullMonths(12);
    default: return null; // custom — handled by the inputs
  }
}

// ---- comparison window + deltas ----

export type CompareKey = "none" | "prev" | "yoy";

// "vs previous 30 days" reads better than a generic "previous period", so the prev
// option's label follows the selected range: N days for day-type ranges (span from the
// resolved dates), N months for the calendar presets.
function compareOptions(
  rangeKey: RangeKey,
  dates: { start: string; end: string } | null,
): { value: CompareKey; label: string }[] {
  const months = MONTH_PRESET_SPANS[rangeKey];
  const prevLabel = months
    ? months === 1 ? "vs previous month" : `vs previous ${months} months`
    : dates
      ? `vs previous ${spanDays(dates.start, dates.end)} days`
      : "vs previous period";
  return [
    { value: "none", label: "No comparison" },
    { value: "prev", label: prevLabel },
    { value: "yoy", label: "vs same period last year" },
  ];
}

// The calendar-aware presets: N whole months. Everything else (day presets, MTD,
// custom) compares by day-span shift.
const MONTH_PRESET_SPANS: Partial<Record<RangeKey, number>> = {
  last_month: 1, "3mo": 3, "6mo": 6, "12mo": 12,
};

function addDaysIso(iso: string, n: number): string {
  return ymd(new Date(
    Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + n
  ));
}
// One year back, day clamped to the target month's length (Feb 29 → Feb 28).
function yearBackIso(iso: string): string {
  const y = Number(iso.slice(0, 4)) - 1;
  const m = Number(iso.slice(5, 7));
  const day = Math.min(Number(iso.slice(8, 10)), new Date(y, m, 0).getDate());
  return ymd(new Date(y, m - 1, day));
}

// The comparison window the current selection resolves to — pure, exported for tests.
// "prev": day-type ranges shift back by their own span (contiguous previous window);
// month presets take the N full months immediately before. "yoy": the same window one
// year earlier (month presets keep whole calendar months, so Feb compares to Feb even
// across leap years).
export function compareDates(
  rangeKey: RangeKey,
  dates: { start: string; end: string },
  compare: CompareKey,
): { start: string; end: string } | null {
  if (compare === "none") return null;
  const months = MONTH_PRESET_SPANS[rangeKey];
  if (months) {
    const sy = Number(dates.start.slice(0, 4)), sm = Number(dates.start.slice(5, 7));
    if (compare === "prev") {
      return {
        start: ymd(new Date(sy, sm - 1 - months, 1)),
        end: ymd(new Date(sy, sm - 1, 0)), // last day of the month before the window
      };
    }
    const ey = Number(dates.end.slice(0, 4)), em = Number(dates.end.slice(5, 7));
    return {
      start: ymd(new Date(sy - 1, sm - 1, 1)),
      end: ymd(new Date(ey - 1, em, 0)), // last day of the same end month, a year back
    };
  }
  if (compare === "prev") {
    const span = spanDays(dates.start, dates.end);
    return { start: addDaysIso(dates.start, -span), end: addDaysIso(dates.end, -span) };
  }
  return { start: yearBackIso(dates.start), end: yearBackIso(dates.end) };
}

export interface DeltaInfo {
  real: number;        // cur − prev, in the metric's own unit
  pct: number | null;  // % change; null when prev is 0 (no meaningful base)
}

// Real + % change for a metric pair — null when either side has no value (a window
// with no leads has CPL = null: the UI shows a dash, never a bogus %). Exported for
// tests.
export function deltaInfo(cur: number | null, prev: number | null): DeltaInfo | null {
  if (cur === null || prev === null) return null;
  return { real: cur - prev, pct: prev > 0 ? (cur / prev - 1) * 100 : null };
}

// ---- activity-based account visibility (Task #3900) ----

/** Where the comparison fetch stands, as visibility evidence: only "loaded" may
 *  contribute hiding evidence; "loading"/"failed" keep every account visible
 *  (never hide on uncertain data); "none" leaves the selected range alone to
 *  decide. */
export type CompareState = "none" | "loading" | "failed" | "loaded";

export interface AccountActivity {
  /** Selected-range totals for the account. */
  current: { spend: number; leads: number };
  /** Comparison-window totals — null when the comparison payload has no loaded
   *  series for this account (its fetch failed or it's absent): uncertain, so
   *  the account stays visible. Ignored unless compareState is "loaded". */
  compare: { spend: number; leads: number } | null;
  /** The current-range series failed to load — its zeros are placeholders, not
   *  confirmed idleness, so the account stays visible. */
  metricsFailed: boolean;
}

// Per-account visibility flags, aligned with the input order (callers keep color
// assignment keyed to the payload index, so hiding never reshuffles colors). The
// rule is ACTIVITY-based only — ClickUp Ads Status is deliberately not an input:
// Off/Paused never hides an account. An account is active in a window when it has
// any spend or any leads there; it hides only when idleness is CONFIRMED in every
// applicable window:
//   · metrics_failed → visible (placeholder zeros are not evidence);
//   · any current-range activity → visible;
//   · comparison "none" → the selected range alone decides;
//   · comparison "loading"/"failed" → visible (uncertain data never hides);
//   · comparison "loaded" → hidden only when the account's comparison side is
//     present AND idle too (a null side = uncertain → visible).
// All-idle bypass: if the rule would hide every account, filtering is skipped
// entirely (all visible) — a fully idle client renders exactly as before, never a
// blank Performance section, and a single-account client always shows its card.
export function accountVisibility(
  accounts: AccountActivity[],
  compareState: CompareState,
): boolean[] {
  const active = (t: { spend: number; leads: number }) => t.spend > 0 || t.leads > 0;
  const flags = accounts.map((a) => {
    if (a.metricsFailed) return true;
    if (active(a.current)) return true;
    if (compareState === "loading" || compareState === "failed") return true;
    if (compareState === "loaded") return a.compare === null || active(a.compare);
    return false; // "none" — confirmed idle in the selected range
  });
  return flags.some(Boolean) ? flags : flags.map(() => true);
}

// ---- bucketing (daily payload -> chart buckets) ----

function mondayOf(iso: string): string {
  const [y, m, d] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // back to Monday
  return dt.toISOString().slice(0, 10);
}
function daysInMonth(key: string): number {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();
}

export function toBuckets(points: PerfPoint[], tf: Timeframe): PerfBucket[] {
  const groups = new Map<string, { spend: number; leads: number; days: number }>();
  for (const p of points) {
    const key = tf === "daily" ? p.date : tf === "weekly" ? mondayOf(p.date) : p.date.slice(0, 7);
    const g = groups.get(key) ?? { spend: 0, leads: 0, days: 0 };
    g.spend += p.spend;
    g.leads += p.leads;
    g.days += 1;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, g]) => {
      const expected = tf === "daily" ? 1 : tf === "weekly" ? 7 : daysInMonth(key);
      return {
        key,
        label: tf === "monthly" ? monthYear(key) : monthDay(key),
        days: g.days,
        partial: g.days < expected,
        spend: g.spend,
        leads: g.leads,
        cpl: g.leads > 0 ? g.spend / g.leads : null,
      };
    });
}

// Blended daily series: sum across accounts per date (all series share the zero-filled
// date axis, so index-wise addition is safe; verified by date key regardless).
export function blendedPoints(accounts: PerfSeries[]): PerfPoint[] {
  const by = new Map<string, PerfPoint>();
  for (const s of accounts) {
    for (const p of s.points) {
      const b = by.get(p.date) ?? { date: p.date, spend: 0, leads: 0 };
      b.spend += p.spend;
      b.leads += p.leads;
      by.set(p.date, b);
    }
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---- the section ----

export interface RangeTotals {
  spend: number;
  leads: number;
  cpl: number | null;
}

export function totals(points: PerfPoint[]): RangeTotals {
  const spend = points.reduce((a, p) => a + p.spend, 0);
  const leads = points.reduce((a, p) => a + p.leads, 0);
  return { spend, leads, cpl: leads > 0 ? spend / leads : null };
}

// ---- channel + battery aggregation (Task #3912) ----

/** Solid channel colors for battery/split segments and channel dots — theme
 *  variables consistent with the GAds/LSA tag hues (blue / green); adsOs.css
 *  defines light + dark values. */
export const CHANNEL_COLORS: Record<Product, string> = {
  gads: "var(--chan-gads)",
  lsa: "var(--chan-lsa)",
};

export interface ChannelAgg {
  product: Product;
  /** Platform-table / trend-row display name. */
  label: string;
  /** Compact name for battery summaries ("GAds 2% · LSA 98% of spend"). */
  short: string;
  /** Included account count (the caller passes the #3900-visible set). */
  accounts: number;
  current: RangeTotals;
  /** Comparison-window totals summed across members — null (chips suppressed)
   *  when the comparison is off/unavailable, any member's comparison side is
   *  missing, or any member's CURRENT series failed (its placeholder zeros
   *  would fake deltas), mirroring the per-account `cmpFor` rule. */
  compare: RangeTotals | null;
  /** Combined daily series across the channel's members. */
  points: PerfPoint[];
  /** Any member's current series failed to load — the channel carries the
   *  "data didn't load" treatment and its deltas are suppressed. */
  anyFailed: boolean;
  /** Share of the included accounts' total spend/leads, 0–100 (0 when the
   *  cross-channel total is 0 — never NaN). */
  spendShare: number;
  leadsShare: number;
}

// Group included accounts into per-channel summaries — GAds first, LSA second
// (payload order); a channel with no included account is simply absent, and the
// UI renders the by-channel row only when BOTH are present. INCLUSION IS THE
// CALLER'S: pass exactly the accounts the #3900 activity-visibility rule keeps
// (plus any revealed idle ones) so this breakdown, the by-account breakdown and
// the idle reveal can never disagree — ClickUp Ads Status is not an input here
// and never filters. Per-account comparison totals arrive aligned with the
// entries (null = comparison off, or that account's comparison side missing).
export function channelBreakdown(
  entries: { series: PerfSeries; compare: RangeTotals | null }[],
): ChannelAgg[] {
  const out: ChannelAgg[] = [];
  for (const product of ["gads", "lsa"] as Product[]) {
    const members = entries.filter((e) => e.series.product === product);
    if (!members.length) continue;
    const points = blendedPoints(members.map((m) => m.series));
    const anyFailed = members.some((m) => m.series.metrics_failed);
    let compare: RangeTotals | null = null;
    if (!anyFailed && members.every((m) => m.compare !== null)) {
      const spend = members.reduce((a, m) => a + (m.compare as RangeTotals).spend, 0);
      const leads = members.reduce((a, m) => a + (m.compare as RangeTotals).leads, 0);
      compare = { spend, leads, cpl: leads > 0 ? spend / leads : null };
    }
    out.push({
      product,
      label: product === "gads" ? "Google Ads" : "LSA",
      short: product === "gads" ? "GAds" : "LSA",
      accounts: members.length,
      current: totals(points),
      compare,
      points,
      anyFailed,
      spendShare: 0, // filled below once cross-channel totals are known
      leadsShare: 0,
    });
  }
  const totSpend = out.reduce((a, c) => a + c.current.spend, 0);
  const totLeads = out.reduce((a, c) => a + c.current.leads, 0);
  for (const c of out) {
    c.spendShare = totSpend > 0 ? (c.current.spend / totSpend) * 100 : 0;
    c.leadsShare = totLeads > 0 ? (c.current.leads / totLeads) * 100 : 0;
  }
  return out;
}

export interface BatterySeg {
  id: string;
  label: string;
  color: string;
  /** 0–100 share of the group's total spend. */
  pct: number;
}

// Data for the compact "battery" composition strip: one segment per item with
// spend (zero-spend items would be invisible slivers, so they're skipped), plus
// the top spender for the "X drives Y% of spend" summary. Ties keep the first
// in input order — payload order, so the pick is stable across renders. No
// spend at all → no segments and no top (headers omit battery + summary).
export function spendBattery(
  items: { id: string; label: string; color: string; spend: number }[],
): { segments: BatterySeg[]; top: BatterySeg | null } {
  const total = items.reduce((a, i) => a + (i.spend > 0 ? i.spend : 0), 0);
  if (total <= 0) return { segments: [], top: null };
  const segments = items
    .filter((i) => i.spend > 0)
    .map((i) => ({ id: i.id, label: i.label, color: i.color, pct: (i.spend / total) * 100 }));
  let top = segments[0];
  for (const s of segments) if (s.pct > top.pct) top = s;
  return { segments, top };
}

// Categorical color per account, keyed to the PAYLOAD index (fixed account order) —
// one color per account across the donuts, CPL bars, legend dots and breakdown
// cards. Keyed to payload order deliberately: hiding or revealing idle accounts must
// never reshuffle the remaining accounts' colors.
const colorFor = (i: number) => ACCOUNT_PALETTE[i % ACCOUNT_PALETTE.length];

function Chip({ s }: { s: PerfSeries }) {
  if (s.ads_status === "paused") return <span className="cp-status paused">Paused</span>;
  if (s.ads_status === "off") return <span className="cp-status off">Off</span>;
  return null;
}

// One comparison chip: "▲ $340 · 13%" — arrow for direction, real change, then the %
// (unsigned; the arrow already says which way). Tinting follows the app's good/bad
// rule — leads up = good, CPL down = good, spend neutral — with the same ≥10%-to-tint
// threshold as the dashboard delta pills. A null delta (no CPL on a side) renders a
// dash rather than a bogus %; a zero-base delta shows the real change with no %.
function DeltaChip({ d, kind, fmt, vs }: {
  d: DeltaInfo | null;
  kind: "neutral" | "up-good" | "down-good";
  fmt: (v: number) => string;
  /** Formatted comparison-period value, for the tooltip. */
  vs?: string;
}) {
  if (d === null) {
    return <span className="perf-chg n" title="No comparison data for this metric">—</span>;
  }
  const title = vs ? `vs ${vs} in the comparison period` : undefined;
  if (d.real === 0) return <span className="perf-chg n" title={title ?? "No change vs comparison"}>±0</span>;
  const pctR = d.pct === null ? null : Math.round(d.pct);
  const up = d.real > 0;
  const cls =
    kind === "neutral" || pctR === null || Math.abs(pctR) < 10
      ? "n"
      : (kind === "up-good" ? up : !up) ? "up" : "dn";
  return (
    <span className={`perf-chg ${cls}`} title={title}>
      {up ? "▲" : "▼"} {fmt(Math.abs(d.real))}
      {pctR !== null && pctR !== 0 && <em>· {Math.abs(pctR)}%</em>}
    </span>
  );
}

const fmtLeadsVal = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// Per-metric delta chips sharing one formatting rule set: spend and CPL deltas
// round to whole dollars (the sign lives in the arrow); leads stay integer or
// 1-decimal. The raw delta and percentage calculations remain full precision.
function SpendDelta({ t, cmp }: { t: RangeTotals; cmp: RangeTotals }) {
  return <DeltaChip d={deltaInfo(t.spend, cmp.spend)} kind="neutral" fmt={moneyWhole} vs={moneyWhole(cmp.spend)} />;
}
function LeadsDelta({ t, cmp }: { t: RangeTotals; cmp: RangeTotals }) {
  return <DeltaChip d={deltaInfo(t.leads, cmp.leads)} kind="up-good" fmt={fmtLeadsVal} vs={fmtLeadsVal(cmp.leads)} />;
}
function CplDelta({ t, cmp }: { t: RangeTotals; cmp: RangeTotals }) {
  return (
    <DeltaChip
      d={deltaInfo(t.cpl, cmp.cpl)} kind="down-good" fmt={moneyWhole}
      vs={cmp.cpl === null ? undefined : formatCpl(cmp.cpl)}
    />
  );
}

// The compact segmented battery strip on breakdown headers. Purely decorative —
// the adjacent summary text always carries the numbers — so it's aria-hidden.
function Battery({ segments }: { segments: BatterySeg[] }) {
  if (!segments.length) return null;
  return (
    <span className="perf-battery" aria-hidden="true">
      {segments.map((s) => (
        <span key={s.id} className="seg" style={{ width: `${s.pct}%`, background: s.color }} />
      ))}
    </span>
  );
}

// One labeled split bar of the by-channel "Share of this range" block — a
// full-width battery plus a per-channel legend ("● GAds 2% · ● LSA 98%").
function ChannelSplitRow({ label, channels, share }: {
  label: string;
  channels: ChannelAgg[];
  share: (c: ChannelAgg) => number;
}) {
  return (
    <div className="perf-split-row" data-testid={`perf-split-${label.toLowerCase()}`}>
      <span className="perf-split-label">{label}</span>
      <span className="perf-split-track" aria-hidden="true">
        {channels.filter((c) => share(c) > 0).map((c) => (
          <span
            key={c.product} className="seg"
            style={{ width: `${share(c)}%`, background: CHANNEL_COLORS[c.product] }}
          />
        ))}
      </span>
      <span className="perf-split-legend tnum">
        {channels.map((c) => (
          <span key={c.product}>
            <span className="perf-dot" style={{ background: CHANNEL_COLORS[c.product] }} />
            {c.short} <b>{Math.round(share(c))}%</b>
          </span>
        ))}
      </span>
    </div>
  );
}

// The headline treatment: three metric-colored KPI tiles — big value with its delta
// beside it, the metric label, and the comparison period's value underneath when a
// comparison is active.
function KpiTiles({ t, cmp, single }: {
  t: RangeTotals;
  cmp?: RangeTotals | null;
  /** Single-account clients label the third tile plain "CPL" (nothing is blended). */
  single?: boolean;
}) {
  const tile = (
    key: "spend" | "leads" | "cpl",
    label: string,
    value: string,
    delta: ReactNode,
    vsValue: string | null,
  ) => (
    // Data-viz KPI rail — METRIC_COLORS is a per-metric chart palette (matches
    // the series colors), NOT a status signal; exempt from the --status-*
    // token sweep (Task #4492, per side-tab accent audit).
    <div className="perf-kpi" style={{ borderLeftColor: METRIC_COLORS[key] }} data-testid={`perf-kpi-${key}`}>
      <div className="v tnum" style={{ color: METRIC_COLORS[key] }}>
        {value}
        {delta}
      </div>
      <div className="l">{label}</div>
      {vsValue !== null && <div className="vs tnum">vs {vsValue}</div>}
    </div>
  );
  return (
    <div className="perf-kpis">
      {tile("spend", "Spend", money(t.spend),
        cmp && <SpendDelta t={t} cmp={cmp} />, cmp ? moneyWhole(cmp.spend) : null)}
      {tile("leads", "Leads", String(Math.round(t.leads)),
        cmp && <LeadsDelta t={t} cmp={cmp} />, cmp ? fmtLeadsVal(cmp.leads) : null)}
      {tile("cpl", single ? "CPL" : "Blended CPL", formatCpl(t.cpl),
        cmp && <CplDelta t={t} cmp={cmp} />, cmp ? formatCpl(cmp.cpl) : null)}
    </div>
  );
}

function CardHead({ title, sub, t, cmp, right, failed }: {
  title: string; sub?: ReactNode;
  /** Inline range totals (breakdown cards); omit when KPI tiles carry the numbers. */
  t?: RangeTotals;
  /** Comparison-window totals — chips render beside each metric when present. */
  cmp?: RangeTotals | null;
  /** Right-side slot when there are no inline totals (e.g. the comparison window). */
  right?: ReactNode;
  failed?: boolean;
}) {
  return (
    <div className="perf-card-h">
      <span className="perf-card-title">
        {sub}
        {title}
        {failed && (
          <span className="perf-failed" title="This account's data couldn't be loaded — the chart shows zeros, not real spend.">
            data didn’t load
          </span>
        )}
      </span>
      {t ? (
        <span className="perf-totals tnum">
          <span>
            {money(t.spend)}<em>spend</em>
            {cmp && <SpendDelta t={t} cmp={cmp} />}
          </span>
          <span>
            {Math.round(t.leads)}<em>leads</em>
            {cmp && <LeadsDelta t={t} cmp={cmp} />}
          </span>
          <span>
            {formatCpl(t.cpl)}<em>CPL</em>
            {cmp && <CplDelta t={t} cmp={cmp} />}
          </span>
        </span>
      ) : (
        right ?? null
      )}
    </div>
  );
}

export function PerformanceSection({ name }: { name: string }) {
  const [rangeKey, setRangeKey] = useState<RangeKey>("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [tf, setTf] = useState<Timeframe>("daily");
  const [compare, setCompare] = useState<CompareKey>("none");
  const [showAccounts, setShowAccounts] = useState(false); // per-account breakdown collapsed by default
  const [showChannels, setShowChannels] = useState(false); // by-channel breakdown collapsed by default
  const [showIdle, setShowIdle] = useState(false); // reveal accounts hidden as no-activity
  const [data, setData] = useState<ClientPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cmpData, setCmpData] = useState<ClientPerformance | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [cmpLoading, setCmpLoading] = useState(false);
  const [tick, setTick] = useState(0); // bumped by Retry to refetch the same range
  const reqIdRef = useRef(0);
  const cmpReqIdRef = useRef(0);

  const maxDate = ymd(yesterday());

  // The concrete dates the current selection resolves to (null = nothing to fetch yet).
  const dates = useMemo(() => {
    if (rangeKey !== "custom") return presetDates(rangeKey);
    if (!customStart || !customEnd) return null;
    const start = customStart, end = customEnd > maxDate ? maxDate : customEnd;
    if (start > end || spanDays(start, end) > MAX_SPAN_DAYS) return null;
    return { start, end };
  }, [rangeKey, customStart, customEnd, maxDate]);

  const customInvalid =
    rangeKey === "custom" && !!customStart && !!customEnd &&
    (customStart > customEnd
      ? "Start must be before end."
      : spanDays(customStart, customEnd) > MAX_SPAN_DAYS
        ? "Range too long — max ~13 months."
        : null);

  useEffect(() => {
    if (!dates) return;
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    api
      .clientPerformance(name, dates.start, dates.end)
      .then((r) => {
        if (reqIdRef.current !== id) return; // stale response — a newer range is in flight
        setData(r);
        setLoading(false);
      })
      .catch((e) => {
        if (reqIdRef.current !== id) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, dates?.start, dates?.end, tick]);

  // The comparison window the current selection + Compare choice resolve to.
  const cmpDates = useMemo(
    () => (dates && compare !== "none" ? compareDates(rangeKey, dates, compare) : null),
    [dates, compare, rangeKey],
  );

  // Comparison fetch — deliberately separate from the primary one: stale/failed
  // comparison responses only ever touch the chips and the note, never the charts.
  useEffect(() => {
    cmpReqIdRef.current += 1; // invalidate any in-flight comparison response
    setCmpData(null);
    setCmpError(null);
    setCmpLoading(false);
    if (!cmpDates) return;
    const id = cmpReqIdRef.current;
    setCmpLoading(true);
    api
      .clientPerformance(name, cmpDates.start, cmpDates.end)
      .then((r) => {
        if (cmpReqIdRef.current !== id) return;
        setCmpData(r);
        setCmpLoading(false);
      })
      .catch((e) => {
        if (cmpReqIdRef.current !== id) return;
        setCmpError(e instanceof Error ? e.message : String(e));
        setCmpLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, cmpDates?.start, cmpDates?.end, tick]);

  const blended = useMemo(() => (data ? blendedPoints(data.accounts) : []), [data]);

  // Comparison totals, keyed per account by product+customer id. A comparison series
  // whose metrics failed maps to null (its zeros would fake a −100% delta), and the
  // blended comparison is withheld entirely when any comparison account failed.
  const cmpByKey = useMemo(() => {
    if (!cmpData) return null;
    const m = new Map<string, RangeTotals | null>();
    for (const s of cmpData.accounts) {
      m.set(`${s.product}:${s.customer_id}`, s.metrics_failed ? null : totals(s.points));
    }
    return m;
  }, [cmpData]);
  const cmpBlended = useMemo(() => {
    if (!cmpData || cmpData.accounts.some((s) => s.metrics_failed)) return null;
    return totals(blendedPoints(cmpData.accounts));
  }, [cmpData]);

  const gadsCount = data ? data.accounts.filter((s) => s.product === "gads").length : 0;

  // Comparison fetch state, as visibility evidence — only "loaded" may hide (cmpData
  // is nulled the moment the window changes, so a stale payload can't linger here).
  const cmpState: CompareState =
    compare === "none" ? "none" : cmpData ? "loaded" : cmpError ? "failed" : "loading";

  // Per-account visibility (aligned with data.accounts). Activity-based only —
  // ads_status is deliberately not consulted; see accountVisibility.
  const visFlags = useMemo(() => {
    if (!data) return [];
    return accountVisibility(
      data.accounts.map((s) => ({
        current: totals(s.points),
        compare: cmpByKey?.get(`${s.product}:${s.customer_id}`) ?? null,
        metricsFailed: s.metrics_failed,
      })),
      cmpState,
    );
  }, [data, cmpByKey, cmpState]);
  const hiddenIdleCount = visFlags.filter((v) => !v).length;

  // Composition items follow the visibility rule (hidden idle accounts are all-zero,
  // so donut/bar/KPI numbers are identical either way); colors keep the payload index.
  const compItems: CompositionItem[] = useMemo(() => {
    if (!data) return [];
    return data.accounts
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => showIdle || visFlags[i] !== false)
      .map(({ s, i }) => {
        const t = totals(s.points);
        return {
          id: `${s.product}:${s.customer_id}`,
          label: accountShortLabel(s, gadsCount),
          color: colorFor(i),
          spend: t.spend,
          leads: t.leads,
          cpl: t.cpl,
        };
      });
  }, [data, gadsCount, visFlags, showIdle]);

  return (
    <section className="cp-card" id="cp-performance">
      <div className="cp-card-h">
        <h2>Performance</h2>
        <div className="perf-controls">
          {rangeKey === "custom" && (
            <>
              <input
                type="date" className="range-dd perf-date" value={customStart} max={maxDate}
                aria-label="Custom start date"
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <input
                type="date" className="range-dd perf-date" value={customEnd} max={maxDate}
                aria-label="Custom end date"
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </>
          )}
          <select
            className="range-dd" value={rangeKey} aria-label="Date range"
            onChange={(e) => setRangeKey(e.target.value as RangeKey)}
            data-testid="select-perf-range"
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            className="range-dd" value={compare} aria-label="Compare against"
            onChange={(e) => setCompare(e.target.value as CompareKey)}
            data-testid="select-perf-compare"
          >
            {compareOptions(rangeKey, dates).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            className="range-dd" value={tf} aria-label="Timeframe"
            onChange={(e) => setTf(e.target.value as Timeframe)}
            data-testid="select-perf-timeframe"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
      </div>

      {dates && (
        <div className="perf-range-note muted">
          {rangeLabel(dates)}
          {cmpDates && (
            <> · vs {rangeLabel(cmpDates)}{cmpLoading ? " (comparison loading…)" : ""}</>
          )}
          {loading ? " · loading…" : ""}
        </div>
      )}

      {customInvalid && <div className="perf-note muted">{customInvalid}</div>}
      {rangeKey === "custom" && (!customStart || !customEnd) && !customInvalid && (
        <div className="perf-note muted">Pick a start and end date (up to yesterday).</div>
      )}
      {rangeKey === "mtd" && !dates && (
        <div className="perf-note muted">No complete days yet this month — check back tomorrow.</div>
      )}

      {error && (
        <div className="perf-note" role="alert">
          Couldn’t load performance data. Retry.{" "}
          <button className="link" onClick={() => setTick((t) => t + 1)}>Retry</button>
        </div>
      )}

      {cmpError && (
        <div className="perf-note muted" role="alert" data-testid="note-perf-compare-failed">
          Comparison data couldn’t load — showing the current period without
          change figures.{" "}
          <button className="link" onClick={() => setTick((t) => t + 1)}>Retry</button>
        </div>
      )}

      {!data && !error && dates && (
        <div className="perf-note muted" role="status">Loading charts…</div>
      )}

      {data && (
        <div className="perf-cards" style={loading ? { opacity: 0.6 } : undefined}>
          {(() => {
            const multi = data.accounts.length > 1;
            // Comparison totals for one account — null (no chips) while the comparison
            // is off/loading, or when either side of the pair failed to load.
            const cmpFor = (s: PerfSeries): RangeTotals | null =>
              !cmpByKey || s.metrics_failed
                ? null
                : cmpByKey.get(`${s.product}:${s.customer_id}`) ?? null;
            const anyCurFailed = data.accounts.some((s) => s.metrics_failed);
            // Activity-filtered account list (original payload index kept — colors are
            // keyed to it). `shown` drives the table, composition and breakdown cards;
            // blended figures below still sum EVERY account.
            const shown = data.accounts
              .map((s, i) => ({ s, i }))
              .filter(({ i }) => showIdle || visFlags[i] !== false);
            // Channel + battery aggregation (Task #3912) — fed the SAME `shown`
            // inclusion set as the by-account breakdown, so the two breakdowns
            // and the idle reveal always agree (activity-based, never Ads Status).
            const channels = channelBreakdown(
              shown.map(({ s }) => ({ series: s, compare: cmpFor(s) })),
            );
            const chanBattery: BatterySeg[] = channels
              .filter((c) => c.spendShare > 0)
              .map((c) => ({
                id: c.product, label: c.short, color: CHANNEL_COLORS[c.product], pct: c.spendShare,
              }));
            const acctBattery = spendBattery(compItems);
            // The comparison window, as the card corner note ("vs Jun 4 – Jul 3, 2026").
            const vsNote = cmpDates ? (
              <span className="perf-vs-note muted tnum">vs {rangeLabel(cmpDates)}</span>
            ) : null;
            // A single-account client's one card doubles as its Overview: KPI tiles
            // instead of cramped inline head totals. Breakdown cards (inside the
            // collapsible list) keep the compact inline totals.
            const card = (s: PerfSeries, i: number, tiles = false) => (
              <div className="perf-card" key={`${s.product}-${s.customer_id}`}>
                <CardHead
                  title={s.product === "lsa" && s.city ? s.city : s.name}
                  sub={
                    <>
                      {multi && <span className="perf-dot" style={{ background: colorFor(i) }} />}
                      <span className={`cmb-tag ${s.product === "gads" ? "g" : "l"}`}>
                        {s.product === "gads" ? "GAds" : "LSA"}
                      </span>
                      <Chip s={s} />
                    </>
                  }
                  t={tiles ? undefined : totals(s.points)}
                  cmp={cmpFor(s)}
                  right={tiles ? vsNote : undefined}
                  failed={s.metrics_failed}
                />
                {tiles && <KpiTiles t={totals(s.points)} cmp={cmpFor(s)} single />}
                <TrendRow buckets={toBuckets(s.points, tf)} />
              </div>
            );
            return (
              <>
                {/* ── Overview: blended KPI tiles, the composition donuts/bars, the
                     per-account table (the figures the hero used to carry, now
                     range-driven), then the blended trend ── */}
                {multi && (
                  <div className="perf-card perf-overview">
                    <CardHead title="Overview" right={vsNote} />
                    <KpiTiles t={totals(blended)} cmp={anyCurFailed ? null : cmpBlended} />
                    <CompositionRow items={compItems} legend={false} />
                    <div className="perf-subhead">By account · this range</div>
                    {/* Dot column doubles as the composition legend (same colors/order). */}
                    <div className="perf-acct-table tnum" data-testid="perf-account-table">
                      <span className="h">Account</span>
                      <span className="h num">Spend</span>
                      <span className="h num">Leads</span>
                      <span className="h num">CPL</span>
                      {shown.map(({ s, i }) => {
                        const t = totals(s.points);
                        const cmp = cmpFor(s);
                        return (
                          <Fragment key={`${s.product}-${s.customer_id}`}>
                            <span className="who">
                              <span className="perf-dot" style={{ background: colorFor(i) }} />
                              <span className="acct">
                                <span className="nm">
                                  {accountShortLabel(s, gadsCount)}
                                  {/* Sole-GAds rows are already labeled "GAds" — no tag echo. */}
                                  {!accountTagIsEcho(s, gadsCount) && (
                                    <span className={`cmb-tag ${s.product === "gads" ? "g" : "l"}`}>
                                      {s.product === "gads" ? "GAds" : "LSA"}
                                    </span>
                                  )}
                                  <Chip s={s} />
                                  {s.metrics_failed && (
                                    <span className="perf-failed" title="This account's data couldn't be loaded — zeros, not real numbers.">
                                      data didn’t load
                                    </span>
                                  )}
                                </span>
                                <span className="cid tnum">{formatId(s.customer_id)}</span>
                              </span>
                            </span>
                            <span className="cell">
                              {money(t.spend)}
                              {cmp && <SpendDelta t={t} cmp={cmp} />}
                            </span>
                            <span className="cell">
                              {Math.round(t.leads)}
                              {cmp && <LeadsDelta t={t} cmp={cmp} />}
                            </span>
                            <span className="cell">
                              {formatCpl(t.cpl)}
                              {cmp && <CplDelta t={t} cmp={cmp} />}
                            </span>
                          </Fragment>
                        );
                      })}
                    </div>
                    {hiddenIdleCount > 0 && (
                      <div className="perf-note muted" data-testid="note-perf-idle-accounts">
                        {hiddenIdleCount} account{hiddenIdleCount === 1 ? "" : "s"} with no
                        activity in this range
                        {cmpState === "loaded" ? " or the comparison period" : ""} —{" "}
                        <button
                          className="link"
                          onClick={() => setShowIdle((v) => !v)}
                          data-testid="button-perf-idle-toggle"
                        >
                          {showIdle ? "hide" : "show"}
                        </button>
                      </div>
                    )}
                    <div className="perf-subhead">All accounts · trend</div>
                    <TrendRow buckets={toBuckets(blended, tf)} />
                  </div>
                )}

                {/* ── Channel breakdown (Task #3912) — GAds vs all-LSA-combined, only
                     when both channels are present among the included accounts (one
                     channel = nothing to compare). Collapsed: header battery + spend
                     split. Expanded: share split bars, the platform table, and one
                     combined trend row per channel. ── */}
                {multi && channels.length > 1 && (
                  <>
                    <button
                      className="perf-accts-toggle"
                      onClick={() => setShowChannels((v) => !v)}
                      aria-expanded={showChannels}
                      aria-controls="perf-channels"
                      data-testid="button-perf-channels-toggle"
                    >
                      <span className="chevron">{showChannels ? "▾" : "▸"}</span>
                      <span className="perf-accts-label">By channel</span>
                      <Battery segments={chanBattery} />
                      {chanBattery.length > 0 && (
                        <span className="perf-accts-sum tnum">
                          {channels.map((c, ci) => (
                            <Fragment key={c.product}>
                              {ci > 0 && " · "}
                              {c.short} <b>{Math.round(c.spendShare)}%</b>
                            </Fragment>
                          ))}{" "}
                          of spend
                        </span>
                      )}
                      <span className="perf-accts-count">{showChannels ? "Hide" : "Show"}</span>
                    </button>
                    {showChannels && (
                      <div id="perf-channels" className="perf-card" data-testid="perf-channel-block">
                        <div className="perf-subhead first">Share of this range</div>
                        <ChannelSplitRow label="Spend" channels={channels} share={(c) => c.spendShare} />
                        <ChannelSplitRow label="Leads" channels={channels} share={(c) => c.leadsShare} />
                        <div className="perf-subhead">Platform totals</div>
                        <div className="perf-acct-table perf-chan-table tnum" data-testid="perf-channel-table">
                          <span className="h">Platform</span>
                          <span className="h num">Spend</span>
                          <span className="h num">Leads</span>
                          <span className="h num">CPL</span>
                          {channels.map((c) => (
                            <Fragment key={c.product}>
                              <span className="who">
                                <span className="perf-dot" style={{ background: CHANNEL_COLORS[c.product] }} />
                                {c.label}
                                <span className="muted">
                                  · {c.accounts} account{c.accounts === 1 ? "" : "s"}
                                </span>
                                {c.anyFailed && (
                                  <span className="perf-failed" title="An account in this channel couldn't be loaded — its zeros are placeholders, so this channel under-reports and change figures are hidden.">
                                    data didn’t load
                                  </span>
                                )}
                              </span>
                              <span className="cell">
                                {money(c.current.spend)}
                                {c.compare && <SpendDelta t={c.current} cmp={c.compare} />}
                              </span>
                              <span className="cell">
                                {Math.round(c.current.leads)}
                                {c.compare && <LeadsDelta t={c.current} cmp={c.compare} />}
                              </span>
                              <span className="cell">
                                {formatCpl(c.current.cpl)}
                                {c.compare && <CplDelta t={c.current} cmp={c.compare} />}
                              </span>
                            </Fragment>
                          ))}
                        </div>
                        <div className="perf-subhead">Trend per channel</div>
                        {channels.map((c) => (
                          <div className="perf-chan-trend" key={c.product}>
                            <div className="perf-chan-trend-h">
                              <span className="perf-dot" style={{ background: CHANNEL_COLORS[c.product] }} />
                              {c.label}
                              <span className="muted">
                                {c.accounts === 1 ? "1 account" : `${c.accounts} accounts combined`}
                              </span>
                              {c.anyFailed && (
                                <span className="perf-failed" title="An account in this channel couldn't be loaded — the combined line under-reports.">
                                  data didn’t load
                                </span>
                              )}
                            </div>
                            <TrendRow buckets={toBuckets(c.points, tf)} />
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* ── Account breakdown — collapsed by default for multi-account clients
                     (the per-account charts are the bulk of the page); a single-account
                     client has nothing to summarize, so its one card shows inline. ── */}
                {multi ? (
                  <>
                    <button
                      className="perf-accts-toggle"
                      onClick={() => setShowAccounts((v) => !v)}
                      aria-expanded={showAccounts}
                      aria-controls="perf-accts"
                      data-testid="button-perf-accounts-toggle"
                    >
                      <span className="chevron">{showAccounts ? "▾" : "▸"}</span>
                      <span className="perf-accts-label">By account</span>
                      <Battery segments={acctBattery.segments} />
                      <span className="perf-accts-sum tnum">
                        {shown.length} account{shown.length === 1 ? "" : "s"}
                        {acctBattery.top && (
                          <>
                            {" "}· {acctBattery.top.label} drives{" "}
                            <b>{Math.round(acctBattery.top.pct)}%</b> of spend
                          </>
                        )}
                      </span>
                      <span className="perf-accts-count">{showAccounts ? "Hide" : "Show"}</span>
                    </button>
                    {showAccounts && (
                      <div id="perf-accts" className="perf-accts">
                        {shown.map(({ s, i }) => card(s, i))}
                      </div>
                    )}
                  </>
                ) : (
                  data.accounts.map((s, i) => card(s, i, true))
                )}

                <div className="perf-foot muted">
                  The most recent days can under-report leads while conversions finish
                  attributing — a rising CPL at the very end of a chart usually settles down
                  within a week.
                  {compare !== "none" &&
                    " The same caveat applies to a change measured against a comparison period."}
                </div>
              </>
            );
          })()}
        </div>
      )}
    </section>
  );
}
