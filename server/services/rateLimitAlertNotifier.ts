import { storage } from "../storage";
import { dbRetry, withDbAttribution } from "../db";
import type { UsageAlert } from "./rateLimitMonitor";
import {
  getMaxAttemptForChain,
  getRateLimitAlertNotification,
  insertRateLimitAlertNotification,
  listFailedNotificationsForRetry,
  type RateLimitAlertNotificationFilters,
} from "../storage/rateLimitAlertNotificationsStorage";
import { sendEmail as sendMailerEmail, isMailerConfigured } from "./mailer";
import {
  deleteAllPendingDigestAlerts,
  deletePendingDigestAlerts,
  insertPendingDigestAlert,
  listPendingDigestAlerts,
} from "../storage/pendingDigestAlertsStorage";

const SETTING_SLACK_CHANNEL = "rate_limit_alert_slack_channel_id";
const SETTING_EMAIL = "rate_limit_alert_email";
const SETTING_DISABLED_CATEGORIES = "rate_limit_alert_disabled_categories";
const SETTING_CADENCE = "rate_limit_alert_cadence";

export type AlertCadence = "realtime" | "hourly" | "daily";

const VALID_CADENCES: AlertCadence[] = ["realtime", "hourly", "daily"];

export interface AlertNotifyConfig {
  slackChannelId: string | null;
  email: string | null;
  disabledCategories: string[];
  cadence: AlertCadence;
}

let cached: AlertNotifyConfig | null = null;
let loadPromise: Promise<AlertNotifyConfig> | null = null;

export async function loadAlertNotifyConfig(force = false): Promise<AlertNotifyConfig> {
  if (!force && cached) return cached;
  if (!force && loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      // Task #813: idempotent SELECTs invoked from periodic auto-retry &
      // digest paths — wrap in dbRetry so a transient Neon recycle doesn't
      // surface as a hard failure.
      const [slack, email, disabled, cadenceSetting] = await Promise.all([
        dbRetry(
          () => storage.getSystemSetting(SETTING_SLACK_CHANNEL),
          "rateLimitAlert.loadAlertNotifyConfig:slack",
        ),
        dbRetry(
          () => storage.getSystemSetting(SETTING_EMAIL),
          "rateLimitAlert.loadAlertNotifyConfig:email",
        ),
        dbRetry(
          () => storage.getSystemSetting(SETTING_DISABLED_CATEGORIES),
          "rateLimitAlert.loadAlertNotifyConfig:disabled",
        ),
        dbRetry(
          () => storage.getSystemSetting(SETTING_CADENCE),
          "rateLimitAlert.loadAlertNotifyConfig:cadence",
        ),
      ]);
      let disabledCategories: string[] = [];
      if (disabled?.value) {
        try {
          const parsed = JSON.parse(disabled.value);
          if (Array.isArray(parsed)) disabledCategories = parsed.filter((s) => typeof s === "string");
        } catch {}
      }
      const rawCadence = cadenceSetting?.value?.trim();
      const cadence: AlertCadence = VALID_CADENCES.includes(rawCadence as AlertCadence)
        ? (rawCadence as AlertCadence)
        : "realtime";
      cached = {
        slackChannelId: slack?.value?.trim() || null,
        email: email?.value?.trim() || null,
        disabledCategories,
        cadence,
      };
      ensureDigestTimer(cached.cadence);
      // Pull any warnings that were queued before a previous restart back into
      // memory so the next scheduled flush can include them. Best-effort; if
      // the DB is unavailable we'll retry on the next call.
      hydratePendingDigest().catch(() => undefined);
      return cached;
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] Failed to load config:", err.message);
      cached = { slackChannelId: null, email: null, disabledCategories: [], cadence: "realtime" };
      return cached;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export function getCachedAlertNotifyConfig(): AlertNotifyConfig | null {
  return cached;
}

export async function setAlertNotifyConfig(
  patch: Partial<AlertNotifyConfig>,
  updatedBy: string,
): Promise<AlertNotifyConfig> {
  const before = await loadAlertNotifyConfig();
  const auditUserId = updatedBy && updatedBy !== "system" ? updatedBy : null;
  const audits: Array<{
    settingKey: string;
    oldValues: Record<string, unknown>;
    newValues: Record<string, unknown>;
  }> = [];

  if (patch.slackChannelId !== undefined) {
    const next = (patch.slackChannelId ?? "").trim() || null;
    if (next !== before.slackChannelId) {
      audits.push({
        settingKey: SETTING_SLACK_CHANNEL,
        oldValues: { slackChannelId: before.slackChannelId },
        newValues: { slackChannelId: next },
      });
    }
    await storage.setSystemSetting(
      SETTING_SLACK_CHANNEL,
      (patch.slackChannelId ?? "").trim(),
      updatedBy,
    );
  }
  if (patch.email !== undefined) {
    const next = (patch.email ?? "").trim() || null;
    if (next !== before.email) {
      audits.push({
        settingKey: SETTING_EMAIL,
        oldValues: { email: before.email },
        newValues: { email: next },
      });
    }
    await storage.setSystemSetting(SETTING_EMAIL, (patch.email ?? "").trim(), updatedBy);
  }
  if (patch.disabledCategories !== undefined) {
    const arr = Array.from(
      new Set((patch.disabledCategories ?? []).filter((s) => typeof s === "string" && s.length > 0)),
    );
    const sortedNext = [...arr].sort();
    const sortedPrev = [...before.disabledCategories].sort();
    if (sortedNext.join("|") !== sortedPrev.join("|")) {
      audits.push({
        settingKey: SETTING_DISABLED_CATEGORIES,
        oldValues: { disabledCategories: sortedPrev },
        newValues: { disabledCategories: sortedNext },
      });
    }
    await storage.setSystemSetting(SETTING_DISABLED_CATEGORIES, JSON.stringify(arr), updatedBy);
  }
  if (patch.cadence !== undefined) {
    if (!VALID_CADENCES.includes(patch.cadence)) {
      throw new Error(`cadence must be one of: ${VALID_CADENCES.join(", ")}`);
    }
    const previous = cached?.cadence ?? "realtime";
    if (patch.cadence !== before.cadence) {
      audits.push({
        settingKey: SETTING_CADENCE,
        oldValues: { cadence: before.cadence },
        newValues: { cadence: patch.cadence },
      });
    }
    await storage.setSystemSetting(SETTING_CADENCE, patch.cadence, updatedBy);
    // If switching away from a digest cadence, flush whatever is queued so it
    // doesn't sit indefinitely under the new (possibly real-time) policy.
    if (previous !== "realtime" && patch.cadence === "realtime") {
      await flushDigestNow({
        source: "config_change",
        actorId: auditUserId,
      });
    }
  }

  // Capture the resolved destinations *before* invalidating the cache so the
  // outgoing alert reflects the configuration in effect at the moment of the
  // change (e.g. "Slack channel cleared" still posts a final message to the
  // outgoing channel before falling silent).
  const dispatchConfig: AlertNotifyConfig = {
    slackChannelId: before.slackChannelId,
    email: before.email,
    disabledCategories: before.disabledCategories,
    cadence: before.cadence,
  };

  for (const entry of audits) {
    try {
      const row = await storage.recordAdminSettingChange({
        settingKey: entry.settingKey,
        scope: null,
        changedBy: auditUserId,
        oldValues: entry.oldValues,
        newValues: entry.newValues,
      });
      // Task #745 — push every notification-config change through the same
      // Slack/email pipeline that delivers warnings, so admins who don't
      // visit the dashboard still see when categories are disabled or the
      // destination changes. Fire-and-forget; never block the save.
      if (row?.id) {
        void dispatchNotifyConfigChangeAlert({
          auditId: row.id,
          settingKey: entry.settingKey,
          oldValues: entry.oldValues,
          newValues: entry.newValues,
          actorId: auditUserId,
          config: dispatchConfig,
        }).catch((err) =>
          console.error(
            "[RateLimitAlertNotifier] notify-config change alert failed:",
            err?.message ?? err,
          ),
        );
      }
    } catch (auditErr: any) {
      console.error(
        `[RateLimitAlertNotifier] Audit record failed for ${entry.settingKey}:`,
        auditErr?.message,
      );
    }
  }

  cached = null;
  return loadAlertNotifyConfig(true);
}

// ──────────────────────────────────────────────────────────────────────────
// Task #745 — notify-config change alerts
// ──────────────────────────────────────────────────────────────────────────
// Each new admin_setting_audit row for the four `rate_limit_alert_*` keys
// triggers a Slack/email notification (subject to existing notify settings),
// and the delivery outcome is reflected back into the audit row via
// updateAdminSettingAuditDelivery so the admin history panel can render a
// sent/failed indicator.

const NOTIFY_CONFIG_FIELD_LABELS: Record<string, string> = {
  slackChannelId: "Slack channel",
  email: "Email recipient",
  disabledCategories: "Notify on categories",
  cadence: "Delivery cadence",
};

function describeNotifyConfigValue(field: string, value: unknown): string {
  if (field === "disabledCategories") {
    const arr = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return arr.length === 0 ? "(none disabled)" : `disabled: ${arr.join(", ")}`;
  }
  if (value === null || value === undefined || value === "") return "(unset)";
  return String(value);
}

const NOTIFY_CONFIG_FAILURE_REASON_MAX = 500;

function shortenFailureReason(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = String(s).replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > NOTIFY_CONFIG_FAILURE_REASON_MAX
    ? trimmed.slice(0, NOTIFY_CONFIG_FAILURE_REASON_MAX - 1) + "…"
    : trimmed;
}

async function dispatchNotifyConfigChangeAlert(params: {
  auditId: string;
  settingKey: string;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  actorId: string | null;
  config: AlertNotifyConfig;
  resend?: { actorId: string | null };
}): Promise<void> {
  const field = SETTING_FIELD_BY_KEY[params.settingKey] ?? params.settingKey;
  const fieldLabel = NOTIFY_CONFIG_FIELD_LABELS[field] ?? field;
  const oldStr = describeNotifyConfigValue(field, params.oldValues[field]);
  const newStr = describeNotifyConfigValue(field, params.newValues[field]);
  const actorLabel = await describeActor(params.actorId);
  const ts = new Date();

  const slackText =
    `:gear: *Rate-limit alert config changed* — ${fieldLabel}\n` +
    `Changed by: ${actorLabel}\n` +
    `Old: \`${oldStr}\`  →  New: \`${newStr}\``;
  const emailSubject = `[Rate-limit alerts] ${fieldLabel} changed by ${actorLabel}`;
  const emailBody =
    `${actorLabel} changed the rate-limit alert ${fieldLabel}.\n\n` +
    `Setting key: ${params.settingKey}\n` +
    `Old value: ${oldStr}\n` +
    `New value: ${newStr}\n` +
    `Changed at: ${ts.toISOString()}\n`;

  const update: Parameters<typeof storage.updateAdminSettingAuditDelivery>[0] = {
    id: params.auditId,
  };
  if (params.resend) {
    update.lastResendAt = ts;
    update.lastResendBy = params.resend.actorId;
    update.lastResendSource = "manual";
  }

  // Slack ───────────────────────────────────────────────────────────────
  if (params.config.slackChannelId) {
    try {
      const { postMessage, isConnected } = await import("./slackIntegration");
      if (await isConnected()) {
        await postMessage(params.config.slackChannelId, slackText);
        update.slackStatus = "sent";
        update.slackFailureReason = null;
      } else {
        update.slackStatus = "skipped";
        update.slackFailureReason = "Slack not connected";
      }
    } catch (err: any) {
      console.error(
        "[RateLimitAlertNotifier] Notify-config Slack post failed:",
        err?.message,
      );
      update.slackStatus = "failed";
      update.slackFailureReason =
        shortenFailureReason(err?.message) ?? "Slack delivery failed";
    }
  } else {
    update.slackStatus = "skipped";
    update.slackFailureReason = "No Slack channel configured";
  }

  // Email ───────────────────────────────────────────────────────────────
  if (params.config.email) {
    if (!isMailerConfigured()) {
      update.emailStatus = "skipped";
      update.emailFailureReason =
        "SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not configured";
    } else {
      try {
        const result = await sendMailerEmail({
          to: [params.config.email],
          subject: emailSubject,
          text: emailBody,
          logPrefix: "[RateLimitAlertNotifier]",
        });
        if (result.ok) {
          update.emailStatus = "sent";
          update.emailFailureReason = null;
        } else if (result.reason === "missing_config") {
          update.emailStatus = "skipped";
          update.emailFailureReason =
            "SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not configured";
        } else {
          update.emailStatus = "failed";
          update.emailFailureReason =
            shortenFailureReason(
              result.reason === "http_error"
                ? `SendGrid ${result.status}: ${result.message ?? ""}`
                : result.message ?? result.reason,
            ) ?? "Email delivery failed";
        }
      } catch (err: any) {
        console.error(
          "[RateLimitAlertNotifier] Notify-config email send failed:",
          err?.message,
        );
        update.emailStatus = "failed";
        update.emailFailureReason =
          shortenFailureReason(err?.message) ?? "Email delivery failed";
      }
    }
  } else {
    update.emailStatus = "skipped";
    update.emailFailureReason = "No email recipient configured";
  }

  try {
    await storage.updateAdminSettingAuditDelivery(update);
  } catch (err: any) {
    console.error(
      "[RateLimitAlertNotifier] Failed to update audit delivery for notify-config change:",
      err?.message,
    );
  }
}

const NOTIFY_CONFIG_SETTING_KEYS = new Set<string>([
  SETTING_SLACK_CHANNEL,
  SETTING_EMAIL,
  SETTING_DISABLED_CATEGORIES,
  SETTING_CADENCE,
]);

export async function resendNotifyConfigChangeAlert(params: {
  auditId: string;
  actorId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const row = await storage.getAdminSettingAuditById(params.auditId);
  if (!row) return { ok: false, error: "Audit entry not found", status: 404 };
  if (!NOTIFY_CONFIG_SETTING_KEYS.has(row.settingKey)) {
    return {
      ok: false,
      error: "Audit entry is not a notification config change",
      status: 400,
    };
  }
  const config = await loadAlertNotifyConfig(true);
  await dispatchNotifyConfigChangeAlert({
    auditId: row.id,
    settingKey: row.settingKey,
    oldValues: (row.oldValues as Record<string, unknown>) ?? {},
    newValues: (row.newValues as Record<string, unknown>) ?? {},
    actorId: row.changedBy ?? null,
    config,
    resend: { actorId: params.actorId },
  });
  return { ok: true };
}

// De-dup keys: userId:category:windowStart. Bounded to avoid unbounded growth.
const notifiedKeys = new Set<string>();
const MAX_NOTIFIED_KEYS = 5000;

// Pending alerts awaiting digest flush. Mirrored to the
// `pending_digest_alerts` table so the queue survives a server restart — see
// hydratePendingDigest() below.
interface PendingEntry {
  id: string;
  alert: UsageAlert;
}
const pendingDigest: PendingEntry[] = [];
const MAX_PENDING_DIGEST = 5000;

let hydrated = false;
let hydratePromise: Promise<void> | null = null;

function parseUsageAlertPayload(value: unknown): UsageAlert | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.userId === "string" &&
    typeof v.category === "string" &&
    typeof v.count === "number" &&
    typeof v.max === "number" &&
    typeof v.warningPercent === "number" &&
    typeof v.windowStart === "number" &&
    typeof v.windowMs === "number" &&
    typeof v.triggeredAt === "number"
  ) {
    return {
      userId: v.userId,
      category: v.category,
      count: v.count,
      max: v.max,
      warningPercent: v.warningPercent,
      windowStart: v.windowStart,
      windowMs: v.windowMs,
      triggeredAt: v.triggeredAt,
    };
  }
  return null;
}

