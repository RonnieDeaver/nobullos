import {
  CANONICAL_PRODUCTS,
  type CanonicalProduct,
  resolveEffectiveProducts,
} from "./productResolution";

export const PLATFORMS_WITH_LEAD_QUALITY = ["gbp", "google_ads", "lsa", "webinar"] as const;
export type LeadQualityPlatform = typeof PLATFORMS_WITH_LEAD_QUALITY[number];

export interface LeadQualityCounts {
  good: number;
  notQuotable: number;
  missedCalls: number;
  noData: number;
}

export const EMPTY_LEAD_QUALITY: LeadQualityCounts = {
  good: 0,
  notQuotable: 0,
  missedCalls: 0,
  noData: 0,
};

export function addLeadQuality(
  a: LeadQualityCounts,
  b: Partial<LeadQualityCounts> | null | undefined,
): LeadQualityCounts {
  return {
    good: (a.good || 0) + (b?.good || 0),
    notQuotable: (a.notQuotable || 0) + (b?.notQuotable || 0),
    missedCalls: (a.missedCalls || 0) + (b?.missedCalls || 0),
    noData: (a.noData || 0) + (b?.noData || 0),
  };
}

export function leadQualityTotal(c: LeadQualityCounts): number {
  return (c.good || 0) + (c.notQuotable || 0) + (c.missedCalls || 0) + (c.noData || 0);
}

function normalizeLeadQuality(lq: any): LeadQualityCounts {
  return {
    good: Number(lq?.good) || 0,
    notQuotable: Number(lq?.notQuotable) || 0,
    missedCalls: Number(lq?.missedCalls) || 0,
    noData: Number(lq?.noData) || 0,
  };
}

export interface GbpLeadQualityReading {
  /** The canonical counts every GBP lead-quality surface renders. */
  counts: LeadQualityCounts;
  /** Which stored shape produced `counts`. */
  source: "rollup" | "locations" | "none";
  /** Normalized `gbpLeadQuality` rollup, when that key exists. */
  rollup: LeadQualityCounts | null;
  /** Sum across per-location buckets, when any location rows exist. */
  locationSum: LeadQualityCounts | null;
  /**
   * True when BOTH shapes carry data and disagree — e.g. a manual form edit
   * of the aggregate left it out of sync with the per-location buckets. The
   * canonical counts still come from the rollup so every consumer renders
   * the same numbers; this flag exists so divergent data is loggable.
   */
  divergent: boolean;
}

/**
 * Task #3771: the ONE way to read GBP lead quality from a marketing block.
 *
 * Precedence: the `gbpLeadQuality` rollup (operator-entered or webhook/
 * reparse-derived) wins whenever it exists; the per-location bucket sum is
 * the fallback. This matches what the Leads Quality Breakdown bar/legend/
 * totals/donuts have always shown. The headline previously used the OPPOSITE
 * precedence (locations first), so when the two shapes disagreed the "% Good"
 * headline contradicted the bar right under it (Ackah: 47% vs 38%). Every
 * reader — `computeQualityHeadline`, the public renderer's card aggregation,
 * the "% Good Leads by Source" trend, and `aggregateActiveLeadQuality` —
 * routes through here so the card can never disagree with itself.
 */
export function readGbpLeadQuality(marketing: any): GbpLeadQualityReading {
  const locs = marketing?.gbp?.locations || marketing?.gbpLocations || [];
  let locationSum: LeadQualityCounts | null = null;
  if (Array.isArray(locs) && locs.length > 0) {
    let acc: LeadQualityCounts = { ...EMPTY_LEAD_QUALITY };
    for (const loc of locs) acc = addLeadQuality(acc, loc?.leadQuality);
    locationSum = acc;
  }
  const rollupRaw = marketing?.gbpLeadQuality;
  const rollup =
    rollupRaw && typeof rollupRaw === "object" ? normalizeLeadQuality(rollupRaw) : null;
  const counts = rollup ?? locationSum ?? { ...EMPTY_LEAD_QUALITY };
  const divergent =
    rollup !== null &&
    locationSum !== null &&
    leadQualityTotal(locationSum) > 0 &&
    (rollup.good !== locationSum.good ||
      rollup.notQuotable !== locationSum.notQuotable ||
      rollup.missedCalls !== locationSum.missedCalls ||
      rollup.noData !== locationSum.noData);
  return {
    counts: { ...counts },
    source: rollup ? "rollup" : locationSum ? "locations" : "none",
    rollup,
    locationSum,
    divergent,
  };
}

