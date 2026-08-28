/**
 * Task #3755 — Related-only smoke gate selection engine.
 *
 * The routine smoke gate (`TEST_SMOKE=1 npm test`, run by `npm run gate` on
 * every task) historically executed every SMOKE_FILES entry no matter what
 * the task touched. That set grows with nearly every task, the full run
 * outlives the 300s shell budget, and most of it is irrelevant to any given
 * change. This module computes, for a given smoke-test universe, the subset
 * whose import graph reaches the files the current task actually changed.
 *
 * Selection contract (see tests/smoke-related-selection.test.ts):
 *
 *   1. Changed files = git diff vs a base (merge-base with main when on a
 *      task branch, `SMOKE_RELATED_BASE` env override when set, origin/main
 *      when present) UNION working-tree changes (staged, unstaged, untracked).
 *      In a task environment work stays uncommitted on `main` until the
 *      platform's pre-merge commit, so the working-tree component is the
 *      primary signal there.
 *   2. Each smoke test's import closure is traced in ONE shared esbuild
 *      trace pass (a frontier BFS of batched parse-only builds — see
 *      traceImportClosures): entry points are the test file plus any local
 *      setup / hook files referenced by its registered `extraNodeArgs` (e.g.
 *      `--import ./tests/foo-setup.mjs`). `@/` and `@shared/` aliases are
 *      resolved like tsconfig does; bare package imports stay external;
 *      literal dynamic imports ARE followed (esbuild records them as
 *      `dynamic-import` edges). Non-literal dynamic imports and paths only
 *      referenced as strings (module.register loader targets) are invisible
 *      to tracing — the global-trigger + unattributable-file rules below
 *      cover those conservatively.
 *   3. A test is selected when its closure intersects the changed set, with
 *      a per-test reason naming the changed file that pulled it in.
 *   4. Global-trigger paths (migrations/, shared/schema*, package.json,
 *      lockfile, tsconfig*, .replit, harness scripts (gate.ts, the gate
 *      lint worker, lint-*, predeploy.sh, post-merge.sh — NOT all of
 *      scripts/, Task #3789), tests/run-all.ts, tests/helpers/, this
 *      selector, core db bootstrap, test-runner deps) defer broad coverage to
 *      central integrity: they can affect any test without appearing in any
 *      import closure.
 *   5. Every failure of the machinery — git unavailable, base ref invalid,
 *      esbuild trace error, unparseable file — produces an explicit deferred
 *      outcome, never silently zero coverage or an automatic full-suite run.
 *      The bounded result keeps directly identifiable tests and the core set.
 *   6. A non-empty changed set that reaches no smoke test still runs the
 *      always-run CORE subset (repo-scanning lint-guard tests + explicitly
 *      listed cross-cutting invariants, which read source via fs and are
 *      invisible to import tracing) and says so loudly.
 *
 * The engine is pure with injectable seams (git runner, env, repo root,
 * trigger/core overrides) so the gated regression test can drive every path
 * against a throwaway fixture repo without touching the real git state.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import * as esbuild from "esbuild";
import ts from "typescript";

export interface SmokeTestEntry {
  file: string;
  extraNodeArgs?: string[];
  /** Task #4103: repo-root-relative files/dirs this suite reads via fs at
   * runtime (registration `scanPaths`). Invisible to import tracing, so the
   * selector matches changed files against them directly. */
  scanPaths?: string[];
}

/** Task #4103: does a changed repo-relative file fall under one of a suite's
 * declared scanPaths (exact file match, or inside a declared directory)? */
