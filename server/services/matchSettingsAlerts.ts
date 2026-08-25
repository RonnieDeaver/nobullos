import { storage } from "../storage";
import { sendEmail as sendMailerEmail, isMailerConfigured } from "./mailer";

const SLACK_CHANNEL_SETTING = "match_settings_alert_slack_channel_id";
const SLACK_CHANNEL_ENV = "MATCH_SETTINGS_SLACK_CHANNEL_ID";
const TEST_HISTORY_SETTING = "match_settings_alert_test_history";
const TEST_HISTORY_MAX_ENTRIES = 10;

let cachedChannelId: string | null | undefined = undefined;

export async function getMatchSettingsAlertChannelId(): Promise<string | null> {
  if (cachedChannelId !== undefined) return cachedChannelId;
  try {
    const setting = await storage.getSystemSetting(SLACK_CHANNEL_SETTING);
    cachedChannelId = setting?.value?.trim() || null;
  } catch {
    cachedChannelId = null;
  }
  return cachedChannelId;
}

export async function setMatchSettingsAlertChannelId(
  channelId: string | null,
  updatedBy: string,
): Promise<string | null> {
  const trimmed = (channelId ?? "").trim();
  const next = trimmed || null;
  let previous: string | null = null;
  try {
    previous = (await getMatchSettingsAlertChannelId()) ?? null;
  } catch {
    previous = null;
  }
  await storage.setSystemSetting(SLACK_CHANNEL_SETTING, trimmed, updatedBy);
  cachedChannelId = next;
  if (previous !== next) {
    try {
      await storage.recordAdminSettingChange({
        settingKey: SLACK_CHANNEL_SETTING,
        scope: null,
        changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
        oldValues: { channelId: previous },
        newValues: { channelId: next },
      });
    } catch (err: any) {
      console.error("[match-settings-alerts] Audit record failed:", err?.message);
    }
  }
  return cachedChannelId;
}

async function resolveAlertChannel(): Promise<string | null> {
  const fromSetting = await getMatchSettingsAlertChannelId();
  if (fromSetting) return fromSetting;
  return process.env[SLACK_CHANNEL_ENV] || null;
}

export type MatchSettingAlertPayload = {
  scope: string;
  scopeLabel: string;
  settingKey: string;
  settingLabel: string;
  oldValue: string;
  newValue: string;
  action: "updated" | "cleared";
  actorName: string;
  recipientEmails: string[];
};

const EMAIL_ENABLED_ENV = "MATCH_SETTINGS_EMAIL_ENABLED";
const EMAIL_FROM_OVERRIDE_ENV = "MATCH_SETTINGS_EMAIL_FROM";

function buildPlainText(p: MatchSettingAlertPayload): string {
  const verb = p.action === "cleared" ? "cleared override for" : "changed";
  return (
    `${p.actorName} ${verb} "${p.settingLabel}" (${p.settingKey}) on ${p.scopeLabel}: ` +
    `${p.oldValue} → ${p.newValue}`
  );
}