export function platformLeadQuality(marketing: any, platform: LeadQualityPlatform): LeadQualityCounts {
  if (!marketing) return { ...EMPTY_LEAD_QUALITY };
  if (platform === "gbp") {
    // Task #3771: canonical rollup-first reader — keeps the headline in
    // lock-step with the breakdown bar/legend that always preferred the
    // rollup.
    return readGbpLeadQuality(marketing).counts;
  }
  if (platform === "google_ads") return { ...EMPTY_LEAD_QUALITY, ...(marketing.googleAds?.leadQuality || {}) };
  if (platform === "lsa") return { ...EMPTY_LEAD_QUALITY, ...(marketing.lsa?.leadQuality || {}) };
  if (platform === "webinar") return { ...EMPTY_LEAD_QUALITY, ...((marketing.webinar || marketing.webinars)?.leadQuality || {}) };
  return { ...EMPTY_LEAD_QUALITY };
}

export interface QualityHeadline {
  /**
   * % Good of RATED leads (good + notQuotable + missedCalls). NULL when
   * nothing was rated — render "—"/"not yet rated", never a 0% or 100% off
   * an empty denominator.
   */
  qualityPercent: number | null;
  /** (Good + NotQuotable) / (Good + NotQuotable + MissedCalls); null when that denominator is 0. */
  answerRatePercent: number | null;
  /** Task #4914 coverage: leads with a KNOWN disposition (good + NQ + missed). */
  ratedCount: number;
  /** Task #4914 coverage: leads nobody could rate (the "No data" bucket). */
  noDataCount: number;
  /** Task #4914 coverage: ratedCount / (ratedCount + noDataCount); null when there are no leads at all. */
  ratedPercent: number | null;
  contributingPlatforms: LeadQualityPlatform[];
  totals: LeadQualityCounts;
}

/**
 * Canonical Lead Quality headline for the marketing slide.
 *
 *  - Only platforms in `activeProducts` AND PLATFORMS_WITH_LEAD_QUALITY contribute.
 *    "Other" is intentionally excluded — those leads aren't generated by us so we
 *    don't measure their quality. (Task #1028's ghost-product fix stays: the
 *    Wanta Thome 30% bug came from a GBP block on a Google-Ads-only client
 *    inflating the denominator with NoData rows.)
 *  - Webinar is excluded by default (matches `totalLeadsExcludingWebinar`).
 *  - Task #4914 (owner decision — deliberately supersedes Task #1028's
 *    all-buckets denominator): the quality % answers "of the leads we could
 *    actually RATE, how many were good?". rated = Good + NotQuotable +
 *    MissedCalls — every KNOWN disposition. Missed stays in the denominator:
 *    it is a known bad outcome and keeps call-handling accountability. The
 *    "No data" bucket (leads nobody could rate) is a COVERAGE problem, not a
 *    quality signal, so it moves out of the quality denominator and into the
 *    coverage outputs below. Under the old math a no-data-heavy month
 *    (Cambridge Immigration July 2026: 48 good / 40 NQ / 0 missed / 154 no
 *    data) read "20% Good" when 55% of the rated leads were good.
 *  - qualityPercent is NULL when rated = 0 — render "—"/"not yet rated",
 *    never 0% or 100% off an empty denominator.
 *  - Answer Rate % = (Good + NotQuotable) / (Good + NotQuotable + MissedCalls)
 *    surfaces missed-call performance separately — unchanged by #4914 (its
 *    denominator was already the rated set).
 *  - Coverage outputs: ratedCount, noDataCount, ratedPercent = rated /
 *    (rated + noData). The deck renders these beside every quality % so the
 *    excluded No-data leads stay visible, never hidden.
 */
export function computeQualityHeadline(
  marketing: any,
  activeProducts: CanonicalProduct[],
  options: { includeWebinar?: boolean } = {},
): QualityHeadline {
  const includeWebinar = options.includeWebinar ?? false;
  const contributing: LeadQualityPlatform[] = [];
  let totals: LeadQualityCounts = { ...EMPTY_LEAD_QUALITY };
  for (const p of PLATFORMS_WITH_LEAD_QUALITY) {
    if (!activeProducts.includes(p)) continue;
    if (p === "webinar" && !includeWebinar) continue;
    const counts = platformLeadQuality(marketing, p);
    if (counts.good + counts.notQuotable + counts.missedCalls + counts.noData === 0) continue;
    contributing.push(p);
    totals = addLeadQuality(totals, counts);
  }
  // Task #4914 — `rated` is the quality denominator AND the Answer Rate
  // denominator (that sum is what Answer Rate always used; its math is
  // unchanged).
  const rated = totals.good + totals.notQuotable + totals.missedCalls;
  const ratedPlusNoData = rated + totals.noData;
  return {
    qualityPercent: rated > 0 ? Math.round((totals.good / rated) * 100) : null,
    answerRatePercent: rated > 0
      ? Math.round(((totals.good + totals.notQuotable) / rated) * 100)
      : null,
    ratedCount: rated,
    noDataCount: totals.noData,
    ratedPercent: ratedPlusNoData > 0 ? Math.round((rated / ratedPlusNoData) * 100) : null,
    contributingPlatforms: contributing,
    totals,
  };
}

export { resolveEffectiveProducts, CANONICAL_PRODUCTS };
export type { CanonicalProduct };
