import { isConnected as isSlackConnected, postMessage } from "./slackIntegration";
import { loadAlertNotifyConfig } from "./rateLimitAlertNotifier";
import type { Alert } from "./healthMetrics";
import { getSystemSetting, setSystemSetting, deleteSystemSetting } from "../storage/settingsStorage";
import {
  insertManualReserveAlertDispatches,
  listManualReserveAlertDispatches,
  pruneManualReserveAlertDispatches,
  type ListManualReserveAlertDispatchesOpts,
} from "../storage/healthMetricsStorage";
import type { InsertManualReserveAlertDispatch } from "@shared/schema";

// Fallback override for environments that haven't configured the centralized
// alert channel via the admin UI (system_settings). The primary configuration
// path is the same one used by other alerts — see loadAlertNotifyConfig().
const SLACK_CHANNEL_ENV_OVERRIDE = "HEALTH_ALERTS_SLACK_CHANNEL_ID";
const COOLDOWN_MS = 15 * 60_000;

const lastSentAt = new Map<string, number>();
const lastMutedAuditAt = new Map<string, number>();

const MUTE_SETTING_KEY = "manual_reserve_alert_mute";
const MAX_MUTE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days hard cap

export type ManualReserveMuteSource = "manual" | "auto";

export interface ManualReserveMuteState {
  muted: boolean;
  mutedUntil: number | null;
  mutedAt: number | null;
  mutedBy: string | null;
  reason: string | null;
  source: ManualReserveMuteSource | null;
  jobId: string | null;
  jobLabel: string | null;
}

interface StoredMute {
  mutedUntil: number;
  mutedAt: number;
  mutedBy: string | null;
  reason: string | null;
  source: ManualReserveMuteSource;
  jobId: string | null;
  jobLabel: string | null;
}

const EMPTY_STATE: ManualReserveMuteState = {
  muted: false,
  mutedUntil: null,
  mutedAt: null,
  mutedBy: null,
  reason: null,
  source: null,
  jobId: null,
  jobLabel: null,
};

