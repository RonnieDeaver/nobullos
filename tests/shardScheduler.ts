/**
 * shardScheduler.ts — shard distribution and bounded pull-dispatch utilities.
 *
 * These functions are deterministic and dependency-free (no imports from
 * server/, no I/O). The bounded dispatcher owns only per-run in-memory claim
 * state. Kept separate from run-all.ts so the guard suite can import and
 * unit-test these without booting the runner.
 */

/**
 * Extend any suite descriptor with an optional estimated duration so the
 * scheduler can balance load. Suites with unknown duration (estimatedMs=0 or
 * undefined) use the deterministic balanced fallback in distributeSuites.
 */
export interface SchedulableSuite {
  estimatedMs?: number;
}

/**
 * Bounded, lowering-only shard policy. The runner supplies live machine facts
 * so this remains deterministic and independently testable.
 *
 * The limits derive from existing harness facts: a lane has one active suite
 * child, each child is capped at API=3 plus worker=2 connections, and the
 * socket-only hermetic cluster has max_connections=100. This does not tune any
 * application pool or timeout.
 */
export const SHARD_CONCURRENCY_POLICY = {
  maxShards: 4,
  childDbConnectionsPerLane: 5,
  localHermeticMaxConnections: 100,
  reservedHermeticConnections: 20,
  maxActiveChildProcesses: 4,
  memoryReserveBytes: 2 * 1024 * 1024 * 1024,
  memoryPerLaneBytes: 1024 * 1024 * 1024,
} as const;

export type ShardCountSource = "serial" | "flag" | "env" | "default";
export type ShardCapReason =
  | "serial-mode"
  | "cpu"
  | "memory-headroom"
  | "database-connections"
  | "worker-processes"
  | "selected-suite-count"
  | "hermetic-fallback"
  | "shard-db-provisioning";

export interface ShardConcurrencyDecision {
  requestedShardCount: number;
  effectiveShardCount: number;
  source: ShardCountSource;
  capReasons: ShardCapReason[];
  caps: {
    cpu: number;
    memory: number;
    database: number;
    workerProcesses: number;
    selectedSuites: number;
    hermetic: number;
  };
}

export function resolveShardConcurrency(input: {
  requestedShardCount: number;
  source: ShardCountSource;
  selectedSuiteCount: number;
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  hermeticMode: "local-cluster" | "shared-instance-fallback";
}): ShardConcurrencyDecision {
  const requestedShardCount = Math.max(1, Math.trunc(input.requestedShardCount) || 1);
  const cpuCount = Math.max(1, Math.trunc(input.cpuCount) || 1);
  const selectedSuites = Math.max(1, Math.trunc(input.selectedSuiteCount) || 1);
  const totalMemoryBytes = Math.max(0, Math.trunc(input.totalMemoryBytes) || 0);
  const freeMemoryBytes = Math.max(0, Math.trunc(input.freeMemoryBytes) || 0);
  const cpu = Math.min(SHARD_CONCURRENCY_POLICY.maxShards, Math.max(1, Math.ceil(cpuCount / 2)));
  // A missing or low memory fact is conservative: run serially rather than
  // spawning children into an already-constrained host.
  const memoryUsableBytes = Math.min(
    Math.max(0, totalMemoryBytes - SHARD_CONCURRENCY_POLICY.memoryReserveBytes),
    Math.max(0, freeMemoryBytes - SHARD_CONCURRENCY_POLICY.memoryReserveBytes),
  );
  const memory = Math.max(
    1,
    Math.floor(memoryUsableBytes / SHARD_CONCURRENCY_POLICY.memoryPerLaneBytes),
  );
  const database = Math.max(
    1,
    Math.floor(
      (SHARD_CONCURRENCY_POLICY.localHermeticMaxConnections -
        SHARD_CONCURRENCY_POLICY.reservedHermeticConnections) /
        SHARD_CONCURRENCY_POLICY.childDbConnectionsPerLane,
    ),
  );
  const workerProcesses = SHARD_CONCURRENCY_POLICY.maxActiveChildProcesses;
  const hermetic = input.hermeticMode === "local-cluster" ? SHARD_CONCURRENCY_POLICY.maxShards : 1;
  const caps = { cpu, memory, database, workerProcesses, selectedSuites, hermetic };
  const effectiveShardCount = Math.max(
    1,
    Math.min(
      requestedShardCount,
      caps.cpu,
      caps.memory,
      caps.database,
      caps.workerProcesses,
      caps.selectedSuites,
      caps.hermetic,
    ),
  );
  const capReasons: ShardCapReason[] = [];
  if (input.source === "serial") capReasons.push("serial-mode");
  if (effectiveShardCount < requestedShardCount) {
    if (caps.cpu === effectiveShardCount) capReasons.push("cpu");
    if (caps.memory === effectiveShardCount) capReasons.push("memory-headroom");
    if (caps.database === effectiveShardCount) capReasons.push("database-connections");
    if (caps.workerProcesses === effectiveShardCount) capReasons.push("worker-processes");
    if (caps.selectedSuites === effectiveShardCount) capReasons.push("selected-suite-count");
    if (caps.hermetic === effectiveShardCount) capReasons.push("hermetic-fallback");
  }
  return { requestedShardCount, effectiveShardCount, source: input.source, capReasons, caps };
}

