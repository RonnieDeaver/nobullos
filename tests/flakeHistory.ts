/**
 * Task #3797 — per-suite flake-history journal (Google TAP / Chromium LUCI
 * practice): every run appends each suite's outcome to a persistent journal
 * so repeat offenders surface in the end-of-run summary instead of vanishing
 * into scrollback. The journal lives with the run artifacts under
 * `.local/runs/` (never committed).
 *
 * Pure functions + tiny fs wrappers so the logic is unit-testable without a
 * filesystem.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SUITE_HISTORY_PATH = ".local/runs/history/suite-history.json";

/** Cap per-suite records so the journal stays small forever. */
export const MAX_RECORDS_PER_SUITE = 25;

export interface SuiteRunRecord {
  at: string; // run start ISO timestamp
  outcome: "passed" | "failed";
  ms: number;
  mode: string; // all | smoke | regression
  reason?: string; // failureReason when failed
  /**
   * Task #5028: true when this run was a sweep/nightly lane (regression or
   * nightly-publish mode), not a smoke gate or isolated --file run. Used by
   * the auto-quarantine reinstatement check: ≥3 of the trailing 10 greens
   * must come from sweep lanes to prove the suite is stable under sweep
   * conditions (where flakes typically manifest).
   */
  sweepLane?: boolean;
}

export interface SuiteHistoryFile {
  schemaVersion: 1;
  updatedAt: string;
  suites: Record<string, SuiteRunRecord[]>;
}

export interface RunOutcomeEntry {
  file: string;
  outcome: "passed" | "failed";
  elapsedMs: number;
  failureReason?: string;
  /** Task #5028: true when this run was a sweep/nightly lane. See SuiteRunRecord.sweepLane. */
  sweepLane?: boolean;
}

export function emptyHistory(): SuiteHistoryFile {
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), suites: {} };
}

/** Append one run's outcomes; returns a NEW history object (pure). */
export function appendRunToHistory(
  history: SuiteHistoryFile,
  results: RunOutcomeEntry[],
  meta: { at: string; mode: string; sweepLane?: boolean },
): SuiteHistoryFile {
  const suites: Record<string, SuiteRunRecord[]> = { ...history.suites };
  for (const r of results) {
    const rec: SuiteRunRecord = {
      at: meta.at,
      outcome: r.outcome,
      ms: r.elapsedMs,
      mode: meta.mode,
      ...(meta.sweepLane ? { sweepLane: true } : {}),
      ...(r.outcome === "failed" && r.failureReason ? { reason: r.failureReason } : {}),
    };
    const prev = suites[r.file] ?? [];
    suites[r.file] = [...prev, rec].slice(-MAX_RECORDS_PER_SUITE);
  }
  return { schemaVersion: 1, updatedAt: meta.at, suites };
}

export interface RepeatOffender {
  file: string;
  failures: number;
  window: number; // how many recorded runs were considered
  lastFailureAt: string;
  lastReason?: string;
  /**
   * Task #4187 — classification:
   *   - "flaky": failures interleave with passes (or the suite is still red)
   *     → genuinely intermittent, surfaces loudly.
   *   - "recovered": the window's failures form ONE contiguous block followed
   *     by ≥ RECOVERY_GREENS consecutive passes — the signature of a
   *     deterministic failure burst bounded by a fixing commit (e.g. stale
   *     assertions after a base change), NOT nondeterminism. Reported
   *     quietly so the loud list stays actionable.
   */
  kind: "flaky" | "recovered";
}

/**
 * How many consecutive trailing passes are required before a contiguous
 * failure burst counts as "recovered". 3 greens ≈ several distinct runs
 * (smoke gates + nightly), enough to distinguish "someone fixed it" from
 * "it happened to pass once".
 */
export const RECOVERY_GREENS = 3;

/**
 * True when the failures inside `recent` form exactly one contiguous block
 * and the window ends with ≥ RECOVERY_GREENS consecutive passes after it.
 * (The block may begin at the window's start — the burst's head can have
 * aged out of the window; contiguity within the window is what matters.)
 */
function isRecoveredBurst(recent: ReadonlyArray<{ outcome: string }>): boolean {
  const failIdx = recent
    .map((r, i) => (r.outcome === "failed" ? i : -1))
    .filter((i) => i >= 0);
  if (failIdx.length === 0) return false;
  const first = failIdx[0];
  const last = failIdx[failIdx.length - 1];
  // Contiguous: no pass inside [first, last].
  if (last - first + 1 !== failIdx.length) return false;
  // Recovered: ≥ RECOVERY_GREENS trailing passes after the block.
  return recent.length - 1 - last >= RECOVERY_GREENS;
}

