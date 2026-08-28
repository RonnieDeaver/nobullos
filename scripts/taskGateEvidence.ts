/**
 * Bounded, privacy-safe evidence for completed task gates.
 *
 * The ledger deliberately stores aggregate control-plane facts plus the
 * minimum optional task/delivery correlation needed to audit which change a
 * gate checked. It stores no test names/paths, output, user identifiers,
 * environment values, error text, task prose, or commit messages. Persistence
 * is best-effort and must never change a gate verdict.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  TASK_GATE_DISPOSITIONS,
  type TaskGateDisposition,
} from "./taskGatePolicy";

export const TASK_GATE_EVIDENCE_SCHEMA_VERSION = 1;
export const TASK_GATE_PROVENANCE_SCHEMA_VERSION = 1;
export const TASK_GATE_EVIDENCE_PATH = ".local/runs/task-gate-evidence.jsonl";
/**
 * Calendar retention window, shortened from 42 to 14 days by the
 * 2026-08-26 decision-ledger entry (owner-approved, cost/token-pressure
 * reversal of the 2026-08-19 42-day deferral). 14 days is the shortest span
 * that still spans at least two full weekly rotation/full-integrity-sweep
 * cycles; see `audits/governance/decision-ledger.md`.
 */
export const TASK_GATE_EVIDENCE_RETENTION_DAYS = 14;
/**
 * Minimum number of unique, in-window completed-gate observations required
 * before the retained window may be treated as "ready" for a re-review
 * decision. Added alongside the shortened calendar window (2026-08-26) so a
 * quiet 14-day stretch with only one or two gates cannot fake population
 * diversity the way a bare calendar cutoff could; report-only, never a gate
 * verdict input.
 */
export const TASK_GATE_EVIDENCE_MIN_OBSERVATIONS_FOR_READINESS = 20;
export const TASK_GATE_EVIDENCE_MAX_RECORDS = 5_000;
export const TASK_GATE_SHARD_COUNT_SOURCES = ["serial", "flag", "env", "default"] as const;
export const TASK_GATE_SHARD_CAP_REASONS = [
  "serial-mode",
  "cpu",
  "memory-headroom",
  "database-connections",
  "worker-processes",
  "selected-suite-count",
  "hermetic-fallback",
  "shard-db-provisioning",
] as const;

const DAY_MS = 86_400_000;
const LOCK_WAIT_MS = 25;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_STALE_MS = 60_000;
const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

export type TaskGateShardCountSource = (typeof TASK_GATE_SHARD_COUNT_SOURCES)[number];
export type TaskGateShardCapReason = (typeof TASK_GATE_SHARD_CAP_REASONS)[number];

export type TaskGateSelectionMode =
  | "related-smoke"
  | "deferred-central-integrity"
  | "full-smoke"
  | "smoke-unresolved"
  | "smoke-skipped"
  | "lint-only";

export type TaskGateVerdict = "pass" | "fail";

export interface TaskGateProvenance {
  schemaVersion: typeof TASK_GATE_PROVENANCE_SCHEMA_VERSION;
  /** Numeric tracker reference only; no title, prompt, user, or public URL. */
  taskRef: string;
  /** Exact source revision whose tree the validation process observed. */
  validatedCommit: string;
  /** Exact Git tree assembled from the tracked and untracked source validated. */
  validatedTree: string;
  /**
   * Exact delivered revision, attached by the completion/merge boundary.
   * Omission is intentionally incomplete provenance, never an inferred link.
   */
  deliveryCommit?: string;
}

export interface TaskGateAttributionSummary {
  /** Failures proven disjoint from the task diff. */
  inherited: number;
  /** Failures attributed to the task under the conservative attribution rails. */
  yours: number;
  /** Failures blocked because the upstream baseline was stale. */
  unattributable: number;
  /** Failed checks for which no fresh structured attribution was available. */
  unknown: number;
}

/**
 * Aggregate-only performance facts. These intentionally contain no suite,
 * file, command, environment, output, task, commit, or user identity.
 */
export interface TaskGatePerformanceSummary {
  lint: {
    wallMs: number;
    concurrency: number;
    cacheEligibleChecks: number;
    cacheHitChecks: number;
    cacheMissChecks: number;
  };
  runner: {
    shardCount: number;
    /** Optional so observations written before resource-policy telemetry remain valid. */
    requestedShardCount?: number;
    shardCountSource?: TaskGateShardCountSource;
    shardCapReasons?: TaskGateShardCapReason[];
    /**
     * Capacity policy facts, not live PostgreSQL utilization. Optional so
     * observations written before the benchmark comparison remain valid.
     */
    databaseBudget?: {
      maxConnections: number;
      reservedConnections: number;
      connectionsPerLane: number;
      laneCap: number;
    };
    activeLaneCount: number;
    estimateKnownCount: number;
    estimateUnknownCount: number;
    plannedLaneTotalMs: number;
    plannedLaneMinMs: number;
    plannedLaneMaxMs: number;
    actualLaneTotalMs: number;
    actualLaneMinMs: number;
    actualLaneMaxMs: number;
    /** Optional so observations written before batch-efficiency telemetry remain valid. */
    batchCompatibleFirstAttempts?: number;
    batchIncompatibleFirstAttempts?: number;
    batchedFirstAttempts: number;
    soloFirstAttempts: number;
    soloFirstAttemptElapsedMs?: number;
    batchedFailureSoloRechecks: number;
    batchWorkerStarts: number;
    batchWorkerReuses: number;
    batchWorkerSuiteRuns?: number;
    batchWorkerPeakRssKb?: number;
    batchWorkerRecyclesHardCap?: number;
    batchWorkerRecyclesResourcePressure?: number;
    batchWorkerRecyclesFailure?: number;
    batchWorkerRecyclesStraggler?: number;
  } | null;
  resources: {
    maxRssKb: number;
    cpuUserMicros: number;
    cpuSystemMicros: number;
  };
}

export interface TaskGateEvidenceRecord {
  schemaVersion: typeof TASK_GATE_EVIDENCE_SCHEMA_VERSION;
  /** Unique per gate invocation; contains no task, commit, user, or suite data. */
  observationId: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  selectionMode: TaskGateSelectionMode;
  executedCount: number;
  skippedCount: number;
  deferredCount: number;
  verdict: TaskGateVerdict;
  /**
   * Additive policy labels. Optional for pre-policy records; newly written
   * records always include both the primary and mixed-run labels.
   */
  primaryDisposition?: TaskGateDisposition;
  dispositions?: TaskGateDisposition[];
  attribution: TaskGateAttributionSummary;
  /** Optional for legacy or non-task gates; incomplete links remain unknown. */
  provenance?: TaskGateProvenance;
  /** Optional for records written before aggregate performance evidence. */
  performance?: TaskGatePerformanceSummary;
}

