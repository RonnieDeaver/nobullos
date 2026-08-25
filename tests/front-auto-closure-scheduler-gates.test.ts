/* test-registration
{
  "name": "Front auto-closure scheduler safety gates (Task #2514)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2514 — Direct unit coverage for the Front auto-closure scheduler's
 * own safety gates.
 *
 * Task #2501 added a safety-net for the CEO prod-action wrapper
 * (`triggerFrontAutoClosureTickAction`) but did so by *stubbing out* the
 * scheduler module, so the real decision logic in
 * `server/services/frontAutoClosureScheduler.ts` —
 * `evaluateFrontAutoClosureGates` and the `enqueueWithGate` path behind
 * `enqueueManualFrontAutoClosureTick` — has no direct coverage. A
 * regression there (a gate silently flipped open, the manual/scheduled
 * trigger distinction lost, or the no-op-when-closed enqueue guard
 * removed) would break the self-heal loop without the #2501 test noticing.
 *
 * This test exercises the REAL gate function against the dev DB, flipping
 * exactly one condition at a time off an all-open baseline:
 *   1. each documented closed reason — perf flag off, queue paused, the
 *      `non_critical_sweeps` kill switch on, no Front access token, an
 *      in-flight tick row — and `{ open: true }` when every gate passes.
 *   2. `"manual"` skips the scheduler-enabled setting while `"scheduled"`
 *      honors it.
 *   3. `enqueueManualFrontAutoClosureTick()` no-ops (enqueues nothing) when
 *      a gate is closed and enqueues exactly one job when open.
 *
 * Stays off real Front by writing a fake `front_access_token`
 * system-setting value (the gate only checks token *presence*; it never
 * calls Front). Pins every shared `system_settings` switch it reads —
 * the scheduler-enabled flag, the queue pause state, the kill switch, and
 * the Front token — backing each up and restoring it in `finally` so a
 * SIGKILL'd sibling can't leave the dev DB contaminated and this suite is
 * deterministic regardless of leftover global state.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2501 (the scheduler-stubbing prod-action safety-net this complements),
 *   #2499 (settled-state contract that depends on these gate reasons),
 *   #2379 (shared-DB global-switch pin+restore contract).
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db, runWithWorkerDb } from "../server/db";
import { storage } from "../server/storage";
import { PERF } from "../server/perfConfig";
import {
  setQueuePause,
  isQueuePaused,
  ensureQueueDrainStateLoaded,
} from "../server/services/queueDrainControl";
import {
  setKillSwitch,
  isKillSwitchEnabled,
  ensureKillSwitchesLoaded,
} from "../server/services/killSwitches";
import {
  evaluateFrontAutoClosureGates,
  enqueueManualFrontAutoClosureTick,
  FRONT_AUTO_CLOSURE_TICK_QUEUE,
  SCHEDULER_ENABLED_SETTING,
} from "../server/services/frontAutoClosureScheduler";

const FRONT_ACCESS_TOKEN_KEY = "front_access_token";
const FAKE_TOKEN = "test-fake-front-token-2514";

// ── DB helpers (dev DB; FRONT_AUTO_CLOSURE_TICK_QUEUE is an enqueue-only
// self-heal tick, so pruning its inert pending rows is harmless). ──────
async function countInflightTickRows(): Promise<number> {
  const res: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM work_queue
    WHERE queue_name = ${FRONT_AUTO_CLOSURE_TICK_QUEUE}
      AND status IN ('pending', 'processing', 'leased')
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function deleteInflightTickRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM work_queue
    WHERE queue_name = ${FRONT_AUTO_CLOSURE_TICK_QUEUE}
      AND status IN ('pending', 'processing', 'leased')
  `);
}

async function insertInflightTickRow(): Promise<void> {
  await db.execute(sql`
    INSERT INTO work_queue (queue_name, job_type, workload_class, status, dedupe_key)
    VALUES (
      ${FRONT_AUTO_CLOSURE_TICK_QUEUE},
      ${FRONT_AUTO_CLOSURE_TICK_QUEUE},
      'maintenance',
      'pending',
      ${"test-2514-inflight-" + Date.now()}
    )
  `);
}

const gate = (trigger: "scheduled" | "manual" = "manual") =>
  runWithWorkerDb(() => evaluateFrontAutoClosureGates(trigger));

// Bring every gate to its OPEN value so each test can flip exactly one.
async function setOpenBaseline(): Promise<void> {
  PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED = true;
  await storage.setSystemSetting(SCHEDULER_ENABLED_SETTING, "true");
  await setQueuePause(FRONT_AUTO_CLOSURE_TICK_QUEUE, false);
  await setKillSwitch("non_critical_sweeps", false);
  await storage.setSystemSetting(FRONT_ACCESS_TOKEN_KEY, FAKE_TOKEN);
  await deleteInflightTickRows();
}

// ── Back up shared state so a SIGKILL'd sibling can't leave it dirty. ──
await ensureQueueDrainStateLoaded();
await ensureKillSwitchesLoaded();
const ORIG_PERF_FLAG = PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED;
const ORIG_SCHED_SETTING = (await storage.getSystemSetting(SCHEDULER_ENABLED_SETTING))?.value ?? null;
const ORIG_TOKEN = (await storage.getSystemSetting(FRONT_ACCESS_TOKEN_KEY))?.value ?? null;
const ORIG_QUEUE_PAUSED = isQueuePaused(FRONT_AUTO_CLOSURE_TICK_QUEUE);
const ORIG_KILL = isKillSwitchEnabled("non_critical_sweeps");

try {
  // ── 1. Each closed reason in isolation, plus the all-open pass. ──────

  // perf flag off → perf_flag_disabled (checked before any DB read).
  await setOpenBaseline();
  PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED = false;
  {
    const g = await gate("manual");
    assert.deepEqual(g, { open: false, reason: "perf_flag_disabled" },
      "perf flag off → perf_flag_disabled");
  }

  // queue paused → queue_paused.
  await setOpenBaseline();
  await setQueuePause(FRONT_AUTO_CLOSURE_TICK_QUEUE, true);
  {
    const g = await gate("manual");
    assert.equal(g.open, false, "queue paused closes the gate");
    assert.equal((g as any).reason, "queue_paused", "queue paused → queue_paused");
  }

  // non_critical_sweeps kill switch on → non_critical_sweeps_killed.
  await setOpenBaseline();
  await setKillSwitch("non_critical_sweeps", true);
  {
    const g = await gate("manual");
    assert.equal(g.open, false, "kill switch closes the gate");
    assert.equal((g as any).reason, "non_critical_sweeps_killed",
      "non_critical_sweeps on → non_critical_sweeps_killed");
  }

  // no Front access token → front_not_connected.
  await setOpenBaseline();
  await storage.setSystemSetting(FRONT_ACCESS_TOKEN_KEY, "");
  {
    const g = await gate("manual");
    assert.equal(g.open, false, "missing token closes the gate");
    assert.equal((g as any).reason, "front_not_connected",
      "empty token → front_not_connected");
  }

  // an in-flight tick row → inflight_job_present.
  await setOpenBaseline();
  await insertInflightTickRow();
  {
    const g = await gate("manual");
    assert.equal(g.open, false, "an in-flight tick row closes the gate");
    assert.equal((g as any).reason, "inflight_job_present",
      "pending tick row → inflight_job_present");
  }

  // all gates open → { open: true }.
  await setOpenBaseline();
  {
    const g = await gate("manual");
    assert.deepEqual(g, { open: true }, "every gate passing → open");
  }

  // ── 2. manual skips the scheduler-enabled setting; scheduled honors it. ──
  await setOpenBaseline();
  await storage.setSystemSetting(SCHEDULER_ENABLED_SETTING, "false");
  {
    const manual = await gate("manual");
    assert.deepEqual(manual, { open: true },
      "manual trigger ignores the scheduler-enabled setting");
    const scheduled = await gate("scheduled");
    assert.equal(scheduled.open, false, "scheduled honors the disabled setting");
    assert.equal((scheduled as any).reason, "scheduler_setting_disabled",
      "scheduled + setting false → scheduler_setting_disabled");
  }

  // ── 3. enqueueManualFrontAutoClosureTick: no-op closed, one job open. ──

  // Closed gate (queue paused) → no enqueue, no new row.
  await setOpenBaseline();
  await setQueuePause(FRONT_AUTO_CLOSURE_TICK_QUEUE, true);
  {
    const before = await countInflightTickRows();
    const outcome = await enqueueManualFrontAutoClosureTick();
    assert.equal(outcome.enqueued, false, "a closed gate must not enqueue");
    assert.equal((outcome as any).reason, "queue_paused",
      "the refusal carries the closing gate reason");
    const after = await countInflightTickRows();
    assert.equal(after, before, "no work_queue row added when the gate is closed");
  }

  // Open gate → enqueues exactly one job.
  await setOpenBaseline();
  {
    assert.equal(await countInflightTickRows(), 0, "baseline has no in-flight tick rows");
    const outcome = await enqueueManualFrontAutoClosureTick();
    assert.equal(outcome.enqueued, true, "an open gate enqueues");
    assert.equal((outcome as any).trigger, "manual", "the enqueued job is the manual trigger");
    assert.equal(await countInflightTickRows(), 1,
      "exactly one front_auto_closure_tick job is enqueued");
  }
  // Remove the row this test enqueued.
  await deleteInflightTickRows();
} finally {
  // Restore every shared switch we pinned, regardless of outcome.
  PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED = ORIG_PERF_FLAG;
  await storage.setSystemSetting(SCHEDULER_ENABLED_SETTING, ORIG_SCHED_SETTING ?? "");
  await storage.setSystemSetting(FRONT_ACCESS_TOKEN_KEY, ORIG_TOKEN ?? "");
  await setQueuePause(FRONT_AUTO_CLOSURE_TICK_QUEUE, ORIG_QUEUE_PAUSED);
  await setKillSwitch("non_critical_sweeps", ORIG_KILL);
  await deleteInflightTickRows();
}

console.log("front-auto-closure-scheduler-gates.test.ts: OK");