async function hydratePendingDigest(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const rows = await listPendingDigestAlerts();
      // Merge rather than replace: if the DB was unavailable earlier we may
      // have memory-only fallback entries (id starts with `mem-`) that aren't
      // in the DB — those must not be dropped. Likewise, anything already in
      // memory with a real DB id will be deduped against the rows we load.
      const existingIds = new Set(pendingDigest.map((p) => p.id));
      const invalidIds: string[] = [];
      for (const r of rows) {
        if (existingIds.has(r.id)) continue;
        const alert = parseUsageAlertPayload(r.payload);
        if (alert) {
          pendingDigest.push({ id: r.id, alert });
        } else {
          invalidIds.push(r.id);
        }
      }
      hydrated = true;
      if (invalidIds.length > 0) {
        console.warn(
          `[RateLimitAlertNotifier] Dropping ${invalidIds.length} invalid persisted digest entr${
            invalidIds.length === 1 ? "y" : "ies"
          }.`,
        );
        await deletePendingDigestAlerts(invalidIds).catch((err) =>
          console.error(
            "[RateLimitAlertNotifier] Failed to delete invalid persisted digest entries:",
            err.message,
          ),
        );
      }
    } catch (err: any) {
      console.error(
        "[RateLimitAlertNotifier] Failed to hydrate pending digest queue:",
        err.message,
      );
    } finally {
      hydratePromise = null;
    }
  })();
  return hydratePromise;
}

let digestTimer: NodeJS.Timeout | null = null;
let digestTimerCadence: AlertCadence | null = null;
let digestTimerStartedAt: number | null = null;
let lastDigestFlushAt: number | null = null;

function dedupKey(alert: UsageAlert): string {
  return `${alert.userId}:${alert.category}:${alert.windowStart}`;
}

export function clearAlertNotifyDedup(): void {
  notifiedKeys.clear();
  pendingDigest.length = 0;
  hydrated = true;
  // Best-effort: also drop the persisted queue so a restart doesn't resurrect
  // warnings the operator just cleared.
  deleteAllPendingDigestAlerts().catch((err) =>
    console.error(
      "[RateLimitAlertNotifier] Failed to clear persisted digest queue:",
      err.message,
    ),
  );
}

function isCriticalAlert(alert: UsageAlert): boolean {
  // Once usage has reached/exceeded the effective max, the user is actually
  // being rate-limited. Surface those immediately even if a digest cadence is
  // configured.
  return alert.max > 0 && alert.count >= alert.max;
}

async function describeUser(userId: string): Promise<string> {
  try {
    const u = await storage.getUser(userId);
    if (!u) return userId;
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    if (name && u.email) return `${name} (${u.email})`;
    return name || u.email || userId;
  } catch {
    return userId;
  }
}

function pct(alert: UsageAlert): number {
  if (alert.max <= 0) return 0;
  return Math.round((alert.count / alert.max) * 100);
}

export type DigestTrigger = {
  source:
    | "scheduled"
    | "manual"
    | "config_change"
    | "retry"
    | "auto_retry"
    | "auto_overdue"
    | "test";
  actorId?: string | null;
};

// Canonical delivery-outcome event payload. Every channel × resend path
// records the same shape, so the admin UI and history exports show
// destination, attempt count, error reason and latency uniformly.
export type DeliveryAttemptOutcome = {
  channel: "slack" | "email";
  destination: string;
  status: "sent" | "failed" | "skipped";
  errorMessage: string | null;
  latencyMs: number | null;
  attemptNumber: number;
  parentNotificationId: string | null;
  triggerSource: TriggerSource;
  triggerActorId: string | null;
};

export type TriggerSource =
  | "scheduled"
  | "manual"
  | "config_change"
  | "retry"
  | "auto_retry"
  | "auto_overdue"
  | "test";

async function recordAttempt(
  channel: "slack" | "email",
  destination: string,
  alert: UsageAlert,
  userLabel: string,
  status: "sent" | "failed" | "skipped",
  errorMessage: string | null,
  trigger: DigestTrigger = { source: "scheduled" },
  extras: {
    latencyMs?: number | null;
    attemptNumber?: number;
    parentNotificationId?: string | null;
  } = {},
): Promise<string | null> {
  try {
    const row = await insertRateLimitAlertNotification({
      channel,
      destination,
      status,
      errorMessage,
      userId: alert.userId,
      userLabel,
      category: alert.category,
      count: alert.count,
      maxRequests: alert.max,
      warningPercent: alert.warningPercent,
      windowMs: alert.windowMs,
      windowStart: alert.windowStart,
      triggeredAt: alert.triggeredAt,
      attemptedAt: Date.now(),
      alert,
      triggerSource: trigger.source as any,
      triggerActorId: trigger.actorId ?? null,
      latencyMs: extras.latencyMs ?? null,
      attemptNumber: extras.attemptNumber ?? 1,
      parentNotificationId: extras.parentNotificationId ?? null,
    });
    return row?.id ?? null;
  } catch (err: any) {
    console.error("[RateLimitAlertNotifier] Failed to record notification attempt:", err.message);
    return null;
  }
}

type AttemptExtras = {
  attemptNumber?: number;
  parentNotificationId?: string | null;
};

async function sendSlack(
  alert: UsageAlert,
  channelId: string,
  userLabel: string,
  trigger: DigestTrigger = { source: "scheduled" },
  extras: AttemptExtras = {},
): Promise<{ status: "sent" | "failed" | "skipped"; errorMessage: string | null; latencyMs: number | null; rowId: string | null }> {
  // Task #994: route through the unified dispatcher. Channel override
  // preserves this service's existing resolution chain
  // (`loadAlertNotifyConfig`); the dispatcher still enforces the console
  // enabled flag, kill switch, Slack connectivity check, and records the
  // unified delivery row. Per-user attempt rows continue to be written via
  // `recordAttempt` for the legacy admin telemetry table.
  const startedAt = Date.now();
  const { notifyByType } = await import("./notifications/dispatcher");
  const windowMin = Math.max(1, Math.round(alert.windowMs / 60000));
  const text =
    `:rotating_light: *Rate-limit warning* — ${userLabel}\n` +
    `Category: \`${alert.category}\` · Usage: *${alert.count}/${alert.max}* (${pct(alert)}%, threshold ${alert.warningPercent}%)\n` +
    `Window: ${windowMin} min · Triggered: <!date^${Math.floor(alert.triggeredAt / 1000)}^{date_short_pretty} {time}|${new Date(alert.triggeredAt).toISOString()}>`;
  const result = await notifyByType(
    "usage.rate_limits.warning",
    {
      text,
      preview: { category: alert.category, count: alert.count, max: alert.max },
    },
    {
      // `TriggerSource` ("scheduled"|"manual"|"retry"|"auto_retry"|"test")
      // is a strict subset of `NotificationTriggerSource`, so this assignment
      // is type-safe without a cast.
      triggerSource: trigger.source ?? "alert_service",
      triggerActorId: trigger.actorId ?? null,
      bypassDedupe: true,
      // No channelOverride: let the dispatcher's resolver pick the channel
      // (notification_settings → env override → legacy
      // `rate_limit_alert_slack_channel_id`). This makes admin edits in the
      // Slack Notifications Console immediately reroute live alerts.
    },
  );
  const latency = Date.now() - startedAt;
  // Prefer the channel the dispatcher actually used (resolver wins over
  // the legacy `channelId` we were called with) so the per-user telemetry
  // row reflects reality.
  const effectiveChannel = result.channelId ?? channelId;
  if (result.delivered) {
    const id = await recordAttempt("slack", effectiveChannel, alert, userLabel, "sent", null, trigger, {
      latencyMs: latency,
      ...extras,
    });
    return { status: "sent", errorMessage: null, latencyMs: latency, rowId: id };
  }
  if (result.status === "skipped_slack_disconnected") {
    console.warn(
      "[RateLimitAlertNotifier] Slack channel configured but Slack is not connected; skipping post.",
    );
    const id = await recordAttempt(
      "slack",
      effectiveChannel,
      alert,
      userLabel,
      "skipped",
      "Slack not connected",
      trigger,
      { latencyMs: latency, ...extras },
    );
    return { status: "skipped", errorMessage: "Slack not connected", latencyMs: latency, rowId: id };
  }
  if (
    result.status === "skipped_disabled" ||
    result.status === "skipped_no_channel" ||
    result.status === "skipped_unknown_id" ||
    result.status === "skipped_deduped"
  ) {
    const reason = result.skipReason ?? result.status;
    const id = await recordAttempt("slack", effectiveChannel, alert, userLabel, "skipped", reason, trigger, {
      latencyMs: latency,
      ...extras,
    });
    return { status: "skipped", errorMessage: reason, latencyMs: latency, rowId: id };
  }
  // failed
  const errorMessage = result.error ?? "Slack delivery failed";
  console.error("[RateLimitAlertNotifier] Slack post failed:", errorMessage);
  const id = await recordAttempt(
    "slack",
    effectiveChannel,
    alert,
    userLabel,
    "failed",
    errorMessage,
    trigger,
    { latencyMs: latency, ...extras },
  );
  return { status: "failed", errorMessage, latencyMs: latency, rowId: id };
}