function parseStored(raw: string | null | undefined): StoredMute | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.mutedUntil === "number" &&
      typeof parsed.mutedAt === "number"
    ) {
      const source: ManualReserveMuteSource =
        parsed.source === "auto" ? "auto" : "manual";
      return {
        mutedUntil: parsed.mutedUntil,
        mutedAt: parsed.mutedAt,
        mutedBy: typeof parsed.mutedBy === "string" ? parsed.mutedBy : null,
        reason: typeof parsed.reason === "string" ? parsed.reason : null,
        source,
        jobId: typeof parsed.jobId === "string" ? parsed.jobId : null,
        jobLabel: typeof parsed.jobLabel === "string" ? parsed.jobLabel : null,
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}

export async function getManualReserveMuteState(now = Date.now()): Promise<ManualReserveMuteState> {
  let row;
  try {
    row = await getSystemSetting(MUTE_SETTING_KEY);
  } catch (err: any) {
    console.warn("[manual-reserve-alerts] Failed to load mute state:", err?.message || err);
    return EMPTY_STATE;
  }
  const stored = parseStored(row?.value);
  if (!stored) return EMPTY_STATE;
  const muted = stored.mutedUntil > now;
  return {
    muted,
    mutedUntil: stored.mutedUntil,
    mutedAt: stored.mutedAt,
    mutedBy: stored.mutedBy,
    reason: stored.reason,
    source: stored.source,
    jobId: stored.jobId,
    jobLabel: stored.jobLabel,
  };
}

export async function isManualReserveAlertMuted(now = Date.now()): Promise<boolean> {
  const state = await getManualReserveMuteState(now);
  return state.muted;
}

export async function setManualReserveMute(opts: {
  mutedUntil: number;
  mutedBy?: string | null;
  reason?: string | null;
  now?: number;
  source?: ManualReserveMuteSource;
  jobId?: string | null;
  jobLabel?: string | null;
}): Promise<ManualReserveMuteState> {
  const now = opts.now ?? Date.now();
  if (typeof opts.mutedUntil !== "number" || !Number.isFinite(opts.mutedUntil)) {
    throw new Error("mutedUntil must be a finite timestamp in ms");
  }
  if (opts.mutedUntil <= now) {
    throw new Error("mutedUntil must be in the future");
  }
  const cap = now + MAX_MUTE_DURATION_MS;
  if (opts.mutedUntil > cap) {
    throw new Error("mutedUntil exceeds the 7-day mute cap");
  }
  const reason = opts.reason && opts.reason.trim().length > 0
    ? opts.reason.trim().slice(0, 500)
    : null;
  const source: ManualReserveMuteSource = opts.source ?? "manual";
  const payload: StoredMute = {
    mutedUntil: Math.floor(opts.mutedUntil),
    mutedAt: now,
    mutedBy: opts.mutedBy ?? null,
    reason,
    source,
    jobId: opts.jobId ?? null,
    jobLabel: opts.jobLabel ?? null,
  };
  await setSystemSetting(MUTE_SETTING_KEY, JSON.stringify(payload), opts.mutedBy ?? undefined);
  return {
    muted: true,
    mutedUntil: payload.mutedUntil,
    mutedAt: payload.mutedAt,
    mutedBy: payload.mutedBy,
    reason: payload.reason,
    source: payload.source,
    jobId: payload.jobId,
    jobLabel: payload.jobLabel,
  };
}

export async function clearManualReserveMute(): Promise<ManualReserveMuteState> {
  try {
    await deleteSystemSetting(MUTE_SETTING_KEY);
  } catch (err: any) {
    console.warn("[manual-reserve-alerts] Failed to clear mute state:", err?.message || err);
  }
  return EMPTY_STATE;
}

// ─── Mute-window end Slack summary (Task #1195) ──────────────────────────
//
// When a manual-reserve mute window ends (timer expiry detected by the
// healthMetrics sampler, manual unmute via DELETE /api/health/manual-reserve-mute,
// or auto-clear by a backfill job releasing its own mute) we post one Slack
// recap summarizing what was suppressed during the window so on-call admins
// don't have to remember to open the dashboard.
//
// Routing reuses the existing centralized alert channel (the same
// `usage.manual_reserve.starvation` notification id used by live alerts).
// We bypass the dispatcher's dedupe so this end-of-window post is never
// collapsed against the live alerts that fired right before the mute.

export type ManualReserveMuteEndReason =
  | "expired"
  | "cleared_manual"
  | "cleared_auto";

export interface EndedManualReserveMute {
  mutedAt: number;
  mutedUntil: number;
  mutedBy: string | null;
  reason: string | null;
  source: ManualReserveMuteSource;
  jobId: string | null;
  jobLabel: string | null;
}

// In-memory dedupe so we don't double-post for the same mute window even if
// the natural-expiry poll and an explicit clear race against each other.
// Keyed by `mutedAt` since that's the unique identifier of a mute window.
const announcedMuteEnds = new Set<number>();
const ANNOUNCED_MUTE_ENDS_CAP = 100;

function rememberAnnouncedMuteEnd(mutedAt: number): void {
  announcedMuteEnds.add(mutedAt);
  if (announcedMuteEnds.size > ANNOUNCED_MUTE_ENDS_CAP) {
    // Drop the oldest insertion (Sets preserve insertion order).
    const first = announcedMuteEnds.values().next().value;
    if (first !== undefined) announcedMuteEnds.delete(first);
  }
}

export function __resetManualReserveMuteEndDedupForTest(): void {
  announcedMuteEnds.clear();
}

// Test-only seam: lets unit tests inject a fake dispatcher so the mute-end
// recap can be exercised without standing up Slack. Production never sets
// this — we fall back to the real `notifyByType` import.
type MuteEndDispatcherFn = (
  id: string,
  payload: { text: string; blocks?: any[]; preview?: any },
  opts: { triggerSource?: string; bypassDedupe?: boolean; metadata?: any },
) => Promise<{
  delivered: boolean;
  status?: string;
  channelId?: string | null;
  skipReason?: string;
  error?: string;
}>;
let __muteEndDispatcherOverride: MuteEndDispatcherFn | null = null;
export function __test_setMuteEndDispatcherOverride(
  fn: MuteEndDispatcherFn | null,
): void {
  __muteEndDispatcherOverride = fn;
}

function fmtTsShort(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function endReasonLabel(reason: ManualReserveMuteEndReason): string {
  switch (reason) {
    case "expired":
      return "expired";
    case "cleared_manual":
      return "cleared by operator";
    case "cleared_auto":
      return "auto-cleared by backfill";
  }
}

interface SuppressedAggregate {
  metric: string;
  severity: ManualReserveAlertDispatch["severity"];
  count: number;
  maxValue: number;
  threshold: number;
}

interface SuppressedSummary {
  total: number;
  perKey: SuppressedAggregate[];
  highest: {
    metric: string;
    severity: ManualReserveAlertDispatch["severity"];
    value: number;
    threshold: number;
    message: string;
  } | null;
  windowStart: number;
  windowEnd: number;
}

function buildSuppressedSummary(
  endedMute: EndedManualReserveMute,
  endedAt: number,
  rows: Array<{
    timestamp: number | bigint;
    metric: string;
    severity: string;
    value: number;
    threshold: number;
    message: string;
    eventType: string;
  }>,
): SuppressedSummary {
  const perKeyMap = new Map<string, SuppressedAggregate>();
  let highest: SuppressedSummary["highest"] = null;
  let highestVal = -Infinity;
  for (const r of rows) {
    const key = `${r.metric}:${r.severity}`;
    let agg = perKeyMap.get(key);
    if (!agg) {
      agg = {
        metric: r.metric,
        severity: r.severity as ManualReserveAlertDispatch["severity"],
        count: 0,
        maxValue: r.value,
        threshold: r.threshold,
      };
      perKeyMap.set(key, agg);
    }
    agg.count += 1;
    if (r.value > agg.maxValue) agg.maxValue = r.value;
    if (r.value > highestVal) {
      highestVal = r.value;
      highest = {
        metric: r.metric,
        severity: r.severity as ManualReserveAlertDispatch["severity"],
        value: r.value,
        threshold: r.threshold,
        message: r.message,
      };
    }
  }
  const perKey = Array.from(perKeyMap.values()).sort(
    (a, b) =>
      // criticals first, then by count desc, then metric name
      (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1) ||
      b.count - a.count ||
      a.metric.localeCompare(b.metric),
  );
  return {
    total: rows.length,
    perKey,
    highest,
    windowStart: endedMute.mutedAt,
    windowEnd: endedAt,
  };
}

function formatMuteEndedText(
  endedMute: EndedManualReserveMute,
  endReason: ManualReserveMuteEndReason,
  endedAt: number,
  summary: SuppressedSummary,
): string {
  const lines: string[] = [];
  lines.push(
    `:mute: *Manual-reserve mute ${endReasonLabel(endReason)}* — recap of suppressed alerts`,
  );
  lines.push(
    `Window: ${fmtTsShort(endedMute.mutedAt)} → ${fmtTsShort(endedAt)} ` +
      `(${fmtDurationMs(endedAt - endedMute.mutedAt)})`,
  );
  const muter = endedMute.mutedBy
    ? endedMute.mutedBy
    : endedMute.source === "auto"
      ? `auto (${endedMute.jobLabel ?? endedMute.jobId ?? "backfill"})`
      : "unknown";
  lines.push(`Muted by: ${muter}`);
  lines.push(`Reason: ${endedMute.reason ?? "(none provided)"}`);
  lines.push(
    `Suppressed: *${summary.total}* dispatch row(s) across *${summary.perKey.length}* metric/severity key(s).`,
  );
  if (summary.perKey.length > 0) {
    lines.push("*By metric × severity:*");
    for (const k of summary.perKey) {
      lines.push(
        `• \`${k.metric}\` (${k.severity}) — ${k.count} suppressed · peak ${k.maxValue} (thr ${k.threshold})`,
      );
    }
  }
  if (summary.highest) {
    lines.push(
      `Highest value seen: ${summary.highest.value} (thr ${summary.highest.threshold}) — ` +
        `\`${summary.highest.metric}\` ${summary.highest.severity}`,
    );
  }
  return lines.join("\n");
}

function formatMuteEndedBlocks(
  endedMute: EndedManualReserveMute,
  endReason: ManualReserveMuteEndReason,
  endedAt: number,
  summary: SuppressedSummary,
): any[] {
  const muter = endedMute.mutedBy
    ? endedMute.mutedBy
    : endedMute.source === "auto"
      ? `auto (${endedMute.jobLabel ?? endedMute.jobId ?? "backfill"})`
      : "unknown";
  const headerText =
    `:mute: *Manual-reserve mute ${endReasonLabel(endReason)}*\n` +
    `Window ${fmtTsShort(endedMute.mutedAt)} → ${fmtTsShort(endedAt)} ` +
    `(${fmtDurationMs(endedAt - endedMute.mutedAt)}) · ` +
    `${summary.total} suppressed alert dispatch(es) across ${summary.perKey.length} metric/severity key(s).`;
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: headerText } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Muted by*\n${muter}` },
        { type: "mrkdwn", text: `*Reason*\n${endedMute.reason ?? "(none)"}` },
      ],
    },
  ];
  if (summary.perKey.length > 0) {
    const fields = summary.perKey.slice(0, 10).map((k) => ({
      type: "mrkdwn" as const,
      text: `*${k.metric}* (${k.severity})\n${k.count} suppressed · peak ${k.maxValue} (thr ${k.threshold})`,
    }));
    blocks.push({ type: "section", fields });
  }
  if (summary.highest) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `Highest value seen during the window: ` +
            `*${summary.highest.value}* (thr ${summary.highest.threshold}) — ` +
            `\`${summary.highest.metric}\` ${summary.highest.severity}`,
        },
      ],
    });
  }
  return blocks;
}

