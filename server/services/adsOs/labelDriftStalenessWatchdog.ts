// @db-pool-intent: worker
/**
 * Independent liveness watchdog for the Ads OS monitor-label drift guard.
 *
 * The guard records `metadata_json.lastEvaluatedAt` only after a fully
 * observed pass. This scheduler watches that durable heartbeat and alerts
 * responsible admins when it is missing, malformed, implausibly future-dated,
 * or at least two guard ticks old. It has its own timer, lock, kill switch,
 * and health row so a dead/disabled guard timer cannot silence its watchdog.
 */
import { runWithWorkerDb, withDbAttribution } from "../../db";
import { isRunningInDeployment } from "../../lib/deploymentEnv";
import { getSystemSetting } from "../../storage/settingsStorage";
import { registerModuleStateResetForTest } from "../moduleStateReset";
import {
  LABEL_DRIFT_NOTIFICATION_ID,
  LABEL_DRIFT_STATE_DEDUPE_KEY,
  LABEL_DRIFT_TICK_INTERVAL_MS,
} from "./labelDriftGuard";

export const LABEL_DRIFT_STALENESS_NOTIFICATION_ID =
  "system.ads_os.label_drift.staleness";
export const LABEL_DRIFT_STALENESS_STATE_DEDUPE_KEY =
  "ads_os.label_drift.staleness";
export const LABEL_DRIFT_STALENESS_INBOX_DEDUPE_PREFIX =
  "ads_os.label_drift.staleness:";
export const LABEL_DRIFT_STALENESS_ENABLED_SETTING =
  "ads_os_label_drift_guard_staleness_alert_enabled";
export const LABEL_DRIFT_STALENESS_THRESHOLD_MS =
  2 * LABEL_DRIFT_TICK_INTERVAL_MS;
export const LABEL_DRIFT_STALENESS_CHECK_INTERVAL_MS =
  LABEL_DRIFT_TICK_INTERVAL_MS;
export const LABEL_DRIFT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

interface WatchdogHealthState {
  state?: string;
  lastNotifiedAt?: Date | null;
  metadataJson?: unknown;
}

