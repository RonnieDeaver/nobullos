/**
 * Task #4278 — Engine funnel + report currency single source (audit §8.5).
 *
 * Engine Health and Revenue Leak both render the monthly
 * leads → consults → cases pipeline. Before this module each slide
 * recomputed its own copy (and Engine Health priced revenue with a
 * hard-coded $5K average case value), so the two slides could — and did —
 * drift apart ("$120k" vs "$212K", consults > leads rendered silently).
 *
 * Rule (same pattern as shared/reportMetrics.ts): both slides consume ONE
 * computed EngineFunnel stamped on the derived view — stages, est. top-line
 * revenue, and monotonicity breaks are computed HERE and nowhere else, so
 * the slides reconcile by construction. The deck-wide currency format
 * ("$212K", uppercase K) also lives here.
 */

export type EngineFunnelStageKey = "leads" | "consults" | "cases";

export interface EngineFunnelStage {
  key: EngineFunnelStageKey;
  /** Entered count; null = not entered → renders the deck's "No data". */
  value: number | null;
}

/** A later stage exceeding the nearest earlier valued stage (funnel-math violation). */
export interface EngineFunnelBreak {
  from: EngineFunnelStageKey;
  to: EngineFunnelStageKey;
}

export interface EngineFunnel {
  stages: [EngineFunnelStage, EngineFunnelStage, EngineFunnelStage];
  /**
   * Est. top-line revenue = entered cases × entered avg case value.
   * Null unless BOTH inputs were entered — never priced off a fabricated
   * average (the retired Engine Health strip hard-coded $5,000).
   */
  estTopLineRevenue: number | null;
  /** Non-monotonic steps; a funnel render MUST annotate these (§8.5). */
  breaks: EngineFunnelBreak[];
}

export interface EngineFunnelInput {
  totalLeads: number;
  totalConsults: number;
  totalCases: number;
  hasConsultsData: boolean;
  hasCasesData: boolean;
  avgCaseValue: number;
  hasAvgCaseValueData: boolean;
}

export interface FunnelBreakIndices {
  fromIndex: number;
  toIndex: number;
}

/**
 * Indices of non-monotonic steps in an ordered funnel: each valued stage is
 * compared against the NEAREST EARLIER valued stage (nulls — "No data" —
 * are skipped, never treated as zero). A step where the later value exceeds
 * the earlier one is a break the renderer must annotate.
 */
export function findNonMonotonicBreaks(
  values: ReadonlyArray<number | null | undefined>,
): FunnelBreakIndices[] {
  const breaks: FunnelBreakIndices[] = [];
  let prevIndex = -1;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null || value === undefined) continue;
    if (prevIndex >= 0 && value > (values[prevIndex] as number)) {
      breaks.push({ fromIndex: prevIndex, toIndex: i });
    }
    prevIndex = i;
  }
  return breaks;
}

/**
 * The annotation line a funnel renders at a non-monotonic step (§8.5:
 * "refuses to render non-monotonic stages without an annotation").
 * Monthly report slides pass period="month" → "Consults include prior-month
 * leads"; period-agnostic funnels (CEO Pulse charts) default to
 * "prior-period".
 */
export function funnelCarryoverNote(
  fromLabel: string,
  toLabel: string,
  period: "month" | "period" = "period",
): string {
  return `${toLabel} include prior-${period} ${fromLabel.toLowerCase()}`;
}

export function computeEngineFunnel(input: EngineFunnelInput): EngineFunnel {
  const stages: EngineFunnel["stages"] = [
    // Leads are summed from the marketing section (0 is a real total), so the
    // stage always carries a value; consults/cases follow the #3688 presence
    // rule — a never-entered metric is null, not a fabricated 0.
    { key: "leads", value: input.totalLeads },
    { key: "consults", value: input.hasConsultsData ? input.totalConsults : null },
    { key: "cases", value: input.hasCasesData ? input.totalCases : null },
  ];
  const breaks = findNonMonotonicBreaks(stages.map((s) => s.value)).map(
    ({ fromIndex, toIndex }): EngineFunnelBreak => ({
      from: stages[fromIndex].key,
      to: stages[toIndex].key,
    }),
  );
  const estTopLineRevenue =
    input.hasCasesData && input.hasAvgCaseValueData
      ? input.totalCases * input.avgCaseValue
      : null;
  return { stages, estTopLineRevenue, breaks };
}

/**
 * Deck-wide currency format — "$212K" / "$1.3M", uppercase K (§8.5 one value
 * format; the lowercase "$120k" variant is retired). Moved verbatim from
 * RevenueLeakSlide.
 *
 * Deliberate (Task #2776): `precise` is only used for the user-entered avg
 * case value, which must render EXACTLY as entered ("$5,250.50", never a
 * "$5.3K" compaction). Computed aggregates (unrealized revenue, est.
 * top-line revenue) stay compact for headline readability.
 */
export function formatReportCurrency(amount: number, precise: boolean = false): string {
  if (precise) {
    return `$${amount.toLocaleString("en-US", {
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `$${Math.round(amount / 1000)}K`;
  return `$${amount.toLocaleString()}`;
}
