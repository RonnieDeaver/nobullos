/* test-registration
{
  "name": "Daily judgment rating contract — atomic evidence, authoritative status/relationship/risk, and audit",
  "regression": true,
  "smoke": true,
  "smokeReason": "The deterministic rating contract validates atomic evidence provenance and owns persisted status, relationship, and risk. Pure, DB-free invariant coverage proves evidence-required tiers, disjoint risk bands, model independence, and monotonic independent-driver scoring; persistence is covered by tests/daily-judgment-data-inventory.test.ts.",
  "timeoutMs": 60000,
  "tier": "small"
}
test-registration */
/**
 * Task #4761 — unit coverage for the deterministic judgment tier gate:
 *
 *   1. `validateEvidenceCitations` — verbatim-quote checking against the
 *      PROVENANCE-SCOPED evidence corpus: normalization (curly
 *      quotes/dashes/whitespace), minimum-substance rules (stricter for
 *      Critical-qualifying categories), fixed-vocabulary categories, the
 *      20-item cap, and storage truncation. A quote that only exists in a
 *      PRIOR JUDGMENT is rejected — earlier AI output can never launder
 *      itself into evidence. Deterministic reclassification closes the
 *      category-label loophole: agency write-off vocabulary is forcibly
 *      internal_hygiene_gap wherever it appears, Critical-qualifying
 *      categories quoted only from internal context downgrade to
 *      expressed_dissatisfaction, and corroborated_loss_signal needs >= 2
 *      DISTINCT client-communication citations.
 *   2. `isBaselineSilenceExceeded` — silence judged against the client's
 *      OWN longest historical gap (fallback 21d), never from ≤3 business
 *      days, never from a null (no-comms) baseline.
 *   3. `assessDeliveryStability` — latest completed month vs prior average;
 *      "unknown" for thin/stale/all-zero history; the in-progress judgment
 *      month is excluded so a partial total never reads as collapse.
 *   4. `applyJudgmentTierGate` — the ceilings themselves, pinned to real
 *      prod-replica basis rows (2026-08-14): the steady-leads quiet client
 *      the CEO flagged must NOT be Critical; an explicit client cancel
 *      quote may be; the gate never RAISES severity; Healthy-force applies
 *      only on a full basis with stable delivery and zero validated
 *      negative evidence; stored risk is clamped into the gated tier band.
 *   5. `buildEvidenceCorpus` — renders comms/intel/asks/panel/RIS/report
 *      sections via the SAME builders the prompt uses (so citations are
 *      checked against exactly what the model saw) and structurally
 *      excludes prior judgments and agent-memory context.
 *
 * Pure functions, DB-free — but importing the dailyJudgment module for
 * `buildEvidenceCorpus` warms the pg pools through its storage imports, so
 * the suite closes them for a natural drain (same pattern as
 * tests/daily-judgment-calibration-pure.test.ts).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import {
  TIER_GATE_VERSION,
  TIER_RISK_BANDS,
  MAX_EVIDENCE_ITEMS,
  AGENCY_WRITEOFF_PHRASES,
  containsAgencyWriteoffLanguage,
  isKnownEvidenceCategory,
  normalizeForCitationMatch,
  validateEvidenceCitations,
  isBaselineSilenceExceeded,
  assessDeliveryStability,
  clampRiskToTier,
  calculateRiskFromDrivers,
  buildEvidenceRecencyFingerprint,
  applyJudgmentTierGate,
  buildTierGateAudit,
  toAccountRatingPresentation,
  reconcileJudgmentNarrative,
  stripModelRatingClaims,
  type TierGateInput,
  type EvidenceCorpus,
  type EvidenceFragment,
  type EvidenceProvenance,
} from "../server/services/judgmentTierGate";
import {
  buildEvidenceCorpus,
  buildJudgmentCommSections,
  discloseInternalInterpretationInNarrative,
  extractClientAuthoredCommContent,
  buildOpenAsksSection,
  STALE_ASK_THRESHOLD_DAYS,
  type CommWithPerClientSummary,
} from "../server/services/dailyJudgment";
import { closeDbPools } from "../server/db";

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message ?? err}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, msg: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg}: expected to find ${JSON.stringify(needle)}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const DATE_STR = "2026-08-14";
const CLIENT_IDENTITY = {
  contactEmail: "client@acmelegal.com",
  emailDomains: ["acmelegal.com"],
  contactPhone: "+15551234567",
};

function comm(i: number, hoursAgo: number, extra: Record<string, unknown> = {}): CommWithPerClientSummary {
  return {
    id: `c${i}`,
    timestamp: new Date(Date.parse(`${DATE_STR}T23:00:00.000Z`) - hoursAgo * 60 * 60 * 1000),
    sourceType: "front_email",
    sourceSubtype: "email_message",
    direction: "inbound",
    title: `Corpus comm ${i}`,
    contentPreview: null,
    participantsJson: [{ email: "client@acmelegal.com", role: "author" }],
    ...extra,
  } as unknown as CommWithPerClientSummary;
}

// The dissatisfied comm the model may cite (rendered with full Content line
// because it sits in the 24h band).
const FRUSTRATED_COMM = comm(1, 2, {
  contentPreview:
    "We are honestly frustrated - three weeks with no report and we're being courted by LawRank.",
});

// Client's OWN cancel language in an inbound message's Content line — the
// only provenance that may unlock Critical.
const CANCEL_COMM = comm(3, 5, {
  contentPreview:
    "If August looks like July we want to cancel the engagement at the end of the quarter.",
});
const CLIENT_CANCEL_QUOTE = "want to cancel the engagement at the end of the quarter";

// AI-generated summary text on an INBOUND comm: rendered in the prompt's
// "AI Summary:" line but NOT client speech — prior AI output must never
// unlock Critical (it can launder a hallucinated cancellation).
const AI_SUMMARY_COMM = comm(4, 6, {
  aiSummary: "Summary: the client intends to cancel the contract at renewal unless lead volume recovers.",
});
const AI_SUMMARY_QUOTE = "intends to cancel the contract at renewal unless lead volume recovers";

const GENERATED_ZOOM_SIGNAL_QUOTE =
  "The client may be preparing to switch agencies after expressing concern about lead quality";
const GENERATED_ZOOM_COMM = comm(6, 4, {
  sourceType: "zoom",
  sourceSubtype: "recording",
  direction: "internal",
  aiSignals: [{
    relevance: "high",
    type: "churn_risk",
    description: GENERATED_ZOOM_SIGNAL_QUOTE,
  }],
});

// OUR outbound message: agency-authored language that is NOT in the
// write-off denylist — outbound provenance alone must keep it out of the
// client scope.
const OUTBOUND_COMM = comm(5, 7, {
  direction: "outbound",
  contentPreview:
    "After internal review we think this engagement should be wound down before the renewal date.",
});
const OUTBOUND_QUOTE = "this engagement should be wound down before the renewal date";

const INTEL_ROWS = [
  {
    id: "i-1",
    clientId: "c-1",
    judgmentId: null,
    concernText: "Renewal risk raised on the July call",
    intelType: "context",
    note: "Client said they want to cancel in a month if leads don't recover.",
    createdBy: "u-1",
    createdAt: new Date("2026-08-03T14:00:00.000Z"),
  },
  {
    id: "i-2",
    clientId: "c-1",
    judgmentId: null,
    concernText: "Account posture debate",
    intelType: "context",
    // Agency write-off vocabulary observed verbatim in prod panel/ask rows —
    // the exact text that drove the 46-Critical wall. Must never validate as
    // client churn evidence.
    note: "Team consensus: this client has effectively churned and we should offboard after Q3.",
    createdBy: "u-1",
    createdAt: new Date("2026-08-05T14:00:00.000Z"),
  },
] as any[];

const OPEN_ASKS = [
  {
    askText: "Send the June reconciliation spreadsheet",
    status: "open",
    askType: "client_ask",
    concernScore: 2,
    askCategory: "reporting",
    lastReferencedAt: new Date("2026-04-20T00:00:00.000Z"), // >60d before DATE_STR → STALE
  },
  {
    askText: "We promised a revised GBP strategy deck",
    status: "open",
    askType: "internal_promise",
    concernScore: 1,
    askCategory: "strategy",
    lastReferencedAt: new Date("2026-08-10T00:00:00.000Z"),
  },
] as any[];

const COMMAND_PANEL = { quarterPrimaryObjective: "Dominate the local PI market this quarter." } as any;

const RIS_ENGAGEMENT = [
  { status: "fail", label: "Monthly strategy call", period: "2026-07", notes: "Client no-showed twice" },
] as any[];

const REPORT_DATA = {
  reportId: "r1",
  reportMonth: "2026-07",
  updatedAt: null,
  sections: { marketing: { totalLeads: 70 } },
} as any;

const REPORT_HISTORY = [
  { month: "2026-07", leads: 179, reviews: 6 },
  { month: "2026-06", leads: 195, reviews: null },
];

function corpus(): EvidenceCorpus {
  return buildEvidenceCorpus({
    client: CLIENT_IDENTITY,
    last24hComms: [FRUSTRATED_COMM, CANCEL_COMM, AI_SUMMARY_COMM, OUTBOUND_COMM],
    windowComms: [FRUSTRATED_COMM, CANCEL_COMM, AI_SUMMARY_COMM, OUTBOUND_COMM, comm(2, 30 * 24)],
    openAsks: OPEN_ASKS,
    reportData: REPORT_DATA,
    commandPanel: COMMAND_PANEL,
    risEngagement: RIS_ENGAGEMENT,
    recentIntel: INTEL_ROWS,
    reportHistory: REPORT_HISTORY,
    dateStr: DATE_STR,
    hasKnowledgeContext: false,
  });
}

function corpusFromInputs(options: {
  communications?: CommWithPerClientSummary[];
  reportData?: any;
  metricTracking?: { consults: "entered_before" | "never_entered"; cases: "entered_before" | "never_entered" };
} = {}): EvidenceCorpus {
  const communications = options.communications ?? [];
  return buildEvidenceCorpus({
    client: CLIENT_IDENTITY,
    last24hComms: communications,
    windowComms: communications,
    openAsks: [],
    reportData: options.reportData ?? null,
    commandPanel: null,
    risEngagement: [],
    recentIntel: [],
    reportHistory: [],
    dateStr: DATE_STR,
    hasKnowledgeContext: false,
    metricTracking: options.metricTracking,
  });
}

/** Scope-pinning helpers for unit-style corpora. */
/** Corpus with the given texts as ATOMIC client-authored fragments. */
function clientOnly(...texts: string[]): EvidenceCorpus {
  return fragmentCorpus("client_authored", ...texts);
}
function internalOnly(text: string): EvidenceCorpus {
  return fragmentCorpus("internal_context", text);
}
function fragmentCorpus(provenance: EvidenceProvenance, ...texts: string[]): EvidenceCorpus {
  return {
    fragments: texts.map((text, index): EvidenceFragment => ({
      id: `fixture:${provenance}:${index}`,
      text,
      provenance,
      sourceType: provenance === "client_authored" ? "front_email" : "fixture",
      sourceId: `source-${index}`,
      field: "content",
      occurredAt: `${DATE_STR}T12:00:00.000Z`,
      authorAttribution: provenance === "client_authored" ? "exact_client_contact" : "fixture",
    })),
  };
}

