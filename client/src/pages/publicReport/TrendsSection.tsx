/**
 * TrendsSection — shared pieces of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 655–877 @ d31d7c0c7, Task #4271).
 * Zero visual/behavioral change intended — do not edit alongside a move.
 */

import { TrendingUp } from "lucide-react";
import { clampPercent } from "@shared/missedCallRate";
import { ResponsiveContainer, XAxis, Tooltip, Area, AreaChart } from "recharts";
import { NO_DATA_LABEL } from "./EmptyState";
import { ReportTrendData } from "./types";
import { REPORT_COLORS, REPORT_TICK_FONT_SIZE } from './reportTokens';
import { svgSafeId } from "@/lib/svgSafeId";

// Task #4258 — shared trend x-axis month formatting. Trend datasets can span
// multiple years (e.g. demo fixtures with 2026-02 and 2027-02), and bare
// month names collapse those to duplicate labels ("Feb Feb"), which reads as
// a glitched axis. When the months in a dataset cross a year boundary, every
// tick gets a 2-digit year suffix so labels stay unique and chronological.
export const TREND_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// (exported for the label-uniqueness test in tests/client/)
export function trendSpansMultipleYears(months: Array<string | undefined | null>): boolean {
  // Only well-formed YYYY-MM months count toward the span check; malformed
  // entries must never flip the whole axis into year mode (Task #4265).
  const years = new Set(
    months
      .filter((m): m is string => !!m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m))
      .map(m => m.split('-')[0]),
  );
  return years.size > 1;
}

export function formatTrendMonth(month: string | undefined | null, includeYear: boolean): string {
  const parts = (month || '').split('-');
  const name = TREND_MONTH_NAMES[parseInt(parts[1] || '0') - 1];
  if (!name) return parts[1] || month || '';
  return includeYear ? `${name} '${parts[0].slice(-2)}` : name;
}

// Task #4383 — shared-axis series builder for the Historical Trends module.
// Every chart in a section plots the FULL trend window the server sent as its
// x-axis; a month whose metric wasn't provided keeps a null point (Task #3688
// — never a fake 0) so the plot shows a gap there. Before this, each chart
// filtered its own non-null months and invented a private compressed axis, so
// sibling charts disagreed on month count (4 vs 2 vs 5) and correct data read
// as glitched charts.
// (exported for the hermetic contract test in tests/client/)
export interface TrendChartPoint {
  month: string;
  value: number | null;
}

export interface TrendMetricSeries {
  /** One point per month of the full trend window — the shared x-axis. */
  points: TrendChartPoint[];
  /** How many months carry real (non-null) data for this metric. */
  dataCount: number;
  /**
   * The two most recent months WITH data (chronologically previous, current)
   * for the delta chip; null when fewer than two months have data.
   */
  deltaPair: {
    previous: { month: string; value: number };
    current: { month: string; value: number };
  } | null;
}

export function buildTrendMetricSeries(
  trendData: ReportTrendData[],
  section: 'intake' | 'sales' | 'marketing',
  metric: { key: string; unit?: string },
): TrendMetricSeries {
  // Task #3688 — a null trend point means the metric wasn't provided that
  // month (absent or No-Data-flagged). Keep the month on the shared axis with
  // a null value instead of dropping it or plotting a fake 0.
  const points: TrendChartPoint[] = trendData.map(d => {
    const sectionData = d[section] ?? {};
    const rawValue = (sectionData as any)?.[metric.key];
    if (rawValue === null || rawValue === undefined) return { month: d.month, value: null };
    // Task #2680 sweep — a persisted %-rate (missed-call, lead→consult,
    // consult→case, no-show) must never plot raw, or a legacy absurd value
    // (e.g. 5,300%) still renders in the trend. Clamp every %-unit trend
    // point to 0–100; non-% metrics pass through unchanged.
    const value = metric.unit === '%' ? clampPercent(rawValue) : rawValue;
    return { month: d.month, value };
  });
  const dataPoints = points.filter(
    (p): p is { month: string; value: number } => p.value !== null,
  );
  return {
    points,
    dataCount: dataPoints.length,
    deltaPair:
      dataPoints.length >= 2
        ? {
            previous: dataPoints[dataPoints.length - 2],
            current: dataPoints[dataPoints.length - 1],
          }
        : null,
  };
}

// ── Task #4274 — §8.5 trend-card spec constants ─────────────────────────────
// Single source for the audited data-viz rules so the hermetic contract test
// can lock them: 2.5px stroke, area fill ramp 0.18→0.04, 140px card floor.
export const TREND_STROKE_WIDTH = 2.5;
export const TREND_FILL_TOP_OPACITY = 0.18;
export const TREND_FILL_BOTTOM_OPACITY = 0.04;

