/* test-registration
{
  "name": "lint-sweep-only-scan-path-pins — sweep-only readFileSync repo pins must appear in scanPaths (Task #4921)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4921: guards the green-skip blind spot for sweep-only suites that readFileSync-pin a repo source file without declaring it in scanPaths. Such a suite can stay permanently green-skipped while the file it audits changes, silently rotting its scan. Fast, DB-free, pure repo walk.",
  "tier": "small"
}
test-registration */
/**
 * Task #4921 — Sweep-only readFileSync source-pin guard.
 *
 * Background: a sweep-only test (regression=true, smoke!=true) is excluded from
 * the routine TEST_SMOKE gate. The green-skip fingerprint is the only mechanism
 * that forces it to re-run when its inputs change. Import tracing is invisible
 * to `readFileSync` calls — those inputs only enter the fingerprint via
 * `scanPaths` in the registration block.
 *
 * If a sweep-only suite reads a repo source file via readFileSync but omits that
 * file from its scanPaths, the fingerprint never changes when the source changes,
 * so the suite stays green-skipped indefinitely — silently stale.
 *
 * Rule: every sweep-only suite (regression=true, smoke!=true) that calls an fs
 * read API and references a repo-source path literal must declare every such path
 * in its registration "scanPaths" (exact file or ancestor directory).
 *
 * Exemptions:
 *   - Always-run core tests (tests/lint-*.test.ts) — they re-run on every gate
 *     regardless of fingerprint changes, so staleness is not possible.
 *   - Lines carrying a `// fs-scan-inputs-ignore -- <reason>` marker — the
 *     literal is intentionally not an fs target (assert-marker strings etc.).
 *     The reason must be non-empty (bare markers are violations themselves, per
 *     lint-test-fs-scan-inputs).
 *
 * This guard is narrower than lint-test-fs-scan-inputs (which covers ALL test
 * files): it focuses specifically on sweep-only suites because those have the
 * highest silent-rot risk — they never run at gate time and depend entirely on
 * the fingerprint mechanism for re-selection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { buildTestRegistry, discoverTestFiles, parseRegistration } from "./testRegistry.ts";
import {
  collectStringLiterals,
  normalizeRepoSourceLiteral,
  markerHasReason,
  maskLiteralContents,
} from "../scripts/lint-test-fs-scan-inputs.ts";
import { scanPathHit, coreReason, DEFAULT_CORE_RULES } from "./relatedSmokeSelection.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const FS_READ_RE = /\b(readFileSync|readdirSync|readFile|readdir)\s*\(/;
const IGNORE_MARKER = "fs-scan-inputs-ignore";

// ---------------------------------------------------------------------------
// Core logic — exported for testability
// ---------------------------------------------------------------------------

export interface ScanPinViolation {
  file: string;
  message: string;
}

export interface LintResult {
  ok: boolean;
  violations: ScanPinViolation[];
  /** Number of sweep-only fs-reading suites actually checked. */
  checked: number;
}

/**
 * Run the sweep-only scan-pin guard over the given repo root.
 *
 * Only sweep-only suites (regression=true AND smoke!=true) that call an fs
 * read API are checked; non-regression, smoke-gated, and always-run core
 * tests are skipped.
 */
export function runLint(repoRoot: string = REPO_ROOT): LintResult {
  const violations: ScanPinViolation[] = [];
  const registry = buildTestRegistry({ repoRoot });
  let checked = 0;

  for (const [file, reg] of registry.registrations) {
    // Target: sweep-only suites only (regression=true, smoke!=true).
    if (reg.regression !== true || reg.smoke === true) continue;
    // Always-run core tests re-execute on every gate run; fingerprint staleness
    // is not a risk for them.
    if (coreReason(file, DEFAULT_CORE_RULES)) continue;

    const source = readFileSync(resolve(repoRoot, file), "utf8");
    if (!FS_READ_RE.test(source)) continue;
    checked++;

    const maskedLines = maskLiteralContents(source).split("\n");
    const literals = collectStringLiterals(source);
    const scanPaths = reg.scanPaths;

    const uncovered: Array<{ path: string; line: number }> = [];
    for (const lit of literals) {
      const norm = normalizeRepoSourceLiteral(lit.value, file);
      if (!norm) continue;
      // Honor the per-line ignore marker (must have a reason to suppress).
      const litLine = maskedLines[lit.line - 1] ?? "";
      if (markerHasReason(litLine, IGNORE_MARKER)) continue;
      if (!scanPathHit(norm, scanPaths)) {
        uncovered.push({ path: norm, line: lit.line });
      }
    }

    if (uncovered.length > 0) {
      const list = uncovered.map(({ path, line }) => `${path} (line ${line})`).join(", ");
      violations.push({
        file,
        message:
          `sweep-only suite readFileSync-pins repo source not declared in registration "scanPaths": ${list}. ` +
          `This suite is not smoke-gated, so the green-skip fingerprint is the only mechanism that forces ` +
          `re-execution when these files change. Fix: add them to "scanPaths" in the registration block ` +
          `(exact file or ancestor directory), or append "// ${IGNORE_MARKER} -- <reason>" to a line that ` +
          `holds a repo-source-looking string that is genuinely not an fs target.`,
      });
    }
  }

  return { ok: violations.length === 0, violations, checked };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "sweep-only-pin-fixture-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "server/subject.ts"), "export const S = 1;\n");
  return root;
}

