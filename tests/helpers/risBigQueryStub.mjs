// Stub for `server/services/ris/bigQueryClient` used by the RIS auto-pull
// safety test (`tests/ris-auto-pull-safety.test.ts`).
//
// `runRisAutoPull` reaches BigQuery through a STATIC
// `import { runAutoSourceQuery, isBigQueryConfigured, BigQueryUnavailableError }
//  from "./bigQueryClient"`. ESM named exports are immutable live bindings, so
// we cannot monkey-patch `runAutoSourceQuery` at runtime; instead the companion
// resolve hook (`risBigQueryLoader.mjs`) redirects every import of
// `bigQueryClient` to THIS module.
//
// We re-export the REAL module untouched (so `isBigQueryConfigured`,
// `BigQueryUnavailableError`, `BigQueryQueryError`, and every other binding any
// importer needs keep their real implementations) and override ONLY
// `runAutoSourceQuery` with a test-configurable impl. The loader passes through
// the stub's own re-export of the real module (it keys on `context.parentURL`)
// so this does not redirect onto itself.
//
// The test file imports THIS path directly to configure the impl; the
// production code path resolves to the same singleton via the hook, so the
// configured behavior is observed by `runRisAutoPull`.
export * from "../../server/services/ris/bigQueryClient";

let impl = null;

export async function runAutoSourceQuery(mapping, params) {
  if (typeof impl !== "function") {
    throw new Error(
      "[risBigQueryStub] runAutoSourceQuery called but no impl configured — call __setRunAutoSourceQuery first",
    );
  }
  return impl(mapping, params);
}

/**
 * Set the function backing the stubbed `runAutoSourceQuery`. It receives
 * `(mapping, params)` (the full mapping row including `autoSource`) and must
 * resolve to `{ row }` (an object or null) — or throw to simulate an upstream
 * failure (e.g. a generic Error, or a `BigQueryUnavailableError` to simulate
 * an unreachable / unconfigured BigQuery).
 */
export function __setRunAutoSourceQuery(fn) {
  impl = fn;
}

export function __resetRunAutoSourceQuery() {
  impl = null;
}
