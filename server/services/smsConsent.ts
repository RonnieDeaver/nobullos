/**
 * Task #4336 — SMS consent service.
 *
 * Business operations over the consent ledger:
 *   - `recordInboundConsentKeyword` — called (best-effort) from
 *     `handleInboundSms` after a NEW inbound message row is inserted. The
 *     app-level MessageSid dedupe upstream means replayed webhook deliveries
 *     never reach this hook; the partial unique index on
 *     sms_consent_events.message_sid is the database-level second belt.
 *   - `recordTwilioBlockOptOut` — reconciliation hook for Twilio error 21610
 *     ("attempt to send to unsubscribed recipient"): the carrier block list
 *     is authoritative evidence the number must not receive automated texts,
 *     regardless of what consent was previously expressed.
 *   - `setConsentManually` — operator changes from the admin ledger.
 *   - read helpers for the comms/client status surfaces.
 *
 * The app NEVER auto-replies to consent keywords: our sender is a toll-free
 * number, and Twilio's mandatory toll-free edge handling already sends the
 * STOP/START confirmation replies (cannot be disabled, even with Advanced
 * Opt-Out). App-side replies would double-message every opt-out. See
 * TWILIO.md "SMS consent & opt-out" for the full division of labor.
 */

import {
  classifySmsConsentKeyword,
  type SmsConsentKeywordMatch,
} from "./smsConsentKeywords";
import * as smsConsentStorage from "../storage/smsConsentStorage";
import { normalizeToE164, getPhoneMatchKey } from "./phoneNormalization";
import { recordSmsOptOutAndEvaluate } from "./smsOptOutStormAlerts";
import { kickGhlOutboundSyncFireAndForget } from "./ghlOutboundKick";
import type { SmsConsentLedgerRow, SmsConsentState } from "@shared/schema";

export const BOOK_CHECKOUT_SMS_DISCLOSURE_VERSION = "book-checkout-sms-v1";
export const BOOK_CHECKOUT_SMS_DISCLOSURE_COPY =
  "I agree to receive automated marketing texts from NoBull Marketing at the number provided, including cart reminders and book-buyer offers. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. See Terms and Privacy Policy.";

export interface BookCheckoutSmsChoiceResult {
  ledgerId: string;
  phoneE164: string;
  state: SmsConsentState;
  confirmationStatus: "pending" | "confirmed" | "declined";
  confirmedAt: Date | null;
}

/**
 * Record the independent book-checkout SMS choice without treating a checked
 * marketing box as completed double opt-in.
 *
 * Existing authoritative opt-in/opt-out state is never downgraded or
 * overwritten. Every checkout choice is still appended to the canonical event
 * history, and a new/unknown number remains `unknown` until an inbound
 * confirmation or other approved authority changes it.
 */
