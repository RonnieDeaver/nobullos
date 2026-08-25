/**
 * Report design tokens — TS mirror of the CSS custom-property layer
 * (Task #4272; audit §8.2).
 *
 * WHY A MIRROR EXISTS: recharts (and other SVG presentation-attribute
 * consumers) cannot resolve `var(--report-*)` in `fill`/`stroke` props,
 * so chart code needs literal hexes. These constants are the ONLY
 * sanctioned source for report colors in TSX; the CSS layer in
 * `client/src/index.css` (":root client-report token layer") is the
 * canonical definition. `tests/report-token-lockstep.test.ts` asserts
 * hex-for-hex parity between the two and re-computes the WCAG AA
 * contrast contract for each token's declared role — edit both files
 * together or that suite goes red.
 *
 * Do NOT import from here into the heatmap SERVED palette
 * (`shared/heatmapColors.ts`) or vice versa — that palette is a frozen
 * external contract guarded by lint-heatmap-color-lockstep.
 */

export const REPORT_COLORS = {
  /** v2 Crimson — headers, critical accents, brand chrome. */
  crimson: '#8A292F',
  /** Burgundy gradient mid-stop. */
  crimsonDeep: '#6B2327',
  /** Burgundy gradient end-stop. */
  crimsonShadow: '#4A1A1C',
  /** v2 Goldenrod — decoration + large-text on dark ONLY (fails AA as body text). */
  gold: '#D5AC5C',
  /** v2 Gold Ink — the text-safe gold on light surfaces (≥5:1 on eggshell). */
  goldInk: '#7D5C1B',
  /** v2 Eggshell — slide field. */
  eggshell: '#EEE8DC',
  /** Card field on light slides. */
  paper: '#F7F5F0',
  /** v2 Warm Paper — brightest field step. */
  paperBright: '#FAF8F4',
  /** v2 Cream Deep — deepest light field step. */
  creamDeep: '#E7DFCE',
  /** Primary text on light. */
  ink: '#232323',
  /** Secondary text on light (solid — never an alpha of ink). */
  inkMuted: '#595959',
  /** Primary text on dark. */
  inkInverse: '#F5F1E8',
  /** Secondary text on dark. */
  inkInverseMuted: '#B3AC9F',
  /** Dark slide field. */
  charcoal: '#1A1A1A',
  /** Dark gradient top. */
  charcoalHi: '#2D2D2D',
  /** Card on dark. */
  charcoalCard: '#252525',
  /** Deepest dark step. */
  charcoalDeep: '#121212',
  /** Muted steel-blue data accent. */
  steel: '#5B7B9A',
  /** Muted positive data accent. */
  sage: '#2D8B6F',
  /** Neutral data accent. */
  slate: '#9CA3AF',
  /** Positive text/lines on dark fields (healthy is too dark there). */
  healthyBright: '#66B384',
  /** Negative text/lines on dark fields (crimson is too dark there). */
  crimsonBright: '#D4757A',
  /** v2 Liberty Blue — info / ramp-up accent. */
  liberty: '#485696',
  /** v2 Earth — baseline / grounded accent. */
  earth: '#524B3A',
  /** Plain white — kept here so chart code never hand-writes '#fff'. */
  white: '#FFFFFF',
} as const;

export type ReportStatusLevel =
  | 'healthy'
  | 'watch'
  | 'attention'
  | 'critical'
  | 'neutral';

/**
 * Report status scale (CSS: `.report-surface { --status-* }`).
 * All five pass WCAG AA (≥4.5:1) as fills under white text AND as text
 * on white/paper light surfaces.
 */
export const REPORT_STATUS_COLORS: Record<ReportStatusLevel, string> = {
  healthy: '#2F6B44',
  watch: REPORT_COLORS.goldInk,
  attention: '#96491F',
  critical: REPORT_COLORS.crimson,
  neutral: REPORT_COLORS.inkMuted,
};

/**
 * Glyph redundancy (§8.4): status is never color-alone. Every status
 * tag pairs its color with a direction glyph.
 */
export const REPORT_STATUS_GLYPHS: Record<ReportStatusLevel, string> = {
  healthy: '▲',
  watch: '—',
  attention: '▼',
  critical: '▼',
  neutral: '—',
};

