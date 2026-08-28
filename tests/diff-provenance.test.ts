/* test-registration
{
  "name": "Live diff-provenance tool: ownership/ancestry classification against synthetic git fixtures (Task #5316)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5316: this tool is the standard first move for a completion review that flags 'unrelated changes' — a misclassification (inherited vs own) would ship wrong rebuttal evidence into a completion. Pure fixture tests build tiny synthetic git repos in tmpdir (git CLI only): no DB, no network, no live repo state.",
  "scanPaths": ["scripts/diffProvenanceLib.ts", "scripts/diff-provenance.ts", "TASK_PREFLIGHT.md"],
  "tier": "small",
  "tierReason": "Unmeasured suites default to the mechanical 'medium' classification, but this is a DB-free, network-free, browser-free suite: every case builds a tiny synthetic git repo in mkdtemp and shells out to the git CLI only, completing in a few seconds."
}
test-registration */
// fs-scan-fixture-only -- reads files inside mkdtemp git fixture repos only
/**
 * Task #5316 — Proves scripts/diffProvenanceLib.ts (and the CLI arg parser in
 * scripts/diff-provenance.ts) against synthetic git repos, mirroring the
 * fixture style of tests/merge-integrity.test.ts:
 *
 *   1. Linear (non-merge) HEAD — base resolution is "head" (same convention
 *      as gateLintAttribution): an already-committed file classifies
 *      `inherited` (trivially an ancestor of itself, the accepted
 *      limitation), an uncommitted worktree edit classifies `uncommitted`
 *      (own), and an untouched path classifies `not-found`.
 *   2. Merge HEAD — base resolution is "merge-second-parent" (HEAD^2): a file
 *      only the task branch edited classifies `own` (genuinely part of the
 *      task's own diff — not reachable from the upstream side); a file only
 *      the upstream branch edited classifies `inherited`; the true diff
 *      surface is exactly the task's own file, matching the merge-commit
 *      base-resolution convention.
 *   3. Conflict-resolution edge case: a file both branches edited
 *      differently, resolved with new content IN the merge commit itself,
 *      classifies `own` — the merge commit is the file's last-touch commit
 *      and is never an ancestor of the upstream side it merged in.
 *   4. Consistency cross-check notes: an inherited file present in the diff
 *      surface (anomaly) and an own file absent from it (net-zero edit) both
 *      get a NOTE; the expected pairings get a plain consistency-check note.
 *   5. Formatting: the evidence block is ready-to-paste (contains the
 *      upstream tip, every diff-surface file, and a verdict line per flagged
 *      file); a base-resolution failure produces a one-line error output
 *      instead of throwing.
 *   6. CLI arg parsing: `--help`/`-h` short-circuits; everything else is
 *      collected as a flagged path.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProvenanceReport,
  classifyFileOwnership,
  formatEvidenceBlock,
  formatSummaryLines,
  type ProvenanceReport,
} from "../scripts/diffProvenanceLib";
import { parseArgs } from "../scripts/diff-provenance";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Synthetic repo helpers (mirrors tests/merge-integrity.test.ts)
// ---------------------------------------------------------------------------

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

function commitAll(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

function headSha(root: string): string {
  return git(root, "rev-parse", "HEAD");
}

/**
 * base (fileA/fileB/fileC) → task branch edits fileA; upstream (main) branch
 * edits fileB + fileC. Callers then merge main into task, optionally with a
 * conflict.
 */
function makeMergeFixture(): { root: string; upstreamCommit: string } {
  const root = mkdtempSync(join(tmpdir(), "diff-provenance-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "fileA.txt"), "A base\n");
  writeFileSync(join(root, "fileB.txt"), "B base\n");
  writeFileSync(join(root, "fileC.txt"), "C base\n");
  commitAll(root, "base");
  git(root, "checkout", "-q", "-b", "task");
  writeFileSync(join(root, "fileA.txt"), "A task edit\n");
  commitAll(root, "task: edit fileA");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "fileB.txt"), "B upstream edit\n");
  writeFileSync(join(root, "fileC.txt"), "C upstream edit\n");
  commitAll(root, "upstream: edit fileB + fileC");
  const upstreamCommit = headSha(root);
  git(root, "checkout", "-q", "task");
  return { root, upstreamCommit };
}

