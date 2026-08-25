// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
/**
 * Task #1984 — Close the outbound message gap automatically.
 *
 * The per-direction coverage row (Task #1974) exposes
 * `messages_outbound_gap` = max(messages_outbound_front -
 * messages_outbound_local, 0): the number of outbound messages Front
 * Analytics says were sent during a month that NoBull never stored as
 * `raw_communication_records` evidence. Before this task the gap was
 * only *reported* — an operator had to manually chase the misses.
 *
 * This module turns that report into an automatic (or operator-
 * triggered) close-gap retry. For each month with a positive outbound
 * gap it routes the month window back through the existing Front
 * Historical Recovery ingestion pipeline
 * (`runHistoricalRecovery({ customWindows })`). That pipeline:
 *
 *   1. enumerates the Front conversations in the `[monthStart, monthEnd)`
 *      window via the Front list / search endpoint, then
 *   2. hydrates each conversation's full message list and writes one
 *      `raw_communication_records` row per `msg_*` id, deduping every
 *      insert against `raw_communication_records.external_source_id`
 *      (the Front message id) before it writes — see
 *      `frontWebhookIngestion.ts` per-message materialization.
 *
 * So the "enumerate Front message ids → dedupe against
 * external_message_id → enqueue the misses for normal ingestion" loop
 * the task describes is the per-message materialization path; this
 * module is the bounded, gated *driver* that points it at the months
 * that still have an outbound gap.
 *
 * IMPORTANT — per-message materialization dependency. Recovery only
 * writes per-message outbound rows when the
 * `front_recovery_per_message_materialization_enabled` switch is ON.
 * With it OFF, recovery writes a single last-message row per
 * conversation and the per-message outbound gap can never close. This
 * tick therefore treats a disabled switch as a *hard-gap reason* and
 * no-ops rather than spawning recovery jobs that cannot help.
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { PERF } from "../perfConfig";
import { isQueuePaused } from "./queueDrainControl";
import { isPoolEpicSwitchEnabled } from "./poolEpicKillSwitches";

export const QUEUE_NAME = "front_outbound_gap_close";

/** Master enable switch. Default OFF — opt-in because the tick spawns
 * real ingestion (recovery) work, not measurement. */
export const SETTING_ENABLED = "front_outbound_gap_close_enabled";
/** Per-tick budget: how many gap months to drive into recovery per
 * tick. Bounded 1..MAX so a backlog of gap months can never fan out an
 * unbounded number of concurrent recovery jobs (each of which is itself
 * throttled and capped by `front_recovery_max_concurrent_jobs`). */
export const SETTING_MAX_MONTHS_PER_TICK =
  "front_outbound_gap_close_max_months_per_tick";

const DEFAULT_MAX_MONTHS_PER_TICK = 1;
const MAX_MONTHS_PER_TICK_CAP = 12;

/** The per-message materialization switch this tick depends on. */
export const REQUIRED_MATERIALIZATION_SWITCH =
  "front_recovery_per_message_materialization_enabled" as const;

/** Persisted JSON summary of the most recent tick so operators get a
 * live readout of what the closer last attempted/skipped (and why)
 * without scraping worker logs. */
export const SETTING_LAST_RUN = "front_outbound_gap_close_last_run";

export const TICK_INTERVAL_MS = Number(
  process.env.FRONT_OUTBOUND_GAP_CLOSE_INTERVAL_MS || 60 * 60_000,
);

let interval: ReturnType<typeof setInterval> | null = null;

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

async function loadMaxMonthsPerTick(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_MAX_MONTHS_PER_TICK).catch(() => null)
  )?.value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_MONTHS_PER_TICK;
  return Math.min(MAX_MONTHS_PER_TICK_CAP, Math.floor(n));
}

export interface OutboundGapMonth {
  month: string;
  monthStart: Date;
  monthEnd: Date;
  messagesOutboundFront: number | null;
  messagesOutboundLocal: number | null;
  messagesOutboundGap: number | null;
}