async function sendEmail(
  alert: UsageAlert,
  to: string,
  userLabel: string,
  trigger: DigestTrigger = { source: "scheduled" },
  extras: AttemptExtras = {},
): Promise<{ status: "sent" | "failed" | "skipped"; errorMessage: string | null; latencyMs: number | null; rowId: string | null }> {
  const startedAt = Date.now();
  if (!isMailerConfigured()) {
    console.warn(
      `[RateLimitAlertNotifier] Email recipient ${to} configured but no email provider set (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL missing); skipping email.`,
    );
    const msg = "SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not configured";
    const id = await recordAttempt("email", to, alert, userLabel, "skipped", msg, trigger, {
      latencyMs: Date.now() - startedAt,
      ...extras,
    });
    return { status: "skipped", errorMessage: msg, latencyMs: Date.now() - startedAt, rowId: id };
  }
  const windowMin = Math.max(1, Math.round(alert.windowMs / 60000));
  const subject = `Rate-limit warning: ${userLabel} on ${alert.category} (${pct(alert)}%)`;
  const body =
    `Rate-limit warning fired.\n\n` +
    `User: ${userLabel}\n` +
    `Category: ${alert.category}\n` +
    `Usage: ${alert.count}/${alert.max} (${pct(alert)}%, threshold ${alert.warningPercent}%)\n` +
    `Window: ${windowMin} min\n` +
    `Triggered at: ${new Date(alert.triggeredAt).toISOString()}\n`;
  const result = await sendMailerEmail({
    to: [to],
    subject,
    text: body,
    logPrefix: "[RateLimitAlertNotifier]",
  });
  const latency = Date.now() - startedAt;
  if (result.ok) {
    const id = await recordAttempt("email", to, alert, userLabel, "sent", null, trigger, {
      latencyMs: latency,
      ...extras,
    });
    return { status: "sent", errorMessage: null, latencyMs: latency, rowId: id };
  }
  if (result.reason === "missing_config") {
    const msg = "SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not configured";
    const id = await recordAttempt("email", to, alert, userLabel, "skipped", msg, trigger, {
      latencyMs: latency,
      ...extras,
    });
    return { status: "skipped", errorMessage: msg, latencyMs: latency, rowId: id };
  }
  const errorMessage =
    result.reason === "http_error"
      ? `SendGrid ${result.status}: ${(result.message ?? "").slice(0, 500)}`
      : result.message ?? "Unknown error";
  const id = await recordAttempt("email", to, alert, userLabel, "failed", errorMessage, trigger, {
    latencyMs: latency,
    ...extras,
  });
  return { status: "failed", errorMessage, latencyMs: latency, rowId: id };
}

async function dispatchSingle(alert: UsageAlert, config: AlertNotifyConfig): Promise<void> {
  const userLabel = await describeUser(alert.userId);
  const tasks: Promise<unknown>[] = [];
  // Always attempt Slack: the dispatcher's resolver decides the channel
  // (notification_settings → env override → legacy
  // `rate_limit_alert_slack_channel_id`) and skips with a recorded reason
  // if nothing is configured. This makes admin edits in the Slack
  // Notifications Console immediately reroute live alerts even when the
  // legacy key is empty.
  tasks.push(sendSlack(alert, config.slackChannelId ?? "", userLabel));
  if (config.email) tasks.push(sendEmail(alert, config.email, userLabel));
  await Promise.all(tasks);
}

export function notifyRateLimitAlert(alert: UsageAlert): void {
  const key = dedupKey(alert);
  if (notifiedKeys.has(key)) return;

  // Fire and forget; never block the request path.
  void (async () => {
    try {
      const config = await loadAlertNotifyConfig();
      // Skip-but-don't-dedup so that enabling a destination or category
      // mid-window still allows the next refire to notify once.
      if (config.disabledCategories.includes(alert.category)) return;
      // Probe the notification resolver so console-configured channels
      // count toward "any destination configured" even when the legacy
      // `rate_limit_alert_slack_channel_id` is empty.
      let resolvedSlack: string | null = null;
      try {
        const { resolveNotification } = await import("./notifications/resolver");
        const r = await resolveNotification("usage.rate_limits.warning");
        if (r?.enabled) resolvedSlack = r.channelId ?? null;
      } catch {
        resolvedSlack = config.slackChannelId ?? null;
      }
      if (!resolvedSlack && !config.email) return;

      // Re-check in case another concurrent dispatch already claimed the key.
      if (notifiedKeys.has(key)) return;
      notifiedKeys.add(key);
      if (notifiedKeys.size > MAX_NOTIFIED_KEYS) {
        const toDelete = notifiedKeys.size - MAX_NOTIFIED_KEYS;
        let i = 0;
        for (const k of notifiedKeys) {
          if (i++ >= toDelete) break;
          notifiedKeys.delete(k);
        }
      }

      const critical = isCriticalAlert(alert);
      if (config.cadence === "realtime" || critical) {
        await dispatchSingle(alert, config);
        return;
      }

      // Queue for the next digest flush. Persist first so the warning survives
      // a restart even if the in-memory queue is lost.
      await hydratePendingDigest();
      try {
        const row = await insertPendingDigestAlert(alert, Date.now());
        pendingDigest.push({ id: row.id, alert });
      } catch (err: any) {
        console.error(
          "[RateLimitAlertNotifier] Failed to persist pending digest entry; keeping it in memory only:",
          err.message,
        );
        pendingDigest.push({ id: `mem-${Date.now()}-${Math.random()}`, alert });
      }
      if (pendingDigest.length > MAX_PENDING_DIGEST) {
        const dropped = pendingDigest.splice(0, pendingDigest.length - MAX_PENDING_DIGEST);
        const droppedIds = dropped.filter((d) => !d.id.startsWith("mem-")).map((d) => d.id);
        if (droppedIds.length > 0) {
          deletePendingDigestAlerts(droppedIds).catch((err) =>
            console.error(
              "[RateLimitAlertNotifier] Failed to prune persisted digest entries:",
              err.message,
            ),
          );
        }
      }
      ensureDigestTimer(config.cadence);
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] notify failed:", err.message);
    }
  })();
}

function cadenceIntervalMs(cadence: AlertCadence): number {
  if (cadence === "hourly") return 60 * 60 * 1000;
  if (cadence === "daily") return 24 * 60 * 60 * 1000;
  return 0;
}

function ensureDigestTimer(cadence: AlertCadence): void {
  if (cadence === "realtime") {
    if (digestTimer) {
      clearInterval(digestTimer);
      digestTimer = null;
      digestTimerCadence = null;
      digestTimerStartedAt = null;
    }
    return;
  }
  if (digestTimer && digestTimerCadence === cadence) return;
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
  const interval = cadenceIntervalMs(cadence);
  digestTimer = setInterval(() => {
    void withDbAttribution("scheduler:rate-limit-alert-digest", () =>
      flushDigestNow().catch((err) =>
        console.error("[RateLimitAlertNotifier] digest flush failed:", err.message),
      ),
    );
  }, interval);
  if (typeof digestTimer.unref === "function") digestTimer.unref();
  digestTimerCadence = cadence;
  digestTimerStartedAt = Date.now();
}

interface DigestGroup {
  userId: string;
  category: string;
  count: number;
  peakCount: number;
  peakMax: number;
  peakPct: number;
  firstAt: number;
  lastAt: number;
  warningPercent: number;
  windowMs: number;
}

function buildDigestGroups(alerts: UsageAlert[]): DigestGroup[] {
  const groups = new Map<string, DigestGroup>();
  for (const a of alerts) {
    const key = `${a.userId}::${a.category}`;
    const p = pct(a);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        userId: a.userId,
        category: a.category,
        count: 1,
        peakCount: a.count,
        peakMax: a.max,
        peakPct: p,
        firstAt: a.triggeredAt,
        lastAt: a.triggeredAt,
        warningPercent: a.warningPercent,
        windowMs: a.windowMs,
      });
    } else {
      existing.count += 1;
      if (p > existing.peakPct) {
        existing.peakPct = p;
        existing.peakCount = a.count;
        existing.peakMax = a.max;
      }
      if (a.triggeredAt < existing.firstAt) existing.firstAt = a.triggeredAt;
      if (a.triggeredAt > existing.lastAt) existing.lastAt = a.triggeredAt;
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.peakPct - a.peakPct || b.count - a.count);
}

interface RecentSettingChange {
  field: "slackChannelId" | "email" | "disabledCategories" | "cadence";
  changedAt: number;
  changedBy: string | null;
  oldValue: unknown;
  newValue: unknown;
}

const SETTING_FIELD_BY_KEY: Record<string, RecentSettingChange["field"]> = {
  rate_limit_alert_slack_channel_id: "slackChannelId",
  rate_limit_alert_email: "email",
  rate_limit_alert_disabled_categories: "disabledCategories",
  rate_limit_alert_cadence: "cadence",
};

async function fetchRecentNotifySettingChanges(
  sinceMs: number,
): Promise<RecentSettingChange[]> {
  try {
    const out: RecentSettingChange[] = [];
    for (const settingKey of Object.keys(SETTING_FIELD_BY_KEY)) {
      const rows = await storage.listAdminSettingAudit({ settingKey, limit: 25 });
      for (const r of rows) {
        const ts = new Date(r.changedAt as any).getTime();
        if (!Number.isFinite(ts) || ts <= sinceMs) continue;
        const field = SETTING_FIELD_BY_KEY[r.settingKey];
        if (!field) continue;
        const oldVals = (r.oldValues as Record<string, unknown>) ?? {};
        const newVals = (r.newValues as Record<string, unknown>) ?? {};
        out.push({
          field,
          changedAt: ts,
          changedBy: (r.changedBy as string | null) ?? null,
          oldValue: oldVals[field],
          newValue: newVals[field],
        });
      }
    }
    return out.sort((a, b) => b.changedAt - a.changedAt);
  } catch (err: any) {
    console.error(
      "[RateLimitAlertNotifier] Failed to load recent setting changes for digest:",
      err?.message ?? err,
    );
    return [];
  }
}

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(none)";
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(", ");
  return String(value);
}

