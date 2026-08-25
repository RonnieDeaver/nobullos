// Node ESM resolve hook that redirects every import of
// `server/services/ris/bigQueryClient` to the in-memory stub
// (`risBigQueryStub.mjs`) so the RIS auto-pull safety test can drive
// `runAutoSourceQuery` deterministically without hitting real BigQuery.
// Registered via `--import ./tests/helpers/risBigQuerySetup.mjs` so it is
// active before the test file (and its static import chain through
// `risAutoPull` → `bigQueryClient`) evaluates.
//
// The stub itself re-exports the REAL `bigQueryClient`; when it does so its
// `context.parentURL` is the stub's own URL, so we pass that resolution
// through untouched to avoid redirecting the stub onto itself (an infinite
// loop). Every other importer gets the stub.

const STUB_URL = new URL("./risBigQueryStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/services\/ris\/bigQueryClient\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
