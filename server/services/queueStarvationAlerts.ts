/**
 * Task #1009 — alert when a queue stays idle across multiple
 * consecutive dispatch windows while it still has pending depth.
 *
 * Task #1003 added per-queue dispatch counters to the work-queue admin
 * card via `getDispatchCountersSnapshot`. That gives an operator who's
 * looking at the page a way to spot a starved queue. This watcher
 * turns the same data source into a proactive Slack alert: if a queue
 * dispatches 0 jobs for N consecutive ~60-cycle windows AND it has
 * pending jobs AND it isn't paused, fire a starvation alert through
 * the unified `notifyByType` dispatcher. Once the queue dispatches
 * again, send a single "resolved" follow-up so the on-call thread
 * gets closure without manual intervention.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `queue.scheduler.starved`; threshold knobs live in `system_settings`
 * so an admin can tune them without a deploy.
 */
import { withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import {
  getDispatchCountersSnapshot as realGetDispatchCountersSnapshot,
} from "./workScheduler";
import {
  ensureQueueDrainStateLoaded,
  getQueuePendingCount,
  isQueuePaused,
} from "./queueDrainControl";

type DispatchSnapshot = ReturnType<typeof realGetDispatchCountersSnapshot>;
let snapshotOverride: (() => DispatchSnapshot) | null = null;
function getDispatchCountersSnapshot(): DispatchSnapshot {
  return snapshotOverride ? snapshotOverride() : realGetDispatchCountersSnapshot();
}

const NOTIFICATION_ID = "queue.scheduler.starved";

export const SETTING_ENABLED = "queue_starvation_alert_enabled";
export const SETTING_WINDOWS = "queue_starvation_alert_consecutive_windows";
export const SETTING_MIN_PENDING = "queue_starvation_alert_min_pending";
export const SETTING_COOLDOWN = "queue_starvation_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  consecutiveWindows: 3,
  minPending: 1,
  cooldownMinutes: 60,
};

const CHECK_INTERVAL_MS = 60_000;

export interface QueueStarvationAlertConfig {
  enabled: boolean;
  consecutiveWindows: number;
  minPending: number;
  cooldownMinutes: number;
}

interface QueueIdleState {
  /** `capturedAt` of the most recently processed completed window. */
  lastWindowAt: string | null;
  /** Number of consecutive completed windows with 0 dispatches AND pending > 0. */
  consecutiveIdleWindows: number;
  /** Wall-clock ms of the last fired starvation alert (for cooldown). */
  lastAlertAt: number | null;
  /** Pending count at the time of the last alert (for the resolve message). */
  lastAlertPending: number | null;
  /** True once a starvation alert has fired and not yet been resolved. */
  alerted: boolean;
}

const stateByQueue = new Map<string, QueueIdleState>();

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: { triggerSource: string; bypassDedupe?: boolean; metadata?: Record<string, unknown> },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegInt(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export async function getQueueStarvationAlertConfig(): Promise<QueueStarvationAlertConfig> {
  const [enabledRow, windowsRow, minPendingRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_WINDOWS).catch(() => null),
    getSystemSetting(SETTING_MIN_PENDING).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    consecutiveWindows: parsePositiveInt(windowsRow?.value, DEFAULTS.consecutiveWindows),
    minPending: parseNonNegInt(minPendingRow?.value, DEFAULTS.minPending),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
  };
}

function buildWorkQueueLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  const path = "/admin/health#work-queue";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function buildStarvationText(args: {
  queueName: string;
  consecutiveIdleWindows: number;
  threshold: number;
  pending: number;
}): string {
  const link = buildWorkQueueLink();
  return [
    `:warning: *Queue starved* — \`${args.queueName}\``,
    `• 0 dispatches across the last *${args.consecutiveIdleWindows}* dispatch windows (threshold: ${args.threshold})`,
    `• Pending depth right now: *${args.pending}* jobs`,
    `Inspect the per-queue dispatch counters: ${link}`,
  ].join("\n");
}

