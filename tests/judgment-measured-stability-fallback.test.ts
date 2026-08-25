/* test-registration
{
  "name": "Measured-fallback delivery stability + unknown-stability triage split (Task #4766)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4766: the tier gate may now ground deliveryStability from MEASURED live-data leads when entered reports can't — but only under the exact entered-report rules plus a post-close requirement, and the audit must name its source so measured data is never mistaken for entered data. A drift here either fabricates a verdict from a partial mid-month total (false 'declining' on a real client) or silently weakens the gate. The triage split is the honest-outcome half: a client with recent communications must NEVER be an archive candidate. Pure, DB-free, fast.",
  "timeoutMs": 60000,
  "tier": "small"
}
test-registration */
/**
 * Task #4766 — unit coverage for:
 *
 *   1. `assessDeliveryStabilityWithFallback` — entered reports stay
 *      PRIMARY; measured monthly leads (post-close snapshots only) ground
 *      stability only when entered data reads "unknown"; same thresholds
 *      (≥2 completed months, latest ≤2 months behind, judgment month
 *      excluded, <0.6× prior average = declining, all-zero grounds
 *      nothing); nothing available → unknown + source "none".
 *   2. `isPostCloseSnapshot` — a snapshot fetched mid-month never counts
 *      as that month's final total.
 *   3. `buildTierGateAudit` — persists `deliveryStabilitySource`.
 *   4. `classifyStabilityTriage` — recent-comms client is ALWAYS a data
 *      gap; only a client dead across comms, entered reports, measured
 *      data, AND open asks is an archive candidate.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import {
  assessDeliveryStabilityWithFallback,
  isPostCloseSnapshot,
  buildTierGateAudit,
  applyJudgmentTierGate,
  TIER_GATE_VERSION,
  type MeasuredMonthlyLeads,
  type TierGateInput,
} from "../server/services/judgmentTierGate";
import {
  classifyStabilityTriage,
  TRIAGE_COMMS_DEAD_DAYS,
} from "../server/services/stabilityTriage";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
  }
}
function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const DATE = "2026-08-14"; // judgment date; completed months are ≤ 2026-07
const noReports: Array<{ month: string; leads: number | null; reviews: number | null }> = [];
const postClose = (month: string, leads: number): MeasuredMonthlyLeads => ({
  month,
  leads,
  // First day of month+2 is safely after close for any test month here.
  fetchedAt: "2026-08-05T00:00:00.000Z",
});

console.log("assessDeliveryStabilityWithFallback:");

check("entered reports stay primary when they ground a verdict", () => {
  const entered = [
    { month: "2026-07", leads: 10, reviews: null },
    { month: "2026-06", leads: 11, reviews: null },
  ];
  // Measured says declining — must be ignored because entered grounds "stable".
  const measured = [postClose("2026-07", 1), postClose("2026-06", 50)];
  const r = assessDeliveryStabilityWithFallback(entered, measured, DATE);
  assertEq(r.stability, "stable", "stability");
  assertEq(r.source, "entered_reports", "source");
});

check("measured fallback grounds 'stable' when entered data is absent", () => {
  const measured = [postClose("2026-07", 12), postClose("2026-06", 10), postClose("2026-05", 11)];
  const r = assessDeliveryStabilityWithFallback(noReports, measured, DATE);
  assertEq(r.stability, "stable", "stability");
  assertEq(r.source, "measured_live_data", "source");
});

check("measured fallback grounds 'declining' on a collapse", () => {
  const measured = [postClose("2026-07", 2), postClose("2026-06", 10), postClose("2026-05", 10)];
  const r = assessDeliveryStabilityWithFallback(noReports, measured, DATE);
  assertEq(r.stability, "declining", "stability");
  assertEq(r.source, "measured_live_data", "source");
});

check("a mid-month (pre-close) snapshot never counts — no false collapse", () => {
  const measured: MeasuredMonthlyLeads[] = [
    // 2026-07 total fetched July 20th — partial, must be discarded.
    { month: "2026-07", leads: 1, fetchedAt: "2026-07-20T12:00:00.000Z" },
    postClose("2026-06", 10),
    postClose("2026-05", 11),
  ];
  const r = assessDeliveryStabilityWithFallback(noReports, measured, DATE);
  // With 2026-07 discarded, latest completed is 2026-06 (≤2 months behind) → stable.
  assertEq(r.stability, "stable", "stability");
  assertEq(r.source, "measured_live_data", "source");
});

check("judgment month is excluded from the measured series", () => {
  const measured = [postClose("2026-08", 0), postClose("2026-07", 10)];
  // 2026-08 is the judgment month → excluded; only one completed month → unknown.
  const r = assessDeliveryStabilityWithFallback(noReports, measured, DATE);
  assertEq(r.stability, "unknown", "stability");
  assertEq(r.source, "none", "source");
});

check("all-zero measured history grounds nothing", () => {
  const measured = [postClose("2026-07", 0), postClose("2026-06", 0), postClose("2026-05", 0)];
  const r = assessDeliveryStabilityWithFallback(noReports, measured, DATE);
  assertEq(r.stability, "unknown", "stability");
  assertEq(r.source, "none", "source");
});

check("stale measured series (latest >2 months behind) reads unknown", () => {
  const measured = [postClose("2026-04", 10), postClose("2026-03", 10)];
  const r = assessDeliveryStabilityWithFallback(noReports, measured, DATE);
  assertEq(r.stability, "unknown", "stability");
  assertEq(r.source, "none", "source");
});

check("nothing available → unknown + source none", () => {
  const r = assessDeliveryStabilityWithFallback(noReports, [], DATE);
  assertEq(r.stability, "unknown", "stability");
  assertEq(r.source, "none", "source");
});

check("stale entered reports fall through to a live measured series", () => {
  const entered = [
    { month: "2026-03", leads: 10, reviews: null },
    { month: "2026-02", leads: 10, reviews: null },
  ]; // latest is >2 months behind → entered reads unknown
  const measured = [postClose("2026-07", 10), postClose("2026-06", 9)];
  const r = assessDeliveryStabilityWithFallback(entered, measured, DATE);
  assertEq(r.stability, "stable", "stability");
  assertEq(r.source, "measured_live_data", "source");
});

console.log("isPostCloseSnapshot:");

// future-date-literal-reviewed: 2027-01-01 (and every other date here) is
// compared against the pinned month literal "2026-12" inside the pure
// isPostCloseSnapshot — literal-vs-literal with no wall-clock read, so the
// assertions cannot rot when real time passes these dates.
check("boundary: exactly the first instant after close counts", () => {
  assertEq(isPostCloseSnapshot("2026-07", "2026-08-01T00:00:00.000Z"), true, "first instant");
  assertEq(isPostCloseSnapshot("2026-07", "2026-07-31T23:59:59.999Z"), false, "last pre-close ms");
  assertEq(isPostCloseSnapshot("2026-12", "2027-01-01T00:00:00.000Z"), true, "year rollover");
  assertEq(isPostCloseSnapshot("garbage", "2026-08-01T00:00:00.000Z"), false, "bad month");
  assertEq(isPostCloseSnapshot("2026-07", "not-a-date"), false, "bad timestamp");
});

console.log("buildTierGateAudit persists the source:");

check("audit carries deliveryStabilitySource + current provenance-gate version", () => {
  assertEq(TIER_GATE_VERSION, 6, "TIER_GATE_VERSION");
  const input: TierGateInput = {
    judgmentDate: "2026-08-14",
    proposedStatus: "Healthy",
    proposedOverallRisk: 10,
    proposedRelationshipStatus: "Stable",
    evidence: [],
    tier: "full",
    silenceExceeded: false,
    deliveryStability: "stable",
    deliveryStabilitySource: "measured_live_data",
  };
  const gate = applyJudgmentTierGate(input);
  const audit = buildTierGateAudit(input, gate, { items: [], validCount: 0, rejectedCount: 0, reclassifiedCount: 0 } as any);
  assertEq(audit.deliveryStability, "stable", "stability in audit");
  assertEq(audit.deliveryStabilitySource, "measured_live_data", "source in audit");
});

console.log("classifyStabilityTriage:");

const base = {
  judgmentDate: DATE,
  lastCommAt: null as string | null,
  lastEnteredReportMonth: null as string | null,
  measuredMonths: 0,
  activeOpenAsks: 0,
};

check("all-dead client is an archive candidate", () => {
  const r = classifyStabilityTriage({ ...base });
  assertEq(r.kind, "archive_candidate", "kind");
  assertEq(r.reasons.length > 0, true, "has evidence reasons");
});

check("recent-comms client is NEVER an archive candidate", () => {
  const r = classifyStabilityTriage({ ...base, lastCommAt: "2026-08-10T00:00:00.000Z" });
  assertEq(r.kind, "data_gap", "kind");
});

check("comms just past the dead threshold alone still means archive candidate", () => {
  const deadMs = Date.parse(DATE + "T00:00:00Z") - (TRIAGE_COMMS_DEAD_DAYS + 10) * 86_400_000;
  const r = classifyStabilityTriage({ ...base, lastCommAt: new Date(deadMs).toISOString() });
  assertEq(r.kind, "archive_candidate", "kind");
});

check("a recent entered report alone keeps the client a data gap", () => {
  const r = classifyStabilityTriage({ ...base, lastEnteredReportMonth: "2026-06" });
  assertEq(r.kind, "data_gap", "kind");
});

check("measured data alone keeps the client a data gap", () => {
  const r = classifyStabilityTriage({ ...base, measuredMonths: 3 });
  assertEq(r.kind, "data_gap", "kind");
});

check("an active open ask alone keeps the client a data gap", () => {
  const r = classifyStabilityTriage({ ...base, activeOpenAsks: 1 });
  assertEq(r.kind, "data_gap", "kind");
});

check("very stale entered report does not rescue an otherwise-dead client", () => {
  const r = classifyStabilityTriage({ ...base, lastEnteredReportMonth: "2025-09" });
  assertEq(r.kind, "archive_candidate", "kind");
});

if (failures > 0) {
  console.error(`\n${failures} measured-stability test step(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log("\nAll measured-stability fallback tests passed");
}
