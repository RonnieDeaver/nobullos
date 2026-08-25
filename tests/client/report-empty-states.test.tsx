/* test-registration
{
  "name": "Report deck-wide no-data upsell states — fully-empty sections render full slide skeletons (muted 'No data' slots + quiet chart placeholder frames, never fabricated zeros) with exactly ONE gold CaseIntake™ callout each (manual-ask variant for consults/cases, upgrade-only otherwise), a Marketing slide WITH data names the actual gap (reviews / ad spend / both / leads, Task #4850) instead of the whole-section 'No data' line and shows no callout when nothing is missing, all five data-section agenda rows render unconditionally, badges are suppressed over absent data, sentence-case 'No data' is the only rendered wording, delta chips never assert change over absent baselines, and hand-built views without the presence map fail open (Task #4693, superseding the #4285 collapse)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4693: fast (~3s), pure SSR + pure-function units — no DB, no jsdom, no network (fetch stubbed to throw). Pins the deck-wide no-data upsell convention on the paying-client surface: a regression here 'restores' the #4285 collapse (hiding the sales lever the owner explicitly asked for), fabricates zero-value charts, repeats the pitch on every card, drops agenda rows, ships a posture badge over zero volume, or lets delta chips claim change against absent baselines (#4226). The fail-open contract also guards every hand-built partial view in sibling suites.",
  "extraEnv": {
    "NODE_ENV": "test",
    "TSX_TSCONFIG_PATH": "./tsconfig.tests.json"
  },
  "scanPaths": [
    "client/src/pages/publicReport",
    "client/src/pages/PublicReport.tsx",
    "client/src/index.css"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4693 — deck-wide no-data upsell conformance (supersedes the Task
 * #4285 collapse convention; audit backlog #17 + §8.6 badge rules survive).
 *
 * Layer choice (test-economics L1): the contract is markup shape + pure
 * decision rules — react-dom/server static markup plus direct unit calls.
 * No jsdom, no DB, no network. Existing coverage this does NOT duplicate:
 *   - report-deep-dive-slides-editorial pins the intake/sales PARTIAL path
 *     (one entered metric keeps the full slide, per-metric Task #3688
 *     gating, header-tag suppression) via jsdom mounts;
 *   - market-context-slide-resilience pins the Market Context drop rule;
 *   - report-trend-short-history-states pins the trend card states.
 *
 * What this suite uniquely pins:
 *   (1) computeSectionPresence — the ONE presence bit per section that now
 *       drives skeleton mode, callout variants, and badge suppression,
 *       including entry-tracking era semantics (noDataFlags KEY presence,
 *       Task #3688) and entered-zero trend months counting as data (#4226).
 *   (2) Sparse deck SSR through the REAL deriver: every empty data section
 *       renders its FULL slide skeleton with exactly ONE gold CaseIntake™
 *       callout (manual-ask copy where consults/cases are missing,
 *       upgrade-only elsewhere; Lifetime Value month-free), quiet chart
 *       placeholder frames, no collapse bands, no title-cased wording.
 *   (3) Badge suppression: no marketing posture badge over 0 leads, no
 *       neutral tags on Engine Health missing rows, populated controls
 *       keep their badges.
 *   (4) Agenda: the five data-section rows render UNCONDITIONALLY (empty
 *       sections still have destinations); conditional NoBull Brief /
 *       Market Context flags survive; fail-open without a presence map.
 *   (5) #4226 regression: buildTrendMetricSeries deltaPair is null with <2
 *       data months; an entered zero IS a baseline.
 *   (6) Source scan: the title-cased wording is banned from the whole slide
 *       directory (one deck-wide convention, enforced at the source level).
 *   (7) Task #4850: a marketing slide WITH data never shows the generic
 *       whole-section "No data" line — the callout names the actual gap
 *       (reviews / ad spend / both / leads, month-scoped), the generic copy
 *       stays fully-empty-only, all-present shows no callout, and every
 *       state keeps exactly ONE callout with exactly one CaseIntake™.
 *   (8) Task #4982: an Engine Health leads-hero month whose total includes a
 *       non-zero "Other" bucket renders the Other-leads disclosure clarifier
 *       (actual count, SSR-escaped rendered quotes, attribution tail) plus
 *       the compact status-row version; zero-Other, zero-lead, and
 *       fully-empty months render neither.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { derivePublicReportView } from "../../client/src/pages/publicReport/derive";
import {
  computeSectionPresence,
  hasLifetimeData,
  isAgendaRowPresent,
} from "../../client/src/pages/publicReport/sectionPresence";
import {
  NO_DATA_LABEL,
  SectionUpsellCallout,
  ChartPlaceholderFrame,
  buildMarketingAdSpendGapUpsellMessage,
  buildMarketingLeadsGapUpsellMessage,
  buildMarketingReviewsAndAdSpendGapUpsellMessage,
  buildMarketingReviewsGapUpsellMessage,
  buildUpgradeUpsellMessage,
} from "../../client/src/pages/publicReport/EmptyState";
import { buildTrendMetricSeries } from "../../client/src/pages/publicReport/TrendsSection";
import { AgendaSlide } from "../../client/src/pages/publicReport/AgendaSlide";
import { EngineHealthSlide } from "../../client/src/pages/publicReport/EngineHealthSlide";
import { IntakeSlide } from "../../client/src/pages/publicReport/IntakeSlide";
import { SalesSlide } from "../../client/src/pages/publicReport/SalesSlide";
import { MarketingSlide } from "../../client/src/pages/publicReport/MarketingSlide";
import { RevenueLeakSlide } from "../../client/src/pages/publicReport/RevenueLeakSlide";
import { LifetimeValueSlide } from "../../client/src/pages/publicReport/LifetimeValueSlide";
import { Next30DaysSlide } from "../../client/src/pages/publicReport/Next30DaysSlide";

// Harness-agnostic JSX-runtime shim: batch workers compile .tsx CLASSIC
// (React.createElement) while component modules carry no React import of
// their own — bind the global BEFORE the first render.
(globalThis as { React?: typeof React }).React = React;

// Hermeticity: nothing here may touch the network. SSR never runs query
// effects, so this stub is belt-and-braces — a render that fetches fails
// loudly instead of hitting a live endpoint.
(globalThis as { fetch?: typeof fetch }).fetch = (async () => {
  throw new Error("network disabled in report-empty-states test");
}) as unknown as typeof fetch;

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SLIDE_NUMBERS = {
  title: 1, roadmap: 2, ceoPulse: 3, marketContext: 4, engineHealth: 5,
  marketing: 6, intake: 7, sales: 8, lossAudit: 9, lifetimeValue: 10,
  next30: 11, bookPromo: 12,
};

/** Legacy-shaped sparse report: sections WITHOUT noDataFlags keys, nothing entered. */
function sparseData(): any {
  return {
    report: { id: "r-4285-sparse", reportMonth: "2026-06", status: "final" },
    client: {
      firmName: "Sparse Firm", contactName: null, products: [],
      consultType: "paid", terminology: null,
    },
    sections: [
      { sectionKey: "intake", data: {} },
      { sectionKey: "sales", data: {} },
      { sectionKey: "marketing", data: {} },
    ],
    ceoPulse: null,
    dataAccess: [],
    trendData: [],
  };
}