function evidenceOf(category: string, quote: string, against: EvidenceCorpus) {
  return validateEvidenceCitations(
    [{ category, quote, source: "test", date: DATE_STR }],
    against,
    {
      judgmentDate: DATE_STR,
      deliveryStability: "stable",
      deliveryStabilitySource: "entered_reports",
    },
  );
}

// ── 1. buildEvidenceCorpus — what citations are checked against ─────────────

console.log("\nbuildEvidenceCorpus:");

const CORPUS = corpus();

/** True when some ATOMIC client-authored fragment contains the text. */
function inClientScope(text: string): boolean {
  return CORPUS.fragments.some(f => f.provenance === "client_authored" && f.text.includes(text));
}

function inProvenance(provenance: EvidenceProvenance, text: string): boolean {
  return CORPUS.fragments.some(f => f.provenance === provenance && f.text.includes(text));
}

check("corpus renders every model-visible evidence section via the shared builders, scoped by provenance", () => {
  // Only attributable authored content — never its transport subject.
  assertEq(inClientScope("three weeks with no report"), true, "24h inbound comm content");
  assertEq(inClientScope("want to cancel the engagement at the end of the quarter"), true, "client cancel comm");
  assertEq(inClientScope("Corpus comm 1"), false, "subject is not client-authored");
  assertEq(inProvenance("communication_subject", "Corpus comm 1"), true, "subject remains auditable");
  assertEq(inProvenance("operator_intel", "want to cancel in a month"), true, "operator intel provenance");
  assertEq(inProvenance("open_ask", "Send the June reconciliation spreadsheet"), true, "open ask provenance");
  assertEq(inProvenance("internal_context", "Dominate the local PI market this quarter."), true, "panel provenance");
  assertEq(inProvenance("internal_operational", "Monthly strategy call"), true, "RIS provenance");
  assertEq(inProvenance("objective_report_metric", "70 total leads"), true, "latest report metric provenance");
  assertEq(inProvenance("objective_report_metric", "- 2026-07: leads 179, reviews 6"), true, "history provenance");
  assertEq(inClientScope("intends to cancel the contract at renewal"), false, "AI summary not in client scope");
  assertEq(inClientScope("should be wound down before the renewal date"), false, "outbound content not in client scope");
  assertEq(inClientScope("want to cancel in a month"), false, "intel not in client scope");
  const direct = evidenceOf(
    "expressed_dissatisfaction",
    "We are honestly frustrated - three weeks with no report",
    CORPUS,
  );
  assertEq(direct.items[0]?.sourceScope, "client_communication", "client scope");
  assertEq(direct.items[0]?.provenance, "client_authored", "atomic provenance recorded");
  assertEq(direct.items[0]?.matchedFragment?.sourceId, "c1", "source record recorded");
});

check("cross-fragment concatenation quotes reject — client matching is atomic per rendered field", () => {
  const scoped = clientOnly(
    "We are cancelling after this last report",
    "and ending the engagement before renewal",
  );
  const synthetic = "after this last report and ending the engagement";
  const joined = normalizeForCitationMatch(scoped.fragments.map(f => f.text).join(" "));
  assertEq(joined.includes(normalizeForCitationMatch(synthetic)), true, "joined corpus would false-positive");
  const res = evidenceOf("explicit_churn_language", synthetic, scoped);
  assertEq(res.items[0]?.valid, false, "stitched quote rejected");
  assertEq(res.items[0]?.rejectReason, "not_found_in_inputs", "counts as absent evidence");
});

check("subjects and compact/digest rows never become client-authored evidence", () => {
  const longTitle =
    "URGENT: we want to cancel the engagement because July reporting is still missing";
  const recent = Array.from({ length: 10 }, (_, k) => comm(60 + k, 3));
  recent.push(comm(75, 4, { title: longTitle }));
  const direct = extractClientAuthoredCommContent(recent, recent, true, CLIENT_IDENTITY);
  assertEq(direct.some(text => text.includes("want to cancel")), false, "digest subject excluded");
  const compact = extractClientAuthoredCommContent(
    [],
    [comm(76, 20 * 24, { title: longTitle, contentPreview: CLIENT_CANCEL_QUOTE })],
    true,
    CLIENT_IDENTITY,
  );
  assertEq(compact.length, 0, "compact row has no model-visible authored content");
});

check("corpus structurally excludes prior-judgment content — old AI output cannot launder into evidence", () => {
  // This sentence exists ONLY in a (simulated) prior judgment, which
  // buildEvidenceCorpus deliberately takes no parameter for.
  const priorJudgmentClaim = "the client has effectively churned per the AM";
  const res = evidenceOf("explicit_churn_language", priorJudgmentClaim, CORPUS);
  assertEq(res.validCount, 0, "prior-judgment quote must not validate");
  assertEq(res.items[0]?.rejectReason, "not_found_in_inputs", "reject reason");
});

check("open-asks section carries staleness + internal-promise markers and the hard rules", () => {
  const text = buildOpenAsksSection(OPEN_ASKS, DATE_STR).join("\n");
  assertIncludes(text, "[open | STALE] Send the June reconciliation spreadsheet", "stale marker");
  assertIncludes(text, "Last referenced: 2026-04-20", "last-referenced date");
  assertIncludes(text, "[open | internal promise] We promised a revised GBP strategy deck", "internal-promise marker");
  assertIncludes(text, `no reference in ${STALE_ASK_THRESHOLD_DAYS}+ days`, "stale rule");
  assertIncludes(text, "commitments WE made", "internal-promise rule");
  assertIncludes(text, "requires the CLIENT re-referencing the ask", "repeated-ask rule");
});

// ── 2. validateEvidenceCitations ────────────────────────────────────────────

console.log("\nvalidateEvidenceCitations:");

check("verbatim quote from the corpus validates", () => {
  const res = evidenceOf(
    "expressed_dissatisfaction",
    "We are honestly frustrated - three weeks with no report",
    CORPUS,
  );
  assertEq(res.validCount, 1, "validCount");
  assertEq(res.items[0]?.valid, true, "valid flag");
});

check("curly quotes / dashes / collapsed whitespace still match (normalization)", () => {
  // Corpus has ASCII "we're being courted by LawRank"; the model copies it
  // back with a curly apostrophe and doubled spaces.
  const res = evidenceOf("competitor_switch", "we\u2019re  being courted by LawRank", CORPUS);
  assertEq(res.validCount, 1, "normalized match");
  assertEq(normalizeForCitationMatch("\u201Cdon\u2019t\u201D \u2014 stop\u2026"), '"don\'t" - stop...', "normalize output");
});

check("fabricated quote is rejected as not_found_in_inputs", () => {
  const res = evidenceOf("billing_or_legal_escalation", "the client threatened legal action yesterday", CORPUS);
  assertEq(res.validCount, 0, "validCount");
  assertEq(res.items[0]?.rejectReason, "not_found_in_inputs", "reject reason");
});

check("unknown category and missing quote are rejected without throwing", () => {
  const res = validateEvidenceCitations(
    [
      { category: "vibes_based_doom", quote: "three weeks with no report" },
      { category: "internal_hygiene_gap", quote: "" },
      null,
    ],
    CORPUS,
  );
  assertEq(res.items[0]?.rejectReason, "invalid_category", "invalid category");
  assertEq(res.items[1]?.rejectReason, "missing_quote", "missing quote");
  assertEq(res.items[2]?.rejectReason, "invalid_category", "null entry treated as malformed");
  assertEq(res.validCount, 0, "nothing validates");
  assertEq(isKnownEvidenceCategory("vibes_based_doom"), false, "category vocabulary is closed");
});