export function scanPathHit(changedFile: string, scanPaths: readonly string[] | undefined): string | null {
  if (!scanPaths) return null;
  for (const p of scanPaths) {
    if (changedFile === p || changedFile.startsWith(p + "/")) return p;
  }
  return null;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

export type GitRunner = (args: string[]) => GitResult;

export interface GlobalTrigger {
  /** Exact repo-relative path, or prefix ending in "/", or "startsWith:" token. */
  kind: "exact" | "prefix";
  path: string;
  why: string;
}

export interface CoreRule {
  kind: "pattern" | "exact";
  /** For "pattern": RegExp source tested against the repo-relative file. */
  value: string;
  why: string;
}

export interface SelectionDeps {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  runGit?: GitRunner;
  globalTriggers?: GlobalTrigger[];
  coreRules?: CoreRule[];
  /** Task #4560: hard budget for the import trace (same stall protection as
   * the Task #4547 blast-radius expansion). Defaults to
   * SMOKE_RELATED_TRACE_TIMEOUT_MS or 120s. On timeout the selection falls
   * produce a deferred result with an honest deferredReason. */
  traceTimeoutMs?: number;
  /** Injectable tracer seam (tests exercise the timeout path with it). */
  traceFn?: typeof traceImportClosures;
  /**
   * The deliberately closed set of generated artifacts whose generator
   * inputs and guard suites can be attributed precisely. Tests may inject a
   * fixture contract; production uses DEFAULT_ARTIFACT_OWNERSHIP.
   */
  artifactOwnership?: ArtifactOwnershipContract[];
  /** Executes the real freshness proof for a matched artifact owner. Fixture
   * tests inject a repo-local equivalent; production uses the named lint. */
  artifactFreshnessVerifier?: ArtifactFreshnessVerifier;
}

export interface SelectedTest {
  file: string;
  reason: string;
}

export interface SelectionManifest {
  schemaVersion: 1;
  generatedAt: string;
  /** "related" = trusted narrow proof; "deferred" = bounded proof plus central debt. */
  mode: "related" | "deferred";
  /** Why broad coverage was deferred (mode === "deferred" only). */
  deferredReason: string | null;
  /** The existing post-merge/nightly/weekly lane owns deferred broad coverage. */
  deferredOwner: "post-merge/nightly/weekly" | null;
  /** Legacy alias for deferredReason retained for old report readers. */
  fullReason: string | null;
  /** Human description of the git diff base used for the changed set. */
  baseDescription: string | null;
  changedFiles: string[];
  universeCount: number;
  selectedCount: number;
  skippedCount: number;
  selected: SelectedTest[];
  notes: string[];
}

export interface ArtifactPathRule {
  kind: "exact" | "prefix";
  path: string;
}

/**
 * Explicit ownership contract for a generated artifact family.
 *
 * This is intentionally more verbose than a filename convention. An artifact
 * is trusted only when its outputs, generator, freshness guard, and named
 * guard suites all exist and the source files still mention the relationship.
 * Unknown generated-looking files therefore never become precise by accident.
 */
export interface ArtifactOwnershipContract {
  id: string;
  artifactPaths: readonly string[];
  generatorPaths: readonly string[];
  inputPaths: readonly ArtifactPathRule[];
  freshnessGuardPaths: readonly string[];
  guardSuites: readonly string[];
  /** Explicit upstream artifact families whose outputs this generator consumes. */
  dependsOnOwners?: readonly string[];
}

export interface ArtifactOwnershipVerification {
  ok: boolean;
  evidence: string[];
  problems: string[];
}

export type ArtifactFreshnessVerifier = (
  owner: ArtifactOwnershipContract,
  repoRoot: string,
) => Promise<ArtifactOwnershipVerification> | ArtifactOwnershipVerification;

/**
 * The only generated-artifact families currently admitted to precise
 * related-smoke selection. Keep this list closed: adding another family
 * requires a generator, freshness guard, and named guard-suite coverage.
 */
export const DEFAULT_ARTIFACT_OWNERSHIP: readonly ArtifactOwnershipContract[] = [
  {
    id: "route-inventory",
    artifactPaths: ["tests/route-inventory.json", "tests/route-inventory-report.md"],
    generatorPaths: ["scripts/regen-route-inventory.mjs", "tests/route-inventory.ts"],
    inputPaths: [
      { kind: "exact", path: "server/routes.ts" },
      { kind: "prefix", path: "server/routes/" },
    ],
    freshnessGuardPaths: ["scripts/lint-route-inventory-freshness.ts"],
    guardSuites: [
      "tests/lint-route-inventory-freshness.test.ts",
      "tests/post-merge-route-inventory-refresh.test.ts",
    ],
  },
  {
    id: "endpoint-contract-table",
    artifactPaths: [
      "audits/D-endpoint-contract-table.md",
      "audits/D-endpoint-contract-table.json",
    ],
    generatorPaths: [
      "scripts/generate-endpoint-contract-table.mjs",
      "scripts/contract-table-classifiers.mjs",
    ],
    inputPaths: [
      { kind: "exact", path: "tests/route-inventory.json" },
      { kind: "exact", path: "scripts/generate-endpoint-contract-table.mjs" },
      { kind: "exact", path: "scripts/contract-table-classifiers.mjs" },
      // The endpoint generator scans these filesystem trees for callers and
      // route handlers; they must remain explicit ownership inputs rather
      // than relying on import tracing.
      { kind: "prefix", path: "client/src/" },
      { kind: "prefix", path: "scripts/" },
      { kind: "prefix", path: "tests/" },
      { kind: "prefix", path: "server/services/" },
      { kind: "exact", path: "server/routes.ts" },
      { kind: "prefix", path: "server/routes/" },
    ],
    freshnessGuardPaths: ["scripts/lint-contract-table-freshness.ts"],
    guardSuites: [
      "tests/lint-contract-table-freshness.test.ts",
      "tests/post-merge-generated-artifact-refresh.test.ts",
    ],
    dependsOnOwners: ["route-inventory"],
  },
  {
    id: "test-portfolio-baseline",
    artifactPaths: ["audits/governance/test-portfolio-baseline.json"],
    generatorPaths: [
      "scripts/generate-test-portfolio-baseline.ts",
      "scripts/governanceInventoryLib.ts",
    ],
    // The portfolio guard's declared scanPaths covers the complete tests tree.
    // These exact files are the non-import generator inputs whose change must
    // also verify the generated inventory.
    inputPaths: [
      { kind: "exact", path: "tests/testRegistry.ts" },
      { kind: "exact", path: "scripts/governanceInventoryLib.ts" },
    ],
    freshnessGuardPaths: ["scripts/generate-test-portfolio-baseline.ts"],
    guardSuites: ["tests/governance-test-portfolio-baseline.test.ts"],
  },
];

/**
 * Paths whose change can affect any test without appearing in any import
 * closure. Matching any of these widens the run to the FULL smoke set.
 */
export const DEFAULT_GLOBAL_TRIGGERS: GlobalTrigger[] = [
  { kind: "prefix", path: "migrations/", why: "DB migrations affect every DB-backed test" },
  { kind: "exact", path: "shared/schema.ts", why: "DB schema affects every DB-backed test" },
  { kind: "prefix", path: "shared/schema/", why: "DB schema modules affect every DB-backed test" },
  { kind: "exact", path: "package.json", why: "dependency/script change affects everything" },
  { kind: "exact", path: "package-lock.json", why: "dependency change affects everything" },
  { kind: "prefix", path: "tsconfig", why: "TS config changes module resolution for everything" },
  { kind: "exact", path: ".replit", why: "workflow/run config change" },
  { kind: "exact", path: "vite.config.ts", why: "bundler aliases/config affect client tests" },
  { kind: "exact", path: "drizzle.config.ts", why: "DB tooling config affects every DB-backed test" },
  // Task #3789: `scripts/` used to be one blanket prefix trigger, so editing
  // ANY script — including one-off backfill/analysis scripts that cannot
  // affect the harness — forced the FULL smoke set. Only harness-relevant
  // scripts remain global triggers; other scripts flow through normal import
  // tracing, and lint scripts' own guard tests are core rules anyway.
  { kind: "exact", path: "scripts/gate.ts", why: "the gate runner itself changed" },
  { kind: "exact", path: "scripts/gate-lint-worker.mjs", why: "the gate's lint worker bootstrap changed" },
  { kind: "exact", path: "scripts/taskGatePolicy.ts", why: "task-gate disposition policy changed" },
  { kind: "exact", path: "scripts/taskGateEvidence.ts", why: "task-gate evidence contract changed" },
  { kind: "exact", path: "scripts/report-task-gate-evidence.ts", why: "task-gate evidence report changed" },
  { kind: "exact", path: "scripts/gateLintAttribution.ts", why: "gate attribution policy changed" },
  { kind: "exact", path: "scripts/regen-gate-duration-budget.ts", why: "gate duration budget policy changed" },
  { kind: "prefix", path: "scripts/lint-", why: "lint scripts/baselines define what the gate checks" },
  { kind: "exact", path: "scripts/predeploy.sh", why: "the deploy gate script changed" },
  { kind: "exact", path: "scripts/post-merge.sh", why: "the post-merge setup script changed" },
  { kind: "exact", path: "scripts/post-merge-canary.ts", why: "the post-merge canary runner changed (Task #4501)" },
  { kind: "exact", path: "tests/run-all.ts", why: "the test runner itself changed" },
  { kind: "exact", path: "tests/relatedSmokeSelection.ts", why: "the selection engine itself changed" },
  { kind: "exact", path: "tests/durationBudget.ts", why: "duration-budget selection policy changed" },
  { kind: "exact", path: "tests/redManifest.ts", why: "gate red-attribution policy changed" },
  // Task #3791: the fingerprint/green-skip engine decides which suites
  // EXECUTE at all; treat it like the runner itself.
  { kind: "exact", path: "tests/suiteFingerprint.ts", why: "the incremental green-skip fingerprint engine changed" },
  // Task #3786: the registry module discovers/parses every per-test
  // registration block; a parsing change can alter the whole derived
  // registry, so treat it like the runner itself.
  { kind: "exact", path: "tests/testRegistry.ts", why: "the test-registration parser/discovery changed" },
  { kind: "prefix", path: "tests/helpers/", why: "shared test helpers can be loaded outside import graphs" },
  { kind: "exact", path: "server/db.ts", why: "core db bootstrap affects every DB-backed test" },
  { kind: "exact", path: "server/devMigrations.ts", why: "dev-migration bootstrap affects every DB-backed test" },
  { kind: "exact", path: "server/services/regressionSweep.ts", why: "test-run reporting dependency of the runner" },
  { kind: "exact", path: "server/services/regressionSweepScheduler.ts", why: "central integrity scheduler changed" },
  // Task #5028: a quarantine-policy change rewires which suites block the gate.
  { kind: "exact", path: "tests/flakeQuarantine.ts", why: "auto-quarantine state machine — a runner-behavior module (Task #5028)" },
];

/**
 * Always-run core: cross-cutting invariant tests whose SUBJECT is read via
 * fs at runtime (git ls-files / readFileSync of source trees), so no import
 * closure can ever connect them to a change. Skipping them on "unrelated"
 * changes is exactly how they would rot. Convention: a smoke test that scans
 * repo sources instead of importing its subject must be named
 * `tests/lint-*.test.ts` (picked up by the pattern) or be listed here
 * explicitly.
 */
export const DEFAULT_CORE_RULES: CoreRule[] = [
  {
    kind: "pattern",
    value: "^tests/lint-[^/]+\\.test\\.tsx?$",
    why: "repo-scanning lint guard (reads source via fs, invisible to import tracing)",
  },
  {
    kind: "exact",
    value: "tests/work-queue-required-handlers.test.ts",
    why: "parses server/index.ts + server/boot/* via fs to enforce the required-handlers gate",
  },
  {
    kind: "exact",
    value: "tests/smoke-related-selection.test.ts",
    why: "guards the related-selection engine itself",
  },
  {
    kind: "exact",
    value: "tests/incremental-green-skip.test.ts",
    why: "guards the incremental green-skip engine itself (Task #3791)",
  },
  {
    kind: "exact",
    value: "tests/rate-limit-coverage.test.ts",
    why: "repo-wide rate-limit coverage invariant — scans server route files via fs (invisible to import tracing); green-skipping it let uncovered sensitive-write routes land (Task #4091)",
  },
  {
    kind: "exact",
    value: "tests/rate-limit-exempt-category.test.ts",
    why: "source-guards server/index.ts + server/boot/* via fs for the exempt-category registration; fs subjects are invisible to import tracing (Task #4091)",
  },
  {
    kind: "exact",
    value: "tests/upstream-red-attribution.test.ts",
    why: "guards the red-manifest attribution/excusal rails (scans run-all wiring via fs, Task #3922)",
  },
  {
    kind: "exact",
    value: "tests/full-lane-deferral.test.ts",
    why: "guards the rotation-day deferral + wall-alert policy engine itself (scans run-all/gate wiring via fs, Task #5030)",
  },
];

/** Run-artifact paths that must never count as task changes. */
const IGNORED_CHANGED_PREFIXES = [".local/"];

/** Production git runner (exported so the selector test drives the real parsing). */
export function makeGitRunner(repoRoot: string): GitRunner {
  return (args: string[]): GitResult => {
    const res = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) return { ok: false, stdout: "", error: String(res.error) };
    if (res.status !== 0) {
      return { ok: false, stdout: res.stdout ?? "", error: (res.stderr || `git exited ${res.status}`).trim() };
    }
    return { ok: true, stdout: res.stdout ?? "" };
  };
}

