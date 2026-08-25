import {
  isCompanyEmail,
  isCompanyDomain,
  isPublicEmailDomain,
  normalizeEmail,
  extractDomain,
  normalizeDomain,
  isReceiptStyleSenderEmail,
} from "./companyIdentity";

export type SeedSource = "seeded" | "learned" | "manual" | "penalized";
export type TrustTier = "trusted" | "restricted" | "blocked";

const SYSTEM_NOTIFICATION_EMAILS: ReadonlySet<string> = new Set([
  "noreply@google.com",
  "no-reply@google.com",
  "noreply@accounts.google.com",
  "notifications@google.com",
  "google-noreply@google.com",
  "calendar-notification@google.com",
  "noreply-local-guides@google.com",
  "noreply-reviews@google.com",
  "noreply-maps@google.com",
  "noreply@youtube.com",
  "noreply-dfe0ed@plus.google.com",
  "noreply@plus.google.com",
  "googlebusiness@google.com",
  "google-business@google.com",
  "business-noreply@google.com",
  "noreply-business@google.com",
  "gbp-noreply@google.com",
  "support@google.com",
  "googlecommunityteam-noreply@google.com",
  "noreply@searchconsole.google.com",
  "noreply@ads.google.com",
  "noreply@mailer.facebook.com",
  "notification@facebookmail.com",
  "noreply@facebookmail.com",
  "noreply@business.fb.com",
  "ads-noreply@meta.com",
  "noreply@meta.com",
  "noreply@yelp.com",
  "no-reply@yelp.com",
  "noreply@bbb.org",
  "noreply@bbbmail.org",
  "noreply@trustpilot.com",
  "noreply@avvo.com",
  "noreply@superlawyers.com",
  "donotreply@superlawyers.com",
  "noreply@findlaw.com",
  "noreply@callrail.com",
  "notifications@callrail.com",
  "noreply@hubspot.com",
  "noreply@calendly.com",
  "notifications@calendly.com",
  "noreply@zoom.us",
  "no-reply@zoom.us",
  "noreply@slack.com",
  "notification@slack.com",
  "noreply@trello.com",
  "noreply@asana.com",
  "noreply@monday.com",
  "noreply@mailchimp.com",
  "noreply@intuit.com",
  "noreply@quickbooks.intuit.com",
  "donotreply@mycase.com",
  "noreply@clio.com",
  "noreply@practicepanther.com",
  "noreply@lawpay.com",
  "mailer-daemon@google.com",
  "mailer-daemon@googlemail.com",
  "postmaster@google.com",
]);

const NOREPLY_PATTERNS: ReadonlyArray<RegExp> = [
  /^noreply@/i,
  /^no-reply@/i,
  /^no\.reply@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^do\.not\.reply@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^bounce[s]?@/i,
  /^notifications?@.*\.(google|facebook|meta|yelp|callrail)\.com$/i,
  /^alerts?@.*\.(google|facebook|meta)\.com$/i,
];

// Task #4790: exported (was module-private) so the vendor-identifier cleanup
// prod action can derive its SQL predicate from this exact list — single
// source, no drift. Membership check MUST go through
// `isVendorPlatformDomain` (subdomain-aware); the raw set is exact hosts.
export const VENDOR_PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
  "callrail.com",
  "mycase.com",
  "clio.com",
  "practicepanther.com",
  "lawpay.com",
  "smokeball.com",
  "actionstep.com",
  "filevine.com",
  "litify.com",
  "needlescasemgmt.com",
  "abacusnext.com",
  // Task #4790 — payment/dev/billing platforms NoBull itself transacts with.
  // Read from prod 2026-08-14: Dellutri's trusted-domain list claimed
  // `stripe.com`, `mail.replit.com`, `tabs3.com`, auto-matching 646 of
  // NoBull's own vendor receipts to their comm log. Subdomains (e.g.
  // `mail.replit.com`) are covered by the suffix rule in
  // `isVendorPlatformDomain`.
  "stripe.com",
  "replit.com",
  "tabs3.com",
]);

const COMPETITOR_LAW_FIRM_DOMAINS: ReadonlySet<string> = new Set([
  "obrienlawfirm.com",
  "flanaganlawfirm.com",
  "gracelegal.com",
  "gracelegalgroup.com",
  "abbottlawfirm.com",
  "abbottlawgroup.com",
  "okuosalaw.com",
  "mendozalawfirm.com",
  "mendozalaw.com",
  "punchwork.com",
]);

