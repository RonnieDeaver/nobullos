/* test-registration
{
  "name": "Judgment metric-tracking classifier + fabricated-zero predicate + untracked-metric prompt rendering (Task #4846)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4846: pure, DB-free policy core of the fabricated-zero fix — the never-entered vs lapsed classification, the calibrated poisoned-claim predicate (exact prod-replica strings, unicode preserved), the per-family suppression gate, the not-tracked report rendering, and the AI-inferred/human-filed provenance labels; the DB guard + drain sides gate via the sweep (tests/judgment-fabricated-zero-guard.test.ts, tests/prod-action-fabricated-zero-facts.test.ts)",
  "timeoutMs": 60000,
  "tier": "small"
}
test-registration */
/**
 * Task #4846 — pure unit coverage for the untracked-metric machinery:
 *
 *  1. classifyMetricTrackingFromSections: never_entered vs entered_before
 *     per family, on the same isMetricEntered gates the report block uses —
 *     No-Data-flagged values and legacy blank-coerced zeros never count as
 *     entered; one genuinely entered month flips the family permanently.
 *  2. matchFabricatedZeroClaim: the calibrated predicate against EXACT
 *     production fact texts (read from the prod replica 2026-08-17 —
 *     unicode dashes/quotes preserved verbatim; "zero‑intake" with U+2011
 *     is the canonical poisoned spelling), plus healthy controls that must
 *     never match.
 *  3. shouldSuppressFabricatedZeroClaim: suppression requires EVERY
 *     asserted family to be never-tracked — tracked clients keep their zero
 *     claims (for them a zero may be a real measurement).
 *  4. buildLatestReportSection: a never-tracked family renders "not tracked
 *     for this client" (distinct from the month-scoped "no data" lapse),
 *     the hard-rule banner names the untracked families, and section-absent
 *     fallbacks still surface the not-tracked line.
 *  5. formatContextForPrompt: agent-memory facts carry [AI-inferred] vs
 *     [human-filed] provenance labels plus the caution paragraph, so
 *     recycled judgment narrative can no longer masquerade as operator
 *     intel.
 */

// FIRST import: forces NODE_ENV=test before hoisted server imports evaluate,
// so the transitively-created pg pool uses test-mode idle reaping and a bare
// `npx tsx` run can exit naturally after the assertions.
import "./helpers/forceTestEnv";

import {
  classifyMetricTrackingFromSections,
  matchFabricatedZeroClaim,
  shouldSuppressFabricatedZeroClaim,
  filterFabricatedZeroFacts,
  type ClientMetricTracking,
} from "../server/services/judgmentMetricTracking";
import { buildLatestReportSection } from "../server/services/dailyJudgment";
import { formatContextForPrompt } from "../server/services/contextRetrieval";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NEVER_BOTH: ClientMetricTracking = { consults: "never_entered", cases: "never_entered", monthsInspected: 8 };
const TRACKED_BOTH: ClientMetricTracking = { consults: "entered_before", cases: "entered_before", monthsInspected: 8 };
const CONSULTS_ONLY_TRACKED: ClientMetricTracking = { consults: "entered_before", cases: "never_entered", monthsInspected: 8 };

// ─── 1. classifier ───────────────────────────────────────────────────────────

