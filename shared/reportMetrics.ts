/**
 * Task #3688 — Report metric data-presence + execution-score single source.
 *
 * The public report's consult/sales metrics used to be unlocked by the
 * per-client Data Access toggle (`client_data_access`), which produced two
 * bug classes:
 *
 *   1. Fabricated values — a toggle flipped "available" (e.g. by saving an
 *      intake section that only had a quality score) rendered a red "0%"
 *      Leads→Consults metric and 0 consults for a client who never entered
 *      consult data.
 *   2. Card-vs-trend divergence — the Intake Execution Score card fell back
 *      to the raw quality score when the lead→consult rate was missing,
 *      while the server's trend builder multiplied by the missing rate and
 *      plotted 0 for every month (card 39.56 vs trend 0).
 *
 * New rule: every metric is driven purely by data presence. A value that was
 * entered displays; one that wasn't shows "No Data" — never a fabricated 0.
 * Both the client report page and the server trend builders (main + demo
 * endpoints) resolve presence and compute IES/ESQ through THIS module so the
 * card and its trend can never diverge again.
 *
 * Historical-report sweep: whether a stored 0 on an observational metric is
 * a real measurement depends on the section's era. Sections saved since the
 * No-Data-flag era always carry a `noDataFlags` key, so an unflagged 0 there
 * was deliberately entered and displays. Legacy sections predate the key and
 * their blank fields were coerced to 0 on save — a stored 0 there is
 * indistinguishable from "never entered" and renders "No Data" instead
 * (see {@link sectionHasEntryTracking}). The missed-call rate is PUSHED from
 * client call reporting (or typed) rather than entered per-save, so its
 * stored 0 is gated on missed-call bucket evidence
 * ({@link hasMissedCallBucketEvidence}) in EVERY era (Task #4983): both the
 * form and the imports historically stamped recomputed 0s over months with
 * no call tracking at all, so a stored 0 without a counted missed call in
 * the buckets is fabricated, not measured. Bare lead volume
 * ({@link hasLeadVolumeEvidence}) stays the gate for the OTHER derived
 * lead-data consumers — a month can have hundreds of leads and no call
 * tracking.
 */
import { applyHideOtherLeads, clampPercent } from "./missedCallRate";

/** Coerce persisted JSON values (which can drift to numeric strings) to a number. */
function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Presence rule for entered counts/rates/scores (totalConsults,
 * leadToConsultRate, totalCases, consultToCaseRate, averageCaseValue,
 * quality scores, pipeline momentum): the value counts as provided only when
 * it is a positive number AND not No-Data-flagged. The ReportForm saves
 * blank fields as 0, so a stored 0 for these metrics means "not entered",
 * not a measured zero.
 */
export function isMetricEntered(value: unknown, noDataFlagged?: boolean): boolean {
  if (noDataFlagged) return false;
  const n = toFiniteNumber(value);
  return n !== null && n > 0;
}

/** Numeric value when entered (per {@link isMetricEntered}), else null. */
export function enteredMetricOrNull(value: unknown, noDataFlagged?: boolean): number | null {
  return isMetricEntered(value, noDataFlagged) ? toFiniteNumber(value) : null;
}

/**
 * Presence rule for stored observational metrics where an ENTERED 0 is a
 * legitimate measurement (missedCallRate, avgTimeToAnswer, noShowRate,
 * avgFollowUps): null when absent or No-Data-flagged, and — because legacy
 * sections coerced blank fields to 0 on save — null for a stored 0 unless
 * the section proves the 0 was entered (`hasEntryTracking`, see
 * {@link sectionHasEntryTracking}; for the derived missed-call rate pass
 * lead-volume evidence instead). Nonzero values display in every era.
 *
 * `hasEntryTracking` is required so every caller decides the era question
 * explicitly — a forgotten argument fails the build instead of silently
 * fabricating measurements out of legacy blanks.
 */
export function storedMetricOrNull(
  value: unknown,
  noDataFlagged: boolean | undefined,
  hasEntryTracking: boolean,
): number | null {
  if (noDataFlagged) return null;
  const n = toFiniteNumber(value);
  if (n === null) return null;
  if (n === 0 && !hasEntryTracking) return null;
  return n;
}

/**
 * Display resolution for a supporting-metric card on the deep-dive slides
 * (Avg Time to Human Answer, No-Show Rate). Same presence rule as
 * {@link storedMetricOrNull} — absent, No-Data-flagged, or a legacy
 * blank-coerced 0 → null, which the card renders as "No Data"; an entered 0
 * is a real measurement — with optional percent clamping for rate-unit
 * metrics so a legacy absurd persisted rate can't render. The server trend
 * builders route the SAME fields through storedMetricOrNull, so a card can
 * never show a value (or a fabricated 0) for a month whose trend point is
 * null.
 */
