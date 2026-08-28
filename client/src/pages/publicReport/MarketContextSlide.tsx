/**
 * MarketContextSlide — shared pieces of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 894–1253, 1261–1622 @ d31d7c0c7, Task #4271).
 * Zero visual/behavioral change intended — do not edit alongside a move.
 */

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis, LabelList, Line } from "recharts";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { highlightPhases, phaseColors } from "./chrome";
import { REPORT_PHASE_INK_COLORS } from "./reportTokens";
import { PhaseSettingResponse, PracticeAreaTrend, TrendDataPoint, TrendsResponse } from "./types";
import { Slide } from "./Slide";
import { VerdictLine } from "./VerdictLine";
import { REPORT_COLORS, REPORT_STATUS_COLORS, REPORT_TICK_FONT_SIZE } from './reportTokens';

// Task #4847 — vertical rhythm for the current-month "NOW" callout stack.
// The three stacked elements (NOW, ▼ arrow, value label) previously sat 7px
// apart baseline-to-baseline at the 11px tick font and visually collided.
// Space each step a full line-height so the callout reads as separate lines;
// the value label keeps its original 2px lift so it stays aligned with the
// value labels on every other bar.
const NOW_STACK_LINE_STEP = Math.ceil(REPORT_TICK_FONT_SIZE * 1.25); // 14px — ≥ a full line-height at the 11px tick font
const VALUE_LABEL_LIFT = 2; // unchanged — matches the value labels on non-current bars
const NOW_ARROW_LIFT = VALUE_LABEL_LIFT + NOW_STACK_LINE_STEP; // 16px
const NOW_LABEL_LIFT = VALUE_LABEL_LIFT + 2 * NOW_STACK_LINE_STEP; // 30px
// Headroom so the taller NOW stack never clips at the SVG top even when the
// current month is the tallest bar (value 100 on the hidden [0, 115] domain):
// at the compact h-32 height a 100-value bar tops out only ~7.7px below the
// plot top, so the top margin must absorb NOW_LABEL_LIFT + text ascent (~9px)
// − 7.7px ≈ 31px; 34 leaves slack at both chart heights.
const TREND_CHART_TOP_MARGIN = 34;

// Custom bar shape that applies phase color directly to the rect element
export const PhaseBarShape = (props: any) => {
  const { x, y, width, height, fill, phase } = props;
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill={fill}
      rx={3}
      ry={3}
      style={{ fill, fillOpacity: 1 }}
      data-phase={phase}
      className={`phase-rect phase-rect-${phase?.toLowerCase() || 'hold'}`}
    />
  );
};