/**
 * Read the coverage rows that still report a positive outbound gap,
 * worst-gap first so a bounded per-tick budget chips away at the
 * biggest misses first. Pure read against the cached coverage table —
 * no Front API call.
 */
export async function selectOutboundGapMonths(
  limit: number,
): Promise<OutboundGapMonth[]> {
  const rows = await workerDb.execute(sql`
    SELECT month, month_start, month_end,
           messages_outbound_front, messages_outbound_local, messages_outbound_gap
    FROM front_analytics_monthly_coverage
    WHERE messages_outbound_gap > 0
    ORDER BY messages_outbound_gap DESC, month DESC
    LIMIT ${limit}
  `);
  const list = ((rows as any).rows ?? (rows as unknown as any[])) as Array<{
    month: string;
    month_start: Date | string;
    month_end: Date | string;
    messages_outbound_front: number | null;
    messages_outbound_local: number | null;
    messages_outbound_gap: number | null;
  }>;
  return list.map((r) => ({
    month: r.month,
    monthStart:
      r.month_start instanceof Date ? r.month_start : new Date(r.month_start),
    monthEnd:
      r.month_end instanceof Date ? r.month_end : new Date(r.month_end),
    messagesOutboundFront:
      r.messages_outbound_front == null
        ? null
        : Number(r.messages_outbound_front),
    messagesOutboundLocal:
      r.messages_outbound_local == null
        ? null
        : Number(r.messages_outbound_local),
    messagesOutboundGap:
      r.messages_outbound_gap == null ? null : Number(r.messages_outbound_gap),
  }));
}

/**
 * Read a single coverage row by `month` (YYYY-MM), regardless of its
 * current stored `messages_outbound_gap`. Used by the operator-scoped
 * "Run for this month" action (Task #2057): the operator explicitly
 * targets one row in the gap-months table, so we re-drive exactly that
 * month and let the shared per-month re-verify decide the outcome
 * (`already_closed` when the fresh local count has caught up). Returns
 * an empty list when the month has no coverage row at all. Pure read —
 * no Front API call.
 */
export async function selectOutboundGapMonthsForMonth(
  month: string,
): Promise<OutboundGapMonth[]> {
  const rows = await workerDb.execute(sql`
    SELECT month, month_start, month_end,
           messages_outbound_front, messages_outbound_local, messages_outbound_gap
    FROM front_analytics_monthly_coverage
    WHERE month = ${month}
    LIMIT 1
  `);
  const list = ((rows as any).rows ?? (rows as unknown as any[])) as Array<{
    month: string;
    month_start: Date | string;
    month_end: Date | string;
    messages_outbound_front: number | null;
    messages_outbound_local: number | null;
    messages_outbound_gap: number | null;
  }>;
  return list.map((r) => ({
    month: r.month,
    monthStart:
      r.month_start instanceof Date ? r.month_start : new Date(r.month_start),
    monthEnd:
      r.month_end instanceof Date ? r.month_end : new Date(r.month_end),
    messagesOutboundFront:
      r.messages_outbound_front == null
        ? null
        : Number(r.messages_outbound_front),
    messagesOutboundLocal:
      r.messages_outbound_local == null
        ? null
        : Number(r.messages_outbound_local),
    messagesOutboundGap:
      r.messages_outbound_gap == null ? null : Number(r.messages_outbound_gap),
  }));
}

/**
 * Fresh local outbound count for a month — same source filter the
 * coverage worker uses for `messages_outbound_local`. Cheap single
 * grouped count; lets the tick re-verify a gap is still real before
 * spending a recovery slot on it (the stored `messages_outbound_gap`
 * can be stale between coverage refreshes if ingestion already landed
 * the misses).
 */
