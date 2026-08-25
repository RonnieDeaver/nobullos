import {
  Bar, BarChart, XAxis, YAxis, ResponsiveContainer, LabelList, Cell,
  PieChart, Pie,
  LineChart, Line,
  AreaChart, Area,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ScatterChart, Scatter, CartesianGrid, Tooltip, ZAxis,
} from "recharts";
import { Fragment } from "react";
import FunnelChart from "./FunnelChart";
import {
  PULSE_CRIMSON, PULSE_NEUTRAL, PULSE_TARGET, PULSE_GRID,
  PULSE_INK, PULSE_INK_FAINT, PULSE_LABEL_MUTED, PULSE_WHITE,
  PULSE_POSITIVE, PULSE_DEFAULT_COLORS,
} from "../lib/ceoPulsePalette";

export type ChartDataItem = {
  label: string;
  value: number;
  previousValue?: number;
  color?: string;
  group?: string;
};

export type LegendItem = {
  label: string;
  color: string;
};

export type FunnelStage = {
  label: string;
  value: number;
  color?: string;
};

export type FunnelGroup = {
  label: string;
  colorScheme?: "light" | "dark";
  stages: FunnelStage[];
};

export type FunnelAnnotation = {
  afterStage: number;
  text: string;
};

export type SeriesItem = {
  name: string;
  color?: string;
  dataKey: string;
};

export type CeoPulseChart = {
  type: string;
  title: string;
  description?: string;
  subtitle?: string;
  data?: ChartDataItem[];
  legend?: LegendItem[];
  valueSuffix?: string;
  groups?: FunnelGroup[];
  annotations?: FunnelAnnotation[];
  series?: SeriesItem[];
  target?: number;
};

type CeoPulseChartRendererProps = {
  charts: CeoPulseChart[];
  compact?: boolean;
  /** Gates ALL motion: the framer funnel entrance AND recharts entry
   *  animations (Task #4286, audit #28 — the public report passes false so
   *  its mini-chart grid renders settled; internal previews keep the
   *  default). */
  animate?: boolean;
  /** Task #4414 — report brand palette override; omit for the stock OS colors. */
  palette?: CeoPulseChartPalette;
};

const DEFAULT_COLORS = PULSE_DEFAULT_COLORS;

// Task #4414 — optional palette override so the public client report can
// render these shared charts in its `--report-*` brand palette without
// leaking report branding into the internal OS surface (which passes no
// palette and keeps the stock colors above). recharts/SVG presentation
// attributes cannot resolve var(), so the report passes literal hexes from
// client/src/pages/publicReport/reportTokens.ts — components/ must not
// import from pages/, hence a prop rather than an import.
export type CeoPulseChartPalette = {
  /** Cycled series fills replacing DEFAULT_COLORS (every entry must hold AA under white segment labels). */
  series: readonly string[];
  /** Default single-series accent (bars/lines/radar/gauge/scatter). */
  primary: string;
  /** "Previous period" neutral series. */
  neutral: string;
  /** Target/threshold line. */
  target: string;
  /** Chart grid lines / gauge track. */
  grid: string;
  /** Chart text — axis ticks and value labels. */
  ink: string;
  /** Faint captions (gauge sublabel, radial axis). */
  inkFaint: string;
  /** Value labels rendered ON dark series fills (stacked-bar segments). */
  valueOnDark: string;
  /** Positive / negative delta text (metric cards). */
  positiveText: string;
  negativeText: string;
  /** Funnel stage ramp, light→dark; stage i takes min(i, last) so ramps stay
   *  monotonic. In report mode this REPLACES both funnel color schemes AND
   *  any AI-supplied per-stage colors (deterministic, no stock leakage);
   *  every entry must hold AA under the white stage labels. */
  funnelStages: readonly string[];
};

type PaletteCtx = CeoPulseChartPalette & {
  isReport: boolean;
  /**
   * Resolve an explicit (possibly AI-emitted stock) color: default mode
   * passes it through (falling back to the series cycle); report mode
   * remaps every distinct explicit hex deterministically onto the report
   * series — first-seen order — so stock SaaS hexes never reach the report
   * surface while legend swatches and data fills stay consistent.
   */
  resolve: (explicit: string | undefined, index: number) => string;
};

function makePaletteCtx(palette?: CeoPulseChartPalette): PaletteCtx {
  if (!palette) {
    return {
      isReport: false,
      series: DEFAULT_COLORS,
      primary: PULSE_CRIMSON,
      neutral: PULSE_NEUTRAL,
      target: PULSE_TARGET,
      grid: PULSE_GRID,
      ink: PULSE_INK,
      inkFaint: PULSE_INK_FAINT,
      valueOnDark: PULSE_WHITE,
      positiveText: PULSE_POSITIVE,
      negativeText: PULSE_TARGET,
      funnelStages: [], // unused in stock mode — FunnelChart keeps its own schemes
      resolve: (explicit, index) => explicit || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    };
  }
  const assigned = new Map<string, string>();
  return {
    isReport: true,
    ...palette,
    resolve: (explicit, index) => {
      if (!explicit) return palette.series[index % palette.series.length];
      const key = explicit.toLowerCase();
      if (!assigned.has(key)) assigned.set(key, palette.series[assigned.size % palette.series.length]);
      return assigned.get(key)!;
    },
  };
}