export interface NotifyMuteWindowEndedResult {
  posted: boolean;
  suppressedCount: number;
  reason:
    | "already_announced"
    | "zero_suppressed"
    | "delivered"
    | "delivery_failed"
    | "skipped";
  status?: string;
  channelId?: string | null;
}

export async function notifyManualReserveMuteWindowEnded(
  endedMute: EndedManualReserveMute,
  endReason: ManualReserveMuteEndReason,
  now: number = Date.now(),
): Promise<NotifyMuteWindowEndedResult> {
  if (announcedMuteEnds.has(endedMute.mutedAt)) {
    return { posted: false, suppressedCount: 0, reason: "already_announced" };
  }

  // Pull every dispatch row written since the mute started, then keep only
  // the `muted` ones whose timestamp falls inside this mute window. Using
  // an upper bound of `min(endedAt, mutedUntil)` keeps the recap tight even
  // if a stray "muted" row sneaks in just after the boundary (e.g. a tick
  // racing the clear).
  const upperBound = Math.min(now, endedMute.mutedUntil);
  let rows: Awaited<ReturnType<typeof listManualReserveAlertDispatches>> = [];
  try {
    const list =
      __listManualReserveAlertDispatchesOverride ?? listManualReserveAlertDispatches;
    rows = await list({
      sinceTimestamp: endedMute.mutedAt,
      eventTypes: ["muted"],
      limit: 1000,
    });
  } catch (err: any) {
    console.warn(
      "[manual-reserve-alerts] mute-end recap: dispatch read failed; falling back to in-memory buffer:",
      err?.message || err,
    );
    rows = recentBuffer
      .filter(
        (r) =>
          r.eventType === "muted" &&
          r.timestamp >= endedMute.mutedAt &&
          r.timestamp <= upperBound,
      )
      .map((r) => ({
        id: 0,
        timestamp: r.timestamp,
        eventType: r.eventType,
        metric: r.metric,
        severity: r.severity,
        message: r.message,
        value: r.value,
        threshold: r.threshold,
        status: r.status,
        detail: r.detail ?? null,
        mutedBy: r.mutedBy ?? null,
        muteReason: r.muteReason ?? null,
        triggeredBy: r.triggeredBy ?? null,
        triggerSource: r.triggerSource ?? null,
        isResend: r.isResend ?? false,
      })) as any;
  }

  const inWindow = rows.filter((r) => {
    const ts = Number(r.timestamp);
    return ts >= endedMute.mutedAt && ts <= upperBound;
  });

  if (inWindow.length === 0) {
    rememberAnnouncedMuteEnd(endedMute.mutedAt);
    return { posted: false, suppressedCount: 0, reason: "zero_suppressed" };
  }

  rememberAnnouncedMuteEnd(endedMute.mutedAt);

  const summary = buildSuppressedSummary(endedMute, now, inWindow as any);
  const text = formatMuteEndedText(endedMute, endReason, now, summary);
  const blocks = formatMuteEndedBlocks(endedMute, endReason, now, summary);

  try {
    const dispatch =
      __muteEndDispatcherOverride ??
      (async (id, payload, opts) => {
        const { notifyByType } = await import("./notifications/dispatcher");
        return notifyByType(id as any, payload as any, opts as any);
      });
    const result = await dispatch(
      "usage.manual_reserve.starvation",
      {
        text,
        blocks,
        preview: {
          event: "mute_window_ended",
          endReason,
          suppressedCount: summary.total,
          metricKeys: summary.perKey.length,
        },
      },
      {
        triggerSource: "mute_ended",
        bypassDedupe: true,
        metadata: {
          endReason,
          mutedAt: endedMute.mutedAt,
          mutedUntil: endedMute.mutedUntil,
          suppressedCount: summary.total,
        },
      },
    );
    return {
      posted: result.delivered,
      suppressedCount: summary.total,
      reason: result.delivered ? "delivered" : "delivery_failed",
      status: result.status,
      channelId: result.channelId ?? null,
    };
  } catch (err: any) {
    console.warn(
      "[manual-reserve-alerts] mute-end recap dispatch failed:",
      err?.message || err,
    );
    return {
      posted: false,
      suppressedCount: summary.total,
      reason: "delivery_failed",
    };
  }
}

