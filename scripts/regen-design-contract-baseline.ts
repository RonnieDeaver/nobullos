/**
 * scripts/regen-design-contract-baseline.ts — the SOLE writer of
 * scripts/design-contract-baseline.json (Task #4347 design-contract ratchets).
 *
 * Recounts the four ratchet categories over the tracked client tree and
 * rewrites the frozen baseline artifact — but REFUSES any per-category TOTAL
 * increase: new violations are fixed with tokens (see the lint output), never
 * absorbed. Per-file increases that are offset by reductions elsewhere are
 * REFUSED too (Task #4507 — offsetting reductions must not hide brand-new
 * breaks) unless there is explicit evidence of a count-conserving move:
 *   - a git rename (R) of a file into the increased path whose old-path count
 *     covers the increase (stage the move — `git add -A` — so `git diff -M`
 *     sees it), or
 *   - an audited override: `--audited-move="<reason>"` — logged loudly so the
 *     reason lands in the run output and the reviewer can hold it to account.
 *
 * When to run:
 *   - after a sweep reduces counts (the lints fail "below baseline" until the
 *     reduction is locked in here);
 *   - after a rebase/merge conflict on the artifact: take either side first
 *     (git checkout --ours|--theirs), then regen on the rebased tree and
 *     commit. Never hand-merge — the sha256 self-hash rejects hand edits.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BASELINE_RELPATH,
  BASELINE_VERSION,
  CATEGORIES,
  CATEGORY_IDS,
  composeBaselineJson,
  discoverClientFiles,
  parseBaselineJson,
  scanFileContent,
  type BaselineCategories,
  type DesignCategoryId,
} from "./designContractRatchet.ts";

export interface RegenBaselineOptions {
  /** Fixture-tree root. When set, opts.files is required (no git discovery). */
  rootDir?: string;
  files?: string[];
  /** Existing artifact override: undefined = read from disk; null = bootstrap. */
  existingBaselineJson?: string | null;
  generatedAtIso?: string;
  /**
   * Rename evidence for count-conserving moves. undefined = detect via
   * `git diff -M --name-status` (staged + worktree) against HEAD. Tests and
   * fixture trees inject explicit pairs (or [] for "no rename evidence").
   */
  renamePairs?: RenamePair[];
  /**
   * Audited override for per-file increases that lack git rename evidence.
   * Non-empty reason = absorb every such increase, logging the reason loudly.
   * CLI: --audited-move="<reason>".
   */
  auditedMoveReason?: string;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

export interface RenamePair {
  from: string;
  to: string;
}
export interface RegenBaselineResult {
  ok: boolean;
  bootstrap: boolean;
  refusals: string[];
  moveWarnings: string[];
  artifactJson: string | null;
  totals: Record<DesignCategoryId, number>;
  prevTotals: Record<DesignCategoryId, number> | null;
}

