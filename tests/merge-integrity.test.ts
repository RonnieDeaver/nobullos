/* test-registration
{
  "name": "Merge-integrity verification — smear + resurrected-ancestor detection (Task #3922)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3922: the post-merge integrity check is the early-warning rail for system merges that smear task branches; a bug here keeps corruption invisible until completion review. Builds tiny synthetic git repos in tmpdir (git CLI only): no DB, no network, typecheck probe disabled.",
  "tier": "small"
}
test-registration */
// fs-scan-fixture-only -- reads files inside mkdtemp git fixture repos only
/**
 * Task #3922 — Proves scripts/verify-merge-integrity.ts against synthetic
 * git repos:
 *
 *   1. A linear (non-merge) HEAD reports kind "not-a-merge" and warns nothing.
 *   2. A CLEAN system merge — upstream changes adopted, task changes kept —
 *      yields zero smear suspects; divergence from the upstream tip is
 *      exactly the task's own files.
 *   3. A SMEARED merge — a file reverted to the merge-base blob during the
 *      merge, plus a file mangled to junk — flags both as smears and marks
 *      only the base-blob one as resurrected ancestor content.
 *   4. Worktree modifications count as task-touched (live agent work is
 *      never called a smear).
 *   5. parseTscErrorFiles extracts unique tsc error files; the warning
 *      formatter goes loud on smears and stays quiet on clean merges;
 *      reports write where asked; a zero budget degrades with a warning
 *      instead of lying.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MERGE_INTEGRITY_REPORT_PATH,
  analyzeMergeIntegrity,
  formatMergeIntegrityWarnings,
  parseTscErrorFiles,
  writeMergeIntegrityReport,
  type MergeIntegrityReport,
} from "../scripts/verify-merge-integrity";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Synthetic repo helpers
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

/**
 * Layout mirroring a task environment:
 *   base commit (fileA/fileB/fileC) → task branch edits fileA;
 *   upstream branch edits fileB AND fileC. Callers then merge upstream into
 *   the task branch, optionally corrupting the merge first.
 */
function makeMergeFixture(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "merge-integrity-"));
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
  git(root, "checkout", "-q", "task");
  return { root };
}

function analyze(root: string): MergeIntegrityReport {
  return analyzeMergeIntegrity({ repoRoot: root, runTypecheck: false });
}

// ---------------------------------------------------------------------------
// 1. Not a merge
// ---------------------------------------------------------------------------

