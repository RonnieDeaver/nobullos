/* test-registration
{
  "name": "Hard-match automated-sender guard + public-suffix domains + vendor-identifier defense (Tasks #4049, #4790)",
  "smoke": true,
  "smokeReason": "Pure in-memory unit test (~1s, no DB): pins the automated-sender guard, public-suffix predicate, vendor-platform/receipt-sender defense, and JS↔SQL regex equivalence that decide whether operational noise can auto-claim a client.",
  "tier": "small"
}
test-registration */
// Task #4049 — unit guardrails for the trusted-domain matcher tier:
//
//   1. `isPublicEmailDomain` is SUFFIX-aware: subdomains of public providers
//      (`txt.voice.google.com`, `docs.google.com`) are public too. Production
//      matched-participant data showed these Google gateway subdomains evading
//      the previous exact-match check — they must never be trusted to one client.
//   2. `isAutomatedSenderEmail` (the relocated Task #971 spam-sender predicate)
//      and its SQL twin `AUTOMATED_SENDER_SQL_REGEX` agree on a production-shaped
//      fixture set, so the set-based backlog estimate cannot drift from the
//      per-row JS guard.
//   3. `resolveFrontHardMatch` tier 2 only accepts DOMAIN evidence from HUMAN
//      senders: a trusted client domain appearing solely on `noreply@` /
//      `notifications@` traffic (review-tool alerts, newsletters) stays
//      unmatched with an explicit reason; one human participant on the same
//      domain still matches. The exact-email tier is deliberately untouched
//      (operator-registered addresses are explicit per-address decisions).
//   4. `buildHardMatchIndexes` drops public-suffix domains from operator-entered
//      `emailDomains` lists, so a bad list entry cannot arm the domain tier.
//
// Production-realistic fixtures: participant shapes mirror the read-replica
// sample from Task #4049's investigation (Law Offices of Ricky Malik et al.).
//
// Pure unit test — no DB, no network.

import assert from "node:assert/strict";
import {
  buildHardMatchIndexes,
  resolveFrontHardMatch,
} from "../server/services/frontHardMatch";
import {
  isPublicEmailDomain,
  isAutomatedSenderEmail,
  isReceiptStyleSenderEmail,
  AUTOMATED_SENDER_SQL_REGEX,
  RECEIPT_STYLE_SENDER_SQL_REGEX,
  MATCH_REASON_CODES,
} from "../server/services/companyIdentity";
import { isVendorPlatformDomain } from "../server/services/seedingTrustPolicy";
import type { Client, ClientContact } from "@shared/schema";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
  }
}

// ── 1. Public-suffix awareness ──────────────────────────────────────────────
check("gmail.com is public (exact)", () => assert.equal(isPublicEmailDomain("gmail.com"), true));
check("txt.voice.google.com is public (suffix of google.com)", () =>
  assert.equal(isPublicEmailDomain("txt.voice.google.com"), true));
check("docs.google.com is public (suffix of google.com)", () =>
  assert.equal(isPublicEmailDomain("docs.google.com"), true));
check("mail.yahoo.com is public (suffix)", () => assert.equal(isPublicEmailDomain("mail.yahoo.com"), true));
check("rickymaliklaw.com is NOT public", () => assert.equal(isPublicEmailDomain("rickymaliklaw.com"), false));
check("notgmail.com is NOT public (no dot-boundary false positive)", () =>
  assert.equal(isPublicEmailDomain("notgmail.com"), false));

