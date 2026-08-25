// @db-pool-intent: worker
// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
//
// All DB work in this module flows through `action.apply()` (each
// eligible prod-action resolves its handle via `getDb()`) and the
// `recordProdActionRun` audit write. The only caller of
// `runProdActionSelfHealTick()` is the `prod_action_self_heal`
// work-queue handler, which wraps it in `runWithWorkerDb(...)` so every
// `getDb()` inside the applied actions resolves to the worker pool.
/**
 * Task #2086 — Self-healing for maintenance drains.
 *
 * Several CEO "prod-actions" are idempotent, recurring maintenance
 * chores (cancel stale Front backlog, dedupe unread notifications, mark
 * legacy front_email pending rows terminal, drain the 122k Front
 * backlog, backfill competitor location labels). Each one is safe to
 * apply repeatedly — an apply that finds nothing to do returns
 * `not-needed` and writes zero rows. Until now the CEO had to open the
 * panel and apply them by hand whenever a backlog re-accumulated.
 *
 * This module turns that manual chore into an automatic, scheduled
 * repair. On a cadence it applies the actions that have explicitly
 * opted in via `ProdAction.selfHeal` (and ONLY those), respecting each
 * action's own cadence/backoff so a real backlog drains promptly while
 * an idle action is only re-checked occasionally. Every action it runs
 * is the SAME idempotent `action.apply()` the panel calls, so the
 * automation can never do anything the operator could not already do by
 * hand — and with the master switch OFF (the default) it does nothing
 * at all (behaviour-neutral).
 *
 * Per-action scheduling. The persisted last-run JSON carries a
 * `schedule` map of `{ actionId: { nextEligibleAt } }`. An action is
 * "due" when it has never run or `now >= nextEligibleAt`. After a run,
 * `nextEligibleAt` advances by the action's `cadenceMs` (outcome
 * `applied` — keep draining) or `backoffMs` (outcome `not-needed` /
 * `error` — nothing to do or stuck, check less often). Each tick runs
 * at most `maxPerTick` due actions, oldest-due first, so one pass can
 * never fan out an unbounded number of writes.
 *
 * Audit. Runs with a real effect (`applied`) or a failure (`error`)
 * write a `recordProdActionRun` audit row attributed to "system" (null
 * actor) — the same History surface manual applies use. `not-needed`
 * runs are intentionally NOT recorded so the History is not flooded
 * with no-op rows every backoff window; the persisted last-run JSON
 * still reflects the most recent check of every eligible action.
 *
 * Gating (default OFF — opt-in master switch):
 *   1. `prod_action_self_heal_enabled` system setting (master switch).
 *   2. `prod_action_self_heal` queue-drain pause.
 *   3. `KILL_SWITCH_NON_CRITICAL_SWEEPS`.
 *
 * DB pool tenancy: all DB work runs in the worker pool. The work-queue
 * handler wraps `runProdActionSelfHealTick()` in `runWithWorkerDb` so
 * the `getDb()` calls inside each applied action resolve to the worker
 * pool.
 */
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import type { ProdAction } from "./prodActionsRegistry";

/** Audit recorder shape — the subset of `recordProdActionRun` this
 * module calls. Extracted so tests can inject an in-memory recorder
 * instead of hitting the prod_action_runs table. */
export type SelfHealRecordRun = (entry: {
  actionId: string;
  actionTitle: string;
  actorUserId: string | null;
  outcomeState: "applied" | "not-needed" | "error" | "blocked";
  detail: string | null;
  rowsAffected: number | null;
  errorMessage: string | null;
}) => Promise<unknown>;

/**
 * Task #2096 — persistent-failure alert sender. Extracted so tests can
 * capture the alert without resolving real recipients or writing to the
 * `user_notifications` table. The default implementation fans out a
 * worker-context `notifyUser()` to every responsible admin.
 */
export type SelfHealFailureAlert = (entry: {
  actionId: string;
  actionTitle: string;
  consecutiveFailures: number;
  threshold: number;
  detail: string;
}) => Promise<void>;

/**
 * Task #2124 — reconnect-required (auth-dead) alert sender. Extracted so
 * tests can capture the alert without resolving real recipients or
 * writing to the `user_notifications` table. The default implementation
 * fans out a worker-context `notifyUser()` to every responsible admin,
 * naming the integration to reconnect. Unlike the persistent-failure
 * alert (#2096) this has no consecutive threshold: a `blocked` outcome is
 * a deterministic "login not connected" detection, not a transient blip,
 * so the operator is told on the first detection (debounced by the
 * per-action `reconnectAlertSent` flag + an integration-keyed notify
 * dedupe so a persistent dead token never spams).
 */
export type SelfHealReconnectAlert = (entry: {
  actionId: string;
  actionTitle: string;
  /** Integration to reconnect (e.g. "Front"); null when the outcome did
   * not name one. */
  integration: string | null;
  detail: string;
}) => Promise<void>;

