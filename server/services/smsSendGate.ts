/**
 * Task #4336 — THE single guarded entry point for automated SMS.
 *
 * CONTRACT (owner-approved via Task #4336; expensive to reverse — do not
 * weaken without an explicit compliance decision):
 *   - Every AUTOMATED send (scheduler, sequence step, campaign, AI agent —
 *     anything not a human pressing Send on a specific thread) MUST go
 *     through `sendAutomatedSms`. Nothing else may call
 *     `twilioService.sendSms` for automated traffic.
 *   - The gate blocks unless ALL of:
 *       1. the kill switch `automatedSendsEnabled` is ON (default OFF; read
 *          FRESH from the DB on every send — never the 5-min cached path),
 *       2. the recipient's consent ledger state is exactly `opted_in`
 *          (`unknown` is NOT sendable — strict opt-in, the TCPA-safe floor),
 *       3. the recipient-local quiet-hours window allows it (conservative
 *          multi-timezone policy — see smsQuietHours.ts).
 *   - EVERY evaluation is audited to sms_send_gate_audit — allowed and
 *     blocked alike — so a future opt-out investigation can attribute every
 *     attempt ("purpose" is the caller's machine label).
 *   - Human console 1:1 sends deliberately BYPASS this gate (they are
 *     conversational, human-judgment traffic — the Conversation Hub surfaces
 *     the recipient's consent state to the sender instead). They keep using
 *     `twilioService.sendSms` directly.
 *
 * There are intentionally NO production callers yet: automated/marketing
 * SMS is future work that additionally requires a registered campaign. The
 * gate ships first so that work CANNOT ship without passing through it.
 */

import { z } from "zod";
import { getSystemSettingFresh } from "../storage/settingsStorage";
import * as smsConsentStorage from "../storage/smsConsentStorage";
import { normalizeToE164, getPhoneMatchKey } from "./phoneNormalization";
import {
  evaluateQuietHours,
  DEFAULT_SEND_WINDOW_START_HOUR_LOCAL,
  DEFAULT_SEND_WINDOW_END_HOUR_LOCAL,
} from "./smsQuietHours";
import { sendSms } from "./twilioService";
import type { SmsConsentState, SmsSendGateOutcome } from "@shared/schema";

export const SMS_SEND_GATE_CONFIG_KEY = "sms_send_gate_config";

/**
 * Stored as one JSON value under `sms_send_gate_config`. Any parse problem
 * degrades to the DEFAULTS — i.e. kill switch OFF — never to a permissive
 * state.
 */
export const smsSendGateConfigSchema = z.object({
  automatedSendsEnabled: z.boolean().catch(false).default(false),
  sendWindowStartHourLocal: z.number().int().min(0).max(23).catch(DEFAULT_SEND_WINDOW_START_HOUR_LOCAL).default(DEFAULT_SEND_WINDOW_START_HOUR_LOCAL),
  sendWindowEndHourLocal: z.number().int().min(0).max(23).catch(DEFAULT_SEND_WINDOW_END_HOUR_LOCAL).default(DEFAULT_SEND_WINDOW_END_HOUR_LOCAL),
});

export type SmsSendGateConfig = z.infer<typeof smsSendGateConfigSchema>;

export const SMS_SEND_GATE_DEFAULT_CONFIG: SmsSendGateConfig = {
  automatedSendsEnabled: false,
  sendWindowStartHourLocal: DEFAULT_SEND_WINDOW_START_HOUR_LOCAL,
  sendWindowEndHourLocal: DEFAULT_SEND_WINDOW_END_HOUR_LOCAL,
};

/**
 * Fresh (uncached) read — the kill switch must react immediately to an
 * emergency OFF, not after a 5-minute cache TTL (P7).
 */
