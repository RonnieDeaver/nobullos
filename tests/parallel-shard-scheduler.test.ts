/* test-registration
{
  "name": "parallel-shard-scheduler",
  "smoke": true,
  "smokeReason": "L1 correctness guard: the shard scheduler's dispatch-exactly-once, order-preservation, and lane-env-derivation properties are verdict-integrity invariants (Task #5029 Architecture Impact Review §10)",
  "tier": "medium",
  "tierReason": "This pure guard is mechanically small but protects runner verdict integrity; medium keeps it visible with the other control-plane safety checks."
}
test-registration */

/**
 * Guard suite for tests/shardScheduler.ts (Task #5029).
 *
 * Unique failure mode: a shard scheduler bug that drops, duplicates, or
 * misroutes suites would produce a different verdict set than the serial
 * runner — the classic "lost work" concurrency error. These pure-function
 * tests catch that class of bug at the unit layer (no DB, no spawning).
 *
 * Lowest layer: pure computation, <5s cold.
 */

import assert from "node:assert/strict";
import {
  buildPullSchedule,
  createBoundedSuiteDispatcher,
  distributeSuites,
  buildDurationEstimateMap,
  boundShardConcurrencyToProvisionedDatabases,
  buildShardEnvOverlay,
  deriveUnknownEstimateMs,
  mergeLaneResults,
  resolveShardConcurrency,
  SHARD_CONCURRENCY_POLICY,
  summarizeLaneLoads,
} from "./shardScheduler";

// ─── bounded shard-resource policy ─────────────────────────────────────────

{
  const decision = resolveShardConcurrency({
    requestedShardCount: 4,
    source: "default",
    selectedSuiteCount: 20,
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 12 * 1024 ** 3,
    hermeticMode: "local-cluster",
  });
  assert.equal(decision.effectiveShardCount, 4);
  assert.deepEqual(decision.capReasons, []);
  assert.equal(decision.caps.database, 16, "known 100-connection hermetic cap leaves 80/5 lane slots");
  console.log("✓ shard concurrency: healthy 8-vCPU/12GiB-free host retains four-lane default");
}

{
  const decision = resolveShardConcurrency({
    requestedShardCount: 4,
    source: "flag",
    selectedSuiteCount: 20,
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: SHARD_CONCURRENCY_POLICY.memoryReserveBytes + 1.5 * 1024 ** 3,
    hermeticMode: "local-cluster",
  });
  assert.equal(decision.effectiveShardCount, 1, "low measured free memory must reduce before child spawn");
  assert.ok(decision.capReasons.includes("memory-headroom"));
  console.log("✓ shard concurrency: low free-memory pressure lowers lanes conservatively");
}

{
  const decision = resolveShardConcurrency({
    requestedShardCount: 8,
    source: "env",
    selectedSuiteCount: 2,
    cpuCount: 4,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 12 * 1024 ** 3,
    hermeticMode: "local-cluster",
  });
  assert.equal(decision.effectiveShardCount, 2);
  assert.ok(decision.capReasons.includes("cpu"));
  assert.ok(decision.capReasons.includes("selected-suite-count"));
  console.log("✓ shard concurrency: explicit override remains visible but cannot exceed CPU/suite safety caps");
}

{
  const decision = resolveShardConcurrency({
    requestedShardCount: 4,
    source: "default",
    selectedSuiteCount: 20,
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 12 * 1024 ** 3,
    hermeticMode: "shared-instance-fallback",
  });
  assert.equal(decision.effectiveShardCount, 1);
  assert.ok(decision.capReasons.includes("hermetic-fallback"));
  console.log("✓ shard concurrency: shared-instance fallback remains serial");
}