export interface LabelDriftStalenessDeps {
  getGuardState: () => Promise<WatchdogHealthState | undefined>;
  getWatchdogState: () => Promise<WatchdogHealthState | undefined>;
  upsertWatchdogState: (patch: {
    state: "healthy" | "unhealthy";
    failureType?: string | null;
    lastNotifiedAt?: Date | null;
    metadataJson?: unknown;
  }) => Promise<unknown>;
  getRecipients: () => Promise<string[]>;
  notifyUser: (
    userId: string,
    opts: {
      category: string;
      title: string;
      body?: string;
      deepLink?: string;
      dedupeKey?: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  acquireWatchdogLock: () => Promise<{
    release: () => Promise<void>;
  } | null>;
  isEnabled: () => Promise<boolean>;
  getDeploymentLogsLink: () => string;
}

function defaultDeploymentLogsLink(): string {
  const owner = process.env.REPL_OWNER?.trim();
  const slug = process.env.REPL_SLUG?.trim();
  if (owner && slug) {
    // Replit does not document a permanent deep-link directly to one log
    // stream; the deployment pane is the closest project-scoped destination.
    return `https://replit.com/@${encodeURIComponent(owner)}/${encodeURIComponent(slug)}#deployment`;
  }
  return "https://docs.replit.com/features/publishing/monitoring-a-deployment";
}

const defaultDeps: LabelDriftStalenessDeps = {
  getGuardState: async () => {
    const { getHealthState } = await import(
      "../../storage/notificationsStorage"
    );
    return getHealthState(
      LABEL_DRIFT_NOTIFICATION_ID,
      LABEL_DRIFT_STATE_DEDUPE_KEY,
    );
  },
  getWatchdogState: async () => {
    const { getHealthState } = await import(
      "../../storage/notificationsStorage"
    );
    return getHealthState(
      LABEL_DRIFT_STALENESS_NOTIFICATION_ID,
      LABEL_DRIFT_STALENESS_STATE_DEDUPE_KEY,
    );
  },
  upsertWatchdogState: async (patch) => {
    const { upsertHealthState } = await import(
      "../../storage/notificationsStorage"
    );
    return upsertHealthState({
      notificationId: LABEL_DRIFT_STALENESS_NOTIFICATION_ID,
      dedupeKey: LABEL_DRIFT_STALENESS_STATE_DEDUPE_KEY,
      ...patch,
    });
  },
  getRecipients: async () => {
    const { getResponsibleAdminsForAlert } = await import(
      "../notifications/recipients"
    );
    return getResponsibleAdminsForAlert();
  },
  notifyUser: async (userId, opts) => {
    const { notifyUser } = await import("../notifications/userInbox");
    return notifyUser(userId, opts as Parameters<typeof notifyUser>[1]);
  },
  acquireWatchdogLock: async () => {
    const { acquireWorkerSingletonLock } = await import("../crossInstanceLock");
    const { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } = await import("../workerConfig");
    return acquireWorkerSingletonLock(
      "ads_os_label_drift_staleness",
      "[adsOsLabelDriftStaleness]",
      {
        maxHoldMs:
          CROSS_INSTANCE_LOCK_MAX_HOLD_MS.ads_os_label_drift_staleness,
      },
    );
  },
  isEnabled: async () => {
    const row = await getSystemSetting(
      LABEL_DRIFT_STALENESS_ENABLED_SETTING,
    );
    const value = row?.value;
    return (
      value === null ||
      value === undefined ||
      value === "1" ||
      value === "true"
    );
  },
  getDeploymentLogsLink: defaultDeploymentLogsLink,
};

let deps: LabelDriftStalenessDeps = { ...defaultDeps };
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export function __setLabelDriftStalenessDepsForTest(
  overrides: Partial<LabelDriftStalenessDeps>,
): void {
  deps = { ...deps, ...overrides };
}

export function __resetLabelDriftStalenessDepsForTest(): void {
  deps = { ...defaultDeps };
}

interface ParsedHeartbeat {
  completedAt: Date | null;
  reason: "valid" | "missing" | "invalid" | "future";
}

function parseHeartbeat(value: unknown, now: Date): ParsedHeartbeat {
  if (typeof value !== "string" || value.length === 0) {
    return { completedAt: null, reason: "missing" };
  }
  const completedAt = new Date(value);
  if (
    Number.isNaN(completedAt.getTime()) ||
    completedAt.toISOString() !== value
  ) {
    return { completedAt: null, reason: "invalid" };
  }
  if (
    completedAt.getTime() - now.getTime() >
    LABEL_DRIFT_MAX_FUTURE_SKEW_MS
  ) {
    return { completedAt, reason: "future" };
  }
  return { completedAt, reason: "valid" };
}

function episodeToken(heartbeat: ParsedHeartbeat): string {
  if (heartbeat.reason !== "valid" || !heartbeat.completedAt) {
    return `no-valid-pass-${heartbeat.reason}`;
  }
  return heartbeat.completedAt.toISOString().replace(/\D/g, "");
}

export interface LabelDriftStalenessResult {
  stale: boolean;
  reason: ParsedHeartbeat["reason"] | "fresh";
  ageMs: number | null;
  graceRemainingMs: number | null;
  lastEvaluatedAt: string | null;
  notified: string[];
  failed: string[];
}

function parseStoredIso(value: unknown, now: Date): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value ||
    parsed.getTime() > now.getTime()
  ) {
    return null;
  }
  return parsed;
}

