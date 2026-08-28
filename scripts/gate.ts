/**
 * Consolidated gate script — runs typecheck + all registered lint checks +
 * smoke gate in one invocation with a clear per-check pass/fail summary.
 *
 * This is the single source of truth for the gate command set. The `.replit`
 * managed Long validation workflow runs the reviewed routine-gate profile; individual scripts remain available
 * as focused CLI commands (`npx tsx scripts/…`). LINT_CHECKS below is the
 * canonical list. See TASK_SELFCHECK.md § 4 when adding a lint.
 *
 * Lint phase (Task #3789): instead of spawning one `npx tsx` process per lint
 * serially (~45s wall for 22 checks, mostly interpreter boot), the gate runs
 * every lint inside THIS process via a bounded pool of worker threads
 * (scripts/gate-lint-worker.mjs). Each lint script must therefore:
 *   1. be import-side-effect-free (no scanning/output/process.exit on import);
 *   2. export `cliMain(): number` that prints exactly what the standalone CLI
 *      prints and returns the exit code;
 *   3. keep its bottom `isMain` guard calling `process.exit(cliMain())` so the
 *      standalone `npx tsx scripts/lint-….ts` command and predeploy.sh keep
 *      working.
 * tests/gate-lint-phase.test.ts enforces the contract for every entry.
 *
 * Every mode FIRST runs the scratch self-clean (scripts/clean-scratch.ts
 * --stale-only, Task #3794): it deletes untracked junk-pattern files and
 * TTL-prunes the declared scratch zones so the worktree-hygiene lint then
 * validates the cleaned tree. It is deliberately NOT part of LINT_CHECKS —
 * it mutates the worktree and is not part of the read-only worker pool.
 *
 * Usage:
 *   npm run gate              — typecheck + lints + RELATED smoke subset
 *                               (Task #3755: only smoke tests whose traced
 *                               import closure reaches the task's changed
 *                               files, plus the always-run core; any
 *                               selection failure falls open to the full set)
 *   npm run gate --full-smoke — typecheck + lints + the complete smoke set
 *   npm run gate --no-smoke   — typecheck + lints only (skip smoke gate)
 *   npm run gate --lint-only  — lints only
 *
 * Per-check timings are printed inline and persisted to
 * .local/runs/gate-timings.json so gate slowdowns are attributable.
 *
 * Exit code: 0 if all checks pass, 1 if any fail.
 */

import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { loadDurationBudgetArtifact } from "../tests/durationBudget";
// Task #5030 — wall breaches alert (non-blocking) and land in the breach
// ledger; the sweep scheduler auto-files the re-baseline/triage item.
// Import is side-effect-free (pure helpers + node:fs wrappers).
import { appendDurationBudgetBreachEvent } from "../server/services/regressionSweep";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Task #4491 — self-heal + base-tree A/B attribution rails for gate lint reds.
// Import is side-effect-free (constants + function defs only), preserving the
// nightly report-only `import("../scripts/gate")` in tests/run-all.ts.
import { runGateLintFailureRails } from "./gateLintAttribution";
// Task #5317 — reuse Task #5316's live diff-provenance tool (which itself
// reuses gateLintAttribution's resolveBaseTree) rather than a second
// base-resolution implementation. Import is side-effect-free.
import { buildProvenanceReport, type ProvenanceReport } from "./diffProvenanceLib";
import {
  TASK_GATE_EVIDENCE_SCHEMA_VERSION,
  TASK_GATE_SHARD_CAP_REASONS,
  TASK_GATE_SHARD_COUNT_SOURCES,
  appendTaskGateEvidence,
  buildTaskGateProvenance,
  captureTaskGateSource,
  type TaskGateAttributionSummary,
  type TaskGateEvidenceRecord,
  type TaskGatePerformanceSummary,
  type TaskGateSelectionMode,
} from "./taskGateEvidence";
import { classifyTaskGateDisposition, mandatoryRailWasExecuted } from "./taskGatePolicy";
import { computeChangedFiles, makeGitRunner } from "../tests/relatedSmokeSelection";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PATH = resolve(ROOT, "scripts/gate-lint-worker.mjs");
const TIMINGS_PATH = resolve(ROOT, ".local/runs/gate-timings.json");
const GATE_INVOCATION_STARTED_AT_MS = Date.now();
const GATE_OBSERVATION_ID = `${new Date(GATE_INVOCATION_STARTED_AT_MS).toISOString()}:${process.pid}`;
const GATE_PRIVATE_ARTIFACT_STEM = `${GATE_INVOCATION_STARTED_AT_MS}-${process.pid}`;
const GATE_SWEEP_REPORT_PATH = resolve(
  ROOT,
  `.local/scratch/task-gate-sweep-${GATE_PRIVATE_ARTIFACT_STEM}.json`,
);
const GATE_ATTRIBUTION_REPORT_PATH = resolve(
  ROOT,
  `.local/scratch/task-gate-attribution-${GATE_PRIVATE_ARTIFACT_STEM}.json`,
);
// Task #5317 — well-known (not per-invocation-private) fixed path: every
// gate run overwrites this with a freshly computed report, so it's always
// where an agent expects it, unlike the per-PID scratch paths above.
const GATE_DIFF_PROVENANCE_REPORT_PATH = resolve(ROOT, ".local/runs/gate-diff-provenance.json");

// npm swallows unknown --flags before argv (`npm run gate --lint-only` arrives
// only as npm_config_lint_only), while `npm run gate -- --lint-only` arrives
// via argv. Honor both for every flag.
function flag(argvName: string, npmConfigName: string): boolean {
  return (
    process.argv.includes(argvName) ||
    (process.env[`npm_config_${npmConfigName}`] ?? "") !== ""
  );
}
const NO_SMOKE =
  flag("--no-smoke", "no_smoke") ||
  // npm parses `--no-smoke` as a NEGATION of a "smoke" config: it arrives as
  // npm_config_smoke="" (present but empty), never as npm_config_no_smoke.
  process.env.npm_config_smoke === "";
const LINT_ONLY = flag("--lint-only", "lint_only");
const FULL_SMOKE = flag("--full-smoke", "full_smoke");

/**
 * Changes to these policy-owning surfaces require focused contract proof plus
 * a bounded gate. Their broad verification is explicitly deferred to the
 * shared central-integrity lane; only an operator-requested full smoke run
 * verifies that debt immediately.
 */
const TASK_CONTROL_PLANE_PATHS = [
  "scripts/gate.ts",
  "scripts/gate-lint-worker.mjs",
  "scripts/taskGatePolicy.ts",
  "scripts/taskGateEvidence.ts",
  "scripts/report-task-gate-evidence.ts",
  "scripts/gateLintAttribution.ts",
  "scripts/regen-gate-duration-budget.ts",
  "tests/run-all.ts",
  "tests/testRegistry.ts",
  "tests/relatedSmokeSelection.ts",
  "tests/suiteFingerprint.ts",
  "tests/redManifest.ts",
  "tests/durationBudget.ts",
  "tests/flake-quarantine.json",
  "server/services/regressionSweep.ts",
  "server/services/regressionSweepScheduler.ts",
] as const;

export function isTaskControlPlanePath(path: string): boolean {
  return (
    TASK_CONTROL_PLANE_PATHS.includes(path as (typeof TASK_CONTROL_PLANE_PATHS)[number]) ||
    path.startsWith("scripts/lint-") ||
    path.startsWith("tests/helpers/") ||
    path.startsWith("tests/flake-quarantine")
  );
}

function currentTaskTouchesTaskControlPlane(): boolean {
  const changed = computeChangedFiles(makeGitRunner(ROOT), process.env);
  return !changed.ok || changed.files.some(isTaskControlPlanePath);
}


