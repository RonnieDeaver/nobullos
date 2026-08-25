/**
 * Task #4336 — SMS consent keyword classifier.
 *
 * Pure leaf module (no imports) shared by the inbound-webhook consent hook,
 * the historical backfill prod-action, and tests.
 *
 * Semantics deliberately mirror Twilio's edge keyword handling (help.twilio.com
 * "Twilio support for opt-out keywords", verified 2026-08-10):
 *   - Only SINGLE-WORD message bodies classify ("STOP PLEASE" does not).
 *   - Matching is case-insensitive.
 *   - Opt-out additionally tolerates trailing punctuation ("STOP.") — Twilio
 *     may not block that at the edge, but recording the opt-out anyway is the
 *     compliance-safe direction (we only ever become STRICTER than carrier
 *     enforcement, never looser).
 *   - Opt-in and help require an exact keyword (no trailing punctuation), so
 *     we never record consent Twilio's edge would not have re-subscribed.
 *
 * Keyword sets = the union of the task-mandated HubSpot floor and Twilio's
 * post-April-2025 FCC default list:
 *   opt-out: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT (+ FCC 2025
 *            additions REVOKE, OPTOUT)
 *   opt-in:  START, UNSTOP, SUBSCRIBE (+ Twilio long-code YES)
 *   help:    HELP, INFO
 *
 * Divergence note (documented in TWILIO.md): on our toll-free sender Twilio
 * only honors START/UNSTOP for carrier un-blocking. YES/SUBSCRIBE still
 * record expressed consent here; if the carrier block persists, the next
 * automated send fails with Twilio error 21610 and the reconciliation hook
 * flips the ledger back to opted_out.
 *
 * The `optOutTypeHint` parameter is Twilio's `OptOutType` webhook field —
 * present only when a Messaging Service with Advanced Opt-Out processed the
 * inbound message. When present it is authoritative (it may reflect custom
 * console-configured keywords our body classifier does not know), so it is
 * used as a fallback whenever the body alone does not classify.
 */

export const SMS_OPT_OUT_KEYWORDS = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
] as const;

export const SMS_OPT_IN_KEYWORDS = ["START", "YES", "UNSTOP", "SUBSCRIBE"] as const;

export const SMS_HELP_KEYWORDS = ["HELP", "INFO"] as const;

export type SmsConsentKeywordKind = "opt_out" | "opt_in" | "help";

export interface SmsConsentKeywordMatch {
  kind: SmsConsentKeywordKind;
  /** Uppercased keyword recorded on the consent event. */
  keyword: string;
  /** How the classification was reached (body match vs Twilio edge hint). */
  matchedVia: "body" | "opt_out_type_hint";
}

const OPT_OUT_SET: ReadonlySet<string> = new Set(SMS_OPT_OUT_KEYWORDS);
const OPT_IN_SET: ReadonlySet<string> = new Set(SMS_OPT_IN_KEYWORDS);
const HELP_SET: ReadonlySet<string> = new Set(SMS_HELP_KEYWORDS);

const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

export function classifySmsConsentKeyword(
  body: string | null | undefined,
  optOutTypeHint?: string | null,
): SmsConsentKeywordMatch | null {
  const trimmed = (body ?? "").trim();
  const isSingleWord = trimmed.length > 0 && !/\s/.test(trimmed);
  const upper = trimmed.toUpperCase();

  if (isSingleWord) {
    if (OPT_IN_SET.has(upper)) {
      return { kind: "opt_in", keyword: upper, matchedVia: "body" };
    }
    if (HELP_SET.has(upper)) {
      return { kind: "help", keyword: upper, matchedVia: "body" };
    }
    const withoutTrailingPunctuation = upper.replace(TRAILING_PUNCTUATION, "");
    if (OPT_OUT_SET.has(withoutTrailingPunctuation)) {
      return { kind: "opt_out", keyword: withoutTrailingPunctuation, matchedVia: "body" };
    }
  }

  // Twilio edge hint fallback: Advanced Opt-Out can match custom keywords
  // (including multi-word ones) that our static sets cannot know about.
  const hint = (optOutTypeHint ?? "").trim().toUpperCase();
  if (hint === "STOP") {
    return { kind: "opt_out", keyword: isSingleWord ? upper : "STOP", matchedVia: "opt_out_type_hint" };
  }
  if (hint === "START") {
    return { kind: "opt_in", keyword: isSingleWord ? upper : "START", matchedVia: "opt_out_type_hint" };
  }
  if (hint === "HELP") {
    return { kind: "help", keyword: isSingleWord ? upper : "HELP", matchedVia: "opt_out_type_hint" };
  }

  return null;
}
