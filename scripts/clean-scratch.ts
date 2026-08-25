/**
 * clean-scratch.ts — Task #3794: scratch GC — the gate's self-clean step.
 *
 * Two jobs, mirroring how Bazel/Eden keep an out-of-tree output base from
 * becoming the new junk pile:
 *   1. Delete UNTRACKED junk-pattern files from the worktree (the debris
 *      classes in scripts/worktreePolicy.ts — *.bak, nohup.out, tmp_*,
 *      *_block.txt, …). Tracked files are NEVER deleted (the hygiene lint
 *      flags those for a deliberate `git rm`); if git is unavailable the
 *      junk sweep is SKIPPED entirely rather than guessing.
 *   2. Prune the DECLARED scratch zones (.local/scratch/, tmp/) — and
 *      nothing else:
 *        - stale-only mode (gate + predeploy): delete zone entries whose
 *          recursive newest mtime is older than the TTL
 *          (CLEAN_SCRATCH_TTL_HOURS, default 72h), then enforce a per-zone
 *          size cap (CLEAN_SCRATCH_MAX_MB, default 512MB) oldest-first.
 *        - full mode (manual `npm run clean:scratch`): wipe zone contents.
 *
 * Hard safety rules:
 *   - Platform-managed directories (.local/state, .local/skills,
 *     .local/secondary_skills, .local/custom_skills) and agent memory
 *     (.agents/) are never entered, never deleted. Agent tooling
 *     (.local/runs, .local/tasks) is never auto-pruned by this generic
 *     cleaner; long-control evidence owns its separate lifecycle below
 *     .local/runs/long-validation/.
 *   - Unknown `.local` entries (dirs or loose files) are REPORTED, never
 *     deleted — classify them in worktreePolicy.ts if they should be scratch.
 *   - Symlinks are never followed and never deleted-through.
 *   - Every deletion target must resolve inside the repo root (and, for
 *     zone pruning, inside a declared zone).
 *
 * Usage:
 *   npm run clean:scratch                  — full wipe of scratch zones + junk sweep
 *   npm run clean:scratch --dry-run        — report only (npm swallows --flags into
 *                                            npm_config_*; both spellings honored)
 *   npx tsx scripts/clean-scratch.ts --stale-only [--dry-run]
 *
 * Skip (emergency): CLEAN_SCRATCH_SKIP=1. Exit codes: 0 — success (unknown
 * `.local` entries do NOT fail it); 1 — real errors (failed deletions).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyLocalEntry,
  lstatSafe,
  SCRATCH_ZONES,
  walkJunkFiles,
} from "./worktreePolicy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const DEFAULT_TTL_HOURS = 72;
const DEFAULT_MAX_MB = 512;

export interface CleanOptions {
  root?: string;
  dryRun?: boolean;
  /** true = TTL + size-cap prune (gate/predeploy); false = full zone wipe. */
  staleOnly?: boolean;
  ttlMs?: number;
  maxZoneBytes?: number;
  now?: number;
  /**
   * Tracked-file set for the junk sweep. undefined = ask git (real runs);
   * an explicit Set = fixture injection; null = simulate git unavailable
   * (junk sweep skipped).
   */
  trackedFiles?: Set<string> | null;
  log?: (line: string) => void;
}

export interface ZonePrune {
  zone: string;
  entry: string;
  reason: "stale" | "size-cap" | "full-wipe";
  bytes: number;
}

export interface CleanReport {
  dryRun: boolean;
  junkDeleted: string[];
  junkSkippedTracked: string[];
  junkSweepSkipped: boolean;
  zonePruned: ZonePrune[];
  symlinksSkipped: string[];
  unknownLocal: string[];
  platformUntouched: string[];
  bytesFreed: number;
  errors: string[];
}

interface EntryStat {
  maxMtimeMs: number;
  bytes: number;
}

