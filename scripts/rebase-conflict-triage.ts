/**
 * Task #4553 — Completion-rebase conflict triage: one-command executor.
 *
 * When main moves during a task's completion/validation window, the rebase
 * stops on conflicts. This helper makes each round cheap and mechanical:
 *
 *   1. Classifies every conflicted path (pure logic in
 *      scripts/rebaseConflictTriageLib.ts) into generated-artifact /
 *      memory-index / lockfile / source classes.
 *   2. Auto-resolves the mechanical classes: takes a side, runs the
 *      EXISTING sanctioned generators in dependency order on the rebased
 *      tree (route inventory before the endpoint contract table), stages
 *      results, union-merges the memory index, reinstalls on a lockfile
 *      conflict.
 *   3. Prints a crisp list of only the residual real conflicts — which it
 *      NEVER touches (unknown conflicts always fall open to manual
 *      handling, recorded as such in the round report).
 *   4. Leaves an audited machine-readable round report under
 *      .local/runs/rebase-triage/.
 *
 * Safety rule: generators must not parse a tree that still contains
 * conflict markers, so whenever residual source conflicts remain ALL
 * take-side/regen/lockfile work is deferred — resolve the residual
 * conflicts, then re-run the same command. The content-independent
 * memory-index union is the only action that still executes on a deferred
 * round.
 *
 * After the round lands (rebase continued / merge committed):
 *
 *   npx tsx scripts/rebase-conflict-triage.ts --verify
 *
 * runs the existing merge-integrity verifier (scripts/verify-merge-integrity.ts,
 * which ALSO runs the `npm run check` typecheck itself — deliberately no
 * second typecheck here, same rule as post-merge.sh) and folds the outcome
 * into a verify report.
 *
 * Canonical operator protocol: COMPLETION_REBASE_TRIAGE.md.
 *
 * Usage:
 *   npx tsx scripts/rebase-conflict-triage.ts              triage current round
 *   npx tsx scripts/rebase-conflict-triage.ts --dry-run    classify + plan only
 *   npx tsx scripts/rebase-conflict-triage.ts --side ours  override take-side
 *   npx tsx scripts/rebase-conflict-triage.ts --verify     post-round integrity pass
 *
 * Exit codes (triage): 0 all conflicts auto-resolved; 2 residual manual
 * conflicts remain (listed in report); 1 an executed action failed.
 * Exit codes (--verify): 0 clean; 1 smears/resurrections/typecheck red or
 * verifier error; 2 refused (round not finished — unmerged paths remain).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_FAMILIES,
  planTriage,
  parseLsFilesUnmergedZ,
  detectMode,
  upstreamSideFor,
  type Classification,
  type ConflictSide,
  type RepoMergeMode,
  type TriagePlan,
  type UnmergedPath,
} from "./rebaseConflictTriageLib";

export const ROUND_REPORT_DIR = ".local/runs/rebase-triage";
export const MERGE_INTEGRITY_REPORT = ".local/runs/merge-integrity.json";
const SCRATCH_DIR = ".local/scratch/rebase-triage";
const NPM_INSTALL_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 2_000;

export interface RoundAction {
  kind: "take-side" | "regen" | "union-merge" | "reinstall" | "stage";
  /** Repo path or artifact family id the action applies to. */
  target: string;
  argv?: readonly string[];
  outcome: "ok" | "failed" | "skipped" | "planned" | "deferred";
  detail?: string;
  durationMs?: number;
}

export interface RoundIntegritySummary {
  verifierRan: boolean;
  kind: string | null;
  smearedFiles: number;
  resurrectedAncestors: number;
  typecheckRan: boolean;
  typecheckExitCode: number | null;
  typecheckErrorFilesNotTaskTouched: number;
  warnings: string[];
  reportPath: string;
}

export interface TriageRoundReport {
  schemaVersion: 1;
  tool: "rebase-conflict-triage";
  mode: "triage" | "verify";
  generatedAt: string;
  repoOperation: RepoMergeMode;
  upstreamSide: ConflictSide | null;
  sideTaken: ConflictSide | null;
  dryRun: boolean;
  conflictedPaths: UnmergedPath[];
  classifications: Classification[];
  actions: RoundAction[];
  /** Conflicts the helper refused to touch — fell open to manual handling. */
  residualManual: { path: string; reason: string }[];
  deferredRegens: boolean;
  integrity: RoundIntegritySummary | null;
  outcome:
    | "clean"
    | "residual-manual"
    | "actions-failed"
    | "verify-clean"
    | "verify-failed"
    | "verify-refused";
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

function run(
  argv: readonly [string, ...string[]],
  opts: { timeoutMs?: number; inheritStdio?: boolean } = {},
): RunResult {
  const started = Date.now();
  const res = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf-8",
    timeout: opts.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    stdio: opts.inheritStdio ? "inherit" : "pipe",
  });
  return {
    status: res.status,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
    durationMs: Date.now() - started,
    error: res.error ? String(res.error) : undefined,
  };
}

