import { motion, useReducedMotion } from "framer-motion";
import { findNonMonotonicBreaks, funnelCarryoverNote } from "@shared/reportFunnel";

type FunnelStage = {
  label: string;
  value: number;
  color?: string;
};

type FunnelGroup = {
  label: string;
  colorScheme?: "light" | "dark";
  stages: FunnelStage[];
};

type FunnelAnnotation = {
  afterStage: number;
  text: string;
};

type FunnelChartProps = {
  groups: FunnelGroup[];
  annotations?: FunnelAnnotation[];
  subtitle?: string;
  animate?: boolean;
  /** Task #4414 — 'report' swaps the stock amber annotation callout and ink
   *  classes for `--report-*` token classes inside the public client report
   *  (`.report-surface`). Omit for the internal OS surface. */
  variant?: 'report';
  /** Report stage ramp (light→dark, stage i clamps to the last entry). When
   *  set with variant='report' it deterministically replaces BOTH color
   *  schemes and any AI-supplied per-stage colors, so stock/non-token fills
   *  never reach the report while the white stage labels keep AA (every
   *  entry is contrast-vetted in reportTokens). */
  reportStageColors?: readonly string[];
};

const LIGHT_COLORS = ["#D4A5A7", "#C48B8E", "#B47275", "#A4585C", "#944043"];
const DARK_COLORS = ["#8B2E31", "#7A2729", "#6B2023", "#5C191C", "#4D1316"];

function getStagePct(value: number, maxValue: number): number {
  if (maxValue <= 0) return 30;
  return Math.max(30, (value / maxValue) * 100);
}

function AnnotationCallout({ text, animate, delay, report }: { text: string; animate: boolean; delay: number; report: boolean }) {
  return (
    <motion.div
      initial={animate ? { opacity: 0, scale: 0.9 } : {}}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, delay }}
      className="flex items-center justify-center gap-1.5 py-1"
    >
      {/* Report mode rides text-report-gold-ink + currentColor strokes so the
          callout stays in the report's gold family instead of stock amber. */}
      <div className={`flex items-center gap-1.5 rounded-full px-3 py-1 shadow-sm border ${report ? 'bg-report-eggshell border-report-gold-ink/30 text-report-gold-ink' : 'bg-[#FEF3C7] border-[#F59E0B]/30'}`}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
          <path d="M7 1L7 10M7 10L4 7M7 10L10 7" stroke={report ? 'currentColor' : '#D97706'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="7" cy="12.5" r="1" fill={report ? 'currentColor' : '#D97706'}/>
        </svg>
        <span className={`text-[11px] font-semibold whitespace-nowrap ${report ? '' : 'text-[#92400E]'}`}>{text}</span>
      </div>
    </motion.div>
  );
}

function StageBlock({ stage, color, widthPct, stageHeight, isLast, animate, delay, groupLabel, stageIndex }: {
  stage: FunnelStage;
  color: string;
  widthPct: number;
  stageHeight: number;
  isLast: boolean;
  animate: boolean;
  delay: number;
  groupLabel: string;
  stageIndex: number;
}) {
  return (
    <motion.div
      initial={animate ? { opacity: 0, scaleX: 0 } : {}}
      animate={{ opacity: 1, scaleX: 1 }}
      transition={{ duration: 0.4, delay }}
      className="relative flex items-center justify-center"
      style={{
        width: `${widthPct}%`,
        minWidth: "60px",
        height: `${stageHeight}px`,
        backgroundColor: color,
        clipPath: !isLast
          ? "polygon(0 0, 100% 0, 96% 100%, 4% 100%)"
          : "polygon(4% 0, 96% 0, 50% 100%)",
      }}
      data-testid={`funnel-stage-${groupLabel}-${stageIndex}`}
    >
      <div className="text-white text-center px-2 z-10">
        <div className="text-[11px] font-medium leading-tight truncate max-w-full">{stage.label}</div>
        <div className="text-xs font-bold">{stage.value.toLocaleString()}</div>
      </div>
    </motion.div>
  );
}

