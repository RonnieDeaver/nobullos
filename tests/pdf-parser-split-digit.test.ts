/* test-registration
{
  "name": "PDF parser split-digit number reassembly (Task #2555)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2555: the split-digit-safe numeric helpers underpin EVERY count in an imported report (a PDF extractor renders \"11\" as \"1 1\"; a naive `(\\d+)` stored 1). Gate the helper unit matrix so a regression in reassembly, labeled-count capture, lead-count cross-check, or quality-row checksum fails fast. Pure functions, no DB, fast and deterministic.",
  "tier": "small"
}
test-registration */
/**
 * Task #2555 — PDF parser split-digit number corruption.
 *
 * Some PDF text extractors render a multi-digit number like `11` as the two
 * space-separated tokens `1 1`. A naive `(\d+)` capture then stores only the
 * first digit (Oscar Mendoza's report imported 11 Google Ads leads as 1).
 *
 * These tests exercise the shared, split-digit-safe helpers that every numeric
 * extraction site now routes through:
 *   - reassembleSplitDigits  — strip intra-number spaces, flag reassembly.
 *   - captureLabeledCount    — label + (possibly split) count single-field grab.
 *   - crossCheckLeadCount    — reconcile a spend-section count against the
 *                              checksum-validated Lead Quality total.
 *   - reassembleQualityRow   — merge split tokens in an N-column quality row
 *                              using the checksum (col0 == sum of the rest).
 *   - parseLegacyQualityRow  — label-anchored wrapper over the row reassembler.
 */