export function displayedSupportingMetric(
  value: unknown,
  noDataFlagged: boolean | undefined,
  hasEntryTracking: boolean,
  options?: { clampAsPercent?: boolean },
): number | null {
  const n = storedMetricOrNull(value, noDataFlagged, hasEntryTracking);
  if (n === null) return null;
  return options?.clampAsPercent ? clampPercent(n) : n;
}

/**
 * Entry-tracking era marker for a report section's stored JSON. The
 * ReportForm has written the `noDataFlags` key on every save since the flag
 * era began (even when every flag is false), so key presence means blank
 * fields were saved deliberately: an unflagged stored 0 was typed. Sections
 * without the key predate tracking; their blank fields were coerced to 0 by
 * the old `|| 0` save path, so a stored 0 there means "never entered".
 */
export function sectionHasEntryTracking(sectionData: unknown): boolean {
  return (
    !!sectionData &&
    typeof sectionData === "object" &&
    "noDataFlags" in (sectionData as Record<string, unknown>)
  );
}

/**
 * Evidence that a report month has ANY entered lead volume in its marketing
 * section. The missed-call rate is never typed by the operator — the form
 * derives it from lead data (`missedCalls / totalLeads`) — so a stored or
 * recomputed 0% is a real measurement only when lead data exists for the
 * month. With no lead volume the derived rate is fabricated in every era
 * (the flag-era form still computes-and-saves 0 over empty lead data), so
 * era tracking alone cannot gate this metric.
 *
 * The shapes inspected mirror everything PublicReport's displayed Total
 * Leads counts across storage generations: root totalLeads, the root and
 * per-source leadQuality buckets (good/notQuotable/missedCalls/noData), the
 * `gbpLeadQuality` rollup written by webhook ingest, per-GBP-location
 * uniqueLeads + buckets (`gbp.locations` and legacy `gbpLocations`),
 * googleAds/lsa uniqueLeads, webinar hotTransfers + buckets (webinar quality
 * counts as volume even at zero transfers, and the legacy `webinars` alias
 * is honored), and the Other bucket's count + buckets. A false negative here
 * turns a real 0% month into "No Data" — when the form grows a new lead
 * source, add its stored shape.
 */
export function hasLeadVolumeEvidence(marketingData: unknown): boolean {
  if (!marketingData || typeof marketingData !== "object") return false;
  const m = marketingData as any;
  const qualityBuckets = (lq: any): unknown[] =>
    lq && typeof lq === "object"
      ? [lq.good, lq.notQuotable, lq.missedCalls, lq.noData]
      : [];
  const webinar = m.webinar ?? m.webinars;
  const candidates: unknown[] = [
    m.totalLeads,
    m.googleAds?.uniqueLeads,
    m.lsa?.uniqueLeads,
    webinar?.hotTransfers,
    m.otherLeads?.count,
    ...qualityBuckets(m.leadQuality),
    ...qualityBuckets(m.gbpLeadQuality),
    ...qualityBuckets(m.googleAds?.leadQuality),
    ...qualityBuckets(m.lsa?.leadQuality),
    ...qualityBuckets(webinar?.leadQuality),
    ...qualityBuckets(m.otherLeads?.leadQuality),
  ];
  const gbpLocations = m.gbp?.locations || m.gbpLocations;
  if (Array.isArray(gbpLocations)) {
    for (const loc of gbpLocations) {
      candidates.push(loc?.uniqueLeads, ...qualityBuckets(loc?.leadQuality));
    }
  }
  return candidates.some((c) => (toFiniteNumber(c) ?? 0) > 0);
}

/**
 * Task #4983 — evidence that a report month has ANY real missed-call data in
 * its marketing section: some source's lead-quality bucket actually counted a
 * missed call (`missedCalls > 0`).
 *
 * Missed-call counts are PUSHED from client call reporting (webhook/PDF
 * quality tables) or typed by an operator — the bucket fields are structural
 * defaults (0) otherwise, so bare lead volume ({@link hasLeadVolumeEvidence})
 * cannot vouch for a stored/recomputed 0% missed-call rate: a month can have
 * hundreds of leads and no call tracking at all. This narrower predicate
 * gates the trend's stored missed-call points (and the slide-verdict context)
 * the same way the public card gates its display — no evidence → null →
 * "No data", never a fabricated healthy 0%.
 *
 * Shape walk mirrors {@link hasLeadVolumeEvidence}'s bucket coverage but
 * inspects ONLY the `missedCalls` field of each bucket: root `leadQuality`,
 * the webhook `gbpLeadQuality` rollup, googleAds/lsa/webinar (+ legacy
 * `webinars` alias)/otherLeads buckets, and per-GBP-location buckets
 * (`gbp.locations` and legacy `gbpLocations`). When the form grows a new lead
 * source, extend BOTH predicates together.
 */
