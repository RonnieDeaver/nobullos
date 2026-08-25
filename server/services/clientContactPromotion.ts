/**
 * Operator-confirmed promotion of participant emails into authoritative
 * `client_contacts` rows.
 *
 * This is the ONLY path through which a manual match (Front email / Slack /
 * Zoom) is allowed to create or extend a client contact. The rule established
 * by Task #755 stands: imports/syncs/matchers may not silently mint
 * contacts. The manual-match dialog in the Command Panel surfaces each
 * participant email as an opt-in checkbox; only emails the operator
 * explicitly checked are passed here. If the operator did not opt in (the
 * common case), this helper is never called.
 *
 * Behaviour:
 *  - Normalises + dedupes incoming emails.
 *  - Filters out company / spam patterns and emails that already exist on
 *    any contact for this client.
 *  - If the client has a primary contact (or any contact at all): appends
 *    the new emails to that contact (this is an `update_existing` write,
 *    which the import policy already permits).
 *  - If the client has no contacts yet: creates a NEW primary contact. This
 *    is the only authoritative create path, and is gated entirely behind
 *    `explicitOptIn === true`.
 *
 * Returns a structured summary so callers can surface a toast / log entry.
 */

import { storage } from "../storage";
import { extractDomain, isCompanyEmail, isReceiptStyleSenderEmail } from "./companyIdentity";
import { isVendorPlatformDomain } from "./seedingTrustPolicy";
import { isSpamSenderEmail } from "./frontIntegration";
import type { InsertClientContact } from "@shared/schema";

export interface PromoteEmailsInput {
  clientId: string;
  /** Emails the operator explicitly chose to add. Empty/undefined ⇒ no-op. */
  emails: string[];
  /** Display name to use when creating a brand-new contact. */
  contactName?: string;
  /** Auth user performing the action (audit / future use). */
  userId?: string;
  /** Must be true to perform any write. Defaults to false for safety. */
  explicitOptIn?: boolean;
  /**
   * Audit-source label written to `client_contacts_audit.source`.
   * Defaults to `"operator_promotion"` (manual-match dialog). The
   * trusted-domain branch in `applyMatchedConversation` overrides this
   * to `"trusted_domain_promotion"` so the audit trail distinguishes
   * the two write paths.
   */
  auditSource?: string;
}

/**
 * Task #4790 — machine-readable per-email skip reason, so callers (and their
 * toasts/logs) can say exactly WHY an opted-in email was refused instead of
 * a bare aggregate count.
 */
export type PromoteEmailSkipReason =
  | "company_internal"
  | "vendor_platform_domain"
  | "receipt_style_sender"
  | "automated_sender"
  | "already_present";

export interface PromoteEmailsResult {
  added: number;
  skipped: number;
  contactId: string | null;
  createdNewContact: boolean;
  reason?: string;
  /**
   * Task #4790 — one entry per opted-in email that was NOT added, with the
   * reason it was refused/skipped. Vendor-platform and receipt-style senders
   * are refused here even though the operator explicitly opted in: they can
   * never legitimately identify a client (prod poison case: Dellutri's
   * contact row carried `receipts+acct_…@stripe.com` / `contact@mail.replit.com`,
   * auto-matching NoBull's own vendor receipts to their comm log).
   */
  skippedEmails: Array<{ email: string; reason: PromoteEmailSkipReason }>;
}

// Task #971: this surface and the Front-enrichment surface share one
// canonical spam-sender predicate (`isSpamSenderEmail` in
// `server/services/frontIntegration.ts`). Importing it here — instead of
// duplicating the regex list — guarantees the two surfaces can never
// drift apart.
const isSpamSender = isSpamSenderEmail;

export async function promoteEmailsToClientContact(
  input: PromoteEmailsInput,
): Promise<PromoteEmailsResult> {
  const empty: PromoteEmailsResult = {
    added: 0, skipped: 0, contactId: null, createdNewContact: false,
    skippedEmails: [],
  };

  if (!input.explicitOptIn) {
    return { ...empty, reason: "no_opt_in" };
  }
  if (!Array.isArray(input.emails) || input.emails.length === 0) {
    return { ...empty, reason: "no_emails_selected" };
  }

  const normalised = [...new Set(
    input.emails
      .map(e => (e || "").trim().toLowerCase())
      .filter(e => e.includes("@")),
  )];

  // Task #4790: classify every refusal so the caller can surface a per-email
  // reason. Vendor-platform domains and receipt-style senders are refused
  // even with explicit operator opt-in — they can never identify a client.
  const skippedEmails: Array<{ email: string; reason: PromoteEmailSkipReason }> = [];
  const filtered = normalised.filter(e => {
    if (isCompanyEmail(e)) {
      skippedEmails.push({ email: e, reason: "company_internal" });
      return false;
    }
    const domain = extractDomain(e);
    if (domain && isVendorPlatformDomain(domain)) {
      skippedEmails.push({ email: e, reason: "vendor_platform_domain" });
      return false;
    }
    if (isReceiptStyleSenderEmail(e)) {
      skippedEmails.push({ email: e, reason: "receipt_style_sender" });
      return false;
    }
    if (isSpamSender(e)) {
      skippedEmails.push({ email: e, reason: "automated_sender" });
      return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    return { ...empty, skipped: normalised.length, reason: "all_filtered", skippedEmails };
  }

  const contacts = await storage.getClientContacts(input.clientId);
  const existing = new Set<string>();
  for (const c of contacts) {
    for (const e of c.emails || []) {
      if (e) existing.add(e.toLowerCase());
    }
  }
  const fresh = filtered.filter(e => {
    if (existing.has(e)) {
      skippedEmails.push({ email: e, reason: "already_present" });
      return false;
    }
    return true;
  });
  if (fresh.length === 0) {
    return { ...empty, skipped: filtered.length, reason: "already_present", skippedEmails };
  }

  const target = contacts.find(c => c.isPrimary) || contacts[0];

  if (target) {
    await storage.updateClientContact(
      target.id,
      { emails: [...(target.emails || []), ...fresh] },
      {
        actorUserId: input.userId ?? null,
        source: input.auditSource || "operator_promotion",
        reason: `promoteEmailsToClientContact(append:${fresh.length})`,
      },
    );
    return {
      added: fresh.length,
      skipped: filtered.length - fresh.length,
      contactId: target.id,
      createdNewContact: false,
      skippedEmails,
    };
  }

  const insertPayload: InsertClientContact = {
    clientId: input.clientId,
    name: (input.contactName || "").trim() || fresh[0],
    emails: fresh,
    phones: [],
    isPrimary: true,
  };
  const created = await storage.createClientContact(insertPayload, {
    actorUserId: input.userId ?? null,
    source: input.auditSource || "operator_promotion",
    reason: `promoteEmailsToClientContact(create:${fresh.length})`,
  });
  return {
    added: fresh.length,
    skipped: filtered.length - fresh.length,
    contactId: created.id,
    createdNewContact: true,
    skippedEmails,
  };
}