/**
 * Detect natural mute-window expiry and post a recap. Called from the
 * healthMetrics sampler tick so a mute that ages past `mutedUntil` triggers
 * the summary even when no operator action follows. Idempotent — the mute
 * row is cleared after the recap fires and the in-memory dedup prevents
 * double posts if the poll races with an explicit clear.
 */
export async function pollManualReserveMuteEnd(
  now: number = Date.now(),
): Promise<{ notified: boolean }> {
  let row;
  try {
    row = await getSystemSetting(MUTE_SETTING_KEY);
  } catch {
    return { notified: false };
  }
  const stored = parseStored(row?.value);
  if (!stored) return { notified: false };
  if (stored.mutedUntil > now) return { notified: false };
  const ended: EndedManualReserveMute = {
    mutedAt: stored.mutedAt,
    mutedUntil: stored.mutedUntil,
    mutedBy: stored.mutedBy,
    reason: stored.reason,
    source: stored.source,
    jobId: stored.jobId,
    jobLabel: stored.jobLabel,
  };
  // Clear first so subsequent ticks don't re-enter; the dedup set still
  // guards against the (very small) window where notify is in flight.
  await clearManualReserveMute();
  await notifyManualReserveMuteWindowEnded(ended, "expired", now);
  return { notified: true };
}

/**
 * Auto-mute helper for backfill workers (Task #726).
 *
 * Lets a known long-running backfill register a mute window for the duration
 * of its run so admins don't have to remember to click the manual mute button
 * before kicking it off. The mute carries the originating jobId/jobLabel so
 * the Health dashboard can show "auto-muted by job X" and the
 * matching `clearManualReserveMuteForBackfillJob` only clears its own mute.
 *
 * Precedence rules:
 *   - If an active manual mute exists, do NOT overwrite it (manual control
 *     is the override). Returns the existing state with `applied:false`.
 *   - If an active auto-mute exists for a different job, extend its window
 *     to `max(existing, new)` and take ownership (last writer wins). The
 *     prior owner's later clear will no-op (jobId mismatch) so we don't
 *     prematurely silence the new owner.
 *   - Otherwise, install a fresh auto-mute.
 *
 * The mute is hard-capped to MAX_MUTE_DURATION_MS so a crashed worker that
 * never reaches its `clearManualReserveMuteForBackfillJob` finally block
 * will still naturally expire within 7 days.
 */
export async function setManualReserveMuteForBackfillJob(opts: {
  jobId: string;
  jobLabel: string;
  durationMs: number;
  reason?: string | null;
  now?: number;
}): Promise<{ applied: boolean; state: ManualReserveMuteState }> {
  const now = opts.now ?? Date.now();
  if (!opts.jobId || typeof opts.jobId !== "string") {
    throw new Error("jobId is required");
  }
  if (!opts.jobLabel || typeof opts.jobLabel !== "string") {
    throw new Error("jobLabel is required");
  }
  if (
    typeof opts.durationMs !== "number" ||
    !Number.isFinite(opts.durationMs) ||
    opts.durationMs <= 0
  ) {
    throw new Error("durationMs must be a positive finite number");
  }
  const cappedDuration = Math.min(opts.durationMs, MAX_MUTE_DURATION_MS);
  let mutedUntil = now + cappedDuration;

  const existing = await getManualReserveMuteState(now);
  if (existing.muted && existing.source === "manual") {
    return { applied: false, state: existing };
  }
  const ownershipTransferFromJobId =
    existing.muted &&
    existing.source === "auto" &&
    existing.jobId &&
    existing.jobId !== opts.jobId
      ? existing.jobId
      : null;
  const ownershipTransferFromJobLabel =
    ownershipTransferFromJobId ? existing.jobLabel ?? ownershipTransferFromJobId : null;
  if (
    existing.muted &&
    existing.source === "auto" &&
    typeof existing.mutedUntil === "number" &&
    existing.mutedUntil > mutedUntil
  ) {
    mutedUntil = existing.mutedUntil;
  }

  const reason =
    opts.reason && opts.reason.trim().length > 0
      ? opts.reason.trim().slice(0, 500)
      : `Auto-muted for ${opts.jobLabel}`;
  const state = await setManualReserveMute({
    mutedUntil,
    mutedBy: null,
    reason,
    now,
    source: "auto",
    jobId: opts.jobId,
    jobLabel: opts.jobLabel,
  });
  // Audit-trail: a prior auto-owner has been silently displaced (#1200).
  // Record the implicit release so the timeline doesn't look like the prior
  // job is still muting alerts.
  if (ownershipTransferFromJobId) {
    recordAutoMuteTransition(
      "auto_unmuted",
      ownershipTransferFromJobId,
      ownershipTransferFromJobLabel ?? ownershipTransferFromJobId,
      `Released — ownership transferred to ${opts.jobLabel}`,
      null,
    );
  }
  recordAutoMuteTransition(
    "auto_muted",
    opts.jobId,
    opts.jobLabel,
    reason,
    state.mutedUntil,
  );
  return { applied: true, state };
}

/**
 * Inverse of `setManualReserveMuteForBackfillJob`. Only clears the mute
 * if the currently-stored mute is an auto-mute owned by `jobId`. A no-op
 * when:
 *   - the mute has already expired or been cleared,
 *   - an operator has installed a manual override mute, or
 *   - a different (more recent) backfill has taken ownership.
 */
