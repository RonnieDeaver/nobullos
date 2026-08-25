/**
 * Task #1986 — Slack/in-app alert when a client create/update/delete audit-log
 * write fails.
 *
 * The History popover for a client is rendered straight from the
 * `user_activity_logs` rows that `insertActivityLogs` writes on create / update
 * / delete (see `server/routes/clients.ts`). Those writes are intentionally
 * best-effort: if the insert throws, the underlying mutation still succeeds so
 * a transient logging hiccup never blocks an operator from saving a client.
 *
 * The problem this service fixes: before, a failed audit-log write only emitted
 * a single `console.error` line, so a *persistently* broken logging path would
 * quietly empty the timeline with no operator-visible signal. Routing the same
 * failure through the canonical notifications dispatcher (`notifyByType`) makes
 * it surface in Slack + the in-app admin bell so a broken history path is
 * noticed instead of silently dropping events.
 *
 * Dedup: persists the last-alerted timestamp in `system_settings` so a tight
 * mutation loop hitting the same broken path doesn't spam the channel. Cooldown
 * default is 30 minutes and is overridable via `system_settings`.
 *
 * Best-effort: this service never throws. The whole point is to add a signal on
 * the failure path, not to introduce a new way for the mutation to fail.
 */

import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

export const NOTIFICATION_ID = "infra.client_audit_log.write_failed";

export const SETTING_LAST_ALERTED_AT =
  "client_audit_log:write_failed_last_alerted_at";
export const SETTING_COOLDOWN_MINUTES =
  "client_audit_log:write_failed_alert_cooldown_minutes";

export const DEFAULT_COOLDOWN_MINUTES = 30;

export type ClientAuditOperation = "create" | "update" | "delete";

type NotifyByTypeFn = typeof import("./notifications/dispatcher").notifyByType;
let dispatcherOverride: NotifyByTypeFn | null = null;

export interface AuditLogFailureInput {
  operation: ClientAuditOperation;
  clientId: string | null;
  clientFirmName?: string | null;
  /** Number of audit events that were lost by this failed write. */
  eventCount: number;
  error: unknown;
}

export type AuditLogFailureDecision =
  | "alerted"
  | "skipped_cooldown"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped";

export interface AuditLogFailureResult {
  decision: AuditLogFailureDecision;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Dispatch a "client audit-log write failed" alert via the canonical notifier.
 * Honors a persisted cooldown window so a broken logging path hit repeatedly
 * doesn't spam admins. Best-effort; never throws.
 */
export async function recordClientAuditLogWriteFailure(
  input: AuditLogFailureInput,
): Promise<AuditLogFailureResult> {
  const cooldownMinutes = await getCooldownMinutes().catch(
    () => DEFAULT_COOLDOWN_MINUTES,
  );

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

  const msg = errorMessage(input.error);
  const clientLabel = input.clientFirmName
    ? `${input.clientFirmName} (${input.clientId ?? "unknown id"})`
    : (input.clientId ?? "unknown client");

  const text =
    `:warning: *Client audit-log write failed (History popover lost ${input.eventCount} event(s))*\n` +
    `Operation: *client ${input.operation}*\n` +
    `Client: ${clientLabel}\n` +
    `The mutation itself still succeeded, but the audit rows that feed the ` +
    `client History timeline were not written. If this repeats, the logging ` +
    `path (\`insertActivityLogs\` → \`user_activity_logs\`) is broken.\n` +
    `Error: ${msg}`;

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
          operation: input.operation,
          clientId: input.clientId,
          clientFirmName: input.clientFirmName ?? null,
          eventCount: input.eventCount,
          error: msg,
          cooldownMinutes,
        },
      },
    );
    delivered = r.delivered;
    if (!r.delivered) skipReason = r.skipReason ?? r.status;
  } catch (err: any) {
    console.error(
      "[ClientAuditLogFailureAlerts] dispatch failed:",
      err?.message ?? err,
    );
    skipReason = `dispatch_error:${err?.message ?? "unknown"}`;
  }

  if (delivered) {
    try {
      await setSystemSetting(SETTING_LAST_ALERTED_AT, String(now));
    } catch (err: any) {
      console.warn(
        "[ClientAuditLogFailureAlerts] failed to persist last-alerted timestamp:",
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