function normalizeRepoPath(p: string): string {
  let out = p.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

export interface ChangedFilesResult {
  ok: boolean;
  files: string[];
  baseDescription: string;
  error?: string;
}

/**
 * Compute the changed-file set: committed + tracked changes vs a base ref
 * (when one can be established) plus all working-tree changes including
 * untracked files. Any git failure returns ok:false so the caller falls
 * open to the full set.
 */
export function computeChangedFiles(runGit: GitRunner, env: NodeJS.ProcessEnv): ChangedFilesResult {
  const fail = (error: string): ChangedFilesResult => ({ ok: false, files: [], baseDescription: "", error });

  const revParseOk = (ref: string): boolean => runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;

  let base: string | null = null;
  let baseDescription: string;

  const envBase = (env.SMOKE_RELATED_BASE ?? "").trim();
  if (envBase) {
    if (!revParseOk(envBase)) return fail(`SMOKE_RELATED_BASE=${envBase} is not a resolvable commit`);
    const mb = runGit(["merge-base", envBase, "HEAD"]);
    if (!mb.ok) return fail(`merge-base ${envBase} HEAD failed: ${mb.error}`);
    base = mb.stdout.trim();
    baseDescription = `SMOKE_RELATED_BASE=${envBase} (merge-base ${base.slice(0, 10)})`;
  } else {
    const branchRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branchRes.ok) return fail(`git rev-parse --abbrev-ref HEAD failed: ${branchRes.error}`);
    const branch = branchRes.stdout.trim();
    if (branch !== "main" && revParseOk("main")) {
      const mb = runGit(["merge-base", "main", "HEAD"]);
      if (!mb.ok) return fail(`merge-base main HEAD failed: ${mb.error}`);
      base = mb.stdout.trim();
      baseDescription = `merge-base with main (${base.slice(0, 10)}) from branch ${branch}`;
    } else if (revParseOk("origin/main")) {
      const mb = runGit(["merge-base", "origin/main", "HEAD"]);
      if (!mb.ok) return fail(`merge-base origin/main HEAD failed: ${mb.error}`);
      base = mb.stdout.trim();
      baseDescription = `merge-base with origin/main (${base.slice(0, 10)})`;
    } else {
      // Task env on `main` with no remote-tracking main: work is uncommitted
      // until the platform's pre-merge commit, so the working tree IS the
      // change set.
      baseDescription = "working tree only (on main, no origin/main — task-env mode)";
    }
  }

  const files = new Set<string>();

  if (base) {
    const diff = runGit(["diff", "--name-only", "--no-renames", "-z", base]);
    if (!diff.ok) return fail(`git diff vs ${base.slice(0, 10)} failed: ${diff.error}`);
    for (const raw of diff.stdout.split("\0")) {
      const p = normalizeRepoPath(raw);
      if (p) files.add(p);
    }
  }

  const status = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  if (!status.ok) return fail(`git status failed: ${status.error}`);
  for (const raw of status.stdout.split("\0")) {
    if (!raw) continue;
    // Entry shape with --no-renames: "XY <path>" (XY = 2 status chars).
    if (raw.length < 4) continue;
    const p = normalizeRepoPath(raw.slice(3));
    if (p) files.add(p);
  }

  const filtered = [...files]
    .filter((f) => !IGNORED_CHANGED_PREFIXES.some((pre) => f.startsWith(pre)))
    .sort();

  return { ok: true, files: filtered, baseDescription };
}

export function matchGlobalTrigger(file: string, triggers: GlobalTrigger[]): GlobalTrigger | null {
  for (const t of triggers) {
    if (t.kind === "exact" && file === t.path) return t;
    if (t.kind === "prefix" && file.startsWith(t.path)) return t;
  }
  return null;
}

/**
 * Local setup/hook files referenced by a test's registered extraNodeArgs
 * (e.g. `--import ./tests/foo-setup.mjs`). Flag names and non-path tokens
 * are ignored; only local script-looking paths are returned.
 */
export function extraNodeArgsEntryFiles(extraNodeArgs: string[] | undefined): string[] {
  if (!extraNodeArgs) return [];
  const out: string[] = [];
  for (const arg of extraNodeArgs) {
    if (arg.startsWith("-")) continue;
    if (!/\.(mjs|cjs|js|ts|tsx)$/.test(arg)) continue;
    if (!arg.includes("/")) continue;
    out.push(normalizeRepoPath(arg));
  }
  return out;
}

export interface TraceResult {
  ok: boolean;
  /** entry (repo-relative) → every repo-relative file in its import closure. */
  closures: Map<string, Set<string>>;
  /**
   * importer (repo-relative) → import specifiers that could not be resolved.
   * Populated only under `tolerateUnresolvable` (Task #3791): the fingerprint
   * engine uses it to mark just the affected suites non-skippable instead of
   * failing the whole trace. Without the option an unresolvable import is a
   * trace failure, exactly as before.
   */
  unresolved?: Map<string, string[]>;
  error?: string;
}

/** Extensions stubbed out during tracing: content is irrelevant, but their
 * edges are still recorded, so path-level matching keeps working. */
const EMPTY_LOADER_EXTS = [
  ".css", ".scss", ".sass", ".less",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".mov",
  ".pdf", ".node", ".wasm", ".md", ".txt", ".html",
];

/** File kinds we parse for further imports. Everything else (json, assets)
 * is a leaf: its edge is recorded for path-level matching but never loaded. */
const PARSEABLE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** pluginData sentinel that lets our own build.resolve() calls fall through
 * to esbuild's native resolver instead of re-entering the onResolve hook. */
const RESOLVE_PASSTHROUGH = { relatedSmokePassthrough: true };

/**
 * Trace the static import closure of every entry with a frontier BFS: each
 * round, ONE esbuild pass parses only the frontier files while an onResolve
 * hook resolves every edge (aliases `@/` → client/src and `@shared/` →
 * shared, extension probing via esbuild's own resolver), records it, and
 * externalizes it. Externalizing means esbuild never LINKS the importee, so
 * named-export validation cannot fail the trace — essential because several
 * smoke tests import test-only hooks from modules their runtime loader shims
 * replace (e.g. `__setParseReportPdf`), which a naive bundling pass rejects
 * with id-less, unsilenceable "No matching export" errors. Bare package /
 * builtin imports stay external without an edge; literal dynamic imports are
 * followed; an unresolvable relative import is a trace failure (fall open).
 *
 * Under `tolerateUnresolvable` (the fingerprinting caller, Task #3791),
 * unresolvable imports and per-file build errors do NOT fail the trace:
 * they are recorded per-importer in `unresolved`, which marks the affected
 * suites unskippable while the rest of the universe fingerprints normally.
 */
