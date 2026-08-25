/**
 * derivePublicReportView — the root component's derived-const block.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 1779–2056 @ d31d7c0c7, Task #4271).
 * Zero visual/behavioral change intended — do not edit alongside a move.
 */
// The body below is the ORIGINAL derived-const block, moved verbatim. It runs
// after the root's early returns (data is non-null) and contains NO hooks, so
// extracting it into a plain function cannot change hook mount order.

import { getTermLabel } from "@shared/schema";
import { normalizeProductList } from "@shared/productResolution";
import { computeQualityHeadline, readGbpLeadQuality } from "@shared/activeProductsHeadline";
import { computeMissedCallRate, clampPercent, applyRecomputedMissedCallRate, resolveMissedCallRate } from "@shared/missedCallRate";
import { computeExecutionScore, enteredMetricOrNull, getIntakeTargetRate, getSalesTargetRate, isMetricEntered } from "@shared/reportMetrics";
import { computeEngineFunnel } from "@shared/reportFunnel";
import { REPORT_COLORS } from "./reportTokens";
import { computeSectionPresence } from "./sectionPresence";
import type { SharedReportData } from "./types";

export interface PublicReportRootState {
  isDemo: boolean;
  isPrintMode: boolean;
  isPreview: boolean;
  isEditing: boolean;
  prefersReducedMotion: boolean | null;
  printModeActive: boolean;
  hasCeoPulse: boolean;
  /** Task #4277 — false drops the Market Context slide from deck + agenda. */
  hasMarketContext: boolean;
  slideNumbers: {
    title: number; roadmap: number; ceoPulse: number; marketContext: number;
    engineHealth: number; intake: number; sales: number; marketing: number;
    lossAudit: number; lifetimeValue: number; bookPromo: number; next30: number;
  };
  data: SharedReportData;
}

