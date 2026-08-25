/* test-registration
{
  "name": "Front re-match restrictToIds scoping guard (Task #2269)",
  "regression": true,
  "sweepOnlyReason": "Task #4096 triage of the migrated no-reason boilerplate: too slow for the routine gate (~6.5s in the 2026-08-07 nightly sweep); still runs in the full suite and the nightly --regression sweep.",
  "tier": "small"
}
test-registration */
/**
 * Task #2269 — regression test for the re-match scoping guard
 * `scripts/lint-front-rematch-restrict-to-ids.ts` (Task #2264).
 *
 * That guard fails the pre-deploy gate if any non-test source file passes the
 * TEST-ONLY `restrictToIds` option to one of the three whole-corpus Front
 * re-match sweeps (`rematchAll`, `reprocessDismissedNonSpam`,
 * `reEvaluateExistingUnmatched`). Passing it from production would make the
 * sweep skip cursor persistence and the full pagination scan, silently
 * processing only the named ids and never draining the backlog.
 *
 * The guard was originally verified only by hand against a simulated offender,
 * so a future refactor of the guard could silently stop catching offenders.
 * This test locks the behaviour in:
 *
 *   1. Clean fixture  → exit 0.
 *   2. Object-literal offender (`rematchAll({ restrictToIds })`) → exit 1,
 *      and the offending fixture file is named in the output.
 *   3. Indirect offender (`const opts = { restrictToIds }; rematchAll(opts)`)
 *      → exit 1. This exercises the guard's *type-checker* path — the whole
 *      reason it builds a typed Program instead of regex-scanning — proving a
 *      shallow scan-only regression would be caught.
 *
 * Mirroring `tests/front-sync-email-triage.test.ts`, the offenders live in a
 * TEMP fixture file and the lint is pointed at it via the
 * `LINT_FRONT_REMATCH_TARGET` env override (see the lint script). The real
 * source tree is never mutated, so even a SIGKILL'd test child can't strand a
 * fixture in production source.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${msg} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

// Every fixture declares the target sweep signatures itself so the lint's
// typed Program needs nothing from the project sources.
const SWEEP_DECLS =
  "declare function rematchAll(opts?: { restrictToIds?: string[] }): Promise<void>;\n" +
  "declare function reprocessDismissedNonSpam(opts?: { restrictToIds?: string[] }): Promise<void>;\n" +
  "declare function reEvaluateExistingUnmatched(opts?: { restrictToIds?: string[] }): Promise<void>;\n";

function runLint(fixturePath: string): ReturnType<typeof spawnSync> {
  return spawnSync("npx", ["tsx", "scripts/lint-front-rematch-restrict-to-ids.ts"], {
    encoding: "utf8",
    env: { ...process.env, LINT_FRONT_REMATCH_TARGET: fixturePath },
  });
}

async function run(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "rematch-lint-"));
  try {
    // --- Case 1: clean fixture — calls the sweeps WITHOUT restrictToIds ---
    {
      const cleanFile = join(tmpDir, "clean.ts");
      writeFileSync(
        cleanFile,
        SWEEP_DECLS +
          "export async function cleanCaller(): Promise<void> {\n" +
          "  await rematchAll();\n" +
          "  await reprocessDismissedNonSpam({});\n" +
          "  await reEvaluateExistingUnmatched({});\n" +
          "}\n",
        "utf8",
      );
      const result = runLint(cleanFile);
      assertEq(result.status, 0, `clean fixture should pass: ${result.stdout}\n${result.stderr}`);
      console.log("[rematch-restrict] clean-fixture check passed");
    }

    // --- Case 2: object-literal offender ---
    {
      const offenderFile = join(tmpDir, "offender-object-literal.ts");
      writeFileSync(
        offenderFile,
        SWEEP_DECLS +
          "export async function badObjectLiteralCaller(ids: string[]): Promise<void> {\n" +
          "  await rematchAll({ restrictToIds: ids });\n" +
          "}\n",
        "utf8",
      );
      const result = runLint(offenderFile);
      assertEq(
        result.status,
        1,
        `object-literal offender should fail; stdout=${result.stdout} stderr=${result.stderr}`,
      );
      const out = `${result.stdout}\n${result.stderr}`;
      assert(out.includes("offender-object-literal.ts"), "output should name the offending fixture file");
      assert(out.includes("rematchAll"), "output should name the offending sweep");
      console.log("[rematch-restrict] object-literal offender check passed");
    }

    // --- Case 3: indirect (type-checker) offender ---
    //   const opts = { restrictToIds: ids }; rematchAll(opts);
    // A regex/shallow scan would miss this; only the typed Program catches it.
    {
      const offenderFile = join(tmpDir, "offender-indirect.ts");
      writeFileSync(
        offenderFile,
        SWEEP_DECLS +
          "export async function badIndirectCaller(ids: string[]): Promise<void> {\n" +
          "  const opts = { restrictToIds: ids };\n" +
          "  await reprocessDismissedNonSpam(opts);\n" +
          "}\n",
        "utf8",
      );
      const result = runLint(offenderFile);
      assertEq(
        result.status,
        1,
        `indirect offender should fail; stdout=${result.stdout} stderr=${result.stderr}`,
      );
      const out = `${result.stdout}\n${result.stderr}`;
      assert(out.includes("offender-indirect.ts"), "output should name the offending fixture file");
      assert(out.includes("reprocessDismissedNonSpam"), "output should name the offending sweep");
      console.log("[rematch-restrict] indirect (type-checker) offender check passed");
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  console.log("✓ front-rematch-restrict-to-ids (Task #2269) all checks passed");
}

run().then(
  () => {},
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
