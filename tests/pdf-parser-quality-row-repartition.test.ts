/* test-registration
{
  "name": "PDF parser quality-row digit-stream repartition (Feedback #46)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Feedback #46 (2026-07 client report): the PDF text layer smeared the GBP Platform Lead Quality row '56 11 28 14 3' into '56 1 128 14 3' — token count preserved, checksum broken, merge-proof — so the row was dropped and ALL 56 GBP leads imported as No Data on a live client report while Google Ads/Other parsed fine. Gates the digit-stream repartition recovery (unambiguous-solution-only) and the real extracted-text fixture end-to-end. Pure functions, DB-free, network-free, fast.",
  "tier": "small"
}
test-registration */
// fs-scan-fixture-only -- reads tests/fixtures/*.txt extracted-text fixtures only
/**
 * Feedback #46 — count-preserving digit smears in Platform Lead Quality rows.
 *
 * Task #2555's merge-based reassembly recovers SPLIT digits ("1 1" → 11): it
 * can only merge adjacent tokens, i.e. reduce token count. The 2026-07 client
 * PDF exposed the complementary corruption class: "11 28" extracted as
 * "1 128" keeps the token count and moves a digit across a boundary. The
 * 5-column match then fails its checksum (1+128+14+3 = 146 ≠ 56), merging
 * cannot re-split "128", the 4-number fallback goes negative, and the GBP row
 * is dropped — leaving the parser-default noData:uniqueLeads on every GBP
 * location: all 56 GBP leads rendered as "No Data" while Google Ads and Other
 * (checksum-clean rows) imported correctly.
 *
 * `repartitionQualityRow` recovers this class by re-partitioning the intact
 * digit STREAM under the row checksum (col0 === sum of the rest). It accepts
 * an unambiguous reading only — ties return null, because writing a wrong
 * breakdown into a client report is worse than leaving the row unparsed.
 *
 * The end-to-end block replays the REAL extracted text of the affected report
 * (client name anonymized) through parseReportText.
 */

import * as fs from "fs";
import {
  parseLegacyQualityRow,
  parseReportText,
  reassembleQualityRow,
  repartitionQualityRow,
} from "../server/services/pdfImportParser";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function eq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((e) => {
      console.error(`  FAIL ${name}`);
      throw e;
    });
}