export interface LintCheck {
  name: string;
  /** Repo-relative path to the lint script (standalone command: `npx tsx <script>`). */
  script: string;
  /**
   * Run this check without any other lint worker active. Reserved for checks
   * whose subprocess is healthy in isolation but can exceed its own bounded
   * timeout under lint-pool CPU/memory contention. Cache hits still occupy
   * this lane briefly; the check's own timeout and verdict remain unchanged.
   */
  exclusive?: boolean;
  /**
   * Task #4491 — optional remediation hint printed when the check fails
   * (generator command or doc pointer), so fixes stop requiring memory
    * archaeology.
   */
  remedy?: string;
  /**
   * Task #4650 — optional V8 old-space cap (MB) for this check's worker
   * thread, threaded to `resourceLimits.maxOldGenerationSizeMb` in
   * runLintWorker (worker threads cannot receive `--max-old-space-size` via
   * execArgv — V8 flags never reach them). Reserved for checks whose analysis
   * provably exceeds the ~4144MB default worker heap; today only
   * lint-async-correctness (full-tree ts.Program — audit 2026-08-12 residual
   * R2 OOM). Checks without this field keep Node's default worker resource
   * limits exactly as before.
   */
  workerMaxOldSpaceMb?: number;
}

/**
 * LINT_CHECKS is the single canonical list of all lint checks.
 *
 * Every entry runs under the managed Long validation workflow's reviewed routine-gate profile.
 * No lint receives a dedicated workflow; standalone commands are focused
 * debugging tools only.
 * When adding a new lint script:
 *   1. Export `cliMain(): number` (import-side-effect-free; see header).
 *   2. Add it to this array.
 * These steps must happen in the same change (Task Preflight § 9);
 * gate-lint-phase.test.ts enforces the contract.
 */
export const LINT_CHECKS: LintCheck[] = [
  { name: "lint-sql-array-bindings", script: "scripts/lint-sql-array-bindings.ts" },
  { name: "lint-getdb-attribution", script: "scripts/lint-getdb-attribution.ts" },
  { name: "lint-db-pool-tenancy", script: "scripts/lint-db-pool-tenancy.ts" },
  { name: "lint-apply-state-writers", script: "scripts/lint-apply-state-writers.ts" },
  { name: "lint-replit-md", script: "scripts/lint-replit-md.ts" },
  { name: "lint-migration-prefixes", script: "scripts/lint-migration-prefixes.ts" },
  // Task #4179 (Architecture Governor first-wave guard #1): applied
  // migration files are immutable history — sha-256 ledger frozen at
  // activation; edits/deletes/renames of old files fail, and destructive
  // SQL in NEW migrations needs an in-file approval marker.
  { name: "lint-migration-immutability", script: "scripts/lint-migration-immutability.ts" },
  { name: "lint-oauth-refresh-single-flight", script: "scripts/lint-oauth-refresh-single-flight.ts" },
  { name: "lint-prod-actions-no-re-press", script: "scripts/lint-prod-actions-no-re-press.ts" },
  { name: "lint-front-sync-email-triage", script: "scripts/lint-front-sync-email-triage.ts" },
  { name: "lint-test-hedge-comments", script: "scripts/lint-test-hedge-comments.ts" },
  { name: "lint-probe-swallow-into-unauthorized", script: "scripts/lint-probe-swallow-into-unauthorized.ts" },
  { name: "lint-front-rematch-restrict-to-ids", script: "scripts/lint-front-rematch-restrict-to-ids.ts" },
  {
    name: "lint-bundle-budget",
    script: "scripts/lint-bundle-budget.ts",
    exclusive: true,
  },
  { name: "lint-probe-refresh-purpose", script: "scripts/lint-probe-refresh-purpose.ts" },
  { name: "lint-test-shared-setting-pinning", script: "scripts/lint-test-shared-setting-pinning.ts" },
  { name: "lint-cross-instance-locks", script: "scripts/lint-cross-instance-locks.ts" },
  { name: "lint-calendar-preview-probe-purpose", script: "scripts/lint-calendar-preview-probe-purpose.ts" },
  { name: "lint-keyword-canonical-lockstep", script: "scripts/lint-keyword-canonical-lockstep.ts" },
  { name: "lint-heatmap-color-lockstep", script: "scripts/lint-heatmap-color-lockstep.ts" },
  { name: "lint-smoke-gate-regression", script: "scripts/lint-smoke-gate-regression.ts" },
  { name: "lint-comms-shared-message-components", script: "scripts/lint-comms-shared-message-components.ts" },
  { name: "lint-notification-shared-row", script: "scripts/lint-notification-shared-row.ts" },
  { name: "lint-worktree-hygiene", script: "scripts/lint-worktree-hygiene.ts" },
  { name: "lint-monolith-aggregator-size", script: "scripts/lint-monolith-aggregator-size.ts" },
  {
    name: "lint-route-inventory-freshness",
    script: "scripts/lint-route-inventory-freshness.ts",
    remedy: "npx tsx scripts/regen-route-inventory.mjs — regen FIRST, the contract table derives from it. The gate self-heals this automatically after completion rebases, Task #4491.",
  },
  // Task #4995: a route registered as `app.get("/path", mw, handler);` on
  // ONE line is invisible to the route-inventory parser (ROUTE_REGEX needs
  // an inline handler; MULTI_LINE_OPEN_REGEX needs `app.get(` alone on a
  // line). The route silently vanishes from tests/route-inventory.json and
  // every downstream audit artifact with all lints green. Enforce the
  // multi-line form (`app.get(\n  "path",\n  mw,\n  handler,\n);`) so
  // BARE_REF_CLOSE_REGEX picks it up.
  {
    name: "lint-single-line-bare-ref-routes",
    script: "scripts/lint-single-line-bare-ref-routes.ts",
  },
  // Task #4092: the committed endpoint contract table (audits/D-endpoint-
  // contract-table.{md,json}) is generated FROM tests/route-inventory.json;
  // fail the gate when it drifts from the inventory instead of rotting until
  // the next audit regenerates it.
  {
    name: "lint-contract-table-freshness",
    script: "scripts/lint-contract-table-freshness.ts",
    remedy: "node scripts/generate-endpoint-contract-table.mjs — run AFTER regenerating the route inventory. The gate self-heals this automatically after completion rebases, Task #4491.",
  },
  // PR4: website/public is a committed esbuild/HTML artifact; fail the gate
  // when any website/src|content input was edited without re-running
  // `npx tsx website/generate.ts`.
  {
    name: "lint-website-bundle-freshness",
    script: "scripts/lint-website-bundle-freshness.ts",
    remedy: "npx tsx website/generate.ts — website/public is committed generator output. The gate self-heals this automatically after completion rebases, Task #4491.",
  },
  // Task #3797: tests own a hermetic per-run DB; block raw pools,
  // dev-DB literals, and self-granted shared-dev escapes in tests/**.
  { name: "lint-test-hermetic-db", script: "scripts/lint-test-hermetic-db.ts" },
  // Task #4180: Architecture Governor first-wave guard — every observed-public
  // route must have an owner-reviewed allow-list entry in
  // scripts/route-public-allowlist.json; net-new unclassified or
  // unauthenticated routes are blocked from shipping without L3 approval.
  { name: "lint-route-classification", script: "scripts/lint-route-classification.ts" },
  // Task #4180: Architecture Governor first-wave guard — vendor SDK importers
  // (openai, twilio, stripe, etc.) are frozen in
  // scripts/vendor-importer-baseline.json; net-new direct importers outside
  // the frozen baseline require L3 owner approval to add.
  { name: "lint-vendor-confinement", script: "scripts/lint-vendor-confinement.ts" },
  // Task #3817: typescript-eslint async-correctness rules (no-floating-promises
  // family) gated on NEW hits vs the count baseline. Type-aware, so this is the
  // slowest lint (~2-2.5 min full scan); full-set test runs enforce it again
  // via tests/async-correctness-lint.test.ts.
  // Task #4650: uncached runs that land on the serial in-worker lane build the
  // FULL typed program inside the worker and sit right at the ~4144MB default
  // worker heap — completable solo but ERR_WORKER_OUT_OF_MEMORY under
  // concurrent gate load (audit 2026-08-12 §9, residual R2). 6144 matches the
  // guard suite's proven full-program budget from Task #4548.
  {
    name: "lint-async-correctness",
    script: "scripts/lint-async-correctness.ts",
    workerMaxOldSpaceMb: 6144,
  },
  // Task #3944: periodic/background execution paths (setInterval, node-cron,
  // supervised samplers, boot-seeded services) must not consume the
  // request-serving pool (`db`/`apiPool`) — worker boundary only. AST-based;
  // narrow per-file @periodic-request-pool-exception markers, pinned by
  // tests/lint-periodic-pool-ownership.test.ts.
  { name: "lint-periodic-pool-ownership", script: "scripts/lint-periodic-pool-ownership.ts" },
  // Task #3984: upload accept paths (ACL stamping / persisting request-supplied
  // /objects/ paths) outside the object_storage module must call
  // verifyObjectEntityContent — the Task #3964 server-side content check.
  { name: "lint-upload-content-verification", script: "scripts/lint-upload-content-verification.ts" },
  // Task #3951: whole-repository runtime import-cycle gate — traces the
  // static runtime import graph of server/ + shared/ with the repo-native
  // esbuild tracer and fails on ANY cycle, printing the complete cycle path.
  // Zero-cycle baseline, no allow-list.
  { name: "lint-server-import-cycles", script: "scripts/lint-server-import-cycles.ts" },
  // Task #3826: every registered test file (+ its extraNodeArgs setup files)
  // must parse under esbuild bundle-mode semantics — a committed unparseable
  // test fails every run as a vague "pre-existing failure" and poisons the
  // related-selection/fingerprint tracers. Parse-only (~6s), no execution,
  // no DB.
  { name: "lint-test-file-parseability", script: "scripts/lint-test-file-parseability.ts" },
  // Task #4201: raw-spread persistence boundary — new `.set({...x})`/
  // `.values({...x})` sites must show a Zod parse or carry a reviewed
  // spread-write-approved marker; F8 population frozen (hash-pinned).
  { name: "lint-persistence-spread-boundary", script: "scripts/lint-persistence-spread-boundary.ts" },
  { name: "lint-storage-update-boundary", script: "scripts/lint-storage-update-boundary.ts" },
  { name: "lint-test-fs-scan-inputs", script: "scripts/lint-test-fs-scan-inputs.ts" },
  { name: "lint-gate-workflow-drift", script: "scripts/lint-gate-workflow-drift.ts" },
  // Task #4207: Architecture Governor L3 guard — test files that combine
  // NOW()-relative fixture seeding (daysAgo/make_interval/interval') with
  // calendar month/week bucket assertions (YYYY-MM, date_trunc, .slice(0,7))
  // and whose fixture spread is <60 days can fail only in the first days of
  // a calendar month.
  { name: "lint-calendar-fixture-bucket-gap", script: "scripts/lint-calendar-fixture-bucket-gap.ts" },
  // Task #4347: design-contract count ratchets — the token fork in client/src
  // (hardcoded hex colors, arbitrary text-[Npx] sizes, off-contract rounded-*,
  // off-scale z-*) may only SHRINK vs the frozen baseline
  // scripts/design-contract-baseline.json (sole writer:
  // scripts/regen-design-contract-baseline.ts).
  { name: "lint-design-hex-colors", script: "scripts/lint-design-hex-colors.ts" },
  { name: "lint-design-text-px", script: "scripts/lint-design-text-px.ts" },
  { name: "lint-design-rounded", script: "scripts/lint-design-rounded.ts" },
  { name: "lint-design-z-index", script: "scripts/lint-design-z-index.ts" },
  // Task #4500: numeric fontSize literals below the sanctioned 10px
  // chart-internal label floor (recharts props evade the text-[Npx] ratchet).
  { name: "lint-design-chart-font-size", script: "scripts/lint-design-chart-font-size.ts" },
  { name: "lint-design-primary-white", script: "scripts/lint-design-primary-white.ts" },
  // Task #4929: brief-surface report-token guard — the NoBull Brief uses its
  // own `brief-*` palette; a future token sweep must not substitute `report-*`
  // tokens (different hex values) into CeoPulseVisual / CeoPulseLetter /
  // PublicCeoPulse.
  { name: "lint-brief-surface-report-tokens", script: "scripts/lint-brief-surface-report-tokens.ts" },
];