function rootState(data: any): any {
  return {
    isDemo: true, isPrintMode: false, isPreview: false, isEditing: false,
    prefersReducedMotion: true, printModeActive: false, hasCeoPulse: false,
    hasMarketContext: false, slideNumbers: SLIDE_NUMBERS, data,
  };
}

const queryClient = new QueryClient();
const ssr = (Component: any, view: any): string =>
  renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Component, { view }),
    ),
  );

/** All-empty computeSectionPresence input — override per case. */
const baseInput = (): any => ({
  intakeSection: undefined, salesSection: undefined, marketingSection: undefined,
  actionsSection: undefined, lifetimeValue: null, totalLeads: 0,
  hasConsultsData: false, hasLeadToConsultData: false, hasCasesData: false,
  hasConsultToCaseData: false, hasAvgCaseValueData: false,
  displayedMissedCallRate: null, intakeExecutionScore: null,
  effectiveSalesQuality: null, pipelineMomentumIndex: null,
  intakeNoDataFlags: {}, salesNoDataFlags: {},
  gbpLocations: [], gbpTotalReviews: 0, totalAdSpend: 0,
  webinars: {}, hasWebinar: false, trendData: [], correctedTrendData: [],
});

const ALL_SECTIONS = ["engineHealth", "intake", "sales", "marketing", "lossAudit", "lifetimeValue", "next30"] as const;

// ---------------------------------------------------------------------------
// (1) computeSectionPresence units
// ---------------------------------------------------------------------------

{
  const sparse = computeSectionPresence(baseInput());
  for (const key of ALL_SECTIONS) {
    assert.equal((sparse as any)[key], false, `${key} absent on an all-empty report`);
  }
  ok("all-empty input → every section absent");

  // Any entered pipeline stage lights Engine Health + Revenue Leak; consult
  // volume is also an intake signal, but never a sales/marketing one.
  const consultsOnly = computeSectionPresence({ ...baseInput(), hasConsultsData: true });
  assert.equal(consultsOnly.engineHealth, true);
  assert.equal(consultsOnly.lossAudit, true);
  assert.equal(consultsOnly.intake, true);
  assert.equal(consultsOnly.sales, false);
  assert.equal(consultsOnly.marketing, false);
  ok("entered consult volume lights engine health, leak, and intake — not sales/marketing");

  // Entry-tracking era semantics (Task #3688 — noDataFlags KEY presence is
  // the era marker; boundaries NOT redefined here): a legacy value counts,
  // an era value under its flag does not.
  const legacyValue = computeSectionPresence({
    ...baseInput(),
    intakeSection: { data: { avgTimeToAnswer: 25 } },
  });
  assert.equal(legacyValue.intake, true, "legacy (no noDataFlags key) entered value counts");
  const eraFlagged = computeSectionPresence({
    ...baseInput(),
    intakeSection: { data: { avgTimeToAnswer: 25, noDataFlags: { avgTimeToAnswer: true } } },
    intakeNoDataFlags: { avgTimeToAnswer: true },
  });
  assert.equal(eraFlagged.intake, false, "era value under its no-data flag is absent");
  const eraEntered = computeSectionPresence({
    ...baseInput(),
    intakeSection: { data: { avgTimeToAnswer: 25, noDataFlags: {} } },
  });
  assert.equal(eraEntered.intake, true, "era value without a flag counts");
  ok("entry-tracking era semantics respected (flagged era value absent, legacy value present)");

  // A trend month with an entered ZERO is real data (#4226 semantics); a
  // null-only month is not.
  const trendZero = computeSectionPresence({
    ...baseInput(),
    correctedTrendData: [{ month: "2026-05", intake: { leadToConsultRate: 0 } }],
  });
  assert.equal(trendZero.intake, true, "entered-zero trend month counts as intake history");
  const trendNull = computeSectionPresence({
    ...baseInput(),
    correctedTrendData: [{ month: "2026-05", intake: { leadToConsultRate: null } }],
  });
  assert.equal(trendNull.intake, false, "null-only trend month is not data");
  ok("trend history: entered 0 is data, null is not (#4226 semantics)");

  // Marketing lights on any activity axis, not only leads.
  assert.equal(
    computeSectionPresence({ ...baseInput(), marketingSection: { data: { reviewGeneration: { list: { reviews: 2 } } } } }).marketing,
    true, "review-generation activity alone lights marketing",
  );
  assert.equal(computeSectionPresence({ ...baseInput(), totalAdSpend: 100 }).marketing, true, "ad spend alone lights marketing");
  assert.equal(
    computeSectionPresence({ ...baseInput(), hasWebinar: true, webinars: { registrants: 8 } }).marketing,
    true, "webinar activity alone lights marketing",
  );
  ok("marketing presence covers non-lead activity axes");

  // Next 30 Days: either column, the expansion question, or real notes.
  assert.equal(computeSectionPresence({ ...baseInput(), actionsSection: { data: { theirs: [{ action: "x" }] } } }).next30, true);
  assert.equal(computeSectionPresence({ ...baseInput(), actionsSection: { data: { showExpansionQuestion: true } } }).next30, true);
  assert.equal(computeSectionPresence({ ...baseInput(), actionsSection: { data: { showNotes: true, notes: "   " } } }).next30, false, "whitespace notes are not content");
  assert.equal(computeSectionPresence({ ...baseInput(), actionsSection: { data: { showNotes: false, notes: "call" } } }).next30, false, "hidden notes are not content");
  assert.equal(computeSectionPresence({ ...baseInput(), actionsSection: { data: { showNotes: true, notes: "call" } } }).next30, true);
  ok("next-30 presence: columns, expansion question, or shown non-blank notes");

  // Lifetime value shares the slide's own gate (single source).
  assert.equal(hasLifetimeData(null), false);
  assert.equal(hasLifetimeData({ totalLeads: 0, totalReviews: 0, totalCases: 0 }), false);
  assert.equal(hasLifetimeData({ totalLeads: 0, totalReviews: 3, totalCases: 0 }), true);
  assert.equal(
    computeSectionPresence({ ...baseInput(), lifetimeValue: { totalLeads: 0, totalReviews: 3, totalCases: 0 } }).lifetimeValue,
    true,
  );
  ok("lifetime-value presence delegates to the shared hasLifetimeData gate");
}