check("Critical-qualifying categories need a longer verbatim run than soft categories", () => {
  // "courted by LawRank" (18 chars, 3 words) — enough for an At-Risk-tier
  // category, but 2 words would not be:
  const soft = evidenceOf("expressed_dissatisfaction", "courted by LawRank", CORPUS);
  assertEq(soft.validCount, 1, "soft category accepts 3-word quote");
  const twoWords = evidenceOf("expressed_dissatisfaction", "by LawRank", CORPUS);
  assertEq(twoWords.items[0]?.rejectReason, "quote_too_short", "10-char quote too short");
  // Same corpus substring under a CRITICAL category with < 3 words: rejected.
  const critShort = evidenceOf("explicit_churn_language", "cancel in a", CORPUS);
  assertEq(critShort.items[0]?.rejectReason, "quote_too_short", "critical quote too short");
  const critReal = evidenceOf("explicit_churn_language", CLIENT_CANCEL_QUOTE, CORPUS);
  assertEq(critReal.validCount, 1, "substantial critical quote validates");
  assertEq(critReal.items[0]?.sourceScope, "client_communication", "client-comm scope recorded");
});

// ── 2b. Provenance scoping + deterministic reclassification ─────────────────
//
// The reviewer-identified loophole: quote-exists-in-corpus alone let a
// Command Panel note like "effectively churned" validate under
// explicit_churn_language and unlock Critical — the model still owned the
// semantic boundary. These pin the deterministic corrections that close it.

console.log("\nprovenance scoping + reclassification:");

check("agency write-off language is forcibly hygiene — even under a Critical category label", () => {
  // Verbatim intel-row text (the exact prod failure mode): model labels it
  // explicit_churn_language, quote DOES exist in the inputs.
  const res = evidenceOf(
    "explicit_churn_language",
    "this client has effectively churned and we should offboard after Q3",
    CORPUS,
  );
  assertEq(res.items[0]?.valid, true, "quote itself validates");
  assertEq(res.items[0]?.sourceScope, "internal_context", "internal provenance recorded");
  assertEq(res.items[0]?.effectiveCategory, "internal_hygiene_gap", "forced to hygiene");
  assertEq(res.items[0]?.reclassifiedFrom, "explicit_churn_language", "model's claim preserved");
  assertEq(res.items[0]?.reclassReason, "agency_writeoff_language", "reason recorded");
  assertEq(res.reclassifiedCount, 1, "reclassified count");
  // Gate consequence: proposed Critical/96 lands at Watch, with the
  // reclassification surfaced as a cap reason.
  const d = applyJudgmentTierGate(gateInput({ evidence: res.items }));
  assertEq(d.finalStatus, "Watch", "write-off note cannot unlock Critical");
  assertEq(d.capReasons.includes("hygiene_only_evidence"), true, "hygiene-only cap");
  assertEq(d.capReasons.includes("critical_claims_reclassified"), true, "reclass surfaced");
});

check("write-off vocabulary is hygiene even when it appears in the CLIENT scope", () => {
  const res = evidenceOf(
    "explicit_churn_language",
    "honestly we should offboard this account",
    clientOnly("AM recap forwarded by the client: honestly we should offboard this account."),
  );
  assertEq(res.items[0]?.valid, true, "quote validates");
  assertEq(res.items[0]?.sourceScope, "client_communication", "client scope");
  assertEq(res.items[0]?.effectiveCategory, "internal_hygiene_gap", "denylist beats scope");
  assertEq(res.items[0]?.reclassReason, "agency_writeoff_language", "reason recorded");
  assertEq(containsAgencyWriteoffLanguage("we should offboard this account"), true, "denylist helper");
  assertEq(AGENCY_WRITEOFF_PHRASES.includes("effectively churned"), true, "prod phrase pinned");
});

check("operator-relayed explicit churn is process context, never client dissatisfaction or Critical", () => {
  const res = evidenceOf(
    "explicit_churn_language",
    "want to cancel in a month if leads don't recover",
    CORPUS,
  );
  assertEq(res.items[0]?.valid, true, "quote validates");
  assertEq(res.items[0]?.sourceScope, "internal_context", "internal provenance");
  assertEq(res.items[0]?.provenance, "operator_intel", "precise provenance");
  assertEq(res.items[0]?.effectiveCategory, "internal_hygiene_gap", "reclassified as process context");
  assertEq(res.items[0]?.reclassReason, "critical_requires_direct_client_language", "reason recorded");
  const d = applyJudgmentTierGate(gateInput({ evidence: res.items }));
  assertEq(d.finalStatus, "Watch", "Watch, not client-risk evidence");
  assertEq(d.capReasons.includes("hygiene_only_evidence"), true, "hygiene cap reason");
  assertEq(d.capReasons.includes("critical_claims_reclassified"), true, "reclass surfaced");
});

check("the same cancel language FROM THE CLIENT's own communications still unlocks Critical", () => {
  const res = evidenceOf("explicit_churn_language", CLIENT_CANCEL_QUOTE, CORPUS);
  assertEq(res.items[0]?.effectiveCategory, "explicit_churn_language", "no reclassification");
  assertEq(res.items[0]?.reclassifiedFrom, undefined, "no reclass marker");
  const d = applyJudgmentTierGate(gateInput({ proposedOverallRisk: 85, evidence: res.items }));
  assertEq(d.finalStatus, "Critical", "client-sourced churn language unlocks Critical");
});

check("corroborated_loss_signal needs two DISTINCT client citations — lone or duplicated signals downgrade", () => {
  const lossCorpus = clientOnly(
    "Please hand over GBP access to our new vendor contact this week.",
    "Separately, please package all creative assets for transfer to our new vendor.",
  );
  const single = validateEvidenceCitations(
    [{ category: "corroborated_loss_signal", quote: "hand over GBP access to our new vendor contact" }],
    lossCorpus,
  );
  assertEq(single.items[0]?.valid, true, "single signal validates");
  assertEq(single.items[0]?.effectiveCategory, "expressed_dissatisfaction", "lone signal downgraded");
  assertEq(single.items[0]?.reclassReason, "uncorroborated_independent_signals", "reason recorded");
  assertEq(applyJudgmentTierGate(gateInput({ evidence: single.items })).finalStatus, "At Risk", "At Risk cap");

  const duplicated = validateEvidenceCitations(
    [
      { category: "corroborated_loss_signal", quote: "hand over GBP access to our new vendor contact" },
      { category: "corroborated_loss_signal", quote: "hand over  GBP access to our new vendor contact" },
    ],
    lossCorpus,
  );
  assertEq(
    duplicated.items.every(i => i.effectiveCategory === "expressed_dissatisfaction"),
    true,
    "duplicated quote is still ONE signal",
  );

  const corroborated = validateEvidenceCitations(
    [
      { category: "corroborated_loss_signal", quote: "hand over GBP access to our new vendor contact" },
      { category: "corroborated_loss_signal", quote: "package all creative assets for transfer to our new vendor" },
    ],
    lossCorpus,
  );
  assertEq(
    corroborated.items.every(i => i.effectiveCategory === "corroborated_loss_signal"),
    true,
    "two distinct citations corroborate",
  );
  assertEq(corroborated.reclassifiedCount, 0, "no downgrade");
  assertEq(applyJudgmentTierGate(gateInput({ evidence: corroborated.items })).finalStatus, "Critical", "Critical allowed");
});

check("routine departing-employee access removals cannot corroborate client loss", () => {
  const result = validateEvidenceCitations(
    [
      {
        category: "corroborated_loss_signal",
        quote: "remove Sarah's access to the reporting portal",
      },
      {
        category: "corroborated_loss_signal",
        quote: "remove Adam's access to the billing portal",
      },
    ],
    clientOnly(
      "Please remove Sarah's access to the reporting portal; she left the firm.",
      "Please remove Adam's access to the billing portal; he left the firm.",
    ),
  );
  assertEq(
    result.items.every(item =>
      item.effectiveCategory === "other_negative" &&
      item.reclassReason === "category_semantics_not_met"
    ),
    true,
    "routine user administration is not a loss signal",
  );
  assertEq(
    applyJudgmentTierGate(gateInput({ evidence: result.items })).finalStatus,
    "Watch",
    "routine access removal cannot unlock Critical",
  );
});

check("duplicate Front rollup/message representations count as one loss signal", () => {
  const timestamp = new Date(`${DATE_STR}T20:00:00.000Z`);
  const commonPrefix =
    "Please hand over GBP access to our new agency. " +
    "Context for the transition ".repeat(6);
  const firstRepresentation = comm(81, 3, {
    timestamp,
    sourceSubtype: "email_thread",
    contentPreview:
      `[${timestamp.toISOString()}] client@acmelegal.com:\n${commonPrefix}`,
  });
  const materializedMessage = comm(82, 3, {
    timestamp,
    contentPreview:
      `${commonPrefix}Please package all creative assets for transfer to the new agency.`,
  });
  const duplicateCorpus = corpusFromInputs({
    communications: [firstRepresentation, materializedMessage],
  });
  const authoredFragments = duplicateCorpus.fragments.filter(
    fragment => fragment.provenance === "client_authored",
  );
  assertEq(authoredFragments[0]?.id === authoredFragments[1]?.id, false, "different stored rows");
  assertEq(
    authoredFragments[0]?.independenceKey,
    authoredFragments[1]?.independenceKey,
    "same underlying authored-message identity",
  );
  const res = validateEvidenceCitations(
    [
      { category: "corroborated_loss_signal", quote: "hand over GBP access to our new agency" },
      { category: "corroborated_loss_signal", quote: "package all creative assets for transfer to the new agency" },
    ],
    duplicateCorpus,
  );
  assertEq(res.validCount, 1, "duplicate representations collapse to one accepted item");
  assertEq(
    res.items.every(item => item.effectiveCategory === "expressed_dissatisfaction"),
    true,
    "duplicate materialization cannot corroborate itself",
  );
});

