/* test-registration
{
  "name": "Ingestion-class concurrency boot hydration (Task #1817)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1817 — boot-load regression test for the live-tunable
 * ingestion-class concurrency cap added in Task #1816.
 *
 * Pins three behaviours that a future refactor could silently break
 * and leave the scheduler stuck at the default (3) after every
 * redeploy:
 *
 *   (a) `setIngestionClassConcurrency(n)` updates the in-memory cap
 *       and clamps to the documented [MIN, MAX] bounds.
 *   (b) `loadIngestionClassConcurrencyFromSettings()` reads
 *       `system_settings.workload_class_ingestion_max_concurrency`
 *       and applies it to the in-memory cap (the survival-of-redeploy
 *       guarantee invoked by `startScheduler`).
 *   (c) Invalid persisted values (non-numeric, missing) leave the
 *       in-memory cap untouched so a corrupt setting cannot brick the
 *       scheduler.
 *
 * The test restores both the system setting and the in-memory cap on
 * exit so it is safe to run repeatedly against the shared dev DB.
 */

import assert from "node:assert/strict";

import { storage } from "../server/storage";
import {
  INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
  INGESTION_CLASS_CONCURRENCY_DEFAULT,
  INGESTION_CLASS_CONCURRENCY_MAX,
  INGESTION_CLASS_CONCURRENCY_MIN,
  getIngestionClassConcurrency,
  setIngestionClassConcurrency,
  loadIngestionClassConcurrencyFromSettings,
} from "../server/services/workloadManager";

// "test" is one of the SYNTHETIC_UPDATED_BY_MARKERS in
// `server/storage/settingsStorage.ts`, so it satisfies the
// `system_settings.updated_by → users.id` FK by being normalised to
// NULL instead of looked up as a real user id.
const TAG_USER = "test";

const initialLive = getIngestionClassConcurrency();
const initialPersistedRow = await storage.getSystemSetting(
  INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
);
const initialPersisted = initialPersistedRow?.value ?? null;

async function restorePersisted(): Promise<void> {
  if (initialPersisted === null) {
    await storage.deleteSystemSetting(INGESTION_CLASS_CONCURRENCY_SETTING_KEY);
  } else {
    await storage.setSystemSetting(
      INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
      initialPersisted,
      TAG_USER,
    );
  }
}

let failed = 0;
let passed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  // ── (a) setIngestionClassConcurrency: bounds + clamping ───────────
  setIngestionClassConcurrency(INGESTION_CLASS_CONCURRENCY_DEFAULT);
  check(
    "reset to default succeeds",
    getIngestionClassConcurrency() === INGESTION_CLASS_CONCURRENCY_DEFAULT,
  );

  const r4 = setIngestionClassConcurrency(4);
  check("set(4) applies as 4", r4.applied === 4 && !r4.clamped);
  check("live cap is 4 after set", getIngestionClassConcurrency() === 4);

  const rHigh = setIngestionClassConcurrency(99);
  check(
    `set(99) clamps to MAX=${INGESTION_CLASS_CONCURRENCY_MAX}`,
    rHigh.applied === INGESTION_CLASS_CONCURRENCY_MAX && rHigh.clamped,
  );

  const rLow = setIngestionClassConcurrency(0);
  check(
    `set(0) clamps to MIN=${INGESTION_CLASS_CONCURRENCY_MIN}`,
    rLow.applied === INGESTION_CLASS_CONCURRENCY_MIN && rLow.clamped,
  );

  // ── (b) boot loader reads persisted value through worker pool ─────
  setIngestionClassConcurrency(INGESTION_CLASS_CONCURRENCY_DEFAULT);
  await storage.setSystemSetting(
    INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
    "4",
    TAG_USER,
  );
  await loadIngestionClassConcurrencyFromSettings();
  check(
    "boot loader hydrates persisted '4' into in-memory cap",
    getIngestionClassConcurrency() === 4,
    `got ${getIngestionClassConcurrency()}`,
  );

  // Re-load idempotency: re-running the loader with the same value
  // must not change anything.
  await loadIngestionClassConcurrencyFromSettings();
  check(
    "boot loader is idempotent (still 4 after second call)",
    getIngestionClassConcurrency() === 4,
  );

  // Bump the persisted value to 5 and re-hydrate.
  await storage.setSystemSetting(
    INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
    "5",
    TAG_USER,
  );
  await loadIngestionClassConcurrencyFromSettings();
  check(
    "boot loader picks up persisted update to '5'",
    getIngestionClassConcurrency() === 5,
    `got ${getIngestionClassConcurrency()}`,
  );

  // ── (c) malformed / unset persisted values leave the cap alone ────
  setIngestionClassConcurrency(3);
  await storage.setSystemSetting(
    INGESTION_CLASS_CONCURRENCY_SETTING_KEY,
    "not-a-number",
    TAG_USER,
  );
  await loadIngestionClassConcurrencyFromSettings();
  check(
    "non-numeric persisted value is ignored (cap stays at 3)",
    getIngestionClassConcurrency() === 3,
    `got ${getIngestionClassConcurrency()}`,
  );

  setIngestionClassConcurrency(3);
  await storage.deleteSystemSetting(INGESTION_CLASS_CONCURRENCY_SETTING_KEY);
  await loadIngestionClassConcurrencyFromSettings();
  check(
    "unset persisted value is ignored (cap stays at 3)",
    getIngestionClassConcurrency() === 3,
    `got ${getIngestionClassConcurrency()}`,
  );
} finally {
  await restorePersisted();
  setIngestionClassConcurrency(initialLive);
}

console.log(`${passed} passed, ${failed} failed.`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
assert.equal(failed, 0, "ingestion-class concurrency boot regression");

// Task #1821: explicit exit so the test child doesn't hang on
// non-unref'd timers/listeners pulled in by the storage / db modules
// when this file is run under the full suite harness. In isolation
// the process exits in ~1s because nothing else holds the loop, but
// under `tests/run-all.ts` the same code reliably times out at the
// 180s wall-clock cap. All assertions have already passed by the
// time we reach this line; the `finally` block above already
// restored both the persisted setting and the in-memory cap.
