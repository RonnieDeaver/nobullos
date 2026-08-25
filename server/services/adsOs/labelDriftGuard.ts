// @db-pool-intent: worker
//
// Task #4964 — Ads OS monitor-label DRIFT GUARD.
//
// Once an enrolled account has been labeled (or arrives labeled), nothing
// previously noticed when it drifted back to ZERO monitor-labeled campaigns
// (new campaigns replacing labeled ones, the label deleted, a new client
// onboarded unlabeled) — the account just silently rendered $0.00 again.
// This evaluator alerts the responsible admins whenever ANY enrolled GAds
// account is zero-label.
//
// Design (mirrors winCadenceNudge / slackOutageDetector — the review-approved
// "lock-guarded periodic evaluator over durable state" pattern; event-driven
// triggers alone are review-rejected):
//  - 15-min tick + boot catch-up; each pass takes the cluster-wide worker
//    singleton advisory lock and runs on the worker pool with scheduler
//    attribution. Deployment-gated (Ads API quota + alert noise from dev),
//    ADS_OS_LABEL_DRIFT_FORCE_ENABLE=1 for local runs; live kill switch
//    `ads_os_label_drift_guard_enabled` (missing/1 = ON) checked every tick.
//  - Once per ET day: durable completed-day stamp in the singleton
//    notification_health_state metadata, so restarts/autoscale can't re-run
//    a finished day and a persistent condition re-alerts on the NEXT day —
//    daily re-fire, no intra-day spam.
//  - Inbox dedupe keys are day+user scoped
//    (`ads_os.label_drift:<ET day>:<uid>`) — one consolidated daily row per
//    recipient, never constant (constant keys collapse a recurring escalation
//    into one forever-unread row).
//  - "unknown" classifications (Ads API failure) are non-observations: never
//    alerted, and they do NOT mark the day complete for the affected pass —
//    partial-delivery failures keep the day open for retry on the next tick.
//  - STRICTLY READ-ONLY (this directory is mutate-guarded): detection via
//    the shared labelCoverage classifier; the repair is the operator's
//    one-press prod action.

import { runWithWorkerDb, withDbAttribution } from "../../db";
import { getSystemSetting } from "../../storage/settingsStorage";
import { isRunningInDeployment } from "../../lib/deploymentEnv";
import { registerModuleStateResetForTest } from "../moduleStateReset";
import {
  classifyEnrolledLabelCoverage,
  type AccountLabelCoverage,
} from "./labelCoverage";
import { KI_CAMPAIGN_LABEL } from "./config";

export const LABEL_DRIFT_NOTIFICATION_ID = "system.ads_os.label_drift";
export const LABEL_DRIFT_STATE_DEDUPE_KEY = "ads_os.label_drift";
/** Bell rows are keyed `ads_os.label_drift:<ET day>:<uid>` — tests MUST
 *  scope asserts by this prefix, never by total counts. */
export const LABEL_DRIFT_INBOX_DEDUPE_PREFIX = "ads_os.label_drift:";
export const LABEL_DRIFT_ENABLED_SETTING = "ads_os_label_drift_guard_enabled";
export const LABEL_DRIFT_TICK_INTERVAL_MS = 15 * 60 * 1000;
export const LABEL_DRIFT_PAGE_PATH = "/ads-os";

export interface LabelDriftDeps {
  classify: () => Promise<AccountLabelCoverage[]>;
  getState: () => Promise<{
    state?: string;
    metadataJson?: unknown;
  } | undefined>;
  upsertState: (patch: {
    state: "healthy" | "unhealthy";
    failureType?: string | null;
    lastNotifiedAt?: Date | null;
    metadataJson?: unknown;
  }) => Promise<unknown>;
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
  getRecipients: () => Promise<string[]>;
  /** Cluster-wide singleton lock — null = another instance owns this tick. */
  acquireEvaluatorLock: () => Promise<{ release: () => Promise<void> } | null>;
  isEnabled: () => Promise<boolean>;
}

const defaultDeps: LabelDriftDeps = {
  classify: () => classifyEnrolledLabelCoverage(),
  getState: async () => {
    const { getHealthState } = await import("../../storage/notificationsStorage");
    return getHealthState(LABEL_DRIFT_NOTIFICATION_ID, LABEL_DRIFT_STATE_DEDUPE_KEY);
  },
  upsertState: async (patch) => {
    const { upsertHealthState } = await import("../../storage/notificationsStorage");
    return upsertHealthState({
      notificationId: LABEL_DRIFT_NOTIFICATION_ID,
      dedupeKey: LABEL_DRIFT_STATE_DEDUPE_KEY,
      ...patch,
    });
  },
  notifyUser: async (userId, opts) => {
    const { notifyUser } = await import("../notifications/userInbox");
    return notifyUser(userId, opts as Parameters<typeof notifyUser>[1]);
  },
  getRecipients: async () => {
    const { getResponsibleAdminsForAlert } = await import("../notifications/recipients");
    return getResponsibleAdminsForAlert();
  },
  acquireEvaluatorLock: async () => {
    const { acquireWorkerSingletonLock } = await import("../crossInstanceLock");
    const { CROSS_INSTANCE_LOCK_MAX_HOLD_MS } = await import("../workerConfig");
    return acquireWorkerSingletonLock("ads_os_label_drift", "[adsOsLabelDrift]", {
      maxHoldMs: CROSS_INSTANCE_LOCK_MAX_HOLD_MS.ads_os_label_drift,
    });
  },
  isEnabled: async () => {
    const row = await getSystemSetting(LABEL_DRIFT_ENABLED_SETTING);
    const v = row?.value;
    return v === null || v === undefined || v === "1" || v === "true";
  },
};

