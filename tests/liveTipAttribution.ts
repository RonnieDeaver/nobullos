/**
 * Task #5318 — Live-tip fallback for stuck attribution.
 *
 * tests/redManifest.ts's manifest-based proof (classifyFailure) only excuses
 * a failure as "inherited" when the nightly-published red manifest lists it
 * with a matching failure signature AND an identical input fingerprint. That
 * bar is deliberately strict (Task #3922) — it is the ONLY thing standing
 * between a task-caused red and a silently-excused regression. But it has a
 * well-known blind spot: a stale/absent/mismatched manifest, or a
 * fingerprint shift caused by an unrelated blast-radius touch, makes a
 * genuinely pre-existing failure fall open to "yours"/"unattributable" even
 * though an agent could trivially prove it inherited by hand: stash the
 * task's diff (or check out a clean worktree at the resolved upstream base
 * commit) and re-run the one failing suite there.
 *
 * This module mechanizes exactly that manual ritual as a bounded, opt-in
 * SECOND proof source — never a replacement for the manifest rails above:
 *
 *   - `classifyLiveTipCandidate` is the pure, conservative classifier: given
 *     the head failure's signature and one base-tree run outcome, it decides
 *     "proved" (identical signature reproduces at the base commit — the
 *     task's tree is provably uninvolved), "not-proved" (the base run
 *     passed, or failed with a different signature — the task likely IS
 *     involved), or "inconclusive" (the base run could not be attempted or
 *     did not finish — budget/cap/spawn trouble). Only "proved" may ever
 *     upgrade a verdict; every other outcome leaves today's static verdict
 *     exactly as it was.
 *   - `reproduceAtUpstream` is the impure orchestrator: it resolves a
 *     trustworthy clean upstream base commit via the SAME base-resolution
 *     logic the gate-lint A/B rails already use (`resolveBaseTree` in
 *     scripts/gateLintAttribution.ts — merge → HEAD^2, non-merge → HEAD with
 *     the worktree-only diff), materializes it into a disposable
 *     `git worktree`, and re-runs each candidate suite there through the
 *     same `npx tsx` invocation shape tests/run-all.ts itself uses (see
 *     `runOne`). The worktree is scoped to this process (pid + timestamp in
 *     its path) and is always torn down in a `finally` block — concurrent
 *     gate runs never collide, and the task's own working tree is never
 *     touched.
 *
 * Budget discipline: the whole pass is bounded by ONE wall-clock budget
 * (TEST_LIVE_TIP_BUDGET_MS, default DEFAULT_LIVE_TIP_BUDGET_MS) and a hard
 * cap on how many suites it will attempt per run
 * (TEST_LIVE_TIP_MAX_SUITES, default DEFAULT_LIVE_TIP_MAX_SUITES). Once
 * either is spent, remaining candidates are reported "inconclusive" and fall
 * back to their static verdict — this fallback can only ADD excusals it can
 * prove, never weaken or replace the conservative default.
 *
 * Lane guard: the task diff intersecting LIVE_TIP_HARNESS_PATHS (this
 * module, the attribution module, the runner, or the base-resolution
 * helper) forces the ENTIRE pass off for that run — the machinery deciding
 * truth must never grade its own self-attestation. The caller
 * (tests/redManifest.ts's `attributeRunFailures`) additionally gates
 * whether this module is even invoked: only the excusal-eligible smoke lane
 * (never nightly publish, full/regression sweeps, or isolated-evidence
 * runs) may arm it, mirroring the existing excusal-arming pattern.
 *
 * DB isolation note: a live-tip re-run of a suite happens strictly AFTER
 * the main sweep's shard execution has finished (attribution runs post-hoc,
 * once hard failures are known), so it is never concurrent with another
 * suite in the SAME run — the same non-concurrency guarantee a retry
 * already relies on. It reuses the run's existing DB/pool env exactly like
 * a retry does (see `runOne`); it does not provision a separate database.
 */

import { spawn, spawnSync } from "node:child_process";
import { rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeFailureSignature, signaturesMatch } from "./redManifest";
import { resolveBaseTree } from "../scripts/gateLintAttribution";

