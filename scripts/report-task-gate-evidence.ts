#!/usr/bin/env npx tsx
/**
 * Read-only task-gate evidence report over the retained window (14 days;
 * see TASK_GATE_EVIDENCE_RETENTION_DAYS).
 *
 * Usage:
 *   npx tsx scripts/report-task-gate-evidence.ts
 *   npx tsx scripts/report-task-gate-evidence.ts --json
 */
import {
  TASK_GATE_EVIDENCE_PATH,
  buildTaskGateEvidenceReport,
  readTaskGateEvidence,
} from "./taskGateEvidence";

export function formatTaskGateEvidenceReport(
  report: ReturnType<typeof buildTaskGateEvidenceReport>,
): string {
  const duration =
    report.medianWallMs === null ? "not available" : `${(report.medianWallMs / 60_000).toFixed(2)} min`;
  const p95 =
    report.p95WallMs === null ? "not available" : `${(report.p95WallMs / 60_000).toFixed(2)} min`;
  const fraction =
    report.failureAttribution.unrelatedToDiffFraction === null
      ? "not available (no retained failure observations)"
      : `${(report.failureAttribution.unrelatedToDiffFraction * 100).toFixed(1)}% ` +
        `(${report.failureAttribution.unrelatedToDiff}/${report.failureAttribution.total})`;
  const decisions = report.performance.runner.shardDecisions;
  const decisionSources = Object.entries(decisions.sourceCounts)
    .map(([source, count]) => `${source}=${count}`)
    .join(", ");
  const capReasons = Object.entries(decisions.capReasonCounts)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  const selectionModes = Object.entries(report.selectionModes)
    .map(([mode, count]) => `${mode}=${count}`)
    .join(", ");
  const settings =
    decisions.settings.length === 0
      ? "not available (legacy observations or no retained runner telemetry)"
      : decisions.settings
          .map((setting) => {
            const budgets =
              setting.databaseBudgets.length === 0
                ? "not retained"
                : setting.databaseBudgets
                    .map(
                      (budget) =>
                        `${budget.maxConnections}-${budget.reservedConnections}` +
                        `/${budget.connectionsPerLane}=${budget.laneCap} lanes (${budget.observations})`,
                    )
                    .join("; ");
            return (
              `requested=${setting.requestedShardCount} (${setting.source}), n=${setting.observations}, ` +
              `executed=${setting.executedCount}, ` +
              `effective=${setting.effectiveShardCountMin}-${setting.effectiveShardCountMax}, ` +
              `gate wall median/p95=${setting.medianGateWallMs === null ? "not available" : `${(setting.medianGateWallMs / 1000).toFixed(1)}s`}/${setting.p95GateWallMs === null ? "not available" : `${(setting.p95GateWallMs / 1000).toFixed(1)}s`}, ` +
              `RSS median/p95=${setting.medianMaxRssKb === null ? "not available" : `${setting.medianMaxRssKb} KiB`}/${setting.p95MaxRssKb === null ? "not available" : `${setting.p95MaxRssKb} KiB`}, ` +
              `worker peak=${setting.peakWorkerRssKb} KiB, ` +
              `recycles cap/resource/failure/straggler=${setting.recycleHardCap}/${setting.recycleResourcePressure}/${setting.recycleFailure}/${setting.recycleStraggler}, ` +
              `database policy-cap=${setting.databaseCapLimitedObservations}, ` +
              `cap reasons=${Object.entries(setting.capReasonCounts).map(([reason, count]) => `${reason}=${count}`).join(", ")}, ` +
              `budget=${budgets}`
            );
          })
          .join("\n  - ");
  return [
    "Task-gate evidence report",
    `Window: ${report.windowStartedAt} through ${report.generatedAt} (${report.windowDays} days)`,
    `Observations: ${report.observations.inWindow} unique in-window ` +
      `(${report.observations.duplicatesDropped} duplicate line(s) dropped)`,
    `Completed-gate wall time: median ${duration}; p95 ${p95}`,
    `Cost boundary: repository validation resource use=${report.costBoundary.repositoryValidation.observations} observation(s), ` +
      `wall=${(report.costBoundary.repositoryValidation.totalWallMs / 60_000).toFixed(2)} min, ` +
      `CPU=${report.costBoundary.repositoryValidation.totalCpuMs === null ? "not available" : `${report.costBoundary.repositoryValidation.totalCpuMs.toFixed(0)}ms`}; ` +
      `Replit/model/platform billing=${report.costBoundary.platformOrModelBilling.status} (never estimated from repository telemetry).`,
    `Affordability: $${report.costBoundary.affordability.monthlyCeilingUsd.toLocaleString()}/month ceiling; ` +
      `attributable spend=${report.costBoundary.affordability.attributableSpendUsd === null ? "unavailable" : `$${report.costBoundary.affordability.attributableSpendUsd.toFixed(2)}`}; ` +
      `monthly-normalized spend=${report.costBoundary.affordability.monthlyNormalizedSpendUsd === null ? "unavailable" : `$${report.costBoundary.affordability.monthlyNormalizedSpendUsd.toFixed(2)}`}; ` +
      `outcome=${report.costBoundary.affordability.outcome} (${report.costBoundary.affordability.reason}).`,
    `Outcome separation: executed=${report.outcomes.execution.executedSuites}, ` +
      `green-skipped=${report.outcomes.execution.greenSkippedSuites}, ` +
      `deferred-not-verified=${report.outcomes.execution.deferredNotVerifiedSuites}; ` +
      `quarantined=${report.outcomes.observations.quarantinedNonBlocking}, ` +
      `inherited=${report.outcomes.observations.inheritedFailures}, ` +
      `task-caused=${report.outcomes.observations.taskCausedFailures}, ` +
      `unresolved=${report.outcomes.observations.unresolvedFailures}, ` +
      `incomplete=${report.outcomes.observations.incompleteVerification}.`,
    `Selection evidence: ${selectionModes} (related-smoke = precise related selection; deferred-central-integrity = bounded proof with central debt)`,
    `Lint evidence: ${report.performance.lint.observations} observation(s), ` +
      `median ${report.performance.lint.medianWallMs === null ? "not available" : `${(report.performance.lint.medianWallMs / 1000).toFixed(1)}s`}, ` +
      `p95 ${report.performance.lint.p95WallMs === null ? "not available" : `${(report.performance.lint.p95WallMs / 1000).toFixed(1)}s`}; ` +
      `cache hits=${report.performance.lint.cache.hitChecks}, misses=${report.performance.lint.cache.missChecks}, ` +
      `hit rate=${report.performance.lint.cache.hitFraction === null ? "not available" : `${(report.performance.lint.cache.hitFraction * 100).toFixed(1)}%`}`,
    `Runner evidence: ${report.performance.runner.observations} observation(s), ` +
      `sharded=${report.performance.runner.shardRuns}, lane utilization=${report.performance.runner.laneUtilizationFraction === null ? "not available" : `${(report.performance.runner.laneUtilizationFraction * 100).toFixed(1)}%`}, ` +
      `estimate coverage=${report.performance.runner.estimateKnownCount}/${report.performance.runner.estimateKnownCount + report.performance.runner.estimateUnknownCount}, ` +
      `planned/actual lane imbalance=${report.performance.runner.plannedImbalanceRatio === null ? "not available" : report.performance.runner.plannedImbalanceRatio.toFixed(2)}x/${report.performance.runner.actualImbalanceRatio === null ? "not available" : report.performance.runner.actualImbalanceRatio.toFixed(2)}x`,
    `Batching: first-attempt batched=${report.performance.runner.batching.batchedFirstAttempts}, ` +
      `solo=${report.performance.runner.batching.soloFirstAttempts}, ` +
      `compatible=${report.performance.runner.batching.compatibleFirstAttempts}, ` +
      `process-start-args=${report.performance.runner.batching.incompatibleFirstAttempts}, ` +
      `solo rechecks=${report.performance.runner.batching.batchedFailureSoloRechecks}, ` +
      `worker reuse/start=${report.performance.runner.batching.reusesPerWorkerStart === null ? "not available" : report.performance.runner.batching.reusesPerWorkerStart.toFixed(2)}, ` +
      `avg suites/worker=${report.performance.runner.batching.averageSuitesPerWorker === null ? "not available" : report.performance.runner.batching.averageSuitesPerWorker.toFixed(2)}, ` +
      `solo first-attempt avg (includes suite work)=${report.performance.runner.batching.averageSoloFirstAttemptMs === null ? "not available" : `${Math.round(report.performance.runner.batching.averageSoloFirstAttemptMs)}ms`}, ` +
      `recycles cap/resource/failure/straggler=${report.performance.runner.batching.recycleHardCap}/${report.performance.runner.batching.recycleResourcePressure}/${report.performance.runner.batching.recycleFailure}/${report.performance.runner.batching.recycleStraggler}, ` +
      `peak worker RSS=${report.performance.runner.batching.peakWorkerRssKb} KiB`,
    `Shard decisions: ${decisions.observations} source-tagged observation(s); ` +
      `sources ${decisionSources}; cap reasons ${capReasons}`,
    `Shard setting comparison: ${decisions.qualifiedComparisonObservations} qualified ` +
      `(passing full-smoke, zero-skip, zero-deferral) observation(s); ` +
      `${decisions.excludedComparisonObservations} runner observation(s) excluded.\n  - ${settings}`,
    `Gate-orchestrator resource envelope: ${report.performance.resources.observations} observation(s), ` +
      `max RSS median/p95=${report.performance.resources.medianMaxRssKb === null ? "not available" : `${report.performance.resources.medianMaxRssKb} KiB`}/${report.performance.resources.p95MaxRssKb === null ? "not available" : `${report.performance.resources.p95MaxRssKb} KiB`}, ` +
      `CPU median/p95=${report.performance.resources.medianCpuMs === null ? "not available" : `${report.performance.resources.medianCpuMs.toFixed(0)}ms`}/${report.performance.resources.p95CpuMs === null ? "not available" : `${report.performance.resources.p95CpuMs.toFixed(0)}ms`}`,
    `Unrelated-to-diff failure fraction: ${fraction}`,
    `Failure attribution: inherited=${report.failureAttribution.inherited}, ` +
      `yours=${report.failureAttribution.yours}, ` +
      `unattributable=${report.failureAttribution.unattributable}, ` +
      `unknown=${report.failureAttribution.unknown}`,
    `Validation history: observed linked passes=${report.validationHistory.observed.linkedPasses}, ` +
      `observed linked validator failures=${report.validationHistory.observed.linkedFailures}, ` +
      `unknown=${report.validationHistory.unknown.observations}.`,
    `Policy-required but unobserved checks: not counted (${report.validationHistory.requiredButUnobserved.reason}).`,
    `Documentation-only mentions: not counted (${report.validationHistory.documentationOnlyMentions.reason}).`,
    `Verdicts: pass=${report.verdicts.pass}, fail=${report.verdicts.fail}`,
    `Dispositions: executed-and-passed=${report.dispositions["executed-and-passed"]}, ` +
      `reused-accepted-green-evidence=${report.dispositions["reused-accepted-green-evidence"]}, ` +
      `deferred-and-not-verified=${report.dispositions["deferred-and-not-verified"]}, ` +
      `quarantined-non-blocking=${report.dispositions["quarantined-non-blocking"]}, ` +
      `blocking-failure=${report.dispositions["blocking-failure"]}`,
    `Execution: executed=${report.execution.executed}, skipped=${report.execution.skipped}, ` +
      `deferred=${report.execution.deferred}`,
    `Retention: newest ${report.retention.maxRecords} records within ${report.retention.maxAgeDays} days ` +
      `(${TASK_GATE_EVIDENCE_PATH})`,
    `Evidence readiness: ${report.readiness.observedInWindow}/${report.readiness.minObservationsForReadiness} ` +
      `completed-gate observation(s) in the ${report.windowDays}-day window ` +
      `(floor ${report.readiness.meetsObservationFloor ? "met" : "not met"}); ` +
      `a met floor plus the full calendar window are both required before a re-review decision, ` +
      `elapsed time alone is not sufficient.`,
  ].join("\n");
}

export function cliMain(): number {
  const report = buildTaskGateEvidenceReport(readTaskGateEvidence());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTaskGateEvidenceReport(report));
  }
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("scripts/report-task-gate-evidence.ts") ?? false);

if (isMain) process.exit(cliMain());