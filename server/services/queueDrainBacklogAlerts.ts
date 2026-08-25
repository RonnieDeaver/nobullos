/**
 * Task #998 — alert when a paused queue's backlog keeps growing.
 *
 * Task #987 lets operators pause a single queue (e.g. `retroactive_reprocess`
 * when its 2,200-job backlog is pinning the worker pool). The risk is that
 * a queue gets paused during an incident and then forgotten — the backlog
 * quietly grows past the original size and nobody notices until the queue
 * is resumed and the system gets hit hard.
 *
 * This watcher periodically inspects every paused queue and fires a Slack
 * alert (via the unified `notifyByType` dispatcher) when BOTH:
 *   - the queue has been paused for at least `hours_threshold` hours, AND
 *   - the pending count has grown by at least `growth_threshold` jobs
 *     since the queue was paused.
 *
 * Per-queue cooldown ensures we don't spam — once an alert fires for a
 * queue, the same queue is silent for `cooldown_minutes` minutes (default
 * 6h) unless the backlog grows by another `growth_threshold` jobs above
 * the previously-alerted count, OR the queue is resumed/re-paused (which
 * resets the baseline via `setQueuePause`).
 *
 * Channel/enabled state lives in `notification_settings` for
 * `queue.drain_control.paused_backlog_growing`; threshold knobs live in
 * `system_settings` so an admin can tune them without a deploy.
 */
import { withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import {
  ensureQueueDrainStateLoaded,
  getQueuePendingCount,
  type QueueDrainState,
} from "./queueDrainControl";

const NOTIFICATION_ID = "queue.drain_control.paused_backlog_growing";

export const SETTING_ENABLED = "queue_drain_backlog_alert_enabled";
export const SETTING_HOURS = "queue_drain_backlog_alert_hours_threshold";
export const SETTING_GROWTH = "queue_drain_backlog_alert_growth_threshold";
export const SETTING_COOLDOWN = "queue_drain_backlog_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  hoursThreshold: 4,
  growthThreshold: 100,
  cooldownMinutes: 6 * 60,
};

const CHECK_INTERVAL_MS = 5 * 60_000;

export interface QueueDrainBacklogAlertConfig {
  enabled: boolean;
  hoursThreshold: number;
  growthThreshold: number;
  cooldownMinutes: number;
}

interface LastAlertRecord {
  at: number;
  pendingCount: number;
  /**
   * The `pausedAt` value of the pause cycle this alert belongs to. The
   * cooldown only applies WITHIN the same pause cycle — if a queue is
   * resumed and then paused again, `pausedAt` changes and the prior
   * record is ignored so the first alert of the new cycle isn't
   * silently suppressed.
   */
  pausedAt: string;
}

const lastAlertByQueue = new Map<string, LastAlertRecord>();

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

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export async function getQueueDrainBacklogAlertConfig(): Promise<QueueDrainBacklogAlertConfig> {
  const [enabledRow, hoursRow, growthRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_HOURS).catch(() => null),
    getSystemSetting(SETTING_GROWTH).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    hoursThreshold: parsePositiveInt(hoursRow?.value, DEFAULTS.hoursThreshold),
    growthThreshold: parsePositiveInt(growthRow?.value, DEFAULTS.growthThreshold),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
  };
}

function buildQueueDrainControlLink(): string {
  const base =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.REPLIT_DEPLOYMENT_URL ||
    "";
  // The Queue Drain Control card lives on the admin Health Dashboard.
  const path = "/admin/health#queue-drain-control";
  if (!base) return path;
  return `${base.replace(/\/$/, "")}${path}`;
}

function formatHours(hours: number): string {
  if (hours >= 24) {
    const d = hours / 24;
    return `${d.toFixed(d < 10 ? 1 : 0)}d`;
  }
  return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
}

function buildAlertText(args: {
  queueName: string;
  pausedAt: string;
  hoursPaused: number;
  pausedAtBacklog: number;
  currentPending: number;
  growth: number;
  config: QueueDrainBacklogAlertConfig;
}): string {
  const link = buildQueueDrainControlLink();
  const lines = [
    `:warning: *Paused queue backlog is growing* — \`${args.queueName}\``,
    `• Paused for *${formatHours(args.hoursPaused)}* (since ${args.pausedAt})`,
    `• Pending now: *${args.currentPending}* jobs (was *${args.pausedAtBacklog}* at pause — grew by *+${args.growth}*)`,
    `• Thresholds: paused ≥ ${args.config.hoursThreshold}h AND grew ≥ ${args.config.growthThreshold} jobs`,
    `Resume or cancel from the Queue Drain Control card: ${link}`,
  ];
  return lines.join("\n");
}

