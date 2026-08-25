/* test-registration
{
  "name": "PDF parser Time to Human Answer label + parse-evidence contract (Task #3772)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3772: the \"Time to Human Answer\" label variant + the parse-evidence contract (fieldConfidence key presence = parsed; absent metrics must NOT become unflagged zeros). A regression here silently fabricates healthy- looking \"0s\" intake cards on imported reports. Pure functions, no DB.",
  "tier": "small"
}
test-registration */
/**
 * Task #3772 — "Time to Human Answer" label variant + parse-evidence contract.
 *
 * Newer "REA Data Export" PDFs (June 2026+: Ackah Law, Jurist Law Group,
 * Shields & Boris) label the intake answer-time metric "Time to Human Answer"
 * instead of the legacy "Avg Time to Answer". The parser must:
 *   1. capture BOTH label variants (optional "Avg"/"Avg." prefix, optional
 *      "(s)"/"(sec)" suffix) into intake.avgTimeToAnswer at high confidence;
 *   2. record a fieldConfidence["intake.avgTimeToAnswer"] entry ONLY when a
 *      label matched — key presence is the "parsed vs defaulted 0" contract
 *      the import write policy and review dialog rely on.
 *
 * Fixtures reproduce the REAL extracted-text shape from the production
 * webhook_import_logs rows that motivated the task: the label followed
 * directly by a decimal, surrounded by "See details" link noise, with the
 * letter-spaced header junk these exports carry.
 */

import { parseReportText } from "../server/services/pdfImportParser";
import { buildImportedSectionNoDataFlags } from "../server/services/importWritePolicy";
import {
  ENTRY_TRACKED_IMPORT_METRICS,
  importMetricWasParsed,
  importMetricNotFound,
} from "../shared/importMetricPresence";

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

// Real extracted-text shape (Ackah Law 2026-07 production import log):
// letter-spaced header, "See details" noise, label + decimal.
const ACKAH_JULY_TEXT =
  "R E A D a t a E x p o r t Ackah Law Report July 2026 Overview " +
  "See details See details Time to Human Answer 8.45 See details See details " +
  "Good 12 Not Quotable 27 Missed Call 2 No Data 7";

const JURIST_JUNE_TEXT =
  "Jurist Law Group REA Data Export June 2026 " +
  "See details Time to Human Answer 14.37 See details";