(async () => {
  console.log("repartitionQualityRow");
  await run("recovers the live GBP smear (56 1 128 14 3 → 56 11 28 14 3)", () => {
    eq(JSON.stringify(repartitionQualityRow([56, 1, 128, 14, 3], 5)), JSON.stringify([56, 11, 28, 14, 3]), "cols");
  });
  await run("tolerates a trailing junk token (the 2 that a 28.21 score cell sheds)", () => {
    eq(JSON.stringify(repartitionQualityRow([56, 1, 128, 14, 3, 2], 5)), JSON.stringify([56, 11, 28, 14, 3]), "cols");
  });
  await run("recovers fused tokens (11 28 → 1128, fewer tokens than columns)", () => {
    eq(JSON.stringify(repartitionQualityRow([56, 1128, 14, 3], 5)), JSON.stringify([56, 11, 28, 14, 3]), "cols");
  });
  await run("recovers a smeared total (56 → 5 6)", () => {
    eq(JSON.stringify(repartitionQualityRow([5, 6, 11, 28, 14, 3], 5)), JSON.stringify([56, 11, 28, 14, 3]), "cols");
  });
  await run("expectedTotal pin rejects a stream whose only balanced reading has another total", () => {
    eq(repartitionQualityRow([9, 5, 3, 1], 4, 11), null, "pinned reject");
  });
  await run("ambiguous streams refuse to guess (two balanced readings, tied boundary score)", () => {
    // Stream "11110" balances into 3 columns two ways: 11|1|10 and 11|11|0.
    // The fused original 11|110 preserves exactly one boundary of each — a
    // tie — so the helper must return null rather than pick a reading.
    eq(repartitionQualityRow([11, 110], 3), null, "tie -> null");
  });
  await run("genuinely unbalanced rows stay null", () => {
    eq(repartitionQualityRow([7, 1, 1], 3), null, "no balanced reading");
  });
  await run("cross-prefix ambiguity refuses (valid readings at two junk-tolerant prefixes)", () => {
    // take=3 stream "312" balances as 3|1|2; take=4 stream "31229" balances
    // as 31|2|29 (boundary-preferred over 31|22|9). Two prefixes admit valid
    // readings and the helper cannot know whether the 4th token is junk or
    // row data — it must refuse rather than pick one.
    eq(repartitionQualityRow([3, 1, 2, 29], 3), null, "cross-prefix -> null");
  });

  console.log("reassembleQualityRow (repartition integration)");
  await run("exact-length checksum failure now falls through to repartition", () => {
    eq(JSON.stringify(reassembleQualityRow([56, 1, 128, 14, 3], 5)), JSON.stringify([56, 11, 28, 14, 3]), "cols");
  });
  await run("Task #2555 merge recovery still wins for pure splits", () => {
    eq(JSON.stringify(reassembleQualityRow([1, 1, 5, 3, 2, 1], 5)), JSON.stringify([11, 5, 3, 2, 1]), "cols");
  });
  await run("Task #2555 null contracts hold (expectedTotal reject / unbalanced)", () => {
    eq(reassembleQualityRow([9, 5, 3, 1], 4, 11), null, "hint reject");
    eq(reassembleQualityRow([7, 1, 1], 3), null, "unbalanced");
  });

  console.log("parseLegacyQualityRow");
  await run("legacy row with the smear + trailing score fragment recovers and is flagged", () => {
    const r = parseLegacyQualityRow("GBP 56 1 128 14 3 28.21 Other 49 4 34 7 4 10.53", String.raw`GBP`, 5);
    assert(r, "matched");
    eq(JSON.stringify(r!.cols), JSON.stringify([56, 11, 28, 14, 3]), "cols");
    eq(r!.reassembled, true, "flagged as reassembled");
  });
  await run("intact rows keep reassembled:false (flag is value-diff, not length-diff)", () => {
    const r = parseLegacyQualityRow("Google Ads 11 5 3 2 1", String.raw`Google\s*Ads`, 5);
    assert(r, "matched");
    eq(JSON.stringify(r!.cols), JSON.stringify([11, 5, 3, 2, 1]), "cols");
    eq(r!.reassembled, false, "not flagged");
  });
  await run("never-balancing rows keep the first-N raw-token fallback", () => {
    const r = parseLegacyQualityRow("LSA 7 1 1", String.raw`LSA`, 3);
    assert(r, "matched");
    eq(JSON.stringify(r!.cols), JSON.stringify([7, 1, 1]), "first-N fallback");
    eq(r!.reassembled, false, "fallback not flagged");
  });

  console.log("end-to-end: real 2026-07 extracted text (anonymized)");
  const FIXTURE = fs.readFileSync(
    new URL("./fixtures/gbp-quality-smear-extracted-text.txt", import.meta.url),
    "utf8",
  );
  assert(FIXTURE.includes("GBP 56 1 128 14 3"), "fixture carries the raw smear");
  const parsed: any = parseReportText(FIXTURE);
  await run("Google Ads quality parses as before (checksum-clean row untouched)", () => {
    eq(
      JSON.stringify(parsed.marketing.googleAds.leadQuality),
      JSON.stringify({ good: 19, notQuotable: 29, missedCalls: 16, noData: 10 }),
      "ads quality",
    );
  });
  await run("Other quality parses as before", () => {
    eq(
      JSON.stringify(parsed.marketing.otherLeads.leadQuality),
      JSON.stringify({ good: 4, notQuotable: 34, missedCalls: 7, noData: 4 }),
      "other quality",
    );
  });
  await run("GBP row recovers: the location gets 11G/28NQ/14M/3ND instead of 56 No Data", () => {
    const locs = parsed.marketing.gbpLocations;
    eq(locs.length, 1, "one location");
    eq(locs[0].name, "Houston", "location name");
    eq(locs[0].uniqueLeads, 56, "uniqueLeads");
    eq(
      JSON.stringify(locs[0].leadQuality),
      JSON.stringify({ good: 11, notQuotable: 28, missedCalls: 14, noData: 3 }),
      "location quality",
    );
  });
  await run("GBP quality confidence entry records the reassembly", () => {
    const conf = parsed.fieldConfidence?.["marketing.gbp.leadQuality"];
    assert(conf, "confidence key present");
    assert(
      String(conf.source).includes("(reassembled)"),
      `source records reassembly, got: ${conf?.source}`,
    );
  });

  console.log("\nAll quality-row repartition tests passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
