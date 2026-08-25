// @cross-instance-safe: dev-workspace-only weekly e2e sweep; in-flight flag
// guards the single long-lived dev process, and the sub-environment gate
// (fail closed) keeps task-environment clones from ever running it.
/**
 * Task #4729 — scheduled runner + staleness watchdog for the non-Latin
 * spreadsheet typing safety check (`scripts/verify-sheet-nonlatin-e2e.ts`).
 *
 * Why: the harness needs a fresh production build (~minutes) plus ~90s of
 * puppeteer against a spawned prod server, so nobody runs it routinely — the
 * 2026-08-11 Clerk auth cutover silently broke it for two days. This module
 * gives it a cadence and, independently, an alerting arm so breakage of the
 * harness OR of spreadsheet typing surfaces without a human remembering.
 *
 * Design (mirrors regressionSweepScheduler, the sanctioned pattern for
 * dev-workspace-only heavy sweeps):
 *  - Weekly cron (Saturday 04:30 ET — weeknight regression sweeps are
 *    incremental/short and the Sunday force-all sweep can run for hours, so
 *    Saturday is the quiet slot). Runs `npm run build`, then the harness.
 *  - Dev workspace ONLY: refuses deployments (the harness spawns
 *    dist/index.cjs against DATABASE_URL and drives the dev DB + a real
 *    throwaway Clerk user), and refuses task/sub-environments via the same
 *    fail-closed detector the sweep publisher uses (task clones must not burn
 *    5-minute builds or churn Clerk users nightly).
 *  - NOT in the Publish build seam: script/build.ts is reserved for
 *    dist-inspecting checks; a 90s puppeteer + live-vendor e2e would lengthen
 *    and flake every deploy and mutate Clerk from the build path.
 *  - Every run appends to a JSONL ledger and overwrites a last-result state
 *    file. Failures dispatch `infra.sheet_nonlatin_check.failed` (Slack +
 *    admin bell mirror) with a day-scoped dedupe key.
 *  - Staleness watchdog (boot + every 6h): if there is no recorded SUCCESS
 *    within STALENESS_ALERT_DAYS, alert once per calendar day. This is the
 *    arm that catches the 2026-08-11 failure class — the run leg dying
 *    silently (crash, never scheduled, kill switch left off) still surfaces.
 *    The daily stamp persists on ANY non-null dispatch result (including
 *    skipped_deduped / skipped_slack_disconnected — the in-app mirror fired)
 *    so an offline Slack cannot turn the 6h ticks into a bell flood.
 *
 * Kill switch: SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED=false (default ON in
 * the dev workspace; the deployment/sub-env gates make default-ON safe).
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import cron from "node-cron";

import { isRunningInDeployment } from "../lib/deploymentEnv";
import { registerModuleStateResetForTest } from "./moduleStateReset";

// Heavy server modules (DB pool, notification dispatcher, sub-env detector)
// are imported LAZILY inside the functions that need them so importing this
// module for unit tests stays pure fs/cron — no live DB-pool initialization.
type NotifyFn = typeof import("./notifications/dispatcher").notifyByType;

export const NOTIFICATION_ID = "infra.sheet_nonlatin_check.failed";
const CRON_EXPRESSION = "30 4 * * 6"; // Saturday 04:30
const CRON_TIMEZONE = "America/New_York";

export const LAST_RESULT_PATH = ".local/state/sheet-nonlatin-check-last.json";
export const RUN_LEDGER_PATH = ".local/runs/sheet-nonlatin-check.jsonl";
export const WATCHDOG_STATE_PATH = ".local/state/sheet-nonlatin-check-watchdog.json";

/** Alert when no successful run is recorded within this many days. The
 * cadence is weekly, so 9 days = one missed week plus slack for a long
 * Saturday outage — tighter would false-alarm on a single slow weekend. */
export const STALENESS_ALERT_DAYS = 9;

const BUILD_TIMEOUT_MS = 25 * 60 * 1000;
const HARNESS_TIMEOUT_MS = 12 * 60 * 1000;
/** Keep only the tail of child output in the alert/ledger. */
const LOG_TAIL_CHARS = 2000;

export interface CheckRunResult {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  /** Which leg failed (or "harness" on success). */
  phase: "build" | "harness";
  exitCode: number | null;
  /** Tail of combined stdout+stderr of the failed (or final) leg. */
  logTail: string;
  trigger: "cron" | "manual";
}