export async function traceImportClosures(
  entries: string[],
  repoRoot: string,
  opts: { tolerateUnresolvable?: boolean } = {},
): Promise<TraceResult> {
  const unique = [...new Set(entries.map(normalizeRepoPath))];
  if (unique.length === 0) return { ok: true, closures: new Map(), unresolved: new Map() };

  for (const entryRel of unique) {
    if (!existsSync(resolve(repoRoot, entryRel))) {
      return { ok: false, closures: new Map(), error: `entry ${entryRel} does not exist` };
    }
  }

  const loader: Record<string, esbuild.Loader> = {};
  for (const ext of EMPTY_LOADER_EXTS) loader[ext] = "empty";

  const rootPrefix = resolve(repoRoot) + sep;
  const toRel = (abs: string): string => normalizeRepoPath(relative(repoRoot, abs));

  /** repo-relative importer → repo-relative importees (assets included). */
  const edges = new Map<string, Set<string>>();
  const addEdge = (importerAbs: string, importeeAbs: string): void => {
    const importer = toRel(importerAbs);
    let set = edges.get(importer);
    if (!set) {
      set = new Set();
      edges.set(importer, set);
    }
    set.add(toRel(importeeAbs));
  };

  const scheduled = new Set<string>(unique.map((e) => resolve(repoRoot, e)));
  let frontier = [...scheduled];
  const unresolvable: string[] = [];
  const unresolvedByImporter = new Map<string, string[]>();

  while (frontier.length > 0) {
    const next = new Set<string>();
    try {
      await esbuild.build({
        entryPoints: frontier,
        bundle: true,
        write: false,
        outdir: resolve(tmpdir(), "related-smoke-trace-out"),
        platform: "node",
        format: "esm",
        target: "esnext",
        jsx: "automatic",
        logLevel: "silent",
        absWorkingDir: repoRoot,
        loader,
        plugins: [
          {
            name: "related-smoke-edge-recorder",
            setup(build) {
              build.onResolve({ filter: /.*/ }, async (args) => {
                if (args.pluginData === RESOLVE_PASSTHROUGH) return undefined;
                if (args.kind === "entry-point") return undefined;

                // Alias mapping (mirrors tsconfig paths).
                let spec = args.path;
                let resolveDir = args.resolveDir;
                if (spec.startsWith("@/")) {
                  spec = `./client/src/${spec.slice(2)}`;
                  resolveDir = repoRoot;
                } else if (spec.startsWith("@shared/")) {
                  spec = `./shared/${spec.slice("@shared/".length)}`;
                  resolveDir = repoRoot;
                }

                // Bare package / node builtin: external, no edge.
                if (!spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/")) {
                  return { path: args.path, external: true };
                }

                const resolved = await build.resolve(spec, {
                  resolveDir,
                  importer: args.importer,
                  kind: args.kind,
                  pluginData: RESOLVE_PASSTHROUGH,
                });
                if (resolved.errors.length > 0 || !resolved.path) {
                  unresolvable.push(`cannot resolve "${args.path}" imported from ${toRel(args.importer)}`);
                  const importerRel = toRel(args.importer);
                  const list = unresolvedByImporter.get(importerRel) ?? [];
                  list.push(args.path);
                  unresolvedByImporter.set(importerRel, list);
                  return { path: args.path, external: true };
                }

                const abs = resolve(resolved.path);
                const insideRepo = abs.startsWith(rootPrefix) && !abs.includes(`${sep}node_modules${sep}`);
                if (!insideRepo) return { path: abs, external: true };

                addEdge(args.importer, abs);
                if (PARSEABLE_RE.test(abs) && !scheduled.has(abs)) {
                  scheduled.add(abs);
                  next.add(abs);
                }
                return { path: abs, external: true };
              });
            },
          },
        ],
      });
    } catch (err) {
      const errorList =
        err && typeof err === "object" && Array.isArray((err as { errors?: esbuild.Message[] }).errors)
          ? (err as { errors: esbuild.Message[] }).errors
          : null;

      // Tolerant mode (Task #3791): a per-file BUILD error (e.g. a syntax /
      // const-reassignment parse error in ONE test file) must not disable
      // fingerprinting for the whole universe. esbuild only parses frontier
      // files (imports are externalized), so a located error is attributable
      // to a specific frontier file: poison it (recorded as an unresolved
      // input, making it and every dependent suite unskippable) and retry the
      // round without it, carrying forward imports discovered before the
      // failure. Errors without a location still fail the trace (fall open).
      if (opts.tolerateUnresolvable && errorList) {
        const locFiles = new Set<string>();
        for (const m of errorList) {
          if (m.location?.file) locFiles.add(normalizeRepoPath(m.location.file));
        }
        const survivors = frontier.filter((abs) => !locFiles.has(toRel(abs)));
        if (locFiles.size > 0 && survivors.length < frontier.length) {
          for (const rel of locFiles) {
            const msgs = errorList
              .filter((m) => m.location && normalizeRepoPath(m.location.file) === rel)
              .slice(0, 3)
              .map((m) => `<build error: ${m.text}>`);
            const list = unresolvedByImporter.get(rel) ?? [];
            list.push(...(msgs.length > 0 ? msgs : ["<build error>"]));
            unresolvedByImporter.set(rel, list);
          }
          // Imports resolved before the round died are in `next`/`scheduled`
          // but were never traced — re-frontier them or closures silently
          // narrow (missing inputs would mean wrong fingerprints).
          frontier = [...new Set([...survivors, ...next])];
          continue;
        }
      }

      const messages = errorList
        ? errorList
            .slice(0, 5)
            .map((e) => `${e.text}${e.location ? ` @ ${e.location.file}:${e.location.line}` : ""}`)
            .join("; ")
        : String(err);
      return { ok: false, closures: new Map(), error: `esbuild trace failed: ${messages}` };
    }
    if (!opts.tolerateUnresolvable && unresolvable.length > 0) {
      return {
        ok: false,
        closures: new Map(),
        error: `esbuild trace failed: ${unresolvable.slice(0, 5).join("; ")}`,
      };
    }
    frontier = [...next];
  }

  const closures = new Map<string, Set<string>>();
  for (const entryRel of unique) {
    const key = normalizeRepoPath(relative(repoRoot, resolve(repoRoot, entryRel)));
    const seen = new Set<string>();
    const stack = [key];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const imp of edges.get(cur) ?? []) stack.push(imp);
    }
    closures.set(entryRel, seen);
  }
  return { ok: true, closures, unresolved: unresolvedByImporter };
}

/** Exported for the Task #3791 fingerprint engine: the always-run core set
 * must be exempt from green-skipping in EVERY mode, using these same rules. */
export function coreReason(file: string, rules: CoreRule[]): string | null {
  for (const rule of rules) {
    if (rule.kind === "exact" && file === rule.value) return rule.why;
    if (rule.kind === "pattern" && new RegExp(rule.value).test(file)) return rule.why;
  }
  return null;
}

function artifactPathRuleHit(file: string, rule: ArtifactPathRule): boolean {
  return rule.kind === "exact" ? file === rule.path : file.startsWith(rule.path);
}

function isGeneratedArtifactCandidate(file: string): boolean {
  // This is detection only, never trust. The explicit ownership records above
  // are the sole path to precision; anything else in these artifact-heavy
  // trees falls open so a newly introduced output cannot be skipped.
  if (!file.startsWith("tests/") && !file.startsWith("audits/")) return false;
  if (!/\.(json|md)$/.test(file) || /\.test\.tsx?$/.test(file)) return false;
  return true;
}

/**
 * A report can be a deliberately authored test input rather than a generated
 * artifact. Keep that exception precise: the registration must name the exact
 * file and the selected guard's source must also name it. A directory
 * scanPath, or a registration-only claim, never bypasses generated-artifact
 * ownership verification.
 */
function hasExactNodeFsRead(source: string, file: string): boolean {
  const parsed = ts.createSourceFile("evidence-reader.ts", source, ts.ScriptTarget.Latest, true);
  const importsReadFileSync = parsed.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "node:fs" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === "readFileSync" && (element.propertyName?.text ?? "readFileSync") === "readFileSync",
      ),
  );
  if (!importsReadFileSync) return false;

  let readsExactFile = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "readFileSync"
    ) {
      const target = node.arguments[0];
      if (
        target &&
        (
          (ts.isStringLiteral(target) && target.text === file) ||
          (ts.isCallExpression(target) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === "join" &&
            target.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === file))
        )
      ) {
        readsExactFile = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return readsExactFile;
}
function exactAuthoredEvidenceReaders(
  file: string,
  tests: readonly SmokeTestEntry[],
  repoRoot: string,
): string[] {
  const normalizedFile = normalizeRepoPath(file);
  const readers: string[] = [];
  for (const test of tests) {
    if (!test.scanPaths?.some((scanPath) => normalizeRepoPath(scanPath) === normalizedFile)) continue;
    try {
      const source = readFileSync(resolve(repoRoot, normalizeRepoPath(test.file)), "utf8");
      if (hasExactNodeFsRead(source, normalizedFile)) readers.push(normalizeRepoPath(test.file));
    } catch {
      // Missing guard source is handled by import tracing; it cannot earn the
      // authored-evidence exception here.
    }
  }
  return readers;
}
function uniqueNormalizedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeRepoPath))];
}

/**
 * Verify the closed ownership contract against the current repository and
 * test universe. This deliberately checks source references instead of
 * accepting a self-declared exception: a renamed generator, removed freshness
 * lint, missing output, or unregistered guard suite all force full smoke.
 */