function tail(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS
    ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}`
    : trimmed;
}

function git(args: readonly string[]): RunResult {
  return run(["git", ...args]);
}

function detectRepoOperation(): RepoMergeMode {
  const gitPath = (name: string): string | null => {
    const res = git(["rev-parse", "--git-path", name]);
    return res.status === 0 ? res.stdout.trim() : null;
  };
  const rebaseMerge = gitPath("rebase-merge");
  const rebaseApply = gitPath("rebase-apply");
  const mergeHead = gitPath("MERGE_HEAD");
  return detectMode({
    rebaseMergeDir: rebaseMerge !== null && existsSync(rebaseMerge),
    rebaseApplyDir: rebaseApply !== null && existsSync(rebaseApply),
    mergeHead: mergeHead !== null && existsSync(mergeHead),
  });
}

function listUnmerged(): UnmergedPath[] {
  const res = git(["ls-files", "-u", "-z"]);
  if (res.status !== 0) {
    throw new Error(`git ls-files -u failed: ${tail(res.stderr)}`);
  }
  return parseLsFilesUnmergedZ(res.stdout);
}

function writeReport(report: TriageRoundReport): string {
  mkdirSync(ROUND_REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(ROUND_REPORT_DIR, `${stamp}-${report.mode}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/** 3-stage union merge for the memory index (mirrors merge=union). */
