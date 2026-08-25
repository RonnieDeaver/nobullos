/**
 * Task #994 — Shared notification dispatcher.
 *
 *   await notifyByType("usage.rate_limits.warning", { text, blocks }, options?)
 *
 * - Validates the ID exists in the registry; unknown IDs are logged + recorded
 *   as `skipped_unknown_id` and never throw.
 * - Resolves enabled/channel/env-override state via `resolver.resolveNotification`.
 * - Skips delivery (recording the skip reason) if disabled, no channel, Slack
 *   disconnected, or the kill switch is on (manual test sends bypass the kill
 *   switch and dedupe).
 * - Sends through the existing Slack client (`slackIntegration.postMessage`).
 * - Records every attempt in `notification_deliveries` with redacted error
 *   message + payload preview, dedupe key, trigger source, and Slack ts.
 *
 * Returns `{ attempted, delivered, skipped, skipReason?, channelId?, deliveryId?, error? }`.
 */

import { isConnected as isSlackConnected, postMessage } from "../slackIntegration";
import { storage } from "../../storage";
import { dbRetry } from "../../db";
import { resolveNotification } from "./resolver";
import { redactPayloadPreview, redactString } from "./redaction";
import { noteSlackDeliveryOutcome } from "./slackOutageDetector";
import {
  insertNotificationDelivery,
  upsertHealthState,
  getHealthState,
} from "../../storage/notificationsStorage";
import type {
  InsertNotificationDelivery,
  NotificationDeliveryStatus,
} from "@shared/schema";

const KILL_SWITCH_SETTING = "notifications_slack_watchers_enabled";
const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h reminder for sustained unhealthy state

export type NotificationTriggerSource =
  | "scheduled"
  | "manual"
  | "config_change"
  | "test"
  | "retry"
  | "auto_retry"
  | "auto_overdue"
  | "watcher"
  | "alert_service";

export interface NotifyPayload {
  /** Plain-text fallback. Required. */
  text: string;
  /** Optional Slack Block Kit blocks. */
  blocks?: any[];
  /** Optional structured preview (stringified + redacted into delivery row). */
  preview?: unknown;
}

export interface NotifyOptions {
  triggerSource?: NotificationTriggerSource;
  triggerActorId?: string | null;
  /** When supplied, override the resolved channel (used by "send test" UI). */
  channelOverride?: string | null;
  /**
   * Dedupe key. If supplied, the dispatcher records a `skipped_deduped` row
   * when the registry's transition state is already `unhealthy` for the same
   * failureType (and the reminder interval hasn't elapsed). Manual + test
   * sends always bypass dedupe.
   */
  dedupeKey?: string | null;
  /** Failure type segment of the dedupe key — re-alerts when it changes. */
  failureType?: string | null;
  /** Bypass the kill switch (used by manual test sends). */
  bypassKillSwitch?: boolean;
  /** Bypass dedupe (used by manual test sends). */
  bypassDedupe?: boolean;
  /** Extra metadata persisted with the delivery row. */
  metadata?: Record<string, unknown>;
  /**
   * When true, suppress the admin in-app mirror that normally fans the
   * Slack alert into every responsible admin's inbox. Use this when the
   * caller already produces its own targeted per-user inbox rows (e.g.
   * the match-settings give-up notification) so admins don't get one
   * generic mirror row PLUS one specific row for the same event.
   */
  skipAdminInAppMirror?: boolean;
  /**
   * Task #3175 — deep link for the admin in-app mirror rows. Defaults to
   * "/admin/notifications". Set this when the alert's fix lives on a
   * specific admin page (e.g. "/admin/service-desk") so the inbox row
   * takes the admin straight there.
   */
  mirrorDeepLink?: string;
}

export interface NotifyResult {
  attempted: boolean;
  delivered: boolean;
  skipped: boolean;
  status: NotificationDeliveryStatus;
  skipReason?: string;
  channelId?: string | null;
  deliveryId?: string | null;
  slackTs?: string | null;
  error?: string;
}

let killSwitchCache: { value: boolean; loadedAt: number } | null = null;
const KILL_SWITCH_TTL_MS = 30_000;

