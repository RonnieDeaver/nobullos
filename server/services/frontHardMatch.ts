// Task #867 — Front email hard-match resolver
//
// One deterministic rule replaces the prior tangle of firm-name keyword
// scans, contact-name token sniffing and AI auto-claim. A Front email is
// auto-matched to a client if and only if any external participant satisfies
// at least one of:
//
//   1. EXACT EMAIL MATCH  — participant.email exactly matches one entry in
//      either `clients.contactEmail` or any `client_contacts.emails[]` row
//      attached to that client. The match is uniquely owned by that client.
//
//   2. TRUSTED DOMAIN MATCH — participant.email's domain (lowercased, no `@`)
//      appears in the *new* `clients.emailDomains[]` list, and that domain is
//      neither a public free-mail provider (gmail, hotmail, …) nor the
//      company's own internal domain. The match is uniquely owned by that
//      client.
//
// Anything else — no signal, signal collides between two clients, only
// company/public participants — produces NO MATCH and the email goes to the
// unified Unmatched inbox. The AI agent is no longer permitted to auto-claim
// inside this resolver; it lives on as a *suggestion* surface only.
//
// The resolver itself is intentionally pure (it accepts pre-loaded client
// data) so it can be unit-tested and reused by both the live pipeline and
// the one-time backfill job without performing any DB IO of its own.

import type { Client, ClientContact } from "@shared/schema";
import { isCompanyEmail, isCompanyDomain, isPublicEmailDomain, isAutomatedSenderEmail, isReceiptStyleSenderEmail, MATCH_REASON_CODES } from "./companyIdentity";
import { isVendorPlatformDomain } from "./seedingTrustPolicy";
import { storage } from "../storage";
import { normalizeClientEmailDomains } from "@shared/models/clients";

// Task #4790 — vendor-identifier defense. Poisoned client data (Dellutri's
// trusted-domain list claimed stripe.com / mail.replit.com / tabs3.com, and a
// contact row carried `receipts+acct_…@stripe.com`) auto-matched 646 of
// NoBull's OWN vendor receipts to a client. Writers now refuse these
// identifiers, but the matcher must also refuse them as EVIDENCE even while
// a client row still claims them: vendor-platform domains never enter the
// domain index or contribute participant domain evidence, and vendor-domain /
// receipt-style addresses never enter the email index or count as exact-email
// evidence. (Contrast Task #4049: generic automated senders remain valid at
// the exact-email tier because an operator registered them deliberately —
// vendor/receipt identifiers are refused outright because they can never
// legitimately identify a client.)
function isVendorTaintedEmail(email: string): boolean {
  if (isReceiptStyleSenderEmail(email)) return true;
  const domain = email.split("@")[1];
  return !!domain && isVendorPlatformDomain(domain);
}

