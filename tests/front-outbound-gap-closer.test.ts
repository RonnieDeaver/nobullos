/* test-registration
{
  "name": "Front outbound gap-close driver (Task #1984 / #2022)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/frontGapCloserRecoverySetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1984 — Close the outbound message gap automatically.
 *
 * Pins the bounded close-gap driver that reads
 * `front_analytics_monthly_coverage` rows with a positive
 * `messages_outbound_gap` and drives the still-real ones back through
 * the historical-recovery ingestion pipeline.
 *
 * Deterministic units (no live Front needed):
 *   1. `selectOutboundGapMonths` returns only rows with
 *      `messages_outbound_gap > 0`, worst-gap first, honoring the limit.
 *   2. `countOutboundLocalForMonth` counts only outbound `front_email`
 *      rows inside the half-open `[monthStart, monthEnd)` window.
 *   3. `runOutboundGapCloseTick` no-ops with a reason when the master
 *      enable setting is OFF (default) — never spawns recovery.
 *   4. `loadMaxMonthsPerTick` parses + bounds the per-tick budget.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { setSystemSetting, deleteSystemSetting } from "../server/storage/settingsStorage";
import {
  selectOutboundGapMonths,
  countOutboundLocalForMonth,
  runOutboundGapCloseTick,
  getLastOutboundGapCloseRun,
  QUEUE_NAME,
  SETTING_ENABLED,
  SETTING_MAX_MONTHS_PER_TICK,
  SETTING_LAST_RUN,
  REQUIRED_MATERIALIZATION_SWITCH,
  __frontOutboundGapCloseTestHelpers,
} from "../server/services/frontOutboundGapCloser";
import { setPoolEpicSwitch } from "../server/services/poolEpicKillSwitches";
import {
  setQueuePause,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";
import { PERF } from "../server/perfConfig";
import {
  __getRecoveryCalls,
  __resetRecovery,
  __setRecoveryBehavior,
} from "./helpers/frontHistoricalRecoveryStub.mjs";

const TAG = "task-1984";
// Far-future months so we never collide with real coverage rows.
const Y = 2991;
const M_BIG = `${Y}-03`; // gap 12
const M_SMALL = `${Y}-04`; // gap 5
const M_ZERO = `${Y}-05`; // gap 0 (must be excluded)
const M_LOCAL = `${Y}-06`; // used for the local-count test
// Recovery-trigger (Task #2022) months. Given astronomically large gaps
// so they sort ahead of any real coverage row under `ORDER BY
// messages_outbound_gap DESC`, making the bounded per-tick selection
// deterministic on a loaded test DB.
const R_A = `${Y}-07`; // happy-path month #1 (biggest gap)
const R_B = `${Y}-08`; // happy-path month #2
const R_CLOSED = `${Y}-09`; // gap already closed by fresh local count
const R_CAP1 = `${Y}-10`; // first month — recovery cap reached
const R_CAP2 = `${Y}-11`; // second month — never reached (break)
const RECOVERY_MONTHS = [R_A, R_B, R_CLOSED, R_CAP1, R_CAP2];

function monthBounds(month: string): { start: Date; end: Date } {
  const [yy, mm] = month.split("-").map(Number);
  const start = new Date(Date.UTC(yy, mm - 1, 1));
  const end = new Date(Date.UTC(yy, mm, 1));
  return { start, end };
}

async function upsertCoverage(
  month: string,
  outboundFront: number | null,
  outboundLocal: number | null,
  outboundGap: number | null,
): Promise<void> {
  const { start, end } = monthBounds(month);
  await db.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end, messages_outbound_front,
       messages_outbound_local, messages_outbound_gap)
    VALUES (${month}, ${start.toISOString()}, ${end.toISOString()},
            ${outboundFront}, ${outboundLocal}, ${outboundGap})
    ON CONFLICT (month) DO UPDATE SET
      messages_outbound_front = EXCLUDED.messages_outbound_front,
      messages_outbound_local = EXCLUDED.messages_outbound_local,
      messages_outbound_gap   = EXCLUDED.messages_outbound_gap
  `);
}

async function insertRawComm(
  externalSourceId: string,
  direction: string,
  sourceType: string,
  ts: Date,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO raw_communication_records
      (source_type, title, timestamp, direction, external_source_id)
    VALUES (${sourceType}, ${`${TAG} fixture`}, ${ts.toISOString()},
            ${direction}, ${externalSourceId})
  `);
}

/** Delete only the recovery-trigger fixtures so each recovery test gets
 * a deterministic selection regardless of run order. */
