// MCU capacity-status severity scale — shared map + legend source (Task #4681).
//
// ONE home for the four-tier capacity scale rendered by the shared
// UsStateMap component, the zoomed single-state view (StateZoomMap — dot
// fills/gradients/glows + inline legend, Task #4704) and their hosting
// page's sidebar legend / status-filter dots (McuDashboard). Promoted from
// inline light-era
// literals (`#22c55e/#eab308/#f97316/#ef4444` in the map, `bg-*-500` dots on
// the page) so the swatches can never drift from the rendered map scale
// again — same convention as lib/leadSourceColors.ts.
//
// Values are CSS-token references, not hexes: SVG `fill` attributes and
// inline `backgroundColor` styles resolve `hsl(var(--…))` per theme, which
// is the only way inline paints can follow dark mode (the Tailwind `.dark`
// compat remap can't reach inline fills). The ramp matches the rest of the
// MCU dashboard's capacity tiers (bars/badges, Task #4662): an intensity
// ramp ok → warn/60 → warn → critical, so Filling vs Tight differ by
// lightness rather than hue alone (colorblind-safer) and every tier keeps
// AA-adjacent contrast in BOTH themes.
export const CAPACITY_STATUS_COLORS: Record<
  "green" | "yellow" | "orange" | "red",
  string
> = {
  green: "hsl(var(--status-ok))",
  yellow: "hsl(var(--status-warn) / 0.6)",
  orange: "hsl(var(--status-warn))",
  red: "hsl(var(--status-critical))",
} as const;

/**
 * Legend / filter entries in severity order. `key` matches the map's
 * `StateData["status"]` values (also the page's status-filter keys);
 * `colorKey` indexes CAPACITY_STATUS_COLORS.
 */
export const CAPACITY_STATUS_LEGEND = [
  { key: "Open", colorKey: "green", label: "Open (<35%)" },
  { key: "Filling", colorKey: "yellow", label: "Filling (35-60%)" },
  { key: "Tight", colorKey: "orange", label: "Tight (60-80%)" },
  { key: "Saturated", colorKey: "red", label: "Saturated (≥80%)" },
] as const;

/**
 * Glow variant of CAPACITY_STATUS_COLORS (Task #4704) — the soft halo ring
 * StateZoomMap paints behind each market-zone dot. Same status tokens at low
 * alpha so halos track their dots through theme switches. Yellow's halo is
 * softer because its *fill* tier is already the 60%-alpha warn step — a
 * full-strength warn halo would read as Tight's.
 *
 * Deliberately NO stroke/edge variant: dot rims use the shared card-ring
 * convention (`stroke="hsl(var(--card))"`, same as UsStateMap's state
 * outlines), and gradient depth comes from a same-token stopOpacity vignette
 * — deriving "darker ink" edges from these tokens would require a second
 * per-theme ramp for a purely decorative cue.
 */
export const CAPACITY_STATUS_GLOW_COLORS: Record<
  "green" | "yellow" | "orange" | "red",
  string
> = {
  green: "hsl(var(--status-ok) / 0.25)",
  yellow: "hsl(var(--status-warn) / 0.15)",
  orange: "hsl(var(--status-warn) / 0.25)",
  red: "hsl(var(--status-critical) / 0.25)",
} as const;
