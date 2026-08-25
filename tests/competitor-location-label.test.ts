/* test-registration
{
  "name": "Competitor location label derivation (Task #1997)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import {
  deriveCompetitorLocationLabel,
  parseCompetitorAddress,
} from "../server/services/localDominanceService";
import { normalizeCompetitorName } from "../server/services/competitorLocationBackfill";

// Task #1997 / #2020 — unit coverage for deriveCompetitorLocationLabel.
//
// NOTE ON SCOPE: Task #2020 added structured locality/street columns to
// `heatmap_competitor_snapshots` (parsed best-effort from the SEMrush
// business `address` free-text string, which the API does NOT break into
// sub-fields). The function signature is now
// `(gbpUrl, firmName, structured?)` and its precedence is:
//   0. structured locality/street ("Locality / Street") when present  [#2020]
//   1. `/place/<segment>/` fragment (with firm-name leak stripping)
//   2. `cid=` short-code hash
//   3. `place_id` short-code hash
//   4. whole-URL short-code hash
//   5. null (only when no structured fields AND no GBP URL are present)
// These tests assert that actual behavior so future edits can't silently
// regress label quality.

// Mirror of the private shortGbpHash so expectations are derived, not guessed.
function shortGbpHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i);
    h |= 0;
  }
  return (Math.abs(h) % 0xfffff).toString(16).padStart(5, "0");
}

async function run() {
  // --- 1. Place fragment with firm-name leak stripping ---
  // The /place/ segment leads with the firm name; it must be stripped so the
  // label carries only the disambiguating remainder.
  assert.equal(
    deriveCompetitorLocationLabel(
      "https://www.google.com/maps/place/Smith+Law+Firm+Chicago/@41.8,-87.6,17z",
      "Smith Law Firm",
    ),
    "Chicago",
    "leading firm-name and separators stripped from the /place/ fragment",
  );

  // Stripping must tolerate regex-special characters in the firm name.
  assert.equal(
    deriveCompetitorLocationLabel(
      "https://www.google.com/maps/place/Dewey%2C+Cheatem+%26+Howe+-+Downtown/",
      "Dewey, Cheatem & Howe",
    ),
    "Downtown",
    "regex-special chars in firm name don't break the strip",
  );

  // --- 2. Place fragment that is NOT a firm-name leak is kept verbatim ---
  assert.equal(
    deriveCompetitorLocationLabel(
      "https://www.google.com/maps/place/Downtown+Office/",
      "Acme Injury",
    ),
    "Downtown Office",
    "non-leaking fragment returned as-is",
  );

  // --- 3. Redundant fragment dedupe: seg == firm name falls through to hash ---
  // When the only fragment content is the firm name itself it carries no
  // disambiguating value, so the place branch is skipped and we fall back to
  // the whole-URL short-code hash.
  const dedupeUrl = "https://www.google.com/maps/place/Smith+Law+Firm/";
  assert.equal(
    deriveCompetitorLocationLabel(dedupeUrl, "Smith Law Firm"),
    `GBP ${shortGbpHash(dedupeUrl)}`,
    "fragment identical to firm name (ignoring punctuation/case) falls through to hash",
  );

  // --- 4. cid short-code hash fallback (no /place/ fragment) ---
  assert.equal(
    deriveCompetitorLocationLabel(
      "https://maps.google.com/?cid=1234567890",
      "Some Firm",
    ),
    `GBP ${shortGbpHash("1234567890")}`,
    "cid param drives the short-code hash",
  );

  // --- 5. place_id short-code hash fallback ---
  assert.equal(
    deriveCompetitorLocationLabel(
      "https://www.google.com/search?q=place_id=ChIJ_abc-123",
      "Some Firm",
    ),
    `GBP ${shortGbpHash("ChIJ_abc-123")}`,
    "place_id drives the short-code hash when no cid/fragment present",
  );

  // --- 6. whole-URL short-code hash fallback ---
  const opaque = "https://g.page/some-opaque-shortlink";
  assert.equal(
    deriveCompetitorLocationLabel(opaque, "Some Firm"),
    `GBP ${shortGbpHash(opaque)}`,
    "opaque URL with no fragment/cid/place_id hashes the whole URL",
  );

  // Hash fallback is deterministic and 5 hex chars wide.
  const label = deriveCompetitorLocationLabel(opaque, "Some Firm")!;
  assert.match(label, /^GBP [0-9a-f]{5}$/, "hash label format is `GBP <5 hex>`");
  assert.equal(
    deriveCompetitorLocationLabel(opaque, "Some Firm"),
    label,
    "hash fallback is stable across calls",
  );

  // --- 7. null when there is no GBP URL AND no structured fields ---
  assert.equal(deriveCompetitorLocationLabel(null, "Some Firm"), null, "null gbpUrl → null");
  assert.equal(deriveCompetitorLocationLabel(undefined, "Some Firm"), null, "undefined gbpUrl → null");
  assert.equal(deriveCompetitorLocationLabel("", "Some Firm"), null, "empty gbpUrl → null");

  // --- 8. Task #2020 — structured fields produce "Locality / Street" ---
  assert.equal(
    deriveCompetitorLocationLabel(null, "Smith Law Firm", {
      locality: "Chicago",
      street: "W Madison St",
    }),
    "Chicago / W Madison St",
    "structured locality + street formatted as 'Locality / Street'",
  );

  // Structured fields win over a GBP URL that would otherwise drive the label.
  assert.equal(
    deriveCompetitorLocationLabel(
      "https://www.google.com/maps/place/Smith+Law+Firm+Downtown/",
      "Smith Law Firm",
      { locality: "Chicago", street: "W Madison St" },
    ),
    "Chicago / W Madison St",
    "structured fields take precedence over the /place/ fragment",
  );

  // Only locality present → just the locality.
  assert.equal(
    deriveCompetitorLocationLabel(null, "Smith Law Firm", { locality: "Chicago" }),
    "Chicago",
    "locality only → locality",
  );

  // Only street present → just the street.
  assert.equal(
    deriveCompetitorLocationLabel(null, "Smith Law Firm", { street: "W Madison St" }),
    "W Madison St",
    "street only → street",
  );

  // --- 9. Dedupe when locality == street (ignoring case/punctuation) ---
  assert.equal(
    deriveCompetitorLocationLabel(null, "Smith Law Firm", {
      locality: "Chicago",
      street: "chicago",
    }),
    "Chicago",
    "locality == street (case-insensitive) collapses to one",
  );

  // --- 10. Firm-name leaks stripped from structured fields ---
  // A field that is nothing but the firm name carries no disambiguating
  // value and must be dropped.
  assert.equal(
    deriveCompetitorLocationLabel(null, "Smith Law Firm", {
      locality: "Chicago",
      street: "Smith Law Firm",
    }),
    "Chicago",
    "street that is just the firm name is dropped",
  );
  // A leading firm-name leak on a field is stripped, keeping the remainder.
  assert.equal(
    deriveCompetitorLocationLabel(null, "Smith Law Firm", {
      locality: "Smith Law Firm - Chicago",
      street: "W Madison St",
    }),
    "Chicago / W Madison St",
    "leading firm-name leak stripped from locality",
  );

  // --- 11. Empty / blank structured fields fall through to GBP URL logic ---
  assert.equal(
    deriveCompetitorLocationLabel(
      "https://www.google.com/maps/place/Downtown+Office/",
      "Acme Injury",
      { locality: "  ", street: "" },
    ),
    "Downtown Office",
    "blank structured fields fall through to the /place/ fragment",
  );
  // Structured fields that are ONLY the firm name fall through too.
  assert.equal(
    deriveCompetitorLocationLabel(opaque, "Some Firm", {
      locality: "Some Firm",
      street: "Some Firm",
    }),
    `GBP ${shortGbpHash(opaque)}`,
    "structured fields that are all firm-name leaks fall through to the hash",
  );

  // --- 12. Task #2020 — parseCompetitorAddress heuristic ---
  // US-style address: first segment → street, second → locality.
  assert.deepEqual(
    parseCompetitorAddress("123 W Madison St, Chicago, IL 60601, USA"),
    { street: "123 W Madison St", locality: "Chicago" },
    "US address parsed: street + locality, region/zip/country dropped",
  );
  // Two-segment address still yields both.
  assert.deepEqual(
    parseCompetitorAddress("Strada arancione 62, Italy"),
    { street: "Strada arancione 62", locality: "Italy" },
    "two-segment address parsed best-effort",
  );
  // Single segment → street only, no locality.
  assert.deepEqual(
    parseCompetitorAddress("123 Main St"),
    { street: "123 Main St" },
    "single-segment address → street only",
  );
  // --- 12b. Task #2042 — widened address-format recognition ---
  // Leading suite/unit segment is dropped; street + locality recovered.
  assert.deepEqual(
    parseCompetitorAddress("Suite 200, 123 W Madison St, Chicago, IL 60601, USA"),
    { street: "123 W Madison St", locality: "Chicago" },
    "leading suite segment dropped, street + locality recovered",
  );
  assert.deepEqual(
    parseCompetitorAddress("#3, 500 Main St, Austin, TX 78701"),
    { street: "500 Main St", locality: "Austin" },
    "leading #unit segment dropped",
  );
  // Address missing a street → locality only (first segment is the city).
  assert.deepEqual(
    parseCompetitorAddress("Chicago, IL 60601, USA"),
    { locality: "Chicago" },
    "address with no street → locality only",
  );
  // Region/state + ZIP must not be mistaken for the locality.
  assert.deepEqual(
    parseCompetitorAddress("123 Main St, IL 60601, USA"),
    { street: "123 Main St" },
    "state+ZIP segment is not treated as the locality",
  );
  // Bare state code following the street is also skipped.
  assert.deepEqual(
    parseCompetitorAddress("123 Main St, CA"),
    { street: "123 Main St" },
    "bare state code is not treated as the locality",
  );
  // Trailing country dropped, real locality preserved (street with suffix, no number).
  assert.deepEqual(
    parseCompetitorAddress("Main Street, Springfield, USA"),
    { street: "Main Street", locality: "Springfield" },
    "street recognized by suffix; trailing country dropped",
  );
  // Bare ZIP-only segment is skipped when picking the locality.
  assert.deepEqual(
    parseCompetitorAddress("742 Evergreen Ter, 90210"),
    { street: "742 Evergreen Ter" },
    "bare ZIP after street is not the locality",
  );

  // --- 12c. Task #2051 — international postal/region recognition ---
  // Canadian postal code "A1A 1A1" is recognized, so the real city wins.
  assert.deepEqual(
    parseCompetitorAddress("123 King St W, Toronto, ON M5V 2T6, Canada"),
    { street: "123 King St W", locality: "Toronto" },
    "Canadian address: province + postal not mistaken for the locality",
  );
  // Canadian postal code as its own segment (no province prefix) is skipped.
  assert.deepEqual(
    parseCompetitorAddress("123 Main St, M5V 2T6, Canada"),
    { street: "123 Main St" },
    "bare Canadian postal code is not the locality",
  );
  // Canadian postal with no internal space still recognized.
  assert.deepEqual(
    parseCompetitorAddress("123 Main St, M5V2T6"),
    { street: "123 Main St" },
    "Canadian postal without internal space is not the locality",
  );
  // Bare Canadian province code following the street is skipped.
  assert.deepEqual(
    parseCompetitorAddress("123 Main St, ON"),
    { street: "123 Main St" },
    "bare Canadian province code is not the locality",
  );
  // UK postcode "SW1A 1AA" is recognized, so the real city wins.
  assert.deepEqual(
    parseCompetitorAddress("10 Downing St, London, SW1A 1AA, UK"),
    { street: "10 Downing St", locality: "London" },
    "UK address: postcode not mistaken for the locality",
  );
  // Other UK postcode shapes are recognized as their own segment.
  assert.deepEqual(
    parseCompetitorAddress("221B Baker St, M1 1AE, England"),
    { street: "221B Baker St" },
    "UK postcode 'M1 1AE' is not the locality",
  );
  assert.deepEqual(
    parseCompetitorAddress("100 High St, B33 8TH, UK"),
    { street: "100 High St" },
    "UK postcode 'B33 8TH' is not the locality",
  );
  // No-street international address still yields the locality.
  assert.deepEqual(
    parseCompetitorAddress("Vancouver, BC V6B 1A1, Canada"),
    { locality: "Vancouver" },
    "no-street Canadian address → locality only",
  );

  // --- 12d. Task #2291 — more international postal/region recognition ---
  // Australian state code + 4-digit postcode is recognized, so the city wins.
  assert.deepEqual(
    parseCompetitorAddress("123 George St, Sydney, NSW 2000, Australia"),
    { street: "123 George St", locality: "Sydney" },
    "Australian address: state + postcode not mistaken for the locality",
  );
  // Bare "<AU state> <postcode>" pair (no city) is skipped.
  assert.deepEqual(
    parseCompetitorAddress("123 George St, NSW 2000, Australia"),
    { street: "123 George St" },
    "bare AU state + postcode is not the locality",
  );
  // Bare Australian state code following the street is skipped.
  assert.deepEqual(
    parseCompetitorAddress("100 Collins St, VIC"),
    { street: "100 Collins St" },
    "bare AU state code is not the locality",
  );
  // No-street Australian address still yields the locality.
  assert.deepEqual(
    parseCompetitorAddress("Melbourne, VIC 3000, Australia"),
    { locality: "Melbourne" },
    "no-street Australian address → locality only",
  );
  // Irish Eircode "D02 AF30" is recognized, so the real city wins.
  assert.deepEqual(
    parseCompetitorAddress("12 Dame St, Dublin, D02 AF30, Ireland"),
    { street: "12 Dame St", locality: "Dublin" },
    "Irish address: Eircode not mistaken for the locality",
  );
  // Bare Eircode segment (no city) is skipped.
  assert.deepEqual(
    parseCompetitorAddress("12 Dame St, D02 AF30, Ireland"),
    { street: "12 Dame St" },
    "bare Eircode is not the locality",
  );
  // D6W routing key (letter-digit-letter) Eircode is also recognized.
  assert.deepEqual(
    parseCompetitorAddress("1 Main St, D6W 1234, Ireland"),
    { street: "1 Main St" },
    "D6W-style Eircode is not the locality",
  );
  // Dutch postcode "1011 AB" is recognized, so the real city wins.
  assert.deepEqual(
    parseCompetitorAddress("Damrak 1, 1012 LG, Amsterdam, Netherlands"),
    { street: "Damrak 1", locality: "Amsterdam" },
    "Dutch address: postcode not mistaken for the locality",
  );
  // Dutch postcode without internal space is still recognized.
  assert.deepEqual(
    parseCompetitorAddress("Damrak 1, 1012LG"),
    { street: "Damrak 1" },
    "Dutch postcode without internal space is not the locality",
  );
  // No-street Dutch address still yields the locality.
  assert.deepEqual(
    parseCompetitorAddress("Amsterdam, 1012 LG, Netherlands"),
    { locality: "Amsterdam" },
    "no-street Dutch address → locality only",
  );

  // Empty / nullish → {}.
  assert.deepEqual(parseCompetitorAddress(null), {}, "null address → {}");
  assert.deepEqual(parseCompetitorAddress(undefined), {}, "undefined address → {}");
  assert.deepEqual(parseCompetitorAddress(""), {}, "empty address → {}");
  assert.deepEqual(parseCompetitorAddress("  , , "), {}, "blank/comma-only address → {}");

  // --- 13. Task #2015 — client-facing mode suppresses the opaque hash ---
  // `allowOpaqueFallback: false` is the 4th arg (after `structured`). Friendly
  // `/place/` fragments and structured labels are still returned, but every
  // short-code-hash fallback collapses to `null` so a client-facing report/PDF
  // never renders an opaque "GBP <hash>" code.
  assert.equal(
    deriveCompetitorLocationLabel(
      "https://www.google.com/maps/place/Smith+Law+Firm+Chicago/@41.8,-87.6,17z",
      "Smith Law Firm",
      undefined,
      { allowOpaqueFallback: false },
    ),
    "Chicago",
    "client-facing mode still returns a friendly /place/ fragment",
  );
  assert.equal(
    deriveCompetitorLocationLabel(dedupeUrl, "Smith Law Firm", undefined, { allowOpaqueFallback: false }),
    null,
    "client-facing mode: firm-name-only fragment → null (no opaque hash)",
  );
  assert.equal(
    deriveCompetitorLocationLabel("https://maps.google.com/?cid=1234567890", "Some Firm", undefined, { allowOpaqueFallback: false }),
    null,
    "client-facing mode: cid fallback suppressed → null",
  );
  assert.equal(
    deriveCompetitorLocationLabel("https://www.google.com/search?q=place_id=ChIJ_abc-123", "Some Firm", undefined, { allowOpaqueFallback: false }),
    null,
    "client-facing mode: place_id fallback suppressed → null",
  );
  assert.equal(
    deriveCompetitorLocationLabel(opaque, "Some Firm", undefined, { allowOpaqueFallback: false }),
    null,
    "client-facing mode: whole-URL hash fallback suppressed → null",
  );
  // No GBP URL is still null regardless of the flag.
  assert.equal(
    deriveCompetitorLocationLabel(null, "Some Firm", undefined, { allowOpaqueFallback: false }),
    null,
    "client-facing mode: null gbpUrl → null",
  );
  // Structured labels still surface even in client-facing mode.
  assert.equal(
    deriveCompetitorLocationLabel(
      opaque,
      "Some Firm",
      { locality: "Chicago", street: "W Madison St" },
      { allowOpaqueFallback: false },
    ),
    "Chicago / W Madison St",
    "client-facing mode still returns structured labels",
  );

  // --- 13. normalizeCompetitorName (Task #2017 backfill match key) ---
  // The backfill matches SEMrush top-competitor names to historical snapshot
  // rows by this normalized key, so case / punctuation / whitespace variants
  // of the same firm must collapse to one identical key.
  assert.equal(
    normalizeCompetitorName("Smith Law Firm"),
    "smithlawfirm",
    "lowercased, spaces removed",
  );
  assert.equal(
    normalizeCompetitorName("Smith, Law & Firm  LLC."),
    "smithlawfirmllc",
    "punctuation and collapsed whitespace stripped",
  );
  assert.equal(
    normalizeCompetitorName("  SMITH LAW FIRM  "),
    normalizeCompetitorName("smith law firm"),
    "case + surrounding whitespace variants collapse to the same key",
  );
  assert.equal(normalizeCompetitorName(""), "", "empty string normalizes to empty");
  assert.equal(
    normalizeCompetitorName("---&&&"),
    "",
    "all-punctuation name normalizes to empty (no false match key)",
  );

  console.log("All competitor location label derivation tests passed.");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(
  () => {},
  err => {
    console.error(err);
    process.exitCode = 1;
  },
);
