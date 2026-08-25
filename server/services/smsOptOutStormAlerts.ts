/**
 * Task #4336 — alert when inbound SMS opt-outs spike (opt-out storm).
 *
 * A burst of STOP-family keywords usually means an automated/marketing send
 * went out that shouldn't have (or annoyed recipients), a number was spoofed,
 * or an upstream list got texted without consent. At today's book size
 * (~tens of known phones) even a handful of opt-outs in an hour is a
 * five-alarm signal, hence the small default threshold.
 *
 * Structure mirrors the Task #1284 collision watcher
 * (`twilioWebhookCollisionAlerts.ts`) — same settings-knob convention, same
 * cooldown-with-growth-override semantics, same injectable dispatcher test
 * seam — with one deliberate difference: evaluation is EVENT-DRIVEN only
 * (each recorded opt-out evaluates; no interval scheduler) and the windowed
 * count comes from the durable `sms_consent_events` table, so a process
 * restart mid-storm cannot reset the count (P12). Only the cooldown
 * bookkeeping is in-memory — worst case after a restart is one duplicate
 * alert, never a missed one.
 *
 * Channel/enabled state lives in `notification_settings` for
 * `infra.twilio_webhook.sms_optout_spike`; threshold knobs live in
 * `system_settings` so an admin can tune them without a deploy.
 */

import { getSystemSetting } from "../storage/settingsStorage";
import { countRecentOptOutEvents } from "../storage/smsConsentStorage";
import { registerModuleStateResetForTest } from "./moduleStateReset";

const NOTIFICATION_ID = "infra.twilio_webhook.sms_optout_spike";

export const SETTING_ENABLED = "sms_optout_storm_alert_enabled";
export const SETTING_WINDOW = "sms_optout_storm_alert_window_minutes";
export const SETTING_THRESHOLD = "sms_optout_storm_alert_threshold";
export const SETTING_COOLDOWN = "sms_optout_storm_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  windowMinutes: 60,
  threshold: 3,
  cooldownMinutes: 240,
};

/** Defensive cap on the in-memory recent-phone list (alert body only). */
const MAX_RETAINED_EVENTS = 1000;

/** How many (masked) phones to surface in the alert body for triage. */
const MAX_PHONES_IN_ALERT = 10;

export interface SmsOptOutStormAlertConfig {
  enabled: boolean;
  windowMinutes: number;
  threshold: number;
  cooldownMinutes: number;
}

interface OptOutEvent {
  phoneMasked: string;
  at: number;
}

interface LastAlertRecord {
  at: number;
  windowedCount: number;
}

const recentOptOuts: OptOutEvent[] = [];
let lastAlert: LastAlertRecord | null = null;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: { triggerSource: string; bypassDedupe?: boolean; metadata?: Record<string, unknown> },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(String(raw).trim());
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

export async function getSmsOptOutStormAlertConfig(): Promise<SmsOptOutStormAlertConfig> {
  const [enabledRow, windowRow, thresholdRow, cooldownRow] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_WINDOW).catch(() => null),
    getSystemSetting(SETTING_THRESHOLD).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabledRow?.value, DEFAULTS.enabled),
    windowMinutes: parsePositiveInt(windowRow?.value, DEFAULTS.windowMinutes),
    threshold: parsePositiveInt(thresholdRow?.value, DEFAULTS.threshold),
    cooldownMinutes: parsePositiveInt(cooldownRow?.value, DEFAULTS.cooldownMinutes),
  };
}

/** Mask the middle digits for the Slack alert body (PII discipline). */
function maskPhone(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, "");
  if (digits.length < 7) return "•••";
  return `+${digits.slice(0, digits.length - 7)}•••${digits.slice(-4)}`;
}

export interface OptOutStormCheckResult {
  evaluatedAt: string;
  enabled: boolean;
  windowMinutes: number;
  threshold: number;
  windowedCount: number;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_below_threshold"
    | "skipped_cooldown"
    | "skipped_no_growth_since_last_alert"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
}

/**
 * Record one opt-out receipt and evaluate the storm condition. Called from
 * the consent service after a keyword opt-out is applied; must be cheap and
 * must never throw (callers still wrap it best-effort).
 */