interface SpawnCheck {
  name: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /** Env keys DELETED from the composed child env after the parent-merge —
   * the only way an inherited variable can be refused (an env overlay can
   * only add or override, never remove). */
  unsetEnv?: string[];
}

/**
 * Scratch self-clean (Task #3794) — runs FIRST in every gate mode so the
 * worktree-hygiene lint validates the already-cleaned tree. Stale-only:
 * deletes untracked junk-pattern files + TTL/size-prunes the declared
 * scratch zones (.local/scratch/, tmp/) only. Kept OUTSIDE LINT_CHECKS on
 * purpose: it mutates the worktree (not a read-only lint) and must not run in
 * the lint worker pool.
 */
const CLEAN_SCRATCH: SpawnCheck = {
  name: "clean-scratch",
  cmd: "npx",
  args: ["tsx", "scripts/clean-scratch.ts", "--stale-only"],
};

const TYPECHECK: SpawnCheck = {
  name: "typecheck",
  cmd: "npm",
  args: ["run", "check"],
};

/**
 * Task #3755: related-only selection is the gate default; --full-smoke runs
 * the complete smoke set. Task #4531: merely OMITTING TEST_SMOKE_RELATED
 * here is not enough — runSpawnCheck composes the child env over the
 * parent's, so an inherited TEST_SMOKE_RELATED=1 would still reach
 * tests/run-all.ts and silently narrow an intended-full run. The builder
 * therefore (a) strips the variable from the composed child env via
 * unsetEnv and (b) passes --full-smoke through npm to the runner, whose
 * resolveSmokeSelection treats forced-full as authoritative over env state.
 * Exported (with composeSpawnEnv) so the duration-budget guard exercises
 * the REAL seam instead of a re-implementation.
 */
export function buildSmokeGateCheck(fullSmoke: boolean): SpawnCheck {
  return {
    name: "smoke-gate",
    cmd: "npm",
    args: fullSmoke ? ["test", "--", "--full-smoke"] : ["test"],
    env: {
      TEST_SMOKE: "1",
      TEST_FILE_TIMEOUT_MS: "180000",
      // Private per-gate artifacts prevent overlapping gate invocations from
      // reading each other's aggregate runner/attribution evidence. The gate
      // removes both after it appends the canonical bounded record.
      TEST_TASK_GATE_SWEEP_REPORT_PATH: GATE_SWEEP_REPORT_PATH,
      TEST_TASK_GATE_ATTRIBUTION_REPORT_PATH: GATE_ATTRIBUTION_REPORT_PATH,
      // Task #4501: blast-radius gate expansion — append non-smoke suites whose
      // import closure intersects the diff. Kill switch: TEST_GATE_EXPANSION=0.
      TEST_GATE_EXPANSION: "1",
      ...(fullSmoke ? {} : { TEST_SMOKE_RELATED: "1" }),
    },
    unsetEnv: fullSmoke ? ["TEST_SMOKE_RELATED"] : [],
  };
}

const SMOKE_GATE: SpawnCheck = buildSmokeGateCheck(FULL_SMOKE);

export interface Result {
  name: string;
  passed: boolean;
  durationMs: number;
}

export interface LintCheckResult extends Result {
  script: string;
  exitCode: number;
  output: { stream: "stdout" | "stderr"; text: string }[];
}

interface WorkerLintMessage {
  code: number;
  lines: { stream: "stdout" | "stderr"; text: string }[];
  durationMs: number;
}

/** Composes a SpawnCheck's child env: parent env overlaid with check.env,
 * then check.unsetEnv keys removed. Exported for the gate guard test. */
export function composeSpawnEnv(
  check: Pick<SpawnCheck, "env" | "unsetEnv">,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv, ...(check.env ?? {}) };
  for (const key of check.unsetEnv ?? []) delete env[key];
  return env;
}

