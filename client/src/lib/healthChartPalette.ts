// Admin health-dashboard categorical chart series (Task #4481).
//
// DECISION: the per-entry-point ("per-worker") delay chart draws up to eight
// simultaneous lines whose ONLY job is to be mutually distinguishable — a true
// categorical data-viz series, not status semantics. The internal-OS token set
// (primary + 4 status colors) cannot supply eight distinguishable hues, so the
// rotation is promoted here from inline hexes in
// components/admin/health/dashboard/charts.tsx as a documented token-adjacent
// series module (same exception class as client/src/lib/leadSourceColors.ts).
// Values preserved exactly from the pre-promotion rotation; slot 1 stays the
// brand primary token so the first/solo line reads as brand chrome.
//
// Semantic series in the same charts (warning/critical thresholds, timeout,
// delayed, pool-wait) do NOT live here — they map to the status tokens
// (--status-warn/--status-critical/--status-info) directly in charts.tsx.
export const HEALTH_SERIES_VIOLET = "#7c3aed"; // bg-saturation series — categorical third hue alongside the warn/critical token pair

export const PER_WORKER_LINE_COLORS = [
  "hsl(var(--primary))",
  "#0891b2",
  "#d97706",
  HEALTH_SERIES_VIOLET,
  "#dc2626",
  "#15803d",
  "#2563eb",
  "#db2777",
] as const;