/**
 * Provisioning occurs before incremental planning. A later resource sample may
 * be less constrained, but execution must never launch more lanes than the
 * isolated shard databases that were successfully created for this run.
 */
export function boundShardConcurrencyToProvisionedDatabases(
  decision: ShardConcurrencyDecision,
  provisionedShardDbCount: number,
): ShardConcurrencyDecision {
  const provisionedCap = Math.max(1, Math.trunc(provisionedShardDbCount) || 1);
  if (decision.effectiveShardCount <= provisionedCap) return decision;
  return {
    ...decision,
    effectiveShardCount: provisionedCap,
    capReasons: [...new Set([...decision.capReasons, "shard-db-provisioning" as const])],
  };
}

export interface DurationSample {
  file: string;
  elapsedMs: number;
}

/**
 * Retain estimates from the durable per-suite history while allowing the
 * newest duration report to replace entries it actually observed. The report
 * is often partial (`--file`, incremental, or deferred runs), so it must not
 * be treated as a replacement for the full-population history.
 */
export function buildDurationEstimateMap(
  retainedHistory: readonly DurationSample[],
  latestReport: readonly DurationSample[],
): Map<string, number> {
  const estimates = new Map<string, number>();
  for (const sample of [...retainedHistory, ...latestReport]) {
    if (typeof sample.file !== "string" || !Number.isFinite(sample.elapsedMs) || sample.elapsedMs <= 0) {
      continue;
    }
    estimates.set(sample.file, sample.elapsedMs);
  }
  return estimates;
}

export interface LaneLoadSummary {
  suiteCount: number;
  knownEstimateCount: number;
  unknownEstimateCount: number;
  estimatedLoadMs: number;
  plannedLoadMs: number;
}

/** Median known estimate, or 1ms when no prior timing evidence exists. */
export function deriveUnknownEstimateMs<T extends SchedulableSuite>(
  suites: readonly T[],
): number {
  const known = suites
    .map((suite) => suite.estimatedMs)
    .filter((ms): ms is number => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);
  if (known.length === 0) return 1;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 0 ? (known[middle - 1] + known[middle]) / 2 : known[middle];
}

/** Aggregate-only lane facts for startup and post-run diagnostics. */
export function summarizeLaneLoads<T extends SchedulableSuite>(
  lanes: readonly (readonly T[])[],
  unknownEstimateMs: number,
): LaneLoadSummary[] {
  return lanes.map((lane) => ({
    suiteCount: lane.length,
    knownEstimateCount: lane.filter(
      (suite) => Number.isFinite(suite.estimatedMs) && (suite.estimatedMs ?? 0) > 0,
    ).length,
    unknownEstimateCount: lane.filter(
      (suite) => !Number.isFinite(suite.estimatedMs) || (suite.estimatedMs ?? 0) <= 0,
    ).length,
    estimatedLoadMs: lane.reduce(
      (sum, suite) =>
        sum + (Number.isFinite(suite.estimatedMs) && (suite.estimatedMs ?? 0) > 0
          ? suite.estimatedMs!
          : 0),
      0,
    ),
    plannedLoadMs: lane.reduce(
      (sum, suite) =>
        sum +
        (Number.isFinite(suite.estimatedMs) && (suite.estimatedMs ?? 0) > 0
          ? suite.estimatedMs!
          : unknownEstimateMs),
      0,
    ),
  }));
}

/**
 * Distribute suites across `shardCount` lanes using a greedy LPT-like
 * (Longest Processing Time) assignment:
 *  1. Sort by estimated duration descending (unknowns sort last).
 *  2. Assign each suite to the currently least-loaded lane.
 *  3. Give unknowns the median known estimate (or 1ms if none exist). Before
 *     normal greedy assignment, place one unknown on each lane in ascending
 *     known-load order whenever enough unknown suites exist; then use
 *     rotating least-load selection for the remainder. This guarantees
 *     coverage even when a known lane is uniquely heavy.
 *
 * Returns exactly `shardCount` arrays (some may be empty for tiny runs).
 * Caller should use the registration-order index to re-sort results after
 * execution (see `mergeLaneResults`).
 *
 * Invariant: every input suite appears in exactly one output lane.
 */
