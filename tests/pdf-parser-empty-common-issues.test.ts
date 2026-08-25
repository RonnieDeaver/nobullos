/* test-registration
{
  "name": "PDF parser empty/placeholder Common Issues (Task #830)",
  "tier": "medium"
}
test-registration */
/**
 * Task #830 — PDF parser: empty / placeholder Common Issues hardening.
 *
 * Verifies:
 *   1. The "missing data source" placeholder family is detected as empty
 *      across whitespace, casing, hyphen-vs-em-dash, and split-line
 *      variants.
 *   2. extractCommonIssuesFromText returns:
 *        - real text  → confidence: "high"
 *        - placeholder → confidence: "none" + reason
 *        - blank body  → confidence: "none" + reason
 *        - no section  → confidence: "none" + reason
 *      …for both intake and sales.
 *   3. resolveCommonIssuesOnReimport preserves existing non-empty values
 *      when the parsed body is empty / placeholder, and uses parsed
 *      content when it is real.
 *   4. parseReportPdf integration: the placeholder produces no string
 *      assignment to intake/sales.commonIssues and no "high" confidence,
 *      while a real body is captured at "high" confidence.
 */

import {
  extractCommonIssuesFromText,
  isEmptySectionBody,
  isMissingDataSourcePlaceholder,
  normalizeExtractedSectionText,
  resolveCommonIssuesOnReimport,
} from "../server/services/pdfImportParser";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
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

const PLACEHOLDER_BASE = "Missing data source - There is no data source associated with this component. See details";