function testClassifier(): void {
  console.log("\nclassifyMetricTrackingFromSections:");

  const empty = classifyMetricTrackingFromSections([]);
  check(
    "empty history → never_entered both, 0 months",
    empty.consults === "never_entered" && empty.cases === "never_entered" && empty.monthsInspected === 0,
  );

  // Ashley Andrews Law shape (prod reference client): every month has the
  // intake totalConsults + sales totalCases No-Data flags set, values 0.
  const allFlagged = classifyMetricTrackingFromSections([
    {
      month: "2026-06",
      sectionKey: "intake",
      data: { totalConsults: 0, leadToConsultRate: 0, noDataFlags: { totalConsults: true } },
    },
    {
      month: "2026-06",
      sectionKey: "sales",
      data: { totalConsults: 0, totalCases: 0, consultToCaseRate: 0, noDataFlags: { totalConsults: true, totalCases: true } },
    },
    {
      month: "2026-07",
      sectionKey: "intake",
      data: { totalConsults: 0, leadToConsultRate: 0, noDataFlags: { totalConsults: true } },
    },
    {
      month: "2026-07",
      sectionKey: "sales",
      data: { totalConsults: 0, totalCases: 0, consultToCaseRate: 0, noDataFlags: { totalConsults: true, totalCases: true } },
    },
  ]);
  check(
    "all months No-Data-flagged → never_entered both",
    allFlagged.consults === "never_entered" && allFlagged.cases === "never_entered",
  );
  check("months counted", allFlagged.monthsInspected === 2, String(allFlagged.monthsInspected));

  // Legacy blank-coerced zeros (no noDataFlags key at all) never count.
  const legacyZeros = classifyMetricTrackingFromSections([
    { month: "2026-03", sectionKey: "intake", data: { totalConsults: 0, leadToConsultRate: 0 } },
    { month: "2026-03", sectionKey: "sales", data: { totalCases: 0, consultToCaseRate: 0 } },
  ]);
  check(
    "legacy blank-coerced zeros → never_entered both",
    legacyZeros.consults === "never_entered" && legacyZeros.cases === "never_entered",
  );

  // One entered month flips the family — even among flagged months.
  const enteredOnce = classifyMetricTrackingFromSections([
    { month: "2026-05", sectionKey: "intake", data: { totalConsults: 0, noDataFlags: { totalConsults: true } } },
    { month: "2026-06", sectionKey: "intake", data: { totalConsults: 7, noDataFlags: {} } },
    { month: "2026-06", sectionKey: "sales", data: { totalCases: 0, noDataFlags: { totalCases: true } } },
  ]);
  check(
    "one entered intake month → consults entered_before, cases never",
    enteredOnce.consults === "entered_before" && enteredOnce.cases === "never_entered",
  );

  // Sales-section consults count toward the consults family; the rate
  // fields ride their family flag.
  const salesConsults = classifyMetricTrackingFromSections([
    { month: "2026-06", sectionKey: "sales", data: { totalConsults: 4, totalCases: 0, noDataFlags: { totalCases: true } } },
  ]);
  check(
    "sales.totalConsults entered → consults family tracked",
    salesConsults.consults === "entered_before" && salesConsults.cases === "never_entered",
  );

  const rateOnly = classifyMetricTrackingFromSections([
    { month: "2026-06", sectionKey: "sales", data: { totalCases: 0, consultToCaseRate: 25, noDataFlags: {} } },
  ]);
  check("entered consultToCaseRate alone → cases tracked", rateOnly.cases === "entered_before");

  // A flagged rate does NOT count (flag gates the pair).
  const flaggedRate = classifyMetricTrackingFromSections([
    { month: "2026-06", sectionKey: "sales", data: { totalCases: 0, consultToCaseRate: 25, noDataFlags: { totalCases: true } } },
  ]);
  check("flagged consultToCaseRate → cases still never_entered", flaggedRate.cases === "never_entered");
}

// ─── 2. predicate vs exact prod corpus strings ───────────────────────────────

