/* test-registration
{
  "name": "lint-getdb-attribution callsite guard (Task #1724 Phase 4.1)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
// Task #1724 Phase 4.1 — Regression test for the AST-level
// per-callsite lint guard. Proves the cases the reviewer of Task
// #1724 flagged:
//
//   1. A brand-new file with `getDb()` outside any wrap callback is
//      flagged.
//   2. A brand-new file that *imports* `withDbAttribution` but does
//      not actually wrap its `getDb()` call is STILL flagged. (This
//      is the mixed-attribution case: token presence in the file is
//      not enough — the call site must be lexically inside the wrap
//      callback.)
//   3. A brand-new file with two `getDb()` calls, one inside a wrap
//      callback and one outside, is flagged with `unattributed: 1`.
//   4. A baselined file that gains a new unattributed `getDb()` is
//      flagged via count regression.
//   5. A clean tree (everything attributed or at/under baseline)
//      reports `ok: true`.
//   6. A stale baseline entry (no `getDb()` in the file anymore) is
//      surfaced.
//
// Usage: tsx tests/lint-getdb-attribution.test.ts

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLint,
  analyzeFile,
} from "../scripts/lint-getdb-attribution";

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

function setupFixture(): {
  root: string;
  baselinePath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lint-getdb-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const baselinePath = join(root, "baseline.txt");
  return {
    root,
    baselinePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

console.log("\n[lint-getdb-attribution] regression suite (AST-level)");

// ─── Case 1: brand-new unattributed caller ──────────────────────────
{
  const { root, baselinePath, cleanup } = setupFixture();
  try {
    writeFileSync(
      join(root, "src", "new.ts"),
      `import { getDb } from "./db";\nexport function q() { return getDb().select(); }\n`,
    );
    writeFileSync(baselinePath, "# empty baseline\n");
    const result = runLint({ roots: [root], baselinePath });
    assert(!result.ok, "case 1: lint reports not-ok");
    const offender = result.newOffenders.find((o) => o.file.endsWith("new.ts"));
    assert(offender?.unattributed === 1, "case 1: 1 unattributed call site reported");
  } finally {
    cleanup();
  }
}

// ─── Case 2: helper imported but not wrapping the call ──────────────
{
  const { root, baselinePath, cleanup } = setupFixture();
  try {
    const filePath = join(root, "src", "imports_only.ts");
    writeFileSync(
      filePath,
      [
        // Helper is imported (mere token presence — what the previous
        // file-level regex would have accepted as "attributed") but is
        // never actually called around getDb().
        `import { getDb, withDbAttribution } from "./db";`,
        `void withDbAttribution;`,
        `export async function q() {`,
        `  return getDb().select();`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(baselinePath, "# empty baseline\n");
    const result = runLint({ roots: [root], baselinePath });
    assert(
      !result.ok,
      "case 2: lint reports not-ok even when helper is imported",
    );
    const offender = result.newOffenders.find((o) =>
      o.file.endsWith("imports_only.ts"),
    );
    assert(
      offender?.unattributed === 1,
      "case 2: 1 unattributed call site reported despite import",
    );
  } finally {
    cleanup();
  }
}

// ─── Case 3: mixed attributed + unattributed in same file ───────────
{
  const { root, baselinePath, cleanup } = setupFixture();
  try {
    const filePath = join(root, "src", "mixed.ts");
    writeFileSync(
      filePath,
      [
        `import { getDb, withDbAttribution } from "./db";`,
        `export async function attributed() {`,
        `  return withDbAttribution("foo:a", async () => {`,
        `    return getDb().select();`,
        `  });`,
        `}`,
        `export async function leaked() {`,
        `  // Forgot the wrap — this is the regression class.`,
        `  return getDb().select();`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeFileSync(baselinePath, "# empty baseline\n");
    // Sanity check the analyzer itself before the lint result.
    const counts = analyzeFile(filePath, readFileSync(filePath, "utf8"));
    assert(counts.total === 2, "case 3: analyzer counts 2 total call sites");
    assert(
      counts.unattributed === 1,
      "case 3: analyzer flags exactly 1 unattributed (the leaked one)",
    );
    const result = runLint({ roots: [root], baselinePath });
    assert(
      !result.ok,
      "case 3: lint reports not-ok for mixed attribution",
    );
    const offender = result.newOffenders.find((o) => o.file.endsWith("mixed.ts"));
    assert(
      offender?.unattributed === 1,
      "case 3: only the unwrapped call is reported (not both)",
    );
  } finally {
    cleanup();
  }
}

// ─── Case 4: count regression inside baselined file ─────────────────
{
  const { root, baselinePath, cleanup } = setupFixture();
  try {
    const filePath = join(root, "src", "grandfathered.ts");
    writeFileSync(
      filePath,
      [
        `import { getDb, withDbAttribution } from "./db";`,
        `export async function a() {`,
        `  return withDbAttribution("foo:a", () => getDb().select());`,
        `}`,
        `export async function b() { return getDb().select(); }`,
        `export async function c() { return getDb().select(); }`,
        `export async function d() { return getDb().select(); }`,
        ``,
      ].join("\n"),
    );
    // Baseline allows 2 unattributed; file now has 3 unattributed.
    writeFileSync(baselinePath, `${filePath} 2\n`);
    const result = runLint({ roots: [root], baselinePath });
    assert(!result.ok, "case 4: lint reports not-ok when count is exceeded");
    const regression = result.countRegressions.find((r) =>
      r.file.endsWith("grandfathered.ts"),
    );
    assert(!!regression, "case 4: count regression entry present");
    assert(
      regression?.baselined === 2 && regression?.actual === 3,
      "case 4: regression shows baselined=2 actual=3",
    );
  } finally {
    cleanup();
  }
}

// ─── Case 5: clean tree ─────────────────────────────────────────────
{
  const { root, baselinePath, cleanup } = setupFixture();
  try {
    const attributed = join(root, "src", "attributed.ts");
    writeFileSync(
      attributed,
      [
        `import { getDb, withDbAttribution } from "./db";`,
        `export async function a() {`,
        `  return withDbAttribution("foo:a", () => getDb().select());`,
        `}`,
        ``,
      ].join("\n"),
    );
    const baselined = join(root, "src", "baselined.ts");
    writeFileSync(
      baselined,
      [
        `import { getDb } from "./db";`,
        `export async function a() { return getDb().select(); }`,
        `export async function b() { return getDb().select(); }`,
        ``,
      ].join("\n"),
    );
    writeFileSync(baselinePath, `${baselined} 2\n`);
    const result = runLint({ roots: [root], baselinePath });
    assert(result.ok, "case 5: lint reports ok for clean tree");
    assert(
      result.newOffenders.length === 0 &&
        result.countRegressions.length === 0 &&
        result.staleBaseline.length === 0,
      "case 5: no offenders / regressions / stale entries",
    );
  } finally {
    cleanup();
  }
}

// ─── Case 6: stale baseline entry ───────────────────────────────────
{
  const { root, baselinePath, cleanup } = setupFixture();
  try {
    writeFileSync(baselinePath, `${join(root, "src", "gone.ts")} 5\n`);
    const result = runLint({ roots: [root], baselinePath });
    assert(!result.ok, "case 6: lint reports not-ok for stale baseline");
    assert(
      result.staleBaseline.some((f) => f.endsWith("gone.ts")),
      "case 6: stale entry surfaced",
    );
  } finally {
    cleanup();
  }
}

console.log(`\n[lint-getdb-attribution] passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
process.exit(0);