export async function getSmsSendGateConfig(): Promise<SmsSendGateConfig> {
  let raw: string | null | undefined;
  try {
    const row = await getSystemSettingFresh(SMS_SEND_GATE_CONFIG_KEY);
    raw = row?.value;
  } catch (err: any) {
    console.warn(`[SmsSendGate] config read failed — using locked defaults: ${err?.message}`);
    return { ...SMS_SEND_GATE_DEFAULT_CONFIG };
  }
  if (!raw) return { ...SMS_SEND_GATE_DEFAULT_CONFIG };
  try {
    return smsSendGateConfigSchema.parse(JSON.parse(raw));
  } catch {
    console.warn(`[SmsSendGate] config value unparseable — using locked defaults`);
    return { ...SMS_SEND_GATE_DEFAULT_CONFIG };
  }
}

export interface AutomatedSmsRequest {
  to: string;
  body: string;
  /**
   * Machine label for WHAT automation is attempting the send
   * (e.g. "booking_reminder"). Recorded on every audit row.
   */
  purpose: string;
  /**
   * Real users.id the send runs on behalf of. Used for both the
   * twilio_messages sent_by attribution and the gate audit row.
   */
  senderUserId: string;
  /** Optional durable idempotency passthrough to `sendSms` (Task #3896). */
  operationId?: string;
}

export type AutomatedSmsGateResult =
  | {
      outcome: "sent";
      consentState: "opted_in";
      messageId: string;
      twilioSid: string;
      conversationId: string;
      status: string;
    }
  | {
      outcome: "blocked";
      reason: "kill_switch" | "no_consent" | "opted_out" | "quiet_hours" | "invalid_phone";
      consentState: SmsConsentState | null;
      detail: string;
    };

export interface SmsSendGateDeps {
  /** Test seam — replaces the real Twilio send. */
  sendSmsImpl?: typeof sendSms;
  /** Test seam — injectable clock for quiet-hours matrices. */
  now?: () => Date;
}

async function writeAudit(entry: {
  phoneNormalized: string;
  purpose: string;
  outcome: SmsSendGateOutcome;
  consentState: SmsConsentState | null;
  detail: string;
  requestedByUserId: string | null;
}): Promise<void> {
  try {
    await smsConsentStorage.insertSendGateAudit({
      phoneNormalized: entry.phoneNormalized,
      purpose: entry.purpose,
      outcome: entry.outcome,
      consentState: entry.consentState,
      detail: entry.detail,
      requestedByUserId: entry.requestedByUserId,
    });
  } catch (err: any) {
    // The audit trail must never turn a decided outcome into a thrown error
    // (a blocked result stays blocked; a successful send stays successful) —
    // but its absence is loud in the logs.
    console.error(`[SmsSendGate] AUDIT WRITE FAILED (${entry.outcome}): ${err?.message}`);
  }
}

/**
 * Consent + quiet-hours gate, then delegate to the existing idempotent
 * `sendSms` machinery. Blocked outcomes RETURN (discriminated union) rather
 * than throw; a Twilio-side send failure after the gate passed rethrows
 * exactly like `sendSms` does (after auditing `send_failed`).
 */