export function TrendChart({ data, title, searchTerm, compact = false, estimated = false }: { 
  data: TrendDataPoint[]; 
  title: string; 
  searchTerm: string;
  compact?: boolean;
  /** Task #4277 — true when the series is the static industry-pattern
   *  fallback rather than fetched/embedded Google Trends data: the source
   *  chip must never claim "Google Trends" for numbers we estimated. */
  estimated?: boolean;
}) {
  // Task #5326 — at narrow (<768px) widths this card's own column is full
  // width but still only ~230-260px, too tight for 12 side-by-side month
  // ticks PLUS a per-bar numeric label without overlapping illegibly. Thin
  // the ticks to every other month and drop the numeric labels (the "NOW"
  // callout and phase colors/legend still carry the story) rather than
  // shrinking font past a readable floor.
  const isNarrow = useIsMobile(768);
  return (
    <div className={compact ? "p-4" : "p-6"}>
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className={`font-bold text-report-ink ${compact ? 'text-xs' : 'text-sm'} mb-1`}>{title}</h3>
          <p className={`text-report-ink-muted ${compact ? 'text-[11px]' : 'text-[11px]'}`}>"{searchTerm}"</p>
        </div>
        <div className="bg-report-cream-deep text-report-ink-muted text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider">
          {estimated ? "Industry Estimate" : "Google Trends"}
        </div>
      </div>
      <div className={compact ? "h-32" : "h-48"} style={{ width: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: TREND_CHART_TOP_MARGIN, right: 5, left: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={REPORT_COLORS.creamDeep} />
            <XAxis 
              dataKey="month" 
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: REPORT_COLORS.inkMuted, fontSize: REPORT_TICK_FONT_SIZE, fontWeight: 600 }} 
              dy={3}
              interval={isNarrow ? 1 : 0}
            />
            <YAxis hide domain={[0, 115]} />
            <Bar 
              dataKey="value" 
              // Task #4286 (audit #28) — mini-chart grids render settled;
              // entry animations batch on tall slides and double-paint in print.
              isAnimationActive={false}
              radius={[3, 3, 0, 0]} 
              maxBarSize={compact ? 24 : 38}
              shape={(props: any) => {
                const entry = data[props.index];
                const fillColor = phaseColors[entry?.phase] || REPORT_COLORS.slate;
                return <PhaseBarShape {...props} fill={fillColor} phase={entry?.phase} />;
              }}
            >
              <LabelList 
                dataKey="value" 
                position="top" 
                fontSize={REPORT_TICK_FONT_SIZE}
                content={({ x, y, width, value, index }: any) => {
                  const entry = data[index];
                  const isCurrentMonth = entry?.isCurrent;
                  return (
                    <g>
                      {isCurrentMonth && (
                        <>
                          <text x={(x as number) + (width as number) / 2} y={(y as number) - NOW_LABEL_LIFT} textAnchor="middle" fill={REPORT_COLORS.crimson} fontSize={REPORT_TICK_FONT_SIZE} fontWeight={700}>NOW</text>
                          <text x={(x as number) + (width as number) / 2} y={(y as number) - NOW_ARROW_LIFT} textAnchor="middle" fill={REPORT_COLORS.crimson} fontSize={REPORT_TICK_FONT_SIZE}>▼</text>
                        </>
                      )}
                      {!isNarrow && (
                        <text x={(x as number) + (width as number) / 2} y={(y as number) - VALUE_LABEL_LIFT} textAnchor="middle" fill={REPORT_COLORS.ink} fontSize={REPORT_TICK_FONT_SIZE} fontWeight={400}>{value}</text>
                      )}
                    </g>
                  );
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {!compact && (
        <div className="mt-2 flex justify-center gap-4 text-[11px] font-medium">
          {Object.entries(phaseColors).map(([phase, color]) => (
            <div key={phase} className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
              <span className="text-report-ink-muted">{phase}</span>
            </div>
          ))}
        </div>
      )}
      {!compact && estimated && (
        <p
          className="mt-2 text-center text-[11px] text-report-ink-muted"
          data-testid="text-market-context-estimated-note"
        >
          Estimated seasonal pattern from industry averages — live search-trend
          data was not available for this report.
        </p>
      )}
    </div>
  );
}

export const practiceAreaColors = [
  REPORT_COLORS.crimson, REPORT_COLORS.steel, REPORT_COLORS.gold,
  REPORT_COLORS.sage, REPORT_COLORS.liberty, REPORT_STATUS_COLORS.attention,
];

// Client-side phase classifier matching server logic (with state machine)
export function classifyPhasesClient(values: number[]): string[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return ["Hold"];
  
  const indexed = values.map((v, i) => ({ value: v, originalIndex: i }));
  const sorted = [...indexed].sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return a.originalIndex - b.originalIndex;
  });
  
  const rankMap = new Map<number, number>();
  sorted.forEach((item, rank) => rankMap.set(item.originalIndex, rank));
  
  if (n <= 6) {
    return values.map((_, i) => {
      const rank = rankMap.get(i)!;
      if (rank === 0) return "Peak";
      if (rank === n - 1) return "Soft";
      if (n === 2) return rank === 0 ? "Peak" : "Soft";
      if (n === 3) return rank === 1 ? "Hold" : (rank === 0 ? "Peak" : "Soft");
      if (rank <= 1) return "Hold";
      if (rank >= n - 2) return "Rebuild";
      return "Taper";
    });
  }
  
  // For n>=7
  const peakCutoff = Math.max(1, Math.min(2, Math.ceil(n * 0.12)));
  const holdCutoff = Math.max(peakCutoff + 1, Math.ceil(n * 0.30));
  const softCutoff = Math.min(n - 1, Math.max(holdCutoff + 1, Math.floor(n * 0.75)));
  
  const peakThreshold = sorted[peakCutoff - 1].value;
  const holdThreshold = sorted[holdCutoff - 1].value;
  const softThreshold = sorted[softCutoff - 1].value;
  
  const getMomentum = (idx: number) => {
    const prev1 = values[(idx - 1 + n) % n];
    const prev2 = values[(idx - 2 + n) % n];
    return (values[idx] - prev1) * 0.6 + (prev1 - prev2) * 0.4;
  };
  
  const isNearLowPoint = (index: number) => {
    for (let offset = -3; offset <= 0; offset++) {
      const checkIdx = (index + offset + n) % n;
      if (values[checkIdx] <= softThreshold) return true;
    }
    return false;
  };
  
  const isRisingTowardPeak = (index: number) => {
    for (let offset = 1; offset <= 3; offset++) {
      const checkIdx = (index + offset) % n;
      if (values[checkIdx] >= holdThreshold) return true;
    }
    return false;
  };
  
  const initialPhases: string[] = [];
  for (let i = 0; i < n; i++) {
    const value = values[i];
    const momentum = getMomentum(i);
    if (value >= peakThreshold) initialPhases.push("Peak");
    else if (value >= holdThreshold) initialPhases.push(momentum < -3 ? "Taper" : "Hold");
    else if (value <= softThreshold) initialPhases.push(momentum > 1 ? "Rebuild" : "Soft");
    else {
      const nearLow = isNearLowPoint(i);
      const risingToPeak = isRisingTowardPeak(i);
      if (nearLow && risingToPeak) initialPhases.push("Rebuild");
      else if (momentum > 1 || (nearLow && momentum >= 0)) initialPhases.push("Rebuild");
      else if (momentum < -2) initialPhases.push("Taper");
      else if (!nearLow && momentum < 0) initialPhases.push("Taper");
      else initialPhases.push("Hold");
    }
  }
  
  // State machine to fix illogical transitions
  const phases = [...initialPhases];
  const validTransitions: Record<string, string[]> = {
    "Peak": ["Peak", "Hold", "Taper"],
    "Hold": ["Peak", "Hold", "Taper", "Soft"],  // Allow Hold→Soft for sharp demand drops
    "Taper": ["Peak", "Hold", "Taper", "Soft"],
    "Soft": ["Peak", "Soft", "Rebuild", "Hold"],  // NOT Taper
    "Rebuild": ["Rebuild", "Hold", "Peak", "Soft"],  // Allow Rebuild→Soft if recovery stalls
  };
  
  const fixTransition = (prevPhase: string, currentPhase: string, momentum: number) => {
    const allowed = validTransitions[prevPhase] || [];
    if (allowed.includes(currentPhase)) return currentPhase;
    if (prevPhase === "Soft" && currentPhase === "Taper") return momentum > 0 ? "Rebuild" : "Soft";
    if (prevPhase === "Peak" && currentPhase === "Soft") return "Taper";
    if (prevPhase === "Rebuild" && currentPhase === "Taper") return momentum > 0 ? "Rebuild" : "Hold";
    if (prevPhase === "Rebuild" && currentPhase === "Soft") return "Rebuild";
    return allowed[0] || currentPhase;
  };
  
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const prevIdx = (i - 1 + n) % n;
      const fixed = fixTransition(phases[prevIdx], phases[i], getMomentum(i));
      if (fixed !== phases[i]) { phases[i] = fixed; changed = true; }
    }
    if (!changed) break;
  }
  
  return phases;
}