function unionMergeMemoryIndex(repoPath: string, hasBase: boolean): RoundAction {
  const started = Date.now();
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const oursFile = path.join(SCRATCH_DIR, "ours");
  const baseFile = path.join(SCRATCH_DIR, "base");
  const theirsFile = path.join(SCRATCH_DIR, "theirs");
  try {
    const blob = (stage: 1 | 2 | 3): string | null => {
      const res = git(["cat-file", "blob", `:${stage}:${repoPath}`]);
      return res.status === 0 ? res.stdout : null;
    };
    const ours = blob(2);
    const theirs = blob(3);
    if (ours === null || theirs === null) {
      return {
        kind: "union-merge",
        target: repoPath,
        outcome: "failed",
        detail: "could not read stage 2/3 blobs",
        durationMs: Date.now() - started,
      };
    }
    writeFileSync(oursFile, ours);
    writeFileSync(baseFile, hasBase ? (blob(1) ?? "") : "");
    writeFileSync(theirsFile, theirs);
    const mergeRes = git(["merge-file", "--union", oursFile, baseFile, theirsFile]);
    if (mergeRes.status === null || mergeRes.status < 0) {
      return {
        kind: "union-merge",
        target: repoPath,
        outcome: "failed",
        detail: `git merge-file --union failed: ${tail(mergeRes.stderr)}`,
        durationMs: Date.now() - started,
      };
    }
    writeFileSync(repoPath, readFileSync(oursFile, "utf-8"));
    const add = git(["add", "--", repoPath]);
    if (add.status !== 0) {
      return {
        kind: "union-merge",
        target: repoPath,
        outcome: "failed",
        detail: `git add failed: ${tail(add.stderr)}`,
        durationMs: Date.now() - started,
      };
    }
    return {
      kind: "union-merge",
      target: repoPath,
      outcome: "ok",
      detail: "union of both sides written and staged",
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
}

function takeSide(repoPath: string, side: ConflictSide): RoundAction {
  const res = git(["checkout", `--${side}`, "--", repoPath]);
  return {
    kind: "take-side",
    target: repoPath,
    outcome: res.status === 0 ? "ok" : "failed",
    detail: res.status === 0 ? `took --${side}` : tail(res.stderr),
    durationMs: res.durationMs,
  };
}

function stagePaths(target: string, paths: readonly string[]): RoundAction {
  const res = git(["add", "--", ...paths]);
  return {
    kind: "stage",
    target,
    outcome: res.status === 0 ? "ok" : "failed",
    detail: res.status === 0 ? paths.join(", ") : tail(res.stderr),
    durationMs: res.durationMs,
  };
}

export function parseArgs(argv: readonly string[]): {
  dryRun: boolean;
  verify: boolean;
  side: ConflictSide | null;
  help: boolean;
  error: string | null;
} {
  const out = {
    dryRun: false,
    verify: false,
    side: null as ConflictSide | null,
    help: false,
    error: null as string | null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--verify") out.verify = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--side") {
      const v = argv[++i];
      if (v !== "ours" && v !== "theirs") {
        out.error = `--side requires "ours" or "theirs" (got ${v ?? "nothing"})`;
      } else {
        out.side = v;
      }
    } else {
      out.error = `unknown argument: ${a}`;
    }
  }
  return out;
}

function log(msg: string): void {
  console.log(`[rebase-triage] ${msg}`);
}

function runTriage(opts: { dryRun: boolean; side: ConflictSide | null }): number {
  const repoOperation = detectRepoOperation();
  const unmerged = listUnmerged();

  if (unmerged.length === 0) {
    if (repoOperation === "none") {
      log("no rebase/merge in progress and no unmerged paths — nothing to triage.");
    } else {
      log(
        `${repoOperation} in progress but every conflict is already staged — ` +
          "continue the rebase/merge, then run `--verify` for the integrity pass.",
      );
    }
    return 0;
  }

  const upstreamSide = upstreamSideFor(repoOperation);
  const sideTaken = opts.side ?? upstreamSide;
  log(
    `${repoOperation === "none" ? "conflicted index (no rebase/merge marker found)" : `${repoOperation} in progress`}; ` +
      `${unmerged.length} unmerged path(s). Upstream side assumed --${upstreamSide}; taking --${sideTaken}` +
      (opts.side ? " (overridden via --side)." : "."),
  );

  const plan: TriagePlan = planTriage(unmerged);
  const actions: RoundAction[] = [];
  const residualManual = plan.residual.map((c) => ({ path: c.path, reason: c.reason }));

  // Memory-index union is content-independent — runs even on deferred rounds.
  for (const memPath of plan.memoryUnionPaths) {
    if (opts.dryRun) {
      actions.push({ kind: "union-merge", target: memPath, outcome: "planned" });
      continue;
    }
    const u = unmerged.find((x) => x.path === memPath);
    actions.push(unionMergeMemoryIndex(memPath, u?.hasBase ?? false));
  }

  if (plan.deferRegens) {
    for (const t of plan.takeSidePaths) {
      actions.push({
        kind: "take-side",
        target: t.path,
        outcome: "deferred",
        detail: "residual source conflicts remain — generators must not parse a marker-laden tree",
      });
    }
    for (const regen of plan.regens) {
      actions.push({
        kind: "regen",
        target: regen.familyId,
        argv: regen.regenArgv,
        outcome: "deferred",
        detail: `trigger=${regen.trigger} via ${regen.triggeredBy.join(", ")}`,
      });
    }
    for (const lock of plan.lockfilePaths) {
      actions.push({ kind: "reinstall", target: lock, outcome: "deferred" });
    }
  } else if (opts.dryRun) {
    for (const t of plan.takeSidePaths) {
      actions.push({ kind: "take-side", target: t.path, outcome: "planned" });
    }
    for (const regen of plan.regens) {
      actions.push({
        kind: "regen",
        target: regen.familyId,
        argv: regen.regenArgv,
        outcome: "planned",
        detail: `trigger=${regen.trigger} via ${regen.triggeredBy.join(", ")}`,
      });
    }
    for (const lock of plan.lockfilePaths) {
      actions.push({ kind: "reinstall", target: lock, outcome: "planned" });
    }
  } else {
    // 1. Take a side on every auto-resolvable generated artifact.
    const takeSideFailures = new Set<string>();
    for (const t of plan.takeSidePaths) {
      const action = takeSide(t.path, sideTaken);
      actions.push(action);
      if (action.outcome === "failed") takeSideFailures.add(t.familyId);
    }
    // 2. Regens in dependency order; a failed dependency skips dependents.
    //    The dependency relation is the family's declared regenAlsoWhen list
    //    (e.g. endpoint-contract-table is generated FROM route-inventory).
    const failedFamilies = new Set<string>(takeSideFailures);
    for (const regen of plan.regens) {
      const declaredDeps =
        ARTIFACT_FAMILIES.find((f) => f.id === regen.familyId)?.regenAlsoWhen ?? [];
      const blockedByDep =
        failedFamilies.has(regen.familyId) ||
        declaredDeps.some((dep) => failedFamilies.has(dep));
      if (blockedByDep) {
        actions.push({
          kind: "regen",
          target: regen.familyId,
          argv: regen.regenArgv,
          outcome: "skipped",
          detail: "dependency family failed — regen would run against stale inputs",
        });
        failedFamilies.add(regen.familyId);
        continue;
      }
      log(`regenerating ${regen.familyId} (${regen.regenCommand}) …`);
      const res = run(regen.regenArgv, { timeoutMs: regen.timeoutMs });
      if (res.status !== 0) {
        actions.push({
          kind: "regen",
          target: regen.familyId,
          argv: regen.regenArgv,
          outcome: "failed",
          detail: tail(`${res.error ?? ""}\n${res.stderr}\n${res.stdout}`),
          durationMs: res.durationMs,
        });
        failedFamilies.add(regen.familyId);
        for (const p of regen.triggeredBy) {
          if (regen.trigger === "conflicted") {
            residualManual.push({
              path: p,
              reason: `regen failed for family ${regen.familyId} — path left unstaged (still unmerged in the index); fix the generator failure, then re-run`,
            });
          }
        }
        continue;
      }
      actions.push({
        kind: "regen",
        target: regen.familyId,
        argv: regen.regenArgv,
        outcome: "ok",
        detail: `trigger=${regen.trigger}`,
        durationMs: res.durationMs,
      });
      actions.push(stagePaths(regen.familyId, regen.stagePaths));
    }
    // 3. Lockfile: take a side, reinstall, stage.
    for (const lock of plan.lockfilePaths) {
      const ts = takeSide(lock, sideTaken);
      actions.push(ts);
      if (ts.outcome === "failed") continue;
      log("lockfile conflict — running npm install (reinstall, never merge) …");
      const res = run(["npm", "install", "--no-fund", "--no-audit"], {
        timeoutMs: NPM_INSTALL_TIMEOUT_MS,
      });
      if (res.status !== 0) {
        actions.push({
          kind: "reinstall",
          target: lock,
          outcome: "failed",
          detail: tail(`${res.error ?? ""}\n${res.stderr}`),
          durationMs: res.durationMs,
        });
        residualManual.push({
          path: lock,
          reason: "npm install failed after take-side — lockfile left unstaged",
        });
        continue;
      }
      actions.push({
        kind: "reinstall",
        target: lock,
        outcome: "ok",
        durationMs: res.durationMs,
      });
      actions.push(stagePaths(lock, [lock]));
    }
  }

  const anyFailed = actions.some((a) => a.outcome === "failed");
  const outcome: TriageRoundReport["outcome"] = anyFailed
    ? "actions-failed"
    : residualManual.length > 0
      ? "residual-manual"
      : "clean";

  const report: TriageRoundReport = {
    schemaVersion: 1,
    tool: "rebase-conflict-triage",
    mode: "triage",
    generatedAt: new Date().toISOString(),
    repoOperation,
    upstreamSide,
    sideTaken: opts.dryRun ? null : sideTaken,
    dryRun: opts.dryRun,
    conflictedPaths: unmerged,
    classifications: plan.classifications,
    actions,
    residualManual,
    deferredRegens: plan.deferRegens,
    integrity: null,
    outcome,
  };
  const reportPath = writeReport(report);

  // ---- Crisp console summary -------------------------------------------
  const auto = plan.classifications.filter((c) => c.autoResolvable);
  if (auto.length > 0) {
    log(`mechanical (${opts.dryRun ? "planned" : plan.deferRegens ? "deferred" : "auto-resolved"}):`);
    for (const c of auto) log(`  • ${c.path}  [${c.classId}${c.familyId ? `:${c.familyId}` : ""}]`);
  }
  if (residualManual.length > 0) {
    log(`REAL conflicts needing judgment (${residualManual.length}) — NOT touched:`);
    for (const r of residualManual) log(`  ✋ ${r.path}\n       ${r.reason}`);
  } else if (!opts.dryRun && !anyFailed) {
    log("no residual conflicts — every conflicted path was auto-resolved and staged.");
  }
  if (plan.deferRegens && !opts.dryRun) {
    log(
      "regens DEFERRED (residual conflicts above must be resolved first). " +
        "Resolve + `git add` them, then re-run this command to execute the mechanical plan.",
    );
  } else if (!opts.dryRun && !anyFailed && residualManual.length === 0) {
    log("next: continue the rebase/merge, then run `npx tsx scripts/rebase-conflict-triage.ts --verify`.");
  }
  if (anyFailed) log("one or more actions FAILED — see the round report.");
  log(`round report: ${reportPath}`);

  return anyFailed ? 1 : residualManual.length > 0 ? 2 : 0;
}

export interface VerifyDeps {
  listUnmergedFn?: () => UnmergedPath[];
  detectRepoOperationFn?: () => RepoMergeMode;
  /** Spawns the sanctioned verifier; it must write integrityReportPath itself. */
  spawnVerifier?: () => { status: number | null };
  integrityReportPath?: string;
  writeRoundReportFn?: (report: TriageRoundReport) => string;
  nowMs?: () => number;
}

/**
 * Freshness slack for the integrity-report mtime gate: filesystem timestamp
 * rounding can put a legitimate write a hair before the pre-spawn clock read.
 */
const VERIFY_REPORT_FRESHNESS_SLACK_MS = 2_000;

export function runVerify(deps: VerifyDeps = {}): number {
  const {
    listUnmergedFn = listUnmerged,
    detectRepoOperationFn = detectRepoOperation,
    integrityReportPath = MERGE_INTEGRITY_REPORT,
    writeRoundReportFn = writeReport,
    nowMs = Date.now,
    spawnVerifier = () =>
      run(["npx", "tsx", "scripts/verify-merge-integrity.ts"], {
        inheritStdio: true,
      }),
  } = deps;
  const unmerged = listUnmergedFn();
  const repoOperation = detectRepoOperationFn();
  if (unmerged.length > 0) {
    log(
      `refusing --verify: ${unmerged.length} unmerged path(s) remain — finish the round ` +
        "(triage + manual resolution + continue) first.",
    );
    const report: TriageRoundReport = {
      schemaVersion: 1,
      tool: "rebase-conflict-triage",
      mode: "verify",
      generatedAt: new Date().toISOString(),
      repoOperation,
      upstreamSide: null,
      sideTaken: null,
      dryRun: false,
      conflictedPaths: unmerged,
      classifications: [],
      actions: [],
      residualManual: [],
      deferredRegens: false,
      integrity: null,
      outcome: "verify-refused",
    };
    log(`round report: ${writeRoundReportFn(report)}`);
    return 2;
  }

  // The verifier runs `npm run check` itself (it absorbed the post-merge
  // typecheck pre-warm) — invoking it covers integrity AND typecheck; a
  // second bare typecheck here would pay ~90s twice for nothing.
  //
  // Fail-closed freshness: delete any prior integrity report BEFORE spawning
  // so a stale clean result can never be attributed to this invocation, then
  // trust the report only when it exists with an mtime at/after spawn start.
  // The child's exit status stays a failure signal even when a fresh report
  // parses clean.
  try {
    rmSync(integrityReportPath, { force: true });
  } catch (err) {
    log(
      `warning: could not remove prior ${integrityReportPath} ` +
        `(${(err as Error).message}); the mtime freshness gate below still applies.`,
    );
  }
  log("running scripts/verify-merge-integrity.ts (includes the typecheck) …");
  const spawnStartMs = nowMs();
  const res = spawnVerifier();

  const integrity: RoundIntegritySummary = {
    verifierRan: false,
    kind: null,
    smearedFiles: 0,
    resurrectedAncestors: 0,
    typecheckRan: false,
    typecheckExitCode: null,
    typecheckErrorFilesNotTaskTouched: 0,
    warnings: [],
    reportPath: integrityReportPath,
  };
  let reportFresh = false;
  try {
    reportFresh =
      statSync(integrityReportPath).mtimeMs >=
      spawnStartMs - VERIFY_REPORT_FRESHNESS_SLACK_MS;
  } catch {
    reportFresh = false;
  }
  if (!reportFresh) {
    integrity.warnings.push(
      `verifier did not write a fresh ${integrityReportPath} after spawn ` +
        "(missing or stale mtime) — failing closed; any prior report was " +
        "deleted pre-spawn and is never trusted.",
    );
  } else {
    try {
      const raw = JSON.parse(readFileSync(integrityReportPath, "utf-8")) as {
        kind?: string;
        smearedFiles?: { resurrectedAncestorBlob?: boolean }[];
        typecheck?: {
          ran?: boolean;
          exitCode?: number | null;
          errorFilesNotTaskTouched?: string[];
        };
        warnings?: string[];
      };
      // Retain the child-result failure signal: a fresh, clean-parsing report
      // from a non-zero verifier exit still fails the round.
      integrity.verifierRan = res.status === 0;
      integrity.kind = raw.kind ?? null;
      integrity.smearedFiles = raw.smearedFiles?.length ?? 0;
      integrity.resurrectedAncestors =
        raw.smearedFiles?.filter((s) => s.resurrectedAncestorBlob).length ?? 0;
      integrity.typecheckRan = raw.typecheck?.ran ?? false;
      integrity.typecheckExitCode = raw.typecheck?.exitCode ?? null;
      integrity.typecheckErrorFilesNotTaskTouched =
        raw.typecheck?.errorFilesNotTaskTouched?.length ?? 0;
      integrity.warnings = [...(raw.warnings ?? [])];
      if (res.status !== 0) {
        integrity.warnings.push(
          `verifier child exited ${res.status ?? "null"} — failing closed ` +
            "despite a fresh report.",
        );
      }
    } catch (err) {
      integrity.verifierRan = false;
      integrity.warnings.push(
        `could not read ${integrityReportPath}: ${(err as Error).message}`,
      );
    }
  }

  const clean =
    integrity.verifierRan &&
    (integrity.kind === "merge" || integrity.kind === "not-a-merge") &&
    integrity.smearedFiles === 0 &&
    integrity.typecheckRan &&
    integrity.typecheckExitCode === 0;

  const report: TriageRoundReport = {
    schemaVersion: 1,
    tool: "rebase-conflict-triage",
    mode: "verify",
    generatedAt: new Date().toISOString(),
    repoOperation,
    upstreamSide: null,
    sideTaken: null,
    dryRun: false,
    conflictedPaths: [],
    classifications: [],
    actions: [],
    residualManual: [],
    deferredRegens: false,
    integrity,
    outcome: clean ? "verify-clean" : "verify-failed",
  };
  const reportPath = writeRoundReportFn(report);

  if (integrity.kind === "not-a-merge") {
    log(
      "HEAD is not a merge commit (rebase-shaped round) — smear analysis is N/A here; " +
        "if anything looks off, diff against the upstream tip per the merge-corruption playbook.",
    );
  }
  if (clean) {
    log(
      `integrity pass CLEAN (kind=${integrity.kind}, smears=0, typecheck exit 0). ` +
        "Next: single incremental revalidation via the managed Long validation workflow verdict.",
    );
  } else {
    log(
      `integrity pass NOT clean: kind=${integrity.kind ?? "unknown"}, smears=${integrity.smearedFiles} ` +
        `(resurrected=${integrity.resurrectedAncestors}), typecheck ` +
        (integrity.typecheckRan ? `exit ${integrity.typecheckExitCode}` : "SKIPPED — run `npm run check` by hand") +
        `. Details: ${integrityReportPath}`,
    );
  }
  log(`round report: ${reportPath}`);
  return clean ? 0 : 1;
}

export function cliMain(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`[rebase-triage] ${args.error}`);
    return 1;
  }
  if (args.help) {
    console.log(
      [
        "rebase-conflict-triage — scripted completion-rebase conflict triage",
        "",
        "  npx tsx scripts/rebase-conflict-triage.ts             triage the current conflict round",
        "  npx tsx scripts/rebase-conflict-triage.ts --dry-run   classify + plan only, no mutations",
        "  npx tsx scripts/rebase-conflict-triage.ts --side X    take --ours/--theirs instead of the default",
        "  npx tsx scripts/rebase-conflict-triage.ts --verify    post-round integrity pass",
        "",
        "Protocol: COMPLETION_REBASE_TRIAGE.md. Reports: .local/runs/rebase-triage/",
      ].join("\n"),
    );
    return 0;
  }
  try {
    return args.verify ? runVerify() : runTriage({ dryRun: args.dryRun, side: args.side });
  } catch (err) {
    console.error(`[rebase-triage] fatal: ${(err as Error).stack ?? String(err)}`);
    return 1;
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(cliMain(process.argv.slice(2)));
}