export async function sendAutomatedSms(
  request: AutomatedSmsRequest,
  deps: SmsSendGateDeps = {},
): Promise<AutomatedSmsGateResult> {
  const purpose = request.purpose?.trim();
  if (!purpose) {
    throw new Error("[SmsSendGate] `purpose` is required — every automated send must be attributable");
  }

  const phoneE164 = normalizeToE164(request.to);
  const matchKey = getPhoneMatchKey(request.to);
  // NANP-only by policy: every recipient in this book of business is +1;
  // anything else is far likelier a malformed number than a real
  // international recipient, and quiet-hours resolution would be a guess.
  if (matchKey === null || !/^\+1\d{10}$/.test(phoneE164)) {
    const detail = `Recipient "${request.to}" did not normalize to a NANP E.164 number`;
    await writeAudit({
      phoneNormalized: phoneE164 || request.to,
      purpose,
      outcome: "blocked_invalid_phone",
      consentState: null,
      detail,
      requestedByUserId: request.senderUserId ?? null,
    });
    return { outcome: "blocked", reason: "invalid_phone", consentState: null, detail };
  }

  // One indexed point read; feeds both the decision and every audit row.
  const ledgerRow = await smsConsentStorage.getConsentByPhoneE164(phoneE164);
  const consentState = (ledgerRow?.state as SmsConsentState | undefined) ?? "unknown";

  const config = await getSmsSendGateConfig();
  if (!config.automatedSendsEnabled) {
    const detail = "Kill switch `automatedSendsEnabled` is OFF (default)";
    await writeAudit({
      phoneNormalized: phoneE164,
      purpose,
      outcome: "blocked_kill_switch",
      consentState,
      detail,
      requestedByUserId: request.senderUserId ?? null,
    });
    return { outcome: "blocked", reason: "kill_switch", consentState, detail };
  }

  if (consentState !== "opted_in") {
    const blockedReason = consentState === "opted_out" ? "opted_out" : "no_consent";
    const detail =
      consentState === "opted_out"
        ? `Recipient opted out${ledgerRow?.optedOutAt ? ` at ${ledgerRow.optedOutAt.toISOString()}` : ""} (source: ${ledgerRow?.source ?? "unknown"})`
        : ledgerRow === null
          ? "No consent ledger row exists for this number (strict opt-in: unknown is not sendable)"
          : "Consent state is `unknown` (strict opt-in: unknown is not sendable)";
    await writeAudit({
      phoneNormalized: phoneE164,
      purpose,
      outcome: consentState === "opted_out" ? "blocked_opted_out" : "blocked_no_consent",
      consentState,
      detail,
      requestedByUserId: request.senderUserId ?? null,
    });
    return { outcome: "blocked", reason: blockedReason, consentState, detail };
  }

  const now = deps.now?.() ?? new Date();
  const quietHours = evaluateQuietHours({
    now,
    phoneE164,
    overrideTimezone: ledgerRow?.timezone ?? null,
    startHourLocal: config.sendWindowStartHourLocal,
    endHourLocal: config.sendWindowEndHourLocal,
  });
  if (!quietHours.withinSendWindow) {
    const detail =
      `Outside the ${config.sendWindowStartHourLocal}:00–${config.sendWindowEndHourLocal}:00 recipient-local window ` +
      `(tz source: ${quietHours.timezoneSource}; blocked in: ${quietHours.blockedZones
        .map((tz) => `${tz}@${quietHours.localHours[tz]}h`)
        .join(", ")})`;
    await writeAudit({
      phoneNormalized: phoneE164,
      purpose,
      outcome: "blocked_quiet_hours",
      consentState,
      detail,
      requestedByUserId: request.senderUserId ?? null,
    });
    return { outcome: "blocked", reason: "quiet_hours", consentState, detail };
  }

  const sendImpl = deps.sendSmsImpl ?? sendSms;
  try {
    const sent = await sendImpl({
      to: request.to,
      body: request.body,
      userId: request.senderUserId,
      operationId: request.operationId,
    });
    await writeAudit({
      phoneNormalized: phoneE164,
      purpose,
      outcome: "allowed",
      consentState,
      detail: `Sent (sid ${sent.twilioSid}, tz source: ${quietHours.timezoneSource})`,
      requestedByUserId: request.senderUserId ?? null,
    });
    return {
      outcome: "sent",
      consentState: "opted_in",
      messageId: sent.messageId,
      twilioSid: sent.twilioSid,
      conversationId: sent.conversationId,
      status: sent.status,
    };
  } catch (err: any) {
    await writeAudit({
      phoneNormalized: phoneE164,
      purpose,
      outcome: "send_failed",
      consentState,
      detail: `Gate passed but Twilio send failed: ${String(err?.message ?? err).slice(0, 500)}`,
      requestedByUserId: request.senderUserId ?? null,
    });
    // Preserve sendSms error semantics for the (future) caller — including
    // the 21610 reconciliation hook that already ran inside sendSms.
    throw err;
  }
}
