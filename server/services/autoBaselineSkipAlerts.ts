/**
 * Task #984 — Slack/email alert when the boot-time post-deploy auto-baseline
 * snapshot is skipped because overall checklist status is not "pass".
 *
 * Without this, a deploy that comes up degraded silently never refreshes its
 * baseline (a single console line is the only signal). Operators only notice
 * days later when they open the panel. This service surfaces the skip through
 * the canonical notifications dispatcher (`notifyByType`) so the on-call hears
 * about it the same way they hear about other infra alerts.
 *
 * Dedup: persists the last-alerted timestamp in `system_settings` so repeated
 * skips across a flapping/restarting deploy don't spam the channel. Cooldown
 * default is 6 hours and is overridable via `system_settings`.
 */

import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

export const NOTIFICATION_ID = "infra.deployment.auto_baseline_skipped";

export const SETTING_LAST_ALERTED_AT =
  "post_deploy_verification:auto_baseline_skip_last_alerted_at";
export const SETTING_COOLDOWN_MINUTES =
  "post_deploy_verification:auto_baseline_skip_alert_cooldown_minutes";

export const DEFAULT_COOLDOWN_MINUTES = 6 * 60; // 6h

type NotifyByTypeFn = typeof import("./notifications/dispatcher").notifyByType;
let dispatcherOverride: NotifyByTypeFn | null = null;

export interface FailingGroup {
  id: string;
  title: string;
  status: "warn" | "fail";
}

export interface SkipAlertInput {
  overall: "warn" | "fail";
  failingGroups: FailingGroup[];
  reason: string;
}

export type SkipAlertDecision =
  | "alerted"
  | "skipped_cooldown"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped";

export interface SkipAlertResult {
  decision: SkipAlertDecision;
  cooldownMinutes: number;
  delivered: boolean;
  skipReason?: string;
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

/**
 * Dispatch an "auto-baseline skipped" alert via the canonical notifier.
 * Honors a persisted cooldown window so repeated skips during the same
 * outage / boot loop don't spam admins. Best-effort; never throws.
 */
export async function recordAutoBaselineSkip(
  input: SkipAlertInput,
): Promise<SkipAlertResult> {
  const cooldownMinutes = await getCooldownMinutes();
  const cooldownMs = cooldownMinutes * 60_000;
  const now = Date.now();

  const lastRow = await getSystemSetting(SETTING_LAST_ALERTED_AT).catch(
    () => null,
  );
  const last = Number(lastRow?.value ?? 0);
  if (Number.isFinite(last) && last > 0 && now - last < cooldownMs) {
    return {
      decision: "skipped_cooldown",
      cooldownMinutes,
      delivered: false,
      skipReason: `last alert ${Math.floor((now - last) / 60_000)}m ago < ${cooldownMinutes}m`,
    };
  }

  const groupNames =
    input.failingGroups.length === 0
      ? "(none reported)"
      : input.failingGroups
          .map((g) => `${g.title} [${g.status}]`)
          .join(", ");

  const text =
    `:warning: *Post-deploy auto-baseline skipped*\n` +
    `Overall checklist status was *${input.overall}* — the boot-time baseline ` +
    `was not refreshed.\n` +
    `Failing checks: ${groupNames}\n` +
    `Reason: ${input.reason}\n` +
    `Open System Health → Post-Deploy Verification to triage and manually ` +
    `save a baseline once the failing groups recover.`;

  let delivered = false;
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
        // Persisted cooldown above already prevents flooding.
        bypassDedupe: true,
        metadata: {
          overall: input.overall,
          failingGroups: input.failingGroups.map((g) => ({
            id: g.id,
            title: g.title,
            status: g.status,
          })),
          reason: input.reason,
          cooldownMinutes,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      "[AutoBaselineSkipAlerts] dispatch failed:",
      err?.message ?? err,
    );
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    try {
      // Omit `updatedBy` — this row is written by the auto-alert service,
      // not a real user, and the column is FK'd to `users(id)`.
      await setSystemSetting(SETTING_LAST_ALERTED_AT, String(now));
    } catch (err: any) {
      console.warn(
        "[AutoBaselineSkipAlerts] failed to persist last-alerted timestamp:",
        err?.message ?? err,
      );
    }
    return { decision: "alerted", cooldownMinutes, delivered: true };
  }

  return {
    decision: skipReason?.startsWith("dispatch_error")
      ? "skipped_send_failed"
      : "skipped_dispatcher_skipped",
    cooldownMinutes,
    delivered: false,
    skipReason,
  };
}

export const __testHelpers = {
  setDispatcher(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
};