export function verifyArtifactOwnershipContract(
  owner: ArtifactOwnershipContract,
  repoRoot: string,
  tests: readonly SmokeTestEntry[] = [],
): ArtifactOwnershipVerification {
  const evidence: string[] = [];
  const problems: string[] = [];
  const fail = (problem: string): void => {
    problems.push(problem);
  };
  const validRelPath = (p: string, allowTrailingSlash = false): boolean =>
    p.length > 0 &&
    !p.startsWith("/") &&
    !p.startsWith("./") &&
    !p.split("/").includes("..") &&
    (allowTrailingSlash || !p.endsWith("/"));
  const readRepoFile = (rel: string): string | null => {
    if (!validRelPath(rel) || !existsSync(resolve(repoRoot, rel))) return null;
    try {
      return readFileSync(resolve(repoRoot, rel), "utf8");
    } catch {
      return null;
    }
  };

  if (!owner.id.trim()) fail("ownership record has an empty id");
  const outputs = uniqueNormalizedPaths(owner.artifactPaths);
  if (outputs.length === 0 || outputs.length !== owner.artifactPaths.length) {
    fail("ownership record has no unique artifact paths");
  }
  const generators = uniqueNormalizedPaths(owner.generatorPaths);
  const freshnessGuards = uniqueNormalizedPaths(owner.freshnessGuardPaths);
  const guardSuites = uniqueNormalizedPaths(owner.guardSuites);
  if (generators.length === 0) fail("ownership record has no generator paths");
  if (freshnessGuards.length === 0) fail("ownership record has no freshness guard paths");
  if (guardSuites.length === 0) fail("ownership record has no named guard suites");
  if (owner.inputPaths.length === 0) fail("ownership record has no generator inputs");

  for (const p of outputs) {
    if (!validRelPath(p)) fail(`invalid artifact path "${p}"`);
    const source = readRepoFile(p);
    if (source === null) {
      fail(`artifact "${p}" is missing or unreadable`);
      continue;
    }
    if (p.endsWith(".json")) {
      try {
        JSON.parse(source);
      } catch {
        fail(`artifact "${p}" is malformed JSON`);
      }
    } else if (source.trim() === "") {
      fail(`artifact "${p}" is empty`);
    }
  }

  for (const p of generators) {
    const source = readRepoFile(p);
    if (source === null) {
      fail(`generator "${p}" is missing or unreadable`);
    } else {
      evidence.push(`generator ${p}`);
    }
  }
  const primaryGenerator = generators[0] ? readRepoFile(generators[0]) : null;
  if (primaryGenerator !== null && outputs.some((output) => !primaryGenerator.includes(output))) {
    fail(`primary generator "${generators[0]}" does not reference every owned artifact output`);
  }

  for (const p of freshnessGuards) {
    const source = readRepoFile(p);
    if (source === null) {
      fail(`freshness guard "${p}" is missing or unreadable`);
      continue;
    }
    if (!outputs.every((output) => source.includes(output))) {
      fail(`freshness guard "${p}" does not reference every owned artifact output`);
    }
    evidence.push(`freshness guard ${p}`);
  }

  const availableSuites = new Set(tests.map((t) => normalizeRepoPath(t.file)));
  for (const suite of guardSuites) {
    if (tests.length > 0 && !availableSuites.has(suite)) {
      fail(`guard suite "${suite}" is not in the smoke universe`);
    }
    if (readRepoFile(suite) === null) fail(`guard suite "${suite}" is missing or unreadable`);
    else evidence.push(`guard suite ${suite}`);
  }

  const seenInputs = new Set<string>();
  for (const input of owner.inputPaths) {
    const p = normalizeRepoPath(input.path);
    if (
      !validRelPath(p, input.kind === "prefix") ||
      (input.kind !== "exact" && input.kind !== "prefix")
    ) {
      fail(`invalid generator input rule "${input.kind}:${input.path}"`);
      continue;
    }
    const key = `${input.kind}:${p}`;
    if (seenInputs.has(key)) fail(`duplicate generator input rule "${key}"`);
    seenInputs.add(key);
    if (input.kind === "exact" && readRepoFile(p) === null) {
      fail(`generator input "${p}" is missing or unreadable`);
    } else if (input.kind === "prefix" && !existsSync(resolve(repoRoot, p))) {
      fail(`generator input prefix "${p}" is missing`);
    }
  }

  if (problems.length === 0) {
    evidence.unshift(`verified ownership contract ${owner.id}`);
  }
  return { ok: problems.length === 0, evidence, problems };
}

/**
 * Run the actual, family-specific freshness guard before accepting an artifact
 * change as precise. Structural ownership evidence is not enough: valid JSON
 * can still be stale. This only runs for a matched owner and therefore does
 * not add work to ordinary related selections.
 */