export function distributeSuites<T extends SchedulableSuite>(
  suites: T[],
  shardCount: number,
): T[][] {
  const n = Math.max(1, Math.trunc(shardCount));
  if (n === 1) return [suites.slice()];

  const lanes: T[][] = Array.from({ length: n }, () => []);
  const loads = new Float64Array(n); // estimated total ms per lane
  let tieStart = 0;

  // Sort heaviest first: keeps the largest suites spread across lanes early,
  // giving the greedy assignment its best approximation of makespan-minimality.
  const estimate = (suite: T): number =>
    Number.isFinite(suite.estimatedMs) && (suite.estimatedMs ?? 0) > 0 ? suite.estimatedMs! : 0;
  const unknownEstimateMs = deriveUnknownEstimateMs(suites);
  const plannedEstimate = (suite: T): number => estimate(suite) || unknownEstimateMs;
  const sorted = suites.slice().sort((a, b) => estimate(b) - estimate(a));
  const known = sorted.filter((suite) => estimate(suite) > 0);
  const unknown = sorted.filter((suite) => estimate(suite) === 0);

  const assignToLeastLoadedLane = (suite: T): void => {
    // Find the smallest load. Among equal candidates, begin at the rotating
    // cursor so all-zero and partially-unknown runs spread across every lane.
    // O(n) — n ≤ 8 in practice.
    const minLoad = Math.min(...loads);
    let minLane = tieStart;
    for (let offset = 0; offset < n; offset++) {
      const candidate = (tieStart + offset) % n;
      if (loads[candidate] === minLoad) {
        minLane = candidate;
        break;
      }
    }
    lanes[minLane].push(suite);
    loads[minLane] += plannedEstimate(suite);
    tieStart = (minLane + 1) % n;
  };

  for (const suite of known) {
    assignToLeastLoadedLane(suite);
  }

  // Coverage-first fallback: `unknown.length >= n` means every available
  // shard can receive unknown work. The stable lane ordering starts with the
  // lightest known-load lane, preserving LPT's preference while preventing a
  // heavy known lane from receiving no unknown work at all.
  const coverageLanes = Array.from({ length: n }, (_, lane) => lane).sort(
    (a, b) =>
      loads[a] - loads[b] ||
      ((a - tieStart + n) % n) - ((b - tieStart + n) % n),
  );
  const coverageCount = Math.min(unknown.length, n);
  for (let i = 0; i < coverageCount; i++) {
    const lane = coverageLanes[i];
    const suite = unknown[i];
    lanes[lane].push(suite);
    loads[lane] += plannedEstimate(suite);
    tieStart = (lane + 1) % n;
  }
  for (const suite of unknown.slice(coverageCount)) {
    assignToLeastLoadedLane(suite);
  }

  return lanes;
}

/**
 * Produce the deterministic order used by bounded pull dispatch. Known
 * durations are longest-first so the first wave starts the most expensive
 * work; unknowns follow in registration order. Unlike distributeSuites, this
 * does not bind a suite to a lane: a lane claims its next item only when it is
 * ready to begin it.
 */
export function buildPullSchedule<T extends SchedulableSuite>(suites: readonly T[]): T[] {
  const estimate = (suite: T): number =>
    Number.isFinite(suite.estimatedMs) && (suite.estimatedMs ?? 0) > 0 ? suite.estimatedMs! : 0;
  return suites
    .map((suite, registrationIndex) => ({ suite, registrationIndex }))
    .sort(
      (a, b) =>
        estimate(b.suite) - estimate(a.suite) || a.registrationIndex - b.registrationIndex,
    )
    .map(({ suite }) => suite);
}

/**
 * A finite, in-memory work queue for the current run. JavaScript executes a
 * claim synchronously before a lane awaits its child process, so incrementing
 * the cursor is an atomic exactly-once claim among concurrent async lanes.
 *
 * The dispatcher deliberately has no retry/requeue operation: once claimed,
 * the suite has started in that lane and may not move. A lane crash therefore
 * leaves its claimed-but-unreported suite to the existing fail-closed result
 * accounting instead of silently executing it a second time elsewhere.
 */
export interface BoundedSuiteDispatcher<T> {
  /** Stable LPT-like queue order, useful for aggregate diagnostics/tests. */
  readonly schedule: readonly T[];
  /** Claim one unstarted suite, or undefined after the fixed queue is empty. */
  claimNext(): T | undefined;
  /** Number of suites claimed by lanes in this run. */
  readonly claimedCount: number;
  /** Number of suites never started by any lane. */
  readonly remainingCount: number;
}