export async function evaluateLabelDriftStaleness(
  now: Date = new Date(),
): Promise<LabelDriftStalenessResult> {
  const [guardState, watchdogState] = await Promise.all([
    deps.getGuardState(),
    deps.getWatchdogState(),
  ]);
  const guardMeta = (guardState?.metadataJson ?? {}) as Record<string, unknown>;
  const watchdogMeta = (watchdogState?.metadataJson ?? {}) as Record<
    string,
    unknown
  >;
  const heartbeat = parseHeartbeat(guardMeta.lastEvaluatedAt, now);
  const ageMs =
    heartbeat.reason === "valid" && heartbeat.completedAt
      ? Math.max(0, now.getTime() - heartbeat.completedAt.getTime())
      : null;
  const stale =
    heartbeat.reason !== "valid" ||
    ageMs == null ||
    ageMs >= LABEL_DRIFT_STALENESS_THRESHOLD_MS;
  const lastEvaluatedAt = heartbeat.completedAt?.toISOString() ?? null;

  if (!stale) {
    if (
      watchdogState?.state === "unhealthy" ||
      typeof watchdogMeta.observedEpisode === "string"
    ) {
      await deps.upsertWatchdogState({
        state: "healthy",
        failureType: "ads_os_label_drift_staleness",
        metadataJson: {
          recoveredAt: now.toISOString(),
          lastObservedEvaluationAt: lastEvaluatedAt,
        },
      });
    }
    return {
      stale: false,
      reason: "fresh",
      ageMs,
      graceRemainingMs: null,
      lastEvaluatedAt,
      notified: [],
      failed: [],
    };
  }

  const episode = episodeToken(heartbeat);
  // A valid old heartbeat already carries its own durable age and may page
  // immediately. Missing/malformed/future values have no trustworthy clock,
  // so start a durable first-observed grace window. This prevents a normal
  // boot race (watchdog starts before the guard's first pass) from paging.
  const currentEpisodeAlreadyOpen =
    watchdogState?.state === "unhealthy" &&
    watchdogMeta.episode === episode;
  if (heartbeat.reason !== "valid" && !currentEpisodeAlreadyOpen) {
    const sameObservedEpisode = watchdogMeta.observedEpisode === episode;
    const storedFirstObserved = sameObservedEpisode
      ? parseStoredIso(watchdogMeta.firstObservedStaleAt, now)
      : null;
    const firstObservedStaleAt = storedFirstObserved ?? now;
    const observedForMs = Math.max(
      0,
      now.getTime() - firstObservedStaleAt.getTime(),
    );
    if (observedForMs < LABEL_DRIFT_STALENESS_THRESHOLD_MS) {
      await deps.upsertWatchdogState({
        // Preserve an older active incident while this DIFFERENT invalid
        // episode ages through grace. The episode ledger below switches only
        // after the new invalid condition persists for the full threshold.
        state: watchdogState?.state === "unhealthy" ? "unhealthy" : "healthy",
        failureType: "ads_os_label_drift_staleness",
        metadataJson: {
          ...watchdogMeta,
          observedEpisode: episode,
          firstObservedStaleAt: firstObservedStaleAt.toISOString(),
          observedReason: heartbeat.reason,
          observedEvaluationAt: lastEvaluatedAt,
        },
      });
      return {
        stale: true,
        reason: heartbeat.reason,
        ageMs,
        graceRemainingMs:
          LABEL_DRIFT_STALENESS_THRESHOLD_MS - observedForMs,
        lastEvaluatedAt,
        notified: [],
        failed: [],
      };
    }
  }

  const notifiedLedger = new Set<string>(
    watchdogState?.state === "unhealthy" &&
      watchdogMeta.episode === episode &&
      Array.isArray(watchdogMeta.notifiedRecipients)
      ? (watchdogMeta.notifiedRecipients as string[])
      : [],
  );
  const notified: string[] = [];
  const failed: string[] = [];
  const recipients = await deps.getRecipients();
  if (recipients.length === 0) {
    console.warn(
      "[adsOsLabelDriftStaleness] no responsible admins found — alert has no recipients",
    );
  }

  const ageMinutes = ageMs == null ? null : Math.floor(ageMs / 60_000);
  const openedAt =
    watchdogState?.state === "unhealthy" &&
    watchdogMeta.episode === episode &&
    typeof watchdogMeta.openedAt === "string"
      ? watchdogMeta.openedAt
      : (
          parseStoredIso(watchdogMeta.firstObservedStaleAt, now) ?? now
        ).toISOString();
  const persistEpisode = async (lastNotifiedAt?: Date): Promise<void> => {
    await deps.upsertWatchdogState({
      state: "unhealthy",
      failureType: "ads_os_label_drift_staleness",
      lastNotifiedAt,
      metadataJson: {
        episode,
        openedAt,
        notifiedRecipients: Array.from(notifiedLedger),
        reason: heartbeat.reason,
        lastObservedEvaluationAt: lastEvaluatedAt,
        ageMinutes,
      },
    });
  };

  for (const userId of recipients) {
    if (notifiedLedger.has(userId)) continue;
    try {
      const result = await deps.notifyUser(userId, {
        category: "system",
        title: "Ads OS label-drift guard has stopped completing passes",
        body:
          `The monitor-label drift guard has not completed a fully observed pass ` +
          `within ${LABEL_DRIFT_STALENESS_THRESHOLD_MS / 60_000} minutes. ` +
          (lastEvaluatedAt
            ? `Last completed: ${lastEvaluatedAt} (${ageMinutes} minutes ago). `
            : `No valid completed-pass timestamp is available (${heartbeat.reason}). `) +
          `Open the deployment logs and inspect [adsOsLabelDrift] failures, the ` +
          `Ads API quota, and the guard kill switch.`,
        deepLink: deps.getDeploymentLogsLink(),
        dedupeKey: `${LABEL_DRIFT_STALENESS_INBOX_DEDUPE_PREFIX}${episode}:${userId}`,
        metadata: {
          episode,
          reason: heartbeat.reason,
          lastEvaluatedAt,
          ageMinutes,
          thresholdMinutes: LABEL_DRIFT_STALENESS_THRESHOLD_MS / 60_000,
        },
      });
      if (result == null) {
        failed.push(userId);
        continue;
      }
      notifiedLedger.add(userId);
      notified.push(userId);
      // Persist after EACH accepted inbox write. If the process exits before
      // the next recipient, a restart cannot resend to someone who read the
      // first bell (the inbox's unread-only dedupe is not enough on its own).
      await persistEpisode(now);
    } catch (err: any) {
      failed.push(userId);
      console.warn(
        `[adsOsLabelDriftStaleness] notify failed for ${userId}: ${err?.message ?? err}`,
      );
    }
  }

  await persistEpisode(notified.length > 0 ? now : undefined);

  return {
    stale: true,
    reason: heartbeat.reason,
    ageMs,
    graceRemainingMs: null,
    lastEvaluatedAt,
    notified,
    failed,
  };
}