function runSpawnCheck(check: SpawnCheck): Result {
  const start = Date.now();
  const env = composeSpawnEnv(check, process.env);
  const result = spawnSync(check.cmd, check.args, {
    stdio: "inherit",
    env,
    shell: false,
  });
  const durationMs = Date.now() - start;
  const passed = result.status === 0 && result.error == null;
  return { name: check.name, passed, durationMs };
}

function runLintWorker(check: LintCheck): Promise<LintCheckResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const worker = new Worker(WORKER_PATH, {
      workerData: { script: resolve(ROOT, check.script) },
      // Task #4650: per-check heap override (see LintCheck.workerMaxOldSpaceMb).
      // Spread conditionally so every check WITHOUT the field passes no
      // resourceLimits at all — byte-identical to the pre-#4650 spawn.
      ...(check.workerMaxOldSpaceMb !== undefined
        ? { resourceLimits: { maxOldGenerationSizeMb: check.workerMaxOldSpaceMb } }
        : {}),
    });
    let settled = false;
    let posted: WorkerLintMessage | null = null;
    const settle = (r: LintCheckResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(r);
    };
    worker.on("message", (msg: WorkerLintMessage) => {
      posted = msg;
    });
    worker.on("error", (err) => {
      settle({
        name: check.name,
        script: check.script,
        passed: false,
        exitCode: 95,
        durationMs: Date.now() - startedAt,
        output: [
          {
            stream: "stderr",
            text: `[gate] worker error for ${check.name}: ${err.stack ?? String(err)}`,
          },
        ],
      });
    });
    worker.on("exit", (exitCode) => {
      if (posted) {
        settle({
          name: check.name,
          script: check.script,
          passed: posted.code === 0,
          exitCode: posted.code,
          durationMs: Date.now() - startedAt,
          output: posted.lines,
        });
      } else {
        settle({
          name: check.name,
          script: check.script,
          passed: false,
          exitCode: exitCode || 94,
          durationMs: Date.now() - startedAt,
          output: [
            {
              stream: "stderr",
              text:
                `[gate] ${check.script} worker exited (code ${exitCode}) before posting a result — ` +
                `the module likely runs its CLI (or calls process.exit) at import time instead of ` +
                `exporting a side-effect-free cliMain().`,
            },
          ],
        });
      }
    });
  });
}

function defaultLintConcurrency(): number {
  const envRaw = Number(process.env.GATE_LINT_CONCURRENCY);
  if (Number.isFinite(envRaw) && envRaw >= 1) return Math.floor(envRaw);
  return Math.max(1, Math.min(availableParallelism(), 8));
}

export interface LintPhaseSink {
  out(text: string): void;
  err(text: string): void;
}

/**
 * Runs every check's cliMain() in a bounded worker-thread pool inside this
 * process. Per-check output is buffered by the worker and flushed here in
 * canonical LINT_CHECKS order (a check's block prints as soon as it and all
 * checks before it have finished), so output stays deterministic while
 * execution is concurrent.
 */
export async function runLintPhase(
  checks: readonly LintCheck[] = LINT_CHECKS,
  opts: { concurrency?: number; sink?: LintPhaseSink } = {},
): Promise<{ results: LintCheckResult[]; wallMs: number; concurrency: number }> {
  const sink: LintPhaseSink =
    opts.sink ?? {
      out: (t) => console.log(t),
      err: (t) => console.error(t),
    };
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? defaultLintConcurrency(), Math.max(checks.length, 1)),
  );
  const phaseStart = Date.now();
  const results: (LintCheckResult | undefined)[] = new Array(checks.length);

  let flushedThrough = 0;
  const flushReady = () => {
    while (flushedThrough < checks.length) {
      const r = results[flushedThrough];
      if (!r) return;
      sink.out(`--- [${r.name}]`);
      for (const line of r.output) {
        if (line.stream === "stderr") sink.err(line.text);
        else sink.out(line.text);
      }
      const icon = r.passed ? "✓" : "✗";
      sink.out(`    ${icon} ${r.name} (${formatDuration(r.durationMs)})`);
      // Task #4491 — remediation hint so failing lints stop requiring memory
      // archaeology (freshness lints name their registered generator).
      const remedy = checks[flushedThrough]?.remedy;
      if (!r.passed && remedy) sink.out(`      ↳ remedy: ${remedy}`);
      sink.out("");
      flushedThrough++;
    }
  };

  const runIndexes = async (
    indexes: readonly number[],
    laneConcurrency: number,
  ): Promise<void> => {
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < indexes.length) {
        const index = indexes[cursor++];
        const result = await runLintWorker(checks[index]);
        results[index] = result;
        flushReady();
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(laneConcurrency, Math.max(indexes.length, 1)) },
        () => runNext(),
      ),
    );
  };

  let index = 0;
  while (index < checks.length) {
    if (checks[index].exclusive) {
      await runIndexes([index], 1);
      index++;
      continue;
    }
    const concurrentIndexes: number[] = [];
    while (index < checks.length && !checks[index].exclusive) {
      concurrentIndexes.push(index);
      index++;
    }
    await runIndexes(concurrentIndexes, concurrency);
  }
  flushReady();

  return {
    results: results as LintCheckResult[],
    wallMs: Date.now() - phaseStart,
    concurrency,
  };
}

export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function persistTimings(results: Result[], mode: string, extra: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(TIMINGS_PATH), { recursive: true });
    writeFileSync(
      TIMINGS_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode,
          totalMs: results.reduce((sum, r) => sum + r.durationMs, 0),
          ...extra,
          checks: results.map((r) => ({
            name: r.name,
            passed: r.passed,
            durationMs: r.durationMs,
          })),
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort — timings must never fail the gate */
  }
}