// EXACT production fact_text values, read from the prod replica 2026-08-17
// (calibration corpus, .local/scratch/t4846 harness). Unicode is preserved
// verbatim — U+2011 non-breaking hyphens, U+2018/19 curly quotes, U+201C/1D
// curly double quotes. Do NOT "fix" the spelling: the predicate must match
// what production actually stored.
const PROD_POISONED: Array<{ text: string; families: string[] }> = [
  {
    // U+2011 in "non‑defensive" — consults-only claim ("0 intakes").
    text: "Unresolved: Likely unresolved: Clear, non‑defensive explanation of how 98 May leads and 55 June GBP leads produced 0 intakes, plus a concrete intake/tracking remediation plan.",
    families: ["consults"],
  },
  {
    text: "Tracking/attribution failures (27 GBP leads vs 0 intake, CallRail/CRM mismatch) remain unexplained to her, so any future data from us would be non‑credible.",
    families: ["consults"],
  },
  {
    // Curly double quotes U+201C/U+201D around “no data”.
    text: "We still have no recorded intake, consult, or case data for July (all marked “no data” in the report) despite 240 total leads, leaving ROI and true performance completely unclear.",
    families: ["consults", "cases"],
  },
  {
    text: "Misha’s frozen story — 150+ reported leads, 0 intakes, no convincing explanation — is a clean reputational risk if he talks to other estate planning attorneys or vendors.",
    families: ["consults"],
  },
  {
    text: "Current sentiment is likely negative-to-wary, even though we don’t see fresh emails. The data pattern (0 intake vs. significant GBP leads and expensive Google Ads CPL) would naturally trigger frustration about performance and value.",
    families: ["consults"],
  },
];

// Kept-matched shapes: match the vocabulary, but belong to clients whose
// report history DOES track the family — the suppression gate must keep them.
const PROD_KEPT_MATCHED: string[] = [
  "The February 360‑leads/0‑conversions incident remains undocumented in a client‑facing post‑mortem, leaving a damaging, one‑sided story about our lead quality and ownership.",
  "Unresolved: Intake system improvements appear still open — without these, reported 0 consults and 0 cases will persist even if lead flow returns.",
];

// Healthy prod facts that must NEVER match ("zero spend" is a spend
// observation, "June weak/0" is lead volatility — neither asserts an
// intake/sales metric outcome).
const PROD_HEALTHY: string[] = [
  "Unresolved: Use the client list Anne will send to run review campaigns and improve GBP visibility for criminal defense; appears still open with no list received",
  "Unresolved: Google Ads performance issue (prolonged inactivity/zero spend) remains likely unresolved; there is no evidence of reactivation, technical fix, or a clear plan communicated",
  "Unresolved: Implicit need for us to explain the volatility pattern (April poor, May strong, June weak/0) and present a stabilization plan to avoid future zero or near-zero months",
  "Client sentiment is almost certainly negative and declining, but quiet. No overt complaints, just disengagement.",
  "Unresolved: Likely unresolved: agreement on short-term success metrics (visibility, profile views, calls, direction requests) so we can show directional progress",
];

function testPredicate(): void {
  console.log("\nmatchFabricatedZeroClaim (exact prod strings):");

  for (const { text, families } of PROD_POISONED) {
    const m = matchFabricatedZeroClaim(text);
    check(
      `poisoned matches [${families.join(",")}]: "${text.slice(0, 60)}…"`,
      m.matched && families.every((f) => m.families.includes(f as any)),
      `matched=${m.matched} families=${m.families.join(",")}`,
    );
  }

  for (const text of PROD_KEPT_MATCHED) {
    check(`kept-matched still MATCHES (gate decides): "${text.slice(0, 60)}…"`, matchFabricatedZeroClaim(text).matched);
  }

  for (const text of PROD_HEALTHY) {
    const m = matchFabricatedZeroClaim(text);
    check(`healthy control does NOT match: "${text.slice(0, 60)}…"`, !m.matched, `families=${m.families.join(",")}`);
  }

  // Canonical unicode spelling: U+2011 non-breaking hyphen inside the claim
  // itself ("zero‑intake") — normalization must see one spelling.
  const u2011 = matchFabricatedZeroClaim("confirmed zero\u2011intake month despite steady lead flow");
  check("U+2011 'zero‑intake' matches consults", u2011.matched && u2011.families.includes("consults"));

  const zeroConsultOutcome = matchFabricatedZeroClaim("the zero-consult/poor-conversion outcome repeated in July");
  check(
    "zero-consult/poor-conversion → both families (conversion widens)",
    zeroConsultOutcome.matched &&
      zeroConsultOutcome.families.includes("consults") &&
      zeroConsultOutcome.families.includes("cases"),
  );

  const visibility = matchFabricatedZeroClaim("we still lack visibility into the conversion problem");
  check(
    "visibility-into-conversion → both families",
    visibility.matched && visibility.families.length === 2,
  );
}