export interface SelfHealTickOpts {
  now?: Date;
  /**
   * Test seam: override the source of eligible actions. Defaults to the
   * registry's `PROD_ACTIONS`. The list is still filtered by
   * `selfHeal != null`, so callers can pass a mix.
   */
  actions?: ProdAction[];
  /**
   * Test seam: override the audit recorder. Defaults to
   * `recordProdActionRun`.
   */
  recordRun?: SelfHealRecordRun;
  /**
   * Task #2096 test seam: override the persistent-failure alert sender.
   * Defaults to the worker-context `notifyUser()` fan-out.
   */
  alertFailure?: SelfHealFailureAlert;
  /**
   * Task #2124 test seam: override the reconnect-required (auth-dead)
   * alert sender. Defaults to the worker-context `notifyUser()` fan-out.
   */
  alertReconnect?: SelfHealReconnectAlert;
  /**
   * Test seam: supply the prior cadence/backoff `schedule` map directly
   * instead of reading the persisted `SETTING_LAST_RUN`. Lets a test
   * thread state across ticks without depending on the shared global
   * key (which a concurrent test could clobber).
   */
  priorSchedule?: Record<string, SelfHealScheduleEntry>;
  /**
   * Test seam: when `false`, skip persisting the tick summary to
   * `SETTING_LAST_RUN`. Defaults to persisting (production behaviour).
   */
  persist?: boolean;
}

export const QUEUE_NAME = "prod_action_self_heal";

/** Master enable switch. Default OFF — opt-in because the tick applies
 * real maintenance actions (DB writes / background drains), not just
 * measurement. With it OFF the tick is a behaviour-neutral no-op. */
export const SETTING_ENABLED = "prod_action_self_heal_enabled";

/** Per-tick budget: how many *due* eligible actions to apply per tick so
 * a single pass can never fan out an unbounded number of writes. Bounded
 * 1..MAX. Default deliberately small. */
export const SETTING_MAX_PER_TICK = "prod_action_self_heal_max_per_tick";

/** Persisted JSON summary of the most recent tick (what it applied /
 * skipped and why) plus the per-action `schedule` map used to enforce
 * each action's cadence/backoff across ticks. */
export const SETTING_LAST_RUN = "prod_action_self_heal_last_run";

/**
 * Task #2096 — opt-in switch for the persistent-failure alert. Default
 * OFF: enabling self-heal does not silently start paging admins. With it
 * OFF the tick still tracks consecutive failures (so the alert works the
 * moment it is turned on) but never sends a notification.
 */
export const SETTING_FAILURE_ALERT_ENABLED =
  "prod_action_self_heal_failure_alert_enabled";

/**
 * Task #2096 — how many *consecutive* `error` outcomes for one action
 * trip a single alert. Bounded 1..MAX. Default deliberately small so a
 * genuinely stuck action surfaces quickly, but above 1 so a single
 * one-off transient error never pages anyone.
 */
export const SETTING_FAILURE_ALERT_THRESHOLD =
  "prod_action_self_heal_failure_alert_threshold";

/**
 * Task #2124 — opt-in switch for the reconnect-required (auth-dead) alert.
 * Default OFF, mirroring the persistent-failure alert (#2096): enabling
 * self-heal does not silently start paging admins. With it OFF the tick
 * still tracks the `reconnectAlertSent` de-dupe flag (so the alert works
 * the moment it is turned on) but never sends a notification.
 */
export const SETTING_RECONNECT_ALERT_ENABLED =
  "prod_action_self_heal_reconnect_alert_enabled";

const DEFAULT_MAX_PER_TICK = 2;
const MAX_PER_TICK_CAP = 10;

export const DEFAULT_FAILURE_ALERT_THRESHOLD = 3;
/** Lower bound: 1 means a single error pages immediately. */
export const FAILURE_ALERT_THRESHOLD_MIN = 1;
export const FAILURE_ALERT_THRESHOLD_CAP = 50;

export const TICK_INTERVAL_MS = Number(
  process.env.PROD_ACTION_SELF_HEAL_INTERVAL_MS || 15 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

async function loadMaxPerTick(): Promise<number> {
  const raw = (await getSystemSetting(SETTING_MAX_PER_TICK).catch(() => null))
    ?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_PER_TICK;
  return Math.min(MAX_PER_TICK_CAP, Math.floor(n));
}

/** Task #2096 — is the persistent-failure alert opted in? Default OFF. */
async function loadFailureAlertEnabled(): Promise<boolean> {
  return parseBool(
    (await getSystemSetting(SETTING_FAILURE_ALERT_ENABLED).catch(() => null))
      ?.value,
    false,
  );
}

/** Task #2096 — consecutive-error threshold that trips one alert. */
async function loadFailureAlertThreshold(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_FAILURE_ALERT_THRESHOLD).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FAILURE_ALERT_THRESHOLD;
  return Math.min(FAILURE_ALERT_THRESHOLD_CAP, Math.floor(n));
}

/**
 * Task #2173 — public read of the current consecutive-error threshold,
 * normalized to the bounded [MIN, CAP] range (default when unset). Lets
 * the CEO panel show the live trip point next to the tuning control.
 */
export async function getFailureAlertThreshold(): Promise<number> {
  return loadFailureAlertThreshold();
}

/**
 * Task #2173 — public read of whether the persistent-failure alert is
 * opted in, so the panel can tell the operator whether the threshold it
 * is tuning is currently armed.
 */
