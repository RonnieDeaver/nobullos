// Stub for `server/mcu/geocoding` used by the add-stale-location route test
// (`tests/add-stale-location-route.test.ts`).
//
// The `POST /api/clients/:clientId/locations` handler reaches the geocoder
// through a DYNAMIC `await import("../mcu/geocoding")` and calls
// `geocodeLocationText(name, address)`. ESM named exports are immutable, so we
// cannot monkey-patch it at runtime; instead the companion resolve hook
// (`geocodeLocationTextLoader.mjs`) redirects every import of `geocoding` to
// THIS module.
//
// We re-export the REAL module untouched (so `classifyGoogleGeocodeStatus`,
// `geocodeAddress`, the FIPS/normalize helpers, and every other binding any
// importer in the process needs keep their real implementations) and override
// ONLY `geocodeLocationText` with a test-configurable impl. The loader passes
// through the stub's own re-export of the real module (it keys on
// `context.parentURL`) so this does not redirect onto itself.
//
// The test file imports THIS path directly to configure the impl; the
// production route resolves to the same singleton via the hook, so the
// configured behavior is observed by the handler.
export * from "../../server/mcu/geocoding";

let impl = null;

export async function geocodeLocationText(rawText, explicitAddress) {
  if (typeof impl !== "function") {
    throw new Error(
      "[geocodeLocationTextStub] geocodeLocationText called but no impl configured — call __setGeocodeLocationText first",
    );
  }
  return impl({ rawText, explicitAddress });
}

/**
 * Set the function backing the stubbed `geocodeLocationText`. It receives
 * `{ rawText, explicitAddress }` and must resolve to a `GeocodedLocationData`
 * shaped object (lat/lng null + `geocodeFailureReason` for failures, populated
 * coordinates for success).
 */
export function __setGeocodeLocationText(fn) {
  impl = fn;
}

export function __resetGeocodeLocationText() {
  impl = null;
}

// ---------------------------------------------------------------------------
// `geocodeAddress` override — used by the edit-location-address route test
// (`tests/edit-location-address-route.test.ts`). The PATCH
// /api/clients/:clientId/locations/:locationId handler re-geocodes a changed
// address through a DIFFERENT helper than the POST path: it reaches the
// geocoder via a dynamic `await import("../mcu/geocoding")` and calls
// `geocodeAddress(address)` (returning a `GeocodeResult`: { lat, lng,
// formattedAddress, success, failureReason? }). The same resolve hook that
// redirects this module for `geocodeLocationText` also routes `geocodeAddress`
// here, so an explicit override (which shadows the `export *` re-export above)
// lets the test drive success / failure deterministically.
let addressImpl = null;

export async function geocodeAddress(address) {
  if (typeof addressImpl !== "function") {
    throw new Error(
      "[geocodeLocationTextStub] geocodeAddress called but no impl configured — call __setGeocodeAddress first",
    );
  }
  return addressImpl(address);
}

/**
 * Set the function backing the stubbed `geocodeAddress`. It receives the raw
 * address string and must resolve to a `GeocodeResult` shaped object
 * (`success:true` with formattedAddress/lat/lng for a hit, `success:false`
 * with an optional `failureReason` for a miss).
 */
export function __setGeocodeAddress(fn) {
  addressImpl = fn;
}

export function __resetGeocodeAddress() {
  addressImpl = null;
}