// ─── 3. per-family suppression gate ──────────────────────────────────────────

function testSuppressionGate(): void {
  console.log("\nshouldSuppressFabricatedZeroClaim:");

  const consultsClaim = PROD_POISONED[0].text; // consults-only
  check("never-tracked client: consults claim suppressed", shouldSuppressFabricatedZeroClaim(consultsClaim, NEVER_BOTH));
  check(
    "tracked client: same claim KEPT (zero may be a real measurement)",
    !shouldSuppressFabricatedZeroClaim(consultsClaim, TRACKED_BOTH),
  );
  check(
    "consults tracked, cases never: consults-only claim KEPT",
    !shouldSuppressFabricatedZeroClaim(consultsClaim, CONSULTS_ONLY_TRACKED),
  );

  const bothClaim = "reported 0 consults and 0 cases again this month";
  check(
    "both-family claim vs consults-tracked client: KEPT (every family must be untracked)",
    !shouldSuppressFabricatedZeroClaim(bothClaim, CONSULTS_ONLY_TRACKED),
  );
  check("both-family claim vs never-both client: suppressed", shouldSuppressFabricatedZeroClaim(bothClaim, NEVER_BOTH));

  const casesClaim = "no signed cases were recorded in the July report";
  check(
    "cases-only claim vs consults-tracked/cases-never client: suppressed",
    shouldSuppressFabricatedZeroClaim(casesClaim, CONSULTS_ONLY_TRACKED),
  );

  check("healthy text never suppressed even for never-both", !shouldSuppressFabricatedZeroClaim(PROD_HEALTHY[1], NEVER_BOTH));

  const parts = filterFabricatedZeroFacts(
    [
      { text: consultsClaim },
      { text: PROD_HEALTHY[0] },
      { text: bothClaim },
    ],
    NEVER_BOTH,
  );
  check(
    "filterFabricatedZeroFacts partitions (2 suppressed, 1 kept)",
    parts.suppressed.length === 2 && parts.kept.length === 1 && parts.kept[0].text === PROD_HEALTHY[0],
  );
}

// ─── 4. report-section rendering: never-tracked vs lapsed ────────────────────

function report(sections: Record<string, unknown>): any {
  return { reportId: "r1", reportMonth: "2026-07", updatedAt: null, sections };
}

