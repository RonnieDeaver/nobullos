// Node ESM resolve hook that redirects every import of
// `server/services/semrushApi` to the in-memory stub
// (`competitorBackfillSemrushStub.mjs`) so the competitor
// structured-location backfill FILL test can drive `getTopCompetitors`
// deterministically without hitting the real SEMrush API. Registered via
// `--import ./tests/helpers/competitorBackfillSemrushSetup.mjs` so it is
// active before the test file (and its static import chain through
// `competitorStructuredLocationBackfill` → `competitorLocationBackfill` →
// `semrushApi`) evaluates.
//
// The stub itself re-exports the REAL `semrushApi`; when it does so its
// `context.parentURL` is the stub's own URL, so we pass that resolution
// through untouched to avoid redirecting the stub onto itself (an infinite
// loop). Every other importer gets the stub.

const STUB_URL = new URL("./competitorBackfillSemrushStub.mjs", import.meta.url)
  .href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/services\/semrushApi\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
