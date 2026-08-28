/**
 * Task #5316 — Live diff-provenance tool for stale-base review: CLI.
 *
 * Standard first move for a completion review that flags "this diff contains
 * unrelated changes": instead of hand-running `git log`/`git diff`/
 * `git merge-base` archaeology (the old manual recipe in
 * `.agents/memory/completion-review-stale-base.md`), this prints, in
 * seconds:
 *
 *   1. The task's true diff surface vs the current upstream tip — freshly
 *      computed from live git state (never a cached report), using the exact
 *      same base-tree convention as scripts/gateLintAttribution.ts
 *      (merge-commit HEAD^2 vs linear-history HEAD).
 *   2. For every file path named on the command line ("flagged" by a
 *      reviewer), whether that file's owning commit is already an ancestor
 *      of the upstream tip (inherited upstream work — not this task) or
 *      genuinely part of this task's own diff.
 *
 * The output ends with a ready-to-paste markdown block for a completion's
 * drift/rebuttal explanation — see TASK_PREFLIGHT.md § 12 for when to use
 * this tool.
 *
 * Usage:
 *   npx tsx scripts/diff-provenance.ts                       # diff surface only
 *   npx tsx scripts/diff-provenance.ts path/a.ts path/b.ts    # + ownership of named files
 *
 * All logic here is read-only (git log/status/merge-base/diff --name-only) —
 * no writes, no network, no worktrees. Exit code is 1 only when base
 * resolution itself fails (e.g. not a git repo); flagged-file ownership
 * results never affect the exit code — they are evidence, not a pass/fail
 * gate. This tool is standalone and intentionally not wired into
 * scripts/gate.ts or any other automatic step (see the task's "Out of
 * scope").
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildProvenanceReport, formatEvidenceBlock, formatSummaryLines } from "./diffProvenanceLib";

export const DIFF_PROVENANCE_REPORT_PATH = ".local/runs/diff-provenance.json";

const USAGE = `Usage: npx tsx scripts/diff-provenance.ts [file1] [file2] ...

Computes, LIVE (never from a cached report), this task's true diff surface
against the current upstream tip, using the same base-tree convention as
scripts/gateLintAttribution.ts. For each named file path, reports whether its
owning commit is already an ancestor of the upstream tip (inherited upstream
work) or genuinely part of this task's own diff.

With no file arguments, prints only the true diff surface. Ends with a
ready-to-paste markdown evidence block for a completion drift/rebuttal
explanation. See TASK_PREFLIGHT.md § 12.`;

export function parseArgs(argv: readonly string[]): { help: boolean; paths: string[] } {
  const paths: string[] = [];
  let help = false;
  for (const a of argv) {
    if (a === "--help" || a === "-h") help = true;
    else paths.push(a);
  }
  return { help, paths };
}

export function cliMain(argv: readonly string[] = process.argv.slice(2)): number {
  const { help, paths } = parseArgs(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }
  const repoRoot = process.cwd();
  const report = buildProvenanceReport({ repoRoot, flaggedPaths: paths });

  for (const line of formatSummaryLines(report)) console.log(line);
  console.log("");
  console.log("--- Ready-to-paste evidence block (drift/rebuttal explanations) ---");
  console.log(formatEvidenceBlock(report));

  try {
    const absPath = resolve(repoRoot, DIFF_PROVENANCE_REPORT_PATH);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (err) {
    console.log(`[diff-provenance] report write failed (${(err as Error).message}) — console output above is the only record`);
  }

  return report.error ? 1 : 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` || (process.argv[1]?.endsWith("diff-provenance.ts") ?? false);
if (isMain) {
  process.exit(cliMain());
}