/** Kill switch: defaults ON for the eligible smoke lane; "0" disables. Read
 * only by tests/run-all.ts when computing `liveTipArmed` — this module never
 * reads it directly, mirroring how TEST_ATTRIBUTION_EXCUSE stays out of
 * tests/redManifest.ts's own reads (single wiring owner, pinned by tests). */
export const LIVE_TIP_KILL_SWITCH_ENV = "TEST_LIVE_TIP_ATTRIBUTION";
/** Overall wall-clock budget in ms for the whole live-tip pass (worktree add
 * + every candidate's base-tree re-run). */
export const LIVE_TIP_BUDGET_ENV = "TEST_LIVE_TIP_BUDGET_MS";
/** Hard cap on how many failing suites live-tip will attempt in one run. */
export const LIVE_TIP_MAX_SUITES_ENV = "TEST_LIVE_TIP_MAX_SUITES";

export const DEFAULT_LIVE_TIP_BUDGET_MS = 240_000;
export const DEFAULT_LIVE_TIP_MAX_SUITES = 3;
export const DEFAULT_LIVE_TIP_PER_SUITE_TIMEOUT_MS = 120_000;

/** Task-diff intersection with any of these forces the WHOLE live-tip pass
 * off for this run (never just the touching suite) — the attribution
 * machinery must never be trusted to grade a change to itself. */
export const LIVE_TIP_HARNESS_PATHS: readonly string[] = [
  "tests/redManifest.ts",
  "tests/liveTipAttribution.ts",
  "tests/run-all.ts",
  "scripts/gateLintAttribution.ts",
];

// Mirrors tests/run-all.ts's CHILD_POOL_ENV — a live-tip re-run is a single
// suite, not a full sweep, so it gets the same small-pool footprint a solo
// retry would.
const CHILD_POOL_ENV = {
  DB_API_POOL_MIN: "1",
  DB_API_POOL_MAX: "3",
  DB_WORKER_POOL_MIN: "0",
  DB_WORKER_POOL_MAX: "2",
};

export interface LiveTipCandidate {
  file: string;
  name: string;
  /** run-all-shaped failureReason at HEAD, e.g. "exit 1" / "hang 184s". */
  headFailureReason: string;
  extraNodeArgs?: string[];
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

export interface LiveTipOutcome {
  file: string;
  status: "proved" | "not-proved" | "inconclusive";
  detail: string;
  evidence: string[];
}

export interface LiveTipRunResult {
  /** True once the pass actually attempted (or explicitly chose to attempt
   * zero) candidates; false when it could not even start (base resolution
   * failed, worktree setup failed, or the harness-path guard tripped). */
  ran: boolean;
  skippedReason: string | null;
  baseCommit: string | null;
  outcomes: LiveTipOutcome[];
  wallMs: number;
  budgetMs: number;
  maxSuites: number;
}

export type LiveTipRunner = (opts: {
  repoRoot: string;
  candidates: LiveTipCandidate[];
  budgetMs?: number;
  maxSuites?: number;
  perSuiteTimeoutMs?: number;
  log?: (line: string) => void;
}) => Promise<LiveTipRunResult>;

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

export interface BaseSuiteRun {
  /** "ran" = the suite actually executed to completion or was killed for
   * hanging (hangs are folded into `failureReason`, exactly like run-all's
   * own runOne — there is no separate "timeout" status: a base-tree hang
   * IS a real repro attempt, not infra trouble). "spawn-error"/
   * "budget-exhausted" mean the suite was never meaningfully exercised. */
  status: "ran" | "spawn-error" | "budget-exhausted";
  /** run-all-shaped failureReason ("exit N" / "hang Ns" / "" for a clean
   * pass); null when status !== "ran". */
  failureReason: string | null;
  detail?: string;
}

export interface LiveTipVerdict {
  status: "proved" | "not-proved" | "inconclusive";
  detail: string;
  evidence: string[];
}

/**
 * Pure and conservative: only an identical failure signature reproducing at
 * the resolved upstream base may return "proved". Anything else — a clean
 * base pass, a different signature, or an inconclusive base run — leaves the
 * failure exactly where the static manifest-based verdict left it.
 */
export function classifyLiveTipCandidate(input: {
  headFailureReason: string;
  baseRun: BaseSuiteRun | undefined;
}): LiveTipVerdict {
  const { headFailureReason, baseRun } = input;
  if (!baseRun) {
    return {
      status: "inconclusive",
      detail: "no base-tree run recorded (live-tip budget/cap exhausted before this suite was attempted)",
      evidence: [],
    };
  }
  if (baseRun.status === "budget-exhausted") {
    return {
      status: "inconclusive",
      detail: "live-tip's per-run wall-clock budget was exhausted before this suite ran",
      evidence: [],
    };
  }
  if (baseRun.status === "spawn-error") {
    return {
      status: "inconclusive",
      detail: `base-tree run could not be executed (${baseRun.detail ?? "no detail"}) — cannot prove either way`,
      evidence: [],
    };
  }
  const reason = baseRun.failureReason ?? "";
  if (reason.length === 0) {
    return {
      status: "not-proved",
      detail: "the suite PASSED at the resolved upstream base commit — the task's tree causes this failure",
      evidence: [],
    };
  }
  if (!signaturesMatch(headFailureReason, reason)) {
    return {
      status: "not-proved",
      detail: `base-tree failure signature differs (base "${reason}" vs head "${headFailureReason}") — not the same breakage`,
      evidence: [],
    };
  }
  return {
    status: "proved",
    detail: `identical failure signature "${normalizeFailureSignature(reason)}" reproduces at the resolved upstream base commit — the task's tree is provably uninvolved`,
    evidence: [`base-tree run: ${reason}`],
  };
}

// ---------------------------------------------------------------------------
// Impure: disposable worktree + real suite runner
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const res = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: res.status === 0 && res.error == null, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message };
  }
}