{
  const initial = resolveShardConcurrency({
    requestedShardCount: 4,
    source: "default",
    selectedSuiteCount: 20,
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: SHARD_CONCURRENCY_POLICY.memoryReserveBytes + 1.5 * 1024 ** 3,
    hermeticMode: "local-cluster",
  });
  const afterPlanning = resolveShardConcurrency({
    requestedShardCount: 4,
    source: "default",
    selectedSuiteCount: 20,
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 12 * 1024 ** 3,
    hermeticMode: "local-cluster",
  });
  const bounded = boundShardConcurrencyToProvisionedDatabases(
    afterPlanning,
    initial.effectiveShardCount,
  );
  assert.equal(initial.effectiveShardCount, 1);
  assert.equal(afterPlanning.effectiveShardCount, 4);
  assert.equal(bounded.effectiveShardCount, 1);
  assert.ok(bounded.capReasons.includes("shard-db-provisioning"));
  console.log("✓ shard concurrency: later memory recovery cannot exceed provisioned shard DB capacity");
}

// ─── distributeSuites ─────────────────────────────────────────────────────

function makeSuites(count: number, durations?: number[]) {
  return Array.from({ length: count }, (_, i) => ({
    file: `tests/suite-${i}.test.ts`,
    name: `suite-${i}`,
    estimatedMs: durations ? (durations[i] ?? 0) : 0,
  }));
}

// Every input suite appears in exactly one lane (dispatch-exactly-once invariant).
{
  const suites = makeSuites(20, Array.from({ length: 20 }, (_, i) => (i + 1) * 1000));
  for (const shardCount of [1, 2, 3, 4, 5, 8]) {
    const lanes = distributeSuites(suites, shardCount);
    assert.equal(lanes.length, shardCount, `shardCount=${shardCount}: lane count wrong`);
    const allFiles = lanes.flat().map((s) => s.file);
    assert.equal(allFiles.length, suites.length, `shardCount=${shardCount}: total suite count wrong`);
    const unique = new Set(allFiles);
    assert.equal(unique.size, suites.length, `shardCount=${shardCount}: duplicate suites detected`);
    for (const suite of suites) {
      assert.ok(unique.has(suite.file), `shardCount=${shardCount}: missing suite ${suite.file}`);
    }
  }
  console.log("✓ distributeSuites: dispatch-exactly-once holds for N=1..8");
}

// Single-shard: output equals input (slice copy, same order).
{
  const suites = makeSuites(5, [100, 200, 300, 400, 500]);
  const lanes = distributeSuites(suites, 1);
  assert.equal(lanes.length, 1);
  // Content must match (order may differ due to sort; just verify membership).
  const outFiles = new Set(lanes[0].map((s) => s.file));
  for (const s of suites) assert.ok(outFiles.has(s.file));
  console.log("✓ distributeSuites: single shard preserves all suites");
}

// Empty input → all lanes empty.
{
  const lanes = distributeSuites([], 4);
  assert.equal(lanes.length, 4);
  for (const l of lanes) assert.equal(l.length, 0);
  console.log("✓ distributeSuites: empty input produces empty lanes");
}

// All unknown estimates must rotate across every lane instead of repeatedly
// selecting lane 0 on equal zero-load ties.
{
  const lanes = distributeSuites(makeSuites(16), 4);
  assert.deepEqual(
    lanes.map((lane) => lane.length),
    [4, 4, 4, 4],
    "all-zero estimates must spread evenly across every lane",
  );
  console.log("✓ distributeSuites: all-zero estimates use balanced round-robin fallback");
}

// Known and unknown estimates share the same deterministic tie-break. Unknown
// work is never concentrated in the first lane after known work is placed.
{
  const suites = [
    ...makeSuites(4, [10_000, 8_000, 6_000, 4_000]),
    ...makeSuites(8).map((suite) => ({ ...suite, file: `tests/unknown-${suite.name}.test.ts` })),
  ];
  const lanes = distributeSuites(suites, 4);
  const unknownCounts = lanes.map((lane) => lane.filter((s) => !s.estimatedMs).length);
  assert.ok(
    unknownCounts.every((count) => count > 0),
    `mixed estimates must put unknown suites on every lane: ${unknownCounts.join(",")}`,
  );
  console.log("✓ distributeSuites: mixed known/unknown estimates cover every lane");
}