// ── channel_not_found self-alert ─────────────────────────────────────────────

/** True when a Slack API error indicates the channel ID does not exist or the
 *  bot is not a member. These are NOT auth errors — they are configuration
 *  errors (wrong channel ID saved, channel deleted, bot not invited). */
function isChannelNotFound(err: any): boolean {
  const msg: string = err?.message ?? "";
  return (
    msg.includes("channel_not_found") ||
    msg.includes("not_in_channel") ||
    err?.code === "channel_not_found"
  );
}

/** Per-channel-ID throttle: only alert admins once per 6 h so a high-frequency
 *  notification doesn't flood the inbox on every failed delivery. */
const channelMisconfiguredLastAlertMs = new Map<string, number>();
const CHANNEL_MISCONFIGURED_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Fan an in-app alert to all responsible admins when Slack rejects a delivery
 *  with channel_not_found. Goes directly to the in-app inbox — never through
 *  Slack (which is the broken path). Best-effort, never throws. */
async function alertAdminsOfMisconfiguredSlackChannel(
  channelId: string,
  notificationId: string,
): Promise<void> {
  try {
    const last = channelMisconfiguredLastAlertMs.get(channelId) ?? 0;
    if (Date.now() - last < CHANNEL_MISCONFIGURED_ALERT_INTERVAL_MS) return;
    channelMisconfiguredLastAlertMs.set(channelId, Date.now());
    const { getResponsibleAdminsForAlert } = await import("./recipients");
    const { notifyUser } = await import("./userInbox");
    const admins = await getResponsibleAdminsForAlert();
    const body =
      `Slack delivery for "${notificationId}" failed: channel ${channelId} not found. ` +
      `The bot may have been removed from the channel, the channel may have been renamed or deleted, ` +
      `or the wrong channel ID is saved. Update the channel in Settings → Notifications.`;
    for (const uid of admins) {
      await notifyUser(uid, {
        category: "system",
        title: "Slack channel misconfigured — delivery failing",
        body,
        deepLink: "/admin/notifications",
        dedupeKey: `slack.channel_not_found:${channelId}:${uid}`,
        metadata: { channelId, notificationId },
      });
    }
  } catch (alertErr: any) {
    console.warn(
      `[notifications/dispatch] channel_not_found self-alert failed for channel ${channelId}: ${alertErr?.message ?? alertErr}`,
    );
  }
}

async function isKillSwitchEnabled(): Promise<boolean> {
  if (killSwitchCache && Date.now() - killSwitchCache.loadedAt < KILL_SWITCH_TTL_MS) {
    return killSwitchCache.value;
  }
  let enabled = true;
  try {
    const row = await dbRetry(
      () => storage.getSystemSetting(KILL_SWITCH_SETTING),
      "notifications.killSwitch",
    );
    if (row?.value != null) {
      const v = row.value.trim().toLowerCase();
      enabled = !(v === "false" || v === "0" || v === "off");
    }
  } catch {
    enabled = true;
  }
  killSwitchCache = { value: enabled, loadedAt: Date.now() };
  return enabled;
}

export function invalidateKillSwitchCache(): void {
  killSwitchCache = null;
}

async function recordDelivery(
  input: Omit<InsertNotificationDelivery, "id">,
): Promise<string | null> {
  const row = await insertNotificationDelivery(input as InsertNotificationDelivery);
  return row?.id ?? null;
}