export interface TaskGateEvidenceReport {
  schemaVersion: 1;
  generatedAt: string;
  windowDays: typeof TASK_GATE_EVIDENCE_RETENTION_DAYS;
  windowStartedAt: string;
  retention: {
    maxAgeDays: typeof TASK_GATE_EVIDENCE_RETENTION_DAYS;
    maxRecords: typeof TASK_GATE_EVIDENCE_MAX_RECORDS;
  };
  observations: {
    parsed: number;
    unique: number;
    duplicatesDropped: number;
    inWindow: number;
    outsideWindow: number;
  };
  /**
   * Report-only readiness signal (2026-08-26): a calendar window alone
   * cannot prove population diversity, so re-review readiness also requires
   * a minimum in-window observation count. Never consumed by gate
   * selection, verdict, or policy logic.
   */
  readiness: {
    minObservationsForReadiness: typeof TASK_GATE_EVIDENCE_MIN_OBSERVATIONS_FOR_READINESS;
    observedInWindow: number;
    meetsObservationFloor: boolean;
  };
  medianWallMs: number | null;
  p95WallMs: number | null;
  verdicts: Record<TaskGateVerdict, number>;
  selectionModes: Record<TaskGateSelectionMode, number>;
  dispositions: Record<TaskGateDisposition, number>;
  execution: {
    executed: number;
    skipped: number;
    deferred: number;
  };
  failureAttribution: TaskGateAttributionSummary & {
    total: number;
    unrelatedToDiff: number;
    unrelatedToDiffFraction: number | null;
  };
  validationHistory: {
    observed: {
      linkedPasses: number;
      linkedFailures: number;
    };
    requiredButUnobserved: {
      count: null;
      reason: "policy requirements are not execution observations";
    };
    documentationOnlyMentions: {
      count: null;
      reason: "documentation mentions are not execution observations";
    };
    unknown: {
      observations: number;
      reason: "missing or malformed task-delivery-validation provenance";
    };
  };
  /**
   * The repository can measure only its own aggregate validation resource
   * consumption. Replit, model, and other platform billing are deliberately
   * not inferred from wall time, CPU, test counts, or task observations.
   */
  costBoundary: {
    repositoryValidation: {
      status: "measured-resource-usage";
      observations: number;
      totalWallMs: number;
      resourceTelemetryObservations: number;
      totalCpuMs: number | null;
    };
    platformOrModelBilling: {
      status: "unavailable";
      reason: "repository telemetry does not expose Replit, model, or platform billing";
    };
    affordability: {
      monthlyCeilingUsd: 5_000;
      attributableSpendUsd: null;
      monthlyNormalizedSpendUsd: null;
      outcome: "inconclusive";
      reason: "no observable currency billing or monthly task-volume denominator";
    };
  };
  /** Explicit outcome labels; all values derive from the existing bounded record. */
  outcomes: {
    execution: {
      executedSuites: number;
      greenSkippedSuites: number;
      deferredNotVerifiedSuites: number;
    };
    observations: {
      quarantinedNonBlocking: number;
      inheritedFailures: number;
      taskCausedFailures: number;
      unresolvedFailures: number;
      incompleteVerification: number;
    };
  };
  performance: {
    lint: {
      observations: number;
      medianWallMs: number | null;
      p95WallMs: number | null;
      cache: {
        eligibleChecks: number;
        hitChecks: number;
        missChecks: number;
        hitFraction: number | null;
      };
    };
    runner: {
      observations: number;
      shardRuns: number;
      laneSlots: number;
      activeLaneSlots: number;
      laneUtilizationFraction: number | null;
      estimateKnownCount: number;
      estimateUnknownCount: number;
      plannedLaneTotalMs: number;
      actualLaneTotalMs: number;
      plannedImbalanceRatio: number | null;
      actualImbalanceRatio: number | null;
        shardDecisions: {
          observations: number;
          qualifiedComparisonObservations: number;
          excludedComparisonObservations: number;
          sourceCounts: Record<TaskGateShardCountSource, number>;
          capReasonCounts: Record<TaskGateShardCapReason, number>;
          settings: Array<{
            requestedShardCount: number;
            source: TaskGateShardCountSource;
            executedCount: number;
            observations: number;
            effectiveShardCountMin: number;
            effectiveShardCountMax: number;
            medianGateWallMs: number | null;
            p95GateWallMs: number | null;
            medianMaxRssKb: number | null;
            p95MaxRssKb: number | null;
            peakWorkerRssKb: number;
            recycleHardCap: number;
            recycleResourcePressure: number;
            recycleFailure: number;
            recycleStraggler: number;
            databaseCapLimitedObservations: number;
            capReasonCounts: Record<TaskGateShardCapReason, number>;
            databaseBudgets: Array<{
              maxConnections: number;
              reservedConnections: number;
              connectionsPerLane: number;
              laneCap: number;
              observations: number;
            }>;
          }>;
        };
      batching: {
        batchedFirstAttempts: number;
        soloFirstAttempts: number;
        compatibleFirstAttempts: number;
        incompatibleFirstAttempts: number;
        soloFirstAttemptElapsedMs: number;
        batchedFailureSoloRechecks: number;
        workerStarts: number;
        workerReuses: number;
        workerSuiteRuns: number;
        peakWorkerRssKb: number;
        recycleHardCap: number;
        recycleResourcePressure: number;
        recycleFailure: number;
        recycleStraggler: number;
        reusesPerWorkerStart: number | null;
        averageSuitesPerWorker: number | null;
        averageSoloFirstAttemptMs: number | null;
      };
    };
    resources: {
      observations: number;
      medianMaxRssKb: number | null;
      p95MaxRssKb: number | null;
      medianCpuMs: number | null;
      p95CpuMs: number | null;
    };
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSelectionMode(value: unknown): value is TaskGateSelectionMode {
  return (
    value === "related-smoke" ||
    value === "deferred-central-integrity" ||
    value === "full-smoke" ||
    value === "smoke-unresolved" ||
    value === "smoke-skipped" ||
    value === "lint-only"
  );
}

function isDisposition(value: unknown): value is TaskGateDisposition {
  return TASK_GATE_DISPOSITIONS.includes(value as TaskGateDisposition);
}

function isAttributionSummary(value: unknown): value is TaskGateAttributionSummary {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<TaskGateAttributionSummary>;
  return (
    isNonNegativeInteger(a.inherited) &&
    isNonNegativeInteger(a.yours) &&
    isNonNegativeInteger(a.unattributable) &&
    isNonNegativeInteger(a.unknown)
  );
}

function isCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isTaskRef(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

export function isTaskGateProvenance(value: unknown): value is TaskGateProvenance {
  if (!value || typeof value !== "object") return false;
  const provenance = value as Partial<TaskGateProvenance>;
  return (
    provenance.schemaVersion === TASK_GATE_PROVENANCE_SCHEMA_VERSION &&
    isTaskRef(provenance.taskRef) &&
    isCommitId(provenance.validatedCommit) &&
    isCommitId(provenance.validatedTree) &&
    (provenance.deliveryCommit === undefined || isCommitId(provenance.deliveryCommit))
  );
}

export function buildTaskGateProvenance(
  input: {
    taskRef?: string;
    validatedCommit?: string;
    validatedTree?: string;
    deliveryCommit?: string;
  },
): TaskGateProvenance | undefined {
  const candidate = {
    schemaVersion: TASK_GATE_PROVENANCE_SCHEMA_VERSION,
    taskRef: input.taskRef?.replace(/^#/, ""),
    validatedCommit: input.validatedCommit?.toLowerCase(),
    validatedTree: input.validatedTree?.toLowerCase(),
    ...(input.deliveryCommit ? { deliveryCommit: input.deliveryCommit.toLowerCase() } : {}),
  };
  return isTaskGateProvenance(candidate) ? candidate : undefined;
}

export function captureTaskGateSource(
  repoRoot: string = process.cwd(),
): { validatedCommit: string; validatedTree: string } | undefined {
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(resolve(tmpdir(), "task-gate-source-"));
    const indexPath = resolve(scratch, "index");
    const git = (args: string[]) =>
      spawnSync("git", args, {
        cwd: repoRoot,
        env: { ...process.env, GIT_INDEX_FILE: indexPath },
        encoding: "utf8",
        shell: false,
      });
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
    });
    if (head.status !== 0 || head.error) return undefined;
    if (git(["read-tree", "HEAD"]).status !== 0) return undefined;
    if (git(["add", "-A", "--", "."]).status !== 0) return undefined;
    const tree = git(["write-tree"]);
    const source = {
      validatedCommit: head.stdout.trim().toLowerCase(),
      validatedTree: tree.stdout.trim().toLowerCase(),
    };
    return isCommitId(source.validatedCommit) && isCommitId(source.validatedTree)
      ? source
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // Provenance capture is report-only and cannot change a gate verdict.
      }
    }
  }
}