/** Mirrors tests/run-all.ts's runOne exactly (same command shape, same
 * detached-process-group timeout kill), but resolves a run-all-shaped
 * BaseSuiteRun instead of a raw status/signal pair. */
function runSuiteAt(dir: string, candidate: LiveTipCandidate, timeoutMs: number): Promise<BaseSuiteRun> {
  return new Promise((resolvePromise) => {
    const extra = candidate.extraNodeArgs ?? [];
    const file = candidate.file;
    const args = candidate.extraEnv?.TSX_TSCONFIG_PATH
      ? ["tsx", ...extra, file]
      : file.endsWith(".tsx")
        ? ["tsx", ...extra, "--tsconfig", "./tsconfig.tests.json", file]
        : ["tsx", ...extra, file];
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      RUN_INTEGRATION_TESTS: "1",
      ...CHILD_POOL_ENV,
      ...(candidate.extraEnv ?? {}),
    };
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("npx", args, { cwd: dir, stdio: "ignore", detached: true, env: childEnv });
    } catch (err) {
      resolvePromise({ status: "spawn-error", failureReason: null, detail: (err as Error).message });
      return;
    }
    const startedAt = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* best-effort */
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* best-effort */
        }
      }, 5_000).unref();
    }, timeoutMs);
    child.on("exit", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      if (timedOut || signal) {
        resolvePromise({ status: "ran", failureReason: `hang ${elapsedSec}s` });
      } else if (status !== 0) {
        resolvePromise({ status: "ran", failureReason: `exit ${status}` });
      } else {
        resolvePromise({ status: "ran", failureReason: "" });
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ status: "spawn-error", failureReason: null, detail: err.message });
    });
  });
}

/**
 * Reproduce up to `maxSuites` failing suites against a clean upstream base
 * commit inside a disposable, per-invocation `git worktree`. Never throws:
 * any failure to even start (base resolution, worktree add, node_modules
 * symlink, or a harness-path touch) yields `ran: false` with a
 * `skippedReason`, which the caller must treat as "no upgrade for anyone" —
 * exactly like the static verdicts these candidates already carry.
 */