function buildResolvedText(args: {
  queueName: string;
  pendingAtAlert: number | null;
  pendingNow: number;
}): string {
  const link = buildWorkQueueLink();
  const wasLine =
    args.pendingAtAlert != null
      ? `• Pending was *${args.pendingAtAlert}* at alert time, now *${args.pendingNow}*`
      : `• Pending now: *${args.pendingNow}*`;
  return [
    `:white_check_mark: *Queue recovered* — \`${args.queueName}\``,
    `• Dispatches resumed in the most recent window`,
    wasLine,
    `Per-queue dispatch counters: ${link}`,
  ].join("\n");
}

export type StarvationDecision =
  | "alerted"
  | "resolved"
  | "incremented_idle"
  | "skipped_disabled"
  | "skipped_no_completed_window"
  | "skipped_window_unchanged"
  | "skipped_paused"
  | "skipped_below_min_pending"
  | "skipped_below_threshold"
  | "skipped_cooldown"
  | "skipped_dispatcher_failed"
  | "skipped_dispatcher_skipped"
  | "skipped_pending_lookup_failed";

export interface StarvationCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  windowCapturedAt: string | null;
  windowProcessed: boolean;
  alertsSent: number;
  resolvesSent: number;
  perQueue: Array<{
    queueName: string;
    dispatchCount: number;
    pending: number | null;
    consecutiveIdleWindows: number;
    decision: StarvationDecision;
    skipReason?: string;
  }>;
}

async function safeGetPending(queueName: string): Promise<number | null> {
  try {
    return await getQueuePendingCount(queueName);
  } catch (err: any) {
    console.warn(
      `[QueueStarvationAlerts] pending count read failed for ${queueName}: ${err?.message}`,
    );
    return null;
  }
}

function getOrCreateState(queueName: string): QueueIdleState {
  let s = stateByQueue.get(queueName);
  if (!s) {
    s = {
      lastWindowAt: null,
      consecutiveIdleWindows: 0,
      lastAlertAt: null,
      lastAlertPending: null,
      alerted: false,
    };
    stateByQueue.set(queueName, s);
  }
  return s;
}

async function dispatchAlert(
  notificationId: string,
  text: string,
  metadata: Record<string, unknown>,
): Promise<{ delivered: boolean; skipReason?: string }> {
  try {
    const notifyByType =
      dispatcherOverride ??
      (await import("./notifications/dispatcher")).notifyByType;
    const r = await notifyByType(
      notificationId,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        // Per-queue cooldown is managed in this module; let the
        // dispatcher fire whenever we get here.
        bypassDedupe: true,
        metadata,
      },
    );
    return { delivered: r.delivered, skipReason: r.delivered ? undefined : (r.skipReason ?? r.status) };
  } catch (err: any) {
    console.error(
      `[QueueStarvationAlerts] dispatch failed: ${err?.message}`,
    );
    return { delivered: false, skipReason: `dispatch_error:${err?.message ?? "unknown"}` };
  }
}