function isPerformanceSummary(value: unknown): value is TaskGatePerformanceSummary {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<TaskGatePerformanceSummary>;
  const lint = p.lint;
  const resources = p.resources;
  const runner = p.runner;
  const counters = (input: unknown, keys: readonly string[]): boolean =>
    Boolean(input) &&
    typeof input === "object" &&
    keys.every((key) => isNonNegativeInteger((input as Record<string, unknown>)[key]));
  return (
    counters(lint, [
      "wallMs",
      "concurrency",
      "cacheEligibleChecks",
      "cacheHitChecks",
      "cacheMissChecks",
    ]) &&
    lint!.concurrency >= 1 &&
    lint!.cacheHitChecks + lint!.cacheMissChecks === lint!.cacheEligibleChecks &&
    counters(resources, ["maxRssKb", "cpuUserMicros", "cpuSystemMicros"]) &&
    (runner === null ||
      (counters(runner, [
        "shardCount",
        "activeLaneCount",
        "estimateKnownCount",
        "estimateUnknownCount",
        "plannedLaneTotalMs",
        "plannedLaneMinMs",
        "plannedLaneMaxMs",
        "actualLaneTotalMs",
        "actualLaneMinMs",
        "actualLaneMaxMs",
        "batchedFirstAttempts",
        "soloFirstAttempts",
        "batchedFailureSoloRechecks",
        "batchWorkerStarts",
        "batchWorkerReuses",
      ]) &&
        [
          "batchCompatibleFirstAttempts",
          "batchIncompatibleFirstAttempts",
          "soloFirstAttemptElapsedMs",
          "batchWorkerSuiteRuns",
          "batchWorkerPeakRssKb",
          "batchWorkerRecyclesHardCap",
          "batchWorkerRecyclesResourcePressure",
          "batchWorkerRecyclesFailure",
          "batchWorkerRecyclesStraggler",
        ].every((key) => runner[key] === undefined || isNonNegativeInteger(runner[key])) &&
        (runner.requestedShardCount === undefined ||
          (isNonNegativeInteger(runner.requestedShardCount) && runner.requestedShardCount >= 1)) &&
        (runner.shardCountSource === undefined ||
          TASK_GATE_SHARD_COUNT_SOURCES.includes(runner.shardCountSource)) &&
        (runner.shardCapReasons === undefined ||
          (Array.isArray(runner.shardCapReasons) &&
            runner.shardCapReasons.every((reason) =>
              TASK_GATE_SHARD_CAP_REASONS.includes(reason),
            ))) &&
        (runner.databaseBudget === undefined ||
          (counters(runner.databaseBudget, [
            "maxConnections",
            "reservedConnections",
            "connectionsPerLane",
            "laneCap",
          ]) &&
            runner.databaseBudget.maxConnections >= runner.databaseBudget.reservedConnections &&
            runner.databaseBudget.connectionsPerLane >= 1 &&
            runner.databaseBudget.laneCap >= 1 &&
            runner.databaseBudget.laneCap <=
              Math.floor(
                (runner.databaseBudget.maxConnections - runner.databaseBudget.reservedConnections) /
                  runner.databaseBudget.connectionsPerLane,
              ))) &&
        runner.shardCount >= 1 &&
        runner.activeLaneCount <= runner.shardCount &&
        runner.plannedLaneMinMs <= runner.plannedLaneMaxMs &&
        runner.actualLaneMinMs <= runner.actualLaneMaxMs))
  );
}

export function isTaskGateEvidenceRecord(value: unknown): value is TaskGateEvidenceRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<TaskGateEvidenceRecord>;
  const startedMs = Date.parse(r.startedAt ?? "");
  const finishedMs = Date.parse(r.finishedAt ?? "");
  return (
    r.schemaVersion === TASK_GATE_EVIDENCE_SCHEMA_VERSION &&
    typeof r.observationId === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[1-9]\d*$/.test(r.observationId) &&
    Number.isFinite(startedMs) &&
    Number.isFinite(finishedMs) &&
    finishedMs >= startedMs &&
    isFiniteNonNegative(r.wallMs) &&
    isSelectionMode(r.selectionMode) &&
    isNonNegativeInteger(r.executedCount) &&
    isNonNegativeInteger(r.skippedCount) &&
    isNonNegativeInteger(r.deferredCount) &&
    (r.verdict === "pass" || r.verdict === "fail") &&
    (r.primaryDisposition === undefined || isDisposition(r.primaryDisposition)) &&
    (r.dispositions === undefined ||
      (Array.isArray(r.dispositions) && r.dispositions.every(isDisposition))) &&
    isAttributionSummary(r.attribution) &&
    (r.provenance === undefined || isTaskGateProvenance(r.provenance)) &&
    (r.performance === undefined || isPerformanceSummary(r.performance))
  );
}