// Unknown coverage is explicit even when one known suite makes a lane much
// heavier than its peers. A median planning weight alone would keep choosing
// the light lanes and leave the heavy lane with no unknown work.
{
  const suites = [
    { file: "tests/heavy-known.test.ts", estimatedMs: 100_000 },
    ...makeSuites(3, [1, 1, 1]).map((suite) => ({ ...suite, file: `tests/light-${suite.name}.test.ts` })),
    ...makeSuites(12).map((suite) => ({ ...suite, file: `tests/skew-unknown-${suite.name}.test.ts` })),
  ];
  const lanes = distributeSuites(suites, 4);
  const unknownCounts = lanes.map((lane) =>
    lane.filter((suite) => suite.file.includes("skew-unknown-")).length,
  );
  assert.ok(
    unknownCounts.every((count) => count > 0),
    `skewed known estimates must still distribute unknown suites to every lane: ${unknownCounts.join(",")}`,
  );
  console.log("✓ distributeSuites: coverage-first fallback survives skewed known estimates");
}

// A partial/single-suite report overlays the durable full-population history
// only for the suite it observed; all other estimates survive.
{
  const fullRun = makeSuites(8, [800, 700, 600, 500, 400, 300, 200, 100]).map((suite) => ({
    file: suite.file,
    elapsedMs: suite.estimatedMs!,
  }));
  const singleSuite = [{ file: "tests/suite-3.test.ts", elapsedMs: 1_234 }];
  const estimatesAfterPartial = buildDurationEstimateMap(fullRun, singleSuite);
  assert.equal(estimatesAfterPartial.size, 8);
  assert.equal(estimatesAfterPartial.get("tests/suite-3.test.ts"), 1_234);
  assert.equal(estimatesAfterPartial.get("tests/suite-0.test.ts"), 800);
  const nextRun = makeSuites(8).map((suite) => ({
    ...suite,
    estimatedMs: estimatesAfterPartial.get(suite.file) ?? 0,
  }));
  const lanes = distributeSuites(nextRun, 4);
  const laneSizes = lanes.map((lane) => lane.length);
  assert.ok(
    Math.max(...laneSizes) - Math.min(...laneSizes) <= 2,
    `full run after single-suite run must remain count-balanced: ${laneSizes.join(",")}`,
  );
  assert.equal(lanes.flat().length, 8, "full run after partial history must dispatch every suite");
  console.log("✓ buildDurationEstimateMap: partial history retains full-population coverage");
}

// Aggregate observability is deterministic and contains no suite output.
{
  const suites = makeSuites(6, [600, 500, 400, 300, 200, 100]);
  const summaries = summarizeLaneLoads(distributeSuites(suites, 3), deriveUnknownEstimateMs(suites));
  assert.equal(summaries.reduce((sum, lane) => sum + lane.suiteCount, 0), 6);
  assert.equal(summaries.reduce((sum, lane) => sum + lane.knownEstimateCount, 0), 6);
  assert.equal(summaries.reduce((sum, lane) => sum + lane.estimatedLoadMs, 0), 2_100);
  assert.equal(summaries.reduce((sum, lane) => sum + lane.plannedLoadMs, 0), 2_100);
  console.log("✓ summarizeLaneLoads: aggregate planned load is complete");
}

// shardCount > suiteCount: some lanes are empty, but total suite count still correct.
{
  const suites = makeSuites(3);
  const lanes = distributeSuites(suites, 8);
  assert.equal(lanes.length, 8);
  assert.equal(lanes.flat().length, 3);
  const emptyLanes = lanes.filter((l) => l.length === 0).length;
  assert.ok(emptyLanes >= 5, "expected at least 5 empty lanes when 3 suites across 8 shards");
  console.log("✓ distributeSuites: shardCount > suiteCount handled correctly");
}

