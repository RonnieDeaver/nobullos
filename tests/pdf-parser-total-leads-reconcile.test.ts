/* test-registration
{
  "name": "Pdf parser total leads reconcile (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
// Task #2753 — regression for the Total-Leads reliability reconciliation in
// `server/services/pdfImportParser.ts`.
//
// Bug fixed: the Task #2555 per-source clamp treated the parsed "Total Leads"
// as always-trustworthy. On the June 2026 Jones Law Firm report the parser
// mis-read "Total Leads 1" while the per-source lead-quality tables clearly
// supported ~595 platform leads — so the clamp crushed EVERY source
// (59 / 340 / 179 / 17 → 1). The fix (`reconcileTotalLeadsAgainstSources`)
// declares the TOTAL unreliable when the summed per-source evidence EXCLUDING
// the single largest source still exceeds it, and recomputes the total from
// the sources instead of clamping them. A genuine single-source split-digit
// overshoot of a trustworthy total (the case #2555 was built for) must still
// be left to the clamp.
//
// Usage: tsx tests/pdf-parser-total-leads-reconcile.test.ts
import assert from "node:assert/strict";
import { reconcileTotalLeadsAgainstSources } from "../server/services/pdfImportParser";

function run() {
  // ── (1) June 2026 shape: tiny mis-read total vs several well-supported
  //        sources → total is the unreliable value; recompute from sources. ──
  {
    // GBP locations 59 + 179, LSA 340, webinar 17 → sum 595; total mis-read as 1.
    const rec = reconcileTotalLeadsAgainstSources(1, [59, 179, 340, 17], 0);
    assert.equal(rec.unreliable, true, "tiny total vs multi-source evidence → unreliable");
    assert.equal(rec.sourceSum, 595, "source sum computed");
    assert.equal(
      rec.supportExcludingLargest,
      255,
      "support excluding the largest source (340) is 255 > 1",
    );
    assert.equal(rec.correctedTotal, 595, "corrected total = sum of sources");
  }

  // ── (2) Other-leads are folded into the corrected total. ──
  {
    const rec = reconcileTotalLeadsAgainstSources(1, [59, 179, 340, 17], 12);
    assert.equal(rec.unreliable, true);
    assert.equal(rec.correctedTotal, 607, "corrected total includes Other leads");
  }

  // ── (3) Genuine single-source split-digit overshoot: ONE corrupted source
  //        exceeds a trustworthy total, the rest fit comfortably → total is
  //        KEPT (the #2555 clamp downstream handles the bad source). ──
  {
    // total 100; corrupted source 115 (e.g. "1 15" reassembled wrong), others 20+10.
    const rec = reconcileTotalLeadsAgainstSources(100, [115, 20, 10], 0);
    assert.equal(
      rec.unreliable,
      false,
      "single-source overshoot with the rest fitting inside the total → total kept",
    );
    assert.equal(rec.correctedTotal, 100, "parsed total preserved for the clamp path");
  }

  // ── (4) Sources fit inside the total → nothing to reconcile. ──
  {
    const rec = reconcileTotalLeadsAgainstSources(600, [59, 179, 340, 17], 0);
    assert.equal(rec.unreliable, false, "consistent report untouched");
    assert.equal(rec.correctedTotal, 600);
  }

  // ── (5) Boundary: support-excluding-largest EQUAL to the total is NOT
  //        enough — strict inequality required so a legitimately-tight report
  //        can't get its parsed total overwritten. ──
  {
    const rec = reconcileTotalLeadsAgainstSources(30, [40, 20, 10], 0);
    assert.equal(rec.supportExcludingLargest, 30);
    assert.equal(rec.unreliable, false, "support == total → total kept (strict >)");
  }
  {
    const rec = reconcileTotalLeadsAgainstSources(29, [40, 20, 10], 0);
    assert.equal(rec.unreliable, true, "support just over total → unreliable");
    assert.equal(rec.correctedTotal, 70);
  }

  // ── (6) No parsed total (0) → nothing to reconcile (parse-fallback paths
  //        downstream own that case). Negative/NaN sources are ignored. ──
  {
    const rec = reconcileTotalLeadsAgainstSources(0, [59, 179], 0);
    assert.equal(rec.unreliable, false, "total 0 → not reconciled");
  }
  {
    const rec = reconcileTotalLeadsAgainstSources(1, [59, NaN as any, -5, 179, 340, 17], 0);
    assert.equal(rec.unreliable, true, "junk source values ignored, verdict unchanged");
    assert.equal(rec.sourceSum, 595);
  }

  console.log("pdf-parser-total-leads-reconcile: ALL TESTS PASSED");
}

run();