function canonicalRecord(record: TaskGateEvidenceRecord): TaskGateEvidenceRecord {
  return {
    schemaVersion: TASK_GATE_EVIDENCE_SCHEMA_VERSION,
    observationId: record.observationId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    wallMs: record.wallMs,
    selectionMode: record.selectionMode,
    executedCount: record.executedCount,
    skippedCount: record.skippedCount,
    deferredCount: record.deferredCount,
    verdict: record.verdict,
    ...(record.primaryDisposition ? { primaryDisposition: record.primaryDisposition } : {}),
    ...(record.dispositions ? { dispositions: [...record.dispositions] } : {}),
    attribution: {
      inherited: record.attribution.inherited,
      yours: record.attribution.yours,
      unattributable: record.attribution.unattributable,
      unknown: record.attribution.unknown,
    },
    ...(record.provenance
      ? {
          provenance: {
            schemaVersion: TASK_GATE_PROVENANCE_SCHEMA_VERSION,
            taskRef: record.provenance.taskRef,
            validatedCommit: record.provenance.validatedCommit,
            validatedTree: record.provenance.validatedTree,
            ...(record.provenance.deliveryCommit
              ? { deliveryCommit: record.provenance.deliveryCommit }
              : {}),
          },
        }
      : {}),
    ...(record.performance
      ? {
          performance: {
            lint: { ...record.performance.lint },
            runner: record.performance.runner
              ? {
                  ...record.performance.runner,
                  ...(record.performance.runner.shardCapReasons
                    ? { shardCapReasons: [...record.performance.runner.shardCapReasons] }
                    : {}),
                   ...(record.performance.runner.databaseBudget
                     ? { databaseBudget: { ...record.performance.runner.databaseBudget } }
                     : {}),
                }
              : null,
            resources: { ...record.performance.resources },
          },
        }
      : {}),
  };
}

function newerRecord(
  current: TaskGateEvidenceRecord | undefined,
  candidate: TaskGateEvidenceRecord,
): TaskGateEvidenceRecord {
  if (!current) return candidate;
  const currentFinished = Date.parse(current.finishedAt);
  const candidateFinished = Date.parse(candidate.finishedAt);
  if (candidateFinished !== currentFinished) {
    return candidateFinished > currentFinished ? candidate : current;
  }
  const currentStarted = Date.parse(current.startedAt);
  const candidateStarted = Date.parse(candidate.startedAt);
  if (candidateStarted !== currentStarted) {
    return candidateStarted > currentStarted ? candidate : current;
  }
  // Deterministic tie-break: input/file order cannot change the aggregate.
  return JSON.stringify(candidate) > JSON.stringify(current) ? candidate : current;
}

function deduplicateNewest(
  records: readonly TaskGateEvidenceRecord[],
): Map<string, TaskGateEvidenceRecord> {
  const byId = new Map<string, TaskGateEvidenceRecord>();
  for (const record of records) {
    byId.set(record.observationId, newerRecord(byId.get(record.observationId), record));
  }
  return byId;
}