let deps: LabelDriftDeps = { ...defaultDeps };
let evaluatorTimer: ReturnType<typeof setInterval> | null = null;

export function __setLabelDriftDepsForTest(overrides: Partial<LabelDriftDeps>): void {
  deps = { ...deps, ...overrides };
}
export function __resetLabelDriftDepsForTest(): void {
  deps = { ...defaultDeps };
}

/** ET calendar day (YYYY-MM-DD) — the day instance id used in every dedupe
 *  key, so a persistent condition re-alerts each ET morning. */
export function labelDriftDayStamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface LabelDriftEvaluationResult {
  day: string;
  alreadyComplete: boolean;
  zeroLabelCids: string[];
  notified: string[]; // recipient IDs delivered this pass
  failed: string[]; // recipient IDs whose notify failed (retried next tick)
  unknownCount: number;
}

/** One evaluation of the current ET day. Idempotent via the durable per-day
 *  ledger; never throws. */
export async function evaluateLabelDrift(
  now: Date = new Date(),
): Promise<LabelDriftEvaluationResult | null> {
  try {
    const day = labelDriftDayStamp(now);
    const state = await deps.getState();
    const meta = (state?.metadataJson ?? {}) as Record<string, unknown>;
    if (meta.completedDay === day) {
      // A short-circuited pass is still a completed scheduler pass. Refresh
      // the watchdog heartbeat without repeating Ads API work or notifications.
      const zeroLabelCids = Array.isArray(meta.zeroLabelCids)
        ? (meta.zeroLabelCids as string[])
        : [];
      await deps.upsertState({
        state:
          state?.state === "healthy" || state?.state === "unhealthy"
            ? state.state
            : zeroLabelCids.length > 0
              ? "unhealthy"
              : "healthy",
        failureType: "ads_os_label_drift",
        metadataJson: {
          ...meta,
          lastAttemptedAt: now.toISOString(),
          lastEvaluatedAt: now.toISOString(),
        },
      });
      return {
        day,
        alreadyComplete: true,
        zeroLabelCids: [],
        notified: [],
        failed: [],
        unknownCount: 0,
      };
    }
    const ledger = new Set<string>(
      meta.ledgerDay === day && Array.isArray(meta.ledger) ? (meta.ledger as string[]) : [],
    );

    const coverage = await deps.classify();
    const zero = coverage.filter((a) => a.coverage === "zero");
    const unknownCount = coverage.filter((a) => a.coverage === "unknown").length;

    const notified: string[] = [];
    const failed: string[] = [];

    if (zero.length > 0) {
      const recipients = await deps.getRecipients();
      if (recipients.length === 0) {
        console.warn("[adsOsLabelDrift] no responsible admins found — alert has no recipients");
      }
      const isConsolidated = zero.length >= 2;
      const affectedAccounts = zero.map(
        (acct) =>
          `${acct.descriptive_name} (${acct.customer_id}; ${acct.activeCampaignIds.length} active campaign(s))`,
      );
      for (const uid of recipients) {
        if (ledger.has(uid)) continue;
        try {
          const [acct] = zero;
          await deps.notifyUser(uid, {
            category: "system",
            title: isConsolidated
              ? `Ads OS monitoring broken: ${zero.length} accounts have no labeled campaigns`
              : `Ads OS monitoring broken: ${acct.descriptive_name} has no labeled campaigns`,
            body: isConsolidated
              ? `${zero.length} accounts have ZERO ${KI_CAMPAIGN_LABEL} labels — every Ads OS surface ` +
                `shows $0.00 for them: ${affectedAccounts.join("; ")}. ` +
                `Fix: press "Apply Ads OS monitor labels" in the production actions panel.`
              : `${acct.descriptive_name} (${acct.customer_id}) has ` +
                `${acct.activeCampaignIds.length} active campaign(s) and ZERO ` +
                `${KI_CAMPAIGN_LABEL} labels — every Ads OS surface shows $0.00 for it. ` +
                `Fix: press "Apply Ads OS monitor labels" in the production actions panel.`,
            deepLink: LABEL_DRIFT_PAGE_PATH,
            dedupeKey: `${LABEL_DRIFT_INBOX_DEDUPE_PREFIX}${day}:${uid}`,
            metadata: isConsolidated
              ? {
                  day,
                  customerIds: zero.map((zeroAcct) => zeroAcct.customer_id),
                  activeCampaigns: zero.map((zeroAcct) => ({
                    customerId: zeroAcct.customer_id,
                    count: zeroAcct.activeCampaignIds.length,
                  })),
                }
              : {
                  day,
                  customerId: acct.customer_id,
                  activeCampaigns: acct.activeCampaignIds.length,
                },
          });
          ledger.add(uid);
          notified.push(uid);
        } catch (err: any) {
          failed.push(uid);
          console.warn(`[adsOsLabelDrift] notify failed for ${uid}: ${err?.message ?? err}`);
        }
      }
    }

    // Unknown Ads responses are non-observations: they do not advance the
    // successful-evaluation heartbeat or complete the day. Delivery failures
    // likewise keep the day open, but a fully observed classification still
    // advances lastEvaluatedAt even when an inbox write needs retrying.
    const evaluationComplete = unknownCount === 0;
    const complete = evaluationComplete && failed.length === 0;
    await deps.upsertState({
      state: zero.length > 0 ? "unhealthy" : "healthy",
      failureType: "ads_os_label_drift",
      lastNotifiedAt: notified.length > 0 ? now : undefined,
      metadataJson: {
        completedDay: complete ? day : (meta.completedDay ?? null),
        ledgerDay: day,
        ledger: Array.from(ledger),
        zeroLabelCids: zero.map((a) => a.customer_id),
        unknownCount,
        lastAttemptedAt: now.toISOString(),
        lastEvaluatedAt: evaluationComplete
          ? now.toISOString()
          : (meta.lastEvaluatedAt ?? null),
      },
    });

    if (notified.length > 0) {
      console.log(
        `[adsOsLabelDrift] day ${day}: ${zero.length} zero-label account(s) — ` +
          `${notified.length} bell row(s) sent` +
          (failed.length ? `, ${failed.length} failed (will retry)` : ""),
      );
    }
    return {
      day,
      alreadyComplete: false,
      zeroLabelCids: zero.map((a) => a.customer_id),
      notified,
      failed,
      unknownCount,
    };
  } catch (err: any) {
    console.warn(`[adsOsLabelDrift] evaluation failed: ${err?.message ?? err}`);
    return null;
  }
}

