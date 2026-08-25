/**
 * CEO Pulse stock OS palette — hex constants centralised so
 * CeoPulseChartRenderer.tsx carries no raw hex literals.
 *
 * These values are intentionally stored as literal strings because SVG and
 * recharts paint attributes cannot resolve CSS custom properties (var(…)),
 * so the values must be concrete hexes at JS runtime.  The corresponding
 * brief-* and report-* Tailwind utilities in index.css reference the same
 * design values for DOM (non-SVG) elements; keep them in lockstep if the
 * palette ever changes.
 *
 * Design-contract ratchet: this file's hex count is the sole source for
 * the CEO Pulse stock palette — never copy these values elsewhere in the
 * component tree; import from here instead.
 */

// ── Primary brand ────────────────────────────────────────────────────────────
/** NoBull Crimson — matches --color-brief-crimson in index.css */
export const PULSE_CRIMSON = '#8B2E31';

/** NoBull Gold — matches --color-brief-gold in index.css */
export const PULSE_GOLD = '#C4A35A';

// ── Supplementary series colours ─────────────────────────────────────────────
export const PULSE_SAGE   = '#2D6A4F';
export const PULSE_NAVY   = '#1E3A5F';
export const PULSE_AMBER  = '#D97706';
export const PULSE_VIOLET = '#7C3AED';
export const PULSE_TEAL   = '#0891B2';
export const PULSE_NEUTRAL = '#9CA3AF';

// ── Semantic chart values ─────────────────────────────────────────────────────
/** Target / negative-delta indicator line. */
export const PULSE_TARGET   = '#DC2626';
/** Grid lines / gauge track. */
export const PULSE_GRID     = '#e5e5e5';
/** Primary axis-tick and value-label ink — matches --color-brief-ink-soft */
export const PULSE_INK      = '#333333';
/** Faint secondary labels (gauge sublabel, radial axis). */
export const PULSE_INK_FAINT = '#999999';
/** Muted comparison-bar label in non-report mode. */
export const PULSE_LABEL_MUTED = '#666666';
/** Value labels rendered ON dark series fills. */
export const PULSE_WHITE    = '#ffffff';
/** Positive-delta text. */
export const PULSE_POSITIVE = '#16A34A';

// ── Default series cycle ──────────────────────────────────────────────────────
/**
 * Ordered colour cycle for the stock OS surface.  Report mode replaces this
 * with the CeoPulseChartPalette.series supplied by the caller.
 */
export const PULSE_DEFAULT_COLORS: readonly string[] = [
  PULSE_CRIMSON,
  PULSE_SAGE,
  PULSE_NAVY,
  PULSE_AMBER,
  PULSE_VIOLET,
  PULSE_TEAL,
  PULSE_GOLD,
  PULSE_NEUTRAL,
];
