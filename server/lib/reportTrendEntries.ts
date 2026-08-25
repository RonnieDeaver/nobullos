/**
 * Task #3688 — per-month intake/sales trend entries for the report response.
 *
 * Both report response builders (the main share/preview `buildReportResponse`
 * and the demo endpoint) push one trend entry per report month. These entries
 * used to coerce every missing metric to 0 (`|| 0`) and compute the execution
 * scores with local copies of the blend formula, which produced two bugs:
 *
 *   - Metric-months that were never provided plotted as fake 0 points, so a
 *     client's trend chart showed a plunge to zero instead of "No Data".
 *   - The score formulas multiplied by a missing conversion rate, plotting 0
 *     for every month while the client card fell back to the raw quality
 *     score (card 39.56 vs trend 0).
 *
 * Now a metric-month that wasn't provided (absent, blank-saved-as-0 for
 * entered counts/rates/scores, or No-Data-flagged) is emitted as null, and
 * the scores come from the shared `computeExecutionScore` the client card
 * also uses. The client's trend section skips null points when plotting.
 *
 * Historical-report sweep: observational metrics (missed-call rate, time to
 * answer, no-show rate, follow-ups) keep an ENTERED 0 as a real measurement,
 * but a 0 stored by a legacy section (no `noDataFlags` key — blank fields
 * were coerced to 0 on save back then) plots as null.
 *
 * Task #4983 — the missed-call rate is PUSHED from client call reporting (or
 * typed) rather than entered per-save, so each month's point goes through the
 * SAME shared three-tier resolver as the public card: the month's own bucket
 * sums (passed by the call site via `sumMissedCallBucketInputs`, same-lead-set
 * + hideOtherLeads-symmetric) recompute when they carry a missed call; else a
 * stored rate > 0 plots clamped (pushed/typed truth); else null. Bare lead
 * volume no longer unlocks a stored 0, and a stale stored value can never
 * contradict what that month's buckets actually counted: both write paths
 * historically stamped recomputed 0s over months with no call tracking, so
 * "0 with leads" is indistinguishable from "not tracked" — those months plot
 * null, matching the card's "No data".
 */
import {
  computeExecutionScore,
  enteredMetricOrNull,
  getIntakeTargetRate,
  getSalesTargetRate,
  sectionHasEntryTracking,
  storedMetricOrNull,
} from "@shared/reportMetrics";
import { resolveMissedCallRate } from "@shared/missedCallRate";
// F5 — section payloads arrive through the typed JSONB accessors
// (readIntakeSection / readSalesSection) instead of bare `as any` casts.
import type { IntakeSectionRead, SalesSectionRead } from "./reportJsonbAccessors";

export interface IntakeTrendEntry {
  totalConsults: number | null;
  leadToConsultRate: number | null;
  missedCallRate: number | null;
  avgTimeToAnswer: number | null;
  qualityScore: number | null;
  intakeExecutionScore: number | null;
}

export interface SalesTrendEntry {
  totalCases: number | null;
  consultToCaseRate: number | null;
  avgCaseValue: number | null;
  noShowRate: number | null;
  avgFollowUps: number | null;
  pipelineMomentumScore: number | null;
  qualityScore: number | null;
  effectiveSalesQuality: number | null;
}

export function buildIntakeTrendEntry(
  intakeData: IntakeSectionRead | undefined,
  consultType: string | null | undefined,
  missedCallBuckets?: { bucketMissedCalls?: number; totalLeads?: number },
): IntakeTrendEntry {
  const flags = intakeData?.noDataFlags || {};
  const tracked = sectionHasEntryTracking(intakeData);
  const qualityScore = enteredMetricOrNull(intakeData?.qualityScore, flags.qualityScore);
  const leadToConsultRate = enteredMetricOrNull(intakeData?.leadToConsultRate, flags.totalConsults);
  return {
    totalConsults: enteredMetricOrNull(intakeData?.totalConsults, flags.totalConsults),
    leadToConsultRate,
    // Observational metrics where an ENTERED 0 is a real measurement — null
    // when absent, No-Data-flagged, or a legacy blank-coerced 0. Task #4983:
    // the missed-call rate resolves through the shared three-tier resolver
    // over the month's OWN bucket sums (from `sumMissedCallBucketInputs` at
    // the call site): buckets carrying a missed call → same-lead-set
    // recompute (a stale stored value never contradicts them); else stored
    // > 0 → clamped pushed/typed value; else null. Callers that can't
    // supply bucket sums resolve on the stored rate alone (0 → null).
    missedCallRate: resolveMissedCallRate({
      bucketMissedCalls: missedCallBuckets?.bucketMissedCalls ?? 0,
      totalLeads: missedCallBuckets?.totalLeads ?? 0,
      storedRate: intakeData?.missedCallRate,
    }),
    avgTimeToAnswer: storedMetricOrNull(intakeData?.avgTimeToAnswer, flags.avgTimeToAnswer, tracked),
    qualityScore,
    intakeExecutionScore: computeExecutionScore(
      qualityScore,
      leadToConsultRate,
      getIntakeTargetRate(consultType),
    ),
  };
}

export function buildSalesTrendEntry(
  salesData: SalesSectionRead | undefined,
  consultType: string | null | undefined,
): SalesTrendEntry {
  const flags = salesData?.noDataFlags || {};
  const tracked = sectionHasEntryTracking(salesData);
  const qualityScore = enteredMetricOrNull(salesData?.qualityScore, flags.qualityScore);
  const consultToCaseRate = enteredMetricOrNull(salesData?.consultToCaseRate, flags.totalCases);
  return {
    totalCases: enteredMetricOrNull(salesData?.totalCases, flags.totalCases),
    consultToCaseRate,
    avgCaseValue: enteredMetricOrNull(salesData?.averageCaseValue, flags.averageCaseValue),
    noShowRate: storedMetricOrNull(salesData?.noShowRate, flags.noShowRate, tracked),
    avgFollowUps: storedMetricOrNull(salesData?.avgFollowUps, flags.avgFollowUps, tracked),
    pipelineMomentumScore: enteredMetricOrNull(
      salesData?.pipelineMomentumScore,
      flags.pipelineMomentumScore,
    ),
    qualityScore,
    effectiveSalesQuality: computeExecutionScore(
      qualityScore,
      consultToCaseRate,
      getSalesTargetRate(consultType),
    ),
  };
}
