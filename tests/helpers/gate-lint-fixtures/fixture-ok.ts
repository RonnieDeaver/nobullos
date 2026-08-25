/**
 * Fixture for tests/gate-lint-phase.test.ts — a passing lint-style check
 * honoring the gate's cliMain contract (Task #3789).
 */
export function cliMain(): number {
  console.log("fixture-ok: OK");
  return 0;
}
