import { spawn, type ChildProcess } from "child_process";
import { cpus, freemem, totalmem } from "os";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import {
  createBoundedSuiteDispatcher,
  boundShardConcurrencyToProvisionedDatabases,
  distributeSuites,
  buildDurationEstimateMap,
  buildShardEnvOverlay,
  deriveUnknownEstimateMs,
  mergeLaneResults,
  resolveShardConcurrency,
  SHARD_CONCURRENCY_POLICY,
  summarizeLaneLoads,
  type ShardCapReason,
  type ShardConcurrencyDecision,
  type ShardCountSource,
} from "./shardScheduler";
import { dirname, resolve } from "path";
import {
  appendDurationBudgetBreachEvent,
  buildSweepReport,
  isQuarantinedTestFile,
  reportIndicatesFailure,
  summarizeSweepResult,
  type SweepReport,
  type SweepTestResult,
} from "../server/services/regressionSweep";
import {
  DEFAULT_CORE_RULES,
  coreReason,
  computeChangedFiles,
  formatSelectionSummary,
  makeGitRunner,
  selectBlastRadiusExpansion,
  selectRelatedSmokeTests,
  writeSelectionManifest,
} from "./relatedSmokeSelection";
import {
  DEFAULT_GREEN_BASELINE_PATH,
  formatExecutedSkippedLine,
  formatIncrementalSummary,
  formatRepeatPoisonWarnings,
  deferralCandidatesFromPlan,
  planFullLaneDeferral,
  planIncrementalRun,
  publishGreenBaseline,
  recordRunOutcomes,
  updateSkipPoisonHistory,
  writeFullLaneDeferralRecord,
  writeSkipAudit,
  type IncrementalPlan,
} from "./suiteFingerprint";
import {
  DEFAULT_RED_MANIFEST_PATH,
  attributeRunFailures,
  loadRedManifest,
  publishRedManifest,
  resolveMergeWindow,
} from "./redManifest";
import { buildTestRegistry, type TestDef } from "./testRegistry";
import { provisionHermeticDb, type HermeticHandle } from "./hermetic/provision";
import {
  appendRunToHistory,
  findRepeatOffenders,
  formatRepeatOffenders,
  loadSuiteHistory,
  saveSuiteHistory,
} from "./flakeHistory";
import {
  QUARANTINE_KILL_SWITCH_ENV,
  QUARANTINE_LEDGER_PATH,
  buildQuarantineFeedbackText,
  computeQuarantineTransitions,
  formatQuarantineEntry,
  isAutoQuarantined,
  loadQuarantineLedger,
  saveQuarantineLedger,
} from "./flakeQuarantine";
import {
  batchCompatibilityForSuite,
  recycleAfterResult,
  recycleBeforeDispatch,
  type BatchRecycleCause,
} from "./batchWorkerPolicy";
import {
  BUDGET_ARTIFACT_PATH,
  REGEN_COMMAND,
  evaluateDurationBudget,
  loadDurationBudgetArtifact,
  type DurationBudgetEvaluation,
  resolveSmokeSelection,
} from "./durationBudget";

// ─── Task #3797: hermetic per-run test database ──────────────────────
// By default the runner provisions a PRIVATE throwaway Postgres for this
// run (see tests/hermetic/provision.ts) and injects its URL into every
// connection-string variant each child inherits, so suites physically
// cannot touch the shared Helium dev DB — the root cause of years of
// cross-run flakes (dev server + task leftovers sharing one mutable DB).
// server/db.ts enforces the inverse in test mode: it unconditionally
// refuses to open the shared dev DB.
//
// Escape-hatch history: the per-suite `sharedDev: true` tag was retired in
// Task #3862 (last tagged suite went hermetic in Task #3851; the registry
// rejects the key), and the whole-run TEST_SHARED_DEV_DB=1 legacy mode was
// retired once confirmed unused — hermetic is the ONLY mode. There is no
// supported way for tests to touch the shared Helium dev DB.
let hermetic: HermeticHandle | null = null;

// Task #3839: the dev-server "test-run pause" sentinel machinery
// (Task #2083's server/services/testRunPause.ts) is gone — hermetic runs
// own a private DB, so the dev server never needs to yield.

// Always release the hermetic cluster, however this process ends.
// HermeticHandle.teardown()'s body is synchronous under the hood
// (pg_ctl stop / DROP DATABASE + rm), so it is safe to invoke from an
// 'exit' handler.
process.on("exit", () => {
  const h = hermetic;
  if (h) {
    hermetic = null;
    void h.teardown().catch(() => {});
  }
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    process.exit(1);
  });
}
process.on("uncaughtException", (err) => {
  console.error("[run-all] Uncaught exception:", err);
  process.exit(1);
});

// Hard safety guard (deploy-build incident, Jul 16 2026): the test
// suite bootstraps migrations and writes test rows, so it must never
// run against the production Neon database. The deploy build exports
// the prod DATABASE_URL, which is how this was nearly violated —
// the legacy bootstrap tried to apply 0000_… against prod and only
// "relation already exists" stopped it. Dev is Helium; prod is Neon.
// server/db.ts re-enforces this inside every test child.
if (
  (process.env.DATABASE_URL ?? "").includes("neon.tech") &&
  process.env.ALLOW_PROD_DB_TESTS !== "1"
) {
  console.error(
    "[run-all] REFUSING to run: DATABASE_URL points at the production Neon database. " +
      "Tests mutate schema and data. Set ALLOW_PROD_DB_TESTS=1 only if you are absolutely sure.",
  );
  process.exit(1);
}

// Task #b65e9824: sweep leftover isolated test schemas (test_iso_*) from
// the shared dev DB before anything else. SIGKILL'd test children skip
// their finally-DROP, and the orphaned schemas' cloned constraints have
// already fooled a presence check into skipping a public-schema restore.
// Best-effort and non-fatal by design; kept even though every run is now
// hermetic because leftovers from historical legacy runs live in the
// shared dev DB regardless of how this run's tests connect.
if (process.env.DATABASE_URL) {
  const { sweepLeftoverIsolatedSchemas } = await import("./sweep-isolated-schemas");
  await sweepLeftoverIsolatedSchemas(process.env.DATABASE_URL);
}

// (Hermetic provisioning happens after test selection, right before the
// run loop, so empty selections and --list never pay for a cluster.)

// Task #3786: the TESTS array and SMOKE_FILES set used to live right here
// as ~2,500 lines of hand-maintained literals — the single worst merge
// hotspot in the repo (edited in 158 of the 400 commits before the
// cutover). Every test file now carries its own `/* test-registration`
// block (see tests/testRegistry.ts for the format and the smoke-gate
// policy prose that used to head SMOKE_FILES), and the registry is derived
// by discovery, so adding a test touches no shared file. Structural
// problems fail loudly: a partial registry must never silently shrink the
// suite.
const registry = buildTestRegistry();
if (registry.problems.length > 0) {
  console.error(
    `[run-all] ${registry.problems.length} invalid test registration(s) — refusing to run with a partial registry:`,
  );
  for (const p of registry.problems) console.error(`  - ${p.file}: ${p.message}`);
  console.error(
    "[run-all] Fix the block(s) above (format: tests/testRegistry.ts docblock; lint: npx tsx scripts/lint-test-registration.ts).",
  );
  process.exit(1);
}
const TESTS: TestDef[] = registry.tests;
const SMOKE_FILES: Set<string> = registry.smokeFiles;

// Task #5028: load the auto-quarantine ledger. Fail-closed on any problem
// (tampered seal, malformed JSON, missing file) → empty ledger → every
// quarantined suite blocks. Kill switch: FLAKE_QUARANTINE=0 disables all
// quarantine behavior (conservative direction). Single writer: the
// TEST_GREEN_BASELINE_PUBLISH=1 publish block below.
const quarantineLedgerAbsPath = resolve(process.cwd(), QUARANTINE_LEDGER_PATH);
const { ledger: autoQuarantineLedger, note: quarantineLedgerNote } = loadQuarantineLedger(
  quarantineLedgerAbsPath,
);
if (quarantineLedgerNote) console.log(`[quarantine] ${quarantineLedgerNote}`);
const autoQuarantinedFiles = new Set(autoQuarantineLedger.entries.map((e) => e.file));
if (autoQuarantinedFiles.size > 0) {
  console.log(
    `[quarantine] ${autoQuarantinedFiles.size} auto-quarantined suite(s) loaded from ${QUARANTINE_LEDGER_PATH}`,
  );
}

const onlyRegression = process.argv.includes("--regression");
const fullSmokeForced = process.argv.includes("--full-smoke");
const onlySmoke = process.env.TEST_SMOKE === "1" || process.argv.includes("--smoke") || fullSmokeForced;

// Budget enforcement keys on the selector's ACTUAL outcome. Explicit
// --full-smoke remains the only task-time path that runs the full universe;
// selector uncertainty keeps a bounded proof and transfers broad coverage to
// central integrity.
const relatedSmokeRequested =
  onlySmoke && (process.env.TEST_SMOKE_RELATED === "1" || process.argv.includes("--related-smoke"));
const relatedSmoke = relatedSmokeRequested && !fullSmokeForced;
let smokeSelection = resolveSmokeSelection({
  requestedRelated: relatedSmokeRequested,
  fullSmokeForced,
  manifestMode: null,
});
if (smokeSelection.note) console.log(smokeSelection.note);
let selected = TESTS;
let sweepMode: SweepReport["mode"] = "all";
// Direct rails are the actual diff-selected suites, not every suite in a
// full universe. The latter can still carry legitimate rotation debt.
const directRelatedFiles = new Set<string>();
let centralIntegrityDeferred: {
  reason: string;
  selectionManifestGeneratedAt: string | null;
} | null = null;

if (onlyRegression) {
  selected = TESTS.filter((t) => t.regression === true);
  sweepMode = "regression";
} else if (onlySmoke) {
  selected = TESTS.filter((t) => SMOKE_FILES.has(t.file));
  sweepMode = "smoke";
  if (relatedSmoke) {
    // Task #3755: related-only smoke selection — map the files changed
    // since the merge base to the smoke tests that (transitively) depend on
    // them. selectRelatedSmokeTests never throws; when analysis cannot prove
    // a narrow universe it returns a bounded deferred result instead of
    // launching the entire smoke universe.
    const manifest = await selectRelatedSmokeTests(
      selected.map((t) => ({ file: t.file, extraNodeArgs: t.extraNodeArgs, scanPaths: t.scanPaths })),
    );
    writeSelectionManifest(manifest, ".local/runs/smoke-related-selection.json");
    for (const line of formatSelectionSummary(manifest)) console.log(line);
    smokeSelection = resolveSmokeSelection({
      requestedRelated: true,
      fullSmokeForced: false,
      manifestMode: manifest.mode,
    });
    if (smokeSelection.note) console.log(smokeSelection.note);
    if (smokeSelection.narrowToRelated) {
      const keep = new Set(manifest.selected.map((s) => s.file));
      selected = selected.filter((t) => keep.has(t.file));
      for (const entry of manifest.selected) {
        if (coreReason(entry.file, DEFAULT_CORE_RULES) === null) directRelatedFiles.add(entry.file);
      }
    }
    if (manifest.mode === "deferred") {
      centralIntegrityDeferred = {
        reason: manifest.deferredReason ?? "selection uncertainty",
        selectionManifestGeneratedAt: manifest.generatedAt,
      };
    }
  }
}

// Task #5028: in smoke mode, remove auto-quarantined suites from the gate
// selection. They will be added back as BLOCKING only if their import closure
// intersects the current diff (see the diff-touching override block after the
// blast-radius expansion below). If the diff check fails, ALL quarantined
// suites are re-added (fail-closed). Not applicable outside smoke mode (they
// always execute, non-blocking, so evidence accrues).
let quarantineExcludedFromSmoke = new Set<string>();
let quarantineGateSkippedCount = 0;
if (onlySmoke && autoQuarantinedFiles.size > 0) {
  const excluded = selected.filter((t) => autoQuarantinedFiles.has(t.file));
  if (excluded.length > 0) {
    quarantineExcludedFromSmoke = new Set(excluded.map((t) => t.file));
    selected = selected.filter((t) => !autoQuarantinedFiles.has(t.file));
    console.log(
      `[quarantine] removed ${excluded.length} auto-quarantined suite(s) from smoke gate; checking diff-touching override…`,
    );
  }
}

// Task #5030 — deferral bookkeeping: suites added by blast-radius expansion
// or the quarantine diff-touching override are risk-triggered adds and must
// NEVER be deferred to the post-merge lane (see the rotation-day deferral
// block below the incremental plan).
const expansionAddedFiles = new Set<string>();
const quarantineReAddedFiles = new Set<string>();

// Task #4501: blast-radius gate expansion — when TEST_GATE_EXPANSION != "0"
// and running in smoke mode (not an explicit --file or --regression run), trace
// non-smoke suites' import closures against the diff and append those that are
// reached by a changed file (budget-capped, honest truncation log).
//
// This closes the structural gap where a base-breaking merge (e.g. 2026-08
// login switch) merges green because affected non-smoke suites were outside
// SMOKE_FILES and therefore invisible to the gate.  Kill switch:
// TEST_GATE_EXPANSION=0 (or leave unset to rely on gate.ts which sets "1").
if (onlySmoke && process.env.TEST_GATE_EXPANSION !== "0") {
  try {
    const gitRunner = makeGitRunner(process.cwd());
    const changedResult = computeChangedFiles(gitRunner, process.env);
    if (!changedResult.ok) {
      console.log(
        `[expansion] blast-radius expansion skipped: diff detection failed (${changedResult.error ?? "unknown"}) — smoke selection unchanged.`,
      );
    } else if (changedResult.files.length === 0) {
      console.log("[expansion] blast-radius: no changed files detected — no expansion needed.");
    } else {
      const alreadySelected = new Set(selected.map((t) => t.file));
      const nonSmokeSuites = TESTS.filter(
        (t) => !SMOKE_FILES.has(t.file) && !alreadySelected.has(t.file),
      );
      if (nonSmokeSuites.length > 0) {
        const maxSuites = Number(process.env.GATE_EXPANSION_MAX_SUITES) || 15;
        // Task #4547: hard timeout for the tracer so a stalled esbuild BFS
        // fails to an honest fallbackReason instead of eating the outer
        // spawnSync budget and killing the whole smoke run.
        const expansionTimeoutMs = Number(process.env.GATE_EXPANSION_TIMEOUT_MS) || 30_000;
        const expansion = await selectBlastRadiusExpansion(
          nonSmokeSuites.map((t) => ({
            file: t.file,
            extraNodeArgs: t.extraNodeArgs,
            scanPaths: t.scanPaths,
          })),
          changedResult.files,
          { repoRoot: process.cwd(), maxSuites, timeoutMs: expansionTimeoutMs },
        );
        if (expansion.fallbackReason) {
          console.log(`[expansion] blast-radius expansion skipped: ${expansion.fallbackReason}`);
        } else {
          const toAdd = nonSmokeSuites.filter((t) =>
            expansion.selected.some((s) => s.file === t.file),
          );
          if (toAdd.length > 0) {
            console.log(
              `\n[expansion] blast-radius: +${toAdd.length} non-smoke suite(s) whose import closure intersects ${changedResult.files.length} changed file(s):`,
            );
            for (const s of expansion.selected) {
              console.log(`[expansion]   + ${s.file} — ${s.reason}`);
            }
            selected = [...selected, ...toAdd];
            for (const t of toAdd) expansionAddedFiles.add(t.file);
          } else {
            console.log(
              `[expansion] blast-radius: no non-smoke suites reached by the diff (${changedResult.files.length} changed file(s)) — no expansion needed.`,
            );
          }
          if (expansion.truncated) {
            console.log(
              `[expansion] NOTE: ${expansion.truncatedCount} additional closure-hit suite(s) not appended (cap ${maxSuites}). Set GATE_EXPANSION_MAX_SUITES=N to raise.`,
            );
          }
        }
      }
    }
  } catch (expansionErr) {
    // Expansion errors must NEVER suppress the smoke run — log and continue.
    console.warn(
      `[expansion] blast-radius expansion crashed (non-fatal, smoke run continues): ${
        expansionErr instanceof Error ? expansionErr.message : String(expansionErr)
      }`,
    );
  }
}

