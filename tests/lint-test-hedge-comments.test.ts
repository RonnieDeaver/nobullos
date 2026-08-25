/* test-registration
{
  "name": "lint-test-hedge-comments guard (Task #1875)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1875 — Regression test for the shared-DB hedge-comment guard.
 *
 * Proves:
 *   1. A fixture tree with a known hedge phrase is flagged.
 *   2. A fixture tree with no hedge phrase passes.
 *   3. The real `tests/` tree is clean (no offenders).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-test-hedge-comments";

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

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-hedge-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// 1. Hedge phrase is flagged.
{
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(
      join(root, "nested", "bad.test.ts"),
      [
        "// Shared-DB workspace: live table can contain prod rows",
        "// the test's seeded counts are a LOWER bound, not an exact match.",
        "assert.ok(x >= 1);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "hedge phrase trips the lint");
    assert(
      res.offenders.some((o) => /Shared-DB workspace/i.test(o.text)),
      "Shared-DB workspace phrase is reported",
    );
    assert(
      res.offenders.some((o) => /LOWER bound, not an exact match/.test(o.text)),
      "LOWER bound phrase is reported",
    );
  } finally {
    cleanup();
  }
}

// 2. Clean fixture passes.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "ok.test.ts"),
      [
        "// Normal comment with no hedge phrasing.",
        "// We assert exact counts; isolation comes from runInTxSandbox.",
        "assert.equal(x, 1);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(res.ok, "clean fixture passes");
    assert.strictEqual ? null : null;
    assert(res.offenders.length === 0, "no offenders reported for clean fixture");
  } finally {
    cleanup();
  }
}

// 3. The real tests/ tree is clean.
{
  const res = runLint("tests");
  if (!res.ok) {
    for (const o of res.offenders) {
      console.error(`    ${o.file}:${o.line} > ${o.text}`);
    }
  }
  assert(res.ok, "tests/ tree contains no shared-DB hedge comments");
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
