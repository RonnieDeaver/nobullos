// @db-pool-intent: ambient
//
// Task #2371 — RIS Performance Layer threshold engine.
//
// Pure, side-effect-free scoring of a single Performance metric into a
// Green / Yellow / Red / Gray status from its period-over-period change vs
// admin-tunable threshold bands. No DB, no IO — trivially unit-testable.
//
// Threshold model (from the V1 spec):
//   volume (higher better): Green down <15% / Yellow -15..-25% / Red >25% drop
//   cost   (lower  better): Green up   <15% / Yellow +15..+30% / Red >30% rise
//   rate   (higher better): Green down <10% / Yellow -10..-20% / Red >20% drop
//   budget (pacing ratio) : Green within band / Yellow modest off / Red material
//   Gray everywhere: insufficient/zero prior volume or no current value.

import type {
  RisMetricType,
  RisPerformanceStatus,
  RisThresholdOverride,
} from "@shared/schema";

// Resolved band set after merging defaults with any per-check override.
export interface ResolvedBands {
  // volume/cost/rate: percent boundaries (positive). For volume/rate these
  // are DROP boundaries; for cost they are RISE boundaries.
  yellow: number;
  red: number;
  // Prior-period volume at or below which a comparison is Gray (too little
  // data to trust the percentage). 0 means "only a zero/empty prior is Gray".
  minVolume: number;
  // budget pacing: percent-of-expected bands (100 = exactly on pace).
  greenLow: number;
  greenHigh: number;
  yellowLow: number;
  yellowHigh: number;
}

// Metric-type defaults. Budget fields are only meaningful for `budget`;
// yellow/red/minVolume only for volume/cost/rate. We carry a full shape for
// every type to keep the merge logic uniform.
const DEFAULT_BANDS: Record<RisMetricType, ResolvedBands> = {
  volume: { yellow: 15, red: 25, minVolume: 0, greenLow: 85, greenHigh: 115, yellowLow: 70, yellowHigh: 130 },
  cost: { yellow: 15, red: 30, minVolume: 0, greenLow: 85, greenHigh: 115, yellowLow: 70, yellowHigh: 130 },
  rate: { yellow: 10, red: 20, minVolume: 0, greenLow: 85, greenHigh: 115, yellowLow: 70, yellowHigh: 130 },
  budget: { yellow: 15, red: 30, minVolume: 0, greenLow: 85, greenHigh: 115, yellowLow: 70, yellowHigh: 130 },
};

/** Merge a per-check override (any subset of bands) over the metric-type
 *  defaults. Unknown/absent override fields fall back to the default. */
export function resolveBands(
  metricType: RisMetricType,
  override?: RisThresholdOverride | null,
): ResolvedBands {
  const base = DEFAULT_BANDS[metricType] ?? DEFAULT_BANDS.volume;
  if (!override) return { ...base };
  return {
    yellow: override.yellow ?? base.yellow,
    red: override.red ?? base.red,
    minVolume: override.minVolume ?? base.minVolume,
    greenLow: override.greenLow ?? base.greenLow,
    greenHigh: override.greenHigh ?? base.greenHigh,
    yellowLow: override.yellowLow ?? base.yellowLow,
    yellowHigh: override.yellowHigh ?? base.yellowHigh,
  };
}

export interface ComputePerformanceInput {
  metricType: RisMetricType;
  /** Current-period value. For `budget` this is the pacing percent
   *  (actual/expected × 100). NULL → Gray. */
  current: number | null | undefined;
  /** Prior-period value. Ignored for `budget`. NULL/zero/≤minVolume → Gray. */
  previous?: number | null;
  /** Optional target (for display only in V1; does not drive status). */
  target?: number | null;
  bands?: RisThresholdOverride | null;
}

export interface PerformanceVerdict {
  status: RisPerformanceStatus;
  /** Signed period-over-period percent change, rounded to 1 dp. NULL when no
   *  comparison was possible (Gray) or for `budget` (pacing, not a change). */
  changePct: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Score one metric into a Performance status + signed change percent.
 * Pure: identical inputs always yield identical output.
 */
export function computePerformanceStatus(
  input: ComputePerformanceInput,
): PerformanceVerdict {
  const bands = resolveBands(input.metricType, input.bands);
  const current = input.current;

  // No current observation at all → insufficient data.
  if (current == null || Number.isNaN(current)) {
    return { status: "gray", changePct: null };
  }

  // ── Budget pacing: single value scored against the pacing bands. ──
  if (input.metricType === "budget") {
    const p = current;
    if (p >= bands.greenLow && p <= bands.greenHigh) {
      return { status: "green", changePct: null };
    }
    if (p >= bands.yellowLow && p <= bands.yellowHigh) {
      return { status: "yellow", changePct: null };
    }
    return { status: "red", changePct: null };
  }

  // ── volume / cost / rate: need a trustworthy prior to compute change. ──
  const prev = input.previous;
  if (prev == null || Number.isNaN(prev) || prev <= bands.minVolume) {
    return { status: "gray", changePct: null };
  }

  const changePct = round1(((current - prev) / prev) * 100);

  if (input.metricType === "cost") {
    // Lower is better: positive change (cost rose) is bad. Spec bands are
    // "Green up <yellow / Yellow [yellow..red] / Red >red", so the yellow
    // boundary itself is Yellow (green is strictly inside it).
    if (changePct < bands.yellow) return { status: "green", changePct };
    if (changePct <= bands.red) return { status: "yellow", changePct };
    return { status: "red", changePct };
  }

  // volume & rate: higher is better; a drop (negative change) is bad. Mirror of
  // the cost contract: a drop of exactly `yellow`% is Yellow, not Green.
  if (changePct > -bands.yellow) return { status: "green", changePct };
  if (changePct >= -bands.red) return { status: "yellow", changePct };
  return { status: "red", changePct };
}