export function hasMissedCallBucketEvidence(marketingData: unknown): boolean {
  if (!marketingData || typeof marketingData !== "object") return false;
  const m = marketingData as any;
  const webinar = m.webinar ?? m.webinars;
  const candidates: unknown[] = [
    m.leadQuality?.missedCalls,
    m.gbpLeadQuality?.missedCalls,
    m.googleAds?.leadQuality?.missedCalls,
    m.lsa?.leadQuality?.missedCalls,
    webinar?.leadQuality?.missedCalls,
    m.otherLeads?.leadQuality?.missedCalls,
  ];
  const gbpLocations = m.gbp?.locations || m.gbpLocations;
  if (Array.isArray(gbpLocations)) {
    for (const loc of gbpLocations) {
      candidates.push(loc?.leadQuality?.missedCalls);
    }
  }
  return candidates.some((c) => (toFiniteNumber(c) ?? 0) > 0);
}

/**
 * Same-lead-set missed-call resolver inputs from a STORED marketing section
 * (Task #4983) — the `{ bucketMissedCalls, totalLeads }` pair that
 * `resolveMissedCallRate` tier 1 needs, mirroring the persist-time recompute
 * contract (Task #2680): numerator = the active-set per-source bucket sum
 * plus Other's missed calls, denominator = the stored grand total (which
 * includes Other), then the per-client hideOtherLeads toggle applied
 * symmetrically to BOTH sides. Server surfaces that resolve a stored month
 * (trend entries, slide-verdict context) share this one aggregation so they
 * can never disagree with each other about what the buckets say.
 *
 * Shape rules (stored-section grain — the same walk as
 * {@link hasMissedCallBucketEvidence} minus double counting):
 *   - GBP: the persisted `gbpLeadQuality` rollup wins when present (the
 *     Task #3771 render rule: every surface renders the rollup); else the
 *     per-location sum (`gbp.locations`, legacy `gbpLocations`).
 *   - googleAds / lsa / webinar (legacy `webinars`): their `leadQuality`
 *     blocks.
 *   - Legacy root fallback: when NO per-source quality block exists at all,
 *     the persisted root `leadQuality` rollup (active-set, excludes Other)
 *     stands in — old rows carried only that shape.
 *   - Other: `otherLeads.leadQuality.missedCalls`, with `otherLeads.count`
 *     (parsed-era legacy `total`) as the symmetric denominator share.
 */
export function sumMissedCallBucketInputs(
  marketingData: unknown,
  opts?: { hideOtherLeads?: boolean },
): { bucketMissedCalls: number; totalLeads: number } {
  if (!marketingData || typeof marketingData !== "object") {
    return { bucketMissedCalls: 0, totalLeads: 0 };
  }
  const m = marketingData as any;
  const n = (v: unknown): number => toFiniteNumber(v) ?? 0;
  const gbpRollup = m.gbpLeadQuality;
  const gbpLocations = m.gbp?.locations || m.gbpLocations;
  const gbpMissed =
    gbpRollup != null && typeof gbpRollup === "object"
      ? n(gbpRollup.missedCalls)
      : Array.isArray(gbpLocations)
        ? gbpLocations.reduce(
            (sum: number, loc: any) => sum + n(loc?.leadQuality?.missedCalls),
            0,
          )
        : 0;
  const webinar = m.webinar ?? m.webinars;
  const hasPerSourceBlock = [
    gbpRollup,
    Array.isArray(gbpLocations) && gbpLocations.length > 0 ? gbpLocations : undefined,
    m.googleAds?.leadQuality,
    m.lsa?.leadQuality,
    webinar?.leadQuality,
    m.otherLeads?.leadQuality,
  ].some((b) => b != null && typeof b === "object");
  const coreMissed = hasPerSourceBlock
    ? gbpMissed +
      n(m.googleAds?.leadQuality?.missedCalls) +
      n(m.lsa?.leadQuality?.missedCalls) +
      n(webinar?.leadQuality?.missedCalls)
    : n(m.leadQuality?.missedCalls);
  const otherMissedCalls = n(m.otherLeads?.leadQuality?.missedCalls);
  const otherLeadCount = n(m.otherLeads?.count ?? m.otherLeads?.total);
  const adjusted = applyHideOtherLeads({
    missedCalls: coreMissed + otherMissedCalls,
    totalLeads: n(m.totalLeads),
    otherMissedCalls,
    otherLeadCount,
    hideOtherLeads: opts?.hideOtherLeads === true,
  });
  return { bucketMissedCalls: adjusted.missedCalls, totalLeads: adjusted.totalLeads };
}

