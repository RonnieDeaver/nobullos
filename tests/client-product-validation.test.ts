/* test-registration
{
  "name": "Client product validation",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for client product list validation.
 *
 * `normalizeProductList` is the canonical funnel for client product
 * selections. Pinned behaviors:
 *
 *   1. Aliases collapse to the canonical id (e.g. "Google Business Profile"
 *      → "gbp"; "Local Service Ads" → "lsa").
 *   2. Duplicates are de-duped while preserving first-seen order.
 *   3. The composite legacy id "google_ads_lsa" expands into both
 *      "google_ads" and "lsa".
 *   4. Unknown / empty / non-string values are SILENTLY filtered (the
 *      validation contract for callers is "if everything is unknown, you
 *      get an empty array — caller decides whether to 400").
 *   5. `resolveEffectiveProducts` prefers an explicit (non-empty) command
 *      panel `productTypes` over the client's product list, returning [] if
 *      the panel exists but contains no recognized products.
 */

import {
  normalizeProductList,
  resolveEffectiveProducts,
  CANONICAL_PRODUCTS,
} from "../shared/productResolution";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function eqArr<T>(actual: T[], expected: T[], msg: string): void {
  assert(
    actual.length === expected.length && actual.every((v, i) => v === expected[i]),
    `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

function main(): void {
  // (1) Alias resolution
  eqArr(
    normalizeProductList(["Google Business Profile", "Google Ads"]),
    ["gbp", "google_ads"],
    "human-readable aliases should map to canonical ids",
  );
  eqArr(
    normalizeProductList(["Local Service Ads", "Webinars"]),
    ["lsa", "webinar"],
    "LSA + Webinars aliases should normalize",
  );

  // (2) Duplicates collapse, order preserved
  eqArr(
    normalizeProductList(["gbp", "GBP", "google_business_profile", "lsa", "lsa"]),
    ["gbp", "lsa"],
    "duplicates should collapse, first-seen order preserved",
  );

  // (3) Composite legacy id expands
  eqArr(
    normalizeProductList(["google_ads_lsa"]),
    ["google_ads", "lsa"],
    "google_ads_lsa should expand into google_ads + lsa",
  );
  eqArr(
    normalizeProductList(["lsa", "google_ads_lsa"]),
    ["lsa", "google_ads"],
    "google_ads_lsa expansion should respect already-present items",
  );

  // (4) Unknowns + empties + non-strings are silently filtered
  eqArr(
    normalizeProductList(["", "  ", "totally-unknown-product", "GBP"] as any),
    ["gbp"],
    "empty/whitespace/unknown should be filtered, valid items kept",
  );
  eqArr(
    normalizeProductList(["nonsense-only", ""] as any),
    [],
    "if everything is invalid, result is an empty array",
  );
  eqArr(
    normalizeProductList([null, undefined, 42, "gbp"] as any),
    ["gbp"],
    "non-string entries should be filtered without throwing",
  );

  // (5) resolveEffectiveProducts precedence rules
  eqArr(
    resolveEffectiveProducts({ productTypes: ["lsa", "Google Ads"] }, ["gbp"]),
    ["lsa", "google_ads"],
    "command panel productTypes win over client products when present",
  );
  eqArr(
    resolveEffectiveProducts({ productTypes: ["unknown-thing"] }, ["gbp"]),
    [],
    "command panel with only-unknown productTypes returns []; does NOT fall back to client products",
  );
  eqArr(
    resolveEffectiveProducts({ productTypes: [] }, ["gbp"]),
    [],
    "command panel with empty productTypes returns [] (explicit override)",
  );
  eqArr(
    resolveEffectiveProducts(null, ["Google Business Profile"]),
    ["gbp"],
    "no command panel → fall through to normalized client products",
  );
  eqArr(
    resolveEffectiveProducts(null, null),
    [],
    "no command panel + no client products → empty",
  );

  // Sanity: the canonical product set is exactly the four we expect.
  eqArr(
    [...CANONICAL_PRODUCTS],
    // Task #1028 introduced "other" as a fifth canonical product
    // representing the marketing.otherLeads bucket. It participates in the
    // Active-Products invariant but is NOT exposed in CLIENT_PRODUCT_OPTIONS
    // (the UI selector) — inclusion happens via auto-detection.
    ["gbp", "google_ads", "lsa", "webinar", "other"],
    "CANONICAL_PRODUCTS contract",
  );

  console.log("client-product-validation: PASSED");
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error("client-product-validation: FAILED", err);
  process.exit(1);
}
