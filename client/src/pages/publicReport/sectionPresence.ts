/**
 * Section data-presence map (Task #4285 — audit backlog #17 + §8.6;
 * repurposed by Task #4693's no-data upsell convention).
 *
 * ONE presence bit per major deck section. Since Task #4693 empty sections
 * NEVER collapse and agenda rows never drop out — the bit now drives:
 * - skeleton mode: a fully-empty section renders its full slide layout with
 *   muted "No data" slots and quiet chart placeholder frames (never
 *   fabricated zero charts);
 * - the single gold CaseIntake™ upsell callout per section and its
 *   manual-vs-upgrade copy variant;
 * - badge/status-tag suppression over absent data (unchanged from #4285).
 *
 * The predicates reuse the SAME presence-gated derivations the slides
 * render (Task #3688 semantics — noDataFlags KEY presence is the era
 * marker; the shared helpers in @shared/reportMetrics decide entered vs
 * blank-coerced 0, and those boundaries are NOT redefined here): a section
 * is "present" exactly when at least one of the things its slide can show
 * — a gated metric, a common-issues block, or a usable historical trend
 * point — exists. Presence deliberately errs open: when ANY renderable
 * signal exists the full slide renders and per-metric absences keep their
 * compact neutral-card treatment.
 *
 * Consumers fail open on a missing map (`view.sectionPresence?.x ?? true`):
 * the real deriver always stamps it, but hand-built partial views (tests,
 * embeddings) must never collapse a slide by accident.
 */

import { displayedSupportingMetric, sectionHasEntryTracking } from "@shared/reportMetrics";
import { parseCommonIssuesForPresentation } from "./commonIssuesPresentation";

export interface SectionPresence {
  engineHealth: boolean;
  intake: boolean;
  sales: boolean;
  marketing: boolean;
  /** Revenue Leak Analysis (slide id "closing"). */
  lossAudit: boolean;
  lifetimeValue: boolean;
  next30: boolean;
}

/**
 * The Lifetime Value slide's long-standing data gate, shared so the slide
 * and the presence map can never disagree (single source, §8.5 precedent).
 */
export function hasLifetimeData(
  lifetimeValue: { totalLeads?: number; totalReviews?: number; totalCases?: number } | null | undefined,
): boolean {
  return (
    !!lifetimeValue &&
    ((lifetimeValue.totalLeads ?? 0) > 0 ||
      (lifetimeValue.totalReviews ?? 0) > 0 ||
      (lifetimeValue.totalCases ?? 0) > 0)
  );
}

/** A trend month has usable data for a section when any metric is a real number (nulls are the server's "not provided" gaps — Task #3688). */
function trendHasSectionData(trendData: any[] | null | undefined, section: "intake" | "sales"): boolean {
  return (trendData ?? []).some((m: any) => {
    const bag = m?.[section];
    if (!bag || typeof bag !== "object") return false;
    return Object.values(bag).some((v) => typeof v === "number");
  });
}

/** Marketing trend months always carry numbers; only non-zero volume counts as activity. */
function trendHasMarketingActivity(trendData: any[] | null | undefined): boolean {
  return (trendData ?? []).some(
    (m: any) => (m?.marketing?.totalLeads ?? 0) > 0 || (m?.marketing?.totalReviews ?? 0) > 0,
  );
}

export interface SectionPresenceInput {
  intakeSection: { data?: any } | undefined;
  salesSection: { data?: any } | undefined;
  marketingSection: { data?: any } | undefined;
  actionsSection: { data?: any } | undefined;
  lifetimeValue: { totalLeads?: number; totalReviews?: number; totalCases?: number } | null | undefined;
  totalLeads: number;
  hasConsultsData: boolean;
  hasLeadToConsultData: boolean;
  hasCasesData: boolean;
  hasConsultToCaseData: boolean;
  hasAvgCaseValueData: boolean;
  displayedMissedCallRate: number | null;
  intakeExecutionScore: number | null;
  effectiveSalesQuality: number | null;
  pipelineMomentumIndex: number | null;
  intakeNoDataFlags: Record<string, boolean>;
  salesNoDataFlags: Record<string, boolean>;
  gbpLocations: any[];
  gbpTotalReviews: number;
  totalAdSpend: number;
  webinars: { registrants?: number; attendees?: number; hotTransfers?: number };
  hasWebinar: boolean;
  trendData: any[] | null | undefined;
  correctedTrendData: any[] | null | undefined;
}

