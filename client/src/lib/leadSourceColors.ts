// Lead-source data-viz series — internal OS surfaces (Task #4360).
//
// Categorical chart palette for the lead-source breakdown pie on the internal
// report form (ReportForm.tsx). Promoted here from inline hexes so the series
// has ONE documented home; data-viz categorical series are token-adjacent
// constants (same exception class as the public report's derive.ts series —
// see the index.css report-layer note). The PUBLIC report renders its own
// series from the report token layer (publicReport/reportTokens.ts
// REPORT_COLORS) — deliberately NOT unified: the internal form predates the
// report redesign and keeps its lighter pastel series for parity.
export const LEAD_SOURCE_COLORS = {
  gbp: "#FF6B6B",
  googleAds: "#60A5FA",
  lsa: "#4ADE80",
  webinar: "#FBBF24",
  other: "#E5E7EB",
} as const;
