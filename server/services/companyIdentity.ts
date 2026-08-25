export const COMPANY_DOMAINS: ReadonlySet<string> = new Set([
  "nobullmarketing.com",
  "nobullmarketing.co",
]);

export const COMPANY_EXACT_EMAILS: ReadonlySet<string> = new Set([
  "admin@nobullmarketing.com",
  "team@nobullmarketing.com",
  "rdeaver@nobullmarketing.com",
  "heretoserve@nobullmarketing.com",
  "oliver@nobullmarketing.com",
  "liri.abdullahu@nobullmarketing.com",
  "brett.barney@nobullmarketing.com",
  "cmcmanus@nobullmarketing.co",
]);

const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "google.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "aol.com",
  "icloud.com",
  "mail.com",
  "protonmail.com",
  "zoho.com",
  "yandex.com",
  "live.com",
  "msn.com",
  "me.com",
  "mac.com",
  "comcast.net",
  "att.net",
  "verizon.net",
  "sbcglobal.net",
  "cox.net",
  "charter.net",
]);

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim();
}

export function extractDomain(email: string): string | null {
  const parts = normalizeEmail(email).split("@");
  return parts.length === 2 ? parts[1] : null;
}

// Internal-identity authority is the hardcoded `COMPANY_DOMAINS` /
// `COMPANY_EXACT_EMAILS` sets above. (The former DB-backed operational-rules
// override was removed with the operational classifier in Task #2637.)
export function isCompanyDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  return COMPANY_DOMAINS.has(d);
}

export function isCompanyEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (COMPANY_EXACT_EMAILS.has(normalized)) return true;
  const domain = extractDomain(normalized);
  if (!domain) return false;
  return COMPANY_DOMAINS.has(domain);
}

export function isPublicEmailDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  if (PUBLIC_EMAIL_DOMAINS.has(d)) return true;
  // Task #4049: subdomains of public providers are public too. Production
  // matched-conversation participants include gateway subdomains like
  // `txt.voice.google.com` (Google Voice SMS-to-email) and `docs.google.com`
  // (Docs comment notifications) — shared infrastructure that must never be
  // trusted to a single client, but which dodged the exact-match check.
  for (const pub of PUBLIC_EMAIL_DOMAINS) {
    if (d.endsWith(`.${pub}`)) return true;
  }
  return false;
}

// ── Task #4049: automated-sender detection (leaf home) ─────────────────────
//
// Moved here from `frontIntegration.ts` (where it was Task #971's
// SPAM_SENDER_PATTERNS) so the pure hard-match resolver in
// `frontHardMatch.ts` can consult it without importing the huge integration
// module (which itself imports frontHardMatch — a cycle). frontIntegration
// re-exports these under the legacy names for its existing consumers.
//
// The `(^|[-._+])` boundary matches the token at the start of the local part
// or after a separator, so `businessprofile-noreply@google.com` is automated
// while `henoreply@example.com` is not.
// Task #4790: receipt/billing-style senders (receipts@, receipts+acct…@,
// billing@, invoice@/invoices@) are transactional vendor mailboxes —
// Stripe receipts for Replit charges arrive from
// `receipts+acct_…@stripe.com` (read from prod 2026-08-14). They are a
// distinct sub-class of automated senders: beyond never contributing
// domain evidence, they are also refused as exact-email contacts and as
// tier-1 match evidence (see `isReceiptStyleSenderEmail`). The optional
// `([+][^@]*)?` tail covers plus-addressed variants.
export const RECEIPT_STYLE_SENDER_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|[-._+])(receipts?|billing|invoices?)([+][^@]*)?@/i,
];

export const AUTOMATED_SENDER_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|[-._+])no-?reply@/i,
  /(^|[-._+])do-?not-?reply@/i,
  /(^|[-._+])notifications?@/i,
  /(^|[-._+])bounce@/i,
  /(^|[-._+])mailer-daemon@/i,
  /^bot@/i,
  /^postmaster@/i,
  /^automated@/i, /^auto@/i, /^system@/i,
  ...RECEIPT_STYLE_SENDER_PATTERNS,
];