export async function clearManualReserveMuteForBackfillJob(
  jobId: string,
): Promise<{ cleared: boolean; state: ManualReserveMuteState }> {
  if (!jobId) return { cleared: false, state: EMPTY_STATE };
  const existing = await getManualReserveMuteState();
  if (
    existing.muted &&
    existing.source === "auto" &&
    existing.jobId === jobId &&
    existing.mutedAt !== null &&
    existing.mutedUntil !== null
  ) {
    const ended: EndedManualReserveMute = {
      mutedAt: existing.mutedAt,
      mutedUntil: existing.mutedUntil,
      mutedBy: existing.mutedBy,
      reason: existing.reason,
      source: existing.source,
      jobId: existing.jobId,
      jobLabel: existing.jobLabel,
    };
    const cleared = await clearManualReserveMute();
    // Audit-trail row first (synchronous push to in-memory buffer + best-
    // effort DB persist) so the timeline always reflects the release.
    recordAutoMuteTransition(
      "auto_unmuted",
      jobId,
      existing.jobLabel ?? jobId,
      existing.reason,
      null,
    );
    // Best-effort recap; don't block the caller's release path on Slack.
    void notifyManualReserveMuteWindowEnded(ended, "cleared_auto").catch((err) =>
      console.warn(
        "[manual-reserve-alerts] auto-clear recap dispatch failed:",
        err?.message || err,
      ),
    );
    return { cleared: true, state: cleared };
  }
  return { cleared: false, state: existing };
}

export type ManualReserveAlertDispatchStatus =
  | "sent"
  | "failed"
  | "not_configured"
  | "muted"
  | "transition";
export type ManualReserveAlertEventType =
  | "alert"
  | "muted"
  | "backed_up"
  | "all_clear"
  | "auto_muted"
  | "auto_unmuted";

export type ManualReserveAlertDispatch = {
  timestamp: number;
  eventType: ManualReserveAlertEventType;
  metric: string;
  severity: Alert["severity"] | "info";
  message: string;
  value: number;
  threshold: number;
  status: ManualReserveAlertDispatchStatus;
  detail?: string | null;
  mutedBy?: string | null;
  muteReason?: string | null;
  // For operator-initiated resends: identifies who pressed the button and the
  // source (e.g. "admin_ui"), and flags the dispatch as a resend. Undefined
  // for the original auto-fired dispatch. Task #798: persisted to the
  // `manual_reserve_alert_dispatches.triggered_by/trigger_source/is_resend`
  // columns so the Health dashboard can render
  // "Last resend by … at … (source)" inline next to retried rows.
  triggeredBy?: string | null;
  triggerSource?: string | null;
  isResend?: boolean;
};

// Last in-memory dispatches written through, used as a hot cache and as a
// fallback if the DB write fails or the table is not yet provisioned.
const RECENT_BUFFER_CAPACITY = 200;
const recentBuffer: ManualReserveAlertDispatch[] = [];

function pushBuffer(d: ManualReserveAlertDispatch): void {
  recentBuffer.push(d);
  if (recentBuffer.length > RECENT_BUFFER_CAPACITY) {
    recentBuffer.splice(0, recentBuffer.length - RECENT_BUFFER_CAPACITY);
  }
}

async function persistDispatches(rows: ManualReserveAlertDispatch[]): Promise<void> {
  if (rows.length === 0) return;
  for (const r of rows) pushBuffer(r);
  try {
    const records: InsertManualReserveAlertDispatch[] = rows.map((r) => ({
      timestamp: r.timestamp,
      eventType: r.eventType,
      metric: r.metric,
      severity: r.severity,
      message: r.message,
      value: Math.round(r.value),
      threshold: Math.round(r.threshold),
      status: r.status,
      detail: r.detail ?? null,
      mutedBy: r.mutedBy ?? null,
      muteReason: r.muteReason ?? null,
      triggeredBy: r.triggeredBy ?? null,
      triggerSource: r.triggerSource ?? null,
      isResend: r.isResend ?? false,
    }));
    await insertManualReserveAlertDispatches(records);
  } catch (err: any) {
    console.warn(
      "[manual-reserve-alerts] persist failed (kept in-memory only):",
      err?.message || err,
    );
  }
}

function recordDispatches(
  alerts: Alert[],
  status: ManualReserveAlertDispatchStatus,
  detail?: string,
  opts?: {
    eventType?: ManualReserveAlertEventType;
    mutedBy?: string | null;
    muteReason?: string | null;
    triggeredBy?: string | null;
    triggerSource?: string | null;
    isResend?: boolean;
  },
): void {
  const ts = Date.now();
  const evt = opts?.eventType ?? "alert";
  const rows: ManualReserveAlertDispatch[] = alerts.map((a) => ({
    timestamp: ts,
    eventType: evt,
    metric: a.metric,
    severity: a.severity,
    message: a.message,
    value: a.value,
    threshold: a.threshold,
    status,
    detail: detail ?? null,
    mutedBy: opts?.mutedBy ?? null,
    muteReason: opts?.muteReason ?? null,
    ...(opts?.triggeredBy !== undefined ? { triggeredBy: opts.triggeredBy } : {}),
    ...(opts?.triggerSource !== undefined ? { triggerSource: opts.triggerSource } : {}),
    ...(opts?.isResend ? { isResend: true } : {}),
  }));
  // Fire-and-forget; the in-memory buffer is updated synchronously inside
  // persistDispatches before the DB write.
  void persistDispatches(rows);
}

/**
 * Records a single state-transition event ("backed_up" | "all_clear") so the
 * audit timeline shows when manual-reserve alerts started and stopped firing
 * (#737). Called once from healthMetrics.collectSample on each transition.
 */
