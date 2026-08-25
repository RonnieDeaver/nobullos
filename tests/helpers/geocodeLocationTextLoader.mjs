// Node ESM resolve hook that redirects every import of `server/mcu/geocoding`
// to the in-memory stub (`geocodeLocationTextStub.mjs`) so the add-stale-
// location route test can drive `geocodeLocationText` deterministically
// (success / not_found / system fault) without hitting the real Google
// Geocoding API. Registered via
// `--import ./tests/helpers/geocodeLocationTextSetup.mjs` so it is active
// before the route handler's dynamic `await import("../mcu/geocoding")`
// evaluates.
//
// The stub itself re-exports the REAL `geocoding`; when it does so its
// `context.parentURL` is the stub's own URL, so we pass that resolution
// through untouched to avoid redirecting the stub onto itself (an infinite
// loop). Every other importer gets the stub.

const STUB_URL = new URL("./geocodeLocationTextStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/mcu\/geocoding\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