// ---------------------------------------------------------------------------
// (2) isAgendaRowPresent units — data rows unconditional (Task #4693)
// ---------------------------------------------------------------------------

{
  const none = {
    engineHealth: false, intake: false, sales: false, marketing: false,
    lossAudit: false, lifetimeValue: false, next30: false,
  };
  const flags = { hasCeoPulse: false, hasMarketContext: false };

  // Task #4693: the five data-section rows render UNCONDITIONALLY — empty
  // sections now render full skeletons with an upsell callout, so every row
  // has a destination even on an all-empty presence map.
  for (const target of ["engine-health", "marketing", "closing", "lifetime-value", "next-30-days"]) {
    assert.equal(isAgendaRowPresent(target, { ...flags, sectionPresence: none }), true, `${target} row renders even when its section is empty`);
    assert.equal(isAgendaRowPresent(target, flags), true, `${target} row renders without a presence map`);
  }
  // Conditional NoBull-authored slides keep their existing flags (Task
  // #4277) regardless of the presence map.
  assert.equal(isAgendaRowPresent("ceo-pulse", { ...flags, hasCeoPulse: true, sectionPresence: none }), true);
  assert.equal(isAgendaRowPresent("ceo-pulse", { ...flags, sectionPresence: none }), false);
  assert.equal(isAgendaRowPresent("market-context", { ...flags, hasMarketContext: true, sectionPresence: none }), true);
  assert.equal(isAgendaRowPresent("market-context", { ...flags, sectionPresence: none }), false);
  // Unknown targets never drop (future rows fail open).
  assert.equal(isAgendaRowPresent("book-promo", { ...flags, sectionPresence: none }), true);
  ok("agenda rows: data sections unconditional, conditional flags survive, fail-open");
}

// ---------------------------------------------------------------------------
// (3) Sparse deck SSR through the REAL deriver — skeletons + ONE callout each
// ---------------------------------------------------------------------------

const sparseView: any = derivePublicReportView(rootState(sparseData()));

