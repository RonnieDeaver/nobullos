// Stub for `server/mcu/fips` used by the edit-location-address route test
// (`tests/edit-location-address-route.test.ts`).
//
// On the address-change SUCCESS path, the PATCH
// /api/clients/:clientId/locations/:locationId handler reaches the FIPS lookup
// through a DYNAMIC `await import("../mcu/fips")` and calls
// `getFipsForLocation({ lat, lng })`, which hits the live FCC Census Block API.
// ESM named exports are immutable, so we cannot monkey-patch it at runtime;
// instead the companion resolve hook (`fipsLookupLoader.mjs`) redirects every
// import of `fips` to THIS module.
//
// We re-export the REAL module untouched (so every other binding any importer
// in the process needs keeps its real implementation) and override ONLY
// `getFipsForLocation` with a test-configurable impl. The loader passes through
// the stub's own re-export of the real module (it keys on `context.parentURL`)
// so this does not redirect onto itself.
export * from "../../server/mcu/fips";

let impl = null;

export async function getFipsForLocation(location) {
  if (typeof impl !== "function") {
    throw new Error(
      "[fipsLookupStub] getFipsForLocation called but no impl configured — call __setGetFipsForLocation first",
    );
  }
  return impl(location);
}

/**
 * Set the function backing the stubbed `getFipsForLocation`. It receives the
 * `{ lat, lng }` location and must resolve to a `FipsResult` shaped object
 * (`{ stateFips, countyFips, ... }`) or `null`.
 */
export function __setGetFipsForLocation(fn) {
  impl = fn;
}

export function __resetGetFipsForLocation() {
  impl = null;
}
