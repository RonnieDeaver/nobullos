/**
 * Task #4276 (§8.7-3 client-report design audit) — pure derivation of what
 * the REPORT slide's "By The Numbers" card shows. The audit's residual for
 * the CEO Pulse slide: cap the card at TWO charts plus ONE insight
 * paragraph, with per-chart source attribution kept legible.
 *
 * The AI writes each chart's `description` in the pinned prompt shape
 * "Source: <name>. <why it matters prose>" (server/routes/reports.ts). On
 * the report slide we split that: the "Source: <name>" attribution stays
 * with its chart (the legible source line), and the prose of the FIRST
 * chart that has any becomes the slide's single insight paragraph. Prose
 * beyond that one paragraph is deliberately dropped on this surface — the
 * standalone /pulse share page still renders every chart with its full
 * description (it is the full brief, not a report slide, so the cap does
 * not apply there).
 */
import type { CeoPulseChart } from "./CeoPulseChartRenderer";

/** §8.7-3 — the report slide renders at most this many charts. */
export const CEO_PULSE_SLIDE_MAX_CHARTS = 2;

/**
 * Split an AI chart description into its "Source: <name>" attribution and
 * the insight prose that follows. Handles source names containing dots
 * (e.g. domains) by requiring a sentence boundary (period + whitespace)
 * before the prose. Unparseable descriptions come back as insight-only so
 * nothing is silently lost.
 */
export function splitChartSourceInsight(description?: string): {
  source: string | null;
  insight: string | null;
} {
  const text = (description ?? "").trim();
  if (!text) return { source: null, insight: null };
  const m = text.match(/^(sources?\s*:\s*.+?)\.\s+(\S[\s\S]*)$/i);
  if (m) {
    const insight = m[2].trim();
    return { source: m[1].trim(), insight: insight.length > 0 ? insight : null };
  }
  if (/^sources?\s*:/i.test(text)) {
    // Attribution-only description ("Source: X." with no prose).
    return { source: text.replace(/\.\s*$/, ""), insight: null };
  }
  return { source: null, insight: text };
}

export type CeoPulseSlideContent = {
  /** Capped charts with descriptions rewritten to source-attribution lines. */
  charts: CeoPulseChart[];
  /** The slide's single insight paragraph (null when no chart carries prose). */
  insight: string | null;
};

export function deriveCeoPulseSlideContent(
  allCharts: CeoPulseChart[] | undefined | null,
): CeoPulseSlideContent {
  const capped = (allCharts ?? []).filter(Boolean).slice(0, CEO_PULSE_SLIDE_MAX_CHARTS);

  // The first chart with any prose supplies the slide's one insight paragraph.
  let insight: string | null = null;
  let promotedIndex = -1;
  for (let i = 0; i < capped.length; i++) {
    const { insight: chartInsight } = splitChartSourceInsight(capped[i].description);
    if (chartInsight) {
      insight = chartInsight;
      promotedIndex = i;
      break;
    }
  }

  const charts = capped.map((chart, i) => {
    const { source } = splitChartSourceInsight(chart.description);
    // Parseable: keep only the attribution with the chart.
    if (source) return { ...chart, description: source };
    // Unparseable but promoted wholesale to the insight paragraph: drop the
    // per-chart copy so the same text never renders twice.
    if (i === promotedIndex) return { ...chart, description: undefined };
    // Unparseable and not promoted: keep as-is — it is the only attribution
    // this chart has.
    return chart;
  });

  return { charts, insight };
}