{
  assert.ok(sparseView.sectionPresence, "the real deriver stamps the presence map");
  for (const key of ALL_SECTIONS) {
    assert.equal(sparseView.sectionPresence[key], false, `deriver: ${key} absent on the sparse report`);
  }
  assert.ok(sparseView.monthLabel, "fixture sanity: deriver produced a month label");

  // Task #4693: every empty data section renders its FULL slide skeleton
  // with exactly ONE gold callout — never a collapse band, never a wall of
  // repeated pitches. Next 30 Days is NoBull-authored content and keeps its
  // #4285 band (out of the upsell's scope).
  const slides: Array<[string, any, string, string]> = [
    ["EngineHealthSlide", EngineHealthSlide, "upsell-engine-health", "empty-engine-health"],
    ["IntakeSlide", IntakeSlide, "upsell-intake", "empty-intake"],
    ["SalesSlide", SalesSlide, "upsell-sales", "empty-sales"],
    ["MarketingSlide", MarketingSlide, "upsell-marketing", "empty-marketing"],
    ["RevenueLeakSlide", RevenueLeakSlide, "upsell-revenue-leak", "empty-revenue-leak"],
    ["LifetimeValueSlide", LifetimeValueSlide, "upsell-lifetime-value", "empty-lifetime-value"],
  ];
  for (const [name, Component, calloutTestId, retiredBandTestId] of slides) {
    const html = ssr(Component, sparseView);
    assert.equal(
      html.split(`data-testid="${calloutTestId}"`).length - 1, 1,
      `${name}: exactly ONE section callout`,
    );
    assert.ok(!html.includes(`data-testid="${retiredBandTestId}"`), `${name}: the #4285 collapse band is retired`);
    assert.equal(
      html.split("CaseIntake™").length - 1, 1,
      `${name}: the pitch appears exactly once (never repeated on cards)`,
    );
    assert.ok(!/No Data/.test(html), `${name}: no title-cased wording`);
  }
  const next30Html = ssr(Next30DaysSlide, sparseView);
  assert.ok(next30Html.includes('data-testid="empty-next-30-days"'), "Next 30 Days keeps its #4285 band (NoBull-authored, out of scope)");
  assert.ok(!next30Html.includes("CaseIntake"), "Next 30 Days carries no upsell");
  ok("all six data sections render full skeletons with exactly ONE callout; Next 30 Days unchanged");

  // Callout copy variants (owner-approved "direct ask" direction). SSR
  // escapes apostrophes, so assert around them.
  const intakeHtml = ssr(IntakeSlide, sparseView);
  assert.ok(
    intakeHtml.includes(`Still waiting on your ${sparseView.t("consults").toLowerCase()} count for ${sparseView.monthLabel} — send it over`),
    "intake callout: month-scoped manual-ask variant using the client's terminology",
  );
  assert.ok(intakeHtml.includes("upgrade to CaseIntake™"), "manual variant offers the upgrade");
  const salesHtml = ssr(SalesSlide, sparseView);
  assert.ok(
    salesHtml.includes(`Still waiting on your ${sparseView.t("cases").toLowerCase()} count`),
    "sales callout: manual-ask variant names the cases count",
  );
  const upgradeCopy = `${NO_DATA_LABEL} — CaseIntake™ tracks this automatically. Ask us about upgrading.`;
  const marketingHtml = ssr(MarketingSlide, sparseView);
  assert.ok(marketingHtml.includes(upgradeCopy), "marketing callout: upgrade-only variant");
  const ltvHtml = ssr(LifetimeValueSlide, sparseView);
  assert.ok(ltvHtml.includes(upgradeCopy), "lifetime-value callout: upgrade-only, month-free (not month-scoped)");
  assert.ok(!ltvHtml.includes(`for ${sparseView.monthLabel}`), "lifetime-value copy carries no month clause");
  ok("callout copy: manual-ask (month + terminology) vs upgrade-only variants");

  // Skeletons show muted slots and quiet placeholder frames — no fabricated
  // zero-value charts, no zeroed metrics.
  assert.ok(intakeHtml.includes('data-testid="chart-placeholder-intake"'), "intake trend area renders the placeholder frame");
  assert.ok(salesHtml.includes('data-testid="chart-placeholder-sales"'), "sales trend area renders the placeholder frame");
  assert.ok(marketingHtml.includes('data-testid="chart-placeholder-marketing"'), "marketing source-chart area renders the placeholder frame");
  assert.ok(ltvHtml.includes('data-testid="chart-placeholder-lifetime-value"'), "lifetime-value arc area renders the placeholder frame");
  assert.ok(marketingHtml.includes('data-testid="text-marketing-hero-missing"'), "marketing hero is a muted no-data slot, not a 0");
  const engineHtml = ssr(EngineHealthSlide, sparseView);
  assert.ok(engineHtml.includes('data-testid="text-engine-flow-leads-missing"'), "engine funnel leads cell is a muted no-data slot");
  assert.ok(engineHtml.includes('data-testid="text-engine-marketing-missing"'), "engine marketing row is a muted no-data slot, not '0 leads generated'");
  assert.ok(engineHtml.includes('data-testid="text-engine-hero-revenue-missing"'), "engine hero stays the muted hero-scale no-data slot on a fully-empty month");
  assert.ok(!engineHtml.includes('data-testid="text-engine-hero-leads"'), "no leads hero on a fully-empty month (Task #4841 — never a fabricated 0 hero)");
  // Task #4982 — nothing to disclose on a fully-empty month: no Other-leads
  // clarifier on the marketing hero, the engine hero, or the status row.
  assert.ok(!marketingHtml.includes("text-total-leads-other-annotation"), "no Other-leads disclosure on the empty marketing hero (Task #4982)");
  assert.ok(!engineHtml.includes("text-engine-hero-leads-other-note"), "no Other-leads clarifier under the empty engine hero (Task #4982)");
  assert.ok(!engineHtml.includes("text-engine-marketing-other-note"), "no compact Other clarifier on the empty Marketing status row (Task #4982)");
  const leakHtml = ssr(RevenueLeakSlide, sparseView);
  assert.ok(leakHtml.includes('data-testid="text-funnel-leads-missing"'), "leak funnel leads cell is a muted no-data slot");
  ok("skeletons: muted slots + placeholder frames, never fabricated zeros");

  // Skeleton slides keep their anchor ids — the strip/anchors still resolve.
  const anchorPairs: Array<[any, string]> = [
    [EngineHealthSlide, 'id="engine-health"'], [IntakeSlide, 'id="intake"'],
    [SalesSlide, 'id="sales"'], [MarketingSlide, 'id="marketing"'],
    [RevenueLeakSlide, 'id="closing"'], [Next30DaysSlide, 'id="next-30-days"'],
  ];
  for (const [Component, anchor] of anchorPairs) {
    assert.ok(ssr(Component, sparseView).includes(anchor), `skeleton slide keeps ${anchor}`);
  }
  ok("skeleton slides keep their slide ids (anchors, strip, print)");

  // Agenda end-to-end (Task #4693): the sparse deck's roadmap lists ALL five
  // data sections (each now has a rendered destination); conditional slides
  // still drop without their flags; the retired #4496 placeholder is gone.
  const agendaHtml = ssr(AgendaSlide, sparseView);
  for (const target of ["engine-health", "marketing", "closing", "lifetime-value", "next-30-days"]) {
    assert.ok(agendaHtml.includes(`data-testid="link-agenda-${target}"`), `agenda row ${target} renders on the sparse deck`);
  }
  for (const target of ["ceo-pulse", "market-context"]) {
    assert.ok(!agendaHtml.includes(`data-testid="link-agenda-${target}"`), `conditional agenda row ${target} still drops without its flag`);
  }
  assert.ok(!agendaHtml.includes('data-testid="empty-agenda"'), "the all-empty roadmap placeholder is retired (rows can never all drop)");
  ok("sparse deck agenda lists all five data sections; conditional flags survive");

  // Populated control: an all-true presence map keeps every row.
  const fullAgendaView: any = {
    prefersReducedMotion: true, hasCeoPulse: true, hasMarketContext: true,
    slideNumbers: SLIDE_NUMBERS,
    sectionPresence: {
      engineHealth: true, intake: true, sales: true, marketing: true,
      lossAudit: true, lifetimeValue: true, next30: true,
    },
  };
  const fullAgendaHtml = ssr(AgendaSlide, fullAgendaView);
  for (const target of ["ceo-pulse", "market-context", "engine-health", "marketing", "closing", "lifetime-value", "next-30-days"]) {
    assert.ok(fullAgendaHtml.includes(`data-testid="link-agenda-${target}"`), `agenda row ${target} present when its section has data`);
  }
  assert.ok(!fullAgendaHtml.includes('data-testid="empty-agenda"'), "populated roadmap has no placeholder");
  ok("populated agenda keeps all rows");

  // Fail-open control (Task #4496): a hand-built view WITHOUT a presence map
  // renders every row — the placeholder must never appear by accident.
  const noMapView: any = {
    prefersReducedMotion: true, hasCeoPulse: false, hasMarketContext: false,
    slideNumbers: SLIDE_NUMBERS,
  };
  const noMapHtml = ssr(AgendaSlide, noMapView);
  assert.ok(!noMapHtml.includes('data-testid="empty-agenda"'), "no placeholder without a presence map");
  assert.ok(noMapHtml.includes('data-testid="link-agenda-engine-health"'), "fail-open agenda keeps its rows");
  ok("agenda placeholder respects the fail-open contract (no presence map → full rows)");
}