function writeTest(
  root: string,
  rel: string,
  reg: Record<string, unknown>,
  body: string,
): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    `/* test-registration\n${JSON.stringify({ tier: "medium", ...reg }, null, 2)}\ntest-registration */\n${body}`,
  );
}

const FS_BODY = (lit: string): string =>
  `import { readFileSync } from "node:fs";\nconst src = readFileSync(${JSON.stringify(lit)}, "utf8");\nconsole.log(src.length);\n`;

// ---------------------------------------------------------------------------
// Unit tests — fixture trees
// ---------------------------------------------------------------------------

test("sweep-only suite with uncovered readFileSync repo pin is a violation (negative EXECUTES)", () => {
  const root = makeRepo();
  try {
    writeTest(
      root,
      "tests/sweep.test.ts",
      { name: "s", regression: true, sweepOnlyReason: "DB-heavy" },
      FS_BODY("server/subject.ts"),
    );
    const { ok, violations, checked } = runLint(root);
    assert.equal(ok, false, "missing scanPath for repo pin must be a violation");
    assert.equal(checked, 1);
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /server\/subject\.ts/);
    assert.match(violations[0].message, /scanPaths/);
    assert.match(violations[0].message, /sweep-only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweep-only suite with pin covered by exact scanPath is clean", () => {
  const root = makeRepo();
  try {
    writeTest(
      root,
      "tests/sweep.test.ts",
      { name: "s", regression: true, sweepOnlyReason: "DB-heavy", scanPaths: ["server/subject.ts"] },
      FS_BODY("server/subject.ts"),
    );
    const { ok, violations } = runLint(root);
    assert.equal(ok, true, JSON.stringify(violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweep-only suite with pin covered by ancestor directory scanPath is clean", () => {
  const root = makeRepo();
  try {
    writeTest(
      root,
      "tests/sweep.test.ts",
      { name: "s", regression: true, sweepOnlyReason: "DB-heavy", scanPaths: ["server"] },
      FS_BODY("server/subject.ts"),
    );
    const { ok, violations } = runLint(root);
    assert.equal(ok, true, JSON.stringify(violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke-gated suite with uncovered readFileSync pin is NOT flagged (out of scope)", () => {
  const root = makeRepo();
  try {
    writeTest(
      root,
      "tests/smoke.test.ts",
      { name: "s", regression: true, smoke: true, smokeReason: "fast pure logic" },
      FS_BODY("server/subject.ts"),
    );
    const { ok, violations, checked } = runLint(root);
    // Smoke-gated suites are out of scope for this guard (lint-test-fs-scan-inputs
    // handles them in the general path).
    assert.equal(ok, true, JSON.stringify(violations));
    assert.equal(checked, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-regression suite with readFileSync pin is NOT flagged", () => {
  const root = makeRepo();
  try {
    writeTest(
      root,
      "tests/plain.test.ts",
      { name: "p" },
      FS_BODY("server/subject.ts"),
    );
    const { ok, violations, checked } = runLint(root);
    assert.equal(ok, true, JSON.stringify(violations));
    assert.equal(checked, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core (lint-*) sweep-only suite with uncovered pin is NOT flagged", () => {
  const root = makeRepo();
  try {
    // lint-*.test.ts names are always-run core — fingerprint staleness is not a risk.
    writeTest(
      root,
      "tests/lint-something.test.ts",
      { name: "core", regression: true, sweepOnlyReason: "scans whole repo, DB-free" },
      FS_BODY("server/subject.ts"),
    );
    const { ok, violations, checked } = runLint(root);
    assert.equal(ok, true, JSON.stringify(violations));
    assert.equal(checked, 0, "core suites are always-run and must not be counted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fs-scan-inputs-ignore marker with reason suppresses a literal", () => {
  const root = makeRepo();
  try {
    const body =
      `import { readFileSync } from "node:fs";\n` +
      `const marker = "server/subject.ts"; // fs-scan-inputs-ignore -- assert-marker string, not an fs target\n` +
      `console.log(marker);\n`;
    writeTest(
      root,
      "tests/sweep.test.ts",
      { name: "s", regression: true, sweepOnlyReason: "DB-heavy" },
      body,
    );
    const { ok, violations } = runLint(root);
    assert.equal(ok, true, JSON.stringify(violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare fs-scan-inputs-ignore marker (no reason) does NOT suppress the literal", () => {
  // A bare marker is itself a violation of lint-test-fs-scan-inputs (no reason
  // written). For this guard, we treat an improperly-reasoned marker the same
  // as no marker at all — the literal remains uncovered.
  const root = makeRepo();
  try {
    const body =
      `import { readFileSync } from "node:fs";\n` +
      `const src = readFileSync("server/subject.ts", "utf8"); // fs-scan-inputs-ignore\n` +
      `console.log(src);\n`;
    writeTest(
      root,
      "tests/sweep.test.ts",
      { name: "s", regression: true, sweepOnlyReason: "DB-heavy" },
      body,
    );
    const { ok, violations } = runLint(root);
    assert.equal(ok, false, "bare marker must not suppress the literal");
    assert.match(violations[0].message, /server\/subject\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-repo-source literals (fixtures, tmp, node_modules) are not flagged", () => {
  const root = makeRepo();
  try {
    mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
    writeFileSync(join(root, "tests/fixtures/data.json"), "{}");
    const body =
      `import { readFileSync } from "node:fs";\n` +
      `const d = readFileSync("tests/fixtures/data.json", "utf8");\n` +
      `console.log(d);\n`;
    writeTest(
      root,
      "tests/sweep.test.ts",
      { name: "s", regression: true, sweepOnlyReason: "DB-heavy" },
      body,
    );
    const { ok, violations } = runLint(root);
    // tests/ paths are not repo-source (normalizeRepoSourceLiteral returns null for them)
    assert.equal(ok, true, JSON.stringify(violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relative ../ literals resolve to repo-source and are flagged without scanPaths", () => {
  const root = makeRepo();
  try {
    writeTest(
      root,
      "tests/sweep.test.ts",
      { name: "s", regression: true, sweepOnlyReason: "DB-heavy" },
      FS_BODY("../server/subject.ts"),
    );
    const { ok, violations } = runLint(root);
    assert.equal(ok, false, "../-relative repo-source pin must be caught");
    assert.match(violations[0].message, /server\/subject\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple uncovered pins all appear in one violation message", () => {
  const root = makeRepo();
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/tool.ts"), "// tool\n");
    const body =
      `import { readFileSync } from "node:fs";\n` +
      `const a = readFileSync("server/subject.ts", "utf8");\n` +
      `const b = readFileSync("scripts/tool.ts", "utf8");\n` +
      `console.log(a, b);\n`;
    writeTest(
      root,
      "tests/sweep.test.ts",
      { name: "s", regression: true, sweepOnlyReason: "DB-heavy" },
      body,
    );
    const { ok, violations } = runLint(root);
    assert.equal(ok, false);
    assert.equal(violations.length, 1, "all uncovered pins reported in one violation");
    assert.match(violations[0].message, /server\/subject\.ts/);
    assert.match(violations[0].message, /scripts\/tool\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("covering only some pins still flags the uncovered ones", () => {
  const root = makeRepo();
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/tool.ts"), "// tool\n");
    const body =
      `import { readFileSync } from "node:fs";\n` +
      `const a = readFileSync("server/subject.ts", "utf8");\n` +
      `const b = readFileSync("scripts/tool.ts", "utf8");\n` +
      `console.log(a, b);\n`;
    writeTest(
      root,
      "tests/sweep.test.ts",
      {
        name: "s",
        regression: true,
        sweepOnlyReason: "DB-heavy",
        // Only covers server/; scripts/ is NOT covered.
        scanPaths: ["server/subject.ts"],
      },
      body,
    );
    const { ok, violations } = runLint(root);
    assert.equal(ok, false);
    assert.match(violations[0].message, /scripts\/tool\.ts/);
    assert.ok(!violations[0].message.includes("server/subject.ts"), "covered pin must not appear");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Live-repo invariant: the shipped guard passes against HEAD
// ---------------------------------------------------------------------------

test("the real repository passes the sweep-only scan-pin guard", () => {
  const { ok, violations, checked } = runLint();
  assert.equal(
    ok,
    true,
    violations.map((v) => `${v.file}: ${v.message}`).join("\n"),
  );
  // Sanity: we must have checked at least a few sweep-only fs-reading suites.
  // If this drops to 0 the guard is probably scanning nothing (registration drift).
  assert.ok(
    checked >= 1,
    `expected at least 1 sweep-only fs-reading suite to be checked, got ${checked} — ` +
      `if all sweep-only suites have been migrated to smoke-gated, this assertion can be removed`,
  );
});