/**
 * Marketing-calendar phase colors (MarketContextSlide). Keys match the
 * `data-phase` attribute values used by the print/pdf CSS rules — the
 * CSS `--report-phase-*` aliases must stay in lockstep.
 */
export const REPORT_PHASE_COLORS = {
  Peak: REPORT_COLORS.crimson,
  Hold: REPORT_COLORS.steel,
  Taper: REPORT_COLORS.gold,
  Soft: REPORT_COLORS.slate,
  Rebuild: REPORT_COLORS.sage,
} as const;

/**
 * AA-safe "ink" counterparts to REPORT_PHASE_COLORS for TEXT roles
 * (phase chips / phase-square initials — audit R1 residue, Task #4542).
 * The base phase palette is a DATA-ACCENT palette: steel (3.5:1), gold
 * (2.0:1), slate (2.5:1) and sage (4.3:1) all fail as text on light or
 * as fills under white text. Each entry here reuses an existing token
 * whose ≥4.5:1 contract on light surfaces AND as a fill under white is
 * already enforced by tests/report-token-lockstep.test.ts — no new
 * hexes, so the design hex ratchet is untouched. Charts keep using
 * REPORT_PHASE_COLORS; anything that sets TEXT color (or a small solid
 * fill behind white text) must use this map.
 */
export const REPORT_PHASE_INK_COLORS: Record<keyof typeof REPORT_PHASE_COLORS, string> = {
  Peak: REPORT_COLORS.crimson,
  Hold: REPORT_COLORS.liberty,
  Taper: REPORT_COLORS.goldInk,
  Soft: REPORT_COLORS.inkMuted,
  Rebuild: REPORT_STATUS_COLORS.healthy,
} as const;

/**
 * Task #4414 — CEO Pulse chart palette for the report surface. The shared
 * chart renderer (client/src/components/CeoPulseChartRenderer.tsx) keeps its
 * stock SaaS colors for the internal OS; inside the report, CeoPulseSlide
 * passes this palette so every chart fill/stroke/label rides `--report-*`
 * tokens instead (recharts consumes literal hexes, hence values from this
 * mirror). Every entry reuses an EXISTING sanctioned token — no new hexes —
 * and every `series` fill is dark enough to hold WCAG AA under the white
 * stacked-segment labels the renderer paints on series fills (why gold,
 * steel, sage, and slate are deliberately absent from `series`).
 */
export const REPORT_CEO_PULSE_CHART_PALETTE = {
  series: [
    REPORT_COLORS.crimson,
    REPORT_STATUS_COLORS.healthy,
    REPORT_COLORS.liberty,
    REPORT_COLORS.goldInk,
    REPORT_STATUS_COLORS.attention,
    REPORT_COLORS.earth,
    REPORT_COLORS.crimsonDeep,
    REPORT_COLORS.inkMuted,
  ],
  primary: REPORT_COLORS.crimson,
  neutral: REPORT_COLORS.slate,
  target: REPORT_STATUS_COLORS.attention,
  grid: REPORT_COLORS.creamDeep,
  ink: REPORT_COLORS.ink,
  inkFaint: REPORT_COLORS.inkMuted,
  valueOnDark: REPORT_COLORS.white,
  positiveText: REPORT_STATUS_COLORS.healthy,
  negativeText: REPORT_STATUS_COLORS.critical,
  // Funnel stage ramp (light→dark; stage i clamps to the last entry) —
  // replaces both funnel schemes AND AI-supplied stage colors in the report,
  // all AA under the white stage labels.
  funnelStages: [
    REPORT_COLORS.crimson,
    REPORT_COLORS.crimsonDeep,
    REPORT_COLORS.crimsonShadow,
  ],
} as const;

/** §8.3 floors for chart text (recharts fontSize props). */
export const REPORT_TICK_FONT_SIZE = 11;
export const REPORT_CAPTION_FONT_SIZE = 12;

/**
 * Map the report's DOMAIN status levels (metric bands: `big_issue`,
 * `issue`, `no_data`, …) onto the visual status scale. Keeps slide code
 * from hand-rolling color ternaries per metric.
 */
export function reportStatusLevelFromDomain(level: string): ReportStatusLevel {
  switch (level) {
    case 'critical':
      return 'critical';
    case 'big_issue':
      return 'attention';
    case 'issue':
      return 'watch';
    case 'no_data':
      return 'neutral';
    default:
      return 'healthy';
  }
}