// ---------------------------------------------------------------------------
// (4) Badge suppression — no badge asserts a status over absent data
// ---------------------------------------------------------------------------

{
  // Marketing posture: reviews-only report (0 leads) renders the FULL slide
  // (review activity is content) but NO posture badge — the audit's
  // "'Scaling' over 0 leads". Stored posture defaults to 'scaling'.
  const reviewsOnly = sparseData();
  reviewsOnly.sections[2].data = { reviewGeneration: { list: { reviews: 6, activationRate: 10 } } };
  const reviewsView: any = derivePublicReportView(rootState(reviewsOnly));
  assert.equal(reviewsView.sectionPresence.marketing, true, "review activity keeps the full marketing slide");
  const reviewsHtml = ssr(MarketingSlide, reviewsView);
  assert.ok(!reviewsHtml.includes('data-testid="empty-marketing"'), "full slide, not the band");
  for (const label of ["Scaling", "Ramp-Up", "Establishing Baseline", "Stable"]) {
    assert.ok(!reviewsHtml.includes(`>${label}<`), `no '${label}' posture badge over 0 leads`);
  }
  ok("marketing posture badge suppressed at zero lead volume (full slide keeps rendering)");

  // Task #4850: this slide visibly HAS data (6 reviews), so the callout must
  // name the actual gap (zero leads) — never the whole-section generic line.
  assert.ok(
    reviewsHtml.includes(buildMarketingLeadsGapUpsellMessage(reviewsView.monthLabel, reviewsView.t("leads").toLowerCase())),
    "reviews-only slide: callout names the leads gap (terminology-aware, month-scoped)",
  );
  assert.ok(
    !reviewsHtml.includes(buildUpgradeUpsellMessage()),
    "reviews-only slide: the generic whole-section line never renders beside visible review data",
  );
  assert.equal(reviewsHtml.split('data-testid="upsell-marketing"').length - 1, 1, "still exactly ONE callout");
  assert.equal(reviewsHtml.split("CaseIntake™").length - 1, 1, "still exactly one CaseIntake™ mention");
  ok("reviews-only marketing slide: leads-gap variant, generic line banned (Task #4850)");

  // Control: with lead volume the badge returns.
  const withLeads = sparseData();
  withLeads.sections[2].data = {
    gbp: { locations: [{ uniqueLeads: 26, leadQuality: { good: 10, notQuotable: 5, missedCalls: 11, noData: 0 } }] },
  };
  const leadsView: any = derivePublicReportView(rootState(withLeads));
  assert.ok(leadsView.totalLeads > 0, "fixture sanity: leads entered");
  const leadsHtml = ssr(MarketingSlide, leadsView);
  assert.ok(leadsHtml.includes(">Scaling<"), "populated slide keeps its posture badge (default posture)");
  ok("populated marketing keeps the posture badge (suppression is no-data-only)");

  // Task #4850: 26 leads entered but zero reviews recorded — the callout
  // names the reviews gap. The generic line would falsely claim the whole
  // section is empty next to a populated lead hero.
  assert.ok(
    leadsHtml.includes(buildMarketingReviewsGapUpsellMessage(leadsView.monthLabel)),
    "leads-without-reviews slide: callout names the reviews gap",
  );
  assert.ok(
    !leadsHtml.includes(buildUpgradeUpsellMessage()),
    "leads-without-reviews slide: no generic whole-section line beside visible lead data",
  );
  assert.equal(leadsHtml.split('data-testid="upsell-marketing"').length - 1, 1, "still exactly ONE callout");
  assert.equal(leadsHtml.split("CaseIntake™").length - 1, 1, "still exactly one CaseIntake™ mention");
  ok("leads-without-reviews marketing slide: reviews-gap variant (Task #4850)");

  // Engine Health rows: consults entered (slide renders) but 0 leads and no
  // rates — the marketing row count stands untagged and the missing-rate
  // rows keep their explanatory text with NO neutral tag.
  const consultsOnly = sparseData();
  consultsOnly.sections[0].data = { totalConsults: 5, noDataFlags: {} };
  const engineView: any = derivePublicReportView(rootState(consultsOnly));
  assert.equal(engineView.sectionPresence.engineHealth, true, "consult volume keeps the full engine slide");
  const engineHtml = ssr(EngineHealthSlide, engineView);
  assert.ok(!engineHtml.includes('data-testid="empty-engine-health"'), "full slide, not the band");
  assert.ok(!engineHtml.includes('data-testid="tag-engine-marketing"'), "no posture tag over 0 leads");
  assert.ok(engineHtml.includes('data-testid="text-engine-intake-missing"'), "missing intake rate keeps its explanatory text");
  assert.ok(!engineHtml.includes("tag-engine-intake-missing"), "…but no neutral tag beside it");
  assert.ok(engineHtml.includes('data-testid="text-engine-sales-missing"'), "missing sales rate keeps its explanatory text");
  assert.ok(!engineHtml.includes("tag-engine-sales-missing"), "…and no neutral tag there either");
  // Task #4841: zero/untracked leads keep the hero-scale muted revenue slot —
  // the leads hero must never fabricate a 0.
  assert.ok(engineHtml.includes('data-testid="text-engine-hero-revenue-missing"'), "zero-lead partial month keeps the muted revenue hero");
  assert.ok(!engineHtml.includes('data-testid="text-engine-hero-leads"'), "no fabricated 0-lead hero");
  assert.ok(
    !engineHtml.includes("text-engine-hero-leads-other-note") && !engineHtml.includes("text-engine-marketing-other-note"),
    "zero-lead month renders no Other-leads disclosure clarifiers (Task #4982)",
  );
  assert.ok(!/No Data/.test(engineHtml), "no title-cased wording on the partial engine slide");

  // Control: entered leads restore the marketing posture tag — and flip the
  // hero into the Task #4841 partial-data state: revenue still can't compute,
  // so the leads count leads the slide at full hero scale (crimson
  // hero-metric) under the terminology-aware eyebrow, the revenue miss
  // shrinks to ONE compact muted line (SSR-escaped apostrophe), and the
  // hero-scale no-data slot retires. The gold callout stays exactly one.
  const engineWithLeads = sparseData();
  // Task #4982 — make gbp ACTIVE: with sparseData's products:[] the deriver
  // folds these 26 gbp leads into the Other bucket (inactive-product
  // folding), which would make this a 26-Other month. Activating the product
  // keeps every pinned assert (totalLeads 26, hero, tag, callout) and turns
  // the fixture into the true zero-Other control the disclosure asserts need.
  engineWithLeads.client.products = ["gbp"];
  engineWithLeads.sections[0].data = { totalConsults: 5, noDataFlags: {} };
  engineWithLeads.sections[2].data = {
    gbp: { locations: [{ uniqueLeads: 26, leadQuality: { good: 10, notQuotable: 5, missedCalls: 11, noData: 0 } }] },
  };
  const engineLeadsView: any = derivePublicReportView(rootState(engineWithLeads));
  assert.equal(engineLeadsView.engineFunnel.estTopLineRevenue, null, "fixture sanity: revenue still not computable");
  assert.equal(engineLeadsView.totalLeads, 26, "fixture sanity: 26 leads entered");
  const engineLeadsHtml = ssr(EngineHealthSlide, engineLeadsView);
  assert.ok(engineLeadsHtml.includes('data-testid="tag-engine-marketing"'), "entered volume restores the posture tag");
  assert.ok(
    engineLeadsHtml.includes('class="report-hero-metric text-report-crimson" data-testid="text-engine-hero-leads">26<'),
    "leads count takes the hero at full hero scale (crimson hero-metric)",
  );
  assert.ok(
    engineLeadsHtml.includes(`Leads Generated — ${engineLeadsView.monthLabel}`),
    "terminology-aware eyebrow labels the leads hero",
  );
  assert.ok(
    engineLeadsHtml.includes("Est. top-line revenue: No data — we&#x27;ll estimate it once you share this month&#x27;s cases and average case value"),
    "revenue miss shrinks to one compact muted line",
  );
  assert.ok(!engineLeadsHtml.includes('data-testid="text-engine-hero-revenue-missing"'), "hero-scale no-data slot retired on a month with real leads");
  assert.ok(!engineLeadsHtml.includes('data-testid="text-engine-hero-revenue"'), "no fabricated revenue hero");
  assert.equal(
    engineLeadsHtml.split('data-testid="upsell-engine-health"').length - 1,
    1,
    "partial month keeps exactly ONE gold callout",
  );
  // Task #4854: with leads present the callout opens with "Missing <metric>
  // for <month>" instead of the fully-empty "No data for <month>", which
  // would be dishonest next to the visible leads hero. The fixture has
  // consults entered (5) and cases missing, so manualLabel → "cases".
  assert.ok(
    engineLeadsHtml.includes(
      `Missing ${engineLeadsView.t("cases").toLowerCase()} for ${engineLeadsView.monthLabel}`,
    ),
    "partial month callout opens with 'Missing cases for <month>' (not 'No data for <month>')",
  );
  assert.ok(
    !engineLeadsHtml.includes(`${NO_DATA_LABEL} for ${engineLeadsView.monthLabel}`),
    "partial month callout does not claim 'No data for <month>' when the slide shows real leads",
  );
  assert.ok(!/No Data/.test(engineLeadsHtml), "no title-cased wording on the leads-hero slide");
  // Task #4982 — zero-Other month: the disclosure clarifiers are presence-
  // gated on the derive layer's final otherLeadsCount, so a leads-hero month
  // WITHOUT an Other bucket renders neither (byte-identical to pre-#4982).
  assert.ok(
    !engineLeadsHtml.includes("text-engine-hero-leads-other-note"),
    "leads hero with zero Other leads renders NO disclosure clarifier (Task #4982)",
  );
  assert.ok(
    !engineLeadsHtml.includes("text-engine-marketing-other-note"),
    "Marketing status row with zero Other leads renders NO compact clarifier (Task #4982)",
  );
  ok("engine-health: badge suppression + #4841 partial-data leads hero (full-scale leads, compact revenue miss)");

  // Task #4982 — Other-leads disclosure on the leads-hero month: when the
  // displayed total INCLUDES a non-zero "Other" bucket (leads NoBull does
  // not attribute to its campaigns), the hero carries the clarifier with the
  // ACTUAL count (SSR escapes the rendered quotes to &quot;) and the
  // Marketing status row gets the compact count-only version. Both gate on
  // the same derive-layer otherLeadsCount the totals carry, so disclosure
  // and totals can never disagree.
  const engineWithOther = sparseData();
  // gbp ACTIVE here too, so the explicit otherLeads bucket is the ONLY Other
  // contribution and the disclosed count is exactly 34 (no inactive-product
  // folding on top).
  engineWithOther.client.products = ["gbp"];
  engineWithOther.sections[0].data = { totalConsults: 5, noDataFlags: {} };
  engineWithOther.sections[2].data = {
    gbp: { locations: [{ uniqueLeads: 26, leadQuality: { good: 10, notQuotable: 5, missedCalls: 11, noData: 0 } }] },
    otherLeads: { count: 34, description: "" },
  };
  const engineOtherView: any = derivePublicReportView(rootState(engineWithOther));
  assert.equal(engineOtherView.engineFunnel.estTopLineRevenue, null, "fixture sanity: revenue still not computable");
  assert.equal(engineOtherView.otherLeadsCount, 34, "fixture sanity: the deriver exposes the final Other count");
  assert.equal(engineOtherView.totalLeads, 60, "fixture sanity: 26 GBP + 34 Other in the displayed total");
  const engineOtherHtml = ssr(EngineHealthSlide, engineOtherView);
  const leadsWord = engineOtherView.t("leads").toLowerCase();
  assert.ok(
    engineOtherHtml.includes(
      `data-testid="text-engine-hero-leads-other-note">includes 34 &quot;Other&quot; ${leadsWord} — not attributed to our campaigns<`,
    ),
    "leads hero carries the Other-leads clarifier with the actual count and attribution tail",
  );
  assert.ok(
    engineOtherHtml.includes(
      `data-testid="text-engine-marketing-other-note">includes 34 &quot;Other&quot; ${leadsWord}<`,
    ),
    "Marketing status row carries the compact Other-leads clarifier",
  );
  assert.ok(
    engineOtherHtml.includes('data-testid="text-engine-hero-leads">60<'),
    "hero still renders the FULL total (60) — the disclosure annotates, never re-computes",
  );
  ok("engine-health: Task #4982 Other-leads disclosure — clarifier + compact row note when Other > 0, absent at zero");

  // Task #4845 — average case value is CLIENT-supplied: when consults and
  // cases are entered and ONLY the avg case value is missing, the gold
  // callout on Engine Health AND Revenue Leak must attribute the gap to the
  // client (month-scoped "waiting on your …" value variant), never the
  // generic "No data — CaseIntake™ tracks this automatically" pitch (that
  // wording would read as NoBull withholding data on a client-side gap).
  const acvOnly = sparseData();
  acvOnly.sections[0].data = { totalConsults: 8, noDataFlags: {} };
  acvOnly.sections[1].data = { totalCases: 3, noDataFlags: { averageCaseValue: true } };
  acvOnly.sections[2].data = {
    gbp: { locations: [{ uniqueLeads: 26, leadQuality: { good: 10, notQuotable: 5, missedCalls: 11, noData: 0 } }] },
  };
  const acvView: any = derivePublicReportView(rootState(acvOnly));
  assert.equal(acvView.hasConsultsData, true, "fixture sanity: consults entered");
  assert.equal(acvView.hasCasesData, true, "fixture sanity: cases entered");
  assert.equal(acvView.hasAvgCaseValueData, false, "fixture sanity: avg case value missing");
  assert.equal(acvView.engineFunnel.estTopLineRevenue, null, "fixture sanity: revenue not computable without avg case value");
  const acvMsg = `Still waiting on your ${acvView.t("averageCaseValue").toLowerCase()} for ${acvView.monthLabel} — send it over, or upgrade to CaseIntake™ and it&#x27;s tracked automatically.`;
  const genericPitch = "CaseIntake™ tracks this automatically";
  const acvEngineHtml = ssr(EngineHealthSlide, acvView);
  assert.ok(acvEngineHtml.includes(acvMsg), "engine callout: ACV-only gap gets the client-attributed value variant");
  assert.ok(!acvEngineHtml.includes(genericPitch), "engine callout: never the generic pitch on a client-side ACV gap");
  assert.equal(acvEngineHtml.split('data-testid="upsell-engine-health"').length - 1, 1, "still exactly ONE engine callout");
  const acvLeakHtml = ssr(RevenueLeakSlide, acvView);

  const casesGap = sparseData();
  const gbpLoc = { uniqueLeads: 26, reviewsGenerated: 4, leadQuality: { good: 10, notQuotable: 5, missedCalls: 11, noData: 0 } };

  // Paid-media client, leads AND reviews present, $0 recorded ad spend →
  // the callout names the ad-spend gap only.
  const spendGap = sparseData();
  spendGap.client.products = ["gbp", "google_ads"];
  spendGap.sections[2].data = {
    gbp: { locations: [gbpLoc] },
    googleAds: { uniqueLeads: 12, adSpend: 0, leadQuality: { good: 6, notQuotable: 2, missedCalls: 4, noData: 0 } },
  };
  const spendView: any = derivePublicReportView(rootState(spendGap));
  assert.ok(spendView.totalLeads > 0 && spendView.gbpTotalReviews > 0, "fixture sanity: leads and reviews entered");
  assert.equal(spendView.totalAdSpend, 0, "fixture sanity: paid-media client with $0 recorded spend");
  const spendHtml = ssr(MarketingSlide, spendView);
  assert.ok(
    spendHtml.includes(buildMarketingAdSpendGapUpsellMessage(spendView.monthLabel)),
    "paid-media $0-spend slide: callout names the ad-spend gap",
  );
  assert.ok(!spendHtml.includes(buildUpgradeUpsellMessage()), "no generic line beside visible lead/review data");
  assert.equal(spendHtml.split('data-testid="upsell-marketing"').length - 1, 1, "exactly ONE callout");
  assert.equal(spendHtml.split("CaseIntake™").length - 1, 1, "exactly one CaseIntake™ mention");
  ok("paid-media $0-spend marketing slide: ad-spend-gap variant (Task #4850)");

  // Both gaps at once (leads present, zero reviews, paid-media $0 spend) →
  // ONE combined sentence, still one callout.
  const bothGaps = sparseData();
  bothGaps.client.products = ["gbp", "lsa"];
  bothGaps.sections[2].data = {
    gbp: { locations: [{ uniqueLeads: 18, leadQuality: { good: 9, notQuotable: 3, missedCalls: 6, noData: 0 } }] },
    lsa: { uniqueLeads: 7, adSpend: 0 },
  };
  const bothView: any = derivePublicReportView(rootState(bothGaps));
  assert.ok(bothView.totalLeads > 0, "fixture sanity: leads entered");
  assert.equal(bothView.gbpTotalReviews, 0, "fixture sanity: no reviews recorded");
  assert.equal(bothView.totalAdSpend, 0, "fixture sanity: $0 recorded spend on an LSA client");
  const bothHtml = ssr(MarketingSlide, bothView);
  assert.ok(
    bothHtml.includes(buildMarketingReviewsAndAdSpendGapUpsellMessage(bothView.monthLabel)),
    "both-gaps slide: one combined sentence names reviews AND ad spend",
  );
  assert.ok(!bothHtml.includes(buildUpgradeUpsellMessage()), "no generic line beside visible lead data");
  assert.equal(bothHtml.split('data-testid="upsell-marketing"').length - 1, 1, "exactly ONE callout (never stacked)");
  assert.equal(bothHtml.split("CaseIntake™").length - 1, 1, "exactly one CaseIntake™ mention");
  ok("both-gaps marketing slide: combined reviews+ad-spend variant (Task #4850)");

  // All present (leads, reviews, spend on a paid-media client) → NO callout.
  const allPresent = sparseData();
  allPresent.client.products = ["gbp", "google_ads"];
  allPresent.sections[2].data = {
    gbp: { locations: [gbpLoc] },
    googleAds: { uniqueLeads: 12, adSpend: 2500, leadQuality: { good: 6, notQuotable: 2, missedCalls: 4, noData: 0 } },
  };
  const allView: any = derivePublicReportView(rootState(allPresent));
  assert.ok(allView.totalLeads > 0 && allView.gbpTotalReviews > 0 && allView.totalAdSpend > 0, "fixture sanity: nothing missing");
  const allHtml = ssr(MarketingSlide, allView);
  assert.ok(!allHtml.includes('data-testid="upsell-marketing"'), "nothing missing → no callout at all");
  assert.ok(!allHtml.includes("CaseIntake"), "no stray pitch on a fully-populated slide");
  ok("fully-populated marketing slide: no callout (Task #4850 leaves the no-gap state untouched)");
}

