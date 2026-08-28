/**
 * Canonical task-gate disposition vocabulary and conservative decision rules.
 *
 * This module is deliberately pure. It describes the owner-approved contract
 * for interpreting existing selection, execution, green-evidence, quarantine,
 * and failure signals; it does not select or run suites.
 */

export const TASK_GATE_DISPOSITIONS = [
  "executed-and-passed",
  "reused-accepted-green-evidence",
  "deferred-and-not-verified",
  "quarantined-non-blocking",
  "blocking-failure",
] as const;

export type TaskGateDisposition = (typeof TASK_GATE_DISPOSITIONS)[number];

export type TaskGateProofStatus =
  | "accepted-green"
  | "stale-rotation"
  | "stale-expired"
  | "central-integrity"
  | "missing"
  | "malformed"
  | "untrusted";

export interface TaskGatePolicyInput {
  gatePassed: boolean;
  verificationComplete: boolean;
  selectionTrusted: boolean;
  proofStatus: TaskGateProofStatus;
  directlyAffectedUnverified: boolean;
  coreGuardUnverified: boolean;
  testControlPlaneChanged: boolean;
  fullIntegrityVerified: boolean;
  centralIntegrityDeferred: boolean;
  executedAndPassed: boolean;
  reusedAcceptedGreenEvidence: boolean;
  deferredNotVerified: boolean;
  quarantinedNonBlocking: boolean;
}

export interface TaskGatePolicyResult {
  primaryDisposition: TaskGateDisposition;
  dispositions: TaskGateDisposition[];
  blockingReasons: string[];
}

export interface MandatoryRailProof {
  selected: number;
  executed: number;
  skippedGreen: number;
  deferred: number;
}

/**
 * Direct and core rails are blocking work. A required rail suite satisfies
 * the rail either by executing in this gate or by reusing accepted,
 * fingerprint-matched green evidence — the same green-skip proof an ordinary
 * unchanged suite already relies on today (owner-approved scoped exception,
 * 2026-08-26; see TESTING.md). Rails still cannot transfer verification
 * debt: any suite left in `deferred` (rotation-day central-integrity
 * deferral, or any other unresolved/stale/untrusted state that isn't a
 * positive fingerprint-matched green record) blocks the rail.
 */
export function mandatoryRailWasExecuted(rail: MandatoryRailProof | undefined): boolean {
  return (
    rail !== undefined &&
    rail.executed + rail.skippedGreen === rail.selected &&
    rail.deferred === 0
  );
}

const POSITIVELY_STALE_PROOF = new Set<TaskGateProofStatus>([
  "stale-rotation",
  "stale-expired",
  "central-integrity",
]);

/**
 * Apply the owner-approved precedence without changing any runner behavior.
 *
 * Any failed, incomplete, untrusted, malformed, missing, or rail-violating
 * observation is blocking. Only positive stale-green evidence or an explicit
 * centralized-integrity handoff may support a deferred disposition; all other
 * unverified states fall closed to blocking.
 */
export function classifyTaskGateDisposition(input: TaskGatePolicyInput): TaskGatePolicyResult {
  const blockingReasons: string[] = [];
  if (!input.gatePassed) blockingReasons.push("gate reported a blocking failure");
  if (!input.verificationComplete) blockingReasons.push("verification accounting is incomplete");
  if (!input.selectionTrusted) blockingReasons.push("selection proof is untrusted");
  if (input.directlyAffectedUnverified) {
    blockingReasons.push("a directly affected suite was not executed");
  }
  if (input.coreGuardUnverified) {
    blockingReasons.push("a core guard was not executed");
  }
  if (
    input.testControlPlaneChanged &&
    !input.fullIntegrityVerified &&
    !input.centralIntegrityDeferred
  ) {
    blockingReasons.push("test-control-plane changes require a central-integrity handoff");
  }
  if (input.proofStatus === "missing") blockingReasons.push("green proof is missing");
  if (input.proofStatus === "malformed") blockingReasons.push("green proof is malformed");
  if (input.proofStatus === "untrusted") blockingReasons.push("green proof is untrusted");
  if (
    input.deferredNotVerified &&
    !POSITIVELY_STALE_PROOF.has(input.proofStatus)
  ) {
    blockingReasons.push("deferred work lacks accepted-green or central-integrity proof");
  }

  if (blockingReasons.length > 0) {
    return {
      primaryDisposition: "blocking-failure",
      dispositions: ["blocking-failure"],
      blockingReasons,
    };
  }

  const dispositions: TaskGateDisposition[] = [];
  if (input.executedAndPassed) dispositions.push("executed-and-passed");
  if (input.reusedAcceptedGreenEvidence) dispositions.push("reused-accepted-green-evidence");
  if (input.deferredNotVerified) dispositions.push("deferred-and-not-verified");
  if (input.quarantinedNonBlocking) dispositions.push("quarantined-non-blocking");

  // A successful gate always has an explicit disposition, including unusual
  // lint-only or empty-control invocations with no suite-level signal.
  if (dispositions.length === 0) dispositions.push("executed-and-passed");

  return {
    // The primary label is deterministic; the full list preserves mixed runs
    // such as "executed and passed + reused green + deferred".
    primaryDisposition: dispositions.includes("deferred-and-not-verified")
      ? "deferred-and-not-verified"
      : dispositions.includes("reused-accepted-green-evidence")
        ? "reused-accepted-green-evidence"
        : dispositions.includes("quarantined-non-blocking")
          ? "quarantined-non-blocking"
          : "executed-and-passed",
    dispositions,
    blockingReasons: [],
  };
}