export function recordManualReserveTransition(
  eventType: "backed_up" | "all_clear",
  contextMessage: string,
): void {
  const ts = Date.now();
  const row: ManualReserveAlertDispatch = {
    timestamp: ts,
    eventType,
    metric: eventType === "backed_up" ? "reserve_pressure_started" : "reserve_pressure_cleared",
    severity: "info",
    message: contextMessage,
    value: 0,
    threshold: 0,
    status: "transition",
    detail: null,
  };
  void persistDispatches([row]);
}

/**
 * Records an auto-mute install / release transition row in the dispatch
 * audit history (Task #1200). Lets operators distinguish a backfill-induced
 * quiet period from an operator-initiated mute when scrolling history. The
 * jobLabel/jobId are stamped onto `mutedBy` (label) and `detail` (id) so the
 * Health dashboard can render "auto-muted by <label>" inline without
 * widening the schema.
 *
 * Manual mutes/unmutes already surface via the operator-driven setting flow
 * and are intentionally NOT stamped here — only the auto path needs an audit
 * row because its install/release happens silently inside a background
 * worker.
 */
function recordAutoMuteTransition(
  eventType: "auto_muted" | "auto_unmuted",
  jobId: string,
  jobLabel: string,
  reason: string | null,
  mutedUntil: number | null,
): void {
  const ts = Date.now();
  const detailParts: string[] = [`jobId=${jobId}`];
  if (eventType === "auto_muted" && typeof mutedUntil === "number") {
    detailParts.push(`until ${new Date(mutedUntil).toISOString()}`);
  }
  const row: ManualReserveAlertDispatch = {
    timestamp: ts,
    eventType,
    metric: eventType === "auto_muted" ? "auto_mute_installed" : "auto_mute_released",
    severity: "info",
    message:
      eventType === "auto_muted"
        ? `Auto-muted by ${jobLabel}`
        : `Auto-mute released by ${jobLabel}`,
    value: 0,
    threshold: 0,
    status: "transition",
    detail: detailParts.join(" "),
    mutedBy: jobLabel,
    muteReason: reason,
  };
  void persistDispatches([row]);
}

// Test-only seam (Task #1186): allow tests to override the DB-backed list
// helper so the in-memory fallback path can be exercised deterministically.
type ListManualReserveAlertDispatchesFn = typeof listManualReserveAlertDispatches;
let __listManualReserveAlertDispatchesOverride: ListManualReserveAlertDispatchesFn | null = null;
export function __test_setListManualReserveAlertDispatchesOverride(
  fn: ListManualReserveAlertDispatchesFn | null,
): void {
  __listManualReserveAlertDispatchesOverride = fn;
}

export async function getRecentManualReserveAlertDispatches(
  limitOrOpts: number | (ListManualReserveAlertDispatchesOpts & { limit?: number }) = 50,
): Promise<ManualReserveAlertDispatch[]> {
  const opts: ListManualReserveAlertDispatchesOpts =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
  try {
    const list = __listManualReserveAlertDispatchesOverride ?? listManualReserveAlertDispatches;
    const rows = await list({ ...opts, limit });
    return rows.map((r) => ({
      timestamp: Number(r.timestamp),
      eventType: r.eventType as ManualReserveAlertEventType,
      metric: r.metric,
      severity: r.severity as ManualReserveAlertDispatch["severity"],
      message: r.message,
      value: r.value,
      threshold: r.threshold,
      status: r.status as ManualReserveAlertDispatchStatus,
      detail: r.detail ?? null,
      mutedBy: r.mutedBy ?? null,
      muteReason: r.muteReason ?? null,
      triggeredBy: r.triggeredBy ?? null,
      triggerSource: r.triggerSource ?? null,
      isResend: r.isResend ?? false,
    }));
  } catch (err: any) {
    console.warn(
      "[manual-reserve-alerts] DB read failed; serving in-memory buffer:",
      err?.message || err,
    );
    return recentBuffer.slice(-limit).reverse();
  }
}

export async function pruneOldManualReserveAlertDispatches(retentionMs: number): Promise<number> {
  try {
    const cutoff = Date.now() - retentionMs;
    return await pruneManualReserveAlertDispatches(cutoff);
  } catch (err: any) {
    console.warn("[manual-reserve-alerts] prune failed:", err?.message || err);
    return 0;
  }
}

function alertKey(a: Alert): string {
  return `${a.metric}:${a.severity}`;
}

function buildPlainText(alerts: Alert[]): string {
  return (
    `Manual sync reserve pressure detected:\n` +
    alerts.map(a => `- [${a.severity.toUpperCase()}] ${a.message}`).join("\n")
  );
}

function buildBlocks(alerts: Alert[]): any[] {
  const critical = alerts.some(a => a.severity === "critical");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          (critical ? ":rotating_light: " : ":warning: ") +
          `*Manual sync reserve threshold breached*\n` +
          `User-triggered (Sync Now) ingestion is being starved by background work.`,
      },
    },
    {
      type: "section",
      fields: alerts.map(a => ({
        type: "mrkdwn",
        text: `*${a.metric}* (${a.severity})\n${a.value} (threshold: ${a.threshold})`,
      })),
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `Tune via the *Alert Thresholds* card on the Health dashboard ` +
          `(\`manualTimeoutWindow*\`, \`manualWaitP95*Ms\`, ` +
          `\`backgroundIngestionSaturationWindow*\`, ` +
          `\`manualDelayedByBackgroundWindow*\`). ` +
          `Channel routed via the centralized rate-limit alert config.`,
      },
    },
  ];
}

/**
 * Best-effort Slack delivery for manual-reserve alerts. Per (metric, severity)
 * cooldown of 15 minutes prevents spam when thresholds remain breached across
 * consecutive sampler ticks. No-ops gracefully when Slack is not configured.
 */
