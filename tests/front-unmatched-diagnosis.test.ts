/* test-registration
{
  "name": "Front unmatched-backlog diagnosis (Task #2512)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #2512 — Front unmatched-backlog diagnosis.
//
// Pins the contract that:
//   1. `classifyUnmatchedRow` puts every unmatched row in exactly one cause
//      bucket using the SAME deterministic hard-match resolver the live
//      pipeline uses (no fuzzy / name guessing): wouldMatchNow, sharedEmail,
//      sharedDomain, probableOperational, companyOnly, noExternalSignal,
//      noClientData.
//   2. The precision guardrails the attach route depends on still reject a
//      public free-mail domain, the company's own domain, and an automated
//      spam sender — so "raise match rate" can never weaken precision.
//   3. `reEvaluateUnmatchedForTarget` short-circuits on an empty target
//      WITHOUT touching storage (the targeted path never falls back to a
//      whole-corpus sweep).
//
// Pure: builds the hard-match indexes in memory; no DB IO.
//
// Run: tsx tests/front-unmatched-diagnosis.test.ts

import { buildHardMatchIndexes, type FrontParticipant } from "../server/services/frontHardMatch";
import { classifyUnmatchedRow } from "../server/services/frontUnmatchedDiagnosis";
import { reEvaluateUnmatchedForTarget, reEvaluateUnmatchedForTargets, isSpamSenderEmail } from "../server/services/frontIntegration";
import { isPublicEmailDomain, isCompanyDomain, isCompanyEmail } from "../server/services/companyIdentity";
import type { Client, ClientContact } from "@shared/schema";

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// Two clients. Client A owns an exact contact email + a uniquely-trusted
// domain. Client B + C both claim the SAME email and SAME domain to force
// the ambiguous (shared) buckets.
function makeClient(id: string, over: Partial<Client>): Client {
  return {
    id,
    firmName: `Firm ${id}`,
    isArchived: false,
    contactEmail: null,
    emailDomains: [],
    ...over,
  } as unknown as Client;
}

function buildIndexes() {
  const clients: Client[] = [
    makeClient("A", { contactEmail: "owner@acme-law.com", emailDomains: ["acme-law.com"] }),
    makeClient("B", { contactEmail: "shared@bothfirms.com", emailDomains: ["sharedco.com"] }),
    makeClient("C", { contactEmail: "shared@bothfirms.com", emailDomains: ["sharedco.com"] }),
  ];
  const contactsByClient = new Map<string, ClientContact[]>();
  return buildHardMatchIndexes(clients, contactsByClient);
}

function p(email: string | null, name?: string): FrontParticipant {
  return { email, name: name ?? null, role: null };
}

function run(): void {
  console.log("front-unmatched-diagnosis: classification");
  const idx = buildIndexes();

  // 1) wouldMatchNow — exact email now owned by a single client.
  assert(
    classifyUnmatchedRow([p("owner@acme-law.com")], idx) === "wouldMatchNow",
    "exact-email owned by one client → wouldMatchNow",
  );
  // wouldMatchNow via trusted domain too.
  assert(
    classifyUnmatchedRow([p("newperson@acme-law.com")], idx) === "wouldMatchNow",
    "trusted-domain owned by one client → wouldMatchNow",
  );

  // 2) sharedEmail — exact email owned by >1 client (deliberately not claimed).
  assert(
    classifyUnmatchedRow([p("shared@bothfirms.com")], idx) === "sharedEmail",
    "exact-email owned by two clients → sharedEmail",
  );

  // 3) sharedDomain — trusted domain owned by >1 client.
  assert(
    classifyUnmatchedRow([p("someone@sharedco.com")], idx) === "sharedDomain",
    "trusted-domain owned by two clients → sharedDomain",
  );

  // 4) probableOperational — external sender, no client, automated address.
  assert(
    classifyUnmatchedRow([p("noreply@vendor.io")], idx) === "probableOperational",
    "automated noreply sender with no client → probableOperational",
  );
  assert(
    classifyUnmatchedRow([p("billing-notifications@stripe.com")], idx) === "probableOperational",
    "notifications@ sender with no client → probableOperational",
  );

  // 5) companyOnly — only internal participants.
  assert(
    classifyUnmatchedRow([p("team@nobullmarketing.com"), p("oliver@nobullmarketing.com")], idx) === "companyOnly",
    "all-company participants → companyOnly",
  );

  // 6) noExternalSignal — no participants at all to match on. (A participant
  //    that carries a name but no email is treated as company-filtered by the
  //    resolver, so the empty-conversation case is what lands here.)
  assert(
    classifyUnmatchedRow([], idx) === "noExternalSignal",
    "no participants → noExternalSignal",
  );
  assert(
    classifyUnmatchedRow([p(null, "No Email Person")], idx) === "companyOnly",
    "name-only participant (no email) → companyOnly",
  );

  // 7) noClientData — genuine external sender no client owns yet (the
  //    actionable backlog).
  assert(
    classifyUnmatchedRow([p("jane@prospectfirm.com")], idx) === "noClientData",
    "external human sender with no client → noClientData",
  );
  // A public free-mail human sender is also noClientData (not operational).
  assert(
    classifyUnmatchedRow([p("jane.doe@gmail.com")], idx) === "noClientData",
    "public free-mail human sender with no client → noClientData",
  );

  console.log("front-unmatched-diagnosis: precision guardrails (attach route)");
  // These are the exact predicates the attach-sender-to-client route uses to
  // refuse weakening precision.
  assert(isPublicEmailDomain("gmail.com") === true, "gmail.com rejected as public domain");
  assert(isPublicEmailDomain("acme-law.com") === false, "private client domain not flagged public");
  assert(isCompanyDomain("nobullmarketing.com") === true, "company domain rejected");
  assert(isCompanyEmail("team@nobullmarketing.com") === true, "company email rejected");
  assert(isSpamSenderEmail("noreply@acme-law.com") === true, "noreply sender rejected as contact");
  assert(isSpamSenderEmail("jane@acme-law.com") === false, "ordinary human sender allowed as contact");
}

async function runAsync(): Promise<void> {
  run();

  console.log("front-unmatched-diagnosis: targeted re-eval scoping");
  // Empty target must short-circuit WITHOUT querying storage — the targeted
  // path never expands to a whole-corpus sweep.
  const empty = await reEvaluateUnmatchedForTarget({});
  assert(
    empty.total === 0 && empty.matched === 0 && empty.filterRuleHandled === 0,
    "empty target re-eval is a no-op (no whole-corpus fallback)",
  );
  const blank = await reEvaluateUnmatchedForTarget({ email: "  ", domain: "  " });
  assert(
    blank.total === 0 && blank.matched === 0,
    "whitespace-only target re-eval is a no-op",
  );

  // Task #2526 — the BATCH re-eval shares the same no-whole-corpus-fallback
  // guarantee: an empty list, an all-blank list, and a no-args call must all
  // short-circuit WITHOUT touching storage.
  const batchEmpty = await reEvaluateUnmatchedForTargets([]);
  assert(
    batchEmpty.total === 0 && batchEmpty.matched === 0 && batchEmpty.filterRuleHandled === 0,
    "empty batch re-eval is a no-op (no whole-corpus fallback)",
  );
  const batchBlank = await reEvaluateUnmatchedForTargets([
    { domain: "  " },
    { email: "  ", domain: "  " },
    {},
  ]);
  assert(
    batchBlank.total === 0 && batchBlank.matched === 0,
    "all-blank batch re-eval is a no-op",
  );

  console.log(`\nfront-unmatched-diagnosis: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
