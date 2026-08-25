/* test-registration
{
  "name": "clean-scratch scratch GC (Task #3794)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3794: proves the gate's automatic scratch prune (TTL/size caps, dry-run, tracked-file safety, unknown-.local reporting) deletes ONLY sanctioned zones and untracked junk — temp-dir fixtures, DB-free, fast. A regression could delete platform-managed .local state on every gate run.",
  "tier": "small"
}
test-registration */
/**
 * Task #3794 — Unit tests for the scratch GC (scripts/clean-scratch.ts),
 * against temp-dir fixtures.
 *
 * Proves, above all, the OFF-LIMITS guarantees:
 *   1. Platform-managed dirs (.local/state, .local/skills,
 *      .local/secondary_skills, .local/custom_skills), agent tooling
 *      (.local/runs, .local/tasks), and .agents/ SURVIVE every mode.
 *   2. Unknown `.local` entries (dirs and loose files) are REPORTED,
 *      never deleted.
 *   3. Tracked junk-pattern files are never deleted; with git unavailable
 *      the junk sweep is skipped entirely.
 *   4. Symlinks in a zone are skipped, never followed.
 * And the GC behaviors:
 *   5. stale-only: TTL prune (recursive newest mtime) + size cap
 *      oldest-first; fresh entries survive.
 *   6. full mode wipes zone contents but keeps the zone dirs.
 *   7. dry-run deletes nothing while reporting what it would do.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCleanScratch } from "../scripts/clean-scratch";

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

const HOUR = 3_600_000;

function makeOld(path: string, hoursAgo: number, now: number): void {
  const t = new Date(now - hoursAgo * HOUR);
  utimesSync(path, t, t);
}

interface Fixture {
  root: string;
  now: number;
  cleanup: () => void;
}

/** Builds a full repo-shaped fixture with zones, platform dirs, and junk. */
function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "clean-scratch-"));
  const now = Date.now();

  // Scratch zones with stale + fresh entries
  mkdirSync(join(root, ".local", "scratch", "old-dir"), { recursive: true });
  writeFileSync(join(root, ".local", "scratch", "old-dir", "a.txt"), "old\n");
  makeOld(join(root, ".local", "scratch", "old-dir", "a.txt"), 100, now);
  makeOld(join(root, ".local", "scratch", "old-dir"), 100, now);
  writeFileSync(join(root, ".local", "scratch", "fresh.txt"), "fresh\n");
  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(join(root, "tmp", "stale_dump.txt"), "old\n");
  makeOld(join(root, "tmp", "stale_dump.txt"), 100, now);
  writeFileSync(join(root, "tmp", "fresh_dump.txt"), "fresh\n");

  // Off-limits: platform, tooling, agent memory
  for (const d of ["state", "skills", "secondary_skills", "custom_skills", "runs", "tasks"]) {
    mkdirSync(join(root, ".local", d), { recursive: true });
    writeFileSync(join(root, ".local", d, "keep.bin"), "keep\n");
    makeOld(join(root, ".local", d, "keep.bin"), 500, now);
  }
  mkdirSync(join(root, ".agents", "memory"), { recursive: true });
  writeFileSync(join(root, ".agents", "memory", "MEMORY.md"), "keep\n");
  makeOld(join(root, ".agents", "memory", "MEMORY.md"), 500, now);

  // Unknown .local entries: a dir and a loose file — report, never delete
  mkdirSync(join(root, ".local", "qa-mystery"), { recursive: true });
  writeFileSync(join(root, ".local", "qa-mystery", "shot.png"), "x\n");
  makeOld(join(root, ".local", "qa-mystery", "shot.png"), 500, now);
  writeFileSync(join(root, ".local", "loose-probe.ts"), "x\n");
  makeOld(join(root, ".local", "loose-probe.ts"), 500, now);

  // Worktree junk: untracked root + nested, and one TRACKED junk file
  writeFileSync(join(root, "nohup.out"), "x\n");
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "server", "thing.bak"), "x\n");
  writeFileSync(join(root, "tracked.bak"), "x\n");
  writeFileSync(join(root, "package.json"), "{}\n");

  return { root, now, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const TRACKED = new Set(["tracked.bak", "package.json"]);

// 1 + 2 + 3 + 5. stale-only run: TTL prune, junk sweep, off-limits survive.
{
  const { root, now, cleanup } = buildFixture();
  try {
    const lines: string[] = [];
    const report = runCleanScratch({
      root,
      staleOnly: true,
      now,
      ttlMs: 72 * HOUR,
      trackedFiles: TRACKED,
      log: (l) => lines.push(l),
    });

    assert(report.errors.length === 0, `no errors (${report.errors.join("; ")})`);
    assert(!existsSync(join(root, ".local", "scratch", "old-dir")), "stale zone dir pruned (recursive mtime)");
    assert(existsSync(join(root, ".local", "scratch", "fresh.txt")), "fresh zone file survives TTL");
    assert(!existsSync(join(root, "tmp", "stale_dump.txt")), "stale tmp/ entry pruned");
    assert(existsSync(join(root, "tmp", "fresh_dump.txt")), "fresh tmp/ entry survives");

    assert(!existsSync(join(root, "nohup.out")), "untracked root junk deleted");
    assert(!existsSync(join(root, "server", "thing.bak")), "untracked nested junk deleted");
    assert(existsSync(join(root, "tracked.bak")), "TRACKED junk is never deleted");
    assert(report.junkSkippedTracked.includes("tracked.bak"), "tracked junk reported as skipped");

    for (const d of ["state", "skills", "secondary_skills", "custom_skills", "runs", "tasks"]) {
      assert(existsSync(join(root, ".local", d, "keep.bin")), `.local/${d} untouched (500h old)`);
    }
    assert(existsSync(join(root, ".agents", "memory", "MEMORY.md")), ".agents/memory untouched");

    assert(existsSync(join(root, ".local", "qa-mystery", "shot.png")), "unknown .local dir untouched");
    assert(existsSync(join(root, ".local", "loose-probe.ts")), "unknown .local loose file untouched");
    assert(
      report.unknownLocal.includes(".local/qa-mystery") &&
        report.unknownLocal.includes(".local/loose-probe.ts"),
      "unknown .local entries are REPORTED",
    );
    assert(
      report.platformUntouched.length === 4,
      `all 4 platform dirs reported untouched (${report.platformUntouched.length})`,
    );
    assert(report.bytesFreed > 0, "bytesFreed accounted");
  } finally {
    cleanup();
  }
}

// 6. Full mode wipes zone contents but keeps zone dirs; off-limits still safe.
{
  const { root, now, cleanup } = buildFixture();
  try {
    const report = runCleanScratch({
      root,
      staleOnly: false,
      now,
      trackedFiles: TRACKED,
      log: () => {},
    });
    assert(report.errors.length === 0, "full mode: no errors");
    assert(!existsSync(join(root, ".local", "scratch", "fresh.txt")), "full mode wipes fresh zone entries too");
    assert(!existsSync(join(root, "tmp", "fresh_dump.txt")), "full mode wipes fresh tmp/ entries too");
    assert(existsSync(join(root, ".local", "scratch")), "zone dir .local/scratch preserved");
    assert(existsSync(join(root, "tmp")), "zone dir tmp/ preserved");
    assert(existsSync(join(root, ".local", "state", "keep.bin")), "platform dir survives full mode");
    assert(existsSync(join(root, ".local", "qa-mystery")), "unknown .local dir survives full mode");
    assert(existsSync(join(root, "tracked.bak")), "tracked junk survives full mode");
  } finally {
    cleanup();
  }
}

// 7. Dry-run deletes nothing while reporting what it would do.
{
  const { root, now, cleanup } = buildFixture();
  try {
    const report = runCleanScratch({
      root,
      staleOnly: true,
      dryRun: true,
      now,
      ttlMs: 72 * HOUR,
      trackedFiles: TRACKED,
      log: () => {},
    });
    assert(report.dryRun, "report marked dryRun");
    assert(existsSync(join(root, "nohup.out")), "dry-run: junk file NOT deleted");
    assert(existsSync(join(root, ".local", "scratch", "old-dir")), "dry-run: stale zone entry NOT deleted");
    assert(
      report.junkDeleted.includes("nohup.out") &&
        report.zonePruned.some((z) => z.entry === "old-dir" && z.reason === "stale"),
      "dry-run report lists would-delete items",
    );
  } finally {
    cleanup();
  }
}

// 5b. Size cap prunes oldest-first after the TTL pass.
{
  const root = mkdtempSync(join(tmpdir(), "clean-scratch-cap-"));
  const now = Date.now();
  try {
    mkdirSync(join(root, ".local", "scratch"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    const older = join(root, ".local", "scratch", "older.bin");
    const newer = join(root, ".local", "scratch", "newer.bin");
    writeFileSync(older, "a".repeat(2048));
    writeFileSync(newer, "b".repeat(2048));
    makeOld(older, 10, now); // fresh enough to survive TTL, older than `newer`
    const report = runCleanScratch({
      root,
      staleOnly: true,
      now,
      ttlMs: 72 * HOUR,
      maxZoneBytes: 3000, // both together (4096) exceed; one (2048) fits
      trackedFiles: new Set<string>(),
      log: () => {},
    });
    assert(!existsSync(older), "size cap deletes the OLDER entry first");
    assert(existsSync(newer), "newer entry survives once under the cap");
    assert(
      report.zonePruned.some((z) => z.entry === "older.bin" && z.reason === "size-cap"),
      "size-cap prune reported with its reason",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 3b. Git unavailable → junk sweep skipped, zones still pruned.
{
  const { root, now, cleanup } = buildFixture();
  try {
    const report = runCleanScratch({
      root,
      staleOnly: true,
      now,
      ttlMs: 72 * HOUR,
      trackedFiles: null, // simulate git failure
      log: () => {},
    });
    assert(report.junkSweepSkipped, "junk sweep skipped without git");
    assert(existsSync(join(root, "nohup.out")), "junk file untouched without git (cannot prove untracked)");
    assert(!existsSync(join(root, "tmp", "stale_dump.txt")), "zones still pruned without git");
  } finally {
    cleanup();
  }
}

// 4. Symlinks in a zone are skipped, never followed.
{
  const root = mkdtempSync(join(tmpdir(), "clean-scratch-link-"));
  try {
    mkdirSync(join(root, ".local", "scratch"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
    const target = join(root, "outside", "precious.txt");
    writeFileSync(target, "precious\n");
    symlinkSync(join(root, "outside"), join(root, ".local", "scratch", "escape-link"));
    const report = runCleanScratch({
      root,
      staleOnly: false, // full wipe — the aggressive mode
      trackedFiles: new Set<string>(),
      log: () => {},
    });
    assert(existsSync(target), "symlink target OUTSIDE the zone survives a full wipe");
    assert(
      report.symlinksSkipped.includes(".local/scratch/escape-link"),
      "symlink reported as skipped",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