// ---------------------------------------------------------------------------
// (5) Fail-open — hand-built views WITHOUT the presence map never collapse
// ---------------------------------------------------------------------------

{
  const strippedView: any = { ...sparseView, sectionPresence: undefined };
  const html = ssr(IntakeSlide, strippedView);
  assert.ok(!html.includes('data-testid="chart-placeholder-intake"'), "skeleton mode never engages without a presence map");
  assert.ok(html.includes('data-testid="core-metric-lead-to-consult"'), "full slide renders (per-metric no-data cards)");
  ok("slides fail open without the presence map (hand-built partial views keep working)");
}

// ---------------------------------------------------------------------------
// (6) #4226 regression — delta chips never assert change over absent baselines
// ---------------------------------------------------------------------------

{
  const oneMonth = buildTrendMetricSeries(
    [{ month: "2026-05", intake: { leadToConsultRate: 40 } }, { month: "2026-06", intake: { leadToConsultRate: null } }] as any,
    "intake",
    { key: "leadToConsultRate", unit: "%" },
  );
  assert.equal(oneMonth.dataCount, 1);
  assert.equal(oneMonth.deltaPair, null, "one data month → no delta chip (no baseline to compare against)");

  const zeroBaseline = buildTrendMetricSeries(
    [{ month: "2026-05", intake: { leadToConsultRate: 0 } }, { month: "2026-06", intake: { leadToConsultRate: 5 } }] as any,
    "intake",
    { key: "leadToConsultRate", unit: "%" },
  );
  assert.equal(zeroBaseline.dataCount, 2, "an entered zero IS a baseline");
  assert.deepEqual(zeroBaseline.deltaPair, {
    previous: { month: "2026-05", value: 0 },
    current: { month: "2026-06", value: 5 },
  });
  ok("delta chips: null under 2 data months; entered zero counts as a real baseline (#4226)");
}