function testRendering(): void {
  console.log("\nbuildLatestReportSection (not-tracked vs no-data):");

  const flaggedSections = {
    intake: { totalConsults: 0, leadToConsultRate: 0, noDataFlags: { totalConsults: true } },
    sales: { totalConsults: 0, totalCases: 0, consultToCaseRate: 0, noDataFlags: { totalConsults: true, totalCases: true } },
  };

  // Never-tracked client: hard-rule banner + "not tracked" lines.
  const never = buildLatestReportSection(report(flaggedSections), { consults: "never_entered", cases: "never_entered" }).join("\n");
  check("never-tracked: hard-rule banner present", never.includes("Metric-tracking status (hard rule)"));
  check(
    "banner names both families",
    never.includes("consult/intake metrics and case/sales metrics are NOT TRACKED"),
  );
  check("intake line says not tracked", /Intake: consults booked: not tracked for this client/.test(never));
  check("sales cases say not tracked", /cases signed: not tracked for this client/.test(never));
  check("never renders a zero", !/consults booked: 0|cases signed: 0/.test(never));
  check(
    "supersede rule covers agent memory + zero consults",
    never.includes("SUPERSEDES any metric claims in prior judgments or agent memory") && never.includes('"zero consults"'),
  );

  // Lapsed client (tracked before, blank this month): month-scoped no-data,
  // NOT the structural line, and no hard-rule banner.
  const lapsed = buildLatestReportSection(report(flaggedSections), { consults: "entered_before", cases: "entered_before" }).join("\n");
  check("lapsed: no hard-rule banner", !lapsed.includes("Metric-tracking status (hard rule)"));
  check("lapsed: month-scoped no-data wording", /consults booked: no data \(not entered for this month/.test(lapsed));
  check("lapsed: never says structurally unavailable", !lapsed.includes("not tracked for this client ("));

  // Mixed: consults tracked (lapsed), cases never.
  const mixed = buildLatestReportSection(report(flaggedSections), { consults: "entered_before", cases: "never_entered" }).join("\n");
  check("mixed: banner names only case/sales", mixed.includes("case/sales metrics are NOT TRACKED") && !mixed.includes("consult/intake metrics and"));
  check(
    "mixed: consults no-data, cases not-tracked",
    /consults booked: no data \(/.test(mixed) && /cases signed: not tracked for this client/.test(mixed),
  );

  // Entered values always win over tracking state.
  const entered = buildLatestReportSection(
    report({
      intake: { totalConsults: 7, leadToConsultRate: 30, noDataFlags: {} },
      sales: { totalConsults: 6, totalCases: 2, consultToCaseRate: 33, noDataFlags: {} },
    }),
    { consults: "entered_before", cases: "entered_before" },
  ).join("\n");
  check("entered values render as numbers", entered.includes("consults booked: 7") && entered.includes("cases signed: 2"));

  // Section absent entirely: never-tracked fallback lines still render.
  const absent = buildLatestReportSection(report({ marketing: { totalLeads: 0 } }), {
    consults: "never_entered",
    cases: "never_entered",
  }).join("\n");
  check(
    "absent sections: Intake/Sales not-tracked fallback lines",
    /Intake: not tracked for this client/.test(absent) && /Sales: not tracked for this client/.test(absent),
  );

  // Backward compat: no tracking info behaves like Task #4048 (no banner,
  // plain no-data) — pre-4846 callers/tests keep their semantics.
  const noTracking = buildLatestReportSection(report(flaggedSections)).join("\n");
  check("no tracking arg: no banner, no not-tracked lines", !noTracking.includes("hard rule") && !noTracking.includes("not tracked for this client"));
}

// ─── 5. provenance labels ────────────────────────────────────────────────────

function testProvenance(): void {
  console.log("\nformatContextForPrompt provenance:");

  const ctx = {
    knownFacts: [
      {
        category: "recurring_concern",
        facts: [
          { text: "Client reports intake volume down", confidence: 0.9, lastSeen: "2026-08-10", sourceAgent: "daily_judgment" },
          { text: "Owner said August is their slow season", confidence: 0.9, lastSeen: "2026-08-12", sourceAgent: "manual" },
        ],
      },
    ],
    recentCorrections: [],
    factCount: 2,
    totalFactCount: 2,
    latestFactSeenAt: "2026-08-12T00:00:00.000Z",
  };
  const out = formatContextForPrompt(ctx as any);
  check("caution paragraph present", out.includes("NOT operator intel") || out.includes("NOT human statements, NOT operator intel"));
  check("daily_judgment fact labeled AI-inferred", out.includes("- [AI-inferred] Client reports intake volume down"));
  check("manual fact labeled human-filed", out.includes("- [human-filed] Owner said August is their slow season"));
  check(
    "caution says drop unsupported AI-inferred claims",
    out.includes("drop it rather than restate it"),
  );
}

// ─── run ─────────────────────────────────────────────────────────────────────

testClassifier();
testPredicate();
testSuppressionGate();
testRendering();
testProvenance();

console.log(`\nTest run: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

// The pure assertions never query, but importing the judgment/context
// modules transitively constructs DB pools — close them so BOTH lanes
// (batched runner and bare tsx) exit promptly instead of idling on pool
// resources.
void import("../server/db").then(({ closeDbPools }) => closeDbPools()).catch(() => {});
