/* test-registration
{
  "name": "lint-report-editor-decimal-parseint guard (Task #2757)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2757: fast, DB-free fixture-based guard test — asserts the report-editor decimal-parseInt lint flags a decimal-capable field bound to parseInt (the Ad Spend / Avg Time to Human Answer bug class) and stays quiet on integer-count fields, so the guard itself can't silently rot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2757 — Regression test for the report-editor decimal parseInt guard.
 *
 * The guard (scripts/lint-report-editor-decimal-parseint.ts) flags any
 * report-editor assignment `<field>: parseInt(...)` where <field> is
 * decimal-capable (dollar amounts, seconds, rates, averages...). This is the
 * Ad Spend / Avg Time to Human Answer bug class: parseInt on a controlled
 * input strips decimals silently as the user types.
 *
 * Proves:
 *   1. The REAL ReportForm.tsx passes (all remaining parseInt fields are
 *      integer counts) and the scan actually saw parseInt assignments.
 *   2. A decimal-capable field (adSpend / avgTimeToAnswer style) bound to
 *      parseInt in a fixture is flagged, naming file, line, and field.
 *   3. Number.parseInt is caught too.
 *   4. Integer-count fields (uniqueLeads, registrants, ...) using parseInt are
 *      NOT flagged.
 *   5. Segment matching is whole-segment: "messagesCount" does not trip via
 *      the "age" substring inside "messages".
 *   6. A missing guarded target file is an error (the guard can't silently
 *      pass because the editor moved).
 *   7. Task #2762: `safeNumber(..., { allowDecimal: false })` on a
 *      decimal-capable field (the averageCaseValue / noShowRate case) is
 *      flagged, while the same option on an integer-count field is allowed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLint,
  isDecimalCapableFieldName,
  splitIdentifier,
} from "../scripts/lint-report-editor-decimal-parseint";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function fixtureFile(lines: string[]): { file: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-report-decimal-"));
  const file = join(root, "ReportFormFixture.tsx");
  writeFileSync(file, lines.join("\n") + "\n");
  return { file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 1. The REAL report editor passes the guard.
{
  const res = runLint();
  if (!res.ok) for (const e of res.errors) console.error(`    error: ${e}`);
  assert(res.ok, "real ReportForm.tsx passes the decimal-parseInt guard");
  assert(res.filesScanned === 1, "the guarded editor file was scanned");
  assert(
    res.parseIntAssignments > 0,
    "the scan actually saw parseInt assignments (integer counts exist)",
  );
}

// 2. A decimal-capable field bound to parseInt is flagged with file/line/field.
{
  const { file, cleanup } = fixtureFile([
    "onChange={e => setData(prev => ({",
    "  ...prev,",
    "  adSpend: parseInt(e.target.value) || 0,", // line 3 — the original bug
    "}))}",
    "onChange={e => setData(prev => ({ ...prev, avgTimeToAnswer: parseInt(e.target.value) || 0 }))}", // line 5
  ]);
  try {
    const res = runLint({ targetFiles: [file] });
    assert(!res.ok, "adSpend/avgTimeToAnswer bound to parseInt trips the guard");
    assert(res.violations.length === 2, "both decimal fields are flagged");
    assert(
      res.errors.some(
        (e) => e.includes(`${file}:3`) && e.includes('"adSpend"'),
      ),
      "the error names the file, line, and field for adSpend",
    );
    assert(
      res.errors.some((e) => e.includes('"avgTimeToAnswer"')),
      "avgTimeToAnswer (seconds, a real column) is flagged too",
    );
    assert(
      res.errors.some((e) => e.includes("safeNumber")),
      "the error tells the author to use safeNumber",
    );
  } finally {
    cleanup();
  }
}

// 3. Number.parseInt is caught too.
{
  const { file, cleanup } = fixtureFile([
    "const next = { missedCallRate: Number.parseInt(e.target.value) || 0 };",
  ]);
  try {
    const res = runLint({ targetFiles: [file] });
    assert(!res.ok, "Number.parseInt on a rate field trips the guard");
    assert(
      res.violations.some((v) => v.field === "missedCallRate"),
      "the rate field is named in the violation",
    );
  } finally {
    cleanup();
  }
}

// 4. Integer-count fields remain allowed to use parseInt.
{
  const { file, cleanup } = fixtureFile([
    "const a = { uniqueLeads: parseInt(e.target.value) || 0 };",
    "const b = { registrants: parseInt(e.target.value) || 0 };",
    "const c = { monthlyTarget: parseInt(e.target.value) || 0 };",
    "const d = { pipelineMomentumScore: parseInt(e.target.value) || 0 };",
  ]);
  try {
    const res = runLint({ targetFiles: [file] });
    if (!res.ok) for (const e of res.errors) console.error(`    error: ${e}`);
    assert(res.ok, "integer-count fields using parseInt are NOT flagged");
    assert(
      res.parseIntAssignments === 4,
      "all four integer assignments were checked, none flagged",
    );
  } finally {
    cleanup();
  }
}

// 5. Whole-segment matching: no substring false positives.
{
  assert(
    !isDecimalCapableFieldName("messagesCount"),
    '"messagesCount" is not decimal-capable ("messages" must not match "age")',
  );
  assert(
    !isDecimalCapableFieldName("pageViews"),
    '"pageViews" is not decimal-capable ("page" must not match "age")',
  );
  assert(
    isDecimalCapableFieldName("averageCaseValue"),
    '"averageCaseValue" is decimal-capable (average + value)',
  );
  assert(
    isDecimalCapableFieldName("dealTouchDensity"),
    '"dealTouchDensity" is decimal-capable (density)',
  );
  assert(
    isDecimalCapableFieldName("avgAgeOpenMatters"),
    '"avgAgeOpenMatters" is decimal-capable (avg + age as whole segments)',
  );
  const segs = splitIdentifier("avgTimeToAnswer");
  assert(
    segs.join(",") === "avg,time,to,answer",
    "camelCase identifiers split into lowercase whole segments",
  );
}

// 7. safeNumber with allowDecimal: false on a decimal-capable field is flagged.
{
  const { file, cleanup } = fixtureFile([
    "onChange={e => setSalesData(prev => ({ ...prev, averageCaseValue: safeNumber(e.target.value, { allowDecimal: false }) }))}", // line 1 — the Task #2762 bug
    "onChange={e => setSalesData(prev => ({ ...prev, noShowRate: safeNumber(e.target.value, { max: 100, allowDecimal: false }) }))}", // line 2
    "onChange={e => setIntakeData(prev => ({ ...prev, totalConsults: safeNumber(e.target.value, { allowDecimal: false }) }))}", // integer count — allowed
    "onChange={e => setSalesData(prev => ({ ...prev, avgFollowUps: safeNumber(e.target.value) }))}", // decimals allowed — fine
  ]);
  try {
    const res = runLint({ targetFiles: [file] });
    assert(!res.ok, "allowDecimal: false on decimal-capable fields trips the guard");
    assert(
      res.violations.length === 2,
      "exactly the two decimal fields are flagged (integer count + decimal-allowed pass)",
    );
    assert(
      res.errors.some(
        (e) => e.includes(`${file}:1`) && e.includes('"averageCaseValue"'),
      ),
      "the error names the file, line, and field for averageCaseValue",
    );
    assert(
      res.errors.some(
        (e) => e.includes('"noShowRate"') && e.includes("allowDecimal: false"),
      ),
      "noShowRate is flagged and the error names allowDecimal: false as the cause",
    );
  } finally {
    cleanup();
  }
}

// 6. A missing guarded file is an error, not a silent pass.
{
  const res = runLint({ targetFiles: ["client/src/pages/DoesNotExist.tsx"] });
  assert(!res.ok, "a missing guarded target file fails the lint");
  assert(
    res.errors.some((e) => e.includes("not found")),
    "the missing-file error tells the author to update TARGET_FILES",
  );
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