check("negated churn/escalation language and routine asset requests cannot unlock Critical", () => {
  const cases = [
    {
      category: "explicit_churn_language",
      text: "We do not want to cancel the engagement; we want to keep working together.",
      quote: "want to cancel the engagement",
    },
    {
      category: "explicit_churn_language",
      text: "We will not cancel the engagement because the partnership is working.",
      quote: "will not cancel the engagement",
    },
    {
      category: "explicit_churn_language",
      text: "We aren't cancelling our retainer this year.",
      quote: "aren't cancelling our retainer this year",
    },
    {
      category: "explicit_churn_language",
      text: "We decided not to cancel the engagement after reviewing the results.",
      quote: "decided not to cancel the engagement",
    },
    {
      category: "explicit_churn_language",
      text: "Please cancel our Calendly appointment tomorrow so we can reschedule.",
      quote: "cancel our Calendly appointment tomorrow",
    },
    {
      category: "explicit_churn_language",
      text: "Please cancel the summer campaign after Friday.",
      quote: "cancel the summer campaign after Friday",
    },
    {
      category: "competitor_switch",
      text: "We are not going to switch to another agency this quarter.",
      quote: "switch to another agency this quarter",
    },
    {
      category: "competitor_switch",
      text: "We aren't switching to another agency; we are staying with you.",
      quote: "aren't switching to another agency",
    },
    {
      category: "competitor_switch",
      text: "We decided not to switch to another agency after the strategy review.",
      quote: "decided not to switch to another agency",
    },
    {
      category: "competitor_switch",
      text: "We are being courted by the Chamber of Commerce to sponsor its conference.",
      quote: "being courted by the Chamber of Commerce",
    },
    {
      category: "billing_or_legal_escalation",
      text: "We do not plan to request a refund or take legal action.",
      quote: "request a refund or take legal action",
    },
    {
      category: "billing_or_legal_escalation",
      text: "We aren't requesting a refund because the invoice was corrected.",
      quote: "aren't requesting a refund",
    },
    {
      category: "corroborated_loss_signal",
      text: "Please send the creative assets for our routine monthly review.",
      quote: "send the creative assets for our routine monthly review",
    },
    {
      category: "corroborated_loss_signal",
      text: "We aren't transferring access to a new provider; your team keeps access.",
      quote: "aren't transferring access to a new provider",
    },
  ];
  for (const [index, testCase] of cases.entries()) {
    const result = evidenceOf(
      testCase.category,
      testCase.quote,
      clientOnly(testCase.text),
    );
    assertEq(result.items[0]?.valid, true, `case ${index} quote validates`);
    assertEq(result.items[0]?.effectiveCategory, "other_negative", `case ${index} is soft-only`);
    assertEq(result.items[0]?.reclassReason, "category_semantics_not_met", `case ${index} reason`);
    assertEq(
      applyJudgmentTierGate(gateInput({ proposedOverallRisk: 95, evidence: result.items })).finalStatus,
      "Watch",
      `case ${index} cannot unlock Critical`,
    );
  }
});

check("AI-generated summary text can NEVER unlock dissatisfaction or Critical", () => {
  const res = evidenceOf("explicit_churn_language", AI_SUMMARY_QUOTE, CORPUS);
  assertEq(res.items[0]?.valid, true, "quote validates");
  assertEq(res.items[0]?.sourceScope, "internal_context", "AI summary is internal scope");
  assertEq(res.items[0]?.provenance, "ai_generated", "generated provenance");
  assertEq(res.items[0]?.effectiveCategory, "other_negative", "not client dissatisfaction");
  assertEq(res.items[0]?.reclassReason, "critical_requires_direct_client_language", "reason recorded");
  const d = applyJudgmentTierGate(gateInput({ evidence: res.items }));
  assertEq(d.finalStatus, "Watch", "Watch cap — prior AI output cannot become client-risk evidence");
});

check("generated Zoom signals stay Watch and explanations call them internal interpretation, not client evidence", () => {
  const zoomCorpus = corpusFromInputs({ communications: [GENERATED_ZOOM_COMM] });
  const validation = evidenceOf(
    "explicit_churn_language",
    GENERATED_ZOOM_SIGNAL_QUOTE,
    zoomCorpus,
  );
  assertEq(validation.items[0]?.valid, true, "generated Zoom signal remains auditable");
  assertEq(validation.items[0]?.provenance, "ai_generated", "generated provenance");
  assertEq(validation.items[0]?.effectiveCategory, "other_negative", "not direct client risk");

  const input = gateInput({
    proposedStatus: "Critical",
    proposedOverallRisk: 99,
    evidence: validation.items,
    deliveryStability: "stable",
    deliveryStabilitySource: "entered_reports",
  });
  const decision = applyJudgmentTierGate(input);
  assertEq(decision.finalStatus, "Watch", "generated Zoom signal has a hard Watch ceiling");
  assertEq(decision.finalRelationshipStatus, "Stable", "generated signal cannot imply relationship strain");

  const audit = buildTierGateAudit(input, decision, validation);
  const rating = toAccountRatingPresentation({
    status: decision.finalStatus,
    relationship: decision.finalRelationshipStatus,
    riskScore: decision.finalOverallRisk,
    judgmentDate: DATE_STR,
    dataSourcesSummary: {
      tier: "full",
      promptRevision: "5228.1",
      generatedAt: `${DATE_STR}T23:00:00.000Z`,
      tierGate: audit,
    },
  });
  assertEq(rating?.primaryDrivers[0]?.provenance, "internal", "driver is visibly internal");
  assertEq(
    rating?.primaryDrivers[0]?.sourceLabel,
    "Internal AI interpretation — not direct client evidence",
    "driver wording discloses the source limitation",
  );

  const narrative = discloseInternalInterpretationInNarrative(
    "The account may be preparing to switch agencies.",
    validation.items,
  );
  assertIncludes(narrative, "Internal interpretation note:", "narrative disclosure");
  assertIncludes(narrative, "not direct client evidence", "narrative rejects client attribution");
  assertIncludes(narrative, "cannot independently justify At Risk or Critical", "narrative names tier limit");

  const promptSection = buildJudgmentCommSections(
    [GENERATED_ZOOM_COMM],
    [GENERATED_ZOOM_COMM],
    false,
  ).join("\n");
  assertIncludes(
    promptSection,
    "Internal AI interpretation — not direct client evidence — Key Signals:",
    "prompt labels generated Zoom signals before the model explains them",
  );
});

check("unknown-provenance communication evidence is internal interpretation with a Watch ceiling", () => {
  const unknownCorpus = fragmentCorpus(
    "unknown",
    "The client may be dissatisfied with recent progress and could reconsider the engagement.",
  );
  const validation = evidenceOf(
    "expressed_dissatisfaction",
    "client may be dissatisfied with recent progress",
    unknownCorpus,
  );
  const input = gateInput({
    evidence: validation.items,
    deliveryStability: "stable",
    deliveryStabilitySource: "entered_reports",
  });
  const decision = applyJudgmentTierGate(input);
  assertEq(decision.finalStatus, "Watch", "unknown provenance cannot justify At Risk");
  const rating = toAccountRatingPresentation({
    status: decision.finalStatus,
    relationship: decision.finalRelationshipStatus,
    riskScore: decision.finalOverallRisk,
    judgmentDate: DATE_STR,
    dataSourcesSummary: {
      tier: "full",
      promptRevision: "5228.1",
      generatedAt: `${DATE_STR}T23:00:00.000Z`,
      tierGate: buildTierGateAudit(input, decision, validation),
    },
  });
  assertEq(rating?.primaryDrivers[0]?.provenance, "internal", "unknown source is visibly internal");
  assertEq(
    rating?.primaryDrivers[0]?.sourceLabel,
    "Internal interpretation with unknown provenance — not direct client evidence",
    "unknown provenance wording is explicit",
  );
});

check("OUR outbound message with wind-down language can NEVER unlock Critical (no denylist needed)", () => {
  // Agency-authored text that does NOT match the write-off denylist —
  // outbound provenance alone keeps it out of the client scope.
  const res = evidenceOf("explicit_churn_language", OUTBOUND_QUOTE, CORPUS);
  assertEq(res.items[0]?.valid, true, "quote validates");
  assertEq(res.items[0]?.sourceScope, "internal_context", "outbound is internal scope");
  assertEq(res.items[0]?.effectiveCategory, "other_negative", "downgraded to soft context");
  const d = applyJudgmentTierGate(gateInput({ proposedOverallRisk: 90, evidence: res.items }));
  assertEq(d.finalStatus, "Watch", "Watch cap");
  assertEq(d.finalOverallRisk, 29, "risk derived inside Watch from accepted drivers");
});

check("internal-sourced corroborated_loss_signal cannot corroborate — provenance rule fires first", () => {
  const res = validateEvidenceCitations(
    [
      { category: "corroborated_loss_signal", quote: "Send the June reconciliation spreadsheet" },
      { category: "corroborated_loss_signal", quote: "Client no-showed twice" },
    ],
    CORPUS,
  );
  for (const item of res.items) {
    assertEq(item.valid, true, "quotes validate");
    assertEq(item.sourceScope, "internal_context", "internal provenance");
    assertEq(
      item.effectiveCategory === "internal_hygiene_gap" || item.effectiveCategory === "other_negative",
      true,
      "downgraded before corroboration counting",
    );
  }
  assertEq(applyJudgmentTierGate(gateInput({ evidence: res.items })).finalStatus, "Watch", "never client-risk");
});