(async () => {
  console.log("normalizeExtractedSectionText");
  await run("collapses whitespace and trims", () => {
    assert(normalizeExtractedSectionText("  hello   world\n\nfoo  ") === "hello world foo", "whitespace collapse");
  });
  await run("normalizes em-dash and en-dash to hyphen", () => {
    const out = normalizeExtractedSectionText("a \u2014 b \u2013 c");
    assert(out === "a - b - c", `expected dashes normalized, got ${JSON.stringify(out)}`);
  });
  await run("returns empty string for null/undefined", () => {
    assert(normalizeExtractedSectionText(null) === "", "null → empty");
    assert(normalizeExtractedSectionText(undefined) === "", "undefined → empty");
  });

  console.log("isMissingDataSourcePlaceholder");
  await run("detects exact placeholder", () => {
    assert(isMissingDataSourcePlaceholder(PLACEHOLDER_BASE), "exact placeholder");
  });
  await run("detects with em-dash and trailing whitespace", () => {
    const variant = "  Missing data source \u2014 There is no data source associated with this component.   See details   \n";
    assert(isMissingDataSourcePlaceholder(variant), "em-dash + whitespace variant");
  });
  await run("detects when split across lines", () => {
    const variant = "Missing data source\n-\nThere is no data source associated with this\ncomponent.\nSee details";
    assert(isMissingDataSourcePlaceholder(variant), "multi-line variant");
  });
  await run("case-insensitive", () => {
    const variant = "MISSING DATA SOURCE - there is no data source associated with this component. SEE DETAILS";
    assert(isMissingDataSourcePlaceholder(variant), "case-insensitive");
  });
  await run("does NOT match real content", () => {
    assert(!isMissingDataSourcePlaceholder("Sometimes intake misses follow-ups on bilingual leads."), "real text not matched");
  });
  await run("does NOT match empty string", () => {
    assert(!isMissingDataSourcePlaceholder(""), "empty string returns false (handled by isEmptySectionBody)");
  });

  console.log("isEmptySectionBody");
  await run("empty / null / whitespace are empty", () => {
    assert(isEmptySectionBody(""), "empty");
    assert(isEmptySectionBody(null), "null");
    assert(isEmptySectionBody(undefined), "undefined");
    assert(isEmptySectionBody("   \n\n  "), "whitespace");
    assert(isEmptySectionBody("---  ----"), "dashes-only separator");
  });
  await run("placeholder is empty", () => {
    assert(isEmptySectionBody(PLACEHOLDER_BASE), "placeholder treated as empty");
  });
  await run("real text is not empty", () => {
    assert(!isEmptySectionBody("Frequently dropped Spanish-speaking leads on first call."), "real text");
  });

  console.log("extractCommonIssuesFromText (intake)");
  await run("captures real intake body at high confidence", () => {
    const text = `Some report header
Intake Common Issues
Frequently dropped Spanish-speaking leads on first call. Need follow-up training.
Sales Common Issues
Other body here for sales`;
    const r = extractCommonIssuesFromText(text, "intake");
    assert(!r.isEmpty, "should not be empty");
    assert(r.confidence.confidence === "high", `expected high, got ${r.confidence.confidence}`);
    assert(r.value.includes("Frequently dropped"), `value preserved: ${r.value}`);
    assert(!r.value.includes("Sales Common Issues"), "should stop before sales heading");
  });
  await run("placeholder intake → none + reason", () => {
    const text = `Intake Common Issues
${PLACEHOLDER_BASE}
Sales Common Issues
real sales body that is long enough to count as content`;
    const r = extractCommonIssuesFromText(text, "intake");
    assert(r.isEmpty, "placeholder should be empty");
    assert(r.value === "", "value should be empty string");
    assert(r.confidence.confidence === "none", `expected none, got ${r.confidence.confidence}`);
    assert(r.emptyReason === "missing_data_source_placeholder", `reason: ${r.emptyReason}`);
    assert(/missing data source/i.test(r.confidence.source), "source mentions placeholder");
  });
  await run("blank intake body → none + reason", () => {
    const text = `Intake Common Issues
   
Sales Common Issues
body`;
    const r = extractCommonIssuesFromText(text, "intake");
    assert(r.isEmpty, "blank body");
    assert(r.confidence.confidence === "none", "none");
    assert(r.emptyReason === "blank_body" || r.emptyReason === "no_section_match", `reason: ${r.emptyReason}`);
  });
  await run("missing intake heading → none + no_section_match", () => {
    const text = `Some unrelated report content with no relevant heading at all.`;
    const r = extractCommonIssuesFromText(text, "intake");
    assert(r.isEmpty, "no match");
    assert(r.confidence.confidence === "none", "none");
    assert(r.emptyReason === "no_section_match", `reason: ${r.emptyReason}`);
  });

  console.log("extractCommonIssuesFromText (sales)");
  await run("captures real sales body at high confidence", () => {
    const text = `Sales Common Issues
Reps not following up within 24 hours on consult requests for new clients.
Client (Acme) - extra footer`;
    const r = extractCommonIssuesFromText(text, "sales");
    assert(!r.isEmpty, "real sales body");
    assert(r.confidence.confidence === "high", "high");
    assert(r.value.includes("Reps not following up"), "value preserved");
  });
  await run("placeholder sales → none + reason", () => {
    const text = `Intake Common Issues
real intake body that has plenty of content here
Sales Common Issues
${PLACEHOLDER_BASE}
Client (Acme)`;
    const r = extractCommonIssuesFromText(text, "sales");
    assert(r.isEmpty, "placeholder sales");
    assert(r.value === "", "empty value");
    assert(r.confidence.confidence === "none", "none");
    assert(r.emptyReason === "missing_data_source_placeholder", `reason: ${r.emptyReason}`);
  });

  console.log("resolveCommonIssuesOnReimport");
  await run("preserves existing when parsed empty", () => {
    const out = resolveCommonIssuesOnReimport("", "We are losing leads on weekends.");
    assert(out === "We are losing leads on weekends.", `got: ${out}`);
  });
  await run("preserves existing when parsed is placeholder", () => {
    const out = resolveCommonIssuesOnReimport(PLACEHOLDER_BASE, "We are losing leads on weekends.");
    assert(out === "We are losing leads on weekends.", `got: ${out}`);
  });
  await run("uses parsed when parsed has real content", () => {
    const out = resolveCommonIssuesOnReimport("Brand new finding from this month.", "Old finding.");
    assert(out === "Brand new finding from this month.", `got: ${out}`);
  });
  await run("returns empty string when both empty", () => {
    const out = resolveCommonIssuesOnReimport("", "");
    assert(out === "", `got: ${out}`);
  });
  await run("returns empty string when no existing and parsed empty", () => {
    const out = resolveCommonIssuesOnReimport("", undefined);
    assert(out === "", `got: ${out}`);
  });
  await run("preserves existing placeholder when parsed empty (cleanup is a separate step)", () => {
    // Per task #830 spec: re-import must NEVER use a parsed empty as proof
    // that an existing stored value should be replaced — even if that
    // existing value is itself the bad placeholder. Cleanup of historical
    // bad rows is handled by the explicit data correction script, not by
    // re-import behavior.
    const out = resolveCommonIssuesOnReimport("", PLACEHOLDER_BASE);
    assert(out === PLACEHOLDER_BASE, `existing placeholder should be preserved, got: ${out}`);
  });
  await run("preserves existing placeholder when parsed is also placeholder", () => {
    const out = resolveCommonIssuesOnReimport(PLACEHOLDER_BASE, PLACEHOLDER_BASE);
    assert(out === PLACEHOLDER_BASE, `existing placeholder should be preserved, got: ${out}`);
  });

  console.log("parseReportPdf integration (extracted-text path)");
  // We exercise the same code path the parser uses by feeding the parser's
  // text-extraction step a synthetic buffer would be heavy. Instead, we
  // build the same fullText shape and re-run the helper to assert end-state
  // behavior (no commonIssues string is ever set when placeholder, no high
  // confidence is recorded).
  await run("placeholder body never becomes a stored value or high confidence", () => {
    const fullText = `Intake Quality Score 8
Intake Common Issues
${PLACEHOLDER_BASE}
Sales Common Issues
${PLACEHOLDER_BASE}
Client (Acme)`;
    const intake = extractCommonIssuesFromText(fullText, "intake");
    const sales = extractCommonIssuesFromText(fullText, "sales");
    assert(intake.value === "" && sales.value === "", "both values empty");
    assert(intake.confidence.confidence !== "high", "intake not high");
    assert(sales.confidence.confidence !== "high", "sales not high");
    assert(intake.confidence.confidence === "none", "intake explicitly none");
    assert(sales.confidence.confidence === "none", "sales explicitly none");
  });

  console.log("\nAll Task #830 PDF parser tests passed.");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
