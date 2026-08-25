/* test-registration
{
  "name": "Front auto-closure scheduler concurrent dedupe (Task #2575)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2575 — Two operators pressing the auto-closure nudge at the EXACT
 * same time can't double-run it.
 *
 * Task #2549 verified the dedupe collapse for SEQUENTIAL presses (the
 * second press sees the first press's in-flight row and no-ops via the
 * `inflight_job_present` gate) and, separately, that two `enqueueJob`
 * calls carrying the identical per-bucket dedupe key collapse to one row.
 * What #2549 does NOT cover is the truly CONCURRENT case at the SERVICE
 * level: two `enqueueManualFrontAutoClosureTick()` calls fired together
 * with `Promise.all`, so BOTH evaluate the in-flight pre-check before
 * either has inserted its row.
 *
 * In that window the in-flight pre-check (`isAutoClosureTickInFlight`)
 * can legitimately pass for BOTH callers — neither row exists yet — so
 * the pre-check alone cannot guarantee a single job. The ONLY thing that
 * collapses the pair is the per-bucket dedupe key landing on the
 * `wq_dedupe_key_idx` unique index (`onConflictDoNothing`). A regression
 * that dropped the dedupe key (leaving only the pre-check) would still
 * pass #2549's sequential assertions but would silently allow TWO
 * `front_auto_closure_tick` rows under real concurrency — i.e. a real
 * double-run. This suite is the missing concurrent guard for that.
 *
 * What it asserts: from an all-open baseline, two
 * `enqueueManualFrontAutoClosureTick()` fired via `Promise.all` leave
 * EXACTLY ONE `front_auto_closure_tick` row in work_queue.
 *
 * Stays off real Front by writing a fake `front_access_token`
 * system-setting value (the gate only checks token *presence*; it never
 * calls Front). Reuses the pin/restore + cleanup pattern from
 * `tests/front-auto-closure-scheduler-dedupe.test.ts`: it backs up and
 * restores every shared `system_settings` switch it reads (the
 * scheduler-enabled flag, the queue pause state, the non_critical_sweeps
 * kill switch, and the Front token) in `finally` so a SIGKILL'd sibling
 * can't leave the dev DB contaminated, and it cleans up every work_queue
 * row it enqueues.
 *
 * Prior tasks consulted (per replit.md prior-task research rule):
 *   #2549 (the sequential + dedupe-key coverage this complements),
 *   #2514 (the gate/single-enqueue coverage #2549 itself complemented),
 *   #2379 (shared-DB global-switch pin+restore contract).
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
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
  enqueueManualFrontAutoClosureTick,
  FRONT_AUTO_CLOSURE_TICK_QUEUE,
  SCHEDULER_ENABLED_SETTING,
} from "../server/services/frontAutoClosureScheduler";

const FRONT_ACCESS_TOKEN_KEY = "front_access_token";
const FAKE_TOKEN = "test-fake-front-token-2575";

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

// Bring every gate to its OPEN value with no in-flight tick rows so the
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
  // ── Two operators press at the EXACT same time. Fire both manual
  // enqueues via Promise.all so both evaluate the in-flight pre-check
  // before either inserts — the window where only the per-bucket dedupe
  // key (wq_dedupe_key_idx) can keep the queue to a single row. ────────
  // A single concurrent pair only samples one interleaving. A race test is
  // probabilistic by nature, so we repeat the simultaneous-pair attempt a
  // handful of times (cleaning the queue between attempts) to raise the
  // odds of hitting the vulnerable window where both presses clear the
  // in-flight pre-check before either inserts. Every attempt must still
  // collapse to exactly one row — if a regression dropped the dedupe key,
  // at least one attempt across the loop would land two rows and fail.
  const CONCURRENT_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= CONCURRENT_ATTEMPTS; attempt++) {
    await setOpenBaseline();
    assert.equal(
      await countInflightTickRows(),
      0,
      `attempt ${attempt}: baseline has no in-flight tick rows`,
    );

    const [a, b] = await Promise.all([
      enqueueManualFrontAutoClosureTick(),
      enqueueManualFrontAutoClosureTick(),
    ]);

    // Neither concurrent press throws — both return a well-formed
    // outcome. Note: in the true-race window the in-flight pre-check can
    // pass for BOTH, so the service-level result may optimistically
    // report `enqueued: true` for both (the second `enqueueJob` returns
    // the existing row's id without throwing when its insert collapses on
    // the dedupe index). That optimistic report is harmless precisely
    // because the dedupe key — NOT the pre-check — guarantees a single
    // row, which is the real "can't double-run it" protection asserted
    // below. (If a regression dropped the dedupe key, both would still
    // report `enqueued: true` here AND two rows would land — caught by
    // the row-count assertion.)
    for (const r of [a, b]) {
      assert.equal(
        typeof r.enqueued,
        "boolean",
        `attempt ${attempt}: each concurrent press returns a well-formed outcome`,
      );
    }

    assert.equal(
      await countInflightTickRows(),
      1,
      `attempt ${attempt}: two simultaneous presses leave exactly one front_auto_closure_tick row, never two`,
    );

    await deleteInflightTickRows();
  }
} finally {
  // Restore every shared switch we pinned, regardless of outcome.
  PERF.FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED = ORIG_PERF_FLAG;
  await storage.setSystemSetting(SCHEDULER_ENABLED_SETTING, ORIG_SCHED_SETTING ?? "");
  await storage.setSystemSetting(FRONT_ACCESS_TOKEN_KEY, ORIG_TOKEN ?? "");
  await setQueuePause(FRONT_AUTO_CLOSURE_TICK_QUEUE, ORIG_QUEUE_PAUSED);
  await setKillSwitch("non_critical_sweeps", ORIG_KILL);
  await deleteInflightTickRows();
}

console.log("front-auto-closure-scheduler-concurrent-dedupe.test.ts: OK");
