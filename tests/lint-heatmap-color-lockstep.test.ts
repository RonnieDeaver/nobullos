/* test-registration
{
  "name": "lint-heatmap-color-lockstep guard (Task #2615)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2615: the heatmap color drift guard (scripts/lint-heatmap-color- lockstep.ts) is only useful if it actually fails on drift and stays quiet on a clean tree. Gate this fast, DB-free fixture-based test so the guard's own behavior — flagging a leaked palette hex, ignoring the out-of-scope slate hexes, and enforcing the allow-list exact-count — can't silently rot (the \"regression-flagged-but-unselected\" failure mode this repo has hit).",
  "tier": "small"
}
test-registration */
/**
 * Task #2615 — Regression test for the heatmap color drift guard.
 *
 * The guard (scripts/lint-heatmap-color-lockstep.ts, Task #2600) fails if a
 * distinctive heatmap rank/movement palette hex is hardcoded anywhere outside
 * the single source of truth `shared/heatmapColors.ts` (Task #2587). Its value
 * depends on it actually firing on drift and staying quiet on a clean tree;
 * until now nothing asserted either.
 *
 * `runLint()` accepts optional overrides (scanDirs / sourceOfTruth / allowList)
 * specifically so it can be exercised against a temp fixture tree — exactly how
 * the sibling lint-cross-instance-locks guard is tested.
 *
 * Proves:
 *   1. The REAL source tree passes (no palette hex has leaked).
 *   2. A flagged palette hex (#0d6b3d) introduced in a scanned file is flagged,
 *      and the offending file + hex are named.
 *   3. The slate hexes (#94a3b8 / #64748b) are intentionally OUT of scope — a
 *      file using only those is NOT flagged.
 *   4. Allow-list exact-count behavior: a file allow-listed for N incidental
 *      uses of #4ade80 passes at exactly N, but a NEW (N+1th) occurrence trips
 *      the guard even in the allow-listed file.
 *   5. The source-of-truth file itself is exempt (a palette hex there is fine).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-heatmap-color-lockstep";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-heatmap-color-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeFile(root: string, rel: string, lines: string[]): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
  return full.replace(/\\/g, "/");
}

// 1. The REAL source tree passes the guard.
{
  const res = runLint();
  if (!res.ok) for (const e of res.errors) console.error(`    error: ${e}`);
  assert(res.ok, "real source tree passes the heatmap color guard");
  assert(res.filesScanned > 0, "the guard actually scanned source files");
}

// 2. A flagged palette hex hardcoded in a scanned file is flagged.
{
  const { root, cleanup } = fixture();
  try {
    const file = writeFile(root, "components/BadHeatmap.tsx", [
      "export const fill = {",
      '  top3: "#0d6b3d",', // rank Top 3 — must come from @shared/heatmapColors
      "};",
    ]);
    const res = runLint({ scanDirs: [root] });
    assert(!res.ok, "a hardcoded palette hex (#0d6b3d) trips the guard");
    assert(
      res.errors.some((e) => e.includes(file) && e.includes("0d6b3d")),
      "the offending file and hex are named in the error",
    );
    assert(res.occurrences === 1, "the single leaked occurrence is counted");
  } finally {
    cleanup();
  }
}

// 3. The slate hexes are intentionally out of scope (not flagged).
{
  const { root, cleanup } = fixture();
  try {
    writeFile(root, "components/MutedText.tsx", [
      "export const muted = {",
      '  unranked: "#94a3b8",', // Tailwind slate-400 — generic muted color
      '  stable: "#64748b",', // Tailwind slate-500 — generic muted color
      "};",
    ]);
    const res = runLint({ scanDirs: [root], allowList: {} });
    assert(res.ok, "slate hexes #94a3b8 / #64748b are not flagged");
    assert(res.occurrences === 0, "no flagged occurrences for slate-only file");
  } finally {
    cleanup();
  }
}

// 4. Allow-list exact-count: passes at exactly N, trips at N+1.
{
  const { root, cleanup } = fixture();
  try {
    // Mirror the real allow-list entry style: an allow-listed file may carry a
    // documented count of an incidental (non-heatmap) palette-hex use.
    const okFile = writeFile(root, "pages/PublicReport.tsx", [
      "export const series = {",
      '  leadSource: "#4ade80",', // 1 incidental use — allow-listed for exactly 1
      "};",
    ]);
    const okRes = runLint({
      scanDirs: [root],
      allowList: { [okFile]: { "4ade80": 1 } },
    });
    assert(
      okRes.ok,
      "exactly the allow-listed count of #4ade80 passes in the allow-listed file",
    );

    // Now a NEW (2nd) occurrence of the same hex in the same allow-listed file.
    const driftFile = writeFile(root, "pages/PublicReport.tsx", [
      "export const series = {",
      '  leadSource: "#4ade80",', // documented incidental use
      '  somethingNew: "#4ade80",', // a NEW occurrence — must trip the guard
      "};",
    ]);
    const driftRes = runLint({
      scanDirs: [root],
      allowList: { [driftFile]: { "4ade80": 1 } },
    });
    assert(
      !driftRes.ok,
      "a NEW occurrence of #4ade80 in an allow-listed file still trips the guard",
    );
    assert(
      driftRes.errors.some(
        (e) => e.includes(driftFile) && e.includes("4ade80"),
      ),
      "the over-count error names the allow-listed file and hex",
    );
  } finally {
    cleanup();
  }
}

// 5. The source-of-truth file itself is exempt.
{
  const { root, cleanup } = fixture();
  try {
    const sot = writeFile(root, "shared/heatmapColors.ts", [
      "export const HEATMAP_RANK_COLORS = {",
      '  top3: "#0d6b3d",',
      '  top10: "#4ade80",',
      "};",
    ]);
    const res = runLint({ scanDirs: [root], sourceOfTruth: sot, allowList: {} });
    assert(res.ok, "palette hexes in the source-of-truth file are exempt");
  } finally {
    cleanup();
  }
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