// ── 2. JS predicate ↔ SQL regex equivalence ────────────────────────────────
// The SQL twin runs as `lower(email) ~ regex` in Postgres (POSIX ERE). The
// pattern deliberately uses only ERE-compatible syntax, so a JS RegExp over
// the lowercased input evaluates identically; this fixture sweep pins that.
const AUTOMATED_FIXTURES: Array<{ email: string; automated: boolean }> = [
  { email: "noreply@rickymaliklaw.com", automated: true },
  { email: "no-reply@firmdomain.com", automated: true },
  { email: "businessprofile-noreply@google.com", automated: true },
  { email: "googlemybusiness-noreply@google.com", automated: true },
  { email: "notifications@reviewtool.com", automated: true },
  { email: "notification@facebookmail.com", automated: true },
  { email: "donotreply@courts.state.va.us", automated: true },
  { email: "do-not-reply@lawpay.com", automated: true },
  { email: "billing.notifications@vendor.io", automated: true },
  { email: "bounce@mailer.example.com", automated: true },
  { email: "mailer-daemon@googlemail.com", automated: true },
  { email: "bot@intake.example", automated: true },
  { email: "postmaster@firm.com", automated: true },
  { email: "automated@system.example", automated: true },
  { email: "auto@shop.example", automated: true },
  { email: "system@calendaring.example", automated: true },
  // Task #4790 — receipt/billing-style senders. The first value is the EXACT
  // Stripe sender read from prod (2026-08-14) behind "Your Replit receipt"
  // emails that auto-matched into Dellutri Law Group's comm log.
  { email: "receipts+acct_15ypnsjamnyvovfn@stripe.com", automated: true },
  { email: "receipts@stripe.com", automated: true },
  { email: "receipt@shop.example", automated: true },
  { email: "billing@tabs3.com", automated: true },
  { email: "invoice@vendor.example", automated: true },
  { email: "invoices@vendor.example", automated: true },
  { email: "acct-receipts+123@stripe.com", automated: true }, // token after "-" boundary
  // Humans — including the tricky boundary cases from Task #971.
  { email: "henoreply@example.com", automated: false }, // token not at a boundary
  { email: "ricky@rickymaliklaw.com", automated: false },
  { email: "jane.doe@clientfirm.com", automated: false },
  { email: "paralegal+intake@firm.com", automated: false },
  { email: "autoinsurance.claims@firm.com", automated: false }, // "auto" mid-local-part token? starts local-part but followed by chars — regex is ^auto@ so no
  { email: "systematic.reviews@firm.com", automated: false },
  { email: "bots.department@firm.com", automated: false },
  // Task #4790 boundary negatives — receipt tokens NOT at a separator
  // boundary must stay human.
  { email: "ebilling@firm.com", automated: false },
  { email: "receiptsdept@firm.com", automated: false },
  { email: "myinvoice@firm.com", automated: false },
];
const sqlRe = new RegExp(AUTOMATED_SENDER_SQL_REGEX);
for (const f of AUTOMATED_FIXTURES) {
  check(`isAutomatedSenderEmail("${f.email}") === ${f.automated}`, () =>
    assert.equal(isAutomatedSenderEmail(f.email), f.automated));
  check(`SQL regex agrees for "${f.email}"`, () =>
    assert.equal(sqlRe.test(f.email.toLowerCase()), f.automated));
}

// ── 3. Tier-2 human-evidence guard ─────────────────────────────────────────
const CLIENT_A = "client-a-4049";
const CLIENT_B = "client-b-4049";
const clients = [
  {
    id: CLIENT_A,
    firmName: "Law Offices of Ricky Malik",
    isArchived: false,
    emailDomains: ["rickymaliklaw.com"],
    contactEmail: null,
  },
  {
    id: CLIENT_B,
    firmName: "Beta Legal Group",
    isArchived: false,
    // One legit domain + two entries that must be DROPPED at index build:
    // a public-suffix gateway and an exact public provider.
    emailDomains: ["betalegal.com", "docs.google.com", "gmail.com"],
    contactEmail: "owner@betalegal.com",
  },
] as unknown as Client[];
const contactsByClient = new Map<string, ClientContact[]>([
  [CLIENT_A, []],
  [CLIENT_B, []],
]);
const indexes = buildHardMatchIndexes(clients, contactsByClient);

check("index build drops public-suffix + public domains from emailDomains", () => {
  assert.equal(indexes.domainIndex.has("docs.google.com"), false, "docs.google.com must not be indexed");
  assert.equal(indexes.domainIndex.has("gmail.com"), false, "gmail.com must not be indexed");
  assert.equal(indexes.domainIndex.has("betalegal.com"), true);
  assert.equal(indexes.domainIndex.has("rickymaliklaw.com"), true);
});