export async function getFailureAlertEnabled(): Promise<boolean> {
  return loadFailureAlertEnabled();
}

/**
 * Task #2173 — write the consecutive-error threshold from the CEO panel,
 * clamped to the bounded [MIN, CAP] range. The value is read fresh by
 * `loadFailureAlertThreshold()` on every self-heal tick (and the write
 * busts the settings cache), so the new trip point reflects immediately
 * in the next tick — no restart needed. Returns the effective (clamped)
 * value that was persisted. Throws on a non-finite input so the route
 * can answer 400 rather than silently storing garbage.
 */
export async function setFailureAlertThreshold(
  value: number,
  actorId?: string,
): Promise<number> {
  if (!Number.isFinite(value)) {
    throw new Error("threshold must be a finite number");
  }
  const clamped = Math.min(
    FAILURE_ALERT_THRESHOLD_CAP,
    Math.max(FAILURE_ALERT_THRESHOLD_MIN, Math.floor(value)),
  );
  await setSystemSetting(
    SETTING_FAILURE_ALERT_THRESHOLD,
    String(clamped),
    actorId,
  );
  return clamped;
}

/** Task #2124 — is the reconnect-required (auth-dead) alert opted in?
 * Default OFF. */
async function loadReconnectAlertEnabled(): Promise<boolean> {
  return parseBool(
    (await getSystemSetting(SETTING_RECONNECT_ALERT_ENABLED).catch(() => null))
      ?.value,
    false,
  );
}

export interface SelfHealScheduleEntry {
  /** ISO timestamp the action becomes eligible to run again. */
  nextEligibleAt: string;
  /** Outcome of the most recent automatic run. */
  lastOutcome: "applied" | "not-needed" | "error" | "blocked";
  /** ISO timestamp of the most recent automatic run. */
  lastRunAt: string;
  /**
   * Rows written by the most recent automatic run, when the action
   * reports a count (`applied` outcomes). `null` for `not-needed` /
   * `error` runs or actions that do not report a row count. Persisted
   * durably so the admin readout can always show last run / outcome /
   * rows for each eligible action, not just for the current tick.
   */
  lastRowsAffected: number | null;
  /**
   * Task #2096 — number of *consecutive* `error` outcomes for this
   * action. Incremented on every `error`, reset to 0 on any healthy
   * outcome (`applied` / `not-needed`), left unchanged on a `blocked`
   * (reconnect-required) outcome. Optional for backward compatibility
   * with `schedule` JSON persisted before this field existed.
   */
  consecutiveFailures?: number;
  /**
   * Task #2179 — the detail/message of the most recent `error` outcome,
   * so the admin readout can show *why* an auto-fix keeps failing (not
   * just the count). Set on every `error`, cleared to `null` on any
   * healthy outcome (`applied` / `not-needed`) when the streak resets,
   * left unchanged on a `blocked` (reconnect-required) outcome. Optional
   * for backward compatibility with `schedule` JSON persisted before this
   * field existed.
   */
  lastErrorDetail?: string | null;
  /**
   * Task #2096 — de-dupe flag: `true` once a persistent-failure alert
   * has fired for the current failing streak, so we do not re-page on
   * every backoff tick. Cleared the moment the action recovers (a
   * healthy outcome resets `consecutiveFailures` to 0).
   */
  failureAlertSent?: boolean;
  /**
   * Task #2124 — de-dupe flag: `true` once a reconnect-required
   * (auth-dead) alert has fired for the current `blocked` streak, so a
   * persistent dead token does not re-page on every backoff tick. Cleared
   * the moment the action recovers (any healthy `applied` / `not-needed`
   * outcome). Optional for backward compatibility with `schedule` JSON
   * persisted before this field existed.
   */
  reconnectAlertSent?: boolean;
}

export interface SelfHealAttempt {
  actionId: string;
  actionTitle: string;
  outcome: "applied" | "not-needed" | "error" | "blocked";
  detail: string;
  rowsAffected: number | null;
  /** When this action becomes eligible again after this run. */
  nextEligibleAt: string;
}

export interface ProdActionSelfHealTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  maxPerTick: number;
  /** All actions opted in via `ProdAction.selfHeal`. */
  eligibleActionIds: string[];
  /** Eligible actions that were due (would run if within the budget). */
  dueActionIds: string[];
  /** Actions actually applied this tick (bounded by maxPerTick). */
  attempted: SelfHealAttempt[];
  applied: number;
  notNeeded: number;
  errors: number;
  /**
   * Task #2111 — reconnect-required outcomes this tick. A blocked
   * outcome is NOT an error (it means an integration login expired and
   * the operator must reconnect), so it is counted separately and kept
   * out of `errors` so it never trips error-style alerting.
   */
  blocked: number;
  reason?: string;
  /**
   * Task #2096 — action ids for which a persistent-failure alert was
   * sent this tick (each fires at most once per failing streak). Empty
   * on a healthy tick; useful for tests and the persisted readout.
   */
  failureAlertsSent: string[];
  /**
   * Task #2124 — action ids for which a reconnect-required (auth-dead)
   * alert was sent this tick (each fires at most once per `blocked`
   * streak). Empty on a healthy tick; useful for tests and the persisted
   * readout.
   */
  reconnectAlertsSent: string[];
  /** Per-action cadence/backoff state carried across ticks. */
  schedule: Record<string, SelfHealScheduleEntry>;
}

