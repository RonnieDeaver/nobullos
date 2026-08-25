/* test-registration
{
  "name": "Front auto-closure scheduler dedupe collapse (Task #2549)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2549 — Verify rapid repeated auto-closure nudges don't pile up
 * duplicate jobs.
 *
 * Task #2514 covered the Front auto-closure scheduler's safety gates and
 * the single open-gate enqueue, but NOT the burst-collapse behavior that
 * protects the work queue from a flurry of operator presses or
 * overlapping timer ticks landing in the same window. Two independent
 * layers provide that protection (see frontAutoClosureScheduler.ts):
 *
 *   1. The in-flight DB pre-check inside `evaluateFrontAutoClosureGates`:
 *      once a `front_auto_closure_tick` row is pending/processing/leased,
 *      every subsequent enqueue attempt no-ops with
 *      `inflight_job_present`. This collapses the realistic SEQUENTIAL
 *      double-press.
 *   2. The per-bucket dedupe key
 *      (`front_auto_closure_tick:<trigger>:<bucket>`) on `enqueueJob`:
 *      even if two enqueues slip PAST the pre-check at the same instant
 *      (a true concurrent race the pre-check alone can't guarantee), the
 *      `wq_dedupe_key_idx` unique index collapses them to one row.
 *
 * This suite exercises BOTH:
 *   A. Two sequential `enqueueManualFrontAutoClosureTick()` presses in the
 *      same window leave exactly one `front_auto_closure_tick` row, with
 *      the second press refused (the in-flight gate).
 *   B. Two `enqueueJob` calls carrying the identical manual per-bucket
 *      dedupe key (the bucket the manual path computes) return the same
 *      job id and leave exactly one row — proving the dedupe key itself
 *      collapses duplicates regardless of the pre-check.
 *
 * Stays off real Front by writing a fake `front_access_token`
 * system-setting value (the gate only checks token *presence*; it never
 * calls Front). Pins every shared `system_settings` switch it reads —
 * the scheduler-enabled flag, the queue pause state, the kill switch, and
 * the Front token — backing each up and restoring it in `finally` so a
 * SIGKILL'd sibling can't leave the dev DB contaminated and this suite is
 * deterministic regardless of leftover global state. Cleans up every
 * work_queue row it enqueues.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2514 (the gate/single-enqueue coverage this complements),
 *   #2501 (the scheduler-stubbing prod-action safety-net),
 *   #2379 (shared-DB global-switch pin+restore contract).
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db, runWithWorkerDb } from "../server/db";
import { storage } from "../server/storage";
import { PERF } from "../server/perfConfig";
import { enqueueJob } from "../server/services/workScheduler";
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
  enqueueManualFrontAutoClosureTick,
  FRONT_AUTO_CLOSURE_TICK_QUEUE,
  SCHEDULER_ENABLED_SETTING,
  MANUAL_DEDUPE_BUCKET_MS,
} from "../server/services/frontAutoClosureScheduler";

const FRONT_ACCESS_TOKEN_KEY = "front_access_token";
const FAKE_TOKEN = "test-fake-front-token-2549";

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

// Bring every gate to its OPEN value with no in-flight tick rows so each
// scenario starts from a clean, all-open baseline.
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
  // ── A. Two sequential manual presses collapse to a single row. ──────
  // The second press sees the first press's pending row and no-ops via
  // the in-flight gate, so the queue never stacks duplicates.
  await setOpenBaseline();
  {
    assert.equal(await countInflightTickRows(), 0, "baseline has no in-flight tick rows");

    const first = await enqueueManualFrontAutoClosureTick();
    assert.equal(first.enqueued, true, "the first press of an open gate enqueues");
    assert.equal((first as any).trigger, "manual", "the enqueued job is the manual trigger");

    const second = await enqueueManualFrontAutoClosureTick();
    assert.equal(second.enqueued, false, "the second press in the same window must collapse");
    assert.equal(
      (second as any).reason,
      "inflight_job_present",
      "the second press is refused because the first press's row is still in flight",
    );

    assert.equal(
      await countInflightTickRows(),
      1,
      "two rapid presses leave exactly one front_auto_closure_tick row, not two",
    );
  }
  await deleteInflightTickRows();

  // ── B. The per-bucket dedupe key collapses identical enqueues even if
  // two slip past the in-flight pre-check at the same instant (the true
  // concurrent race the pre-check alone can't guarantee). We replicate
  // the exact dedupe key the manual path builds and enqueue twice. ─────
  await setOpenBaseline();
  {
    assert.equal(await countInflightTickRows(), 0, "baseline has no in-flight tick rows");

    const bucket = Math.floor(Date.now() / MANUAL_DEDUPE_BUCKET_MS);
    const dedupeKey = `${FRONT_AUTO_CLOSURE_TICK_QUEUE}:manual:${bucket}`;
    const enqueueOnce = () =>
      runWithWorkerDb(() =>
        enqueueJob({
          queueName: FRONT_AUTO_CLOSURE_TICK_QUEUE,
          workloadClass: "maintenance",
          priority: 200,
          payload: { trigger: "manual", bucket },
          dedupeKey,
          maxAttempts: 2,
        }),
      );

    const id1 = await enqueueOnce();
    const id2 = await enqueueOnce();

    assert.equal(
      id2,
      id1,
      "a duplicate dedupe-keyed enqueue returns the existing job id, it does not create a new one",
    );
    assert.equal(
      await countInflightTickRows(),
      1,
      "the per-bucket dedupe key collapses both enqueues into a single work_queue row",
    );
  }
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

console.log("front-auto-closure-scheduler-dedupe.test.ts: OK");
