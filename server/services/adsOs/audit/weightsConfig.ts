/**
 * Ads OS — GAds Hygiene Audit scoring model.
 *
 * Verbatim port of the source bundle's `config/weights.yaml` — impact-based
 * weighting (set from the team's weight/impact sheet). Tunable without touching
 * the check modules: all math in scoring.ts reads from here via configLoader.
 */

export type ImpactLevel = "critical" | "high" | "medium" | "low";

export interface BandDef {
  min: number;
  name: string;
  color: string;
}

export interface WeightsConfig {
  /** Category display names (no longer carry a category weight — the overall
   * score is a flat impact-weighted average of every check, see `impact`). */
  categories: Record<string, { name: string }>;
  /** Per-check performance impact. Drives the global weight (impact_weights)
   * and, for `critical`, a score cap when the check is failing (see caps). */
  impact: Record<string, ImpactLevel>;
  /** Impact level -> global weight in the overall (flat) weighted average. */
  impact_weights: Record<ImpactLevel, number>;
  /** Score caps: failing `critical`-impact checks (status bad or critical;
   * "okay" does not count) cap the overall so the account can't read "Healthy".
   * The cap is dynamic — it drops with the NUMBER of critical errors:
   *   cap = critical_default - per_additional * (count - 1), floored at `floor`.
   * e.g. 1 critical -> 65, 2 -> 55, 3 -> 45, ...  final = min(raw, cap). */
  caps: {
    critical_default: number;
    per_additional: number;
    floor: number;
    by_check: Record<string, number>;
  };
  /** Discrete status -> sub-score map. N/A is excluded from the average. */
  status_scores: Record<"good" | "okay" | "bad" | "critical", number>;
  /** BID-04 Smart Bidding maturity threshold (see checks/bid.ts). Any
   * manual/Max-Clicks campaign with >= this many conversions in the lookback
   * window is flagged to move to conversion-based Smart Bidding. */
  bid_04_smart_bidding: { min_conversions: number };
  /** Health bands (overall). Evaluated top-down by min. */
  bands: BandDef[];
}

export const WEIGHTS: WeightsConfig = {
  categories: {
    GEO: { name: "Targeting & Geo Integrity" },
    KWS: { name: "Keywords & Search-Term Hygiene" },
    BID: { name: "Bidding & Budget Efficiency" },
    ADS: { name: "Ads & Creative" },
    AST: { name: "Assets / Extensions" },
    OPT: { name: "Optimization Score & Recs" },
    STR: { name: "Account Structure & Settings" },
  },

  impact: {
    "GEO-01": "critical",
    "GEO-02": "critical",
    "GEO-04": "critical",
    "KWS-01": "high",
    "KWS-02": "low",
    "KWS-03": "critical",
    "KWS-06": "critical",
    "KWS-08": "high",
    "BID-01": "critical",
    "BID-02": "low",
    "BID-03": "low",
    "BID-04": "high",
    "BID-05": "medium",
    "ADS-01": "high",
    "ADS-02": "low",
    "ADS-05": "low",
    "ADS-07": "medium",
    "AST-01": "high",
    "AST-02": "critical",
    "AST-03": "critical",
    "AST-04": "medium",
    "AST-05": "medium",
    "AST-06": "medium",
    "OPT-01": "low",
    "STR-01": "critical",
    // Removed from the audit per team review (now owned by the alerts engine or dropped):
    //   POL-01/03/04/05, ADS-04, OPT-02, STR-02, STR-04.
  },

  impact_weights: {
    critical: 12,
    high: 6,
    medium: 3,
    low: 1,
  },

  caps: {
    critical_default: 65, // cap for the first failing critical check
    per_additional: 10, // each additional failing critical check lowers the cap
    floor: 10, // cap never drops below this
    by_check: {}, // (POL-05 override removed with the POL checks)
  },

  status_scores: {
    good: 100,
    okay: 60,
    bad: 20,
    critical: 0,
    // na: excluded
  },

  bid_04_smart_bidding: {
    min_conversions: 15,
  },

  bands: [
    { min: 90, name: "Excellent", color: "green" },
    { min: 75, name: "Healthy", color: "green" },
    { min: 60, name: "Needs Attention", color: "yellow" },
    { min: 40, name: "At Risk", color: "orange" },
    { min: 0, name: "Critical", color: "red" },
  ],
};
