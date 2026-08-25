// Node ESM resolve hook that redirects every import of `server/mcu/fips` to
// the in-memory stub (`fipsLookupStub.mjs`) so the edit-location-address route
// test can drive `getFipsForLocation` deterministically without hitting the
// real FCC Census Block API. Registered via
// `--import ./tests/helpers/fipsLookupSetup.mjs` so it is active before the
// route handler's dynamic `await import("../mcu/fips")` evaluates.
//
// The stub itself re-exports the REAL `fips`; when it does so its
// `context.parentURL` is the stub's own URL, so we pass that resolution
// through untouched to avoid redirecting the stub onto itself (an infinite
// loop). Every other importer gets the stub.

const STUB_URL = new URL("./fipsLookupStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/mcu\/fips\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