export async function countOutboundLocalForMonth(
  monthStart: Date,
  monthEnd: Date,
): Promise<number> {
  const rows = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM raw_communication_records
    WHERE source_type = 'front_email'
      AND direction = 'outbound'
      AND timestamp IS NOT NULL
      AND timestamp >= ${monthStart.toISOString()}
      AND timestamp <  ${monthEnd.toISOString()}
  `);
  const r = ((rows as any).rows ?? (rows as unknown as any[]))[0];
  return Number(r?.n ?? 0) || 0;
}

export type GapMonthOutcome =
  | "recovery_triggered"
  | "already_closed"
  | "front_count_unknown"
  | "deferred_recovery_cap";

export interface GapMonthAttempt {
  month: string;
  outcome: GapMonthOutcome;
  /** Outbound gap recomputed from the fresh local count vs. stored Front count. */
  remainingGap: number | null;
  /** Recovery job id when `outcome === "recovery_triggered"`. */
  recoveryJobId?: string;
}

export interface OutboundGapCloseTickResult {
  ranAt: string;
  enabled: boolean;
  paused: boolean;
  /** True when the per-message materialization switch is ON (required). */
  materializationEnabled: boolean;
  maxMonthsPerTick: number;
  candidateMonths: number;
  attempted: GapMonthAttempt[];
  reason?: string;
  /** Present when this run was scoped to a single operator-chosen month
   * (Task #2057) rather than the worst-gap-first per-tick budget. */
  scopedMonth?: string;
}

/**
 * Persist the most recent tick summary as a JSON `system_settings`
 * value so the operator status route can surface what the closer last
 * attempted/skipped (and why) without scraping worker logs. Never
 * throws — a persistence failure must not fail the tick.
 */
async function persistLastRun(
  result: OutboundGapCloseTickResult,
): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.warn(
      `[FrontOutboundGapClose] Failed to persist last-run summary: ${
        err?.message ?? err
      }`,
    );
  }
}

/**
 * Why the last-run summary could not be returned as a parsed object:
 *   - "ok"        — a well-formed summary was read.
 *   - "never_run" — the key is absent/empty; normal on a fresh deploy.
 *   - "unreadable" — the stored value (or the settings read itself)
 *     failed to produce a summary; signals a real persistence bug, not
 *     a fresh deploy.
 */
export type LastOutboundGapCloseRunStatus = "ok" | "never_run" | "unreadable";

export interface LastOutboundGapCloseRunRead {
  /** The parsed summary, or null when status is not "ok". */
  lastRun: OutboundGapCloseTickResult | null;
  status: LastOutboundGapCloseRunStatus;
  /** Plain-English reason present only when status === "unreadable". */
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so the
 * operator status route can tell "never ran" (normal) apart from
 * "stored value was unreadable" (a persistence regression). Never
 * throws — a settings-read failure is reported as `unreadable` with the
 * error message rather than masquerading as `never_run`.
 */
export async function readLastOutboundGapCloseRun(): Promise<LastOutboundGapCloseRunRead> {
  let raw: string | undefined;
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    raw = row?.value?.trim();
  } catch (err: any) {
    // The settings read itself threw — this is an unknown/error state,
    // NOT a confirmed "never ran". Surface it as unreadable.
    const message = err?.message ?? String(err);
    console.warn(
      `[FrontOutboundGapClose] Failed to read last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }

  if (!raw) return { lastRun: null, status: "never_run" };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as OutboundGapCloseTickResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.warn(`[FrontOutboundGapClose] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.warn(
      `[FrontOutboundGapClose] Failed to parse last-run summary: ${message}`,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * Read the persisted last-run summary, or null if the closer has not
 * run yet (or the stored value is unparseable). Thin back-compat wrapper
 * over {@link readLastOutboundGapCloseRun} that preserves the original
 * "null for both never-run and unreadable" contract.
 */
export async function getLastOutboundGapCloseRun(): Promise<OutboundGapCloseTickResult | null> {
  return (await readLastOutboundGapCloseRun()).lastRun;
}

/**
 * Task #2197 — proactively alert admins when the persisted last-run
 * summary goes corrupt.
 *
 * Task #2130 made {@link readLastOutboundGapCloseRun} classify an
 * unparseable persisted value as `unreadable` and surface it on the
 * operator panel. But an admin only sees that warning if they happen to
 * open the panel — a corrupt persisted value signals a real persistence
 * bug that deserves a proactive ping. This raises a deduped in-app /
 * opt-in Slack-DM notification (the per-user inbox path) to the
 * integrations owners (CEO / team_lead) so the regression isn't missed.
 *
 * Dedupe + cooldown: every recipient gets at most one UNREAD bell row per
 * stable {@link UNREADABLE_ALERT_DEDUPE_KEY} (notifyUser's DB-level
 * dedupe), and a persisted per-process cooldown bounds re-fires across
 * read/archive cycles so a persistent corruption re-detected every tick
 * can't flood the bell. Best-effort — never throws; an alert failure must
 * not fail the tick.
 */
export const UNREADABLE_ALERT_DEDUPE_KEY =
  "front-outbound-gap-close-last-run-unreadable";

/** Operator panel that hosts the gap-close readout (deep link target). */
const UNREADABLE_ALERT_DEEP_LINK = "/admin/front";

/** Cooldown (minutes) between repeat unreadable alerts. Overridable. */
export const SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES =
  "front_outbound_gap_close:unreadable_alert_cooldown_minutes";
/** When `"true"`, the corrupt-status admin alert is muted entirely
 * (no notification fires regardless of cooldown). Default OFF. */
export const SETTING_UNREADABLE_ALERT_MUTED =
  "front_outbound_gap_close:unreadable_alert_muted";
const SETTING_UNREADABLE_ALERT_LAST_AT =
  "front_outbound_gap_close:unreadable_alert_last_at";
export const DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES = 60;
/** Lower / upper bounds for the operator-tunable cooldown (minutes).
 * Floor 1 min; ceiling one week so a typo can't silence alerts for
 * months — use the explicit mute flag for that instead. */
export const MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES = 1;
export const MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES = 10080;

export type UnreadableLastRunAlertDecision =
  | "alerted"
  | "skipped_not_unreadable"
  | "skipped_cooldown"
  | "skipped_muted"
  | "skipped_no_recipients"
  | "skipped_error";

export interface UnreadableLastRunAlertResult {
  decision: UnreadableLastRunAlertDecision;
  recipientCount: number;
  cooldownMinutes: number;
  skipReason?: string;
}

// Test seams — let unit tests stub the recipient resolver + notifier
// without a DB (mirrors integrationTokenClearedAlerts.ts).
type ResolveAlertRecipientsFn = () => Promise<string[]>;
type NotifyUserFn = typeof import("./notifications/userInbox").notifyUser;
let resolveAlertRecipientsOverride: ResolveAlertRecipientsFn | null = null;
let notifyUserOverride: NotifyUserFn | null = null;

async function getUnreadableAlertCooldownMinutes(): Promise<number> {
  const raw = (
    await getSystemSetting(SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES).catch(
      () => null,
    )
  )?.value;
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0)
    return DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES;
  return n;
}

async function getUnreadableAlertMuted(): Promise<boolean> {
  const raw = (
    await getSystemSetting(SETTING_UNREADABLE_ALERT_MUTED).catch(() => null)
  )?.value;
  return String(raw ?? "").trim().toLowerCase() === "true";
}

export interface UnreadableAlertConfig {
  /** Effective cooldown (minutes) the closer enforces between alerts. */
  cooldownMinutes: number;
  /** When true, the alert never fires regardless of cooldown. */
  muted: boolean;
  /** Cooldown the closer falls back to when nothing is persisted. */
  defaultCooldownMinutes: number;
  /** Inclusive bounds the operator UI / route must keep edits within. */
  minCooldownMinutes: number;
  maxCooldownMinutes: number;
}

/**
 * Read the operator-tunable corrupt-status alert config (cooldown +
 * mute) so the Front integration panel can display and edit it without
 * touching the raw system settings. Never throws — a read failure
 * degrades to the defaults.
 */
export async function readUnreadableAlertConfig(): Promise<UnreadableAlertConfig> {
  const [cooldownMinutes, muted] = await Promise.all([
    getUnreadableAlertCooldownMinutes().catch(
      () => DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES,
    ),
    getUnreadableAlertMuted().catch(() => false),
  ]);
  return {
    cooldownMinutes,
    muted,
    defaultCooldownMinutes: DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES,
    minCooldownMinutes: MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES,
    maxCooldownMinutes: MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES,
  };
}

/**
 * Persist an operator override of the corrupt-status alert config.
 * Either or both fields may be supplied. The cooldown is validated to
 * the documented bounds; `muted` is stored as a `"true"`/`"false"`
 * string. Returns the resulting effective config. Throws a
 * `RangeError` on an out-of-bounds / non-integer cooldown so the route
 * can map it to a 400.
 */
export async function setUnreadableAlertConfig(
  patch: { cooldownMinutes?: number; muted?: boolean },
  userId?: string,
): Promise<UnreadableAlertConfig> {
  if (patch.cooldownMinutes !== undefined) {
    const n = patch.cooldownMinutes;
    if (
      !Number.isInteger(n) ||
      n < MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES ||
      n > MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES
    ) {
      throw new RangeError(
        `cooldownMinutes must be an integer between ${MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES} and ${MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES}`,
      );
    }
    await setSystemSetting(
      SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES,
      String(n),
      userId,
    );
  }
  if (patch.muted !== undefined) {
    await setSystemSetting(
      SETTING_UNREADABLE_ALERT_MUTED,
      patch.muted ? "true" : "false",
      userId,
    );
  }
  return readUnreadableAlertConfig();
}

/**
 * Raise a deduped admin alert iff the persisted last-run summary is
 * currently `unreadable`. Honors a persisted cooldown. Returns a decision
 * describing what happened. Never throws.
 */
export async function alertIfLastRunUnreadable(): Promise<UnreadableLastRunAlertResult> {
  const cooldownMinutes = await getUnreadableAlertCooldownMinutes().catch(
    () => DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES,
  );
  try {
    const read = await readLastOutboundGapCloseRun();
    if (read.status !== "unreadable") {
      return {
        decision: "skipped_not_unreadable",
        recipientCount: 0,
        cooldownMinutes,
      };
    }

    // Operator mute: an admin can silence this alert entirely from the
    // Front integration panel without disabling the closer itself. The
    // corrupt status still surfaces on the panel readout — only the
    // proactive ping is suppressed.
    const muted = await getUnreadableAlertMuted().catch(() => false);
    if (muted) {
      return {
        decision: "skipped_muted",
        recipientCount: 0,
        cooldownMinutes,
        skipReason: "corrupt-status alert is muted",
      };
    }

    const now = Date.now();
    const cooldownMs = cooldownMinutes * 60_000;
    const lastRow = await getSystemSetting(
      SETTING_UNREADABLE_ALERT_LAST_AT,
    ).catch(() => null);
    const last = Number(lastRow?.value ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < cooldownMs) {
      return {
        decision: "skipped_cooldown",
        recipientCount: 0,
        cooldownMinutes,
        skipReason: `last alert ${Math.floor((now - last) / 60_000)}m ago < ${cooldownMinutes}m`,
      };
    }

    const resolveRecipients =
      resolveAlertRecipientsOverride ??
      (await import("./notifications/recipients"))
        .getResponsibleAdminsForAlert;
    const recipients = await resolveRecipients();
    if (recipients.length === 0) {
      return {
        decision: "skipped_no_recipients",
        recipientCount: 0,
        cooldownMinutes,
        skipReason: "no ceo/team_lead recipients resolved",
      };
    }

    const notifyUser =
      notifyUserOverride ??
      (await import("./notifications/userInbox")).notifyUser;

    const errorSuffix = read.error ? ` (${read.error})` : "";
    const title = "Outbound gap-close: saved status is corrupt";
    const body =
      `The Front outbound gap-close driver's saved last-run summary ` +
      `could not be read back${errorSuffix}. This signals a persistence ` +
      `bug — open the Front integration panel to review the readout and ` +
      `confirm the closer is still running.`;

    let delivered = 0;
    for (const uid of recipients) {
      try {
        await notifyUser(uid, {
          category: "system",
          title,
          body,
          deepLink: UNREADABLE_ALERT_DEEP_LINK,
          dedupeKey: UNREADABLE_ALERT_DEDUPE_KEY,
          metadata: { error: read.error ?? null },
        });
        delivered += 1;
      } catch (err: any) {
        console.warn(
          `[FrontOutboundGapClose] unreadable-alert notifyUser(${uid}) failed: ${err?.message ?? err}`,
        );
      }
    }

    // Only consume the cooldown if at least one recipient was actually
    // notified — otherwise a transient notification-pipeline outage would
    // suppress retries for the whole cooldown window.
    if (delivered === 0) {
      return {
        decision: "skipped_error",
        recipientCount: 0,
        cooldownMinutes,
        skipReason: "all notifyUser calls failed",
      };
    }

    try {
      await setSystemSetting(SETTING_UNREADABLE_ALERT_LAST_AT, String(now));
    } catch (err: any) {
      console.warn(
        `[FrontOutboundGapClose] failed to persist unreadable-alert cooldown: ${err?.message ?? err}`,
      );
    }

    return {
      decision: "alerted",
      recipientCount: delivered,
      cooldownMinutes,
    };
  } catch (err: any) {
    console.error(
      `[FrontOutboundGapClose] unreadable-alert dispatch failed: ${err?.message ?? err}`,
    );
    return {
      decision: "skipped_error",
      recipientCount: 0,
      cooldownMinutes,
      skipReason: `error:${err?.message ?? "unknown"}`,
    };
  }
}