export async function runLabelDriftStalenessPassOnce(
  opts: { now?: Date } = {},
): Promise<LabelDriftStalenessResult | null> {
  let lock: { release: () => Promise<void> } | null = null;
  try {
    if (!(await deps.isEnabled())) return null;
    lock = await deps.acquireWatchdogLock();
    if (!lock) return null;
    return await runWithWorkerDb(() =>
      withDbAttribution("scheduler:ads-os-label-drift-staleness", () =>
        evaluateLabelDriftStaleness(opts.now ?? new Date()),
      ),
    );
  } catch (err: any) {
    console.warn(
      `[adsOsLabelDriftStaleness] periodic pass failed: ${err?.message ?? err}`,
    );
    return null;
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch {
        /* release is best-effort — the maxHoldMs watchdog reclaims it */
      }
    }
  }
}

function isForceEnabled(): boolean {
  const value = process.env.ADS_OS_LABEL_DRIFT_FORCE_ENABLE;
  return value === "1" || value === "true";
}

export function startLabelDriftStalenessWatchdogScheduler(): void {
  if (process.env.NODE_ENV === "test" || process.env.TEST_SMOKE) {
    console.log("[adsOsLabelDriftStaleness] test env — watchdog disabled");
    return;
  }
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log(
      "[adsOsLabelDriftStaleness] not a deployment — watchdog disabled",
    );
    return;
  }
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    void runLabelDriftStalenessPassOnce();
  }, LABEL_DRIFT_STALENESS_CHECK_INTERVAL_MS);
  watchdogTimer.unref?.();
  void runLabelDriftStalenessPassOnce();
}

export function stopLabelDriftStalenessWatchdogScheduler(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}

registerModuleStateResetForTest("adsOsLabelDriftStalenessWatchdog", () => {
  stopLabelDriftStalenessWatchdogScheduler();
  __resetLabelDriftStalenessDepsForTest();
});