export async function recordSmsOptOutAndEvaluate(
  phoneE164: string,
): Promise<OptOutStormCheckResult> {
  recentOptOuts.push({ phoneMasked: maskPhone(phoneE164), at: Date.now() });
  if (recentOptOuts.length > MAX_RETAINED_EVENTS) {
    recentOptOuts.splice(0, recentOptOuts.length - MAX_RETAINED_EVENTS);
  }
  return evaluateOptOutStorm("optout_recorded");
}

export async function evaluateOptOutStorm(
  triggerSource: string,
): Promise<OptOutStormCheckResult> {
  const evaluatedAt = new Date().toISOString();
  const config = await getSmsOptOutStormAlertConfig();
  const base = {
    evaluatedAt,
    enabled: config.enabled,
    windowMinutes: config.windowMinutes,
    threshold: config.threshold,
  };
  if (!config.enabled) {
    return { ...base, windowedCount: 0, decision: "skipped_disabled" };
  }

  // Durable count — restart-proof (the in-memory list only feeds the alert
  // body). Falls back to the in-memory count if the query fails.
  let windowedCount: number;
  try {
    windowedCount = await countRecentOptOutEvents(config.windowMinutes);
  } catch (err: any) {
    console.warn(`[SmsOptOutStormAlerts] durable count failed, using in-memory: ${err?.message}`);
    const cutoff = Date.now() - config.windowMinutes * 60_000;
    windowedCount = recentOptOuts.filter((e) => e.at >= cutoff).length;
  }

  if (windowedCount < config.threshold) {
    return { ...base, windowedCount, decision: "skipped_below_threshold" };
  }

  const now = Date.now();
  if (lastAlert !== null) {
    const inCooldown = now - lastAlert.at < config.cooldownMinutes * 60_000;
    if (inCooldown) {
      // Growth override: a storm that keeps growing by another full
      // threshold re-alerts even inside the cooldown.
      if (windowedCount < lastAlert.windowedCount + config.threshold) {
        return { ...base, windowedCount, decision: "skipped_cooldown" };
      }
    } else if (windowedCount <= lastAlert.windowedCount) {
      // Out of cooldown but the window still contains only already-alerted
      // events — stay silent until NEW opt-outs arrive.
      return { ...base, windowedCount, decision: "skipped_no_growth_since_last_alert" };
    }
  }

  const cutoff = now - config.windowMinutes * 60_000;
  const recentMasked = [
    ...new Set(recentOptOuts.filter((e) => e.at >= cutoff).map((e) => e.phoneMasked)),
  ].slice(-MAX_PHONES_IN_ALERT);
  const text = [
    `🚨 SMS opt-out storm: ${windowedCount} STOP-family opt-out(s) in the last ${config.windowMinutes} min (threshold ${config.threshold}).`,
    `Likely causes: an automated/marketing send that shouldn't have gone out, an annoyed recipient list, or webhook replay abuse.`,
    recentMasked.length > 0 ? `Recent numbers: ${recentMasked.join(", ")}` : "",
    `Review: /admin/sms-consent (ledger + events).`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const dispatch =
      dispatcherOverride ??
      ((await import("./notifications/dispatcher")).notifyByType as NotifyByTypeFn);
    const result = await dispatch(
      NOTIFICATION_ID,
      { text, preview: `SMS opt-out storm: ${windowedCount} in ${config.windowMinutes}m` },
      {
        triggerSource,
        bypassDedupe: true,
        metadata: { windowedCount, windowMinutes: config.windowMinutes },
      },
    );
    if (!result.delivered && result.status !== "skipped_deduped") {
      // Dispatch resolves on failure too (house convention) — only a
      // delivered/deduped result counts as "alerted" for cooldown purposes.
      return { ...base, windowedCount, decision: "skipped_dispatcher_skipped" };
    }
  } catch (err: any) {
    console.warn(`[SmsOptOutStormAlerts] dispatch failed: ${err?.message}`);
    return { ...base, windowedCount, decision: "skipped_send_failed" };
  }

  lastAlert = { at: now, windowedCount };
  return { ...base, windowedCount, decision: "alerted" };
}

registerModuleStateResetForTest("smsOptOutStormAlerts", () => {
  recentOptOuts.length = 0;
  lastAlert = null;
  dispatcherOverride = null;
});

export const __testHelpers = {
  NOTIFICATION_ID,
  DEFAULTS,
  MAX_RETAINED_EVENTS,
  MAX_PHONES_IN_ALERT,
  resetForTests(): void {
    recentOptOuts.length = 0;
    lastAlert = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  recentCount(): number {
    return recentOptOuts.length;
  },
};
