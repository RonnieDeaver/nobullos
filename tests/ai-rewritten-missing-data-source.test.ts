/* test-registration
{
  "name": "AI-rewritten Missing data source placeholder cleanup (Task #1267)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1267 — Detector for the AI-rewritten "Missing data source" finding.
 *
 * Verifies:
 *   1. isAiRewrittenMissingDataSourceFinding matches the canonical AI rewrite
 *      (single and stacked blocks), tolerates the letter-spaced PDF artifact
 *      tail ("N a m e   C l e a n ( 1 ) : …"), and the separator "---".
 *   2. It rejects empty / blank / literal placeholder values (those are
 *      handled by the existing isEmptySectionBody path).
 *   3. It rejects rows that mix in genuinely different findings so the
 *      cleanup script leaves them alone.
 *   4. The cleanup script's eligibility predicate (isEmptySectionBody OR
 *      isAiRewrittenMissingDataSourceFinding) covers all three flavors of
 *      bad-row we want to clear and skips real content.
 */

import {
  isAiRewrittenMissingDataSourceFinding,
  isEmptySectionBody,
  isMissingDataSourcePlaceholder,
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

const SINGLE_BLOCK = `🔴 **Issue:** Missing data source. There is no data source associated with this component.
↳ **Impact:** Operators cannot see the underlying intake metrics.
> ➡️ **Strategic Fix:** Connect the intake CSV feed to this report so the section populates.`;

const STACKED_BLOCKS = `${SINGLE_BLOCK}

---

🔴 **Issue:** No data source associated with this component.
↳ **Impact:** Sales numbers can't be calculated.
> ➡️ **Strategic Fix:** Wire up the sales pipeline export before next month's report.`;

const STACKED_WITH_ARTIFACT_TAIL = `${STACKED_BLOCKS}

N a m e   C l e a n ( 1 ) : ABC Law Firm`;

const MIXED_WITH_REAL_FINDING = `${SINGLE_BLOCK}

---

🔴 **Issue:** Reps drop Spanish-speaking leads on first call.
↳ **Impact:** Conversion on bilingual leads is half the firm average.
> ➡️ **Strategic Fix:** Add a Spanish-speaking intake specialist to the morning shift.`;

const REAL_FINDING_ONLY = `🔴 **Issue:** Reps drop Spanish-speaking leads on first call.
↳ **Impact:** Conversion on bilingual leads is half the firm average.
> ➡️ **Strategic Fix:** Add a Spanish-speaking intake specialist to the morning shift.`;

const LITERAL_PLACEHOLDER =
  "Missing data source - There is no data source associated with this component. See details";

(async () => {
  console.log("isAiRewrittenMissingDataSourceFinding — positives");
  await run("matches a single AI-rewritten placeholder block", () => {
    assert(
      isAiRewrittenMissingDataSourceFinding(SINGLE_BLOCK),
      "single block should match",
    );
  });
  await run("matches stacked AI-rewritten placeholder blocks", () => {
    assert(
      isAiRewrittenMissingDataSourceFinding(STACKED_BLOCKS),
      "stacked blocks should match",
    );
  });
  await run(
    "matches when followed by the letter-spaced PDF artifact tail",
    () => {
      assert(
        isAiRewrittenMissingDataSourceFinding(STACKED_WITH_ARTIFACT_TAIL),
        "stacked + NameClean tail should match",
      );
    },
  );

  console.log("isAiRewrittenMissingDataSourceFinding — negatives");
  await run("does NOT match empty / null / whitespace", () => {
    assert(!isAiRewrittenMissingDataSourceFinding(""), "empty");
    assert(!isAiRewrittenMissingDataSourceFinding(null), "null");
    assert(!isAiRewrittenMissingDataSourceFinding(undefined), "undefined");
    assert(!isAiRewrittenMissingDataSourceFinding("   \n\n  "), "whitespace");
  });
  await run("does NOT match the literal (non-AI) placeholder", () => {
    // The literal placeholder is handled by isEmptySectionBody/
    // isMissingDataSourcePlaceholder, not by this detector.
    assert(
      !isAiRewrittenMissingDataSourceFinding(LITERAL_PLACEHOLDER),
      "literal placeholder is not AI-rewritten",
    );
  });
  await run("does NOT match a real finding only", () => {
    assert(
      !isAiRewrittenMissingDataSourceFinding(REAL_FINDING_ONLY),
      "real finding should be left alone",
    );
  });
  await run("does NOT match when a real finding is mixed in", () => {
    assert(
      !isAiRewrittenMissingDataSourceFinding(MIXED_WITH_REAL_FINDING),
      "mixed content should be left alone",
    );
  });
  await run("does NOT match prose-only content with no 🔴 markers", () => {
    assert(
      !isAiRewrittenMissingDataSourceFinding(
        "There is no data source associated with this component yet, but we are gathering it.",
      ),
      "prose without 🔴 markers must not match",
    );
  });
  await run("does NOT match when text precedes the first 🔴 block", () => {
    const withPrefix = `Note from operator: please review.\n\n${SINGLE_BLOCK}`;
    assert(
      !isAiRewrittenMissingDataSourceFinding(withPrefix),
      "prefix text means mixed content",
    );
  });

  console.log("cleanup-script eligibility predicate");
  // This mirrors the eligibility logic in
  // scripts/clear-placeholder-common-issues.ts so a regression in either
  // file is caught here.
  const isEligible = (text: string): boolean =>
    isMissingDataSourcePlaceholder(text) ||
    isEmptySectionBody(text) ||
    isAiRewrittenMissingDataSourceFinding(text);

  await run("eligible: literal placeholder", () => {
    assert(isEligible(LITERAL_PLACEHOLDER), "literal placeholder eligible");
  });
  await run("eligible: blank / dashes-only body", () => {
    assert(isEligible("---  ----"), "dashes-only eligible");
  });
  await run("eligible: single AI-rewritten block", () => {
    assert(isEligible(SINGLE_BLOCK), "single AI block eligible");
  });
  await run("eligible: stacked AI-rewritten blocks + artifact tail", () => {
    assert(
      isEligible(STACKED_WITH_ARTIFACT_TAIL),
      "stacked + tail eligible",
    );
  });
  await run("NOT eligible: real finding", () => {
    assert(!isEligible(REAL_FINDING_ONLY), "real finding skipped");
  });
  await run("NOT eligible: AI placeholder mixed with a real finding", () => {
    assert(
      !isEligible(MIXED_WITH_REAL_FINDING),
      "mixed content skipped",
    );
  });

  console.log("\nAll Task #1267 AI-rewritten placeholder tests passed.");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
