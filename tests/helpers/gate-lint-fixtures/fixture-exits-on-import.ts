/**
 * Fixture for tests/gate-lint-phase.test.ts — violates the gate's contract
 * on purpose by running CLI work (and process.exit) at import time. The
 * worker dies before posting a result; the gate must report the check as
 * failed with the import-time hint instead of hanging or passing silently.
 */
export const violatesContract = true;
console.log("fixture-exits-on-import: running at import time");
process.exit(3);