async function describeActor(userId: string | null): Promise<string> {
  if (!userId) return "system";
  try {
    return await describeUser(userId);
  } catch {
    return userId;
  }
}

async function buildSlackDigest(
  groups: DigestGroup[],
  cadence: AlertCadence,
  totalAlerts: number,
  recentChanges: RecentSettingChange[] = [],
): Promise<string> {
  const userLabels = new Map<string, string>();
  for (const g of groups) {
    if (!userLabels.has(g.userId)) {
      userLabels.set(g.userId, await describeUser(g.userId));
    }
  }
  const periodLabel = cadence === "hourly" ? "last hour" : "last day";
  const uniqueUsers = new Set(groups.map((g) => g.userId)).size;
  const lines: string[] = [];
  lines.push(
    `:bar_chart: *Rate-limit warning digest* — ${periodLabel}: *${totalAlerts}* warning${
      totalAlerts === 1 ? "" : "s"
    } across *${uniqueUsers}* user${uniqueUsers === 1 ? "" : "s"}.`,
  );
  // Group lines by user for readability.
  const byUser = new Map<string, DigestGroup[]>();
  for (const g of groups) {
    const arr = byUser.get(g.userId) || [];
    arr.push(g);
    byUser.set(g.userId, arr);
  }
  for (const [userId, userGroups] of byUser.entries()) {
    const label = userLabels.get(userId) || userId;
    lines.push(`• *${label}*`);
    for (const g of userGroups) {
      lines.push(
        `    – \`${g.category}\`: ${g.count} warning${g.count === 1 ? "" : "s"}, peak ` +
          `*${g.peakCount}/${g.peakMax}* (${g.peakPct}%, threshold ${g.warningPercent}%)`,
      );
    }
  }
  if (recentChanges.length > 0) {
    lines.push("");
    lines.push(
      `:gear: *Notification setting changes since last digest* (${recentChanges.length}):`,
    );
    for (const c of recentChanges.slice(0, 10)) {
      const actor = await describeActor(c.changedBy);
      lines.push(
        `    – ${c.field}: \`${formatChangeValue(c.oldValue)}\` → \`${formatChangeValue(c.newValue)}\` (by ${actor})`,
      );
    }
    if (recentChanges.length > 10) {
      lines.push(`    – …and ${recentChanges.length - 10} more`);
    }
  }
  return lines.join("\n");
}

async function buildEmailDigest(
  groups: DigestGroup[],
  cadence: AlertCadence,
  totalAlerts: number,
  userLabels: Map<string, string>,
  recentChanges: RecentSettingChange[] = [],
): Promise<{ subject: string; body: string }> {
  const periodLabel = cadence === "hourly" ? "last hour" : "last day";
  const uniqueUsers = new Set(groups.map((g) => g.userId)).size;
  const subject = `Rate-limit warnings digest (${cadence}): ${totalAlerts} warning${
    totalAlerts === 1 ? "" : "s"
  } across ${uniqueUsers} user${uniqueUsers === 1 ? "" : "s"}`;
  const lines: string[] = [];
  lines.push(`Rate-limit warning digest — ${periodLabel}.`);
  lines.push(`${totalAlerts} warning${totalAlerts === 1 ? "" : "s"} across ${uniqueUsers} user${uniqueUsers === 1 ? "" : "s"}.`);
  lines.push("");
  const byUser = new Map<string, DigestGroup[]>();
  for (const g of groups) {
    const arr = byUser.get(g.userId) || [];
    arr.push(g);
    byUser.set(g.userId, arr);
  }
  for (const [userId, userGroups] of byUser.entries()) {
    const label = userLabels.get(userId) || userId;
    lines.push(`User: ${label}`);
    for (const g of userGroups) {
      lines.push(
        `  - ${g.category}: ${g.count} warning${g.count === 1 ? "" : "s"}, peak ` +
          `${g.peakCount}/${g.peakMax} (${g.peakPct}%, threshold ${g.warningPercent}%)`,
      );
    }
    lines.push("");
  }
  if (recentChanges.length > 0) {
    lines.push(
      `Notification setting changes since last digest (${recentChanges.length}):`,
    );
    for (const c of recentChanges.slice(0, 10)) {
      const actor = await describeActor(c.changedBy);
      lines.push(
        `  - ${c.field}: ${formatChangeValue(c.oldValue)} -> ${formatChangeValue(c.newValue)} (by ${actor})`,
      );
    }
    if (recentChanges.length > 10) {
      lines.push(`  - ...and ${recentChanges.length - 10} more`);
    }
    lines.push("");
  }
  return { subject, body: lines.join("\n") };
}

export async function flushDigestNow(
  trigger: DigestTrigger = { source: "scheduled" },
): Promise<void> {
  await hydratePendingDigest();
  if (pendingDigest.length === 0) return;
  const config = cached ?? (await loadAlertNotifyConfig());
  if (!config.slackChannelId && !config.email) {
    const ids = pendingDigest
      .filter((p) => !p.id.startsWith("mem-"))
      .map((p) => p.id);
    pendingDigest.length = 0;
    if (ids.length > 0) {
      await deletePendingDigestAlerts(ids).catch((err) =>
        console.error(
          "[RateLimitAlertNotifier] Failed to drop persisted digest entries:",
          err.message,
        ),
      );
    }
    return;
  }
  const drained = pendingDigest.splice(0, pendingDigest.length);
  const groups = buildDigestGroups(drained.map((d) => d.alert));
  // Fold notification-setting changes since the previous flush into the
  // outgoing digest body so reviewers can see what's changed without leaving
  // the channel/inbox (#745).
  const changesSince =
    lastDigestFlushAt ?? Date.now() - 24 * 60 * 60 * 1000;
  const recentChanges = await fetchRecentNotifySettingChanges(changesSince);
  const cadence: AlertCadence = config.cadence === "realtime" ? "hourly" : config.cadence;
  let anyFailure = false;
  // Per-channel outcome for the digest as a whole. We record one history row
  // per alert × channel below, tagged with this trigger metadata so the
  // admin UI can show "manual" flushes alongside scheduled ones. `latencyMs`
  // is the time the single batched dispatch took for that channel — we
  // attribute the same value to every per-alert row so the canonical event
  // payload always carries it.
  const slackOutcome: {
    status: "sent" | "failed" | "skipped";
    error: string | null;
    latencyMs: number | null;
  } | null = config.slackChannelId
    ? { status: "skipped", error: "Slack not connected", latencyMs: null }
    : null;
  const emailOutcome: {
    status: "sent" | "failed" | "skipped";
    error: string | null;
    latencyMs: number | null;
  } | null = config.email ? { status: "skipped", error: null, latencyMs: null } : null;
  // Pre-resolve user labels once for both record-keeping and email rendering.
  const userLabels = new Map<string, string>();
  for (const entry of drained) {
    if (!userLabels.has(entry.alert.userId)) {
      userLabels.set(entry.alert.userId, await describeUser(entry.alert.userId));
    }
  }
  try {
    if (config.slackChannelId && slackOutcome) {
      const startedAt = Date.now();
      try {
        const { postMessage, isConnected } = await import("./slackIntegration");
        if (await isConnected()) {
          const text = await buildSlackDigest(groups, cadence, drained.length, recentChanges);
          await postMessage(config.slackChannelId, text);
          slackOutcome.status = "sent";
          slackOutcome.error = null;
        } else {
          console.warn("[RateLimitAlertNotifier] Slack not connected; skipping digest post.");
        }
      } catch (err: any) {
        anyFailure = true;
        slackOutcome.status = "failed";
        slackOutcome.error = err?.message ?? "Unknown error";
        console.error("[RateLimitAlertNotifier] Slack digest post failed:", err.message);
      } finally {
        slackOutcome.latencyMs = Date.now() - startedAt;
      }
    }
    if (config.email && emailOutcome) {
      const startedAt = Date.now();
      if (!isMailerConfigured()) {
        emailOutcome.status = "skipped";
        emailOutcome.error = "SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not configured";
        emailOutcome.latencyMs = Date.now() - startedAt;
        console.warn(
          `[RateLimitAlertNotifier] Email recipient ${config.email} configured but no email provider set; skipping digest email.`,
        );
      } else {
        try {
          const { subject, body } = await buildEmailDigest(groups, cadence, drained.length, userLabels, recentChanges);
          const result = await sendMailerEmail({
            to: [config.email],
            subject,
            text: body,
            logPrefix: "[RateLimitAlertNotifier]",
          });
          if (result.ok) {
            emailOutcome.status = "sent";
            emailOutcome.error = null;
          } else {
            anyFailure = true;
            emailOutcome.status = "failed";
            emailOutcome.error = result.message ?? "Unknown error";
          }
        } catch (err: any) {
          anyFailure = true;
          emailOutcome.status = "failed";
          emailOutcome.error = err?.message ?? "Unknown error";
          console.error("[RateLimitAlertNotifier] Email digest send failed:", err.message);
        } finally {
          emailOutcome.latencyMs = Date.now() - startedAt;
        }
      }
    }
    // Record one history entry per alert × channel so the admin UI can show
    // who triggered the flush (scheduled vs. manual + actor).
    for (const entry of drained) {
      const label = userLabels.get(entry.alert.userId) ?? entry.alert.userId;
      if (config.slackChannelId && slackOutcome) {
        await recordAttempt(
          "slack",
          config.slackChannelId,
          entry.alert,
          label,
          slackOutcome.status,
          slackOutcome.error,
          trigger,
          { latencyMs: slackOutcome.latencyMs ?? null },
        );
      }
      if (config.email && emailOutcome) {
        await recordAttempt(
          "email",
          config.email,
          entry.alert,
          label,
          emailOutcome.status,
          emailOutcome.error,
          trigger,
          { latencyMs: emailOutcome.latencyMs ?? null },
        );
      }
    }
  } finally {
    if (anyFailure) {
      // Put drained items back at the front so the next scheduled flush can
      // retry. Bound the queue to MAX_PENDING_DIGEST to avoid runaway growth
      // if the destination stays broken for a long time. The persisted rows
      // are still in the DB (we only delete on success), so a restart will
      // also recover them.
      const requeued = drained.concat(pendingDigest);
      pendingDigest.length = 0;
      const start = Math.max(0, requeued.length - MAX_PENDING_DIGEST);
      const droppedIds: string[] = [];
      for (let i = 0; i < start; i++) {
        if (!requeued[i].id.startsWith("mem-")) droppedIds.push(requeued[i].id);
      }
      for (let i = start; i < requeued.length; i++) pendingDigest.push(requeued[i]);
      if (droppedIds.length > 0) {
        await deletePendingDigestAlerts(droppedIds).catch((err) =>
          console.error(
            "[RateLimitAlertNotifier] Failed to prune persisted digest entries after retry cap:",
            err.message,
          ),
        );
      }
    } else {
      lastDigestFlushAt = Date.now();
      const ids = drained.filter((d) => !d.id.startsWith("mem-")).map((d) => d.id);
      if (ids.length > 0) {
        await deletePendingDigestAlerts(ids).catch((err) =>
          console.error(
            "[RateLimitAlertNotifier] Failed to clear persisted digest entries after flush:",
            err.message,
          ),
        );
      }
    }
  }
}

