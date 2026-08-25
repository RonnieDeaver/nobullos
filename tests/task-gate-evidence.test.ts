/* test-registration
{
  "name": "Task-gate evidence ledger and 42-day report (Task #5061)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5061: the CI control-plane re-review depends on one privacy-safe, bounded observation per completed gate. This fast unit/contract suite proves canonical field stripping, age/count retention, observation-ID de-duplication, 42-day median and unrelated-to-diff fraction math, and pass/fail gate wiring. DB-free, network-free, tmpdir-only.",
  "scanPaths": [
    "scripts/gate.ts",
    "scripts/taskGateEvidence.ts",
    "scripts/report-task-gate-evidence.ts",
    "tests/run-all.ts",
    "server/services/regressionSweep.ts",
    "TESTING.md",
    "audits/ci-control-plane-simplification-audit-2026-08.md"
  ],
  "tier": "small"
}
test-registration */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { formatTaskGateEvidenceReport } from "../scripts/report-task-gate-evidence";
import {
  TASK_GATE_EVIDENCE_MAX_RECORDS,
  TASK_GATE_EVIDENCE_RETENTION_DAYS,
  TASK_GATE_EVIDENCE_SCHEMA_VERSION,
  appendTaskGateEvidence,
  buildTaskGateEvidenceReport,
  readTaskGateEvidence,
  type TaskGateEvidenceRecord,
} from "../scripts/taskGateEvidence";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-19T12:00:00.000Z");

function record(overrides: Partial<TaskGateEvidenceRecord> = {}): TaskGateEvidenceRecord {
  const startedAt = overrides.startedAt ?? "2026-08-19T11:59:50.000Z";
  return {
    schemaVersion: TASK_GATE_EVIDENCE_SCHEMA_VERSION,
    observationId: overrides.observationId ?? `${startedAt}:101`,
    startedAt,
    finishedAt: overrides.finishedAt ?? "2026-08-19T12:00:00.000Z",
    wallMs: overrides.wallMs ?? 10_000,
    selectionMode: overrides.selectionMode ?? "related-smoke",
    executedCount: overrides.executedCount ?? 3,
    skippedCount: overrides.skippedCount ?? 2,
    deferredCount: overrides.deferredCount ?? 1,
    verdict: overrides.verdict ?? "pass",
    attribution: overrides.attribution ?? {
      inherited: 0,
      yours: 0,
      unattributable: 0,
      unknown: 0,
    },
    ...(overrides.performance ? { performance: overrides.performance } : {}),
  };
}

function performance(
  overrides: Partial<NonNullable<TaskGateEvidenceRecord["performance"]>> = {},
): NonNullable<TaskGateEvidenceRecord["performance"]> {
  return {
    lint: {
      wallMs: 12_000,
      concurrency: 4,
      cacheEligibleChecks: 3,
      cacheHitChecks: 2,
      cacheMissChecks: 1,
      ...(overrides.lint ?? {}),
    },
    runner: {
      shardCount: 2,
      requestedShardCount: 4,
      shardCountSource: "default",
      shardCapReasons: ["selected-suite-count"],
      databaseBudget: {
        maxConnections: 100,
        reservedConnections: 20,
        connectionsPerLane: 5,
        laneCap: 16,
      },
      activeLaneCount: 2,
      estimateKnownCount: 8,
      estimateUnknownCount: 2,
      plannedLaneTotalMs: 10_000,
      plannedLaneMinMs: 4_500,
      plannedLaneMaxMs: 5_500,
      actualLaneTotalMs: 9_000,
      actualLaneMinMs: 4_000,
      actualLaneMaxMs: 5_000,
      batchCompatibleFirstAttempts: 8,
      batchIncompatibleFirstAttempts: 2,
      batchedFirstAttempts: 7,
      soloFirstAttempts: 3,
      soloFirstAttemptElapsedMs: 600,
      batchedFailureSoloRechecks: 1,
      batchWorkerStarts: 2,
      batchWorkerReuses: 5,
      batchWorkerSuiteRuns: 7,
      batchWorkerPeakRssKb: 123_456,
      batchWorkerRecyclesHardCap: 1,
      batchWorkerRecyclesResourcePressure: 2,
      batchWorkerRecyclesFailure: 3,
      batchWorkerRecyclesStraggler: 4,
      ...(overrides.runner ?? {}),
    },
    resources: {
      maxRssKb: 100_000,
      cpuUserMicros: 12_000_000,
      cpuSystemMicros: 3_000_000,
      ...(overrides.resources ?? {}),
    },
  };
}

