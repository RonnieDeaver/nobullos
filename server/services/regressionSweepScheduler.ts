// @cross-instance-safe: workspace-only nightly sweep (gated to !isRunningInDeployment so only the single dev-workspace process schedules it); the failure alert is dedupe-keyed by day so a duplicate run can't double-post.
/**
 * Task #2611 — Nightly scheduled regression sweep.
 *
 * Problem: rarely-run tests rot. A test flagged `regression: true` only runs
 * when someone passes `--regression` (or it is in the small TEST_SMOKE gate),
 * so a regression-flagged-but-unselected test can silently break for months
 * and nobody notices. This scheduler runs the full `--regression` suite once a
 * night and alerts the team (Slack + in-app inbox) if anything broke, so a
 * rotted test is caught within a day.
 *
 * WORKSPACE-ONLY by design. The test suite is bound to the dev workspace:
 * `tests/run-all.ts` provisions a hermetic per-run Postgres on the local
 * filesystem (Task #3797). Running it in the deployed
 * autoscale environment would point the suite at the live Neon prod database —
 * catastrophic. So this scheduler is gated to `!isRunningInDeployment()`,
 * the OPPOSITE of the Front workers. (This is also why a single in-process
 * schedule is cross-instance-safe: only the one workspace process ever arms
 * it.)
 *
 * Default ON in the workspace. Set `REGRESSION_SWEEP_SCHEDULER_ENABLED=false`
 * to opt out. It does NOT run on boot by default (cron only fires at the
 * nightly wall-clock time), but Task #4437 adds a catch-up arm: if the
 * committed baseline is stale (age > CATCHUP_BASELINE_AGE_THRESHOLD_DAYS) and
 * no sweep has completed recently, a catch-up run fires once per calendar day
 * (gated by REGRESSION_SWEEP_CATCHUP_ENABLED, default ON). This closes the
 * gap where the workspace process is not alive at 03:30 ET.
 *
 * Task #4530 — The catch-up arm is publisher-gated: it must only fire on the
 * MAIN dev workspace (set REGRESSION_SWEEP_PUBLISHER_ENABLED=1). Task-branch
 * environments must not publish baselines from diverged trees, which would
 * corrupt the single-writer invariant. The staleness watchdog is exempt from
 * this gate (it only alerts; it never triggers a publish).
 *
 * Flaky handling: the spawned run uses `--sweep`, which (a) retries a failing
 * file a couple of times so a transient contention flake recovers, and (b)
 * downgrades a failure in a quarantined file (see `regressionSweep.ts`) to a
 * warning. Only a real, non-quarantined failure raises the alert, so the
 * sweep isn't perpetually red.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import cron from "node-cron";

import { isRunningInDeployment } from "../lib/deploymentEnv";
import { withDbAttribution } from "../db";
import {
  buildSweepRunArgs,
  isFullIntegritySweepDate,
  parseSweepReport,
  readDurationBudgetBreachEvents,
  reportIndicatesFailure,
  summarizeSweepResult,
  type DurationBudgetBreachEvent,
  type SweepReport,
} from "./regressionSweep";
import { notifyByType } from "./notifications/dispatcher";
import {
  fileAndResolveSweepFeedback,
  fileAndResolveQuarantineFeedback,
  listOpenSweepItemFiles,
  resolveOpenSweepItemsForFile,
} from "./regressionSweepFeedback";
import {
  relayFeedbackToSlack,
  FEEDBACK_SLACK_RELAY_BUDGET_MS,
} from "./feedbackSlackRelay";
import { registerModuleStateResetForTest } from "./moduleStateReset";

const NOTIFICATION_ID = "infra.regression_sweep.failed";
// 03:30 America/New_York — overnight, after the other daily-ish jobs.
const CRON_EXPRESSION = "30 3 * * *";
const CRON_TIMEZONE = "America/New_York";

/**
 * Task #4077 — skip-health: alert when the committed green baseline stops
 * refreshing. The nightly run publishes it on EVERY run (red or green), so
 * with a healthy publish arm its age right after a tick is ~0 days. Anything
 * older than this threshold means baseline publishing is broken (or the
 * sweep has not completed in days) and every task validation is silently
 * paying for a full re-execution — the exact regression this task fixed.
 */
export const BASELINE_STALENESS_ALERT_DAYS = 2;

/**
 * Task #4501 — alert when the red manifest (tests/red-manifest.json)
 * hasn't been updated by either the nightly sweep or the post-merge
 * canary within this many days. Independent of the baseline watchdog
 * so a sweep that publishes the baseline but crashes before writing
 * the manifest still triggers the alert.
 */
export const RED_MANIFEST_STALENESS_ALERT_DAYS = 2;

/**
 * Task #4437 — catch-up arm thresholds.
 * Age at which the catch-up arm kicks in (lower than BASELINE_STALENESS_ALERT_DAYS
 * so the catch-up fires before the alert does on a missed nightly).
 */
export const CATCHUP_BASELINE_AGE_THRESHOLD_DAYS = 1.5;
/** Hours since the last completed sweep before the catch-up arm considers acting. */
export const CATCHUP_MIN_HOURS_SINCE_LAST_TICK = 20;
/** 1-minute loadavg above which the catch-up arm defers (merge-queue contention). */
export const CATCHUP_LOAD_DEFER_THRESHOLD = 8;
/** Consecutive infra-crash count that triggers the crash-streak alert. */
export const CRASH_STREAK_ALERT_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Durable telemetry paths (Task #4437)
// ---------------------------------------------------------------------------

/** JSONL append log — every sweep attempt gets one record. */
export const TICK_LOG_PATH = ".local/runs/regression-sweep-tick-log.jsonl";
/** Last-attempt state file — answered "did the nightly run?" from disk. */
export const LAST_TICK_STATE_PATH = ".local/state/regression-sweep-last-tick.json";
/** Max entries kept in the tick log (trim on append). */
const TICK_LOG_MAX_ENTRIES = 400;

export interface CommittedBaselineStatus {
  publishedAt: string | null;
  ageDays: number | null;
}

/**
 * Read the committed baseline's publish stamp. Deliberately a tiny local
 * JSON read (NOT an import of tests/suiteFingerprint.ts — that would drag
 * the test harness into the server bundle). Never throws; absent/unreadable
 * → nulls, which the notification treats as "cannot assess" (no alert —
 * a repo with no baseline yet is not a staleness incident).
 */
export function readCommittedBaselineStatus(
  now: Date = new Date(),
  baselinePath = "tests/green-baseline.json",
): CommittedBaselineStatus {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as { publishedAt?: unknown } | null;
    const publishedAt = parsed && typeof parsed.publishedAt === "string" ? parsed.publishedAt : null;
    const t = publishedAt ? Date.parse(publishedAt) : NaN;
    if (!Number.isFinite(t)) return { publishedAt, ageDays: null };
    return { publishedAt, ageDays: (now.getTime() - t) / (24 * 60 * 60 * 1000) };
  } catch {
    return { publishedAt: null, ageDays: null };
  }
}

// ---------------------------------------------------------------------------
// Task #4112 — once-per-streak repeat-poison alerting.
//
// Task #4104 made the sweep notification fire (even on green sweeps) whenever
// a test file has carried a <build error> for 3+ consecutive skip audits. But
// the alert's dedupe key is per-day, so an unfixed file re-alerted every
// single night. This state file remembers WHICH poisoned files have already
// been alerted; a night whose poisoned set adds no new file stays quiet. A
// healed file is pruned from the state (the runner's streak history in
// .local/state/skip-poison-history.json resets it too), so a future
// re-poisoning alerts again.
// ---------------------------------------------------------------------------

export const DEFAULT_POISON_ALERT_STATE_PATH =
  ".local/state/regression-sweep-poison-alerted.json";

/** Read the set of poisoned files already alerted. Never throws — a missing
 * or corrupt state file simply means "nothing alerted yet" (worst case one
 * duplicate alert, never a missed one). */
export function readAlertedPoisonFiles(statePath = DEFAULT_POISON_ALERT_STATE_PATH): string[] {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { files?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.files)) return [];
    return parsed.files.filter((f): f is string => typeof f === "string");
  } catch {
    return [];
  }
}

/** Persist the currently-poisoned set as "alerted". Never throws. */
export function writeAlertedPoisonFiles(
  files: string[],
  statePath = DEFAULT_POISON_ALERT_STATE_PATH,
): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ files: [...files].sort() }, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not persist poison-alert state: ${(err as Error)?.message ?? err}`,
    );
  }
}

export const DEFAULT_LINT_RED_ALERT_STATE_PATH =
  ".local/state/regression-sweep-lint-red-alerted.json";
export const DEFAULT_BASELINE_STALENESS_ALERT_STATE_PATH =
  ".local/state/regression-sweep-baseline-staleness-alerted.json";

/** Read the publishedAt stamp of the baseline already alerted as stale.
 * Never throws — a missing or corrupt state file means "nothing alerted yet"
 * (worst case one duplicate alert, never a missed one). */
export function readAlertedBaselineStalenessStamp(
  statePath = DEFAULT_BASELINE_STALENESS_ALERT_STATE_PATH,
): string | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { publishedAt?: unknown } | null;
    return parsed && typeof parsed.publishedAt === "string" ? parsed.publishedAt : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, with null) the stale-alerted baseline stamp. Never throws. */
export function writeAlertedBaselineStalenessStamp(
  publishedAt: string | null,
  statePath = DEFAULT_BASELINE_STALENESS_ALERT_STATE_PATH,
): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ publishedAt }, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not persist baseline-staleness alert state: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task #4437 — out-of-band staleness watchdog state.
//
// Independent of the nightly tick: fires at boot + periodically and alerts
// when the baseline is stale even when the tick itself never ran. Uses its
// own once-per-streak stamp so it doesn't interfere with the tick's state.
// ---------------------------------------------------------------------------

export const DEFAULT_WATCHDOG_STALENESS_STATE_PATH =
  ".local/state/regression-sweep-watchdog-staleness-alerted.json";

export interface WatchdogStalenessState {
  /** publishedAt stamp of the baseline for which we last alerted. */
  publishedAt: string | null;
  /**
   * UTC YYYY-MM-DD of the day when we committed the stamp.
   * Task #4530 — daily re-alert: we re-alert when EITHER the episode changes
   * (new publishedAt) OR the calendar day rolls over (alertedOn ≠ today).
   * Old state files without this field read as null → treated as "not today"
   * → at most one extra alert on first boot with new code.
   */
  alertedOn: string | null;
}
/** @deprecated — use readWatchdogStalenessState; retained for existing tests that import this. */
export function readWatchdogStalenessStamp(
  statePath = DEFAULT_WATCHDOG_STALENESS_STATE_PATH,
): string | null {
  return readWatchdogStalenessState(statePath).publishedAt;
}

export function writeWatchdogStalenessState(
  state: WatchdogStalenessState,
  statePath = DEFAULT_WATCHDOG_STALENESS_STATE_PATH,
): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not persist watchdog staleness state: ${(err as Error)?.message ?? err}`,
    );
  }
}
export function writeWatchdogStalenessStamp(
  publishedAt: string | null,
  statePath = DEFAULT_WATCHDOG_STALENESS_STATE_PATH,
): void {
  writeWatchdogStalenessState({ publishedAt, alertedOn: null }, statePath);
}

/**
 * Task #4530 — structural sub-environment (task workspace) detection.
 *
 * The publisher opt-in flag alone cannot be "main workspace only": Replit
 * Secrets and shared env vars both propagate into task-branch environments,
 * so a flag set on main is visible in every clone. Two structural signals
 * distinguish the environments regardless of env-var inheritance:
 *
 *  1. REPL_ID shape — task environments run under a sub-scoped repl id of the
 *     form "<uuid>:<subid>"; the main workspace has a bare "<uuid>".
 *  2. The `main-repl` git remote — task environments carry a remote named
 *     `main-repl` (the completion-rebase target). The main workspace has no
 *     such remote (it IS the main repl).
 *
 * Fail-closed: when signals are missing or git cannot answer, we classify as
 * sub-environment (no publish). A wrong "sub-env" answer on main would freeze
 * the publisher — which the staleness watchdog alarm then reports within a
 * day, making the failure loud instead of silent.
 */