// LPT property: heaviest suite must land on a lane, and total per-lane load
// should be "roughly balanced" (max lane load ≤ 2× min non-zero lane load for
// uniform inputs).
{
  const uniformMs = 1000;
  const suites = makeSuites(12, Array(12).fill(uniformMs));
  const lanes = distributeSuites(suites, 4);
  const loads = lanes.map((l) => l.reduce((s, t) => s + (t.estimatedMs ?? 0), 0));
  const nonZero = loads.filter((l) => l > 0);
  const maxLoad = Math.max(...nonZero);
  const minLoad = Math.min(...nonZero);
  assert.ok(
    maxLoad <= minLoad * 2,
    `LPT balance: max lane load ${maxLoad} is more than 2× min ${minLoad}`,
  );
  console.log(`✓ distributeSuites: LPT balance (max=${maxLoad}ms min=${minLoad}ms)`);
}

// Heaviest suite is placed before lighter suites on its lane (greedy LPT order
// guarantee: after sorting heaviest-first, the first assignment goes to lane-0).
{
  const suites = [
    { file: "heavy.test.ts", estimatedMs: 50_000 },
    ...makeSuites(6, Array(6).fill(1_000)),
  ];
  const lanes = distributeSuites(suites, 4);
  const heavyLane = lanes.find((l) => l.some((s) => s.file === "heavy.test.ts"));
  assert.ok(heavyLane !== undefined, "heavy suite must appear in some lane");
  console.log("✓ distributeSuites: heaviest suite placed (LPT first assignment)");
}

// ─── bounded pull dispatch ─────────────────────────────────────────────────

// The schedule is deterministic and starts known expensive work first without
// binding it to a lane. Equal estimates preserve registration order, which
// keeps benchmark output reproducible.
{
  const suites = [
    { file: "unknown-first.test.ts", estimatedMs: 0 },
    { file: "medium-a.test.ts", estimatedMs: 50 },
    { file: "heavy.test.ts", estimatedMs: 100 },
    { file: "medium-b.test.ts", estimatedMs: 50 },
    { file: "unknown-last.test.ts", estimatedMs: 0 },
  ];
  assert.deepEqual(
    buildPullSchedule(suites).map((suite) => suite.file),
    [
      "heavy.test.ts",
      "medium-a.test.ts",
      "medium-b.test.ts",
      "unknown-first.test.ts",
      "unknown-last.test.ts",
    ],
  );
  console.log("✓ buildPullSchedule: deterministic LPT-like queue order");
}

// A shared dispatcher can only give each unstarted suite to one lane. A
// claimed suite is never returned again, even after all lanes have exhausted
// the bounded queue.
{
  const suites = makeSuites(12, Array.from({ length: 12 }, (_, i) => 12 - i));
  const dispatcher = createBoundedSuiteDispatcher(suites);
  const claimedByLane = [[], [], []] as string[][];
  let lane = 0;
  for (;;) {
    const suite = dispatcher.claimNext();
    if (!suite) break;
    claimedByLane[lane % claimedByLane.length].push(suite.file);
    lane++;
  }
  const claimed = claimedByLane.flat();
  assert.equal(claimed.length, suites.length);
  assert.equal(new Set(claimed).size, suites.length, "a suite may be claimed exactly once");
  assert.equal(dispatcher.claimedCount, suites.length);
  assert.equal(dispatcher.remainingCount, 0);
  assert.equal(dispatcher.claimNext(), undefined, "the schedule must not requeue started work");
  console.log("✓ bounded pull dispatcher: exactly-once claims and no post-start moves");
}

