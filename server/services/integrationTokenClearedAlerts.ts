/**
 * Task #1978 — proactively notify responsible admins when an integration
 * token is auto-cleared because the provider returned a terminal auth error.
 *
 * Task #1968 already records every Slack token clear to `admin_setting_audit`
 * (scope = trigger) and surfaces it in the IntegrationsHub "View history"
 * dialog, but an admin has to open that dialog to notice. When a token is
 * *auto*-cleared (e.g. the connect handler self-wipes after `auth.test`
 * returns a terminal Slack auth code), downstream features start failing
 * silently until someone re-connects. This module turns that audit breadcrumb
 * into an in-app + opt-in Slack-DM ping to the integrations owners
 * (CEO / team_lead, via `getResponsibleAdminsForAlert()`).
 *
 * Cooldown: a persisted per-provider timestamp in `system_settings` suppresses
 * repeat alerts within a short window so a retry loop / autoscale restart can't
 * flood the bell. Default 30 minutes, overridable via `system_settings`.
 *
 * Best-effort: every path is wrapped so a notification failure can never block
 * the primary disconnect / token-clear work.
 */

import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

export const SETTING_COOLDOWN_MINUTES =
  "integration_token_cleared:alert_cooldown_minutes";

export const DEFAULT_COOLDOWN_MINUTES = 30;

/** Deep link to the IntegrationsHub admin page where the card is re-connected. */
const INTEGRATIONS_HUB_DEEP_LINK = "/admin/integrations";

export type IntegrationTokenClearedDecision =
  | "alerted"
  | "skipped_no_recipients"
  | "skipped_cooldown"
  | "skipped_error";

export interface IntegrationTokenClearedResult {
  decision: IntegrationTokenClearedDecision;
  cooldownMinutes: number;
  recipientCount: number;
  skipReason?: string;
}

export interface IntegrationTokenClearedInput {
  /** Provider key, e.g. "slack". Used in the cooldown key + copy. */
  provider: string;
  /** Human-readable provider label, e.g. "Slack". Defaults to `provider`. */
  providerLabel?: string;
  /** The provider error code that triggered the auto-clear, if known. */
  errorCode?: string | null;
  /** The audit scope / trigger that fired this (e.g. connect_terminal_auth_error). */
  trigger?: string | null;
}

function settingLastAlertedKey(provider: string): string {
  return `integration_token_cleared:${provider}:last_alerted_at`;
}

function parsePositiveInt(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export async function getCooldownMinutes(): Promise<number> {
  const row = await getSystemSetting(SETTING_COOLDOWN_MINUTES).catch(() => null);
  return parsePositiveInt(row?.value, DEFAULT_COOLDOWN_MINUTES);
}

// Test seam: lets unit tests stub the recipient resolver + notifier without a DB.
type ResolveRecipientsFn = () => Promise<string[]>;
type NotifyUserFn =
  typeof import("./notifications/userInbox").notifyUser;
let resolveRecipientsOverride: ResolveRecipientsFn | null = null;
let notifyUserOverride: NotifyUserFn | null = null;

/**
 * Notify the integrations owners that an integration token was auto-cleared.
 * Honors a persisted per-provider cooldown. Best-effort; never throws.
 */
export async function notifyIntegrationTokenCleared(
  input: IntegrationTokenClearedInput,
): Promise<IntegrationTokenClearedResult> {
  const cooldownMinutes = await getCooldownMinutes();
  const provider = input.provider;
  const providerLabel = input.providerLabel ?? provider;

  try {
    const cooldownMs = cooldownMinutes * 60_000;
    const now = Date.now();
    const lastKey = settingLastAlertedKey(provider);

    const lastRow = await getSystemSetting(lastKey).catch(() => null);
    const last = Number(lastRow?.value ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < cooldownMs) {
      return {
        decision: "skipped_cooldown",
        cooldownMinutes,
        recipientCount: 0,
        skipReason: `last alert ${Math.floor((now - last) / 60_000)}m ago < ${cooldownMinutes}m`,
      };
    }

    const resolveRecipients =
      resolveRecipientsOverride ??
      (await import("./notifications/recipients")).getResponsibleAdminsForAlert;
    const recipients = await resolveRecipients();
    if (recipients.length === 0) {
      return {
        decision: "skipped_no_recipients",
        cooldownMinutes,
        recipientCount: 0,
        skipReason: "no ceo/team_lead recipients resolved",
      };
    }

    const notifyUser =
      notifyUserOverride ??
      (await import("./notifications/userInbox")).notifyUser;

    const errorSuffix = input.errorCode
      ? ` (error: ${input.errorCode})`
      : "";
    const title = `${providerLabel} disconnected — token auto-cleared`;
    const body =
      `${providerLabel}'s saved token was automatically cleared after the ` +
      `provider returned a terminal auth error${errorSuffix}. ` +
      `Re-connect ${providerLabel} in the Integrations Hub before ` +
      `dependent features start failing.`;
    // One stable dedupeKey per provider so every recipient gets at most one
    // unread row per cooldown window (notifyUser dedupes per user+key within
    // an hour); the persisted cooldown above bounds repeats across windows.
    const dedupeKey = `integration-token-cleared:${provider}`;

    for (const uid of recipients) {
      try {
        await notifyUser(uid, {
          category: "system",
          title,
          body,
          deepLink: INTEGRATIONS_HUB_DEEP_LINK,
          dedupeKey,
          metadata: {
            provider,
            errorCode: input.errorCode ?? null,
            trigger: input.trigger ?? null,
          },
        });
      } catch (err: any) {
        console.warn(
          `[IntegrationTokenClearedAlerts] notifyUser(${uid}) failed: ${err?.message ?? err}`,
        );
      }
    }

    try {
      await setSystemSetting(lastKey, String(now));
    } catch (err: any) {
      console.warn(
        `[IntegrationTokenClearedAlerts] failed to persist cooldown timestamp: ${err?.message ?? err}`,
      );
    }

    return {
      decision: "alerted",
      cooldownMinutes,
      recipientCount: recipients.length,
    };
  } catch (err: any) {
    console.error(
      `[IntegrationTokenClearedAlerts] dispatch failed: ${err?.message ?? err}`,
    );
    return {
      decision: "skipped_error",
      cooldownMinutes,
      recipientCount: 0,
      skipReason: `error:${err?.message ?? "unknown"}`,
    };
  }
}

export const __testHelpers = {
  setResolveRecipients(fn: ResolveRecipientsFn | null): void {
    resolveRecipientsOverride = fn;
  },
  setNotifyUser(fn: NotifyUserFn | null): void {
    notifyUserOverride = fn;
  },
};