export async function recordBookCheckoutSmsChoice(params: {
  phone: string;
  selected: boolean;
  sourceUrl: string;
  capturedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<BookCheckoutSmsChoiceResult | { error: string }> {
  const phoneE164 = normalizeToE164(params.phone);
  const phoneMatchKey = getPhoneMatchKey(params.phone);
  if (!phoneE164 || phoneMatchKey === null) {
    return { error: "Enter a valid mobile number or leave the mobile field blank." };
  }

  const evidence = JSON.stringify({
    disclosureVersion: BOOK_CHECKOUT_SMS_DISCLOSURE_VERSION,
    disclosureCopy: BOOK_CHECKOUT_SMS_DISCLOSURE_COPY,
    selected: params.selected,
    confirmationStatus: params.selected ? "pending" : "declined",
    sourceUrl: params.sourceUrl.slice(0, 4000),
    capturedAt: params.capturedAt.toISOString(),
    ipAddress: params.ipAddress?.slice(0, 128) || null,
    userAgent: params.userAgent?.slice(0, 500) || null,
  });

  const existing = await smsConsentStorage.getConsentByPhoneE164(phoneE164);
  let row = existing;
  if (!existing || existing.state === "unknown") {
    const applied = await smsConsentStorage.applyConsentStateChange({
      phoneE164,
      phoneMatchKey,
      newState: "unknown",
      source: "book_checkout",
      evidence,
      event: {
        eventType: "checkout_choice",
        detail: evidence,
      },
    });
    row = applied.row;
  } else {
    await smsConsentStorage.insertConsentEvent({
      phoneNormalized: phoneE164,
      eventType: "checkout_choice",
      priorState: existing.state as SmsConsentState,
      newState: existing.state as SmsConsentState,
      source: "book_checkout",
      detail: evidence,
    });
  }

  if (!row) {
    throw new Error("Book checkout SMS choice did not produce durable evidence");
  }

  const state = row.state as SmsConsentState;
  const alreadyConfirmed = params.selected && state === "opted_in";
  return {
    ledgerId: row.id,
    phoneE164,
    state,
    confirmationStatus: params.selected
      ? alreadyConfirmed ? "confirmed" : "pending"
      : "declined",
    confirmedAt: alreadyConfirmed ? row.optedInAt : null,
  };
}

export interface InboundKeywordOutcome {
  match: SmsConsentKeywordMatch;
  result: smsConsentStorage.ConsentStateChangeResult | null;
}

/**
 * Classify an inbound SMS body for consent keywords and record the outcome.
 * Returns null when the message is not a consent keyword (the overwhelmingly
 * common case). Never throws on classification misses; storage errors DO
 * propagate so the caller's best-effort try/catch can log them.
 */
export async function recordInboundConsentKeyword(params: {
  fromPhone: string;
  body: string;
  messageSid: string;
  /** Twilio's `OptOutType` webhook field, when present (edge hint). */
  optOutTypeHint?: string | null;
}): Promise<InboundKeywordOutcome | null> {
  const match = classifySmsConsentKeyword(params.body, params.optOutTypeHint);
  if (match === null) return null;

  const phoneE164 = normalizeToE164(params.fromPhone);
  const phoneMatchKey = getPhoneMatchKey(params.fromPhone);
  if (!phoneE164 || phoneMatchKey === null) {
    // Fewer than 10 digits — nothing stable to key a ledger row on.
    console.warn(
      `[SmsConsent] Inbound keyword from unkeyable phone (${params.fromPhone.length} chars) ignored`,
    );
    return null;
  }

  if (match.kind === "help") {
    // HELP is informational: record the event for the admin feed but leave
    // the ledger state untouched (Twilio's edge already sent the help reply).
    await smsConsentStorage.insertConsentEvent({
      phoneNormalized: phoneE164,
      eventType: "help",
      messageSid: params.messageSid,
      keyword: match.keyword,
      source: "keyword_inbound",
      detail: `HELP-family keyword (matched via ${match.matchedVia})`,
    });
    return { match, result: null };
  }

  const newState: SmsConsentState = match.kind === "opt_out" ? "opted_out" : "opted_in";
  const result = await smsConsentStorage.applyDedupedConsentStateChange({
    phoneE164,
    phoneMatchKey,
    newState,
    source: "keyword_inbound",
    evidence: `Inbound "${match.keyword}" (MessageSid ${params.messageSid})`,
    event: {
      eventType: match.kind,
      messageSid: params.messageSid,
      keyword: match.keyword,
      detail: `matched via ${match.matchedVia}`,
    },
  });
  if (result.eventInserted) kickGhlOutboundSyncFireAndForget();

  if (match.kind === "opt_out") {
    // Feed the opt-out-storm watcher. Best-effort: alerting must never make
    // the webhook path fail.
    try {
      await recordSmsOptOutAndEvaluate(phoneE164);
    } catch (err: any) {
      console.warn(`[SmsConsent] opt-out storm evaluation failed: ${err?.message}`);
    }
  }

  return { match, result };
}

/**
 * Twilio error 21610 reconciliation: an outbound create was rejected because
 * the recipient is on Twilio's carrier block list for our number. Whatever
 * the ledger believed, this number is not automatable — flip it to
 * opted_out with the block as evidence. Called best-effort from the
 * `sendSms` create-error path.
 */
export async function recordTwilioBlockOptOut(params: {
  phone: string;
  /** Durable outbound SMS operation row id; dedupes repeat 21610 handling. */
  operationId: string;
  detail: string;
}): Promise<void> {
  const phoneE164 = normalizeToE164(params.phone);
  const phoneMatchKey = getPhoneMatchKey(params.phone);
  if (!phoneE164 || phoneMatchKey === null) return;
  const result = await smsConsentStorage.applyDedupedConsentStateChange({
    phoneE164,
    phoneMatchKey,
    newState: "opted_out",
    source: "twilio_block_21610",
    evidence: `Twilio rejected an outbound send with error 21610 (${params.detail})`,
    event: {
      eventType: "twilio_block",
      messageSid: `twilio:21610:${params.operationId}`,
      detail: params.detail,
    },
  });
  if (result.eventInserted) kickGhlOutboundSyncFireAndForget();
}

/** Operator-initiated state change from the admin ledger (note required). */
export async function setConsentManually(params: {
  phone: string;
  state: SmsConsentState;
  note: string;
  actorUserId: string;
  /** Optional IANA timezone override; undefined leaves existing untouched. */
  timezone?: string | null;
}): Promise<smsConsentStorage.ConsentStateChangeResult | { error: string }> {
  const phoneE164 = normalizeToE164(params.phone);
  const phoneMatchKey = getPhoneMatchKey(params.phone);
  if (!phoneE164 || phoneMatchKey === null) {
    return { error: "Phone number must contain at least 10 digits" };
  }
  const result = await smsConsentStorage.applyConsentStateChange({
    phoneE164,
    phoneMatchKey,
    newState: params.state,
    source: "manual",
    evidence: `Manual: ${params.note}`,
    timezone: params.timezone,
    actorUserId: params.actorUserId,
    event: {
      eventType: "manual_set",
      detail: params.note,
    },
  });
  if (result.eventInserted) kickGhlOutboundSyncFireAndForget();
  return result;
}

export interface ConsentStatus {
  phone: string;
  phoneMatchKey: string | null;
  state: SmsConsentState;
  /** False when no ledger row exists yet (state is implicitly `unknown`). */
  exists: boolean;
  source: string | null;
  evidence: string | null;
  timezone: string | null;
  optedInAt: Date | null;
  optedOutAt: Date | null;
  updatedAt: Date | null;
}

function toStatus(phone: string, matchKey: string | null, row: SmsConsentLedgerRow | null): ConsentStatus {
  return {
    phone,
    phoneMatchKey: matchKey,
    state: (row?.state as SmsConsentState | undefined) ?? "unknown",
    exists: row !== null,
    source: row?.source ?? null,
    evidence: row?.evidence ?? null,
    timezone: row?.timezone ?? null,
    optedInAt: row?.optedInAt ?? null,
    optedOutAt: row?.optedOutAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Consent status for one loosely-formatted phone string. */
export async function getConsentStatusForPhone(phone: string): Promise<ConsentStatus> {
  const phoneE164 = normalizeToE164(phone);
  const matchKey = getPhoneMatchKey(phone);
  if (!phoneE164 || matchKey === null) return toStatus(phone, matchKey, null);
  let row = await smsConsentStorage.getConsentByPhoneE164(phoneE164);
  if (row === null) {
    // Robustness for non-US-default formats: fall back to the match key.
    const byKey = await smsConsentStorage.getConsentsByMatchKeys([matchKey]);
    row = byKey[0] ?? null;
  }
  return toStatus(phone, matchKey, row);
}

/**
 * Batch consent lookup keyed by the caller's ORIGINAL phone strings (the UI
 * passes whatever formatting it holds; results map back verbatim).
 */
export async function getConsentStatusesForPhones(
  phones: string[],
): Promise<Record<string, ConsentStatus>> {
  const keyed = phones.map((p) => ({ phone: p, matchKey: getPhoneMatchKey(p) }));
  const keys = [...new Set(keyed.map((k) => k.matchKey).filter((k): k is string => k !== null))];
  const rows = keys.length > 0 ? await smsConsentStorage.getConsentsByMatchKeys(keys) : [];
  const byKey = new Map<string, SmsConsentLedgerRow>();
  for (const row of rows) byKey.set(row.phoneMatchKey, row);
  const out: Record<string, ConsentStatus> = {};
  for (const { phone, matchKey } of keyed) {
    out[phone] = toStatus(phone, matchKey, matchKey !== null ? (byKey.get(matchKey) ?? null) : null);
  }
  return out;
}