/**
 * Task #4217 — classify a suite's recent recorded history for consumers
 * OUTSIDE the repeat-offender report (currently the failure-attribution
 * evidence in tests/redManifest.ts). Applies the same default window as
 * findRepeatOffenders so both surfaces agree on what "recent" means:
 *   - "none": no failures in the window;
 *   - "recovered": one contiguous failure block + ≥RECOVERY_GREENS trailing
 *     passes — a deterministic burst bounded by a fixing commit;
 *   - "flaky": any other failure shape (alternation, still-red tail).
 * Pure and side-effect free; corroborating signal only, never proof.
 */
export function classifyRecentFailureHistory(
  records: ReadonlyArray<{ outcome: string }>,
  opts: { window?: number } = {},
): "none" | "flaky" | "recovered" {
  const window = opts.window ?? 10;
  const recent = records.slice(-window);
  if (!recent.some((r) => r && r.outcome === "failed")) return "none";
  return isRecoveredBurst(recent) ? "recovered" : "flaky";
}

/**
 * A suite is a repeat offender when it failed ≥ minFailures times within its
 * last `window` recorded outcomes. This is deliberately per-suite recorded
 * history (not calendar time): a suite that only runs in full mode still
 * accumulates a meaningful window.
 */
export function findRepeatOffenders(
  history: SuiteHistoryFile,
  opts: { window?: number; minFailures?: number } = {},
): RepeatOffender[] {
  const window = opts.window ?? 10;
  const minFailures = opts.minFailures ?? 2;
  const out: RepeatOffender[] = [];
  for (const [file, records] of Object.entries(history.suites)) {
    const recent = records.slice(-window);
    const failures = recent.filter((r) => r.outcome === "failed");
    if (failures.length >= minFailures) {
      const last = failures[failures.length - 1];
      out.push({
        file,
        failures: failures.length,
        window: recent.length,
        lastFailureAt: last.at,
        ...(last.reason ? { lastReason: last.reason } : {}),
        kind: isRecoveredBurst(recent) ? "recovered" : "flaky",
      });
    }
  }
  return out.sort((a, b) => b.failures - a.failures || a.file.localeCompare(b.file));
}

export function formatRepeatOffenders(offenders: RepeatOffender[]): string[] {
  if (offenders.length === 0) return [];
  const lines: string[] = [];
  const flaky = offenders.filter((o) => o.kind === "flaky");
  const recovered = offenders.filter((o) => o.kind === "recovered");
  if (flaky.length > 0) {
    lines.push(
      `Repeat offenders (failed ≥2 of their last ≤10 recorded runs — fix or quarantine with reason+expiry, see TESTING.md):`,
    );
    for (const o of flaky) {
      lines.push(
        `  - ${o.file}: ${o.failures}/${o.window} recent runs failed` +
          (o.lastReason ? ` (last failure: ${o.lastReason})` : ""),
      );
    }
  }
  if (recovered.length > 0) {
    // Task #4187: a contiguous failure block followed by ≥RECOVERY_GREENS
    // consecutive greens is deterministic base drift bounded by a fixing
    // commit, not flake — report it as informational so the loud list above
    // stays actionable.
    lines.push(
      `Recovered (deterministic burst — contiguous failures, ≥${RECOVERY_GREENS} greens since; no action needed):`,
    );
    for (const o of recovered) {
      lines.push(
        `  - ${o.file}: ${o.failures}/${o.window} recent runs failed, all contiguous; green since ${o.lastFailureAt}` +
          (o.lastReason ? ` (last failure: ${o.lastReason})` : ""),
      );
    }
  }
  return lines;
}

// ─── fs wrappers ─────────────────────────────────────────────────────

export function loadSuiteHistory(path: string = SUITE_HISTORY_PATH): SuiteHistoryFile {
  try {
    const full = resolve(path);
    if (!existsSync(full)) return emptyHistory();
    const parsed = JSON.parse(readFileSync(full, "utf8")) as Partial<SuiteHistoryFile>;
    if (parsed && parsed.schemaVersion === 1 && parsed.suites && typeof parsed.suites === "object") {
      return parsed as SuiteHistoryFile;
    }
    return emptyHistory();
  } catch {
    return emptyHistory();
  }
}

export function saveSuiteHistory(history: SuiteHistoryFile, path: string = SUITE_HISTORY_PATH): void {
  try {
    const full = resolve(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(history, null, 2));
  } catch (err) {
    console.warn(`[flake-history] could not persist ${path}:`, err);
  }
}
