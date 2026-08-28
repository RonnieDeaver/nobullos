/**
 * Task #5316 — Live diff-provenance tool for stale-base review: pure logic.
 *
 * Completion code review diffs a task against a base tree that can go stale
 * between when the diff was computed and when it's actually reviewed — main
 * moves (many merges/day), so the reviewer flags files the task never
 * touched and blames unrelated upstream work on it. Fixing this used to be
 * entirely manual: `git log`/`git diff`/`git merge-base` archaeology run by
 * hand every single time (see `.agents/memory/completion-review-stale-base.md`
 * for the pre-existing recipe). scripts/gateLintAttribution.ts already solved
 * the identical staleness problem for gate LINT reds (Task #4491) — a LIVE,
 * re-derived-at-the-moment-of-use comparison, never a cached snapshot or a
 * periodically-published manifest. This module extends that same approach to
 * the separate, previously-uncovered case: proving a task's true diff
 * surface and per-file ownership against the live upstream tip at the moment
 * a completion review (or any "your diff contains unrelated changes"
 * challenge) needs rebuttal evidence.
 *
 * Base-tree resolution (WHICH commit is "the base") is reused verbatim from
 * gateLintAttribution's `resolveBaseTree` — same merge-commit HEAD^2 vs
 * linear-history HEAD conventions, same accepted limitation (a hypothetical
 * mid-session self-commit is treated as base). Importing the exact function
 * (rather than re-implementing the convention) guarantees the two tools can
 * never drift apart on what "the task's base" means.
 *
 * The true diff SURFACE (which files actually differ), however, is computed
 * independently here via `computeTrueDiffSurface` — a single
 * `git diff --name-only <baseCommit>` against the live working tree, not
 * `resolveBaseTree`'s own `taskDiffFiles` (a committed-diff ∪ status-porcelain
 * union tuned for gateLintAttribution's needs, which this tool intentionally
 * does not reuse). `git diff --name-only <baseCommit>` — one argument, no
 * second ref — diffs the named commit against the CURRENT effective content
 * of the working tree (staged + unstaged combined), so a path that was
 * committed by the task and then reverted (in a later commit, or by an
 * in-progress uncommitted edit) back to byte-identical upstream content
 * correctly nets to "no difference" and drops out of the diff surface.
 * Naively unioning `git status --porcelain` paths (any path that differs
 * from HEAD) with a committed base..head diff — as gateLintAttribution's
 * `taskDiffFiles` does — cannot see that net-zero case: a path can differ
 * from HEAD while still being byte-identical to the upstream tip. Untracked
 * paths are never part of `git diff` output at all, so they are added back
 * from `git status --porcelain`'s `??` entries unconditionally (a genuinely
 * new path has nothing at the base commit to net against).
 *
 * Ownership classification for a named ("flagged") file path:
 *   1. A path with an UNCOMMITTED working-tree change is unambiguously this
 *      task's own (in-progress) edit — no ancestry check needed.
 *   2. Otherwise, find the path's last-touch commit reachable from HEAD
 *      (`git log -1 -- <path>`). If none exists, the path was never touched
 *      by this branch at all (`not-found` — usually means the reviewer named
 *      a path that isn't actually part of any diff).
 *   3. Otherwise, cross the owning commit's ancestry against the upstream
 *      tip (`git merge-base --is-ancestor`) WITH whether the path is
 *      actually present in the freshly computed diff surface
 *      (`taskDiffFiles`). Both signals must agree before the tool asserts
 *      ownership either way — ancestry alone is NOT sufficient, because a
 *      path's last-touch commit can be non-ancestor (task-side) while its
 *      *current content* is still identical to the upstream tip (a net-zero
 *      edit: e.g. the task edited the file and then reverted it, or a later
 *      commit converged back to upstream's content). Citing "own" from
 *      ancestry alone in that case would hand a reviewer materially false
 *      evidence — this is exactly the class of bug this module exists to
 *      prevent, so it must not reproduce it internally.
 *        - not-an-ancestor AND in the diff surface → `own` (expected/
 *          consistent: genuinely part of this task's own diff).
 *        - ancestor AND NOT in the diff surface → `inherited` (expected/
 *          consistent: pre-existing upstream work, not part of this task).
 *        - not-an-ancestor AND NOT in the diff surface → `not-in-diff`
 *          (net-zero edit: the owning commit is task-only, but current
 *          content already matches the upstream tip — never assert this is
 *          part of the task's diff).
 *        - ancestor AND in the diff surface → `ambiguous` (the owning
 *          commit is upstream-only, yet content still differs from the
 *          upstream tip — a `git log -1` traversal-order anomaly; never
 *          assert either way, flag for manual investigation).
 *
 * Everything here is read-only (`git log`, `git status`, `git merge-base
 * --is-ancestor`, `git rev-list`, `git diff --name-only`) — no writes, no
 * network, no worktrees. scripts/diff-provenance.ts is the thin CLI wrapper;
 * tests/diff-provenance.test.ts proves this module against small synthetic
 * git fixtures (temp repos), not live repo state.
 */

