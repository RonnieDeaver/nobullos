/**
 * lint-test-hermetic-db — Task #3797 guardrail.
 *
 * Tests run against a HERMETIC per-run Postgres (tests/hermetic/provision.ts);
 * the shared Helium dev DB is off-limits to test code. This lint blocks the
 * three ways a new test could quietly punch back through to shared state:
 *
 *   1. raw-pool         — constructing its own `pg` Pool/Client instead of
 *                         going through server/db.ts or the sanctioned
 *                         harness helpers (which honor the injected hermetic
 *                         env and its guards).
 *   2. dev-db-literal   — hardcoding the shared dev database name
 *                         (`heliumdb`) or a `DATABASE_URL=` style literal
 *                         pointing at it.
 *   3. shared-dev-grant — a suite assigning `process.env.TEST_SHARED_DEV_DB`.
 *                         The flag is fully retired (server/db.ts ignores it;
 *                         the per-suite `sharedDev` tag went in Task #3862),
 *                         so any assignment is dead code at best and an
 *                         attempted reintroduction at worst.
 *
 * Sanctioned files (the machinery itself): tests/run-all.ts,
 * tests/db-sandbox.ts, tests/hermetic/**, tests/hermetic-db-guard.test.ts.
 *
 * Structure follows the repo lint conventions: pure `runLint()` for tests,
 * `main()` behind an isMain guard so importing this file never exits the
 * importer (see .agents memory: lint-script-testable-cli-guard).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(THIS_FILE, "..", "..");

/** Files allowed to construct raw connections / reference the dev DB name. */
const SANCTIONED = new Set<string>([
  "tests/run-all.ts",
  "tests/db-sandbox.ts",
  // Task #b65e9824: the leftover-schema sweeper deliberately opens a raw
  // pool to the SHARED dev DB at runner start — that is where SIGKILL'd
  // legacy runs orphan their test_iso_* schemas.
  "tests/sweep-isolated-schemas.ts",
  "tests/hermetic-db-guard.test.ts",
]);
const SANCTIONED_DIRS = ["tests/hermetic/"];

export interface LintViolation {
  file: string;
  line: number;
  rule: "raw-pool" | "dev-db-literal" | "shared-dev-grant";
  text: string;
}

export interface LintResult {
  ok: boolean;
  scanned: number;
  violations: LintViolation[];
}

function isSanctioned(rel: string): boolean {
  if (SANCTIONED.has(rel)) return true;
  return SANCTIONED_DIRS.some((d) => rel.startsWith(d));
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      out.push(...listTestFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Strip line comments and block comments so commented-out code never trips the lint. */
function stripComments(src: string): string {
  // Good-enough structural pass for lint purposes: remove /* … */ then // tails.
  // String contents are kept (a URL literal inside a string SHOULD trip rule 2).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1}`);
}

export function lintSource(rel: string, src: string): LintViolation[] {
  if (isSanctioned(rel)) return [];
  const violations: LintViolation[] = [];
  const stripped = stripComments(src);
  const lines = stripped.split("\n");
  const rawLines = src.split("\n");

  const importsPg = /from\s+["'](pg|pg-pool)["']|require\(\s*["'](pg|pg-pool)["']\s*\)/.test(stripped);

  lines.forEach((line, i) => {
    if (importsPg && /new\s+(pg\.)?(Pool|Client)\s*\(/.test(line)) {
      // Per-site escape hatch for tests that DELIBERATELY build a broken or
      // constrained pool from the injected (hermetic) env — e.g. simulating a
      // dead store. Marker sits on the violation line or the line above it.
      const marker = /lint-hermetic-db-ok:/;
      if (!marker.test(rawLines[i] ?? "") && !marker.test(rawLines[i - 1] ?? "")) {
        violations.push({
          file: rel,
          line: i + 1,
          rule: "raw-pool",
          text: rawLines[i]?.trim().slice(0, 160) ?? "",
        });
      }
    }
    if (/heliumdb/i.test(line)) {
      violations.push({
        file: rel,
        line: i + 1,
        rule: "dev-db-literal",
        text: rawLines[i]?.trim().slice(0, 160) ?? "",
      });
    }
    if (/process\.env\.TEST_SHARED_DEV_DB\s*=[^=]/.test(line) || /TEST_SHARED_DEV_DB\s*:\s*["']1["']/.test(line)) {
      violations.push({
        file: rel,
        line: i + 1,
        rule: "shared-dev-grant",
        text: rawLines[i]?.trim().slice(0, 160) ?? "",
      });
    }
  });
  return violations;
}

export function runLint(root: string = ROOT): LintResult {
  const testsDir = join(root, "tests");
  const files = listTestFiles(testsDir);
  const violations: LintViolation[] = [];
  for (const full of files) {
    const rel = relative(root, full).replace(/\\/g, "/");
    violations.push(...lintSource(rel, readFileSync(full, "utf8")));
  }
  return { ok: violations.length === 0, scanned: files.length, violations };
}

// Gate worker contract (Task #3789): export an import-side-effect-free
// cliMain(): number so scripts/gate.ts can run this check in-process via the
// lint worker pool; the standalone CLI below preserves `npx tsx <script>`.
export function cliMain(): number {
  const res = runLint();
  if (res.ok) {
    console.log(`lint-test-hermetic-db OK (${res.scanned} test files scanned)`);
    return 0;
  }
  console.error(
    `lint-test-hermetic-db FAILED — ${res.violations.length} violation(s). ` +
      `Tests must reach the database only through server/db.ts / the sanctioned harness helpers, ` +
      `never the shared dev DB. See TESTING.md.`,
  );
  for (const v of res.violations) {
    console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.text}`);
  }
  return 1;
}

const isMain = process.argv[1] != null && resolve(process.argv[1]) === THIS_FILE;
if (isMain) process.exit(cliMain());