check("forwarded search alerts and automated mail cannot masquerade as client service-failure evidence", () => {
  const forwarded = comm(90, 2, {
    title: "Fwd: Search visibility alert",
    contentPreview:
      "FYI\n\nBegin forwarded message:\nSearch alert: the campaign is still not delivering the promised visibility.",
  });
  const automated = comm(91, 3, {
    participantsJson: [{ email: "notifications@search-monitor.example", role: "author" }],
    contentPreview:
      "Automated search alert: the campaign is still not delivering the promised visibility.",
  });
  const evidenceCorpus = corpusFromInputs({ communications: [forwarded, automated] });
  const forwardedResult = evidenceOf(
    "service_failure",
    "campaign is still not delivering the promised visibility",
    evidenceCorpus,
  );
  assertEq(forwardedResult.items[0]?.provenance, "client_forwarded", "forwarded provenance");
  assertEq(forwardedResult.items[0]?.effectiveCategory, "other_negative", "not service-failure evidence");
  assertEq(
    forwardedResult.items[0]?.reclassReason,
    "client_risk_requires_direct_client_language",
    "forward rejection reason",
  );

  const automatedResult = evidenceOf(
    "service_failure",
    "campaign is still not delivering the promised visibility",
    {
      fragments: evidenceCorpus.fragments.filter(fragment => fragment.sourceId === "c91"),
    },
  );
  assertEq(automatedResult.items[0]?.provenance, "automated", "automated provenance");
  assertEq(automatedResult.items[0]?.effectiveCategory, "other_negative", "automation cannot unlock service failure");

  const conventionalForward = comm(95, 2, {
    title: "Re: Search visibility question",
    contentPreview:
      "FYI\n\n---------- Forwarded message ---------\n" +
      "From: alerts@search-monitor.example\n" +
      "Date: Thu, 14 Aug 2026 10:00:00 +0000\n" +
      "Subject: Search visibility alert\n\n" +
      "The campaign is still not delivering the promised visibility.",
  });
  const conventionalResult = evidenceOf(
    "service_failure",
    "campaign is still not delivering the promised visibility",
    corpusFromInputs({ communications: [conventionalForward] }),
  );
  assertEq(conventionalResult.items[0]?.provenance, "client_forwarded", "dashed wrapper provenance");
  assertEq(conventionalResult.items[0]?.effectiveCategory, "other_negative", "RE subject does not bypass forwarding");
});

check("Outlook Original Email blocks stay forwarded when To/Cc headers precede Sent", () => {
  const outlookForward = comm(94, 2, {
    title: "Re: Campaign update",
    contentPreview:
      "FYI for context.\n\n" +
      "-----Original Email-----\n" +
      "From: vendor@example.net\n" +
      "To: client@acmelegal.com\n" +
      "Cc: finance@acmelegal.com\n" +
      "Sent: Thursday, August 20, 2026 9:15 AM\n" +
      "Subject: Contract notice\n\n" +
      "We will cancel the engagement at the end of this month.",
  });
  const result = evidenceOf(
    "explicit_churn_language",
    "will cancel the engagement at the end of this month",
    corpusFromInputs({ communications: [outlookForward] }),
  );
  assertEq(result.items[0]?.valid, true, "forwarded quote remains auditable");
  assertEq(result.items[0]?.provenance, "client_forwarded", "Outlook block is forwarded");
  assertEq(result.items[0]?.effectiveCategory, "other_negative", "forwarded third-party language is soft");
  assertEq(
    applyJudgmentTierGate(gateInput({ evidence: result.items })).finalStatus,
    "Watch",
    "forwarded Critical language cannot lift Watch",
  );
});

check("a single Calendly-hours question is not a repeated unresolved ask", () => {
  const question = comm(92, 1, {
    contentPreview: "What hours are available on the Calendly link for next Tuesday?",
  });
  const res = evidenceOf(
    "repeated_unresolved_ask",
    "What hours are available on the Calendly link for next Tuesday",
    corpusFromInputs({ communications: [question] }),
  );
  assertEq(res.items[0]?.provenance, "client_authored", "real client words");
  assertEq(res.items[0]?.effectiveCategory, "other_negative", "one-off question not repeated ask");
  assertEq(res.items[0]?.reclassReason, "repeated_ask_not_repeated", "precise reason");
  assertEq(applyJudgmentTierGate(gateInput({ evidence: res.items })).finalStatus, "Watch", "cannot unlock At Risk");
});

check("an unrelated repeat marker elsewhere in the message cannot relabel a one-off ask", () => {
  const question = comm(96, 1, {
    contentPreview:
      "The weather changed again today. What hours are available on the Calendly link for next Tuesday?",
  });
  const res = evidenceOf(
    "repeated_unresolved_ask",
    "What hours are available on the Calendly link for next Tuesday",
    corpusFromInputs({ communications: [question] }),
  );
  assertEq(res.items[0]?.effectiveCategory, "other_negative", "marker must be in the cited reference");
  assertEq(res.items[0]?.reclassReason, "repeated_ask_not_repeated", "precise reason");
});

check("a recent explicit client follow-up can qualify as a repeated unresolved ask", () => {
  const followUp = comm(93, 1, {
    contentPreview: "Following up again: can you send the July reporting spreadsheet we asked for last week?",
  });
  const res = evidenceOf(
    "repeated_unresolved_ask",
    "Following up again: can you send the July reporting spreadsheet",
    corpusFromInputs({ communications: [followUp] }),
  );
  assertEq(res.items[0]?.effectiveCategory, "repeated_unresolved_ask", "eligible repeated ask");
  assertEq(res.items[0]?.reclassReason, undefined, "no reclassification");
});

check("third-party review text cannot become client dissatisfaction", () => {
  const review = comm(94, 2, {
    participantsJson: [{ email: "reviewer@community.example", role: "author" }],
    contentPreview: "Third-party review: I am unhappy with the firm's legal service and response time.",
  });
  const res = evidenceOf(
    "expressed_dissatisfaction",
    "I am unhappy with the firm's legal service and response time",
    corpusFromInputs({ communications: [review] }),
  );
  assertEq(res.items[0]?.provenance, "third_party", "third-party provenance");
  assertEq(res.items[0]?.effectiveCategory, "other_negative", "not client dissatisfaction");
  assertEq(res.items[0]?.reclassReason, "client_risk_requires_direct_client_language", "precise reason");
});

check("untracked report metrics reject rather than masquerade as delivery decline", () => {
  const evidenceCorpus = corpusFromInputs({
    reportData: { reportId: "untracked-report", reportMonth: "2026-07", sections: {} },
    metricTracking: { consults: "never_entered", cases: "never_entered" },
  });
  const res = evidenceOf(
    "delivery_metric_decline",
    "not tracked for this client (never entered in any report month)",
    evidenceCorpus,
  );
  assertEq(res.items[0]?.valid, false, "untracked metric rejected");
  assertEq(res.items[0]?.rejectReason, "untracked_metric", "precise rejection reason");
  assertEq(res.items[0]?.matchedFragment?.metricState, "untracked", "metric state audited");
});

check("delivery decline requires tracked report facts and the server's measured decline verdict", () => {
  const measured: EvidenceCorpus = {
    fragments: [{
      id: "report:2026-07:leads",
      text: "- 2026-07: leads 40, reviews 5",
      provenance: "objective_report_metric",
      sourceType: "report_history",
      sourceId: "2026-07",
      field: "metric_line",
      metricState: "tracked",
    }],
  };
  const raw = [{
    category: "delivery_metric_decline",
    quote: "2026-07: leads 40, reviews 5",
  }];
  const declining = validateEvidenceCitations(raw, measured, {
    judgmentDate: DATE_STR,
    deliveryStability: "declining",
    deliveryStabilitySource: "entered_reports",
  });
  assertEq(declining.items[0]?.effectiveCategory, "delivery_metric_decline", "measured decline accepted");
  const stable = validateEvidenceCitations(raw, measured, {
    judgmentDate: DATE_STR,
    deliveryStability: "stable",
    deliveryStabilitySource: "entered_reports",
  });
  assertEq(stable.items[0]?.effectiveCategory, "other_negative", "stable facts cannot be labeled decline");
  assertEq(stable.items[0]?.reclassReason, "delivery_decline_not_measured", "server verdict reason");
});

check("internal delivery commentary cannot become client-authored service failure", () => {
  const res = evidenceOf(
    "service_failure",
    "Internal note: the July report is still not delivered",
    fragmentCorpus("internal_staff", "Internal note: the July report is still not delivered to the client."),
  );
  assertEq(res.items[0]?.effectiveCategory, "other_negative", "not service failure");
  assertEq(res.items[0]?.reclassReason, "client_risk_requires_direct_client_language", "precise reason");
});

check("genuine direct client churn language remains eligible", () => {
  const res = evidenceOf("explicit_churn_language", CLIENT_CANCEL_QUOTE, CORPUS);
  assertEq(res.items[0]?.provenance, "client_authored", "direct client provenance");
  assertEq(res.items[0]?.effectiveCategory, "explicit_churn_language", "category preserved");
  assertEq(applyJudgmentTierGate(gateInput({ evidence: res.items })).finalStatus, "Critical", "Critical control");
});

check("evidence list is capped and audit stores no quoted communication body", () => {
  const fillers = Array.from(
    { length: MAX_EVIDENCE_ITEMS + 5 },
    (_, index) => `Steady lead flow evidence item ${index} with weekly reporting cadence.`,
  );
  const fillerCorpus = fragmentCorpus("internal_context", ...fillers);
  const many = fillers.map(filler => ({
    category: "internal_hygiene_gap",
    quote: filler,
  }));
  const res = validateEvidenceCitations(many, fillerCorpus);
  assertEq(res.items.length, MAX_EVIDENCE_ITEMS, "capped");
  assertEq(res.items[0]?.valid, true, "validation ran on the FULL quote");
  assertEq(res.items[0]?.quote, "[citation redacted]", "raw quote redacted");
  assertEq(res.items[0]?.quoteFingerprint?.length, 20, "bounded correlation fingerprint");
  assertEq(res.items[0]?.quoteLength, fillers[0].length, "citation length remains auditable");
  assertEq(res.items[0]?.quote.includes("steady lead flow"), false, "body text not persisted");
});