function acquireLedgerLock(
  ledgerPath: string,
): { fd: number; path: string; token: string } | null {
  const lockPath = `${ledgerPath}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryOwnerPath = resolve(recoveryPath, "owner");
  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const clearDeadRecovery = (): void => {
    try {
      const [pidText, startedText] = readFileSync(recoveryOwnerPath, "utf8").split(":");
      const pid = Number.parseInt(pidText, 10);
      const startedAt = Number.parseInt(startedText, 10);
      if (Date.now() - startedAt > LOCK_STALE_MS && !pidIsAlive(pid)) {
        rmSync(recoveryPath, { recursive: true, force: true });
      }
    } catch {
      try {
        if (Date.now() - statSync(recoveryPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(recoveryPath, { recursive: true, force: true });
        }
      } catch {
        /* recovery disappeared */
      }
    }
  };
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    if (existsSync(recoveryPath)) {
      clearDeadRecovery();
      Atomics.wait(SLEEP_WORD, 0, 0, LOCK_WAIT_MS);
      continue;
    }
    try {
      const fd = openSync(lockPath, "wx");
      const token = `${process.pid}:${Date.now()}`;
      try {
        writeFileSync(fd, token, "utf8");
        fsyncSync(fd);
        return { fd, path: lockPath, token };
      } catch {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          /* nothing to clean */
        }
        return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          const observedToken = readFileSync(lockPath, "utf8");
          const ownerPid = Number.parseInt(observedToken.split(":", 1)[0], 10);
          if (!pidIsAlive(ownerPid)) {
            try {
              mkdirSync(recoveryPath);
              writeFileSync(recoveryOwnerPath, `${process.pid}:${Date.now()}`, "utf8");
            } catch {
              Atomics.wait(SLEEP_WORD, 0, 0, LOCK_WAIT_MS);
              continue;
            }
            try {
              if (readFileSync(lockPath, "utf8") === observedToken) unlinkSync(lockPath);
            } finally {
              rmSync(recoveryPath, { recursive: true, force: true });
            }
            continue;
          }
        }
      } catch {
        // Lock disappeared between open/stat attempts; retry immediately.
        continue;
      }
      Atomics.wait(SLEEP_WORD, 0, 0, LOCK_WAIT_MS);
    }
  }
  return null;
}

function releaseLedgerLock(lock: { fd: number; path: string; token: string }): void {
  try {
    closeSync(lock.fd);
  } catch {
    /* already closed */
  }
  try {
    if (readFileSync(lock.path, "utf8") === lock.token) unlinkSync(lock.path);
  } catch {
    /* lock cleanup is best-effort */
  }
}

function resolveLedgerPath(path: string, repoRoot: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function fsyncParentDirectory(path: string): void {
  try {
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Some filesystems do not permit directory fsync.
  }
}

/**
 * Read valid records in file order. Missing files and torn/foreign lines are
 * tolerated so measurement cannot become a new gate failure mode.
 */
export function readTaskGateEvidence(
  ledgerPath: string = TASK_GATE_EVIDENCE_PATH,
  repoRoot: string = process.cwd(),
): TaskGateEvidenceRecord[] {
  try {
    const raw = readFileSync(resolveLedgerPath(ledgerPath, repoRoot), "utf8");
    const records: TaskGateEvidenceRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isTaskGateEvidenceRecord(parsed)) {
          records.push(canonicalRecord(parsed));
          continue;
        }
        // Provenance is additive audit metadata. A malformed link becomes
        // unknown history without erasing an otherwise valid observation.
        if (parsed && typeof parsed === "object" && "provenance" in parsed) {
          const withoutProvenance = { ...(parsed as Record<string, unknown>) };
          delete withoutProvenance.provenance;
          if (isTaskGateEvidenceRecord(withoutProvenance)) {
            records.push(canonicalRecord(withoutProvenance));
          }
        }
      } catch {
        // Ignore a torn append; all other valid observations remain usable.
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Append one completed-gate observation and atomically rewrite the bounded
 * ledger. Records older than TASK_GATE_EVIDENCE_RETENTION_DAYS (14) days are
 * discarded, then the newest 5,000 are retained. Duplicate observation IDs
 * collapse to their newest occurrence.
 *
 * Returns false on IO failure and never throws; telemetry cannot flip a gate.
 */
export function appendTaskGateEvidence(
  record: TaskGateEvidenceRecord,
  options: {
    ledgerPath?: string;
    repoRoot?: string;
    now?: Date;
  } = {},
): boolean {
  try {
    if (!isTaskGateEvidenceRecord(record)) return false;
    const sanitizedRecord = canonicalRecord(record);
    const repoRoot = options.repoRoot ?? process.cwd();
    const ledgerPath = resolveLedgerPath(options.ledgerPath ?? TASK_GATE_EVIDENCE_PATH, repoRoot);
    const now = options.now ?? new Date();
    if (Date.parse(sanitizedRecord.finishedAt) > now.getTime() + 1_000) return false;
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const lock = acquireLedgerLock(ledgerPath);
    if (!lock) return false;
    try {
      const cutoffMs = now.getTime() - TASK_GATE_EVIDENCE_RETENTION_DAYS * DAY_MS;
      const retainedPrior = readTaskGateEvidence(ledgerPath, repoRoot).filter(
        (prior) => Date.parse(prior.finishedAt) >= cutoffMs,
      );
      const byId = deduplicateNewest(retainedPrior);
      byId.set(
        sanitizedRecord.observationId,
        newerRecord(byId.get(sanitizedRecord.observationId), sanitizedRecord),
      );
      const kept = [...byId.values()]
        .filter((candidate) => Date.parse(candidate.finishedAt) >= cutoffMs)
        .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))
        .slice(-TASK_GATE_EVIDENCE_MAX_RECORDS);

      const tmp = `${ledgerPath}.tmp-${process.pid}`;
      writeFileSync(tmp, kept.map((candidate) => JSON.stringify(candidate)).join("\n") + "\n", "utf8");
      const tmpFd = openSync(tmp, "r");
      try {
        fsyncSync(tmpFd);
      } finally {
        closeSync(tmpFd);
      }
      renameSync(tmp, ledgerPath);
      fsyncParentDirectory(ledgerPath);
      return true;
    } finally {
      releaseLedgerLock(lock);
    }
  } catch {
    return false;
  }
}

/**
 * Completion/merge-boundary handoff. It attaches the final delivered commit
 * to one already-retained validation observation only when the task and
 * validated revision match exactly. Missing records, malformed input, and
 * conflicting replays fail closed; the evidence ledger remains unchanged.
 */
export function attachTaskGateDelivery(
  link: {
    observationId: string;
    taskRef: string;
    validatedCommit: string;
    validatedTree: string;
    deliveryCommit: string;
  },
  options: {
    ledgerPath?: string;
    repoRoot?: string;
    now?: Date;
  } = {},
): boolean {
  try {
    const provenance = buildTaskGateProvenance(link);
    if (!provenance?.deliveryCommit) return false;
    const repoRoot = options.repoRoot ?? process.cwd();
    const ledgerPath = resolveLedgerPath(options.ledgerPath ?? TASK_GATE_EVIDENCE_PATH, repoRoot);
    const now = options.now ?? new Date();
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const lock = acquireLedgerLock(ledgerPath);
    if (!lock) return false;
    try {
      const cutoffMs = now.getTime() - TASK_GATE_EVIDENCE_RETENTION_DAYS * DAY_MS;
      const records = [...deduplicateNewest(readTaskGateEvidence(ledgerPath, repoRoot)).values()]
        .filter((record) => Date.parse(record.finishedAt) >= cutoffMs);
      const index = records.findIndex((record) => record.observationId === link.observationId);
      if (index < 0) return false;
      const current = records[index];
      if (
        !current.provenance ||
        current.provenance.taskRef !== provenance.taskRef ||
        current.provenance.validatedCommit !== provenance.validatedCommit ||
        current.provenance.validatedTree !== provenance.validatedTree ||
        (current.provenance.deliveryCommit !== undefined &&
          current.provenance.deliveryCommit !== provenance.deliveryCommit)
      ) {
        return false;
      }
      const commitExists = spawnSync(
        "git",
        ["cat-file", "-e", `${provenance.validatedCommit}^{commit}`],
        { cwd: repoRoot, stdio: "ignore", shell: false },
      );
      const deliveryExists = spawnSync(
        "git",
        ["cat-file", "-e", `${provenance.deliveryCommit}^{commit}`],
        { cwd: repoRoot, stdio: "ignore", shell: false },
      );
      const ancestry = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", provenance.validatedCommit, provenance.deliveryCommit],
        { cwd: repoRoot, stdio: "ignore", shell: false },
      );
      const deliveryTree = spawnSync(
        "git",
        ["rev-parse", `${provenance.deliveryCommit}^{tree}`],
        { cwd: repoRoot, encoding: "utf8", shell: false },
      );
      if (
        commitExists.status !== 0 ||
        deliveryExists.status !== 0 ||
        ancestry.status !== 0 ||
        deliveryTree.status !== 0 ||
        deliveryTree.error ||
        deliveryTree.stdout.trim().toLowerCase() !== provenance.validatedTree
      ) {
        return false;
      }
      records[index] = canonicalRecord({ ...current, provenance });
      const kept = records
        .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))
        .slice(-TASK_GATE_EVIDENCE_MAX_RECORDS);
      const tmp = `${ledgerPath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, kept.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
      const tmpFd = openSync(tmp, "r");
      try {
        fsyncSync(tmpFd);
      } finally {
        closeSync(tmpFd);
      }
      renameSync(tmp, ledgerPath);
      fsyncParentDirectory(ledgerPath);
      return true;
    } finally {
      releaseLedgerLock(lock);
    }
  } catch {
    return false;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

/**
 * Build the retained-window report (14 days, see
 * TASK_GATE_EVIDENCE_RETENTION_DAYS). Observation IDs are de-duplicated
 * before every aggregate, so a replayed line cannot inflate either the
 * median or fraction. The report also surfaces whether the in-window
 * observation count meets TASK_GATE_EVIDENCE_MIN_OBSERVATIONS_FOR_READINESS,
 * so a quiet window cannot fake readiness on elapsed time alone.
 */
export function buildTaskGateEvidenceReport(
  parsedRecords: readonly TaskGateEvidenceRecord[],
  now: Date = new Date(),
): TaskGateEvidenceReport {
  const byId = deduplicateNewest(parsedRecords);
  const uniqueRecords = [...byId.values()];
  const windowStartedMs = now.getTime() - TASK_GATE_EVIDENCE_RETENTION_DAYS * DAY_MS;
  const inWindow = uniqueRecords.filter((record) => {
    const finishedMs = Date.parse(record.finishedAt);
    return finishedMs >= windowStartedMs && finishedMs <= now.getTime();
  });

  const attribution: TaskGateAttributionSummary = {
    inherited: 0,
    yours: 0,
    unattributable: 0,
    unknown: 0,
  };
  const verdicts: Record<TaskGateVerdict, number> = { pass: 0, fail: 0 };
  const selectionModes: Record<TaskGateSelectionMode, number> = {
    "related-smoke": 0,
    "deferred-central-integrity": 0,
    "full-smoke": 0,
    "smoke-unresolved": 0,
    "smoke-skipped": 0,
    "lint-only": 0,
  };
  const dispositions: Record<TaskGateDisposition, number> = {
    "executed-and-passed": 0,
    "reused-accepted-green-evidence": 0,
    "deferred-and-not-verified": 0,
    "quarantined-non-blocking": 0,
    "blocking-failure": 0,
  };
  let executed = 0;
  let skipped = 0;
  let deferred = 0;
  let quarantinedNonBlockingObservations = 0;
  let incompleteVerificationObservations = 0;
  let linkedPasses = 0;
  let linkedFailures = 0;
  let unknownHistoryObservations = 0;
  let totalCpuMs = 0;
  const lintWallMs: number[] = [];
  const resourceRss: number[] = [];
  const resourceCpuMs: number[] = [];
  let cacheEligibleChecks = 0;
  let cacheHitChecks = 0;
  let cacheMissChecks = 0;
  let runnerObservations = 0;
  let shardRuns = 0;
  let laneSlots = 0;
  let activeLaneSlots = 0;
  let estimateKnownCount = 0;
  let estimateUnknownCount = 0;
  let plannedLaneTotalMs = 0;
  let actualLaneTotalMs = 0;
  const plannedImbalanceRatios: number[] = [];
  const actualImbalanceRatios: number[] = [];
  let batchedFirstAttempts = 0;
  let soloFirstAttempts = 0;
  let compatibleFirstAttempts = 0;
  let incompatibleFirstAttempts = 0;
  let soloFirstAttemptElapsedMs = 0;
  let batchedFailureSoloRechecks = 0;
  let workerStarts = 0;
  let workerReuses = 0;
  let workerSuiteRuns = 0;
  let workerStartsWithSuiteRuns = 0;
  let soloFirstAttemptsWithElapsed = 0;
  let peakWorkerRssKb = 0;
  let recycleHardCap = 0;
  let recycleResourcePressure = 0;
  let recycleFailure = 0;
  let recycleStraggler = 0;
  const decisionSourceCounts: Record<TaskGateShardCountSource, number> = {
    serial: 0,
    flag: 0,
    env: 0,
    default: 0,
  };
  const capReasonCounts: Record<TaskGateShardCapReason, number> = {
    "serial-mode": 0,
    cpu: 0,
    "memory-headroom": 0,
    "database-connections": 0,
    "worker-processes": 0,
    "selected-suite-count": 0,
    "hermetic-fallback": 0,
    "shard-db-provisioning": 0,
  };
  const settingAggregates = new Map<
    string,
    {
      requestedShardCount: number;
      source: TaskGateShardCountSource;
      executedCount: number;
      effectiveShardCounts: number[];
      wallMs: number[];
      maxRssKb: number[];
      peakWorkerRssKb: number;
      recycleHardCap: number;
      recycleResourcePressure: number;
      recycleFailure: number;
      recycleStraggler: number;
      databaseCapLimitedObservations: number;
      capReasonCounts: Record<TaskGateShardCapReason, number>;
      databaseBudgets: Map<
        string,
        {
          maxConnections: number;
          reservedConnections: number;
          connectionsPerLane: number;
          laneCap: number;
          observations: number;
        }
      >;
    }
  >();
  let qualifiedComparisonObservations = 0;
  for (const record of inWindow) {
    verdicts[record.verdict]++;
    if (isTaskGateProvenance(record.provenance) && record.provenance.deliveryCommit) {
      if (record.verdict === "pass") linkedPasses++;
      else linkedFailures++;
    } else {
      unknownHistoryObservations++;
    }
    selectionModes[record.selectionMode]++;
    const recordDispositions = record.dispositions ?? (() => {
      if (record.verdict === "fail") return ["blocking-failure"] as TaskGateDisposition[];
      const inferred: TaskGateDisposition[] = [];
      // Legacy deferred records retain their honest debt label. A mixed run
      // may also have reused proof or newly executed work, so do not collapse
      // the categories into a single primary label.
      if (record.deferredCount > 0) inferred.push("deferred-and-not-verified");
      if (record.skippedCount > 0) inferred.push("reused-accepted-green-evidence");
      if (record.executedCount > 0 || inferred.length === 0) inferred.push("executed-and-passed");
      return inferred;
    })();
    for (const disposition of recordDispositions) dispositions[disposition]++;
    if (recordDispositions.includes("quarantined-non-blocking")) {
      quarantinedNonBlockingObservations++;
    }
    if (record.selectionMode === "smoke-unresolved") incompleteVerificationObservations++;
    executed += record.executedCount;
    skipped += record.skippedCount;
    deferred += record.deferredCount;
    attribution.inherited += record.attribution.inherited;
    attribution.yours += record.attribution.yours;
    attribution.unattributable += record.attribution.unattributable;
    attribution.unknown += record.attribution.unknown;
    if (record.performance) {
      const { lint, runner, resources } = record.performance;
      lintWallMs.push(lint.wallMs);
      cacheEligibleChecks += lint.cacheEligibleChecks;
      cacheHitChecks += lint.cacheHitChecks;
      cacheMissChecks += lint.cacheMissChecks;
      resourceRss.push(resources.maxRssKb);
      const cpuMs = (resources.cpuUserMicros + resources.cpuSystemMicros) / 1_000;
      resourceCpuMs.push(cpuMs);
      totalCpuMs += cpuMs;
      if (runner) {
        runnerObservations++;
        if (runner.shardCount > 1) shardRuns++;
        laneSlots += runner.shardCount;
        activeLaneSlots += runner.activeLaneCount;
        estimateKnownCount += runner.estimateKnownCount;
        estimateUnknownCount += runner.estimateUnknownCount;
        plannedLaneTotalMs += runner.plannedLaneTotalMs;
        actualLaneTotalMs += runner.actualLaneTotalMs;
        if (runner.plannedLaneMinMs > 0) {
          plannedImbalanceRatios.push(runner.plannedLaneMaxMs / runner.plannedLaneMinMs);
        }
        if (runner.actualLaneMinMs > 0) {
          actualImbalanceRatios.push(runner.actualLaneMaxMs / runner.actualLaneMinMs);
        }
        batchedFirstAttempts += runner.batchedFirstAttempts;
        soloFirstAttempts += runner.soloFirstAttempts;
        compatibleFirstAttempts += runner.batchCompatibleFirstAttempts ?? 0;
        incompatibleFirstAttempts += runner.batchIncompatibleFirstAttempts ?? 0;
        if (runner.soloFirstAttemptElapsedMs !== undefined) {
          soloFirstAttemptElapsedMs += runner.soloFirstAttemptElapsedMs;
          soloFirstAttemptsWithElapsed += runner.soloFirstAttempts;
        }
        batchedFailureSoloRechecks += runner.batchedFailureSoloRechecks;
        workerStarts += runner.batchWorkerStarts;
        workerReuses += runner.batchWorkerReuses;
        if (runner.batchWorkerSuiteRuns !== undefined) {
          workerSuiteRuns += runner.batchWorkerSuiteRuns;
          workerStartsWithSuiteRuns += runner.batchWorkerStarts;
        }
        peakWorkerRssKb = Math.max(peakWorkerRssKb, runner.batchWorkerPeakRssKb ?? 0);
        recycleHardCap += runner.batchWorkerRecyclesHardCap ?? 0;
        recycleResourcePressure += runner.batchWorkerRecyclesResourcePressure ?? 0;
        recycleFailure += runner.batchWorkerRecyclesFailure ?? 0;
        recycleStraggler += runner.batchWorkerRecyclesStraggler ?? 0;
        if (runner.shardCountSource) decisionSourceCounts[runner.shardCountSource]++;
        for (const reason of new Set(runner.shardCapReasons ?? [])) capReasonCounts[reason]++;
        // Comparison rows intentionally exclude related, failed, skipped, and
        // deferred gates. They remain in the retention-wide source/reason
        // totals above, but cannot be treated as a like-for-like cap benchmark.
        const qualifiesForComparison =
          record.selectionMode === "full-smoke" &&
          record.verdict === "pass" &&
          record.skippedCount === 0 &&
          record.deferredCount === 0;
        if (
          qualifiesForComparison &&
          runner.requestedShardCount !== undefined &&
          runner.shardCountSource !== undefined
        ) {
          qualifiedComparisonObservations++;
          const key = `${runner.requestedShardCount}:${runner.shardCountSource}:${record.executedCount}`;
          let aggregate = settingAggregates.get(key);
          if (!aggregate) {
            aggregate = {
              requestedShardCount: runner.requestedShardCount,
              source: runner.shardCountSource,
              executedCount: record.executedCount,
              effectiveShardCounts: [],
              wallMs: [],
              maxRssKb: [],
              peakWorkerRssKb: 0,
              recycleHardCap: 0,
              recycleResourcePressure: 0,
              recycleFailure: 0,
              recycleStraggler: 0,
              databaseCapLimitedObservations: 0,
              capReasonCounts: {
                "serial-mode": 0,
                cpu: 0,
                "memory-headroom": 0,
                "database-connections": 0,
                "worker-processes": 0,
                "selected-suite-count": 0,
                "hermetic-fallback": 0,
                "shard-db-provisioning": 0,
              },
              databaseBudgets: new Map(),
            };
            settingAggregates.set(key, aggregate);
          }
          aggregate.effectiveShardCounts.push(runner.shardCount);
          aggregate.wallMs.push(record.wallMs);
          aggregate.maxRssKb.push(resources.maxRssKb);
          aggregate.peakWorkerRssKb = Math.max(
            aggregate.peakWorkerRssKb,
            runner.batchWorkerPeakRssKb ?? 0,
          );
          aggregate.recycleHardCap += runner.batchWorkerRecyclesHardCap ?? 0;
          aggregate.recycleResourcePressure += runner.batchWorkerRecyclesResourcePressure ?? 0;
          aggregate.recycleFailure += runner.batchWorkerRecyclesFailure ?? 0;
          aggregate.recycleStraggler += runner.batchWorkerRecyclesStraggler ?? 0;
          if (runner.shardCapReasons?.includes("database-connections")) {
            aggregate.databaseCapLimitedObservations++;
          }
          for (const reason of new Set(runner.shardCapReasons ?? [])) {
            aggregate.capReasonCounts[reason]++;
          }
          if (runner.databaseBudget) {
            const budget = runner.databaseBudget;
            const budgetKey = [
              budget.maxConnections,
              budget.reservedConnections,
              budget.connectionsPerLane,
              budget.laneCap,
            ].join(":");
            const existing = aggregate.databaseBudgets.get(budgetKey);
            if (existing) {
              existing.observations++;
            } else {
              aggregate.databaseBudgets.set(budgetKey, { ...budget, observations: 1 });
            }
          }
        }
      }
    }
  }
  const totalFailures =
    attribution.inherited + attribution.yours + attribution.unattributable + attribution.unknown;

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    windowDays: TASK_GATE_EVIDENCE_RETENTION_DAYS,
    windowStartedAt: new Date(windowStartedMs).toISOString(),
    retention: {
      maxAgeDays: TASK_GATE_EVIDENCE_RETENTION_DAYS,
      maxRecords: TASK_GATE_EVIDENCE_MAX_RECORDS,
    },
    readiness: {
      minObservationsForReadiness: TASK_GATE_EVIDENCE_MIN_OBSERVATIONS_FOR_READINESS,
      observedInWindow: inWindow.length,
      meetsObservationFloor: inWindow.length >= TASK_GATE_EVIDENCE_MIN_OBSERVATIONS_FOR_READINESS,
    },
    observations: {
      parsed: parsedRecords.length,
      unique: uniqueRecords.length,
      duplicatesDropped: parsedRecords.length - uniqueRecords.length,
      inWindow: inWindow.length,
      outsideWindow: uniqueRecords.length - inWindow.length,
    },
    medianWallMs: median(inWindow.map((record) => record.wallMs)),
    p95WallMs: percentile(inWindow.map((record) => record.wallMs), 0.95),
    verdicts,
    selectionModes,
    dispositions,
    execution: { executed, skipped, deferred },
    failureAttribution: {
      ...attribution,
      total: totalFailures,
      unrelatedToDiff: attribution.inherited,
      unrelatedToDiffFraction: totalFailures === 0 ? null : attribution.inherited / totalFailures,
    },
    validationHistory: {
      observed: {
        linkedPasses,
        linkedFailures,
      },
      requiredButUnobserved: {
        count: null,
        reason: "policy requirements are not execution observations",
      },
      documentationOnlyMentions: {
        count: null,
        reason: "documentation mentions are not execution observations",
      },
      unknown: {
        observations: unknownHistoryObservations,
        reason: "missing or malformed task-delivery-validation provenance",
      },
    },
    costBoundary: {
      repositoryValidation: {
        status: "measured-resource-usage",
        observations: inWindow.length,
        totalWallMs: inWindow.reduce((sum, record) => sum + record.wallMs, 0),
        resourceTelemetryObservations: resourceCpuMs.length,
        totalCpuMs: resourceCpuMs.length === 0 ? null : totalCpuMs,
      },
      platformOrModelBilling: {
        status: "unavailable",
        reason: "repository telemetry does not expose Replit, model, or platform billing",
      },
      affordability: {
        monthlyCeilingUsd: 5_000,
        attributableSpendUsd: null,
        monthlyNormalizedSpendUsd: null,
        outcome: "inconclusive",
        reason: "no observable currency billing or monthly task-volume denominator",
      },
    },
    outcomes: {
      execution: {
        executedSuites: executed,
        greenSkippedSuites: skipped,
        deferredNotVerifiedSuites: deferred,
      },
      observations: {
        quarantinedNonBlocking: quarantinedNonBlockingObservations,
        inheritedFailures: attribution.inherited,
        taskCausedFailures: attribution.yours,
        unresolvedFailures: attribution.unattributable + attribution.unknown,
        incompleteVerification: incompleteVerificationObservations,
      },
    },
    performance: {
      lint: {
        observations: lintWallMs.length,
        medianWallMs: median(lintWallMs),
        p95WallMs: percentile(lintWallMs, 0.95),
        cache: {
          eligibleChecks: cacheEligibleChecks,
          hitChecks: cacheHitChecks,
          missChecks: cacheMissChecks,
          hitFraction: cacheEligibleChecks === 0 ? null : cacheHitChecks / cacheEligibleChecks,
        },
      },
      runner: {
        observations: runnerObservations,
        shardRuns,
        laneSlots,
        activeLaneSlots,
        laneUtilizationFraction: laneSlots === 0 ? null : activeLaneSlots / laneSlots,
        estimateKnownCount,
        estimateUnknownCount,
        plannedLaneTotalMs,
        actualLaneTotalMs,
        plannedImbalanceRatio: median(plannedImbalanceRatios),
        actualImbalanceRatio: median(actualImbalanceRatios),
        shardDecisions: {
          observations: Object.values(decisionSourceCounts).reduce((sum, count) => sum + count, 0),
          qualifiedComparisonObservations,
          excludedComparisonObservations: runnerObservations - qualifiedComparisonObservations,
          sourceCounts: decisionSourceCounts,
          capReasonCounts,
          settings: [...settingAggregates.values()]
            .sort(
              (a, b) =>
                a.requestedShardCount - b.requestedShardCount ||
                a.source.localeCompare(b.source) ||
                a.executedCount - b.executedCount,
            )
            .map((aggregate) => ({
              requestedShardCount: aggregate.requestedShardCount,
              source: aggregate.source,
              executedCount: aggregate.executedCount,
              observations: aggregate.wallMs.length,
              effectiveShardCountMin: Math.min(...aggregate.effectiveShardCounts),
              effectiveShardCountMax: Math.max(...aggregate.effectiveShardCounts),
              medianGateWallMs: median(aggregate.wallMs),
              p95GateWallMs: percentile(aggregate.wallMs, 0.95),
              medianMaxRssKb: median(aggregate.maxRssKb),
              p95MaxRssKb: percentile(aggregate.maxRssKb, 0.95),
              peakWorkerRssKb: aggregate.peakWorkerRssKb,
              recycleHardCap: aggregate.recycleHardCap,
              recycleResourcePressure: aggregate.recycleResourcePressure,
              recycleFailure: aggregate.recycleFailure,
              recycleStraggler: aggregate.recycleStraggler,
              databaseCapLimitedObservations: aggregate.databaseCapLimitedObservations,
              capReasonCounts: aggregate.capReasonCounts,
              databaseBudgets: [...aggregate.databaseBudgets.values()].sort(
                (a, b) =>
                  a.laneCap - b.laneCap ||
                  a.maxConnections - b.maxConnections ||
                  a.reservedConnections - b.reservedConnections ||
                  a.connectionsPerLane - b.connectionsPerLane,
              ),
            })),
        },
        batching: {
          batchedFirstAttempts,
          soloFirstAttempts,
          compatibleFirstAttempts,
          incompatibleFirstAttempts,
          soloFirstAttemptElapsedMs,
          batchedFailureSoloRechecks,
          workerStarts,
          workerReuses,
          workerSuiteRuns,
          peakWorkerRssKb,
          recycleHardCap,
          recycleResourcePressure,
          recycleFailure,
          recycleStraggler,
          reusesPerWorkerStart: workerStarts === 0 ? null : workerReuses / workerStarts,
          averageSuitesPerWorker:
            workerStartsWithSuiteRuns === 0
              ? null
              : workerSuiteRuns / workerStartsWithSuiteRuns,
          averageSoloFirstAttemptMs:
            soloFirstAttemptsWithElapsed === 0
              ? null
              : soloFirstAttemptElapsedMs / soloFirstAttemptsWithElapsed,
        },
      },
      resources: {
        observations: resourceRss.length,
        medianMaxRssKb: median(resourceRss),
        p95MaxRssKb: percentile(resourceRss, 0.95),
        medianCpuMs: median(resourceCpuMs),
        p95CpuMs: percentile(resourceCpuMs, 0.95),
      },
    },
  };
}