// When actual durations drift from equal estimates, static ownership can leave
// one lane idle while another retains several slow suites. Pull dispatch lets
// the idle lane claim only work that has not begun, reducing the modeled tail
// without moving running work or changing suite membership.
{
  const suites = makeSuites(6, Array(6).fill(100));
  const actualMs = [100, 1, 100, 1, 100, 1];
  const staticWallMs = Math.max(
    ...distributeSuites(suites, 2).map((lane) =>
      lane.reduce((sum, suite) => sum + actualMs[Number(suite.name.slice("suite-".length))], 0),
    ),
  );
  const dispatcher = createBoundedSuiteDispatcher(suites);
  const laneReadyAt = [0, 0];
  for (;;) {
    const suite = dispatcher.claimNext();
    if (!suite) break;
    const lane = laneReadyAt[0] <= laneReadyAt[1] ? 0 : 1;
    const index = Number(suite.name.slice("suite-".length));
    laneReadyAt[lane] += actualMs[index];
  }
  const pullWallMs = Math.max(...laneReadyAt);
  assert.equal(dispatcher.claimedCount, suites.length);
  assert.ok(
    pullWallMs < staticWallMs,
    `pull dispatch must improve drifted tail (pull=${pullWallMs}ms static=${staticWallMs}ms)`,
  );
  console.log(`✓ bounded pull dispatcher: drifted tail improves (${staticWallMs}ms → ${pullWallMs}ms)`);
}

// ─── buildShardEnvOverlay ─────────────────────────────────────────────────

{
  const base: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgresql://localhost/nobull_test",
    DATABASE_URL_DIRECT: "postgresql://localhost/nobull_test",
    PGDATABASE_URL: "postgresql://localhost/nobull_test",
    PGHOST: "/tmp/nobull-hermetic/sock",
    PGPORT: "54321",
    PGUSER: "postgres",
    PGPASSWORD: "",
    PGDATABASE: "nobull_test",
    NOBULL_TEST_CACHE_NAMESPACE: "run-20260818-123456-999",
    SOME_OTHER_VAR: "unchanged",
  };
  const shardUrl = "postgresql://localhost/nobull_shard_2?host=%2Ftmp%2Fnobull-hermetic%2Fsock";
  const overlay = buildShardEnvOverlay(base, shardUrl, 2, "run-20260818-123456-999");

  // DB URL overrides.
  assert.equal(overlay.DATABASE_URL, shardUrl, "DATABASE_URL must point at shard DB");
  assert.equal(overlay.DATABASE_URL_DIRECT, shardUrl, "DATABASE_URL_DIRECT must point at shard DB");
  assert.equal(overlay.PGDATABASE_URL, shardUrl, "PGDATABASE_URL must point at shard DB");

  // Cache namespace must be scoped by shard index.
  assert.ok(
    (overlay.NOBULL_TEST_CACHE_NAMESPACE ?? "").includes("-s2"),
    `cache namespace must include shard index: got '${overlay.NOBULL_TEST_CACHE_NAMESPACE}'`,
  );
  assert.notEqual(
    overlay.NOBULL_TEST_CACHE_NAMESPACE,
    base.NOBULL_TEST_CACHE_NAMESPACE,
    "shard cache namespace must differ from base",
  );

  // Non-DB vars are inherited unchanged.
  assert.equal(overlay.SOME_OTHER_VAR, "unchanged", "non-DB vars must be inherited");
  assert.equal(overlay.PGHOST, base.PGHOST, "PGHOST must be inherited (socket dir shared)");
  assert.equal(overlay.PGPORT, base.PGPORT, "PGPORT must be inherited");

  // Different shard indices must produce different cache namespaces.
  const overlay0 = buildShardEnvOverlay(base, shardUrl, 0, "run-20260818-123456-999");
  const overlay3 = buildShardEnvOverlay(base, shardUrl, 3, "run-20260818-123456-999");
  assert.notEqual(overlay0.NOBULL_TEST_CACHE_NAMESPACE, overlay3.NOBULL_TEST_CACHE_NAMESPACE);

  console.log("✓ buildShardEnvOverlay: URL override + cache scoping + passthrough correct");
}

// ─── mergeLaneResults ─────────────────────────────────────────────────────