export interface MainReplRemoteProbe {
  /** spawnSync status: 0 = remote present, 1 = key absent, other/null = git error. */
  status: number | null;
  stdout: string;
}
/**
 * True only when REGRESSION_SWEEP_PUBLISHER_ENABLED=1 is explicitly set AND
 * this process is running in the main workspace (not a task sub-environment).
 * Gate the catch-up arm on this; the watchdog (alert-only, no publish) is
 * exempt.
 *
 * The two-condition gate exists because the flag alone is inherited by task
 * environments (Secrets and shared env vars both propagate into clones); the
 * structural check makes publishes impossible from task workspaces even when
 * the flag is visible there. `opts.isSubEnvironment` is an injection seam for
 * tests; production callers omit it and get real detection.
 */
export function isPublisherEnabled(opts?: { isSubEnvironment?: boolean }): boolean {
  const raw = (process.env.REGRESSION_SWEEP_PUBLISHER_ENABLED ?? "").trim().toLowerCase();
  const flagOn = raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  if (!flagOn) return false;
  const isSubEnv = opts?.isSubEnvironment ?? detectSubEnvironment();
  return !isSubEnv;
}

/**
 * Task #4530 S1 — builds the spawn env for every sweep trigger (cron,
 * catch-up, manual).  TEST_GREEN_BASELINE_PUBLISH=1 is injected ONLY when
 * the publisher gate passes (explicit flag + main workspace); task-branch
 * workspaces therefore never publish diverged baselines regardless of which
 * trigger fires or which env vars they inherited.  Exported for unit-testing.
 */
export function buildSweepSpawnEnv(opts?: { isSubEnvironment?: boolean }): NodeJS.ProcessEnv {
  if (isPublisherEnabled(opts)) {
    return { ...process.env, TEST_GREEN_BASELINE_PUBLISH: "1" };
  }
  // Explicitly remove the publish flag even if inherited from the parent env,
  // so a task-branch workspace that inherits TEST_GREEN_BASELINE_PUBLISH=1
  // cannot accidentally publish a diverged baseline.
  const env = { ...process.env };
  delete env.TEST_GREEN_BASELINE_PUBLISH;
  return env;
}

// ---------------------------------------------------------------------------
// Task #4501 — red-manifest staleness watchdog state helpers.
// Mirrors the baseline watchdog pattern but targets tests/red-manifest.json,
// which is updated by both the nightly sweep AND the post-merge canary.
// ---------------------------------------------------------------------------

export const DEFAULT_WATCHDOG_RED_MANIFEST_STATE_PATH =
  ".local/state/regression-sweep-red-manifest-watchdog.json";

/**
 * Read the most-recent stamp from tests/red-manifest.json.
 * Uses publishedAt (nightly full publish) if present; falls back to
 * lastPartialUpdateAt (canary partial-publish, Task #4501).
 * Mirrors readCommittedBaselineStatus but targets the red manifest.
 */
export function readCommittedRedManifestStatus(
  now: Date = new Date(),
  manifestPath = "tests/red-manifest.json",
): CommittedBaselineStatus {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      publishedAt?: unknown;
      lastPartialUpdateAt?: unknown;
    } | null;
    // Use the MOST RECENT of publishedAt (nightly full publish) and
    // lastPartialUpdateAt (post-merge canary partial update, Task #4501).
    // Using ?? would always prefer publishedAt and mask a newer canary update,
    // producing false "stale manifest" alerts when the canary ran more recently
    // than the last nightly sweep.
    const candidates = [
      parsed && typeof parsed.publishedAt === "string" ? parsed.publishedAt : null,
      parsed && typeof parsed.lastPartialUpdateAt === "string"
        ? parsed.lastPartialUpdateAt
        : null,
    ].filter((s): s is string => s !== null);
    const stamp =
      candidates.length === 0
        ? null
        : candidates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    if (!stamp) return { publishedAt: null, ageDays: null };
    const t = Date.parse(stamp);
    if (!Number.isFinite(t)) return { publishedAt: stamp, ageDays: null };
    return { publishedAt: stamp, ageDays: (now.getTime() - t) / (24 * 60 * 60 * 1000) };
  } catch {
    return { publishedAt: null, ageDays: null };
  }
}

export function readRedManifestWatchdogStamp(
  statePath = DEFAULT_WATCHDOG_RED_MANIFEST_STATE_PATH,
): string | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
      publishedAt?: unknown;
    } | null;
    return parsed && typeof parsed.publishedAt === "string" ? parsed.publishedAt : null;
  } catch {
    return null;
  }
}

export function writeRedManifestWatchdogStamp(
  publishedAt: string | null,
  statePath = DEFAULT_WATCHDOG_RED_MANIFEST_STATE_PATH,
): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ publishedAt }, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not persist red-manifest watchdog state: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task #4437 — durable last-tick state + tick log.
// ---------------------------------------------------------------------------

export interface LastTickState {
  /** "cron" | "catchup" | "manual" */
  trigger: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  hardFailed: number | null;
  /** True when the runner produced no report AND the exit suggests an OS-level
   *  crash rather than a genuine test failure (thread exhaustion, OOM). */
  isInfraCrash: boolean;
  crashSignature: string | null;
  /** Consecutive infra-crash count (resets to 0 on any non-crash tick). */
  crashStreak: number;
  /** ISO date (UTC YYYY-MM-DD) of the last successful catch-up run, used for
   *  the once-per-day cap. */
  lastCatchupDate: string | null;
}