interface WatchdogState {
  /** Calendar day (UTC, YYYY-MM-DD) the staleness alert last dispatched. */
  alertedOn: string | null;
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let watchdogIntervalId: ReturnType<typeof setInterval> | null = null;
let runInFlight = false;
let lastRunAt: number | null = null;

registerModuleStateResetForTest("sheetNonlatinCheckScheduler", () => {
  if (scheduledTask) {
    void scheduledTask.stop();
    scheduledTask = null;
  }
  if (watchdogIntervalId !== null) {
    clearInterval(watchdogIntervalId);
    watchdogIntervalId = null;
  }
  runInFlight = false;
  lastRunAt = null;
});

function isEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  // Default ON. Explicit "false" / "0" / "off" / "no" opts out.
  const raw = (env.SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED ?? "").trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/**
 * Pure workspace-eligibility classifier — exported for unit tests. Returns
 * null when this process is the main dev workspace (the only place either
 * the run scheduler OR the watchdog may operate), else a refusal reason.
 * Deliberately does NOT consult the kill switch: the switch disables only
 * the run leg, never the staleness watchdog — a kill switch left off is
 * exactly one of the silent-failure classes the watchdog exists to catch.
 */
export function classifyWorkspaceRefusal(params: {
  inDeployment: boolean;
  isSubEnvironment: boolean;
}): string | null {
  if (params.inDeployment) {
    return "running in deployment — the harness drives the dev DB and spawns a local prod server; dev workspace only";
  }
  if (params.isSubEnvironment) {
    return "task/sub-environment detected (fail closed) — only the main dev workspace runs the weekly check";
  }
  return null;
}

/**
 * Pure gating classifier for the RUN scheduler (cron leg) — workspace
 * eligibility plus the kill switch. Exported for unit tests.
 */
export function classifySchedulerRefusal(params: {
  inDeployment: boolean;
  isSubEnvironment: boolean;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const workspaceRefusal = classifyWorkspaceRefusal(params);
  if (workspaceRefusal) return workspaceRefusal;
  if (!isEnabledByEnv(params.env)) {
    return "disabled by SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Durable result state
// ---------------------------------------------------------------------------

function writeJsonSafe(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
  } catch (err) {
    console.warn(
      `[SheetNonlatinCheck] could not write ${path}: ${(err as Error)?.message ?? err}`,
    );
  }
}

export interface CheckState {
  lastResult: CheckRunResult | null;
  /** finishedAt of the most recent SUCCESSFUL run — preserved across later
   * failed attempts, so one failed week never erases the success record and
   * fakes an immediate "never succeeded" staleness alert. */
  lastSuccessAt: string | null;
}

function isRunResultShape(raw: unknown): raw is CheckRunResult {
  const r = raw as CheckRunResult | null;
  return !!r && typeof r.finishedAt === "string" && typeof r.ok === "boolean";
}

export function readCheckState(statePath = LAST_RESULT_PATH): CheckState {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as
      | (Partial<CheckState> & Partial<CheckRunResult>)
      | null;
    if (raw && isRunResultShape(raw.lastResult)) {
      return {
        lastResult: raw.lastResult,
        lastSuccessAt: typeof raw.lastSuccessAt === "string" ? raw.lastSuccessAt : null,
      };
    }
    // Legacy shape: the file held the bare CheckRunResult.
    if (isRunResultShape(raw)) {
      return { lastResult: raw, lastSuccessAt: raw.ok ? raw.finishedAt : null };
    }
    return { lastResult: null, lastSuccessAt: null };
  } catch {
    return { lastResult: null, lastSuccessAt: null };
  }
}

export function readLastResult(statePath = LAST_RESULT_PATH): CheckRunResult | null {
  return readCheckState(statePath).lastResult;
}

export function recordRunResult(
  result: CheckRunResult,
  paths?: { statePath?: string; ledgerPath?: string },
): void {
  const statePath = paths?.statePath ?? LAST_RESULT_PATH;
  const prior = readCheckState(statePath);
  const next: CheckState = {
    lastResult: result,
    lastSuccessAt: result.ok ? result.finishedAt : prior.lastSuccessAt,
  };
  writeJsonSafe(statePath, next);
  const ledgerPath = paths?.ledgerPath ?? RUN_LEDGER_PATH;
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify(result) + "\n");
  } catch (err) {
    console.warn(
      `[SheetNonlatinCheck] could not append ${ledgerPath}: ${(err as Error)?.message ?? err}`,
    );
  }
}

