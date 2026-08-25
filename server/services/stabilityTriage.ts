// Task #4766 — unknown-stability operator triage (pure classifier).
//
// After the measured-live-data fallback, some clients STILL read
// deliveryStability "unknown": their entered reports can't ground a verdict
// AND no post-close measured leads exist. Two honest realities hide behind
// that state:
//   • a real active client whose data is simply missing ("data gap" —
//     recent communications prove the relationship is alive; the fix is to
//     enter real reports through the normal flow or configure the measured
//     BigQuery source), or
//   • a client we likely no longer work with ("archive candidate" — dead
//     across communications, entered reports, measured data, AND open
//     asks; they shouldn't be judged at all and belong in the existing
//     archive/offboarding flow — a HUMAN decision, never automatic).
//
// The split is deterministic and computed from the judgment's own stored
// source signals — no new data collection, no AI. Pure leaf module so the
// thresholds are unit-testable with pinned fixtures.

/** Days without any matched communication before comms count as "dead". */
export const TRIAGE_COMMS_DEAD_DAYS = 120;

/** Months an entered report may trail the judgment month before "dead". */
export const TRIAGE_REPORT_DEAD_MONTHS = 4;

export type StabilityTriageKind = "data_gap" | "archive_candidate";

export interface StabilityTriageInput {
  /** Judgment date (YYYY-MM-DD) the evidence is judged relative to. */
  judgmentDate: string;
  /** Most recent matched communication ever (ISO), null = none on record. */
  lastCommAt: string | null;
  /** Latest entered report month (YYYY-MM), null = no reports. */
  lastEnteredReportMonth: string | null;
  /** Number of measured (post-close, ok-leads) months available. */
  measuredMonths: number;
  /** Active open asks at judgment time. */
  activeOpenAsks: number;
}

export interface StabilityTriageResult {
  kind: StabilityTriageKind;
  /** Human-readable evidence lines behind the classification. */
  reasons: string[];
}

function monthsBetween(earlier: string, later: string): number {
  const [ey, em] = earlier.split("-").map(Number);
  const [ly, lm] = later.split("-").map(Number);
  return (ly - ey) * 12 + (lm - em);
}

/**
 * Deterministic split. A client is an archive candidate ONLY when every
 * signal is dead: no communication within TRIAGE_COMMS_DEAD_DAYS, no
 * entered report within TRIAGE_REPORT_DEAD_MONTHS, zero measured months,
 * and zero active open asks. Any live signal — most importantly recent
 * communications — makes it a data gap instead: the client is real, the
 * data is what's missing.
 */
export function classifyStabilityTriage(input: StabilityTriageInput): StabilityTriageResult {
  const judgmentMs = new Date(input.judgmentDate + "T23:59:59.999Z").getTime();
  const judgmentMonth = input.judgmentDate.substring(0, 7);
  const reasons: string[] = [];

  let commsDead: boolean;
  if (input.lastCommAt === null) {
    commsDead = true;
    reasons.push("no matched communications on record");
  } else {
    const days = Math.floor((judgmentMs - new Date(input.lastCommAt).getTime()) / 86_400_000);
    commsDead = days > TRIAGE_COMMS_DEAD_DAYS;
    reasons.push(
      commsDead
        ? `last communication ${days} days ago (dead past ${TRIAGE_COMMS_DEAD_DAYS}d)`
        : `communications alive — last one ${Math.max(days, 0)} days ago`,
    );
  }

  let reportsDead: boolean;
  if (input.lastEnteredReportMonth === null || !/^\d{4}-\d{2}$/.test(input.lastEnteredReportMonth)) {
    reportsDead = true;
    reasons.push("no entered reports on record");
  } else {
    const lag = monthsBetween(input.lastEnteredReportMonth, judgmentMonth);
    reportsDead = lag > TRIAGE_REPORT_DEAD_MONTHS;
    reasons.push(
      reportsDead
        ? `latest entered report ${input.lastEnteredReportMonth} is ${lag} months behind`
        : `entered reports recent (latest ${input.lastEnteredReportMonth})`,
    );
  }

  const measuredDead = input.measuredMonths === 0;
  reasons.push(
    measuredDead
      ? "no measured (post-close) lead data available"
      : `${input.measuredMonths} measured month(s) of lead data available`,
  );

  const asksDead = input.activeOpenAsks === 0;
  reasons.push(
    asksDead ? "no active open asks" : `${input.activeOpenAsks} active open ask(s)`,
  );

  const kind: StabilityTriageKind =
    commsDead && reportsDead && measuredDead && asksDead ? "archive_candidate" : "data_gap";
  return { kind, reasons };
}