export interface FrontParticipant {
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

/**
 * Outcome of running the hard-match resolver against one Front conversation.
 *
 * - `matched`: a single client was uniquely identified by an exact-email or
 *   trusted-domain signal. `clientId`, `method`, `matchedOn` describe the
 *   winning evidence.
 * - `ambiguous`: a signal was found but it points to multiple clients, so
 *   we deliberately refuse to auto-claim and route the email to Unmatched.
 *   `reason` carries a short human/audit string and `candidateClientIds`
 *   lists the colliding clients (useful for the suggestion surface).
 * - `no_match`: no exact-email or trusted-domain signal was found.
 *   Optionally `reason` records why (e.g. company-only participants).
 */
export type FrontHardMatchResult =
  | {
      status: "matched";
      clientId: string;
      firmName: string;
      method: "email_exact" | "email_domain";
      matchedOn: string;
      reasonCode: "EXACT_EMAIL" | "UNIQUE_DOMAIN";
      reason: string;
    }
  | {
      status: "ambiguous";
      method: "email_exact" | "email_domain";
      matchedOn: string;
      candidateClientIds: string[];
      reason: string;
    }
  | {
      status: "no_match";
      reason: string;
    };

/** Internal indexes the resolver consumes. Built once per batch. */
export interface HardMatchIndexes {
  /** lowercased email -> set of client ids that own that exact email */
  emailIndex: Map<string, Set<string>>;
  /** lowercased domain -> set of client ids that trust that domain */
  domainIndex: Map<string, Set<string>>;
  /** clientId -> firm name (for human-readable result messages) */
  firmNames: Map<string, string>;
}

/**
 * Build the in-memory indexes from a list of clients and their contacts.
 *
 * `contactsByClient` may be partial; missing entries are treated as "no
 * contact rows". Archived clients are skipped — they cannot win an
 * auto-match.
 */
export function buildHardMatchIndexes(
  clients: Client[],
  contactsByClient: Map<string, ClientContact[]>,
): HardMatchIndexes {
  const emailIndex = new Map<string, Set<string>>();
  const domainIndex = new Map<string, Set<string>>();
  const firmNames = new Map<string, string>();

  for (const client of clients) {
    if (client.isArchived) continue;
    firmNames.set(client.id, client.firmName);

    // 1) clients.contactEmail — historic primary email field.
    const primary = (client.contactEmail || "").trim().toLowerCase();
    if (primary && primary.includes("@") && !isCompanyEmail(primary) && !isVendorTaintedEmail(primary)) {
      addToIndex(emailIndex, primary, client.id);
    }

    // 2) client_contacts.emails[] — authoritative contact roster.
    const contacts = contactsByClient.get(client.id) || [];
    for (const contact of contacts) {
      const emails = contact.emails || [];
      for (const raw of emails) {
        if (!raw) continue;
        const email = raw.trim().toLowerCase();
        if (!email.includes("@") || isCompanyEmail(email)) continue;
        // Task #4790: vendor-domain / receipt-style entries in a contact row
        // are data poison, never client identity — refuse them as evidence.
        if (isVendorTaintedEmail(email)) continue;
        addToIndex(emailIndex, email, client.id);
      }
    }

    // 3) clients.emailDomains[] — Task #867's per-client trusted-domain list.
    const trusted = normalizeClientEmailDomains(client.emailDomains as unknown);
    for (const domain of trusted) {
      // Defence in depth: refuse to seed a public free-mail, company, or
      // vendor-platform (Task #4790) domain into the trusted-domain index
      // even if an admin saved one.
      if (isPublicEmailDomain(domain) || isCompanyDomain(domain) || isVendorPlatformDomain(domain)) continue;
      addToIndex(domainIndex, domain, client.id);
    }
  }

  return { emailIndex, domainIndex, firmNames };
}

function addToIndex(index: Map<string, Set<string>>, key: string, clientId: string): void {
  let bucket = index.get(key);
  if (!bucket) {
    bucket = new Set();
    index.set(key, bucket);
  }
  bucket.add(clientId);
}

/**
 * Run the hard-match rule against one set of participants. Pure function:
 * no DB IO, no logging side effects. Caller decides what to persist.
 */
export function resolveFrontHardMatch(
  participants: FrontParticipant[],
  indexes: HardMatchIndexes,
): FrontHardMatchResult {
  // Extract clean external email handles up-front. We deliberately drop
  // company-internal participants here so the resolver cannot accidentally
  // claim a client based on an internal CC.
  const externalEmails = uniq(
    participants
      .map((p) => (p?.email || "").trim().toLowerCase())
      .filter((e) => e.length > 0 && e.includes("@") && !isCompanyEmail(e)),
  );

  if (externalEmails.length === 0) {
    // No external signal — could be all-internal, could be empty. Either way
    // the answer is "no match".
    const allCompany = participants.length > 0 && participants.every((p) => {
      const e = (p?.email || "").trim().toLowerCase();
      return !e || isCompanyEmail(e);
    });
    if (allCompany) {
      return { status: "no_match", reason: `[${MATCH_REASON_CODES.COMPANY_FILTERED}] All participants are company identifiers` };
    }
    return { status: "no_match", reason: "No external email participants" };
  }

  // ── Tier 1 — exact-email ────────────────────────────────────────────────
  // Collect *all* exact-email signals across *all* external participants
  // before deciding. The match is only "unique" if every signal we found
  // points at the same single client. Two different participants pointing
  // at two different clients (or one shared address registered to multiple
  // clients) is ambiguous and must NOT auto-claim.
  const emailCandidates = new Set<string>();
  const emailEvidence: string[] = [];
  for (const email of externalEmails) {
    // Task #4790 participant-side defense: vendor-domain / receipt-style
    // senders never count as exact-email evidence, even if a (stale or
    // poisoned) index still carries them.
    if (isVendorTaintedEmail(email)) continue;
    const owners = indexes.emailIndex.get(email);
    if (!owners || owners.size === 0) continue;
    emailEvidence.push(email);
    for (const id of owners) emailCandidates.add(id);
  }
  if (emailCandidates.size === 1) {
    const clientId = [...emailCandidates][0];
    const matchedOn = emailEvidence[0];
    return {
      status: "matched",
      clientId,
      firmName: indexes.firmNames.get(clientId) || clientId,
      method: "email_exact",
      matchedOn,
      reasonCode: "EXACT_EMAIL",
      reason: `Exact email match: ${matchedOn}`,
    };
  }
  if (emailCandidates.size > 1) {
    return {
      status: "ambiguous",
      method: "email_exact",
      matchedOn: emailEvidence.join(","),
      candidateClientIds: [...emailCandidates],
      reason: `[${MATCH_REASON_CODES.SHARED_EMAIL}] Exact-email signals point to ${emailCandidates.size} clients (${emailEvidence.join(", ")})`,
    };
  }

  // ── Tier 2 — trusted domain ─────────────────────────────────────────────
  // Same all-or-one rule as tier 1 but keyed on the domain portion.
  // Public-mail and company domains are excluded at index-build time, so
  // we don't need to re-check them here.
  //
  // Task #4049 guardrail: only HUMAN participants may contribute domain
  // evidence. Automated senders (`noreply@`, `notifications@`, …) on a
  // trusted client domain are operational noise — review-tool alerts,
  // intake-form notifications, newsletters — not correspondence with the
  // client, so they must not ride the domain into an auto-match. The
  // exact-email tier above is deliberately untouched: an operator who
  // registered a specific address as a client contact has made an explicit
  // per-address decision.
  const humanExternalEmails = externalEmails.filter((e) => !isAutomatedSenderEmail(e));
  const externalDomains = uniq(
    humanExternalEmails
      .map((e) => e.split("@")[1])
      // Task #4790: vendor-platform domains (stripe.com, mail.replit.com, …)
      // are excluded alongside public/company — they can never be client
      // domain evidence even when a client's trusted list still claims them.
      .filter((d): d is string => !!d && !isPublicEmailDomain(d) && !isCompanyDomain(d) && !isVendorPlatformDomain(d)),
  );

  const domainCandidates = new Set<string>();
  const domainEvidence: string[] = [];
  for (const domain of externalDomains) {
    const owners = indexes.domainIndex.get(domain);
    if (!owners || owners.size === 0) continue;
    domainEvidence.push(domain);
    for (const id of owners) domainCandidates.add(id);
  }
  if (domainCandidates.size === 1) {
    const clientId = [...domainCandidates][0];
    const matchedOn = domainEvidence[0];
    return {
      status: "matched",
      clientId,
      firmName: indexes.firmNames.get(clientId) || clientId,
      method: "email_domain",
      matchedOn,
      reasonCode: "UNIQUE_DOMAIN",
      reason: `Trusted domain match: ${matchedOn}`,
    };
  }
  if (domainCandidates.size > 1) {
    return {
      status: "ambiguous",
      method: "email_domain",
      matchedOn: domainEvidence.join(","),
      candidateClientIds: [...domainCandidates],
      reason: `[${MATCH_REASON_CODES.SHARED_DOMAIN}] Trusted-domain signals point to ${domainCandidates.size} clients (${domainEvidence.join(", ")})`,
    };
  }

  // Diagnostic: the conversation carries a trusted domain, but only on
  // automated senders. Surface that explicitly so operators reviewing the
  // Unmatched feed can see WHY the noise guard held the row back.
  const automatedTrustedDomains = uniq(
    externalEmails
      .filter((e) => isAutomatedSenderEmail(e))
      .map((e) => e.split("@")[1])
      .filter((d): d is string => !!d && indexes.domainIndex.has(d)),
  );
  if (automatedTrustedDomains.length > 0) {
    return {
      status: "no_match",
      reason: `[${MATCH_REASON_CODES.AUTOMATED_SENDERS_ONLY}] Trusted domain(s) ${automatedTrustedDomains.join(", ")} appear only on automated senders (no-reply/notification traffic is never auto-matched)`,
    };
  }

  return { status: "no_match", reason: "No exact-email or trusted-domain match" };
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// ── Cached index builder ────────────────────────────────────────────────────
//
// The hard matcher is called per-email by every Front pipeline path
// (live sync, re-eval, batch reprocess, batch rematch, rematch-all,
// reprocess-dismissed) plus the backfill job. Building the indexes from
// scratch each time would re-issue O(clients) DB queries; a 60s TTL cache
// matches the prior `buildMatchIndexes` behaviour and is cheap to invalidate.

interface CachedIndexes {
  indexes: HardMatchIndexes;
  expiresAt: number;
}

let cached: CachedIndexes | null = null;
const HARD_MATCH_INDEX_TTL_MS = 60_000;

/**
 * Returns the active hard-match indexes, refreshing them from storage if
 * the in-memory cache has expired. Safe to call from concurrent matchers
 * — at worst two refreshes race, both populate the same value.
 */
export async function getHardMatchIndexes(): Promise<HardMatchIndexes> {
  const now = Date.now();
  if (cached && now < cached.expiresAt) return cached.indexes;

  // Task #4330 — prospect-INCLUSIVE: lead records must be matchable by
  // email/phone before they are paying clients (that is the point of
  // promoting inquiries/bookings to first-class records). Archived rows
  // are still excluded below.
  const allClients = await storage.getClientsIncludingProspects();
  const activeIds = allClients.filter((c) => !c.isArchived).map((c) => c.id);
  const contactsByClient = activeIds.length > 0
    ? await storage.getClientContactsForClients(activeIds)
    : new Map();

  const indexes = buildHardMatchIndexes(allClients, contactsByClient);
  cached = { indexes, expiresAt: now + HARD_MATCH_INDEX_TTL_MS };
  return indexes;
}

/** Invalidate the in-memory cache. Called whenever a client's contact set
 *  or trusted-domain list changes so the next matcher run sees fresh data.
 */
export function invalidateHardMatchIndexes(): void {
  cached = null;
}