// Task #5028: quarantine diff-touching override. For each quarantined suite
// removed from smoke selection above, check if its import closure intersects
// the current diff — if so, it MUST run and block (quarantine cannot hide a
// regression in code you actually touched). Fail closed: any failure in diff
// detection or the closure trace adds ALL quarantined suites back as blocking.
if (onlySmoke && quarantineExcludedFromSmoke.size > 0) {
  try {
    const qSuites = TESTS.filter((t) => quarantineExcludedFromSmoke.has(t.file));
    const qGitRunner = makeGitRunner(process.cwd());
    const qChangedResult = computeChangedFiles(qGitRunner, process.env);
    let toAddBack: (typeof TESTS)[number][];
    let qFailClosedReason: string | null = null;

    if (!qChangedResult.ok) {
      qFailClosedReason = `diff detection failed (${qChangedResult.error ?? "unknown"})`;
      toAddBack = qSuites;
    } else if (qChangedResult.files.length === 0) {
      // Zero changed files → no suite can be diff-related → all stay excluded.
      toAddBack = [];
      quarantineGateSkippedCount = qSuites.length;
      console.log(
        `[quarantine] no changed files — all ${qSuites.length} quarantined suite(s) excluded from gate (non-diff-related)`,
      );
    } else {
      const qTimeoutMs = Number(process.env.GATE_EXPANSION_TIMEOUT_MS) || 20_000;
      const qExpansion = await selectBlastRadiusExpansion(
        qSuites.map((t) => ({ file: t.file, extraNodeArgs: t.extraNodeArgs, scanPaths: t.scanPaths })),
        qChangedResult.files,
        { repoRoot: process.cwd(), maxSuites: qSuites.length, timeoutMs: qTimeoutMs },
      );
      if (qExpansion.fallbackReason) {
        qFailClosedReason = `closure trace failed (${qExpansion.fallbackReason})`;
        toAddBack = qSuites;
      } else {
        const hitFiles = new Set(qExpansion.selected.map((s) => s.file));
        toAddBack = qSuites.filter((t) => hitFiles.has(t.file));
        const notRelated = qSuites.filter((t) => !hitFiles.has(t.file));
        quarantineGateSkippedCount = notRelated.length;
        if (notRelated.length > 0) {
          console.log(
            `[quarantine] ${notRelated.length} quarantined suite(s) not diff-related — excluded from gate (non-blocking):`,
          );
          for (const t of notRelated) console.log(`[quarantine]   - ${t.file}`);
        }
      }
    }

    if (qFailClosedReason) {
      console.log(
        `[quarantine] override fail-closed (${qFailClosedReason}) — all ${qSuites.length} quarantined suite(s) added as blocking`,
      );
    }
    if (toAddBack.length > 0) {
      console.log(
        `[quarantine] ${toAddBack.length} diff-related quarantined suite(s) re-added as blocking:`,
      );
      for (const t of toAddBack) {
        console.log(`[quarantine]   + ${t.file} (import closure intersects diff — override applies)`);
      }
      selected = [
        ...selected,
        ...toAddBack.filter((t) => !selected.some((s) => s.file === t.file)),
      ];
      for (const t of toAddBack) quarantineReAddedFiles.add(t.file);
    }
  } catch (qOverrideErr) {
    // Any crash = fail closed: all quarantined suites run and block.
    const qSuites = TESTS.filter((t) => quarantineExcludedFromSmoke.has(t.file));
    console.log(
      `[quarantine] override check crashed — all ${qSuites.length} quarantined suite(s) added as blocking (fail closed): ${
        qOverrideErr instanceof Error ? qOverrideErr.message : String(qOverrideErr)
      }`,
    );
    selected = [
      ...selected,
      ...qSuites.filter((t) => !selected.some((s) => s.file === t.file)),
    ];
    for (const t of qSuites) quarantineReAddedFiles.add(t.file);
  }
}

// Task #3797: `--file=<path>[,<path>…]` runs only the named REGISTERED
// suites (with their registered loader flags/env) under the hermetic
// backend. This is the sanctioned replacement for bare
// `NODE_ENV=test npx tsx tests/x.test.ts`, which server/db.ts now refuses
// against the shared dev DB.
const fileArgs = process.argv.filter((a) => a.startsWith("--file="));
if (fileArgs.length > 0) {
  const wanted = new Set(
    fileArgs
      .flatMap((a) => a.slice("--file=".length).split(","))
      .map((f) => f.trim())
      .filter(Boolean),
  );
  const missing = [...wanted].filter((f) => !TESTS.some((t) => t.file === f));
  if (missing.length > 0) {
    console.error(
      `[run-all] --file selection(s) not in the TESTS registry: ${missing.join(", ")}. ` +
        `Register the suite in tests/run-all.ts first.`,
    );
    process.exit(1);
  }
  selected = TESTS.filter((t) => wanted.has(t.file));
  sweepMode = "all";
  console.log(`Running ${selected.length} suite(s) selected via --file.`);
}

// ─── Task #5029: parallel shard count resolution ────────────────────────
// Resolved here (before hermetic provisioning) so the shard DB creation
// immediately following provisioning can reference `requestedShards`.
// Default N = min(4, ceil(vCPUs / 2)): 8-vCPU box → 4 shards (approved).
// Overrides (highest to lowest priority):
//   --serial flag       → N=1 (exact pre-5029 serial behavior)
//   --shards=<n>        → N=n
//   TEST_SHARDS=<n> env → N=n
//   default             → min(4, ceil(cpuCount / 2))
//
// N=1 is also forced automatically when:
//   - The hermetic provisioner is in shared-instance-fallback mode (no
//     per-shard DB isolation available).
//   - toRun.length ≤ 1 (no benefit to launching shard infrastructure).
const _serialFlag = process.argv.includes("--serial");
const _shardsArgRaw = process.argv.find((a) => a.startsWith("--shards="));
const _shardsFromEnv = Number.parseInt(process.env.TEST_SHARDS ?? "", 10);
const _defaultShards = Math.min(4, Math.max(1, Math.ceil(cpus().length / 2)));
const shardCountSource: ShardCountSource = _serialFlag
  ? "serial"
  : _shardsArgRaw
    ? "flag"
    : Number.isFinite(_shardsFromEnv) && _shardsFromEnv > 0
      ? "env"
      : "default";
const requestedShards = _serialFlag
  ? 1
  : _shardsArgRaw
    ? Math.max(1, Number.parseInt(_shardsArgRaw.slice("--shards=".length), 10) || 1)
    : Number.isFinite(_shardsFromEnv) && _shardsFromEnv > 0
      ? _shardsFromEnv
      : _defaultShards;
// Dynamic dispatch is intentionally explicit while its performance evidence
// accumulates. It never changes `--serial`; without this opt-in, LPT's static
// lane assignment remains the default and rollback path.
const dynamicShardDispatchRequested =
  !_serialFlag &&
  (process.argv.includes("--dynamic-shards") || process.env.TEST_DYNAMIC_SHARDS === "1");

// ─── Hermetic provisioning (Task #3797) ──────────────────────────────
// After selection so empty selections never pay for a cluster. On any
// provisioning failure we abort loudly — never a silent fall back to the
// shared dev DB.
if (selected.length > 0) {
  try {
    hermetic = await provisionHermeticDb();
  } catch (err) {
    console.error(
      "[run-all] FATAL: hermetic DB provisioning failed. Refusing to silently fall back to the " +
        "shared dev DB. Diagnose with `npx tsx tests/hermetic/provision.ts --doctor`.\n",
      err,
    );
    process.exit(1);
  }
  // Point the runner's own env at the hermetic DB too: children inherit
  // process.env, so this is what makes every connection-string variant in
  // every child resolve hermetic (plus explicit unsets of the POOLED /
  // MIGRATIONS overrides that `??` fallbacks would otherwise resurrect).
  for (const k of hermetic.env.unset) delete process.env[k];
  Object.assign(process.env, hermetic.env.set);
}

// Task #5138: resolve a bounded, lowering-only count after hermetic mode is
// known. The policy preserves the current four-lane maximum and only applies
// measured CPU/memory plus known child-connection/process limits.
const resolveCurrentShardConcurrency = (selectedSuiteCount: number): ShardConcurrencyDecision =>
  resolveShardConcurrency({
    requestedShardCount: requestedShards,
    source: shardCountSource,
    selectedSuiteCount,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    hermeticMode: hermetic?.mode ?? "shared-instance-fallback",
  });

