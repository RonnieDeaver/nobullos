// Stub for `server/services/semrushApi` used by the competitor
// structured-location backfill FILL test
// (`tests/competitor-structured-location-backfill-converge.test.ts`).
//
// `processStructuredLocationSnapshot` reaches SEMrush through a STATIC
// `import { getTopCompetitors } from "./semrushApi"` inside the shared
// `fetchTopCompetitorsForBackfill` helper. ESM named exports are immutable,
// so we cannot monkey-patch `getTopCompetitors` at runtime; instead the
// companion resolve hook (`competitorBackfillSemrushLoader.mjs`) redirects
// every import of `semrushApi` to THIS module.
//
// We re-export the REAL module untouched (so `findBestReportDate`,
// `SemrushRateLimitError`, `SemrushNotFoundError`, and every other binding
// any importer in the process needs keep their real implementations) and
// override ONLY `getTopCompetitors` with a test-configurable impl. The
// loader passes through the stub's own re-export of the real module (it
// keys on `context.parentURL`) so this does not redirect onto itself.
//
// The test file imports THIS path directly to configure the impl; the
// production code path resolves to the same singleton via the hook, so the
// configured behavior is observed by `fetchTopCompetitorsForBackfill`.
export * from "../../server/services/semrushApi";

let impl = null;

export async function getTopCompetitors(campaignId, keywordId, reportDate, options, signal) {
  if (typeof impl !== "function") {
    throw new Error(
      "[competitorBackfillSemrushStub] getTopCompetitors called but no impl configured — call __setGetTopCompetitors first",
    );
  }
  return impl({ campaignId, keywordId, reportDate, options, signal });
}

/**
 * Set the function backing the stubbed `getTopCompetitors`. It receives
 * `{ campaignId, keywordId, reportDate, options, signal }` and must resolve
 * to the SEMrush top-competitors array (objects with at least `name` and
 * `address`) — or throw to simulate an upstream failure.
 */
export function __setGetTopCompetitors(fn) {
  impl = fn;
}

export function __resetGetTopCompetitors() {
  impl = null;
}