export function regenerateBaseline(opts: RegenBaselineOptions = {}): RegenBaselineResult {
  const log = opts.log ?? ((l: string) => console.log(l));
  const logError = opts.logError ?? ((l: string) => console.error(l));
  if (opts.rootDir !== undefined && opts.files === undefined) {
    throw new Error("regenerateBaseline: opts.files is required when opts.rootDir is set");
  }
  const rootDir = opts.rootDir ?? process.cwd();
  const files = opts.files ?? discoverClientFiles();
  const renamePairs = opts.renamePairs ?? detectGitRenamePairs();
  const auditedMoveReason = opts.auditedMoveReason?.trim() ?? "";

  const filesByCat: Record<DesignCategoryId, Record<string, number>> = {
    hexColors: {},
    textPx: {},
    rounded: {},
    zIndex: {},
    chartFontSize: {},
    primaryWhite: {},
  };
  const totals: Record<DesignCategoryId, number> = {
    hexColors: 0,
    textPx: 0,
    rounded: 0,
    zIndex: 0,
    chartFontSize: 0,
    primaryWhite: 0,
  };
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(resolve(rootDir, rel), "utf8");
    } catch {
      continue; // listed but unreadable/deleted on disk: counts as 0
    }
    const scan = scanFileContent(src);
    for (const id of CATEGORY_IDS) {
      const c = scan[id].count;
      if (c > 0) {
        filesByCat[id][rel] = c;
        totals[id] += c;
      }
    }
  }
  const fresh: BaselineCategories = {
    hexColors: { total: totals.hexColors, files: filesByCat.hexColors },
    textPx: { total: totals.textPx, files: filesByCat.textPx },
    rounded: { total: totals.rounded, files: filesByCat.rounded },
    zIndex: { total: totals.zIndex, files: filesByCat.zIndex },
    chartFontSize: { total: totals.chartFontSize, files: filesByCat.chartFontSize },
    primaryWhite: { total: totals.primaryWhite, files: filesByCat.primaryWhite },
  };

  let existingRaw: string | null;
  if (opts.existingBaselineJson !== undefined) {
    existingRaw = opts.existingBaselineJson;
  } else {
    const p = resolve(rootDir, BASELINE_RELPATH);
    existingRaw = existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  const refusals: string[] = [];
  const moveWarnings: string[] = [];
  let prevTotals: Record<DesignCategoryId, number> | null = null;
  let bootstrap = false;

  if (existingRaw === null) {
    bootstrap = true;
    log(`⚠ ${BASELINE_RELPATH} not found — BOOTSTRAP: freezing the current tree as the initial baseline.`);
  } else {
    const parsed = parseBaselineJson(existingRaw);
    if (!parsed.ok || !parsed.baseline) {
      refusals.push(
        `existing ${BASELINE_RELPATH} is invalid (${parsed.error ?? "unknown"}). Restore a valid committed artifact ` +
          `first — git checkout --ours|--theirs -- ${BASELINE_RELPATH} (mid-rebase) or ` +
          `git checkout HEAD -- ${BASELINE_RELPATH} (hand edit) — then re-run.`,
      );
    } else if (parsed.baseline.version !== BASELINE_VERSION) {
      // One-time definition migration: the scanner definitions changed since
      // this artifact was frozen, so totals may legitimately move in either
      // direction. Re-freeze the current tree under the new definitions.
      prevTotals = { hexColors: 0, textPx: 0, rounded: 0, zIndex: 0, chartFontSize: 0, primaryWhite: 0 };
      // Older-version artifacts may predate newer categories (v3 added chartFontSize, v4 primaryWhite).
      for (const id of CATEGORY_IDS) prevTotals[id] = parsed.baseline.categories[id]?.total ?? 0;
      log(
        `⚠ definition migration: artifact version ${parsed.baseline.version} → ${BASELINE_VERSION}. ` +
          `Totals re-frozen under the new scanner definitions (increases permitted for this migration only).`,
      );
    } else {
      prevTotals = { hexColors: 0, textPx: 0, rounded: 0, zIndex: 0, chartFontSize: 0, primaryWhite: 0 };
      for (const id of CATEGORY_IDS) {
        const prevCat = parsed.baseline.categories[id];
        prevTotals[id] = prevCat.total;
        if (fresh[id].total > prevCat.total) {
          const offenders = Object.entries(fresh[id].files)
            .filter(([f, c]) => c > (prevCat.files[f] ?? 0))
            .sort(
              (a, b) =>
                b[1] - (prevCat.files[b[0]] ?? 0) - (a[1] - (prevCat.files[a[0]] ?? 0)),
            )
            .slice(0, 10)
            .map(([f, c]) => `${f} ${prevCat.files[f] ?? 0}→${c}`);
          refusals.push(
            `${CATEGORIES[id].lintName}: total would RISE ${prevCat.total} → ${fresh[id].total}. ` +
              `The ratchet only moves down — replace the new occurrence(s) with tokens ` +
              `(top offenders: ${offenders.join(", ")}).`,
          );
        } else {
          for (const [f, c] of Object.entries(fresh[id].files)) {
            const prevCount = prevCat.files[f] ?? 0;
            if (c <= prevCount) continue;
            const increase = c - prevCount;
            // Evidence 1: a git rename INTO this path whose old-path baseline
            // count covers the increase (a count-conserving move).
            const pair = renamePairs.find((p) => {
              if (p.to !== f) return false;
              const fromPrev = prevCat.files[p.from] ?? 0;
              const fromFresh = fresh[id].files[p.from] ?? 0;
              return fromPrev - fromFresh >= increase;
            });
            if (pair) {
              moveWarnings.push(
                `${CATEGORIES[id].lintName}: ${f} ${prevCount}→${c} (+${increase}) absorbed as a ` +
                  `count-conserving move (git rename ${pair.from} → ${f}).`,
              );
              continue;
            }
            // Evidence 2: an audited override — absorbed, reason logged loudly.
            if (auditedMoveReason) {
              moveWarnings.push(
                `${CATEGORIES[id].lintName}: ${f} ${prevCount}→${c} (+${increase}) absorbed via ` +
                  `AUDITED override — reason: ${auditedMoveReason}`,
              );
              continue;
            }
            // No evidence: an offsetting reduction elsewhere must not hide a
            // brand-new break (Task #4507).
            refusals.push(
              `${CATEGORIES[id].lintName}: ${f} ${prevCount}→${c} (+${increase}) has no move evidence — ` +
                `offsetting reductions elsewhere do not excuse new occurrences. Replace them with tokens, ` +
                `or if this IS a file move/rename, stage it (git add -A) so git records the rename, ` +
                `or re-run with --audited-move="<reason>" for an audited absorption.`,
            );
          }
        }
      }
    }
  }

  if (refusals.length > 0) {
    logError(`✗ regen-design-contract-baseline REFUSED:`);
    for (const r of refusals) logError(`  - ${r}`);
    return { ok: false, bootstrap, refusals, moveWarnings, artifactJson: null, totals, prevTotals };
  }

  const generatedAtIso = opts.generatedAtIso ?? new Date().toISOString().slice(0, 10);
  const artifactJson = composeBaselineJson(fresh, generatedAtIso);
  for (const w of moveWarnings) log(`⚠ ${w}`);
  for (const id of CATEGORY_IDS) {
    const prev = prevTotals ? `${prevTotals[id]} → ` : "";
    log(`  ${CATEGORIES[id].lintName}: ${prev}${totals[id]}`);
  }
  return { ok: true, bootstrap, refusals, moveWarnings, artifactJson, totals, prevTotals };
}