// Report-vs-stock class pairs for DOM (non-SVG) text/fields. The report
// classes resolve against the `.report-surface` token layer.
// Stock classes use the brief-ink-soft token (--color-brief-ink-soft = #333333)
// so no raw hex literal appears in this file.
const inkCls = (ctx: PaletteCtx) => (ctx.isReport ? 'text-report-ink' : 'text-brief-ink-soft');
const inkMutedCls = (ctx: PaletteCtx) => (ctx.isReport ? 'text-report-ink-muted' : 'text-brief-ink-soft/60');
const inkSoftCls = (ctx: PaletteCtx) => (ctx.isReport ? 'text-report-ink-muted' : 'text-brief-ink-soft/70');
const inkFaintCls = (ctx: PaletteCtx) => (ctx.isReport ? 'text-report-ink-muted' : 'text-brief-ink-soft/50');
const mutedCardCls = (ctx: PaletteCtx) =>
  ctx.isReport ? 'bg-report-paper-bright border-report-cream-deep' : 'bg-muted/50 border-border';

// Task #4276 (§8.3/§8.5 client-report design audit) — legibility floors for
// every text element the charts draw. The 8–10px tick/label sizes are
// retired: axis ticks and value labels render at ≥11px on every surface
// (report slide, /pulse share page, Studio preview). Mirrors
// reportTokens.REPORT_TICK_FONT_SIZE — kept as local literals because
// components/ must not import from pages/.
const TICK_FONT_SIZE = 11;
const VALUE_LABEL_FONT_SIZE = 11;
const valueLabelStyle = (ink: string) => ({ fontSize: VALUE_LABEL_FONT_SIZE, fontWeight: 600, fill: ink } as const);
// Horizontal-bar category axis width: room for ~25-char labels at 11px so
// category names stop truncating mid-word (§8.7-3).
const yAxisCategoryWidth = (compact: boolean) => (compact ? 110 : 140);

// Task #4276 (§8.5) — trend charts label their first and last points (the
// §8.5 trend prescription) instead of shipping unlabeled lines; interior
// points stay uncluttered and readable via the tooltip.
const endpointValueLabel = (count: number, suffix: string, ink: string) => (props: any) => {
  const { x, y, value, index } = props;
  if (value == null || index == null || (index !== 0 && index !== count - 1)) return null;
  return (
    <text
      x={x}
      y={(y ?? 0) - 9}
      textAnchor={index === 0 ? 'start' : 'end'}
      fontSize={VALUE_LABEL_FONT_SIZE}
      fontWeight={600}
      fill={ink}
    >
      {`${value}${suffix}`}
    </text>
  );
};

// Task #4276 (§8.5) — per-segment value labels for horizontal stacked bars;
// segments too narrow to fit a legible label stay clean (value lives in the
// tooltip) instead of overlapping their neighbors.
const stackSegmentLabel = (suffix: string, fill: string) => (props: any) => {
  const { x, y, width, height, value } = props;
  if (value == null || width == null || width < 34) return null;
  return (
    <text
      x={x + width / 2}
      y={y + height / 2}
      dy={4}
      textAnchor="middle"
      fontSize={VALUE_LABEL_FONT_SIZE}
      fontWeight={600}
      fill={fill}
    >
      {`${value}${suffix}`}
    </text>
  );
};

// Task #4226 — CEO Pulse "By the Numbers" charts shipped axes with no bars on
// a real finalized report because the AI emits series[].dataKey values that
// don't exist as keys in chart.data rows (every point then coerces to 0). A
// series is "usable" only if at least one data row carries a non-null value
// under its dataKey. Duplicate dataKeys (same AI-mismatch family) also caused
// the React duplicate-key warning — usable series are de-duplicated by dataKey
// so element keys stay unique.
export function getUsableSeries(chart: CeoPulseChart): SeriesItem[] {
  if (!chart.series || chart.series.length === 0 || !chart.data || chart.data.length === 0) return [];
  const rows = chart.data.filter(Boolean) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  return chart.series.filter((s) => {
    if (!s || !s.dataKey || seen.has(s.dataKey)) return false;
    const usable = rows.some((row) => row[s.dataKey] !== null && row[s.dataKey] !== undefined);
    if (usable) seen.add(s.dataKey);
    return usable;
  });
}

