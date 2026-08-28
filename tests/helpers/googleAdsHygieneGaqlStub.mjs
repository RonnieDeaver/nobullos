// Stub for `server/services/googleAdsIntegration` used by
// `tests/google-ads-hygiene-pacing-status-filter.test.ts`.
//
// `computeBudgetPacing` / `fetchLsaDashboard` in
// `server/services/googleAdsHygieneService.ts` reach Google Ads through a
// STATIC `import { gaqlSearchStream } from "./googleAdsIntegration"` — ESM
// named exports are immutable live bindings, so we cannot monkey-patch it at
// runtime. The companion resolve hook (`googleAdsHygieneGaqlLoader.mjs`)
// redirects every import of `googleAdsIntegration` to THIS module instead.
//
// We re-export the REAL module untouched (so error classes, config helpers
// and every other binding keep their real implementations) and override
// ONLY `gaqlSearchStream` with a test-configurable impl. The loader passes
// through this module's own re-export of the real module (keyed on
// parentURL) so it does not redirect onto itself.
export * from "../../server/services/googleAdsIntegration";

let impl = null;

export async function gaqlSearchStream(customerId, query) {
  if (typeof impl !== "function") {
    throw new Error(
      "[googleAdsHygieneGaqlStub] gaqlSearchStream called but no impl configured — call __setGaqlImpl first",
    );
  }
  return impl(customerId, query);
}

/** Set the function backing the stubbed `gaqlSearchStream`: (cid, query) => rows[]. */
export function __setGaqlImpl(fn) {
  impl = fn;
}

export function __resetGaqlImpl() {
  impl = null;
}
