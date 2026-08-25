/**
 * Task #2587 — single source of truth for the heatmap rank-band palette.
 *
 * The rank-band colors (Top 3 / Top 10 / Top 20 / Beyond 20 / Unranked, incl.
 * the unranked slate) were duplicated across at least three places:
 *   - server `RANK_COLORS` in `server/services/heatmapService.ts` (map fill data),
 *   - the `RANK_LEGEND` swatches in `client/src/components/InteractiveHeatmap.tsx`,
 *   - `HEATMAP_UNRANKED_FILL_COLOR` in `client/src/components/heatmapPaint.ts`,
 * plus the distribution-band colors in the report/dashboard components
 * (`PublicReport.tsx`, `LocalDominanceDashboard.tsx`, `LocalDominanceMetrics.tsx`).
 *
 * If one was edited and the others weren't, the map fill, the legend swatch,
 * and the report colors silently diverged. Consolidating them here guarantees
 * they stay in lockstep.
 */

/** Canonical rank-band palette keyed by ranking tier. */
export const HEATMAP_RANK_COLORS = {
  top3: "#0d6b3d",
  top10: "#4ade80",
  top20: "#e88c30",
  beyond20: "#c53030",
  unranked: "#94a3b8",
} as const;

/** Period-over-period movement palette (improved / stable / declined). */
export const HEATMAP_MOVEMENT_COLORS = {
  improved: "#0d9448",
  stable: "#64748b",
  declined: "#c53030",
} as const;

/**
 * The unranked slate, exported separately because it doubles as the TERMINAL
 * literal fallback in the MapLibre fill-color coalesce: a cell carrying neither
 * a rankColor nor a color (old/partial cache, or a snapshot lacking position
 * data) would otherwise resolve to null and MapLibre would paint the cell BLACK
 * — the silent "broken heatmap" look. Falling back to this explicit slate
 * guarantees a cell is never invisible/black.
 */
export const HEATMAP_UNRANKED_FILL_COLOR = HEATMAP_RANK_COLORS.unranked;

/**
 * Distribution-band palette as consumed by the report/dashboard surfaces, which
 * label the bands top3 / band4to10 / band11to20 / outOfTop20. These map 1:1
 * onto the canonical rank tiers above so the report band colors and the map
 * fill cannot drift.
 */
export const HEATMAP_DISTRIBUTION_BAND_COLORS = {
  top3: HEATMAP_RANK_COLORS.top3,
  band4to10: HEATMAP_RANK_COLORS.top10,
  band11to20: HEATMAP_RANK_COLORS.top20,
  outOfTop20: HEATMAP_RANK_COLORS.beyond20,
} as const;

/** Ordered legend entries (strongest → weakest) for the map legend swatches. */
export const HEATMAP_RANK_LEGEND: ReadonlyArray<{ label: string; color: string }> = [
  { label: "Top 3", color: HEATMAP_RANK_COLORS.top3 },
  { label: "Top 10", color: HEATMAP_RANK_COLORS.top10 },
  { label: "Top 20", color: HEATMAP_RANK_COLORS.top20 },
  { label: "20+", color: HEATMAP_RANK_COLORS.beyond20 },
  { label: "Unranked", color: HEATMAP_RANK_COLORS.unranked },
];
