/**
 * Task #3306 (reworked by Task #3786) — every test file must carry a valid
 * `/* test-registration` block.
 *
 * Background: Task #3298 discovered two test files that existed on disk but
 * were never registered in the (then hand-maintained) TESTS array of
 * tests/run-all.ts — so they ran NOWHERE, and both were actually broken when
 * finally run. Task #3786 then removed the central array entirely: the
 * runner now DISCOVERS every `*.test.ts(x)` file under `tests/` and
 * `client/src/` and derives its registry from the registration block each
 * test carries at the top of its own file (see tests/testRegistry.ts for the
 * format). That kills both failure modes at once:
 *
 *   - a test file cannot exist without a registration (this lint fails), and
 *   - registering a test no longer edits any shared file, so concurrent
 *     test-adding tasks cannot merge-conflict in a central registry.
 *
 * What this lint enforces (STRUCTURAL validity):
 *   1. Every discovered `*.test.ts` / `*.test.tsx` file starts with a
 *      parseable registration block (`/* test-registration` on line 1, a
 *      JSON object, then the end-marker line).
 *   2. The block's fields typecheck (non-empty `name`, boolean flags,
 *      positive-integer `timeoutMs`, string-array `extraNodeArgs`,
 *      string-map `extraEnv`, no unknown keys).
 *
 * The SEMANTIC smoke-vs-sweep gate decision (a regression test must either
 * be gated or record a sweepOnlyReason) is the complementary guard in
 * scripts/lint-smoke-gate-regression.ts.
 *
 * There is no baseline/grandfather file anymore: the Task #3786 conversion
 * stamped a block onto every existing test file, so the invariant holds
 * universally. The runner itself also refuses to start with an invalid
 * registration (it must never silently shrink the suite), which makes this
 * lint the fast, focused version of that same failure.
 *
 * Helpers, fixtures, loaders, and setup files are out of scope by pattern:
 * only `*.test.ts` / `*.test.tsx` files are scanned.
 *
 * Exit codes:
 *   0 — every discovered test file carries a valid registration block.
 *   1 — at least one file is missing a block or has an invalid one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TEST_ROOTS,
  discoverTestFiles,
  parseRegistration,
} from "../tests/testRegistry";

export interface LintOptions {
  /** Roots to scan (default: tests/ and client/src/). */
  rootDirs?: string[];
  /** Repo root the rootDirs are relative to (default: cwd). */
  repoRoot?: string;
}

export interface Offender {
  file: string;
  message: string;
}

export interface LintResult {
  ok: boolean;
  /** Total on-disk *.test.ts(x) files scanned. */
  onDiskCount: number;
  /** Files whose registration block parsed and validated. */
  validCount: number;
  /** Files with a missing or invalid registration block. */
  offenders: Offender[];
}

export function runLint(options: LintOptions = {}): LintResult {
  const repoRoot = options.repoRoot ?? process.cwd();
  const rootDirs = options.rootDirs ?? DEFAULT_TEST_ROOTS;
  const files = discoverTestFiles(rootDirs, repoRoot);

  const offenders: Offender[] = [];
  let validCount = 0;
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(repoRoot, file), "utf8");
    } catch (err) {
      offenders.push({
        file,
        message: `could not read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const { registration, errors } = parseRegistration(source);
    if (registration) {
      validCount++;
    } else {
      for (const message of errors) offenders.push({ file, message });
    }
  }

  return {
    ok: offenders.length === 0,
    onDiskCount: files.length,
    validCount,
    offenders,
  };
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-test-registration.ts");

if (isMain) {
  const result = runLint();

  if (result.ok) {
    console.log(
      `lint-test-registration: OK (${result.onDiskCount} test file(s) on disk, ` +
        `all carry a valid registration block).`,
    );
    process.exit(0);
  }

  console.error("");
  console.error(
    "✗ lint-test-registration: test file(s) with a missing or invalid registration block",
  );
  console.error("");
  console.error(
    "  Since Task #3786 the runner derives its registry by DISCOVERY: every",
  );
  console.error(
    "  *.test.ts(x) file under tests/ or client/src/ must start with a",
  );
  console.error(
    "  registration block, and the runner refuses to start while any block is",
  );
  console.error(
    "  invalid (a partial registry must never silently shrink the suite).",
  );
  console.error("");
  console.error("  Put this at the VERY TOP of the file (line 1):");
  console.error("");
  console.error("    /* test-registration");
  console.error("    {");
  console.error('      "name": "What this suite proves (Task #NNNN)"');
  console.error("    }");
  console.error("    test-registration " + "*/");
  console.error("");
  console.error(
    "  Optional fields: regression, smoke + smokeReason, sweepOnlyReason, tier + tierReason,",
  );
  console.error(
    "  timeoutMs, extraNodeArgs, extraEnv, notes — see the tests/testRegistry.ts",
  );
  console.error(
    "  docblock for what each means, and scripts/lint-smoke-gate-regression.ts",
  );
  console.error("  for the smoke-vs-sweep decision a regression test must record.");
  console.error("");
  console.error("  Offending file(s):");
  for (const o of result.offenders) console.error(`    - ${o.file}: ${o.message}`);
  console.error("");
  process.exit(1);
}