export interface BacklogCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  pausedQueues: number;
  alertsSent: number;
  /** Per-queue evaluation outcomes for diagnostics. */
  perQueue: Array<{
    queueName: string;
    pausedAt: string | null;
    pausedAtBacklog: number | null;
    currentPending: number;
    hoursPaused: number | null;
    growth: number | null;
    decision:
      | "alerted"
      | "skipped_disabled"
      | "skipped_no_baseline"
      | "skipped_below_hours"
      | "skipped_below_growth"
      | "skipped_cooldown"
      | "skipped_no_growth_since_last_alert"
      | "skipped_send_failed"
      | "skipped_dispatcher_skipped";
    skipReason?: string;
  }>;
}

interface DrainSnapshotLike {
  queueName: string;
  state: QueueDrainState;
}

async function loadPausedQueues(): Promise<DrainSnapshotLike[]> {
  await ensureQueueDrainStateLoaded();
  // Read directly from the in-memory state via a re-import. This keeps the
  // contract narrow — we don't want to expand `getDrainStateSnapshot`'s
  // public shape just for this watcher.
  const mod = await import("./queueDrainControl");
  // `getDrainStateSnapshot` already does the SELECT-pending join, but we
  // need per-queue counts in our own loop because the watcher must look at
  // EVERY paused queue (the snapshot is fine but does the same DB roundtrip
  // we'd do anyway). Reuse the snapshot for consistency with the admin UI.
  const snapshot = await mod.getDrainStateSnapshot();
  return snapshot
    .filter((q) => q.paused)
    .map((q) => ({
      queueName: q.queueName,
      state: {
        paused: q.paused,
        ratePerMinute: q.ratePerMinute,
        updatedAt: q.updatedAt,
        updatedBy: q.updatedBy,
        pausedAt: q.pausedAt,
        pausedAtBacklog: q.pausedAtBacklog,
        // Task #1785 added a required `pauseNote` field to QueueDrainState.
        // The snapshot row from `getDrainStateSnapshot()` carries it through.
        pauseNote: (q as { pauseNote?: string | null }).pauseNote ?? null,
      },
    }));
}

