/* test-registration
{
  "name": "lint-test-file-parseability guard",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the Task #3826 parseability gate lint: four smoke suites once landed committed but UNPARSEABLE (merge-lost section openers, const-reassignment bundle-mode errors tsx only warns about) and failed every run for days as vague pre-existing failures while degrading related selection to the full set. Fast, DB-free, deterministic (tolerant-tracer scan of real registry + tmpdir fixture trees). lint-*.test.ts name keeps it in the always-run core.",
  "tier": "small"
}
test-registration */
/**
 * Guard test for scripts/lint-test-file-parseability.ts.
 *
 * Proves:
 *   1. The REAL repository's registered test files all parse cleanly (the
 *      actual gate assertion — a committed broken test file fails here AND
 *      in the gate lint phase).
 *   2. Positive control — syntax error: a fixture registered test file with
 *      a stray `}` (the Task #3787 merge-damage class) is flagged with the
 *      file path and an esbuild error message.
 *   3. Positive control — bundle-mode semantic error: a const-reassignment
 *      (tsx only warns; esbuild bundle mode hard-errors) is flagged.
 *   4. A healthy fixture file alongside a broken one is NOT flagged, and
 *      unresolvable imports alone are NOT violations (loader-shim suites
 *      import modules their runtime shims replace).
 *   5. extraNodeArgs setup files are traced as entries: a broken setup .ts
 *      referenced only via `--import` is flagged.
 *   6. Wiring lockstep: gate.ts LINT_CHECKS registers the lint and the drift
 *      guard defines `LONG_VALIDATION_WORKFLOW` with the exact managed Long validation command.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runParseabilityLint, formatResult } from "../scripts/lint-test-file-parseability";

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

function reg(name: string, extra: string = ""): string {
  return `/* test-registration\n{\n  "name": "${name}",\n  "tier": "medium"${extra}\n}\ntest-registration */\n`;
}

async function main(): Promise<void> {
  // 1. Real repository is clean.
  {
    const res = await runParseabilityLint();
    assert(res.ok, `REAL repo: all ${res.entryCount} registered test entries parse cleanly${res.ok ? "" : `\n${formatResult(res)}`}`);
    assert(res.entryCount > 500, `REAL repo: traced a plausible entry count (${res.entryCount} > 500)`);
  }

  // Fixture tree.
  const root = mkdtempSync(join(tmpdir(), "parseability-lint-"));
  try {
    mkdirSync(join(root, "tests"), { recursive: true });

    // Healthy suite with an unresolvable import (shim-replaced module).
    writeFileSync(
      join(root, "tests/healthy.test.ts"),
      reg("healthy") + `import { thing } from "./no-such-shimmed-module";\nconsole.log(thing);\n`,
    );
    // Syntax-broken suite (merge-damage class).
    writeFileSync(
      join(root, "tests/broken-syntax.test.ts"),
      reg("broken syntax") + `const a = 1;\n}\nconsole.log(a);\n`,
    );
    // Const-reassignment suite (bundle-mode semantic error).
    writeFileSync(
      join(root, "tests/broken-const.test.ts"),
      reg("broken const") + `const x = 1;\nx = 2;\nconsole.log(x);\n`,
    );
    // Suite whose registered setup file is broken.
    writeFileSync(join(root, "tests/setup-broken.mjs"), `let y = ;\n`);
    writeFileSync(
      join(root, "tests/uses-setup.test.ts"),
      reg("uses setup", `,\n  "extraNodeArgs": ["--import", "tests/setup-broken.mjs"]`) + `console.log("ok");\n`,
    );

    const res = await runParseabilityLint(root);
    assert(!res.ok, "fixture: overall verdict is FAIL");
    const files = res.violations.map((v) => v.file);
    assert(files.includes("tests/broken-syntax.test.ts"), "fixture: syntax-broken test file flagged");
    assert(files.includes("tests/broken-const.test.ts"), "fixture: const-reassignment test file flagged");
    assert(files.includes("tests/setup-broken.mjs"), "fixture: broken extraNodeArgs setup file flagged");
    assert(!files.includes("tests/healthy.test.ts"), "fixture: healthy suite with only an unresolvable import NOT flagged");
    const constViolation = res.violations.find((v) => v.file === "tests/broken-const.test.ts");
    assert(
      constViolation !== undefined && constViolation.errors.some((e) => /constant/i.test(e)),
      "fixture: const-reassignment violation carries the esbuild error text",
    );
    const text = formatResult(res);
    assert(
      text.includes("tests/broken-syntax.test.ts") && text.includes("FAIL"),
      "fixture: formatted output names the broken file",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 6. Wiring lockstep.
  {
    const gate = readFileSync("scripts/gate.ts", "utf8");
    assert(
      gate.includes(`{ name: "lint-test-file-parseability", script: "scripts/lint-test-file-parseability.ts" }`),
      "wiring: gate.ts LINT_CHECKS registers the lint",
    );
    const drift = readFileSync("scripts/lint-gate-workflow-drift.ts", "utf8");
    assert(
      /export const LONG_VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run validate:long -- --request \.local\/runs\/long-validation-request\.json"/.test(drift),
      "wiring: lint-gate-workflow-drift defines LONG_VALIDATION_WORKFLOW with the exact managed Long validation command",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