export async function notifyByType(
  notificationId: string,
  payload: NotifyPayload,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  const triggerSource = options.triggerSource ?? "scheduled";
  const triggerActorId = options.triggerActorId ?? null;
  const isManual = triggerSource === "manual" || triggerSource === "test";

  // Task #1688 — Per-user inbox mirror for admin queue/health alerts.
  // Non-manual dispatches that flow through the Slack pipeline are also
  // surfaced in the in-app bell for responsible admins (CEO / team_lead)
  // so they don't need to live in Slack to see incidents. Best-effort
  // and fire-and-forget — never blocks or fails the Slack send.
  if (!isManual && !options.skipAdminInAppMirror) {
    const category: "queue_health" | "system" = notificationId.startsWith("queue.")
      ? "queue_health"
      : "system";
    void (async () => {
      try {
        const { getResponsibleAdminsForAlert } = await import("./recipients");
        const { notifyUser } = await import("./userInbox");
        const admins = await getResponsibleAdminsForAlert();
        const titlePrefix = category === "queue_health" ? "Queue alert" : "System alert";
        const mirrorBody = typeof payload.text === "string" ? payload.text : "";
        const dedupeKey = options.dedupeKey
          ? `alert:${notificationId}:${options.dedupeKey}`
          : `alert:${notificationId}`;
        for (const uid of admins) {
          await notifyUser(uid, {
            category,
            title: `${titlePrefix}: ${notificationId}`,
            body: mirrorBody.length > 240 ? mirrorBody.slice(0, 237) + "..." : mirrorBody,
            deepLink: options.mirrorDeepLink ?? "/admin/notifications",
            dedupeKey: `${dedupeKey}:${uid}`,
            metadata: {
              notificationId,
              triggerSource,
              failureType: options.failureType ?? null,
            },
          });
        }
      } catch (err: any) {
        console.warn(
          `[notifications/dispatch] admin in-app mirror failed for ${notificationId}: ${err?.message ?? err}`,
        );
      }
    })();
  }
  const previewText = redactPayloadPreview(
    options.metadata ?? payload.preview ?? payload.text,
  );

  // ── Unknown id ───────────────────────────────────────────────────────
  const resolved = await resolveNotification(notificationId);
  if (!resolved) {
    console.warn(`[notifications/dispatch] unknown id: ${notificationId}`);
    const id = await recordDelivery({
      notificationId,
      channelId: options.channelOverride ?? null,
      channelName: null,
      status: "skipped_unknown_id",
      errorMessage: "Unknown notification id",
      triggerSource,
      triggerActorId,
      payloadPreview: previewText,
      dedupeKey: options.dedupeKey ?? null,
      metadataJson: (options.metadata ?? null) as Record<string, unknown> | null,
    });
    return {
      attempted: false,
      delivered: false,
      skipped: true,
      status: "skipped_unknown_id",
      skipReason: "Unknown notification id",
      deliveryId: id,
    };
  }

  // ── Kill switch (watcher-driven signals only) ────────────────────────
  // The `notifications_slack_watchers_enabled` kill switch is intentionally
  // scoped to integration-health + infrastructure watchers (Phase 5/6).
  // Legacy operational alerts (`alert_service` / `scheduled` from the five
  // pre-existing senders) and manual/test sends are never suppressed by it
  // — they have their own per-service mute/snooze controls.
  if (triggerSource === "watcher" && !options.bypassKillSwitch) {
    const live = await isKillSwitchEnabled();
    if (!live) {
      const id = await recordDelivery({
        notificationId,
        channelId: resolved.channelId,
        channelName: resolved.channelName,
        status: "skipped_killswitch",
        errorMessage: "Watcher kill switch is OFF",
        triggerSource,
        triggerActorId,
        payloadPreview: previewText,
        dedupeKey: options.dedupeKey ?? null,
        metadataJson: (options.metadata ?? null) as Record<string, unknown> | null,
      });
      return {
        attempted: false,
        delivered: false,
        skipped: true,
        status: "skipped_killswitch",
        skipReason: "Watcher kill switch is OFF",
        channelId: resolved.channelId,
        deliveryId: id,
      };
    }
  }

  // ── Disabled ─────────────────────────────────────────────────────────
  if (!resolved.enabled && !isManual) {
    const id = await recordDelivery({
      notificationId,
      channelId: resolved.channelId,
      channelName: resolved.channelName,
      status: "skipped_disabled",
      errorMessage: null,
      triggerSource,
      triggerActorId,
      payloadPreview: previewText,
      dedupeKey: options.dedupeKey ?? null,
      metadataJson: (options.metadata ?? null) as Record<string, unknown> | null,
    });
    return {
      attempted: false,
      delivered: false,
      skipped: true,
      status: "skipped_disabled",
      skipReason: "Notification disabled",
      channelId: resolved.channelId,
      deliveryId: id,
    };
  }

  // ── Channel resolution ───────────────────────────────────────────────
  const channelId =
    (options.channelOverride && options.channelOverride.trim()) || resolved.channelId;
  if (!channelId) {
    const id = await recordDelivery({
      notificationId,
      channelId: null,
      channelName: null,
      status: "skipped_no_channel",
      errorMessage: null,
      triggerSource,
      triggerActorId,
      payloadPreview: previewText,
      dedupeKey: options.dedupeKey ?? null,
      metadataJson: (options.metadata ?? null) as Record<string, unknown> | null,
    });
    return {
      attempted: false,
      delivered: false,
      skipped: true,
      status: "skipped_no_channel",
      skipReason: "No Slack channel configured",
      channelId: null,
      deliveryId: id,
    };
  }

  // ── Dedupe (transition-based) ────────────────────────────────────────
  if (!isManual && !options.bypassDedupe && options.dedupeKey) {
    try {
      const state = await getHealthState(notificationId, options.dedupeKey);
      if (state && state.state === "unhealthy") {
        const ftSame =
          (state.failureType ?? null) === (options.failureType ?? null);
        const lastNotified = state.lastNotifiedAt ? state.lastNotifiedAt.getTime() : 0;
        const elapsed = Date.now() - lastNotified;
        if (ftSame && elapsed < REMINDER_INTERVAL_MS) {
          const id = await recordDelivery({
            notificationId,
            channelId,
            channelName: resolved.channelName,
            status: "skipped_deduped",
            errorMessage: null,
            triggerSource,
            triggerActorId,
            payloadPreview: previewText,
            dedupeKey: options.dedupeKey,
            metadataJson: (options.metadata ?? null) as Record<string, unknown> | null,
          });
          return {
            attempted: false,
            delivered: false,
            skipped: true,
            status: "skipped_deduped",
            skipReason: "Already notified for this failure type",
            channelId,
            deliveryId: id,
          };
        }
      }
    } catch {
      // best-effort dedupe
    }
  }

  // ── Slack disconnected ───────────────────────────────────────────────
  let slackOk = false;
  try {
    slackOk = await isSlackConnected();
  } catch {
    slackOk = false;
  }
  if (!slackOk) {
    const id = await recordDelivery({
      notificationId,
      channelId,
      channelName: resolved.channelName,
      status: "skipped_slack_disconnected",
      errorMessage: "Slack is not connected",
      triggerSource,
      triggerActorId,
      payloadPreview: previewText,
      dedupeKey: options.dedupeKey ?? null,
      metadataJson: (options.metadata ?? null) as Record<string, unknown> | null,
    });
    return {
      attempted: false,
      delivered: false,
      skipped: true,
      status: "skipped_slack_disconnected",
      skipReason: "Slack is not connected",
      channelId,
      deliveryId: id,
    };
  }

  // ── Send ─────────────────────────────────────────────────────────────
  try {
    // `postMessage` currently returns void; the Slack ts (when we capture it
    // via webhooks in the future) is recorded out-of-band.
    await postMessage(channelId, payload.text, payload.blocks);
    const slackTs: string | null = null;
    const id = await recordDelivery({
      notificationId,
      channelId,
      channelName: resolved.channelName,
      status: "success",
      errorMessage: null,
      slackTs,
      triggerSource,
      triggerActorId,
      payloadPreview: previewText,
      dedupeKey: options.dedupeKey ?? null,
      metadataJson: (options.metadata ?? null) as Record<string, unknown> | null,
    });
    // Task #4645 — feed the sustained-outage detector (prompt close on the
    // first success after an outage). Fire-and-forget, never blocks a send.
    noteSlackDeliveryOutcome("success");

    if (!isManual && options.dedupeKey) {
      try {
        await upsertHealthState({
          notificationId,
          dedupeKey: options.dedupeKey,
          state: "unhealthy",
          failureType: options.failureType ?? null,
          lastNotifiedAt: new Date(),
        });
      } catch {}
    }

    return {
      attempted: true,
      delivered: true,
      skipped: false,
      status: "success",
      channelId,
      deliveryId: id,
      slackTs,
    };
  } catch (err: any) {
    const errMsg = redactString(err?.message ?? String(err));
    const id = await recordDelivery({
      notificationId,
      channelId,
      channelName: resolved.channelName,
      status: "failed",
      errorMessage: errMsg,
      errorCode: err?.code ?? null,
      triggerSource,
      triggerActorId,
      payloadPreview: previewText,
      dedupeKey: options.dedupeKey ?? null,
      metadataJson: (options.metadata ?? null) as Record<string, unknown> | null,
    });

    // When Slack rejects with channel_not_found the configured channel ID is
    // stale (renamed, deleted, or bot removed). The in-app mirror was already
    // fired before the Slack attempt, but there is nothing alerting the admin
    // that their Slack routing is broken. Fan out a targeted in-app alert so
    // this can never silently fail forever. Rate-limited once per 6 h per
    // channel ID to avoid spamming the inbox on high-frequency notifications.
    if (channelId && isChannelNotFound(err)) {
      void alertAdminsOfMisconfiguredSlackChannel(channelId, notificationId);
    }
    // Task #4645 — feed the sustained-outage detector (aggregate, durable
    // escalation when Slack is failing across the board). Throttled inside.
    noteSlackDeliveryOutcome("failure");

    return {
      attempted: true,
      delivered: false,
      skipped: false,
      status: "failed",
      error: errMsg ?? undefined,
      channelId,
      deliveryId: id,
    };
  }
}

