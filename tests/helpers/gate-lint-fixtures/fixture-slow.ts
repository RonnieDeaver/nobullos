/**
 * Fixture for tests/gate-lint-phase.test.ts — sleeps ~1.5s synchronously
 * (Atomics.wait is allowed in worker threads) and appends start/end
 * timestamps to $GATE_FIXTURE_LOG so the test can measure how many checks
 * ran concurrently.
 */
import { appendFileSync } from "node:fs";

export function cliMain(): number {
  const logPath = process.env.GATE_FIXTURE_LOG;
  if (!logPath) {
    console.error("fixture-slow: GATE_FIXTURE_LOG not set");
    return 9;
  }
  appendFileSync(logPath, `S ${Date.now()}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  appendFileSync(logPath, `E ${Date.now()}\n`);
  console.log("fixture-slow: done");
  return 0;
}