test("writer strips foreign/privacy-sensitive fields, de-duplicates, prunes age, and caps count", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-gate-evidence-"));
  const path = join(dir, "evidence.jsonl");
  try {
    const oldFinished = new Date(NOW.getTime() - (TASK_GATE_EVIDENCE_RETENTION_DAYS + 1) * DAY_MS);
    const oldStarted = new Date(oldFinished.getTime() - 1000);
    const seed: TaskGateEvidenceRecord[] = [
      record({
        observationId: `${oldStarted.toISOString()}:1`,
        startedAt: oldStarted.toISOString(),
        finishedAt: oldFinished.toISOString(),
      }),
    ];
    for (let i = 0; i < TASK_GATE_EVIDENCE_MAX_RECORDS + 2; i++) {
      const startedAt = new Date(NOW.getTime() - 20_000 - i).toISOString();
      seed.push(
        record({
          observationId: `${startedAt}:${i + 2}`,
          startedAt,
          finishedAt: new Date(NOW.getTime() - 10_000 - i).toISOString(),
        }),
      );
    }
    writeFileSync(path, seed.map((item) => JSON.stringify(item)).join("\n") + "\n");

    const safe = {
      ...record({ observationId: "2026-08-19T11:59:59.000Z:999999" }),
      performance: {
        ...performance(),
        paths: ["tests/private.test.ts"],
      },
      output: "must not persist",
      userData: { email: "must-not-persist@example.invalid" },
      secret: "must not persist",
    } as TaskGateEvidenceRecord;
    assert.equal(appendTaskGateEvidence(safe, { ledgerPath: path, now: NOW }), true);
    assert.equal(appendTaskGateEvidence(safe, { ledgerPath: path, now: NOW }), true);

    const retained = readTaskGateEvidence(path);
    assert.equal(retained.length, TASK_GATE_EVIDENCE_MAX_RECORDS);
    assert.equal(retained.filter((item) => item.observationId === safe.observationId).length, 1);
    assert.ok(retained.every((item) => Date.parse(item.finishedAt) >= NOW.getTime() - 42 * DAY_MS));
    const retainedSafe = retained.find((item) => item.observationId === safe.observationId)!;
    assert.equal(retainedSafe.performance?.runner?.requestedShardCount, 4);
    assert.deepEqual(retainedSafe.performance?.runner?.shardCapReasons, ["selected-suite-count"]);
    assert.deepEqual(retainedSafe.performance?.runner?.databaseBudget, {
      maxConnections: 100,
      reservedConnections: 20,
      connectionsPerLane: 5,
      laneCap: 16,
    });
    const raw = readFileSync(path, "utf8");
    assert.ok(!raw.includes("must not persist"));
    assert.ok(!raw.includes("must-not-persist"));
    assert.ok(!raw.includes('"output"'));
    assert.ok(!raw.includes('"userData"'));
    assert.ok(!raw.includes('"secret"'));
    assert.ok(!raw.includes("tests/private.test.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("42-day report de-duplicates observations before median and attribution math", () => {
  const startedA = "2026-08-18T10:00:00.000Z";
  const startedB = "2026-08-17T10:00:00.000Z";
  const duplicateOld = record({
    observationId: `${startedA}:201`,
    startedAt: startedA,
    finishedAt: "2026-08-18T10:00:00.100Z",
    wallMs: 100,
    attribution: { inherited: 99, yours: 0, unattributable: 0, unknown: 0 },
  });
  const duplicateNewest = record({
    observationId: duplicateOld.observationId,
    startedAt: startedA,
    finishedAt: "2026-08-18T10:00:00.300Z",
    wallMs: 300,
    verdict: "pass",
    selectionMode: "full-smoke",
    skippedCount: 0,
    deferredCount: 0,
    attribution: { inherited: 1, yours: 1, unattributable: 0, unknown: 0 },
    performance: performance(),
  });
  const second = record({
    observationId: `${startedB}:202`,
    startedAt: startedB,
    finishedAt: "2026-08-17T10:00:00.500Z",
    wallMs: 500,
    selectionMode: "full-smoke-fallback",
    executedCount: 7,
    skippedCount: 0,
    deferredCount: 0,
    verdict: "fail",
    attribution: { inherited: 2, yours: 0, unattributable: 1, unknown: 1 },
    performance: performance({
      lint: {
        wallMs: 30_000,
        concurrency: 4,
        cacheEligibleChecks: 3,
        cacheHitChecks: 0,
        cacheMissChecks: 3,
      },
      runner: {
        shardCount: 1,
        requestedShardCount: 1,
        shardCountSource: "serial",
        shardCapReasons: ["serial-mode"],
        activeLaneCount: 1,
        estimateKnownCount: 0,
        estimateUnknownCount: 0,
        plannedLaneTotalMs: 0,
        plannedLaneMinMs: 0,
        plannedLaneMaxMs: 0,
        actualLaneTotalMs: 8_000,
        actualLaneMinMs: 8_000,
        actualLaneMaxMs: 8_000,
        batchedFirstAttempts: 0,
        soloFirstAttempts: 7,
        batchedFailureSoloRechecks: 0,
        batchWorkerStarts: 0,
        batchWorkerReuses: 0,
      },
      resources: { maxRssKb: 120_000, cpuUserMicros: 20_000_000, cpuSystemMicros: 5_000_000 },
    }),
  });
  const candidateStarted = "2026-08-16T10:00:00.000Z";
  const candidate = record({
    observationId: `${candidateStarted}:204`,
    startedAt: candidateStarted,
    finishedAt: "2026-08-16T10:00:00.700Z",
    wallMs: 700,
    selectionMode: "full-smoke",
    executedCount: 10,
    skippedCount: 0,
    deferredCount: 0,
    verdict: "pass",
    performance: performance({
      runner: {
        shardCount: 4,
        requestedShardCount: 6,
        shardCountSource: "flag",
        shardCapReasons: ["database-connections", "worker-processes"],
        activeLaneCount: 4,
        estimateKnownCount: 0,
        estimateUnknownCount: 0,
        plannedLaneTotalMs: 0,
        plannedLaneMinMs: 0,
        plannedLaneMaxMs: 0,
        actualLaneTotalMs: 0,
        actualLaneMinMs: 0,
        actualLaneMaxMs: 0,
        batchCompatibleFirstAttempts: 0,
        batchIncompatibleFirstAttempts: 0,
        batchedFirstAttempts: 0,
        soloFirstAttempts: 0,
        soloFirstAttemptElapsedMs: 0,
        batchedFailureSoloRechecks: 0,
        batchWorkerStarts: 0,
        batchWorkerReuses: 0,
        batchWorkerSuiteRuns: 0,
        batchWorkerPeakRssKb: 0,
        batchWorkerRecyclesHardCap: 0,
        batchWorkerRecyclesResourcePressure: 0,
        batchWorkerRecyclesFailure: 0,
        batchWorkerRecyclesStraggler: 0,
        databaseBudget: {
          maxConnections: 40,
          reservedConnections: 20,
          connectionsPerLane: 5,
          laneCap: 4,
        },
      },
    }),
  });
  const oldStarted = new Date(NOW.getTime() - 50 * DAY_MS);
  const outside = record({
    observationId: `${oldStarted.toISOString()}:203`,
    startedAt: oldStarted.toISOString(),
    finishedAt: new Date(oldStarted.getTime() + 1000).toISOString(),
    wallMs: 50_000,
  });

  const report = buildTaskGateEvidenceReport([duplicateOld, duplicateNewest, second, candidate, outside], NOW);
  assert.deepEqual(report.observations, {
    parsed: 5,
    unique: 4,
    duplicatesDropped: 1,
    inWindow: 3,
    outsideWindow: 1,
  });
  assert.equal(report.medianWallMs, 500);
  assert.equal(report.p95WallMs, 700);
  assert.deepEqual(report.verdicts, { pass: 2, fail: 1 });
  assert.equal(report.selectionModes["full-smoke"], 2);
  assert.equal(report.selectionModes["full-smoke-fallback"], 1);
  assert.deepEqual(report.execution, { executed: 20, skipped: 0, deferred: 0 });
  assert.deepEqual(report.failureAttribution, {
    inherited: 3,
    yours: 1,
    unattributable: 1,
    unknown: 1,
    total: 6,
    unrelatedToDiff: 3,
    unrelatedToDiffFraction: 0.5,
  });
  assert.deepEqual(report.performance.lint.cache, {
    eligibleChecks: 9,
    hitChecks: 4,
    missChecks: 5,
    hitFraction: 4 / 9,
  });
  assert.equal(report.performance.lint.medianWallMs, 12_000);
  assert.equal(report.performance.lint.p95WallMs, 30_000);
  assert.equal(report.performance.runner.laneUtilizationFraction, 1);
  assert.equal(report.performance.runner.plannedImbalanceRatio, 11_000 / 9_000);
  assert.equal(report.performance.runner.actualImbalanceRatio, 1.125);
  assert.equal(report.performance.runner.batching.reusesPerWorkerStart, 2.5);
  assert.equal(report.performance.runner.batching.compatibleFirstAttempts, 16);
  assert.equal(report.performance.runner.batching.incompatibleFirstAttempts, 4);
  assert.equal(report.performance.runner.batching.averageSuitesPerWorker, 7);
  assert.equal(report.performance.runner.batching.averageSoloFirstAttemptMs, 120);
  assert.equal(report.performance.runner.batching.peakWorkerRssKb, 123_456);
  assert.deepEqual(report.performance.runner.shardDecisions.sourceCounts, {
    serial: 1,
    flag: 1,
    env: 0,
    default: 1,
  });
  assert.deepEqual(report.performance.runner.shardDecisions.capReasonCounts, {
    "serial-mode": 1,
    cpu: 0,
    "memory-headroom": 0,
    "database-connections": 1,
    "worker-processes": 1,
    "selected-suite-count": 1,
    "hermetic-fallback": 0,
    "shard-db-provisioning": 0,
  });
  const serialSetting = report.performance.runner.shardDecisions.settings.find(
    (setting) => setting.requestedShardCount === 1 && setting.source === "serial",
  );
  assert.equal(serialSetting, undefined);
  const defaultSetting = report.performance.runner.shardDecisions.settings.find(
    (setting) => setting.requestedShardCount === 4 && setting.source === "default",
  );
  assert.equal(defaultSetting?.observations, 1);
  assert.equal(defaultSetting?.executedCount, 3);
  assert.equal(defaultSetting?.effectiveShardCountMin, 2);
  assert.equal(defaultSetting?.medianGateWallMs, 300);
  assert.equal(defaultSetting?.peakWorkerRssKb, 123_456);
  assert.deepEqual(defaultSetting?.databaseBudgets, [
    {
      maxConnections: 100,
      reservedConnections: 20,
      connectionsPerLane: 5,
      laneCap: 16,
      observations: 1,
    },
  ]);
  const candidateSetting = report.performance.runner.shardDecisions.settings.find(
    (setting) => setting.requestedShardCount === 6 && setting.source === "flag",
  );
  assert.equal(report.performance.runner.shardDecisions.qualifiedComparisonObservations, 2);
  assert.equal(report.performance.runner.shardDecisions.excludedComparisonObservations, 1);
  assert.equal(candidateSetting?.observations, 1);
  assert.equal(candidateSetting?.executedCount, 10);
  assert.equal(candidateSetting?.databaseCapLimitedObservations, 1);
  assert.equal(candidateSetting?.capReasonCounts["database-connections"], 1);
  assert.equal(candidateSetting?.capReasonCounts["worker-processes"], 1);
  assert.deepEqual(
    {
      cap: report.performance.runner.batching.recycleHardCap,
      resource: report.performance.runner.batching.recycleResourcePressure,
      failure: report.performance.runner.batching.recycleFailure,
      straggler: report.performance.runner.batching.recycleStraggler,
    },
    { cap: 2, resource: 4, failure: 6, straggler: 8 },
  );
  assert.equal(report.performance.resources.p95MaxRssKb, 120_000);
  const text = formatTaskGateEvidenceReport(report);
  assert.ok(text.includes("Completed-gate wall time: median 0.01 min; p95 0.01 min"));
  assert.ok(text.includes("cache hits=4, misses=5, hit rate=44.4%"));
  assert.ok(text.includes("Runner evidence: 3 observation(s), sharded=2, lane utilization=100.0%"));
  assert.ok(text.includes("Shard decisions: 3 source-tagged observation(s); sources serial=1, flag=1, env=0, default=1"));
  assert.ok(text.includes("Shard setting comparison: 2 qualified (passing full-smoke, zero-skip, zero-deferral) observation(s); 1 runner observation(s) excluded."));
  assert.ok(text.includes("requested=6 (flag), n=1, executed=10, effective=4-4"));
  assert.ok(text.includes("Unrelated-to-diff failure fraction: 50.0% (3/6)"));

  const reversed = buildTaskGateEvidenceReport(
    [duplicateNewest, duplicateOld, second, outside],
    NOW,
  );
  assert.equal(reversed.medianWallMs, 400);
  assert.deepEqual(reversed.failureAttribution, report.failureAttribution);
});

test("legacy runner observations without batch-efficiency fields remain valid and report unavailable averages honestly", () => {
  const runner = performance().runner;
  if (!runner) throw new Error("fixture unexpectedly omitted runner performance");
  const legacyRunner = { ...runner } as Record<string, unknown>;
  for (const field of [
    "batchCompatibleFirstAttempts",
    "batchIncompatibleFirstAttempts",
    "soloFirstAttemptElapsedMs",
    "batchWorkerSuiteRuns",
    "batchWorkerPeakRssKb",
    "batchWorkerRecyclesHardCap",
    "batchWorkerRecyclesResourcePressure",
    "batchWorkerRecyclesFailure",
    "batchWorkerRecyclesStraggler",
  ]) {
    delete legacyRunner[field];
  }
  const report = buildTaskGateEvidenceReport(
    [
      record({
        performance: {
          ...performance(),
          runner: legacyRunner as NonNullable<TaskGateEvidenceRecord["performance"]>["runner"],
        },
      }),
    ],
    NOW,
  );
  assert.equal(report.performance.runner.observations, 1);
  assert.equal(report.performance.runner.batching.compatibleFirstAttempts, 0);
  assert.equal(report.performance.runner.batching.peakWorkerRssKb, 0);
  assert.equal(report.performance.runner.batching.averageSuitesPerWorker, null);
  assert.equal(report.performance.runner.batching.averageSoloFirstAttemptMs, null);
});

test("benchmark rows exclude non-comparable gates while retaining their global decision evidence", () => {
  const comparable = record({
    observationId: "2026-08-19T11:59:00.000Z:401",
    startedAt: "2026-08-19T11:59:00.000Z",
    selectionMode: "full-smoke",
    verdict: "pass",
    skippedCount: 0,
    deferredCount: 0,
    performance: performance(),
  });
  const excluded = [
    record({
      observationId: "2026-08-19T11:58:00.000Z:402",
      startedAt: "2026-08-19T11:58:00.000Z",
      selectionMode: "related-smoke",
      performance: performance(),
    }),
    record({
      observationId: "2026-08-19T11:57:00.000Z:403",
      startedAt: "2026-08-19T11:57:00.000Z",
      selectionMode: "full-smoke",
      verdict: "fail",
      skippedCount: 0,
      deferredCount: 0,
      performance: performance(),
    }),
    record({
      observationId: "2026-08-19T11:56:00.000Z:404",
      startedAt: "2026-08-19T11:56:00.000Z",
      selectionMode: "full-smoke",
      skippedCount: 1,
      deferredCount: 0,
      performance: performance(),
    }),
    record({
      observationId: "2026-08-19T11:55:00.000Z:405",
      startedAt: "2026-08-19T11:55:00.000Z",
      selectionMode: "full-smoke",
      skippedCount: 0,
      deferredCount: 1,
      performance: performance(),
    }),
    record({
      observationId: "2026-08-19T11:54:00.000Z:406",
      startedAt: "2026-08-19T11:54:00.000Z",
      selectionMode: "full-smoke",
      skippedCount: 0,
      deferredCount: 0,
      performance: {
        ...performance(),
        runner: {
          ...performance().runner!,
          requestedShardCount: undefined,
          shardCountSource: undefined,
        },
      },
    }),
  ];
  const report = buildTaskGateEvidenceReport([comparable, ...excluded], NOW);
  assert.equal(report.performance.runner.observations, 6);
  assert.equal(report.performance.runner.shardDecisions.observations, 5);
  assert.equal(report.performance.runner.shardDecisions.qualifiedComparisonObservations, 1);
  assert.equal(report.performance.runner.shardDecisions.excludedComparisonObservations, 5);
  assert.equal(report.performance.runner.shardDecisions.settings.length, 1);
  assert.equal(report.performance.runner.shardDecisions.settings[0].requestedShardCount, 4);
});

test("invalid aggregate telemetry is rejected while legacy observations remain reportable", () => {
  const invalid = record({
    performance: performance({
      lint: {
        wallMs: 1,
        concurrency: 1,
        cacheEligibleChecks: 2,
        cacheHitChecks: 2,
        cacheMissChecks: 1,
      },
    }),
  });
  const invalidDatabaseBudget = record({
    performance: performance({
      runner: {
        databaseBudget: {
          maxConnections: 10,
          reservedConnections: 9,
          connectionsPerLane: 2,
          laneCap: 2,
        },
      },
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "task-gate-evidence-invalid-"));
  const path = join(dir, "evidence.jsonl");
  try {
    assert.equal(appendTaskGateEvidence(invalid, { ledgerPath: path, now: NOW }), false);
    assert.equal(appendTaskGateEvidence(invalidDatabaseBudget, { ledgerPath: path, now: NOW }), false);
    const legacy = record();
    const report = buildTaskGateEvidenceReport([legacy], NOW);
    assert.equal(report.performance.lint.observations, 0);
    assert.equal(report.performance.runner.observations, 0);
    assert.equal(report.performance.resources.observations, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry IO failures fall open without changing evidence callers", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-gate-evidence-io-failure-"));
  const blockingFile = join(dir, "not-a-directory");
  writeFileSync(blockingFile, "block ledger parent");
  try {
    assert.doesNotThrow(() => {
      assert.equal(
        appendTaskGateEvidence(record(), {
          ledgerPath: join(blockingFile, "task-gate-evidence.jsonl"),
          now: NOW,
        }),
        false,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent gate writers retain every unique completed observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-gate-evidence-concurrent-"));
  const path = join(dir, "evidence.jsonl");
  const moduleUrl = pathToFileURL(resolve("scripts/taskGateEvidence.ts")).href;
  try {
    const writes = Array.from({ length: 8 }, (_, index) => {
      const startedAt = new Date(NOW.getTime() - 10_000 + index).toISOString();
      const value = record({
        observationId: `${startedAt}:${300 + index}`,
        startedAt,
        finishedAt: new Date(NOW.getTime() - 1_000 + index).toISOString(),
      });
      const source = [
        `import { appendTaskGateEvidence } from ${JSON.stringify(moduleUrl)};`,
        `const ok = appendTaskGateEvidence(${JSON.stringify(value)}, { ledgerPath: ${JSON.stringify(path)}, now: new Date(${JSON.stringify(NOW.toISOString())}) });`,
        `if (!ok) process.exit(2);`,
      ].join("\n");
      return new Promise<void>((resolveWrite, rejectWrite) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", source],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", rejectWrite);
        child.once("exit", (code) => {
          if (code === 0) resolveWrite();
          else rejectWrite(new Error(`concurrent writer exited ${code}: ${stderr}`));
        });
      });
    });
    await Promise.all(writes);
    const retained = readTaskGateEvidence(path);
    assert.equal(retained.length, writes.length);
    assert.equal(new Set(retained.map((item) => item.observationId)).size, writes.length);
    assert.ok(!readFileSync(path, "utf8").includes('"output"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate records both final verdict paths and docs point to the report", () => {
  const gate = readFileSync("scripts/gate.ts", "utf8");
  assert.match(gate, /persistTaskGateEvidence\(\{[\s\S]*?verdict: "pass"/);
  assert.match(gate, /persistTaskGateEvidence\(\{[\s\S]*?verdict: "fail"/);
  assert.match(gate, /readFreshSuiteDurationSummary/);
  assert.match(gate, /readFreshAttributionSummary/);
  assert.match(gate, /parseRunnerPerformance/);
  assert.match(gate, /databaseBudget/);
  assert.match(gate, /summarizeLintPerformance/);
  assert.match(gate, /reused cached green verdict/);
  assert.match(gate, /appendTaskGateEvidence\(record\)/);
  assert.match(gate, /TEST_TASK_GATE_SWEEP_REPORT_PATH: GATE_SWEEP_REPORT_PATH/);
  assert.match(gate, /TEST_TASK_GATE_ATTRIBUTION_REPORT_PATH: GATE_ATTRIBUTION_REPORT_PATH/);
  assert.match(gate, /unlinkSync\(path\)/);
  assert.match(
    gate,
    /inspect the per-suite attribution in the smoke output above; this gate's aggregate is retained/,
  );

  const runner = readFileSync("tests/run-all.ts", "utf8");
  assert.match(runner, /process\.env\.TEST_TASK_GATE_SWEEP_REPORT_PATH/);
  assert.match(runner, /reportPath: process\.env\.TEST_TASK_GATE_ATTRIBUTION_REPORT_PATH/);
  assert.match(runner, /relatedSelection:[\s\S]*?smokeSelection\.relatedSelectionForBudget/);
  assert.match(runner, /taskGatePerformance = \{/);
  assert.match(runner, /databaseBudget:/);
  assert.match(runner, /if \(!incompleteShardResults\)/);
  assert.match(runner, /batchedFirstAttempts/);

  for (const path of ["TESTING.md", "audits/ci-control-plane-simplification-audit-2026-08.md"]) {
    const doc = readFileSync(path, "utf8");
    assert.ok(
      doc.includes("npx tsx scripts/report-task-gate-evidence.ts"),
      `${path} must point its re-review reader to the task-gate evidence report`,
    );
  }
});

async function main(): Promise<void> {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`✓ ${name}`);
  }
  console.log(`task-gate-evidence: ${tests.length} test(s) passed`);
}

main().catch((error) => {
  console.error("task-gate-evidence: FAILED", error);
  process.exit(1);
});