/**
 * Shadow-record a delivery that was dispatched by a legacy alert service
 * outside the dispatcher. Used by `rateLimitAlertNotifier`,
 * `matchSettingsAlerts`, `zoomReviewQueueAlerts`, `healthSlackDigest`, and
 * `manualReserveAlerts` so their attempts show up in the unified delivery
 * history without changing the existing copy/cadence/thresholds.
 *
 * Never throws.
 */
export async function recordExternalDelivery(opts: {
  notificationId: string;
  status: NotificationDeliveryStatus;
  channelId?: string | null;
  channelName?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  slackTs?: string | null;
  triggerSource?: NotificationTriggerSource | string;
  triggerActorId?: string | null;
  payloadPreview?: unknown;
  metadata?: Record<string, unknown>;
  dedupeKey?: string | null;
}): Promise<string | null> {
  try {
    const id = await recordDelivery({
      notificationId: opts.notificationId,
      channelId: opts.channelId ?? null,
      channelName: opts.channelName ?? null,
      status: opts.status,
      errorMessage: redactString(opts.errorMessage ?? null),
      errorCode: opts.errorCode ?? null,
      slackTs: opts.slackTs ?? null,
      payloadPreview: redactPayloadPreview(opts.payloadPreview),
      triggerSource: (opts.triggerSource as NotificationTriggerSource) ?? "alert_service",
      triggerActorId: opts.triggerActorId ?? null,
      dedupeKey: opts.dedupeKey ?? null,
      metadataJson: (opts.metadata ?? null) as Record<string, unknown> | null,
    });
    // Task #4645 — legacy alert services' shadow-recorded outcomes feed the
    // sustained-outage detector too (they are real Slack sends).
    if (opts.status === "failed" || opts.status === "success") {
      noteSlackDeliveryOutcome(opts.status === "failed" ? "failure" : "success");
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * Mark a transitioned-to-healthy state — clears the dedupe gate so the next
 * unhealthy transition fires immediately. Used by recovery paths.
 */
export async function markRecovered(notificationId: string, dedupeKey: string): Promise<void> {
  try {
    const state = await getHealthState(notificationId, dedupeKey);
    if (!state || state.state !== "unhealthy") return;
    await upsertHealthState({
      notificationId,
      dedupeKey,
      state: "healthy",
      failureType: null,
      lastNotifiedAt: null,
    });
  } catch {
    // best-effort
  }
}