// Explicit "chart unavailable" state — rendered (with the chart's title intact)
// whenever series dataKeys don't match the data, instead of empty axes.
function ChartUnavailable({ chart, chartIndex, compact, ctx }: { chart: CeoPulseChart; chartIndex: number; compact: boolean; ctx: PaletteCtx }) {
  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <div
        className={`${mutedCardCls(ctx)} border py-6 px-4 text-center`}
        data-testid={`chart-unavailable-${chartIndex}`}
      >
        <p className={`text-xs font-medium ${inkMutedCls(ctx)}`}>Chart unavailable</p>
        <p className={`text-[11px] mt-0.5 ${ctx.isReport ? 'text-report-ink-muted' : 'text-brief-ink-soft/60'}`}>This chart's data could not be displayed.</p>
      </div>
    </ChartWrapper>
  );
}

function ChartWrapper({ chart, chartIndex, compact, ctx, children }: { chart: CeoPulseChart; chartIndex: number; compact: boolean; ctx: PaletteCtx; children: React.ReactNode }) {
  return (
    <div key={chartIndex} className={`${compact ? 'pb-3' : 'pb-4'} border-b ${ctx.isReport ? 'border-report-crimson/10' : 'border-brief-crimson/10'} last:border-b-0 last:pb-0`} data-testid={`chart-${chart.type}-${chartIndex}`}>
      <h4 className={`text-sm font-semibold mb-0.5 ${inkCls(ctx)}`}>{chart.title}</h4>
      {chart.description && (
        <p className={`text-xs ${inkMutedCls(ctx)} ${compact ? 'mb-2' : 'mb-3'}`}>{chart.description}</p>
      )}
      {children}
      {chart.subtitle && (
        // §8.5 — source/context micro-lines render at ≥11px.
        <p className={`text-[11px] ${inkFaintCls(ctx)} text-center mt-1 italic`}>{chart.subtitle}</p>
      )}
      <ChartLegend chart={chart} compact={compact} ctx={ctx} />
    </div>
  );
}