// ---------------------------------------------------------------------------
// (7) Source scan — ONE wording deck-wide (title-cased form banned)
// ---------------------------------------------------------------------------

{
  const dir = path.join(process.cwd(), "client/src/pages/publicReport");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => path.join(dir, f));
  files.push(path.join(process.cwd(), "client/src/pages/PublicReport.tsx"));
  const offenders = files.filter((f) => /No Data/.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    offenders.map((f) => path.basename(f)),
    [],
    "title-cased no-data wording must not reappear anywhere in the slide modules (canonical: NO_DATA_LABEL)",
  );
  assert.equal(NO_DATA_LABEL, "No data", "the canonical label is sentence-case");
  ok("source scan: slide directory + PublicReport.tsx free of the title-cased wording");
}

// ---------------------------------------------------------------------------
// (8) Print atomicity (Tasks #4715/#4747) — the callout band and placeholder
// frame must never split across a Save-as-PDF page break. The contract is an
// EXPLICIT `break-inside: avoid` rule in client/src/index.css @media print
// targeting `[data-testid^="upsell-"]` and `[data-testid^="chart-placeholder-"]`
// (the old contract rode a literal `rounded-lg` class on the roots and
// silently died when that class was dropped — hence the explicit rule).
// This block pins: (a) the rule exists, (b) the roots surface the testid the
// rule targets, (c) every call site's testId keeps the load-bearing prefix.
// End-to-end enforcement: the sparse page-break smoke check + its
// --page-break-selftest negative proof (scripts/report-smoke-check.ts).
// ---------------------------------------------------------------------------