check("human sender on trusted domain still matches (tier 2)", () => {
  const r = resolveFrontHardMatch(
    [
      { name: "Ricky Malik", email: "ricky@rickymaliklaw.com", role: "from" },
      { name: "Ops", email: "ops@nobullmarketing.com", role: "to" },
    ],
    indexes,
  );
  assert.equal(r.status, "matched");
  assert.equal((r as any).clientId, CLIENT_A);
  assert.equal((r as any).method, "email_domain");
});

check("automated-only sender on trusted domain stays unmatched with explicit reason", () => {
  // Production shape: a review-notification tool sending FROM the client's
  // own domain — correspondence count must not inflate on tool noise.
  const r = resolveFrontHardMatch(
    [
      { name: "Reviews", email: "notifications@rickymaliklaw.com", role: "from" },
      { name: "Ops", email: "ops@nobullmarketing.com", role: "to" },
    ],
    indexes,
  );
  assert.equal(r.status, "no_match");
  assert.match(
    (r as any).reason ?? "",
    new RegExp(MATCH_REASON_CODES.AUTOMATED_SENDERS_ONLY),
    "reason must carry the automated-senders-only code",
  );
});

check("mixed automated + human on same trusted domain matches (human evidence wins)", () => {
  const r = resolveFrontHardMatch(
    [
      { name: "Noreply", email: "noreply@rickymaliklaw.com", role: "from" },
      { name: "Ricky", email: "ricky@rickymaliklaw.com", role: "cc" },
    ],
    indexes,
  );
  assert.equal(r.status, "matched");
  assert.equal((r as any).clientId, CLIENT_A);
});

check("human senders on TWO clients' trusted domains stay ambiguous (all-or-one intact)", () => {
  const r = resolveFrontHardMatch(
    [
      { name: "Ricky", email: "ricky@rickymaliklaw.com", role: "from" },
      { name: "Beta", email: "someone@betalegal.com", role: "to" },
    ],
    indexes,
  );
  assert.equal(r.status, "ambiguous");
});

check("exact-email tier is untouched by the automated guard", () => {
  // Operator explicitly registered an automated-looking address as a client
  // contact → the per-address decision wins (tier 1).
  const withContact = new Map<string, ClientContact[]>([
    [
      CLIENT_A,
      [{ id: "c1", clientId: CLIENT_A, emails: ["notifications@rickymaliklaw.com"] } as unknown as ClientContact],
    ],
    [CLIENT_B, []],
  ]);
  const idx2 = buildHardMatchIndexes(clients, withContact);
  const r = resolveFrontHardMatch(
    [{ name: "Reviews", email: "notifications@rickymaliklaw.com", role: "from" }],
    idx2,
  );
  assert.equal(r.status, "matched");
  assert.equal((r as any).method, "email_exact");
});

check("public gateway subdomain sender contributes no domain evidence", () => {
  const r = resolveFrontHardMatch(
    [{ name: "Voice", email: "1555000000.someone@txt.voice.google.com", role: "from" }],
    indexes,
  );
  assert.equal(r.status, "no_match");
});

// ── 5. Task #4790 — vendor-platform + receipt-sender defense ───────────────
//
// Prod-pinned fixtures (read from the prod replica 2026-08-14): Dellutri Law
// Group's `clients.email_domains` claimed `stripe.com`, `mail.replit.com`,
// `tabs3.com`, and their "Christie Garratt" contact row carried
// `receipts+acct_15ypnsjamnyvovfn@stripe.com` + `contact@mail.replit.com` —
// NoBull's own vendor receipts then auto-matched 646 conversations into their
// comm log. The matcher must refuse this class of evidence even when client
// rows still claim it.