import { spawnSync } from "node:child_process";

import { parsePorcelainPaths, resolveBaseTree, type BaseTreeInfo } from "./gateLintAttribution";

export { parsePorcelainPaths, resolveBaseTree, type BaseTreeInfo };

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

interface GitResult {
  /** Raw process exit code; null when git could not even be spawned. */
  status: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
}

function git(repoRoot: string, args: string[]): GitResult {
  try {
    const res = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      spawnError: res.error ? String(res.error) : null,
    };
  } catch (err) {
    return { status: null, stdout: "", stderr: "", spawnError: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// File-ownership classification
// ---------------------------------------------------------------------------

export type OwnershipStatus =
  | "uncommitted"
  | "own"
  | "inherited"
  | "not-in-diff"
  | "ambiguous"
  | "not-found"
  | "error";

export interface FileOwnership {
  path: string;
  status: OwnershipStatus;
  ownerCommit: string | null;
  ownerSubject: string | null;
  evidence: string[];
}

/**
 * The task's true diff surface vs `baseCommit`: a single `git diff
 * --name-only <baseCommit>` (one ref — diffs the commit against the live
 * working tree's effective content, staged + unstaged combined) plus
 * untracked paths added back from `git status --porcelain`. See the module
 * doc for why this — not a status-porcelain ∪ committed-diff union — is
 * required to correctly net out a reverted (net-zero) edit, committed OR
 * still uncommitted.
 */
export function computeTrueDiffSurface(repoRoot: string, baseCommit: string): { files: string[]; error: string | null } {
  const diffRes = git(repoRoot, ["diff", "--name-only", baseCommit]);
  if (diffRes.status !== 0) {
    return {
      files: [],
      error: `git diff --name-only ${baseCommit.slice(0, 10)} failed (exit ${diffRes.status ?? "spawn-error"}): ${(diffRes.spawnError ?? diffRes.stderr).trim().slice(0, 300)}`,
    };
  }
  const files = new Set<string>();
  for (const line of diffRes.stdout.split("\n")) {
    const t = line.trim();
    if (t) files.add(t);
  }

  const statusRes = git(repoRoot, ["status", "--porcelain"]);
  if (statusRes.status !== 0) {
    return {
      files: [],
      error: `git status --porcelain failed (exit ${statusRes.status ?? "spawn-error"}): ${(statusRes.spawnError ?? statusRes.stderr).trim().slice(0, 300)}`,
    };
  }
  for (const line of statusRes.stdout.split("\n")) {
    if (line.startsWith("??")) {
      for (const p of parsePorcelainPaths(line)) files.add(p);
    }
  }

  return { files: Array.from(files).sort(), error: null };
}

/**
 * Classify one flagged file path. Pure aside from the injected git calls —
 * every branch is deterministic given the repo state, so the fixture tests
 * exercise this against real (tiny, synthetic) git history rather than
 * mocking git output.
 */
export function classifyFileOwnership(opts: {
  repoRoot: string;
  path: string;
  upstreamTip: string;
  uncommittedPaths: ReadonlySet<string>;
  /**
   * The task's freshly computed diff surface (`taskDiffFiles`). Required:
   * ancestry alone can misclassify a net-zero edit as `own` (see module
   * doc), so every non-trivial verdict is cross-checked against whether the
   * path is actually present here.
   */
  diffSurface: ReadonlySet<string>;
}): FileOwnership {
  const { repoRoot, path, upstreamTip, uncommittedPaths, diffSurface } = opts;

  if (uncommittedPaths.has(path)) {
    if (diffSurface.has(path)) {
      return {
        path,
        status: "uncommitted",
        ownerCommit: null,
        ownerSubject: null,
        evidence: [
          "working tree has an uncommitted change to this path, and it IS present in the freshly computed diff surface — unambiguously this task's own (in-progress) edit",
        ],
      };
    }
    return {
      path,
      status: "not-in-diff",
      ownerCommit: null,
      ownerSubject: null,
      evidence: [
        "working tree shows this path as changed/untracked relative to the last commit, BUT it is absent from the freshly computed diff surface — its current (uncommitted) content already matches the upstream tip byte-for-byte (a net-zero in-progress reversion); do NOT cite this as part of the task's diff",
      ],
    };
  }

  const logRes = git(repoRoot, ["log", "-1", "--format=%H%x1f%s", "--", path]);
  if (logRes.status !== 0) {
    return {
      path,
      status: "error",
      ownerCommit: null,
      ownerSubject: null,
      evidence: [
        `git log failed (exit ${logRes.status ?? "spawn-error"}): ${(logRes.spawnError ?? logRes.stderr).trim().slice(0, 300)}`,
      ],
    };
  }
  const line = logRes.stdout.trim();
  if (!line) {
    return {
      path,
      status: "not-found",
      ownerCommit: null,
      ownerSubject: null,
      evidence: [
        "no commit in HEAD's history touches this path, and it has no uncommitted change — this path was never touched by this branch",
      ],
    };
  }
  const sep = line.indexOf("\u001f");
  const ownerCommit = sep === -1 ? line : line.slice(0, sep);
  const ownerSubject = sep === -1 ? "" : line.slice(sep + 1);

  const ancRes = git(repoRoot, ["merge-base", "--is-ancestor", ownerCommit, upstreamTip]);
  if (ancRes.status !== 0 && ancRes.status !== 1) {
    return {
      path,
      status: "error",
      ownerCommit,
      ownerSubject,
      evidence: [
        `git merge-base --is-ancestor failed (exit ${ancRes.status ?? "spawn-error"}): ${(ancRes.spawnError ?? ancRes.stderr).trim().slice(0, 300)}`,
      ],
    };
  }

  const shortOwner = ownerCommit.slice(0, 10);
  const shortTip = upstreamTip.slice(0, 10);
  const isAncestor = ancRes.status === 0;
  const inDiffSurface = diffSurface.has(path);
  const ownerLine = `last touched by ${shortOwner} ("${ownerSubject}")`;

  if (isAncestor && !inDiffSurface) {
    return {
      path,
      status: "inherited",
      ownerCommit,
      ownerSubject,
      evidence: [
        ownerLine,
        `${shortOwner} IS an ancestor of the upstream tip ${shortTip}, and the path is absent from the freshly computed diff surface — already present upstream, not part of this task's diff`,
      ],
    };
  }
  if (!isAncestor && inDiffSurface) {
    return {
      path,
      status: "own",
      ownerCommit,
      ownerSubject,
      evidence: [
        ownerLine,
        `${shortOwner} is NOT an ancestor of the upstream tip ${shortTip}, and the path IS present in the freshly computed diff surface — genuinely part of this task's own diff`,
      ],
    };
  }
  if (!isAncestor && !inDiffSurface) {
    return {
      path,
      status: "not-in-diff",
      ownerCommit,
      ownerSubject,
      evidence: [
        ownerLine,
        `${shortOwner} is NOT an ancestor of the upstream tip ${shortTip}, BUT the path is absent from the freshly computed diff surface — a net-zero edit (current content already matches the upstream tip); do NOT cite this as part of the task's diff`,
      ],
    };
  }
  // isAncestor && inDiffSurface
  return {
    path,
    status: "ambiguous",
    ownerCommit,
    ownerSubject,
    evidence: [
      ownerLine,
      `${shortOwner} IS an ancestor of the upstream tip ${shortTip}, BUT the path IS present in the freshly computed diff surface — content differs from upstream despite an upstream-attributed last-touch commit (traversal-order anomaly); investigate before citing either way`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Full report
// ---------------------------------------------------------------------------

export interface ProvenanceReport {
  schemaVersion: 1;
  generatedAt: string;
  repoRoot: string;
  head: string;
  /** Non-null only when base resolution itself failed. */
  error: string | null;
  baseResolution: BaseTreeInfo["resolution"] | null;
  upstreamTip: string | null;
  upstreamTipSubject: string | null;
  /** The task's true diff surface vs the upstream tip, freshly computed. */
  taskDiffFiles: string[];
  flaggedFiles: FileOwnership[];
}

/**
 * Build the full live report: resolves the base the same way
 * gateLintAttribution does, then classifies every flagged path against the
 * resolved upstream tip. Diff-surface membership is cross-checked INSIDE
 * `classifyFileOwnership` itself (not bolted on afterward) — every `own` /
 * `inherited` verdict already agrees with the freshly computed diff surface;
 * a disagreement produces `not-in-diff` or `ambiguous` instead, so the
 * paste-ready evidence block can never assert ownership that contradicts
 * the diff surface printed right above it.
 */
export function buildProvenanceReport(opts: {
  repoRoot: string;
  flaggedPaths: readonly string[];
}): ProvenanceReport {
  const { repoRoot } = opts;
  const generatedAt = new Date().toISOString();
  const headRes = git(repoRoot, ["rev-parse", "HEAD"]);
  const head = headRes.status === 0 ? headRes.stdout.trim() : "?";

  const base = resolveBaseTree(repoRoot);
  if ("error" in base) {
    return {
      schemaVersion: 1,
      generatedAt,
      repoRoot,
      head,
      error: base.error,
      baseResolution: null,
      upstreamTip: null,
      upstreamTipSubject: null,
      taskDiffFiles: [],
      flaggedFiles: [],
    };
  }

  const surfaceRes = computeTrueDiffSurface(repoRoot, base.baseCommit);
  if (surfaceRes.error) {
    return {
      schemaVersion: 1,
      generatedAt,
      repoRoot,
      head,
      error: surfaceRes.error,
      baseResolution: base.resolution,
      upstreamTip: base.baseCommit,
      upstreamTipSubject: base.baseSubject,
      taskDiffFiles: [],
      flaggedFiles: [],
    };
  }

  const statusRes = git(repoRoot, ["status", "--porcelain"]);
  const uncommittedPaths = new Set<string>(statusRes.status === 0 ? parsePorcelainPaths(statusRes.stdout) : []);
  const diffSurface = new Set(surfaceRes.files);

  const flaggedFiles = opts.flaggedPaths.map((path) =>
    classifyFileOwnership({ repoRoot, path, upstreamTip: base.baseCommit, uncommittedPaths, diffSurface }),
  );

  return {
    schemaVersion: 1,
    generatedAt,
    repoRoot,
    head,
    error: null,
    baseResolution: base.resolution,
    upstreamTip: base.baseCommit,
    upstreamTipSubject: base.baseSubject,
    taskDiffFiles: surfaceRes.files,
    flaggedFiles,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function short(sha: string): string {
  return sha.slice(0, 10);
}

const STATUS_LABEL: Record<OwnershipStatus, string> = {
  inherited: "INHERITED (already upstream, not this task's)",
  own: "OWN (genuinely part of this task's diff)",
  uncommitted: "OWN (uncommitted working-tree edit)",
  "not-in-diff": "NOT IN DIFF (net-zero edit — current content already matches upstream; NOT part of this task's diff)",
  ambiguous: "AMBIGUOUS (owner looks upstream, but content differs from upstream — investigate, do not cite either way)",
  "not-found": "NOT TOUCHED (no commit or working-tree edit found on this path)",
  error: "ERROR",
};

/** Human-readable console summary. Pure; exported for tests. */
export function formatSummaryLines(report: ProvenanceReport): string[] {
  const lines: string[] = [];
  if (report.error) {
    lines.push(`[diff-provenance] base resolution FAILED: ${report.error}`);
    return lines;
  }
  lines.push(
    `[diff-provenance] HEAD ${short(report.head)} vs upstream tip ${short(report.upstreamTip!)} ("${report.upstreamTipSubject}") — resolution: ${report.baseResolution}`,
  );
  lines.push(`[diff-provenance] task's true diff surface: ${report.taskDiffFiles.length} file(s)`);
  const MAX_LISTED = 200;
  for (const f of report.taskDiffFiles.slice(0, MAX_LISTED)) lines.push(`  - ${f}`);
  if (report.taskDiffFiles.length > MAX_LISTED) {
    lines.push(`  … and ${report.taskDiffFiles.length - MAX_LISTED} more (see the evidence block / JSON report)`);
  }
  if (report.flaggedFiles.length > 0) {
    lines.push("");
    lines.push(`[diff-provenance] flagged-file ownership (${report.flaggedFiles.length}):`);
    for (const f of report.flaggedFiles) {
      lines.push(`  - ${f.path}: ${STATUS_LABEL[f.status]}`);
      for (const e of f.evidence) lines.push(`      ${e}`);
    }
  }
  return lines;
}

/**
 * Ready-to-paste markdown evidence block — designed to drop directly into a
 * completion's drift/rebuttal explanation with no further editing.
 */
export function formatEvidenceBlock(report: ProvenanceReport): string {
  if (report.error) {
    return `Diff-provenance evidence: base resolution FAILED (${report.error}) — cannot produce evidence; investigate the repo state by hand.`;
  }
  const lines: string[] = [];
  lines.push(
    `## Diff-provenance evidence (live, HEAD \`${short(report.head)}\` vs upstream tip \`${short(report.upstreamTip!)}\` "${report.upstreamTipSubject}")`,
  );
  lines.push("");
  lines.push(`Base resolution: \`${report.baseResolution}\` (same convention as scripts/gateLintAttribution.ts).`);
  lines.push("");
  lines.push(`**Task's true diff surface vs the current upstream tip (${report.taskDiffFiles.length} file(s)):**`);
  if (report.taskDiffFiles.length === 0) {
    lines.push("- (none — the task tree is currently identical to the upstream tip)");
  } else {
    for (const f of report.taskDiffFiles) lines.push(`- \`${f}\``);
  }
  if (report.flaggedFiles.length > 0) {
    lines.push("");
    lines.push("**Flagged-file ownership:**");
    for (const f of report.flaggedFiles) {
      if (f.status === "inherited") {
        lines.push(
          `- \`${f.path}\`: last touched by \`${short(f.ownerCommit!)}\` ("${f.ownerSubject}"), which **is already an ancestor** of the upstream tip \`${short(report.upstreamTip!)}\` and is **absent from the diff surface above** — inherited upstream work, not part of this task's diff.`,
        );
      } else if (f.status === "own") {
        lines.push(
          `- \`${f.path}\`: last touched by \`${short(f.ownerCommit!)}\` ("${f.ownerSubject}"), which is **NOT** an ancestor of the upstream tip \`${short(report.upstreamTip!)}\` and **is present in the diff surface above** — genuinely part of this task's own diff.`,
        );
      } else if (f.status === "uncommitted") {
        lines.push(`- \`${f.path}\`: has an **uncommitted working-tree edit** — genuinely part of this task's own (in-progress) diff.`);
      } else if (f.status === "not-in-diff") {
        const ownerNote = f.ownerCommit
          ? `last touched by \`${short(f.ownerCommit)}\` ("${f.ownerSubject}", not an ancestor of the upstream tip)`
          : "has an uncommitted working-tree change vs the last commit";
        lines.push(
          `- \`${f.path}\`: ${ownerNote}, but the path is **absent from the diff surface above** — a net-zero edit, current content already matches upstream. **This is NOT part of the task's diff; do not cite it as one.**`,
        );
      } else if (f.status === "ambiguous") {
        lines.push(
          `- \`${f.path}\`: last touched by \`${short(f.ownerCommit!)}\` ("${f.ownerSubject}", an ancestor of the upstream tip), yet the path **is present in the diff surface above** — content differs from upstream despite an upstream-attributed owner. **Ambiguous: investigate by hand before citing this either way.**`,
        );
      } else if (f.status === "not-found") {
        lines.push(`- \`${f.path}\`: no commit in HEAD's history and no working-tree edit touches this path — never touched by this branch.`);
      } else {
        lines.push(`- \`${f.path}\`: ERROR — ${f.evidence.join("; ")}`);
      }
    }
  }
  lines.push("");
  lines.push(
    `_Generated ${report.generatedAt} by \`npx tsx scripts/diff-provenance.ts\` — live, freshly computed, never from a cached report._`,
  );
  return lines.join("\n");
}