export function readWatchdogState(statePath = WATCHDOG_STATE_PATH): WatchdogState {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as WatchdogState | null;
    return { alertedOn: typeof raw?.alertedOn === "string" ? raw.alertedOn : null };
  } catch {
    return { alertedOn: null };
  }
}

export function writeWatchdogState(
  state: WatchdogState,
  statePath = WATCHDOG_STATE_PATH,
): void {
  writeJsonSafe(statePath, state);
}

// ---------------------------------------------------------------------------
// Run leg
// ---------------------------------------------------------------------------

function spawnLeg(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; logTail: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let log = "";
    const keepTail = (buf: Buffer) => {
      log = (log + buf.toString()).slice(-LOG_TAIL_CHARS * 4);
    };
    child.stdout?.on("data", keepTail);
    child.stderr?.on("data", keepTail);
    const timer = setTimeout(() => {
      log += `\n[SheetNonlatinCheck] leg timed out after ${timeoutMs / 1000}s — killing`;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    timer.unref?.();
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, logTail: log.slice(-LOG_TAIL_CHARS) });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        logTail: (log + `\nspawn error: ${err?.message ?? err}`).slice(-LOG_TAIL_CHARS),
      });
    });
  });
}

/** Pure notification builder — exported for unit tests. */
export function buildFailureNotification(
  result: CheckRunResult,
  now: Date,
): { text: string; dedupeKey: string } {
  const day = now.toISOString().slice(0, 10);
  const legLabel =
    result.phase === "build" ? "production build (npm run build)" : "typing harness";
  return {
    text:
      `❌ Weekly non-Latin spreadsheet typing check FAILED at the ${legLabel} leg ` +
      `(exit=${result.exitCode ?? "spawn-error"}, trigger=${result.trigger}, ` +
      `started ${result.startedAt}). Spreadsheet typing of CJK/emoji/accented/RTL ` +
      `text may be broken in production builds, or the harness itself broke ` +
      `(e.g. an auth change — see 2026-08-11). ` +
      `Reproduce: npm run build && npx tsx scripts/verify-sheet-nonlatin-e2e.ts\n\n` +
      `Log tail:\n${result.logTail || "(no output captured)"}`,
    // Day-scoped: a broken week alerts once per day it stays broken, never
    // collapses into one forever-unread row.
    dedupeKey: `sheet-nonlatin-check-failed:${day}`,
  };
}