export async function verifyArtifactFreshness(
  owner: ArtifactOwnershipContract,
  repoRoot: string,
): Promise<ArtifactOwnershipVerification> {
  if (resolve(repoRoot) !== resolve(process.cwd())) {
    return {
      ok: false,
      evidence: [],
      problems: [`cannot run ${owner.id} freshness guard outside the current repository root`],
    };
  }
  try {
    if (owner.id === "route-inventory") {
      const { runLint } = await import("../scripts/lint-route-inventory-freshness");
      const result = runLint();
      return {
        ok: result.ok,
        evidence: result.ok
          ? [`freshness verified by scripts/lint-route-inventory-freshness.ts (${result.freshCount} routes)`]
          : [],
        problems: result.problems,
      };
    }
    if (owner.id === "endpoint-contract-table") {
      const { runLint } = await import("../scripts/lint-contract-table-freshness");
      const result = runLint();
      return {
        ok: result.ok,
        evidence: result.ok
          ? [`freshness verified by scripts/lint-contract-table-freshness.ts (${result.inventoryCount} routes)`]
          : [],
        problems: result.problems,
      };
    }
    if (owner.id === "test-portfolio-baseline") {
      const [{ generate, ARTIFACT_PATH }, { checkArtifact }] = await Promise.all([
        import("../scripts/generate-test-portfolio-baseline"),
        import("../scripts/governanceInventoryLib"),
      ]);
      const result = checkArtifact(ARTIFACT_PATH, generate());
      return {
        ok: result.ok,
        evidence: result.ok
          ? ["freshness verified by scripts/generate-test-portfolio-baseline.ts --check"]
          : [],
        problems: result.problems,
      };
    }
  } catch (error) {
    return {
      ok: false,
      evidence: [],
      problems: [`freshness guard crashed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  return {
    ok: false,
    evidence: [],
    problems: [`no runtime freshness verifier is registered for ${owner.id}`],
  };
}

function ownershipSetProblems(owners: readonly ArtifactOwnershipContract[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const outputs = new Map<string, string>();
  const guards = new Map<string, string>();
  for (const owner of owners) {
    if (ids.has(owner.id)) problems.push(`duplicate ownership id "${owner.id}"`);
    ids.add(owner.id);
    for (const output of owner.artifactPaths.map(normalizeRepoPath)) {
      const prior = outputs.get(output);
      if (prior) problems.push(`artifact "${output}" is owned by both ${prior} and ${owner.id}`);
      outputs.set(output, owner.id);
    }
    for (const suite of owner.guardSuites.map(normalizeRepoPath)) {
      const prior = guards.get(suite);
      if (prior) problems.push(`guard suite "${suite}" is claimed by both ${prior} and ${owner.id}`);
      guards.set(suite, owner.id);
    }
  }
  for (const owner of owners) {
    for (const dependency of owner.dependsOnOwners ?? []) {
      if (!ids.has(dependency) || dependency === owner.id) {
        problems.push(`owner ${owner.id} declares an unknown or self dependency "${dependency}"`);
      }
    }
  }
  const byId = new Map(owners.map((owner) => [owner.id, owner] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      problems.push(`ownership dependency cycle includes "${id}"`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOnOwners ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const owner of owners) visit(owner.id);
  return problems;
}

function artifactOutputHit(file: string, owner: ArtifactOwnershipContract): string | null {
  return owner.artifactPaths
    .map(normalizeRepoPath)
    .find((output) => file === output || file.startsWith(output + "/")) ?? null;
}

function artifactInputHit(file: string, owner: ArtifactOwnershipContract): ArtifactPathRule | null {
  return owner.inputPaths.find((input) =>
    artifactPathRuleHit(file, { ...input, path: normalizeRepoPath(input.path) }),
  ) ?? null;
}

function matchedOwnershipIsUnambiguous(
  matches: readonly ArtifactOwnershipContract[],
  file: string,
): string | null {
  if (matches.length <= 1) return null;
  const outputOwners = matches.filter((owner) => artifactOutputHit(file, owner) !== null);
  if (outputOwners.length === 0) {
    // A source path may be read by an upstream generator and by a dependent
    // generator directly. That overlap is precise only when all matched
    // non-root owners explicitly name the single upstream root.
    const roots = matches.filter(
      (owner) => !matches.some((candidate) => owner.dependsOnOwners?.includes(candidate.id)),
    );
    if (
      roots.length === 1 &&
      matches.every(
        (owner) =>
          owner.id === roots[0].id || owner.dependsOnOwners?.includes(roots[0].id),
      )
    ) {
      return null;
    }
    return `ownership ambiguity: ${file} matches ${matches.map((owner) => owner.id).join(", ")}`;
  }
  if (outputOwners.length !== 1) {
    return `ownership ambiguity: ${file} matches ${matches.map((owner) => owner.id).join(", ")}`;
  }
  const outputOwner = outputOwners[0];
  for (const owner of matches) {
    if (owner.id === outputOwner.id) continue;
    const isInputOnly =
      artifactOutputHit(file, owner) === null && artifactInputHit(file, owner) !== null;
    if (!isInputOnly || !owner.dependsOnOwners?.includes(outputOwner.id)) {
      return `ownership ambiguity: ${file} matches ${matches.map((candidate) => candidate.id).join(", ")}`;
    }
  }
  return null;
}

/**
 * Returns every declared non-import input for an ownership guard suite.
 * Incremental-green fingerprints use this to ensure a regenerated artifact
 * guard cannot be skipped after its generator, source tree, or output moves.
 * Any invalid contract deliberately makes the caller execute the suite.
 */
export function generatedArtifactOwnershipInputsForSuite(
  suiteFile: string,
  repoRoot: string,
  owners: readonly ArtifactOwnershipContract[] = DEFAULT_ARTIFACT_OWNERSHIP,
): { ok: true; inputs: string[]; families: string[] } | { ok: false; error: string } {
  const normalizedSuite = normalizeRepoPath(suiteFile);
  const directOwningFamilies = owners.filter((owner) =>
    owner.guardSuites.map(normalizeRepoPath).includes(normalizedSuite),
  );
  if (directOwningFamilies.length === 0) return { ok: true, inputs: [], families: [] };

  const problems = ownershipSetProblems(owners);
  const universe = owners.flatMap((owner) => owner.guardSuites).map((file) => ({ file }));
  for (const owner of owners) {
    const verification = verifyArtifactOwnershipContract(owner, repoRoot, universe);
    problems.push(...verification.problems.map((problem) => `${owner.id}: ${problem}`));
  }
  if (problems.length > 0) {
    return { ok: false, error: `generated artifact ownership invalid: ${[...new Set(problems)].join("; ")}` };
  }

  const files = new Set<string>();
  const owningFamilies = new Map(directOwningFamilies.map((owner) => [owner.id, owner] as const));
  const byId = new Map(owners.map((owner) => [owner.id, owner] as const));
  const addDependencies = (owner: ArtifactOwnershipContract): void => {
    for (const dependency of owner.dependsOnOwners ?? []) {
      const upstream = byId.get(dependency);
      if (upstream && !owningFamilies.has(upstream.id)) {
        owningFamilies.set(upstream.id, upstream);
        addDependencies(upstream);
      }
    }
  };
  for (const owner of directOwningFamilies) addDependencies(owner);
  const addTree = (path: string): void => {
    const rel = normalizeRepoPath(path).replace(/\/$/, "");
    let stats;
    try {
      stats = statSync(resolve(repoRoot, rel));
    } catch {
      throw new Error(`missing declared ownership input: ${rel}`);
    }
    if (stats.isFile()) {
      files.add(rel);
      return;
    }
    for (const name of readdirSync(resolve(repoRoot, rel)).sort()) addTree(`${rel}/${name}`);
  };
  try {
    for (const owner of owningFamilies.values()) {
      for (const path of owner.artifactPaths) addTree(path);
      for (const path of owner.generatorPaths) addTree(path);
      for (const path of owner.freshnessGuardPaths) addTree(path);
      for (const input of owner.inputPaths) addTree(input.path);
    }
  } catch (error) {
    return {
      ok: false,
      error: `could not enumerate generated artifact ownership inputs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    inputs: [...files].sort(),
    families: [...owningFamilies.keys()].sort(),
  };
}

/**
 * Main entry: compute the related subset of `tests` for the current change
 * set. Never throws — every internal failure returns mode:"deferred" with a
 * reason, so callers keep the bounded result without launching the full
 * universe.
 */
export async function selectRelatedSmokeTests(
  tests: SmokeTestEntry[],
  deps: SelectionDeps = {},
): Promise<SelectionManifest> {
  const repoRoot = deps.repoRoot ?? process.cwd();
  const env = deps.env ?? process.env;
  const runGit = deps.runGit ?? makeGitRunner(repoRoot);
  const triggers = deps.globalTriggers ?? DEFAULT_GLOBAL_TRIGGERS;
  const coreRules = deps.coreRules ?? DEFAULT_CORE_RULES;

  const base: Omit<
    SelectionManifest,
    "mode" | "deferredReason" | "deferredOwner" | "fullReason" | "selected" | "selectedCount" | "skippedCount"
  > = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseDescription: null,
    changedFiles: [],
    universeCount: tests.length,
    notes: [],
  };

  let deferredReason: string | null = null;
  const markDeferred = (reason: string): void => {
    if (deferredReason === null) deferredReason = reason;
  };
  const deferred = (reason: string, changedFiles = base.changedFiles): SelectionManifest => {
    const changed = new Set(changedFiles.map(normalizeRepoPath));
    const selected = tests
      .filter((test) => changed.has(normalizeRepoPath(test.file)) || coreReason(test.file, coreRules) !== null)
      .map((test) => ({
        file: test.file,
        reason: changed.has(normalizeRepoPath(test.file))
          ? "directly changed test (selection deferred)"
          : `always-run core: ${coreReason(test.file, coreRules)}`,
      }));
    return {
      ...base,
      mode: "deferred",
      deferredReason: reason,
      deferredOwner: "post-merge/nightly/weekly",
      fullReason: reason,
      selected,
      selectedCount: selected.length,
      skippedCount: tests.length - selected.length,
    };
  };

  try {
    const changed = computeChangedFiles(runGit, env);
    base.baseDescription = changed.baseDescription || null;
    if (!changed.ok) {
      return deferred(`changed-file detection failed (${changed.error ?? "unknown git error"})`);
    }
    base.changedFiles = changed.files;

    if (changed.files.length === 0) {
      return deferred(
        "empty changed-file set — a gate run on a task always has changes, so base detection likely failed; refusing to narrow on zero information",
      );
    }

    for (const f of changed.files) {
      const trig = matchGlobalTrigger(f, triggers);
      if (trig) {
        markDeferred(`global trigger: ${f} (${trig.why})`);
      }
    }
    // A global trigger invalidates import-closure precision. Keep directly
    // changed tests and core guards, then transfer broad verification to the
    // existing central lane instead of tracing arbitrary dependents.
    if (deferredReason !== null) return deferred(deferredReason, changed.files);

    const artifactOwners = deps.artifactOwnership ?? [...DEFAULT_ARTIFACT_OWNERSHIP];
    const contractProblems = ownershipSetProblems(artifactOwners);
    const ownerMatches = new Map<
      string,
      {
        owner: ArtifactOwnershipContract;
        output: string | null;
        input: ArtifactPathRule | null;
        inheritedFrom: string | null;
      }
    >();
    for (const f of changed.files) {
      const matches = artifactOwners.filter(
        (owner) => artifactOutputHit(f, owner) !== null || artifactInputHit(f, owner) !== null,
      );
      const authoredEvidenceReaders = exactAuthoredEvidenceReaders(f, tests, repoRoot);
      if (matches.length === 0 && isGeneratedArtifactCandidate(f) && authoredEvidenceReaders.length === 0) {
        markDeferred(`unknown generated artifact: ${f} is outside the verified ownership contract`);
      }
      if (authoredEvidenceReaders.length > 0) {
        base.notes.push(
          `VERIFIED authored evidence reader: ${f} → ${authoredEvidenceReaders.join(", ")}`,
        );
      }
      if (matches.length > 0 && contractProblems.length > 0) {
        markDeferred(`artifact ownership contract is ambiguous: ${contractProblems.slice(0, 4).join("; ")}`);
      }
      const ambiguity = matchedOwnershipIsUnambiguous(matches, f);
      if (ambiguity) {
        markDeferred(ambiguity);
        continue;
      }
      for (const owner of matches) {
        const prior = ownerMatches.get(owner.id);
        ownerMatches.set(owner.id, {
          owner,
          output: prior?.output ?? artifactOutputHit(f, owner),
          input: prior?.input ?? artifactInputHit(f, owner),
          inheritedFrom: prior?.inheritedFrom ?? null,
        });
      }
    }
    // An explicit dependency means the downstream generator consumes the
    // upstream artifact. Any source/output change affecting that upstream
    // owner must therefore also verify and select the dependent guard family.
    const ownersById = new Map(artifactOwners.map((owner) => [owner.id, owner] as const));
    const pendingOwners = [...ownerMatches.keys()];
    while (pendingOwners.length > 0) {
      const upstreamId = pendingOwners.pop()!;
      for (const candidate of artifactOwners) {
        if (!candidate.dependsOnOwners?.includes(upstreamId) || ownerMatches.has(candidate.id)) continue;
        if (!ownersById.has(upstreamId)) {
          markDeferred(`artifact ownership dependency "${upstreamId}" is unknown`);
          continue;
        }
        ownerMatches.set(candidate.id, {
          owner: candidate,
          output: null,
          input: null,
          inheritedFrom: upstreamId,
        });
        pendingOwners.push(candidate.id);
      }
    }
    const ownershipEvidence = new Map<string, string[]>();
    const freshnessVerifier = deps.artifactFreshnessVerifier ?? verifyArtifactFreshness;
    for (const { owner } of ownerMatches.values()) {
      const verification = verifyArtifactOwnershipContract(owner, repoRoot, tests);
      if (!verification.ok) {
        markDeferred(
          `artifact ownership verification failed for ${owner.id}: ${verification.problems.slice(0, 4).join("; ")}`,
        );
        continue;
      }
      const freshness = await freshnessVerifier(owner, repoRoot);
      if (!freshness.ok) {
        markDeferred(
          `artifact freshness verification failed for ${owner.id}: ${freshness.problems.slice(0, 4).join("; ")}`,
        );
        continue;
      }
      ownershipEvidence.set(owner.id, [...verification.evidence, ...freshness.evidence]);
    }

    // One shared trace pass over every test file + its setup/hook files.
    const entryByTest = new Map<string, string[]>();
    const allEntries: string[] = [];
    for (const t of tests) {
      const entries = [normalizeRepoPath(t.file), ...extraNodeArgsEntryFiles(t.extraNodeArgs)];
      entryByTest.set(t.file, entries);
      allEntries.push(...entries);
    }
    // Task #4560: same stall protection as the blast-radius expansion — a
    // stalled esbuild BFS must fall open to the FULL set instead of hanging
    // the gate's selection phase past the outer shell budget.
    const traceTimeoutMs =
      deps.traceTimeoutMs ?? (Number(env.SMOKE_RELATED_TRACE_TIMEOUT_MS) || 120_000);
    const { timedOut, trace } = await traceImportClosuresWithBudget(
      allEntries,
      repoRoot,
      {},
      { timeoutMs: traceTimeoutMs, traceFn: deps.traceFn },
    );
    if (timedOut || !trace) {
      return deferred(
        `import trace timed out after ${Math.round(traceTimeoutMs / 1000)}s`,
        changed.files,
      );
    }
    if (!trace.ok) {
      return deferred(trace.error ?? "import trace failed", changed.files);
    }

    // Changed test-infrastructure files under tests/ that are NOT test files
    // and NOT reachable from any entry (loader-registered stubs, fixtures,
    // hook targets referenced only as strings) cannot be attributed to any
    // subset — widen to full rather than guess.
    const reachable = new Set<string>();
    for (const closure of trace.closures.values()) {
      for (const f of closure) reachable.add(f);
    }
    const verifiedGeneratedOutputs = new Set(
      [...ownerMatches.values()].flatMap(({ owner }) => owner.artifactPaths.map(normalizeRepoPath)),
    );
    for (const f of changed.files) {
      if (
        f.startsWith("tests/") &&
        !/\.test\.tsx?$/.test(f) &&
        !reachable.has(f) &&
        !verifiedGeneratedOutputs.has(f)
      ) {
        markDeferred(`unattributable test-infrastructure change: ${f} is not reachable by import tracing`);
      }
    }

    const changedSet = new Set(changed.files);
    const selected: SelectedTest[] = [];
    const selectedFiles = new Set<string>();

    for (const t of tests) {
      const entries = entryByTest.get(t.file) ?? [normalizeRepoPath(t.file)];
      let reason: string | null = null;
      let extraHits = 0;
      for (const entry of entries) {
        const closure = trace.closures.get(entry);
        if (!closure) continue;
        for (const changedFile of changed.files) {
          if (!closure.has(changedFile)) continue;
          if (reason === null) {
            if (entry === normalizeRepoPath(t.file)) {
              reason = changedFile === entry ? "test file changed" : `imports changed ${changedFile}`;
            } else {
              reason = changedFile === entry ? `setup ${entry} changed` : `setup ${entry} imports changed ${changedFile}`;
            }
          } else {
            extraHits++;
          }
        }
      }
      // Task #4103: declared fs-scan inputs (invisible to import tracing).
      if (reason === null) {
        for (const changedFile of changed.files) {
          const hit = scanPathHit(changedFile, t.scanPaths);
          if (hit) {
            reason = `fs-scans changed ${changedFile} (declared scanPath ${hit})`;
            break;
          }
        }
      }
      if (reason !== null) {
        selected.push({ file: t.file, reason: extraHits > 0 ? `${reason} (+${extraHits} more hit(s))` : reason });
        selectedFiles.add(t.file);
      }
    }

    // A verified generated-artifact owner is also a precise dependency edge:
    // changing an output selects its freshness/refresh guards, while changing
    // a generator input selects the same guards without broadening to all
    // smoke tests. The closure and scan-path decisions above remain intact.
    for (const { owner, output, input, inheritedFrom } of ownerMatches.values()) {
      const changedDependency = output
        ? `generated output ${output}`
        : input
          ? `generator input ${input.path}`
          : `upstream ownership ${inheritedFrom ?? "changed path"}`;
      for (const suite of owner.guardSuites) {
        if (selectedFiles.has(suite)) continue;
        selected.push({
          file: suite,
          reason: `verified ownership ${owner.id}: ${changedDependency}; ${owner.freshnessGuardPaths.join(", ")}`,
        });
        selectedFiles.add(suite);
      }
      base.notes.push(
        `VERIFIED artifact ownership: ${owner.id} (${changedDependency}); ` +
          `evidence: ${ownershipEvidence.get(owner.id)?.join(", ") || owner.generatorPaths.join(", ")}`,
      );
    }

    const relatedHitCount = selected.length;

    for (const t of tests) {
      if (selectedFiles.has(t.file)) continue;
      const why = coreReason(t.file, coreRules);
      if (why) {
        selected.push({ file: t.file, reason: `always-run core: ${why}` });
        selectedFiles.add(t.file);
      }
    }

    if (relatedHitCount === 0) {
      base.notes.push(
        `ZERO related matches: none of the ${changed.files.length} changed file(s) reach any smoke test's import closure; ` +
          `running only the always-run core (${selected.length} test(s)). ` +
          `If this looks wrong, force the full set with \`npm run gate --full-smoke\` or plain \`TEST_SMOKE=1 npm test\`.`,
      );
    }

    // Keep universe order (stable, matches run order).
    const order = new Map(tests.map((t, i) => [t.file, i] as const));
    selected.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));

    return {
      ...base,
      mode: deferredReason ? "deferred" : "related",
      deferredReason,
      deferredOwner: deferredReason ? "post-merge/nightly/weekly" : null,
      fullReason: deferredReason,
      selected,
      selectedCount: selected.length,
      skippedCount: tests.length - selected.length,
    };
  } catch (err) {
    return deferred(`unexpected selection error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function formatSelectionSummary(manifest: SelectionManifest): string[] {
  const lines: string[] = [];
  if (manifest.mode === "deferred") {
    lines.push(
      `[related-smoke] DEFERRED to ${manifest.deferredOwner ?? "central-integrity"} — ` +
        `bounded selection ${manifest.selectedCount} of ${manifest.universeCount}; ` +
        `${manifest.deferredReason ?? "selection uncertainty"} (NOT verified by this run)`,
    );
    for (const s of manifest.selected) {
      lines.push(`[related-smoke]   + ${s.file} — ${s.reason}`);
    }
  } else {
    lines.push(
      `[related-smoke] selected ${manifest.selectedCount} of ${manifest.universeCount} smoke test(s) ` +
        `(${manifest.skippedCount} skipped; ${manifest.changedFiles.length} changed file(s); base: ${manifest.baseDescription ?? "n/a"})`,
    );
    for (const s of manifest.selected) {
      lines.push(`[related-smoke]   + ${s.file} — ${s.reason}`);
    }
  }
  for (const note of manifest.notes) {
    lines.push(`[related-smoke] NOTE: ${note}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Task #4501 — blast-radius expansion for the task gate.
// ---------------------------------------------------------------------------

export interface BlastRadiusExpansionResult {
  /** Non-smoke suites whose import closure intersects the diff, sorted by hitCount desc. */
  selected: Array<{ file: string; reason: string; hitCount: number }>;
  /** True when more candidates exist beyond the maxSuites cap. */
  truncated: boolean;
  /** How many additional suites were not included due to the cap. */
  truncatedCount: number;
  /** When non-null, the expansion could not run and selected is empty. */
  fallbackReason: string | null;
}

/**
 * Task #4501 — blast-radius gate expansion.
 *
 * From the set of non-smoke suites, find those whose import closure
 * (traced with the same esbuild tracer and alias rules as related-smoke)
 * intersects the given changed-file set. Returns suites sorted by closure-hit
 * count descending (highest blast radius first), capped at opts.maxSuites.
 *
 * Never throws — any trace failure returns fallbackReason and empty selection.
 * Called by run-all.ts when TEST_GATE_EXPANSION != "0" and in smoke mode.
 */
export async function selectBlastRadiusExpansion(
  nonSmokeSuites: SmokeTestEntry[],
  changedFiles: string[],
  opts: {
    repoRoot?: string;
    maxSuites?: number;
    /**
     * Task #4547: hard budget for the import trace. traceImportClosures has
     * no internal timeout, so a stalled tracer (pathological closure /
     * esbuild hang) would otherwise eat the whole outer spawnSync budget and
     * kill the smoke run before the honest "expansion skipped" line prints.
     * On timeout the expansion returns a fallbackReason and the smoke run
     * continues unexpanded.
     */
    timeoutMs?: number;
    /** Injectable tracer seam (tests exercise the timeout path with it). */
    traceFn?: typeof traceImportClosures;
  } = {},
): Promise<BlastRadiusExpansionResult> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const maxSuites = opts.maxSuites ?? 15;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const traceFn = opts.traceFn ?? traceImportClosures;

  if (nonSmokeSuites.length === 0 || changedFiles.length === 0) {
    return { selected: [], truncated: false, truncatedCount: 0, fallbackReason: null };
  }

  try {
    // Build per-test entry lists (test file + any extraNodeArgs setup files).
    const entryByTest = new Map<string, string[]>();
    const allEntries: string[] = [];
    for (const t of nonSmokeSuites) {
      const entries = [normalizeRepoPath(t.file), ...extraNodeArgsEntryFiles(t.extraNodeArgs)];
      entryByTest.set(t.file, entries);
      allEntries.push(...entries);
    }

    // tolerateUnresolvable=true: missing/unresolvable imports don't fail the
    // trace; affected suites are just left unresolved (effectively "no hits"
    // unless they're reached via another entry). Mirrors the fingerprinting
    // caller (Task #3791) rather than the strict smoke-selection caller.
    // Task #4547: race the tracer against the timeout budget (shared helper
    // — see traceImportClosuresWithBudget for the timer/exit-13 rationale).
    // A timed-out trace is discarded and the smoke run proceeds unexpanded
    // (honest fallbackReason).
    const { timedOut, trace } = await traceImportClosuresWithBudget(
      allEntries,
      repoRoot,
      { tolerateUnresolvable: true },
      { timeoutMs, traceFn },
    );
    if (timedOut || !trace) {
      return {
        selected: [],
        truncated: false,
        truncatedCount: 0,
        fallbackReason: `expansion timed out after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    if (!trace.ok) {
      return {
        selected: [],
        truncated: false,
        truncatedCount: 0,
        fallbackReason: trace.error ?? "import trace failed",
      };
    }

    const changedSet = new Set(changedFiles);
    const candidates: Array<{ file: string; reason: string; hitCount: number }> = [];

    for (const t of nonSmokeSuites) {
      const entries = entryByTest.get(t.file) ?? [normalizeRepoPath(t.file)];
      let firstReason: string | null = null;
      let hitCount = 0;

      for (const entry of entries) {
        const closure = trace.closures.get(entry);
        if (!closure) continue;
        for (const changedFile of changedFiles) {
          if (!closure.has(changedFile)) continue;
          hitCount++;
          if (firstReason === null) {
            if (entry === normalizeRepoPath(t.file)) {
              firstReason =
                changedFile === entry
                  ? "test file changed"
                  : `imports changed ${changedFile}`;
            } else {
              firstReason =
                changedFile === entry
                  ? `setup ${entry} changed`
                  : `setup ${entry} imports changed ${changedFile}`;
            }
          }
        }
      }

      // Also honour declared scanPaths (invisible to import tracing, same as
      // selectRelatedSmokeTests — Task #4103).
      if (firstReason === null) {
        for (const changedFile of changedFiles) {
          const hit = scanPathHit(changedFile, t.scanPaths);
          if (hit) {
            firstReason = `fs-scans changed ${changedFile} (declared scanPath ${hit})`;
            hitCount++;
            break;
          }
        }
      }

      if (firstReason !== null) {
        const reason =
          hitCount > 1
            ? `${firstReason} (+${hitCount - 1} more hit(s))`
            : firstReason;
        candidates.push({ file: t.file, reason, hitCount });
      }
    }

    // Sort by closure-hit count descending, highest blast radius first.
    candidates.sort(
      (a, b) => b.hitCount - a.hitCount || a.file.localeCompare(b.file),
    );

    const selected = candidates.slice(0, maxSuites);
    const truncatedCount = Math.max(0, candidates.length - maxSuites);
    return { selected, truncated: truncatedCount > 0, truncatedCount, fallbackReason: null };
  } catch (err) {
    return {
      selected: [],
      truncated: false,
      truncatedCount: 0,
      fallbackReason: `expansion error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Task #4560 — shared tracer budget: race traceImportClosures against a hard
 * timeout. Extracted from selectBlastRadiusExpansion (Task #4547) so ALL
 * three tracer callers (blast-radius expansion, related-smoke selection,
 * fingerprinting) share one stall-protection implementation.
 *
 * The timer is cleared right after the race, so a finished trace never keeps
 * the process alive (do NOT unref it: with a fully stalled tracer the timer
 * can be the only live handle, and an unref'd one would let the loop drain
 * before it fires — unsettled top-level await, exit 13). A timed-out trace
 * keeps running in the background but its result is discarded; callers fall
 * open (full set / execute everything) with an honest reason.
 *
 * A rejecting (or synchronously throwing) tracer is normalized into the same
 * fall-open shape as a trace failure (ok:false) — and the timer is cleared in
 * a finally so a crashed trace never leaves a live 120s handle keeping the
 * process alive.
 */
export async function traceImportClosuresWithBudget(
  entries: string[],
  repoRoot: string,
  traceOpts: { tolerateUnresolvable?: boolean },
  budget: { timeoutMs: number; traceFn?: typeof traceImportClosures },
): Promise<{ timedOut: boolean; trace: TraceResult | null }> {
  const traceFn = budget.traceFn ?? traceImportClosures;
  const TIMED_OUT = Symbol("trace-timeout");
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<typeof TIMED_OUT>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout(TIMED_OUT), budget.timeoutMs);
  });
  try {
    // Promise.resolve().then(...) folds a synchronously throwing injected
    // tracer into the same rejection path as an async failure.
    const raced = await Promise.race([
      Promise.resolve().then(() => traceFn(entries, repoRoot, traceOpts)),
      timeoutPromise,
    ]);
    if (raced === TIMED_OUT) return { timedOut: true, trace: null };
    return { timedOut: false, trace: raced };
  } catch (err) {
    return {
      timedOut: false,
      trace: {
        ok: false,
        closures: new Map(),
        error: `import trace crashed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Write the machine-readable manifest; failure to write never fails the run. */
export function writeSelectionManifest(manifest: SelectionManifest, path: string): boolean {
  try {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(resolve(path), `${JSON.stringify(manifest, null, 2)}\n`);
    return true;
  } catch (err) {
    console.error(`[related-smoke] could not write selection manifest to ${path}:`, err);
    return false;
  }
}