test("linear HEAD → kind not-a-merge, quiet single-line output", () => {
  const root = mkdtempSync(join(tmpdir(), "merge-integrity-lin-"));
  try {
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "one\n");
    commitAll(root, "one");
    const report = analyze(root);
    assert.equal(report.kind, "not-a-merge");
    const lines = formatMergeIntegrityWarnings(report);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not a merge commit/);
    assert.ok(!lines.join("\n").includes("WARNING"), "no warning banner for linear history");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Clean merge
// ---------------------------------------------------------------------------

test("clean system merge → zero smears; divergence from upstream is exactly the task's own files", () => {
  const { root } = makeMergeFixture();
  try {
    git(root, "merge", "-q", "--no-edit", "main");
    const report = analyze(root);
    assert.equal(report.kind, "merge");
    assert.deepEqual(report.smearedFiles, [], "nothing smeared in a clean merge");
    assert.deepEqual(report.filesDivergingFromUpstream, ["fileA.txt"], "only the task's edit diverges from the upstream tip");
    assert.ok(report.taskTouchedFiles.includes("fileA.txt"));
    const lines = formatMergeIntegrityWarnings(report);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /OK — merge/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Smeared merge
// ---------------------------------------------------------------------------

test("smeared merge → resurrected-ancestor blob flagged, junk-content smear flagged, task file NOT flagged, banner is loud", () => {
  const { root } = makeMergeFixture();
  try {
    // Corrupt the merge: revert fileC to the ANCESTOR blob (the classic
    // resurrected-content pattern) and mangle fileB to junk that matches
    // neither side, then commit the merge with both smears inside.
    git(root, "merge", "--no-commit", "--no-ff", "main");
    git(root, "checkout", "HEAD^", "--", "fileC.txt");
    const baseC = readFileSync(join(root, "fileC.txt"), "utf8");
    assert.equal(baseC, "C base\n", "fixture precondition: fileC restored to ancestor content");
    writeFileSync(join(root, "fileB.txt"), "B junk from a bad merge\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "--no-edit");

    const report = analyze(root);
    assert.equal(report.kind, "merge");
    const byFile = new Map(report.smearedFiles.map((s) => [s.file, s]));
    assert.deepEqual([...byFile.keys()].sort(), ["fileB.txt", "fileC.txt"], "both corrupted files are smear suspects");
    assert.equal(byFile.get("fileC.txt")?.resurrectedAncestorBlob, true, "base-blob revert = resurrected ancestor content");
    assert.equal(byFile.get("fileB.txt")?.resurrectedAncestorBlob, false, "junk content is a smear but not a resurrection");
    assert.ok(!byFile.has("fileA.txt"), "the task's own edit is never a smear");

    const text = formatMergeIntegrityWarnings(report).join("\n");
    assert.match(text, /MERGE INTEGRITY WARNING/);
    assert.match(text, /RESURRECTED ANCESTOR CONTENT/);
    assert.ok(text.includes(MERGE_INTEGRITY_REPORT_PATH), "banner points at the machine-readable report");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Worktree edits are task work
// ---------------------------------------------------------------------------

test("uncommitted worktree edits count as task-touched, never as smears", () => {
  const { root } = makeMergeFixture();
  try {
    git(root, "merge", "-q", "--no-edit", "main");
    writeFileSync(join(root, "fileB.txt"), "B live agent edit in worktree\n");
    const report = analyze(root);
    assert.deepEqual(report.smearedFiles, [], "worktree edit is attributed to the task, not the merge");
    assert.ok(report.taskTouchedFiles.includes("fileB.txt"), "worktree file joins the task-touched set");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Helpers: tsc parsing, report writing, budget degradation
// ---------------------------------------------------------------------------

test("parseTscErrorFiles extracts unique files from tsc output and ignores noise", () => {
  const out = [
    "server/foo.ts(12,3): error TS2304: Cannot find name 'x'.",
    "server/foo.ts(44,1): error TS2345: Argument of type…",
    "client/src/Bar.tsx(7,10): error TS2551: Property…",
    "npm warn something unrelated",
    "Found 3 errors in 2 files.",
  ].join("\n");
  assert.deepEqual(parseTscErrorFiles(out), ["client/src/Bar.tsx", "server/foo.ts"]); // fs-scan-inputs-ignore -- fixture strings for the tsc-output parser, never fs-read
  assert.deepEqual(parseTscErrorFiles(""), []);
});

test("writeMergeIntegrityReport writes valid JSON where asked; zero budget degrades with a warning instead of lying", () => {
  const { root } = makeMergeFixture();
  try {
    git(root, "merge", "--no-commit", "--no-ff", "main");
    git(root, "checkout", "HEAD^", "--", "fileC.txt");
    git(root, "add", "-A");
    git(root, "commit", "-q", "--no-edit");

    const budgetless = analyzeMergeIntegrity({ repoRoot: root, runTypecheck: false, budgetMs: 0 });
    assert.equal(budgetless.kind, "merge", "structural diffs still run on a zero budget");
    const skipped = budgetless.smearedFiles.filter((s) => s.blobCheck === "skipped");
    assert.ok(skipped.length > 0, "blob checks degrade to skipped under a zero budget");
    assert.ok(
      budgetless.warnings.some((w) => w.includes("blob checks")),
      "degradation is announced, not silent",
    );

    const dest = join(root, ".local", "runs", "merge-integrity.json");
    assert.equal(writeMergeIntegrityReport(budgetless, dest), true);
    assert.ok(existsSync(dest));
    const parsed = JSON.parse(readFileSync(dest, "utf8")); // fs-scan-inputs-ignore -- reads back the report this test just wrote under a mkdtemp root
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.kind, "merge");
    assert.ok(Array.isArray(parsed.smearedFiles));

    assert.equal(writeMergeIntegrityReport(budgetless, join(root, "fileA.txt", "nope.json")), false, "write failure reports false, never throws");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("typecheck probe disabled by options records the reason; error files not touched by the task would be split out", () => {
  const { root } = makeMergeFixture();
  try {
    git(root, "merge", "-q", "--no-edit", "main");
    const report = analyze(root);
    assert.equal(report.typecheck.ran, false);
    assert.equal(report.typecheck.skippedReason, "disabled by options");
    assert.deepEqual(report.typecheck.errorFilesNotTaskTouched, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
console.log(`\n${tests.length - failures}/${tests.length} merge-integrity tests passed`);
process.exit(failures > 0 ? 1 : 0);