function ChartLegend({ chart, compact, ctx }: { chart: CeoPulseChart; compact: boolean; ctx: PaletteCtx }) {
  if (!chart.legend || chart.legend.length === 0) return null;
  return (
    <div className={`flex items-center flex-wrap ${compact ? 'gap-3' : 'gap-4'} justify-center text-xs ${compact ? 'mt-1' : 'mt-2'}`}>
      {chart.legend.map((item, idx) => (
        <div key={idx} className="flex items-center gap-1.5">
          <div className={`${compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} rounded`} style={{ backgroundColor: ctx.resolve(item.color, idx) }} />
          <span className={inkSoftCls(ctx)}>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function renderFunnel(chart: CeoPulseChart, chartIndex: number, compact: boolean, animate: boolean, ctx: PaletteCtx) {
  if (!chart.groups || chart.groups.length === 0) return null;
  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <FunnelChart groups={chart.groups} annotations={chart.annotations} subtitle={chart.subtitle} animate={animate} variant={ctx.isReport ? 'report' : undefined} reportStageColors={ctx.isReport ? ctx.funnelStages : undefined} />
    </ChartWrapper>
  );
}

function renderPie(chart: CeoPulseChart, chartIndex: number, compact: boolean, isDoughnut: boolean, animate: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0) return null;
  const pieData = chart.data.filter(Boolean).map((item, i) => ({
    name: item.label,
    value: item.value,
    fill: ctx.resolve(item.color, i),
  }));
  const height = compact ? 220 : 260;
  const outerRadius = compact ? 50 : 60;
  const innerRadius = isDoughnut ? (compact ? 30 : 35) : 0;

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart margin={{ top: 20, right: 40, bottom: 20, left: 40 }} style={{ overflow: 'visible' }}>
          <Pie
            data={pieData}
            isAnimationActive={animate}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={outerRadius}
            innerRadius={innerRadius}
            label={({ name, value }: any) => compact ? `${value}${chart.valueSuffix ?? '%'}` : `${name}: ${value}${chart.valueSuffix ?? '%'}`}
            labelLine={true}
            fontSize={TICK_FONT_SIZE}
          >
            {pieData.map((entry, idx) => (
              <Cell key={idx} fill={entry.fill} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function renderLine(chart: CeoPulseChart, chartIndex: number, compact: boolean, isArea: boolean, animate: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0) return null;

  const series = chart.series;
  const hasSeries = series && series.length > 0;
  const height = compact ? 160 : 200;
  const fontSize = TICK_FONT_SIZE;

  if (hasSeries) {
    const lineData = chart.data.filter(Boolean).map((item: any) => {
      const point: any = { label: item.label };
      for (const s of series!) {
        point[s.dataKey] = item[s.dataKey] ?? item.value ?? 0;
      }
      return point;
    });

    const ChartComponent = isArea ? AreaChart : LineChart;

    return (
      <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
        <ResponsiveContainer width="100%" height={height}>
          <ChartComponent data={lineData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={ctx.grid} />
            <XAxis dataKey="label" tick={{ fontSize, fill: ctx.ink }} />
            <YAxis tick={{ fontSize, fill: ctx.ink }} tickFormatter={(v) => `${v}${chart.valueSuffix ?? ''}`} />
            <Tooltip formatter={(value: any) => `${value}${chart.valueSuffix ?? ''}`} />
            {series!.map((s, i) => {
              const color = ctx.resolve(s.color, i);
              return isArea ? (
                <Area key={`${s.dataKey}-${i}`} type="monotone" isAnimationActive={animate} dataKey={s.dataKey} name={s.name} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} dot={{ r: compact ? 2 : 3 }}>
                  <LabelList dataKey={s.dataKey} content={endpointValueLabel(lineData.length, chart.valueSuffix ?? '', ctx.ink)} />
                </Area>
              ) : (
                <Line key={`${s.dataKey}-${i}`} type="monotone" isAnimationActive={animate} dataKey={s.dataKey} name={s.name} stroke={color} strokeWidth={2} dot={{ r: compact ? 2 : 3, fill: color }}>
                  <LabelList dataKey={s.dataKey} content={endpointValueLabel(lineData.length, chart.valueSuffix ?? '', ctx.ink)} />
                </Line>
              );
            })}
            {chart.target != null && (
              <Line type="monotone" isAnimationActive={animate} dataKey={() => chart.target} stroke={ctx.target} strokeDasharray="6 3" strokeWidth={1.5} dot={false} name="Target" />
            )}
          </ChartComponent>
        </ResponsiveContainer>
      </ChartWrapper>
    );
  }

  const lineData = chart.data.filter(Boolean).map((item) => ({
    label: item.label,
    value: item.value,
    previous: item.previousValue,
  }));

  const ChartComponent = isArea ? AreaChart : LineChart;

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <ResponsiveContainer width="100%" height={height}>
        <ChartComponent data={lineData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={ctx.grid} />
          <XAxis dataKey="label" tick={{ fontSize, fill: ctx.ink }} />
          <YAxis tick={{ fontSize, fill: ctx.ink }} tickFormatter={(v) => `${v}${chart.valueSuffix ?? ''}`} />
          <Tooltip formatter={(value: any) => `${value}${chart.valueSuffix ?? ''}`} />
          {lineData.some(d => d.previous != null) && (
            isArea ? (
              <Area type="monotone" isAnimationActive={animate} dataKey="previous" name="Previous" stroke={ctx.neutral} fill={ctx.neutral} fillOpacity={0.1} strokeWidth={1.5} strokeDasharray="4 3" dot={{ r: 2 }} />
            ) : (
              <Line type="monotone" isAnimationActive={animate} dataKey="previous" name="Previous" stroke={ctx.neutral} strokeWidth={1.5} strokeDasharray="4 3" dot={{ r: 2, fill: ctx.neutral }} />
            )
          )}
          {isArea ? (
            <Area type="monotone" isAnimationActive={animate} dataKey="value" name="Current" stroke={ctx.primary} fill={ctx.primary} fillOpacity={0.15} strokeWidth={2} dot={{ r: compact ? 2 : 3 }}>
              <LabelList dataKey="value" content={endpointValueLabel(lineData.length, chart.valueSuffix ?? '', ctx.ink)} />
            </Area>
          ) : (
            <Line type="monotone" isAnimationActive={animate} dataKey="value" name="Current" stroke={ctx.primary} strokeWidth={2} dot={{ r: compact ? 2 : 3, fill: ctx.primary }}>
              <LabelList dataKey="value" content={endpointValueLabel(lineData.length, chart.valueSuffix ?? '', ctx.ink)} />
            </Line>
          )}
          {chart.target != null && (
            <Line type="monotone" isAnimationActive={animate} dataKey={() => chart.target} stroke={ctx.target} strokeDasharray="6 3" strokeWidth={1.5} dot={false} name="Target" />
          )}
        </ChartComponent>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function renderStackedBar(chart: CeoPulseChart, chartIndex: number, compact: boolean, animate: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0 || !chart.series || chart.series.length === 0) return null;

  // Task #4226 — render only series whose dataKey actually exists in the data;
  // a full mismatch shows an explicit unavailable state, never empty axes.
  const usableSeries = getUsableSeries(chart);
  if (usableSeries.length === 0) {
    return <ChartUnavailable chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx} />;
  }

  const barSize = compact ? 16 : 20;
  const fontSize = TICK_FONT_SIZE;

  const stackData = chart.data.filter(Boolean).map((item: any) => {
    const point: any = { label: item.label };
    for (const s of usableSeries) {
      point[s.dataKey] = item[s.dataKey] ?? 0;
    }
    return point;
  });

  // Task #4276 (§8.5) — stacked bars render HORIZONTALLY (category axis on
  // the left, like every other bar on this surface) with per-segment value
  // labels; height scales with the row count.
  const height = Math.max(compact ? 110 : 140, stackData.length * (compact ? 40 : 52));

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={stackData} layout="vertical" margin={{ top: 5, right: compact ? 40 : 45, left: compact ? 2 : 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={ctx.grid} horizontal={false} />
          <XAxis type="number" tick={{ fontSize, fill: ctx.ink }} tickFormatter={(v) => `${v}${chart.valueSuffix ?? ''}`} />
          <YAxis type="category" dataKey="label" tick={{ fontSize, fill: ctx.ink }} width={yAxisCategoryWidth(compact)} />
          <Tooltip formatter={(value: any) => `${value}${chart.valueSuffix ?? ''}`} />
          {usableSeries.map((s, i) => (
            <Bar key={`${s.dataKey}-${i}`} isAnimationActive={animate} dataKey={s.dataKey} name={s.name} stackId="stack" fill={ctx.resolve(s.color, i)} barSize={barSize}>
              <LabelList dataKey={s.dataKey} content={stackSegmentLabel(chart.valueSuffix ?? '', ctx.valueOnDark)} />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function renderGroupedBar(chart: CeoPulseChart, chartIndex: number, compact: boolean, animate: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0 || !chart.series || chart.series.length === 0) return null;

  // Task #4226 — same dataKey validation as renderStackedBar (see above).
  const usableSeries = getUsableSeries(chart);
  if (usableSeries.length === 0) {
    return <ChartUnavailable chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx} />;
  }

  const barSize = compact ? 12 : 14;
  const fontSize = TICK_FONT_SIZE;

  const groupData = chart.data.filter(Boolean).map((item: any) => {
    const point: any = { label: item.label };
    for (const s of usableSeries) {
      point[s.dataKey] = item[s.dataKey] ?? 0;
    }
    return point;
  });

  // Task #4276 (§8.5) — grouped bars render HORIZONTALLY with a value label
  // at the end of every bar; height scales with rows × series.
  const height = Math.max(
    compact ? 110 : 140,
    groupData.length * (usableSeries.length * (barSize + 6) + (compact ? 16 : 22)),
  );

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={groupData} layout="vertical" margin={{ top: 5, right: compact ? 40 : 45, left: compact ? 2 : 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={ctx.grid} horizontal={false} />
          <XAxis type="number" tick={{ fontSize, fill: ctx.ink }} tickFormatter={(v) => `${v}${chart.valueSuffix ?? ''}`} />
          <YAxis type="category" dataKey="label" tick={{ fontSize, fill: ctx.ink }} width={yAxisCategoryWidth(compact)} />
          <Tooltip formatter={(value: any) => `${value}${chart.valueSuffix ?? ''}`} />
          {usableSeries.map((s, i) => (
            <Bar key={`${s.dataKey}-${i}`} isAnimationActive={animate} dataKey={s.dataKey} name={s.name} fill={ctx.resolve(s.color, i)} barSize={barSize} radius={[0, 4, 4, 0]}>
              <LabelList dataKey={s.dataKey} position="right" formatter={(v: number) => `${v}${chart.valueSuffix ?? ''}`} style={valueLabelStyle(ctx.ink)} />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function renderRadar(chart: CeoPulseChart, chartIndex: number, compact: boolean, animate: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0) return null;
  const height = compact ? 180 : 220;
  const outerRadius = compact ? 60 : 80;

  const radarData = chart.data.filter(Boolean).map((item) => ({
    subject: item.label,
    value: item.value,
    previous: item.previousValue,
  }));

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <ResponsiveContainer width="100%" height={height}>
        <RadarChart data={radarData} outerRadius={outerRadius}>
          <PolarGrid stroke={ctx.grid} />
          <PolarAngleAxis dataKey="subject" tick={{ fontSize: TICK_FONT_SIZE, fill: ctx.ink }} />
          <PolarRadiusAxis tick={{ fontSize: TICK_FONT_SIZE, fill: ctx.inkFaint }} />
          {radarData.some(d => d.previous != null) && (
            <Radar name="Previous" isAnimationActive={animate} dataKey="previous" stroke={ctx.neutral} fill={ctx.neutral} fillOpacity={0.1} strokeDasharray="4 3" />
          )}
          <Radar name="Current" isAnimationActive={animate} dataKey="value" stroke={ctx.primary} fill={ctx.primary} fillOpacity={0.2} strokeWidth={2} />
        </RadarChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function ScatterPointTooltip({ active, payload, valueSuffix, ctx }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  const suffix = valueSuffix ?? '';
  const hasY = point.y != null && point.y !== 0;
  return (
    <div className={`bg-card border ${ctx.isReport ? 'border-report-crimson/20' : 'border-brief-crimson/20'} px-2.5 py-1.5 shadow-sm text-xs`}>
      {point.name && <div className={`font-semibold mb-0.5 ${inkCls(ctx)}`}>{point.name}</div>}
      <div className={inkSoftCls(ctx)}>
        {point.x}{suffix}{hasY ? ` · ${point.y}${suffix}` : ''}
      </div>
    </div>
  );
}

function renderScatter(chart: CeoPulseChart, chartIndex: number, compact: boolean, animate: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0) return null;
  const height = compact ? 160 : 200;
  const fontSize = TICK_FONT_SIZE;
  const labelFontSize = VALUE_LABEL_FONT_SIZE;

  const scatterData = chart.data.filter(Boolean).map((item: any) => ({
    x: item.value,
    y: item.previousValue ?? item.y ?? 0,
    z: item.size ?? 60,
    name: item.label,
    fill: item.color ? ctx.resolve(item.color, 0) : ctx.primary,
  }));

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ top: 14, right: 24, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={ctx.grid} />
          <XAxis type="number" dataKey="x" tick={{ fontSize, fill: ctx.ink }} name="X" />
          <YAxis type="number" dataKey="y" tick={{ fontSize, fill: ctx.ink }} name="Y" />
          <ZAxis type="number" dataKey="z" range={[40, 400]} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<ScatterPointTooltip valueSuffix={chart.valueSuffix} ctx={ctx} />} />
          <Scatter data={scatterData} isAnimationActive={animate} fill={ctx.primary}>
            {scatterData.map((entry, idx) => (
              <Cell key={idx} fill={entry.fill} />
            ))}
            <LabelList
              dataKey="name"
              position="top"
              offset={8}
              style={{ fontSize: labelFontSize, fill: ctx.ink, fontWeight: 500 }}
            />
            {/* §8.5 — every chart carries value labels: the x-value renders
                under each labeled point. */}
            <LabelList
              dataKey="x"
              position="bottom"
              offset={8}
              formatter={(v: number) => `${v}${chart.valueSuffix ?? ''}`}
              style={valueLabelStyle(ctx.ink)}
            />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

function renderProgress(chart: CeoPulseChart, chartIndex: number, compact: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0) return null;

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <div className="space-y-3">
        {chart.data.filter(Boolean).map((item, i) => {
          const pct = Math.min(100, Math.max(0, item.value));
          const color = ctx.resolve(item.color, i);
          const target = chart.target;
          return (
            <div key={i}>
              <div className="flex justify-between items-center mb-1">
                <span className={`${compact ? 'text-xs' : 'text-sm'} font-medium ${inkCls(ctx)}`}>{item.label}</span>
                <span className={`${compact ? 'text-xs' : 'text-sm'} font-semibold ${inkCls(ctx)}`}>{item.value}{chart.valueSuffix ?? '%'}</span>
              </div>
              <div className={`w-full ${compact ? 'h-3' : 'h-4'} ${ctx.isReport ? 'bg-report-cream-deep' : 'bg-muted'} rounded-full overflow-hidden relative`}>
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                {target != null && (
                  <div className={`absolute top-0 bottom-0 w-0.5 ${ctx.isReport ? '' : 'bg-red-500'}`} style={ctx.isReport ? { left: `${Math.min(100, target)}%`, backgroundColor: ctx.target } : { left: `${Math.min(100, target)}%` }} title={`Target: ${target}${chart.valueSuffix ?? '%'}`} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ChartWrapper>
  );
}

function renderGauge(chart: CeoPulseChart, chartIndex: number, compact: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0) return null;
  const item = chart.data[0];
  const value = item.value;
  const max = chart.target || 100;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const color = item.color ? ctx.resolve(item.color, 0) : ctx.primary;
  const size = compact ? 120 : 150;
  const strokeWidth = compact ? 12 : 16;
  const radius = (size - strokeWidth) / 2;
  const circumference = Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <div className="flex flex-col items-center">
        <svg width={size} height={size / 2 + 20} viewBox={`0 0 ${size} ${size / 2 + 20}`}>
          <path
            d={`M ${strokeWidth / 2} ${size / 2 + 10} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2 + 10}`}
            fill="none"
            stroke={ctx.grid}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
          <path
            d={`M ${strokeWidth / 2} ${size / 2 + 10} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2 + 10}`}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
          <text x={size / 2} y={size / 2 + 5} textAnchor="middle" className="text-lg font-bold" fill={ctx.ink} fontSize={compact ? 18 : 22}>
            {value}{chart.valueSuffix ?? '%'}
          </text>
          <text x={size / 2} y={size / 2 + 18} textAnchor="middle" fill={ctx.inkFaint} fontSize={TICK_FONT_SIZE}>
            {item.label}
          </text>
        </svg>
      </div>
    </ChartWrapper>
  );
}

function renderMetricCards(chart: CeoPulseChart, chartIndex: number, compact: boolean, ctx: PaletteCtx) {
  if (!chart.data || chart.data.length === 0) return null;

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <div className={`grid ${chart.data.length <= 2 ? 'grid-cols-2' : chart.data.length === 3 ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'} gap-3`}>
        {chart.data.filter(Boolean).map((item, i) => {
          const color = ctx.resolve(item.color, i);
          const change = item.previousValue != null ? item.value - item.previousValue : null;
          return (
            <div key={i} className={`p-3 text-center border ${ctx.isReport ? 'bg-report-paper-bright border-report-cream-deep' : 'bg-muted/50 border-border'}`}>
              <div className={`${compact ? 'text-lg' : 'text-xl'} font-bold`} style={{ color }}>
                {item.value}{chart.valueSuffix ?? ''}
              </div>
              <div className={`text-xs mt-0.5 ${inkSoftCls(ctx)}`}>{item.label}</div>
              {change != null && (
                <div
                  className={`text-[11px] mt-1 font-medium ${ctx.isReport ? '' : change >= 0 ? 'text-green-600' : 'text-red-600'}`}
                  style={ctx.isReport ? { color: change >= 0 ? ctx.positiveText : ctx.negativeText } : undefined}
                >
                  {change >= 0 ? '↑' : '↓'} {Math.abs(change)}{chart.valueSuffix ?? ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ChartWrapper>
  );
}

function renderBar(chart: CeoPulseChart, chartIndex: number, compact: boolean, animate: boolean, ctx: PaletteCtx) {
  const chartData = (chart.data || []).filter(Boolean).map((item, i) => ({
    label: item.label,
    previous: item.previousValue || 0,
    current: item.value,
    // Resolve here, not in the Cell: recharts spreads every data-entry prop
    // onto the rendered <path> as a DOM attribute, so a raw AI-emitted stock
    // hex would leak into client-facing report markup as color="…" even
    // though the fill itself is remapped (Task #4635).
    color: item.color ? ctx.resolve(item.color, i) : undefined,
    group: item.group,
  }));

  if (chartData.length === 0) return null;

  const hasComparison = chart.type === "comparison" && chartData.some(d => d.previous > 0);
  const hasLegend = chart.legend && chart.legend.length > 0;

  let displayData: any[] = chartData;

  if (hasLegend && chartData.length >= 2) {
    const extractGroup = (label: string) => {
      return label
        .replace(/\s*\([^)]+\)\s*$/i, '')
        .replace(/\s*-\s*(google|chatgpt|bing|ai|other).*$/i, '')
        .trim();
    };

    const groups: string[] = [];
    const groupIndices: Map<string, number[]> = new Map();

    chartData.forEach((d, i) => {
      const group = d.group || extractGroup(d.label);
      if (!groupIndices.has(group)) {
        groups.push(group);
        groupIndices.set(group, []);
      }
      groupIndices.get(group)!.push(i);
    });

    if (groups.length < chartData.length) {
      displayData = chartData.map((d, i) => {
        const group = d.group || extractGroup(d.label);
        const indices = groupIndices.get(group)!;
        const midIndex = Math.floor((indices[0] + indices[indices.length - 1]) / 2);
        const showLabel = i === midIndex || (indices.length === 2 && i === indices[0]);
        return {
          ...d,
          label: showLabel ? group : ' ',
          displayLabel: group,
          groupSize: indices.length,
          isGroupStart: i === indices[0],
        };
      });
    }
  }

  const barSize = compact ? 14 : 18;
  const barSpacing = compact ? 28 : 50;
  const chartHeight = Math.max(compact ? 80 : 120, displayData.length * barSpacing);
  const fontSize = TICK_FONT_SIZE;
  const labelFontSize = VALUE_LABEL_FONT_SIZE;
  const yAxisWidth = yAxisCategoryWidth(compact);

  const truncateLabel = (label: string, maxLen = 25) => {
    if (!label) return '';
    if (label.length <= maxLen) return label;
    return label.substring(0, maxLen - 2) + '...';
  };

  const finalData = displayData.map((d: any) => ({
    ...d,
    label: truncateLabel(d.label),
    fullLabel: d.label,
    isGroupStart: d.isGroupStart || false,
    groupSize: d.groupSize || 1,
  }));

  return (
    <ChartWrapper chart={chart} chartIndex={chartIndex} compact={compact} ctx={ctx}>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={finalData}
          layout="vertical"
          margin={{ top: compact ? 2 : 5, right: compact ? 40 : 45, left: compact ? 2 : 10, bottom: compact ? 2 : 5 }}
          barCategoryGap={compact ? "15%" : "25%"}
        >
          <XAxis type="number" domain={[0, 'auto']} tick={{ fontSize, fill: ctx.ink }} tickFormatter={(v) => `${v}${chart.valueSuffix ?? '%'}`} />
          {compact ? (
            <YAxis
              type="category"
              dataKey="label"
              width={yAxisWidth}
              interval={0}
              tick={(props: any) => {
                const { x, y, payload } = props;
                const label = payload?.value || '';
                const dataItem = finalData[payload?.index];
                const yOffset = (dataItem?.isGroupStart && dataItem?.groupSize === 2) ? 14 : 0;
                if (!label || label === ' ') {
                  return <text x={0} y={0} visibility="hidden" />;
                }
                return (
                  <text x={x} y={y + yOffset} textAnchor="end" fontSize={TICK_FONT_SIZE} fill={ctx.ink}>
                    {label}
                  </text>
                );
              }}
            />
          ) : (
            <YAxis type="category" dataKey="label" tick={{ fontSize, fill: ctx.ink }} width={yAxisWidth} />
          )}
          {hasComparison && (
            <Bar dataKey="previous" isAnimationActive={animate} fill={ctx.neutral} radius={[0, 4, 4, 0]} barSize={barSize}>
              <LabelList dataKey="previous" position="right" formatter={(v: number) => `${v}${chart.valueSuffix ?? '%'}`} style={{ fontSize: labelFontSize, fill: ctx.isReport ? ctx.inkFaint : PULSE_LABEL_MUTED }} />
            </Bar>
          )}
          <Bar dataKey="current" isAnimationActive={animate} radius={[0, 4, 4, 0]} barSize={barSize}>
            {finalData.map((entry: any, index: number) => (
              <Cell key={`cell-${index}`} fill={entry.color || ctx.primary} />
            ))}
            <LabelList dataKey="current" position="right" formatter={(v: number) => `${v}${chart.valueSuffix ?? '%'}`} style={{ fontSize: labelFontSize, fontWeight: 600, fill: ctx.ink }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {!hasLegend && hasComparison && (
        <div className="flex items-center gap-4 justify-center text-xs pt-2">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: ctx.neutral }} />
            <span className={inkSoftCls(ctx)}>Previous</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: ctx.primary }} />
            <span className={inkSoftCls(ctx)}>Current</span>
          </div>
        </div>
      )}
    </ChartWrapper>
  );
}

export default function CeoPulseChartRenderer({ charts, compact = false, animate = true, palette }: CeoPulseChartRendererProps) {
  const filtered = charts.filter(Boolean);
  // One ctx per render: report mode remaps explicit (AI-emitted) hexes
  // first-seen across ALL charts so legend swatches and data fills agree.
  const ctx = makePaletteCtx(palette);
  if (filtered.length === 0) {
    return <p className={`${inkMutedCls(ctx)} text-sm`} data-testid="text-no-chart-data">No chart data available</p>;
  }

  return (
    <div className="space-y-6" data-testid="ceo-pulse-charts">
      {filtered.map((chart, chartIndex) => (
        <Fragment key={`chart-${chartIndex}`}>
          {(() => {
        switch (chart.type) {
          case "funnel":
            return renderFunnel(chart, chartIndex, compact, animate, ctx);
          case "pie":
            return renderPie(chart, chartIndex, compact, false, animate, ctx);
          case "doughnut":
          case "donut":
            return renderPie(chart, chartIndex, compact, true, animate, ctx);
          case "line":
            return renderLine(chart, chartIndex, compact, false, animate, ctx);
          case "area":
            return renderLine(chart, chartIndex, compact, true, animate, ctx);
          case "stacked_bar":
          case "stackedBar":
            return renderStackedBar(chart, chartIndex, compact, animate, ctx);
          case "grouped_bar":
          case "groupedBar":
            return renderGroupedBar(chart, chartIndex, compact, animate, ctx);
          case "radar":
          case "spider":
            return renderRadar(chart, chartIndex, compact, animate, ctx);
          case "scatter":
          case "bubble":
            return renderScatter(chart, chartIndex, compact, animate, ctx);
          case "progress":
            return renderProgress(chart, chartIndex, compact, ctx);
          case "gauge":
            return renderGauge(chart, chartIndex, compact, ctx);
          case "metric":
          case "metric_cards":
          case "kpi":
            return renderMetricCards(chart, chartIndex, compact, ctx);
          case "bar":
          case "comparison":
          default:
            return renderBar(chart, chartIndex, compact, animate, ctx);
        }
          })()}
        </Fragment>
      ))}
    </div>
  );
}