export interface FreshSuiteDurationSummary {
  relatedSelection: boolean;
  centralIntegrityDeferred: boolean;
  executedCount: number;
  skippedCount: number;
  deferredCount: number;
  verificationComplete: boolean;
  quarantinedNonBlockingCount: number;
  railProof: {
    directAffected: { selected: number; executed: number; skippedGreen: number; deferred: number };
    core: { selected: number; executed: number; skippedGreen: number; deferred: number };
  };
  runner: TaskGatePerformanceSummary["runner"];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseRunnerPerformance(value: unknown): TaskGatePerformanceSummary["runner"] {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const fields = [
    "shardCount",
    "requestedShardCount",
    "activeLaneCount",
    "estimateKnownCount",
    "estimateUnknownCount",
    "plannedLaneTotalMs",
    "plannedLaneMinMs",
    "plannedLaneMaxMs",
    "actualLaneTotalMs",
    "actualLaneMinMs",
    "actualLaneMaxMs",
    "batchCompatibleFirstAttempts",
    "batchIncompatibleFirstAttempts",
    "batchedFirstAttempts",
    "soloFirstAttempts",
    "soloFirstAttemptElapsedMs",
    "batchedFailureSoloRechecks",
    "batchWorkerStarts",
    "batchWorkerReuses",
    "batchWorkerSuiteRuns",
    "batchWorkerPeakRssKb",
    "batchWorkerRecyclesHardCap",
    "batchWorkerRecyclesResourcePressure",
    "batchWorkerRecyclesFailure",
    "batchWorkerRecyclesStraggler",
  ] as const;
  if (!fields.every((field) => isNonNegativeInteger(p[field]))) return null;
  if (
    p.activeLaneCount > p.shardCount ||
    p.shardCount < 1 ||
    p.plannedLaneMinMs > p.plannedLaneMaxMs ||
    p.actualLaneMinMs > p.actualLaneMaxMs
  ) {
    return null;
  }
  const shardCountSource =
    typeof p.shardCountSource === "string" &&
    TASK_GATE_SHARD_COUNT_SOURCES.includes(
      p.shardCountSource as (typeof TASK_GATE_SHARD_COUNT_SOURCES)[number],
    )
      ? p.shardCountSource
      : undefined;
  const shardCapReasons =
    Array.isArray(p.shardCapReasons) && p.shardCapReasons.every((reason) =>
      TASK_GATE_SHARD_CAP_REASONS.includes(
        String(reason) as (typeof TASK_GATE_SHARD_CAP_REASONS)[number],
      ),
    )
      ? p.shardCapReasons as NonNullable<TaskGatePerformanceSummary["runner"]>["shardCapReasons"]
      : undefined;
  const databaseBudgetRaw = p.databaseBudget;
  const databaseBudget =
    databaseBudgetRaw &&
    typeof databaseBudgetRaw === "object" &&
    isNonNegativeInteger((databaseBudgetRaw as Record<string, unknown>).maxConnections) &&
    isNonNegativeInteger((databaseBudgetRaw as Record<string, unknown>).reservedConnections) &&
    isNonNegativeInteger((databaseBudgetRaw as Record<string, unknown>).connectionsPerLane) &&
    isNonNegativeInteger((databaseBudgetRaw as Record<string, unknown>).laneCap)
      ? databaseBudgetRaw as NonNullable<TaskGatePerformanceSummary["runner"]>["databaseBudget"]
      : undefined;
  return {
    shardCount: p.shardCount,
    requestedShardCount: p.requestedShardCount,
    shardCountSource,
    shardCapReasons,
    databaseBudget,
    activeLaneCount: p.activeLaneCount,
    estimateKnownCount: p.estimateKnownCount,
    estimateUnknownCount: p.estimateUnknownCount,
    plannedLaneTotalMs: p.plannedLaneTotalMs,
    plannedLaneMinMs: p.plannedLaneMinMs,
    plannedLaneMaxMs: p.plannedLaneMaxMs,
    actualLaneTotalMs: p.actualLaneTotalMs,
    actualLaneMinMs: p.actualLaneMinMs,
    actualLaneMaxMs: p.actualLaneMaxMs,
    batchCompatibleFirstAttempts: p.batchCompatibleFirstAttempts,
    batchIncompatibleFirstAttempts: p.batchIncompatibleFirstAttempts,
    batchedFirstAttempts: p.batchedFirstAttempts,
    soloFirstAttempts: p.soloFirstAttempts,
    soloFirstAttemptElapsedMs: p.soloFirstAttemptElapsedMs,
    batchedFailureSoloRechecks: p.batchedFailureSoloRechecks,
    batchWorkerStarts: p.batchWorkerStarts,
    batchWorkerReuses: p.batchWorkerReuses,
    batchWorkerSuiteRuns: p.batchWorkerSuiteRuns,
    batchWorkerPeakRssKb: p.batchWorkerPeakRssKb,
    batchWorkerRecyclesHardCap: p.batchWorkerRecyclesHardCap,
    batchWorkerRecyclesResourcePressure: p.batchWorkerRecyclesResourcePressure,
    batchWorkerRecyclesFailure: p.batchWorkerRecyclesFailure,
    batchWorkerRecyclesStraggler: p.batchWorkerRecyclesStraggler,
  };
}

function readFreshSuiteDurationSummary(gateStartedAtMs: number): FreshSuiteDurationSummary | null {
  try {
    const parsed = JSON.parse(readFileSync(GATE_SWEEP_REPORT_PATH, "utf8")) as {
      startedAt?: string;
      finishedAt?: string;
      mode?: string;
      relatedSelection?: boolean;
      centralIntegrityDeferred?: boolean;
      total?: number;
      skippedGreen?: number;
      deferredNotVerified?: number;
      verificationComplete?: boolean;
      quarantineSkippedFromGate?: number;
      taskGateRailProof?: FreshSuiteDurationSummary["railProof"];
      taskGatePerformance?: unknown;
    };
    const startedMs = Date.parse(parsed.startedAt ?? "");
    const finishedMs = Date.parse(parsed.finishedAt ?? "");
    const readAtMs = Date.now();
    if (
      !Number.isFinite(startedMs) ||
      !Number.isFinite(finishedMs) ||
      startedMs < gateStartedAtMs ||
      finishedMs < startedMs ||
      finishedMs > readAtMs + 1_000 ||
      parsed.mode !== "smoke"
    ) {
      return null;
    }
    if (
      typeof parsed.relatedSelection !== "boolean" ||
      typeof parsed.centralIntegrityDeferred !== "boolean" ||
      !Number.isInteger(parsed.total) ||
      Number(parsed.total) < 0 ||
      !Number.isInteger(parsed.skippedGreen) ||
      Number(parsed.skippedGreen) < 0 ||
      !Number.isInteger(parsed.deferredNotVerified) ||
      Number(parsed.deferredNotVerified) < 0 ||
      parsed.verificationComplete !== true ||
      !Number.isInteger(parsed.quarantineSkippedFromGate) ||
      Number(parsed.quarantineSkippedFromGate) < 0 ||
      !isRailProof(parsed.taskGateRailProof)
    ) {
      return null;
    }
    return {
      relatedSelection: parsed.relatedSelection,
      centralIntegrityDeferred: parsed.centralIntegrityDeferred,
      executedCount: Number(parsed.total),
      skippedCount: Number(parsed.skippedGreen),
      deferredCount: Number(parsed.deferredNotVerified),
      verificationComplete: parsed.verificationComplete,
      quarantinedNonBlockingCount: Number(parsed.quarantineSkippedFromGate),
      railProof: parsed.taskGateRailProof,
      runner: parseRunnerPerformance(parsed.taskGatePerformance),
    };
  } catch {
    return null;
  }
}

export function isRailProof(
  value: unknown,
): value is FreshSuiteDurationSummary["railProof"] {
  if (!value || typeof value !== "object") return false;
  for (const rail of ["directAffected", "core"] as const) {
    const counts = (value as Record<string, unknown>)[rail];
    if (!counts || typeof counts !== "object") return false;
    for (const key of ["selected", "executed", "skippedGreen", "deferred"]) {
      const count = (counts as Record<string, unknown>)[key];
      if (!Number.isInteger(count) || Number(count) < 0) return false;
    }
  }
  return true;
}

function readFreshAttributionSummary(
  gateStartedAtMs: number,
  results: readonly Result[],
  lintVerdicts: ReadonlyArray<{ name: string; verdict: "inherited" | "yours" }>,
): TaskGateAttributionSummary {
  const summary: TaskGateAttributionSummary = {
    inherited: 0,
    yours: 0,
    unattributable: 0,
    unknown: 0,
  };
  const representedChecks = new Set<string>();
  for (const verdict of lintVerdicts) {
    representedChecks.add(verdict.name);
    if (verdict.verdict === "inherited") summary.inherited++;
    else summary.yours++;
  }
  try {
    const parsed = JSON.parse(readFileSync(GATE_ATTRIBUTION_REPORT_PATH, "utf8")) as {
      generatedAt?: string;
      failures?: Array<{ verdict?: unknown }>;
    };
    const suiteGeneratedMs = Date.parse(parsed.generatedAt ?? "");
    if (
      Number.isFinite(suiteGeneratedMs) &&
      suiteGeneratedMs >= gateStartedAtMs &&
      suiteGeneratedMs <= Date.now() + 1_000
    ) {
      for (const failure of parsed.failures ?? []) {
        if (failure.verdict === "inherited") summary.inherited++;
        else if (failure.verdict === "unattributable") summary.unattributable++;
        else if (failure.verdict === "yours") summary.yours++;
        else summary.unknown++;
      }
      if ((parsed.failures?.length ?? 0) > 0) representedChecks.add(SMOKE_GATE.name);
    }
  } catch {
    // Missing/corrupt attribution is accounted for as unknown below.
  }

  for (const result of results) {
    if (!result.passed && !representedChecks.has(result.name)) summary.unknown++;
  }
  return summary;
}

function persistTaskGateEvidence(input: {
  gateStartedAtMs: number;
  validatedSource:
    | { validatedCommit: string; validatedTree: string }
    | undefined;
  results: readonly Result[];
  verdict: "pass" | "fail";
  lintVerdicts: ReadonlyArray<{ name: string; verdict: "inherited" | "yours" }>;
  performance: TaskGatePerformanceSummary["lint"];
}): { effectiveVerdict: "pass" | "fail"; blockingReasons: string[] } {
  const finishedAtMs = Date.now();
  const suiteSummary = !NO_SMOKE && !LINT_ONLY
    ? readFreshSuiteDurationSummary(input.gateStartedAtMs)
    : null;
  const selectionMode: TaskGateSelectionMode = LINT_ONLY
    ? "lint-only"
    : NO_SMOKE
      ? "smoke-skipped"
      : FULL_SMOKE
        ? "full-smoke"
        : suiteSummary === null
          ? "smoke-unresolved"
          : suiteSummary.relatedSelection
            ? suiteSummary.centralIntegrityDeferred
              ? "deferred-central-integrity"
              : "related-smoke"
            : "full-smoke";
  const testControlPlaneChanged = currentTaskTouchesTaskControlPlane();
  const fullIntegrityVerified =
    FULL_SMOKE && process.env.TEST_FORCE_ALL === "1";
  const policy = classifyTaskGateDisposition({
    gatePassed: input.verdict === "pass",
    verificationComplete:
      NO_SMOKE || LINT_ONLY ? true : suiteSummary?.verificationComplete === true,
    selectionTrusted:
      NO_SMOKE || LINT_ONLY
        ? true
        : suiteSummary !== null && selectionMode !== "smoke-unresolved",
    // A deferred suite can only be emitted by the existing reason-gated
    // planner after positively stale accepted-green evidence. If that
    // invariant changes, this classifier deliberately turns the record red.
    proofStatus:
      suiteSummary?.centralIntegrityDeferred
        ? "central-integrity"
        : (suiteSummary?.deferredCount ?? 0) > 0
          ? "stale-rotation"
          : "accepted-green",
    // The runner's terminal accounting is the authoritative confirmation that
    // related, core, expansion, and quarantine-readded suites produced a
    // complete result. A missing/incomplete report fails each rail closed.
    directlyAffectedUnverified:
      !NO_SMOKE && !LINT_ONLY && !mandatoryRailWasExecuted(suiteSummary?.railProof.directAffected),
    coreGuardUnverified:
      !NO_SMOKE && !LINT_ONLY && !mandatoryRailWasExecuted(suiteSummary?.railProof.core),
    testControlPlaneChanged,
    fullIntegrityVerified,
    centralIntegrityDeferred: suiteSummary?.centralIntegrityDeferred === true,
    executedAndPassed:
      input.verdict === "pass" && (suiteSummary === null || suiteSummary.executedCount > 0),
    reusedAcceptedGreenEvidence: (suiteSummary?.skippedCount ?? 0) > 0,
    deferredNotVerified:
      suiteSummary?.centralIntegrityDeferred === true ||
      (suiteSummary?.deferredCount ?? 0) > 0,
    quarantinedNonBlocking: (suiteSummary?.quarantinedNonBlockingCount ?? 0) > 0,
  });
  console.log(
    `[task-gate] disposition=${policy.primaryDisposition}; ` +
      `observed=${policy.dispositions.join(",")}` +
      (policy.blockingReasons.length > 0 ? `; blockingReasons=${policy.blockingReasons.join("|")}` : ""),
  );
  const effectiveVerdict = policy.primaryDisposition === "blocking-failure"
    ? "fail"
    : input.verdict;
  const endingSource = input.validatedSource
    ? captureTaskGateSource(ROOT)
    : undefined;
  const validatedSource =
    input.validatedSource &&
    endingSource?.validatedCommit === input.validatedSource.validatedCommit &&
    endingSource.validatedTree === input.validatedSource.validatedTree
      ? input.validatedSource
      : undefined;
  const provenance = buildTaskGateProvenance({
    taskRef: process.env.TASK_GATE_TASK_REF,
    validatedCommit: validatedSource?.validatedCommit,
    validatedTree: validatedSource?.validatedTree,
  });
  const record: TaskGateEvidenceRecord = {
    schemaVersion: TASK_GATE_EVIDENCE_SCHEMA_VERSION,
    observationId: GATE_OBSERVATION_ID,
    startedAt: new Date(input.gateStartedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    wallMs: finishedAtMs - input.gateStartedAtMs,
    selectionMode,
    executedCount: suiteSummary?.executedCount ?? 0,
    skippedCount: suiteSummary?.skippedCount ?? 0,
    deferredCount: suiteSummary?.deferredCount ?? 0,
    verdict: effectiveVerdict,
    primaryDisposition: policy.primaryDisposition,
    dispositions: policy.dispositions,
    attribution: readFreshAttributionSummary(
      input.gateStartedAtMs,
      input.results,
      input.lintVerdicts,
    ),
    ...(provenance ? { provenance } : {}),
    performance: {
      lint: input.performance,
      runner: suiteSummary?.runner ?? null,
      resources: (() => {
        try {
          const usage = process.resourceUsage();
          return {
            maxRssKb: Math.max(0, Math.trunc(usage.maxRSS)),
            cpuUserMicros: Math.max(0, Math.trunc(usage.userCPUTime)),
            cpuSystemMicros: Math.max(0, Math.trunc(usage.systemCPUTime)),
          };
        } catch {
          return { maxRssKb: 0, cpuUserMicros: 0, cpuSystemMicros: 0 };
        }
      })(),
    },
  };
  if (!appendTaskGateEvidence(record)) {
    console.warn("[gate-evidence] could not persist the completed-gate evidence record (gate verdict unchanged).");
  }
  console.log(
    `[gate-evidence] observationId=${record.observationId}` +
      (record.provenance
        ? `; taskRef=${record.provenance.taskRef}; validatedCommit=${record.provenance.validatedCommit}; validatedTree=${record.provenance.validatedTree}`
        : "; provenance=unknown"),
  );
  for (const path of [GATE_SWEEP_REPORT_PATH, GATE_ATTRIBUTION_REPORT_PATH]) {
    try {
      unlinkSync(path);
    } catch {
      /* absent/already removed — no private artifact to clean */
    }
  }
  return { effectiveVerdict, blockingReasons: policy.blockingReasons };
}


const CACHE_ELIGIBLE_LINTS = new Set([
  "lint-async-correctness",
  "lint-react-hooks",
  "lint-bundle-budget",
]);

function summarizeLintPerformance(
  lintPhase: Awaited<ReturnType<typeof runLintPhase>>,
): TaskGatePerformanceSummary["lint"] {
  const eligible = lintPhase.results.filter((result) => CACHE_ELIGIBLE_LINTS.has(result.name));
  const hits = eligible.filter((result) =>
    result.output.some((line) => line.text.includes("reused cached green verdict")),
  ).length;
  return {
    wallMs: Math.max(0, Math.trunc(lintPhase.wallMs)),
    concurrency: Math.max(1, Math.trunc(lintPhase.concurrency)),
    cacheEligibleChecks: eligible.length,
    cacheHitChecks: hits,
    cacheMissChecks: eligible.length - hits,
  };
}

async function main(): Promise<number> {
  const gateStartedAtMs = GATE_INVOCATION_STARTED_AT_MS;
  const validatedSource = process.env.TASK_GATE_TASK_REF
    ? captureTaskGateSource(ROOT)
    : undefined;
  const totalChecks =
    1 + (LINT_ONLY ? 0 : 1) + LINT_CHECKS.length + (!NO_SMOKE && !LINT_ONLY ? 1 : 0);
  const smokeMode = NO_SMOKE
    ? " (smoke skipped)"
    : LINT_ONLY
      ? " (lint only)"
      : FULL_SMOKE
        ? " (full smoke)"
        : " (related smoke — pass --full-smoke for the complete set)";
  console.log(`\n==> gate: running ${totalChecks} check(s)${smokeMode}\n`);

  const results: Result[] = [];

  // Scratch self-clean FIRST in every mode (Task #3794): the worktree-hygiene
  // lint below then validates the already-cleaned tree, so every task
  // self-cleans at final validation.
  console.log(`--- [${CLEAN_SCRATCH.name}]`);
  const cleanScratchResult = runSpawnCheck(CLEAN_SCRATCH);
  results.push(cleanScratchResult);
  console.log(
    `    ${cleanScratchResult.passed ? "✓" : "✗"} ${cleanScratchResult.name} (${formatDuration(cleanScratchResult.durationMs)})\n`,
  );

  if (!LINT_ONLY) {
    console.log(`--- [${TYPECHECK.name}]`);
    const r = runSpawnCheck(TYPECHECK);
    results.push(r);
    console.log(`    ${r.passed ? "✓" : "✗"} ${r.name} (${formatDuration(r.durationMs)})\n`);
  }

  const lintPhase = await runLintPhase();
  const lintPerformance = summarizeLintPerformance(lintPhase);
  const lintResults = lintPhase.results.map((r) => ({
    name: r.name,
    passed: r.passed,
    durationMs: r.durationMs,
  }));
  results.push(...lintResults);
  console.log(
    `    lint phase: ${lintPhase.results.length} checks in ${formatDuration(lintPhase.wallMs)} (concurrency ${lintPhase.concurrency}, single process)\n`,
  );

  // Task #4531 (L3-approved gate policy): the lint phase carries a committed
  // wall budget (tests/gate-duration-budget.json, gateLintWallBudgetMs).
  // Fixed per-gate costs are the part of gate wall every task pays on every
  // attempt. Task #5030 revision: an aggregate wall breach is a loud
  // NON-BLOCKING alert — green stays green — recorded to the breach ledger
  // (server/services/regressionSweep.ts), from which the sweep scheduler
  // auto-files ONE re-baseline/triage item per stale-budget episode. A
  // missing artifact is a warn-only bootstrap state; an invalid one remains
  // a hard failure. Kill switch: TEST_DURATION_BUDGET=0. (Measured against
  // lintPhase.wallMs — the #4491 rails re-runs below are excluded.)
  if (process.env.TEST_DURATION_BUDGET !== "0") {
    const budget = loadDurationBudgetArtifact("tests/gate-duration-budget.json");
    if (budget.ok) {
      if (lintPhase.wallMs > budget.artifact.gateLintWallBudgetMs) {
        console.error(
          `    ⚠ ALERT (non-blocking): lint phase wall ${formatDuration(lintPhase.wallMs)} exceeds the committed budget ` +
            `${formatDuration(budget.artifact.gateLintWallBudgetMs)} (tests/gate-duration-budget.json; Task #4531, revised #5030). ` +
            `Green stays green — a breach event was recorded and a re-baseline/triage item will be auto-filed. ` +
            `Remedy: make the lint phase cheaper (e.g. the green-verdict cache), or change policy via a reviewed ` +
            `edit to PINNED_MAXIMA in tests/durationBudget.ts + regen.\n`,
        );
        appendDurationBudgetBreachEvent({
          observedAt: new Date().toISOString(),
          source: "gate-lint-wall",
          wallMs: lintPhase.wallMs,
          budgetMs: budget.artifact.gateLintWallBudgetMs,
          budgetGeneratedAt: budget.artifact.generatedAt,
          mode: "lint",
          suiteCount: 0,
        });
      } else {
        console.log(
          `    lint phase within budget: ${formatDuration(lintPhase.wallMs)} ≤ ${formatDuration(budget.artifact.gateLintWallBudgetMs)} (tests/gate-duration-budget.json)\n`,
        );
      }
    } else if (!budget.missing) {
      results.push({ name: "lint-phase-wall-budget", passed: false, durationMs: 0 });
      console.error(`    ✗ duration-budget artifact invalid — ${budget.error}\n`);
    } else {
      console.log(
        `    (no committed duration-budget artifact yet — lint-phase budget skipped; regen: npx tsx scripts/regen-gate-duration-budget.ts)\n`,
      );
    }
  }

  // Task #4491 — on lint reds: (1) self-heal registered generated-artifact
  // freshness lints (regen → re-verify → artifact-only commit), then (2)
  // base-tree A/B attribution with audited excusal for fully-inherited reds.
  // Everything falls open to "yours"; rails never throw.
  let excusedLintNames = new Set<string>();
  let lintAttributionVerdicts: Array<{
    name: string;
    verdict: "inherited" | "yours";
  }> = [];
  let lintRailsWallMs = 0;
  const lintPhaseFailures = lintPhase.results.filter((r) => !r.passed);
  if (lintPhaseFailures.length > 0) {
    const rails = await runGateLintFailureRails({
      failures: lintPhaseFailures.map((r) => ({
        name: r.name,
        script: r.script,
        exitCode: r.exitCode,
        outputText: r.output.map((o) => o.text).join("\n"),
      })),
      relint: async (check) => {
        const rerun = await runLintPhase([{ name: check.name, script: check.script }]);
        return rerun.results[0]?.passed === true;
      },
    });
    lintRailsWallMs = rails.wallMs;
    for (const name of rails.healedLints) {
      const entry = lintResults.find((r) => r.name === name);
      if (entry) entry.passed = true;
    }
    excusedLintNames = rails.excusedLints;
    lintAttributionVerdicts = rails.verdicts.map((verdict) => ({
      name: verdict.name,
      verdict: verdict.verdict,
    }));
    if (rails.summaryLines.length > 0) {
      console.log("");
      for (const line of rails.summaryLines) console.log(line);
      console.log("");
    }
  }

  if (!NO_SMOKE && !LINT_ONLY) {
    console.log(`--- [${SMOKE_GATE.name}]`);
    const r = runSpawnCheck(SMOKE_GATE);
    results.push(r);
    console.log(`    ${r.passed ? "✓" : "✗"} ${r.name} (${formatDuration(r.durationMs)})\n`);
  }

  const passed = results.filter((r) => r.passed);
  // Task #4491 — excused lint reds (fully inherited from the base tree, with
  // evidence in the attribution report) stay visibly listed but stop blocking
  // the smoke gate. Anything else red still fails.
  const failed = results.filter((r) => !r.passed && !excusedLintNames.has(r.name));
  const excused = results.filter((r) => !r.passed && excusedLintNames.has(r.name));

  console.log("=== gate summary ===");
  for (const r of results) {
    const icon = r.passed ? "✓" : excusedLintNames.has(r.name) ? "≈" : "✗";
    const suffix = !r.passed && excusedLintNames.has(r.name)
      ? "   ← excused (inherited from base tree; needs ONE fix on main)"
      : "";
    console.log(`  ${icon} ${r.name.padEnd(42)} ${formatDuration(r.durationMs)}${suffix}`);
  }
  console.log("");

  printFailureAttributionPointers(
    results,
    gateStartedAtMs,
    GATE_ATTRIBUTION_REPORT_PATH,
  );

  recordGateDiffProvenance();

  persistTimings(results, smokeMode.trim().replace(/^\(|\)$/g, "") || "full gate", {
    lintPhaseWallMs: lintPhase.wallMs,
    lintConcurrency: lintPhase.concurrency,
    lintRailsWallMs,
  });

  if (failed.length === 0) {
    const evidence = persistTaskGateEvidence({
      gateStartedAtMs,
      validatedSource,
      results,
      verdict: "pass",
      lintVerdicts: lintAttributionVerdicts,
      performance: lintPerformance,
    });
    if (evidence.effectiveVerdict === "fail") {
      console.error(
        `gate: FAIL — task-validation policy blocked completion: ${evidence.blockingReasons.join("; ")}\n`,
      );
      return 1;
    }
    if (excused.length > 0) {
      console.log(
        `gate: PASS — ${passed.length} checks passed; ${excused.length} lint red(s) EXCUSED as inherited from the base tree ` +
          `(evidence: .local/runs/attribution-report.json §lints).\n` +
          `⚠ Excused lint(s) [${excused.map((r) => r.name).join(", ")}] need ONE fix on main — file/flag it there instead of patching every task.\n`,
      );
      return 0;
    }
    console.log(`gate: PASS — all ${passed.length} checks passed.\n`);
    return 0;
  }
  persistTaskGateEvidence({
    gateStartedAtMs,
    validatedSource,
    results,
    verdict: "fail",
    lintVerdicts: lintAttributionVerdicts,
    performance: lintPerformance,
  });
  console.error(`gate: FAIL — ${failed.length} of ${results.length} check(s) failed:`);
  for (const r of failed) {
    console.error(`  ✗ ${r.name}`);
  }
  if (excused.length > 0) {
    console.error(
      `  (${excused.length} additional lint red(s) excused as inherited: ${excused.map((r) => r.name).join(", ")})`,
    );
  }
  console.error("");
  return 1;
}

/**
 * Task #3922 — post-summary pointers to the failure-attribution evidence, so
 * an agent staring at a red gate is routed to the machine-readable reports
 * instead of re-deriving innocence proofs by hand. Reads (a) the runner's
 * attribution report — written by tests/run-all.ts whenever the smoke gate
 * had hard failures, and only trusted here when generated during THIS gate
 * run — and (b) the post-merge integrity report for inherited typecheck
 * breakage. Best-effort: never throws, never changes the gate verdict.
 */
function printFailureAttributionPointers(
  results: Result[],
  gateStartedAtMs: number,
  attributionReportPath: string = resolve(ROOT, ".local/runs/attribution-report.json"),
): void {
  try {
    const smoke = results.find((r) => r.name === SMOKE_GATE.name);
    if (smoke) {
      const raw = readFileSync(attributionReportPath, "utf8");
      const attr = JSON.parse(raw) as {
        generatedAt?: string;
        excusedCount?: number;
        blockingCount?: number;
        // Task #4480 — staleness of the upstream red manifest at attribution
        // time; when stale, "blocking" includes unattributable failures that
        // canNOT honestly be called "yours".
        manifest?: { stale?: boolean | null; ageDays?: number | null };
        failures?: Array<{ verdict?: string }>;
      } | null;
      const generatedMs = Date.parse(attr?.generatedAt ?? "");
      const fresh = Number.isFinite(generatedMs) && generatedMs >= gateStartedAtMs;
      if (attr && fresh) {
        const excused = Number(attr.excusedCount ?? 0);
        const blocking = Number(attr.blockingCount ?? 0);
        const privateGateEvidence =
          attributionReportPath === GATE_ATTRIBUTION_REPORT_PATH;
        const evidencePointer = privateGateEvidence
          ? "inspect the per-suite attribution in the smoke output above; this gate's aggregate is retained in .local/runs/task-gate-evidence.jsonl (`npx tsx scripts/report-task-gate-evidence.ts --json`)"
          : "read .local/runs/attribution-report.json";
        if (smoke.passed && excused > 0) {
          console.log(
            `[gate] smoke-gate passed WITH ${excused} excused inherited failure(s) — ${evidencePointer}.`,
          );
          console.log("");
        } else if (!smoke.passed) {
          const unattributable = (attr.failures ?? []).filter((f) => f?.verdict === "unattributable").length;
          const stale = attr.manifest?.stale === true;
          const yoursCount = blocking - unattributable;
          console.log(
            stale
              ? `[gate] smoke-gate failure attribution: ${yoursCount} blocking (yours) / ${unattributable} UNATTRIBUTABLE (stale baseline) / ${excused} excused (inherited) — ${evidencePointer} BEFORE hand-diagnosing; inherited reds get ONE fix on main, not N task-side fixes.`
              : `[gate] smoke-gate failure attribution: ${blocking} blocking (yours) / ${excused} excused (inherited) — ${evidencePointer} BEFORE hand-diagnosing; inherited reds get ONE fix on main, not N task-side fixes.`,
          );
          if (stale) {
            const age = attr.manifest?.ageDays;
            console.log(
              `[gate] ⚠ STALE BASELINE: upstream red manifest is ${typeof age === "number" ? `${age.toFixed(1)}d old` : "unparseably dated"} — the nightly publisher has not run since (main may itself be red); UNATTRIBUTABLE failures cannot be proven yours OR main's. Verify via a worktree-at-HEAD repro before hand-fixing.`,
            );
          }
          console.log("");
        }
      }
    }
  } catch {
    /* no fresh attribution report — nothing to point at */
  }
  try {
    const typecheck = results.find((r) => r.name === TYPECHECK.name);
    if (typecheck && !typecheck.passed) {
      const raw = readFileSync(resolve(ROOT, ".local/runs/merge-integrity.json"), "utf8");
      const rep = JSON.parse(raw) as {
        generatedAt?: string;
        typecheck?: { errorFilesNotTaskTouched?: string[] };
      } | null;
      const inherited = rep?.typecheck?.errorFilesNotTaskTouched ?? [];
      if (Array.isArray(inherited) && inherited.length > 0) {
        console.log(
          `[gate] typecheck: the last merge-integrity check (${rep?.generatedAt ?? "?"}) found ${inherited.length} error file(s) NOT touched by this task — likely inherited from a system merge; see .local/runs/merge-integrity.json.`,
        );
        console.log("");
      }
    }
  } catch {
    /* no merge-integrity report — nothing to add */
  }
}

/**
 * Task #5317 — auto-wire Task #5316's live diff-provenance tool into every
 * gate run, so the "your diff contains unrelated changes" rebuttal evidence
 * always exists by completion-review time without anyone remembering to run
 * the standalone CLI. Reuses `buildProvenanceReport` (which itself reuses
 * `gateLintAttribution.resolveBaseTree`) verbatim — no second base-resolution
 * mechanism. Computed fresh on every call (never reused from a stale cache)
 * and written to a FIXED, well-known path (unlike the per-invocation-private
 * `GATE_*_REPORT_PATH` scratch paths above), so it's always where an agent
 * expects it. Same best-effort contract as `printFailureAttributionPointers`:
 * best-effort, try/caught, never throws, never changes the gate verdict — a
 * failure to compute or write degrades to silence, never a gate error.
 *
 * `compute` and `reportPath` are injectable so
 * tests/gate-diff-provenance-wiring.test.ts can assert exactly-once call
 * semantics, the written report shape, and that an injected throwing
 * `compute` never escapes this function, without depending on live git
 * state or writing into the real `.local/runs/` path.
 */
export function recordGateDiffProvenance(
  compute: (opts: {
    repoRoot: string;
    flaggedPaths: readonly string[];
  }) => ProvenanceReport = buildProvenanceReport,
  reportPath: string = GATE_DIFF_PROVENANCE_REPORT_PATH,
): void {
  // A failed/partial run must never leave a STALE report sitting at this
  // fixed path where a later reviewer would mistake old evidence for fresh
  // — that would silently violate the "never cached" contract this report
  // advertises. So: write to a private temp file and rename it into place
  // atomically (a crash mid-write can't leave a half-written file at
  // `reportPath`), and on ANY failure — compute, mkdir, write, or rename —
  // remove whatever currently sits at `reportPath` so the absence of a
  // report is the visible signal, never a wrong one.
  const tmpPath = `${reportPath}.${process.pid}.tmp`;
  try {
    const report = compute({ repoRoot: ROOT, flaggedPaths: [] });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    renameSync(tmpPath, reportPath);
    console.log(
      `[gate] live diff-provenance evidence (fresh, HEAD vs upstream tip — never cached): .local/runs/gate-diff-provenance.json — cite this if a completion review flags "unrelated changes" instead of hand-running git archaeology (TASK_PREFLIGHT.md §12.9).`,
    );
    console.log("");
  } catch {
    /* best-effort evidence only — never let this affect the gate verdict.
       Clean up both the target and any orphaned temp file so a failure
       degrades to "no report" rather than risking a stale/partial one. */
    for (const p of [reportPath, tmpPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* already absent — fine either way */
      }
    }
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("scripts/gate.ts") ?? false);

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error("[gate] crashed:", err);
      process.exit(1);
    },
  );
}