// Task #4274 — one value formatter for every text surface of the module
// (endpoint labels, baseline text, unlock card). '$' is a PREFIX unit with
// thousands separators ("$12,000", never "12000$"); every other unit appends.
export function formatTrendValue(value: number, unit: string): string {
  if (unit === '$') return `$${value.toLocaleString('en-US')}`;
  // Task #4287 — time values display as whole seconds ("11s", never
  // "10.99s"): one precision convention for the metric deck-wide; the raw
  // value still drives status/trend math upstream.
  if (unit === 's') return `${Math.round(value)}s`;
  return `${value}${unit}`;
}

// Task #4274 — SVG url(#id) references break on characters like '()' (a
// label such as "Pipeline Momentum (BETA)" produced url(#…(BETA)) — an
// invalid paint that rendered the area as a SOLID BLACK rectangle). Gradient
// ids therefore strip to alphanumerics; testids keep the readable slug.
// Task #4430 hoisted the sanitizer to the shared svgSafeId helper so every
// dynamic gradient id goes through one rule.
export function trendGradientId(variant: 'light' | 'dark', label: string): string {
  return `gradient-${variant}-${svgSafeId(label)}`;
}

// Task #4274 — §8.5 "first+last point value labels": only the FIRST and LAST
// months that carry data get an in-chart value label; null gap months and
// interior points never do. Pure + exported for the hermetic test.
export function trendEndpointLabelText(
  index: number | undefined,
  value: number | null | undefined,
  firstDataIdx: number,
  lastDataIdx: number,
  unit: string,
): string | null {
  if (index === undefined || value === null || value === undefined) return null;
  if (index !== firstDataIdx && index !== lastDataIdx) return null;
  return formatTrendValue(value, unit);
}