/**
 * SQL (POSIX ERE) twin of {@link RECEIPT_STYLE_SENDER_PATTERNS}. Composed
 * into {@link AUTOMATED_SENDER_SQL_REGEX} below so the two stay in lockstep;
 * also used standalone by the Task #4790 vendor-identifier cleanup action.
 * Apply with `lower(email) ~ RECEIPT_STYLE_SENDER_SQL_REGEX`.
 */
export const RECEIPT_STYLE_SENDER_SQL_REGEX =
  "(^|[-._+])(receipts?|billing|invoices?)([+][^@]*)?@";

/**
 * SQL (POSIX ERE) twin of {@link AUTOMATED_SENDER_PATTERNS}, for set-based
 * counts that cannot call the JS predicate per row (e.g. the unmatched-backlog
 * re-match estimate). `tests/front-hard-match-automated-guard.test.ts` asserts
 * fixture-level equivalence between the two so they cannot drift silently.
 * Apply with `lower(email) ~ AUTOMATED_SENDER_SQL_REGEX`.
 */
export const AUTOMATED_SENDER_SQL_REGEX =
  "(^|[-._+])(no-?reply|do-?not-?reply|notifications?|bounce|mailer-daemon)@|^(bot|postmaster|automated|auto|system)@|" +
  RECEIPT_STYLE_SENDER_SQL_REGEX;

/**
 * True when the address looks like an automated / no-reply / notification
 * sender that should never contribute client-attribution evidence or become
 * a client contact.
 */
export function isAutomatedSenderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  return AUTOMATED_SENDER_PATTERNS.some((p) => p.test(e));
}

/**
 * Task #4790 — true when the address is a receipt/billing-style transactional
 * sender (`receipts@`, `receipts+acct_…@`, `billing@`, `invoice(s)@`).
 *
 * Stricter consequences than the general automated-sender class: these are
 * refused as client contacts even with explicit operator opt-in, refused by
 * the operator attach endpoints, and skipped by the hard matcher's exact-email
 * tier even when a client contact row still claims them. (The general
 * automated class deliberately does NOT touch the exact-email tier — see the
 * Task #4049 note in `frontHardMatch.ts`.)
 */
export function isReceiptStyleSenderEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  return RECEIPT_STYLE_SENDER_PATTERNS.some((p) => p.test(e));
}

export function isProtectedInternalIdentifier(type: string, value: string): boolean {
  const normalized = value.toLowerCase().trim();
  if (type === "email") return isCompanyEmail(normalized);
  if (type === "domain") return isCompanyDomain(normalized);
  if (type === "sender_email") return isCompanyEmail(normalized);
  if (type === "sender_domain") return isCompanyDomain(normalized);
  return false;
}

export function isNonCompanyExternalEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (isCompanyEmail(normalized)) return false;
  const domain = extractDomain(normalized);
  if (!domain) return false;
  return true;
}

export function hasExternalParticipant(
  participants: Array<{ email?: string; role?: string }>
): boolean {
  return participants.some(p => {
    if (!p.email) return false;
    return isNonCompanyExternalEmail(p.email);
  });
}

export const MATCH_REASON_CODES = {
  EXACT_EMAIL: "exact_contact_email_unique",
  EXACT_PHONE: "exact_contact_phone_unique",
  UNIQUE_DOMAIN: "exact_client_domain_unique",
  SHARED_EMAIL: "shared_identifier_no_autoclaim",
  SHARED_PHONE: "shared_phone_no_autoclaim",
  SHARED_DOMAIN: "shared_domain_no_autoclaim",
  AUTOMATED_SENDERS_ONLY: "automated_senders_only_no_autoclaim",
  COMPANY_FILTERED: "company_identifier_filtered",
  SUBJECT_KEYWORD: "heuristic_subject_keyword",
  PARTICIPANT_KEYWORD: "heuristic_participant_keyword",
  AGENT_CLAIMED: "agent_confidence_claimed",
  AGENT_AMBIGUOUS: "agent_confidence_ambiguous",
} as const;

export type MatchReasonCode = typeof MATCH_REASON_CODES[keyof typeof MATCH_REASON_CODES];

export function isCompanyRelatedName(name: string): boolean {
  const normalized = name.toLowerCase().trim();
  const companyNameTokens = ["nobull", "no bull", "nobullmarketing"];
  return companyNameTokens.some(token => normalized.includes(token));
}