// =====================================================================
// Canonical resend path
// =====================================================================
// Per-row retry (#680) is the one function every other resend path is
// built on. Bulk retry (#671) and background auto-retry (#672) both call
// `retryNotificationById` so they get identical attempt tracking, latency
// recording, and history-row shape.

const SETTING_AUTO_RETRY = "rate_limit_alert_auto_retry";

export interface AutoRetryConfig {
  enabled: boolean;
  maxAttempts: number;
  minIntervalMinutes: number;
  lookbackHours: number;
}

const DEFAULT_AUTO_RETRY: AutoRetryConfig = {
  enabled: true,
  maxAttempts: 5,
  minIntervalMinutes: 5,
  lookbackHours: 24,
};

let cachedAutoRetry: AutoRetryConfig | null = null;

export async function loadAutoRetryConfig(force = false): Promise<AutoRetryConfig> {
  if (!force && cachedAutoRetry) return cachedAutoRetry;
  try {
    // Task #813: pure idempotent SELECT — wrap in dbRetry so a transient
    // Neon recycle on the periodic auto-retry tick is absorbed instead of
    // bumping dbFailures.
    const row = await dbRetry(
      () => storage.getSystemSetting(SETTING_AUTO_RETRY),
      "rateLimitAlert.loadAutoRetryConfig",
    );
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value) as Partial<AutoRetryConfig>;
        cachedAutoRetry = {
          enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_AUTO_RETRY.enabled,
          maxAttempts:
            typeof parsed.maxAttempts === "number" && parsed.maxAttempts > 0
              ? Math.min(20, Math.floor(parsed.maxAttempts))
              : DEFAULT_AUTO_RETRY.maxAttempts,
          minIntervalMinutes:
            typeof parsed.minIntervalMinutes === "number" && parsed.minIntervalMinutes > 0
              ? Math.min(24 * 60, Math.floor(parsed.minIntervalMinutes))
              : DEFAULT_AUTO_RETRY.minIntervalMinutes,
          lookbackHours:
            typeof parsed.lookbackHours === "number" && parsed.lookbackHours > 0
              ? Math.min(7 * 24, Math.floor(parsed.lookbackHours))
              : DEFAULT_AUTO_RETRY.lookbackHours,
        };
        return cachedAutoRetry;
      } catch {}
    }
  } catch {}
  cachedAutoRetry = { ...DEFAULT_AUTO_RETRY };
  return cachedAutoRetry;
}

export async function setAutoRetryConfig(
  patch: Partial<AutoRetryConfig>,
  updatedBy: string,
): Promise<AutoRetryConfig> {
  const before = await loadAutoRetryConfig();
  const next: AutoRetryConfig = {
    enabled: patch.enabled ?? before.enabled,
    maxAttempts:
      patch.maxAttempts !== undefined
        ? Math.max(1, Math.min(20, Math.floor(patch.maxAttempts)))
        : before.maxAttempts,
    minIntervalMinutes:
      patch.minIntervalMinutes !== undefined
        ? Math.max(1, Math.min(24 * 60, Math.floor(patch.minIntervalMinutes)))
        : before.minIntervalMinutes,
    lookbackHours:
      patch.lookbackHours !== undefined
        ? Math.max(1, Math.min(7 * 24, Math.floor(patch.lookbackHours)))
        : before.lookbackHours,
  };
  await storage.setSystemSetting(SETTING_AUTO_RETRY, JSON.stringify(next), updatedBy);
  if (
    next.enabled !== before.enabled ||
    next.maxAttempts !== before.maxAttempts ||
    next.minIntervalMinutes !== before.minIntervalMinutes ||
    next.lookbackHours !== before.lookbackHours
  ) {
    try {
      await storage.recordAdminSettingChange({
        settingKey: SETTING_AUTO_RETRY,
        scope: null,
        changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
        oldValues: before as unknown as Record<string, unknown>,
        newValues: next as unknown as Record<string, unknown>,
      });
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] Auto-retry audit failed:", err?.message);
    }
  }
  cachedAutoRetry = next;
  return next;
}

export type RetryOutcome = {
  notificationId: string;
  rootId: string;
  channel: "slack" | "email";
  destination: string;
  status: "sent" | "failed" | "skipped" | "blocked";
  attemptNumber: number;
  errorMessage: string | null;
  latencyMs: number | null;
  reason?: string;
};

// Canonical per-row resend path. Loads the row, replays the alert payload
// against its original channel + destination, records a new history row
// with attemptNumber = max(chain) + 1 and parentNotificationId pointing
// at the chain root. Bulk and auto retries call this for each candidate.
export async function retryNotificationById(
  notificationId: string,
  trigger: DigestTrigger & { source: "manual" | "retry" | "auto_retry" } = {
    source: "retry",
    actorId: null,
  },
  options: { maxAttempts?: number } = {},
): Promise<RetryOutcome> {
  // Task #813: idempotent SELECT — wrap in dbRetry so transient Neon
  // recycles (especially during the auto-retry tick) don't surface as
  // hard worker failures.
  const row = await dbRetry(
    () => getRateLimitAlertNotification(notificationId),
    "rateLimitAlert.retryNotificationById:get",
  );
  if (!row) {
    return {
      notificationId,
      rootId: notificationId,
      channel: "slack",
      destination: "",
      status: "blocked",
      attemptNumber: 0,
      errorMessage: "Notification not found",
      latencyMs: null,
      reason: "not_found",
    };
  }
  const alert = parseUsageAlertPayload(row.alert);
  if (!alert) {
    return {
      notificationId,
      rootId: row.parentNotificationId ?? row.id,
      channel: row.channel as any,
      destination: row.destination,
      status: "blocked",
      attemptNumber: row.attemptNumber,
      errorMessage: "Original alert payload missing or malformed",
      latencyMs: null,
      reason: "invalid_payload",
    };
  }
  if (row.channel !== "slack" && row.channel !== "email") {
    return {
      notificationId,
      rootId: row.parentNotificationId ?? row.id,
      channel: "slack",
      destination: row.destination,
      status: "blocked",
      attemptNumber: row.attemptNumber,
      errorMessage: `Unsupported channel: ${row.channel}`,
      latencyMs: null,
      reason: "unsupported_channel",
    };
  }
  const rootId = row.parentNotificationId ?? row.id;
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
  // Task #813: idempotent MAX() lookup — wrap in dbRetry.
  const currentMax = await dbRetry(
    () => getMaxAttemptForChain(rootId, row.destination),
    "rateLimitAlert.retryNotificationById:getMaxAttemptForChain",
  );
  if (currentMax >= maxAttempts) {
    // Task #1249: fire a one-shot heads-up so admins notice when a chain
    // has officially exhausted its retry budget. The shared helper
    // `processMaxAttemptsCapWarnings` enforces strict per-(rootId,
    // destination) one-shot dedupe (a chain whose warning was already
    // delivered at attempt ≥ currentMax stays silent forever) and
    // respects the shared notify settings, so manual/bulk retries and
    // the auto-retry tick converge on a single Slack/email message per
    // exhausted chain. Fire-and-forget — never block the resend HTTP
    // response on Slack/email latency.
    const capInfo: CappedChainInfo = {
      rootId,
      destination: row.destination,
      channel: row.channel as "slack" | "email",
      category: row.category,
      userId: row.userId ?? "(unknown)",
      userLabel: row.userLabel || row.userId || "(unknown)",
      attemptNumber: currentMax,
      maxAttempts,
      lastAttemptedAt: Number(row.attemptedAt) || Date.now(),
      lastError: row.errorMessage,
    };
    void processMaxAttemptsCapWarnings([capInfo]).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        "[RateLimitAlertNotifier] max-attempts cap warning (retry path) failed:",
        message,
      );
    });
    return {
      notificationId,
      rootId,
      channel: row.channel,
      destination: row.destination,
      status: "blocked",
      attemptNumber: currentMax,
      errorMessage: `Max attempts reached (${currentMax}/${maxAttempts})`,
      latencyMs: null,
      reason: "max_attempts",
    };
  }
  const nextAttempt = currentMax + 1;
  const userLabel = row.userLabel || (await describeUser(alert.userId));
  const extras = { attemptNumber: nextAttempt, parentNotificationId: rootId };
  const channel = row.channel as "slack" | "email";
  const result =
    channel === "slack"
      ? await sendSlack(alert, row.destination, userLabel, trigger, extras)
      : await sendEmail(alert, row.destination, userLabel, trigger, extras);
  return {
    notificationId: result.rowId ?? notificationId,
    rootId,
    channel,
    destination: row.destination,
    status: result.status,
    attemptNumber: nextAttempt,
    errorMessage: result.errorMessage,
    latencyMs: result.latencyMs,
  };
}

// Bulk retry (#671) — built on the per-row path. Filters mirror the
// notification history list so admins can resend exactly what they're
// looking at. Hard cap so a single click can't unleash thousands of sends.
const BULK_RETRY_HARD_CAP = 200;
export async function bulkRetryFailedNotifications(
  filters: RateLimitAlertNotificationFilters,
  trigger: DigestTrigger & { source: "manual" } = { source: "manual", actorId: null },
  limit = BULK_RETRY_HARD_CAP,
): Promise<{ attempted: number; outcomes: RetryOutcome[] }> {
  const safeLimit = Math.max(1, Math.min(limit, BULK_RETRY_HARD_CAP));
  // Task #813: idempotent SELECT — wrap in dbRetry.
  const candidates = await dbRetry(
    () => listFailedNotificationsForRetry(filters, safeLimit),
    "rateLimitAlert.bulkRetryFailedNotifications:list",
  );
  const auto = await loadAutoRetryConfig();
  const outcomes: RetryOutcome[] = [];
  for (const c of candidates) {
    const outcome = await retryNotificationById(
      c.id,
      { source: "retry", actorId: trigger.actorId ?? null },
      { maxAttempts: auto.maxAttempts },
    );
    outcomes.push(outcome);
  }
  return { attempted: outcomes.length, outcomes };
}