function main(): number {
  let auditedMoveReason: string | undefined;
  for (const arg of process.argv.slice(2)) {
    const m = /^--audited-move=(.*)$/.exec(arg);
    if (m) {
      auditedMoveReason = m[1];
      if (!auditedMoveReason.trim()) {
        console.error(`✗ --audited-move requires a non-empty reason: --audited-move="moved X into Y"`);
        return 1;
      }
    } else {
      console.error(`✗ unknown argument: ${arg} (only --audited-move="<reason>" is supported)`);
      return 1;
    }
  }
  const res = regenerateBaseline({ auditedMoveReason });
  if (!res.ok || res.artifactJson === null) return 1;
  writeFileSync(resolve(process.cwd(), BASELINE_RELPATH), res.artifactJson);
  console.log(`✓ ${BASELINE_RELPATH} regenerated. Commit the artifact together with your change.`);
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("regen-design-contract-baseline.ts") ?? false);
if (isMain) {
  process.exit(main());
}

/**
 * Rename pairs from git (staged and unstaged vs HEAD). Unstaged pure renames
 * surface as delete+untracked and are invisible here — stage the move
 * (`git add -A`) before regenerating.
 */
export function detectGitRenamePairs(): RenamePair[] {
  const pairs: RenamePair[] = [];
  for (const args of [
    ["diff", "-M", "--name-status", "HEAD"],
    ["diff", "-M", "--name-status", "--cached"],
  ]) {
    let out: string;
    try {
      out = execFileSync("git", args, { encoding: "utf8" });
    } catch {
      continue; // no HEAD yet / not a repo: no rename evidence
    }
    for (const line of out.split("\n")) {
      const m = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line.trim());
      if (m) pairs.push({ from: m[1], to: m[2] });
    }
  }
  return pairs;
}
