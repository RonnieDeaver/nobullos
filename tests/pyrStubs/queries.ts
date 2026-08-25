// Stub for server/services/adsOs/pyramid/queries.ts (see
// ads-os-pyramid-hooks.mjs). Shadows the 7-query Google Ads pull; pure helpers
// (termKey) and the row interfaces stay real via the re-export.
export * from "../../server/services/adsOs/pyramid/queries";

const g = (): any => ((globalThis as any).__pyrTest ??= {});

export async function fetchPyramidData(
  _cid: string,
  lookbackDays: number,
  _campaignIds: string[],
): Promise<any> {
  (g().fetchCalls ??= []).push(lookbackDays);
  const d = g().pyrData;
  if (!d) throw new Error("__pyrTest.pyrData not seeded");
  // Hand out copies so the engine's dormant-filter reassignments and sorting
  // can't mutate the seed between scenarios.
  return {
    ...d,
    campaigns: new Map(d.campaigns),
    ad_groups: new Map(d.ad_groups),
    keywords: [...d.keywords],
    terms: [...d.terms],
    failed_datasets: new Set(d.failed_datasets ?? []),
    warnings: [...(d.warnings ?? [])],
  };
}