// Background auto-retry pass (#672). Caller is the scheduler; can also be
// invoked manually. Dedupes by (rootId, destination): if the latest
// attempt for that chain already succeeded or has reached the cap, it's
// skipped. Resends attempts use the same per-row resend function so the
// history row shape and attempt numbering stay identical.
export async function runAutoRetryPass(
  triggerActorId: string | null = null,
): Promise<{
  scanned: number;
  retried: number;
  skipped: number;
  outcomes: RetryOutcome[];
}> {
  const config = await loadAutoRetryConfig();
  if (!config.enabled) return { scanned: 0, retried: 0, skipped: 0, outcomes: [] };
  const { listFailedRetryCandidates, getLatestAttemptsForChains } = await import(
    "../storage/rateLimitAlertNotificationsStorage"
  );
  const minAgeMs = config.minIntervalMinutes * 60_000;
  const lookbackMs = config.lookbackHours * 60 * 60_000;
  // Task #813: pure idempotent SELECTs invoked from the periodic
  // auto-retry tick — wrap in dbRetry so a transient Neon recycle is
  // absorbed instead of being charged to dbFailures.
  const candidates = await dbRetry(
    () => listFailedRetryCandidates(minAgeMs, lookbackMs, 100),
    "rateLimitAlert.runAutoRetryPass:listCandidates",
  );
  if (candidates.length === 0) return { scanned: 0, retried: 0, skipped: 0, outcomes: [] };
  const rootIds = candidates.map((c) => c.id);
  const latest = await dbRetry(
    () => getLatestAttemptsForChains(rootIds),
    "rateLimitAlert.runAutoRetryPass:getLatest",
  );
  const latestByKey = new Map(latest.map((l) => [`${l.rootId}::${l.destination}`, l]));
  const outcomes: RetryOutcome[] = [];
  let retried = 0;
  let skipped = 0;
  const trigger: DigestTrigger & { source: "auto_retry" } = {
    source: "auto_retry",
    actorId: triggerActorId,
  };
  const cappedChains: CappedChainInfo[] = [];
  for (const cand of candidates) {
    const key = `${cand.id}::${cand.destination}`;
    const cur = latestByKey.get(key);
    // Dedupe: the chain has already been resolved (someone retried since,
    // or the auto-retry pass already covered it within this minInterval).
    if (cur) {
      if (cur.status === "sent") {
        skipped++;
        continue;
      }
      if (cur.attemptNumber >= config.maxAttempts) {
        skipped++;
        // Task #1252 follow-up: only warn when the latest attempt was
        // an actual delivery failure. A `skipped` latest (Slack
        // disconnected, category disabled, dedupe, etc.) is an
        // infrastructure / policy outcome — not a destination problem
        // — and must not trip the exhausted-retry heads-up. We still
        // short-circuit (no retryNotificationById call) so the cap is
        // honored; we just don't enqueue a max-attempts warning for it.
        // Without this guard, a chain whose latest entry is
        // `skipped attempt>=cap` (e.g. left over from a prior
        // auto-retry tick that ran while Slack was unreachable) would
        // re-fire the warning forever, doubling up with the current
        // pass's warning for an unrelated capped chain.
        if (cur.status === "failed") {
          // Task #793: chain has exhausted retries. Queue a one-shot
          // warning (subject to per-chain cooldown) so admins notice
          // persistently broken destinations instead of letting the
          // failure rot in history. Processed in a single batch after
          // the loop so the hot path stays simple.
          cappedChains.push({
            rootId: cand.id,
            destination: cand.destination,
            channel: cand.channel as "slack" | "email",
            category: cand.category,
            userId: cand.userId ?? "(unknown)",
            userLabel: cand.userLabel || cand.userId || "(unknown)",
            attemptNumber: cur.attemptNumber,
            maxAttempts: config.maxAttempts,
            lastAttemptedAt: cur.attemptedAt,
            lastError: null,
          });
        }
        continue;
      }
      if (Date.now() - cur.attemptedAt < minAgeMs) {
        skipped++;
        continue;
      }
    }
    const outcome = await retryNotificationById(cand.id, trigger, {
      maxAttempts: config.maxAttempts,
    });
    if (outcome.status === "blocked") skipped++;
    else retried++;
    outcomes.push(outcome);
    // If this attempt itself just put the chain at the cap and still
    // failed, queue a max-attempts warning for it too.
    if (
      outcome.status === "failed" &&
      outcome.attemptNumber >= config.maxAttempts
    ) {
      cappedChains.push({
        rootId: outcome.rootId,
        destination: outcome.destination,
        channel: outcome.channel,
        category: cand.category,
        userId: cand.userId ?? "(unknown)",
        userLabel: cand.userLabel || cand.userId || "(unknown)",
        attemptNumber: outcome.attemptNumber,
        maxAttempts: config.maxAttempts,
        lastAttemptedAt: Date.now(),
        lastError: outcome.errorMessage,
      });
    }
  }
  if (cappedChains.length > 0) {
    try {
      await processMaxAttemptsCapWarnings(cappedChains);
    } catch (err: any) {
      console.error(
        "[RateLimitAlertNotifier] max-attempts cap warning processing failed:",
        err?.message ?? err,
      );
    }
  }
  return { scanned: candidates.length, retried, skipped, outcomes };
}

// =====================================================================
// Max-attempts-reached warning (Task #793)
// =====================================================================
// When `runAutoRetryPass` skips a chain because attemptNumber has reached
// `maxAttempts`, we send a one-shot Slack/email warning so the broken
// destination gets noticed instead of sitting in history forever. Dedupe
// is per (rootId, destination) with a configurable cooldown — within the
// cooldown the same chain stays silent even if it keeps showing up in the
// pass.

const SETTING_MAX_ATTEMPTS_WARNING = "rate_limit_alert_max_attempts_warning";
const SETTING_MAX_ATTEMPTS_WARNING_STATE =
  "rate_limit_alert_max_attempts_warning_state";

export interface MaxAttemptsWarningConfig {
  enabled: boolean;
  cooldownMinutes: number;
}

const DEFAULT_MAX_ATTEMPTS_WARNING: MaxAttemptsWarningConfig = {
  enabled: true,
  cooldownMinutes: 24 * 60,
};

const MAX_ATTEMPTS_WARNING_COOLDOWN_MAX = 30 * 24 * 60; // 30 days
const MAX_ATTEMPTS_WARNING_STATE_ENTRIES = 500;

type CappedChainInfo = {
  rootId: string;
  destination: string;
  channel: "slack" | "email";
  category: string;
  userId: string;
  userLabel: string;
  attemptNumber: number;
  maxAttempts: number;
  lastAttemptedAt: number;
  lastError: string | null;
};

type MaxAttemptsWarningStateEntry = {
  lastWarningAt: number;
  lastWarningStatus: "sent" | "failed" | "skipped";
  lastWarningError: string | null;
  attemptNumber: number;
};

type MaxAttemptsWarningState = {
  chains: Record<string, MaxAttemptsWarningStateEntry>;
};

let cachedMaxAttemptsWarning: MaxAttemptsWarningConfig | null = null;

export async function loadMaxAttemptsWarningConfig(
  force = false,
): Promise<MaxAttemptsWarningConfig> {
  if (!force && cachedMaxAttemptsWarning) return cachedMaxAttemptsWarning;
  try {
    const row = await dbRetry(
      () => storage.getSystemSetting(SETTING_MAX_ATTEMPTS_WARNING),
      "rateLimitAlert.loadMaxAttemptsWarningConfig",
    );
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value) as Partial<MaxAttemptsWarningConfig>;
        cachedMaxAttemptsWarning = {
          enabled:
            typeof parsed.enabled === "boolean"
              ? parsed.enabled
              : DEFAULT_MAX_ATTEMPTS_WARNING.enabled,
          cooldownMinutes:
            typeof parsed.cooldownMinutes === "number" && parsed.cooldownMinutes > 0
              ? Math.min(
                  MAX_ATTEMPTS_WARNING_COOLDOWN_MAX,
                  Math.floor(parsed.cooldownMinutes),
                )
              : DEFAULT_MAX_ATTEMPTS_WARNING.cooldownMinutes,
        };
        return cachedMaxAttemptsWarning;
      } catch {}
    }
  } catch {}
  cachedMaxAttemptsWarning = { ...DEFAULT_MAX_ATTEMPTS_WARNING };
  return cachedMaxAttemptsWarning;
}

export async function setMaxAttemptsWarningConfig(
  patch: Partial<MaxAttemptsWarningConfig>,
  updatedBy: string,
): Promise<MaxAttemptsWarningConfig> {
  const before = await loadMaxAttemptsWarningConfig();
  const next: MaxAttemptsWarningConfig = {
    enabled: patch.enabled ?? before.enabled,
    cooldownMinutes:
      patch.cooldownMinutes !== undefined && Number.isFinite(patch.cooldownMinutes)
        ? Math.max(
            1,
            Math.min(MAX_ATTEMPTS_WARNING_COOLDOWN_MAX, Math.floor(patch.cooldownMinutes)),
          )
        : before.cooldownMinutes,
  };
  await storage.setSystemSetting(
    SETTING_MAX_ATTEMPTS_WARNING,
    JSON.stringify(next),
    updatedBy,
  );
  if (
    next.enabled !== before.enabled ||
    next.cooldownMinutes !== before.cooldownMinutes
  ) {
    try {
      await storage.recordAdminSettingChange({
        settingKey: SETTING_MAX_ATTEMPTS_WARNING,
        scope: null,
        changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
        oldValues: before as unknown as Record<string, unknown>,
        newValues: next as unknown as Record<string, unknown>,
      });
    } catch (err: any) {
      console.error(
        "[RateLimitAlertNotifier] Max-attempts warning audit failed:",
        err?.message,
      );
    }
  }
  cachedMaxAttemptsWarning = next;
  return next;
}

async function loadMaxAttemptsWarningState(): Promise<MaxAttemptsWarningState> {
  try {
    const row = await storage.getSystemSetting(SETTING_MAX_ATTEMPTS_WARNING_STATE);
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      const chains: Record<string, MaxAttemptsWarningStateEntry> = {};
      if (parsed && typeof parsed === "object" && parsed.chains && typeof parsed.chains === "object") {
        for (const [k, v] of Object.entries(parsed.chains as Record<string, unknown>)) {
          if (!v || typeof v !== "object") continue;
          const e = v as Record<string, unknown>;
          if (typeof e.lastWarningAt !== "number") continue;
          chains[k] = {
            lastWarningAt: e.lastWarningAt,
            lastWarningStatus:
              e.lastWarningStatus === "sent" ||
              e.lastWarningStatus === "failed" ||
              e.lastWarningStatus === "skipped"
                ? e.lastWarningStatus
                : "failed",
            lastWarningError:
              typeof e.lastWarningError === "string" ? e.lastWarningError : null,
            attemptNumber: typeof e.attemptNumber === "number" ? e.attemptNumber : 0,
          };
        }
      }
      return { chains };
    }
  } catch {}
  return { chains: {} };
}

async function saveMaxAttemptsWarningState(
  state: MaxAttemptsWarningState,
): Promise<void> {
  // Bound entry count by evicting the oldest lastWarningAt entries.
  const entries = Object.entries(state.chains);
  if (entries.length > MAX_ATTEMPTS_WARNING_STATE_ENTRIES) {
    entries.sort((a, b) => b[1].lastWarningAt - a[1].lastWarningAt);
    state = {
      chains: Object.fromEntries(entries.slice(0, MAX_ATTEMPTS_WARNING_STATE_ENTRIES)),
    };
  }
  try {
    await storage.setSystemSetting(
      SETTING_MAX_ATTEMPTS_WARNING_STATE,
      JSON.stringify(state),
      "system",
    );
  } catch (err: any) {
    console.error(
      "[RateLimitAlertNotifier] Persist max-attempts warning state failed:",
      err?.message,
    );
  }
}

export async function getMaxAttemptsWarningInfo(): Promise<{
  config: MaxAttemptsWarningConfig;
  state: MaxAttemptsWarningState;
  trackedChains: number;
}> {
  const [config, state] = await Promise.all([
    loadMaxAttemptsWarningConfig(),
    loadMaxAttemptsWarningState(),
  ]);
  return { config, state, trackedChains: Object.keys(state.chains).length };
}