export async function deliverManualReserveAlerts(alerts: Alert[]): Promise<{ sent: boolean; deliveredKeys: string[]; muted?: boolean }> {
  if (alerts.length === 0) return { sent: false, deliveredKeys: [] };
  const now = Date.now();
  const muteState = await getManualReserveMuteState(now);
  if (muteState.muted) {
    // Audit-record the suppressed alerts so operators can see what *would*
    // have been sent and why dispatch was skipped (#725). Apply per-key
    // cooldown to the muted-record path too so we don't write a row on every
    // sampler tick while a mute is active.
    // Use a separate cooldown map for muted-audit rows so that suppressed
    // events do not poison the real Slack delivery cooldown — otherwise the
    // first post-unmute alert could be silenced for up to COOLDOWN_MS.
    const fresh = alerts.filter((a) => {
      const last = lastMutedAuditAt.get(alertKey(a)) ?? 0;
      return now - last >= COOLDOWN_MS;
    });
    if (fresh.length > 0) {
      for (const a of fresh) lastMutedAuditAt.set(alertKey(a), now);
      const detailParts = ["Dispatch suppressed by active mute"];
      if (muteState.mutedUntil) {
        detailParts.push(`until ${new Date(muteState.mutedUntil).toISOString()}`);
      }
      recordDispatches(fresh, "muted", detailParts.join(" "), {
        eventType: "muted",
        mutedBy: muteState.mutedBy,
        muteReason: muteState.reason,
      });
    }
    return { sent: false, deliveredKeys: [], muted: true };
  }
  const fresh = alerts.filter(a => {
    const last = lastSentAt.get(alertKey(a)) ?? 0;
    return now - last >= COOLDOWN_MS;
  });
  if (fresh.length === 0) return { sent: false, deliveredKeys: [] };

  // Task #994: route through the unified dispatcher. The resolver picks
  // the channel (notification_settings → env override
  // `HEALTH_ALERTS_SLACK_CHANNEL_ID` → legacy
  // `rate_limit_alert_slack_channel_id`), so admin edits in the Slack
  // Notifications Console immediately reroute live alerts. The dispatcher
  // also enforces the console enabled flag and Slack connectivity check
  // and records the delivery row. Per-(metric,severity) cooldowns continue
  // to live here.
  const { notifyByType } = await import("./notifications/dispatcher");
  const result = await notifyByType(
    "usage.manual_reserve.starvation",
    {
      text: buildPlainText(fresh),
      blocks: buildBlocks(fresh),
      preview: fresh.map((a) => ({ metric: a.metric, severity: a.severity })),
    },
    { triggerSource: "alert_service", bypassDedupe: true },
  );
  const channel = result.channelId ?? null;
  if (result.delivered) {
    for (const a of fresh) lastSentAt.set(alertKey(a), now);
    recordDispatches(fresh, "sent");
    return { sent: true, deliveredKeys: fresh.map(alertKey) };
  }
  if (result.status === "skipped_no_channel") {
    // Mark as "delivered" anyway so we don't retry every 30s when Slack is
    // intentionally unconfigured. The alerts still surface in currentAlerts.
    for (const a of fresh) lastSentAt.set(alertKey(a), now);
    recordDispatches(fresh, "not_configured", "No Slack channel configured");
    return { sent: false, deliveredKeys: fresh.map(alertKey) };
  }
  if (result.status === "skipped_slack_disconnected") {
    console.log("[manual-reserve-alerts] Slack not connected; skipping Slack delivery");
    for (const a of fresh) lastSentAt.set(alertKey(a), now);
    recordDispatches(fresh, "not_configured", "Slack integration not connected");
    return { sent: false, deliveredKeys: fresh.map(alertKey) };
  }
  if (result.status === "skipped_disabled") {
    for (const a of fresh) lastSentAt.set(alertKey(a), now);
    recordDispatches(fresh, "not_configured", "Notification disabled in console");
    return { sent: false, deliveredKeys: fresh.map(alertKey) };
  }
  // failed or other skip reasons
  void channel;
  const errMsg = result.error ?? result.skipReason ?? "Slack delivery failed";
  console.warn("[manual-reserve-alerts] Slack delivery failed:", errMsg);
  recordDispatches(fresh, "failed", errMsg);
  return { sent: false, deliveredKeys: [] };
}

/**
 * Operator-initiated resend for a previously-recorded manual-reserve alert.
 * Identifies the source dispatch by its `timestamp` (and optionally
 * `metric`+`severity` to disambiguate when several alerts share a timestamp).
 *
 * The actual cooldown / idempotency / actor-tracking is delegated to the
 * generic resend guard. We deliberately bypass the per-(metric,severity) 15-
 * minute cooldown that prevents auto-firing duplicate alerts: an explicit
 * operator resend is exactly the case that cooldown is not designed for.
 */
export type ManualReserveResendOutcome =
  | { ok: true; dispatch: ManualReserveAlertDispatch }
  | {
      ok: false;
      reason: "not_found" | "not_eligible" | "cooldown" | "in_flight" | "broadcast_failed";
      message?: string;
      cooldownRemainingMs?: number;
    };