// 5a. Receipt-style predicate + SQL twin equivalence (subset of automated).
const RECEIPT_FIXTURES: Array<{ email: string; receipt: boolean }> = [
  { email: "receipts+acct_15ypnsjamnyvovfn@stripe.com", receipt: true }, // prod-pinned
  { email: "receipts@stripe.com", receipt: true },
  { email: "receipt@shop.example", receipt: true },
  { email: "billing@tabs3.com", receipt: true },
  { email: "billing+dunning@vendor.example", receipt: true },
  { email: "invoice@vendor.example", receipt: true },
  { email: "invoices@vendor.example", receipt: true },
  { email: "acct-receipts+123@stripe.com", receipt: true },
  { email: "law.billing@firm.example", receipt: true }, // "." separator boundary
  // Automated-but-NOT-receipt (the tier-1 guard keys on receipt-style only,
  // so these distinctions matter — Task #4049's operator-registered
  // `notifications@` contact must keep matching at tier 1):
  { email: "noreply@rickymaliklaw.com", receipt: false },
  { email: "notifications@reviewtool.com", receipt: false },
  { email: "billing.notifications@vendor.io", receipt: false }, // "billing" not directly before @
  // Humans / boundary negatives:
  { email: "ebilling@firm.com", receipt: false },
  { email: "receiptsdept@firm.com", receipt: false },
  { email: "myinvoice@firm.com", receipt: false },
  { email: "cgarratt@dellutrilawgroup.com", receipt: false },
];
const receiptSqlRe = new RegExp(RECEIPT_STYLE_SENDER_SQL_REGEX);
for (const f of RECEIPT_FIXTURES) {
  check(`isReceiptStyleSenderEmail("${f.email}") === ${f.receipt}`, () =>
    assert.equal(isReceiptStyleSenderEmail(f.email), f.receipt));
  check(`receipt SQL regex agrees for "${f.email}"`, () =>
    assert.equal(receiptSqlRe.test(f.email.toLowerCase()), f.receipt));
}

// 5b. Vendor-platform domain predicate: new payment/dev/billing entries,
// subdomain awareness, legacy legal-tech list intact, no substring false
// positives.
check("stripe.com / replit.com / tabs3.com are vendor-platform domains", () => {
  assert.equal(isVendorPlatformDomain("stripe.com"), true);
  assert.equal(isVendorPlatformDomain("replit.com"), true);
  assert.equal(isVendorPlatformDomain("tabs3.com"), true);
});
check("subdomains of vendor platforms are vendor too (mail.replit.com — prod-pinned)", () => {
  assert.equal(isVendorPlatformDomain("mail.replit.com"), true);
  assert.equal(isVendorPlatformDomain("my.stripe.com"), true);
});
check("legacy legal-tech vendor list still covered (clio.com, callrail.com)", () => {
  assert.equal(isVendorPlatformDomain("clio.com"), true);
  assert.equal(isVendorPlatformDomain("callrail.com"), true);
});
check("no substring false positives (notstripe.com, dellutrilawgroup.com)", () => {
  assert.equal(isVendorPlatformDomain("notstripe.com"), false);
  assert.equal(isVendorPlatformDomain("dellutrilawgroup.com"), false);
});

// 5c. Index build refuses vendor identifiers even when client rows claim
// them (the Dellutri poison shape, prod-pinned values).
const CLIENT_DELLUTRI = "client-dellutri-4790";
const poisonedClients = [
  {
    id: CLIENT_DELLUTRI,
    firmName: "Dellutri Law Group",
    isArchived: false,
    // Prod-read 2026-08-14: one legit domain + three vendor domains.
    emailDomains: ["dellutrilawgroup.com", "stripe.com", "mail.replit.com", "tabs3.com"],
    contactEmail: "receipts+acct_15ypnsjamnyvovfn@stripe.com", // vendor-tainted primary
  },
] as unknown as Client[];
const poisonedContacts = new Map<string, ClientContact[]>([
  [
    CLIENT_DELLUTRI,
    [
      {
        id: "cc-garratt",
        clientId: CLIENT_DELLUTRI,
        // Prod-read: legit address + the two vendor senders.
        emails: [
          "cgarratt@dellutrilawgroup.com",
          "receipts+acct_15ypnsjamnyvovfn@stripe.com",
          "contact@mail.replit.com",
        ],
      } as unknown as ClientContact,
    ],
  ],
]);
const poisonedIdx = buildHardMatchIndexes(poisonedClients, poisonedContacts);