// ---------------------------------------------------------------------------
// 1. Linear (non-merge) HEAD
// ---------------------------------------------------------------------------

test("linear HEAD → resolution 'head'; committed file is inherited, uncommitted edit is own, untouched path is not-found", () => {
  const root = mkdtempSync(join(tmpdir(), "diff-provenance-lin-"));
  try {
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "one\n");
    commitAll(root, "committed: add a.txt");
    writeFileSync(join(root, "b.txt"), "two, uncommitted\n");

    const report = buildProvenanceReport({ repoRoot: root, flaggedPaths: ["a.txt", "b.txt", "nope.txt"] });
    assert.equal(report.error, null);
    assert.equal(report.baseResolution, "head");
    assert.equal(report.upstreamTip, report.head, "non-merge base is HEAD itself");
    assert.deepEqual(report.taskDiffFiles, ["b.txt"], "only the uncommitted edit is in the diff surface");

    const byPath = new Map(report.flaggedFiles.map((f) => [f.path, f]));
    assert.equal(byPath.get("a.txt")?.status, "inherited", "already-committed file trivially classifies inherited (base===HEAD)");
    assert.equal(byPath.get("b.txt")?.status, "uncommitted");
    assert.equal(byPath.get("nope.txt")?.status, "not-found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Merge HEAD — the two documented edge cases
// ---------------------------------------------------------------------------

test("merge HEAD → resolution 'merge-second-parent'; task's own file classifies own, upstream-only file classifies inherited", () => {
  const { root, upstreamCommit } = makeMergeFixture();
  try {
    git(root, "merge", "-q", "--no-edit", "main");
    const report = buildProvenanceReport({
      repoRoot: root,
      flaggedPaths: ["fileA.txt", "fileB.txt", "fileC.txt", "nope.txt"],
    });
    assert.equal(report.error, null);
    assert.equal(report.baseResolution, "merge-second-parent");
    assert.equal(report.upstreamTip, upstreamCommit, "upstream tip resolves to HEAD^2");
    assert.deepEqual(report.taskDiffFiles, ["fileA.txt"], "true diff surface is exactly the task's own edit");

    const byPath = new Map(report.flaggedFiles.map((f) => [f.path, f]));
    const a = byPath.get("fileA.txt")!;
    assert.equal(a.status, "own", "task-branch-only edit is NOT an ancestor of the upstream tip, and IS in the diff surface");
    assert.equal(a.ownerSubject, "task: edit fileA");
    assert.ok(a.evidence.some((e) => e.includes("IS present in the freshly computed diff surface")));

    const b = byPath.get("fileB.txt")!;
    assert.equal(b.status, "inherited", "upstream-only edit's owning commit IS the resolved upstream tip, and is absent from the diff surface");
    assert.equal(b.ownerCommit, upstreamCommit);
    assert.ok(b.evidence.some((e) => e.includes("absent from the freshly computed diff surface")));

    assert.equal(byPath.get("fileC.txt")?.status, "inherited");
    assert.equal(byPath.get("nope.txt")?.status, "not-found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflict resolved IN the merge commit → last-touch is the merge commit itself, classifies own (never inherited)", () => {
  const { root } = makeMergeFixture();
  try {
    // Both branches already diverge on fileA (task edit) vs untouched on
    // main; force a genuine conflict by having main ALSO edit fileA, then
    // resolve during the merge with brand-new content.
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "fileA.txt"), "A upstream edit too\n");
    commitAll(root, "upstream: also edit fileA (forces a conflict)");
    const newUpstreamCommit = headSha(root);
    git(root, "checkout", "-q", "task");

    let conflicted = false;
    try {
      git(root, "merge", "--no-edit", "main");
    } catch {
      conflicted = true;
    }
    assert.ok(conflicted, "fixture precondition: the merge must actually conflict on fileA.txt");
    writeFileSync(join(root, "fileA.txt"), "A merged resolution\n");
    commitAll(root, "resolve fileA.txt conflict");
    const mergeCommit = headSha(root);

    const report = buildProvenanceReport({ repoRoot: root, flaggedPaths: ["fileA.txt"] });
    assert.equal(report.upstreamTip, newUpstreamCommit);
    const fileA = report.flaggedFiles[0];
    assert.equal(fileA.ownerCommit, mergeCommit, "the merge commit itself is fileA's last-touch commit");
    assert.equal(fileA.status, "own", "the merge commit resolving the conflict is never an ancestor of the upstream side it merged in");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("net-zero edit: task-only commit reverts content back to upstream's → classifies not-in-diff, NEVER own", () => {
  const { root } = makeMergeFixture();
  try {
    // fileA is already a task-only edit ("A task edit\n") from the fixture.
    // Add a second task-only commit that reverts it back to the exact
    // upstream/base content. The owning commit (the revert) is still
    // task-only (not an ancestor of the upstream tip) — the ancestry-only
    // bug this task fixes would call this "own" — but the file's current
    // content is now byte-identical to upstream, so it must NOT appear in
    // the true diff surface, and must NOT be cited as part of the task's diff.
    writeFileSync(join(root, "fileA.txt"), "A base\n");
    commitAll(root, "task: revert fileA back to base content (net-zero)");
    const revertCommit = headSha(root);

    git(root, "merge", "-q", "--no-edit", "main");
    const report = buildProvenanceReport({ repoRoot: root, flaggedPaths: ["fileA.txt"] });

    assert.ok(
      !report.taskDiffFiles.includes("fileA.txt"),
      "fileA nets to zero change vs upstream, so it must be absent from the true diff surface",
    );
    const fileA = report.flaggedFiles[0];
    assert.equal(fileA.ownerCommit, revertCommit, "the revert commit is fileA's last-touch commit");
    assert.equal(
      fileA.status,
      "not-in-diff",
      "owner is task-only (would ancestry-check as 'own'), but must NOT be asserted as part of the diff since content matches upstream",
    );
    assert.ok(fileA.evidence.some((e) => e.includes("net-zero edit")));

    const block = formatEvidenceBlock(report);
    assert.match(block, /NOT part of the task's diff; do not cite it as one/);
    assert.doesNotMatch(block, /fileA\.txt.*genuinely part of this task's own diff/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncommitted reversion to upstream content: git status shows it modified, but content already matches upstream → not-in-diff, NEVER uncommitted/own", () => {
  const { root, upstreamCommit } = makeMergeFixture();
  try {
    // Merge upstream in: worktree now has fileA = "A task edit" (task's
    // committed edit), fileB/fileC = upstream's edits.
    git(root, "merge", "-q", "--no-edit", "main");
    // Now make an UNCOMMITTED (never git-added, never committed) edit to
    // fileA that happens to restore it to upstream's exact content. `git
    // status` will report fileA as modified (it differs from HEAD, which
    // still has "A task edit" committed) — the exact scenario the review
    // flagged: a naive status-porcelain union would call this "own"/
    // "uncommitted", but its live content is byte-identical to the upstream
    // tip, so it must NOT be asserted as part of the task's diff.
    writeFileSync(join(root, "fileA.txt"), "A base\n");

    const report = buildProvenanceReport({ repoRoot: root, flaggedPaths: ["fileA.txt"] });
    assert.equal(report.error, null);
    assert.equal(report.upstreamTip, upstreamCommit);
    assert.ok(
      !report.taskDiffFiles.includes("fileA.txt"),
      "fileA's live (uncommitted) content matches the upstream tip byte-for-byte, so it must be absent from the true diff surface",
    );

    const fileA = report.flaggedFiles[0];
    assert.equal(
      fileA.status,
      "not-in-diff",
      "git status flags it modified vs HEAD, but it must NOT be classified uncommitted/own since content nets to zero vs upstream",
    );
    assert.ok(fileA.evidence.some((e) => e.includes("net-zero in-progress reversion")));

    const block = formatEvidenceBlock(report);
    assert.match(block, /NOT part of the task's diff; do not cite it as one/);
    assert.doesNotMatch(block, /fileA\.txt.*own \(in-progress\) diff/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifyFileOwnership: ancestor-owner but path still in diff surface classifies ambiguous, never inherited", () => {
  const { root } = makeMergeFixture();
  try {
    git(root, "merge", "-q", "--no-edit", "main");
    const upstreamTip = headSha(root);
    // fileB's real owner (the upstream commit) IS an ancestor of the
    // upstream tip, but inject a diffSurface claiming fileB still differs
    // from upstream — the traversal-order anomaly this status exists for.
    const result = classifyFileOwnership({
      repoRoot: root,
      path: "fileB.txt",
      upstreamTip,
      uncommittedPaths: new Set(),
      diffSurface: new Set(["fileB.txt"]),
    });
    assert.equal(result.status, "ambiguous");
    assert.ok(result.evidence.some((e) => e.includes("traversal-order anomaly")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. classifyFileOwnership directly — uncommitted short-circuit + error paths
// ---------------------------------------------------------------------------

test("classifyFileOwnership: uncommitted set short-circuits before any git history lookup", () => {
  const { root } = makeMergeFixture();
  try {
    git(root, "merge", "-q", "--no-edit", "main");
    // diffSurface DOES include fileB.txt here — this test proves the
    // uncommitted branch short-circuits before any `git log` ownership
    // lookup, not the net-zero cross-check itself (that has its own
    // dedicated test above).
    const result = classifyFileOwnership({
      repoRoot: root,
      path: "fileB.txt",
      upstreamTip: headSha(root),
      uncommittedPaths: new Set(["fileB.txt"]),
      diffSurface: new Set(["fileB.txt"]),
    });
    assert.equal(result.status, "uncommitted");
    assert.equal(result.ownerCommit, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifyFileOwnership: not-a-git-repo path reports error, never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "diff-provenance-noinit-"));
  try {
    const result = classifyFileOwnership({
      repoRoot: root,
      path: "x.txt",
      upstreamTip: "deadbeef",
      uncommittedPaths: new Set(),
      diffSurface: new Set(),
    });
    assert.equal(result.status, "error");
    assert.ok(result.evidence[0].length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Formatting
// ---------------------------------------------------------------------------

test("formatSummaryLines and formatEvidenceBlock render the upstream tip, diff surface, and per-file verdicts", () => {
  const { root } = makeMergeFixture();
  try {
    git(root, "merge", "-q", "--no-edit", "main");
    const report = buildProvenanceReport({ repoRoot: root, flaggedPaths: ["fileA.txt", "fileB.txt"] });

    const summary = formatSummaryLines(report).join("\n");
    assert.match(summary, /task's true diff surface: 1 file/);
    assert.match(summary, /fileA\.txt/);
    assert.match(summary, /OWN \(genuinely part of this task's diff\)/);
    assert.match(summary, /INHERITED \(already upstream, not this task's\)/);

    const block = formatEvidenceBlock(report);
    assert.match(block, /## Diff-provenance evidence/);
    assert.match(block, /`fileA\.txt`/);
    assert.match(block, /is \*\*NOT\*\* an ancestor/);
    assert.match(block, /\*\*is already an ancestor\*\*/);
    assert.match(block, /freshly computed, never from a cached report/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("base-resolution failure (not a git repo) renders a one-line error instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "diff-provenance-noinit2-"));
  try {
    const report: ProvenanceReport = buildProvenanceReport({ repoRoot: root, flaggedPaths: ["x.txt"] });
    assert.ok(report.error, "expected a base-resolution error outside any git repo");
    assert.equal(formatSummaryLines(report).length, 1);
    assert.match(formatSummaryLines(report)[0], /base resolution FAILED/);
    assert.match(formatEvidenceBlock(report), /base resolution FAILED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. CLI arg parsing
// ---------------------------------------------------------------------------

test("parseArgs: --help/-h short-circuits; other args collect as flagged paths", () => {
  assert.deepEqual(parseArgs([]), { help: false, paths: [] });
  assert.deepEqual(parseArgs(["a.ts", "b.ts"]), { help: false, paths: ["a.ts", "b.ts"] });
  assert.deepEqual(parseArgs(["--help"]), { help: true, paths: [] });
  assert.deepEqual(parseArgs(["a.ts", "-h", "b.ts"]), { help: true, paths: ["a.ts", "b.ts"] });
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} diff-provenance tests passed`);
process.exit(failures > 0 ? 1 : 0);