export function createBoundedSuiteDispatcher<T extends SchedulableSuite>(
  suites: readonly T[],
): BoundedSuiteDispatcher<T> {
  const schedule = buildPullSchedule(suites);
  let nextIndex = 0;
  return {
    schedule,
    claimNext: () => {
      const suite = schedule[nextIndex];
      if (!suite) return undefined;
      nextIndex += 1;
      return suite;
    },
    get claimedCount() {
      return nextIndex;
    },
    get remainingCount() {
      return schedule.length - nextIndex;
    },
  };
}

/**
 * Build per-shard env overlay: override every DATABASE_URL variant to point
 * at the shard's own DB, and scope the Redis cache namespace so shard caches
 * are isolated.
 *
 * Call after `provisionHermeticDb` + `createShardDbs` to get each lane's
 * env. The base env already carries PGHOST/PGPORT/PGUSER/PGPASSWORD from the
 * hermetic provisioner; only the DB name + URL need changing per shard.
 */
export function buildShardEnvOverlay(
  baseEnv: NodeJS.ProcessEnv,
  shardDbUrl: string,
  shardIndex: number,
  baseRunId: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    DATABASE_URL: shardDbUrl,
    DATABASE_URL_DIRECT: shardDbUrl,
    PGDATABASE_URL: shardDbUrl,
    // Derive PGDATABASE from the URL path component (e.g. "nobull_shard_2").
    PGDATABASE: (() => {
      try {
        return new URL(shardDbUrl).pathname.slice(1).split("?")[0] || baseEnv.PGDATABASE;
      } catch {
        return baseEnv.PGDATABASE;
      }
    })(),
    // Scope cache so shard-N's writes never bleed into shard-M's reads.
    NOBULL_TEST_CACHE_NAMESPACE: `${baseRunId}-s${shardIndex}`,
  };
}

/**
 * Result-accounting facts from merging lane output. `complete` is true only
 * when every selected suite produced exactly one recognized terminal result.
 * The runner must treat any other outcome as incomplete verification, never as
 * a partial pass.
 */
export interface LaneResultMerge<T> {
  /** Recognized results in original registration order. */
  results: T[];
  /** Selected suites with no terminal result (usually a lane crash). */
  missingFiles: string[];
  /** Selected suites that produced more than one terminal result. */
  duplicateFiles: string[];
  /** Result records that do not belong to the selected suite set. */
  unexpectedFiles: string[];
  /** True only when every selected suite is represented exactly once. */
  complete: boolean;
}

/**
 * Merge N lane result arrays back into the original `toRun` registration
 * order and account for every emitted and selected file. A missing result is
 * not silently dropped: callers receive explicit incompleteness facts so they
 * can synthesize diagnostic records and block evidence publication.
 *
 * @param laneResultArrays  One array of results per lane (order within each
 *                          lane is irrelevant; the merge key is `file`).
 * @param orderedSuites     The original ordered suite list (toRun) used as the
 *                          reference order for output.
 */
export function mergeLaneResults<T extends { file: string }>(
  laneResultArrays: T[][],
  orderedSuites: { file: string }[],
): LaneResultMerge<T> {
  const byFile = new Map<string, T>();
  const counts = new Map<string, number>();
  const selectedFiles = new Set(orderedSuites.map((s) => s.file));
  const unexpectedFiles = new Set<string>();
  for (const arr of laneResultArrays) {
    for (const r of arr) {
      counts.set(r.file, (counts.get(r.file) ?? 0) + 1);
      // Keep the first result deterministically. The duplicate is still
      // reported below and makes the overall verification incomplete.
      if (!byFile.has(r.file)) byFile.set(r.file, r);
      if (!selectedFiles.has(r.file)) unexpectedFiles.add(r.file);
    }
  }
  const results = orderedSuites.flatMap((s) => {
    const r = byFile.get(s.file);
    return r ? [r] : [];
  });
  const missingFiles = orderedSuites.filter((s) => !byFile.has(s.file)).map((s) => s.file);
  const duplicateFiles = orderedSuites
    .filter((s) => (counts.get(s.file) ?? 0) > 1)
    .map((s) => s.file);
  const unexpected = [...unexpectedFiles].sort();
  return {
    results,
    missingFiles,
    duplicateFiles,
    unexpectedFiles: unexpected,
    complete: missingFiles.length === 0 && duplicateFiles.length === 0 && unexpected.length === 0,
  };
}
