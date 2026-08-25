/**
 * Ads OS report theme helpers (port of the bundle's frontend/src/theme.ts) —
 * score→color thresholds and per-status colors/labels, matching the server's
 * standalone HTML export (reportHtml.ts) so the web report and the exported
 * file always agree.
 */

import type { Status } from "./types";

/** Band thresholds: ≥75 green · ≥60 amber · ≥40 orange · else red. */
export function scoreColor(score: number): string {
  if (score >= 75) return "#16a34a";
  if (score >= 60) return "#ca8a04";
  if (score >= 40) return "#ea7317";
  return "#b91c1c";
}

export const statusMeta: Record<Status, { color: string; label: string }> = {
  good: { color: "#16a34a", label: "Good" },
  okay: { color: "#ca8a04", label: "Okay" },
  bad: { color: "#ea7317", label: "Bad" },
  critical: { color: "#b91c1c", label: "Critical" },
  na: { color: "#b0aca6", label: "N/A" },
};

/**
 * Same band thresholds as scoreColor, but returning the module's CSS variables
 * so on-screen renders follow the app theme (Task #4377: the global `.dark`
 * class flips the house tokens these module variables alias; adsOs.css keeps
 * only module-scoped dark deltas). The light values of --green/--yellow/
 * --orange/--red equal the fixed hexes above, and the standalone HTML export
 * keeps using scoreColor/statusMeta directly — web/export parity is unchanged.
 */
export function scoreColorVar(score: number): string {
  if (score >= 75) return "var(--green)";
  if (score >= 60) return "var(--yellow)";
  if (score >= 40) return "var(--orange)";
  return "var(--red)";
}

/** statusMeta colors as theme variables (same mapping; labels stay in statusMeta). */
export const statusColorVar: Record<Status, string> = {
  good: "var(--green)",
  okay: "var(--yellow)",
  bad: "var(--orange)",
  critical: "var(--red)",
  na: "var(--muted)",
};
