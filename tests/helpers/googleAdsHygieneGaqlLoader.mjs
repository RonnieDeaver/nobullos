// Node ESM resolve hook that redirects every import of
// `server/services/googleAdsIntegration` to the in-memory stub
// (`googleAdsHygieneGaqlStub.mjs`) so the pacing/LSA status-filter
// regression test can drive `computeBudgetPacing` / `fetchLsaDashboard`
// deterministically without hitting real Google Ads.
// Registered via `--import ./tests/helpers/googleAdsHygieneGaqlSetup.mjs` so
// it is active before the test file (and its static import chain through
// `googleAdsHygieneService` → `googleAdsIntegration`) evaluates.
//
// The stub itself re-exports the REAL `googleAdsIntegration`; when it does
// so its `context.parentURL` is the stub's own URL, so we pass that
// resolution through untouched to avoid redirecting the stub onto itself (an
// infinite loop). Every other importer gets the stub.

const STUB_URL = new URL("./googleAdsHygieneGaqlStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/services\/googleAdsIntegration\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
