/**
 * Ads OS — core data model for the hygiene audit (port of backend/app/models.py,
 * audit slice). Field names stay snake_case: these objects serialize as-is to
 * the React frontend and the standalone HTML report, matching the bundle's JSON
 * contract exactly.
 */

/** Per-check status band (spec Part 1 legend). */
export const Status = {
  GOOD: "good", // 🟢 -> 100
  OKAY: "okay", // 🟡 -> 60
  BAD: "bad", // 🔴 -> 20
  CRITICAL: "critical", // ⛔ -> 0
  NA: "na", // ⚪ -> excluded from scoring
} as const;

export type Status = (typeof Status)[keyof typeof Status];

/** One affected entity behind a check result. */
export interface Evidence {
  name: string; // e.g. "Personal Injury - Exact"
  id?: string | null; // campaign / ad group / criterion id
  detail?: string | null; // human-readable measured value for this entity
}

export interface CheckResult {
  id: string; // "GEO-02"
  category: string; // "GEO"
  name: string; // human-readable check name
  status: Status;
  score: number | null; // 0-100, or null if status is NA
  weight: number; // global impact weight (for transparency / audit)
  impact: string; // performance impact tier: critical|high|medium|low
  value: string; // human-readable measured value ("avg QS 6.2")
  evidence: Evidence[];
  recommendation: string;
}

export interface CategoryResult {
  code: string; // "GEO"
  name: string;
  weight: number; // category's share of total weight (display)
  score: number; // 0-100, weighted avg of applicable checks
  checks: CheckResult[];
}

export interface GateTriggered {
  id: string;
  source: string; // check id that fired it, e.g. "GEO-01"
  cap: number; // the cap value applied
  reason: string; // human-readable explanation for the banner
}

/** One recommended action in the tiered Next-steps roadmap. */
export interface NextStep {
  title: string; // short headline
  detail: string; // affected entities / measured value
  source: string; // originating check id(s), e.g. "ADS-01"
  points: string[]; // optional sub-bullets
}

/** Prioritized roadmap: fix-now -> quick wins -> strategic. */
export interface NextSteps {
  critical: NextStep[];
  easy_wins: NextStep[];
  long_term: NextStep[];
}

export function emptyNextSteps(): NextSteps {
  return { critical: [], easy_wins: [], long_term: [] };
}

export interface CompactNextSteps {
  critical: { title: string; detail: string }[];
  important: { title: string; detail: string }[];
  minor: { title: string; detail: string }[];
  counts: { critical: number; important: number; minor: number };
}

/**
 * A small, store-friendly snapshot of an audit's next steps, persisted alongside
 * the score so the client profile can show the latest task summary without
 * re-running the audit. Tiers map to the profile's Critical / Important /
 * Less-important columns.
 */
export function compactNextSteps(
  ns: NextSteps,
  perTier = 6,
  detailChars = 160,
): CompactNextSteps {
  const tier = (steps: NextStep[]) =>
    steps.slice(0, perTier).map((s) => ({
      title: s.title,
      detail: (s.detail || "").slice(0, detailChars),
    }));
  return {
    critical: tier(ns.critical),
    important: tier(ns.easy_wins),
    minor: tier(ns.long_term),
    counts: {
      critical: ns.critical.length,
      important: ns.easy_wins.length,
      minor: ns.long_term.length,
    },
  };
}

export interface AuditReport {
  customer_id: string;
  account_name: string;
  generated_at: string; // ISO timestamp (UTC)
  lookback_days: number;

  raw_score: number; // H, before gates
  final_score: number; // H_final, after caps
  band: string; // Excellent | Healthy | Needs Attention | At Risk | Critical | Inactive
  band_color: string;
  /** Set when the account has no scannable labeled campaigns (band "Inactive"). */
  scope_note?: string | null;
  gates_triggered: GateTriggered[];
  next_steps: NextSteps;
  categories: CategoryResult[];
  from_cache?: boolean;
}
