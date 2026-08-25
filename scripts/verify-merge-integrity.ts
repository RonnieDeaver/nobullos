/**
 * Task #3922 — Post-merge branch-integrity verification.
 *
 * Ran by scripts/post-merge.sh right after every system merge (the platform
 * merging upstream main into a task branch mid-session, or a task landing on
 * main). History shows those merges occasionally SMEAR the branch — files end
 * up differing from the merged upstream tip even though no task commit ever
 * touched them, sometimes resurrecting ancestor content that upstream had
 * since changed — and the damage used to surface only at completion review.
 * This script mechanizes the check within minutes of the merge instead.
 *
 * What it verifies when HEAD is a merge commit (upstream tip = HEAD^2):
 *   1. SMEAR: every file where the merged tree differs from the upstream tip
 *      must be accounted for by the task's own work (committed on the task
 *      side since the merge base, or currently modified in the worktree).
 *      Anything else is a smear suspect.
 *   2. RESURRECTED ANCESTOR: a smear suspect whose merged blob is identical
 *      to the merge-base blob while upstream moved on — the classic
 *      "merge silently reverted upstream's change" corruption.
 *   3. TYPECHECK: runs `npm run check` (doubling as the incremental-cache
 *      pre-warm this hook replaced) and splits error files into task-touched
 *      vs not — errors in files the task never touched are likely inherited
 *      from the merge and should be attributed as such, not hand-fixed N
 *      times across sibling tasks.
 *
 * Output: loud console warnings plus a machine-readable report at
 * .local/runs/merge-integrity.json (same citation role as the runner's
 * .local/runs/attribution-report.json — quote it in drift/skip explanations
 * and completion-review rebuttals). Time-budgeted via MERGE_INTEGRITY_BUDGET_MS
 * (default 180s); blob checks and the typecheck degrade to "skipped" notes
 * when the budget runs out. ALWAYS exits 0 — detection is the deliverable;
 * repair stays agent-driven (TASK_PREFLIGHT.md § 12) and the gate re-reports
 * typecheck failures authoritatively later.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MERGE_INTEGRITY_REPORT_PATH = ".local/runs/merge-integrity.json";
const DEFAULT_BUDGET_MS = 180_000;
const MAX_STORED_DIVERGING = 500;
const MAX_BLOB_CHECKS = 200;

export interface MergeIntegritySmear {
  file: string;
  resurrectedAncestorBlob: boolean;
  blobCheck: "done" | "skipped";
}

export interface MergeIntegrityTypecheck {
  ran: boolean;
  exitCode: number | null;
  errorFiles: string[];
  errorFilesNotTaskTouched: string[];
  skippedReason: string | null;
}

export interface MergeIntegrityReport {
  schemaVersion: 1;
  generatedAt: string;
  kind: "merge" | "not-a-merge" | "error";
  error: string | null;
  head: string | null;
  ours: string | null;
  upstream: string | null;
  mergeBase: string | null;
  /** Files accounted to the task: committed on the task side since the merge
   * base, plus current worktree modifications. */
  taskTouchedFiles: string[];
  /** Files where the merged tree differs from the upstream tip (capped). */
  filesDivergingFromUpstream: string[];
  /** Diverging files NOT accounted to the task — smear suspects. */
  smearedFiles: MergeIntegritySmear[];
  typecheck: MergeIntegrityTypecheck;
  warnings: string[];
  budgetMs: number;
  elapsedMs: number;
}

export interface AnalyzeOptions {
  repoRoot: string;
  budgetMs?: number;
  /** Disable the `npm run check` probe (tests use synthetic repos without a
   * package.json script). */
  runTypecheck?: boolean;
}

function runGit(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message };
  }
}

function gitLines(repoRoot: string, args: string[]): string[] | null {
  const res = runGit(repoRoot, args);
  if (!res.ok) return null;
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Strip git's quoting of unusual paths ("a b.ts" incl. escapes) — best effort. */
function unquoteGitPath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    return p.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return p;
}

function worktreeFiles(repoRoot: string): string[] {
  const lines = gitLines(repoRoot, ["status", "--porcelain"]) ?? [];
  const out: string[] = [];
  for (const line of lines) {
    const body = line.slice(2).trim();
    // Rename entries look like `old -> new`; both sides count as touched.
    const arrow = body.indexOf(" -> ");
    if (arrow >= 0) {
      out.push(unquoteGitPath(body.slice(0, arrow).trim()));
      out.push(unquoteGitPath(body.slice(arrow + 4).trim()));
    } else {
      out.push(unquoteGitPath(body));
    }
  }
  return out;
}