/** One guarded evaluator pass — exported directly for tests. Returns null
 *  when disabled, a sibling holds the lock, or the pass failed. */
export async function runLabelDriftPassOnce(
  opts: { now?: Date } = {},
): Promise<LabelDriftEvaluationResult | null> {
  let lock: { release: () => Promise<void> } | null = null;
  try {
    if (!(await deps.isEnabled())) return null;
    lock = await deps.acquireEvaluatorLock();
    if (!lock) return null;
    return await runWithWorkerDb(() =>
      withDbAttribution("scheduler:ads-os-label-drift", () =>
        evaluateLabelDrift(opts.now ?? new Date()),
      ),
    );
  } catch (err: any) {
    console.warn(`[adsOsLabelDrift] periodic pass failed: ${err?.message ?? err}`);
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
  const v = process.env.ADS_OS_LABEL_DRIFT_FORCE_ENABLE;
  return v === "1" || v === "true";
}

/** Boot entry (server/boot/schedulerInits.ts). Test-inert; deployment-gated
 *  (Ads API quota + alert noise from dev instances). */
export function startLabelDriftGuardScheduler(): void {
  if (process.env.NODE_ENV === "test" || process.env.TEST_SMOKE) {
    console.log("[adsOsLabelDrift] test env — periodic evaluator disabled");
    return;
  }
  if (!isRunningInDeployment() && !isForceEnabled()) {
    console.log("[adsOsLabelDrift] not a deployment — evaluator disabled (set ADS_OS_LABEL_DRIFT_FORCE_ENABLE=1 to force)");
    return;
  }
  if (evaluatorTimer) return;
  evaluatorTimer = setInterval(() => {
    void runLabelDriftPassOnce();
  }, LABEL_DRIFT_TICK_INTERVAL_MS);
  evaluatorTimer.unref?.();
  // First pass immediately (boot is already staggered) so a restart can't
  // defer today's alert to the next tick window.
  void runLabelDriftPassOnce();
}

export function stopLabelDriftGuardScheduler(): void {
  if (evaluatorTimer) clearInterval(evaluatorTimer);
  evaluatorTimer = null;
}

registerModuleStateResetForTest("adsOsLabelDriftGuard", () => {
  stopLabelDriftGuardScheduler();
  __resetLabelDriftDepsForTest();
});