export function CombinedTrendChart({ 
  allTrends,
  currentMonthIndex,
  compact = false 
}: { 
  allTrends: PracticeAreaTrend[];
  currentMonthIndex: number;
  compact?: boolean;
}) {
  // Task #5326 — see TrendChart above for the same narrow-width rationale.
  const isNarrow = useIsMobile(768);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // Calculate combined average
  const averages = monthNames.map((_, idx) => {
    const total = allTrends.reduce((sum, trend) => sum + (trend.data[idx]?.value || 0), 0);
    return allTrends.length > 0 ? Math.round(total / allTrends.length) : 0;
  });
  
  // Classify using the same logic as server (with state machine)
  const phases = classifyPhasesClient(averages);
  
  const chartData = monthNames.map((month, idx) => ({
    month,
    isCurrent: idx === currentMonthIndex,
    average: averages[idx],
    phase: phases[idx] || 'Hold',
  }));
  
  return (
    <div className={compact ? "p-4" : "p-6"}>
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className={`font-bold text-report-ink ${compact ? 'text-xs' : 'text-sm'} mb-1`}>
            Combined Search Demand
          </h3>
          <p className={`text-report-ink-muted ${compact ? 'text-[11px]' : 'text-[11px]'}`}>
            Average of {allTrends.length} practice areas
          </p>
        </div>
        <div className="bg-report-cream-deep text-report-ink-muted text-[11px] font-bold px-2 py-1 rounded uppercase tracking-wider">
          Google Trends
        </div>
      </div>
      
      <div className={compact ? "h-32" : "h-48"} style={{ width: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: TREND_CHART_TOP_MARGIN, right: 5, left: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={REPORT_COLORS.creamDeep} />
            <XAxis 
              dataKey="month" 
              axisLine={false} 
              tickLine={false} 
              tick={{ fill: REPORT_COLORS.inkMuted, fontSize: REPORT_TICK_FONT_SIZE, fontWeight: 600 }} 
              dy={3}
              interval={isNarrow ? 1 : 0}
            />
            <YAxis hide domain={[0, 115]} />
            <Bar 
              dataKey="average" 
              isAnimationActive={false}
              radius={[3, 3, 0, 0]} 
              maxBarSize={compact ? 24 : 38}
              shape={(props: any) => {
                const entry = chartData[props.index];
                const fillColor = phaseColors[entry?.phase] || REPORT_COLORS.slate;
                return <PhaseBarShape {...props} fill={fillColor} phase={entry?.phase} />;
              }}
            >
              <LabelList 
                dataKey="average" 
                position="top" 
                fontSize={REPORT_TICK_FONT_SIZE}
                content={({ x, y, width, value, index }: any) => {
                  const entry = chartData[index];
                  const isCurrentMonth = entry?.isCurrent;
                  return (
                    <g>
                      {isCurrentMonth && (
                        <>
                          <text x={(x as number) + (width as number) / 2} y={(y as number) - NOW_LABEL_LIFT} textAnchor="middle" fill={REPORT_COLORS.crimson} fontSize={REPORT_TICK_FONT_SIZE} fontWeight={700}>NOW</text>
                          <text x={(x as number) + (width as number) / 2} y={(y as number) - NOW_ARROW_LIFT} textAnchor="middle" fill={REPORT_COLORS.crimson} fontSize={REPORT_TICK_FONT_SIZE}>▼</text>
                        </>
                      )}
                      {!isNarrow && (
                        <text x={(x as number) + (width as number) / 2} y={(y as number) - VALUE_LABEL_LIFT} textAnchor="middle" fill={REPORT_COLORS.ink} fontSize={REPORT_TICK_FONT_SIZE} fontWeight={400}>{value}</text>
                      )}
                    </g>
                  );
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      
      {!compact && (
        <div className="mt-2 flex justify-center gap-4 text-[11px] font-medium">
          {Object.entries(phaseColors).map(([phase, color]) => (
            <div key={phase} className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
              <span className="text-report-ink-muted">{phase}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ContributionBreakdown({ 
  allTrends,
  currentMonthIndex
}: { 
  allTrends: PracticeAreaTrend[];
  currentMonthIndex: number;
}) {
  const totalValue = allTrends.reduce((sum, trend) => sum + (trend.data[currentMonthIndex]?.value || 0), 0);
  
  return (
    <div className="mt-4 pt-4 border-t border-report-crimson/10">
      <div className="text-[11px] uppercase tracking-wider font-bold text-report-crimson mb-2">
        Current Month Contribution
      </div>
      <div className="space-y-2">
        {allTrends.map((trend, i) => {
          const value = trend.data[currentMonthIndex]?.value || 0;
          const pct = totalValue > 0 ? Math.round((value / totalValue) * 100) : 0;
          const phase = trend.data[currentMonthIndex]?.phase || 'Hold';
          return (
            <div key={trend.practiceArea} className="flex items-center gap-2">
              <div 
                className="w-2 h-2 rounded-sm shrink-0" 
                style={{ backgroundColor: practiceAreaColors[i % practiceAreaColors.length] }} 
              />
              <span className="text-xs text-report-ink flex-1 truncate">{trend.practiceArea}</span>
              <span className="text-xs font-medium text-report-ink">{value}</span>
              {/* Task #4542 — chip text uses the AA-safe phase ink (audit R1: steel/sage
                  chip text was 3.6–3.8:1 on its own tint); the tint keeps the base
                  phase hue so the chart↔chip color link survives. 12px caption floor. */}
              <div 
                className="text-xs px-2 py-1 rounded font-medium"
                style={{ 
                  backgroundColor: `${phaseColors[phase]}20`,
                  color: REPORT_PHASE_INK_COLORS[phase as keyof typeof REPORT_PHASE_INK_COLORS] ?? REPORT_COLORS.inkMuted
                }}
              >
                {phase}
              </div>
              <span className="text-[11px] text-report-ink-muted w-8 text-right">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task #4277 — Market Context resilience (audit §8.7-4, backlog #13/#25).
// Pure, test-covered decision helpers. The slide render can only be one of
// three things: a transient loading card, real trend data, or the clearly
// labeled static industry-pattern chart the print pipeline has always used.
// There is deliberately NO error input and NO error state in this machine —
// a failed or absent fetch degrades to "estimated", so an error card can
// never be the slide's only content.
// ---------------------------------------------------------------------------

export type MarketContextRenderState = "loading" | "data" | "estimated";

export function resolveMarketContextRenderState({
  hasTrendData,
  isLoading,
  isPrinting,
}: {
  hasTrendData: boolean;
  isLoading: boolean;
  isPrinting: boolean;
}): MarketContextRenderState {
  if (hasTrendData) return "data";
  // Print never waits and never blanks: fall straight through to the static
  // fallback chart.
  if (isLoading && !isPrinting) return "loading";
  return "estimated";
}

/**
 * Deck/agenda gate (consumed by PublicReport and, via the view bag,
 * AgendaSlide): without a single practice area AND without an embedded
 * seasonal-trend payload the slide has no market to talk about — it drops
 * from the deck and the agenda instead of rendering generic filler.
 */
export function hasMarketContextData(
  practiceAreas: string[] | null | undefined,
  embeddedTrends?: { practiceAreas?: unknown[] | null } | null,
): boolean {
  return (
    (practiceAreas?.length ?? 0) > 0 ||
    (embeddedTrends?.practiceAreas?.length ?? 0) > 0
  );
}

/** Task #4277 — deterministic phase → verdict sentence (§8.1), used when the
 *  report carries no stored verdict for this slide. */
export function deriveMarketContextVerdict(phase: string): string {
  switch (phase) {
    case "Peak":
      return "Demand is at its seasonal Peak — the move is capture: answer and convert while volume is here.";
    case "Hold":
      return "Demand is holding steady — the move is consistency: keep every stage of the engine running.";
    case "Taper":
      return "Demand is easing off its seasonal high — the move is efficiency, not extra spend.";
    case "Soft":
      return "Demand is in a seasonal Soft phase — the move is intake, not spend.";
    case "Rebuild":
      return "Demand is rebuilding toward its next peak — the move is positioning now, ahead of the wave.";
    default:
      return "Demand is between clear seasonal phases — the move is steady execution while the picture develops.";
  }
}

export function MarketContextSlide({ slideNumber, practiceAreas, embeddedTrends = null, isPrintMode = false, isPublicView = false, verdict = null }: { slideNumber: number; practiceAreas: string[]; embeddedTrends?: TrendsResponse | null; isPrintMode?: boolean; isPublicView?: boolean; verdict?: string | null }) {
  const [selectedTab, setSelectedTab] = useState(0);
  const [isPrinting, setIsPrinting] = useState(isPrintMode);
  
  // Detect print mode to show fallback data instead of loading
  useEffect(() => {
    const handleBeforePrint = () => setIsPrinting(true);
    const handleAfterPrint = () => setIsPrinting(false);
    const printMedia = window.matchMedia('print');
    setIsPrinting(isPrintMode || printMedia.matches);
    window.addEventListener('beforeprint', handleBeforePrint);
    window.addEventListener('afterprint', handleAfterPrint);
    return () => {
      window.removeEventListener('beforeprint', handleBeforePrint);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
  }, [isPrintMode]);
  
  const { data: phaseSettingsData } = useQuery<PhaseSettingResponse[]>({
    queryKey: ["/api/phase-settings"],
    queryFn: async () => {
      const res = await fetch("/api/phase-settings");
      if (!res.ok) throw new Error("Failed to fetch phase settings");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    // Task #4225 — /api/phase-settings is an authenticated endpoint. On
    // public views (share token / demo / public print) it would 401 and pop
    // the global "Request failed" toast over the client's report; the
    // hardcoded fallback actions below render instead. Errors stay silent on
    // authenticated views too — the fallback copy is the on-page state.
    enabled: !isPublicView,
    meta: { silent: true },
  });
  
  const phaseActions: Record<string, string[]> = phaseSettingsData 
    ? Object.fromEntries(phaseSettingsData.map(s => [s.phase, s.actions]))
    : {
        Peak: [
          "**Hold Steady:** Things are working. Enjoy the increased demand and let the system print money",
          "**Fix the Bottleneck:** If you can't take more leads or spend more, intake or sales is the limiter"
        ],
        Hold: [
          "**Stay the Course:** Keep doing what's working while demand stays strong",
          "**Go Wider:** Open new GBP locations to turn steady demand into more total volume"
        ],
        Taper: [
          "**Hold the Line:** Keep ad spend steady and avoid losing momentum",
          "**Strengthen the Engine:** Use this window to improve intake or sales so each lead is worth more"
        ],
        Soft: [
          "**Buy Market Share:** Keep spending while competitors pull back",
          "**Build While It's Quiet:** Fix intake, fix sales, or open new locations so growth isn't capped later"
        ],
        Rebuild: [
          "**Turn It Back Up:** Demand is returning, now is the time to spend more",
          "**Expand Faster:** Add locations and scale what you already know works"
        ],
      };
  
  // Task #4277 — the query's `error` is deliberately not read: any failure
  // simply leaves `effectiveTrends` empty and the render-state machine below
  // degrades to the labeled static fallback chart. No error card exists.
  const { data: trendsData, isLoading } = useQuery<TrendsResponse>({
    queryKey: ["/api/trends/practice-areas", practiceAreas],
    queryFn: async () => {
      const res = await fetch("/api/trends/practice-areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ practiceAreas }),
      });
      if (!res.ok) throw new Error("Failed to fetch trends");
      return res.json();
    },
    // Task #4225 — also authenticated-only: public viewers use the embedded
    // seasonalTrends payload (Task #4210) or the hardcoded fallback, so the
    // query must never fire (and never toast) on public views.
    // Task #4240 — additionally skip the live fetch when the report payload
    // already embeds the finalize-time cached AI commentary: every viewer
    // then reads the SAME stored text, and finalized reports stop
    // re-invoking OpenAI on each authenticated view.
    enabled: !isPublicView && practiceAreas.length > 0 && !embeddedTrends?.aiAnalysis,
    retry: 1,
    meta: { silent: true },
  });

  // Task #4210 — anonymous share-token viewers can't call the authenticated
  // trends endpoint (401); use the deterministic payload embedded in the
  // share-report response instead.
  // Task #4240 — the embedded payload now carries the AI commentary cached
  // at report-finalize time (seasonalTrends.aiAnalysis). When present it
  // wins for everyone (parity: shared-link viewers see the same text as
  // logged-in viewers). Without it (drafts, pre-#4240 finals, generation
  // failure) authenticated viewers keep the live fetch and anonymous
  // viewers render the derived fallback analysis — never an OpenAI call
  // from an unauthenticated view.
  const effectiveTrends =
    (embeddedTrends?.aiAnalysis ? embeddedTrends : trendsData ?? embeddedTrends) ??
    undefined;

  const currentMonth = new Date().getMonth();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // Fallback data when API fails or returns empty
  const fallbackTrend: PracticeAreaTrend = {
    practiceArea: practiceAreas[0] || "Legal Services",
    searchTerm: practiceAreas[0] ? `${practiceAreas[0]} lawyer near me` : "legal services near me",
    data: [90, 88, 85, 82, 80, 75, 72, 78, 82, 85, 80, 75].map((value, index) => ({
      month: monthNames[index],
      value,
      isCurrent: index === currentMonth,
      phase: index <= 2 ? "Hold" : index <= 5 ? "Taper" : index <= 7 ? "Soft" : "Rebuild",
    })),
  };
  
  const hasTrendData = (effectiveTrends?.practiceAreas?.length ?? 0) > 0;
  const renderState = resolveMarketContextRenderState({ hasTrendData, isLoading, isPrinting });
  const usingEstimated = renderState === "estimated";

  const allTrends = hasTrendData && effectiveTrends ? effectiveTrends.practiceAreas : [fallbackTrend];
  const combined = effectiveTrends?.combined;
  const hasMultiple = allTrends.length > 1;
  
  const displayTrends = hasMultiple && combined 
    ? [combined, ...allTrends] 
    : allTrends;
  
  // Ensure selectedTab is within bounds
  const safeSelectedTab = Math.min(selectedTab, displayTrends.length - 1);
  const selectedTrend = displayTrends[safeSelectedTab] || displayTrends[0] || fallbackTrend;
  const currentPhase = selectedTrend?.data?.find(d => d.isCurrent)?.phase || 'Hold';

  // Calculate next phase info for display
  const getNextPhaseInfo = () => {
    const currentIdx = effectiveTrends?.currentMonthIndex ?? currentMonth;
    for (let i = 1; i <= 6; i++) {
      const futureIdx = (currentIdx + i) % 12;
      const futurePhase = selectedTrend?.data?.[futureIdx]?.phase;
      if (futurePhase && futurePhase !== currentPhase) {
        return { phase: futurePhase, monthsAway: i };
      }
    }
    return null;
  };

  // Generate fallback analysis based on selected practice area
  const getPhaseDescription = (phase: string) => {
    switch (phase) {
      case 'Peak': return 'at maximum demand with high client activity';
      case 'Hold': return 'in a stable plateau with steady engagement';
      case 'Taper': return 'declining from recent highs';
      case 'Soft': return 'at a seasonal low point';
      case 'Rebuild': return 'building momentum toward the next peak';
      default: return 'in a transitional period';
    }
  };
  
  const getNextPhasePreview = () => {
    const nextInfo = getNextPhaseInfo();
    if (nextInfo) {
      return `Expect transition to ${nextInfo.phase} phase within the next ${nextInfo.monthsAway === 1 ? 'month' : `${nextInfo.monthsAway} months`}.`;
    }
    return `${currentPhase} phase expected to continue for the near term.`;
  };

  const fallbackAnalysis = {
    currentPosition: [
      `${selectedTrend?.practiceArea || 'Market'} demand is currently ${getPhaseDescription(currentPhase)}.`,
      `Search volume indicates ${currentPhase === 'Peak' || currentPhase === 'Hold' ? 'strong' : 'moderate'} interest in legal services.`,
    ],
    demandShapeAhead: [
      getNextPhasePreview(),
      "Strategic positioning now sets up success for upcoming phases.",
    ],
  };

  // Use AI analysis from the fetched trends (keyed by practice area name), otherwise use fallback
  const selectedPracticeArea = selectedTrend?.practiceArea || "";
  const practiceAreaAnalysis = effectiveTrends?.aiAnalysis?.[selectedPracticeArea];
  const analysis = practiceAreaAnalysis || fallbackAnalysis;

  // Task #4277 — verdict sentence (§8.1). Stored copy wins (operator/AI
  // authored, served as data.slideVerdicts.marketContext); otherwise derive a
  // deterministic one-liner from the DEFAULT view's current phase (combined
  // average when multiple areas, the single trend otherwise) so the sentence
  // stays stable across tab switches. While the live query is still in
  // flight there is no trustworthy phase yet — render no derived verdict
  // rather than a guess that may flip when data lands.
  const storedVerdict = typeof verdict === "string" && verdict.trim().length > 0 ? verdict : null;
  const defaultTrend = displayTrends[0] || fallbackTrend;
  const defaultPhase = defaultTrend?.data?.find(d => d.isCurrent)?.phase || "Hold";
  const verdictText =
    storedVerdict ?? (renderState === "loading" ? null : deriveMarketContextVerdict(defaultPhase));

  return (
    <Slide slideNumber={slideNumber} variant="beige" pattern="dots" id="market-context" vCenter>
      {/* Header with keep-together class for print */}
      <div className="slide-header print-keep-together">
        <BarChart3 className="slide-header-icon text-report-crimson" />
        <h2 className="slide-title text-report-crimson">Market Context</h2>
        <span className="text-sm text-report-ink-muted ml-2">What's Influencing Results</span>
      </div>

      <VerdictLine
        verdict={verdictText}
        slideKey="marketContext"
        className="mb-6 max-w-[68ch] text-report-ink"
      />

      {renderState === "loading" ? (
        <div className="bg-white rounded-lg border border-report-crimson/5 shadow-sm p-8 text-center print:hidden">
          <div className="text-report-crimson animate-pulse">Loading trend data...</div>
          <p className="text-xs text-report-ink-muted mt-2">Please wait for data to load before printing</p>
        </div>
      ) : (
        <>
          {hasMultiple && (
            <div className="flex gap-2 mb-4 flex-wrap">
              {displayTrends.map((trend, idx) => (
                <button
                  key={trend.practiceArea}
                  onClick={() => setSelectedTab(idx)}
                  className={`px-4 py-2 rounded text-xs font-medium transition-all ${
                    safeSelectedTab === idx 
                      ? 'bg-report-crimson text-white shadow-md' 
                      : 'bg-white text-report-ink border border-report-crimson/20 hover:border-report-crimson/40'
                  }`}
                >
                  {trend.practiceArea === "Combined Average" ? "📊 Portfolio View" : trend.practiceArea}
                </button>
              ))}
            </div>
          )}

          <div className="bg-white rounded-lg border border-report-crimson/5 shadow-sm overflow-hidden">
            <div className="grid grid-cols-1 md:grid-cols-12">
              <div className="md:col-span-8 border-b md:border-b-0 md:border-r border-report-crimson/5">
                {hasMultiple && safeSelectedTab === 0 ? (
                  <>
                    <CombinedTrendChart 
                      allTrends={allTrends}
                      currentMonthIndex={effectiveTrends?.currentMonthIndex ?? currentMonth}
                    />
                    <div className="px-6 pb-4">
                      <ContributionBreakdown 
                        allTrends={allTrends}
                        currentMonthIndex={effectiveTrends?.currentMonthIndex ?? currentMonth}
                      />
                    </div>
                  </>
                ) : selectedTrend && (
                  <TrendChart 
                    data={selectedTrend.data} 
                    title={`Search Demand: ${selectedTrend.practiceArea}`}
                    searchTerm={selectedTrend.searchTerm}
                    estimated={usingEstimated}
                  />
                )}
              </div>

              <div className="md:col-span-4 p-6 flex flex-col gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-report-crimson mb-2">
                    {safeSelectedTab === 0 && hasMultiple ? "Portfolio Demand Position" : `${selectedTrend?.practiceArea} Position`}
                  </div>
                  <ul className="space-y-2">
                    {analysis.currentPosition.slice(0, 2).map((bullet, i) => (
                      <li key={i} className="text-report-ink text-xs leading-relaxed flex items-start gap-2">
                        <span className="text-report-crimson mt-1 text-[11px]">•</span>
                        <span>{highlightPhases(bullet)}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-report-crimson mb-2">Expected Demand Shape Ahead</div>
                  <ul className="space-y-2">
                    {analysis.demandShapeAhead.slice(0, 2).map((bullet, i) => (
                      <li key={i} className="text-report-ink text-xs leading-relaxed flex items-start gap-2">
                        <span className="text-report-crimson mt-1 text-[11px]">•</span>
                        <span>{highlightPhases(bullet)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>


            <div className="border-t border-report-crimson/10 bg-report-paper-bright px-6 py-4">
              <div className="text-[11px] uppercase tracking-wider font-bold text-report-crimson mb-4">
                Strategic Response Plan
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(() => {
                  const currentIdx = effectiveTrends?.currentMonthIndex ?? currentMonth;
                  const currentPhaseForTab = selectedTrend?.data?.find(d => d.isCurrent)?.phase || 'Hold';
                  
                  // Scan ahead to find the next phase change (look through all 12 months)
                  let upcomingPhase: string | null = null;
                  let upcomingMonthName: string | null = null;
                  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                  
                  for (let i = 1; i <= 12; i++) {
                    const futureIdx = (currentIdx + i) % 12;
                    const futurePhase = selectedTrend?.data?.[futureIdx]?.phase;
                    if (futurePhase && futurePhase !== currentPhaseForTab) {
                      upcomingPhase = futurePhase;
                      upcomingMonthName = monthNames[futureIdx];
                      break;
                    }
                  }
                  
                  const responseOptionsToShow = [
                    { strategy: currentPhaseForTab, actions: phaseActions[currentPhaseForTab] || [], timing: 'now', monthLabel: null },
                    ...(upcomingPhase
                      ? [{ strategy: upcomingPhase, actions: phaseActions[upcomingPhase] || [], timing: 'upcoming', monthLabel: upcomingMonthName }] 
                      : [])
                  ];
                  
                  return responseOptionsToShow.slice(0, 2).map((option: any, idx) => {
                    const phase = option.strategy;
                    const actions = option.actions;
                    const timing = option.timing || (idx === 0 ? 'now' : 'upcoming');
                    const isNow = timing === 'now';
                    
                    return (
                      <div 
                        key={idx} 
                        className={`rounded-lg p-4 ${
                          isNow 
                            ? 'bg-white border-2 border-report-crimson/20 shadow-sm' 
                            : 'bg-report-paper border border-report-ink/10'
                        }`}
                      >
                        <div className="flex items-center gap-4 mb-4">
                          {/* Task #4542 — phase-square fill uses the AA-safe phase ink so the
                              white initial passes 4.5:1 (base steel/gold/slate fills were 2.5–4.4:1). */}
                          <div 
                            className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm"
                            style={{ backgroundColor: REPORT_PHASE_INK_COLORS[phase as keyof typeof REPORT_PHASE_INK_COLORS] || REPORT_COLORS.inkMuted }}
                          >
                            {phase.charAt(0)}
                          </div>
                          <div>
                            <div className={`text-[11px] uppercase tracking-wider font-bold ${
                              isNow ? 'text-report-crimson' : 'text-report-ink-muted'
                            }`}>
                              {isNow ? 'Current Phase' : `Expected${option.monthLabel ? ` (${option.monthLabel})` : ''}`}
                            </div>
                            <div className="text-base font-bold text-report-ink">{phase}</div>
                          </div>
                        </div>
                        <div className="text-[11px] uppercase tracking-wider text-report-ink-muted mb-2">Response Options</div>
                        <div className="space-y-4">
                          {actions.slice(0, 2).map((action: string, i: number) => {
                            const parts = action.split(/\*\*(.*?)\*\*/g);
                            return (
                              <div 
                                key={i} 
                                className={`text-sm leading-relaxed pl-4 border-l-2 ${
                                  isNow ? 'border-report-crimson/30 text-report-ink' : 'border-report-ink/15 text-report-ink-muted'
                                }`}
                              >
                                {parts.map((part, j) => 
                                  j % 2 === 1 
                                    ? <strong key={j} className="font-bold">{part}</strong>
                                    : <span key={j}>{part}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>
        </>
      )}
    </Slide>
  );
}