export function derivePublicReportView(input: PublicReportRootState) {
  const { data } = input;
  const { report, client, sections, ceoPulse, trendData, productUpdates } = data;
  const t = (key: Parameters<typeof getTermLabel>[1]) => getTermLabel(client.terminology, key);
  const intakeSection = sections.find(s => s.sectionKey === "intake");
  const salesSection = sections.find(s => s.sectionKey === "sales");
  const marketingSection = sections.find(s => s.sectionKey === "marketing");
  const actionsSection = sections.find(s => s.sectionKey === "nextActions");

  const clientProducts = normalizeProductList(client.products || []);
  const hasGBP = clientProducts.includes('gbp');
  const hasGoogleAds = clientProducts.includes('google_ads');
  const hasLSA = clientProducts.includes('lsa');
  const hasWebinar = clientProducts.includes('webinar');
  const hasPaidMedia = hasGoogleAds || hasLSA;

  const formatMonth = (monthKey: string) => {
    const [year, month] = monthKey.split("-");
    const date = new Date(parseInt(year), parseInt(month) - 1);
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };
  const monthLabel = formatMonth(report.reportMonth);
  
  // Presentation month is the month after the data month (e.g., December data -> January presentation)
  const getPresentationMonth = (reportMonth: string) => {
    const [year, month] = reportMonth.split('-').map(Number);
    const nextMonth = month + 1;
    if (nextMonth > 12) {
      return `${year + 1}-01`;
    }
    return `${year}-${nextMonth.toString().padStart(2, '0')}`;
  };
  const presentationMonthLabel = formatMonth(getPresentationMonth(report.reportMonth));

  // Webinar Lead Equivalency: Each booked consultation from webinar = 1.6 Lead Equivalents
  // Reflects historical intake conversion rate of standard inbound leads to produce a booked consultation
  const WEBINAR_LEAD_EQUIVALENCY = 1.6;

  // Marketing metrics - respect product flags, rolling inactive-product leads into "Other"
  const gbpLocations = marketingSection?.data?.gbp?.locations || [];
  const gbpTotalLeads = hasGBP ? gbpLocations.reduce((sum: number, loc: any) => sum + (loc.uniqueLeads || 0), 0) : 0;
  const gbpTotalReviews = hasGBP ? gbpLocations.reduce((sum: number, loc: any) => sum + (loc.reviewsGenerated || 0), 0) : 0;
  const defaultLeadQuality = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };
  const googleAdsRaw = hasGoogleAds ? (marketingSection?.data?.googleAds || {}) : {};
  const googleAds = { 
    uniqueLeads: googleAdsRaw.uniqueLeads ?? 0, 
    adSpend: googleAdsRaw.adSpend ?? 0, 
    costPerLead: googleAdsRaw.costPerLead ?? (googleAdsRaw.uniqueLeads > 0 ? Math.round(googleAdsRaw.adSpend / googleAdsRaw.uniqueLeads) : 0), 
    leadQuality: { ...defaultLeadQuality, ...(googleAdsRaw.leadQuality || {}) } 
  };
  const lsaRaw = hasLSA ? (marketingSection?.data?.lsa || {}) : {};
  const lsa = { 
    uniqueLeads: lsaRaw.uniqueLeads ?? 0, 
    adSpend: lsaRaw.adSpend ?? 0, 
    costPerLead: lsaRaw.costPerLead ?? (lsaRaw.uniqueLeads > 0 ? Math.round(lsaRaw.adSpend / lsaRaw.uniqueLeads) : 0), 
    leadQuality: { ...defaultLeadQuality, ...(lsaRaw.leadQuality || {}) } 
  };
  const webinarsRaw = hasWebinar ? (marketingSection?.data?.webinar || marketingSection?.data?.webinars || {}) : {};
  const webinars = { 
    registrants: webinarsRaw.registrants ?? 0, 
    attendees: webinarsRaw.attendees ?? 0, 
    showRate: webinarsRaw.showRate ?? (webinarsRaw.registrants > 0 ? Math.round((webinarsRaw.attendees / webinarsRaw.registrants) * 100) : 0), 
    hotTransfers: webinarsRaw.hotTransfers ?? 0,
    hotTransferRate: webinarsRaw.hotTransferRate ?? (webinarsRaw.attendees > 0 ? Math.round((webinarsRaw.hotTransfers / webinarsRaw.attendees) * 100) : 0)
  };
  
  // Per-platform Lead Quality used by the Lead Quality Breakdown card below.
  // GBP: Task #3771 — the canonical shared reader (rollup-first, per-location
  // sums as fallback), the SAME reader `computeQualityHeadline` uses, so the
  // "% Good" headline always equals Good/total of the bar/legend counts on
  // this card. Google Ads / LSA pull straight from the active-products-gated
  // platform blocks.
  const gbpAggLeadQuality = hasGBP
    ? readGbpLeadQuality(marketingSection?.data).counts
    : { ...defaultLeadQuality };
  const gAdsLeadQuality = hasGoogleAds ? googleAds.leadQuality : { ...defaultLeadQuality };
  const lsaLeadQuality = hasLSA ? lsa.leadQuality : { ...defaultLeadQuality };

  const otherLeadsData = marketingSection?.data?.otherLeads || { count: 0, description: "" };
  let otherLeadsCount = otherLeadsData.count || 0;

  let inactiveProductLeads = 0;
  if (!hasGBP) {
    const inactiveGbpLeads = gbpLocations.reduce((sum: number, loc: any) => sum + (loc.uniqueLeads || 0), 0);
    inactiveProductLeads += inactiveGbpLeads;
  }
  if (!hasGoogleAds) {
    const rawGads = marketingSection?.data?.googleAds || {};
    inactiveProductLeads += rawGads.uniqueLeads || 0;
  }
  if (!hasLSA) {
    const rawLsa = marketingSection?.data?.lsa || {};
    inactiveProductLeads += rawLsa.uniqueLeads || 0;
  }
  if (!hasWebinar) {
    const rawWebinars = marketingSection?.data?.webinar || marketingSection?.data?.webinars || {};
    inactiveProductLeads += rawWebinars.hotTransfers || 0;
  }
  otherLeadsCount += inactiveProductLeads;

  // Task #2667 — when the per-client "hide Other leads" toggle is on, suppress
  // the entire Other bucket (including the inactive-product leads folded in
  // above) from every downstream figure. Zeroing it here means: it drops out
  // of totalLeadsExcludingWebinar / totalLeads, the lead-source pie + legend +
  // percentages (gated on `otherLeadsCount > 0`), the "Other sources: …"
  // description line, and any figure derived from total leads. When off, this
  // is a no-op and the report is byte-for-byte unchanged.
  // Task #4982 — this post-folding, post-toggle value is ALSO the single
  // disclosure gate: the 'includes N "Other" leads' clarifiers (Marketing
  // hero, Engine Health leads hero + Marketing status row) all read the
  // exposed `otherLeadsCount` below and render only when it is > 0, so they
  // can never disagree with the totals and never surface under the toggle.
  const hideOtherLeads = data?.client?.hideOtherLeads === true;
  if (hideOtherLeads) {
    otherLeadsCount = 0;
  }

  const webinarLeadQuality = (marketingSection?.data?.webinar || marketingSection?.data?.webinars)?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };
  const hasWebinarLeadQualityData = (webinarLeadQuality.good || 0) + (webinarLeadQuality.notQuotable || 0) + (webinarLeadQuality.missedCalls || 0) + (webinarLeadQuality.noData || 0) > 0;
  const webinarLeadCount = hasWebinar
    ? (hasWebinarLeadQualityData
        ? ((webinarLeadQuality.good || 0) + (webinarLeadQuality.notQuotable || 0) + (webinarLeadQuality.missedCalls || 0) + (webinarLeadQuality.noData || 0))
        : Math.ceil((webinars.hotTransfers || 0) * WEBINAR_LEAD_EQUIVALENCY))
    : 0;
  const webinarLeadEquiv = hasWebinar && webinarLeadCount > 0
    ? (hasWebinarLeadQualityData ? Math.ceil(webinarLeadCount * WEBINAR_LEAD_EQUIVALENCY) : webinarLeadCount)
    : 0;
  const totalLeadsExcludingWebinar = gbpTotalLeads + (hasGoogleAds ? (googleAds.uniqueLeads || 0) : 0) + (hasLSA ? (lsa.uniqueLeads || 0) : 0) + otherLeadsCount;
  // Task #4511 — the report total counts webinar in LEAD EQUIVALENTS, matching
  // every other webinar figure on the deck (the Marketing card annotation, the
  // lead-source pie, the trend chart's rebuilt Total per Task #2789, the
  // lifetime-value cumulative). In fallback mode (no quality breakdown)
  // webinarLeadEquiv === webinarLeadCount — already Math.ceil(HT × 1.6) — so
  // Hot Transfers-only clients render byte-identically. ONE variable: Revenue
  // Leak, Engine Health, the engine funnel, benchmark/gap math, and the
  // recomputed missed-call-rate denominator (Task #2680) all follow from here.
  const totalLeads = totalLeadsExcludingWebinar + webinarLeadEquiv;

  // Task #2680 — recompute the Missed Call Rate from the SAME lead set that
  // feeds the displayed Total Leads above (so numerator and denominator can't
  // diverge), respecting `hideOtherLeads` symmetrically: when the toggle is on
  // `otherLeadsCount` is already 0 in the denominator, so Other's missed calls
  // are dropped from the numerator too. The shared helper clamps to 0–100%, so
  // a stale/absurd persisted value (e.g. 5,300%) can never render.
  const displayedMissedCalls =
    (gbpAggLeadQuality.missedCalls || 0) +
    (gAdsLeadQuality.missedCalls || 0) +
    (lsaLeadQuality.missedCalls || 0) +
    (hasWebinar && hasWebinarLeadQualityData ? (webinarLeadQuality.missedCalls || 0) : 0) +
    (hideOtherLeads ? 0 : (otherLeadsData.leadQuality?.missedCalls || 0));
  const recomputedMissedCallRate = computeMissedCallRate(displayedMissedCalls, totalLeads);

  // Task #4983 — the card's displayed value routes through the shared
  // three-tier resolver (missed-call data is PUSHED from client call
  // reporting or typed; the bucket fields are structural 0s otherwise):
  //
  //   1. Bucket evidence in the DISPLAYED lead set (`displayedMissedCalls` >
  //      0, already active-product filtered and hideOtherLeads-symmetric per
  //      Task #2680) → the same-lead-set recompute above.
  //   2. Else a pushed/typed stored rate > 0 (`intake.missedCallRate`) → the
  //      clamped stored value — the recomputed 0 must not bury it.
  //   3. Else null → "No data" card, no status chip. A stored 0 is never
  //      trusted: both write paths historically stamped recomputed 0s over
  //      months with no call tracking, so lead volume alone can no longer
  //      fabricate a healthy 0%.
  //
  // Task #2680 sweep — the Historical Trends mini-chart reads each month's
  // PERSISTED `intake.missedCallRate`, but the card resolves live over the
  // displayed lead set / stored rate, so the current month's stored point
  // (possibly stale or absurd, e.g. 5,300%) could disagree with the card
  // beside it. Override the CURRENT month's trend point with the exact value
  // the card shows so the two can never diverge — in BOTH directions: a
  // resolved value replaces the stored point, and a null ("No data") stamps
  // null over it (the server gates stored points on raw bucket evidence, but
  // the display derivation is narrower — active products, hideOtherLeads).
  // Historical months keep their persisted (clampPercent-guarded) values:
  // they have no adjacent card to match and their recompute inputs aren't
  // carried per-month in trendData (server-side bucket-evidence gating covers
  // their fabricated 0s).
  const displayedMissedCallRate: number | null = resolveMissedCallRate({
    bucketMissedCalls: displayedMissedCalls,
    totalLeads,
    storedRate: intakeSection?.data?.missedCallRate,
  });
  const correctedTrendData = applyRecomputedMissedCallRate(
    trendData,
    report.reportMonth,
    displayedMissedCallRate,
  );
  
  // Lead source breakdown for pie chart — report tokens, dark-surface safe
  // (Task #4272). LSA keeps the raw heatmap-palette green below: that
  // occurrence is allow-listed by exact count in lint-heatmap-color-lockstep,
  // so it must not be tokenized or moved.
  const webinarUsingFallback = hasWebinar && !hasWebinarLeadQualityData && (webinars.hotTransfers || 0) > 0;
  const leadSourceBreakdown = (() => {
    const sources: Array<{name: string; value: number; color: string; isWebinar?: boolean}> = [];
    if (gbpTotalLeads > 0) sources.push({ name: "GBP", value: gbpTotalLeads, color: REPORT_COLORS.crimsonBright });
    if (hasGoogleAds && googleAds.uniqueLeads > 0) sources.push({ name: "Google Ads", value: googleAds.uniqueLeads, color: REPORT_COLORS.steel });
    if (hasLSA && lsa.uniqueLeads > 0) sources.push({ name: "LSA", value: lsa.uniqueLeads, color: "#4ADE80" });
    if (hasWebinar && webinarLeadEquiv > 0) sources.push({ name: "Webinar", value: webinarLeadEquiv, color: REPORT_COLORS.gold, isWebinar: true });
    if (otherLeadsCount > 0) sources.push({ name: "Other", value: otherLeadsCount, color: REPORT_COLORS.slate });
    return sources;
  })();
  const leadSourceTotal = leadSourceBreakdown.reduce((sum, s) => sum + s.value, 0);
  const totalPaidLeads = (hasGoogleAds ? (googleAds.uniqueLeads || 0) : 0) + (hasLSA ? (lsa.uniqueLeads || 0) : 0);
  const totalAdSpend = (hasGoogleAds ? (googleAds.adSpend || 0) : 0) + (hasLSA ? (lsa.adSpend || 0) : 0);
  const blendedCPL = totalPaidLeads > 0 ? totalAdSpend / totalPaidLeads : 0;
  
  const totalGoodExcludingWebinar = (hasGoogleAds ? (googleAds.leadQuality?.good || 0) : 0) + (hasLSA ? (lsa.leadQuality?.good || 0) : 0) + 
    gbpLocations.reduce((sum: number, loc: any) => sum + (loc.leadQuality?.good || 0), 0);
  const webinarGoodForPercent = hasWebinar
    ? (hasWebinarLeadQualityData ? (webinarLeadQuality.good || 0) : (webinars.hotTransfers || 0))
    : 0;
  const totalGood = totalGoodExcludingWebinar + webinarGoodForPercent;
  // Task #4914 — rated-based % Good (owner decision, supersedes the Task
  // #1028 all-leads denominator): where lead-quality bucket data exists this
  // fallback follows the SAME convention as `computeQualityHeadline` —
  // % Good = good / rated, rated = good + notQuotable + missedCalls (every
  // KNOWN disposition), and NULL when nothing was rated so the deck renders
  // "—", never a 0%/100% off an empty denominator. "No data" is coverage,
  // not quality. The old count-based fallback (good / total lead volume)
  // could only fire with a 0 numerator when buckets were absent — the
  // numerator is itself bucket-derived — i.e. it rendered a misleading hard
  // "0%" for unrated months; those surface as null now too. The GBP terms
  // come from `gbpAggLeadQuality` — the canonical rollup-first reader, the
  // SAME counts `computeQualityHeadline` and the quality bar consume — never
  // the per-location sums, which the reader lets diverge from the rollup: a
  // zero-rated rollup with stale rated location buckets must fall through as
  // null here too, or the `qualityPercent ?? goodLeadPercent` fallback would
  // resurrect a percentage the bar and coverage line contradict. gads/lsa
  // pull from the same gated platform blocks the headline reads.
  const ratedGoodExcludingWebinar =
    (hasGoogleAds ? (googleAds.leadQuality?.good || 0) : 0) +
    (hasLSA ? (lsa.leadQuality?.good || 0) : 0) +
    (gbpAggLeadQuality.good || 0);
  const ratedExcludingWebinar =
    (hasGoogleAds ? (googleAds.leadQuality?.good || 0) + (googleAds.leadQuality?.notQuotable || 0) + (googleAds.leadQuality?.missedCalls || 0) : 0) +
    (hasLSA ? (lsa.leadQuality?.good || 0) + (lsa.leadQuality?.notQuotable || 0) + (lsa.leadQuality?.missedCalls || 0) : 0) +
    (gbpAggLeadQuality.good || 0) + (gbpAggLeadQuality.notQuotable || 0) + (gbpAggLeadQuality.missedCalls || 0);
  const goodLeadPercent: number | null = ratedExcludingWebinar > 0
    ? Math.round((ratedGoodExcludingWebinar / ratedExcludingWebinar) * 100)
    : null;

  // Task #3688 — consult/sales metrics are driven purely by data presence in
  // the report's own sections: a value that was entered displays; one that
  // wasn't shows "No data". The per-client Data Access toggle no longer
  // affects rendering (it remains Command Panel tracking metadata), so a
  // flipped toggle can't fabricate a red "0%" for a client who never entered
  // consult data. The ReportForm saves blank fields as 0, so 0 counts as
  // "not entered" for these counts/rates, and No-Data-flagged values are
  // absent regardless of the stored number.
  const intakeNoDataFlags = (intakeSection?.data?.noDataFlags || {}) as Record<string, boolean>;
  const salesNoDataFlags = (salesSection?.data?.noDataFlags || {}) as Record<string, boolean>;
  const hasConsultsData = isMetricEntered(intakeSection?.data?.totalConsults, intakeNoDataFlags.totalConsults);
  const hasLeadToConsultData = isMetricEntered(intakeSection?.data?.leadToConsultRate, intakeNoDataFlags.totalConsults);
  const hasCasesData = isMetricEntered(salesSection?.data?.totalCases, salesNoDataFlags.totalCases);
  const hasConsultToCaseData = isMetricEntered(salesSection?.data?.consultToCaseRate, salesNoDataFlags.totalCases);
  const hasAvgCaseValueData = isMetricEntered(salesSection?.data?.averageCaseValue, salesNoDataFlags.averageCaseValue);

  // Intake/Sales metrics
  const totalConsults = intakeSection?.data?.totalConsults || 0;
  // Task #2680 sweep — clamp persisted rate metrics to 0–100% so a stale/absurd
  // saved value (the same bug that showed a 5,300% missed-call rate) can't render
  // in the headline KPIs or flow into the downstream projection math below.
  const leadToConsultRate = clampPercent(intakeSection?.data?.leadToConsultRate || 0);
  const totalCases = salesSection?.data?.totalCases || 0;
  const consultToCaseRate = clampPercent(salesSection?.data?.consultToCaseRate || 0);
  const avgCaseValue = salesSection?.data?.averageCaseValue || 0;
  
  const isPaidConsults = client.consultType === 'paid';
  const salesTargetRate = getSalesTargetRate(client.consultType);
  const intakeTargetRate = getIntakeTargetRate(client.consultType);
  const intakeStatus = leadToConsultRate >= intakeTargetRate ? "healthy" : leadToConsultRate >= (intakeTargetRate - 10) ? "watch" : "needs_attention";
  const salesStatus = consultToCaseRate >= salesTargetRate ? "healthy" : consultToCaseRate >= (salesTargetRate - 10) ? "watch" : "needs_attention";

  // Task #3688 — IES/ESQ come from the shared computeExecutionScore (also
  // used by the server trend builders) so the card and its trend can never
  // diverge again: quality missing → null ("No data"), conversion rate
  // missing → raw quality fallback (e.g. 39.56), both present → blended.
  const effectiveSalesQuality = computeExecutionScore(
    enteredMetricOrNull(salesSection?.data?.qualityScore, salesNoDataFlags.qualityScore),
    hasConsultToCaseData ? consultToCaseRate : null,
    salesTargetRate,
  );

  const intakeExecutionScore = computeExecutionScore(
    enteredMetricOrNull(intakeSection?.data?.qualityScore, intakeNoDataFlags.qualityScore),
    hasLeadToConsultData ? leadToConsultRate : null,
    intakeTargetRate,
  );

  const pipelineMomentumIndex = (() => {
    const score = salesSection?.data?.pipelineMomentumScore;
    if (score !== undefined && score !== null && score > 0) {
      return Math.round(Math.max(0, Math.min(100, score)));
    }
    return null;
  })();

  // Loss audit - calculate potential at each stage using benchmarks
  // Benchmark: 65%/45% lead-to-consult, 30%/40% consult-to-case (based on consult type)
  const benchmarkIntakeRate = intakeTargetRate / 100;
  const benchmarkSalesRate = salesTargetRate / 100;
  
  // Use the BETTER of current rate or benchmark for each stage
  const effectiveIntakeRate = Math.max(leadToConsultRate / 100, benchmarkIntakeRate);
  const effectiveSalesRate = Math.max(consultToCaseRate / 100, benchmarkSalesRate);
  
  // Additional consults if intake hit target (only if below benchmark)
  const targetConsults = Math.round(totalLeads * benchmarkIntakeRate);
  const additionalConsultsGap = Math.max(0, targetConsults - totalConsults);
  
  // Additional cases if sales hit target (only if below benchmark, from ACTUAL consults)
  const targetCases = Math.round(totalConsults * benchmarkSalesRate);
  const additionalCasesGap = Math.max(0, targetCases - totalCases);
  
  // Convert intake gap to potential cases using EFFECTIVE sales rate (their actual rate if better)
  const casesFromIntakeImprovement = Math.round(additionalConsultsGap * effectiveSalesRate);
  
  // Total unrealized CASES (only from areas below benchmark)
  const totalMissedCases = casesFromIntakeImprovement + additionalCasesGap;
  const unrealizedRevenue = totalMissedCases * avgCaseValue;
  
  // Legacy alias for backward compatibility
  const totalMissed = totalMissedCases;
  
  // Pipeline efficiency: compare to maximum potential using effective rates
  // Max potential = leads × best(intakeRate, benchmark) × best(salesRate, benchmark)
  const maxPotentialCases = Math.round(totalLeads * effectiveIntakeRate * effectiveSalesRate);
  const pipelineEfficiency = maxPotentialCases > 0 
    ? Math.min(100, Math.round((totalCases / maxPotentialCases) * 100))
    : 100;

  // Task #4278 — ONE computed funnel/health source (§8.5): Engine Health and
  // Revenue Leak both render THIS object (stages, est. top-line revenue,
  // monotonicity breaks). Always stamped, no conditional skip path, so the
  // two slides reconcile by construction (card-vs-trend precedent, #3688).
  const engineFunnel = computeEngineFunnel({
    totalLeads,
    totalConsults,
    totalCases,
    hasConsultsData,
    hasCasesData,
    avgCaseValue,
    hasAvgCaseValueData,
  });

  // Task #4285 — deck-wide empty-state convention (audit backlog #17 +
  // §8.6): ONE presence bit per section drives both the slide-level
  // collapse (wall of "No data" cards → single explanatory band) and the
  // agenda drop-out. Computed AFTER every presence-gated metric above, from
  // those same values, so it can never disagree with what slides render.
  const sectionPresence = computeSectionPresence({
    intakeSection,
    salesSection,
    marketingSection,
    actionsSection,
    lifetimeValue: data.lifetimeValue,
    totalLeads,
    hasConsultsData,
    hasLeadToConsultData,
    hasCasesData,
    hasConsultToCaseData,
    hasAvgCaseValueData,
    displayedMissedCallRate,
    intakeExecutionScore,
    effectiveSalesQuality,
    pipelineMomentumIndex,
    intakeNoDataFlags,
    salesNoDataFlags,
    gbpLocations,
    gbpTotalReviews,
    totalAdSpend,
    webinars,
    hasWebinar,
    trendData,
    correctedTrendData,
  });

  return {
    ...input,
    report,
    client,
    sections,
    ceoPulse,
    trendData,
    productUpdates,
    t,
    intakeSection,
    salesSection,
    marketingSection,
    actionsSection,
    clientProducts,
    hasGBP,
    hasGoogleAds,
    hasLSA,
    hasWebinar,
    hasPaidMedia,
    formatMonth,
    monthLabel,
    getPresentationMonth,
    presentationMonthLabel,
    WEBINAR_LEAD_EQUIVALENCY,
    gbpLocations,
    gbpTotalLeads,
    gbpTotalReviews,
    defaultLeadQuality,
    googleAdsRaw,
    googleAds,
    lsaRaw,
    lsa,
    webinarsRaw,
    webinars,
    gbpAggLeadQuality,
    gAdsLeadQuality,
    lsaLeadQuality,
    otherLeadsData,
    otherLeadsCount,
    inactiveProductLeads,
    hideOtherLeads,
    webinarLeadQuality,
    hasWebinarLeadQualityData,
    webinarLeadCount,
    webinarLeadEquiv,
    totalLeadsExcludingWebinar,
    totalLeads,
    displayedMissedCalls,
    recomputedMissedCallRate,
    displayedMissedCallRate,
    correctedTrendData,
    webinarUsingFallback,
    leadSourceBreakdown,
    leadSourceTotal,
    totalPaidLeads,
    totalAdSpend,
    blendedCPL,
    totalGoodExcludingWebinar,
    webinarGoodForPercent,
    totalGood,
    goodLeadPercent,
    intakeNoDataFlags,
    salesNoDataFlags,
    hasConsultsData,
    hasLeadToConsultData,
    hasCasesData,
    hasConsultToCaseData,
    hasAvgCaseValueData,
    totalConsults,
    leadToConsultRate,
    totalCases,
    consultToCaseRate,
    avgCaseValue,
    isPaidConsults,
    salesTargetRate,
    intakeTargetRate,
    intakeStatus,
    salesStatus,
    effectiveSalesQuality,
    intakeExecutionScore,
    pipelineMomentumIndex,
    benchmarkIntakeRate,
    benchmarkSalesRate,
    effectiveIntakeRate,
    effectiveSalesRate,
    targetConsults,
    additionalConsultsGap,
    targetCases,
    additionalCasesGap,
    casesFromIntakeImprovement,
    totalMissedCases,
    unrealizedRevenue,
    totalMissed,
    maxPotentialCases,
    pipelineEfficiency,
    engineFunnel,
    sectionPresence,
  };
}

export type PublicReportViewModel = ReturnType<typeof derivePublicReportView>;