export async function resendManualReserveAlert(opts: {
  timestamp: number;
  metric?: string;
  severity?: Alert["severity"];
  actorId?: string | null;
  source?: string;
}): Promise<ManualReserveResendOutcome> {
  const target = recentBuffer.find(
    (d) =>
      d.timestamp === opts.timestamp &&
      (opts.metric ? d.metric === opts.metric : true) &&
      (opts.severity ? d.severity === opts.severity : true),
  );
  if (!target) return { ok: false, reason: "not_found" };
  // Resend is only meaningful for dispatches that didn't make it out the
  // door. "sent" is already delivered; "not_configured" means there is no
  // destination to retry against.
  if (target.status !== "failed") {
    return {
      ok: false,
      reason: "not_eligible",
      message: `Resend is only available for failed dispatches (current status: ${target.status})`,
    };
  }
  // Synthetic transition events ("backed_up"/"all_clear") are info-severity and
  // are not real alerts, so they cannot be resent through the Slack pipeline.
  if (target.severity !== "warning" && target.severity !== "critical") {
    return {
      ok: false,
      reason: "not_eligible",
      message: "Only warning/critical dispatches can be resent",
    };
  }

  const triggerActorId = opts.actorId ?? null;
  const triggerSource = opts.source ?? "admin_ui";

  const replay: Alert = {
    metric: target.metric,
    severity: target.severity,
    message: target.message,
    value: target.value,
    threshold: target.threshold,
  };

  type ManualReserveResendExecResult = {
    channels: Array<{
      destination: string;
      status: "sent" | "failed" | "skipped";
      failureReason?: string | null;
    }>;
    status: ManualReserveAlertDispatchStatus;
    error?: string;
  };

  const { attemptResend } = await import("./alertResendGuard");
  const guardOutcome = await attemptResend<ManualReserveResendExecResult>({
    alertType: "manual_reserve_alert",
    alertId: `${target.timestamp}:${target.metric}:${target.severity}`,
    destinations: ["slack"],
    actor: { userId: triggerActorId, source: triggerSource },
    execute: async (): Promise<ManualReserveResendExecResult> => {
      // Test-only seam (Task #799): when set, bypass the real Slack/config
      // path and use the override's typed result. Production never sets this.
      if (__manualReserveResendExecuteOverride) {
        return __manualReserveResendExecuteOverride({ replay, triggerActorId, triggerSource });
      }
      let channel: string | null = null;
      try {
        const cfg = await loadAlertNotifyConfig();
        channel = cfg.slackChannelId;
      } catch (err: any) {
        console.warn(
          "[manual-reserve-alerts] Failed to load notify config for resend:",
          err?.message || err,
        );
      }
      if (!channel) {
        const envOverride = process.env[SLACK_CHANNEL_ENV_OVERRIDE];
        if (envOverride && envOverride.trim().length > 0) channel = envOverride.trim();
      }
      const trigger = {
        triggeredBy: triggerActorId,
        triggerSource,
        isResend: true,
      };
      if (!channel) {
        recordDispatches([replay], "not_configured", "No Slack channel configured", trigger);
        return {
          status: "not_configured" as ManualReserveAlertDispatchStatus,
          channels: [{ destination: "slack", status: "skipped" as const }],
        };
      }
      try {
        if (!(await isSlackConnected())) {
          recordDispatches([replay], "not_configured", "Slack integration not connected", trigger);
          return {
            status: "not_configured" as ManualReserveAlertDispatchStatus,
            channels: [{ destination: "slack", status: "skipped" as const }],
          };
        }
        await postMessage(channel, buildPlainText([replay]), buildBlocks([replay]));
        // Refresh the per-metric cooldown so the next auto-firing tick won't
        // re-spam the same metric immediately after the operator resent it.
        lastSentAt.set(alertKey(replay), Date.now());
        recordDispatches([replay], "sent", undefined, trigger);
        return {
          status: "sent" as ManualReserveAlertDispatchStatus,
          channels: [{ destination: "slack", status: "sent" as const }],
        };
      } catch (err: any) {
        const msg = err?.message ? String(err.message) : "Slack delivery failed";
        recordDispatches([replay], "failed", msg, trigger);
        return {
          status: "failed" as ManualReserveAlertDispatchStatus,
          channels: [
            { destination: "slack", status: "failed" as const, failureReason: msg },
          ],
          error: msg,
        };
      }
    },
  });

  if (guardOutcome.status === "cooldown") {
    return {
      ok: false,
      reason: "cooldown",
      message: "Resend is cooling down. Please wait before retrying.",
      cooldownRemainingMs: guardOutcome.cooldownRemainingMs,
    };
  }
  if (guardOutcome.status === "in_flight") {
    return {
      ok: false,
      reason: "in_flight",
      message: "A resend for this alert is already in progress.",
    };
  }
  if (guardOutcome.status === "error") {
    return { ok: false, reason: "broadcast_failed", message: guardOutcome.error };
  }

  // Map the typed execution result to the public outcome. Anything other
  // than a confirmed "sent" is surfaced as a non-OK result so callers don't
  // misreport silent failures (e.g. Slack disconnected => "not_configured").
  const exec = guardOutcome.result;
  if (exec.status === "failed" || exec.error) {
    return {
      ok: false,
      reason: "broadcast_failed",
      message: exec.error || "Slack delivery failed",
    };
  }
  if (exec.status === "not_configured") {
    return {
      ok: false,
      reason: "not_eligible",
      message: "Slack destination is not configured for resend",
    };
  }
  // The most recent ring entry is the one we just appended in `execute`.
  const latest = recentBuffer[recentBuffer.length - 1];
  return { ok: true, dispatch: latest };
}

export function __resetManualReserveAlertDispatchesForTest(): void {
  recentBuffer.length = 0;
}

/** Test-only: append a synthetic dispatch entry (used to seed resend tests). */
export function __pushManualReserveDispatchForTest(d: ManualReserveAlertDispatch): void {
  recentBuffer.push(d);
}

export function __resetManualReserveAlertCooldownsForTest(): void {
  lastSentAt.clear();
  lastMutedAuditAt.clear();
}

// Test-only seam (Task #799): override the inner execute() of the resend
// guard so route-level tests can produce deterministic outcomes without
// standing up Slack. Production code never sets this.
export type ManualReserveResendExecuteOverrideResult = {
  channels: Array<{
    destination: string;
    status: "sent" | "failed" | "skipped";
    failureReason?: string | null;
  }>;
  status: ManualReserveAlertDispatchStatus;
  error?: string;
};
type ManualReserveResendExecuteOverride = (args: {
  replay: Alert;
  triggerActorId: string | null;
  triggerSource: string;
}) => Promise<ManualReserveResendExecuteOverrideResult>;
let __manualReserveResendExecuteOverride: ManualReserveResendExecuteOverride | null = null;
export function __test_setResendExecuteOverride(
  fn: ManualReserveResendExecuteOverride | null,
): void {
  __manualReserveResendExecuteOverride = fn;
}