const COMMON_SURNAMES: ReadonlySet<string> = new Set([
  "jones", "smith", "brown", "johnson", "williams", "davis", "miller",
  "wilson", "moore", "taylor", "anderson", "thomas", "jackson", "white",
  "harris", "martin", "thompson", "garcia", "martinez", "robinson",
  "clark", "rodriguez", "lewis", "lee", "walker", "hall", "allen",
  "young", "king", "wright", "lopez", "hill", "scott", "green",
  "adams", "baker", "gonzalez", "nelson", "carter", "mitchell",
  "perez", "roberts", "turner", "phillips", "campbell", "parker",
  "evans", "edwards", "collins", "stewart", "sanchez", "morris",
  "rogers", "reed", "cook", "morgan", "bell", "murphy", "bailey",
  "rivera", "cooper", "richardson", "cox", "howard", "ward", "torres",
  "peterson", "gray", "ramirez", "james", "watson", "brooks", "kelly",
  "sanders", "price", "bennett", "wood", "barnes", "ross", "henderson",
  "coleman", "jenkins", "perry", "powell", "long", "patterson", "hughes",
  "flores", "washington", "butler", "simmons", "foster", "gonzales",
  "bryant", "alexander", "russell", "griffin", "diaz", "hayes",
  "myers", "ford", "hamilton", "graham", "sullivan", "wallace",
  "woods", "cole", "west", "jordan", "owens", "reynolds", "fisher",
  "ellis", "harrison", "gibson", "mcdonald", "cruz", "marshall",
  "ortiz", "gomez", "murray", "freeman", "wells", "webb", "simpson",
  "stevens", "tucker", "porter", "hunter", "hicks", "crawford",
  "henry", "boyd", "mason", "morales", "kennedy", "warren", "dixon",
  "ramos", "reyes", "burns", "gordon", "shaw", "hunt", "black",
  "holmes", "palmer", "stone", "meyer", "dean", "olson", "burke",
  "carr", "hart", "grant", "dunn", "lane", "rice", "silva",
  "obrien", "o'brien", "flanagan", "abbott", "mendoza", "grace",
]);

export function isCommonSurname(word: string): boolean {
  return COMMON_SURNAMES.has(word.toLowerCase().trim());
}

export function isSystemNotificationEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (SYSTEM_NOTIFICATION_EMAILS.has(normalized)) return true;
  return NOREPLY_PATTERNS.some(p => p.test(normalized));
}

export function isVendorPlatformDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  if (VENDOR_PLATFORM_DOMAINS.has(d)) return true;
  // Task #4790: subdomain-aware, mirroring `isPublicEmailDomain` — prod's
  // poison entry was `mail.replit.com`, which dodged the exact-match check.
  for (const vendor of VENDOR_PLATFORM_DOMAINS) {
    if (d.endsWith(`.${vendor}`)) return true;
  }
  return false;
}

export function isCompetitorDomain(domain: string): boolean {
  return COMPETITOR_LAW_FIRM_DOMAINS.has(normalizeDomain(domain));
}

// ---------------------------------------------------------------------------
// Task #4790 — centralized vendor/receipt identifier validation for EVERY
// client-identifier writer (client create/update, contact create/update, the
// Front attach endpoints, and contact promotion). The matcher refuses these
// as evidence regardless, but writers must refuse them too so client rows
// can't be re-poisoned and the cleanup prod action stays convergent.
// ---------------------------------------------------------------------------

export interface VendorIdentifierViolation {
  identifier: string;
  kind: "vendor_platform_domain" | "vendor_platform_email" | "receipt_style_sender";
  reason: string;
}

/**
 * Screens would-be client identifiers (trusted email domains and/or contact
 * email addresses) against the vendor-platform and receipt-style-sender
 * policy. Returns one violation per offending entry; an empty array means the
 * input is clean. Non-string entries are ignored here — shape validation
 * belongs to the caller's schema.
 */