{
  const printCss = readFileSync(path.join(process.cwd(), "client/src/index.css"), "utf8");
  const printBlock = printCss.slice(printCss.indexOf("@media print {"));
  assert.match(
    printBlock,
    /\[data-testid\^="upsell-"\],\s*\[data-testid\^="chart-placeholder-"\]\s*\{[^}]*break-inside:\s*avoid/,
    "client/src/index.css @media print must keep the explicit break-inside: avoid rule for upsell-*/chart-placeholder-* testids",
  );

  for (const [name, prefix, markup] of [
    [
      "SectionUpsellCallout",
      "upsell-",
      renderToStaticMarkup(
        React.createElement(SectionUpsellCallout, { message: "m", variant: "dark", testId: "upsell-t" }),
      ),
    ],
    [
      "ChartPlaceholderFrame",
      "chart-placeholder-",
      renderToStaticMarkup(
        React.createElement(ChartPlaceholderFrame, { label: "l", variant: "dark", testId: "chart-placeholder-t" }),
      ),
    ],
  ] as const) {
    assert.ok(
      markup.includes(`data-testid="${prefix}t"`),
      `${name} root must surface data-testid — it is the print atomicity hook, not just a test hook`,
    );
  }

  // Call-site prefixes: a testId outside the rule's prefix silently falls
  // out of the print contract (and out of the smoke check's marker tint).
  const dir = path.join(process.cwd(), "client/src/pages/publicReport");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".tsx") && f !== "EmptyState.tsx")) {
    const src = readFileSync(path.join(dir, f), "utf8");
    for (const [comp, prefix] of [
      ["SectionUpsellCallout", "upsell-"],
      ["ChartPlaceholderFrame", "chart-placeholder-"],
    ] as const) {
      const re = new RegExp(`<${comp}[\\s\\S]*?testId="([^"]*)"`, "g");
      for (let m = re.exec(src); m; m = re.exec(src)) {
        assert.ok(
          m[1].startsWith(prefix),
          `${f}: ${comp} testId "${m[1]}" must start with "${prefix}" — the explicit print break-inside rule and the smoke marker tint key on that prefix`,
        );
      }
    }
  }
  ok("print atomicity: explicit testid print rule present; roots + call sites keep the load-bearing prefixes");
}

console.log(`report-empty-states: PASSED (${passed} checks)`);
process.exit(0);

  const casesLower = casesGapView.t("cases").toLowerCase();

  const casesGapView: any = derivePublicReportView(rootState(casesGap));

  const casesGapHtml = ssr(EngineHealthSlide, casesGapView);