export async function checkPausedQueueBacklogs(
  now: number = Date.now(),
): Promise<BacklogCheckResult> {
  const config = await getQueueDrainBacklogAlertConfig();
  const result: BacklogCheckResult = {
    evaluatedAt: new Date(now).toISOString(),
    enabled: config.enabled,
    pausedQueues: 0,
    alertsSent: 0,
    perQueue: [],
  };

  if (!config.enabled) {
    // We still surface the paused queues in the diagnostics view so an
    // operator hitting the manual "test alert" path sees what would be
    // evaluated.
    const paused = await loadPausedQueues();
    result.pausedQueues = paused.length;
    for (const q of paused) {
      const currentPending = await getQueuePendingCount(q.queueName).catch(() => 0);
      result.perQueue.push({
        queueName: q.queueName,
        pausedAt: q.state.pausedAt,
        pausedAtBacklog: q.state.pausedAtBacklog,
        currentPending,
        hoursPaused: q.state.pausedAt
          ? (now - Date.parse(q.state.pausedAt)) / 3_600_000
          : null,
        growth:
          q.state.pausedAtBacklog != null
            ? currentPending - q.state.pausedAtBacklog
            : null,
        decision: "skipped_disabled",
        skipReason: "alert disabled in system_settings",
      });
    }
    return result;
  }

  const paused = await loadPausedQueues();
  result.pausedQueues = paused.length;

  const cooldownMs = config.cooldownMinutes * 60_000;

  for (const q of paused) {
    const { queueName, state } = q;
    if (!state.pausedAt || state.pausedAtBacklog == null) {
      // Pre-Task-#998 paused queues won't have these — skip until the next
      // human pause/resume cycle re-establishes the baseline.
      result.perQueue.push({
        queueName,
        pausedAt: state.pausedAt,
        pausedAtBacklog: state.pausedAtBacklog,
        currentPending: 0,
        hoursPaused: null,
        growth: null,
        decision: "skipped_no_baseline",
        skipReason: "no pause-time baseline (queue paused before Task #998)",
      });
      continue;
    }

    const pausedAtMs = Date.parse(state.pausedAt);
    const hoursPaused = (now - pausedAtMs) / 3_600_000;
    let currentPending = 0;
    try {
      currentPending = await getQueuePendingCount(queueName);
    } catch (err: any) {
      console.warn(
        `[QueueDrainBacklogAlerts] pending count read failed for ${queueName}: ${err?.message}`,
      );
    }
    const growth = currentPending - state.pausedAtBacklog;

    if (hoursPaused < config.hoursThreshold) {
      result.perQueue.push({
        queueName,
        pausedAt: state.pausedAt,
        pausedAtBacklog: state.pausedAtBacklog,
        currentPending,
        hoursPaused,
        growth,
        decision: "skipped_below_hours",
        skipReason: `paused ${hoursPaused.toFixed(2)}h < ${config.hoursThreshold}h`,
      });
      continue;
    }
    if (growth < config.growthThreshold) {
      result.perQueue.push({
        queueName,
        pausedAt: state.pausedAt,
        pausedAtBacklog: state.pausedAtBacklog,
        currentPending,
        hoursPaused,
        growth,
        decision: "skipped_below_growth",
        skipReason: `growth ${growth} < ${config.growthThreshold}`,
      });
      continue;
    }

    const cachedLast = lastAlertByQueue.get(queueName);
    // Only honour the cached cooldown record if it belongs to the CURRENT
    // pause cycle. If `pausedAt` has changed (queue was resumed and
    // re-paused), the old record must not suppress the first alert of the
    // new cycle.
    const last =
      cachedLast && cachedLast.pausedAt === state.pausedAt ? cachedLast : null;
    if (cachedLast && !last) {
      lastAlertByQueue.delete(queueName);
    }
    if (last) {
      const elapsedMs = now - last.at;
      const growthSinceLastAlert = currentPending - last.pendingCount;
      // Re-alert early ONLY if the backlog has grown by another full
      // growthThreshold jobs since the last alert. Otherwise honour the
      // cooldown so we don't spam the same channel every 5 minutes.
      if (
        elapsedMs < cooldownMs &&
        growthSinceLastAlert < config.growthThreshold
      ) {
        if (growthSinceLastAlert <= 0) {
          result.perQueue.push({
            queueName,
            pausedAt: state.pausedAt,
            pausedAtBacklog: state.pausedAtBacklog,
            currentPending,
            hoursPaused,
            growth,
            decision: "skipped_no_growth_since_last_alert",
            skipReason: `no growth since last alert (${currentPending} ≤ ${last.pendingCount})`,
          });
        } else {
          result.perQueue.push({
            queueName,
            pausedAt: state.pausedAt,
            pausedAtBacklog: state.pausedAtBacklog,
            currentPending,
            hoursPaused,
            growth,
            decision: "skipped_cooldown",
            skipReason: `cooldown ${Math.round(elapsedMs / 60_000)}m < ${config.cooldownMinutes}m and growth-since-last ${growthSinceLastAlert} < ${config.growthThreshold}`,
          });
        }
        continue;
      }
    }

    const text = buildAlertText({
      queueName,
      pausedAt: state.pausedAt,
      hoursPaused,
      pausedAtBacklog: state.pausedAtBacklog,
      currentPending,
      growth,
      config,
    });

    let dispatchOk = false;
    let skipReason: string | undefined;
    try {
      const notifyByType =
        dispatcherOverride ??
        (await import("./notifications/dispatcher")).notifyByType;
      const r = await notifyByType(
        NOTIFICATION_ID,
        { text, preview: text.slice(0, 300) },
        {
          triggerSource: "alert_service",
          // The watcher manages its own per-queue cooldown above; let the
          // dispatcher fire whenever we get here.
          bypassDedupe: true,
          metadata: {
            queueName,
            pausedAt: state.pausedAt,
            pausedAtBacklog: state.pausedAtBacklog,
            currentPending,
            growth,
            hoursPaused: Number(hoursPaused.toFixed(2)),
            hoursThreshold: config.hoursThreshold,
            growthThreshold: config.growthThreshold,
          },
        },
      );
      dispatchOk = r.delivered;
      if (!r.delivered) skipReason = r.skipReason ?? r.status;
    } catch (err: any) {
      console.error(
        `[QueueDrainBacklogAlerts] dispatch failed for ${queueName}: ${err?.message}`,
      );
      skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
    }

    if (dispatchOk) {
      lastAlertByQueue.set(queueName, {
        at: now,
        pendingCount: currentPending,
        pausedAt: state.pausedAt,
      });
      result.alertsSent += 1;
      result.perQueue.push({
        queueName,
        pausedAt: state.pausedAt,
        pausedAtBacklog: state.pausedAtBacklog,
        currentPending,
        hoursPaused,
        growth,
        decision: "alerted",
      });
    } else {
      result.perQueue.push({
        queueName,
        pausedAt: state.pausedAt,
        pausedAtBacklog: state.pausedAtBacklog,
        currentPending,
        hoursPaused,
        growth,
        decision: skipReason?.startsWith("dispatch_error")
          ? "skipped_send_failed"
          : "skipped_dispatcher_skipped",
        skipReason,
      });
    }
  }

  return result;
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      const r = await checkPausedQueueBacklogs();
      if (r.alertsSent > 0) {
        console.log(
          `[QueueDrainBacklogAlerts] sent=${r.alertsSent} pausedQueues=${r.pausedQueues}`,
        );
      }
    } catch (err: any) {
      console.warn(`[QueueDrainBacklogAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startQueueDrainBacklogAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:queue-drain-backlog-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  console.log(
    `[QueueDrainBacklogAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopQueueDrainBacklogAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  resetLastAlertCache(): void {
    lastAlertByQueue.clear();
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
