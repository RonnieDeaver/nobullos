/**
 * Shared account-rating vocabulary and severity semantics.
 *
 * The server's deterministic judgment gate owns which status is stored. This
 * module owns how that stored status is described, ranked, and bounded so
 * every client surface uses the same contract instead of local thresholds.
 */
export const accountHealthStatusOptions = [
  "Healthy",
  "Watch",
  "At Risk",
  "Critical",
] as const;

export type AccountHealthStatus = (typeof accountHealthStatusOptions)[number];

/** Exact CEO acknowledgement required before irreversible active-rating cleanup. */
export const FRESH_SLATE_DESTRUCTIVE_CONFIRMATION =
  "DELETE ACTIVE CLIENT RATING HISTORY";

export const relationshipReadOptions = [
  "Strong",
  "Stable",
  "Strained",
  "At Risk",
] as const;

export type RelationshipRead = (typeof relationshipReadOptions)[number];

export type RatingTone = "healthy" | "watch" | "at-risk" | "critical";

export const accountHealthContract: Record<AccountHealthStatus, {
  label: AccountHealthStatus;
  definition: string;
  severityRank: number;
  riskRange: readonly [number, number];
  tone: RatingTone;
}> = {
  Critical: {
    label: "Critical",
    definition: "Qualifying first-party evidence indicates an immediate loss risk.",
    severityRank: 0,
    riskRange: [75, 100],
    tone: "critical",
  },
  "At Risk": {
    label: "At Risk",
    definition: "Accepted client-risk evidence or an objective delivery or cadence breakdown is present.",
    severityRank: 1,
    riskRange: [50, 74],
    tone: "at-risk",
  },
  Watch: {
    label: "Watch",
    definition: "The account has a softer warning or an incomplete basis that needs attention.",
    severityRank: 2,
    riskRange: [25, 49],
    tone: "watch",
  },
  Healthy: {
    label: "Healthy",
    definition: "Delivery is stable, cadence is within baseline, and no accepted negative evidence is present.",
    severityRank: 3,
    riskRange: [0, 24],
    tone: "healthy",
  },
};

export const relationshipReadContract: Record<RelationshipRead, {
  label: RelationshipRead;
  definition: string;
  severityRank: number;
}> = {
  "At Risk": {
    label: "At Risk",
    definition: "Direct client-authored evidence indicates a severe relationship concern.",
    severityRank: 0,
  },
  Strained: {
    label: "Strained",
    definition: "Current client-authored evidence indicates relationship pressure.",
    severityRank: 1,
  },
  Stable: {
    label: "Stable",
    definition: "No current direct client signal supports a strained relationship read.",
    severityRank: 2,
  },
  Strong: {
    label: "Strong",
    definition: "A complete, stable account basis has no accepted negative relationship evidence.",
    severityRank: 3,
  },
};

export function isAccountHealthStatus(value: unknown): value is AccountHealthStatus {
  return typeof value === "string" &&
    (accountHealthStatusOptions as readonly string[]).includes(value);
}

export function isRelationshipRead(value: unknown): value is RelationshipRead {
  return typeof value === "string" &&
    (relationshipReadOptions as readonly string[]).includes(value);
}

export function riskMatchesAccountHealthStatus(
  riskScore: number | null,
  status: AccountHealthStatus,
): boolean {
  if (riskScore === null || !Number.isFinite(riskScore)) return false;
  const [minimum, maximum] = accountHealthContract[status].riskRange;
  return riskScore >= minimum && riskScore <= maximum;
}

export type RatingDriverSeverity = "supporting" | "watch" | "at-risk" | "critical";
export type RatingDriverProvenance = "client-authored" | "objective" | "internal" | "other";
export type RatingDriverFreshness = "current" | "standing" | "unknown";

export interface AccountRatingDriver {
  id: string;
  label: string;
  severity: RatingDriverSeverity;
  provenance: RatingDriverProvenance;
  sourceLabel: string;
  occurredAt: string | null;
  ageDays: number | null;
  freshness: RatingDriverFreshness;
}

export interface AccountRatingPresentation {
  status: AccountHealthStatus;
  statusDefinition: string;
  relationship: RelationshipRead | null;
  relationshipDefinition: string | null;
  riskScore: number | null;
  riskRange: readonly [number, number];
  policyVersion: number;
  promptRevision: string | null;
  basisTier: "full" | "operational" | null;
  judgmentDate: string;
  generatedAt: string | null;
  generation: "generated" | "carried-forward";
  primaryDrivers: AccountRatingDriver[];
  reasonLabels: string[];
  evidenceCounts: {
    accepted: number;
    rejected: number;
    reclassified: number;
  };
  lineage: {
    fromDate: string;
    fromJudgmentId: string;
    rootDate: string;
    rootJudgmentId: string;
  } | null;
}