function blobSha(repoRoot: string, rev: string, file: string): string | null {
  const res = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${rev}:${file}`]);
  if (!res.ok) return null;
  const sha = res.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * Extract the unique set of files carrying `error TS…` diagnostics from tsc
 * output. Pure; exported for tests.
 */
export function parseTscErrorFiles(output: string): string[] {
  const files = new Set<string>();
  const rx = /^(.+?\.(?:ts|tsx|mts|cts))\(\d+,\d+\):\s+error TS\d+/;
  for (const raw of output.split("\n")) {
    const m = rx.exec(raw.trim());
    if (m) files.add(m[1].replace(/\\/g, "/"));
  }
  return [...files].sort();
}

export function analyzeMergeIntegrity(opts: AnalyzeOptions): MergeIntegrityReport {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const remaining = () => budgetMs - (Date.now() - startedAt);
  const report: MergeIntegrityReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: "error",
    error: null,
    head: null,
    ours: null,
    upstream: null,
    mergeBase: null,
    taskTouchedFiles: [],
    filesDivergingFromUpstream: [],
    smearedFiles: [],
    typecheck: { ran: false, exitCode: null, errorFiles: [], errorFilesNotTaskTouched: [], skippedReason: null },
    warnings: [],
    budgetMs,
    elapsedMs: 0,
  };
  try {
    const head = gitLines(opts.repoRoot, ["rev-parse", "HEAD"])?.[0] ?? null;
    if (!head) {
      report.error = "git rev-parse HEAD failed — not a git repository?";
      report.elapsedMs = Date.now() - startedAt;
      return report;
    }
    report.head = head;

    const upstream = gitLines(opts.repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^2"])?.[0] ?? null;
    if (!upstream) {
      report.kind = "not-a-merge";
      report.typecheck = maybeTypecheck(opts, report, remaining());
      report.elapsedMs = Date.now() - startedAt;
      return report;
    }
    report.upstream = upstream;
    const ours = gitLines(opts.repoRoot, ["rev-parse", "HEAD^1"])?.[0] ?? null;
    const mergeBase = ours ? (gitLines(opts.repoRoot, ["merge-base", ours, upstream])?.[0] ?? null) : null;
    report.ours = ours;
    report.mergeBase = mergeBase;
    if (!ours || !mergeBase) {
      report.error = "could not resolve HEAD^1 / merge-base — cannot attribute divergence";
      report.warnings.push("[merge-integrity] merge parents unresolved; treat ALL divergence as suspect until verified by hand");
      report.elapsedMs = Date.now() - startedAt;
      return report;
    }
    report.kind = "merge";

    const diverging = gitLines(opts.repoRoot, ["diff", "--name-only", upstream, "HEAD"]);
    const taskSide = gitLines(opts.repoRoot, ["diff", "--name-only", mergeBase, ours]);
    if (diverging === null || taskSide === null) {
      report.error = "git diff --name-only failed";
      report.elapsedMs = Date.now() - startedAt;
      return report;
    }
    const touched = new Set<string>([...taskSide, ...worktreeFiles(opts.repoRoot)]);
    report.taskTouchedFiles = [...touched].sort();
    if (diverging.length > MAX_STORED_DIVERGING) {
      report.warnings.push(
        `[merge-integrity] ${diverging.length} files diverge from the upstream tip — storing first ${MAX_STORED_DIVERGING} (tree-level divergence this large usually means a corrupted merge)`,
      );
    }
    report.filesDivergingFromUpstream = diverging.slice(0, MAX_STORED_DIVERGING);

    const smearCandidates = diverging.filter((f) => !touched.has(f));
    for (const [i, file] of smearCandidates.entries()) {
      const withinBudget = remaining() > 5_000 && i < MAX_BLOB_CHECKS;
      if (!withinBudget) {
        report.smearedFiles.push({ file, resurrectedAncestorBlob: false, blobCheck: "skipped" });
        continue;
      }
      const shaHead = blobSha(opts.repoRoot, "HEAD", file);
      const shaBase = blobSha(opts.repoRoot, mergeBase, file);
      const shaUp = blobSha(opts.repoRoot, upstream, file);
      const resurrected = shaHead !== null && shaBase !== null && shaHead === shaBase && shaBase !== shaUp;
      report.smearedFiles.push({ file, resurrectedAncestorBlob: resurrected, blobCheck: "done" });
    }
    if (smearCandidates.length > 0 && report.smearedFiles.some((s) => s.blobCheck === "skipped")) {
      report.warnings.push(
        `[merge-integrity] budget/cap exhausted before all blob checks (${report.smearedFiles.filter((s) => s.blobCheck === "skipped").length} skipped) — smear list is complete, resurrected-ancestor flags are not`,
      );
    }

    report.typecheck = maybeTypecheck(opts, report, remaining());
    report.elapsedMs = Date.now() - startedAt;
    return report;
  } catch (err) {
    report.kind = "error";
    report.error = (err as Error).message;
    report.elapsedMs = Date.now() - startedAt;
    return report;
  }
}

function maybeTypecheck(opts: AnalyzeOptions, report: MergeIntegrityReport, remainingMs: number): MergeIntegrityTypecheck {
  const tc: MergeIntegrityTypecheck = {
    ran: false,
    exitCode: null,
    errorFiles: [],
    errorFilesNotTaskTouched: [],
    skippedReason: null,
  };
  if (opts.runTypecheck === false) {
    tc.skippedReason = "disabled by options";
    return tc;
  }
  if (remainingMs < 15_000) {
    tc.skippedReason = `budget exhausted (${remainingMs}ms left) — run \`npm run check\` manually`;
    report.warnings.push(`[merge-integrity] typecheck probe skipped: ${tc.skippedReason}`);
    return tc;
  }
  try {
    const res = spawnSync("npm", ["run", "check"], {
      cwd: opts.repoRoot,
      encoding: "utf8",
      timeout: remainingMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    tc.ran = true;
    tc.exitCode = res.status;
    if (res.status !== 0) {
      const touched = new Set(report.taskTouchedFiles);
      tc.errorFiles = parseTscErrorFiles(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
      tc.errorFilesNotTaskTouched = tc.errorFiles.filter((f) => !touched.has(f));
    }
  } catch (err) {
    tc.skippedReason = `typecheck spawn failed: ${(err as Error).message}`;
  }
  return tc;
}

/** Build the loud console block for a report. Pure; exported for tests. */
export function formatMergeIntegrityWarnings(report: MergeIntegrityReport): string[] {
  const lines: string[] = [];
  const short = (c: string | null) => (c ? c.slice(0, 10) : "?");
  if (report.kind === "not-a-merge") {
    lines.push(
      `[merge-integrity] HEAD is not a merge commit — nothing to verify (typecheck ${report.typecheck.ran ? `exit ${report.typecheck.exitCode}` : "skipped"}).`,
    );
    return lines;
  }
  if (report.kind === "error") {
    lines.push(`[merge-integrity] verification errored: ${report.error ?? "unknown"} — treat the merge as UNVERIFIED and inspect by hand.`);
    return lines;
  }
  const smears = report.smearedFiles;
  const resurrected = smears.filter((s) => s.resurrectedAncestorBlob);
  const inheritedTsc = report.typecheck.errorFilesNotTaskTouched;
  if (smears.length === 0 && inheritedTsc.length === 0 && (report.typecheck.exitCode ?? 0) === 0) {
    lines.push(
      `[merge-integrity] OK — merge ${short(report.head)} matches upstream ${short(report.upstream)} outside the ${report.taskTouchedFiles.length} task-touched file(s); typecheck ${report.typecheck.ran ? "clean" : `skipped (${report.typecheck.skippedReason ?? "?"})`}.`,
    );
    return lines;
  }
  lines.push("=================================================================");
  lines.push("!!! MERGE INTEGRITY WARNING (Task #3922) — read before continuing !!!");
  if (smears.length > 0) {
    lines.push(
      `The merge of upstream ${short(report.upstream)} changed ${smears.length} file(s) relative to the upstream tip that NO task commit or worktree edit touched (smear suspects):`,
    );
    for (const s of smears.slice(0, 20)) {
      lines.push(`  - ${s.file}${s.resurrectedAncestorBlob ? "  << RESURRECTED ANCESTOR CONTENT (upstream's newer version was reverted)" : ""}`);
    }
    if (smears.length > 20) lines.push(`  … and ${smears.length - 20} more (see report)`);
    if (resurrected.length > 0) {
      lines.push(`Repair: restore upstream's version — \`git show ${short(report.upstream)}:<file>\` — or re-merge; verify with \`git diff ${short(report.upstream)} HEAD\`.`);
    }
  }
  if (report.typecheck.ran && (report.typecheck.exitCode ?? 0) !== 0) {
    lines.push(
      `Typecheck is RED after the merge: ${report.typecheck.errorFiles.length} error file(s), of which ${inheritedTsc.length} were NOT touched by this task${inheritedTsc.length > 0 ? ` (likely inherited): ${inheritedTsc.slice(0, 10).join(", ")}${inheritedTsc.length > 10 ? ", …" : ""}` : ""}.`,
    );
  }
  for (const w of report.warnings) lines.push(w);
  lines.push(`Full report: ${MERGE_INTEGRITY_REPORT_PATH} — cite it in drift/skip explanations; do NOT silently hand-fix inherited breakage in N sibling tasks (one fix belongs on main).`);
  lines.push("=================================================================");
  return lines;
}

export function writeMergeIntegrityReport(report: MergeIntegrityReport, absPath: string): boolean {
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function cliMain(): number {
  const repoRoot = process.cwd();
  const budgetMs = Number(process.env.MERGE_INTEGRITY_BUDGET_MS ?? "") || DEFAULT_BUDGET_MS;
  const report = analyzeMergeIntegrity({ repoRoot, budgetMs, runTypecheck: true });
  const wrote = writeMergeIntegrityReport(report, resolve(repoRoot, MERGE_INTEGRITY_REPORT_PATH));
  for (const line of formatMergeIntegrityWarnings(report)) console.log(line);
  if (!wrote) console.log(`[merge-integrity] report write failed — console output above is the only record`);
  // Detection is the deliverable; environment setup must never break on it.
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("verify-merge-integrity.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
