// Task #3661 — durable per-integration disconnect forensics.
//
// Every genuine terminal disconnect (token wipe, breaker trip, manual
// disconnect) previously left only ephemeral console logs, so each incident
// restarted the same debugging cycle. This module persists ONE structured
// "why did this integration disconnect" record per integration in
// system_settings, written at every wipe/trip site and surfaced verbatim on
// the Integrations Hub card so the next disconnect self-explains.
//
// Design notes:
//   - Latest-record-wins (a single system_settings row per integration).
//     The full history remains in admin_setting_audit; this record is the
//     operator-facing "current incident" summary.
//   - Writes are best-effort and never throw — a forensics-write failure
//     must never block or fail the wipe/trip path it is recording.
//   - The record is intentionally denormalized (plain-English summary +
//     operatorAction) so the Hub needs zero interpretation logic.

import { storage } from "../storage";

// Task #4008 — `"google_ads"` left this union with the retired platform
// connection: the env-credential model has no wipe/trip/manual-disconnect
// sites to record (a terminal token rejection surfaces live via the shared
// mint's negative cache instead). Historical `integration_disconnect_
// forensics:google_ads` rows may still exist in system_settings; nothing
// reads them anymore.
export type DisconnectForensicsIntegration = "semrush";

/** Which code path recorded the disconnect (or near-disconnect) event. */
export type DisconnectForensicsCodePath =
  | "authoritative_wipe" // SEMrush onTerminalAfterRetry cleared tokens
  | "wipe_aborted_sibling_rotated" // fingerprint changed — wipe aborted
  | "wipe_skipped_non_authoritative" // probe/proactive terminal — no wipe
  | "wipe_confirmation_read_failed" // Task #3661 fail-safe: re-read threw → wipe aborted, breaker tripped
  | "manual_disconnect" // operator pressed Disconnect
  | "connect_terminal_auth_error"; // credential clear during a failed connect flow

export interface DisconnectForensicsRecord {
  integration: DisconnectForensicsIntegration;
  codePath: DisconnectForensicsCodePath;
  /** Refresh purpose that hit the terminal error (authoritative/probe/proactive/…). */
  purpose?: string | null;
  /** Raw provider error body/message (truncated). */
  providerError?: string | null;
  /** OAuth error code when known (invalid_grant, invalid_client, …). */
  providerErrorCode?: string | null;
  /** Fingerprint-comparison outcome for wipe-confirmation paths. */
  fingerprintOutcome?: string | null;
  /** Machine classification (e.g. client_credentials_mismatch, token_revoked). */
  classification?: string | null;
  /** Plain-English what-happened summary for the operator. */
  summary: string;
  /** Plain-English what-to-do-next guidance for the operator. */
  operatorAction: string;
  /** Instance that recorded the event. */
  instanceId?: string | null;
  /** ISO timestamp; filled by recordDisconnectForensics when omitted. */
  recordedAt?: string;
}

export function disconnectForensicsSettingKey(
  integration: DisconnectForensicsIntegration,
): string {
  return `integration_disconnect_forensics:${integration}`;
}

/**
 * Persist the latest disconnect-forensics record. Best-effort: logs and
 * swallows any storage failure so callers can fire-and-forget from wipe/trip
 * paths without risking the primary action.
 */
export async function recordDisconnectForensics(
  record: DisconnectForensicsRecord,
): Promise<void> {
  const full: DisconnectForensicsRecord = {
    ...record,
    providerError: record.providerError ? record.providerError.slice(0, 500) : record.providerError ?? null,
    recordedAt: record.recordedAt ?? new Date().toISOString(),
  };
  try {
    await storage.setSystemSetting(
      disconnectForensicsSettingKey(record.integration),
      JSON.stringify(full),
      "system",
    );
  } catch (err: any) {
    console.error(
      `[DisconnectForensics] failed to persist ${record.integration} record (codePath=${record.codePath}):`,
      err?.message ?? err,
    );
  }
}

/** Read the latest forensics record for an integration (null when none). */
export async function getDisconnectForensics(
  integration: DisconnectForensicsIntegration,
): Promise<DisconnectForensicsRecord | null> {
  try {
    const row = await storage.getSystemSetting(disconnectForensicsSettingKey(integration));
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object" || typeof parsed.summary !== "string") return null;
    return parsed as DisconnectForensicsRecord;
  } catch (err: any) {
    console.warn(
      `[DisconnectForensics] failed to read ${integration} record:`,
      err?.message ?? err,
    );
    return null;
  }
}

// (Task #4008: the Google Ads terminal-refresh classification helper that
// lived here was retired with the platform refresh path — the shared
// env-trio mint in adsOs/googleAdsClient.ts now carries the terminal
// signature verbatim in its negative-cache detail.)
