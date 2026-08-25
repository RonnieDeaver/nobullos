/* test-registration
{
  "name": "Zoom client matching tiers (Task #4050)",
  "smoke": true,
  "smokeReason": "DB-free pure-function suite: every deterministic Zoom→client matching tier plus the ambiguity/person-name refusal rails that keep bad auto-attributions out of churn analysis.",
  "tier": "small"
}
test-registration */
/**
 * Task #4050 — deterministic Zoom → client matching tiers.
 *
 * Pure unit suite (no DB): exercises buildZoomMatchIndexes /
 * resolveZoomTrustedDomainMatch / resolveZoomTopicFirmMatch /
 * resolveZoomClientMatch with the participant matcher INJECTED, using
 * production-shaped fixtures pinned from the 90-day unmatched study:
 *
 *   - "Richard Perez <> NoBull Marketing" must NOT auto-claim
 *     "Luis A. Perez, P.C." (person-named prospect call) — demote to review
 *     with the suggestion stored.
 *   - "Mike Jones" must NOT auto-claim "Jones Law Firm"; "April Jones" (a
 *     real client contact) MUST — contact confirmation flips the guard.
 *   - Initials/common-first-name firms (MJ Law, Grace Legal) are ineligible
 *     for the topic tier entirely.
 *   - Host-only participant lists (538 of 561 unmatched records) must not
 *     block the topic tier — topic evidence is participant-independent.
 *   - Trusted-domain evidence: exactly one claiming client auto-matches;
 *     shared domains, public domains, company/internal and automated sender
 *     emails never count.
 *   - Cross-tier disagreement always demotes to review, never guesses.
 */

import {
  isStrongParticipantSignal,
  normalizeZoomTopicTokens,
  buildZoomMatchIndexes,
  resolveZoomTrustedDomainMatch,
  resolveZoomTopicFirmMatch,
  resolveZoomClientMatch,
  AMBIGUOUS_TRUSTED_DOMAIN_REVIEW_REASON,
  AMBIGUOUS_TOPIC_FIRM_REVIEW_REASON,
  PERSON_NAME_TOPIC_REVIEW_REASON,
  CONFLICTING_SIGNALS_REVIEW_REASON,
  type ZoomMatchClientInput,
  type ZoomMatchContactInput,
} from "../server/services/zoomClientMatching";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

// ─── Fixtures (shapes pinned from the production unmatched study) ───────────

const CLIENTS: ZoomMatchClientInput[] = [
  { id: "c-bledsoe", firmName: "Bledsoe Law Firm", emailDomains: ["bledsoefirm.example"] },
  { id: "c-jones", firmName: "Jones Law Firm", emailDomains: [] },
  { id: "c-perez", firmName: "Luis A. Perez, P.C.", emailDomains: [] },
  { id: "c-dellutri", firmName: "The Dellutri Law Group", emailDomains: [] },
  { id: "c-family", firmName: "Family First Firm", emailDomains: [] },
  { id: "c-mj", firmName: "MJ Law", emailDomains: [] },
  { id: "c-grace", firmName: "Grace Legal", emailDomains: [] },
  // Two clients deliberately sharing one trusted domain (ambiguity fixture).
  { id: "c-shared-1", firmName: "Shared Domain One LLC", emailDomains: ["sharedfixture.example"] },
  { id: "c-shared-2", firmName: "Shared Domain Two LLC", emailDomains: ["sharedfixture.example"] },
  // Operator pasted junk into emailDomains — must never become evidence.
  { id: "c-junk", firmName: "Junk Domains LLC", emailDomains: ["gmail.com", "nobullmarketing.com"] },
  // Two clients share dualfixture.example so the domain tier yields an
  // ambiguous SHORTLIST — the topic tier then disambiguates within it.
  { id: "c-dual-a", firmName: "Dual Alpha Partners", emailDomains: ["dualfixture.example"] },
  { id: "c-dual-b", firmName: "Dual Beta Partners", emailDomains: ["dualfixture.example"] },
  // Archived client — must be invisible to every tier.
  { id: "c-archived", firmName: "Archived Firm", emailDomains: ["archivedfixture.example"], isArchived: true },
];

const CONTACTS = new Map<string, ZoomMatchContactInput[]>([
  ["c-jones", [{ name: "April Jones" }]],
]);

const INDEXES = buildZoomMatchIndexes(CLIENTS, CONTACTS);

const noParticipantMatch = async () => null;