// Mini trend chart component for displaying metric trends over time
export function TrendMiniChart({ 
  series, 
  label, 
  unit = '',
  color = REPORT_COLORS.crimson,
  height = 80,
  showAxis = true,
  lowerIsBetter = false,
  variant = 'light',
}: { 
  // Task #4383 — the full-window series from buildTrendMetricSeries: nullable
  // points share one month axis across every chart in the section; the area
  // breaks at null months and dots render only on real points.
  series: TrendMetricSeries;
  label: string;
  unit?: string;
  color?: string;
  height?: number;
  showAxis?: boolean;
  lowerIsBetter?: boolean;
  // Task #4226 — the trends module mounts on both light (cream) and dark
  // (charcoal) slides; the dark variant swaps card/header/tick tokens so the
  // charts stay legible instead of reading as blank gray tiles.
  variant?: 'light' | 'dark';
}) {
  const { points, dataCount, deltaPair } = series;
  if (points.length < 1) return null;

  const isDark = variant === 'dark';
  // Task #4274 — §8.5: every trend-card state holds the 140px floor.
  const cardClass = isDark
    ? "bg-report-charcoal-card rounded-lg p-4 border border-white/10 min-h-[140px]"
    : "bg-white/80 rounded-lg p-4 border border-report-crimson/10 min-h-[140px]";
  const headerClass = isDark
    ? "text-[11px] uppercase tracking-wider font-bold text-white/70"
    : "text-[11px] uppercase tracking-wider font-bold text-report-ink-muted";
  const strokeColor = isDark ? REPORT_COLORS.gold : color;
  const tickFill = isDark ? REPORT_COLORS.inkInverseMuted : REPORT_COLORS.inkMuted;
  const labelSlug = label.replace(/\s/g, '');
  
  // Task #4258 — year-aware labels via the shared formatTrendMonth helper so
  // multi-year datasets don't collapse to duplicate ticks ("Feb Feb").
  // Task #4383 — derived from the FULL shared window (not this metric's data
  // months), so tick labels agree across every chart in the section.
  const includeYear = trendSpansMultipleYears(points.map(d => d.month));
  const chartData = points.map(d => ({
    month: formatTrendMonth(d.month, includeYear),
    value: d.value,
  }));

  // Task #4226 — with fewer than 2 months of real data there is no trend to
  // draw: a lone dot on an empty grid (plus a delta chip with no visible
  // baseline) reads as a broken chart. Show an explicit "unlocks next month"
  // state — keyed to the data-month count, never the axis length (#4383).
  if (dataCount < 2 || !deltaPair) {
    const single = points.find(p => p.value !== null);
    return (
      <div className={`${cardClass} flex flex-col items-center justify-center text-center`} data-testid={`trend-unlock-${labelSlug}`}>
        <span className={`${headerClass} mb-2`}>{label} Trend</span>
        <span className={`text-xs font-semibold ${isDark ? 'text-report-gold' : 'text-report-crimson'}`}>
          {single && single.value !== null ? `${formatTrendValue(single.value, unit)} in ${formatTrendMonth(single.month, includeYear)}` : 'Trends unlock with next month\'s report'}
        </span>
        {single && (
          <span className={`text-[11px] mt-1 ${isDark ? 'text-white/50' : 'text-report-ink-muted'}`}>Trends unlock with next month's report</span>
        )}
      </div>
    );
  }
  
  // Task #4383 — the delta chip compares the two most recent months that
  // HAVE data (a metric whose latest window months are gaps still gets an
  // honest chip), never adjacent axis slots.
  const currentValue = deltaPair.current.value;
  const prevValue = deltaPair.previous.value;
  const delta = currentValue - prevValue;
  const deltaPercent = prevValue ? Math.round((delta / prevValue) * 100) : 0;
  
  // Determine if the change is positive (green) or negative (red)
  // For lowerIsBetter metrics (like no-show rate), a decrease is good.
  // Dark cards take the *-bright accents: the light-surface status inks
  // fall below AA on charcoal (report token layer rule, Task #4272).
  const isPositiveChange = lowerIsBetter ? delta < 0 : delta > 0;
  const chipClass = isPositiveChange
    ? (isDark ? 'bg-report-healthy/20 text-report-healthy-bright' : 'bg-report-healthy/10 text-report-healthy')
    : (isDark ? 'bg-report-critical/20 text-report-crimson-bright' : 'bg-report-critical/10 text-report-critical');
  const prevMonthLabel = formatTrendMonth(deltaPair.previous.month, includeYear);

  // Task #4274 — §8.5 "first+last point value labels": indexes of the first
  // and last months WITH data (never null gap slots) on the shared axis.
  const dataIdxs = points.reduce<number[]>((acc, p, i) => (p.value !== null ? [...acc, i] : acc), []);
  const firstDataIdx = dataIdxs[0];
  const lastDataIdx = dataIdxs[dataIdxs.length - 1];
  const valueLabelFill = isDark ? REPORT_COLORS.inkInverse : REPORT_COLORS.ink;
  const renderEndpointLabel = (props: { x?: number; y?: number; value?: number | null; index?: number }) => {
    const { x, y, value, index } = props ?? {};
    const text = trendEndpointLabelText(index, value, firstDataIdx, lastDataIdx, unit);
    if (text === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Edge points hug the plot bounds: anchor outward-safe so labels never
    // clip at the left/right edge of the mini chart's svg.
    const textAnchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
    return (
      <text
        x={x}
        y={(y as number) - 8}
        textAnchor={textAnchor}
        fontSize={REPORT_TICK_FONT_SIZE}
        fontWeight={700}
        fill={valueLabelFill}
      >
        {text}
      </text>
    );
  };

  return (
    <div className={`${cardClass} flex flex-col`}>
      <div className="flex items-center mb-1">
        <span className={headerClass}>{label} Trend</span>
      </div>
      {/* Task #4274 — the chart flexes to absorb the 140px card floor (and any
          extra height from equal-height grid rows) instead of pooling dead
          space under a fixed-height plot; `height` is now the plot's minimum. */}
      <div className="flex-1" style={{ minHeight: height }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* top margin leaves headroom for endpoint value labels above dots */}
          <AreaChart data={chartData} margin={{ top: 18, right: 5, left: 0, bottom: showAxis ? 15 : 5 }}>
            <defs>
              <linearGradient id={trendGradientId(variant, label)} x1="0" y1="0" x2="0" y2="1">
                {/* Task #4274 — §8.5 area fill ramp, both variants */}
                <stop offset="5%" stopColor={strokeColor} stopOpacity={TREND_FILL_TOP_OPACITY}/>
                <stop offset="95%" stopColor={strokeColor} stopOpacity={TREND_FILL_BOTTOM_OPACITY}/>
              </linearGradient>
            </defs>
            {showAxis && <XAxis dataKey="month" tick={{ fontSize: REPORT_TICK_FONT_SIZE, fill: tickFill }} axisLine={false} tickLine={false} />}
            <Area 
              type="monotone" 
              dataKey="value" 
              // Task #4383 — a null month renders as a gap: the area breaks
              // instead of bridging (or zero-flooring) missing months, and
              // recharts skips dots on null points.
              connectNulls={false}
              stroke={strokeColor} 
              strokeWidth={TREND_STROKE_WIDTH}
              // §8.5: the gradient stops are the SINGLE opacity source for the
              // fill ramp — path-level fillOpacity stays 1 so the rendered ramp
              // is literally 0.18→0.04 (recharts' default would multiply it).
              fillOpacity={1}
              fill={`url(#${trendGradientId(variant, label)})`}
              dot={{ r: 3, fill: strokeColor }}
              label={renderEndpointLabel}
              isAnimationActive={false}
            />
            <Tooltip 
              formatter={(value: number) => [formatTrendValue(value, unit), label]}
              labelFormatter={(label) => `${label}`}
              contentStyle={{ fontSize: REPORT_TICK_FONT_SIZE, borderRadius: 8, backgroundColor: REPORT_COLORS.charcoalCard, border: '1px solid rgba(255,255,255,0.1)', color: REPORT_COLORS.white }}
              labelStyle={{ color: REPORT_COLORS.white }}
              itemStyle={{ color: REPORT_COLORS.white }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* Task #4274 — §8.5: the delta chip is anchored to the chart endpoint
          (right-aligned directly under the last point's column) and always
          carries explicit visible baseline text ("46.3% vs 32.3% in Jan") —
          never a bare "↑ 100%" over the plot. The chip itself still renders
          only when there IS a change (Task #4226 kept delta-0 chips out). */}
      <div className="flex items-center justify-end gap-2 mt-1" data-testid={`trend-endpoint-${labelSlug}`}>
        <span className={`text-[11px] font-semibold ${isDark ? 'text-report-ink-inverse-muted' : 'text-report-ink-muted'}`}>
          {`${formatTrendValue(currentValue, unit)} vs ${formatTrendValue(prevValue, unit)} in ${prevMonthLabel}`}
        </span>
        {delta !== 0 && (
          <span className={`text-[11px] font-bold px-2 py-1 rounded ${chipClass}`}>
            {delta > 0 ? '↑' : '↓'} {Math.abs(deltaPercent)}%
          </span>
        )}
      </div>
    </div>
  );
}

// Trends section component for Intake/Sales slides
// (exported for the hermetic render test in tests/client/)
export function TrendsSection({ 
  trendData, 
  section, 
  metrics,
  variant = 'light',
}: { 
  trendData: ReportTrendData[] | null; 
  section: 'intake' | 'sales' | 'marketing';
  metrics: Array<{ key: string; label: string; unit?: string; lowerIsBetter?: boolean }>;
  // Task #4226 — pass 'dark' when the section mounts on a charcoal slide so
  // the header/cards use dark-variant tokens (the light module on charcoal
  // rendered a 1.17:1 header and near-invisible cards on desktop).
  variant?: 'light' | 'dark';
}) {
  if (!trendData || trendData.length < 1) return null;
  const isDark = variant === 'dark';
  
  return (
    <div className={`mt-6 pt-6 border-t ${isDark ? 'border-white/10' : 'border-report-crimson/10'} historical-trends-section`}>
      <div className="flex items-center gap-2 mb-4 historical-trends-header">
        <TrendingUp className={`w-4 h-4 ${isDark ? 'text-report-gold' : 'text-report-crimson'}`} />
        <span className={`text-xs uppercase tracking-wider font-bold ${isDark ? 'text-white/70' : 'text-report-ink-muted'}`}>Historical Trends (Up to 12 Months)</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 historical-trends-grid">
        {metrics.map(metric => {
          // Task #4383 — every chart in the section shares ONE month axis:
          // the full trend window the server sent. The builder keeps null
          // points for not-provided months (Task #3688 — gaps, never fake
          // 0s) and counts the months that DO have data for classification.
          const series = buildTrendMetricSeries(trendData, section, metric);
          // Task #4226 review — a stored zero is a real measurement (matching
          // the wider report semantics where only null means "not provided"),
          // so any non-null point counts as data; "No data" is reserved for
          // metrics with no usable points at all.
          if (series.dataCount === 0) {
            return (
              // Task #4274 — §8.5: explicit-absence card holds the same 140px floor.
              <div key={metric.key} className={`rounded-lg border p-4 flex flex-col items-center justify-center min-h-[140px] ${isDark ? 'bg-report-charcoal-card border-white/10' : 'bg-white border-report-ink/10'}`}>
                <span className={`text-[11px] font-medium mb-2 ${isDark ? 'text-white/60' : 'text-report-ink-muted'}`}>{metric.label}</span>
                <span className={`text-sm font-bold ${isDark ? 'text-report-crimson-bright' : 'text-report-critical'}`}>{NO_DATA_LABEL}</span>
              </div>
            );
          }
          return (
            <TrendMiniChart
              key={metric.key}
              series={series}
              label={metric.label}
              unit={metric.unit || ''}
              color={REPORT_COLORS.crimson}
              lowerIsBetter={metric.lowerIsBetter}
              variant={variant}
            />
          );
        })}
      </div>
    </div>
  );
}

export function LeadQualityBar({ label, good, total }: { label: string; good: number; total: number }) {
  const pct = total > 0 ? Math.round((good / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="font-medium">{label}</span>
        <span className="text-report-crimson font-bold">{pct}%</span>
      </div>
      <div className="h-2 bg-report-cream-deep rounded overflow-hidden">
        <div className="h-full bg-report-healthy rounded" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