// Task #5029: provision per-shard databases from the ensured hermetic DB.
// Done here (immediately after the hermetic cluster is up + ensures pass)
// so the shard DBs are ready by the time the run loop starts. Shard count
// may be reduced to 1 if provisioning fails, mode is fallback, or the
// selected suite count is too small to benefit from sharding (checked after
// toRun is finalized below).
let shardConcurrency = resolveCurrentShardConcurrency(selected.length);
let effectiveShardCount = shardConcurrency.effectiveShardCount;
const shardRuntimeCapReasons = new Set<ShardCapReason>();
const shardDbUrls: string[] = [];
if (effectiveShardCount > 1 && hermetic) {
  if (hermetic.mode === "local-cluster") {
    try {
      const urls = await hermetic.createShardDbs(effectiveShardCount);
      shardDbUrls.push(...urls);
      console.log(
        `[shards] created ${effectiveShardCount} shard DB(s) ` +
          `(nobull_shard_0…nobull_shard_${effectiveShardCount - 1}) from nobull_test template`,
      );
    } catch (err) {
      console.warn(
        `[shards] shard DB creation failed — running serially: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      effectiveShardCount = 1;
      shardRuntimeCapReasons.add("shard-db-provisioning");
    }
  } else {
    // The resolver already selected one lane for shared-instance fallback.
    console.log(
      "[shards] shared-instance-fallback mode does not support per-shard databases — " +
        "running serially. Use TEST_SHARDS=1 to suppress.",
    );
  }
}

const sweepEnabled = process.argv.includes("--sweep");
const retryArg = process.argv.find((a) => a.startsWith("--retry-failed="));
const retryFailed = retryArg
  ? Math.max(0, Number.parseInt(retryArg.slice("--retry-failed=".length), 10) || 0)
  : sweepEnabled
    ? 2
    : 0;
const jsonReportArg = process.argv.find((a) => a.startsWith("--json-report="));
const jsonReportPath = jsonReportArg
  ? jsonReportArg.slice("--json-report=".length)
  : process.env.TEST_TASK_GATE_SWEEP_REPORT_PATH || null;

const forceAll = process.argv.includes("--force-all") || process.env.TEST_FORCE_ALL === "1";

// Task #3791: incremental green-skip. Plan which of the selected suites
// actually need to execute (fingerprint matches the last recorded green →
// skip). planIncrementalRun never throws — any internal failure falls open
// to executing everything.
let plan: IncrementalPlan | null = null;
let poisonWarningLines: string[] = [];
// Task #4104: the structured warnings ride into the sweep report so the
// nightly notification carries them too (see buildSweepReport below).
let repeatPoisonWarnings: import("./suiteFingerprint").RepeatPoisonWarning[] = [];
try {
  plan = await planIncrementalRun({
    suites: selected.map((t) => ({
      file: t.file,
      extraNodeArgs: t.extraNodeArgs,
      scanPaths: t.scanPaths,
      extraEnv: t.extraEnv,
      timeoutMs: t.timeoutMs,
    })),
    mode: sweepMode,
    forceAll,
  });
  for (const line of formatIncrementalSummary(plan)) console.log(line);
  writeSkipAudit(plan);
  // Task #4101: a file the tracer records as `<build error: …>` poisons
  // itself and every dependent suite into permanent unskippability. The
  // merge-time parseability lint catches this on gated merges, but nightly
  // sweeps on main and mid-work task envs run without it — so track
  // consecutive poisonings across audits and warn loudly (here AND in the
  // end-of-run summary) once the same file repeats.
  repeatPoisonWarnings = updateSkipPoisonHistory({ plan }).warnings;
  poisonWarningLines = formatRepeatPoisonWarnings(repeatPoisonWarnings);
  for (const line of poisonWarningLines) console.error(line);
} catch (err) {
  // Fall open: no plan means every selected suite executes.
  console.warn("[run-all] incremental planning failed — executing every suite:", err);
  plan = null;
}

// Task #5030 — rotation-day full-lane deferral (L3-approved policy revision).
// On merge-heavy days suite fingerprints rotate and the incremental plan
// demands near-full execution even though the diff touches almost nothing.
// The blocking gate's job is the DIFF (related + core + risk-triggered adds);
// re-verifying the rotated universe is the post-merge/nightly lane's job
// (post-merge canary #4501 + nightly sweep, which now name culprit merge
// windows). Suites whose ONLY reason to execute is rotated green evidence are
// deferred with an honest "deferred, not verified" record — never recorded
// green, reported in the summary line + sweep report.
//
// Hard rails (never deferred): related-selected (your diff reaches them),
// core guard suites, expansion/quarantine adds, smoke-only suites (the
// nightly lane would never run them), extraNodeArgs suites. Deferral engages
// only on plain full-smoke runs — never related-narrowed runs (already
// diff-scoped), --full-smoke/--force-all (explicitly full), --file runs,
// baseline-publish runs (greens must be measured), or when the related
// selector cannot produce a trustworthy "related" manifest (fall open to
// full execution). A run carrying ANY run-level execute reason
// (plan.skippingDisabledReason — wholesale fingerprint fall-open, integrity
// run) never defers: there is no trustworthy per-suite evidence to classify.
// And per-suite, deferral is REASON-GATED (review-hardened): only decisions
// positively classified "stale-rotation"/"stale-expired" (real green
// evidence invalidated by input churn or age) defer — no-record,
// last-failed, and uncomputable/poisoned suites always execute.
// Kill switch: TEST_FULL_DEFERRAL=0.
let deferredFiles: string[] = centralIntegrityDeferred
  ? TESTS
      .filter((test) => SMOKE_FILES.has(test.file) && !selected.some((selectedTest) => selectedTest.file === test.file))
      .map((test) => test.file)
  : [];
const deferralEligible =
  sweepMode === "smoke" &&
  !relatedSmoke &&
  !fullSmokeForced &&
  !forceAll &&
  fileArgs.length === 0 &&
  process.env.TEST_GREEN_BASELINE_PUBLISH !== "1" &&
  process.env.TEST_FULL_DEFERRAL !== "0" &&
  plan !== null &&
  plan.skippingDisabledReason === null;
if (deferralEligible && plan) {
  try {
    const deferralManifest = await selectRelatedSmokeTests(
      selected.map((t) => ({ file: t.file, extraNodeArgs: t.extraNodeArgs, scanPaths: t.scanPaths })),
    );
    if (deferralManifest.mode !== "related") {
      console.log(
        `[deferral] full-lane deferral NOT applied — related selection fell back to full (${
          deferralManifest.fullReason ?? "no reason recorded"
        }); executing the full incremental plan.`,
      );
    } else {
      const relatedSet = new Set(deferralManifest.selected.map((s) => s.file));
      for (const file of relatedSet) {
        if (coreReason(file, DEFAULT_CORE_RULES) === null) directRelatedFiles.add(file);
      }
      // Reason-gated candidates: the shared helper joins each suite's
      // incremental DECISION (mustExecute + executeReasonKind) with the rail
      // facts — planFullLaneDeferral defers only positively-stale green
      // evidence, never no-record/last-failed/uncomputable/run-level.
      const dPlan = planFullLaneDeferral(
        deferralCandidatesFromPlan({
          plan: plan!,
          suites: selected,
          relatedFiles: relatedSet,
          expansionAddedFiles,
          quarantineReAddedFiles,
          coreRules: DEFAULT_CORE_RULES,
        }),
      );
      if (dPlan.deferredFiles.length === 0) {
        console.log("[deferral] no rotation debt — every must-execute suite is diff-related/core/risk-added.");
      } else {
        deferredFiles = dPlan.deferredFiles;
        writeFullLaneDeferralRecord({
          generatedAt: new Date().toISOString(),
          reason:
            "green evidence rotated (fingerprint churn) — full-universe execution debt deferred to the post-merge/nightly lane",
          selectionManifestGeneratedAt: deferralManifest.generatedAt ?? null,
          deferredFiles: dPlan.deferredFiles,
          keptExecuting: dPlan.keptExecuting,
          greenSkipped: dPlan.greenSkipped,
        });
        const k = dPlan.keptExecuting;
        console.log(
          `[deferral] DEFERRED ${dPlan.deferredFiles.length} suite(s) to the post-merge/nightly lane — NOT verified by this run ` +
            `(kept executing: ${k.relatedSelected} related, ${k.core} core, ${k.expansionAdded} expansion, ` +
            `${k.quarantineReAdded} quarantine-override, ${k.smokeOnly} smoke-only, ${k.extraNodeArgs} extraNodeArgs, ` +
            `${k.noRecord} no-record, ${k.lastFailed} last-failed, ${k.notDeferrable} not-deferrable; ` +
            `record: .local/runs/full-lane-deferred.json; kill switch: TEST_FULL_DEFERRAL=0)`,
        );
      }
    }
  } catch (deferralErr) {
    // Fall open: a deferral failure must never shrink the gate silently.
    deferredFiles = [];
    console.warn(
      `[deferral] deferral planning crashed — executing the full incremental plan: ${
        deferralErr instanceof Error ? deferralErr.message : String(deferralErr)
      }`,
    );
  }
}
const deferredSet = new Set(deferredFiles);

// Task #5028: quarantined suites must always execute in non-smoke modes so
// evidence continues to accrue (reinstatement requires ≥10 trailing greens
// across multiple runs). Force-include any that planIncrementalRun
// green-skipped — they don't count toward the skipped total.
// Task #5030: deferred suites are excluded from execution — a THIRD
// disposition (executed / green-skipped / deferred), never recorded green.
const baseToRun = plan
  ? selected.filter((t) => plan!.executeFiles.has(t.file) && !deferredSet.has(t.file))
  : selected;
const quarantinedGreenSkipped =
  sweepMode !== "smoke" && plan && autoQuarantinedFiles.size > 0
    ? selected.filter(
        (t) => autoQuarantinedFiles.has(t.file) && !plan!.executeFiles.has(t.file),
      )
    : [];
if (quarantinedGreenSkipped.length > 0) {
  console.log(
    `[quarantine] force-executing ${quarantinedGreenSkipped.length} quarantined suite(s) that were green-skipped (evidence must accrue for reinstatement)`,
  );
}
const toRun = [...baseToRun, ...quarantinedGreenSkipped];
const skippedGreenFiles = plan
  ? plan.skippedFiles.filter((f) => !quarantinedGreenSkipped.some((t) => t.file === f))
  : [];

if (centralIntegrityDeferred) {
  const coreCount = selected.filter((test) => coreReason(test.file, DEFAULT_CORE_RULES) !== null).length;
  writeFullLaneDeferralRecord({
    generatedAt: new Date().toISOString(),
    reason:
      `selection uncertainty: ${centralIntegrityDeferred.reason} — broad smoke verification deferred ` +
      "to the post-merge/nightly/weekly integrity lane",
    selectionManifestGeneratedAt: centralIntegrityDeferred.selectionManifestGeneratedAt,
    deferredFiles,
    keptExecuting: {
      relatedSelected: directRelatedFiles.size,
      core: coreCount,
      expansionAdded: expansionAddedFiles.size,
      quarantineReAdded: quarantineReAddedFiles.size,
      smokeOnly: 0,
      extraNodeArgs: 0,
      noRecord: 0,
      lastFailed: 0,
      notDeferrable: 0,
    },
    greenSkipped: skippedGreenFiles.length,
  });
  console.log(
    `[deferral] DEFERRED ${deferredFiles.length} broad smoke suite(s) to the post-merge/nightly/weekly integrity lane — ` +
      "NOT verified by this run; direct and core rails remain blocking.",
  );
}

// Owner-approved bounded task-validation policy: prove, in the private sweep
// report, that each selected direct/core rail has a terminal allowed
// disposition. This is accounting only; selection and execution behavior stay
// owned by the existing selector/runner.
const requiredDirectFiles = new Set(
  [
    ...directRelatedFiles,
    ...expansionAddedFiles,
    ...quarantineReAddedFiles,
  ].filter((file) => coreReason(file, DEFAULT_CORE_RULES) === null),
);
const requiredCoreFiles = new Set(
  onlySmoke
    ? selected
      .filter((test) => coreReason(test.file, DEFAULT_CORE_RULES) !== null)
      .map((test) => test.file)
    : [],
);
function buildTaskGateRailProof(required: ReadonlySet<string>) {
  const has = (file: string) => required.has(file);
  return {
    selected: required.size,
    executed: sweepResults.filter((result) => has(result.file)).length,
    skippedGreen: skippedGreenFiles.filter(has).length,
    deferred: deferredFiles.filter(has).length,
  };
}

// Each spawned child re-imports `server/db` and warms a fresh API pool
// (max 18) + worker pool = ~25 connections at production defaults. Kept
// after the hermetic cutover (Task #3839 review): the hermetic cluster is
// also provisioned with max_connections=100, and several batch children
// plus solo children can be alive at once, so uncapped children could
// still exhaust it. Tiny pools suffice — a child runs one
// fixture at a time.
const CHILD_POOL_ENV = {
  DB_API_POOL_MIN: "1",
  DB_API_POOL_MAX: "3",
  DB_WORKER_POOL_MIN: "0",
  DB_WORKER_POOL_MAX: "2",
};

// ---------------------------------------------------------------------------
// Task #3809 — batched suite execution.
//
// Task #3789's instrumentation showed ~4s of pure process startup (npx + tsx
// boot + import graph) paid PER suite, roughly doubling full-sweep wall time
// versus summed suite time. Suites that need no per-process node args are
// now fed sequentially through a persistent batch child per "group" (same
// extraEnv + tsconfig class — see tests/run-all-worker.mjs), so tsx boot and
// the warm import graph are paid once per group instead of once per suite.
//
// Isolation guarantees preserved:
//   - suites still run strictly one at a time (shared dev DB contention);
//   - a failing/crashing/timing-out suite only ever costs itself: the parent
//     records its result, kills the batch child, and lazily respawns a fresh
//     one for the group's remaining suites;
//   - per-suite timeoutMs semantics are unchanged (parent-side timer +
//     process-group SIGTERM→SIGKILL, same as the solo path);
//   - retries always run through the original solo `npx tsx` path for
//     maximum isolation;
//   - suites with extraNodeArgs (loader shims, --import hooks) always use
//     the solo path — those flags only work at process start.
// ---------------------------------------------------------------------------
const BATCH_WORKER_PATH = resolve(process.cwd(), "tests/run-all-worker.mjs");
// Recycle a batch child after this many suites to bound accumulation of
// leaked handles/globals from otherwise-passing suites.
const BATCH_WORKER_MAX_SUITES = 30;

interface BatchExecutionMetrics {
  batchCompatibleFirstAttempts: number;
  batchIncompatibleFirstAttempts: number;
  batchedFirstAttempts: number;
  soloFirstAttempts: number;
  soloFirstAttemptElapsedMs: number;
  batchedFailureSoloRechecks: number;
  batchWorkerStarts: number;
  batchWorkerReuses: number;
  batchWorkerSuiteRuns: number;
  batchWorkerPeakRssKb: number;
  batchWorkerRecyclesHardCap: number;
  batchWorkerRecyclesResourcePressure: number;
  batchWorkerRecyclesFailure: number;
  batchWorkerRecyclesStraggler: number;
}

function createBatchExecutionMetrics(): BatchExecutionMetrics {
  return {
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
  };
}

function mergeBatchExecutionMetrics(
  metrics: readonly BatchExecutionMetrics[],
): BatchExecutionMetrics {
  return metrics.reduce(
    (total, current) => ({
      batchCompatibleFirstAttempts:
        total.batchCompatibleFirstAttempts + current.batchCompatibleFirstAttempts,
      batchIncompatibleFirstAttempts:
        total.batchIncompatibleFirstAttempts + current.batchIncompatibleFirstAttempts,
      batchedFirstAttempts: total.batchedFirstAttempts + current.batchedFirstAttempts,
      soloFirstAttempts: total.soloFirstAttempts + current.soloFirstAttempts,
      soloFirstAttemptElapsedMs:
        total.soloFirstAttemptElapsedMs + current.soloFirstAttemptElapsedMs,
      batchedFailureSoloRechecks:
        total.batchedFailureSoloRechecks + current.batchedFailureSoloRechecks,
      batchWorkerStarts: total.batchWorkerStarts + current.batchWorkerStarts,
      batchWorkerReuses: total.batchWorkerReuses + current.batchWorkerReuses,
      batchWorkerSuiteRuns: total.batchWorkerSuiteRuns + current.batchWorkerSuiteRuns,
      batchWorkerPeakRssKb: Math.max(total.batchWorkerPeakRssKb, current.batchWorkerPeakRssKb),
      batchWorkerRecyclesHardCap:
        total.batchWorkerRecyclesHardCap + current.batchWorkerRecyclesHardCap,
      batchWorkerRecyclesResourcePressure:
        total.batchWorkerRecyclesResourcePressure + current.batchWorkerRecyclesResourcePressure,
      batchWorkerRecyclesFailure:
        total.batchWorkerRecyclesFailure + current.batchWorkerRecyclesFailure,
      batchWorkerRecyclesStraggler:
        total.batchWorkerRecyclesStraggler + current.batchWorkerRecyclesStraggler,
    }),
    createBatchExecutionMetrics(),
  );
}

interface BatchWorker {
  child: ChildProcess;
  ran: number;
  seq: number;
}

/**
 * Suites batch only when their process-start contract is already owned by the
 * worker. Loader/import hooks retain their exact solo process; redundant
 * runner-provided environment declarations normalize to one compatibility key.
 */
function batchKey(t: TestDef): string | null {
  const compatibility = batchCompatibilityForSuite(t);
  return compatibility.batchable ? compatibility.key : null;
}

function recordBatchCompatibility(metrics: BatchExecutionMetrics, t: TestDef): void {
  if (batchCompatibilityForSuite(t).batchable) {
    metrics.batchCompatibleFirstAttempts++;
  } else {
    metrics.batchIncompatibleFirstAttempts++;
  }
}

function recordBatchRecycle(metrics: BatchExecutionMetrics, cause: BatchRecycleCause | "failure" | "straggler"): void {
  if (cause === "hard-cap") metrics.batchWorkerRecyclesHardCap++;
  else if (cause === "resource-pressure") metrics.batchWorkerRecyclesResourcePressure++;
  else if (cause === "failure") metrics.batchWorkerRecyclesFailure++;
  else metrics.batchWorkerRecyclesStraggler++;
}

const batchWorkers = new Map<string, BatchWorker>();
const serialBatchMetrics = createBatchExecutionMetrics();

function killBatchWorker(w: BatchWorker): void {
  try {
    if (w.child.pid) process.kill(-w.child.pid, "SIGKILL");
  } catch {}
}

function killAllBatchWorkers(): void {
  for (const w of batchWorkers.values()) killBatchWorker(w);
  batchWorkers.clear();
}
process.on("exit", killAllBatchWorkers);

function spawnBatchWorker(t: TestDef): BatchWorker {
  serialBatchMetrics.batchWorkerStarts++;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    RUN_INTEGRATION_TESTS: "1",
    // Tells server/db (and any future process-lifetime teardown) that this
    // process hosts many suites: pool closure must no-op (see server/db.ts).
    RUN_ALL_BATCH_WORKER: "1",
    ...CHILD_POOL_ENV,
    ...(t.extraEnv ?? {}),
  };
  // Mirror the solo path's `--tsconfig ./tsconfig.tests.json` for .tsx
  // suites; tsx's register() honors TSX_TSCONFIG_PATH.
  if (t.file.endsWith(".tsx") && !env.TSX_TSCONFIG_PATH) {
    env.TSX_TSCONFIG_PATH = "./tsconfig.tests.json";
  }
  const child = spawn(process.execPath, [BATCH_WORKER_PATH], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    // Own process group so timeout kills take down anything a suite spawned.
    detached: true,
    env,
  });
  return { child, ran: 0, seq: 0 };
}

// Suites that never call process.exit finish when their top-level import
// settles; suites that do call it must be awaited until the (possibly
// async) exit call — the worker needs to know which contract applies.
const completeOnImportCache = new Map<string, boolean>();
function completesOnImport(t: TestDef): boolean {
  let v = completeOnImportCache.get(t.file);
  if (v === undefined) {
    try {
      v = !readFileSync(resolve(process.cwd(), t.file), "utf8").includes("process.exit");
    } catch {
      v = false;
    }
    completeOnImportCache.set(t.file, v);
  }
  return v;
}

// ─── Task #5029: Sharded lane runner ─────────────────────────────────────
//
// createShardLaneRunner() creates an isolated worker pool (its own Map,
// env overlay, and piped-stdio batch workers) for one parallel shard lane.
// runLane() runs a subset of suites through that runner serially — preserving
// all pre-5029 guarantees (batch-failure solo re-verify, straggler re-dispatch,
// worker recycling, per-suite timeout) — and returns SweepTestResult[].
//
// Output (stdout/stderr) is CAPTURED (piped) per suite and printed atomically
// when the suite completes, preventing interleaving from concurrent lanes.
// The buffer is capped at 8 MB per batch-worker process (4 MB tail when
// exceeded) — tests generating more than 8 MB of output are pathological.
// ---------------------------------------------------------------------------

interface ShardedBatchWorker {
  child: ChildProcess;
  ran: number;
  seq: number;
  /** Rolling output buffer shared across suites in this worker process. */
  outputBuffer: Buffer;
}

interface ShardedRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  resourcePressure?: boolean;
  /** Buffered stdout+stderr for this suite (atomic print after completion). */
  output: Buffer;
}

const OUTPUT_BUFFER_CAP = 8 * 1024 * 1024; // 8 MB per worker process
const OUTPUT_BUFFER_TAIL = 4 * 1024 * 1024; // keep last 4 MB when capped

function createShardLaneRunner(laneEnv: NodeJS.ProcessEnv) {
  const laneWorkers = new Map<string, ShardedBatchWorker>();
  const batchMetrics = createBatchExecutionMetrics();

  function killWorker(w: ShardedBatchWorker): void {
    try {
      if (w.child.pid) process.kill(-w.child.pid, "SIGKILL");
    } catch {}
  }

  function killAll(): void {
    for (const w of laneWorkers.values()) killWorker(w);
    laneWorkers.clear();
  }

  function spawnWorker(t: TestDef): ShardedBatchWorker {
    batchMetrics.batchWorkerStarts++;
    const env: NodeJS.ProcessEnv = {
      ...laneEnv,
      NODE_ENV: "test",
      RUN_INTEGRATION_TESTS: "1",
      RUN_ALL_BATCH_WORKER: "1",
      ...CHILD_POOL_ENV,
      ...(t.extraEnv ?? {}),
    };
    if (t.file.endsWith(".tsx") && !env.TSX_TSCONFIG_PATH) {
      env.TSX_TSCONFIG_PATH = "./tsconfig.tests.json";
    }
    const child = spawn(process.execPath, [BATCH_WORKER_PATH], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
      env,
    });
    const worker: ShardedBatchWorker = { child, ran: 0, seq: 0, outputBuffer: Buffer.alloc(0) };
    const appendOutput = (d: Buffer) => {
      const combined = Buffer.concat([worker.outputBuffer, d]);
      worker.outputBuffer =
        combined.length > OUTPUT_BUFFER_CAP
          ? combined.slice(combined.length - OUTPUT_BUFFER_TAIL)
          : combined;
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    return worker;
  }

  function runOneBatched(
    t: TestDef,
    key: string,
    perTestTimeoutMs: number,
    allowStragglerRetry = true,
  ): Promise<ShardedRunResult> {
    let w = laneWorkers.get(key);
    const recycleCause = w ? recycleBeforeDispatch(w.ran, BATCH_WORKER_MAX_SUITES) : null;
    if (!w || recycleCause || !w.child.connected) {
      if (w) { killWorker(w); laneWorkers.delete(key); }
      if (recycleCause) recordBatchRecycle(batchMetrics, recycleCause);
      w = spawnWorker(t);
      laneWorkers.set(key, w);
    } else {
      batchMetrics.batchWorkerReuses++;
    }
    const worker = w;
    worker.ran++;
    batchMetrics.batchWorkerSuiteRuns++;
    const seq = ++worker.seq;
    const startedAt = Date.now();
    // Mark the output position before dispatching — everything from here to
    // the "result" message belongs to this suite (worker is strictly serial).
    const outputStartMark = worker.outputBuffer.length;

    return new Promise((resolveP) => {
      let settled = false;
      let timedOut = false;

      const finish = (
        r: { status: number | null; signal: NodeJS.Signals | null },
        recycle: BatchRecycleCause | "failure" | null,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.child.off("message", onMessage);
        worker.child.off("exit", onExit);
        worker.child.off("error", onError);
        if (recycle && laneWorkers.get(key) === worker) {
          recordBatchRecycle(batchMetrics, recycle);
          killWorker(worker);
          laneWorkers.delete(key);
        }
        const output = worker.outputBuffer.slice(outputStartMark);
        resolveP({ ...r, elapsedMs: Date.now() - startedAt, output });
      };

      const onMessage = (msg: any) => {
        if (!msg) return;
        if (msg.type === "predecessor-straggler" && msg.seq === seq) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          worker.child.off("message", onMessage);
          worker.child.off("exit", onExit);
          worker.child.off("error", onError);
          if (laneWorkers.get(key) === worker) {
            recordBatchRecycle(batchMetrics, "straggler");
            killWorker(worker);
            laneWorkers.delete(key);
          }
          if (allowStragglerRetry) {
            resolveP(runOneBatched(t, key, perTestTimeoutMs, false));
          } else {
            const output = worker.outputBuffer.slice(outputStartMark);
            resolveP({ status: 1, signal: null, elapsedMs: Date.now() - startedAt, output });
          }
          return;
        }
        if (msg.type !== "result" || msg.seq !== seq) return;
        const code = typeof msg.code === "number" ? msg.code : 1;
        if (typeof msg.rssBytes === "number" && Number.isFinite(msg.rssBytes)) {
          batchMetrics.batchWorkerPeakRssKb = Math.max(
            batchMetrics.batchWorkerPeakRssKb,
            Math.max(0, Math.round(msg.rssBytes / 1024)),
          );
        }
        finish(
          { status: code, signal: null },
          code !== 0 || msg.recycle === true
            ? "failure"
            : recycleAfterResult(msg.resourcePressure === true),
        );
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (laneWorkers.get(key) === worker) {
          laneWorkers.delete(key);
          if (timedOut || code !== 0 || signal !== null) recordBatchRecycle(batchMetrics, "failure");
        }
        finish(
          { status: code ?? -1, signal: timedOut ? (signal ?? "SIGKILL") : signal },
          null,
        );
      };
      const onError = () => finish({ status: -1, signal: null }, "failure");

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (worker.child.pid) process.kill(-worker.child.pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            if (worker.child.pid) process.kill(-worker.child.pid, "SIGKILL");
          } catch {}
        }, 5_000).unref();
      }, perTestTimeoutMs);

      worker.child.on("message", onMessage);
      worker.child.on("exit", onExit);
      worker.child.on("error", onError);
      try {
        worker.child.send({
          type: "run",
          file: resolve(process.cwd(), t.file),
          seq,
          completeOnImport: completesOnImport(t),
        });
      } catch {
        onError();
      }
    });
  }

  function runOneBuffered(t: TestDef, perTestTimeoutMs: number): Promise<ShardedRunResult> {
    return new Promise((resolveOut) => {
      const extra = t.extraNodeArgs ?? [];
      const args = t.extraEnv?.TSX_TSCONFIG_PATH
        ? ["tsx", ...extra, t.file]
        : t.file.endsWith(".tsx")
          ? ["tsx", ...extra, "--tsconfig", "./tsconfig.tests.json", t.file]
          : ["tsx", ...extra, t.file];
      const startedAt = Date.now();
      const childEnv: NodeJS.ProcessEnv = {
        ...laneEnv,
        NODE_ENV: "test",
        RUN_INTEGRATION_TESTS: "1",
        ...CHILD_POOL_ENV,
        ...(t.extraEnv ?? {}),
      };
      const child = spawn("npx", args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: childEnv,
      });
      let outputBuf = Buffer.alloc(0);
      const appendOut = (d: Buffer) => {
        outputBuf = Buffer.concat([outputBuf, d]);
      };
      child.stdout?.on("data", appendOut);
      child.stderr?.on("data", appendOut);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 5_000).unref();
      }, perTestTimeoutMs);

      child.on("exit", (status, signal) => {
        clearTimeout(timer);
        resolveOut({
          status,
          signal: timedOut ? (signal ?? "SIGKILL") : signal,
          elapsedMs: Date.now() - startedAt,
          output: outputBuf,
        });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolveOut({ status: -1, signal: null, elapsedMs: Date.now() - startedAt, output: outputBuf });
      });
    });
  }

  return { runOneBatched, runOneBuffered, killAll, batchMetrics };
}

/**
 * Run one shard lane serially. Each suite dispatches through the lane's own
 * worker pool (batch-failure solo re-verify and straggler re-dispatch are
 * preserved). Output is buffered per suite and printed atomically.
 */
interface LaneWorkSource {
  /** Static lane membership used only for static lane-local batch eligibility. */
  candidates: readonly TestDef[];
  /** Atomically claim one suite that has not yet started in any lane. */
  claimNext(): TestDef | undefined;
  /**
   * Pull lanes have no fixed membership, so they run first attempts solo.
   * This prevents globally compatible suites that land in separate lanes from
   * creating singleton persistent batch workers and changing the resource cap.
   */
  allowsBatching: boolean;
}

function laneWorkSource(lane: readonly TestDef[]): LaneWorkSource {
  let nextIndex = 0;
  return {
    candidates: lane,
    allowsBatching: true,
    claimNext: () => {
      const suite = lane[nextIndex];
      if (!suite) return undefined;
      nextIndex += 1;
      return suite;
    },
  };
}

async function runLane(
  workSource: LaneWorkSource,
  laneIdx: number,
  laneEnv: NodeJS.ProcessEnv,
  retryCount: number,
  defaultTimeoutMs: number,
): Promise<SweepTestResult[]> {
  const runner = createShardLaneRunner(laneEnv);
  const laneResults: SweepTestResult[] = [];

  // Per-lane batch group counts: only suites in the SAME lane share workers.
  const laneGroupCounts = new Map<string, number>();
  for (const t of workSource.candidates) {
    const k = batchKey(t);
    if (k) laneGroupCounts.set(k, (laneGroupCounts.get(k) ?? 0) + 1);
  }

  try {
    for (let t = workSource.claimNext(); t; t = workSource.claimNext()) {
      const effectiveTimeoutMs = t.timeoutMs ?? defaultTimeoutMs;
      const maxAttempts = 1 + retryCount;
      let attempts = 0;
      let elapsedMs = 0;
      let passed = false;
      let failureReason = "";

      while (attempts < maxAttempts) {
        attempts++;
        const key = attempts === 1 && workSource.allowsBatching ? batchKey(t) : null;
        const useBatch = Boolean(key && (laneGroupCounts.get(key) ?? 0) >= 2);
        if (attempts === 1) {
          recordBatchCompatibility(runner.batchMetrics, t);
          if (useBatch) runner.batchMetrics.batchedFirstAttempts++;
          else runner.batchMetrics.soloFirstAttempts++;
        }

        let result: ShardedRunResult;
        if (useBatch) {
          result = await runner.runOneBatched(t, key!, effectiveTimeoutMs);
        } else {
          result = await runner.runOneBuffered(t, effectiveTimeoutMs);
        }

        if (useBatch && (result.signal || result.status !== 0)) {
          runner.batchMetrics.batchedFailureSoloRechecks++;
          // Batched failure may be cross-suite pollution — re-verify in solo.
          process.stdout.write(result.output);
          const solo = await runner.runOneBuffered(t, effectiveTimeoutMs);
          result = { ...solo, elapsedMs: result.elapsedMs + solo.elapsedMs };
        }
        if (attempts === 1 && !useBatch) {
          runner.batchMetrics.soloFirstAttemptElapsedMs += result.elapsedMs;
        }

        elapsedMs += result.elapsedMs;
        const elapsedSec = Math.round(result.elapsedMs / 1000);

        // Print header + buffered output + verdict atomically.
        process.stdout.write(`\n>>> Running: ${t.name} (${t.file}) [shard-${laneIdx}]\n`);
        process.stdout.write(result.output);

        if (result.signal) {
          const overrideHint = t.timeoutMs
            ? `raise this fixture's timeoutMs override (currently ${Math.round(t.timeoutMs / 1000)}s)`
            : `raise TEST_FILE_TIMEOUT_MS (currently ${Math.round(effectiveTimeoutMs / 1000)}s) or add a per-test timeoutMs`;
          process.stderr.write(
            `<<< FAILED: ${t.name} (timed out after ${elapsedSec}s, killed by ${result.signal} — suite continues. To allow more time, ${overrideHint}.)\n`,
          );
          failureReason = `hang ${elapsedSec}s`;
        } else if (result.status !== 0) {
          process.stderr.write(`<<< FAILED: ${t.name} (exit ${result.status} after ${elapsedSec}s)\n`);
          failureReason = `exit ${result.status}`;
        } else {
          process.stdout.write(
            `<<< PASSED: ${t.name} (${elapsedSec}s${attempts > 1 ? `, attempt ${attempts}` : ""})\n`,
          );
          passed = true;
          failureReason = "";
          break;
        }

        if (attempts < maxAttempts) {
          process.stdout.write(`  ... retrying ${t.name} (attempt ${attempts + 1} of ${maxAttempts})\n`);
        }
      }

      laneResults.push({
        name: t.name,
        file: t.file,
        outcome: passed ? "passed" : "failed",
        quarantined:
          sweepMode !== "smoke" &&
          (isQuarantinedTestFile(t.file) || isAutoQuarantined(t.file, autoQuarantineLedger)),
        attempts,
        elapsedMs,
        ...(passed ? {} : { failureReason }),
      });
      // Task #5306: same per-suite persistence as the serial path (see the
      // comment there) — lanes run concurrently but recordRunOutcomes is
      // synchronous end-to-end, so calls from different lanes in this same
      // process cannot interleave mid-write; the final end-of-sweep calls
      // (incomplete-shard invalidation or the full write) still run after
      // every lane settles and remain the closing safety net.
      if (plan) {
        recordRunOutcomes({
          storePath: plan.storePath,
          mode: sweepMode,
          fingerprints: plan.fingerprints,
          outcomes: [{ file: t.file, passed, flaky: passed && attempts > 1, durationMs: elapsedMs }],
          fullRunGreen: false,
        });
      }
    }
  } finally {
    runner.killAll();
  }

  return { results: laneResults, batchMetrics: runner.batchMetrics };
}
// ─── end Task #5029 sharded lane runner ──────────────────────────────────