export async function checkStarvedQueues(
  now: number = Date.now(),
): Promise<StarvationCheckResult> {
  const config = await getQueueStarvationAlertConfig();
  await ensureQueueDrainStateLoaded();
  const snapshot = getDispatchCountersSnapshot();
  const result: StarvationCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    windowCapturedAt: snapshot.lastWindow.capturedAt || null,
    windowProcessed: false,
    alertsSent: 0,
    resolvesSent: 0,
    perQueue: [],
  };

  if (!config.enabled) {
    result.perQueue.push({
      queueName: "(all)",
      dispatchCount: 0,
      pending: null,
      consecutiveIdleWindows: 0,
      decision: "skipped_disabled",
      skipReason: "alert disabled in system_settings",
    });
    return result;
  }

  const lastWindow = snapshot.lastWindow;
  // No completed window yet — nothing to process. Don't churn state.
  if (!lastWindow.capturedAt || lastWindow.cycleCount <= 0) {
    result.perQueue.push({
      queueName: "(all)",
      dispatchCount: 0,
      pending: null,
      consecutiveIdleWindows: 0,
      decision: "skipped_no_completed_window",
      skipReason: "scheduler has not closed a dispatch window yet",
    });
    return result;
  }

  // Build the universe of queues to evaluate: anything with pending
  // depth in the recent snapshot OR anything that dispatched in the
  // last window OR anything we already track. The watcher polls more
  // frequently than the scheduler closes windows, so only act when
  // `capturedAt` has advanced — otherwise we'd over-count idle windows.
  const queueNames = Array.from(
    new Set([
      ...Object.keys(lastWindow.counts),
      ...Array.from(stateByQueue.keys()),
    ]),
  );

  for (const queueName of queueNames) {
    const s = getOrCreateState(queueName);
    const dispatchCount = lastWindow.counts[queueName] ?? 0;

    if (s.lastWindowAt === lastWindow.capturedAt) {
      // We've already processed this window for this queue — the
      // watcher is polling faster than the scheduler closes windows.
      result.perQueue.push({
        queueName,
        dispatchCount,
        pending: null,
        consecutiveIdleWindows: s.consecutiveIdleWindows,
        decision: "skipped_window_unchanged",
        skipReason: `already processed window ${lastWindow.capturedAt}`,
      });
      continue;
    }

    // We're about to consume this window for this queue.
    s.lastWindowAt = lastWindow.capturedAt;
    result.windowProcessed = true;

    // ── Recovery path: queue dispatched in this window. Reset the
    // idle counter and, if we'd previously alerted, send a single
    // "resolved" follow-up. ────────────────────────────────────────
    if (dispatchCount > 0) {
      const wasAlerted = s.alerted;
      const previousIdle = s.consecutiveIdleWindows;
      s.consecutiveIdleWindows = 0;
      if (wasAlerted) {
        const pendingNow = (await safeGetPending(queueName)) ?? 0;
        const r = await dispatchAlert(
          NOTIFICATION_ID,
          buildResolvedText({
            queueName,
            pendingAtAlert: s.lastAlertPending,
            pendingNow,
          }),
          {
            queueName,
            event: "resolved",
            previousIdleWindows: previousIdle,
            dispatchCount,
            pendingNow,
            pendingAtAlert: s.lastAlertPending,
          },
        );
        if (r.delivered) {
          s.alerted = false;
          s.lastAlertAt = null;
          s.lastAlertPending = null;
          result.resolvesSent += 1;
          result.perQueue.push({
            queueName,
            dispatchCount,
            pending: pendingNow,
            consecutiveIdleWindows: 0,
            decision: "resolved",
          });
        } else {
          // Leave `alerted=true` so we retry the resolve next window.
          result.perQueue.push({
            queueName,
            dispatchCount,
            pending: pendingNow,
            consecutiveIdleWindows: 0,
            decision: r.skipReason?.startsWith("dispatch_error")
              ? "skipped_dispatcher_failed"
              : "skipped_dispatcher_skipped",
            skipReason: r.skipReason,
          });
        }
      } else {
        result.perQueue.push({
          queueName,
          dispatchCount,
          pending: null,
          consecutiveIdleWindows: 0,
          decision: "skipped_below_threshold",
          skipReason: "queue dispatched this window",
        });
      }
      continue;
    }

    // ── Starvation path: 0 dispatches in this window. ─────────────
    if (isQueuePaused(queueName)) {
      // Paused queues are intentionally idle — don't accrue.
      s.consecutiveIdleWindows = 0;
      result.perQueue.push({
        queueName,
        dispatchCount,
        pending: null,
        consecutiveIdleWindows: 0,
        decision: "skipped_paused",
        skipReason: "queue is paused via Queue Drain Control",
      });
      continue;
    }

    const pending = await safeGetPending(queueName);
    if (pending == null) {
      // Don't change idle counter if we couldn't read pending — try
      // again next window.
      result.perQueue.push({
        queueName,
        dispatchCount,
        pending: null,
        consecutiveIdleWindows: s.consecutiveIdleWindows,
        decision: "skipped_pending_lookup_failed",
      });
      continue;
    }

    if (pending < config.minPending) {
      // Idle but no work to do — not starvation.
      s.consecutiveIdleWindows = 0;
      result.perQueue.push({
        queueName,
        dispatchCount,
        pending,
        consecutiveIdleWindows: 0,
        decision: "skipped_below_min_pending",
        skipReason: `pending ${pending} < minPending ${config.minPending}`,
      });
      continue;
    }

    s.consecutiveIdleWindows += 1;

    if (s.consecutiveIdleWindows < config.consecutiveWindows) {
      result.perQueue.push({
        queueName,
        dispatchCount,
        pending,
        consecutiveIdleWindows: s.consecutiveIdleWindows,
        decision: "incremented_idle",
        skipReason: `idle ${s.consecutiveIdleWindows} < threshold ${config.consecutiveWindows}`,
      });
      continue;
    }

    // Past the threshold — honour cooldown.
    const cooldownMs = config.cooldownMinutes * 60_000;
    if (s.lastAlertAt && now - s.lastAlertAt < cooldownMs) {
      result.perQueue.push({
        queueName,
        dispatchCount,
        pending,
        consecutiveIdleWindows: s.consecutiveIdleWindows,
        decision: "skipped_cooldown",
        skipReason: `cooldown ${Math.round((now - s.lastAlertAt) / 60_000)}m < ${config.cooldownMinutes}m`,
      });
      continue;
    }

    const r = await dispatchAlert(
      NOTIFICATION_ID,
      buildStarvationText({
        queueName,
        consecutiveIdleWindows: s.consecutiveIdleWindows,
        threshold: config.consecutiveWindows,
        pending,
      }),
      {
        queueName,
        event: "starved",
        consecutiveIdleWindows: s.consecutiveIdleWindows,
        threshold: config.consecutiveWindows,
        pending,
        windowCapturedAt: lastWindow.capturedAt,
      },
    );
    if (r.delivered) {
      s.alerted = true;
      s.lastAlertAt = now;
      s.lastAlertPending = pending;
      result.alertsSent += 1;
      result.perQueue.push({
        queueName,
        dispatchCount,
        pending,
        consecutiveIdleWindows: s.consecutiveIdleWindows,
        decision: "alerted",
      });
    } else {
      result.perQueue.push({
        queueName,
        dispatchCount,
        pending,
        consecutiveIdleWindows: s.consecutiveIdleWindows,
        decision: r.skipReason?.startsWith("dispatch_error")
          ? "skipped_dispatcher_failed"
          : "skipped_dispatcher_skipped",
        skipReason: r.skipReason,
      });
    }
  }

  return result;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkStarvedQueues();
      if (r.alertsSent > 0 || r.resolvesSent > 0) {
        console.log(
          `[QueueStarvationAlerts] alerts=${r.alertsSent} resolves=${r.resolvesSent} window=${r.windowCapturedAt}`,
        );
      }
    } catch (err: any) {
      console.warn(`[QueueStarvationAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startQueueStarvationAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:queue-starvation-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  console.log(
    `[QueueStarvationAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 1000}s)`,
  );
}

export function stopQueueStarvationAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  resetStateForTests(): void {
    stateByQueue.clear();
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  getStateForTests(queueName: string): QueueIdleState | undefined {
    return stateByQueue.get(queueName);
  },
  setSnapshotForTests(fn: (() => DispatchSnapshot) | null): void {
    snapshotOverride = fn;
  },
};