check("non-array churnEvidence yields zero items (defensive on model JSON)", () => {
  const res = validateEvidenceCitations({ not: "an array" }, CORPUS);
  assertEq(res.items.length, 0, "no items");
  assertEq(res.validCount, 0, "no valid");
});

// ── 3. isBaselineSilenceExceeded ────────────────────────────────────────────

console.log("\nisBaselineSilenceExceeded:");

check("silence is judged against the client's OWN longest historical gap", () => {
  // Pinned from prod client basis (2026-08-14): longest lifetime gap 54d.
  assertEq(
    isBaselineSilenceExceeded({ silenceDays: 60, businessDaySilence: 40, longestGapDays: 54 }),
    true,
    "60d > 54d baseline",
  );
  assertEq(
    isBaselineSilenceExceeded({ silenceDays: 40, businessDaySilence: 28, longestGapDays: 54 }),
    false,
    "40d within 54d baseline",
  );
});

check("weekly cadence floor is stable even when a client's historical gaps are shorter", () => {
  assertEq(
    isBaselineSilenceExceeded({
      silenceDays: 3,
      businessDaySilence: 3,
      longestGapDays: 2,
      averageGapDays: 2,
      rolling30dCount: 42,
    }),
    false,
    "today's communication-rich account is not called silent",
  );
  assertEq(
    isBaselineSilenceExceeded({
      silenceDays: 7,
      businessDaySilence: 5,
      longestGapDays: 2,
      averageGapDays: 2,
      rolling30dCount: 42,
    }),
    false,
    "once per week is acceptable",
  );
  assertEq(
    isBaselineSilenceExceeded({
      silenceDays: 8,
      businessDaySilence: 6,
      longestGapDays: 2,
      averageGapDays: 2,
      rolling30dCount: 42,
    }),
    false,
    "the rolling 30d volume still exceeds the weekly standard",
  );
  assertEq(
    isBaselineSilenceExceeded({
      silenceDays: 8,
      businessDaySilence: 6,
      longestGapDays: 2,
      averageGapDays: 2,
      rolling30dCount: 3,
    }),
    true,
    "below-standard rolling volume plus an overdue current gap is a cadence failure",
  );
});

check("a slower client's observed average cadence is respected above the weekly floor", () => {
  assertEq(
    isBaselineSilenceExceeded({
      silenceDays: 10,
      businessDaySilence: 7,
      longestGapDays: 14,
      averageGapDays: 14,
      rolling30dCount: 2,
    }),
    false,
    "10d is within this client's normal 14d cadence",
  );
  assertEq(
    isBaselineSilenceExceeded({
      silenceDays: 15,
      businessDaySilence: 10,
      longestGapDays: 14,
      averageGapDays: 14,
      rolling30dCount: 1,
    }),
    true,
    "15d exceeds the observed 14d cadence",
  );
});

check("≤3 business days is never a silence signal; null baseline uses the weekly standard", () => {
  assertEq(
    isBaselineSilenceExceeded({ silenceDays: 10, businessDaySilence: 3, longestGapDays: 2 }),
    false,
    "3 business days",
  );
  assertEq(
    isBaselineSilenceExceeded({ silenceDays: 8, businessDaySilence: 6, longestGapDays: null }),
    true,
    "8d exceeds the weekly fallback",
  );
  assertEq(
    isBaselineSilenceExceeded({ silenceDays: 7, businessDaySilence: 5, longestGapDays: 0 }),
    false,
    "7d meets the weekly standard",
  );
});

check("no-comms client (null silence) has no cadence baseline to breach", () => {
  assertEq(
    isBaselineSilenceExceeded({ silenceDays: null, businessDaySilence: null, longestGapDays: 54 }),
    false,
    "null silence",
  );
  assertEq(
    isBaselineSilenceExceeded({ silenceDays: 60, businessDaySilence: null, longestGapDays: 54 }),
    true,
    "null business-day count does not mask a real 60d gap",
  );
});

// ── 4. assessDeliveryStability ──────────────────────────────────────────────

console.log("\nassessDeliveryStability:");

check("steady prod fixture reads stable (leads 179/195/224/191, judged 2026-08-14)", () => {
  // Pinned from the prod-replica false positive: ~800 leads/quarter, rated
  // Critical/96 by the model — delivery is plainly stable.
  const history = [
    { month: "2026-07", leads: 179, reviews: 6 },
    { month: "2026-06", leads: 195, reviews: null },
    { month: "2026-05", leads: 224, reviews: 4 },
    { month: "2026-04", leads: 191, reviews: null },
  ];
  assertEq(assessDeliveryStability(history, DATE_STR), "stable", "stable");
});

check("latest month under 60% of prior average reads declining", () => {
  const history = [
    { month: "2026-07", leads: 40, reviews: null },
    { month: "2026-06", leads: 100, reviews: null },
    { month: "2026-05", leads: 110, reviews: null },
  ];
  assertEq(assessDeliveryStability(history, DATE_STR), "declining", "declining");
});

check("thin (<2 months) or stale (>2 months behind) history is unknown, never a verdict", () => {
  assertEq(assessDeliveryStability([{ month: "2026-07", leads: 100, reviews: null }], DATE_STR), "unknown", "one month");
  assertEq(assessDeliveryStability([], DATE_STR), "unknown", "empty");
  const stale = [
    { month: "2026-04", leads: 100, reviews: null },
    { month: "2026-03", leads: 120, reviews: null },
  ];
  assertEq(assessDeliveryStability(stale, DATE_STR), "unknown", "stale reports prove nothing");
});

check("the in-progress judgment month is excluded (a partial total is not a collapse)", () => {
  const history = [
    { month: "2026-08", leads: 12, reviews: null }, // partial current month
    { month: "2026-07", leads: 179, reviews: null },
    { month: "2026-06", leads: 195, reviews: null },
  ];
  assertEq(assessDeliveryStability(history, DATE_STR), "stable", "August partial ignored");
});

check("null-lead months are filtered; all-zero history grounds nothing", () => {
  const withNull = [
    { month: "2026-07", leads: null, reviews: null },
    { month: "2026-06", leads: 100, reviews: null },
    { month: "2026-05", leads: 90, reviews: null },
  ];
  assertEq(assessDeliveryStability(withNull, DATE_STR), "stable", "null month skipped");
  const allZero = [
    { month: "2026-07", leads: 0, reviews: null },
    { month: "2026-06", leads: 0, reviews: null },
  ];
  assertEq(assessDeliveryStability(allZero, DATE_STR), "unknown", "all-zero history");
});

// ── 5. clampRiskToTier ──────────────────────────────────────────────────────

console.log("\nclampRiskToTier:");

check("published risk bands are disjoint and the compatibility clamp uses them", () => {
  assertEq(clampRiskToTier(96, "Watch"), 49, "96 → Watch cap 49");
  assertEq(clampRiskToTier(96, "At Risk"), 74, "96 → At Risk cap 74");
  assertEq(clampRiskToTier(85, "Critical"), 85, "85 stays in Critical band");
  assertEq(clampRiskToTier(5, "Watch"), 25, "floor applies");
  assertEq(clampRiskToTier(30, "Healthy"), 24, "Healthy cap 24");
  assertEq(clampRiskToTier(null, "Critical"), null, "ungrounded stays ungrounded");
  const ordered = ["Healthy", "Watch", "At Risk", "Critical"] as const;
  for (let i = 1; i < ordered.length; i++) {
    assertEq(
      TIER_RISK_BANDS[ordered[i - 1]][1] < TIER_RISK_BANDS[ordered[i]][0],
      true,
      `${ordered[i - 1]} and ${ordered[i]} do not overlap`,
    );
  }
});

// ── 6. applyJudgmentTierGate ────────────────────────────────────────────────

console.log("\napplyJudgmentTierGate:");

const HYGIENE_CORPUS = internalOnly("Operator note: no documented GBP strategy for this client yet.");
const HYGIENE_EVIDENCE = evidenceOf("internal_hygiene_gap", "no documented GBP strategy", HYGIENE_CORPUS).items;

function gateInput(overrides: Partial<TierGateInput> = {}): TierGateInput {
  return {
    proposedStatus: "Critical",
    proposedOverallRisk: 96,
    proposedRelationshipStatus: "At Risk",
    judgmentDate: DATE_STR,
    evidence: [],
    tier: "full",
    silenceExceeded: false,
    deliveryStability: "unknown",
    deliveryStabilitySource: "none",
    ...overrides,
  };
}

check("steady-quiet prod false positive: Critical/96 with hygiene-only evidence derives Watch", () => {
  // Pinned prod-replica row (2026-08-14): silence 3 business days inside a
  // 54-day lifetime gap, leads steady, zero open asks — model said
  // Critical/96 High. The rubric says this is a Watch at most.
  const d = applyJudgmentTierGate(
    gateInput({ evidence: HYGIENE_EVIDENCE, deliveryStability: "stable" }),
  );
  assertEq(d.finalStatus, "Watch", "final status");
  assertEq(d.cap, "Watch", "cap");
  assertEq(d.capReasons.includes("hygiene_only_evidence"), true, "cap reason");
  assertEq(d.overridden, true, "overridden");
  assertEq(d.healthyForced, false, "valid hygiene evidence blocks Healthy-force");
  assertEq(d.finalOverallRisk, 25, "risk derived from one accepted hygiene driver");
  assertEq(d.riskClamped, true, "risk clamped flag");
});

