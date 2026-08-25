// Task #4430 — SVG url(#id) paint references break on characters outside
// [A-Za-z0-9-]: a gradient id built from free text (a location name like
// "Cedar Rapids, IA" or a label like "Pipeline Momentum (BETA)") produces an
// INVALID paint reference, and an invalid paint renders the chart area as an
// OPAQUE BLACK rectangle (not transparent). Every dynamic gradient/pattern id
// must pass through this helper; keep readable slugs for data-testids only.
export function svgSafeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9-]/g, "");
}