/**
 * Canonical per-month leads/reviews extraction from a monthly-report
 * marketing section — the single source shared by the churn leaderboard's
 * report-metric chips and the daily judgment's multi-month report history
 * (Task #4292; logic verbatim from the leaderboard's original inline
 * helper). leads = totalLeads gated on hasLeadVolumeEvidence (no evidence →
 * null, never a fabricated 0); reviews = reviewGeneration.totalReviews with
 * the per-source sum fallback, null when the month carries no
 * review-bearing shape.
 */
export function readMonthLeadsReviews(
  month: unknown,
  marketingData: unknown,
): { month: string; leads: number | null; reviews: number | null } | null {
  if (typeof month !== "string" || !month) return null;
  const m: any = marketingData && typeof marketingData === "object" ? marketingData : {};
  const leads = hasLeadVolumeEvidence(m) ? Number(m.totalLeads) || 0 : null;
  const gbpLocations: any[] = Array.isArray(m.gbp?.locations)
    ? m.gbp.locations
    : Array.isArray(m.gbpLocations)
      ? m.gbpLocations
      : [];
  const gbpReviews = gbpLocations.reduce(
    (sum: number, loc: any) => sum + (Number(loc?.reviewsGenerated) || 0),
    0,
  );
  const listReviews = Number(m.reviewGeneration?.list?.reviews) || 0;
  const webinarReviews = Number(m.reviewGeneration?.webinar?.reviews) || 0;
  const otherReviews = Number(m.reviewGeneration?.other?.count) || 0;
  const hasReviewEvidence =
    (m.reviewGeneration != null && typeof m.reviewGeneration === "object") ||
    gbpLocations.length > 0;
  const reviews = hasReviewEvidence
    ? Number(m.reviewGeneration?.totalReviews) ||
      gbpReviews + listReviews + webinarReviews + otherReviews
    : null;
  return { month, leads, reviews };
}

/** Lead→Consult benchmark: 45% for paid-consult firms, 65% for free. */
export function getIntakeTargetRate(consultType: string | null | undefined): number {
  return consultType === "paid" ? 45 : 65;
}

/** Consult→Case benchmark: 40% for paid-consult firms, 30% for free. */
export function getSalesTargetRate(consultType: string | null | undefined): number {
  return consultType === "paid" ? 40 : 30;
}

/**
 * Intake Execution Score / Effective Sales Quality blend.
 *
 * - No quality score entered → null ("No Data" — never 0).
 * - Quality entered but no conversion rate → the raw quality score,
 *   unrounded (the card historically shows e.g. 39.56; the trend now plots
 *   the same series instead of multiplying by the missing rate into 0).
 * - Both entered → quality blended by conversion performance vs target:
 *   below target scales down linearly, above target earns half-credit,
 *   capped at 100. Rates route through clampPercent so a legacy absurd
 *   persisted rate can't skew the blend.
 *
 * Pass conversionRate/rawQuality as null when the input wasn't provided
 * (use {@link enteredMetricOrNull}).
 */
export function computeExecutionScore(
  rawQuality: number | null | undefined,
  conversionRate: number | null | undefined,
  targetRate: number,
): number | null {
  const quality = toFiniteNumber(rawQuality);
  if (quality === null || quality <= 0) return null;
  const rate = toFiniteNumber(conversionRate);
  if (rate === null || rate <= 0) return quality;
  const R = clampPercent(rate) / 100 / (targetRate / 100);
  if (R < 1) return Math.round(quality * R);
  return Math.min(100, Math.round(quality * (1 + (R - 1) * 0.5)));
}

/**
 * Auto-flip predicate for the `consult_bookings` Data Access category on
 * intake-section save: only genuine consult fields (a consult count or a
 * lead→consult rate) mark the category available. A quality score alone no
 * longer flips it — that was how clients with no consult data ended up with
 * fabricated "0%" consult metrics on their reports.
 */
export function hasGenuineConsultBookingData(sectionData: {
  totalConsults?: unknown;
  leadToConsultRate?: unknown;
  noDataFlags?: { totalConsults?: boolean } | null;
}): boolean {
  const consultsFlagged = sectionData?.noDataFlags?.totalConsults === true;
  return (
    isMetricEntered(sectionData?.totalConsults, consultsFlagged) ||
    isMetricEntered(sectionData?.leadToConsultRate, consultsFlagged)
  );
}
