// Chart-targeting helpers for the CEO Pulse "Refine This Visual" flow.
//
// Extracted from server/routes/reports.ts so the deterministic targeting
// guard (the fix that stopped Refine from editing the wrong chart by number)
// can be unit-tested without an HTTP request or an OpenAI round-trip.

// Deterministic, key-order-independent stringify so two semantically
// identical chart objects compare equal even if the AI emitted their keys
// in a different order than they were originally stored.
export function stableStringify(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

// Parse a 1-based chart reference out of the user's refine request, matching
// the exact numbering the UI shows ("Chart 3" / "{{chart-3}}"). Returns the
// 1-based chart number, or null when the user didn't reference one by number.
export function parseChartOrdinal(msg: string): number | null {
  if (!msg) return null;
  const text = String(msg).toLowerCase();
  let m = text.match(/\{\{\s*chart-(\d+)\s*\}\}/);
  if (m) return parseInt(m[1], 10);
  m = text.match(/\bchart\s*#?\s*(?:number\s*)?(\d+)\b/);
  if (m) return parseInt(m[1], 10);
  m = text.match(/\b(\d+)(?:st|nd|rd|th)\s+chart\b/);
  if (m) return parseInt(m[1], 10);
  const words: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  m = text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+chart\b/);
  if (m) return words[m[1]] ?? null;
  return null;
}

export interface ChartTargetingInput {
  message: string;
  graphsEnabled: boolean;
  // The charts as they were stored before this edit (currentAnalysis.charts).
  inputCharts: any[];
  // The candidate charts produced from the AI response after validation.
  charts: any[];
  // Whether the AI response actually produced a usable chart set.
  chartWasModified: boolean;
}

export interface ChartTargetingResult {
  // The charts to persist — reverted to inputCharts when the edit was
  // mis-targeted and must not be saved.
  charts: any[];
  chartWasModified: boolean;
  // Set to the user-referenced chart number when the edit failed to land on
  // the named chart (count drift or a neighbor changed).
  targetingMismatchNumber: number | null;
  // Set to {number,title} when the edit correctly landed on the named chart.
  targetedChart: { number: number; title: string } | null;
  // True when the edit was a pure reorder — the same chart objects returned
  // in a new order (same count, same contents, changed sequence).
  reordered: boolean;
}

// True when `b` contains exactly the same chart objects as `a` (same count,
// same multiset of contents) but in a different sequence. An identical array
// returns false — that's a no-op, not a reorder. Key-order-independent via
// stableStringify so an AI that re-emits the same chart with reordered keys
// still compares equal.
export function isPureChartPermutation(a: any[], b: any[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length === 0 || a.length !== b.length) return false;
  const sa = a.map(stableStringify).sort();
  const sb = b.map(stableStringify).sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  // Same multiset — require the actual sequence to differ so an unchanged
  // array isn't mistaken for a reorder.
  for (let i = 0; i < a.length; i++) {
    if (stableStringify(a[i]) !== stableStringify(b[i])) return true;
  }
  return false;
}

// Server-side chart-targeting guard. When the user references a chart by its
// canonical 1-based number ("chart 3" / "{{chart-3}}"), make sure the edit
// actually landed on THAT chart and not a neighbor. Charts render in array
// order, so position i is "Chart i+1". If the AI edited a different slot (the
// bug), or drifted the count on what was an in-place edit, we refuse to save
// the mis-targeted result so the caller can report honestly instead of
// silently overwriting the wrong chart.
export function evaluateChartTargeting(input: ChartTargetingInput): ChartTargetingResult {
  const { message, graphsEnabled, inputCharts } = input;
  let charts = input.charts;
  let chartWasModified = input.chartWasModified;

  const targetChartNumber = graphsEnabled ? parseChartOrdinal(message) : null;
  // A structural request (add / remove / merge / split) legitimately changes
  // the chart count, so the in-place positional guard must not run for it.
  const structuralChartRequest = /\b(add|adding|create|creating|new|remove|removing|delete|deleting|drop|dropping|merge|merging|combine|combining|consolidate|consolidating|split|splitting)\b/i.test(message || "");
  // A reorder request ("reorder", "move chart 2 above chart 1", "swap…")
  // legitimately shifts chart positions while keeping every chart's contents
  // intact, so the in-place positional guard must not refuse it.
  const reorderChartRequest = /\b(reorder|re-?order|reordering|rearrange|re-?arrange|rearranging|reorganize|reorganise|reorganizing|reposition|repositioning|move|moving|swap|swapping|switch|switching|shuffle|shuffling|flip)\b/i.test(message || "");
  let targetingMismatchNumber: number | null = null;
  let targetedChart: { number: number; title: string } | null = null;

  // First-class reorder support: when the user asked to reorder/move charts and
  // the AI returned the SAME chart objects in a new order (a pure permutation),
  // accept the new order as-is. Requiring both the reorder intent AND a true
  // permutation keeps this from becoming a blanket bypass — a reorder request
  // whose response actually edited a chart's contents is not a permutation and
  // still falls through to the positional guard below.
  if (
    graphsEnabled &&
    chartWasModified &&
    reorderChartRequest &&
    isPureChartPermutation(inputCharts, charts)
  ) {
    return { charts, chartWasModified, targetingMismatchNumber: null, targetedChart: null, reordered: true };
  }

  if (
    graphsEnabled &&
    chartWasModified &&
    targetChartNumber !== null &&
    !structuralChartRequest &&
    targetChartNumber >= 1 &&
    targetChartNumber <= inputCharts.length
  ) {
    const targetIdx = targetChartNumber - 1;
    if (charts.length !== inputCharts.length) {
      // Count drifted on an in-place edit — positional targeting can no
      // longer be trusted, so don't save it.
      targetingMismatchNumber = targetChartNumber;
      charts = inputCharts;
      chartWasModified = false;
      console.warn(`[CEO Pulse Refine] Targeting guard: user referenced Chart ${targetChartNumber} but chart count changed (${inputCharts.length} → ${charts.length}); refusing mis-targeted edit.`);
    } else {
      const changedIdx: number[] = [];
      for (let i = 0; i < charts.length; i++) {
        if (stableStringify(charts[i]) !== stableStringify(inputCharts[i])) changedIdx.push(i);
      }
      const targetChanged = changedIdx.includes(targetIdx);
      if (!targetChanged && changedIdx.length > 0) {
        // The exact bug: a chart OTHER than the one the user named changed.
        const wrong = changedIdx.map((i) => i + 1).join(", ");
        targetingMismatchNumber = targetChartNumber;
        charts = inputCharts;
        chartWasModified = false;
        console.warn(`[CEO Pulse Refine] Targeting guard: user referenced Chart ${targetChartNumber} but the edit changed Chart(s) ${wrong}; refusing mis-targeted edit.`);
      } else if (targetChanged) {
        targetedChart = { number: targetChartNumber, title: String(charts[targetIdx]?.title || "(untitled)") };
      }
    }
  }

  return { charts, chartWasModified, targetingMismatchNumber, targetedChart, reordered: false };
}

// Build the user-facing confirmation/refusal message for the targeting
// outcomes. Returns null when no targeting branch applies, so the caller can
// fall through to its other message branches.
export function buildTargetingMessage(result: Pick<ChartTargetingResult, "targetingMismatchNumber" | "targetedChart" | "reordered">): string | null {
  if (result.targetingMismatchNumber !== null) {
    const n = result.targetingMismatchNumber;
    return `I didn't change anything because the edit didn't land on Chart ${n} — to avoid editing the wrong chart, nothing was saved. Please try again and reference it exactly as the placeholder panel shows it (e.g. "Chart ${n}" or "{{chart-${n}}}").`;
  }
  if (result.targetedChart !== null) {
    return `Updated Chart ${result.targetedChart.number} ("${result.targetedChart.title}").`;
  }
  if (result.reordered) {
    return `Reordered the charts as requested.`;
  }
  return null;
}