(async () => {
  console.log("Time to Human Answer label variant");

  await run("parses the real Ackah 2026-07 shape (8.45) with high confidence", () => {
    const parsed = parseReportText(ACKAH_JULY_TEXT);
    eq(parsed.intake.avgTimeToAnswer, 8.45, "intake.avgTimeToAnswer");
    const entry = parsed.fieldConfidence["intake.avgTimeToAnswer"];
    assert(entry, "fieldConfidence entry must be recorded");
    eq(entry.confidence, "high", "confidence level");
    assert(
      entry.source.includes("Time to Human Answer"),
      `source names the matched label, got: ${entry.source}`,
    );
  });

  await run("parses the real Jurist 2026-06 shape (14.37)", () => {
    const parsed = parseReportText(JURIST_JUNE_TEXT);
    eq(parsed.intake.avgTimeToAnswer, 14.37, "intake.avgTimeToAnswer");
    assert(parsed.fieldConfidence["intake.avgTimeToAnswer"], "confidence entry present");
  });

  await run("legacy 'Avg Time to Answer' label still parses (regression)", () => {
    const parsed = parseReportText("Intake Metrics Avg Time to Answer 12.5 Quality");
    eq(parsed.intake.avgTimeToAnswer, 12.5, "intake.avgTimeToAnswer");
    const entry = parsed.fieldConfidence["intake.avgTimeToAnswer"];
    assert(entry, "confidence entry present");
    assert(
      entry.source.includes("Avg Time to Answer"),
      `source names the legacy label, got: ${entry.source}`,
    );
  });

  await run("legacy label with (s) suffix still parses", () => {
    const parsed = parseReportText("Avg. Time to Answer (s) 9.2 See details");
    eq(parsed.intake.avgTimeToAnswer, 9.2, "intake.avgTimeToAnswer");
  });

  await run("variant with Avg prefix and (sec) suffix parses", () => {
    const parsed = parseReportText("Avg Time to Human Answer (sec) 7.5 See details");
    eq(parsed.intake.avgTimeToAnswer, 7.5, "intake.avgTimeToAnswer");
  });

  await run("variant with Avg. prefix and (s) suffix parses", () => {
    const parsed = parseReportText("Avg. Time to Human Answer (s) 11.02 See details");
    eq(parsed.intake.avgTimeToAnswer, 11.02, "intake.avgTimeToAnswer");
  });

  await run("split-digit decimal after the variant label reassembles", () => {
    const parsed = parseReportText("See details Time to Human Answer 1 6.32 See details");
    eq(parsed.intake.avgTimeToAnswer, 16.32, "intake.avgTimeToAnswer");
    assert(parsed.fieldConfidence["intake.avgTimeToAnswer"], "confidence entry present");
  });

  console.log("absent stays absent (parse-evidence contract)");

  await run("'No data' body after the label yields NO value and NO confidence key", () => {
    const parsed = parseReportText("See details Time to Human Answer No data See details");
    eq(parsed.intake.avgTimeToAnswer, 0, "defaulted 0");
    assert(
      !("intake.avgTimeToAnswer" in parsed.fieldConfidence),
      "no fieldConfidence entry may be recorded without a numeric match",
    );
  });

  await run("metric entirely absent yields defaulted 0 with NO confidence key", () => {
    const parsed = parseReportText("Some unrelated report text Total Leads 305");
    eq(parsed.intake.avgTimeToAnswer, 0, "defaulted 0");
    assert(!("intake.avgTimeToAnswer" in parsed.fieldConfidence), "no confidence entry");
  });

  console.log("import write policy integration");

  await run("buildImportedSectionNoDataFlags flags exactly the unparsed intake metrics", () => {
    const parsed = parseReportText(ACKAH_JULY_TEXT);
    const flags = buildImportedSectionNoDataFlags(parsed.fieldConfidence, "intake");
    eq(flags.avgTimeToAnswer, false, "parsed metric must stay unflagged");
    eq(flags.totalConsults, true, "unparsed metric must be flagged No-Data");
    eq(flags.qualityScore, true, "unparsed metric must be flagged No-Data");
  });

  await run("sales flags are all No-Data for a PDF with no sales metrics", () => {
    const parsed = parseReportText(ACKAH_JULY_TEXT);
    const flags = buildImportedSectionNoDataFlags(parsed.fieldConfidence, "sales");
    for (const field of ENTRY_TRACKED_IMPORT_METRICS.sales) {
      eq(flags[field], true, `sales.${field} must be flagged`);
    }
  });

  await run("importMetricWasParsed follows key presence, not the value", () => {
    const parsed = parseReportText(ACKAH_JULY_TEXT);
    eq(importMetricWasParsed(parsed.fieldConfidence, "intake", "avgTimeToAnswer"), true, "parsed");
    eq(importMetricWasParsed(parsed.fieldConfidence, "intake", "totalConsults"), false, "unparsed");
    eq(importMetricWasParsed(undefined, "intake", "avgTimeToAnswer"), false, "missing map");
  });

  await run("importMetricNotFound: evidence-less zero is not-found; parsed value is found", () => {
    const found = parseReportText(ACKAH_JULY_TEXT);
    eq(importMetricNotFound(found, "intake.avgTimeToAnswer"), false, "parsed 8.45");
    const missed = parseReportText("Some unrelated report text");
    eq(importMetricNotFound(missed, "intake.avgTimeToAnswer"), true, "evidence-less 0");
    eq(importMetricNotFound(missed, "sales.averageCaseValue"), true, "evidence-less sales 0");
  });

  await run("importMetricNotFound: merged non-zero value without evidence is NOT not-found", () => {
    // The reimport merge preserves existing report values into the parsed
    // payload without adding confidence entries — real data, not fabrication.
    const merged: any = parseReportText("Some unrelated report text");
    merged.intake.totalConsults = 42;
    eq(importMetricNotFound(merged, "intake.totalConsults"), false, "merged 42 stays a real row");
  });

  await run("importMetricNotFound never affects non-numeric-metric keys", () => {
    const missed = parseReportText("Some unrelated report text");
    eq(importMetricNotFound(missed, "intake.commonIssues"), false, "text field");
    eq(importMetricNotFound(missed, "marketing.gbpLocations"), false, "array field");
    eq(importMetricNotFound(null, "intake.avgTimeToAnswer"), false, "null payload");
  });

  console.log("\nAll Time-to-Human-Answer parser tests passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
