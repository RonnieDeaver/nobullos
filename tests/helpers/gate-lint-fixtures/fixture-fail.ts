/**
 * Fixture for tests/gate-lint-phase.test.ts — a failing lint-style check
 * that prints to both streams and returns a nonzero exit code.
 */
export function cliMain(): number {
  console.log("fixture-fail: scanning");
  console.error("fixture-fail: failing on purpose");
  return 1;
}