export function computeSectionPresence(input: SectionPresenceInput): SectionPresence {
  // Engine Health & Revenue Leak both read the shared pipeline: any entered
  // stage lights them up (leads volume, consults/cases counts, either
  // conversion rate, or an entered avg case value).
  const pipelineEntered =
    input.totalLeads > 0 ||
    input.hasConsultsData ||
    input.hasCasesData ||
    input.hasLeadToConsultData ||
    input.hasConsultToCaseData ||
    input.hasAvgCaseValueData;

  // Intake — exactly the signals its slide can render: the core rate, the
  // consult count, the resolved missed-call rate (bucket-backed or pushed,
  // null = "No data" per Task #4983), the entry-tracked
  // avg-time-to-answer, the execution score, a common-issues block, or a
  // usable historical trend point.
  const intakeAvgTimeToAnswer = displayedSupportingMetric(
    input.intakeSection?.data?.avgTimeToAnswer,
    input.intakeNoDataFlags.avgTimeToAnswer,
    sectionHasEntryTracking(input.intakeSection?.data),
  );
  const intakeIssues = parseCommonIssuesForPresentation(input.intakeSection?.data?.commonIssues);
  const intake =
    input.hasLeadToConsultData ||
    input.hasConsultsData ||
    input.displayedMissedCallRate !== null ||
    intakeAvgTimeToAnswer !== null ||
    input.intakeExecutionScore !== null ||
    intakeIssues.kind !== "empty" ||
    trendHasSectionData(input.correctedTrendData, "intake");

  // Sales — analogous set for its slide.
  const salesNoShowRate = displayedSupportingMetric(
    input.salesSection?.data?.noShowRate,
    input.salesNoDataFlags.noShowRate,
    sectionHasEntryTracking(input.salesSection?.data),
    { clampAsPercent: true },
  );
  const salesIssues = parseCommonIssuesForPresentation(input.salesSection?.data?.commonIssues);
  const sales =
    input.hasConsultToCaseData ||
    input.hasCasesData ||
    input.hasAvgCaseValueData ||
    salesNoShowRate !== null ||
    input.effectiveSalesQuality !== null ||
    input.pipelineMomentumIndex !== null ||
    salesIssues.kind !== "empty" ||
    trendHasSectionData(input.trendData, "sales");

  // Marketing — any lead volume (incl. webinar equivalents/Other), a GBP
  // location entry (heatmap/zone content), reviews, review-generation
  // activity, ad spend, webinar activity, or historical lead/review volume.
  const reviewGen = input.marketingSection?.data?.reviewGeneration;
  const reviewGenTotal =
    (reviewGen?.list?.reviews || 0) + (reviewGen?.webinar?.reviews || 0) + (reviewGen?.other?.count || 0);
  const webinarActivity =
    input.hasWebinar &&
    ((input.webinars.registrants || 0) > 0 ||
      (input.webinars.attendees || 0) > 0 ||
      (input.webinars.hotTransfers || 0) > 0);
  const marketing =
    input.totalLeads > 0 ||
    input.gbpLocations.length > 0 ||
    input.gbpTotalReviews > 0 ||
    reviewGenTotal > 0 ||
    input.totalAdSpend > 0 ||
    webinarActivity ||
    trendHasMarketingActivity(input.trendData);

  // Next 30 Days — either action column, the expansion question, or notes.
  const actionsData = input.actionsSection?.data;
  const next30 =
    (actionsData?.ours?.length ?? 0) > 0 ||
    (actionsData?.theirs?.length ?? 0) > 0 ||
    actionsData?.showExpansionQuestion === true ||
    (actionsData?.showNotes === true && typeof actionsData?.notes === "string" && actionsData.notes.trim().length > 0);

  return {
    engineHealth: pipelineEntered,
    intake,
    sales,
    marketing,
    lossAudit: pipelineEntered,
    lifetimeValue: hasLifetimeData(input.lifetimeValue),
    next30,
  };
}

/**
 * Agenda rule (Task #4693, superseding the Task #4285 drop-out): the five
 * data-section rows render UNCONDITIONALLY — empty sections now render full
 * slide skeletons with a CaseIntake™ upsell callout instead of collapsing,
 * so their roadmap rows always have a destination. Conditional NoBull-authored
 * slides (NoBull Brief, Market Context — Task #4277) keep their existing
 * flags. The presence map itself still matters — it drives skeleton mode,
 * callout variants, and badge suppression on the slides.
 */
export function isAgendaRowPresent(
  target: string,
  flags: { hasCeoPulse: boolean; hasMarketContext: boolean; sectionPresence?: SectionPresence | null },
): boolean {
  if (target === "ceo-pulse") return flags.hasCeoPulse;
  if (target === "market-context") return flags.hasMarketContext;
  return true;
}