async function processMaxAttemptsCapWarnings(
  capped: CappedChainInfo[],
): Promise<void> {
  if (capped.length === 0) return;
  const config = await loadMaxAttemptsWarningConfig();
  if (!config.enabled) return;
  // Collapse duplicates within a single pass.
  const byKey = new Map<string, CappedChainInfo>();
  for (const c of capped) {
    byKey.set(`${c.rootId}::${c.destination}`, c);
  }
  const state = await loadMaxAttemptsWarningState();
  // Task #1249: strict one-shot dedupe per (rootId, destination). Once a
  // warning for a given chain has been successfully delivered at attempt
  // N, every later call against the same chain at attempt ≤ N stays
  // silent — irrespective of how much time has elapsed. The
  // `cooldownMinutes` setting still bounds the *retry* cadence for
  // previously-failed/skipped warnings (e.g. Slack outage when the cap
  // was first reached) so they can recover without piling up duplicate
  // heads-ups. A genuinely *new* cap event (attempt count strictly
  // greater than the last alerted attempt) always re-alerts so admins
  // notice if the cap was raised and the chain failed again.
  const cooldownMs = config.cooldownMinutes * 60_000;
  const now = Date.now();
  const notify = await loadAlertNotifyConfig();
  let mutated = false;
  for (const [key, info] of byKey) {
    // Honor the shared notify settings: if this alert category is
    // muted via the primary alert config, the cap-exhausted heads-up
    // is muted too (parity with primary alerts).
    if (notify.disabledCategories.includes(info.category)) {
      console.warn(
        `[RateLimitAlertNotifier] Max-attempts warning suppressed (category disabled): chain=${key} category=${info.category}`,
      );
      continue;
    }
    const prev = state.chains[key];
    if (prev) {
      // Strict one-shot: prior successful delivery at this attempt or
      // higher → never re-alert for this chain.
      if (
        prev.lastWarningStatus === "sent" &&
        prev.attemptNumber >= info.attemptNumber
      ) {
        continue;
      }
      // Prior non-success at this attempt or higher → respect retry
      // cooldown so a flaky destination doesn't get spammed.
      if (
        prev.attemptNumber >= info.attemptNumber &&
        now - prev.lastWarningAt < cooldownMs
      ) {
        continue;
      }
    }
    const result = await sendMaxAttemptsWarning(info, notify);
    state.chains[key] = {
      lastWarningAt: now,
      lastWarningStatus: result.status,
      lastWarningError: result.errorMessage,
      attemptNumber: info.attemptNumber,
    };
    mutated = true;
    console.warn(
      `[RateLimitAlertNotifier] Max-attempts warning: chain=${key} attempts=${info.attemptNumber}/${info.maxAttempts} status=${result.status}` +
        (result.errorMessage ? ` error=${result.errorMessage}` : ""),
    );
  }
  if (mutated) await saveMaxAttemptsWarningState(state);
}

async function sendMaxAttemptsWarning(
  info: CappedChainInfo,
  notify: AlertNotifyConfig,
): Promise<{ status: "sent" | "failed" | "skipped"; errorMessage: string | null }> {
  const slackText =
    `:no_entry: *Auto-retry exhausted* — ${info.channel} delivery to \`${info.destination}\` ` +
    `failed ${info.attemptNumber}/${info.maxAttempts} times and will not be retried automatically.\n` +
    `Chain root: \`${info.rootId}\`\n` +
    `User: ${info.userLabel} · Category: \`${info.category}\`\n` +
    `Last attempt: ${new Date(info.lastAttemptedAt).toISOString()}` +
    (info.lastError ? `\nLast error: ${info.lastError}` : "") +
    `\nFix the destination (revoked token, bounced address, etc.) then resend from the notification history.`;
  const emailSubject = `[Rate-limit alerts] Auto-retry exhausted for ${info.channel} → ${info.destination}`;
  const emailBody =
    `Auto-retry has stopped retrying a rate-limit alert delivery because it reached the attempt cap.\n\n` +
    `Chain root id: ${info.rootId}\n` +
    `Channel: ${info.channel}\n` +
    `Destination: ${info.destination}\n` +
    `User: ${info.userLabel}\n` +
    `Category: ${info.category}\n` +
    `Attempts: ${info.attemptNumber}/${info.maxAttempts}\n` +
    `Last attempt: ${new Date(info.lastAttemptedAt).toISOString()}\n` +
    (info.lastError ? `Last error: ${info.lastError}\n` : "") +
    `\nThe original failure will sit in history until the destination is fixed and the alert is manually resent.\n`;

  let status: "sent" | "failed" | "skipped" = "skipped";
  let errorMessage: string | null = "No destination configured";
  if (notify.slackChannelId) {
    try {
      const { postMessage, isConnected } = await import("./slackIntegration");
      if (await isConnected()) {
        await postMessage(notify.slackChannelId, slackText);
        status = "sent";
        errorMessage = null;
      } else {
        status = "skipped";
        errorMessage = "Slack not connected";
      }
    } catch (err: any) {
      status = "failed";
      errorMessage = err?.message ?? "Unknown error";
    }
  }
  if (notify.email && status !== "sent") {
    if (isMailerConfigured()) {
      try {
        const result = await sendMailerEmail({
          to: [notify.email],
          subject: emailSubject,
          text: emailBody,
          logPrefix: "[RateLimitAlertNotifier:MaxAttempts]",
        });
        if (result.ok) {
          status = "sent";
          errorMessage = null;
        } else {
          status = "failed";
          errorMessage = result.message ?? result.reason ?? "Unknown error";
        }
      } catch (err: any) {
        status = "failed";
        errorMessage = err?.message ?? "Unknown error";
      }
    } else if (status === "skipped") {
      errorMessage = "SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not configured";
    }
  }
  return { status, errorMessage };
}

// =====================================================================
// Test alert (#669)
// =====================================================================

const SETTING_LAST_TEST_ALERT = "rate_limit_alert_last_test";

export type LastTestAlert = {
  attemptedAt: number;
  actorId: string | null;
  outcomes: Array<{
    channel: "slack" | "email";
    destination: string;
    status: "sent" | "failed" | "skipped";
    errorMessage: string | null;
    latencyMs: number | null;
  }>;
};

