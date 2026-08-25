/* test-registration
{
  "name": "Lint calendar preview probe purpose (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2403 — Regression test for the calendar-preview probe-purpose
 * CALL-SITE guard.
 *
 * Proves:
 *   1. The real source passes (the three preview routes tag a non-authoritative
 *      `calendarRefreshPurpose`; the two saga write-path re-checks omit it).
 *   2. A preview call that drops `calendarRefreshPurpose` is flagged.
 *   3. A preview call tagged with an AUTHORITATIVE purpose is flagged.
 *   4. A preview call with a dynamic (non-literal) purpose is flagged.
 *   5. Too few preview calls (a route silently removed) is flagged.
 *   6. A write call that tags itself NON-authoritative is flagged.
 *   7. A write call that omits the option passes; an authoritative literal passes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-calendar-preview-probe-purpose";

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

function fixtureFile(contents: string): { file: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-cal-preview-"));
  const file = join(root, "src.ts");
  writeFileSync(file, contents);
  return { file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 1. Real source passes.
{
  const res = runLint();
  if (!res.ok) {
    for (const v of res.violations) console.error(`    ${v.file}: ${v.reason}`);
  }
  assert(res.ok, "real source passes the lint");
}

// 2. Preview call dropping the purpose is flagged.
{
  const { file, cleanup } = fixtureFile(
    [
      "const a = await computeAvailableSlots(page, { fromUtc, toUtc });",
      "const b = await computeAvailableSlots(page, { fromUtc, toUtc, calendarRefreshPurpose: 'probe' });",
    ].join("\n") + "\n",
  );
  try {
    const res = runLint({
      previewSpecs: [{ file, fn: "computeAvailableSlots", minCalls: 1 }],
      writeSpecs: [],
    });
    assert(!res.ok, "preview call missing the purpose trips the lint");
    assert(
      res.violations.some((v) => /does not pass calendarRefreshPurpose/.test(v.reason)),
      "reports the dropped purpose",
    );
  } finally {
    cleanup();
  }
}

// 3. Preview call with an AUTHORITATIVE purpose is flagged.
{
  const { file, cleanup } = fixtureFile(
    "const a = await computeAvailableSlots(page, { calendarRefreshPurpose: 'expiry' });\n",
  );
  try {
    const res = runLint({
      previewSpecs: [{ file, fn: "computeAvailableSlots", minCalls: 1 }],
      writeSpecs: [],
    });
    assert(!res.ok, "authoritative preview purpose trips the lint");
    assert(
      res.violations.some((v) => /classifies AUTHORITATIVE/.test(v.reason)),
      "reports the authoritative preview purpose",
    );
  } finally {
    cleanup();
  }
}

// 4. Preview call with a dynamic (non-literal) purpose is flagged.
{
  const { file, cleanup } = fixtureFile(
    "const a = await computeAvailableSlots(page, { calendarRefreshPurpose: somePurpose });\n",
  );
  try {
    const res = runLint({
      previewSpecs: [{ file, fn: "computeAvailableSlots", minCalls: 1 }],
      writeSpecs: [],
    });
    assert(!res.ok, "dynamic preview purpose trips the lint");
    assert(
      res.violations.some((v) => /non-literal calendarRefreshPurpose/.test(v.reason)),
      "reports the non-literal preview purpose",
    );
  } finally {
    cleanup();
  }
}

// 5. Too few preview calls (a route silently removed) is flagged.
{
  const { file, cleanup } = fixtureFile(
    "const a = await computeAvailableSlots(page, { calendarRefreshPurpose: 'probe' });\n",
  );
  try {
    const res = runLint({
      previewSpecs: [{ file, fn: "computeAvailableSlots", minCalls: 3 }],
      writeSpecs: [],
    });
    assert(!res.ok, "missing preview call sites trips the lint");
    assert(
      res.violations.some((v) => /expected at least 3/.test(v.reason)),
      "reports the missing preview call sites",
    );
  } finally {
    cleanup();
  }
}

// 6. Write call tagged NON-authoritative is flagged.
{
  const { file, cleanup } = fixtureFile(
    [
      "const a = await isSlotAvailable(page, startUtc, { calendarRefreshPurpose: 'probe' });",
      "const b = await isSlotAvailable(page, startUtc, { calendarRefreshPurpose: 'probe' });",
    ].join("\n") + "\n",
  );
  try {
    const res = runLint({
      previewSpecs: [],
      writeSpecs: [{ file, fn: "isSlotAvailable", minCalls: 2 }],
    });
    assert(!res.ok, "non-authoritative write purpose trips the lint");
    assert(
      res.violations.some((v) => /NON-authoritative/.test(v.reason)),
      "reports the non-authoritative write purpose",
    );
  } finally {
    cleanup();
  }
}

// 7. Write call omitting the option passes; an authoritative literal passes.
{
  const { file, cleanup } = fixtureFile(
    [
      "const a = await isSlotAvailable(page, startUtc, { skipCalendar: true });",
      "const b = await isSlotAvailable(page, startUtc, { calendarRefreshPurpose: 'expiry' });",
    ].join("\n") + "\n",
  );
  try {
    const res = runLint({
      previewSpecs: [],
      writeSpecs: [{ file, fn: "isSlotAvailable", minCalls: 2 }],
    });
    assert(res.ok, "omitted / authoritative write purpose passes");
  } finally {
    cleanup();
  }
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