check("validated explicit churn language from the client requires Critical regardless of proposal", () => {
  const items = evidenceOf("explicit_churn_language", CLIENT_CANCEL_QUOTE, CORPUS).items;
  const d = applyJudgmentTierGate(gateInput({ proposedOverallRisk: 85, evidence: items }));
  assertEq(d.finalStatus, "Critical", "Critical allowed");
  assertEq(d.capReasons.includes("critical_evidence_validated"), true, "cap reason");
  assertEq(d.overridden, false, "same proposed status");
  assertEq(d.finalOverallRisk, 76, "risk derived from accepted Critical + uncertainty drivers");
  assertEq(d.finalRelationshipStatus, "At Risk", "direct Critical client signal grounds relationship At Risk");
});

check("rejected (fabricated) citation counts as absent → Critical collapses to Watch", () => {
  const rejected = evidenceOf("explicit_churn_language", "we are cancelling the contract effective Friday", CORPUS).items;
  assertEq(rejected[0]?.valid, false, "precondition: citation rejected");
  const d = applyJudgmentTierGate(gateInput({ evidence: rejected }));
  assertEq(d.finalStatus, "Watch", "no validated evidence → Watch cap");
  assertEq(d.capReasons.includes("no_validated_negative_evidence"), true, "cap reason");
});

check("baseline-relative silence alone requires At Risk (never Critical)", () => {
  const d = applyJudgmentTierGate(gateInput({ silenceExceeded: true }));
  assertEq(d.finalStatus, "At Risk", "At Risk cap");
  assertEq(d.capReasons.includes("baseline_silence_exceeded"), true, "cap reason");
  assertEq(d.finalOverallRisk, 51, "risk derived from cadence breakdown + uncertainty");
  assertEq(d.finalRelationshipStatus, "Stable", "cadence alone cannot invent relationship strain");
});

check("current positive intel with confirmed client contact prevents a contradicted silence-only At Risk", () => {
  const positiveContact = [{
    id: "intel-positive-contact",
    sourceType: "operator_intel" as const,
    occurredAt: `${DATE_STR}T12:00:00.000Z`,
    confirmsRecentClientContact: true,
  }];
  const input = gateInput({
    proposedStatus: "At Risk",
    silenceExceeded: true,
    deliveryStability: "stable",
    positiveClientContext: positiveContact,
  });
  const decision = applyJudgmentTierGate(input);
  assertEq(decision.finalStatus, "Healthy", "contradicted silence cannot force At Risk");
  assertEq(decision.silenceTemperedByPositiveContext, true, "tempering is explicit");
  assertEq(
    decision.riskDrivers.some(driver => driver.reason === "baseline_silence_exceeded"),
    false,
    "the stale silence driver is removed",
  );
  assertEq(
    decision.capReasons.includes("positive_client_context_tempered_silence"),
    true,
    "positive precedence is explained",
  );

  const audit = buildTierGateAudit(input, decision, {
    items: [],
    validCount: 0,
    rejectedCount: 0,
    reclassifiedCount: 0,
  });
  assertEq(audit.positiveClientContext[0]?.id, "intel-positive-contact", "source identity is audited");
  assertEq(audit.silenceTemperedByPositiveContext, true, "audit explains the removed silence driver");

  const rating = toAccountRatingPresentation({
    status: decision.finalStatus,
    relationship: decision.finalRelationshipStatus,
    riskScore: decision.finalOverallRisk,
    judgmentDate: DATE_STR,
    dataSourcesSummary: {
      tier: "full",
      promptRevision: "5354.1",
      generatedAt: `${DATE_STR}T23:00:00.000Z`,
      tierGate: audit,
    },
  });
  assertEq(
    rating?.reasonLabels.includes(
      "Current positive client context tempered an otherwise contradictory silence-only signal",
    ),
    true,
    "presented basis exposes the positive precedence",
  );
});

check("positive intel is considered but cannot hide genuine cadence or delivery risk", () => {
  const positiveWithoutContact = [{
    id: "intel-positive-sentiment",
    sourceType: "operator_intel" as const,
    occurredAt: `${DATE_STR}T12:00:00.000Z`,
    confirmsRecentClientContact: false,
  }];
  const cadence = applyJudgmentTierGate(gateInput({
    silenceExceeded: true,
    deliveryStability: "stable",
    positiveClientContext: positiveWithoutContact,
  }));
  assertEq(cadence.finalStatus, "At Risk", "positive sentiment does not erase a genuine cadence gap");
  assertEq(cadence.silenceTemperedByPositiveContext, false, "cadence driver remains active");
  assertEq(
    cadence.capReasons.includes("positive_client_context_validated"),
    true,
    "positive intel was still considered",
  );

  const delivery = applyJudgmentTierGate(gateInput({
    silenceExceeded: true,
    deliveryStability: "declining",
    positiveClientContext: [{
      ...positiveWithoutContact[0],
      id: "intel-positive-contact",
      confirmsRecentClientContact: true,
    }],
  }));
  assertEq(delivery.finalStatus, "At Risk", "objective delivery decline remains At Risk");
  assertEq(delivery.silenceTemperedByPositiveContext, false, "delivery risk prevents silence tempering");
  assertEq(
    delivery.riskDrivers.some(driver => driver.reason === "delivery_metrics_declining"),
    true,
    "objective delivery driver remains visible",
  );
});

check("declining delivery metrics cap at At Risk; At-Risk-tier evidence does too", () => {
  const declining = applyJudgmentTierGate(gateInput({ deliveryStability: "declining" }));
  assertEq(declining.finalStatus, "At Risk", "declining delivery");
  const dissatisfied = evidenceOf(
    "expressed_dissatisfaction",
    "We are honestly frustrated - three weeks with no report",
    CORPUS,
  ).items;
  const expressed = applyJudgmentTierGate(gateInput({ evidence: dissatisfied }));
  assertEq(expressed.finalStatus, "At Risk", "expressed dissatisfaction");
  assertEq(expressed.capReasons.includes("at_risk_evidence_validated"), true, "cap reason");
  assertEq(expressed.finalRelationshipStatus, "Strained", "direct client problem grounds Strained");
});

check("Healthy is reachable again: full basis + stable delivery + no evidence + cadence within baseline", () => {
  const d = applyJudgmentTierGate(
    gateInput({ proposedStatus: "Watch", proposedOverallRisk: 30, deliveryStability: "stable" }),
  );
  assertEq(d.finalStatus, "Healthy", "Healthy forced");
  assertEq(d.healthyForced, true, "healthyForced flag");
  assertEq(d.overridden, true, "counted as override");
  assertEq(d.finalOverallRisk, 0, "no accepted negative drivers means zero risk");
  assertEq(d.finalRelationshipStatus, "Strong", "complete stable neutral basis supports Strong");
});

check("Healthy-force never fires on an operational basis or with unknown delivery", () => {
  const ops = applyJudgmentTierGate(
    gateInput({ proposedStatus: "Watch", proposedOverallRisk: 30, deliveryStability: "stable", tier: "operational" }),
  );
  assertEq(ops.finalStatus, "Watch", "operational basis stays Watch");
  assertEq(ops.healthyForced, false, "no force");
  const unknown = applyJudgmentTierGate(gateInput({ proposedStatus: "Watch", proposedOverallRisk: 30 }));
  assertEq(unknown.finalStatus, "Watch", "unknown delivery stays Watch");
});

check("accepted evidence raises the authoritative result above an advisory model proposal", () => {
  const items = evidenceOf("explicit_churn_language", CLIENT_CANCEL_QUOTE, CORPUS).items;
  const d = applyJudgmentTierGate(
    gateInput({ proposedStatus: "Watch", proposedOverallRisk: 30, evidence: items }),
  );
  assertEq(d.cap, "Critical", "authoritative status");
  assertEq(d.finalStatus, "Critical", "validated Critical evidence wins");
  assertEq(d.overridden, true, "proposal overridden");
  assertEq(d.finalOverallRisk, 76, "model risk ignored");
});

check("stored risk never comes from the model, including a null proposal", () => {
  const nullProposal = applyJudgmentTierGate(gateInput({ proposedOverallRisk: null }));
  const highProposal = applyJudgmentTierGate(gateInput({ proposedOverallRisk: 100 }));
  assertEq(nullProposal.finalOverallRisk, 25, "server still calculates Watch risk");
  assertEq(nullProposal.finalOverallRisk, highProposal.finalOverallRisk, "proposal value is irrelevant");
  assertEq(nullProposal.riskClamped, true, "audit records proposal replacement");
});

check("risk rises monotonically with accepted independent drivers", () => {
  const validation = validateEvidenceCitations(
    [
      { category: "expressed_dissatisfaction", quote: "We are frustrated that reporting is still missing" },
      { category: "service_failure", quote: "Your team missed another agreed delivery deadline" },
    ],
    clientOnly(
      "We are frustrated that reporting is still missing.",
      "Your team missed another agreed delivery deadline.",
    ),
  );
  assertEq(validation.validCount, 2, "distinct atomic sources remain accepted");
  assertEq(
    validation.items[0]?.matchedFragment?.id === validation.items[1]?.matchedFragment?.id,
    false,
    "independent fragments retain distinct identities",
  );
  const one = applyJudgmentTierGate(gateInput({ evidence: validation.items.slice(0, 1) }));
  const two = applyJudgmentTierGate(gateInput({ evidence: validation.items }));
  assertEq(one.finalStatus, "At Risk", "one accepted driver tier");
  assertEq(two.finalStatus, "At Risk", "two accepted drivers tier");
  assertEq(two.finalOverallRisk > one.finalOverallRisk, true, "independent driver count raises risk");
  assertEq(
    calculateRiskFromDrivers("Critical", [
      { id: "c1", severity: "critical", reason: "critical_evidence_validated" },
    ]) > two.finalOverallRisk,
    true,
    "higher severity band always exceeds lower tier",
  );
});

