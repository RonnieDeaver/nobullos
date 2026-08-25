// Service-desk ClickUp status → color series (Task #4481).
//
// DECISION: ClickUp's own status colors are canonical for this surface. The
// service desk mirrors a ClickUp list 1:1 — operators work the same tickets
// inside ClickUp itself, where each status wears exactly these colors, so
// re-mapping them to the internal-OS status tokens would break the visual
// vocabulary operators already know (and the OS token set has no analog for
// most of these categorical hues: sky, mint, violet, orange…).
//
// Promoted here from inline hexes in pages/admin/ServiceDeskReports.tsx so the
// series has ONE documented home; data-viz categorical series are
// token-adjacent constants (same exception class as
// client/src/lib/leadSourceColors.ts — see the index.css report-layer note).
// Values preserved exactly from the pre-promotion map.
export const SERVICE_DESK_STATUS_COLORS: Record<string, string> = {
  "submitted": "#94a3b8",
  "scheduled": "#60a5fa",
  "in progress": "#34d399",
  "needs information": "#fbbf24",
  "waiting on account manager": "#f97316",
  "waiting on client": "#f97316",
  "waiting on approval": "#f97316",
  "blocked": "#ef4444",
  "quality review": "#a78bfa",
  "delivered": "#22c55e",
  "closed": "#64748b",
  "reopened": "#fb923c",
  "out of scope": "#475569",
  "canceled": "#475569",
  "duplicate": "#475569",
};

/** Neutral gray for statuses ClickUp introduces that we haven't mapped yet
 *  (matches the "submitted" neutral, the series' own resting gray). */
export const SERVICE_DESK_STATUS_FALLBACK = "#94a3b8";