export function readLastTickState(statePath = LAST_TICK_STATE_PATH): LastTickState | null {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as LastTickState | null;
    if (!raw || typeof raw.trigger !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeLastTickState(state: LastTickState, statePath = LAST_TICK_STATE_PATH): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not write last-tick state: ${(err as Error)?.message ?? err}`,
    );
  }
}

/** Append one JSONL record to the tick log, trimming to TICK_LOG_MAX_ENTRIES. */
function appendTickLog(record: LastTickState): void {
  try {
    mkdirSync(dirname(TICK_LOG_PATH), { recursive: true });
    // Read + trim before appending so the log never grows unboundedly.
    let existing: LastTickState[] = [];
    try {
      existing = readFileSync(TICK_LOG_PATH, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LastTickState);
    } catch {
      // First run or corrupt file — start fresh.
    }
    const entries = [...existing, record].slice(-TICK_LOG_MAX_ENTRIES);
    writeFileSync(TICK_LOG_PATH, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  } catch (err) {
    // Best-effort: a tick-log failure must never abort a sweep.
    console.warn(`[RegressionSweep] could not write tick log: ${(err as Error)?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Task #4437 — infrastructure-crash classifier (pure, unit-testable).
//
// Distinguishes an OS-level crash (no report, non-zero exit, thread-exhaustion
// or OOM signature in stderr) from a genuine red test run. The Aug-10 esbuild
// crash under merge load produced errno=11 / pthread signatures; adding ENOMEM
// as a belt-and-suspenders check for future OOM scenarios.
// ---------------------------------------------------------------------------

export function classifyInfrastructureCrash(
  report: SweepReport | null,
  exitCode: number | null,
  stderrTail: string,
): { isInfraCrash: boolean; signature: string | null } {
  // A report was written → the runner finished normally (pass or fail).
  if (report !== null) return { isInfraCrash: false, signature: null };
  // Exit 0 with no report is impossible in normal flow; treat as non-crash.
  if (!exitCode || exitCode === 0) return { isInfraCrash: false, signature: null };
  if (
    stderrTail.includes("errno=11") ||
    stderrTail.includes("pthread_create") ||
    stderrTail.includes("runtime: failed to create new OS thread")
  ) {
    return { isInfraCrash: true, signature: "thread-exhaustion" };
  }
  if (stderrTail.includes("ENOMEM") || stderrTail.includes("Cannot allocate memory")) {
    return { isInfraCrash: true, signature: "oom" };
  }
  return { isInfraCrash: false, signature: null };
}

// ---------------------------------------------------------------------------
// Task #4437 — catch-up arm eligibility (pure, unit-testable).
// ---------------------------------------------------------------------------

export function isCatchupEnabled(): boolean {
  const raw = (process.env.REGRESSION_SWEEP_CATCHUP_ENABLED ?? "").trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/** Returns true when the 1-min loadavg or a git lock signals active heavy load. */
export function isLoadTooHighForCatchup(
  load1m = loadavg()[0],
  repoRoot = ".",
): boolean {
  if (load1m >= CATCHUP_LOAD_DEFER_THRESHOLD) return true;
  if (existsSync(join(repoRoot, ".git", "index.lock"))) return true;
  if (existsSync(join(repoRoot, ".git", "rebase-merge"))) return true;
  return false;
}

/**
 * Pure eligibility check for the catch-up arm. All side-effectful reads
 * (baseline status, last-tick state, loadavg, git lock) are injected so
 * the function is unit-testable without filesystem access.
 *
 * Task #4530 additions:
 *   publisherEnabled — must be true for the catch-up arm to fire (prevents
 *     task-branch clones from publishing baselines on diverged trees).
 *   lastAttemptStartedAt — ISO timestamp of the most recent attempt start
 *     that has no corresponding completion record; if within the min-gap
 *     window, defer to avoid thrash during merge storms.
 */
export function shouldRunCatchup(params: {
  now: Date;
  baselineAgeDays: number | null;
  lastTickState: LastTickState | null;
  catchupEnabled: boolean;
  workspaceSchedulingEnabled: boolean;
  loadTooHigh: boolean;
  /** Task #4530 S1 — must be true for the catch-up arm to fire. */
  publisherEnabled: boolean;
  /** Task #4530 S3 — ISO timestamp from the attempt-start state file (null if none). */
  lastAttemptStartedAt: string | null;
}): { eligible: boolean; reason: string } {
  const {
    now,
    baselineAgeDays,
    lastTickState,
    catchupEnabled,
    workspaceSchedulingEnabled,
    loadTooHigh,
    publisherEnabled,
    lastAttemptStartedAt,
  } = params;

  if (!workspaceSchedulingEnabled) {
    return { eligible: false, reason: "scheduler disabled" };
  }
  // Task #4530 S1 — publisher gate: catch-up arm must only fire on the main
  // workspace where REGRESSION_SWEEP_PUBLISHER_ENABLED=1 is explicitly set.
  if (!publisherEnabled) {
    return {
      eligible: false,
      reason:
        "publisher not enabled on this workspace — set REGRESSION_SWEEP_PUBLISHER_ENABLED=1 on the main workspace to allow catch-up baseline publishes",
    };
  }
  if (!catchupEnabled) {
    return { eligible: false, reason: "catch-up disabled by REGRESSION_SWEEP_CATCHUP_ENABLED" };
  }
  if (baselineAgeDays === null) {
    // No committed baseline yet; nothing to catch up on.
    return { eligible: false, reason: "no committed baseline to assess" };
  }
  if (baselineAgeDays < CATCHUP_BASELINE_AGE_THRESHOLD_DAYS) {
    return {
      eligible: false,
      reason: `baseline fresh (${baselineAgeDays.toFixed(1)}d < ${CATCHUP_BASELINE_AGE_THRESHOLD_DAYS}d threshold)`,
    };
  }
  // Check once-per-day cap.
  const todayUtc = now.toISOString().slice(0, 10);
  if (lastTickState?.lastCatchupDate === todayUtc) {
    return { eligible: false, reason: `catch-up already ran today (${todayUtc})` };
  }
  // Task #4530 S3 — min-gap between attempt STARTS (not completions). A
  // mid-run sweep that was killed before writing the tick record still blocks
  // a re-attempt within this window, preventing merge-storm thrash.
  if (lastAttemptStartedAt) {
    const hoursSinceAttemptStart =
      (now.getTime() - Date.parse(lastAttemptStartedAt)) / (60 * 60 * 1000);
    if (hoursSinceAttemptStart < CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS) {
      return {
        eligible: false,
        reason: `attempt started ${hoursSinceAttemptStart.toFixed(1)}h ago (min-gap ${CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS}h)`,
      };
    }
  }
  // Check recent completed tick (infra crashes get a shorter cooldown).
  if (lastTickState) {
    const hoursSinceLastTick =
      (now.getTime() - Date.parse(lastTickState.finishedAt)) / (60 * 60 * 1000);
    const cooldownHours = lastTickState.isInfraCrash
      ? 2 // crash cooldown — retry sooner
      : CATCHUP_MIN_HOURS_SINCE_LAST_TICK;
    if (hoursSinceLastTick < cooldownHours) {
      return {
        eligible: false,
        reason: `recent ${lastTickState.isInfraCrash ? "infra-crash" : "completed"} tick ${hoursSinceLastTick.toFixed(1)}h ago (cooldown ${cooldownHours}h)`,
      };
    }
  }
  if (loadTooHigh) {
    return { eligible: false, reason: "load too high or git lock active — deferring" };
  }
  return {
    eligible: true,
    reason: `baseline stale ${baselineAgeDays.toFixed(1)}d, no recent tick`,
  };
}

export function poisonAlertDeliveryAcceptable(
  result: { delivered: boolean; status: string } | null | undefined,
): boolean {
  if (!result) return false;
  return result.delivered === true || result.status === "skipped_deduped";
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let lastRunAt: number | null = null;
let lastExitCode: number | null = null;
let lastReport: SweepReport | null = null;
/** True while a sweep child process is running; prevents concurrent sweeps. */
let sweepInFlight = false;
/** Handle for the 6-hour catch-up + watchdog interval. */
let catchupIntervalId: ReturnType<typeof setInterval> | null = null;

// Reset seam — allows test suites sharing a process to reset scheduler state.
registerModuleStateResetForTest("regressionSweepScheduler", () => {
  if (scheduledTask) {
    void scheduledTask.stop();
    scheduledTask = null;
  }
  if (catchupIntervalId !== null) {
    clearInterval(catchupIntervalId);
    catchupIntervalId = null;
  }
  lastRunAt = null;
  lastExitCode = null;
  lastReport = null;
  sweepInFlight = false;
  cachedIsSubEnvironment = null;
});

function isEnabledByEnv(): boolean {
  // Default ON. Explicit "false" / "0" / "off" / "no" opts out.
  const raw = (process.env.REGRESSION_SWEEP_SCHEDULER_ENABLED ?? "")
    .trim()
    .toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/**
 * The sweep may only be scheduled in the dev workspace with the env opt-in
 * left on. Exported so a test can assert the gating without arming a real
 * cron.
 */
export function shouldScheduleRegressionSweep(): boolean {
  if (isRunningInDeployment()) return false;
  return isEnabledByEnv();
}

/**
 * Decide whether a finished sweep should raise an alert and what to say. Pure
 * over its inputs so it is unit-testable. A null report (the runner crashed
 * before writing JSON) is itself an alertable failure.
 */
export function buildSweepNotification(
  report: SweepReport | null,
  exitCode: number | null,
  baselineStatus?: CommittedBaselineStatus | null,
  alertedPoisonFiles?: readonly string[] | null,
  alertedBaselineStalenessStamp?: string | null,
  // Task #4491 — once-per-streak gate-lint-red alerting (see the state helpers).
  alertedLintReds?: readonly string[] | null,
): {
  shouldNotify: boolean;
  text: string;
  poisonFiles: string[];
  poisonAlertFired: boolean;
  stalenessAlertFired: boolean;
  /** Task #4491 — lint names red on main per this report (empty when the
   * lint phase did not run or the report is null). */
  lintReds: string[];
  lintRedAlertFired: boolean;
} {
  // Task #4077 — a frozen committed baseline silently re-inflates every task
  // validation into a full sweep, so staleness is alertable EVEN WHEN the
  // sweep itself is green. runOnce measures the baseline AFTER the run (i.e.
  // post-publish): a healthy night reads ~0d, so this only fires when the
  // publish arm is genuinely broken. Unknown age (no baseline / no stamp) is
  // not an incident — never alert on nulls.
  const staleness =
    baselineStatus && baselineStatus.ageDays !== null && baselineStatus.ageDays > BASELINE_STALENESS_ALERT_DAYS
      ? `⚠️ Committed green baseline (tests/green-baseline.json) has not refreshed in ` +
        `${baselineStatus.ageDays.toFixed(1)} days (published ${baselineStatus.publishedAt ?? "unknown"}; ` +
        `threshold ${BASELINE_STALENESS_ALERT_DAYS}d). Task validation is re-executing every suite — ` +
        `check the nightly baseline publish (TEST_GREEN_BASELINE_PUBLISH arm) and recent sweep logs.`
      : null;
  // Task #4116 — once per streak, not once per day: a stale baseline keeps
  // its (frozen) publishedAt stamp all streak long, so "already alerted for
  // this stamp" == "still the same staleness episode". Callers that omit the
  // alerted stamp (or the state file is absent/corrupt → null) fall open to
  // alerting. A stale baseline with an unparseable stamp cannot occur here:
  // ageDays is only non-null when publishedAt parsed.
  const stalenessAlertFired =
    staleness !== null && baselineStatus!.publishedAt !== (alertedBaselineStalenessStamp ?? null);
  if (!report) {
    return {
      shouldNotify: true,
      text:
        "Nightly regression sweep could not produce a report " +
        `(runner exit=${exitCode ?? "unknown"}). The sweep itself is broken — ` +
        "check the workspace logs." +
        (staleness ? `\n\n${staleness}` : ""),
      poisonFiles: [],
      poisonAlertFired: false,
      stalenessAlertFired,
      lintReds: [],
      lintRedAlertFired: false,
    };
  }
  const text = summarizeSweepResult(report, "Nightly regression sweep");
  // Task #4104 — a repeat-poisoned test file (same `<build error: …>` across
  // 3+ consecutive skip audits, Task #4101) is alertable EVEN WHEN the sweep
  // is green: the broken file never executes (it can't parse), so it can't
  // fail the sweep — without this, the warning only lives in the sweep log.
  // summarizeSweepResult already renders the file + build-error lines.
  //
  // Task #4112 — once per streak, not once per day: only a file NOT yet in
  // the alerted set (readAlertedPoisonFiles) triggers the poison alert. An
  // unchanged poisoned set stays quiet on subsequent nights; a NEW file
  // joining the set alerts again. Callers that omit the alerted set (or the
  // state file is absent/corrupt) fall open to alerting.
  const poisonFiles = (report.repeatPoisonWarnings ?? []).map((w) => w.file).sort();
  const alerted = new Set(alertedPoisonFiles ?? []);
  const poisonAlertFired = poisonFiles.some((f) => !alerted.has(f));
  // Task #4491 — gate lint reds on main are alertable EVEN WHEN the sweep is
  // green (report-only lint phase never fails the sweep): without a push,
  // every task environment inherits the red and re-proves innocence while
  // main's ONE fix never happens. Once per streak, mirroring the poison
  // alert: only a NEW lint name going red fires; the line still rides along
  // as context whenever something else notifies.
  const lintReds = Array.isArray(report.lintReds) ? [...report.lintReds].sort() : [];
  const lintAlerted = new Set(alertedLintReds ?? []);
  const lintRedAlertFired = lintReds.some((n) => !lintAlerted.has(n));
  const lintLine =
    lintReds.length > 0
      ? `⚠ ${lintReds.length} gate lint(s) RED on main (nightly report-only lint phase; recorded in tests/red-manifest.json "lints"): ${lintReds.join(", ")} — each needs ONE fix on main; task gates excuse fully-inherited copies with evidence.`
      : null;
  // Task #5030 — culprit naming: when the publish step found NEW reds and
  // resolved the merge window since the previous manifest, the window rides
  // into the notification so breakage triage starts at the culprit merge(s).
  const win = report.newRedMergeWindow ?? null;
  const mergeWindowLine = win
    ? `🎯 ${win.newReds.length} NEW red(s) attributed to merge window ${win.fromCommit.slice(0, 10)}..${win.toCommit.slice(0, 10)} ` +
      `(${win.commits.length} commit(s)${win.truncated ? ", truncated" : ""}): ` +
      win.commits
        .slice(0, 5)
        .map((c) => `${c.commit.slice(0, 10)}${c.task ? ` ${c.task}` : ""}`)
        .join(", ") +
      (win.commits.length > 5 ? ", …" : "") +
      ` — new red(s): ${win.newReds.join(", ")}`
    : null;
  let finalText = text;
  if (staleness) finalText += `\n\n${staleness}`;
  if (lintLine) finalText += `\n\n${lintLine}`;
  if (mergeWindowLine) finalText += `\n\n${mergeWindowLine}`;
  return {
    // Task #4116 — an already-alerted (still-stale) baseline no longer forces
    // a nightly notification; a real sweep failure or a fresh staleness
    // episode still does. When something ELSE notifies, the staleness line
    // still rides along as context.
    shouldNotify:
      reportIndicatesFailure(report) || stalenessAlertFired || poisonAlertFired || lintRedAlertFired,
    text: finalText,
    poisonFiles,
    poisonAlertFired,
    stalenessAlertFired,
    lintReds,
    lintRedAlertFired,
  };
}

/** A stable per-day dedupe key so one night's failure posts at most once. */
function dedupeKeyForToday(): string {
  return `regression-sweep:${new Date().toISOString().slice(0, 10)}`;
}

/** Task #4437 — infra-crash alert dedupe key (separate from sweep failure). */
function crashDedupeKey(): string {
  return `regression-sweep-crash:${new Date().toISOString().slice(0, 10)}`;
}

async function runOnce(trigger: string): Promise<void> {
  const started = Date.now();
  lastRunAt = started;

  // Task #4530 S3 — write attempt-start state BEFORE spawning the child so
  // the watchdog can detect an orphaned sweep even if the process is killed
  // before the tick-log completion record is written.
  writeAttemptStartState({ startedAt: new Date(started).toISOString(), trigger });

  const reportDir = mkdtempSync(join(tmpdir(), "regression-sweep-"));
  const reportPath = join(reportDir, "report.json");

  // Task #3791 — incremental cadence: weeknight sweeps let the runner skip
  // suites whose input fingerprint matches their last green run; one night a
  // week (Sunday 03:30 ET) forces `--force-all` so environment/DB drift that
  // fingerprints cannot see is still caught within a week.
  const fullIntegrity = isFullIntegritySweepDate(new Date());
  console.log(
    `[RegressionSweep] tick starting trigger=${trigger} (${
      fullIntegrity
        ? "weekly FULL integrity run — every suite executes"
        : "incremental — suites green on identical inputs skip"
    })`,
  );

  // Task #4437 — capture stderr tail for infra-crash classification without
  // losing the forwarded output.
  const STDERR_CAPTURE_MAX = 8192;
  let stderrTail = "";

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(
      "npx",
      ["--yes", "tsx", ...buildSweepRunArgs(reportPath, fullIntegrity)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // TEST_GREEN_BASELINE_PUBLISH: this scheduler is the SINGLE arm of
        // baseline publishing. It only runs in the main dev workspace
        // (never in deployment). On EVERY nightly run — red or green (Task
        // #4077) — the runner snapshots its green records into the committed
        // tests/green-baseline.json for task environments to inherit;
        // failures are filtered out and land in the red manifest instead.
        // Task #3922: the same flag also publishes the RED sibling — the
        // committed tests/red-manifest.json of suites currently failing at
        // main (on every run, red or green) — which task environments use to
        // attribute inherited gate failures instead of re-proving innocence.
        // Task #4530 S1: the publish flag is only injected when
        // REGRESSION_SWEEP_PUBLISHER_ENABLED=1 is explicitly set on this
        // workspace. Task-branch clones must never publish diverged baselines.
        env: buildSweepSpawnEnv(),
      },
    );
    child.stdout?.on("data", (buf) => {
      process.stdout.write(`[RegressionSweep] ${buf}`);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      process.stderr.write(`[RegressionSweep] ${buf}`);
      // Accumulate tail for crash classification.
      stderrTail += buf.toString("utf8");
      if (stderrTail.length > STDERR_CAPTURE_MAX) {
        stderrTail = stderrTail.slice(-STDERR_CAPTURE_MAX);
      }
    });
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", (err) => {
      console.warn(
        `[RegressionSweep] failed to spawn run-all: ${err?.message ?? err}`,
      );
      resolve(-1);
    });
  });

  lastExitCode = exitCode;
  let report: SweepReport | null = null;
  try {
    report = parseSweepReport(readFileSync(reportPath, "utf8"));
  } catch {
    report = null;
  }
  lastReport = report;
  try {
    rmSync(reportDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the temp report dir */
  }

  const durSec = Math.round((Date.now() - started) / 1000);
  // Task #4077: assess baseline freshness AFTER the run so a successful
  // publish this very night reads as fresh (~0d) and never false-alarms.
  const baselineStatus = readCommittedBaselineStatus();
  const { shouldNotify, text, poisonFiles, poisonAlertFired, stalenessAlertFired, lintReds, lintRedAlertFired } =
    buildSweepNotification(
      report,
      exitCode,
      baselineStatus,
      // Task #4112 — a null report means the poison set was unobservable this
      // run; the alerted-state is left untouched below (a blind run must not
      // prune real state).
      report ? readAlertedPoisonFiles() : null,
      // Task #4116 — baseline freshness is observable even on a crashed run
      // (it is a plain file read), so the staleness alert state always feeds
      // the decision.
      readAlertedBaselineStalenessStamp(),
      // Task #4491 — same blind-run rule as the poison set: only feed (and
      // later reconcile) the lint-red alert state when a report exists.
      report ? readAlertedLintReds() : null,
    );
  console.log(
    `[RegressionSweep] tick finished trigger=${trigger} exit=${exitCode} duration=${durSec}s ` +
      `hardFailed=${report?.hardFailed ?? "n/a"} ` +
      `quarantined=${report?.quarantinedFailed ?? "n/a"} ` +
      `flaky=${report?.flaky ?? "n/a"} ` +
      `skippedGreen=${report?.skippedGreen ?? "n/a"}`,
  );

  // Task #4437 — infra-crash detection + crash-streak alerting.
  const { isInfraCrash, signature: crashSignature } = classifyInfrastructureCrash(
    report,
    exitCode,
    stderrTail,
  );
  const prevState = readLastTickState();
  const prevCrashStreak = prevState?.isInfraCrash ? (prevState.crashStreak ?? 0) : 0;
  const crashStreak = isInfraCrash ? prevCrashStreak + 1 : 0;

  if (isInfraCrash) {
    console.warn(
      `[RegressionSweep] infra-crash detected (signature=${crashSignature}) ` +
        `crash streak=${crashStreak}`,
    );
    if (crashStreak >= CRASH_STREAK_ALERT_THRESHOLD) {
      try {
        await notifyByType(
          NOTIFICATION_ID,
          {
            text:
              `⚠️ Nightly regression sweep has crashed ${crashStreak} consecutive time(s) ` +
              `(signature: ${crashSignature ?? "unknown"}, exit=${exitCode ?? "unknown"}). ` +
              `The workspace may be under heavy load — check merge-queue activity and loadavg. ` +
              `Last crash at ${new Date().toISOString()}.`,
            preview: { exitCode, crashSignature, crashStreak },
          },
          {
            triggerSource: "scheduled",
            failureType: "regression_sweep",
            dedupeKey: crashDedupeKey(),
            metadata: { exitCode, crashSignature, crashStreak },
          },
        );
      } catch (err) {
        console.warn(
          `[RegressionSweep] could not dispatch crash-streak alert: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }
  }

  // Task #4437 — write durable tick telemetry.
  const todayUtc = new Date().toISOString().slice(0, 10);
  // Task #4437 — once-per-day catch-up cap semantics:
  // The cap is only consumed when a catch-up COMPLETES (no infra crash). An
  // infra crash leaves lastCatchupDate unchanged so the 2h crash cooldown in
  // shouldRunCatchup governs the retry window — if we stamped lastCatchupDate
  // on a crash, the per-day cap would block the 2h retry path entirely.
  const lastCatchupDate =
    trigger === "catchup" && !isInfraCrash
      ? todayUtc
      : (prevState?.lastCatchupDate ?? null);
  const tickRecord: LastTickState = {
    trigger,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode,
    hardFailed: report?.hardFailed ?? null,
    isInfraCrash,
    crashSignature,
    crashStreak,
    lastCatchupDate,
  };
  writeLastTickState(tickRecord);
  appendTickLog(tickRecord);

  // The run-level alert dispatches FIRST — before feedback filing — so a
  // slow or hung Slack relay inside the feedback step can never delay or
  // suppress it (tests/regression-sweep-feedback.test.ts pins this order).
  let notifyResult: Awaited<ReturnType<typeof notifyByType>> | null = null;
  if (shouldNotify) {
    try {
      notifyResult = await notifyByType(
        NOTIFICATION_ID,
        { text, preview: report ?? { exitCode } },
        {
          triggerSource: "scheduled",
          failureType: "regression_sweep",
          dedupeKey: dedupeKeyForToday(),
          metadata: {
            exitCode,
            hardFailed: report?.hardFailed ?? null,
            hardFailedNames: report?.hardFailedNames ?? null,
          },
        },
      );
    } catch (err) {
      console.warn(
        `[RegressionSweep] could not dispatch failure alert: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  // Task #4112 — reconcile the poison-alert state. On any completed report
  // (poison set observable) the current poisoned set becomes the alerted set:
  // healed files get pruned (so a re-poisoning alerts again) and freshly
  // alerted files go quiet on subsequent nights. When the poison alert
  // needed to fire but the dispatch did not verifiably reach the team
  // (notifyByType resolves for skips/failures too — see
  // poisonAlertDeliveryAcceptable), keep the old state so tomorrow's run
  // retries the alert instead of silently swallowing it.
  if (report && (!poisonAlertFired || poisonAlertDeliveryAcceptable(notifyResult))) {
    writeAlertedPoisonFiles(poisonFiles);
  }

  // Task #4491 — reconcile the lint-red alert state (mirror of the poison
  // state above). Only when the lint phase actually MEASURED this run
  // (report.lintReds is an array): a null/absent value means budget overrun
  // or a pre-#4491 runner — a blind run must not prune real state. Measured
  // green (empty array) clears the state so a future re-break alerts again;
  // an undelivered alert keeps the old state so tomorrow retries.
  if (
    report &&
    Array.isArray(report.lintReds) &&
    (!lintRedAlertFired || poisonAlertDeliveryAcceptable(notifyResult))
  ) {
    writeAlertedLintReds(lintReds);
  }

  // Task #4116 — reconcile the baseline-staleness alert state. Fresh (or
  // unknown-age) baseline → clear the state so a future staleness episode
  // alerts again. Stale baseline → remember its publishedAt stamp as
  // alerted, but ONLY when the alert either did not need to fire this run
  // or verifiably reached the team (same delivery gate as the poison
  // state); otherwise keep the old state so tomorrow retries the alert.
  const baselineIsStale =
    baselineStatus.ageDays !== null && baselineStatus.ageDays > BASELINE_STALENESS_ALERT_DAYS;
  if (!stalenessAlertFired || poisonAlertDeliveryAcceptable(notifyResult)) {
    writeAlertedBaselineStalenessStamp(baselineIsStale ? baselineStatus.publishedAt : null);
  }

  // Task #3845 — per-test trackable feedback items: file each NEW hard
  // failure into /admin/feedback (+ Slack via the shared relay) and resolve
  // items whose test recovered. Runs on EVERY completed report — green
  // nights are exactly when recovery resolution happens. The run-level alert
  // above stays as the one-line summary; the feedback rows are the durable
  // per-test tracking (deliberately no per-admin notifyUser fan-out here —
  // that would double the inbox noise).
  if (report) {
    try {
      const fb = await fileAndResolveSweepFeedback(report);
      if (fb.filed > 0 || fb.resolved > 0) {
        console.log(
          `[RegressionSweep] feedback items: filed=${fb.filed} resolved=${fb.resolved}`,
        );
      }
    } catch (err) {
      console.warn(
        `[RegressionSweep] feedback filing failed: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  // Task #5028 — auto-quarantine feedback filing/resolution and cap-breach alert.
  if (report && (report.quarantineEntered?.length || report.quarantineReinstated?.length)) {
    try {
      // Build fix-task feedback text for newly-quarantined suites by reading
      // the freshly-committed ledger. Inline read: server/ must not import
      // from tests/, so we read tests/flake-quarantine.json directly.
      let ledgerEntries: Array<{ file: string; reason?: string; evidence?: { failures?: number; window?: number } }> = [];
      try {
        const ledgerRaw = readFileSync("tests/flake-quarantine.json", "utf8");
        const parsed = JSON.parse(ledgerRaw) as { entries?: unknown[] } | null;
        if (parsed && Array.isArray(parsed.entries)) {
          ledgerEntries = parsed.entries as typeof ledgerEntries;
        }
      } catch { /* non-fatal; feedback text falls back to the file path */ }

      const qEntered: Array<{ file: string; feedbackText: string }> = [];
      for (const file of report.quarantineEntered ?? []) {
        const entry = ledgerEntries.find((e) => e.file === file);
        const evidenceSummary = entry?.evidence
          ? `${entry.evidence.failures ?? "?"} of the last ${entry.evidence.window ?? "10"} recorded runs failed`
          : "met the flake threshold";
        const text =
          `**Auto-quarantined flaky test suite** — ${entry?.reason ?? "exceeded the flake threshold"}\n\n` +
          `**File:** \`${file}\`\n` +
          `**Evidence:** ${evidenceSummary}\n\n` +
          `This suite has been automatically removed from the blocking gate. It continues to execute non-blocking in nightly sweep lanes so evidence accrues. ` +
          `It will auto-reinstate once it records ≥10 consecutive greens with ≥3 from nightly sweep lanes. ` +
          `Fix the underlying flakiness and the quarantine will lift automatically.`;
        qEntered.push({ file, feedbackText: text });
      }

      const qfb = await fileAndResolveQuarantineFeedback({
        entered: qEntered,
        reinstatedFiles: report.quarantineReinstated ?? [],
      });
      if (qfb.filed > 0 || qfb.resolved > 0) {
        console.log(
          `[RegressionSweep] quarantine feedback: filed=${qfb.filed} resolved=${qfb.resolved}`,
        );
      }
    } catch (qFbErr) {
      console.warn(
        `[RegressionSweep] quarantine feedback filing failed (non-fatal): ${
          (qFbErr as Error)?.message ?? qFbErr
        }`,
      );
    }
  }
  // Task #5028: cap-breach alert — fires when flaky suite(s) were denied
  // entry because the 10-suite cap was full. Day-deduped so re-alerts don't
  // flood on consecutive nightly runs (constant-key would collapse to one
  // forever-unread bell — see slack-channel-not-found-alert.md).
  if (report?.quarantineCapDenied?.length) {
    try {
      const capNote =
        `⚠ **Flake quarantine cap exceeded** — ${report.quarantineCapDenied.length} flaky suite(s) were denied entry (cap = 10 concurrent quarantined suites). ` +
        `They continue to **block gates** until the cap has room.\n\n` +
        `Denied suites:\n${report.quarantineCapDenied.map((f) => `  - ${f}`).join("\n")}\n\n` +
        `Action required: fix or manually remove quarantined suites to make room.`;
      await notifyByType(
        "infra.flake_quarantine.cap_exceeded",
        { text: capNote },
        // Day-scoped dedupe key so each calendar day fires at most once.
        { dedupeKey: `flake-quarantine-cap:${new Date().toISOString().slice(0, 10)}` },
      );
    } catch (capErr) {
      console.warn(
        `[RegressionSweep] quarantine cap-breach alert failed (non-fatal): ${
          (capErr as Error)?.message ?? capErr
        }`,
      );
    }
  }

  // Task #4530 S3 — clear the attempt-start state now that runOnce has
  // completed (success or failure). The watchdog will no longer see an orphan
  // for this attempt. This is best-effort: a crash before reaching this line
  // correctly leaves the state for the watchdog to find.
  clearAttemptStartState();
}

/**
 * Task #4437 — Callable sweep entrypoint. Single-flight: concurrent callers
 * (cron, catch-up, manual) never run two sweeps in parallel.
 * Exported to unblock Task #2625 (admin on-demand trigger) without opening a
 * second publish arm — the flag literal stays in runOnce, the allow-list
 * files are unchanged.
 */
export async function runRegressionSweepNow(
  trigger: "cron" | "catchup" | "manual",
): Promise<void> {
  if (sweepInFlight) {
    console.log(
      `[RegressionSweep] sweep already in flight, skipping ${trigger} trigger`,
    );
    return;
  }
  sweepInFlight = true;
  try {
    await runOnce(trigger);
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Task #4437 / Task #4530 — out-of-band staleness watchdog, independent of
 * the nightly tick. Fires at boot + every 6h.  Alerts when the committed
 * baseline is stale using its own daily-keyed stamp state (separate from the
 * tick's state so it fires even when the tick never ran).
 *
 * Task #4530 S2 — daily re-alert: within the same staleness episode the
 * watchdog re-alerts once per calendar day (not once per episode) so a
 * multi-day freeze stays visible without the team having to check manually.
 *
 * Task #4530 S3 — orphan detection: if the attempt-start state file records
 * a sweep that started >ATTEMPT_ORPHAN_THRESHOLD_HOURS ago but was never
 * cleared (no completion), the alert mentions the orphaned attempt and its
 * trigger so operators know which leg died.
 *
 * Injectable deps allow unit tests to drive the function without touching real
 * filesystem paths or the real Slack dispatcher.
 */
export async function runStalenessWatchdogOnce(opts?: {
  now?: Date;
  baselinePath?: string;
  watchdogStatePath?: string;
  attemptStartPath?: string;
  notifyFn?: typeof notifyByType;
}): Promise<void> {
  const now = opts?.now ?? new Date();
  const notifyFn = opts?.notifyFn ?? notifyByType;
  const baselineStatus = readCommittedBaselineStatus(now, opts?.baselinePath);
  const { ageDays, publishedAt } = baselineStatus;
  if (ageDays === null) return; // No baseline yet — not an incident.
  if (ageDays <= BASELINE_STALENESS_ALERT_DAYS) {
    // Baseline is fresh — clear the watchdog state so a future staleness
    // episode alerts again.
    writeWatchdogStalenessState(
      { publishedAt: null, alertedOn: null },
      opts?.watchdogStatePath,
    );
    return;
  }
  // Baseline is stale.
  // Task #4530 S2 — re-alert daily: alert if this is a NEW episode (publishedAt
  // changed) OR if we haven't alerted yet today (alertedOn ≠ today).
  const todayUtc = now.toISOString().slice(0, 10);
  const priorState = readWatchdogStalenessState(opts?.watchdogStatePath);
  const alreadyAlertedToday =
    priorState.publishedAt === publishedAt && priorState.alertedOn === todayUtc;
  if (alreadyAlertedToday) return;

  // Task #4530 S3 — orphan detection: check whether there is a sweep attempt
  // that started a long time ago but never completed.
  const attemptStart = readAttemptStartState(opts?.attemptStartPath);
  let orphanContext = "";
  if (attemptStart?.startedAt) {
    const hoursSinceAttempt =
      (now.getTime() - Date.parse(attemptStart.startedAt)) / (60 * 60 * 1000);
    if (hoursSinceAttempt >= ATTEMPT_ORPHAN_THRESHOLD_HOURS) {
      orphanContext =
        ` An attempt started ${hoursSinceAttempt.toFixed(1)}h ago ` +
        `(trigger=${attemptStart.trigger}, started ${attemptStart.startedAt}) ` +
        `has no completion record — the sweep child process may have been killed. ` +
        `Check workspace logs around that time.`;
    }
  }

  const text =
    `⚠️ [Watchdog] Committed green baseline (tests/green-baseline.json) has not refreshed in ` +
    `${ageDays.toFixed(1)} days (published ${publishedAt ?? "unknown"}; threshold ${BASELINE_STALENESS_ALERT_DAYS}d). ` +
    `Task validations are re-executing every suite. Check the nightly sweep publish arm ` +
    `(TEST_GREEN_BASELINE_PUBLISH) and recent sweep logs.` +
    (orphanContext ? `\n\n${orphanContext}` : "");
  console.warn(`[RegressionSweep] ${text}`);

  try {
    const result = await notifyFn(
      NOTIFICATION_ID,
      { text, preview: { ageDays, publishedAt } },
      {
        triggerSource: "scheduled",
        failureType: "regression_sweep",
        // Task #4530 S2 — per-day dedupe key so each calendar day produces one
        // Slack post even when the same staleness episode spans multiple days.
        dedupeKey: `regression-sweep-staleness:${todayUtc}`,
        metadata: { ageDays, publishedAt },
      },
    );
    // Persist alertedOn for any non-null dispatch result — including
    // skipped_slack_disconnected (in-app mirror fired) and skipped_deduped —
    // so the once-per-day cap holds even when Slack is offline.  Only a
    // genuine throw (caught below) leaves today unrecorded so the next tick
    // can retry after a transient infrastructure error.
    if (result != null) {
      writeWatchdogStalenessState(
        { publishedAt: publishedAt ?? null, alertedOn: todayUtc },
        opts?.watchdogStatePath,
      );
    }
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not dispatch watchdog staleness alert: ${
        (err as Error)?.message ?? err
      }`,
    );
  }
}
/**
 * Internal wrapper — runs the baseline staleness watchdog (injectable core
 * with daily re-alert, Task #4530) plus the red-manifest staleness arm
 * (Task #4501).
 */
async function runStalenessWatchdog(): Promise<void> {
  await runStalenessWatchdogOnce();
  await runRedManifestStalenessCheck();
  // Task #4545 — file the deduped "fix main" item when the post-merge canary
  // found a new breakage.
  await runCanaryBreakageCheck();
  // Task #5030 — file the deduped re-baseline/triage item when a run or gate
  // recorded a non-blocking wall-budget breach (green stays green; this arm
  // is the async remediation path).
  await runDurationBudgetBreachCheck();
}

/**
 * Task #4501 — red-manifest staleness check. Independent of the baseline
 * watchdog: a sweep that publishes the baseline but crashes before
 * writing/updating the red manifest still triggers this arm.
 * publishedAt=null (no nightly has ever run) → not an incident.
 * lastPartialUpdateAt from the post-merge canary extends freshness.
 */
async function runRedManifestStalenessCheck(): Promise<void> {
  const now = new Date();
  const redManifestStatus = readCommittedRedManifestStatus(now);
  const { ageDays: redAgeDays, publishedAt: redPublishedAt } = redManifestStatus;
  if (redAgeDays !== null && redAgeDays > RED_MANIFEST_STALENESS_ALERT_DAYS) {
    const alertedRedStamp = readRedManifestWatchdogStamp();
    if (alertedRedStamp !== redPublishedAt) {
      const redText =
        `⚠️ [Watchdog] Committed red manifest (tests/red-manifest.json) has not been updated in ` +
        `${redAgeDays.toFixed(1)} days (last stamp ${redPublishedAt ?? "unknown"}; threshold ${RED_MANIFEST_STALENESS_ALERT_DAYS}d). ` +
        `The post-merge canary or nightly sweep publish arm may be broken — ` +
        `check the sweep logs and scripts/post-merge-canary.ts.`;
      console.warn(`[RegressionSweep] ${redText}`);
      try {
        const redResult = await notifyByType(
          NOTIFICATION_ID,
          { text: redText, preview: { ageDays: redAgeDays, publishedAt: redPublishedAt } },
          {
            triggerSource: "scheduled",
            failureType: "regression_sweep",
            dedupeKey: `regression-sweep-red-manifest-staleness:${now.toISOString().slice(0, 10)}`,
            metadata: { ageDays: redAgeDays, publishedAt: redPublishedAt },
          },
        );
        if (poisonAlertDeliveryAcceptable(redResult)) {
          writeRedManifestWatchdogStamp(redPublishedAt ?? null);
        }
      } catch (err) {
        console.warn(
          `[RegressionSweep] could not dispatch red-manifest watchdog alert: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }
  } else if (redAgeDays !== null && redAgeDays <= RED_MANIFEST_STALENESS_ALERT_DAYS) {
    // Fresh — clear the stamp so a future staleness episode alerts again.
    writeRedManifestWatchdogStamp(null);
  }
}

// ---------------------------------------------------------------------------
// Task #4545 — "fix main" alert when the post-merge canary found a NEW
// breakage. The canary (scripts/post-merge-canary.ts) stamps culprit commits
// into the red manifest and writes a result record, but files no proactive
// operator signal itself (it runs inside the post-merge pipeline where DB
// access is not guaranteed). This arm drains the canary's append-only
// breakage-event ledger at each 6h watchdog tick and files exactly ONE
// system feedback item per culprit commit via fileAndResolveSweepFeedback.
//
// Why a ledger and not just the result file: the result file is OVERWRITTEN
// per merge, so a breaking merge followed by a clean one before the next
// tick would silently lose the incident. The canary appends every breakage
// to the ledger; the drain here files every not-yet-filed culprit (the
// latest result file is still folded in as an implicit event for
// pre-ledger records).
//
// Dedupe is two-layered:
//   1. Durable state file remembers the culprit commits already filed —
//      re-reading the same events on later ticks files nothing, even after
//      an operator resolves the item manually (at most ONE item per culprit).
//   2. DB-atomic open-row dedupe: the synthetic "test file" is
//      `post-merge-canary:<culprit>` under a dedicated submitter id, and the
//      insert is conflict-safe against the partial unique index
//      user_feedback_system_pending_dedupe_idx — concurrent workspaces
//      sharing the dev DB collapse to one open item even when they race.
// ---------------------------------------------------------------------------

/** Result record written by scripts/post-merge-canary.ts. */
export const CANARY_RESULT_PATH = ".local/runs/post-merge-canary.json";
/** Append-only breakage-event ledger written by scripts/post-merge-canary.ts. */
export const CANARY_EVENTS_PATH = ".local/runs/post-merge-canary-events.jsonl";
export const DEFAULT_CANARY_FEEDBACK_STATE_PATH =
  ".local/state/regression-sweep-canary-feedback-filed.json";
/** Reserved submitter id for canary-filed rows — distinct from the nightly
 * sweep's id so fileAndResolveSweepFeedback's open-row scan (and its
 * resolve-what-left-the-report behavior) never touches nightly items. */
export const CANARY_FEEDBACK_USER_ID = "system:post-merge-canary";
export const CANARY_FEEDBACK_USER_NAME = "Post-merge Canary";

interface CanaryResultRecord {
  culpritCommit: string | null;
  culpritTask: string | null;
  newReds: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

/** Shape one parsed JSON object into a CanaryResultRecord. Never throws. */
function parseCanaryRecord(parsed: unknown): CanaryResultRecord | null {
  if (!parsed || typeof parsed !== "object") return null;
  {
    const p = parsed as Record<string, unknown>;
    return {
      culpritCommit:
        typeof p.culpritCommit === "string" && p.culpritCommit ? p.culpritCommit : null,
      culpritTask: typeof p.culpritTask === "string" ? p.culpritTask : null,
      newReds: Array.isArray(p.newReds)
        ? p.newReds.filter((f): f is string => typeof f === "string")
        : [],
      startedAt: typeof p.startedAt === "string" ? p.startedAt : null,
      finishedAt: typeof p.finishedAt === "string" ? p.finishedAt : null,
    };
  }
}

/** Parse the canary result file. Never throws; absent/corrupt → null. */
export function readCanaryResultRecord(
  resultPath = CANARY_RESULT_PATH,
): CanaryResultRecord | null {
  try {
    return parseCanaryRecord(JSON.parse(readFileSync(resultPath, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Read every pending breakage event: the JSONL ledger plus the latest result
 * file (folded in as an implicit event so pre-ledger records still file).
 * Deduped by culprit commit (latest event wins); events without a usable
 * culprit or with no new reds are dropped. Never throws.
 */
export function readCanaryBreakageEvents(
  eventsPath = CANARY_EVENTS_PATH,
  resultPath = CANARY_RESULT_PATH,
): CanaryResultRecord[] {
  const byCulprit = new Map<string, CanaryResultRecord>();
  const consider = (rec: CanaryResultRecord | null): void => {
    if (!rec || rec.newReds.length === 0) return;
    const culprit = rec.culpritCommit;
    // Without a culprit commit there is no stable dedupe key; the
    // red-manifest culprit stamps (Task #4501) still carry the signal.
    if (!culprit || culprit === "unknown") return;
    byCulprit.set(culprit, rec);
  };
  try {
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        consider(parseCanaryRecord(JSON.parse(line)));
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* no ledger yet */
  }
  consider(readCanaryResultRecord(resultPath));
  return [...byCulprit.values()];
}

/** Read the set of culprit commits already filed. Never throws — missing or
 * corrupt state means "nothing filed yet" (worst case one duplicate attempt,
 * which the DB unique-index dedupe then collapses; never a missed alert).
 * Accepts the legacy single-culprit shape too. */
export function readCanaryFeedbackFiledCulprits(
  statePath = DEFAULT_CANARY_FEEDBACK_STATE_PATH,
): string[] {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
      filedCulprits?: unknown;
      culpritCommit?: unknown;
    } | null;
    if (parsed && Array.isArray(parsed.filedCulprits)) {
      return parsed.filedCulprits.filter((c): c is string => typeof c === "string");
    }
    if (parsed && typeof parsed.culpritCommit === "string") return [parsed.culpritCommit];
    return [];
  } catch {
    return [];
  }
}

/** How many filed culprits the state file retains (matches the ledger cap). */
const CANARY_FEEDBACK_STATE_MAX_CULPRITS = 200;

/** Persist the culprit commits already filed (trimmed to the newest). Never throws. */
export function writeCanaryFeedbackFiledCulprits(
  filedCulprits: string[],
  statePath = DEFAULT_CANARY_FEEDBACK_STATE_PATH,
): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const trimmed = filedCulprits.slice(-CANARY_FEEDBACK_STATE_MAX_CULPRITS);
    writeFileSync(statePath, `${JSON.stringify({ filedCulprits: trimmed }, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not persist canary-feedback state: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task #4630 — durable "recovery message pending" ledger.
//
// Task #4609's recovery relay is budget-raced and fire-and-forget: if Slack
// is down (or the send is still in flight when the budget expires) the
// message was simply lost — the feedback row is already resolved, so there
// is no pending slack_status for feedback_slack_retry to re-drive. This
// ledger closes that gap: a failed/timed-out recovery relay persists a
// marker here, and every later watchdog tick (boot + 6h) re-attempts it
// until delivered or the attempt cap is hit. Same never-throws file-state
// pattern as the filed-culprits state above.
// ---------------------------------------------------------------------------

export const DEFAULT_CANARY_RECOVERY_PENDING_STATE_PATH =
  ".local/state/regression-sweep-canary-recovery-pending.json";

/** Give-up cap: at one watchdog tick every 6h this is ~5 days of retries.
 * After that the marker is dropped with a warn — the resolved item + note in
 * /admin/feedback remain the durable record. */
export const CANARY_RECOVERY_RELAY_MAX_ATTEMPTS = 20;

/** Ledger cap — recovery incidents are rare; 50 is far beyond any realistic
 * backlog and bounds the file even if something pathological loops. */
const CANARY_RECOVERY_PENDING_MAX_ENTRIES = 50;

export interface PendingCanaryRecoveryRelay {
  /** Culprit commit — one marker per culprit (stable dedupe key). */
  culprit: string;
  /** The `post-merge-canary:<culprit>` page string the relay posts with. */
  page: string;
  /** Full recovery message text, frozen at resolve time so a retry posts
   * exactly what the original attempt would have. */
  feedbackText: string;
  /** Relay attempts so far (failed or still-in-flight-at-budget). */
  attempts: number;
  firstFailedAt: string;
}

/** Read the pending recovery-relay ledger. Never throws — missing/corrupt
 * state means "nothing pending" (worst case one lost recovery message,
 * which is exactly the pre-#4630 status quo, never a crash). */
export function readPendingCanaryRecoveryRelays(
  statePath = DEFAULT_CANARY_RECOVERY_PENDING_STATE_PATH,
): PendingCanaryRecoveryRelay[] {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
      pending?: unknown;
    } | null;
    if (!parsed || !Array.isArray(parsed.pending)) return [];
    return parsed.pending.filter(
      (e): e is PendingCanaryRecoveryRelay =>
        !!e &&
        typeof e === "object" &&
        typeof (e as any).culprit === "string" &&
        typeof (e as any).page === "string" &&
        typeof (e as any).feedbackText === "string",
    ).map((e) => ({
      culprit: e.culprit,
      page: e.page,
      feedbackText: e.feedbackText,
      attempts: Number.isFinite(Number((e as any).attempts))
        ? Number((e as any).attempts)
        : 0,
      firstFailedAt:
        typeof (e as any).firstFailedAt === "string"
          ? (e as any).firstFailedAt
          : new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

/** Persist the pending recovery-relay ledger (newest-trimmed). Never throws. */
export function writePendingCanaryRecoveryRelays(
  pending: PendingCanaryRecoveryRelay[],
  statePath = DEFAULT_CANARY_RECOVERY_PENDING_STATE_PATH,
): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const trimmed = pending.slice(-CANARY_RECOVERY_PENDING_MAX_ENTRIES);
    writeFileSync(statePath, `${JSON.stringify({ pending: trimmed }, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not persist pending recovery-relay state: ${(err as Error)?.message ?? err}`,
    );
  }
}

/** Remove one culprit's marker from the pending ledger. Never throws. */
function clearPendingCanaryRecoveryRelay(culprit: string, statePath?: string): void {
  const remaining = readPendingCanaryRecoveryRelays(statePath).filter(
    (e) => e.culprit !== culprit,
  );
  writePendingCanaryRecoveryRelays(remaining, statePath);
}

/**
 * One budget-raced recovery-relay attempt. Returns:
 *   - "delivered"     — Slack confirmed the post within the budget.
 *   - "not_delivered" — the relay settled with a non-delivered status or threw.
 *   - "in_flight"     — the budget expired first. A continuation stays
 *     attached: if the in-flight send LATER reports delivered, the culprit's
 *     pending marker is cleared so the next tick does not post a duplicate.
 *     (Timeout-after-success ambiguity: if the process dies between actual
 *     delivery and that clear, the next tick may post one duplicate — we
 *     deliberately prefer a rare duplicate over a lost recovery message.)
 */
async function attemptCanaryRecoveryRelay(
  relay: typeof relayFeedbackToSlack,
  entry: { culprit: string; page: string; feedbackText: string },
  pendingStatePath?: string,
  /** Invoked synchronously when the budget expires, BEFORE the late-delivery
   * continuation is attached — the caller persists the pending marker here so
   * a fast late delivery cannot clear a marker that was not yet written
   * (which would resurrect it and double-post). */
  onBudgetExpired?: () => void,
): Promise<"delivered" | "not_delivered" | "in_flight"> {
  const relayDone = relay({
    topic: "BUG_REPORT",
    userName: CANARY_FEEDBACK_USER_NAME,
    page: entry.page,
    feedbackText: entry.feedbackText,
    screenshotCount: 0,
    videoCount: 0,
    viewUrl: null,
  }).catch((err: any) => {
    console.warn(
      `[RegressionSweep] canary recovery Slack relay threw for ${entry.culprit}:`,
      err?.message ?? err,
    );
    return null;
  });
  let budgetTimer: NodeJS.Timeout | undefined;
  const budget = new Promise<"__budget__">((resolve) => {
    budgetTimer = setTimeout(() => resolve("__budget__"), FEEDBACK_SLACK_RELAY_BUDGET_MS);
  });
  const raced = await Promise.race([relayDone, budget]);
  if (budgetTimer) clearTimeout(budgetTimer);
  if (raced === "__budget__") {
    console.log(
      `[RegressionSweep] canary recovery Slack relay still in flight for ${entry.culprit} — continuing.`,
    );
    onBudgetExpired?.();
    // Late-delivery continuation: clear the marker if this send eventually
    // succeeds so the next tick does not double-post.
    void relayDone.then((late) => {
      if (late && late.status === "delivered") {
        clearPendingCanaryRecoveryRelay(entry.culprit, pendingStatePath);
      }
    });
    return "in_flight";
  }
  return raced && raced.status === "delivered" ? "delivered" : "not_delivered";
}

/**
 * Task #4630 — re-drive pending recovery relays on every watchdog tick.
 * Delivered ⇒ marker removed; still failing ⇒ attempts incremented; past the
 * attempt cap ⇒ dropped with a warn (undeliverable — the resolved item in
 * /admin/feedback stays the durable record). Never throws.
 */
async function drainPendingCanaryRecoveryRelays(
  relay: typeof relayFeedbackToSlack,
  pendingStatePath?: string,
): Promise<void> {
  const pending = readPendingCanaryRecoveryRelays(pendingStatePath);
  if (pending.length === 0) return;
  const keep: PendingCanaryRecoveryRelay[] = [];
  for (const entry of pending) {
    const outcome = await attemptCanaryRecoveryRelay(relay, entry, pendingStatePath);
    if (outcome === "delivered") {
      console.log(
        `[RegressionSweep] canary recovery Slack relay delivered on retry for ${entry.culprit} (attempt ${entry.attempts + 1}).`,
      );
      continue;
    }
    const attempts = entry.attempts + 1;
    if (attempts >= CANARY_RECOVERY_RELAY_MAX_ATTEMPTS) {
      console.warn(
        `[RegressionSweep] giving up on canary recovery Slack relay for ${entry.culprit} after ${attempts} attempts — marked undeliverable; the resolved item in /admin/feedback remains the durable record.`,
      );
      continue;
    }
    keep.push({ ...entry, attempts });
  }
  // Re-read before writing: an in-flight continuation may have cleared a
  // marker for an entry we are keeping — never resurrect a cleared one.
  const stillPending = new Set(
    readPendingCanaryRecoveryRelays(pendingStatePath).map((e) => e.culprit),
  );
  writePendingCanaryRecoveryRelays(
    keep.filter((e) => stillPending.has(e.culprit)),
    pendingStatePath,
  );
}

/**
 * Build the synthetic SweepReport that carries the "fix main" signal through
 * fileAndResolveSweepFeedback. Exactly ONE failed result per culprit commit
 * (never one per suite — that would be N items for one merge): each result's
 * `file` is the dedupe key `post-merge-canary:<culprit>` and its name/reason
 * name the culprit commit/task and list the broken suites. Pure — exported
 * for unit tests.
 */
export function buildCanaryBreakageReport(records: CanaryResultRecord[]): SweepReport {
  const now = new Date().toISOString();
  const results = records.map((record) => {
    const culprit = record.culpritCommit ?? "unknown";
    const taskSuffix = record.culpritTask ? `, Task #${record.culpritTask}` : "";
    return {
      name:
        `Fix main: post-merge canary found new breakage (culprit commit ${culprit}${taskSuffix}). ` +
        `Broken suite(s): ${record.newReds.join(", ")}`,
      file: `post-merge-canary:${culprit}`,
      outcome: "failed" as const,
      quarantined: false,
      attempts: 1,
      elapsedMs: 0,
      failureReason: `new red suite(s) on main: ${record.newReds.join(", ")}`,
    };
  });
  const stamps = records
    .map((r) => r.finishedAt)
    .filter((s): s is string => s !== null)
    .sort();
  return {
    startedAt: records[0]?.startedAt ?? stamps[0] ?? now,
    finishedAt: stamps[stamps.length - 1] ?? now,
    // The canary runs the related-smoke slice; "smoke" is the closest mode.
    mode: "smoke",
    total: results.length,
    passed: 0,
    hardFailed: results.length,
    quarantinedFailed: 0,
    flaky: 0,
    results,
    hardFailedNames: results.map((r) => r.file),
    quarantinedFailedNames: [],
    flakyNames: [],
  };
}

/**
 * Task #4545 — drain the canary breakage-event ledger and file one deduped
 * "fix main" item per not-yet-filed culprit commit. Called from the
 * staleness watchdog (boot + every 6h). Injectable deps for unit tests;
 * production callers omit them. Never throws.
 *
 * Filing runs with autoResolve:false — each drain's report carries only the
 * not-yet-filed incidents, so an OPEN item's absence proves nothing about
 * recovery; a later culprit B must never close culprit A's item. Canary
 * items are per-culprit incidents an operator (or a follow-up recovery arm)
 * resolves.
 */
export async function runCanaryBreakageCheck(opts?: {
  canaryEventsPath?: string;
  canaryResultPath?: string;
  statePath?: string;
  redManifestPath?: string;
  fileFn?: typeof fileAndResolveSweepFeedback;
  listOpenFn?: typeof listOpenSweepItemFiles;
  resolveFn?: typeof resolveOpenSweepItemsForFile;
  relayFn?: typeof relayFeedbackToSlack;
  recoveryPendingStatePath?: string;
}): Promise<void> {
  const events = readCanaryBreakageEvents(opts?.canaryEventsPath, opts?.canaryResultPath);
  if (events.length > 0) {
    const filed = readCanaryFeedbackFiledCulprits(opts?.statePath);
    const filedSet = new Set(filed);
    const unfiled = events.filter((e) => e.culpritCommit && !filedSet.has(e.culpritCommit));
    if (unfiled.length > 0) {
      const report = buildCanaryBreakageReport(unfiled);
      const fileFn = opts?.fileFn ?? fileAndResolveSweepFeedback;
      try {
        const summary = await fileFn(report, {
          submitterId: CANARY_FEEDBACK_USER_ID,
          submitterName: CANARY_FEEDBACK_USER_NAME,
          // Partial per-drain report: absence of an already-filed culprit is
          // not recovery — never auto-resolve older canary incidents.
          autoResolve: false,
        });
        // Stamp the state on success even when filed === 0 (another
        // workspace's open row — or the unique-index conflict — deduped us):
        // the signal exists in the DB either way.
        writeCanaryFeedbackFiledCulprits(
          [...filed, ...unfiled.map((e) => e.culpritCommit!)],
          opts?.statePath,
        );
        console.log(
          `[RegressionSweep] canary breakage check: culprit(s) ${unfiled
            .map((e) => e.culpritCommit)
            .join(", ")} — filed ${summary.filed}, resolved ${summary.resolved}`,
        );
      } catch (err) {
        // Leave the state unstamped so the next 6h tick retries.
        console.warn(
          `[RegressionSweep] could not file canary breakage feedback: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  }

  // Task #4561 — recovery arm: runs on EVERY tick (even with no new
  // breakage events). Filing uses autoResolve:false, so without this arm an
  // open "fix main" item only closes when a LATER merge produces a different
  // culprit. Here we close the loop directly: when every broken suite the
  // culprit's canary run recorded has since cleared from the committed red
  // manifest (nightly sweep or a later canary re-verify removed the
  // entries), the open item resolves itself with a recovery note.
  await runCanaryRecoveryCheck(events, opts);
}

/**
 * Task #4561 — resolve open canary "fix main" items whose broken suites have
 * all cleared from tests/red-manifest.json. Fail-closed on every uncertainty:
 * unreadable manifest, culprit missing from the event ledger, or any suite
 * still red ⇒ the item stays open (a false auto-resolve would silently bury
 * a live "main is broken" incident). Never throws.
 */
async function runCanaryRecoveryCheck(
  events: ReturnType<typeof readCanaryBreakageEvents>,
  opts?: {
    redManifestPath?: string;
    listOpenFn?: typeof listOpenSweepItemFiles;
    resolveFn?: typeof resolveOpenSweepItemsForFile;
    relayFn?: typeof relayFeedbackToSlack;
    recoveryPendingStatePath?: string;
  },
): Promise<void> {
  try {
    const relay = opts?.relayFn ?? relayFeedbackToSlack;
    // Task #4630 — re-drive any recovery messages that failed to reach Slack
    // on an earlier tick. Runs BEFORE the open-items early-return: by the
    // time a relay is pending, its item is already resolved (no longer open).
    await drainPendingCanaryRecoveryRelays(relay, opts?.recoveryPendingStatePath);

    const listOpenFn = opts?.listOpenFn ?? listOpenSweepItemFiles;
    const openFiles = await listOpenFn(CANARY_FEEDBACK_USER_ID);
    const openCanaryFiles = openFiles.filter((f) => f.startsWith("post-merge-canary:"));
    if (openCanaryFiles.length === 0) return;

    // Committed red manifest — the same file the canary stamps and the
    // nightly sweep republishes. Validated via the authoritative
    // loadRedManifest (schema/fingerprint/stamps/entry-shape checks,
    // discard-wholesale on any violation): a truncated or schema-invalid
    // manifest must NOT read as "everything recovered". Absent or invalid ⇒
    // cannot prove recovery ⇒ leave every item open.
    const manifestPath = opts?.redManifestPath ?? "tests/red-manifest.json";
    const { loadRedManifest } = await import("../../tests/redManifest");
    const { manifest } = loadRedManifest(resolvePath(manifestPath));
    if (!manifest) return;
    const redFiles = new Set(Object.keys(manifest.entries));

    const byCulprit = new Map(events.map((e) => [e.culpritCommit, e] as const));
    const resolveFn = opts?.resolveFn ?? resolveOpenSweepItemsForFile;
    for (const file of openCanaryFiles) {
      const culprit = file.slice("post-merge-canary:".length);
      const event = byCulprit.get(culprit);
      // Culprit's event no longer in the ledger (trimmed) — we don't know
      // WHICH suites it broke, so we cannot prove recovery. Leave it open.
      if (!event || event.newReds.length === 0) continue;
      const stillRed = event.newReds.filter((suite) => redFiles.has(suite));
      if (stillRed.length > 0) continue; // not recovered yet
      const note =
        `\n\n[Auto-resolved] Recovered: all broken suite(s) from this merge ` +
        `(${event.newReds.join(", ")}) are no longer red in tests/red-manifest.json ` +
        `as of ${new Date().toISOString()} — main is fixed for this incident.`;
      const resolved = await resolveFn(CANARY_FEEDBACK_USER_ID, file, note);
      if (resolved > 0) {
        console.log(
          `[RegressionSweep] canary recovery: culprit ${culprit} — all ` +
            `${event.newReds.length} broken suite(s) cleared; resolved ${resolved} open item(s)`,
        );
        // Task #4609 — close the Slack loop: the filing side posted a
        // "fix main" message to the channel, so operators watching the
        // thread need the recovery too. Same budget-race pattern as
        // filing (fileAndResolveSweepFeedback): the relay never throws
        // by contract (belt-catch for injected test stubs), and we only
        // WAIT up to FEEDBACK_SLACK_RELAY_BUDGET_MS — a hung Slack
        // request cannot stall the 6h watchdog tick.
        //
        // Task #4630 — unlike filing there is no feedback row left pending
        // to hang retry state off (the item just resolved), so a
        // failed/timed-out relay persists a durable pending marker instead;
        // every later watchdog tick re-attempts it (drain above) until
        // delivered or the attempt cap is hit. An in-flight-at-budget send
        // that later delivers clears its own marker, so the retry does not
        // double-post.
        const entry = {
          culprit,
          page: file,
          feedbackText:
            `Recovered: main is fixed for culprit commit ${culprit}. ` +
            `All broken suite(s) from this merge have cleared from ` +
            `tests/red-manifest.json: ${event.newReds.join(", ")}. ` +
            `The open "fix main" item auto-resolved.`,
        };
        const persistMarker = (): void => {
          const pending = readPendingCanaryRecoveryRelays(
            opts?.recoveryPendingStatePath,
          ).filter((e) => e.culprit !== culprit);
          pending.push({
            ...entry,
            attempts: 1,
            firstFailedAt: new Date().toISOString(),
          });
          writePendingCanaryRecoveryRelays(pending, opts?.recoveryPendingStatePath);
        };
        const outcome = await attemptCanaryRecoveryRelay(
          relay,
          entry,
          opts?.recoveryPendingStatePath,
          persistMarker, // in-flight: marker written before the continuation can clear it
        );
        if (outcome === "not_delivered") persistMarker();
      }
    }
  } catch (err) {
    // Never let the recovery arm break the watchdog tick; next 6h tick retries.
    console.warn(
      `[RegressionSweep] canary recovery check failed: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task #5030 — auto-filed re-baseline/triage item for wall-budget breaches.
//
// The duration-budget wall no longer fails runs (green stays green; see
// tests/durationBudget.ts). Instead run-all and the gate append breach
// events to an append-only ledger (appendDurationBudgetBreachEvent in
// regressionSweep.ts), and this arm drains it at each 6h watchdog tick,
// filing exactly ONE system feedback item per stale-budget EPISODE — keyed
// by the breached artifact's generatedAt stamp, because every breach of the
// same committed budget is the same incident ("this budget is stale or the
// wall genuinely grew — re-baseline or triage"). Re-generating the budget
// starts a new stamp, so a later regression files a fresh item.
//
// Same two-layer dedupe as the canary arm above: durable state file of
// already-filed episode keys + the DB-atomic open-row/unique-index dedupe
// inside fileAndResolveSweepFeedback.
// ---------------------------------------------------------------------------

export const DEFAULT_DURATION_BREACH_FEEDBACK_STATE_PATH =
  ".local/state/regression-sweep-duration-breach-filed.json";
/** Reserved submitter id — distinct from the nightly sweep's and canary's so
 * open-row scans never cross-touch their items. */
export const DURATION_BREACH_FEEDBACK_USER_ID = "system:duration-budget";
export const DURATION_BREACH_FEEDBACK_USER_NAME = "Duration Budget Watchdog";

/** How many filed episode keys the state file retains. */
const DURATION_BREACH_STATE_MAX_KEYS = 200;

/** Read the budget-generatedAt episode keys already filed. Never throws —
 * missing/corrupt state means "nothing filed yet" (worst case one duplicate
 * attempt, which the DB unique-index dedupe collapses). */
export function readDurationBreachFiledKeys(
  statePath = DEFAULT_DURATION_BREACH_FEEDBACK_STATE_PATH,
): string[] {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
      filedBudgetStamps?: unknown;
    } | null;
    if (parsed && Array.isArray(parsed.filedBudgetStamps)) {
      return parsed.filedBudgetStamps.filter((k): k is string => typeof k === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/** Persist the filed episode keys (trimmed to the newest). Never throws. */
export function writeDurationBreachFiledKeys(
  filedBudgetStamps: string[],
  statePath = DEFAULT_DURATION_BREACH_FEEDBACK_STATE_PATH,
): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const trimmed = filedBudgetStamps.slice(-DURATION_BREACH_STATE_MAX_KEYS);
    writeFileSync(
      statePath,
      `${JSON.stringify({ filedBudgetStamps: trimmed }, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not persist duration-breach state: ${(err as Error)?.message ?? err}`,
    );
  }
}

/**
 * Build the synthetic SweepReport that carries the re-baseline/triage signal
 * through fileAndResolveSweepFeedback. Exactly ONE failed result per
 * stale-budget episode (never one per breach — a rotation-day gate could
 * breach dozens of times); each result's `file` is the dedupe key
 * `duration-budget:<budget generatedAt>`. Pure — exported for unit tests.
 */
export function buildDurationBreachReport(
  episodes: Map<string, DurationBudgetBreachEvent[]>,
): SweepReport {
  const now = new Date().toISOString();
  const results = [...episodes.entries()].map(([budgetStamp, events]) => {
    const latest = events[events.length - 1];
    const worst = events.reduce((a, b) => (b.wallMs > a.wallMs ? b : a), events[0]);
    const sources = [...new Set(events.map((e) => e.source))].sort().join(", ");
    return {
      name:
        `Re-baseline/triage the test duration budget: aggregate wall exceeded the committed budget ` +
        `(budget generated ${budgetStamp}; ${events.length} breach event(s); worst ${Math.round(worst.wallMs / 1000)}s ` +
        `vs budget ${Math.round(worst.budgetMs / 1000)}s; source(s): ${sources}). Green runs were NOT failed ` +
        `(Task #5030 — wall breaches alert instead of blocking). Either the suite genuinely grew — regen via ` +
        `npx tsx scripts/regen-gate-duration-budget.ts from a zero-skip full-smoke measurement — or a regression ` +
        `made the run slower; check .local/runs/duration-budget-breach-events.jsonl and recent suite-duration reports.`,
      file: `duration-budget:${budgetStamp}`,
      outcome: "failed" as const,
      quarantined: false,
      attempts: 1,
      elapsedMs: 0,
      failureReason:
        `full-smoke/gate wall ${Math.round(latest.wallMs / 1000)}s > budget ${Math.round(latest.budgetMs / 1000)}s ` +
        `(non-blocking alert; ${events.length} event(s) for this budget stamp)`,
    };
  });
  const stamps = [...episodes.values()]
    .flat()
    .map((e) => e.observedAt)
    .sort();
  return {
    startedAt: stamps[0] ?? now,
    finishedAt: stamps[stamps.length - 1] ?? now,
    mode: "smoke",
    total: results.length,
    passed: 0,
    hardFailed: results.length,
    quarantinedFailed: 0,
    flaky: 0,
    results,
    hardFailedNames: results.map((r) => r.file),
    quarantinedFailedNames: [],
    flakyNames: [],
  };
}

/**
 * Task #5030 — drain the wall-breach ledger and file one deduped
 * re-baseline/triage item per not-yet-filed budget episode. Called from the
 * staleness watchdog (boot + every 6h). Injectable deps for unit tests;
 * production callers omit them. Never throws.
 *
 * autoResolve:false — each drain's report carries only the not-yet-filed
 * episodes, so an open item's absence proves nothing; an operator (or a
 * budget regen) closes the item.
 */
export async function runDurationBudgetBreachCheck(opts?: {
  eventsPath?: string;
  statePath?: string;
  fileFn?: typeof fileAndResolveSweepFeedback;
}): Promise<void> {
  try {
    const events = readDurationBudgetBreachEvents(opts?.eventsPath);
    if (events.length === 0) return;
    const filed = readDurationBreachFiledKeys(opts?.statePath);
    const filedSet = new Set(filed);
    const episodes = new Map<string, DurationBudgetBreachEvent[]>();
    for (const e of events) {
      if (filedSet.has(e.budgetGeneratedAt)) continue;
      const arr = episodes.get(e.budgetGeneratedAt) ?? [];
      arr.push(e);
      episodes.set(e.budgetGeneratedAt, arr);
    }
    if (episodes.size === 0) return;
    const report = buildDurationBreachReport(episodes);
    const fileFn = opts?.fileFn ?? fileAndResolveSweepFeedback;
    try {
      const summary = await fileFn(report, {
        submitterId: DURATION_BREACH_FEEDBACK_USER_ID,
        submitterName: DURATION_BREACH_FEEDBACK_USER_NAME,
        autoResolve: false,
      });
      // Stamp the state on success even when filed === 0 (an open row from
      // another workspace — or the unique-index conflict — deduped us): the
      // signal exists in the DB either way.
      writeDurationBreachFiledKeys([...filed, ...episodes.keys()], opts?.statePath);
      console.log(
        `[RegressionSweep] duration-budget breach check: episode(s) ${[...episodes.keys()].join(", ")} — filed ${summary.filed}, resolved ${summary.resolved}`,
      );
    } catch (err) {
      // Leave the state unstamped so the next 6h tick retries.
      console.warn(
        `[RegressionSweep] could not file duration-breach feedback: ${(err as Error)?.message ?? err}`,
      );
    }
  } catch (err) {
    // Never let this arm break the watchdog tick.
    console.warn(
      `[RegressionSweep] duration-budget breach check failed: ${(err as Error)?.message ?? err}`,
    );
  }
}

/**
 * Task #4437 / Task #4530 — Catch-up check: called at boot + every 6h. Kicks
 * a sweep when the baseline is stale + no recent tick + once-per-day cap not
 * hit + load OK + publisher enabled on this workspace.
 *
 * Task #4530 S4 — ineligible reasons are appended to the durable deferral log
 * (CATCHUP_DEFERRAL_LOG_PATH) so post-mortem diagnosis can distinguish a
 * workspace that was asleep (no records) from one that was awake but deferred
 * (records with reasons like "load too high" or "min-gap").
 */
function runCatchupCheck(): void {
  if (!shouldScheduleRegressionSweep()) return;

  const now = new Date();
  const baselineStatus = readCommittedBaselineStatus(now);
  const lastTickState = readLastTickState();
  const loadTooHigh = isLoadTooHighForCatchup();
  // Task #4530 S3 — read attempt-start state for min-gap enforcement.
  const attemptStart = readAttemptStartState();
  const lastAttemptStartedAt = attemptStart?.startedAt ?? null;

  const { eligible, reason } = shouldRunCatchup({
    now,
    baselineAgeDays: baselineStatus.ageDays,
    lastTickState,
    catchupEnabled: isCatchupEnabled(),
    workspaceSchedulingEnabled: shouldScheduleRegressionSweep(),
    loadTooHigh,
    publisherEnabled: isPublisherEnabled(),
    lastAttemptStartedAt,
  });

  if (!eligible) {
    console.log(`[RegressionSweep] catch-up check: skip (${reason})`);
    // Task #4530 S4 — durable deferral record (skips that don't log to disk
    // are indistinguishable from a workspace that was simply asleep).
    // Gate: skip the publisher-disabled reason — that is the normal task-env
    // path and would flood the log with every 6-hour check on every task env.
    if (!reason.startsWith("publisher not enabled")) {
      appendDeferralLog(now.toISOString(), reason);
    }
    return;
  }

  console.log(
    `[RegressionSweep] catch-up arm firing: ${reason} (baseline age ${baselineStatus.ageDays?.toFixed(1)}d)`,
  );
  void withDbAttribution("scheduler:regression-sweep-catchup", async () => {
    await runRegressionSweepNow("catchup");
  });
}

export function startRegressionSweepScheduler(): void {
  if (scheduledTask) return;
  if (isRunningInDeployment()) {
    console.log(
      "[RegressionSweep] not scheduling in deployment — the test suite is " +
        "bound to the dev workspace DB and must never run against prod.",
    );
    return;
  }
  if (!isEnabledByEnv()) {
    console.log(
      "[RegressionSweep] scheduler disabled by REGRESSION_SWEEP_SCHEDULER_ENABLED",
    );
    return;
  }
  scheduledTask = cron.schedule(
    CRON_EXPRESSION,
    () => {
      void withDbAttribution("scheduler:regression-sweep", async () => {
        await runRegressionSweepNow("cron");
      });
    },
    { timezone: CRON_TIMEZONE },
  );
  console.log(
    `[RegressionSweep] scheduler started (cron="${CRON_EXPRESSION}" ` +
      `${CRON_TIMEZONE}); disable via REGRESSION_SWEEP_SCHEDULER_ENABLED=false`,
  );

  // Task #4437 — catch-up arm + watchdog: fire once at boot, then every 6h.
  // Boot check lets a morning dev-server restart recover from a missed nightly.
  // Watchdog is independent of the tick so "did the nightly run?" is always
  // answerable even when the sweep itself is broken.
  const CATCHUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
  try {
    runCatchupCheck();
  } catch (err) {
    console.warn(
      `[RegressionSweep] boot catch-up check failed: ${(err as Error)?.message ?? err}`,
    );
  }
  void runStalenessWatchdog().catch((err) =>
    console.warn(
      `[RegressionSweep] boot watchdog check failed: ${(err as Error)?.message ?? err}`,
    ),
  );
  catchupIntervalId = setInterval(() => {
    try {
      runCatchupCheck();
    } catch (err) {
      console.warn(
        `[RegressionSweep] periodic catch-up check failed: ${(err as Error)?.message ?? err}`,
      );
    }
    void runStalenessWatchdog().catch((err) =>
      console.warn(
        `[RegressionSweep] periodic watchdog check failed: ${(err as Error)?.message ?? err}`,
      ),
    );
  }, CATCHUP_INTERVAL_MS);
}

export function stopRegressionSweepScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
  }
  if (catchupIntervalId !== null) {
    clearInterval(catchupIntervalId);
    catchupIntervalId = null;
  }
}

/** Test-only / ops-only introspection. */
export function getRegressionSweepSchedulerState(): {
  running: boolean;
  lastRunAt: number | null;
  lastExitCode: number | null;
  lastReport: SweepReport | null;
  sweepInFlight: boolean;
} {
  return {
    running: !!scheduledTask,
    lastRunAt,
    lastExitCode,
    lastReport,
    sweepInFlight,
  };
}

/** Persist the currently-red lint set as "alerted". Never throws. */
export function writeAlertedLintReds(
  lints: string[],
  statePath = DEFAULT_LINT_RED_ALERT_STATE_PATH,
): void {
  writeAlertedPoisonFiles(lints, statePath);
}

/** Read the set of lint names already alerted as red on main. Never throws. */
export function readAlertedLintReds(statePath = DEFAULT_LINT_RED_ALERT_STATE_PATH): string[] {
  return readAlertedPoisonFiles(statePath);
}

export function clearAttemptStartState(statePath = ATTEMPT_START_PATH): void {
  try {
    if (existsSync(statePath)) {
      writeFileSync(statePath, `${JSON.stringify({ startedAt: null, trigger: null }, null, 2)}\n`, "utf8");
    }
  } catch {
    /* best-effort */
  }
}

export interface AttemptStartState {
  startedAt: string;
  trigger: string;
}

export function writeAttemptStartState(
  state: AttemptStartState,
  statePath = ATTEMPT_START_PATH,
): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(
      `[RegressionSweep] could not write attempt-start state: ${(err as Error)?.message ?? err}`,
    );
  }
}

export const CATCHUP_DEFERRAL_LOG_PATH = ".local/runs/regression-sweep-catchup-deferrals.jsonl";

const DEFERRAL_LOG_MAX_ENTRIES = 200;

function appendDeferralLog(at: string, reason: string): void {
  try {
    mkdirSync(dirname(CATCHUP_DEFERRAL_LOG_PATH), { recursive: true });
    let existing: Array<{ at: string; reason: string }> = [];
    try {
      existing = readFileSync(CATCHUP_DEFERRAL_LOG_PATH, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { at: string; reason: string });
    } catch {
      // First run or corrupt file — start fresh.
    }
    const entries = [...existing, { at, reason }].slice(-DEFERRAL_LOG_MAX_ENTRIES);
    writeFileSync(
      CATCHUP_DEFERRAL_LOG_PATH,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

/** Hours — minimum gap between consecutive catch-up attempt STARTS. An in-flight
 *  or recently-killed attempt within this window prevents another catch-up start,
 *  avoiding merge-storm thrash. Does NOT affect the cron arm. */
export const CATCHUP_MIN_GAP_BETWEEN_ATTEMPTS_HOURS = 1;

/** Hours — an attempt that started this long ago with no completion record is
 *  considered orphaned and its cause is mentioned in the staleness alert. */
export const ATTEMPT_ORPHAN_THRESHOLD_HOURS = 1.5;

export function readWatchdogStalenessState(
  statePath = DEFAULT_WATCHDOG_STALENESS_STATE_PATH,
): WatchdogStalenessState {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<WatchdogStalenessState> | null;
    return {
      publishedAt: (parsed && typeof parsed.publishedAt === "string" ? parsed.publishedAt : null),
      alertedOn: (parsed && typeof parsed.alertedOn === "string" ? parsed.alertedOn : null),
    };
  } catch {
    return { publishedAt: null, alertedOn: null };
  }
}

export const ATTEMPT_START_PATH = ".local/state/regression-sweep-attempt-start.json";

export function readAttemptStartState(
  statePath = ATTEMPT_START_PATH,
): AttemptStartState | null {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as AttemptStartState | null;
    if (!raw || typeof raw.startedAt !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

/** Pure classifier — exported for unit tests. */
export function classifySubEnvironment(
  replId: string | undefined,
  mainReplProbe: MainReplRemoteProbe,
): boolean {
  const id = (replId ?? "").trim();
  if (id === "" || id.includes(":")) return true; // missing/sub-scoped id → sub-env (fail closed)
  if (mainReplProbe.status === 0 && mainReplProbe.stdout.trim().length > 0) {
    return true; // main-repl remote present → task environment
  }
  if (mainReplProbe.status === 1) return false; // key absent → main workspace
  return true; // git error / unknown → fail closed (no publish)
}

let cachedIsSubEnvironment: boolean | null = null;

/**
 * Cached real-signal detection. Sub-environment-ness cannot change within a
 * process lifetime, so the git probe runs at most once per boot.
 */
export function detectSubEnvironment(): boolean {
  if (cachedIsSubEnvironment === null) {
    cachedIsSubEnvironment = classifySubEnvironment(
      process.env.REPL_ID,
      probeMainReplRemote(),
    );
  }
  return cachedIsSubEnvironment;
}

function probeMainReplRemote(): MainReplRemoteProbe {
  try {
    const probe = spawnSync("git", ["config", "--get", "remote.main-repl.url"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: probe.status, stdout: probe.stdout ?? "" };
  } catch {
    return { status: null, stdout: "" }; // classify() fails closed on null
  }
}