check("one source fact cited under two categories counts as one risk driver", () => {
  const corpus = clientOnly("We are frustrated that your team missed the agreed reporting deadline.");
  const validation = validateEvidenceCitations(
    [
      {
        category: "expressed_dissatisfaction",
        quote: "frustrated that your team missed the agreed reporting deadline",
      },
      {
        category: "service_failure",
        quote: "your team missed the agreed reporting deadline",
      },
    ],
    corpus,
  );
  const duplicate = applyJudgmentTierGate(gateInput({ evidence: validation.items }));
  const single = applyJudgmentTierGate(gateInput({ evidence: validation.items.slice(0, 1) }));
  assertEq(validation.validCount, 1, "duplicate accepted citations collapse");
  assertEq(validation.items.length, 1, "only one accepted audit item remains");
  assertEq(duplicate.riskDrivers.filter(driver => driver.id.startsWith("evidence:")).length, 1, "one independent fact");
  assertEq(duplicate.finalOverallRisk, single.finalOverallRisk, "duplicate categorization cannot raise risk");
});

check("legacy accepted items without fragments deduplicate by quote fingerprint", () => {
  const [item] = evidenceOf(
    "expressed_dissatisfaction",
    "We are honestly frustrated - three weeks with no report",
    CORPUS,
  ).items;
  if (!item) throw new Error("fingerprint fixture did not validate");
  const legacyItem = { ...item, matchedFragment: undefined };
  const decision = applyJudgmentTierGate(
    gateInput({ evidence: [legacyItem, { ...legacyItem }] }),
  );
  assertEq(
    decision.riskDrivers.filter(driver => driver.id.startsWith("evidence:")).length,
    1,
    "fingerprint fallback keeps one accepted fact",
  );
  const input = gateInput({ evidence: [legacyItem, { ...legacyItem }] });
  const audit = buildTierGateAudit(input, decision, {
    items: input.evidence,
    validCount: 2,
    rejectedCount: 0,
    reclassifiedCount: 0,
  });
  const presentation = toAccountRatingPresentation({
    status: decision.finalStatus,
    relationship: decision.finalRelationshipStatus,
    riskScore: decision.finalOverallRisk,
    judgmentDate: DATE_STR,
    dataSourcesSummary: {
      tier: "full",
      tierGate: audit,
    },
  });
  assertEq(
    presentation?.evidenceCounts.accepted,
    1,
    "legacy explanation count uses unique accepted identities",
  );
});

check("standing evidence decays exactly once rather than holding peak severity", () => {
  const criticalValidation = evidenceOf(
    "explicit_churn_language",
    "want to cancel the engagement at the end of the quarter",
    clientOnly("We want to cancel the engagement at the end of the quarter."),
  );
  const criticalItem = criticalValidation.items[0];
  if (!criticalItem?.matchedFragment) throw new Error("critical fixture did not match");
  criticalItem.matchedFragment.occurredAt = "2026-07-29T12:00:00.000Z";
  const atRiskValidation = evidenceOf(
    "expressed_dissatisfaction",
    "frustrated that reporting is still incomplete",
    clientOnly("We are frustrated that reporting is still incomplete."),
  );
  const atRiskItem = atRiskValidation.items[0];
  if (!atRiskItem?.matchedFragment) throw new Error("at-risk fixture did not match");
  atRiskItem.matchedFragment.occurredAt = "2026-07-29T12:00:00.000Z";

  const decayedCritical = applyJudgmentTierGate(gateInput({ evidence: [criticalItem] }));
  const decayedAtRisk = applyJudgmentTierGate(gateInput({ evidence: [atRiskItem] }));
  assertEq(decayedCritical.finalStatus, "At Risk", "standing Critical signal decays one tier");
  assertEq(decayedCritical.finalRelationshipStatus, "Strained", "standing Critical signal no longer supports relationship At Risk");
  assertEq(decayedAtRisk.finalStatus, "Watch", "standing At-Risk signal decays to Watch");
  assertEq(decayedAtRisk.finalRelationshipStatus, "Stable", "standing weak signal no longer supports Strained");
  assertEq(
    buildEvidenceRecencyFingerprint([criticalItem], "2026-08-12")[0] !==
      buildEvidenceRecencyFingerprint([criticalItem], DATE_STR)[0],
    true,
    "the exact decay crossing changes the freshness fact",
  );
});

check("delivery-only breakdown cannot invent a strained relationship", () => {
  const d = applyJudgmentTierGate(
    gateInput({ deliveryStability: "declining", deliveryStabilitySource: "entered_reports" }),
  );
  assertEq(d.finalStatus, "At Risk", "objective breakdown requires overall At Risk");
  assertEq(d.finalRelationshipStatus, "Stable", "no grounded client relationship signal");
});

check("audited Healthy/Stable model prose is reconciled to the final At Risk rating", () => {
  const decision = applyJudgmentTierGate(
    gateInput({
      proposedStatus: "Healthy",
      proposedOverallRisk: 53,
      proposedRelationshipStatus: "Stable",
      silenceExceeded: true,
    }),
  );
  const raw =
    "Status is Healthy with a Stable relationship. There have been no communications since 8/19.";
  const reconciled = reconcileJudgmentNarrative(
    raw,
    decision.finalStatus,
    decision.finalRelationshipStatus,
    decision.finalOverallRisk,
  );

  assertEq(decision.finalStatus, "At Risk", "audited deterministic outcome");
  assertEq(decision.finalRelationshipStatus, "Stable", "audited relationship outcome");
  assertEq(
    reconciled,
    "Server verdict: At Risk / 51. Relationship: Stable.\n\nSupporting context: There have been no communications since 8/19.",
    "stored narrative follows the tier-gate result",
  );
  assertEq(reconciled.includes("Status is Healthy"), false, "model's conflicting status removed");
});

check("non-canonical model rating claims cannot compete with the server verdict", () => {
  const raw = [
    "This account is Healthy.",
    "The account appropriately sits at Watch.",
    "Overall health is healthy.",
    "Risk remains low.",
    "The relationship remains Strong.",
    "Lead volume declined in the latest completed month.",
  ].join(" ");
  const reconciled = reconcileJudgmentNarrative(raw, "Critical", "At Risk", 82);

  assertEq(
    reconciled,
    "Server verdict: Critical / 82. Relationship: At Risk.\n\nSupporting context: Lead volume declined in the latest completed month.",
    "only the server owns rating language",
  );
  assertEq(
    stripModelRatingClaims("Risk remains low. Delivery fell 40%."),
    "Delivery fell 40%.",
    "supporting fields drop qualitative risk claims too",
  );
});

// ── 7. buildTierGateAudit ───────────────────────────────────────────────────

console.log("\nbuildTierGateAudit:");

check("audit preserves the proposal, the decision, the citation verdicts, and reclassifications", () => {
  const validation = validateEvidenceCitations(
    [
      { category: "explicit_churn_language", quote: CLIENT_CANCEL_QUOTE },
      { category: "explicit_churn_language", quote: "completely invented cancellation threat here" },
      { category: "explicit_churn_language", quote: "want to cancel in a month if leads don't recover" },
    ],
    CORPUS,
  );
  const input = gateInput({ proposedOverallRisk: 92, evidence: validation.items });
  const decision = applyJudgmentTierGate(input);
  const audit = buildTierGateAudit(input, decision, validation);
  assertEq(audit.version, TIER_GATE_VERSION, "version stamped");
  assertEq(audit.proposedStatus, "Critical", "proposed status");
  assertEq(audit.finalStatus, decision.finalStatus, "final status");
  assertEq(audit.proposedRelationshipStatus, "At Risk", "relationship proposal retained");
  assertEq(audit.finalRelationshipStatus, decision.finalRelationshipStatus, "relationship decision retained");
  assertEq(audit.proposedOverallRisk, 92, "proposed risk");
  assertEq(audit.finalOverallRisk, decision.finalOverallRisk, "final risk");
  assertEq(audit.riskDrivers.length > 0, true, "independent decision drivers persisted");
  assertEq(audit.evidence.validCount, 2, "valid count");
  assertEq(audit.evidence.rejectedCount, 1, "rejected count");
  assertEq(audit.evidence.reclassifiedCount, 1, "reclassified count");
  assertEq(audit.evidence.items[0]?.sourceScope, "client_communication", "scope persisted");
  assertEq(audit.evidence.items[1]?.rejectReason, "not_found_in_inputs", "rejected item verdict");
  assertEq(audit.evidence.items[2]?.reclassReason, "critical_requires_direct_client_language", "reclass persisted");
  assertEq(audit.evidence.items[0]?.originalCategory, "explicit_churn_language", "original category persisted");
  assertEq(audit.evidence.items[0]?.provenance, "client_authored", "atomic provenance persisted");
  assertEq(audit.evidence.items[0]?.matchedFragment?.sourceId, "c3", "source record persisted");
  assertEq(audit.evidence.items[0]?.matchedFragment?.field, "content", "source field persisted");
  assertEq(audit.evidence.items[0]?.quote, "[citation redacted]", "audit does not store body text");
  assertEq(audit.evidence.items[0]?.quoteFingerprint?.length, 20, "citation remains correlatable");
});

// ── Wrap up ─────────────────────────────────────────────────────────────────

closeDbPools()
  .catch(() => {})
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} tier-gate test step(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log("\nAll daily-judgment tier-gate tests passed");
    }
  });
