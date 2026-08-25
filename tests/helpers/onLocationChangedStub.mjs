// Stub for `server/mcu/worker` used by the add-stale-location route test
// (`tests/add-stale-location-route.test.ts`).
//
// The `POST /api/clients/:clientId/locations` handler statically imports
// `onLocationChanged` from `server/mcu/worker`. On the SUCCESS path (a good
// address that geocodes to real coordinates and persists a location with
// lat/lng) the route calls `onLocationChanged()`, which arms a 30s
// `setTimeout` that would keep the test process alive long past the asserts —
// a drain hang the run-all harness scores as a timeout SIGKILL.
//
// ESM named exports are immutable, so we cannot monkey-patch the binding at
// runtime; instead the companion resolve hook (`onLocationChangedLoader.mjs`)
// redirects every import of `worker` to THIS module. We re-export the REAL
// module untouched (so `getCachedSummary`, `triggerRefresh`, and every other
// binding keep their real implementations) and override ONLY
// `onLocationChanged` with a no-op that records its invocation count, so the
// test can prove the success path reached the side effect WITHOUT arming the
// real timer. The loader passes through the stub's own re-export of the real
// module (it keys on `context.parentURL`) so this does not redirect onto
// itself.
export * from "../../server/mcu/worker";

let calls = 0;

export function onLocationChanged() {
  calls++;
}

export function __getOnLocationChangedCalls() {
  return calls;
}

export function __resetOnLocationChangedCalls() {
  calls = 0;
}