/** Recursive newest-mtime + total size, symlink-safe (never follows). */
function statRecursive(absPath: string): EntryStat {
  const st = lstatSafe(absPath);
  if (!st) return { maxMtimeMs: 0, bytes: 0 };
  if (st.isSymbolicLink()) return { maxMtimeMs: st.mtimeMs, bytes: 0 };
  if (st.isFile()) return { maxMtimeMs: st.mtimeMs, bytes: st.size };
  if (!st.isDirectory()) return { maxMtimeMs: st.mtimeMs, bytes: 0 };
  let maxMtimeMs = st.mtimeMs;
  let bytes = 0;
  let children: string[] = [];
  try {
    children = readdirSync(absPath);
  } catch {
    return { maxMtimeMs, bytes };
  }
  for (const child of children) {
    const s = statRecursive(join(absPath, child));
    if (s.maxMtimeMs > maxMtimeMs) maxMtimeMs = s.maxMtimeMs;
    bytes += s.bytes;
  }
  return { maxMtimeMs, bytes };
}

function assertInside(root: string, target: string, alsoInside?: string): void {
  const r = resolve(root);
  const t = resolve(target);
  if (t !== r && !t.startsWith(r + sep)) {
    throw new Error(`path-safety violation: ${t} escapes root ${r}`);
  }
  if (alsoInside) {
    const z = resolve(alsoInside);
    if (t !== z && !t.startsWith(z + sep)) {
      throw new Error(`path-safety violation: ${t} escapes zone ${z}`);
    }
  }
}