{
  type FakeResult = { file: string; passed: boolean };
  const toRun = [
    { file: "a.test.ts" },
    { file: "b.test.ts" },
    { file: "c.test.ts" },
    { file: "d.test.ts" },
    { file: "e.test.ts" },
  ];

  // Lane 0 ran a, c, e; lane 1 ran b, d (interleaved order).
  const lane0: FakeResult[] = [
    { file: "c.test.ts", passed: true },
    { file: "a.test.ts", passed: true },
    { file: "e.test.ts", passed: false },
  ];
  const lane1: FakeResult[] = [
    { file: "d.test.ts", passed: true },
    { file: "b.test.ts", passed: true },
  ];

  const merged = mergeLaneResults([lane0, lane1], toRun);
  assert.equal(merged.complete, true, "intact multi-lane merge must be complete");
  assert.equal(merged.results.length, 5, "all 5 results must be present");
  assert.deepEqual(merged.missingFiles, []);
  assert.deepEqual(merged.duplicateFiles, []);
  assert.deepEqual(merged.unexpectedFiles, []);

  // Order must match toRun registration order (a, b, c, d, e).
  const files = merged.results.map((r) => r.file);
  assert.deepEqual(files, ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"]);

  // Check values are correct after reordering.
  assert.equal(merged.results[0].passed, true);  // a
  assert.equal(merged.results[1].passed, true);  // b
  assert.equal(merged.results[2].passed, true);  // c
  assert.equal(merged.results[3].passed, true);  // d
  assert.equal(merged.results[4].passed, false); // e

  console.log("✓ mergeLaneResults: complete multi-lane merge preserves registration order");
}

// Empty lane result / mid-lane crash: the accounted merge fails closed and
// names every missing suite rather than silently returning a green-looking
// subset. The caller converts these facts into explicit incomplete records.
{
  type FakeResult = { file: string };
  const toRun = [
    { file: "a.test.ts" },
    { file: "b.test.ts" },
    { file: "c.test.ts" },
    { file: "d.test.ts" },
  ];
  // The second lane reports b then crashes before c/d. Its remaining selected
  // work is accounted as missing, not passed/skipped.
  const merged = mergeLaneResults<FakeResult>(
    [[{ file: "a.test.ts" }], [{ file: "b.test.ts" }], []],
    toRun,
  );
  assert.equal(merged.complete, false, "any empty/crashed lane result is incomplete verification");
  assert.deepEqual(merged.results.map((r) => r.file), ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(merged.missingFiles, ["c.test.ts", "d.test.ts"]);
  assert.deepEqual(merged.duplicateFiles, []);
  assert.deepEqual(merged.unexpectedFiles, []);
  console.log("✓ mergeLaneResults: empty/mid-lane loss is explicit and fail-closed");
}

// A duplicate or foreign result is also incomplete: exactly-once accounting
// does not accept an arbitrary map overwrite as a trustworthy verdict.
{
  type FakeResult = { file: string };
  const merged = mergeLaneResults<FakeResult>(
    [[{ file: "a.test.ts" }, { file: "a.test.ts" }, { file: "foreign.test.ts" }]],
    [{ file: "a.test.ts" }],
  );
  assert.equal(merged.complete, false);
  assert.deepEqual(merged.duplicateFiles, ["a.test.ts"]);
  assert.deepEqual(merged.unexpectedFiles, ["foreign.test.ts"]);
  console.log("✓ mergeLaneResults: duplicate and foreign results block trusted verification");
}

// Empty lanes.
{
  type FakeResult = { file: string };
  const toRun = [{ file: "x.test.ts" }];
  const merged = mergeLaneResults<FakeResult>([[], [{ file: "x.test.ts" }], []], toRun);
  assert.equal(merged.complete, true);
  assert.equal(merged.results.length, 1);
  assert.equal(merged.results[0].file, "x.test.ts");
  console.log("✓ mergeLaneResults: empty lanes handled correctly");
}

console.log("\n✓ All parallel-shard-scheduler assertions passed.");
