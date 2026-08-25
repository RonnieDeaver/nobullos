/* test-registration
{
  "name": "lint-cross-instance-locks guard (Task #2382)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2382 — Regression test for the cross-instance-protection guard.
 * Task #2397 — Extended to self-rescheduling setTimeout loops + cron libs.
 *
 * The guard (scripts/lint-cross-instance-locks.ts) flags new background
 * schedulers — setInterval, self-rescheduling setTimeout loops, and
 * cron-library entry points — that lack cross-instance protection on the
 * `autoscale` deploy target.
 *
 * Proves, against a temp fixture tree so the assertions are exact:
 *   1. A new setInterval file with no lock/annotation/baseline is flagged.
 *   2. A file that takes the cross-instance advisory lock passes.
 *   3. A file with a `// @cross-instance-safe:` annotation passes.
 *   4. A baselined file passes.
 *   5. A baseline entry that no longer schedules is reported stale.
 *   6. A file that only mentions setInterval in a comment / type position
 *      is NOT treated as a scheduler.
 *   7. A self-rescheduling setTimeout loop (named-fn ref, Form 1) is flagged.
 *   8. A self-rescheduling setTimeout loop (callback self-call, Form 2) is
 *      flagged.
 *   9. A `new Promise(r => setTimeout(r, ms))` sleep helper is NOT flagged.
 *  10. A retry-with-sleep recursion (recursion AFTER an awaited sleep, outside
 *      the setTimeout callback) is NOT flagged.
 *  11. A node-cron `cron.schedule(...)` entry point is flagged.
 *  12. An annotated self-rescheduling setTimeout loop passes.
 *  13. An annotated cron entry point passes.
 *  14. A file that only mentions `cron.schedule` in a comment is NOT a
 *      scheduler.
 *  15. The REAL `server/` tree passes against the committed baseline.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-cross-instance-locks";

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

function fixture(): { root: string; baseline: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-xinst-"));
  const baseline = join(root, "baseline.txt");
  writeFileSync(baseline, "");
  return {
    root,
    baseline,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeFile(root: string, rel: string, lines: string[]): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
  return full;
}

// 1. A new unprotected setInterval scheduler is flagged.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/newJob.ts", [
      "let started = false;",
      "export function start() {",
      "  if (started) return;",
      "  started = true;",
      "  setInterval(async () => { await doWork(); }, 60_000);",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "unprotected scheduler trips the lint");
    assert(
      res.offenders.some((o) => o.file.endsWith("newJob.ts")),
      "the new file is reported as an offender",
    );
  } finally {
    cleanup();
  }
}

// 2. A file using the cross-instance advisory lock passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/lockedJob.ts", [
      "import { withWorkerSingletonLock } from './crossInstanceLock';",
      "export function start() {",
      "  setInterval(async () => {",
      "    await withWorkerSingletonLock('locked_job', async () => doWork());",
      "  }, 60_000);",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "lock-protected scheduler passes");
    assert(res.protectedCount === 1, "it is counted as lock-protected");
    assert(res.offenders.length === 0, "no offenders for lock-protected file");
  } finally {
    cleanup();
  }
}

// 3. A file with the safe-by-design annotation passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/annotatedJob.ts", [
      "// @cross-instance-safe: idempotent UPSERT, harmless on every instance",
      "export function start() {",
      "  setInterval(async () => { await upsertRollup(); }, 60_000);",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "annotated scheduler passes");
    assert(res.annotatedCount === 1, "it is counted as annotated");
  } finally {
    cleanup();
  }
}

// 4. A baselined file passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    const full = writeFile(root, "svc/grandJob.ts", [
      "export function start() {",
      "  setInterval(async () => { await doWork(); }, 60_000);",
      "}",
    ]);
    writeFileSync(baseline, `${full} # grandfathered: audited snapshot\n`);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "baselined scheduler passes");
    assert(res.baselinedCount === 1, "it is counted as baselined");
    assert(res.stale.length === 0, "no stale entries when baseline matches");
  } finally {
    cleanup();
  }
}

// 5. A stale baseline entry (no longer a scheduler) is reported.
{
  const { root, baseline, cleanup } = fixture();
  try {
    const full = writeFile(root, "svc/noLongerScheduler.ts", [
      "// Mentions setInterval only in this comment now.",
      "export function helper() { return 1; }",
    ]);
    writeFileSync(baseline, `${full} # grandfathered\n`);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "stale baseline entry trips the lint");
    assert(
      res.stale.some((s) => s.includes("noLongerScheduler.ts")),
      "the stale entry is reported",
    );
  } finally {
    cleanup();
  }
}

// 6. setInterval only as a comment / type annotation is NOT a scheduler.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/typeOnly.ts", [
      "// A self-rescheduling setTimeout (not a setInterval) drives this.",
      "let timer: ReturnType<typeof setInterval> | null = null;",
      "export function helper() { return timer; }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "comment/type mention of setInterval is not flagged");
    assert(res.scanned === 0, "no schedulers detected in the fixture");
  } finally {
    cleanup();
  }
}

// 7. Self-rescheduling setTimeout loop — Form 1 (named function reference).
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/timeoutLoopForm1.ts", [
      "function tick() {",
      "  doWork();",
      "  setTimeout(tick, 60_000);",
      "}",
      "export function start() { tick(); }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "Form-1 self-rescheduling setTimeout trips the lint");
    assert(
      res.offenders.some((o) => o.file.endsWith("timeoutLoopForm1.ts")),
      "the Form-1 setTimeout file is reported as an offender",
    );
  } finally {
    cleanup();
  }
}

// 8. Self-rescheduling setTimeout loop — Form 2 (callback self-call).
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/timeoutLoopForm2.ts", [
      "export function scheduleNextCycle() {",
      "  setTimeout(async () => {",
      "    await doWork();",
      "    scheduleNextCycle();",
      "  }, 60_000);",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "Form-2 self-rescheduling setTimeout trips the lint");
    assert(
      res.offenders.some((o) => o.file.endsWith("timeoutLoopForm2.ts")),
      "the Form-2 setTimeout file is reported as an offender",
    );
  } finally {
    cleanup();
  }
}

// 9. A `new Promise(r => setTimeout(r, ms))` sleep helper is NOT a scheduler.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/sleepHelper.ts", [
      "export function sleep(ms: number) {",
      "  return new Promise((r) => setTimeout(r, ms));",
      "}",
      "export async function helper() { await sleep(1000); return 1; }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a one-shot sleep helper is not flagged");
    assert(res.scanned === 0, "no schedulers detected for the sleep helper");
  } finally {
    cleanup();
  }
}

// 10. Retry-with-sleep recursion (recursion AFTER an awaited sleep, OUTSIDE
//     the setTimeout callback) is NOT a self-rescheduling loop.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/retryWithSleep.ts", [
      "async function apiRequest(attempt = 0): Promise<unknown> {",
      "  try {",
      "    return await callApi();",
      "  } catch (err) {",
      "    if (attempt >= 3) throw err;",
      "    await new Promise((r) => setTimeout(r, 1000));",
      "    return apiRequest(attempt + 1);",
      "  }",
      "}",
      "export { apiRequest };",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "retry-with-sleep recursion is not flagged");
    assert(res.scanned === 0, "no schedulers detected for retry-with-sleep");
  } finally {
    cleanup();
  }
}

// 11. A node-cron `cron.schedule(...)` entry point is flagged.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/cronJob.ts", [
      "import cron from 'node-cron';",
      "export function start() {",
      "  cron.schedule('0 4 * * *', () => { void doPrune(); });",
      "}",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(!res.ok, "an unprotected cron entry point trips the lint");
    assert(
      res.offenders.some((o) => o.file.endsWith("cronJob.ts")),
      "the cron file is reported as an offender",
    );
  } finally {
    cleanup();
  }
}

// 12. An annotated self-rescheduling setTimeout loop passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/annotatedTimeout.ts", [
      "// @cross-instance-safe: enqueues a deduped work_queue job, leased once",
      "function tick() {",
      "  enqueue();",
      "  setTimeout(tick, 60_000);",
      "}",
      "export function start() { tick(); }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "annotated setTimeout loop passes");
    assert(res.annotatedCount === 1, "the setTimeout loop is counted annotated");
  } finally {
    cleanup();
  }
}

// 13. An annotated cron entry point passes.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/annotatedCron.ts", [
      "// @cross-instance-safe: idempotent time-cutoff DELETE",
      "import cron from 'node-cron';",
      "export function start() { cron.schedule('0 4 * * *', () => void prune()); }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "annotated cron entry point passes");
    assert(res.annotatedCount === 1, "the cron entry point is counted annotated");
  } finally {
    cleanup();
  }
}

// 14. `cron.schedule` only in a comment is NOT a scheduler.
{
  const { root, baseline, cleanup } = fixture();
  try {
    writeFile(root, "svc/cronComment.ts", [
      "// We used to cron.schedule('0 4 * * *', ...) here; now queue-driven.",
      "export function helper() { return 1; }",
    ]);
    const res = runLint({ root, baselinePath: baseline });
    assert(res.ok, "a commented-out cron mention is not flagged");
    assert(res.scanned === 0, "no schedulers detected for the cron comment");
  } finally {
    cleanup();
  }
}

// 15. The REAL server/ tree passes against the committed baseline.
{
  const res = runLint({
    root: "server",
    baselinePath: "scripts/lint-cross-instance-locks.baseline.txt",
  });
  if (!res.ok) {
    for (const o of res.offenders) console.error(`    offender: ${o.file}`);
    for (const s of res.stale) console.error(`    stale: ${s}`);
  }
  assert(res.ok, "real server/ tree passes the cross-instance guard");
  assert(res.scanned > 0, "the guard actually scanned schedulers in server/");
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