export async function runSheetNonlatinCheckNow(
  trigger: "cron" | "manual",
  opts?: {
    notifyFn?: NotifyFn;
    statePath?: string;
    ledgerPath?: string;
  },
): Promise<CheckRunResult | null> {
  if (runInFlight) {
    console.log(`[SheetNonlatinCheck] run already in flight, skipping ${trigger} trigger`);
    return null;
  }
  runInFlight = true;
  lastRunAt = Date.now();
  const notifyFn =
    opts?.notifyFn ?? (await import("./notifications/dispatcher")).notifyByType;
  const startedAt = new Date().toISOString();
  try {
    console.log(`[SheetNonlatinCheck] starting (trigger=${trigger}): npm run build`);
    const build = await spawnLeg("npm", ["run", "build"], BUILD_TIMEOUT_MS);
    let result: CheckRunResult;
    if (build.exitCode !== 0) {
      result = {
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: false,
        phase: "build",
        exitCode: build.exitCode,
        logTail: build.logTail,
        trigger,
      };
    } else {
      console.log("[SheetNonlatinCheck] build OK — running harness");
      const harness = await spawnLeg(
        "npx",
        ["--yes", "tsx", "scripts/verify-sheet-nonlatin-e2e.ts"],
        HARNESS_TIMEOUT_MS,
      );
      result = {
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: harness.exitCode === 0,
        phase: "harness",
        exitCode: harness.exitCode,
        logTail: harness.logTail,
        trigger,
      };
    }
    recordRunResult(result, opts);
    console.log(
      `[SheetNonlatinCheck] finished ok=${result.ok} phase=${result.phase} exit=${result.exitCode}`,
    );
    if (!result.ok) {
      const { text, dedupeKey } = buildFailureNotification(result, new Date());
      try {
        await notifyFn(
          NOTIFICATION_ID,
          { text, preview: { phase: result.phase, exitCode: result.exitCode } },
          {
            triggerSource: "scheduled",
            failureType: "sheet_nonlatin_check",
            dedupeKey,
            metadata: { phase: result.phase, exitCode: result.exitCode, trigger },
          },
        );
      } catch (err) {
        console.warn(
          `[SheetNonlatinCheck] could not dispatch failure alert: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    return result;
  } finally {
    runInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Staleness watchdog
// ---------------------------------------------------------------------------

/**
 * Pure decision — exported for unit tests. Returns the alert text when a
 * staleness alert should dispatch now, else null.
 */
export function classifyStaleness(params: {
  now: Date;
  lastResult: CheckRunResult | null;
  /** Most recent SUCCESS timestamp, tracked independently of the most recent
   * attempt. When omitted, falls back to the last result only if it was a
   * success (legacy-state tolerance). */
  lastSuccessAt?: string | null;
  watchdog: WatchdogState;
  thresholdDays?: number;
}): { text: string; dedupeKey: string } | null {
  const threshold = params.thresholdDays ?? STALENESS_ALERT_DAYS;
  const lastSuccessAt =
    params.lastSuccessAt !== undefined
      ? params.lastSuccessAt
      : params.lastResult && params.lastResult.ok
        ? params.lastResult.finishedAt
        : null;
  let ageDays: number | null = null;
  if (lastSuccessAt) {
    ageDays = (params.now.getTime() - Date.parse(lastSuccessAt)) / (24 * 60 * 60 * 1000);
    if (!Number.isFinite(ageDays)) ageDays = null;
  }
  if (ageDays !== null && ageDays <= threshold) return null;
  // Stale (or never succeeded). Once per calendar day.
  const todayUtc = params.now.toISOString().slice(0, 10);
  if (params.watchdog.alertedOn === todayUtc) return null;
  const lastLine =
    lastSuccessAt !== null
      ? `Last recorded success was ${ageDays!.toFixed(1)} days ago (${lastSuccessAt}).`
      : params.lastResult
        ? `The last recorded run FAILED at the ${params.lastResult.phase} leg (${params.lastResult.finishedAt}); no success on record.`
        : "No run has ever been recorded on this workspace.";
  return {
    text:
      `⚠️ [Watchdog] The weekly non-Latin spreadsheet typing check has no successful ` +
      `run within ${threshold} days. ${lastLine} The scheduled Saturday run may be ` +
      `broken, disabled (SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED), or dying silently — ` +
      `this is exactly how the 2026-08-11 auth cutover went unnoticed. ` +
      `Run manually: npm run build && npx tsx scripts/verify-sheet-nonlatin-e2e.ts`,
    dedupeKey: `sheet-nonlatin-check-stale:${todayUtc}`,
  };
}

export async function runSheetNonlatinStalenessWatchdogOnce(opts?: {
  now?: Date;
  statePath?: string;
  watchdogStatePath?: string;
  notifyFn?: NotifyFn;
}): Promise<void> {
  const now = opts?.now ?? new Date();
  const notifyFn =
    opts?.notifyFn ?? (await import("./notifications/dispatcher")).notifyByType;
  const { lastResult, lastSuccessAt } = readCheckState(opts?.statePath);
  const watchdog = readWatchdogState(opts?.watchdogStatePath);
  const decision = classifyStaleness({ now, lastResult, lastSuccessAt, watchdog });
  if (!decision) {
    // Distinguish "healthy" (fresh success — clear the daily stamp so a
    // future episode alerts again) from "stale but already alerted today"
    // (stamp must survive) by re-classifying with a blank stamp.
    const staleIgnoringStamp = classifyStaleness({
      now,
      lastResult,
      lastSuccessAt,
      watchdog: { alertedOn: null },
    });
    if (!staleIgnoringStamp && watchdog.alertedOn !== null) {
      writeWatchdogState({ alertedOn: null }, opts?.watchdogStatePath);
    }
    return;
  }
  console.warn(`[SheetNonlatinCheck] ${decision.text}`);
  try {
    const result = await notifyFn(
      NOTIFICATION_ID,
      { text: decision.text },
      {
        triggerSource: "scheduled",
        failureType: "sheet_nonlatin_check",
        dedupeKey: decision.dedupeKey,
        metadata: { lastSuccessAt },
      },
    );
    // Persist the daily stamp for ANY non-null dispatch result (including
    // skipped_deduped / skipped_slack_disconnected — the in-app mirror still
    // fired) so 6h ticks never flood the bell. Only a genuine throw leaves
    // today unrecorded for a retry at the next tick.
    if (result != null) {
      writeWatchdogState(
        { alertedOn: now.toISOString().slice(0, 10) },
        opts?.watchdogStatePath,
      );
    }
  } catch (err) {
    console.warn(
      `[SheetNonlatinCheck] could not dispatch staleness alert: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

const WATCHDOG_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export async function startSheetNonlatinCheckScheduler(overrides?: {
  /** Test-only injection seams; production boot passes nothing. */
  inDeployment?: boolean;
  isSubEnvironment?: boolean;
  env?: NodeJS.ProcessEnv;
  watchdogOpts?: Parameters<typeof runSheetNonlatinStalenessWatchdogOnce>[0];
}): Promise<void> {
  if (scheduledTask || watchdogIntervalId) return;
  const inDeployment = overrides?.inDeployment ?? isRunningInDeployment();
  const isSubEnvironment =
    overrides?.isSubEnvironment ??
    (await import("./regressionSweepScheduler")).detectSubEnvironment();
  const workspaceRefusal = classifyWorkspaceRefusal({ inDeployment, isSubEnvironment });
  if (workspaceRefusal) {
    // Neither the run scheduler nor the watchdog may operate here.
    console.log(`[SheetNonlatinCheck] not scheduling: ${workspaceRefusal}`);
    return;
  }
  // Watchdog first — it must run even when the kill switch disables the run
  // leg (a switch left off is one of the silent-failure classes it catches).
  startWatchdog(overrides?.watchdogOpts);
  if (!isEnabledByEnv(overrides?.env)) {
    console.log(
      "[SheetNonlatinCheck] run scheduler disabled by SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED — " +
        "staleness watchdog still active",
    );
    return;
  }
  scheduledTask = cron.schedule(
    CRON_EXPRESSION,
    () => {
      void import("../db")
        .then(({ withDbAttribution }) =>
          withDbAttribution("scheduler:sheet-nonlatin-check", async () => {
            await runSheetNonlatinCheckNow("cron");
          }),
        )
        .catch((err) =>
          console.warn(
            `[SheetNonlatinCheck] cron run failed: ${(err as Error)?.message ?? err}`,
          ),
        );
    },
    { timezone: CRON_TIMEZONE },
  );
  console.log(
    `[SheetNonlatinCheck] scheduler started (cron="${CRON_EXPRESSION}" ${CRON_TIMEZONE}, ` +
      `watchdog every 6h); disable via SHEET_NONLATIN_CHECK_SCHEDULER_ENABLED=false`,
  );
}

/** Watchdog: boot + every 6h — independent of the run leg so "did the check
 * run?" stays answerable even when the run leg is broken OR disabled. */
function startWatchdog(
  watchdogOpts?: Parameters<typeof runSheetNonlatinStalenessWatchdogOnce>[0],
): void {
  void runSheetNonlatinStalenessWatchdogOnce(watchdogOpts).catch((err) =>
    console.warn(
      `[SheetNonlatinCheck] boot watchdog check failed: ${(err as Error)?.message ?? err}`,
    ),
  );
  watchdogIntervalId = setInterval(() => {
    void import("../db")
      .then(({ withDbAttribution }) =>
        withDbAttribution("scheduler:sheet-nonlatin-check-watchdog", async () => {
          await runSheetNonlatinStalenessWatchdogOnce(watchdogOpts);
        }),
      )
      .catch((err) =>
        console.warn(
          `[SheetNonlatinCheck] periodic watchdog check failed: ${(err as Error)?.message ?? err}`,
        ),
      );
  }, WATCHDOG_INTERVAL_MS);
  watchdogIntervalId.unref?.();
}

export function stopSheetNonlatinCheckScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop();
    scheduledTask = null;
  }
  if (watchdogIntervalId !== null) {
    clearInterval(watchdogIntervalId);
    watchdogIntervalId = null;
  }
}

/** Test-only / ops-only introspection. */
export function getSheetNonlatinCheckSchedulerState(): {
  running: boolean;
  watchdogRunning: boolean;
  lastRunAt: number | null;
  runInFlight: boolean;
} {
  return {
    running: !!scheduledTask,
    watchdogRunning: watchdogIntervalId !== null,
    lastRunAt,
    runInFlight,
  };
}
