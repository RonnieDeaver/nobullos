// Stub for server/services/adsOs/keywordIntel/queries.ts (see
// ads-os-ki-hooks.mjs). Shadows the two Google Ads pulls; pure helpers
// (keywordTupleKey, aggregation helpers) and the row interfaces stay real
// via the re-export.
export * from "../../server/services/adsOs/keywordIntel/queries";
import {
  aggregateSearchTerms,
  keywordFinderTermAggregationKey,
} from "../../server/services/adsOs/keywordIntel/queries";

const g = (): any => ((globalThis as any).__kiTest ??= {});

export async function fetchData(_cid: string, lookbackDays: number, _campaignIds: string[]): Promise<any> {
  (g().fetchDataCalls ??= []).push(lookbackDays);
  const d = g().kiData;
  if (!d) throw new Error("__kiTest.kiData not seeded");
  // Hand out copies so engine-side sorting can't mutate the seed between scenarios.
  // Apply the same per-term aggregation that the real fetchData applies so tests
  // that seed duplicate segment rows (same search_term, different keyword/ad-group)
  // get the same collapsed view the engine would see in production.
  return { ...d, search_terms: aggregateSearchTerms([...d.search_terms]), warnings: [...d.warnings] };
}

export async function fetchKeywordFinderData(_cid: string, lookbackDays: number, _campaignIds: string[]): Promise<any> {
  (g().fetchFinderCalls ??= []).push(lookbackDays);
  const d = g().kfData;
  if (!d) throw new Error("__kiTest.kfData not seeded");
  // Keep the finder stub faithful to the production query boundary: GAQL
  // returns separate keyword/ad-group segments for a term, but the finder
  // must make one decision from its cumulative window metrics.
  return {
    ...d,
    converting_terms: aggregateSearchTerms(
      [...d.converting_terms],
      keywordFinderTermAggregationKey,
    ),
    warnings: [...d.warnings],
  };
}