import {
  reassembleSplitDigits,
  captureLabeledCount,
  crossCheckLeadCount,
  reassembleQualityRow,
  parseLegacyQualityRow,
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
  console.log("reassembleSplitDigits");
  await run("reassembles a single split digit (the reported bug: 1 1 -> 11)", () => {
    const r = reassembleSplitDigits("1 1");
    eq(r.value, 11, "value");
    eq(r.reassembled, true, "reassembled flag");
  });
  await run("reassembles multiple split digits (1 2 3 -> 123)", () => {
    const r = reassembleSplitDigits("1 2 3");
    eq(r.value, 123, "value");
    eq(r.reassembled, true, "reassembled flag");
  });
  await run("intact number is unchanged and not flagged", () => {
    const r = reassembleSplitDigits("11");
    eq(r.value, 11, "value");
    eq(r.reassembled, false, "reassembled flag");
  });
  await run("single digit is unchanged and not flagged", () => {
    const r = reassembleSplitDigits("7");
    eq(r.value, 7, "value");
    eq(r.reassembled, false, "reassembled flag");
  });
  await run("handles wider internal whitespace runs", () => {
    const r = reassembleSplitDigits("1   1   5");
    eq(r.value, 115, "value");
    eq(r.reassembled, true, "reassembled flag");
  });
  await run("null/undefined/empty -> 0, not flagged", () => {
    eq(reassembleSplitDigits(null).value, 0, "null value");
    eq(reassembleSplitDigits(undefined).value, 0, "undefined value");
    eq(reassembleSplitDigits("").reassembled, false, "empty flag");
  });

  console.log("captureLabeledCount");
  await run("captures an intact labeled count", () => {
    const r = captureLabeledCount("Registrants 24 attended", "Registrants");
    assert(r, "match found");
    eq(r!.value, 24, "value");
    eq(r!.reassembled, false, "reassembled flag");
  });
  await run("captures and reassembles a split labeled count", () => {
    const r = captureLabeledCount("Google Ads Leads 1 1", String.raw`Google\s*Ads\s*Leads`);
    assert(r, "match found");
    eq(r!.value, 11, "value");
    eq(r!.reassembled, true, "reassembled flag");
  });
  await run("returns null when the label is absent", () => {
    eq(captureLabeledCount("nothing here", "Registrants"), null, "no match");
  });
  await run("trailingGuard (?!\\s*\\.\\d) avoids grabbing the integer part of a following decimal rate", () => {
    // "Missed Calls 8.5%": the 8 is the integer part of a RATE, not a count.
    // Without the guard the helper grabs 8; with the real guard it declines.
    const withGuard = captureLabeledCount("Missed Calls 8.5%", "Missed\\s*Calls", {
      trailingGuard: String.raw`(?!\s*\.\d)`,
    });
    eq(withGuard, null, "guarded capture declines the rate's integer part");
    const noGuard = captureLabeledCount("Missed Calls 8.5%", "Missed\\s*Calls");
    assert(noGuard, "unguarded match found");
    eq(noGuard!.value, 8, "unguarded capture is contaminated (demonstrates why the guard matters)");
  });
  await run("decimal countSource captures a split integer part of a rate", () => {
    const SPLIT_DECIMAL = String.raw`\d[\d\s]*\d(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`;
    const r = captureLabeledCount("Show Rate 1 2.5", String.raw`Show\s*Rate`, {
      countSource: SPLIT_DECIMAL,
    });
    assert(r, "match found");
    eq(r!.value, 12.5, "value");
    eq(r!.reassembled, true, "reassembled flag");
  });

  console.log("crossCheckLeadCount");
  await run("equal values keep the spend value at high confidence", () => {
    const r = crossCheckLeadCount(11, 11);
    eq(r.value, 11, "value");
    eq(r.confidence, "high", "confidence");
    eq(r.note, "", "no note");
  });
  await run("undefined quality total trusts the spend value", () => {
    const r = crossCheckLeadCount(5, undefined);
    eq(r.value, 5, "value");
    eq(r.confidence, "high", "confidence");
  });
  await run("disagreement adopts the checksum-validated quality total", () => {
    // Spend section misread 11 as 1; the Lead Quality total (11) is trusted.
    const r = crossCheckLeadCount(1, 11);
    eq(r.value, 11, "value reconciled to quality total");
    eq(r.confidence, "medium", "confidence downgraded");
    assert(r.note.includes("11") && r.note.includes("1"), "note records both readings");
  });

  console.log("reassembleQualityRow");
  await run("intact 5-column checksum row is returned unchanged", () => {
    // total 11 = good 5 + missed 3 + notQuotable 2 + noData 1
    const r = reassembleQualityRow([11, 5, 3, 2, 1], 5);
    assert(r, "balanced");
    eq(JSON.stringify(r), JSON.stringify([11, 5, 3, 2, 1]), "cols");
  });
  await run("split leading digit is merged to satisfy the checksum", () => {
    // "1 1 5 3 2 1" -> 11,5,3,2,1
    const r = reassembleQualityRow([1, 1, 5, 3, 2, 1], 5);
    assert(r, "balanced");
    eq(JSON.stringify(r), JSON.stringify([11, 5, 3, 2, 1]), "cols");
  });
  await run("4-column old-format row reassembles (total missed notQuotable good)", () => {
    // total 12 = missed 4 + notQuotable 3 + good 5 ; split as "1 2 4 3 5"
    const r = reassembleQualityRow([1, 2, 4, 3, 5], 4);
    assert(r, "balanced");
    eq(r![0], 12, "total");
    eq(r![1] + r![2] + r![3], 12, "breakdown sums to total");
  });
  await run("expectedTotal hint rejects a balanced-but-wrong total", () => {
    // [9,5,3,1] checksums internally (9==5+3+1) but the caller knows total is 11.
    eq(reassembleQualityRow([9, 5, 3, 1], 4, 11), null, "rejected by hint");
  });
  await run("returns null when no merge can satisfy the checksum", () => {
    eq(reassembleQualityRow([7, 1, 1], 3), null, "unbalanced -> null");
  });

  console.log("parseLegacyQualityRow");
  await run("parses an intact labeled 5-column quality row", () => {
    const r = parseLegacyQualityRow("Google Ads 11 5 3 2 1", String.raw`Google\s*Ads`, 5);
    assert(r, "matched");
    eq(JSON.stringify(r!.cols), JSON.stringify([11, 5, 3, 2, 1]), "cols");
    eq(r!.reassembled, false, "not reassembled");
  });
  await run("reassembles a split labeled 5-column quality row", () => {
    const r = parseLegacyQualityRow("Google Ads 1 1 5 3 2 1", String.raw`Google\s*Ads`, 5);
    assert(r, "matched");
    eq(JSON.stringify(r!.cols), JSON.stringify([11, 5, 3, 2, 1]), "cols");
    eq(r!.reassembled, true, "reassembled flag");
  });
  await run("returns null when the platform label is absent", () => {
    eq(parseLegacyQualityRow("LSA 5 3 2", String.raw`Google\s*Ads`, 4), null, "no match");
  });
  await run("falls back to first targetLen tokens when no checksum-valid merge exists", () => {
    // 7 1 1 never balances for 3 cols (7 != 1+1); legacy behavior keeps [7,1,1].
    const r = parseLegacyQualityRow("LSA 7 1 1", String.raw`LSA`, 3);
    assert(r, "matched");
    eq(JSON.stringify(r!.cols), JSON.stringify([7, 1, 1]), "first-N fallback");
    eq(r!.reassembled, false, "fallback is not flagged as reassembled");
  });

  console.log("\nAll Task #2555 split-digit parser helper tests passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