check("index build drops vendor-platform domains from emailDomains (keeps the legit one)", () => {
  assert.equal(poisonedIdx.domainIndex.has("stripe.com"), false, "stripe.com must not be indexed");
  assert.equal(poisonedIdx.domainIndex.has("mail.replit.com"), false, "mail.replit.com must not be indexed");
  assert.equal(poisonedIdx.domainIndex.has("tabs3.com"), false, "tabs3.com must not be indexed");
  assert.equal(poisonedIdx.domainIndex.has("dellutrilawgroup.com"), true, "legit client domain stays indexed");
});
check("index build drops vendor/receipt contact emails (keeps the legit one)", () => {
  assert.equal(poisonedIdx.emailIndex.has("receipts+acct_15ypnsjamnyvovfn@stripe.com"), false);
  assert.equal(poisonedIdx.emailIndex.has("contact@mail.replit.com"), false);
  assert.equal(poisonedIdx.emailIndex.has("cgarratt@dellutrilawgroup.com"), true);
});

// 5d. Participant-side defense: even a STALE/poisoned index (built before the
// policy, or hydrated from a cache) must not let vendor evidence match —
// resolve refuses vendor-tainted participants at both tiers.
const staleIdx = {
  emailIndex: new Map<string, Set<string>>([
    ["receipts+acct_15ypnsjamnyvovfn@stripe.com", new Set([CLIENT_DELLUTRI])],
    ["contact@mail.replit.com", new Set([CLIENT_DELLUTRI])],
    ["cgarratt@dellutrilawgroup.com", new Set([CLIENT_DELLUTRI])],
  ]),
  domainIndex: new Map<string, Set<string>>([
    ["stripe.com", new Set([CLIENT_DELLUTRI])],
    ["dellutrilawgroup.com", new Set([CLIENT_DELLUTRI])],
  ]),
  firmNames: new Map([[CLIENT_DELLUTRI, "Dellutri Law Group"]]),
};

check("receipt-style sender never exact-email matches, even against a poisoned index", () => {
  const r = resolveFrontHardMatch(
    [
      { name: "Stripe", email: "receipts+acct_15ypnsjamnyvovfn@stripe.com", role: "from" },
      { name: "Ops", email: "ops@nobullmarketing.com", role: "to" },
    ],
    staleIdx,
  );
  assert.equal(r.status, "no_match");
});
check("vendor-domain sender never exact-email matches, even against a poisoned index", () => {
  const r = resolveFrontHardMatch(
    [{ name: "Replit", email: "contact@mail.replit.com", role: "from" }],
    staleIdx,
  );
  assert.equal(r.status, "no_match");
});
check("vendor domain contributes no tier-2 domain evidence, even against a poisoned index", () => {
  // A human-looking sender on a vendor platform (support@stripe.com) still
  // must not match via the poisoned trusted-domain entry.
  const r = resolveFrontHardMatch(
    [{ name: "Stripe Support", email: "support@stripe.com", role: "from" }],
    staleIdx,
  );
  assert.equal(r.status, "no_match");
});

// 5e. False-positive guards: legit Dellutri mail keeps matching.
check("legit client contact email still exact-matches (cgarratt@dellutrilawgroup.com)", () => {
  const r = resolveFrontHardMatch(
    [{ name: "Christie Garratt", email: "cgarratt@dellutrilawgroup.com", role: "from" }],
    poisonedIdx,
  );
  assert.equal(r.status, "matched");
  assert.equal((r as any).clientId, CLIENT_DELLUTRI);
  assert.equal((r as any).method, "email_exact");
});
check("legit client domain still matches via tier 2 (human on dellutrilawgroup.com)", () => {
  const r = resolveFrontHardMatch(
    [{ name: "Paralegal", email: "paralegal@dellutrilawgroup.com", role: "from" }],
    poisonedIdx,
  );
  assert.equal(r.status, "matched");
  assert.equal((r as any).clientId, CLIENT_DELLUTRI);
  assert.equal((r as any).method, "email_domain");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