/**
 * Persist the most recent tick summary (including the per-action
 * `schedule` map) as a JSON `system_settings` value. Never throws — a
 * persistence failure must not fail the tick.
 */
async function persistLastRun(
  result: ProdActionSelfHealTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[ProdActionSelfHeal] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

/**
 * Why the last-run summary could not be returned as a parsed object:
 *   - "ok"         — a well-formed summary was read.
 *   - "never_run"  — the key is absent/empty; normal on a fresh deploy.
 *   - "unreadable" — the stored value (or the settings read itself)
 *     failed to produce a summary; signals a real persistence bug, not
 *     a fresh deploy.
 */
export type LastProdActionSelfHealRunStatus = "ok" | "never_run" | "unreadable";

export interface LastProdActionSelfHealRunRead {
  /** The parsed summary, or null when status is not "ok". */
  lastRun: ProdActionSelfHealTickResult | null;
  status: LastProdActionSelfHealRunStatus;
  /** Plain-English reason present only when status === "unreadable". */
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so the
 * admin readout can tell "never ran" (normal) apart from "stored value
 * was unreadable" (a persistence regression). Never throws — a
 * settings-read failure is reported as `unreadable` with the error
 * message rather than masquerading as `never_run`.
 */
export async function readLastProdActionSelfHealRun(): Promise<LastProdActionSelfHealRunRead> {
  let raw: string | undefined;
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    raw = row?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[ProdActionSelfHeal] Failed to read last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }

  if (!raw) return { lastRun: null, status: "never_run" };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as ProdActionSelfHealTickResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.warn(`[ProdActionSelfHeal] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[ProdActionSelfHeal] Failed to parse last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * Read the persisted last-run summary, or null if the self-heal has not
 * run yet (or the stored value is unparseable). Thin back-compat wrapper
 * over {@link readLastProdActionSelfHealRun} that preserves the original
 * "null for both never-run and unreadable" contract.
 */
export async function getLastProdActionSelfHealRun(): Promise<ProdActionSelfHealTickResult | null> {
  return (await readLastProdActionSelfHealRun()).lastRun;
}

/** Per-action self-heal readout for the admin panel: the durable last
 * run / outcome / rows-affected trio plus when it next becomes eligible. */
export interface SelfHealActionReadout {
  /** ISO timestamp of the most recent automatic run of this action. */
  lastRunAt: string;
  /** Outcome of the most recent automatic run. */
  lastOutcome: "applied" | "not-needed" | "error" | "blocked";
  /** Rows written by the most recent automatic run (null when none). */
  lastRowsAffected: number | null;
  /** ISO timestamp the action becomes eligible to run again. */
  nextEligibleAt: string;
  /**
   * Task #2096 / #2153 — number of *consecutive* `error` outcomes for
   * this action (0 when the last run was healthy). Surfaced so the panel
   * can show an "auto-fix keeps failing N× in a row" indicator.
   */
  consecutiveFailures: number;
  /**
   * Task #2179 — the detail/message of the most recent `error` outcome
   * (null when the last run was healthy). Surfaced so the panel's "auto-fix
   * keeps failing" indicator can show *why* it is failing, not just the
   * count, letting an operator triage the root cause from the panel.
   */
  lastErrorDetail: string | null;
  /**
   * Task #2096 / #2153 — `true` once the persistent-failure alert has
   * already paged the responsible admins for the current failing streak.
   * Lets the panel show that an alert was already sent.
   */
  failureAlertSent: boolean;
  /**
   * Task #2124 — `true` once the reconnect-required (auth-dead) alert has
   * already paged the responsible admins for the current `blocked`
   * streak. Lets the panel show that a reconnect nudge was already sent.
   */
  reconnectAlertSent: boolean;
}

/** Tick-level summary of the most recent self-heal pass: when it ran,
 * how many eligible actions were due, and the aggregate outcome counts
 * (applied / not-needed / error). `reason` is set when the tick
 * short-circuited (disabled / paused / kill switch). */
export interface SelfHealLastRunSummary {
  /** ISO timestamp of the most recent tick. */
  ranAt: string;
  /** Eligible actions (opted in via `ProdAction.selfHeal`) at tick time. */
  eligibleCount: number;
  /** Eligible actions that were due at tick time. */
  dueCount: number;
  /** Actions applied (did real work) this tick. */
  applied: number;
  /** Actions checked but with nothing to do this tick. */
  notNeeded: number;
  /** Actions that errored this tick. */
  errors: number;
  /** Why the tick did nothing, when it short-circuited. */
  reason?: string;
}

/** Admin readout of the self-heal scheduler: master-switch state, the
 * tick-level last-run summary, and the durable per-action last-run trio. */
export interface ProdActionSelfHealReadout {
  /** Master switch (`prod_action_self_heal_enabled`) state. */
  enabled: boolean;
  /** ISO timestamp of the most recent tick, or null if it never ran. */
  ranAt: string | null;
  /** Tick-level summary of the most recent pass, or null if never run. */
  lastRun: SelfHealLastRunSummary | null;
  /**
   * Classifies why `lastRun` is null so the panel can tell "never ran"
   * (normal on a fresh deploy) apart from "unreadable" (a persisted-value
   * parse failure → real persistence bug).
   */
  lastRunStatus: LastProdActionSelfHealRunStatus;
  /** Plain-English reason present only when lastRunStatus === "unreadable". */
  lastRunError?: string;
  /** Per-eligible-action durable last-run readout, keyed by action id. */
  actions: Record<string, SelfHealActionReadout>;
}

/**
 * Build the admin readout from the persisted last-run summary. Reflects
 * the master switch plus the durable per-action schedule (last run time,
 * outcome, and rows affected) so the panel can show what the auto-healer
 * did for each eligible action even between ticks. Never throws.
 */
export async function getProdActionSelfHealReadout(): Promise<ProdActionSelfHealReadout> {
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const lastRead = await readLastProdActionSelfHealRun();
  const last = lastRead.lastRun;
  const actions: Record<string, SelfHealActionReadout> = {};
  if (last?.schedule && typeof last.schedule === "object") {
    for (const [id, entry] of Object.entries(last.schedule)) {
      if (!entry) continue;
      actions[id] = {
        lastRunAt: entry.lastRunAt,
        lastOutcome: entry.lastOutcome,
        lastRowsAffected: entry.lastRowsAffected ?? null,
        nextEligibleAt: entry.nextEligibleAt,
        consecutiveFailures: entry.consecutiveFailures ?? 0,
        lastErrorDetail: entry.lastErrorDetail ?? null,
        failureAlertSent: entry.failureAlertSent ?? false,
        reconnectAlertSent: entry.reconnectAlertSent ?? false,
      };
    }
  }
  const lastRun: SelfHealLastRunSummary | null = last
    ? {
        ranAt: last.ranAt,
        eligibleCount: Array.isArray(last.eligibleActionIds)
          ? last.eligibleActionIds.length
          : 0,
        dueCount: Array.isArray(last.dueActionIds)
          ? last.dueActionIds.length
          : 0,
        applied: last.applied ?? 0,
        notNeeded: last.notNeeded ?? 0,
        errors: last.errors ?? 0,
        ...(last.reason ? { reason: last.reason } : {}),
      }
    : null;
  return {
    enabled,
    ranAt: last?.ranAt ?? null,
    lastRun,
    lastRunStatus: lastRead.status,
    ...(lastRead.error ? { lastRunError: lastRead.error } : {}),
    actions,
  };
}

/** Read the prior persisted `schedule` map (cadence/backoff state). */
async function loadPriorSchedule(): Promise<
  Record<string, SelfHealScheduleEntry>
> {
  const prior = await getLastProdActionSelfHealRun();
  if (prior && prior.schedule && typeof prior.schedule === "object") {
    return prior.schedule;
  }
  return {};
}

/**
 * Task #2096 — default persistent-failure alert. Resolves the
 * responsible admins (CEO / team_lead) and writes one worker-context
 * `notifyUser()` row each, reusing the per-user inbox + opt-in Slack-DM
 * mirror (Tasks #1686/#1687/#1688). A stable per-action `dedupeKey`
 * keeps at most one UNREAD row per recipient; combined with the caller's
 * `failureAlertSent` flag (which suppresses re-alerting until the action
 * recovers) the admin gets exactly one nudge per failing streak.
 *
 * Best-effort: never throws. A notification failure must not fail the
 * tick (the action's backoff/retry is unaffected).
 */
const defaultFailureAlert: SelfHealFailureAlert = async (entry) => {
  try {
    const { getResponsibleAdminsForAlert } = await import(
      "./notifications/recipients"
    );
    const { notifyUser } = await import("./notifications/userInbox");
    const recipients = await getResponsibleAdminsForAlert();
    if (recipients.length === 0) {
      console.warn(
        `[ProdActionSelfHeal] persistent-failure alert for ${entry.actionId} ` +
          `has no ceo/team_lead recipients to notify`,
      );
      return;
    }
    const title = `Auto-heal stuck: ${entry.actionTitle}`;
    const body =
      `The self-healing maintenance action "${entry.actionTitle}" has failed ` +
      `${entry.consecutiveFailures} times in a row (alert threshold ` +
      `${entry.threshold}). It will keep retrying on its backoff interval, ` +
      `but it now needs a human to look. Latest error: ${entry.detail}`;
    const dedupeKey = `self-heal-failing:${entry.actionId}`;
    for (const uid of recipients) {
      try {
        await notifyUser(
          uid,
          {
            category: "system",
            title,
            body,
            deepLink: "/admin/integrations",
            dedupeKey,
            metadata: {
              actionId: entry.actionId,
              consecutiveFailures: entry.consecutiveFailures,
              threshold: entry.threshold,
            },
          },
          { source: "worker:prod_action_self_heal" },
        );
      } catch (err: any) {
        console.warn(
          `[ProdActionSelfHeal] notifyUser(${uid}) for ${entry.actionId} ` +
            `failed: ${err?.message ?? err}`,
        );
      }
    }
  } catch (err: any) {
    console.warn(
      `[ProdActionSelfHeal] persistent-failure alert for ${entry.actionId} ` +
        `failed: ${err?.message ?? err}`,
    );
  }
};

/**
 * Task #2124 — default reconnect-required (auth-dead) alert. Resolves the
 * responsible admins (CEO / team_lead) and writes one worker-context
 * `notifyUser()` row each, reusing the per-user inbox + opt-in Slack-DM
 * mirror (Tasks #1686/#1687/#1688), naming the integration to reconnect.
 *
 * Debounce has two layers so a persistent dead token never spams: the
 * caller's per-action `reconnectAlertSent` flag suppresses re-alerting
 * until the action recovers, and a `dedupeKey` keyed on the *integration*
 * (not the action) keeps at most one UNREAD reconnect row per recipient —
 * so if several actions for the same integration go blocked at once, the
 * operator still gets a single "reconnect X" nudge.
 *
 * Best-effort: never throws. A notification failure must not fail the
 * tick (the action's backoff/retry is unaffected).
 */
const defaultReconnectAlert: SelfHealReconnectAlert = async (entry) => {
  try {
    const { getResponsibleAdminsForAlert } = await import(
      "./notifications/recipients"
    );
    const { notifyUser } = await import("./notifications/userInbox");
    const recipients = await getResponsibleAdminsForAlert();
    if (recipients.length === 0) {
      console.warn(
        `[ProdActionSelfHeal] reconnect alert for ${entry.actionId} ` +
          `has no ceo/team_lead recipients to notify`,
      );
      return;
    }
    const integrationName = entry.integration ?? "An integration";
    const title = `Reconnect needed: ${integrationName}`;
    const body =
      `${integrationName} login has expired or disconnected, so the ` +
      `self-healing maintenance action "${entry.actionTitle}" is paused ` +
      `waiting on it. Reconnect ${integrationName} in the Integrations Hub ` +
      `and it will resume automatically. Details: ${entry.detail}`;
    // Dedupe by integration so multiple blocked actions for the same
    // integration collapse to one reconnect nudge per recipient. The
    // action-id fallback is defensive only: since Task #4840 the tick
    // fires this alert exclusively for blocked outcomes that NAME an
    // integration (no-integration blocks are precondition wait-states
    // and never page).
    const dedupeKey = `self-heal-reconnect:${entry.integration ?? entry.actionId}`;
    for (const uid of recipients) {
      try {
        await notifyUser(
          uid,
          {
            category: "system",
            title,
            body,
            deepLink: "/admin/integrations",
            dedupeKey,
            metadata: {
              actionId: entry.actionId,
              integration: entry.integration,
            },
          },
          { source: "worker:prod_action_self_heal" },
        );
      } catch (err: any) {
        console.warn(
          `[ProdActionSelfHeal] notifyUser(${uid}) for ${entry.actionId} ` +
            `reconnect alert failed: ${err?.message ?? err}`,
        );
      }
    }
  } catch (err: any) {
    console.warn(
      `[ProdActionSelfHeal] reconnect alert for ${entry.actionId} ` +
        `failed: ${err?.message ?? err}`,
    );
  }
};

/**
 * One self-heal pass. Applies the due, opted-in maintenance actions
 * (bounded by the per-tick budget), advancing each action's
 * cadence/backoff. Never throws on a per-action failure — the failure is
 * recorded and the next tick retries. Persists the summary as the
 * last-run readout before returning.
 */
export async function runProdActionSelfHealTick(
  opts?: SelfHealTickOpts,
): Promise<ProdActionSelfHealTickResult> {
  const result = await computeProdActionSelfHealTick(opts);
  if (opts?.persist !== false) await persistLastRun(result);
  return result;
}

async function computeProdActionSelfHealTick(
  opts?: SelfHealTickOpts,
): Promise<ProdActionSelfHealTickResult> {
  const now = opts?.now ?? new Date();
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const maxPerTick = await loadMaxPerTick();
  const priorSchedule = opts?.priorSchedule ?? (await loadPriorSchedule());

  const result: ProdActionSelfHealTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    maxPerTick,
    eligibleActionIds: [],
    dueActionIds: [],
    attempted: [],
    applied: 0,
    notNeeded: 0,
    errors: 0,
    blocked: 0,
    failureAlertsSent: [],
    reconnectAlertsSent: [],
    schedule: { ...priorSchedule },
  };

  if (!enabled) {
    result.reason = "self-heal disabled in system_settings";
    return result;
  }
  if (paused) {
    result.reason = "queue paused via queue_drain_state";
    return result;
  }
  if (PERF.KILL_SWITCH_NON_CRITICAL_SWEEPS) {
    result.reason = "KILL_SWITCH_NON_CRITICAL_SWEEPS=true";
    return result;
  }

  const actionSource =
    opts?.actions ?? (await import("./prodActionsRegistry")).PROD_ACTIONS;
  const recordRun: SelfHealRecordRun =
    opts?.recordRun ??
    (await import("../storage/prodActionRuns")).recordProdActionRun;

  // Task #2096 — persistent-failure alerting config. Read once per tick.
  // `failureAlertEnabled` defaults OFF: enabling self-heal does not start
  // paging admins until this is also opted in.
  const failureAlertEnabled = await loadFailureAlertEnabled();
  const failureAlertThreshold = await loadFailureAlertThreshold();
  const alertFailure: SelfHealFailureAlert =
    opts?.alertFailure ?? defaultFailureAlert;

  // Task #2124 — reconnect-required (auth-dead) alerting config. Read once
  // per tick. `reconnectAlertEnabled` defaults OFF (mirrors #2096): the
  // streak/de-dupe flag is still tracked so it works the moment it is
  // opted in, but no admin is paged until then.
  const reconnectAlertEnabled = await loadReconnectAlertEnabled();
  const alertReconnect: SelfHealReconnectAlert =
    opts?.alertReconnect ?? defaultReconnectAlert;

  const eligible = actionSource.filter((a) => a.selfHeal != null);
  result.eligibleActionIds = eligible.map((a) => a.id);

  // Prune schedule entries for actions that are no longer eligible so the
  // persisted map cannot grow stale keys.
  const eligibleIds = new Set(eligible.map((a) => a.id));
  for (const id of Object.keys(result.schedule)) {
    if (!eligibleIds.has(id)) delete result.schedule[id];
  }

  const nowMs = now.getTime();
  const isDue = (id: string): boolean => {
    const entry = priorSchedule[id];
    if (!entry) return true; // never run → due immediately
    const t = Date.parse(entry.nextEligibleAt);
    if (!Number.isFinite(t)) return true; // unparseable → treat as due
    return nowMs >= t;
  };
  const dueAtMs = (id: string): number => {
    const entry = priorSchedule[id];
    if (!entry) return 0; // never run sorts first (oldest-due)
    const t = Date.parse(entry.nextEligibleAt);
    return Number.isFinite(t) ? t : 0;
  };

  // Oldest-due first so a long-stuck action is never starved by newer
  // ones; deterministic id tiebreak.
  const due = eligible
    .filter((a) => isDue(a.id))
    .sort(
      (a, b) => dueAtMs(a.id) - dueAtMs(b.id) || a.id.localeCompare(b.id),
    );
  result.dueActionIds = due.map((a) => a.id);

  for (const action of due.slice(0, maxPerTick)) {
    const selfHeal = action.selfHeal!;
    let outcomeState: "applied" | "not-needed" | "error" | "blocked";
    let detail: string;
    let rowsAffected: number | null = null;
    // Task #2124 — when the outcome is `blocked` (reconnect-required) the
    // integration that needs reconnecting is named on the outcome so the
    // alert can tell the operator exactly what to reconnect.
    let blockedIntegration: string | null = null;
    try {
      const outcome = await action.apply(null);
      outcomeState = outcome.state;
      detail = outcome.detail;
      if (outcome.state === "applied" && "rowsAffected" in outcome) {
        rowsAffected = outcome.rowsAffected ?? null;
      }
      if (outcome.state === "blocked") {
        blockedIntegration = outcome.integration ?? null;
      }
    } catch (err: any) {
      outcomeState = "error";
      detail = err?.message ?? String(err);
    }

    // Advance this action's schedule: cadence after real work, longer
    // backoff after a no-op / failure / reconnect-required (Task #2111).
    const spacing =
      outcomeState === "applied" ? selfHeal.cadenceMs : selfHeal.backoffMs;
    const nextEligibleAt = new Date(nowMs + spacing).toISOString();

    // Task #2096 — track the consecutive-failure streak. `error`
    // increments it; a healthy outcome (`applied` / `not-needed`) resets
    // it and clears the alert flag so the action can page again on a
    // future streak; a `blocked` (reconnect-required) outcome leaves the
    // streak unchanged — it is the operator-recoverable path, not a
    // failure, and has its own reconnect alert (Task #2111).
    const prior = priorSchedule[action.id];
    const priorFailures = prior?.consecutiveFailures ?? 0;
    const priorAlertSent = prior?.failureAlertSent ?? false;
    const priorReconnectSent = prior?.reconnectAlertSent ?? false;
    const priorErrorDetail = prior?.lastErrorDetail ?? null;
    let consecutiveFailures: number;
    let failureAlertSent: boolean;
    // Task #2179 — carry the most recent `error` detail alongside the
    // streak so the panel can show *why* it keeps failing. Set on
    // `error`, cleared on a healthy outcome, carried forward on `blocked`.
    let lastErrorDetail: string | null;
    // Task #2124 — track whether a reconnect nudge has already fired for
    // the current `blocked` streak. A healthy outcome (`applied` /
    // `not-needed`) re-arms it; `error` / `blocked` carry it forward so a
    // persistent dead token is only paged once.
    let reconnectAlertSent: boolean;
    if (outcomeState === "error") {
      consecutiveFailures = priorFailures + 1;
      failureAlertSent = priorAlertSent;
      reconnectAlertSent = priorReconnectSent;
      lastErrorDetail = detail;
    } else if (outcomeState === "blocked") {
      consecutiveFailures = priorFailures;
      failureAlertSent = priorAlertSent;
      reconnectAlertSent = priorReconnectSent;
      lastErrorDetail = priorErrorDetail;
    } else {
      consecutiveFailures = 0;
      failureAlertSent = false;
      reconnectAlertSent = false;
      lastErrorDetail = null;
    }

    // Fire a single alert when the streak first reaches the threshold and
    // we have not already paged for it. Suppressed until the action
    // recovers (the reset above clears `failureAlertSent`). Gated OFF by
    // default via `failureAlertEnabled`. Best-effort: a send failure must
    // not fail the tick, and we only flip the de-dupe flag once the send
    // has been attempted so a transient failure can re-page next tick.
    if (
      failureAlertEnabled &&
      outcomeState === "error" &&
      consecutiveFailures >= failureAlertThreshold &&
      !failureAlertSent
    ) {
      await alertFailure({
        actionId: action.id,
        actionTitle: action.title,
        consecutiveFailures,
        threshold: failureAlertThreshold,
        detail,
      });
      failureAlertSent = true;
      result.failureAlertsSent.push(action.id);
    }

    // Task #2124 — fire a single reconnect nudge the first time an action
    // goes `blocked` (integration login expired/disconnected), as long as
    // we have not already paged for the current blocked streak. No
    // consecutive threshold: `blocked` is a deterministic "not connected"
    // detection, not a transient blip. Suppressed until the action
    // recovers (a healthy outcome re-arms `reconnectAlertSent`). Gated OFF
    // by default via `reconnectAlertEnabled`. Best-effort: a send failure
    // must not fail the tick, and we only flip the de-dupe flag once the
    // send has been attempted so a transient send failure can re-page.
    //
    // Task #4840 — only auth-dead blocks page. A genuine reconnect-required
    // outcome always NAMES the integration (Front/SEMrush direct returns,
    // classifyIntegrationAuthBlocked for SEMrush/Zoom/Google Ads); a
    // `blocked` outcome WITHOUT an integration is a precondition wait-state
    // (e.g. the Zoom legacy-retirement soak) on a healthy integration — it
    // keeps its backoff/streak semantics but must never page admins with a
    // false "login has expired" nudge. `reconnectAlertSent` simply stays
    // false for such rows, so nothing is owed if an integration is later
    // named on a real auth block.
    if (
      reconnectAlertEnabled &&
      outcomeState === "blocked" &&
      blockedIntegration !== null &&
      !reconnectAlertSent
    ) {
      await alertReconnect({
        actionId: action.id,
        actionTitle: action.title,
        integration: blockedIntegration,
        detail,
      });
      reconnectAlertSent = true;
      result.reconnectAlertsSent.push(action.id);
    }

    result.schedule[action.id] = {
      nextEligibleAt,
      lastOutcome: outcomeState,
      lastRunAt: now.toISOString(),
      lastRowsAffected: rowsAffected,
      consecutiveFailures,
      lastErrorDetail,
      failureAlertSent,
      reconnectAlertSent,
    };

    result.attempted.push({
      actionId: action.id,
      actionTitle: action.title,
      outcome: outcomeState,
      detail,
      rowsAffected,
      nextEligibleAt,
    });
    if (outcomeState === "applied") result.applied += 1;
    else if (outcomeState === "not-needed") result.notNeeded += 1;
    // Task #2111 — a blocked (reconnect-required) outcome is a benign,
    // operator-recoverable condition, NOT an error: count it separately
    // so it never inflates `errors` (and thus never trips error-style
    // alerting), and it is logged at info via the tick summary, not warn.
    else if (outcomeState === "blocked") result.blocked += 1;
    else result.errors += 1;

    // Audit only runs that did real work or failed — never the no-op
    // `not-needed` or benign `blocked` (reconnect-required) checks, so the
    // History is not flooded every backoff window. Best-effort: an audit
    // failure must not fail the tick.
    if (outcomeState === "applied" || outcomeState === "error") {
      try {
        await recordRun({
          actionId: action.id,
          actionTitle: action.title,
          actorUserId: null,
          outcomeState,
          detail,
          rowsAffected,
          errorMessage: outcomeState === "error" ? detail : null,
        });
      } catch (auditErr: any) {
        console.error(
          `[ProdActionSelfHeal] audit insert failed for ${action.id} — ${
            auditErr?.message ?? auditErr
          }`,
        );
      }
    }
  }

  return result;
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[ProdActionSelfHeal] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
      );
      return;
    }
    // Cheap due-check: skip enqueue entirely when disabled so a default-
    // OFF deploy never piles up no-op jobs.
    const enabled = parseBool(
      (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
      false,
    );
    if (!enabled) return;
    const { enqueueJob } = await import("./workScheduler");
    const bucket = Math.floor(Date.now() / TICK_INTERVAL_MS);
    await enqueueJob({
      queueName: QUEUE_NAME,
      workloadClass: "maintenance",
      priority: 200,
      payload: { trigger: "scheduled", bucket },
      dedupeKey: `${QUEUE_NAME}:scheduled:${bucket}`,
      maxAttempts: 2,
    });
  } catch (err: any) {
    console.warn(
      `[ProdActionSelfHeal] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startProdActionSelfHealScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[ProdActionSelfHeal] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopProdActionSelfHealScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __prodActionSelfHealTestHelpers = {
  enqueueScheduledTick,
  loadMaxPerTick,
  loadFailureAlertEnabled,
  loadFailureAlertThreshold,
  loadReconnectAlertEnabled,
};
