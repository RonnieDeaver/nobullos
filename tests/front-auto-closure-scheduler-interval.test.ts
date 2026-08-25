/* test-registration
{
  "name": "Front auto-closure scheduler interval resolution (Task #2548)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2548 — Direct unit coverage for the Front auto-closure scheduler's
 * admin-tunable run-cadence resolution.
 *
 * Task #2514 (`front-auto-closure-scheduler-gates.test.ts`) covered the
 * scheduler's *safety gates* — whether a tick is allowed to enqueue — but
 * not the *cadence* it runs at. The interval is admin-tunable via the
 * `front_auto_closure_tick_interval_seconds` system setting and is parsed +
 * range-validated by `refreshIntervalMs()` in
 * `server/services/frontAutoClosureScheduler.ts`: a finite value in
 * [10, 3600] seconds wins (stored in ms), and anything missing, out of
 * range, or non-numeric falls back to `PERF.FRONT_AUTO_CLOSURE_TICK_INTERVAL_MS`.
 * That validation + fallback path had no test, so a regression could
 * silently make the self-heal loop run far too often or fall back
 * unexpectedly.
 *
 * This test exercises the REAL `refreshIntervalMs()` (via
 * `__frontAutoClosureSchedulerTestHelpers`) against the dev DB, wrapped in
 * `runWithWorkerDb` (the helper reads `storage.getSystemSetting`, a
 * worker-pool tenant). It asserts:
 *   1. a valid in-range value (and both inclusive edges, 10 and 3600) is
 *      honored and returned in milliseconds;
 *   2. each invalid form — empty/missing, below-range (9), above-range
 *      (3601), and non-numeric — falls back to the PERF default.
 *
 * Pins + restores the one shared `system_settings` row it reads
 * (`front_auto_closure_tick_interval_seconds`) per the shared-DB pin
 * contract (see `.agents/memory/test-global-setting-leak-from-sigkill.md`),
 * backing it up and restoring it in `finally` so a SIGKILL'd sibling can't
 * leave the dev DB contaminated and this suite is deterministic regardless
 * of leftover global state.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2514 (the scheduler gate coverage this complements + style reference),
 *   #2379 (shared-DB global-switch pin+restore contract).
 */
import assert from "node:assert/strict";

import { runWithWorkerDb } from "../server/db";
import { storage } from "../server/storage";
import { PERF } from "../server/perfConfig";
import {
  SCHEDULER_INTERVAL_SETTING,
  __frontAutoClosureSchedulerTestHelpers,
} from "../server/services/frontAutoClosureScheduler";

const DEFAULT_MS = PERF.FRONT_AUTO_CLOSURE_TICK_INTERVAL_MS;

// Resolve the cadence the way the running scheduler does (worker-pool
// tenant: the helper reads system_settings via storage.getSystemSetting).
const resolve = (): Promise<number> =>
  runWithWorkerDb(() => __frontAutoClosureSchedulerTestHelpers.refreshIntervalMs());

// Set the admin-tunable interval setting (null → store empty, i.e. the
// "missing/empty value" the resolver treats as falsy).
const setInterval = (value: string): Promise<unknown> =>
  storage.setSystemSetting(SCHEDULER_INTERVAL_SETTING, value, "test");

// ── Back up the one shared switch we read so a SIGKILL'd sibling can't
// leave it dirty (and so we leave it as we found it). ─────────────────
const ORIG_INTERVAL =
  (await storage.getSystemSetting(SCHEDULER_INTERVAL_SETTING))?.value ?? null;

try {
  // ── 1. Valid in-range value is honored and returned in milliseconds. ──
  await setInterval("120");
  assert.equal(await resolve(), 120_000,
    "an in-range value (120s) resolves to 120000ms");

  // Inclusive lower edge (10s) is accepted.
  await setInterval("10");
  assert.equal(await resolve(), 10_000,
    "the inclusive lower edge (10s) is honored");

  // Inclusive upper edge (3600s) is accepted.
  await setInterval("3600");
  assert.equal(await resolve(), 3_600_000,
    "the inclusive upper edge (3600s) is honored");

  // ── 2. Every invalid form falls back to the PERF default. ────────────

  // Empty / missing value (falsy row.value) → PERF default.
  await setInterval("");
  assert.equal(await resolve(), DEFAULT_MS,
    "a missing/empty value falls back to the PERF default");

  // Below range (9 < 10) → PERF default.
  await setInterval("9");
  assert.equal(await resolve(), DEFAULT_MS,
    "a below-range value (9s) falls back to the PERF default");

  // Above range (3601 > 3600) → PERF default.
  await setInterval("3601");
  assert.equal(await resolve(), DEFAULT_MS,
    "an above-range value (3601s) falls back to the PERF default");

  // Non-numeric → Number(...) is NaN, not finite → PERF default.
  await setInterval("not-a-number");
  assert.equal(await resolve(), DEFAULT_MS,
    "a non-numeric value falls back to the PERF default");
} finally {
  // Restore the switch we pinned, regardless of outcome.
  await setInterval(ORIG_INTERVAL ?? "");
}

console.log("front-auto-closure-scheduler-interval.test.ts: OK");