export function findVendorIdentifierViolations(input: {
  emailDomains?: unknown;
  emails?: unknown;
}): VendorIdentifierViolation[] {
  const violations: VendorIdentifierViolation[] = [];

  if (Array.isArray(input.emailDomains)) {
    for (const raw of input.emailDomains) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const domain = normalizeDomain(raw);
      if (isVendorPlatformDomain(domain)) {
        violations.push({
          identifier: domain,
          kind: "vendor_platform_domain",
          reason: `"${domain}" is a vendor platform domain (payment/dev/billing/legal-tech vendors are never client identifiers)`,
        });
      }
    }
  }

  if (Array.isArray(input.emails)) {
    for (const raw of input.emails) {
      if (typeof raw !== "string" || !raw.includes("@")) continue;
      const email = normalizeEmail(raw);
      const domain = extractDomain(email);
      if (domain && isVendorPlatformDomain(domain)) {
        violations.push({
          identifier: email,
          kind: "vendor_platform_email",
          reason: `"${email}" is on vendor platform domain "${domain}" — vendor senders are never client identifiers`,
        });
      } else if (isReceiptStyleSenderEmail(email)) {
        violations.push({
          identifier: email,
          kind: "receipt_style_sender",
          reason: `"${email}" is a receipt/billing-style automated sender — never used for client matching`,
        });
      }
    }
  }

  return violations;
}

/** Formats violations into the 400-response error string used by identifier-writing routes. */
export function vendorIdentifierRefusalMessage(violations: VendorIdentifierViolation[]): string {
  return `Vendor/receipt identifiers are never client identifiers: ${violations
    .map((v) => v.reason)
    .join("; ")}`;
}

export function isBlockedSeedIdentifier(type: string, value: string): boolean {
  const normalized = value.toLowerCase().trim();

  if (type === "email" || type === "sender_email") {
    if (isCompanyEmail(normalized)) return true;
    if (isSystemNotificationEmail(normalized)) return true;
    const domain = extractDomain(normalized);
    if (domain && (isVendorPlatformDomain(domain) || isCompetitorDomain(domain))) return true;
    return false;
  }

  if (type === "domain" || type === "sender_domain") {
    if (isCompanyDomain(normalized)) return true;
    if (isVendorPlatformDomain(normalized)) return true;
    if (isCompetitorDomain(normalized)) return true;
    return false;
  }

  return false;
}

export function isRestrictedSeedSource(source: string): boolean {
  return source === "learned";
}

export function canSeedIdentifierForClient(
  type: string,
  value: string,
  source: SeedSource
): boolean {
  if (isBlockedSeedIdentifier(type, value)) return false;

  if (type === "email" || type === "sender_email") {
    const domain = extractDomain(value.toLowerCase().trim());
    if (domain && isPublicEmailDomain(domain) && source !== "manual" && source !== "seeded") {
      return false;
    }
  }

  return true;
}

export function shouldAllowCooccurrenceSignal(signalKey: string): boolean {
  const parts = signalKey.split("|");
  for (const part of parts) {
    if (part.startsWith("email:")) {
      const email = part.substring(6);
      if (isBlockedSeedIdentifier("email", email)) return false;
    }
    if (part.startsWith("name:")) {
      const name = part.substring(5);
      if (name.includes("nobull") || name.includes("no bull")) return false;
    }
  }
  return true;
}

export function isProtectedCompanyIdentifier(type: string, value: string): boolean {
  const normalized = value.toLowerCase().trim();
  if (type === "email" || type === "sender_email") return isCompanyEmail(normalized);
  if (type === "domain" || type === "sender_domain") return isCompanyDomain(normalized);
  return false;
}

export function classifyIdentifierTrust(
  type: string,
  value: string,
  source: SeedSource
): TrustTier {
  if (isBlockedSeedIdentifier(type, value)) return "blocked";

  if (source === "manual" || source === "seeded") return "trusted";

  return "restricted";
}

export function isGenericShortAlias(value: string): boolean {
  const normalized = value.toLowerCase().trim();
  if (normalized.length <= 3) return true;
  if (isCommonSurname(normalized)) return true;
  return false;
}

export function getContaminationRiskScore(
  memoryCount: number,
  learnedCount: number,
  coOccurrenceCount: number
): { risk: "low" | "medium" | "high" | "critical"; score: number } {
  let score = 0;
  if (memoryCount > 100) score += 30;
  else if (memoryCount > 50) score += 15;

  if (learnedCount > 50) score += 30;
  else if (learnedCount > 25) score += 15;

  const learnedRatio = memoryCount > 0 ? learnedCount / memoryCount : 0;
  if (learnedRatio > 0.7) score += 20;
  else if (learnedRatio > 0.5) score += 10;

  if (coOccurrenceCount > 20) score += 20;
  else if (coOccurrenceCount > 10) score += 10;

  let risk: "low" | "medium" | "high" | "critical" = "low";
  if (score >= 70) risk = "critical";
  else if (score >= 50) risk = "high";
  else if (score >= 25) risk = "medium";

  return { risk, score };
}
