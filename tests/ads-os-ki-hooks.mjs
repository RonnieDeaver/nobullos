// Node ESM resolve hook for the ads-os-keyword-intel-engine test (Task #3600).
//
// Redirects the engine/finder's statically-imported collaborators to stubs in
// tests/kiStubs/ so the orchestration logic (cap + honesty warnings, converting
// caution, traffic-quality math, persistQuality window mechanics, the finder's
// actioned/cross-check overlay) runs DB-free and network-free:
//   - enrollment.ts       -> enrollment gate + labeled campaigns from test state
//   - criteriaService.ts  -> loadCriteria from test state (derive/effective real)
//   - keywordIntel/queries.ts -> fetchData/fetchKeywordFinderData from test state
//   - keywordIntel/suggest.ts -> suggestNegatives from test state (prompts real)
//   - keywordIntel/kiStore.ts -> in-memory traffic-quality + actioned stores
//
// Each stub `export *`s the real module and shadows only the impure functions,
// so pure helpers (keywordTupleKey, snapshotEntryExpired, buildUserPrompt…)
// stay the shipped implementations. The parentURL guard lets the stubs' own
// imports of the real modules pass through un-redirected.

const STUBS = [
  ["/server/services/adsOs/enrollment.ts", new URL("./kiStubs/enrollment.ts", import.meta.url).href],
  ["/server/services/adsOs/criteriaService.ts", new URL("./kiStubs/criteriaService.ts", import.meta.url).href],
  ["/server/services/adsOs/keywordIntel/queries.ts", new URL("./kiStubs/queries.ts", import.meta.url).href],
  ["/server/services/adsOs/keywordIntel/suggest.ts", new URL("./kiStubs/suggest.ts", import.meta.url).href],
  ["/server/services/adsOs/keywordIntel/kiStore.ts", new URL("./kiStubs/kiStore.ts", import.meta.url).href],
];
const STUB_URLS = new Set(STUBS.map(([, url]) => url));

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (STUB_URLS.has(context?.parentURL)) return resolved; // stub -> real passthrough
  for (const [suffix, stubUrl] of STUBS) {
    if (resolved.url.endsWith(suffix)) {
      return { ...resolved, url: stubUrl, shortCircuit: true };
    }
  }
  return resolved;
}