function runOneBatched(
  t: TestDef,
  key: string,
  perTestTimeoutMs: number,
  // Task #4672: a worker that reports "predecessor-straggler" for this seq
  // proved the failure belongs to the PREVIOUS suite (the dispatch was still
  // held in the worker's quiet window). Re-dispatch this innocent suite once
  // in a fresh child instead of recording a failure; a fresh child has no
  // predecessor, so one retry suffices.
  allowStragglerRetry = true,
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  resourcePressure?: boolean;
}> {
  let w = batchWorkers.get(key);
  const recycleCause = w ? recycleBeforeDispatch(w.ran, BATCH_WORKER_MAX_SUITES) : null;
  if (!w || recycleCause || !w.child.connected) {
    if (w) {
      killBatchWorker(w);
      batchWorkers.delete(key);
    }
    if (recycleCause) recordBatchRecycle(serialBatchMetrics, recycleCause);
    w = spawnBatchWorker(t);
    batchWorkers.set(key, w);
  } else {
    serialBatchMetrics.batchWorkerReuses++;
  }
  const worker = w;
  worker.ran++;
  serialBatchMetrics.batchWorkerSuiteRuns++;
  const seq = ++worker.seq;
  const startedAt = Date.now();
  return new Promise((resolveP) => {
    let settled = false;
    let timedOut = false;
    const finish = (
      r: { status: number | null; signal: NodeJS.Signals | null },
      recycle: BatchRecycleCause | "failure" | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.child.off("message", onMessage);
      worker.child.off("exit", onExit);
      worker.child.off("error", onError);
      if (recycle && batchWorkers.get(key) === worker) {
        recordBatchRecycle(serialBatchMetrics, recycle);
        killBatchWorker(worker);
        batchWorkers.delete(key);
      }
      resolveP({ ...r, elapsedMs: Date.now() - startedAt });
    };
    const onMessage = (msg: any) => {
      if (!msg) return;
      if (msg.type === "predecessor-straggler" && msg.seq === seq) {
        // Task #4672: the previous suite's post-settle crash fired while this
        // suite's dispatch was still held — this suite never started. Discard
        // the poisoned child and re-run in a fresh one without recording a
        // batched failure for the innocent suite.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.child.off("message", onMessage);
        worker.child.off("exit", onExit);
        worker.child.off("error", onError);
        if (batchWorkers.get(key) === worker) {
          recordBatchRecycle(serialBatchMetrics, "straggler");
          killBatchWorker(worker);
          batchWorkers.delete(key);
        }
        if (allowStragglerRetry) {
          console.log(
            `  ↻ ${t.file}: predecessor suite's post-settle straggler crash — re-dispatching in a fresh batch child (not counted against this suite).`,
          );
          resolveP(runOneBatched(t, key, perTestTimeoutMs, false));
        } else {
          resolveP({ status: 1, signal: null, elapsedMs: Date.now() - startedAt });
        }
        return;
      }
      if (msg.type !== "result" || msg.seq !== seq) return;
      const code = typeof msg.code === "number" ? msg.code : 1;
      if (typeof msg.rssBytes === "number" && Number.isFinite(msg.rssBytes)) {
        serialBatchMetrics.batchWorkerPeakRssKb = Math.max(
          serialBatchMetrics.batchWorkerPeakRssKb,
          Math.max(0, Math.round(msg.rssBytes / 1024)),
        );
      }
      // Any failure discards the whole child: its state is suspect and a
      // polluted process must never host a sibling suite.
      finish(
        { status: code, signal: null },
        code !== 0 || msg.recycle === true
          ? "failure"
          : recycleAfterResult(msg.resourcePressure === true),
      );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (batchWorkers.get(key) === worker) {
        batchWorkers.delete(key);
        if (timedOut || code !== 0 || signal !== null) recordBatchRecycle(serialBatchMetrics, "failure");
      }
      finish(
        { status: code ?? -1, signal: timedOut ? (signal ?? "SIGKILL") : signal },
        null,
      );
    };
    const onError = () => finish({ status: -1, signal: null }, "failure");
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (worker.child.pid) process.kill(-worker.child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (worker.child.pid) process.kill(-worker.child.pid, "SIGKILL");
        } catch {}
      }, 5_000).unref();
    }, perTestTimeoutMs);
    worker.child.on("message", onMessage);
    worker.child.on("exit", onExit);
    worker.child.on("error", onError);
    try {
      worker.child.send({
        type: "run",
        file: resolve(process.cwd(), t.file),
        seq,
        completeOnImport: completesOnImport(t),
      });
    } catch {
      onError();
    }
  });
}