async function clearRecoveryMonths(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month IN (${R_A}, ${R_B}, ${R_CLOSED}, ${R_CAP1}, ${R_CAP2})
  `);
  await db.execute(sql`
    DELETE FROM raw_communication_records
    WHERE external_source_id LIKE ${`${TAG}-r-%`}
  `);
}

/** Count the scheduled-tick jobs currently sitting in `work_queue` for
 * the gap-closer queue. Used by the producer-gating (enqueue) tests. */
async function countEnqueuedGapCloseJobs(): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM work_queue WHERE queue_name = ${QUEUE_NAME}
  `);
  const r = ((rows as any).rows ?? (rows as unknown as any[]))[0];
  return Number(r?.n ?? 0) || 0;
}

/** Drop every gap-closer job from `work_queue` so each enqueue test
 * starts from a clean slate regardless of run order. */
async function clearEnqueuedGapCloseJobs(): Promise<void> {
  await db.execute(sql`DELETE FROM work_queue WHERE queue_name = ${QUEUE_NAME}`);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month IN (${M_BIG}, ${M_SMALL}, ${M_ZERO}, ${M_LOCAL})
  `);
  await db.execute(sql`
    DELETE FROM raw_communication_records
    WHERE external_source_id LIKE ${`${TAG}-%`}
  `);
  await clearRecoveryMonths();
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  await deleteSystemSetting(SETTING_MAX_MONTHS_PER_TICK).catch(() => {});
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
  // Restore the per-message materialization gate to its default-OFF
  // state so a later test file never inherits an ON switch.
  await setPoolEpicSwitch(REQUIRED_MATERIALIZATION_SWITCH, false, "system").catch(
    () => {},
  );
  // Restore the close-gap queue to not-paused and drop in-memory drain
  // state so a later test file never inherits a paused queue.
  await setQueuePause(QUEUE_NAME, false, "system").catch(() => {});
  _resetQueueDrainStateForTests();
  // Restore the non-critical-sweeps kill switch to its default-OFF state
  // in case a test mutated it in-place.
  (PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean }).KILL_SWITCH_NON_CRITICAL_SWEEPS =
    false;
  // Drop any scheduled-tick jobs the producer-gating tests enqueued.
  await clearEnqueuedGapCloseJobs().catch(() => {});
  __resetRecovery();
}

test.before(cleanup);
test.after(cleanup);
// This suite imports `db` (the api pool), which in test children runs with
// DB_API_POOL_MIN=1 — a live connection that keeps the event loop alive, so
// the node:test process never exits naturally once the suite finishes and the
// harness SIGKILLs it at the per-file timeout. Force a clean exit after the
// suite's work is done, preserving the runner's pass/fail exit code (#2083).
test.after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

test("selectOutboundGapMonths returns only positive-gap months, worst-first, honoring limit", async () => {
  await upsertCoverage(M_BIG, 20, 8, 12);
  await upsertCoverage(M_SMALL, 10, 5, 5);
  await upsertCoverage(M_ZERO, 7, 7, 0);

  const all = await selectOutboundGapMonths(50);
  const mine = all.filter((m) => [M_BIG, M_SMALL, M_ZERO].includes(m.month));
  // Zero-gap month is excluded; the two positive-gap months are present.
  assert.deepEqual(
    mine.map((m) => m.month),
    [M_BIG, M_SMALL],
    "expected worst-gap-first ordering with the zero-gap month excluded",
  );
  assert.equal(mine[0].messagesOutboundGap, 12);
  assert.equal(mine[0].messagesOutboundFront, 20);

  // Limit applies.
  const limited = await selectOutboundGapMonths(1);
  assert.ok(limited.length <= 1, "limit must cap the row count");
});

test("countOutboundLocalForMonth counts only in-window outbound front_email rows", async () => {
  const { start, end } = monthBounds(M_LOCAL);
  const inWindow = new Date(start.getTime() + 5 * 24 * 3600_000);
  const beforeWindow = new Date(start.getTime() - 24 * 3600_000);
  const afterWindow = new Date(end.getTime() + 24 * 3600_000);

  await insertRawComm(`${TAG}-o1`, "outbound", "front_email", inWindow);
  await insertRawComm(`${TAG}-o2`, "outbound", "front_email", inWindow);
  // Excluded: inbound direction.
  await insertRawComm(`${TAG}-i1`, "inbound", "front_email", inWindow);
  // Excluded: wrong source type.
  await insertRawComm(`${TAG}-z1`, "outbound", "zoom", inWindow);
  // Excluded: outside the window.
  await insertRawComm(`${TAG}-o3`, "outbound", "front_email", beforeWindow);
  await insertRawComm(`${TAG}-o4`, "outbound", "front_email", afterWindow);

  const n = await countOutboundLocalForMonth(start, end);
  assert.equal(n, 2, "only the 2 in-window outbound front_email rows count");
});

test("runOutboundGapCloseTick no-ops with a reason when disabled (default)", async () => {
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  const r = await runOutboundGapCloseTick();
  assert.equal(r.enabled, false);
  assert.equal(r.attempted.length, 0, "must not attempt any month while disabled");
  assert.match(r.reason ?? "", /disabled/i);
});

test("loadMaxMonthsPerTick parses and bounds the per-tick budget", async () => {
  const { loadMaxMonthsPerTick } = __frontOutboundGapCloseTestHelpers;

  await deleteSystemSetting(SETTING_MAX_MONTHS_PER_TICK).catch(() => {});
  assert.equal(await loadMaxMonthsPerTick(), 1, "default is 1");

  await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "5", "system");
  assert.equal(await loadMaxMonthsPerTick(), 5);

  await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "999", "system");
  assert.equal(await loadMaxMonthsPerTick(), 12, "clamped to the hard cap");

  await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "0", "system");
  assert.equal(await loadMaxMonthsPerTick(), 1, "non-positive falls back to default");

  await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "garbage", "system");
  assert.equal(await loadMaxMonthsPerTick(), 1, "garbage falls back to default");
});

// ===========================================================================
// Task #2022 — Recovery-trigger ("happy path") coverage.
//
// These exercise the enabled path the deterministic units intentionally
// skipped: every gate ON, the tick re-verifies each gap with a fresh
// local count, and drives the still-real months through
// `runHistoricalRecovery`. That call is redirected to an in-memory stub
// (`tests/helpers/frontHistoricalRecoveryStub.mjs`) by the resolve hook
// registered via `--import ./tests/helpers/frontGapCloserRecoverySetup.mjs`
// — see the `run-all.ts` entry for this file — so no real Front API /
// recovery-registry work happens. The far-future months carry
// astronomically large gaps so the bounded per-tick selection is
// deterministic even on a loaded test DB.
// ===========================================================================

/** Flip every gate ON so the tick reaches the recovery-trigger loop. */
async function enableAllGates(maxMonths: number): Promise<void> {
  await setSystemSetting(SETTING_ENABLED, "true", "system");
  await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, String(maxMonths), "system");
  await setPoolEpicSwitch(REQUIRED_MATERIALIZATION_SWITCH, true, "system");
}

test("all gates ON: runHistoricalRecovery called once per selected month with unix-seconds customWindows", async () => {
  await clearRecoveryMonths();
  __resetRecovery();

  // Two months, no local outbound rows → fresh local count is 0, so the
  // recomputed gap stays positive and both months trigger recovery.
  await upsertCoverage(R_A, 9_000_000, 0, 9_000_000);
  await upsertCoverage(R_B, 8_000_000, 0, 8_000_000);
  await enableAllGates(2);

  const r = await runOutboundGapCloseTick();

  assert.equal(r.enabled, true, "tick should report enabled");
  assert.equal(r.materializationEnabled, true, "materialization gate should be ON");
  assert.equal(r.candidateMonths, 2, "both gap months selected under the budget");

  const triggered = r.attempted.filter((a) => a.outcome === "recovery_triggered");
  assert.equal(triggered.length, 2, "both months should trigger recovery");
  assert.deepEqual(
    triggered.map((a) => a.month),
    [R_A, R_B],
    "worst-gap-first ordering preserved",
  );
  assert.ok(
    triggered.every((a) => typeof a.recoveryJobId === "string" && a.recoveryJobId.length > 0),
    "each triggered month records the stub recovery job id",
  );

  const calls = __getRecoveryCalls();
  assert.equal(calls.length, 2, "runHistoricalRecovery called exactly once per month");

  for (const month of [R_A, R_B]) {
    const { start, end } = monthBounds(month);
    const call = calls.find((c) =>
      c?.customWindows?.some((w: any) => w.label === `outbound-gap-${month}`),
    );
    assert.ok(call, `expected a recovery call for ${month}`);
    const win = call.customWindows[0];
    assert.equal(call.customWindows.length, 1, "one window per recovery call");
    assert.equal(
      win.afterTimestamp,
      Math.floor(start.getTime() / 1000),
      "afterTimestamp is monthStart in unix seconds",
    );
    assert.equal(
      win.beforeTimestamp,
      Math.floor(end.getTime() / 1000),
      "beforeTimestamp is monthEnd in unix seconds",
    );
    assert.equal(
      call.resumeMode,
      "clear_checkpoints",
      "recovery restarts from page 1 so a stale checkpoint can't short-circuit",
    );
  }
});

test("month whose gap already closed (fresh local >= front) is skipped before spending a recovery slot", async () => {
  await clearRecoveryMonths();
  __resetRecovery();

  // Stored gap is positive (so the month is selected), but the fresh
  // local count we seed equals the Front count → recomputed gap is 0.
  await upsertCoverage(R_CLOSED, 3, 0, 9_500_000);
  const { start } = monthBounds(R_CLOSED);
  const inWindow = new Date(start.getTime() + 2 * 24 * 3600_000);
  await insertRawComm(`${TAG}-r-c1`, "outbound", "front_email", inWindow);
  await insertRawComm(`${TAG}-r-c2`, "outbound", "front_email", inWindow);
  await insertRawComm(`${TAG}-r-c3`, "outbound", "front_email", inWindow);

  await enableAllGates(1);

  const r = await runOutboundGapCloseTick();

  assert.equal(r.candidateMonths, 1, "only the closed month is selected under the budget");
  assert.equal(r.attempted.length, 1, "one month attempted");
  assert.equal(r.attempted[0].month, R_CLOSED);
  assert.equal(
    r.attempted[0].outcome,
    "already_closed",
    "fresh local count caught up → no recovery spent",
  );
  assert.equal(r.attempted[0].remainingGap, 0);
  assert.equal(
    __getRecoveryCalls().length,
    0,
    "runHistoricalRecovery must NOT be called for an already-closed month",
  );
});

test("RECOVERY_CAP_REACHED is caught and recorded as a deferred outcome, not thrown", async () => {
  await clearRecoveryMonths();
  __resetRecovery();

  await upsertCoverage(R_CAP1, 7_000_000, 0, 7_000_000);
  await upsertCoverage(R_CAP2, 6_000_000, 0, 6_000_000);
  // Budget 2 selects exactly these two huge-gap months (they sort ahead
  // of any real coverage row), so the break-after-deferral leaves R_CAP2
  // for the next tick deterministically.
  await enableAllGates(2);

  // First recovery call hits the concurrency cap; the tick should catch
  // it, record a deferred outcome, set a reason, and stop (break) so the
  // second month is left for the next tick.
  __setRecoveryBehavior((_opts, index) => {
    if (index === 0) {
      const err: any = new Error("Recovery job cap reached (3/3 running).");
      err.code = "RECOVERY_CAP_REACHED";
      throw err;
    }
    return `stub-recovery-job-${index + 1}`;
  });

  let threw = false;
  let r: Awaited<ReturnType<typeof runOutboundGapCloseTick>> | undefined;
  try {
    r = await runOutboundGapCloseTick();
  } catch {
    threw = true;
  }

  assert.equal(threw, false, "the cap error must be swallowed, not thrown");
  assert.ok(r, "tick should return a result");
  assert.equal(r!.candidateMonths, 2, "both cap months selected under the budget");
  assert.equal(r!.attempted.length, 1, "tick breaks after the cap deferral");
  assert.equal(r!.attempted[0].month, R_CAP1);
  assert.equal(
    r!.attempted[0].outcome,
    "deferred_recovery_cap",
    "the capped month is recorded as deferred",
  );
  assert.match(r!.reason ?? "", /cap reached/i);
  assert.equal(
    __getRecoveryCalls().length,
    1,
    "only the first (capped) month reached runHistoricalRecovery",
  );
});

// ===========================================================================
// Task #2034 — Safety-gate ("negative path") coverage.
//
// The happy-path tests above prove recovery fires when every gate is ON.
// These prove the complementary contract: when any single safety gate is
// in its blocking state, the tick records a clear reason and NEVER spawns
// recovery — even with real, selectable gap months present. A regression
// that silently disables one of these gates would otherwise go unnoticed.
//
// Each test seeds the same huge-gap months the happy-path uses (so the
// only reason recovery does NOT fire is the gate under test), flips that
// one gate into its blocking state, and asserts
// `runHistoricalRecovery` was never called.
// ===========================================================================

/** Seed two huge-gap months that WOULD trigger recovery if every gate
 * allowed it (no local outbound rows → fresh gap stays positive). */
async function seedRecoveryReadyMonths(): Promise<void> {
  await upsertCoverage(R_A, 9_000_000, 0, 9_000_000);
  await upsertCoverage(R_B, 8_000_000, 0, 8_000_000);
}

test("gate OFF (materialization): no recovery, reason names the materialization switch", async () => {
  await clearRecoveryMonths();
  __resetRecovery();
  await seedRecoveryReadyMonths();

  // Every gate ON except per-message materialization, which stays OFF.
  await setSystemSetting(SETTING_ENABLED, "true", "system");
  await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "2", "system");
  await setPoolEpicSwitch(REQUIRED_MATERIALIZATION_SWITCH, false, "system");

  const r = await runOutboundGapCloseTick();

  assert.equal(r.enabled, true, "tick is enabled — only the gate under test blocks it");
  assert.equal(r.materializationEnabled, false, "materialization gate reports OFF");
  assert.equal(r.attempted.length, 0, "no month attempted while materialization is OFF");
  assert.equal(r.candidateMonths, 0, "gate trips before any candidate is selected");
  assert.match(
    r.reason ?? "",
    /materialization disabled/i,
    "reason must name the per-message materialization switch",
  );
  assert.match(r.reason ?? "", new RegExp(REQUIRED_MATERIALIZATION_SWITCH));
  assert.equal(
    __getRecoveryCalls().length,
    0,
    "runHistoricalRecovery must NOT be called while materialization is OFF",
  );
});

test("gate (queue paused): no recovery, reason names queue_drain_state", async () => {
  await clearRecoveryMonths();
  __resetRecovery();
  await seedRecoveryReadyMonths();

  // Every other gate ON — only the queue pause should block recovery.
  await setSystemSetting(SETTING_ENABLED, "true", "system");
  await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "2", "system");
  await setPoolEpicSwitch(REQUIRED_MATERIALIZATION_SWITCH, true, "system");
  await setQueuePause(QUEUE_NAME, true, "test");

  try {
    const r = await runOutboundGapCloseTick();

    assert.equal(r.enabled, true, "tick is enabled — only the queue pause blocks it");
    assert.equal(r.paused, true, "tick reports the queue as paused");
    assert.equal(r.attempted.length, 0, "no month attempted while the queue is paused");
    assert.equal(r.candidateMonths, 0, "gate trips before any candidate is selected");
    assert.match(
      r.reason ?? "",
      /queue paused/i,
      "reason must explain the queue is paused via queue_drain_state",
    );
    assert.equal(
      __getRecoveryCalls().length,
      0,
      "runHistoricalRecovery must NOT be called while the queue is paused",
    );
  } finally {
    await setQueuePause(QUEUE_NAME, false, "test");
    _resetQueueDrainStateForTests();
  }
});

test("gate (KILL_SWITCH_NON_CRITICAL_SWEEPS ON): no recovery, reason names the kill switch", async () => {
  await clearRecoveryMonths();
  __resetRecovery();
  await seedRecoveryReadyMonths();

  // Every other gate ON — only the non-critical-sweeps kill switch blocks.
  await setSystemSetting(SETTING_ENABLED, "true", "system");
  await setSystemSetting(SETTING_MAX_MONTHS_PER_TICK, "2", "system");
  await setPoolEpicSwitch(REQUIRED_MATERIALIZATION_SWITCH, true, "system");

  const perf = PERF as { KILL_SWITCH_NON_CRITICAL_SWEEPS: boolean };
  const original = perf.KILL_SWITCH_NON_CRITICAL_SWEEPS;
  perf.KILL_SWITCH_NON_CRITICAL_SWEEPS = true;
  try {
    const r = await runOutboundGapCloseTick();

    assert.equal(r.enabled, true, "tick is enabled — only the kill switch blocks it");
    assert.equal(r.attempted.length, 0, "no month attempted while the kill switch is ON");
    assert.equal(r.candidateMonths, 0, "gate trips before any candidate is selected");
    assert.match(
      r.reason ?? "",
      /KILL_SWITCH_NON_CRITICAL_SWEEPS/,
      "reason must name the non-critical-sweeps kill switch",
    );
    assert.equal(
      __getRecoveryCalls().length,
      0,
      "runHistoricalRecovery must NOT be called while the kill switch is ON",
    );
  } finally {
    perf.KILL_SWITCH_NON_CRITICAL_SWEEPS = original;
  }
});

// ===========================================================================
// Task #2055 — Producer-side ("enqueue") gating coverage.
//
// `enqueueScheduledTick` is the scheduler producer: every TICK_INTERVAL_MS
// it decides whether to drop ONE deduped job into `work_queue` for the
// worker pool to pick up. It must NOT enqueue when the master enable
// setting is OFF or when the queue is paused — otherwise a default-OFF
// (or operator-paused) deploy would silently flood `work_queue` with
// no-op jobs. These tests pin that gating against the real `enqueueJob`
// + `work_queue` table (the recovery stub is irrelevant here — the
// producer never reaches the recovery pipeline).
// ===========================================================================

const { enqueueScheduledTick } = __frontOutboundGapCloseTestHelpers;

test("enqueue: skips entirely when SETTING_ENABLED is OFF (default)", async () => {
  await clearEnqueuedGapCloseJobs();
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  // Queue not paused — disabled is the only reason it should skip.
  await setQueuePause(QUEUE_NAME, false, "system");
  _resetQueueDrainStateForTests();

  await enqueueScheduledTick();

  assert.equal(
    await countEnqueuedGapCloseJobs(),
    0,
    "no job may be enqueued while the master enable setting is OFF",
  );
});

test("enqueue: skips entirely when the queue is paused", async () => {
  await clearEnqueuedGapCloseJobs();
  // Enabled — so the ONLY reason it should skip is the queue pause.
  await setSystemSetting(SETTING_ENABLED, "true", "system");
  await setQueuePause(QUEUE_NAME, true, "test");

  try {
    await enqueueScheduledTick();

    assert.equal(
      await countEnqueuedGapCloseJobs(),
      0,
      "no job may be enqueued while the queue is paused via queue_drain_state",
    );
  } finally {
    await setQueuePause(QUEUE_NAME, false, "test");
    _resetQueueDrainStateForTests();
  }
});

test("enqueue: a single deduped job is enqueued per tick bucket when enabled and not paused", async () => {
  await clearEnqueuedGapCloseJobs();
  await setSystemSetting(SETTING_ENABLED, "true", "system");
  await setQueuePause(QUEUE_NAME, false, "system");
  _resetQueueDrainStateForTests();

  // Two enqueues in immediate succession fall in the same
  // TICK_INTERVAL_MS bucket, so they share a dedupeKey and the second
  // is deduped against the first's pending row.
  await enqueueScheduledTick();
  await enqueueScheduledTick();

  assert.equal(
    await countEnqueuedGapCloseJobs(),
    1,
    "two ticks in the same interval bucket must collapse to one deduped job",
  );
});

// ===========================================================================
// Task #2072 — Last-run status readout round-trip coverage.
//
// Operators rely on the persisted "last run" summary to see what the
// closer last attempted/skipped (and why) without scraping worker logs.
// These pin the write/read round-trip backed by the
// `front_outbound_gap_close_last_run` system setting: a tick must
// persist a summary that reads back with matching fields, and the reader
// must degrade gracefully (null, never throw) when nothing has run yet
// or the stored value is corrupt.
// ===========================================================================

test("runOutboundGapCloseTick persists a summary that getLastOutboundGapCloseRun reads back with matching fields", async () => {
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
  // Disabled is the deterministic, side-effect-free path: it persists a
  // complete summary (enabled/paused/reason/attempted) without spawning
  // recovery, which is all the round-trip needs to exercise.
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});

  const result = await runOutboundGapCloseTick();
  const readBack = await getLastOutboundGapCloseRun();

  assert.ok(readBack, "a last-run summary must be persisted after a tick");
  assert.equal(readBack!.enabled, result.enabled, "enabled field round-trips");
  assert.equal(readBack!.paused, result.paused, "paused field round-trips");
  assert.equal(readBack!.reason, result.reason, "reason field round-trips");
  assert.deepEqual(
    readBack!.attempted,
    result.attempted,
    "attempted field round-trips",
  );
  assert.equal(readBack!.ranAt, result.ranAt, "ranAt field round-trips");
  // Full structural parity: the readout is exactly what the tick returned.
  assert.deepEqual(
    readBack,
    JSON.parse(JSON.stringify(result)),
    "the persisted readout matches the tick result exactly",
  );
});

test("getLastOutboundGapCloseRun returns null before any run and tolerates an unparseable stored value", async () => {
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
  assert.equal(
    await getLastOutboundGapCloseRun(),
    null,
    "null when nothing has run yet",
  );

  // A corrupt / unparseable JSON value must not throw — the reader
  // swallows the parse error and reports null so the status route stays
  // up even with a poisoned setting.
  await setSystemSetting(SETTING_LAST_RUN, "{not valid json", "system");
  let threw = false;
  let res: Awaited<ReturnType<typeof getLastOutboundGapCloseRun>> | undefined;
  try {
    res = await getLastOutboundGapCloseRun();
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "an unparseable stored value must not throw");
  assert.equal(res, null, "an unparseable stored value reads back as null");

  // Parseable-but-non-object JSON (e.g. a bare number) is also rejected.
  await setSystemSetting(SETTING_LAST_RUN, "123", "system");
  assert.equal(
    await getLastOutboundGapCloseRun(),
    null,
    "a parseable non-object value reads back as null",
  );
});

// ===========================================================================
// Task #2054 — Populated last-run summary round-trip.
//
// The Task #2072 round-trip test above exercises only the disabled path,
// whose summary carries an EMPTY `attempted` array. A regression in
// serializing the populated, nested `attempted[]` entries (each a
// GapMonthAttempt with month/outcome/remainingGap/recoveryJobId) would
// slip past it. This drives the fully-enabled recovery path so the
// persisted readout carries real GapMonthAttempt rows, then asserts the
// round-trip preserves them field-for-field.
//
// Robustness on the shared dev DB: the persisted readout is compared
// against the exact same tick result (two snapshots of one tick), so the
// full-object parity assertion is independent of how many *other*
// coverage rows exist. The populated-shape assertions are scoped to the
// two far-future fixtures (R_A / R_B) — whose astronomically large gaps
// sort them to the top under `ORDER BY messages_outbound_gap DESC` — so
// they remain selected regardless of any real gap months the concurrent
// dev server may have written. A generous per-tick budget guarantees
// both fixtures fit in the selection.
// ===========================================================================

test("runOutboundGapCloseTick persists a populated attempted[] summary that round-trips field-for-field", async () => {
  await clearRecoveryMonths();
  __resetRecovery();
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});

  // Two huge-gap months, no local rows → both stay positive and trigger
  // recovery, producing a non-trivial `attempted[]` in the summary.
  await seedRecoveryReadyMonths();
  // Generous budget (the module's hard cap) so both fixtures fit even
  // when real coverage rows are present on the shared dev DB.
  await enableAllGates(12);

  const result = await runOutboundGapCloseTick();
  // Scope the populated-shape assertions to the two fixtures so the
  // presence of unrelated real coverage rows can't perturb the test.
  const mine = result.attempted.filter(
    (a) => a.month === R_A || a.month === R_B,
  );
  assert.equal(
    mine.length,
    2,
    "both far-future fixtures are attempted (top-gap, within the budget)",
  );
  assert.ok(
    mine.every(
      (a) =>
        a.outcome === "recovery_triggered" &&
        typeof a.recoveryJobId === "string" &&
        a.recoveryJobId.length > 0,
    ),
    "both fixture attempts carry a recovery job id (the non-trivial nested shape)",
  );

  const readBack = await getLastOutboundGapCloseRun();
  assert.ok(
    readBack,
    "a last-run summary must be persisted after a populated tick",
  );
  assert.deepEqual(
    readBack,
    JSON.parse(JSON.stringify(result)),
    "the persisted readout matches the populated tick result exactly",
  );
  // Spot-check the nested fixture entries explicitly survived the JSON
  // round-trip (independent of any other months in the summary).
  const project = (a: (typeof mine)[number]) => [
    a.month,
    a.outcome,
    a.remainingGap,
    a.recoveryJobId,
  ];
  const readMine = readBack!.attempted.filter(
    (a) => a.month === R_A || a.month === R_B,
  );
  assert.deepEqual(
    readMine.map(project),
    mine.map(project),
    "each fixture GapMonthAttempt round-trips field-for-field",
  );
});
