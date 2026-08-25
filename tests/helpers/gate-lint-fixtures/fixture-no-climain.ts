/**
 * Fixture for tests/gate-lint-phase.test.ts — violates the gate's contract
 * by not exporting cliMain(); the lint phase must fail this check loudly.
 */
export const notACliMain = true;