function runOne(t: TestDef, perTestTimeoutMs: number): Promise<{ status: number | null; signal: NodeJS.Signals | null; elapsedMs: number }> {
  return new Promise((resolve) => {
    const extra = t.extraNodeArgs ?? [];
    const args = t.extraEnv?.TSX_TSCONFIG_PATH
      ? ["tsx", ...extra, t.file]
      : t.file.endsWith(".tsx")
        ? ["tsx", ...extra, "--tsconfig", "./tsconfig.tests.json", t.file]
        : ["tsx", ...extra, t.file];
    const startedAt = Date.now();
    // DB env: hermetic by default (process.env already points at the
    // per-run DB after provisioning).
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      RUN_INTEGRATION_TESTS: "1",
      ...CHILD_POOL_ENV,
      ...(t.extraEnv ?? {}),
    };
    const child = spawn("npx", args, {
      stdio: "inherit",
      // Detach into a new process group so we can SIGKILL the entire
      // tree (npx → tsx → node) on timeout. Without this, killing only
      // `npx` leaves `tsx`/`node` running and spawnSync/spawn never
      // notices the hang.
      detached: true,
      env: childEnv,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Negative PID = "send signal to the whole process group".
        // First SIGTERM for graceful shutdown, then SIGKILL after 5 s.
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5_000).unref();
    }, perTestTimeoutMs);

    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal: timedOut ? (signal ?? "SIGKILL") : signal,
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ status: -1, signal: null, elapsedMs: Date.now() - startedAt });
    });
  });
}

// The initial resolution provisions safely before incremental planning. Resolve
// again against the executable population so green-skipped suites cannot leave
// idle lanes alive. A shard-DB provisioning failure remains a visible forced
// serial reason.
shardConcurrency = resolveCurrentShardConcurrency(toRun.length);
shardConcurrency = boundShardConcurrencyToProvisionedDatabases(
  shardConcurrency,
  shardDbUrls.length,
);
effectiveShardCount = shardRuntimeCapReasons.size > 0 ? 1 : shardConcurrency.effectiveShardCount;
const shardPolicyReasons = [...new Set([...shardConcurrency.capReasons, ...shardRuntimeCapReasons])];
console.log(
  `[shards] policy: requested=${requestedShards} (${shardCountSource}), effective=${effectiveShardCount}; ` +
    `caps cpu=${shardConcurrency.caps.cpu}, memory=${shardConcurrency.caps.memory}, ` +
    `database=${shardConcurrency.caps.database}, workers=${shardConcurrency.caps.workerProcesses}, ` +
    `selected=${shardConcurrency.caps.selectedSuites}, hermetic=${shardConcurrency.caps.hermetic}; ` +
    `reasons=${shardPolicyReasons.length > 0 ? shardPolicyReasons.join(",") : "none"}; ` +
    `provisioned-shard-dbs=${shardDbUrls.length}; ` +
    `child-db-slots=${CHILD_POOL_ENV.DB_API_POOL_MAX}+${CHILD_POOL_ENV.DB_WORKER_POOL_MAX}/lane.`,
);

let sweepResults: SweepTestResult[] = [];
const sweepStartedAt = new Date().toISOString();
const sweepStartedMs = Date.now();
const defaultPerTestTimeoutMs = Number(process.env.TEST_FILE_TIMEOUT_MS) || 180_000;
let shardObservability:
  | {
      shardCount: number;
      requestedShardCount: number;
      shardCountSource: ShardCountSource;
      shardCapReasons: ShardCapReason[];
      dispatchMode: "static-lpt" | "bounded-pull";
      estimateCoverage: { known: number; unknown: number; total: number };
      planned: ReturnType<typeof summarizeLaneLoads>;
      actual: Array<{ suiteCount: number; elapsedMs: number }>;
    }
  | null = null;
let incompleteShardResults: {
  missingFiles: string[];
  duplicateFiles: string[];
  unexpectedFiles: string[];
  laneCrashes: Array<{ lane: number; reason: string }>;
} | null = null;
let completedBatchMetrics = createBatchExecutionMetrics();