function buildSlackBlocks(p: MatchSettingAlertPayload): any[] {
  const verb = p.action === "cleared" ? "cleared override for" : "changed";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:gear: *Matching threshold ${p.action}*\n` +
          `${p.actorName} ${verb} *${p.settingLabel}* (\`${p.settingKey}\`)`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Scope*\n${p.scopeLabel}` },
        { type: "mrkdwn", text: `*Change*\n${p.oldValue} → ${p.newValue}` },
      ],
    },
  ];
}

export type AlertDeliveryStatus = "delivered" | "skipped" | "failed";

export type AlertDeliveryOutcome = {
  status: AlertDeliveryStatus;
  failureReason?: string | null;
};

const FAILURE_REASON_MAX_LEN = 200;

function shortenReason(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = String(s).replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > FAILURE_REASON_MAX_LEN
    ? trimmed.slice(0, FAILURE_REASON_MAX_LEN - 1) + "…"
    : trimmed;
}

function summarizeSlackError(err: any): string {
  const msg = err?.message ? String(err.message) : String(err);
  // Strip the redundant "Slack API error: " prefix our wrapper adds.
  const cleaned = msg.replace(/^Slack API error:\s*/i, "");
  return shortenReason(`Slack: ${cleaned}`) || "Slack: unknown error";
}

function summarizeEmailFailure(reason: string, status?: number, message?: string): string {
  switch (reason) {
    case "http_error":
      return shortenReason(
        `SendGrid HTTP ${status ?? "?"}${message ? `: ${message}` : ""}`,
      ) || `SendGrid HTTP ${status ?? "?"}`;
    case "timeout":
      return "SendGrid request timed out";
    case "exception":
      return shortenReason(`SendGrid exception${message ? `: ${message}` : ""}`) ||
        "SendGrid exception";
    default:
      return shortenReason(`SendGrid ${reason}`) || `SendGrid ${reason}`;
  }
}

async function sendSlackAlert(p: MatchSettingAlertPayload): Promise<AlertDeliveryOutcome> {
  // Task #994: route through the unified dispatcher so the Slack
  // Notifications Console controls channel + enabled state. The dispatcher's
  // resolver honors `notification_settings` first, then env override, then
  // the legacy `match_settings_alert_slack_channel_id` key, so existing
  // installs continue to work. We disable dedupe because this service has
  // no transition cadence — every settings change is a discrete event.
  const { notifyByType } = await import("./notifications/dispatcher");
  const result = await notifyByType(
    "workflow.match_settings.changed",
    {
      text: buildPlainText(p),
      blocks: buildSlackBlocks(p),
      preview: { settingKey: p.settingKey, action: p.action, scopeLabel: p.scopeLabel },
    },
    { triggerSource: "alert_service", bypassDedupe: true },
  );
  if (result.delivered) return { status: "delivered" };
  if (result.status === "failed") {
    const reason = summarizeSlackError(new Error(result.error ?? "Slack delivery failed"));
    console.warn("[match-settings-alerts] Slack alert failed:", result.error);
    return { status: "failed", failureReason: reason };
  }
  return { status: "skipped" };
}

async function sendEmailAlert(p: MatchSettingAlertPayload): Promise<AlertDeliveryOutcome> {
  if (process.env[EMAIL_ENABLED_ENV] !== "1" && process.env[EMAIL_ENABLED_ENV] !== "true") {
    return { status: "skipped" };
  }
  if (p.recipientEmails.length === 0) return { status: "skipped" };

  const subject = `[Matching Thresholds] ${p.settingLabel} ${p.action} on ${p.scopeLabel}`;
  const text = buildPlainText(p);
  const html =
    `<p><strong>${p.actorName}</strong> ${p.action === "cleared" ? "cleared override for" : "changed"} ` +
    `<strong>${p.settingLabel}</strong> (<code>${p.settingKey}</code>)</p>` +
    `<ul><li><strong>Scope:</strong> ${p.scopeLabel}</li>` +
    `<li><strong>Old value:</strong> ${p.oldValue}</li>` +
    `<li><strong>New value:</strong> ${p.newValue}</li></ul>`;

  const result = await sendMailerEmail({
    to: p.recipientEmails,
    subject,
    text,
    html,
    fromOverride: process.env[EMAIL_FROM_OVERRIDE_ENV],
    logPrefix: "[match-settings-alerts]",
  });
  if (result.ok) return { status: "delivered" };
  if (result.reason === "missing_config" || result.reason === "no_recipients") {
    return { status: "skipped" };
  }
  return {
    status: "failed",
    failureReason: summarizeEmailFailure(result.reason, result.status, result.message),
  };
}

// Test-only seam (Task #799): lets the route-level resend tests substitute
// a spy/stub for the broadcast without standing up Slack + SendGrid. The
// override receives the same payload + channels options so tests can assert
// what the route forwarded; production code never sets this. Pass `null`
// to clear.
type MatchSettingsBroadcastFn = (
  p: MatchSettingAlertPayload,
  options?: { channels?: { slack?: boolean; email?: boolean } },
) => Promise<{ slack: AlertDeliveryOutcome; email: AlertDeliveryOutcome }>;
let __matchSettingsBroadcastOverride: MatchSettingsBroadcastFn | null = null;
export function __test_setBroadcastOverride(fn: MatchSettingsBroadcastFn | null): void {
  __matchSettingsBroadcastOverride = fn;
}

export async function broadcastMatchSettingChange(
  p: MatchSettingAlertPayload,
  options?: { channels?: { slack?: boolean; email?: boolean } },
): Promise<{
  slack: AlertDeliveryOutcome;
  email: AlertDeliveryOutcome;
}> {
  if (__matchSettingsBroadcastOverride) return __matchSettingsBroadcastOverride(p, options);
  const wantSlack = options?.channels?.slack ?? true;
  const wantEmail = options?.channels?.email ?? true;
  const [slack, email] = await Promise.all([
    wantSlack ? sendSlackAlert(p) : Promise.resolve<AlertDeliveryOutcome>({ status: "skipped" }),
    wantEmail ? sendEmailAlert(p) : Promise.resolve<AlertDeliveryOutcome>({ status: "skipped" }),
  ]);
  return { slack, email };
}

export const MATCH_SETTINGS_ALERT_SLACK_CHANNEL_SETTING_KEY = SLACK_CHANNEL_SETTING;
export const MATCH_SETTINGS_ALERT_TEST_HISTORY_SETTING_KEY = TEST_HISTORY_SETTING;

export type AlertChannelTestAttempt = {
  id: string;
  attemptedAt: string;
  channelId: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  success: boolean;
  errorMessage: string | null;
};

function isValidAttempt(v: any): v is AlertChannelTestAttempt {
  return (
    v &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    typeof v.attemptedAt === "string" &&
    typeof v.channelId === "string" &&
    typeof v.success === "boolean"
  );
}

export async function getRecentAlertChannelTests(
  limit: number = TEST_HISTORY_MAX_ENTRIES,
): Promise<AlertChannelTestAttempt[]> {
  try {
    const setting = await storage.getSystemSetting(TEST_HISTORY_SETTING);
    if (!setting?.value) return [];
    const parsed = JSON.parse(setting.value);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isValidAttempt);
    return valid.slice(0, Math.max(0, Math.min(limit, TEST_HISTORY_MAX_ENTRIES)));
  } catch {
    return [];
  }
}

export async function recordAlertChannelTest(
  attempt: Omit<AlertChannelTestAttempt, "id" | "attemptedAt"> &
    Partial<Pick<AlertChannelTestAttempt, "id" | "attemptedAt">>,
): Promise<AlertChannelTestAttempt> {
  const entry: AlertChannelTestAttempt = {
    id:
      attempt.id ??
      (typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    attemptedAt: attempt.attemptedAt ?? new Date().toISOString(),
    channelId: attempt.channelId,
    actorId: attempt.actorId ?? null,
    actorName: attempt.actorName ?? null,
    actorEmail: attempt.actorEmail ?? null,
    success: attempt.success,
    errorMessage: shortenReason(attempt.errorMessage),
  };
  const existing = await getRecentAlertChannelTests(TEST_HISTORY_MAX_ENTRIES);
  const next = [entry, ...existing].slice(0, TEST_HISTORY_MAX_ENTRIES);
  try {
    await storage.setSystemSetting(
      TEST_HISTORY_SETTING,
      JSON.stringify(next),
      attempt.actorId ?? "system",
    );
  } catch (err: any) {
    console.warn(
      "[match-settings-alerts] failed to persist test history:",
      err?.message ?? err,
    );
  }
  return entry;
}

export async function matchSettingAlertChannelStatus(): Promise<{
  slackConfigured: boolean;
  slackChannelId: string | null;
  slackSource: "system_setting" | "env" | "none";
  envChannelId: string | null;
  emailConfigured: boolean;
  lastEdited: import("../routes/lastEditedHelper").LastEditedInfo | null;
  lastTest: AlertChannelTestAttempt | null;
}> {
  const settingChannelId = await getMatchSettingsAlertChannelId();
  const envChannelId = process.env[SLACK_CHANNEL_ENV] || null;
  const slackChannelId = settingChannelId || envChannelId || null;
  const slackSource: "system_setting" | "env" | "none" = settingChannelId
    ? "system_setting"
    : envChannelId
    ? "env"
    : "none";
  const emailEnabled =
    process.env[EMAIL_ENABLED_ENV] === "1" || process.env[EMAIL_ENABLED_ENV] === "true";
  const emailConfigured =
    emailEnabled && isMailerConfigured(process.env[EMAIL_FROM_OVERRIDE_ENV]);

  let lastEdited: import("../routes/lastEditedHelper").LastEditedInfo | null = null;
  try {
    const setting = await storage.getSystemSetting(SLACK_CHANNEL_SETTING);
    if (setting?.updatedAt || setting?.updatedBy) {
      const { resolveLastEditedUsers, buildLastEdited } = await import(
        "../routes/lastEditedHelper"
      );
      const userMap = await resolveLastEditedUsers([setting?.updatedBy ?? null]);
      lastEdited = buildLastEdited(setting?.updatedAt, setting?.updatedBy, userMap);
    }
  } catch {
    lastEdited = null;
  }

  const recentTests = await getRecentAlertChannelTests(1);
  const lastTest = recentTests[0] ?? null;

  return {
    slackConfigured: !!slackChannelId,
    slackChannelId,
    slackSource,
    envChannelId,
    emailConfigured,
    lastEdited,
    lastTest,
  };
}
