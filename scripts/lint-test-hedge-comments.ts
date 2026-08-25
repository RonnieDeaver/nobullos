/**
 * Task #1875 — Guardrail against shared-DB hedge comments in tests/.
 *
 * Background: tests that share a live Postgres database with the running
 * dev app + workers historically resorted to hedged assertions (e.g.
 * `toBeGreaterThanOrEqual(1)` instead of `.equal(1)`) and explanatory
 * comments such as:
 *
 *     // Shared-DB workspace: the live table can contain prod rows …
 *     //                 the test's seeded counts are a LOWER bound, …
 *
 * Those hedges hide flakes. Once we have the per-test isolation
 * primitives in `tests/db-sandbox.ts` (`runInTxSandbox` /
 * `runInIsolatedSchema`), there is no excuse for new hedges — pick the
 * right primitive instead.
 *
 * This lint scans `tests/**\/*.{ts,tsx}` (excluding fixtures and the
 * lint scripts themselves) and fails when any of the hedge phrases
 * below appear. The set is intentionally narrow: the goal is to catch
 * the specific anti-pattern, not to ban every use of the word
 * "shared" / "lower bound".
 *
 * Exit code:
 *   0 — no hedge comments found.
 *   1 — at least one offender.
 */

import { readFileSync } from "node:fs";
import {
  isScannablePath,
  listTrackedFiles,
  walkDir,
} from "./lintFileDiscovery";

const TEST_ROOT = "tests";
const SELF = "lint-test-hedge-comments";

// Repo-wide scope (Task #2846): the default scan discovers test files from
// `git ls-files` — every tracked .ts/.tsx under tests/ PLUS any tracked
// `*.test.ts(x)` anywhere else in the repo — instead of walking the fixed
// `tests/` root. If a test tree ever grows outside tests/ (e.g. co-located
// client tests), it is in scope automatically.
function isHedgeScannable(file: string): boolean {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return false;
  const base = file.split("/").pop() ?? file;
  if (base.includes(SELF)) return false;
  return file.startsWith(`${TEST_ROOT}/`) || /\.test\.tsx?$/.test(base);
}

// Patterns that flag the shared-DB hedge anti-pattern. Keep narrow.
const HEDGE_PATTERNS: Array<{ rx: RegExp; reason: string }> = [
  {
    rx: /Shared-DB workspace/i,
    reason: "comment phrasing reserved for shared-DB hedges; use a db-sandbox primitive instead",
  },
  {
    rx: /\bLOWER bound, not an exact match\b/,
    reason: "shared-DB lower-bound hedge — migrate the test to runInTxSandbox / runInIsolatedSchema",
  },
  {
    rx: /seeded counts are a LOWER bound/i,
    reason: "shared-DB lower-bound hedge — migrate the test to runInTxSandbox / runInIsolatedSchema",
  },
];

interface Offender {
  file: string;
  line: number;
  text: string;
  reason: string;
}

// Fixture-walk accept: same .ts/.tsx + self-skip semantics, but every file
// under the fixture root counts as a "test file" (no tests/-prefix check —
// the fixture root IS the test tree).
function isFixtureScannable(file: string): boolean {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return false;
  const base = file.split("/").pop() ?? file;
  return !base.includes(SELF);
}

export function runLint(root?: string): {
  ok: boolean;
  offenders: Offender[];
  scanned: number;
} {
  const files: string[] = [];
  if (root) {
    walkDir(root, files, isFixtureScannable);
  } else {
    for (const f of listTrackedFiles()) {
      if (isScannablePath(f) && isHedgeScannable(f)) files.push(f);
    }
  }
  const offenders: Offender[] = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { rx, reason } of HEDGE_PATTERNS) {
        if (rx.test(line)) {
          offenders.push({
            file,
            line: i + 1,
            text: line.trim(),
            reason,
          });
        }
      }
    }
  }

  return { ok: offenders.length === 0, offenders, scanned: files.length };
}

export function cliMain(): number {
  const result = runLint();
  if (result.ok) {
    console.log(
      `[lint-test-hedge-comments] OK — scanned ${result.scanned} test files, no shared-DB hedge comments found.`,
    );
    return 0;
  }
  console.error(
    `[lint-test-hedge-comments] FAILED — ${result.offenders.length} hedge comment(s) found:`,
  );
  for (const o of result.offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.reason}`);
    console.error(`    > ${o.text}`);
  }
  console.error(
    "\nFix: migrate the test to a db-sandbox primitive (see tests/db-sandbox.ts):",
  );
  console.error(
    "  - runInTxSandbox(fn)        single-connection transactional sandbox",
  );
  console.error(
    "  - runInIsolatedSchema(fn)   per-test Postgres schema (committed cross-connection visibility)",
  );
  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-test-hedge-comments.ts");

if (isMain) {
  process.exit(cliMain());
}