export async function reproduceAtUpstream(opts: {
  repoRoot: string;
  candidates: LiveTipCandidate[];
  budgetMs?: number;
  maxSuites?: number;
  perSuiteTimeoutMs?: number;
  log?: (line: string) => void;
}): Promise<LiveTipRunResult> {
  const log = opts.log ?? (() => {});
  const envBudget = Number(process.env[LIVE_TIP_BUDGET_ENV]);
  const budgetMs = opts.budgetMs ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : DEFAULT_LIVE_TIP_BUDGET_MS);
  const envMaxSuites = Number(process.env[LIVE_TIP_MAX_SUITES_ENV]);
  const maxSuites =
    opts.maxSuites ?? (Number.isFinite(envMaxSuites) && envMaxSuites > 0 ? envMaxSuites : DEFAULT_LIVE_TIP_MAX_SUITES);
  const perSuiteTimeoutMs = opts.perSuiteTimeoutMs ?? DEFAULT_LIVE_TIP_PER_SUITE_TIMEOUT_MS;
  const start = Date.now();
  const deadline = start + budgetMs;

  const notRun = (skippedReason: string, baseCommit: string | null = null): LiveTipRunResult => ({
    ran: false,
    skippedReason,
    baseCommit,
    outcomes: [],
    wallMs: Date.now() - start,
    budgetMs,
    maxSuites,
  });

  if (opts.candidates.length === 0) {
    return { ran: true, skippedReason: null, baseCommit: null, outcomes: [], wallMs: Date.now() - start, budgetMs, maxSuites };
  }

  let resolved: ReturnType<typeof resolveBaseTree>;
  try {
    resolved = resolveBaseTree(opts.repoRoot);
  } catch (err) {
    return notRun(`base-tree resolution threw (${(err as Error).message})`);
  }
  if ("error" in resolved) {
    return notRun(`could not resolve upstream base commit: ${resolved.error}`);
  }
  const touchedHarness = LIVE_TIP_HARNESS_PATHS.filter((p) => resolved.taskDiffFiles.includes(p));
  if (touchedHarness.length > 0) {
    return notRun(
      `task diff touches attribution harness file(s) (${touchedHarness.join(", ")}) — live-tip never trusts a self-attesting change to its own machinery`,
      resolved.baseCommit,
    );
  }

  const toAttempt = opts.candidates.slice(0, maxSuites);
  const skippedByCap = opts.candidates.slice(maxSuites);
  const outcomes: LiveTipOutcome[] = [];
  const dir = join(tmpdir(), `gate-live-tip-${process.pid}-${Date.now()}`);
  const add = git(opts.repoRoot, ["worktree", "add", "--detach", dir, resolved.baseCommit]);
  if (!add.ok) {
    return notRun(`git worktree add failed: ${add.stderr.trim().slice(0, 400)}`, resolved.baseCommit);
  }
  try {
    try {
      symlinkSync(resolve(opts.repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
    } catch (err) {
      return notRun(`node_modules symlink into the live-tip worktree failed: ${(err as Error).message}`, resolved.baseCommit);
    }

    for (const candidate of toAttempt) {
      const remaining = deadline - Date.now();
      if (remaining <= 2_000) {
        outcomes.push({
          file: candidate.file,
          status: "inconclusive",
          detail: `live-tip budget (${budgetMs}ms) exhausted before this suite ran`,
          evidence: [],
        });
        continue;
      }
      log(`[live-tip] reproducing ${candidate.name} at upstream base ${resolved.baseCommit.slice(0, 10)}…`);
      let baseRun: BaseSuiteRun;
      try {
        baseRun = await runSuiteAt(dir, candidate, Math.min(perSuiteTimeoutMs, remaining));
      } catch (err) {
        baseRun = { status: "spawn-error", failureReason: null, detail: (err as Error).message };
      }
      const verdict = classifyLiveTipCandidate({ headFailureReason: candidate.headFailureReason, baseRun });
      outcomes.push({ file: candidate.file, status: verdict.status, detail: verdict.detail, evidence: verdict.evidence });
    }
    for (const skipped of skippedByCap) {
      outcomes.push({
        file: skipped.file,
        status: "inconclusive",
        detail: `live-tip per-run suite cap (${maxSuites}) reached before this suite was attempted`,
        evidence: [],
      });
    }
  } finally {
    const rm = git(opts.repoRoot, ["worktree", "remove", "--force", dir]);
    if (!rm.ok) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      git(opts.repoRoot, ["worktree", "prune"]);
    }
  }

  return { ran: true, skippedReason: null, baseCommit: resolved.baseCommit, outcomes, wallMs: Date.now() - start, budgetMs, maxSuites };
}