export const __testHelpers = {
  setResolveAlertRecipients(fn: ResolveAlertRecipientsFn | null): void {
    resolveAlertRecipientsOverride = fn;
  },
  setNotifyUser(fn: NotifyUserFn | null): void {
    notifyUserOverride = fn;
  },
};

/**
 * One close-gap pass. Reads gap months, re-verifies each gap against a
 * fresh local count, and drives the still-real ones through the
 * historical-recovery ingestion pipeline (bounded by the per-tick
 * budget). Never throws on a per-month recovery failure — the next
 * tick retries. Persists the summary as the last-run readout before
 * returning.
 */
export async function runOutboundGapCloseTick(opts?: {
  now?: Date;
  /** When set, scope the run to this single month (YYYY-MM) instead of
   * the worst-gap-first per-tick budget (Task #2057 operator action). */
  month?: string;
}): Promise<OutboundGapCloseTickResult> {
  const result = await computeOutboundGapCloseTick(opts);
  await persistLastRun(result);
  return result;
}

async function computeOutboundGapCloseTick(opts?: {
  now?: Date;
  month?: string;
}): Promise<OutboundGapCloseTickResult> {
  const now = opts?.now ?? new Date();
  const scopedMonth = opts?.month;
  const enabled = parseBool(
    (await getSystemSetting(SETTING_ENABLED).catch(() => null))?.value,
    false,
  );
  const paused = isQueuePaused(QUEUE_NAME);
  const materializationEnabled = isPoolEpicSwitchEnabled(
    REQUIRED_MATERIALIZATION_SWITCH,
  );
  const maxMonthsPerTick = await loadMaxMonthsPerTick();
  const result: OutboundGapCloseTickResult = {
    ranAt: now.toISOString(),
    enabled,
    paused,
    materializationEnabled,
    maxMonthsPerTick,
    candidateMonths: 0,
    attempted: [],
    ...(scopedMonth ? { scopedMonth } : {}),
  };

  if (!enabled) {
    result.reason = "close-gap disabled in system_settings";
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
  // Hard-gap reason: recovery cannot write per-message outbound rows
  // unless this switch is ON, so spawning recovery jobs would be wasted
  // Front budget. Surface it instead.
  if (!materializationEnabled) {
    result.reason = `per-message materialization disabled (flip ${REQUIRED_MATERIALIZATION_SWITCH} ON to enable close-gap)`;
    return result;
  }

  // Operator-scoped run (Task #2057): re-drive exactly the one month the
  // operator chose from the gap-months table, regardless of the
  // per-tick budget or its current stored gap. The shared per-month
  // re-verify below still decides the outcome (e.g. `already_closed`).
  const candidates = scopedMonth
    ? await selectOutboundGapMonthsForMonth(scopedMonth)
    : await selectOutboundGapMonths(maxMonthsPerTick);
  result.candidateMonths = candidates.length;
  if (candidates.length === 0) {
    result.reason = scopedMonth
      ? `month ${scopedMonth} has no coverage row to re-drive`
      : "no months with messages_outbound_gap > 0";
    return result;
  }

  const { runHistoricalRecovery } = await import("./frontHistoricalRecovery");

  for (const m of candidates) {
    // Re-verify the gap is still real with a fresh local count — the
    // stored gap can be stale if ingestion already caught up.
    const freshLocal = await countOutboundLocalForMonth(
      m.monthStart,
      m.monthEnd,
    );
    if (m.messagesOutboundFront == null) {
      result.attempted.push({
        month: m.month,
        outcome: "front_count_unknown",
        remainingGap: null,
      });
      continue;
    }
    const remainingGap = Math.max(0, m.messagesOutboundFront - freshLocal);
    if (remainingGap <= 0) {
      result.attempted.push({
        month: m.month,
        outcome: "already_closed",
        remainingGap: 0,
      });
      continue;
    }

    const afterTimestamp = Math.floor(m.monthStart.getTime() / 1000);
    const beforeTimestamp = Math.floor(m.monthEnd.getTime() / 1000);
    try {
      const jobId = await runHistoricalRecovery({
        customWindows: [
          {
            label: `outbound-gap-${m.month}`,
            afterTimestamp,
            beforeTimestamp,
          },
        ],
        // Restart from page 1 so a previously-checkpointed window does
        // not short-circuit; the per-message dedupe makes a full re-walk
        // idempotent.
        resumeMode: "clear_checkpoints",
      });
      result.attempted.push({
        month: m.month,
        outcome: "recovery_triggered",
        remainingGap,
        recoveryJobId: jobId,
      });
    } catch (err: any) {
      // Recovery concurrency cap reached — stop here, the next tick
      // resumes. This is expected back-pressure, not an error.
      if (
        err?.code === "RECOVERY_CAP_REACHED" ||
        /cap reached|already running/i.test(err?.message ?? "")
      ) {
        result.attempted.push({
          month: m.month,
          outcome: "deferred_recovery_cap",
          remainingGap,
        });
        result.reason = "recovery concurrency cap reached; deferred remaining months";
        break;
      }
      // Any other recovery failure: log and move on (non-throwing).
      console.warn(
        `[FrontOutboundGapClose] month=${m.month} recovery trigger failed: ${
          err?.message ?? err
        }`,
      );
      result.attempted.push({
        month: m.month,
        outcome: "deferred_recovery_cap",
        remainingGap,
      });
    }
  }

  return result;
}

async function enqueueScheduledTick(): Promise<void> {
  try {
    if (isQueuePaused(QUEUE_NAME)) {
      console.log(
        `[FrontOutboundGapClose] enqueue_skipped_queue_paused queue=${QUEUE_NAME} reason=queue_drain_state ts=${new Date().toISOString()}`,
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
      `[FrontOutboundGapClose] enqueue scheduled tick failed: ${
        err?.message ?? err
      }`,
    );
  }
}

export function startFrontOutboundGapCloseScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void enqueueScheduledTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `[FrontOutboundGapClose] enqueue scheduler started (every ${
      TICK_INTERVAL_MS / 60_000
    }min; default OFF via ${SETTING_ENABLED}) — work runs in worker pool via ${QUEUE_NAME} queue`,
  );
}

export function stopFrontOutboundGapCloseScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __frontOutboundGapCloseTestHelpers = {
  enqueueScheduledTick,
  loadMaxMonthsPerTick,
};