async function run(): Promise<void> {
  section("isStrongParticipantSignal");
  assert(isStrongParticipantSignal("contact_email:a@b.example"), "contact_email is strong");
  assert(isStrongParticipantSignal("participant_email:a@b.example"), "participant_email is strong");
  assert(!isStrongParticipantSignal("contact_name:april jones"), "contact_name is weak");
  assert(!isStrongParticipantSignal("owner:someone"), "owner fallback is weak");

  section("normalizeZoomTopicTokens");
  assert(
    JSON.stringify(normalizeZoomTopicTokens("NoBull <> The Dellutri Law Group!")) ===
      JSON.stringify(["nobull", "the", "dellutri", "law", "group"]),
    "topic normalization strips punctuation and lowercases",
  );
  assert(normalizeZoomTopicTokens(null).length === 0, "null topic → no tokens");

  section("buildZoomMatchIndexes eligibility");
  const coreIds = new Set(INDEXES.firmCores.map((c) => c.clientId));
  assert(!coreIds.has("c-mj"), "MJ Law (initials only) is topic-tier ineligible");
  assert(!coreIds.has("c-grace"), "Grace Legal (common first name + generic) is ineligible");
  assert(!coreIds.has("c-archived"), "archived clients build no firm core");
  const perezCore = INDEXES.firmCores.find((c) => c.clientId === "c-perez");
  assert(
    JSON.stringify(perezCore?.required) === JSON.stringify(["perez"]),
    `Luis A. Perez, P.C. core is ["perez"] (got ${JSON.stringify(perezCore?.required)})`,
  );
  const familyCore = INDEXES.firmCores.find((c) => c.clientId === "c-family");
  assert(
    JSON.stringify([...(familyCore?.required ?? [])].sort()) === JSON.stringify(["family", "first"]),
    "Family First Firm keeps a two-token core (collision-safe)",
  );
  assert(!INDEXES.domainToClientIds.has("gmail.com"), "public domain pasted into emailDomains is ignored");
  assert(!INDEXES.domainToClientIds.has("nobullmarketing.com"), "company domain pasted into emailDomains is ignored");
  assert(!INDEXES.domainToClientIds.has("archivedfixture.example"), "archived client's domain is not indexed");

  section("trusted-domain tier");
  let out = resolveZoomTrustedDomainMatch(["sarah@bledsoefirm.example"], INDEXES);
  assert(out.kind === "auto" && out.clientId === "c-bledsoe", "unique trusted domain auto-matches");
  assert(
    out.kind === "auto" && out.matchedOn === "trusted_domain:bledsoefirm.example",
    `matchedOn records the domain (got ${out.kind === "auto" ? out.matchedOn : out.kind})`,
  );
  out = resolveZoomTrustedDomainMatch(
    ["sarah@bledsoefirm.example", "joe@bledsoefirm.example"],
    INDEXES,
  );
  assert(out.kind === "auto" && out.clientId === "c-bledsoe", "two participants, same client → still auto");
  out = resolveZoomTrustedDomainMatch(["bob@sharedfixture.example"], INDEXES);
  assert(
    out.kind === "review" && out.reviewReason === AMBIGUOUS_TRUSTED_DOMAIN_REVIEW_REASON,
    "shared domain demotes to review",
  );
  assert(
    out.kind === "review" && out.suggestedClientId === null && out.candidates.length === 2,
    "ambiguous domain stores NO suggestion but both candidates",
  );
  assert(
    resolveZoomTrustedDomainMatch(["x@gmail.com"], INDEXES).kind === "none",
    "public-domain participant is never evidence",
  );
  assert(
    resolveZoomTrustedDomainMatch(["host@nobullmarketing.com"], INDEXES).kind === "none",
    "internal participant is never evidence",
  );
  assert(
    resolveZoomTrustedDomainMatch(["noreply@bledsoefirm.example"], INDEXES).kind === "none",
    "automated sender on a trusted domain is never evidence",
  );
  assert(
    resolveZoomTrustedDomainMatch(["client@archivedfixture.example"], INDEXES).kind === "none",
    "archived client's domain never matches",
  );

  section("topic ↔ firm-name tier");
  out = resolveZoomTopicFirmMatch("NoBull <> The Dellutri Law Group", INDEXES);
  assert(out.kind === "auto" && out.clientId === "c-dellutri", "firm-named topic auto-matches");
  out = resolveZoomTopicFirmMatch("Family First Firm kickoff", INDEXES);
  assert(out.kind === "auto" && out.clientId === "c-family", "multi-token core auto-matches when ALL tokens present");
  assert(
    resolveZoomTopicFirmMatch("Family reunion planning", INDEXES).kind === "none",
    "partial multi-token core (missing 'first') does not match",
  );
  out = resolveZoomTopicFirmMatch("Richard Perez <> NoBull Marketing", INDEXES);
  assert(
    out.kind === "review" && out.reviewReason === PERSON_NAME_TOPIC_REVIEW_REASON,
    "person-named topic (Richard Perez) demotes instead of claiming Luis A. Perez, P.C.",
  );
  assert(
    out.kind === "review" && out.suggestedClientId === "c-perez",
    "person-name demotion stores the surname client as the one-click suggestion",
  );
  out = resolveZoomTopicFirmMatch("Mike Jones", INDEXES);
  assert(
    out.kind === "review" && out.reviewReason === PERSON_NAME_TOPIC_REVIEW_REASON && out.suggestedClientId === "c-jones",
    "unknown person sharing a client surname demotes to review",
  );
  out = resolveZoomTopicFirmMatch("April Jones", INDEXES);
  assert(
    out.kind === "auto" && out.clientId === "c-jones",
    "known client CONTACT named in the topic stays auto (April Jones)",
  );
  out = resolveZoomTopicFirmMatch("Jones and Bledsoe strategy sync", INDEXES);
  assert(
    out.kind === "review" && out.reviewReason === AMBIGUOUS_TOPIC_FIRM_REVIEW_REASON && out.candidates.length === 2,
    "topic hitting two firms demotes with both candidates",
  );
  assert(resolveZoomTopicFirmMatch("MJ Law monthly", INDEXES).kind === "none", "ineligible firm (MJ Law) never topic-matches");
  assert(resolveZoomTopicFirmMatch("Grace Legal check-in", INDEXES).kind === "none", "ineligible firm (Grace Legal) never topic-matches");
  assert(resolveZoomTopicFirmMatch("", INDEXES).kind === "none", "empty topic → none");

  section("resolveZoomClientMatch orchestration");
  // Tier 2: strong participant signal, external call.
  let res = await resolveZoomClientMatch(
    { participantEmails: ["april@clientmail.example"], topic: null },
    {
      matchParticipants: async () => ({ clientId: "c-jones", matchedOn: "contact_email:april@clientmail.example" }),
      indexes: INDEXES,
    },
  );
  assert(
    res.kind === "auto" && res.tier === "participant" && res.clientId === "c-jones",
    "strong participant signal wins tier 2",
  );

  // Strong-but-all-internal: skips tier 2, ends as solo_internal review.
  res = await resolveZoomClientMatch(
    { participantEmails: ["host@nobullmarketing.com"], topic: null },
    {
      matchParticipants: async () => ({ clientId: "c-jones", matchedOn: "contact_email:host@nobullmarketing.com" }),
      indexes: INDEXES,
    },
  );
  assert(
    res.kind === "review" && res.reviewReason === "solo_internal_participants" && res.suggestedClientId === "c-jones",
    "all-internal participant match demotes to solo_internal_participants review",
  );

  // THE exemption: host-only participants + firm-named topic stays AUTO.
  res = await resolveZoomClientMatch(
    { participantEmails: ["host@nobullmarketing.com"], topic: "NoBull <> The Dellutri Law Group" },
    { matchParticipants: noParticipantMatch, indexes: INDEXES },
  );
  assert(
    res.kind === "auto" && res.tier === "topic_firm_name" && res.clientId === "c-dellutri",
    "host-only call with firm-named topic auto-matches (topic tier exempt from all-internal demotion)",
  );

  // Domain auto + topic auto, same client → trusted_domain tier reported.
  res = await resolveZoomClientMatch(
    { participantEmails: ["sarah@bledsoefirm.example"], topic: "NoBull <> Bledsoe Law Firm" },
    { matchParticipants: noParticipantMatch, indexes: INDEXES },
  );
  assert(
    res.kind === "auto" && res.tier === "trusted_domain" && res.clientId === "c-bledsoe",
    "agreeing domain+topic auto-matches once",
  );

  // Domain auto + topic auto, DIFFERENT clients → conflict review.
  res = await resolveZoomClientMatch(
    { participantEmails: ["sarah@bledsoefirm.example"], topic: "April Jones" },
    { matchParticipants: noParticipantMatch, indexes: INDEXES },
  );
  assert(
    res.kind === "review" && res.reviewReason === CONFLICTING_SIGNALS_REVIEW_REASON,
    "domain vs topic disagreement demotes to conflicting_signals",
  );
  assert(
    res.kind === "review" &&
      res.suggestedClientId === null &&
      res.candidates.map((c) => c.clientId).sort().join(",") === "c-bledsoe,c-jones",
    "conflict review stores both candidates and no suggestion",
  );

  // Ambiguous domain shortlist CONTAINING the unique topic hit = agreement.
  res = await resolveZoomClientMatch(
    { participantEmails: ["bob@dualfixture.example"], topic: "Dual Alpha Partners quarterly" },
    { matchParticipants: noParticipantMatch, indexes: INDEXES },
  );
  assert(
    res.kind === "auto" && res.tier === "topic_firm_name" && res.clientId === "c-dual-a",
    "domain shortlist containing the topic hit resolves to the topic client",
  );

  // Ambiguous domain shortlist EXCLUDING the topic hit = conflict.
  res = await resolveZoomClientMatch(
    { participantEmails: ["bob@sharedfixture.example"], topic: "April Jones" },
    { matchParticipants: noParticipantMatch, indexes: INDEXES },
  );
  assert(
    res.kind === "review" && res.reviewReason === CONFLICTING_SIGNALS_REVIEW_REASON && res.candidates.length === 3,
    "domain shortlist excluding the topic hit demotes with all three candidates",
  );

  // Ambiguous domain + weak participant → weak suggestion fills the slot.
  res = await resolveZoomClientMatch(
    { participantEmails: ["bob@sharedfixture.example"], topic: null },
    {
      matchParticipants: async () => ({ clientId: "c-shared-1", matchedOn: "contact_name:bob shared" }),
      indexes: INDEXES,
    },
  );
  assert(
    res.kind === "review" &&
      res.reviewReason === AMBIGUOUS_TRUSTED_DOMAIN_REVIEW_REASON &&
      res.suggestedClientId === "c-shared-1",
    "weak participant suggestion fills an empty ambiguous-domain suggestion slot",
  );

  // Person-name topic demotion keeps ITS suggestion over a weak participant.
  res = await resolveZoomClientMatch(
    { participantEmails: ["mike@gmail.com"], topic: "Mike Jones" },
    {
      matchParticipants: async () => ({ clientId: "c-bledsoe", matchedOn: "contact_name:mike" }),
      indexes: INDEXES,
    },
  );
  assert(
    res.kind === "review" &&
      res.reviewReason === PERSON_NAME_TOPIC_REVIEW_REASON &&
      res.suggestedClientId === "c-jones" &&
      res.candidates.some((c) => c.clientId === "c-bledsoe"),
    "person-name review keeps its own suggestion; weak participant joins candidates only",
  );

  // Tier 5: weak participant only, external call.
  res = await resolveZoomClientMatch(
    { participantEmails: ["someone@randomfirm.example"], topic: null },
    {
      matchParticipants: async () => ({ clientId: "c-jones", matchedOn: "contact_name:someone random" }),
      indexes: INDEXES,
    },
  );
  assert(
    res.kind === "review" && res.reviewReason === "weak_signal_only" && res.suggestedClientId === "c-jones",
    "weak participant signal alone demotes to weak_signal_only",
  );

  // Participant matcher THROWING must not kill the deterministic tiers.
  res = await resolveZoomClientMatch(
    { participantEmails: ["sarah@bledsoefirm.example"], topic: null },
    {
      matchParticipants: async () => {
        throw new Error("[t4050] injected matcher failure");
      },
      indexes: INDEXES,
    },
  );
  assert(
    res.kind === "auto" && res.tier === "trusted_domain" && res.clientId === "c-bledsoe",
    "participant matcher failure still lets the domain tier match",
  );

  // Nothing anywhere → none.
  res = await resolveZoomClientMatch(
    { participantEmails: [], topic: "weekly huddle" },
    { matchParticipants: noParticipantMatch, indexes: INDEXES },
  );
  assert(res.kind === "none", "no signals at all → none (lands in review via caller)");

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
}

run()
  .catch((err) => {
    console.error("FATAL:", err);
    failed++;
  })
  .finally(() => {
    process.exit(failed > 0 ? 1 : 0);
  });