export default function FunnelChart({ groups, annotations, subtitle, animate = true, variant, reportStageColors }: FunnelChartProps) {
  const report = variant === 'report';
  const reportRamp = report && reportStageColors && reportStageColors.length > 0 ? reportStageColors : null;
  // Honor OS-level reduced motion (same pattern as CeoPulseVisual): render
  // the final state directly instead of the entrance animation.
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = animate && !prefersReducedMotion;
  const allValues = groups.flatMap(g => g.stages.map(s => s.value));
  const maxValue = Math.max(...allValues, 1);
  const maxStages = Math.max(...groups.map(g => g.stages.length));
  const stageHeight = maxStages <= 4 ? 44 : 36;

  const isSideBySide = groups.length > 1;

  const annotationsByStage = new Map<number, FunnelAnnotation[]>();
  if (annotations) {
    for (const ann of annotations) {
      if (ann.afterStage >= 0 && ann.afterStage < maxStages - 1) {
        const existing = annotationsByStage.get(ann.afterStage) || [];
        existing.push(ann);
        annotationsByStage.set(ann.afterStage, existing);
      }
    }
  }

  // Task #4278 (§8.5) — a funnel must not render non-monotonic stages
  // silently: when a later stage exceeds the nearest earlier one and the
  // caller registered no annotation at that boundary, inject the carry-over
  // explanation so the "impossible" shape is always accounted for.
  for (const group of groups) {
    for (const brk of findNonMonotonicBreaks(group.stages.map((s) => s.value))) {
      if (!annotationsByStage.has(brk.fromIndex)) {
        annotationsByStage.set(brk.fromIndex, [
          {
            afterStage: brk.fromIndex,
            text: funnelCarryoverNote(
              group.stages[brk.fromIndex].label,
              group.stages[brk.toIndex].label,
            ),
          },
        ]);
      }
    }
  }

  const rows: React.ReactNode[] = [];

  for (let stageIdx = 0; stageIdx < maxStages; stageIdx++) {
    rows.push(
      <div key={`stage-row-${stageIdx}`} className={`flex ${isSideBySide ? "gap-6" : "justify-center"}`}>
        {groups.map((group, gi) => {
          const colors = group.colorScheme === "light" ? LIGHT_COLORS : DARK_COLORS;
          const stage = group.stages[stageIdx];
          if (!stage) {
            return <div key={gi} className="flex-1 min-w-0" />;
          }
          const widthPct = getStagePct(stage.value, maxValue);
          const color = reportRamp
            ? reportRamp[Math.min(stageIdx, reportRamp.length - 1)]
            : stage.color || colors[stageIdx % colors.length];
          const isLast = stageIdx === group.stages.length - 1;

          return (
            <div key={gi} className="flex-1 min-w-0 flex flex-col items-center" style={{ marginTop: stageIdx > 0 ? "-2px" : 0 }}>
              <StageBlock
                stage={stage}
                color={color}
                widthPct={widthPct}
                stageHeight={stageHeight}
                isLast={isLast}
                animate={shouldAnimate}
                delay={stageIdx * 0.1}
                groupLabel={group.label}
                stageIndex={stageIdx}
              />
            </div>
          );
        })}
      </div>
    );

    const stageAnnotations = annotationsByStage.get(stageIdx);
    if (stageAnnotations) {
      stageAnnotations.forEach((ann, ai) => {
        rows.push(
          <div key={`ann-row-${stageIdx}-${ai}`} data-testid={`funnel-annotation-${stageIdx}-${ai}`}>
            <AnnotationCallout
              text={ann.text}
              animate={shouldAnimate}
              delay={0.5 + stageIdx * 0.1}
              report={report}
            />
          </div>
        );
      });
    }
  }

  return (
    <div className="w-full" data-testid="chart-funnel">
      {isSideBySide && (
        <div className="flex gap-6 mb-3">
          {groups.map((group, gi) => (
            <div key={gi} className="flex-1 min-w-0">
              <p className={`text-xs font-semibold text-center uppercase tracking-wide ${report ? 'text-report-ink' : 'text-[#333333]/80'}`} data-testid={`text-funnel-group-${group.label}`}>
                {group.label}
              </p>
            </div>
          ))}
        </div>
      )}

      {!isSideBySide && groups[0] && (
        <p className={`text-xs font-semibold text-center mb-3 uppercase tracking-wide ${report ? 'text-report-ink' : 'text-[#333333]/80'}`} data-testid={`text-funnel-group-${groups[0].label}`}>
          {groups[0].label}
        </p>
      )}

      {rows}

      {subtitle && (
        <p className={`text-xs text-center mt-3 italic ${report ? 'text-report-ink-muted' : 'text-[#333333]/50'}`} data-testid="text-funnel-subtitle">
          {subtitle}
        </p>
      )}
    </div>
  );
}