function gitTrackedSet(root: string): Set<string> | null {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

export function runCleanScratch(opts: CleanOptions = {}): CleanReport {
  const root = resolve(opts.root ?? REPO_ROOT);
  const dryRun = opts.dryRun ?? false;
  const staleOnly = opts.staleOnly ?? false;
  const now = opts.now ?? Date.now();
  const ttlMs =
    opts.ttlMs ??
    Number(process.env.CLEAN_SCRATCH_TTL_HOURS || DEFAULT_TTL_HOURS) * 3_600_000;
  const maxZoneBytes =
    opts.maxZoneBytes ??
    Number(process.env.CLEAN_SCRATCH_MAX_MB || DEFAULT_MAX_MB) * 1024 * 1024;
  const log = opts.log ?? ((line: string) => console.log(line));

  const report: CleanReport = {
    dryRun,
    junkDeleted: [],
    junkSkippedTracked: [],
    junkSweepSkipped: false,
    zonePruned: [],
    symlinksSkipped: [],
    unknownLocal: [],
    platformUntouched: [],
    bytesFreed: 0,
    errors: [],
  };

  const act = dryRun ? "would remove" : "removed";
  if (dryRun) log("[clean-scratch] DRY RUN — nothing will be deleted.");

  const removeTarget = (absPath: string, zoneAbs?: string): boolean => {
    try {
      assertInside(root, absPath, zoneAbs);
      if (!dryRun) rmSync(absPath, { recursive: true, force: true });
      return true;
    } catch (e) {
      report.errors.push(`${absPath}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  // --- 1. Untracked junk-pattern sweep -------------------------------------
  const tracked =
    opts.trackedFiles !== undefined ? opts.trackedFiles : gitTrackedSet(root);
  if (tracked === null) {
    report.junkSweepSkipped = true;
    log(
      "[clean-scratch] WARNING: git unavailable — skipping the junk-file sweep " +
        "(cannot prove files are untracked). Scratch zones are still pruned.",
    );
  } else {
    for (const hit of walkJunkFiles(root)) {
      if (tracked.has(hit.path)) {
        report.junkSkippedTracked.push(hit.path);
        continue; // NEVER delete tracked files — the hygiene lint owns those
      }
      const abs = join(root, hit.path);
      const st = lstatSafe(abs);
      if (!st || st.isSymbolicLink() || !st.isFile()) continue;
      if (removeTarget(abs)) {
        report.junkDeleted.push(hit.path);
        report.bytesFreed += st.size;
        log(`[clean-scratch] ${act} junk file: ${hit.path} (${hit.reason})`);
      }
    }
  }

  // --- 2. Declared scratch zones -------------------------------------------
  for (const zone of SCRATCH_ZONES) {
    const zoneAbs = resolve(root, zone);
    assertInside(root, zoneAbs);
    if (!existsSync(zoneAbs)) {
      if (!dryRun) mkdirSync(zoneAbs, { recursive: true });
      continue;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(zoneAbs);
    } catch (e) {
      report.errors.push(`${zone}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const stats: Array<{ entry: string; abs: string; stat: EntryStat }> = [];
    for (const entry of entries) {
      const abs = join(zoneAbs, entry);
      const st = lstatSafe(abs);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        report.symlinksSkipped.push(`${zone}/${entry}`);
        log(`[clean-scratch] SKIPPED symlink (never followed): ${zone}/${entry}`);
        continue;
      }
      stats.push({ entry, abs, stat: statRecursive(abs) });
    }

    const prune = (item: { entry: string; abs: string; stat: EntryStat }, reason: ZonePrune["reason"]) => {
      if (removeTarget(item.abs, zoneAbs)) {
        report.zonePruned.push({ zone, entry: item.entry, reason, bytes: item.stat.bytes });
        report.bytesFreed += item.stat.bytes;
        const age = Math.round((now - item.stat.maxMtimeMs) / 3_600_000);
        log(
          `[clean-scratch] ${act} ${zone}/${item.entry} (${reason}, ~${age}h old, ${item.stat.bytes} bytes)`,
        );
      }
    };

    if (!staleOnly) {
      for (const item of stats) prune(item, "full-wipe");
      continue;
    }

    const kept: typeof stats = [];
    for (const item of stats) {
      if (item.stat.maxMtimeMs < now - ttlMs) prune(item, "stale");
      else kept.push(item);
    }
    // Size cap on what survives the TTL pass — oldest first.
    kept.sort((a, b) => a.stat.maxMtimeMs - b.stat.maxMtimeMs);
    let keptBytes = kept.reduce((sum, k) => sum + k.stat.bytes, 0);
    for (const item of kept) {
      if (keptBytes <= maxZoneBytes) break;
      prune(item, "size-cap");
      keptBytes -= item.stat.bytes;
    }
  }

  // --- 3. `.local` classification report (never deletes) -------------------
  const localAbs = resolve(root, ".local");
  if (existsSync(localAbs)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(localAbs);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const st = lstatSafe(join(localAbs, entry));
      const isDir = st?.isDirectory() ?? false;
      const cls = isDir ? classifyLocalEntry(entry) : "unknown";
      if (cls === "platform") report.platformUntouched.push(`.local/${entry}`);
      else if (cls === "unknown") report.unknownLocal.push(`.local/${entry}`);
      // tooling + prunable are known homes; nothing to report
    }
    if (report.unknownLocal.length > 0) {
      log(
        `[clean-scratch] ${report.unknownLocal.length} unclassified .local entr(ies) left untouched ` +
          `(classify in scripts/worktreePolicy.ts if they should be scratch):`,
      );
      for (const u of report.unknownLocal) log(`[clean-scratch]   ? ${u}`);
    }
  }

  const mode = staleOnly ? "stale-only" : "full";
  log(
    `[clean-scratch] ${dryRun ? "DRY RUN " : ""}done (${mode}): ` +
      `${report.junkDeleted.length} junk file(s) ${act}, ` +
      `${report.zonePruned.length} zone entr(ies) pruned, ` +
      `${(report.bytesFreed / 1024 / 1024).toFixed(1)} MB freed` +
      (report.junkSweepSkipped ? ", junk sweep SKIPPED (no git)" : "") +
      (report.errors.length ? `, ${report.errors.length} ERROR(S)` : "") +
      ".",
  );

  return report;
}

function cliFlag(name: string): boolean {
  // npm swallows unknown --flags before argv and exposes them as
  // npm_config_* (e.g. `npm run clean:scratch --dry-run` →
  // npm_config_dry_run=true); `npm run clean:scratch -- --dry-run` reaches
  // argv directly. Honor both.
  const argvName = `--${name}`;
  const envName = `npm_config_${name.replace(/-/g, "_")}`;
  return process.argv.includes(argvName) || (process.env[envName] ?? "") !== "";
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("clean-scratch.ts");

if (isMain) {
  if (process.env.CLEAN_SCRATCH_SKIP === "1") {
    console.log("[clean-scratch] SKIPPED (CLEAN_SCRATCH_SKIP=1 — emergency override).");
    process.exit(0);
  }
  const report = runCleanScratch({
    dryRun: cliFlag("dry-run"),
    staleOnly: cliFlag("stale-only"),
  });
  if (report.errors.length > 0) {
    console.error(`[clean-scratch] FAILED — ${report.errors.length} error(s):`);
    for (const e of report.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  process.exit(0);
}
