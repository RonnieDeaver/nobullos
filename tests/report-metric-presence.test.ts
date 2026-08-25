/* test-registration
{
  "name": "Report metrics No Data unless entered — presence predicates + shared IES/ESQ + null trend months (Task #3688)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3688: report consult/sales metrics are driven purely by data presence — entered values display, missing ones show \"No Data\". One shared module owns the presence predicates, the IES/ESQ blend (with the raw-quality fallback that keeps card and trend in agreement), and the consult-bookings auto-flip predicate; the server trend builders emit null (never fake 0) for metric-months that weren't provided. Gate this fast, DB-free unit test so fabricated zeros or card-vs-trend divergence can't silently return.",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import {
  computeExecutionScore,
  displayedSupportingMetric,
  enteredMetricOrNull,
  getIntakeTargetRate,
  getSalesTargetRate,
  hasGenuineConsultBookingData,
  hasLeadVolumeEvidence,
  hasMissedCallBucketEvidence,
  sumMissedCallBucketInputs,
  isMetricEntered,
  sectionHasEntryTracking,
  storedMetricOrNull,
} from "../shared/reportMetrics";
import { resolveMissedCallRate } from "../shared/missedCallRate";
import {
  buildIntakeTrendEntry,
  buildSalesTrendEntry,
} from "../server/lib/reportTrendEntries";

/**
 * Task #3688 — report metrics show "No Data" unless entered.
 *
 * Two bug classes are locked out here:
 *
 *   1. Fabricated values — the Data Access toggle (flipped "available" by an
 *      intake save that only carried a quality score) unlocked consult/sales
 *      metrics, rendering a red "0%" Leads→Consults rate and 0 consults for a
 *      client who never entered consult data. Presence predicates now drive
 *      rendering: blank-saved-as-0 entered metrics and No-Data-flagged values
 *      count as not provided.
 *   2. Card-vs-trend divergence — the Intake Execution Score card fell back to
 *      the raw quality score (39.56) when the lead→consult rate was missing
 *      while the server trend builder multiplied by the missing rate and
 *      plotted 0 every month. Card and trend now route through ONE shared
 *      computeExecutionScore, and trend builders emit null (not 0) for
 *      metric-months that weren't provided.
 *
 * Historical-report sweep extends class 1 to observational metrics: sections
 * saved before the `noDataFlags` era coerced blank fields to 0, so historical
 * reports rendered a healthy "0% no-shows" and a critical "0 follow-ups" for
 * months where nothing was entered. Presence now keys on the section's
 * entry-tracking era (`sectionHasEntryTracking`): an unflagged 0 in a
 * flag-era section is a real, deliberately-entered measurement; a legacy
 * section's 0 renders "No Data".
 *
 * Task #4983 — the missed-call rate is PUSHED from client call reporting (or
 * typed) rather than entered per-save, and both write paths historically
 * stamped recomputed 0s over months with no call tracking. Every surface
 * (card, trend, verdict context) therefore routes through the SAME
 * three-tier resolution over the month's own bucket sums
 * (`sumMissedCallBucketInputs`, same-lead-set + hideOtherLeads-symmetric):
 * buckets carrying a missed call → recompute (a stale stored value can never
 * contradict them); else stored > 0 → clamped pushed/typed value; else null.
 * Bare lead volume (`hasLeadVolumeEvidence`, which stays the gate for the
 * other lead-data consumers) can no longer make a fabricated 0% plot.
 */