export async function getLastTestAlert(): Promise<LastTestAlert | null> {
  try {
    const row = await storage.getSystemSetting(SETTING_LAST_TEST_ALERT);
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as LastTestAlert;
    if (typeof parsed?.attemptedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function sendTestAlert(actorId: string | null): Promise<LastTestAlert> {
  const config = await loadAlertNotifyConfig();
  const now = Date.now();
  const synthetic: UsageAlert = {
    userId: actorId ?? "test-user",
    category: "test",
    count: 1,
    max: 1,
    warningPercent: 100,
    windowStart: now,
    windowMs: 60_000,
    triggeredAt: now,
  };
  const userLabel = "Test alert";
  const trigger: DigestTrigger & { source: "test" } = { source: "test" as any, actorId };
  const outcomes: LastTestAlert["outcomes"] = [];
  if (config.slackChannelId) {
    const r = await sendSlack(synthetic, config.slackChannelId, userLabel, trigger as any);
    outcomes.push({
      channel: "slack",
      destination: config.slackChannelId,
      status: r.status,
      errorMessage: r.errorMessage,
      latencyMs: r.latencyMs,
    });
  }
  if (config.email) {
    const r = await sendEmail(synthetic, config.email, userLabel, trigger as any);
    outcomes.push({
      channel: "email",
      destination: config.email,
      status: r.status,
      errorMessage: r.errorMessage,
      latencyMs: r.latencyMs,
    });
  }
  if (outcomes.length === 0) {
    outcomes.push({
      channel: "slack",
      destination: "(none configured)",
      status: "skipped",
      errorMessage: "No Slack channel or email recipient configured",
      latencyMs: null,
    });
  }
  const result: LastTestAlert = { attemptedAt: now, actorId, outcomes };
  try {
    await storage.setSystemSetting(
      SETTING_LAST_TEST_ALERT,
      JSON.stringify(result),
      actorId ?? "system",
    );
  } catch (err: any) {
    console.error("[RateLimitAlertNotifier] Persist last test alert failed:", err?.message);
  }
  return result;
}

// =====================================================================
// Queued-digest growth warning (#648)
// =====================================================================

const SETTING_DIGEST_GROWTH = "rate_limit_alert_digest_growth";
const SETTING_DIGEST_GROWTH_STATE = "rate_limit_alert_digest_growth_state";

export interface DigestGrowthConfig {
  enabled: boolean;
  warnAt: number;
  cooldownMinutes: number;
  // The flush is considered "overdue" when the time since the last
  // successful flush exceeds (cadence interval) × overdueMultiplier.
  // Only meaningful when cadence is hourly or daily; ignored otherwise.
  overdueMultiplier: number;
  // Task #1107: opt-in kill switch. When true, an "overdue" warning also
  // triggers a `flushDigestNow({ source: "auto_overdue" })` so destinations
  // that recover on their own catch up without operator intervention. The
  // auto-flush rides the same cooldown as the warning (it only fires when
  // the warning fires) so it can't loop on a hard failure.
  autoFlushOnOverdue: boolean;
}

const DEFAULT_DIGEST_GROWTH: DigestGrowthConfig = {
  enabled: true,
  warnAt: 500,
  cooldownMinutes: 60,
  overdueMultiplier: 2,
  autoFlushOnOverdue: false,
};

const MAX_OVERDUE_MULTIPLIER = 100;

export async function loadDigestGrowthConfig(): Promise<DigestGrowthConfig> {
  try {
    // Task #813: idempotent SELECT — wrap in dbRetry for transient resilience.
    const row = await dbRetry(
      () => storage.getSystemSetting(SETTING_DIGEST_GROWTH),
      "rateLimitAlert.loadDigestGrowthConfig",
    );
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Partial<DigestGrowthConfig>;
      return {
        enabled:
          typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_DIGEST_GROWTH.enabled,
        warnAt:
          typeof parsed.warnAt === "number" && parsed.warnAt > 0
            ? Math.min(MAX_PENDING_DIGEST, Math.floor(parsed.warnAt))
            : DEFAULT_DIGEST_GROWTH.warnAt,
        cooldownMinutes:
          typeof parsed.cooldownMinutes === "number" && parsed.cooldownMinutes > 0
            ? Math.min(7 * 24 * 60, Math.floor(parsed.cooldownMinutes))
            : DEFAULT_DIGEST_GROWTH.cooldownMinutes,
        overdueMultiplier:
          typeof parsed.overdueMultiplier === "number" && parsed.overdueMultiplier > 0
            ? Math.min(MAX_OVERDUE_MULTIPLIER, parsed.overdueMultiplier)
            : DEFAULT_DIGEST_GROWTH.overdueMultiplier,
        autoFlushOnOverdue:
          typeof parsed.autoFlushOnOverdue === "boolean"
            ? parsed.autoFlushOnOverdue
            : DEFAULT_DIGEST_GROWTH.autoFlushOnOverdue,
      };
    }
  } catch {}
  return { ...DEFAULT_DIGEST_GROWTH };
}

export async function setDigestGrowthConfig(
  patch: Partial<DigestGrowthConfig>,
  updatedBy: string,
): Promise<DigestGrowthConfig> {
  const before = await loadDigestGrowthConfig();
  const next: DigestGrowthConfig = {
    enabled: patch.enabled ?? before.enabled,
    warnAt:
      patch.warnAt !== undefined && Number.isFinite(patch.warnAt)
        ? Math.max(1, Math.min(MAX_PENDING_DIGEST, Math.floor(patch.warnAt)))
        : before.warnAt,
    cooldownMinutes:
      patch.cooldownMinutes !== undefined && Number.isFinite(patch.cooldownMinutes)
        ? Math.max(1, Math.min(7 * 24 * 60, Math.floor(patch.cooldownMinutes)))
        : before.cooldownMinutes,
    overdueMultiplier:
      patch.overdueMultiplier !== undefined && Number.isFinite(patch.overdueMultiplier)
        ? Math.max(1, Math.min(MAX_OVERDUE_MULTIPLIER, patch.overdueMultiplier))
        : before.overdueMultiplier,
    autoFlushOnOverdue:
      patch.autoFlushOnOverdue !== undefined
        ? !!patch.autoFlushOnOverdue
        : before.autoFlushOnOverdue,
  };
  await storage.setSystemSetting(SETTING_DIGEST_GROWTH, JSON.stringify(next), updatedBy);
  if (
    next.enabled !== before.enabled ||
    next.warnAt !== before.warnAt ||
    next.cooldownMinutes !== before.cooldownMinutes ||
    next.overdueMultiplier !== before.overdueMultiplier ||
    next.autoFlushOnOverdue !== before.autoFlushOnOverdue
  ) {
    try {
      await storage.recordAdminSettingChange({
        settingKey: SETTING_DIGEST_GROWTH,
        scope: null,
        changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
        oldValues: before as unknown as Record<string, unknown>,
        newValues: next as unknown as Record<string, unknown>,
      });
    } catch (err: any) {
      console.error("[RateLimitAlertNotifier] Digest growth audit failed:", err?.message);
    }
  }
  return next;
}

export type DigestGrowthState = {
  lastWarningAt: number | null;
  lastWarningPending: number | null;
  lastWarningStatus: "sent" | "failed" | "skipped" | null;
  lastWarningError: string | null;
  // The reason the most recent warning was raised — "threshold" when the
  // pending count exceeded warnAt, or "overdue" when the last successful
  // flush was older than (intervalMs × overdueMultiplier).
  lastWarningReason: "threshold" | "overdue" | null;
};

async function loadDigestGrowthState(): Promise<DigestGrowthState> {
  try {
    const row = await storage.getSystemSetting(SETTING_DIGEST_GROWTH_STATE);
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      return {
        lastWarningAt: typeof parsed.lastWarningAt === "number" ? parsed.lastWarningAt : null,
        lastWarningPending:
          typeof parsed.lastWarningPending === "number" ? parsed.lastWarningPending : null,
        lastWarningStatus: parsed.lastWarningStatus ?? null,
        lastWarningError: parsed.lastWarningError ?? null,
        lastWarningReason:
          parsed.lastWarningReason === "threshold" || parsed.lastWarningReason === "overdue"
            ? parsed.lastWarningReason
            : null,
      };
    }
  } catch {}
  return {
    lastWarningAt: null,
    lastWarningPending: null,
    lastWarningStatus: null,
    lastWarningError: null,
    lastWarningReason: null,
  };
}

async function saveDigestGrowthState(state: DigestGrowthState): Promise<void> {
  try {
    await storage.setSystemSetting(SETTING_DIGEST_GROWTH_STATE, JSON.stringify(state), "system");
  } catch (err: any) {
    console.error("[RateLimitAlertNotifier] Persist growth state failed:", err?.message);
  }
}

// Compute whether the digest flush is "overdue" — i.e., the last successful
// flush is older than (cadence interval) × overdueMultiplier. Returns
// null when not applicable (cadence is realtime, no anchor yet, or growth
// disabled). When something is queued and the timer never fired, the
// staleness is measured from when the timer was started.
function computeFlushOverdue(config: DigestGrowthConfig): {
  overdue: boolean;
  overdueByMs: number | null;
  expectedFlushBy: number | null;
} {
  const cadence = cached?.cadence ?? "realtime";
  const intervalMs = cadenceIntervalMs(cadence);
  if (!config.enabled || cadence === "realtime" || intervalMs <= 0) {
    return { overdue: false, overdueByMs: null, expectedFlushBy: null };
  }
  const anchor = lastDigestFlushAt ?? digestTimerStartedAt;
  if (anchor == null) {
    return { overdue: false, overdueByMs: null, expectedFlushBy: null };
  }
  const expectedFlushBy = anchor + Math.max(1, intervalMs * config.overdueMultiplier);
  const overdueByMs = Date.now() - expectedFlushBy;
  return {
    overdue: overdueByMs > 0,
    overdueByMs: overdueByMs > 0 ? overdueByMs : null,
    expectedFlushBy,
  };
}

// Rolling in-memory sample buffer of `pendingDigest.length` so the
// admin UI can render a sparkline of the queue size over time. Sampled
// once per scheduler tick (~60s) by `recordDigestGrowthSample()`. We
// keep this in memory — it's purely visualization and a server restart
// just resets the trace, so paying for a `system_settings` write every
// minute would be needlessly expensive.
const DIGEST_GROWTH_HISTORY_MAX = 60;
type DigestGrowthSample = { at: number; pending: number };
const digestGrowthHistory: DigestGrowthSample[] = [];

export function recordDigestGrowthSample(now: number = Date.now()): DigestGrowthSample {
  const sample: DigestGrowthSample = { at: now, pending: pendingDigest.length };
  digestGrowthHistory.push(sample);
  if (digestGrowthHistory.length > DIGEST_GROWTH_HISTORY_MAX) {
    digestGrowthHistory.splice(0, digestGrowthHistory.length - DIGEST_GROWTH_HISTORY_MAX);
  }
  return sample;
}

export function getDigestGrowthHistory(): {
  samples: DigestGrowthSample[];
  max: number;
} {
  return { samples: digestGrowthHistory.slice(), max: DIGEST_GROWTH_HISTORY_MAX };
}

export async function getDigestGrowthInfo(): Promise<{
  config: DigestGrowthConfig;
  state: DigestGrowthState;
  pending: number;
  triggered: boolean;
  overdue: boolean;
  overdueByMs: number | null;
  expectedFlushBy: number | null;
  lastFlushAt: number | null;
  cadence: AlertCadence;
}> {
  const [config, state] = await Promise.all([loadDigestGrowthConfig(), loadDigestGrowthState()]);
  await hydratePendingDigest().catch(() => undefined);
  const pending = pendingDigest.length;
  const triggered = config.enabled && pending >= config.warnAt;
  const { overdue, overdueByMs, expectedFlushBy } = computeFlushOverdue(config);
  return {
    config,
    state,
    pending,
    triggered,
    overdue,
    overdueByMs,
    expectedFlushBy,
    lastFlushAt: lastDigestFlushAt,
    cadence: cached?.cadence ?? "realtime",
  };
}

// Periodic check; called by the auto-retry scheduler tick. When the
// queued-digest count keeps growing past the configured threshold we send
// a one-off Slack/email warning (separate event payload from individual
// delivery failures, so the existing per-alert dedupe doesn't apply).
// Rate-limited by `cooldownMinutes` so we don't spam if the queue stays
// elevated for a long time.
export async function checkDigestGrowthOnce(): Promise<{
  triggered: boolean;
  pending: number;
  warned: boolean;
}> {
  const config = await loadDigestGrowthConfig();
  if (!config.enabled) return { triggered: false, pending: pendingDigest.length, warned: false };
  await hydratePendingDigest().catch(() => undefined);
  const pending = pendingDigest.length;
  const overdueInfo = computeFlushOverdue(config);
  // Only treat the flush as overdue when there is actually something queued —
  // an idle queue with no flushes for a while isn't a delivery problem.
  const overdueWithBacklog = overdueInfo.overdue && pending > 0;
  const reason: "threshold" | "overdue" | null =
    pending >= config.warnAt ? "threshold" : overdueWithBacklog ? "overdue" : null;
  if (!reason) return { triggered: false, pending, warned: false };
  const state = await loadDigestGrowthState();
  const cooldownMs = config.cooldownMinutes * 60_000;
  if (state.lastWarningAt && Date.now() - state.lastWarningAt < cooldownMs) {
    return { triggered: true, pending, warned: false };
  }
  const notify = await loadAlertNotifyConfig();
  const overdueMin =
    overdueInfo.overdueByMs != null ? Math.round(overdueInfo.overdueByMs / 60_000) : 0;
  const text =
    reason === "threshold"
      ? `:warning: *Rate-limit digest queue is backing up* — ${pending} warning${
          pending === 1 ? "" : "s"
        } pending (threshold ${config.warnAt}). ` +
        `Either the digest cadence isn't keeping up, the destination is failing, or there's a flood of new warnings.`
      : `:warning: *Rate-limit digest flush is overdue* — last flush was ${overdueMin} minute${
          overdueMin === 1 ? "" : "s"
        } past the expected interval, with ${pending} warning${
          pending === 1 ? "" : "s"
        } still queued. The destination may be failing or the scheduler may be stuck.`;
  let status: "sent" | "failed" | "skipped" = "skipped";
  let errorMessage: string | null = "No destination configured";
  if (notify.slackChannelId) {
    try {
      const { postMessage, isConnected } = await import("./slackIntegration");
      if (await isConnected()) {
        await postMessage(notify.slackChannelId, text);
        status = "sent";
        errorMessage = null;
      } else {
        status = "skipped";
        errorMessage = "Slack not connected";
      }
    } catch (err: any) {
      status = "failed";
      errorMessage = err?.message ?? "Unknown error";
    }
  }
  if (notify.email && status !== "sent") {
    if (isMailerConfigured()) {
      const result = await sendMailerEmail({
        to: [notify.email],
        subject:
          reason === "threshold"
            ? `Rate-limit digest queue is backing up (${pending} pending)`
            : `Rate-limit digest flush is overdue (${pending} pending, ${overdueMin}m late)`,
        text,
        logPrefix: "[RateLimitAlertNotifier:DigestGrowth]",
      });
      if (result.ok) {
        status = "sent";
        errorMessage = null;
      } else {
        status = "failed";
        errorMessage = result.message ?? "Unknown error";
      }
    }
  }
  await saveDigestGrowthState({
    lastWarningAt: Date.now(),
    lastWarningPending: pending,
    lastWarningStatus: status,
    lastWarningError: errorMessage,
    lastWarningReason: reason,
  });
  console.warn(
    `[RateLimitAlertNotifier] Digest growth warning: reason=${reason} pending=${pending} threshold=${config.warnAt} overdueByMs=${overdueInfo.overdueByMs ?? 0} status=${status}`,
  );
  // Task #1107: opt-in catch-up flush. We only run this when the warning
  // itself fires, which means it inherits the warning's cooldown — a hard
  // failure can't loop because the next warning (and therefore the next
  // auto-flush) won't fire until cooldownMinutes has elapsed. The per-alert
  // delivery rows written by `flushDigestNow` carry triggerSource
  // "auto_overdue" so the notification history reflects the attempt and its
  // outcome.
  if (reason === "overdue" && config.autoFlushOnOverdue) {
    try {
      await flushDigestNow({ source: "auto_overdue" });
      console.log(
        `[RateLimitAlertNotifier] Auto-flush on overdue triggered (pending=${pending}).`,
      );
    } catch (err: any) {
      console.error(
        "[RateLimitAlertNotifier] Auto-flush on overdue failed:",
        err?.message ?? err,
      );
    }
  }
  return { triggered: true, pending, warned: true };
}

export async function getDigestStatus(): Promise<{
  pending: number;
  lastFlushAt: number | null;
  cadence: AlertCadence;
  intervalMs: number;
  nextFlushAt: number | null;
}> {
  // Make sure persisted entries are reflected in the count even if no
  // notification has fired yet since the last restart.
  await hydratePendingDigest().catch(() => undefined);
  const cadence = cached?.cadence ?? "realtime";
  const intervalMs = cadenceIntervalMs(cadence);
  let nextFlushAt: number | null = null;
  if (cadence !== "realtime" && intervalMs > 0) {
    const anchor = lastDigestFlushAt ?? digestTimerStartedAt;
    if (anchor != null) {
      let next = anchor + intervalMs;
      const now = Date.now();
      if (next < now) {
        const missed = Math.ceil((now - anchor) / intervalMs);
        next = anchor + missed * intervalMs;
      }
      nextFlushAt = next;
    }
  }
  return {
    pending: pendingDigest.length,
    lastFlushAt: lastDigestFlushAt,
    cadence,
    intervalMs,
    nextFlushAt,
  };
}
