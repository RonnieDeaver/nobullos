/* test-registration
{
  "name": "Active-Products headline + write boundary (Task #1028; rated-based % Task #4914)",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import {
  computeQualityHeadline,
  platformLeadQuality,
  readGbpLeadQuality,
  EMPTY_LEAD_QUALITY,
} from "../shared/activeProductsHeadline";
import { applyActiveProductsFilter } from "../shared/marketingWriteBoundary";

async function run() {
  // === computeQualityHeadline ===

  // Wanta Thome April scenario: Google-Ads-only client whose true headline
  // (Good 9 / NQ 5 → 64%) was historically dragged to ~30% by ghost GBP/LSA
  // NoData rows.
  const wanta = computeQualityHeadline(
    {
      googleAds: { leadQuality: { good: 9, notQuotable: 5, missedCalls: 0, noData: 0 } },
      gbp: { locations: [{ leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 40 } }] },
      lsa: { leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 30 } },
    },
    ["google_ads"],
  );
  assert.equal(wanta.qualityPercent, 64, "single-product headline = Good / rated (Good+NQ+Missed) of that product");
  assert.deepEqual(wanta.contributingPlatforms, ["google_ads"]);
  assert.equal(wanta.totals.noData, 0, "ghost rows for inactive products must be ignored");

  const empty = computeQualityHeadline({}, ["google_ads"]);
  assert.equal(empty.qualityPercent, null);
  assert.equal(empty.answerRatePercent, null);
  assert.deepEqual(empty.contributingPlatforms, []);
  assert.equal(empty.ratedCount, 0);
  assert.equal(empty.noDataCount, 0);
  assert.equal(empty.ratedPercent, null, "no leads at all → coverage % is null, not 0 or 100");

  const multi = computeQualityHeadline(
    {
      googleAds: { leadQuality: { good: 10, notQuotable: 10, missedCalls: 0, noData: 0 } },
      lsa: { leadQuality: { good: 30, notQuotable: 10, missedCalls: 0, noData: 0 } },
    },
    ["google_ads", "lsa"],
  );
  assert.equal(multi.qualityPercent, 67, "multi-platform aggregate = Σ Good / Σ rated (Good+NQ+Missed)");
  assert.deepEqual(multi.contributingPlatforms.sort(), ["google_ads", "lsa"]);

  const answer = computeQualityHeadline(
    { gbp: { locations: [{ leadQuality: { good: 8, notQuotable: 2, missedCalls: 10, noData: 0 } }] } },
    ["gbp"],
  );
  assert.equal(answer.qualityPercent, 40, "Missed stays in the quality denominator — a known bad outcome (call-handling accountability)");
  assert.equal(answer.answerRatePercent, 50, "Answer Rate surfaced separately: (Good+NQ) / (Good+NQ+Missed) — unchanged by Task #4914");

  const webExcl = computeQualityHeadline(
    {
      googleAds: { leadQuality: { good: 4, notQuotable: 6, missedCalls: 0, noData: 0 } },
      webinar: { leadQuality: { good: 100, notQuotable: 0, missedCalls: 0, noData: 0 } },
    },
    ["google_ads", "webinar"],
  );
  assert.equal(webExcl.qualityPercent, 40, "webinar excluded from headline by default");
  const webIncl = computeQualityHeadline(
    {
      googleAds: { leadQuality: { good: 4, notQuotable: 6, missedCalls: 0, noData: 0 } },
      webinar: { leadQuality: { good: 100, notQuotable: 0, missedCalls: 0, noData: 0 } },
    },
    ["google_ads", "webinar"],
    { includeWebinar: true },
  );
  assert.equal(webIncl.qualityPercent, 95, "webinar included when explicitly requested");

  // === Task #4914 — rated-based quality % (owner decision, supersedes Task
  // #1028's all-buckets denominator): "No data" is coverage, not quality. ===

  // Cambridge Immigration July 2026: 48 good / 40 NQ / 0 missed / 154 no
  // data. The old math diluted the headline to 20%; the rated-based headline
  // says 55% of the 88 rated leads were good, with 36% rating coverage.
  const cambridge = computeQualityHeadline(
    { gbpLeadQuality: { good: 48, notQuotable: 40, missedCalls: 0, noData: 154 } },
    ["gbp"],
  );
  assert.equal(cambridge.qualityPercent, 55, "no-data-heavy month: % Good = 48/88 rated = 55, not 48/242 = 20");
  assert.equal(cambridge.ratedCount, 88, "coverage output: rated = good + NQ + missed");
  assert.equal(cambridge.noDataCount, 154, "coverage output: the excluded No-data bucket stays countable");
  assert.equal(cambridge.ratedPercent, 36, "coverage output: rated / (rated + noData) = 88/242 = 36");
  assert.equal(cambridge.answerRatePercent, 100, "Answer Rate ignores No data (its denominator was always the rated set)");

  // Zero rated leads → null quality %, NEVER 0% or 100% off an empty
  // denominator. Coverage is still reportable: 0 of 25 rated.
  const unrated = computeQualityHeadline(
    { gbpLeadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 25 } },
    ["gbp"],
  );
  assert.equal(unrated.qualityPercent, null, "zero rated → null (renders '—'), never a fabricated %");
  assert.equal(unrated.answerRatePercent, null);
  assert.equal(unrated.ratedCount, 0);
  assert.equal(unrated.noDataCount, 25);
  assert.equal(unrated.ratedPercent, 0, "0 of 25 rated is a REAL 0% coverage — only the quality % goes null");
  assert.deepEqual(unrated.contributingPlatforms, ["gbp"], "noData-only months still contribute counts (coverage), only the % is null");

  // === platformLeadQuality ===
  assert.deepEqual(
    platformLeadQuality({ gbpLeadQuality: { good: 5, notQuotable: 2, missedCalls: 1, noData: 0 } }, "gbp"),
    { good: 5, notQuotable: 2, missedCalls: 1, noData: 0 },
    "gbp reads the gbpLeadQuality rollup when no per-location data",
  );
  assert.deepEqual(platformLeadQuality({}, "lsa"), EMPTY_LEAD_QUALITY);

  // === applyActiveProductsFilter ===
  const m1: any = {
    googleAds: { uniqueLeads: 100, adSpend: 200, leadQuality: { good: 50, notQuotable: 0, missedCalls: 0, noData: 0 } },
    lsa: { uniqueLeads: 0, adSpend: 0 },
    gbp: { locations: [{ name: "X", uniqueLeads: 5 }] },
    webinar: { hotTransfers: 3 },
  };
  const result = applyActiveProductsFilter(m1, ["google_ads"], { source: "test" });
  assert.equal(m1.googleAds.uniqueLeads, 100, "active product is preserved");
  assert.equal("gbp" in m1, false, "inactive gbp key is deleted");
  assert.equal("webinar" in m1, false, "inactive webinar key is deleted");
  assert.equal("lsa" in m1, false, "inactive lsa key is deleted");
  const dirty = result.removed.filter(r => r.hadData).map(r => r.product).sort();
  assert.deepEqual(dirty, ["gbp", "webinar"]);

  const m2: any = { googleAds: { uniqueLeads: 5, leadQuality: { good: 1, notQuotable: 0, missedCalls: 0, noData: 0 } } };
  const before = JSON.stringify(m2);
  applyActiveProductsFilter(m2, ["gbp", "google_ads", "lsa", "webinar"], { source: "test" });
  assert.equal(JSON.stringify(m2), before, "no-op when all products active");

  assert.deepEqual(applyActiveProductsFilter(null, ["google_ads"]).removed, []);
  assert.deepEqual(applyActiveProductsFilter({}, []).removed, []);

  const m3: any = { googleAds: { uniqueLeads: 10 }, lsa: { uniqueLeads: 5 } };
  applyActiveProductsFilter(m3, ["google_ads"], { source: "test" });
  const second = applyActiveProductsFilter(m3, ["google_ads"], { source: "test" });
  assert.equal(second.removed.some(r => r.hadData), false, "filter is idempotent on a clean payload");

  // === "other" is general lead reporting — otherLeads/other keys are
  // ALWAYS preserved by the structural filter, regardless of whether the
  // firm owns the "other" product. Only the Lead Quality headline excludes
  // Other's contribution, because we don't control the quality of leads we
  // didn't generate. ===
  const mOther: any = {
    googleAds: { uniqueLeads: 10, leadQuality: { good: 5, notQuotable: 0, missedCalls: 0, noData: 0 } },
    otherLeads: { total: 8, socialMedia: 3, leadQuality: { good: 2, notQuotable: 0, missedCalls: 0, noData: 0 } },
    other: { count: 1, leadQuality: { good: 1, notQuotable: 0, missedCalls: 0, noData: 0 } },
  };
  applyActiveProductsFilter(mOther, ["google_ads"], { source: "test_other" });
  assert.equal(mOther.otherLeads.total, 8, "otherLeads is preserved (general lead reporting)");
  assert.equal(mOther.other.count, 1, "other key is preserved (general lead reporting)");
  assert.equal(mOther.googleAds.uniqueLeads, 10);

  // === aggregateActiveLeadQuality NEVER includes Other's leadQuality ===
  const { aggregateActiveLeadQuality } = await import("../shared/marketingWriteBoundary");
  const aggOnlyGAds = aggregateActiveLeadQuality(
    {
      googleAds: { leadQuality: { good: 5, notQuotable: 0, missedCalls: 0, noData: 0 } },
      otherLeads: { leadQuality: { good: 100, notQuotable: 0, missedCalls: 0, noData: 0 } },
    },
    ["google_ads"],
  );
  assert.equal(aggOnlyGAds.good, 5, "Other's leadQuality is never aggregated (no quality control over those leads)");
  const aggWithOther = aggregateActiveLeadQuality(
    {
      googleAds: { leadQuality: { good: 5, notQuotable: 0, missedCalls: 0, noData: 0 } },
      otherLeads: { leadQuality: { good: 100, notQuotable: 0, missedCalls: 0, noData: 0 } },
    },
    ["google_ads", "other"],
  );
  assert.equal(aggWithOther.good, 5, "Other's leadQuality stays excluded even when 'other' is in active set");

  // === Task #3771: one canonical GBP reader — the "% Good" headline can
  // never disagree with the Leads Quality Breakdown bar/legend under it. ===

  // Ackah-style divergence: the stored rollup (264 leads, 38% Good — what the
  // bar/legend/total/donuts always rendered) disagrees with stale per-location
  // buckets summing to 150 (47% Good — what the old headline summed first).
  const divergentMarketing = {
    gbpLeadQuality: { good: 100, notQuotable: 104, missedCalls: 40, noData: 20 },
    gbp: {
      locations: [
        { leadQuality: { good: 40, notQuotable: 30, missedCalls: 10, noData: 5 } },
        { leadQuality: { good: 30, notQuotable: 20, missedCalls: 10, noData: 5 } },
      ],
    },
  };
  const divergentReading = readGbpLeadQuality(divergentMarketing);
  assert.deepEqual(
    divergentReading.counts,
    { good: 100, notQuotable: 104, missedCalls: 40, noData: 20 },
    "rollup wins when both shapes exist",
  );
  assert.equal(divergentReading.source, "rollup");
  assert.equal(divergentReading.divergent, true, "disagreeing shapes are flagged for logging");
  assert.deepEqual(
    divergentReading.locationSum,
    { good: 70, notQuotable: 50, missedCalls: 20, noData: 10 },
    "reader still exposes the per-location sum for divergence logging",
  );

  // Headline % Good === Good/RATED of the exact counts the legend/bar shows
  // (Task #4914: the bar itself is rebased on rated leads).
  const divergentHeadline = computeQualityHeadline(divergentMarketing, ["gbp"]);
  const barCounts = divergentReading.counts;
  const barRated = barCounts.good + barCounts.notQuotable + barCounts.missedCalls;
  assert.equal(
    divergentHeadline.qualityPercent,
    Math.round((barCounts.good / barRated) * 100),
    "headline % Good equals the stacked bar's Good/rated on the same card",
  );
  assert.equal(divergentHeadline.qualityPercent, 41, "Ackah-style report: headline follows the rollup the bar renders (100/244 rated = 41), not the location-sum 50");
  assert.deepEqual(divergentHeadline.totals, barCounts, "headline totals are the same counts the legend renders");
  assert.equal(divergentHeadline.ratedCount, 244, "coverage rides the same canonical counts");
  assert.equal(divergentHeadline.noDataCount, 20);
  assert.equal(divergentHeadline.ratedPercent, 92, "rated coverage: 244 of 264 = 92%");

  // Persisted aggregate reads the identical counts.
  const aggDivergent = aggregateActiveLeadQuality(divergentMarketing, ["gbp"]);
  assert.deepEqual(aggDivergent, barCounts, "aggregateActiveLeadQuality uses the same canonical GBP counts");

  // Single-shape reports are untouched by the precedence unification.
  const onlyRollup = readGbpLeadQuality({ gbpLeadQuality: { good: 5, notQuotable: 2, missedCalls: 1, noData: 0 } });
  assert.deepEqual(onlyRollup.counts, { good: 5, notQuotable: 2, missedCalls: 1, noData: 0 });
  assert.equal(onlyRollup.source, "rollup");
  assert.equal(onlyRollup.divergent, false, "rollup-only shape is not divergence");
  const onlyLocations = readGbpLeadQuality({
    gbpLocations: [{ leadQuality: { good: 3, notQuotable: 1, missedCalls: 0, noData: 2 } }],
  });
  assert.deepEqual(
    onlyLocations.counts,
    { good: 3, notQuotable: 1, missedCalls: 0, noData: 2 },
    "legacy gbpLocations key still readable when no rollup exists",
  );
  assert.equal(onlyLocations.source, "locations");
  assert.equal(onlyLocations.divergent, false, "locations-only shape is not divergence");
  assert.equal(readGbpLeadQuality({}).source, "none");
  assert.deepEqual(readGbpLeadQuality(null).counts, EMPTY_LEAD_QUALITY);

  // Aggregate-only manual entry: location rows exist but carry zero quality
  // data — nothing to disagree with, so no divergence flag.
  const zeroLocations = readGbpLeadQuality({
    gbpLeadQuality: { good: 4, notQuotable: 4, missedCalls: 0, noData: 0 },
    gbp: { locations: [{ leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } }, {}] },
  });
  assert.equal(zeroLocations.divergent, false, "zero-quality location rows never flag divergence");
  assert.deepEqual(zeroLocations.counts, { good: 4, notQuotable: 4, missedCalls: 0, noData: 0 });

  // Empty locations array + rollup: aggregateActiveLeadQuality used to sum the
  // empty array to zeros and never consult the rollup; it now matches the card.
  const aggEmptyLocations = aggregateActiveLeadQuality(
    { gbpLocations: [], gbpLeadQuality: { good: 6, notQuotable: 2, missedCalls: 1, noData: 1 } },
    ["gbp"],
  );
  assert.deepEqual(
    aggEmptyLocations,
    { good: 6, notQuotable: 2, missedCalls: 1, noData: 1 },
    "empty location list falls through to the rollup like every other reader",
  );

  // Agreeing shapes: identical counts from every reader, no flag.
  const agreeing = {
    gbpLeadQuality: { good: 8, notQuotable: 2, missedCalls: 0, noData: 0 },
    gbpLocations: [{ leadQuality: { good: 8, notQuotable: 2, missedCalls: 0, noData: 0 } }],
  };
  const agreeingReading = readGbpLeadQuality(agreeing);
  assert.equal(agreeingReading.divergent, false, "matching rollup and location sums are not divergence");
  assert.deepEqual(platformLeadQuality(agreeing, "gbp"), agreeingReading.counts);
  assert.deepEqual(aggregateActiveLeadQuality(agreeing, ["gbp"]), agreeingReading.counts);

  // === "other" alias normalization ===
  const { normalizeProductName, normalizeProductList } = await import("../shared/productResolution");
  assert.equal(normalizeProductName("Other"), "other");
  assert.equal(normalizeProductName("Other Leads"), "other");
  assert.equal(normalizeProductName("other_leads"), "other");
  assert.deepEqual(
    normalizeProductList(["Google Ads", "Other Leads", "GBP"]).sort(),
    ["gbp", "google_ads", "other"].sort(),
  );

  // === Resolver fallback: CP exists but productTypes empty → clients.products ===
  // We can't easily mock storage from here, so we test the underlying
  // resolveEffectiveProducts directly: when CP has empty productTypes the
  // canonical resolver MUST fall back to client.products (Task #1028 fix).
  const { resolveEffectiveProducts } = await import("../shared/productResolution");
  // Old behavior returned [] here; the canonical wrapper at
  // server/services/activeProducts now treats empty CP as non-authoritative
  // and falls back. The lower-level helper still has its existing semantics
  // because other call sites depend on them, so we assert the BOUNDARY
  // condition the wrapper relies on:
  assert.deepEqual(
    resolveEffectiveProducts({ productTypes: [] }, ["google_ads"]),
    [],
    "lower-level resolver still returns [] for empty CP — wrapper handles fallback",
  );
  assert.deepEqual(
    resolveEffectiveProducts(null, ["Google Ads", "Other"]).sort(),
    ["google_ads", "other"].sort(),
    "lower-level resolver normalizes client.products incl. 'other'",
  );

  // Reimport-merge regression: simulates the exact bug the architect flagged.
  // Without a post-merge re-application of the filter, mergeNonZero pulls
  // stale GBP/LSA values from the existing section back onto a
  // Google-Ads-only client. Re-running the filter must scrub them.
  const reimportParsed: any = {
    googleAds: { uniqueLeads: 50, adSpend: 500, leadQuality: { good: 9, notQuotable: 5, missedCalls: 0, noData: 0 } },
    lsa: { uniqueLeads: 0, adSpend: 0, leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } },
    gbpLocations: [],
  };
  // Pre-parse filter (active = google_ads only).
  applyActiveProductsFilter(reimportParsed, ["google_ads"], { source: "reimport_pre_merge" });
  // Simulated mergeNonZero from existing section data with stale values.
  const existing = {
    gbp: { locations: [{ name: "Stale GBP", uniqueLeads: 7, leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 99 } }] },
    lsa: { uniqueLeads: 12, adSpend: 80 },
  };
  // After pre-merge filter, gbpLocations and lsa keys are deleted (active=google_ads).
  // mergeNonZero would re-introduce them from existing data:
  if (!reimportParsed.gbpLocations || reimportParsed.gbpLocations.length === 0) {
    if (existing.gbp.locations.length > 0) {
      reimportParsed.gbpLocations = existing.gbp.locations.map(l => ({ ...l }));
    }
  }
  if (!reimportParsed.lsa) reimportParsed.lsa = { uniqueLeads: 0, adSpend: 0 };
  reimportParsed.lsa.uniqueLeads = reimportParsed.lsa.uniqueLeads || existing.lsa.uniqueLeads;
  reimportParsed.lsa.adSpend = reimportParsed.lsa.adSpend || existing.lsa.adSpend;
  // Without the post-merge filter the storage payload would now contain the
  // stale rows. With it, the inactive keys must be gone.
  applyActiveProductsFilter(reimportParsed, ["google_ads"], { source: "reimport_post_merge" });
  assert.equal("gbpLocations" in reimportParsed, false, "reimport post-merge filter deletes stale GBP locations");
  assert.equal("lsa" in reimportParsed, false, "reimport post-merge filter deletes merged-back LSA");
  assert.equal(reimportParsed.googleAds.uniqueLeads, 50, "active-product values survive both filter passes");

  console.log("All Active-Products headline + boundary tests passed.");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