async function run() {
  // === isMetricEntered: presence rule for entered counts/rates/scores ===
  // The ReportForm saves blank fields as 0, so 0 means "not entered" here.
  assert.equal(isMetricEntered(0), false, "stored 0 counts as not entered");
  assert.equal(isMetricEntered(null), false, "null is not entered");
  assert.equal(isMetricEntered(undefined), false, "undefined is not entered");
  assert.equal(isMetricEntered(-3), false, "negative junk is not entered");
  assert.equal(isMetricEntered(NaN), false, "NaN is not entered");
  assert.equal(isMetricEntered("abc"), false, "non-numeric string is not entered");
  assert.equal(isMetricEntered(5), true, "positive count is entered");
  assert.equal(isMetricEntered("12"), true, "persisted numeric string is entered");
  assert.equal(isMetricEntered(10, true), false, "No-Data flag beats a stored value");

  // === enteredMetricOrNull / storedMetricOrNull ===
  assert.equal(enteredMetricOrNull(0), null, "entered metric: 0 → null");
  assert.equal(enteredMetricOrNull(7), 7, "entered metric: value passes");
  assert.equal(enteredMetricOrNull("12"), 12, "entered metric: string coerces");
  assert.equal(enteredMetricOrNull(7, true), null, "entered metric: flag → null");
  // Observational metrics (missed-call rate, no-show, time-to-answer) keep an
  // ENTERED 0 — a month with zero missed calls is a real measurement. A
  // legacy section (no entry tracking) coerced blanks to 0 on save, so its
  // stored 0 means "never entered" and resolves null instead.
  assert.equal(storedMetricOrNull(0, undefined, true), 0, "tracked section: entered 0 is a real measurement");
  assert.equal(storedMetricOrNull(0, undefined, false), null, "legacy section: blank-coerced 0 → null");
  assert.equal(storedMetricOrNull(0, false, false), null, "legacy section: unflagged 0 still → null");
  assert.equal(storedMetricOrNull("0", undefined, false), null, "legacy section: string '0' is a coerced blank too");
  assert.equal(storedMetricOrNull(4.2, undefined, false), 4.2, "legacy section: nonzero value passes");
  assert.equal(storedMetricOrNull(undefined, undefined, true), null, "stored metric: absent → null");
  assert.equal(storedMetricOrNull(null, undefined, true), null, "stored metric: null → null");
  assert.equal(storedMetricOrNull(4.2, undefined, true), 4.2, "stored metric: value passes");
  assert.equal(storedMetricOrNull("6.8", undefined, true), 6.8, "stored metric: string coerces");
  assert.equal(storedMetricOrNull(5, true, true), null, "stored metric: flag → null");

  // === sectionHasEntryTracking: the era marker ===
  // The ReportForm has written the `noDataFlags` key on every save since the
  // flag era began (even all-false), so key PRESENCE — not flag values — is
  // what separates "blanks were saved deliberately" from "blanks were coerced
  // to 0 by the old save path".
  assert.equal(sectionHasEntryTracking(undefined), false, "missing section: no tracking");
  assert.equal(sectionHasEntryTracking(null), false, "null section: no tracking");
  assert.equal(sectionHasEntryTracking({}), false, "legacy section: no noDataFlags key");
  assert.equal(sectionHasEntryTracking({ totalConsults: 5 }), false, "legacy section with data: no tracking");
  assert.equal(sectionHasEntryTracking({ noDataFlags: {} }), true, "flag-era section: empty flags object still tracks");
  assert.equal(sectionHasEntryTracking({ noDataFlags: { totalConsults: false } }), true, "flag-era section: all-false flags track");

  // === hasLeadVolumeEvidence: the derived missed-call rate's presence gate ===
  assert.equal(hasLeadVolumeEvidence(undefined), false, "missing marketing section: no evidence");
  assert.equal(hasLeadVolumeEvidence({}), false, "empty marketing section: no evidence");
  assert.equal(hasLeadVolumeEvidence({ totalLeads: 0 }), false, "zero lead volume is not evidence");
  assert.equal(hasLeadVolumeEvidence({ totalLeads: 12 }), true, "stored total leads is evidence");
  assert.equal(hasLeadVolumeEvidence({ totalLeads: "8" }), true, "persisted string lead count coerces");
  assert.equal(hasLeadVolumeEvidence({ googleAds: { uniqueLeads: 3 } }), true, "per-source ads leads are evidence");
  assert.equal(hasLeadVolumeEvidence({ lsa: { uniqueLeads: 1 } }), true, "per-source LSA leads are evidence");
  assert.equal(hasLeadVolumeEvidence({ gbp: { locations: [{ uniqueLeads: 2 }] } }), true, "GBP location leads are evidence");
  assert.equal(hasLeadVolumeEvidence({ gbpLocations: [{ leadQuality: { missedCalls: 1 } }] }), true, "a counted missed call is lead data");
  assert.equal(hasLeadVolumeEvidence({ leadQuality: { good: 4 } }), true, "lead-quality buckets are evidence");
  assert.equal(hasLeadVolumeEvidence({ webinar: { hotTransfers: 2 } }), true, "webinar hot transfers are evidence");
  assert.equal(hasLeadVolumeEvidence({ otherLeads: { count: 1 } }), true, "Other-bucket leads are evidence");
  // Per-source quality buckets are stored alongside each platform block, and
  // the display total counts them — every nested shape is evidence too.
  assert.equal(hasLeadVolumeEvidence({ gbpLeadQuality: { good: 5 } }), true, "webhook gbpLeadQuality rollup is evidence");
  assert.equal(hasLeadVolumeEvidence({ googleAds: { uniqueLeads: 0, leadQuality: { missedCalls: 2 } } }), true, "nested ads quality bucket is evidence");
  assert.equal(hasLeadVolumeEvidence({ lsa: { leadQuality: { notQuotable: 1 } } }), true, "nested LSA quality bucket is evidence");
  assert.equal(hasLeadVolumeEvidence({ webinar: { hotTransfers: 0, leadQuality: { good: 3 } } }), true, "webinar quality counts as volume even at zero transfers");
  assert.equal(hasLeadVolumeEvidence({ webinars: { hotTransfers: 2 } }), true, "legacy `webinars` alias is honored");
  assert.equal(hasLeadVolumeEvidence({ webinars: { leadQuality: { noData: 1 } } }), true, "legacy alias quality buckets count too");
  assert.equal(hasLeadVolumeEvidence({ otherLeads: { count: 0, leadQuality: { missedCalls: 1 } } }), true, "Other-bucket quality is evidence");
  assert.equal(
    hasLeadVolumeEvidence({ googleAds: { uniqueLeads: 0, leadQuality: { good: 0, missedCalls: 0 } }, webinar: { hotTransfers: 0 } }),
    false,
    "all-zero nested shapes stay non-evidence",
  );

  // === hasMissedCallBucketEvidence: the missed-call rate's presence gate ===
  // (Task #4983) Strictly narrower than lead-volume evidence: only a bucket
  // that actually COUNTED a missed call vouches for the metric. The bucket
  // fields are structural defaults (0) unless the client's call reporting
  // pushed them, so lead volume alone must never unlock a 0% rate.
  assert.equal(hasMissedCallBucketEvidence(undefined), false, "missing marketing section: no evidence");
  assert.equal(hasMissedCallBucketEvidence({}), false, "empty marketing section: no evidence");
  assert.equal(hasMissedCallBucketEvidence({ totalLeads: 340 }), false, "lead volume alone is NOT missed-call evidence");
  assert.equal(hasMissedCallBucketEvidence({ leadQuality: { good: 4, notQuotable: 2, noData: 1 } }), false, "other quality buckets are not missed-call evidence (owner: rating ≠ call tracking)");
  assert.equal(hasMissedCallBucketEvidence({ leadQuality: { missedCalls: 1 } }), true, "root rollup missed call is evidence");
  assert.equal(hasMissedCallBucketEvidence({ gbpLeadQuality: { missedCalls: 2 } }), true, "webhook gbpLeadQuality rollup counts");
  assert.equal(hasMissedCallBucketEvidence({ googleAds: { leadQuality: { missedCalls: 1 } } }), true, "nested ads bucket counts");
  assert.equal(hasMissedCallBucketEvidence({ lsa: { leadQuality: { missedCalls: "2" } } }), true, "persisted string count coerces");
  assert.equal(hasMissedCallBucketEvidence({ webinar: { leadQuality: { missedCalls: 1 } } }), true, "webinar bucket counts");
  assert.equal(hasMissedCallBucketEvidence({ webinars: { leadQuality: { missedCalls: 1 } } }), true, "legacy `webinars` alias is honored");
  assert.equal(hasMissedCallBucketEvidence({ otherLeads: { leadQuality: { missedCalls: 3 } } }), true, "Other-bucket missed calls count");
  assert.equal(hasMissedCallBucketEvidence({ gbp: { locations: [{ leadQuality: { missedCalls: 1 } }] } }), true, "per-GBP-location bucket counts");
  assert.equal(hasMissedCallBucketEvidence({ gbpLocations: [{ leadQuality: { missedCalls: 1 } }] }), true, "legacy gbpLocations alias counts");
  assert.equal(
    hasMissedCallBucketEvidence({
      googleAds: { leadQuality: { missedCalls: 0 } },
      lsa: { leadQuality: { missedCalls: 0 } },
      gbpLocations: [{ leadQuality: { missedCalls: 0 } }],
      otherLeads: { leadQuality: { missedCalls: 0 } },
    }),
    false,
    "all-zero buckets everywhere stay non-evidence (structural defaults)",
  );
  // The divergence that motivates the split predicate — prod-pinned
  // (read-only replica, 2026-08-18): Cambridge Immigration Law 2026-07 has
  // 340 leads and an empty intake section; it HAS lead volume but NO
  // missed-call evidence, so the card must say "No data", not "0% · Healthy".
  const cambridgeMarketing = {
    totalLeads: 340,
    googleAds: { uniqueLeads: 120, leadQuality: { good: 40, missedCalls: 0 } },
  };
  assert.equal(hasLeadVolumeEvidence(cambridgeMarketing), true, "Cambridge month HAS lead volume");
  assert.equal(hasMissedCallBucketEvidence(cambridgeMarketing), false, "…but NO missed-call evidence");

  // === sumMissedCallBucketInputs: resolver inputs from a stored month ===
  // The server-surface aggregation (trend entries, verdict context) — the
  // same walk as the evidence predicate minus double counting, so bucket-
  // backed months RECOMPUTE with the persist-time (#2680) lead set.
  assert.deepEqual(
    sumMissedCallBucketInputs(undefined),
    { bucketMissedCalls: 0, totalLeads: 0 },
    "missing marketing section sums to zeros (resolver falls to stored tier)",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs({
      totalLeads: 50,
      gbpLeadQuality: { missedCalls: 2 },
      googleAds: { leadQuality: { missedCalls: 1 } },
      lsa: { leadQuality: { missedCalls: "1" } },
      webinar: { leadQuality: { missedCalls: 1 } },
      otherLeads: { count: 10, leadQuality: { missedCalls: 3 } },
    }),
    { bucketMissedCalls: 8, totalLeads: 50 },
    "per-source sum: GBP rollup + ads + lsa (string-coerced) + webinar + Other over the stored grand total",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs({
      totalLeads: 40,
      gbpLeadQuality: { missedCalls: 2 },
      gbp: { locations: [{ leadQuality: { missedCalls: 5 } }] },
    }),
    { bucketMissedCalls: 2, totalLeads: 40 },
    "persisted GBP rollup WINS over per-location buckets (Task #3771 render rule — no double count)",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs({
      totalLeads: 40,
      gbp: { locations: [{ leadQuality: { missedCalls: 1 } }, { leadQuality: { missedCalls: 2 } }] },
    }),
    { bucketMissedCalls: 3, totalLeads: 40 },
    "no rollup → per-location sum",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs({ totalLeads: 40, gbpLocations: [{ leadQuality: { missedCalls: 4 } }] }),
    { bucketMissedCalls: 4, totalLeads: 40 },
    "legacy gbpLocations alias is honored",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs({ totalLeads: 30, leadQuality: { missedCalls: 4 } }),
    { bucketMissedCalls: 4, totalLeads: 30 },
    "legacy root-rollup-only rows fall back to root leadQuality",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs({
      totalLeads: 30,
      leadQuality: { missedCalls: 99 },
      googleAds: { leadQuality: { missedCalls: 1 } },
    }),
    { bucketMissedCalls: 1, totalLeads: 30 },
    "root rollup is IGNORED once any per-source block exists (never double-counted)",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs({ totalLeads: 20, otherLeads: { total: 6, leadQuality: { missedCalls: 2 } } }),
    { bucketMissedCalls: 2, totalLeads: 20 },
    "Other-only months count, with parsed-era `total` as the count alias",
  );
  const hideSymmetric = {
    totalLeads: 50,
    googleAds: { leadQuality: { missedCalls: 5 } },
    otherLeads: { count: 10, leadQuality: { missedCalls: 3 } },
  };
  assert.deepEqual(
    sumMissedCallBucketInputs(hideSymmetric),
    { bucketMissedCalls: 8, totalLeads: 50 },
    "hideOtherLeads off: Other folds into BOTH sides",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs(hideSymmetric, { hideOtherLeads: true }),
    { bucketMissedCalls: 5, totalLeads: 40 },
    "hideOtherLeads on: Other leaves numerator AND denominator (same lead set as the card)",
  );
  assert.deepEqual(
    sumMissedCallBucketInputs(cambridgeMarketing),
    { bucketMissedCalls: 0, totalLeads: 340 },
    "Cambridge class: leads without missed-call buckets → zero numerator",
  );

  // === displayedSupportingMetric: deep-dive supporting-metric cards ===
  // Regression class caught in review: an ABSENT (never entered, unflagged)
  // supporting metric must render the "No Data" card, not a healthy/critical
  // looking 0 — only flagged values used to get the No Data branch.
  assert.equal(displayedSupportingMetric(undefined, undefined, true), null, "absent → No Data card");
  assert.equal(displayedSupportingMetric(null, false, true), null, "null → No Data card");
  assert.equal(displayedSupportingMetric(9, true, true), null, "No-Data flag beats a stored value");
  assert.equal(displayedSupportingMetric(0, undefined, true), 0, "entered 0 is a real measurement");
  assert.equal(displayedSupportingMetric(0, undefined, false), null, "legacy blank-coerced 0 → No Data card");
  assert.equal(displayedSupportingMetric("6.5", undefined, true), 6.5, "persisted numeric string coerces");
  assert.equal(displayedSupportingMetric(130, false, true, { clampAsPercent: true }), 100, "rate-unit card clamps absurd legacy rates to 100");
  assert.equal(displayedSupportingMetric(0, false, true, { clampAsPercent: true }), 0, "clamping keeps an entered 0% real");
  assert.equal(displayedSupportingMetric(0, false, false, { clampAsPercent: true }), null, "clamping never resurrects a legacy 0");
  assert.equal(
    displayedSupportingMetric(undefined, false, true, { clampAsPercent: true }),
    null,
    "absent rate → No Data, never a clamped 0%",
  );

  // Card ↔ trend agreement for the SAME month payload: what the card shows as
  // "No Data" the trend must emit as null, and a stored 0 shows/plots in both.
  const absentIntakeEntry = buildIntakeTrendEntry({}, "free");
  assert.equal(
    displayedSupportingMetric(undefined, undefined, false),
    absentIntakeEntry.avgTimeToAnswer,
    "absent avgTimeToAnswer: card and trend agree (both null)",
  );
  const absentSalesEntry = buildSalesTrendEntry({}, "free");
  assert.equal(
    displayedSupportingMetric(undefined, undefined, false, { clampAsPercent: true }),
    absentSalesEntry.noShowRate,
    "absent noShowRate: card and trend agree (both null)",
  );
  const zeroNoShowEntry = buildSalesTrendEntry({ noShowRate: 0, noDataFlags: {} }, "free");
  assert.equal(
    displayedSupportingMetric(0, false, true, { clampAsPercent: true }),
    zeroNoShowEntry.noShowRate,
    "entered-0 noShowRate: card shows 0% and trend plots 0",
  );
  const legacyZeroNoShowEntry = buildSalesTrendEntry({ noShowRate: 0 }, "free");
  assert.equal(legacyZeroNoShowEntry.noShowRate, null, "legacy stored-0 noShowRate: trend plots null");
  assert.equal(
    displayedSupportingMetric(0, false, false, { clampAsPercent: true }),
    legacyZeroNoShowEntry.noShowRate,
    "legacy stored-0 noShowRate: card No Data and trend null agree",
  );

  // === Benchmark targets: single source for client card + server trend ===
  assert.equal(getIntakeTargetRate("paid"), 45, "intake target, paid consults");
  assert.equal(getIntakeTargetRate("free"), 65, "intake target, free consults");
  assert.equal(getIntakeTargetRate(undefined), 65, "intake target defaults to free");
  assert.equal(getSalesTargetRate("paid"), 40, "sales target, paid consults");
  assert.equal(getSalesTargetRate("free"), 30, "sales target, free consults");
  assert.equal(getSalesTargetRate(null), 30, "sales target defaults to free");

  // === computeExecutionScore: the shared IES/ESQ blend ===
  // No quality entered → null ("No Data"), never a fabricated 0.
  assert.equal(computeExecutionScore(null, 50, 65), null, "no quality → null");
  assert.equal(computeExecutionScore(0, 50, 65), null, "quality 0 (blank save) → null");
  // Quality entered, conversion rate missing → raw quality UNROUNDED. This is
  // the exact card value from the bug report (39.56) that the trend must match.
  assert.equal(computeExecutionScore(39.56, null, 65), 39.56, "missing rate → raw quality fallback");
  assert.equal(computeExecutionScore(39.56, 0, 65), 39.56, "rate 0 (blank save) → raw quality fallback");
  assert.equal(computeExecutionScore("39.56", null, 65), 39.56, "string quality coerces in fallback");
  // Below target: scales down linearly. R = 32.5/65 = 0.5 → 80 × 0.5 = 40.
  assert.equal(computeExecutionScore(80, 32.5, 65), 40, "below-target blend scales down");
  // Above target: half credit. R = 78/65 = 1.2 → 80 × 1.1 = 88.
  assert.equal(computeExecutionScore(80, 78, 65), 88, "above-target blend earns half credit");
  // Capped at 100. R = 100/40 = 2.5 → 95 × 1.75 = 166.25 → 100.
  assert.equal(computeExecutionScore(95, 100, 40), 100, "blend caps at 100");
  // Absurd legacy persisted rate routes through clampPercent before blending:
  // 5300 → 100, R = 100/65 → 60 × 1.2692… = 76.15 → 76.
  assert.equal(computeExecutionScore(60, 5300, 65), 76, "absurd rate clamps before blending");

  // === hasGenuineConsultBookingData: the auto-flip predicate ===
  // A quality score alone no longer flips consult_bookings to "available" —
  // that was how no-consult-data clients got fabricated 0% report metrics.
  assert.equal(
    hasGenuineConsultBookingData({ qualityScore: 88 } as any),
    false,
    "quality score alone is not consult-booking data",
  );
  assert.equal(hasGenuineConsultBookingData({}), false, "empty section has no consult data");
  assert.equal(
    hasGenuineConsultBookingData({ totalConsults: 0, leadToConsultRate: 0 }),
    false,
    "blank-saved-as-0 consult fields are not consult data",
  );
  assert.equal(
    hasGenuineConsultBookingData({ totalConsults: 12 }),
    true,
    "a consult count is genuine consult data",
  );
  assert.equal(
    hasGenuineConsultBookingData({ leadToConsultRate: 40 }),
    true,
    "a lead→consult rate is genuine consult data",
  );
  assert.equal(
    hasGenuineConsultBookingData({ totalConsults: 12, noDataFlags: { totalConsults: true } }),
    false,
    "No-Data-flagged consults are not consult data",
  );

  // === buildIntakeTrendEntry: null for missing metric-months, never fake 0 ===
  const emptyIntake = buildIntakeTrendEntry({}, "free");
  assert.equal(emptyIntake.totalConsults, null, "empty month: consults null");
  assert.equal(emptyIntake.leadToConsultRate, null, "empty month: rate null");
  assert.equal(emptyIntake.missedCallRate, null, "empty month: missed-call null");
  assert.equal(emptyIntake.avgTimeToAnswer, null, "empty month: time-to-answer null");
  assert.equal(emptyIntake.qualityScore, null, "empty month: quality null");
  assert.equal(emptyIntake.intakeExecutionScore, null, "empty month: IES null");

  // THE card/trend agreement case from the bug report: a month with only a
  // quality score entered plots the same 39.56 the card shows — not 0.
  const qualityOnly = buildIntakeTrendEntry({ qualityScore: 39.56 }, "free");
  assert.equal(qualityOnly.qualityScore, 39.56, "quality-only month keeps quality");
  assert.equal(qualityOnly.intakeExecutionScore, 39.56, "quality-only month: IES = raw quality (matches card)");
  assert.equal(qualityOnly.totalConsults, null, "quality-only month: consults stay null");
  assert.equal(qualityOnly.leadToConsultRate, null, "quality-only month: rate stays null");
  assert.equal(
    qualityOnly.intakeExecutionScore,
    computeExecutionScore(39.56, null, getIntakeTargetRate("free")),
    "trend IES routes through the same shared computation as the card",
  );

  // Full month: everything plots, IES blends. The month's buckets carry the
  // missed calls, so the trend point is the same-lead-set recompute (which
  // here agrees with the stored rate the write path stamped).
  const fullIntake = buildIntakeTrendEntry(
    { totalConsults: 18, leadToConsultRate: 32.5, missedCallRate: 25, avgTimeToAnswer: 2.4, qualityScore: 80, noDataFlags: {} },
    "free",
    { bucketMissedCalls: 5, totalLeads: 20 },
  );
  assert.equal(fullIntake.totalConsults, 18, "full month: consults plot");
  assert.equal(fullIntake.leadToConsultRate, 32.5, "full month: rate plots");
  assert.equal(fullIntake.missedCallRate, 25, "full month: bucket-backed recompute plots");
  assert.equal(fullIntake.avgTimeToAnswer, 2.4, "full month: time-to-answer plots");
  assert.equal(fullIntake.intakeExecutionScore, 40, "full month: IES blends (80 × 0.5)");

  // Task #4983 — every month resolves through the SAME three tiers as the
  // card: bucket recompute → stored > 0 → null. Both write paths historically
  // stamped recomputed 0s over months with no call tracking, so "0 with lead
  // volume" is indistinguishable from "not tracked" and plots null; and a
  // stale stored value can never contradict what the buckets counted.
  const flagEraNoEvidence = buildIntakeTrendEntry({ missedCallRate: 0, noDataFlags: {} }, "free");
  assert.equal(flagEraNoEvidence.missedCallRate, null, "flag-era 0 rate without bucket sums → null");
  const staleZero = buildIntakeTrendEntry({ missedCallRate: 0 }, "free", { bucketMissedCalls: 5, totalLeads: 20 });
  assert.equal(staleZero.missedCallRate, 25, "a stale stored 0 never masks counted missed calls — the point is the recompute");
  // THE review-caught divergence class: an in-range stored rate that
  // CONFLICTS with the month's buckets. The card recomputes 25% from the
  // buckets, so the trend must plot 25 — never the stale 55.
  const staleStored = buildIntakeTrendEntry({ missedCallRate: 55 }, "free", { bucketMissedCalls: 5, totalLeads: 20 });
  assert.equal(staleStored.missedCallRate, 25, "bucket-backed months RECOMPUTE: a conflicting stored 55 never plots");
  assert.equal(
    staleStored.missedCallRate,
    resolveMissedCallRate({ bucketMissedCalls: 5, totalLeads: 20, storedRate: 55 }),
    "trend point IS the card resolver's tier-1 value for the same inputs",
  );
  const legacyNoEvidence = buildIntakeTrendEntry({ missedCallRate: 0 }, "free");
  assert.equal(legacyNoEvidence.missedCallRate, null, "legacy 0 rate without bucket sums → null");
  // Prod-pinned (replica 2026-08-18): Parman & Easterday 2026-07 carries a
  // pushed 9.5 with all-zero buckets — the trend keeps plotting the pushed
  // rate even though the month has no bucket evidence.
  const pushedNoBuckets = buildIntakeTrendEntry({ missedCallRate: 9.5 }, "free", { bucketMissedCalls: 0, totalLeads: 137 });
  assert.equal(pushedNoBuckets.missedCallRate, 9.5, "pushed rate plots even with zero buckets (Parman class)");
  const nonzeroNoEvidence = buildIntakeTrendEntry({ missedCallRate: 7.5 }, "free");
  assert.equal(nonzeroNoEvidence.missedCallRate, 7.5, "nonzero rate always passes");
  // Cambridge class end-to-end agreement: the call sites feed the month's
  // own marketing section through sumMissedCallBucketInputs, and the trend
  // point matches the card-side resolver — "No data" on both surfaces.
  const cambridgeEntry = buildIntakeTrendEntry({}, "free", sumMissedCallBucketInputs(cambridgeMarketing));
  assert.equal(cambridgeEntry.missedCallRate, null, "Cambridge 2026-07: intake {} + 340 leads → null, never 0%");
  assert.equal(
    resolveMissedCallRate({ bucketMissedCalls: 0, totalLeads: 340, storedRate: undefined }),
    cambridgeEntry.missedCallRate,
    "card resolver and trend entry agree: No data on both surfaces",
  );

  // Legacy intake section: a blank-coerced avgTimeToAnswer 0 plots null; the
  // same 0 in a flag-era section is an entered measurement and plots.
  assert.equal(buildIntakeTrendEntry({ avgTimeToAnswer: 0 }, "free").avgTimeToAnswer, null, "legacy 0 time-to-answer → null");
  assert.equal(buildIntakeTrendEntry({ avgTimeToAnswer: 0, noDataFlags: {} }, "free").avgTimeToAnswer, 0, "flag-era entered 0 time-to-answer plots");

  // The consults No-Data flag suppresses BOTH consult count and rate (they
  // share one entry checkbox), and IES falls back to raw quality.
  const flaggedIntake = buildIntakeTrendEntry(
    { totalConsults: 10, leadToConsultRate: 50, qualityScore: 70, noDataFlags: { totalConsults: true } },
    "free",
  );
  assert.equal(flaggedIntake.totalConsults, null, "flagged consults → null");
  assert.equal(flaggedIntake.leadToConsultRate, null, "flagged consults suppress the rate too");
  assert.equal(flaggedIntake.intakeExecutionScore, 70, "flagged rate → IES falls back to raw quality");
  const flaggedTime = buildIntakeTrendEntry(
    { avgTimeToAnswer: 3, noDataFlags: { avgTimeToAnswer: true } },
    "free",
  );
  assert.equal(flaggedTime.avgTimeToAnswer, null, "flagged time-to-answer → null");

  // Paid consult type uses the 45% intake target: R = 22.5/45 = 0.5 → 40.
  const paidIntake = buildIntakeTrendEntry({ qualityScore: 80, leadToConsultRate: 22.5 }, "paid");
  assert.equal(paidIntake.intakeExecutionScore, 40, "paid consult type blends against 45% target");

  // === buildSalesTrendEntry: same rules for the sales series ===
  const emptySales = buildSalesTrendEntry({}, "paid");
  assert.equal(emptySales.totalCases, null, "empty month: cases null");
  assert.equal(emptySales.consultToCaseRate, null, "empty month: rate null");
  assert.equal(emptySales.avgCaseValue, null, "empty month: case value null");
  assert.equal(emptySales.noShowRate, null, "empty month: no-show null");
  assert.equal(emptySales.avgFollowUps, null, "empty month: follow-ups null");
  assert.equal(emptySales.pipelineMomentumScore, null, "empty month: momentum null");
  assert.equal(emptySales.effectiveSalesQuality, null, "empty month: ESQ null");

  // ESQ gains the same missing-rate fallback IES already had: a quality-only
  // month plots the raw quality instead of blending against a missing rate.
  const salesQualityOnly = buildSalesTrendEntry({ qualityScore: 74 }, "paid");
  assert.equal(salesQualityOnly.effectiveSalesQuality, 74, "quality-only month: ESQ = raw quality");
  assert.equal(salesQualityOnly.totalCases, null, "quality-only month: cases stay null");

  const fullSales = buildSalesTrendEntry(
    { totalCases: 6, consultToCaseRate: 20, averageCaseValue: 8000, noShowRate: 0, avgFollowUps: 5, pipelineMomentumScore: 55, qualityScore: 80, noDataFlags: {} },
    "paid",
  );
  assert.equal(fullSales.totalCases, 6, "full month: cases plot");
  assert.equal(fullSales.consultToCaseRate, 20, "full month: rate plots");
  assert.equal(fullSales.avgCaseValue, 8000, "full month: case value plots");
  assert.equal(fullSales.noShowRate, 0, "full month: entered 0 no-show rate plots as 0");
  assert.equal(fullSales.avgFollowUps, 5, "full month: follow-ups plot");
  assert.equal(fullSales.pipelineMomentumScore, 55, "full month: momentum plots");
  assert.equal(fullSales.effectiveSalesQuality, 40, "full month: ESQ blends (80 × 20/40)");

  // Legacy sales section (no noDataFlags key): the production sweep found the
  // bulk of legacy sections storing noShowRate/avgFollowUps 0 — blank-coerced,
  // not measured. They plot null, never a healthy "0% no-shows" or a critical
  // "0 follow-ups"; genuinely entered nonzero values still pass.
  const legacySales = buildSalesTrendEntry({ noShowRate: 0, avgFollowUps: 0 }, "paid");
  assert.equal(legacySales.noShowRate, null, "legacy 0 no-show rate → null");
  assert.equal(legacySales.avgFollowUps, null, "legacy 0 follow-ups → null");
  const legacySalesEntered = buildSalesTrendEntry({ noShowRate: 18, avgFollowUps: 6 }, "paid");
  assert.equal(legacySalesEntered.noShowRate, 18, "legacy nonzero no-show rate passes");
  assert.equal(legacySalesEntered.avgFollowUps, 6, "legacy nonzero follow-ups pass");

  // Blank-saved-as-0 avg case value is "not entered" — it must never render
  // as a $0 case value or a $0 recoverable-revenue line.
  const zeroCaseValue = buildSalesTrendEntry({ averageCaseValue: 0 }, "paid");
  assert.equal(zeroCaseValue.avgCaseValue, null, "avg case value 0 → null (not entered)");

  const flaggedSales = buildSalesTrendEntry(
    { totalCases: 4, consultToCaseRate: 25, noShowRate: 12, avgFollowUps: 3, noDataFlags: { totalCases: true, noShowRate: true, avgFollowUps: true } },
    "paid",
  );
  assert.equal(flaggedSales.totalCases, null, "flagged cases → null");
  assert.equal(flaggedSales.consultToCaseRate, null, "flagged cases suppress the rate too");
  assert.equal(flaggedSales.noShowRate, null, "flagged no-show → null");
  assert.equal(flaggedSales.avgFollowUps, null, "flagged follow-ups → null");

  // Free consult type uses the 30% sales target: R = 33/30 = 1.1 → 80 × 1.05 = 84.
  const freeSales = buildSalesTrendEntry({ qualityScore: 80, consultToCaseRate: 33 }, "free");
  assert.equal(freeSales.effectiveSalesQuality, 84, "free consult type blends against 30% target");

  console.log("report-metric-presence.test.ts: all assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