if (effectiveShardCount <= 1) {
  // ─── Serial path ─────────────────────────────────────────────────────────
  // Unchanged from pre-5029: one suite at a time, stdio inherited (live
  // streaming to the terminal), single global batchWorkers map.
  // A batch child only pays off (and only spawns) for groups with 2+ suites
  // in THIS run; singleton groups keep the solo path.
  const batchGroupCounts = new Map<string, number>();
  for (const t of toRun) {
    const k = batchKey(t);
    if (k) batchGroupCounts.set(k, (batchGroupCounts.get(k) ?? 0) + 1);
  }
  for (const t of toRun) {
    console.log(`\n>>> Running: ${t.name} (${t.file})`);
    const effectiveTimeoutMs = t.timeoutMs ?? defaultPerTestTimeoutMs;
    const maxAttempts = 1 + retryFailed;
    let attempts = 0;
    let elapsedMs = 0;
    let passed = false;
    let failureReason = "";
    while (attempts < maxAttempts) {
      attempts++;
      // First attempt may run batched; retries always use the fully isolated
      // solo spawn (identical to the pre-#3809 command).
      const key = attempts === 1 ? batchKey(t) : null;
      const useBatch = Boolean(key && (batchGroupCounts.get(key) ?? 0) >= 2);
      if (attempts === 1) {
        recordBatchCompatibility(serialBatchMetrics, t);
        if (useBatch) serialBatchMetrics.batchedFirstAttempts++;
        else serialBatchMetrics.soloFirstAttempts++;
      }
      let result = useBatch
        ? await runOneBatched(t, key!, effectiveTimeoutMs)
        : await runOne(t, effectiveTimeoutMs);
      if (useBatch && (result.signal || result.status !== 0)) {
        serialBatchMetrics.batchedFailureSoloRechecks++;
        // The batch fast path shares a warm process, so a failure there can
        // be cross-suite module-state pollution rather than a real bug.
        // Solo behavior (the pre-#3809 command) is authoritative: re-verify
        // in an isolated process before counting this attempt as failed.
        console.log(
          `  ... batched run failed for ${t.name}; re-verifying in an isolated process`,
        );
        const solo = await runOne(t, effectiveTimeoutMs);
        result = { ...solo, elapsedMs: result.elapsedMs + solo.elapsedMs };
      }
      if (attempts === 1 && !useBatch) {
        serialBatchMetrics.soloFirstAttemptElapsedMs += result.elapsedMs;
      }
      elapsedMs += result.elapsedMs;
      const elapsedSec = Math.round(result.elapsedMs / 1000);
      if (result.signal) {
        const overrideHint = t.timeoutMs
          ? `raise this fixture's timeoutMs override (currently ${Math.round(t.timeoutMs / 1000)}s)`
          : `raise TEST_FILE_TIMEOUT_MS (currently ${Math.round(effectiveTimeoutMs / 1000)}s) or add a per-test timeoutMs`;
        console.error(`<<< FAILED: ${t.name} (timed out after ${elapsedSec}s, killed by ${result.signal} — suite continues. To allow more time, ${overrideHint}.)`);
        failureReason = `hang ${elapsedSec}s`;
      } else if (result.status !== 0) {
        console.error(`<<< FAILED: ${t.name} (exit ${result.status} after ${elapsedSec}s)`);
        failureReason = `exit ${result.status}`;
      } else {
        console.log(`<<< PASSED: ${t.name} (${elapsedSec}s${attempts > 1 ? `, attempt ${attempts}` : ""})`);
        passed = true;
        failureReason = "";
        break;
      }
      if (attempts < maxAttempts) {
        console.log(`  ... retrying ${t.name} (attempt ${attempts + 1} of ${maxAttempts})`);
      }
    }
    sweepResults.push({
      name: t.name,
      file: t.file,
      outcome: passed ? "passed" : "failed",
      // Task #3797: quarantine (reason + expiry, see QUARANTINE_LEDGER in
      // server/services/regressionSweep.ts) applies in every mode EXCEPT
      // smoke — the gate stays strict so its failures are always loud.
      // Task #5028: also mark as non-blocking (quarantined) when the suite is
      // in the auto-quarantine evidence ledger. isQuarantinedTestFile handles
      // the manual QUARANTINE_LEDGER in regressionSweep.ts; autoQuarantineLedger
      // is the new evidence-gated automatic path.
      quarantined:
        sweepMode !== "smoke" &&
        (isQuarantinedTestFile(t.file) || isAutoQuarantined(t.file, autoQuarantineLedger)),
      attempts,
      elapsedMs,
      ...(passed ? {} : { failureReason }),
    });
    // Task #5306: persist this suite's outcome the moment it is known, not
    // only after the whole sweep loop finishes — a kill mid-sweep must leave
    // every already-finished, already-passed suite recorded. Reuses the same
    // atomic read-merge-write recordRunOutcomes already uses at end-of-sweep;
    // fullRunGreen is a whole-sweep concern and is stamped only there. The
    // end-of-sweep calls below (incomplete-shard invalidation, or the final
    // full write) still run unconditionally afterward and remain the closing
    // safety net — an incomplete/untrustworthy run still overwrites every
    // per-suite green this loop wrote.
    if (plan) {
      recordRunOutcomes({
        storePath: plan.storePath,
        mode: sweepMode,
        fingerprints: plan.fingerprints,
        outcomes: [{ file: t.file, passed, flaky: passed && attempts > 1, durationMs: elapsedMs }],
        fullRunGreen: false,
      });
    }
  }
  // Batch children are no longer needed; kill them so the run can drain.
  killAllBatchWorkers();
  completedBatchMetrics = serialBatchMetrics;

} else {
  // ─── Sharded path (Task #5029) ───────────────────────────────────────────
  // Distribute toRun across N lanes, each with its own hermetic shard DB.
  // Lanes run concurrently (Promise.all); within each lane suites are serial,
  // preserving all batching/solo-re-verify/straggler semantics.
  // Output is buffered per-suite and printed atomically (no interleaving).

  // Load durable per-suite duration measurements for LPT lane balancing.
  // A run's duration report is intentionally partial for --file, incremental,
  // and deferred runs. The flake-history journal retains measurements for
  // suites absent from that report, so a partial run cannot erase the useful
  // full-population estimate set.
  const SHARD_DURATION_REPORT_PATH = ".local/runs/suite-durations.json";
  const retainedHistory: Array<{ file: string; elapsedMs: number }> = [];
  const latestReport: Array<{ file: string; elapsedMs: number }> = [];
  try {
    const history = loadSuiteHistory();
    for (const [file, records] of Object.entries(history.suites)) {
      const latest = records[records.length - 1];
      if (latest) retainedHistory.push({ file, elapsedMs: latest.ms });
    }
  } catch {
    // History is best-effort; unknown suites still use the balanced fallback.
  }
  try {
    const durRaw = readFileSync(resolve(SHARD_DURATION_REPORT_PATH), "utf8");
    const durObj = JSON.parse(durRaw) as { suites?: Array<{ file: string; elapsedMs: number }> };
    if (Array.isArray(durObj.suites)) {
      for (const s of durObj.suites) {
        if (typeof s.file === "string" && typeof s.elapsedMs === "number") {
          latestReport.push({ file: s.file, elapsedMs: s.elapsedMs });
        }
      }
    }
  } catch {
    // First run or stale/missing report — history and the balanced fallback
    // remain sufficient to schedule every suite.
  }

  const priorDurations = buildDurationEstimateMap(retainedHistory, latestReport);
  const toRunWithEstimates = toRun.map((t) => ({
    ...t,
    estimatedMs: priorDurations.get(t.file) ?? 0,
  }));
  // Keep the static LPT plan even during a pull run: it is the stable
  // same-input reference for observability and benchmark comparison. Pull
  // dispatch consumes the same suite population but does not pre-own lanes.
  const staticLanes = distributeSuites(toRunWithEstimates, effectiveShardCount);
  const unknownEstimateMs = deriveUnknownEstimateMs(toRunWithEstimates);
  const plannedLaneLoads = summarizeLaneLoads(staticLanes, unknownEstimateMs);
  const knownEstimateCount = toRunWithEstimates.filter((t) => (t.estimatedMs ?? 0) > 0).length;
  const laneSummary = plannedLaneLoads
    .map((summary, i) => `shard-${i}:${summary.suiteCount}/${Math.round(summary.plannedLoadMs)}ms`)
    .join(" ");
  const dispatchMode: "static-lpt" | "bounded-pull" = dynamicShardDispatchRequested
    ? "bounded-pull"
    : "static-lpt";
  if (dispatchMode === "bounded-pull") {
    console.log(
      `[shards] bounded pull dispatch enabled for ${toRun.length} suite(s) across ${effectiveShardCount} shard(s); ` +
        `static-LPT reference plan: ${laneSummary}`,
    );
  } else {
    console.log(
      `[shards] distributing ${toRun.length} suite(s) across ${effectiveShardCount} shard(s): ${laneSummary}`,
    );
  }
  console.log(
    `[shards] estimate coverage: ${knownEstimateCount}/${toRun.length} known, ` +
      `${toRun.length - knownEstimateCount} unknown (each planned at ${Math.round(unknownEstimateMs)}ms); ` +
      (dispatchMode === "bounded-pull"
        ? "reported planned lane loads are the static-LPT benchmark reference"
        : "planned lane loads are aggregate estimates"),
  );

  // This finite dispatcher is intentionally constructed once for the run and
  // shared only as a synchronous claim callback. A claim happens before the
  // lane awaits child execution, so no queued suite can be claimed twice; the
  // lane's env, database, cache namespace, worker pool, retry flow, and output
  // buffer remain private to that lane.
  const boundedDispatcher =
    dispatchMode === "bounded-pull"
      ? createBoundedSuiteDispatcher(toRunWithEstimates)
      : null;
  const laneRuns = await Promise.all(
    Array.from({ length: effectiveShardCount }, async (_, i) => {
      const workSource =
        boundedDispatcher
          ? {
              // No fixed membership exists in a pull lane. Keep first
              // attempts solo rather than infer batch eligibility from the
              // global queue; that preserves the lane-local worker bound.
              candidates: [] as TestDef[],
              claimNext: () => boundedDispatcher.claimNext(),
              allowsBatching: false,
            }
          : laneWorkSource(staticLanes[i]);
      if (!boundedDispatcher && staticLanes[i].length === 0) {
        return {
          results: [] as SweepTestResult[],
          batchMetrics: createBatchExecutionMetrics(),
          crashReason: null,
        };
      }
      const laneEnv = buildShardEnvOverlay(process.env, shardDbUrls[i], i, hermetic!.runId);
      try {
        const laneRun = await runLane(workSource, i, laneEnv, retryFailed, defaultPerTestTimeoutMs);
        return {
          results: laneRun.results,
          batchMetrics: laneRun.batchMetrics,
          crashReason: null,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[shards] shard-${i} crashed before reporting all results: ${reason}`);
        return {
          results: [] as SweepTestResult[],
          batchMetrics: createBatchExecutionMetrics(),
          crashReason: reason,
        };
      }
    }),
  );
  const laneResultArrays = laneRuns.map((lane) => lane.results);
  completedBatchMetrics = mergeBatchExecutionMetrics(laneRuns.map((lane) => lane.batchMetrics));
  const laneCrashes = laneRuns.flatMap((lane, index) =>
    lane.crashReason === null ? [] : [{ lane: index, reason: lane.crashReason }],
  );

  const actualLaneLoads = laneResultArrays.map((results) => ({
    suiteCount: results.length,
    elapsedMs: results.reduce((sum, result) => sum + result.elapsedMs, 0),
  }));
  shardObservability = {
    shardCount: effectiveShardCount,
    requestedShardCount: requestedShards,
    shardCountSource,
    shardCapReasons: shardPolicyReasons,
    dispatchMode,
    estimateCoverage: {
      known: knownEstimateCount,
      unknown: toRun.length - knownEstimateCount,
      total: toRun.length,
    },
    planned: plannedLaneLoads,
    actual: actualLaneLoads,
  };
  console.log(
    `[shards] actual lane loads: ${actualLaneLoads
      .map((summary, i) => `shard-${i}:${summary.suiteCount}/${Math.round(summary.elapsedMs)}ms`)
      .join(" ")}`,
  );

  // Merge back into toRun registration order and fail closed on any result
  // accounting gap. Missing suites become explicit incomplete records so they
  // cannot be mistaken for passed, skipped, or ordinary test-code failures.
  const merged = mergeLaneResults(laneResultArrays, toRun);
  if (!merged.complete || laneCrashes.length > 0) {
    incompleteShardResults = {
      missingFiles: merged.missingFiles,
      duplicateFiles: merged.duplicateFiles,
      unexpectedFiles: merged.unexpectedFiles,
      laneCrashes,
    };
    const resultByFile = new Map(merged.results.map((result) => [result.file, result]));
    sweepResults = toRun.map((suite) => {
      const result = resultByFile.get(suite.file);
      return result ?? {
        name: suite.name,
        file: suite.file,
        outcome: "incomplete" as const,
        quarantined: false,
        attempts: 0,
        elapsedMs: 0,
        failureReason: "no terminal result returned by its shard lane",
      };
    });
    console.error(
      `[shards] INCOMPLETE VERIFICATION: expected ${toRun.length} selected suite result(s); ` +
        `received ${merged.results.length}. Missing=${merged.missingFiles.length}, ` +
        `duplicate=${merged.duplicateFiles.length}, unexpected=${merged.unexpectedFiles.length}, ` +
        `lane crashes=${laneCrashes.length}. Trusted evidence publication is blocked.`,
    );
    for (const file of merged.missingFiles) console.error(`[shards]   missing: ${file}`);
    for (const file of merged.duplicateFiles) console.error(`[shards]   duplicate result: ${file}`);
    for (const file of merged.unexpectedFiles) console.error(`[shards]   unexpected result: ${file}`);
    for (const crash of laneCrashes) {
      console.error(`[shards]   shard-${crash.lane} crash: ${crash.reason}`);
    }
  } else {
    sweepResults = merged.results;
  }
}

const averageBatchWorkerSuites =
  completedBatchMetrics.batchWorkerStarts === 0
    ? null
    : completedBatchMetrics.batchWorkerSuiteRuns / completedBatchMetrics.batchWorkerStarts;
const averageSoloFirstAttemptMs =
  completedBatchMetrics.soloFirstAttempts === 0
    ? null
    : completedBatchMetrics.soloFirstAttemptElapsedMs / completedBatchMetrics.soloFirstAttempts;
console.log(
  `[batch] eligibility: compatible=${completedBatchMetrics.batchCompatibleFirstAttempts}, ` +
    `process-start-args-solo=${completedBatchMetrics.batchIncompatibleFirstAttempts}; ` +
    `first attempts: batched=${completedBatchMetrics.batchedFirstAttempts}, ` +
    `solo=${completedBatchMetrics.soloFirstAttempts} ` +
    `(solo end-to-end avg=${averageSoloFirstAttemptMs === null ? "n/a" : `${Math.round(averageSoloFirstAttemptMs)}ms`}, includes suite work); ` +
    `workers: starts=${completedBatchMetrics.batchWorkerStarts}, ` +
    `reuses=${completedBatchMetrics.batchWorkerReuses}, ` +
    `avg suites/child=${averageBatchWorkerSuites === null ? "n/a" : averageBatchWorkerSuites.toFixed(2)}, ` +
    `peak RSS=${completedBatchMetrics.batchWorkerPeakRssKb}KiB; ` +
    `recycles: cap=${completedBatchMetrics.batchWorkerRecyclesHardCap}, ` +
    `resource=${completedBatchMetrics.batchWorkerRecyclesResourcePressure}, ` +
    `failure=${completedBatchMetrics.batchWorkerRecyclesFailure}, ` +
    `straggler=${completedBatchMetrics.batchWorkerRecyclesStraggler}; ` +
    `solo rechecks=${completedBatchMetrics.batchedFailureSoloRechecks}.`,
);

// Task #3791: the one-line incremental summary every mode prints.
// Task #5030: deferred suites ride in the same line — a deferral-narrowed
// run must never read like a fully-verified one.
console.log(
  `\n${formatExecutedSkippedLine(
    sweepResults.filter((result) => result.outcome !== "incomplete").length,
    skippedGreenFiles.length,
    deferredFiles.length,
  )}`,
);

// Task #3789: persist a sorted per-suite duration report on every run so a
// slow gate/sweep is attributable to specific suites and smoke-set demotion
// decisions stay data-driven. Best-effort — must never fail the run.
const DURATION_REPORT_PATH = ".local/runs/suite-durations.json";
if (incompleteShardResults) {
  console.error(
    `\n[duration-report] not written: verification was incomplete (${incompleteShardResults.missingFiles.length} missing result(s), ` +
      `${incompleteShardResults.duplicateFiles.length} duplicate(s), ${incompleteShardResults.unexpectedFiles.length} unexpected).`,
  );
} else try {
  const byDuration = [...sweepResults].sort((a, b) => b.elapsedMs - a.elapsedMs);
  mkdirSync(dirname(resolve(DURATION_REPORT_PATH)), { recursive: true });
  writeFileSync(
    resolve(DURATION_REPORT_PATH),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: sweepMode,
        relatedSelection: smokeSelection.relatedSelectionForBudget,
        skippedGreen: skippedGreenFiles.length,
        // Task #5030 — a deferral-narrowed run is not the measured full-smoke
        // quantity: regen-gate-duration-budget refuses it as a budget source.
        deferredNotVerified: deferredFiles.length,
        suiteCount: byDuration.length,
        totalMs: byDuration.reduce((sum, r) => sum + r.elapsedMs, 0),
        shards: shardObservability,
        // Task #3809: wall time of the suite loop, for verifying that batch
        // execution keeps wall ≈ totalMs + small constant.
        wallMs: Date.now() - sweepStartedMs,
        batchWorker: completedBatchMetrics,
        suites: byDuration.map((r) => ({
          file: r.file,
          name: r.name,
          elapsedMs: r.elapsedMs,
          outcome: r.outcome,
          attempts: r.attempts,
        })),
      },
      null,
      2,
    ),
  );
  console.log(
    `\nWrote per-suite duration report to ${DURATION_REPORT_PATH} (${byDuration.length} suite(s), sorted slowest-first).`,
  );
  const slowest = byDuration.slice(0, 10).filter((r) => r.elapsedMs > 0);
  if (slowest.length > 0) {
    console.log("Slowest suites:");
    for (const r of slowest) {
      console.log(`  ${(r.elapsedMs / 1000).toFixed(1).padStart(7)}s  ${r.file}`);
    }
  }
} catch (err) {
  console.warn(`[run-all] Could not write duration report to ${DURATION_REPORT_PATH}:`, err);
}

// ─── Task #4531: duration budget (L3-approved gate policy) ─────────────────
// The committed artifact (tests/gate-duration-budget.json) is the ratchet:
// per-suite ceilings (default 90s/attempt; a registered timeoutMs override is
// the sanctioned slow lane and becomes that suite's ceiling) FAIL full-smoke
// runs and WARN related/sweep runs. Task #5030 revision: the whole-run wall
// budget NEVER fails a run — green stays green; a full-smoke wall breach is
// a loud non-blocking ALERT appended to the breach ledger
// (server/services/regressionSweep.ts), from which the sweep scheduler
// auto-files ONE re-baseline/triage item per stale-budget episode. Missing
// artifact = warn (pre-adoption bootstrap); invalid/tampered artifact = HARD
// FAIL — the budget is policy, and silent decay is exactly the failure mode
// it exists to stop. Kill switch: TEST_DURATION_BUDGET=0.
let durationBudgetEval: DurationBudgetEvaluation | null = null;
let durationBudgetIntegrityError: string | null = null;
if (incompleteShardResults) {
  console.error(
    "\n[duration-budget] not evaluated: incomplete verification cannot produce trustworthy duration evidence.",
  );
} else if (process.env.TEST_DURATION_BUDGET === "0") {
  console.log(
    "\n[duration-budget] enforcement disabled via TEST_DURATION_BUDGET=0 (kill switch) — violations will not block this run.",
  );
} else {
  const loadedBudget = loadDurationBudgetArtifact(resolve(BUDGET_ARTIFACT_PATH));
  if (!loadedBudget.ok) {
    if (loadedBudget.missing) {
      console.warn(
        `\n[duration-budget] no committed budget artifact (${BUDGET_ARTIFACT_PATH}) — enforcement skipped. Regenerate from a zero-skip full-smoke measurement: ${REGEN_COMMAND}`,
      );
    } else {
      durationBudgetIntegrityError = loadedBudget.error;
      console.error(`\n[duration-budget] INVALID committed budget artifact — ${loadedBudget.error}`);
    }
  } else {
    const timeoutOverrideByFile = new Map<string, number | null>(
      toRun.map((t) => [t.file, t.timeoutMs ?? null]),
    );
    durationBudgetEval = evaluateDurationBudget({
      artifact: loadedBudget.artifact,
      suites: sweepResults.map((r) => ({
        file: r.file,
        outcome: r.outcome === "passed" ? ("passed" as const) : ("failed" as const),
        quarantined: r.quarantined,
        elapsedMs: r.elapsedMs,
        attempts: r.attempts,
        timeoutMsOverride: timeoutOverrideByFile.get(r.file) ?? null,
      })),
      wallMs: Date.now() - sweepStartedMs,
      mode: sweepMode,
      relatedSelection: smokeSelection.relatedSelectionForBudget,
      // Task #5030: a deferral-narrowed run did not execute the measured
      // quantity — the wall comparison is skipped (per-suite ceilings still
      // apply).
      deferredCount: deferredFiles.length,
    });
    for (const line of durationBudgetEval.lines) console.log(line);
    // Task #5030: record the wall breach for the scheduler's auto-filed
    // re-baseline/triage item (dedupe = budget artifact generatedAt). Never
    // affects the verdict.
    if (durationBudgetEval.wallHit !== null) {
      appendDurationBudgetBreachEvent({
        observedAt: new Date().toISOString(),
        source: "run-all-wall",
        wallMs: durationBudgetEval.wallHit.wallMs,
        budgetMs: durationBudgetEval.wallHit.budgetMs,
        budgetGeneratedAt: loadedBudget.artifact.generatedAt,
        mode: sweepMode,
        suiteCount: sweepResults.length,
      });
    }
  }
}
// Carried into every exit path below: a PER-SUITE ceiling violation or a
// corrupted artifact must flip even an otherwise-green or excused-pass
// verdict. A wall breach never does (Task #5030 — non-blocking alert +
// auto-filed re-baseline task via the breach ledger).
const durationBudgetBlocks =
  durationBudgetIntegrityError !== null ||
  (durationBudgetEval !== null && durationBudgetEval.failRun);

const sweepReport = buildSweepReport(sweepResults, {
  startedAt: sweepStartedAt,
  finishedAt: new Date().toISOString(),
  mode: sweepMode,
  relatedSelection:
    sweepMode === "smoke" ? smokeSelection.relatedSelectionForBudget : null,
  centralIntegrityDeferred: centralIntegrityDeferred !== null,
  skippedGreen: skippedGreenFiles.length,
  skippedGreenFiles,
  // Task #4077 skip-health: committed-baseline freshness rides along in the
  // report so the sweep summary + nightly notification can surface a frozen
  // baseline instead of tasks discovering it via slow validation runs.
  baselinePublishedAt: plan?.baselinePublishedAt ?? null,
  baselineAgeDays: plan?.baselineAgeDays ?? null,
  // Task #4104: repeat-poison warnings (Task #4101) ride into the report so
  // the nightly sweep notification names the broken file + build error.
  repeatPoisonWarnings,
  // Task #4595: migration-scoping classification + realized skips so the
  // sweep summary trends what the #4503 per-table scoping actually saves.
  migrationTableScopedCount: plan?.migrationTableScopedCount ?? null,
  migrationFullScopeCount: plan?.migrationFullScopeCount ?? null,
  migrationTableScopedSkipped: plan?.migrationTableScopedSkippedCount ?? null,
  migrationFullScopeSkipped: plan?.migrationFullScopeSkippedCount ?? null,
  verificationComplete: !incompleteShardResults,
  verificationProblems: incompleteShardResults
    ? [
        ...incompleteShardResults.missingFiles.map((file) => `missing result: ${file}`),
        ...incompleteShardResults.duplicateFiles.map((file) => `duplicate result: ${file}`),
        ...incompleteShardResults.unexpectedFiles.map((file) => `unexpected result: ${file}`),
        ...incompleteShardResults.laneCrashes.map((crash) => `shard-${crash.lane} crashed: ${crash.reason}`),
      ]
    : [],
  taskGateRailProof: {
    directAffected: buildTaskGateRailProof(requiredDirectFiles),
    core: buildTaskGateRailProof(requiredCoreFiles),
  },
});

// Aggregate-only telemetry for the parent gate: no lane arrays, suite names,
// output, paths, or environment values enter the task-gate evidence ledger.
// An incomplete lane result is diagnostic-only and must not bias utilization,
// balance, or batching aggregates with partial/zero lane data.
if (!incompleteShardResults) {
  const actualLaneLoads = shardObservability?.actual ?? [
    {
      suiteCount: sweepResults.length,
      elapsedMs: sweepResults.reduce((sum, result) => sum + result.elapsedMs, 0),
    },
  ];
  const plannedLaneLoads = shardObservability?.planned ?? [];
  const loadRange = (
    loads: readonly { elapsedMs?: number; plannedLoadMs?: number }[],
    key: "elapsedMs" | "plannedLoadMs",
  ) => {
    const values = loads.map((load) => load[key] ?? 0);
    return {
      totalMs: values.reduce((sum, value) => sum + value, 0),
      minMs: values.length === 0 ? 0 : Math.min(...values),
      maxMs: values.length === 0 ? 0 : Math.max(...values),
    };
  };
  const plannedRange = loadRange(plannedLaneLoads, "plannedLoadMs");
  const actualRange = loadRange(actualLaneLoads, "elapsedMs");
  sweepReport.taskGatePerformance = {
    shardCount: shardObservability?.shardCount ?? 1,
    requestedShardCount: shardObservability?.requestedShardCount ?? requestedShards,
    shardCountSource: shardObservability?.shardCountSource ?? shardCountSource,
    shardCapReasons: shardObservability?.shardCapReasons ?? shardPolicyReasons,
    // Policy capacity, not observed PostgreSQL utilization. The gate retains
    // this snapshot so higher-cap proposals can be compared without inventing
    // a runtime-pressure measurement the runner does not collect.
    databaseBudget: {
      maxConnections: SHARD_CONCURRENCY_POLICY.localHermeticMaxConnections,
      reservedConnections: SHARD_CONCURRENCY_POLICY.reservedHermeticConnections,
      connectionsPerLane: SHARD_CONCURRENCY_POLICY.childDbConnectionsPerLane,
      laneCap: shardConcurrency.caps.database,
    },
    activeLaneCount: actualLaneLoads.filter((lane) => lane.suiteCount > 0).length,
    estimateKnownCount: shardObservability?.estimateCoverage.known ?? 0,
    estimateUnknownCount: shardObservability?.estimateCoverage.unknown ?? 0,
    plannedLaneTotalMs: Math.round(plannedRange.totalMs),
    plannedLaneMinMs: Math.round(plannedRange.minMs),
    plannedLaneMaxMs: Math.round(plannedRange.maxMs),
    actualLaneTotalMs: Math.round(actualRange.totalMs),
    actualLaneMinMs: Math.round(actualRange.minMs),
    actualLaneMaxMs: Math.round(actualRange.maxMs),
    batchedFirstAttempts: completedBatchMetrics.batchedFirstAttempts,
    batchCompatibleFirstAttempts: completedBatchMetrics.batchCompatibleFirstAttempts,
    batchIncompatibleFirstAttempts: completedBatchMetrics.batchIncompatibleFirstAttempts,
    soloFirstAttempts: completedBatchMetrics.soloFirstAttempts,
    soloFirstAttemptElapsedMs: completedBatchMetrics.soloFirstAttemptElapsedMs,
    batchedFailureSoloRechecks: completedBatchMetrics.batchedFailureSoloRechecks,
    batchWorkerStarts: completedBatchMetrics.batchWorkerStarts,
    batchWorkerReuses: completedBatchMetrics.batchWorkerReuses,
    batchWorkerSuiteRuns: completedBatchMetrics.batchWorkerSuiteRuns,
    batchWorkerPeakRssKb: completedBatchMetrics.batchWorkerPeakRssKb,
    batchWorkerRecyclesHardCap: completedBatchMetrics.batchWorkerRecyclesHardCap,
    batchWorkerRecyclesResourcePressure:
      completedBatchMetrics.batchWorkerRecyclesResourcePressure,
    batchWorkerRecyclesFailure: completedBatchMetrics.batchWorkerRecyclesFailure,
    batchWorkerRecyclesStraggler: completedBatchMetrics.batchWorkerRecyclesStraggler,
  };
}

// Task #5028: record how many quarantined suites were excluded from the gate
// (non-diff-related). The scheduler reads this to surface it in the nightly
// notification without re-reading the diff.
sweepReport.quarantineSkippedFromGate = quarantineGateSkippedCount;

// Task #5030: the honest "deferred, not verified" record rides in the report
// — deferred suites are not in `results`/`total` and were NOT verified by
// this run; the post-merge/nightly lane owns their execution debt.
sweepReport.deferredNotVerified = deferredFiles.length;
sweepReport.deferredFiles = deferredFiles;

// Task #3791: persist outcomes. Green is recorded only for passes; failures
// overwrite any prior green. lastFullRunGreenAt is stamped only when a
// mode-"all" run executed EVERY suite (zero skips) and passed — that is what
// predeploy's staleness window trusts.
if (plan) {
  if (incompleteShardResults) {
    // Invalidate every selected suite's prior green so a partial run cannot
    // let missing work skip on the next invocation. Do not record any green
    // outcome from this untrustworthy run.
    recordRunOutcomes({
      storePath: plan.storePath,
      mode: sweepMode,
      fingerprints: plan.fingerprints,
      outcomes: toRun.map((suite) => ({
        file: suite.file,
        passed: false,
        flaky: false,
        durationMs: 0,
      })),
      fullRunGreen: false,
    });
    console.error("[incremental] incomplete verification invalidated selected green records; no passing outcome was recorded.");
  } else {
    recordRunOutcomes({
      storePath: plan.storePath,
      mode: sweepMode,
      fingerprints: plan.fingerprints,
      outcomes: sweepResults.map((r) => ({
        file: r.file,
        passed: r.outcome === "passed",
        flaky: r.outcome === "passed" && r.attempts > 1,
        durationMs: r.elapsedMs,
      })),
      fullRunGreen:
        sweepMode === "all" &&
        skippedGreenFiles.length === 0 &&
        toRun.length === selected.length &&
        !reportIndicatesFailure(sweepReport),
    });
  }
}

// Baseline publish: snapshot the local store's GREEN records into the
// committed tests/green-baseline.json so a fresh task environment can
// inherit them (seeding in planIncrementalRun). Task #4077: this runs on
// EVERY nightly run — red ones included. Requiring a zero-failure sweep
// froze the baseline for days whenever main carried a handful of reds,
// silently re-inflating task validation to full sweeps. It is safe without
// that gate: recordRunOutcomes above has already overwritten this run's
// failures, and publishGreenBaseline filters to verdict-"green" records —
// a red suite simply drops out of the baseline while its green siblings
// keep publishing (failures continue into the red manifest below and can
// never seed a skip). Gated behind TEST_GREEN_BASELINE_PUBLISH=1, which
// ONLY the main workspace's nightly sweep scheduler sets — task-branch runs
// never write the baseline, so it never becomes a merge surface (guard
// test: tests/incremental-green-skip.test.ts pins this wiring).
if (plan && process.env.TEST_GREEN_BASELINE_PUBLISH === "1" && !incompleteShardResults) {
  const pub = publishGreenBaseline({
    storePath: plan.storePath,
    baselinePath: resolve(process.cwd(), DEFAULT_GREEN_BASELINE_PATH),
  });
  if (pub.published) {
    console.log(`[incremental] published green baseline (${pub.count} record(s)) to ${DEFAULT_GREEN_BASELINE_PATH}`);
  } else {
    console.warn(`[incremental] ${pub.note}`);
  }
}

// Task #5028: Build the updated history in memory NOW so the quarantine
// transition block below can evaluate entry/reinstatement thresholds against
// tonight's decisive outcomes (not a stale disk snapshot). The in-memory
// variable is the single source of truth for both the quarantine block and
// the later saveSuiteHistory call — avoiding a second appendRunToHistory.
// Kill switch: if FLAKE_QUARANTINE=0, we still build the history (for the
// repeat-offender report and the priorHistory attribution parameter) but
// skip all quarantine-specific persistence and report fields.
const updatedSuiteHistory = incompleteShardResults
  ? loadSuiteHistory()
  : appendRunToHistory(loadSuiteHistory(), sweepResults, {
  at: sweepStartedAt,
  mode: sweepMode,
  // Task #5028: tag sweep-lane runs so reinstatement can count ≥3 sweep-lane
  // greens (regression mode and nightly-publish runs both qualify; smoke gate
  // and isolated --file runs do NOT).
  sweepLane: sweepMode === "regression" || process.env.TEST_GREEN_BASELINE_PUBLISH === "1",
  });

// Task #5028: compute and commit auto-quarantine state transitions. This block
// is the SINGLE WRITER of tests/flake-quarantine.json — guard-pinned by the
// single-writer test in tests/flake-quarantine-state.test.ts.
// Kill switch: when FLAKE_QUARANTINE=0 the entire block is skipped — no
// ledger write, no report fields, no feedback events. This prevents
// quarantines from accumulating while the switch is off and then activating
// unexpectedly on re-enable.
if (
  process.env.TEST_GREEN_BASELINE_PUBLISH === "1" &&
  process.env[QUARANTINE_KILL_SWITCH_ENV] !== "0" &&
  !incompleteShardResults
) {
  try {
    // Use the in-memory updated history (includes tonight's outcomes) so
    // the decisive run — the one that tips an entry or reinstatement
    // threshold — is acted on immediately, not deferred to a future publish.
    const qRegisteredFiles = new Set(TESTS.map((t) => t.file));
    const qTransitions = computeQuarantineTransitions(updatedSuiteHistory, autoQuarantineLedger, {
      registeredFiles: qRegisteredFiles,
    });
    const { saved: qSaved, note: qSaveNote } = saveQuarantineLedger(
      quarantineLedgerAbsPath,
      qTransitions.newLedger,
    );
    if (!qSaved) {
      console.warn(`[quarantine] ledger publish failed: ${qSaveNote ?? "unknown error"}`);
    } else {
      const parts: string[] = [];
      if (qTransitions.entered.length > 0) parts.push(`+${qTransitions.entered.length} entered`);
      if (qTransitions.reinstated.length > 0) parts.push(`${qTransitions.reinstated.length} reinstated`);
      if (qTransitions.capDenied.length > 0) parts.push(`${qTransitions.capDenied.length} cap-denied`);
      console.log(
        `[quarantine] ledger published (${qTransitions.newLedger.entries.length} active; ${parts.length > 0 ? parts.join(", ") : "no changes"})`,
      );
      for (const entry of qTransitions.entered) {
        console.log(`[quarantine] ENTERED: ${formatQuarantineEntry(entry)}`);
      }
      for (const r of qTransitions.reinstated) {
        console.log(`[quarantine] REINSTATED: ${r.file}`);
      }
      for (const d of qTransitions.capDenied) {
        console.warn(`[quarantine] CAP DENIED: ${d.file} (${d.reason})`);
      }
    }
    // Ride transition summary into the sweep report so the scheduler can
    // drive filing/resolution and cap-breach alerts.
    sweepReport.quarantineEntered = qTransitions.entered.map((e) => e.file);
    sweepReport.quarantineReinstated = qTransitions.reinstated.map((e) => e.file);
    sweepReport.quarantineCapDenied = qTransitions.capDenied.map((d) => d.file);
  } catch (qErr) {
    console.warn(
      `[quarantine] ledger transition/publish failed (non-fatal, previous ledger kept): ${
        qErr instanceof Error ? qErr.message : String(qErr)
      }`,
    );
  }
}

// Task #4491: nightly-only REPORT-ONLY gate lint phase — main-side lint-red
// visibility. Task-side lint attribution never reads these entries (it uses
// a live base-tree A/B, scripts/gateLintAttribution.ts); they exist so lint
// reds on main are pushed via the sweep notification and get their ONE fix
// on main instead of persisting invisibly. Gated behind the SAME
// single-writer publish flag as the baseline/manifest publishes, so task
// runs never pay for it. Report-only by construction: the outcome feeds the
// red manifest's `lints` section + the sweep report, NEVER the sweep verdict
// (sweepReport verdict fields were finalized above) and never any excusal
// decision. Budgeted: an over-budget/errored phase records NOTHING
// (lintFailures stays null ⇒ publishRedManifest carries previous lint
// entries verbatim — an unmeasured run must not fake a lint-green main).
let nightlyLintReds: Array<{ name: string; failureReason: string }> | null = null;
if (process.env.TEST_GREEN_BASELINE_PUBLISH === "1" && !incompleteShardResults) {
  const budgetRaw = Number(process.env.NIGHTLY_LINT_PHASE_BUDGET_MS);
  const budgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 900_000;
  try {
    // Dynamic import keeps the gate module (and its worker-pool machinery)
    // out of every non-publishing run. Importing scripts/gate.ts is
    // side-effect-free (isMain guard; pinned by tests/gate-lint-phase.test.ts).
    const gate = await import("../scripts/gate");
    console.log(`\n[nightly-lints] running the gate lint phase report-only (budget ${Math.round(budgetMs / 1000)}s)…`);
    const timeoutSentinel = Symbol("nightly-lint-budget");
    const timeout = new Promise<typeof timeoutSentinel>((resolveTimeout) => {
      const t = setTimeout(() => resolveTimeout(timeoutSentinel), budgetMs);
      t.unref();
    });
    const phase = await Promise.race([gate.runLintPhase(), timeout]);
    if (phase === timeoutSentinel) {
      // Losing workers are reaped by run-all's unconditional process.exit(0)
      // at the end of this script.
      console.warn(
        `[nightly-lints] lint phase exceeded its ${Math.round(budgetMs / 1000)}s budget — lint reds NOT recorded this run (previous manifest lint entries carry forward unchanged)`,
      );
    } else {
      nightlyLintReds = phase.results
        .filter((r) => !r.passed)
        .map((r) => ({ name: r.name, failureReason: `exit ${r.exitCode}` }));
      console.log(
        nightlyLintReds.length === 0
          ? `[nightly-lints] all ${phase.results.length} gate lint(s) GREEN on main (${Math.round(phase.wallMs / 1000)}s)`
          : `[nightly-lints] ${nightlyLintReds.length} gate lint(s) RED on main: ${nightlyLintReds
              .map((l) => l.name)
              .join(", ")} — recording in the red manifest; each needs ONE fix on main`,
      );
    }
  } catch (err) {
    console.warn(
      `[nightly-lints] lint phase failed to run (${err instanceof Error ? err.message : String(err)}) — lint reds NOT recorded this run (previous manifest lint entries carry forward unchanged)`,
    );
  }
  // Ride the measurement into the sweep report (null = not measured) so the
  // scheduler's notification can push NEW lint reds once per streak.
  sweepReport.lintReds = nightlyLintReds ? nightlyLintReds.map((l) => l.name) : null;
}

// Task #3922: the RED sibling of the baseline publish — snapshot the suites
// currently failing in this run (failure signature + input fingerprint +
// commit stamp) into the committed tests/red-manifest.json so task
// environments can attribute inherited failures automatically instead of
// re-deriving innocence proofs by hand. Same single writer as the green
// baseline (the env flag is armed ONLY by the nightly scheduler); unlike the
// green publish this runs on RED runs too — that is the whole point — and a
// fully green run publishes an EMPTY manifest so stale reds clear. Task
// #4491: gate lint reds from the report-only phase above ride into the SAME
// single publish call (the `lints` section). Guard:
// tests/upstream-red-attribution.test.ts.
if (process.env.TEST_GREEN_BASELINE_PUBLISH === "1" && !incompleteShardResults) {
  const manifestAbsPath = resolve(process.cwd(), DEFAULT_RED_MANIFEST_PATH);
  // Task #5030 — culprit naming: resolve the merge window between the
  // PREVIOUS manifest's commit stamp and this run's HEAD before publishing,
  // so NEW reds are attributed to the merge window that introduced them
  // (stamped as `culprit` only when the window holds exactly one commit —
  // never guess among several). The window also rides into the sweep report
  // so the scheduler's failure notification names it.
  const priorManifest = loadRedManifest(manifestAbsPath).manifest;
  const headCommit = makeGitRunner(process.cwd())(["rev-parse", "HEAD"]);
  const mergeWindow = resolveMergeWindow({
    fromCommit: priorManifest?.commit ?? null,
    toCommit: headCommit.ok ? headCommit.stdout.trim() : "",
    repoRoot: process.cwd(),
  });
  const redPub = publishRedManifest({
    manifestPath: manifestAbsPath,
    repoRoot: process.cwd(),
    failures: sweepResults
      .filter((r) => r.outcome === "failed" && !r.quarantined)
      .map((r) => ({
        file: r.file,
        failureReason: r.failureReason ?? "unknown",
        fingerprint: plan?.fingerprints.get(r.file) ?? null,
      })),
    lintFailures: nightlyLintReds,
    mergeWindow,
  });
  if (redPub.published) {
    console.log(
      `[red-manifest] published upstream-health manifest (${redPub.count} red suite(s), ${redPub.lintCount} red lint(s)) to ${DEFAULT_RED_MANIFEST_PATH}`,
    );
    if (redPub.newRedFiles.length > 0) {
      if (mergeWindow) {
        console.log(
          `[red-manifest] ${redPub.newRedFiles.length} NEW red(s) since ${mergeWindow.fromCommit.slice(0, 10)} — culprit merge window (${mergeWindow.commits.length} commit(s)${mergeWindow.truncated ? ", truncated" : ""}):`,
        );
        for (const c of mergeWindow.commits) {
          console.log(`[red-manifest]   ${c.commit.slice(0, 10)} ${c.task ?? "(no task ref)"} — ${c.subject}`);
        }
      } else {
        console.log(
          `[red-manifest] ${redPub.newRedFiles.length} NEW red(s) — culprit merge window unresolvable (no prior manifest commit or git walk failed).`,
        );
      }
      sweepReport.newRedMergeWindow = mergeWindow
        ? {
            fromCommit: mergeWindow.fromCommit,
            toCommit: mergeWindow.toCommit,
            newReds: redPub.newRedFiles,
            commits: mergeWindow.commits.map((c) => ({ commit: c.commit, task: c.task, subject: c.subject })),
            truncated: mergeWindow.truncated,
          }
        : null;
    }
  } else {
    console.warn(`[red-manifest] ${redPub.note}`);
  }
}

// Task #4101: repeat the repeat-poison warning next to the verdict — the
// plan-time print scrolls away in long sweeps, and this is the alerting
// surface the nightly sweep log tails.
if (poisonWarningLines.length > 0) {
  console.error("");
  for (const line of poisonWarningLines) console.error(line);
}

// Task #3922: automatic upstream-vs-task attribution for every hard failure,
// mechanizing the manual stash/worktree innocence ritual. Verdicts + evidence
// print here and land in .local/runs/attribution-report.json (cite that file
// in drift/skip explanations and completion-review rebuttals). Excusal —
// treating a failure as non-blocking — is armed ONLY for the smoke gate in
// non-publishing environments (kill switch: TEST_ATTRIBUTION_EXCUSE=0), and
// only for failures that are red at upstream main with a matching signature
// AND an input fingerprint identical to main's measurement (byte-identical
// inputs ⇒ the task's diff is provably uninvolved). Everything else — and
// any attribution error — stays blocking ("yours"). This runs BEFORE the
// flake-history append below so history evidence reflects only prior runs.
let excusedFailureFiles = new Set<string>();
// Task #4480 — staleness callout carried down to the final verdict lines: a
// frozen manifest must be visible next to the failure count, not just in the
// scrolled-away attribution block.
let staleBaselineSummary: string | null = null;
if (sweepReport.hardFailed > 0 && !incompleteShardResults) {
  const excusalArmed =
    sweepMode === "smoke" &&
    process.env.TEST_GREEN_BASELINE_PUBLISH !== "1" &&
    process.env.TEST_ATTRIBUTION_EXCUSE !== "0";
  // Task #5318 — live-tip fallback arming mirrors excusalArmed exactly (same
  // lane condition, its own kill switch) and is decided HERE ONLY, never
  // read from tests/redManifest.ts or tests/liveTipAttribution.ts — pinned
  // by the same single-wiring-owner discipline TEST_ATTRIBUTION_EXCUSE and
  // TEST_GREEN_BASELINE_PUBLISH already follow.
  const liveTipArmed =
    sweepMode === "smoke" &&
    process.env.TEST_GREEN_BASELINE_PUBLISH !== "1" &&
    process.env.TEST_LIVE_TIP_ATTRIBUTION !== "0";
  const attribution = await attributeRunFailures({
    repoRoot: process.cwd(),
    mode: sweepMode,
    failures: sweepResults
      .filter((r) => r.outcome === "failed" && !r.quarantined)
      .map((r) => {
        const t = toRun.find((x) => x.file === r.file);
        return {
          file: r.file,
          name: r.name,
          failureReason: r.failureReason ?? "unknown",
          extraNodeArgs: t?.extraNodeArgs,
          extraEnv: t?.extraEnv,
          timeoutMs: t?.timeoutMs,
        };
      }),
    fingerprints: plan?.fingerprints ?? null,
    excusalArmed,
    liveTipArmed,
    publishing: process.env.TEST_GREEN_BASELINE_PUBLISH === "1",
    priorHistory: loadSuiteHistory(),
    reportPath: process.env.TEST_TASK_GATE_ATTRIBUTION_REPORT_PATH || undefined,
  });
  console.log("");
  for (const line of attribution.lines) console.log(line);
  excusedFailureFiles = new Set(attribution.excusedFiles);
  // Deferred intake receives only the runner's bounded, structured proof
  // facts. The scheduler normalizes these alongside the report and never
  // treats this attachment as accepted-green evidence.
  sweepReport.deferredFailureAttribution = attribution.attributions.map((entry) => ({
    file: entry.file,
    verdict: entry.verdict,
    historyKind: entry.historyKind,
    provenInherited: entry.verdict === "inherited" && entry.excusable,
    proofStatus: entry.proofStatus,
  }));
  sweepReport.deferredFailureSource =
    process.env.TEST_GREEN_BASELINE_PUBLISH === "1" ? "nightly" : "periodic";
  if (attribution.manifestStaleness?.stale) {
    const unattributable = attribution.attributions.filter((a) => a.verdict === "unattributable").length;
    const age = attribution.manifestStaleness.ageDays;
    staleBaselineSummary =
      `⚠ STALE BASELINE: upstream red manifest is ${age === null ? "unparseably dated" : `${age.toFixed(1)}d old`} — ` +
      `${unattributable} failure(s) UNATTRIBUTABLE (cannot prove main was green; still blocking). ` +
      `Evidence: .local/runs/attribution-report.json`;
  }
}

if (jsonReportPath) {
  try {
    mkdirSync(dirname(resolve(jsonReportPath)), { recursive: true });
    writeFileSync(resolve(jsonReportPath), JSON.stringify(sweepReport, null, 2));
    console.log(`\nWrote sweep report to ${jsonReportPath}`);
  } catch (err) {
    console.error(`[run-all] Could not write JSON report to ${jsonReportPath}:`, err);
  }
}

console.log(`\n${summarizeSweepResult(sweepReport)}`);

// Task #3797: flake-history journal — persist per-suite outcomes across
// runs and surface repeat offenders, so a flake that a retry masked (or
// that shifts file-to-file between runs) stays visible.
try {
  // Task #5028: updatedSuiteHistory was computed before the quarantine block
  // (above) to include tonight's outcomes in transition evaluation. Reuse it
  // here so we save exactly one appendRunToHistory result, not two.
  saveSuiteHistory(updatedSuiteHistory);
  const offenderLines = formatRepeatOffenders(findRepeatOffenders(updatedSuiteHistory));
  if (offenderLines.length > 0) {
    console.log("");
    for (const line of offenderLines) console.log(line);
  }
} catch (err) {
  console.warn("[run-all] flake-history journal update failed:", err);
}

if (hermetic) {
  const h = hermetic;
  hermetic = null;
  await h.teardown();
}

// Task #5030: the deferral record repeats next to the verdict on EVERY exit
// path — a deferral-narrowed run must never read like a fully-verified one,
// whatever the verdict.
if (deferredFiles.length > 0) {
  console.log(
    `\n[deferral] NOTE: ${deferredFiles.length} suite(s) DEFERRED to the post-merge/nightly lane — not verified by this run (record: .local/runs/full-lane-deferred.json).`,
  );
}
if (incompleteShardResults) {
  console.error(
    `\nTest run verdict: INCOMPLETE — ${sweepReport.incomplete ?? 0} selected suite(s) were not verified; ` +
      "green baseline, red manifest, quarantine, and duration evidence were not updated.",
  );
  process.exit(1);
}
if (reportIndicatesFailure(sweepReport)) {
  // Task #3922: hard failures excused as inherited-from-upstream (see the
  // attribution block above) do not block the verdict. They are still
  // recorded as FAILED in the green store and flake history — an excused red
  // never seeds a green — and they are still listed above with their
  // evidence; only the process exit flips. Any non-excused failure keeps the
  // red verdict.
  const blockingCount = sweepResults.filter(
    (r) => r.outcome === "failed" && !r.quarantined && !excusedFailureFiles.has(r.file),
  ).length;
  if (blockingCount === 0 && excusedFailureFiles.size > 0) {
    if (durationBudgetBlocks) {
      console.error(
        `\nTest run verdict: FAIL — duration budget ${durationBudgetIntegrityError !== null ? "artifact invalid" : "per-suite ceiling(s) exceeded"} (hard failures were excused as inherited, but the budget block above still fails this run).`,
      );
      process.exit(1);
    }
    console.log(
      `\nTest run verdict: PASS with ${excusedFailureFiles.size} excused inherited failure(s) — red at upstream main on identical inputs; evidence: .local/runs/attribution-report.json`,
    );
    process.exit(0);
  }
  console.error(`\n${sweepReport.hardFailed} test(s) failed.`);
  if (staleBaselineSummary) console.error(staleBaselineSummary);
  process.exit(1);
}
if (durationBudgetBlocks) {
  // Task #5030: only per-suite ceilings or a corrupted artifact reach this —
  // an aggregate wall breach never flips a green run (alert + auto-filed
  // re-baseline task instead).
  console.error(
    `\nTest run verdict: FAIL — duration budget ${durationBudgetIntegrityError !== null ? "artifact invalid" : "per-suite ceiling(s) exceeded"} (all suites passed; see the duration budget block above).`,
  );
  process.exit(1);
}
// Task #5028: append quarantine-excluded-from-gate note to the verdict when
// the smoke gate was soft for quarantined suites.
if (onlySmoke && quarantineGateSkippedCount > 0) {
  console.log(
    `\n[quarantine] ${quarantineGateSkippedCount} quarantined flaky suite(s) ran non-blocking (excluded from gate verdict; next action: address the established recurring-failure item in ${QUARANTINE_LEDGER_PATH}).`,
  );
}
console.log("\nAll tests passed.");
process.exit(0);
