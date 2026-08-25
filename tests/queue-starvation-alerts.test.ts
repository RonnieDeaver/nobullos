/* test-registration
{
  "name": "Queue starvation alerts (Task #1009)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~2.2s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1009 regression tests: queue starvation alert.
 *
 * Verifies the consecutive-idle-window accounting end-to-end with a
 * stubbed dispatch-counters snapshot and a stubbed dispatcher:
 *   (a) Idle window with pending depth increments the counter but
 *       does not alert until the threshold is reached.
 *   (b) Once the threshold is crossed, an alert fires through
 *       `notifyByType`. Re-evaluating the same window does NOT
 *       double-count.
 *   (c) When the queue dispatches in a later window, the counter
 *       resets and a single "resolved" follow-up is sent.
 *   (d) Paused queues are exempted (no alert + counter held at 0).
 *   (e) Queues with no pending depth are exempted.
 *
 * Uses real worker DB writes for the pending-count read path,
 * matching the `queue-drain-backlog-alerts.test.ts` pattern.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  setQueuePause,
  ensureQueueDrainStateLoaded,
  _resetQueueDrainStateForTests,
} from "../server/services/queueDrainControl";

const MARKER = `t1009_${process.pid}_${Date.now()}`;
const Q_STARVED = `${MARKER}_starved`;
const Q_PAUSED = `${MARKER}_paused`;
const Q_EMPTY = `${MARKER}_empty`;

const SETTING_KEYS = [
  "queue_starvation_alert_enabled",
  "queue_starvation_alert_consecutive_windows",
  "queue_starvation_alert_min_pending",
  "queue_starvation_alert_cooldown_minutes",
  "queue_drain_state",
] as const;

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM work_queue WHERE queue_name LIKE ${MARKER + "_%"}`);
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
}

async function insertPending(queueName: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await workerDb.execute(sql`
      INSERT INTO work_queue (queue_name, job_type, workload_class, payload, status, dedupe_key)
      VALUES (${queueName}, ${queueName}, 'ingestion', '{}'::jsonb, 'pending', ${`${queueName}_${Date.now()}_${i}_${Math.random()}`})
    `);
  }
}

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function makeSnapshot(args: {
  capturedAt: string;
  cycleCount?: number;
  counts: Record<string, number>;
}) {
  return {
    currentWindow: { cycleCount: 0, counts: {} as Record<string, number> },
    lastWindow: {
      capturedAt: args.capturedAt,
      cycleCount: args.cycleCount ?? 60,
      counts: args.counts,
    },
    recentWindows: [],
  };
}

async function run(): Promise<void> {
  await cleanup();
  _resetQueueDrainStateForTests();
  await ensureQueueDrainStateLoaded();

  // Configure thresholds: enabled, fire after 3 consecutive idle
  // windows, minPending 1, 60-minute cooldown.
  await storage.setSystemSetting("queue_starvation_alert_enabled", "true", "system");
  await storage.setSystemSetting("queue_starvation_alert_consecutive_windows", "3", "system");
  await storage.setSystemSetting("queue_starvation_alert_min_pending", "1", "system");
  await storage.setSystemSetting("queue_starvation_alert_cooldown_minutes", "60", "system");

  const watcherMod = await import("../server/services/queueStarvationAlerts");
  watcherMod.__testHelpers.resetStateForTests();

  const calls: DispatchCall[] = [];
  watcherMod.__testHelpers.setDispatcherForTests(async (id, payload, options) => {
    calls.push({ id, text: payload.text, metadata: options.metadata });
    return { delivered: true, status: "sent" };
  });

  // Set up the universe:
  //   Q_STARVED — has pending depth, never dispatches → should alert
  //   Q_PAUSED  — has pending depth, but is paused → no alert
  //   Q_EMPTY   — no pending depth → no alert
  await insertPending(Q_STARVED, 5);
  await insertPending(Q_PAUSED, 5);
  // Q_EMPTY has zero pending.

  await setQueuePause(Q_PAUSED, true, "test");

  let windowSeq = 0;
  const nextWindowCapturedAt = (): string => {
    windowSeq += 1;
    return new Date(2030, 0, 1, 0, windowSeq, 0).toISOString();
  };

  const idleSnapshot = (capturedAt: string) =>
    makeSnapshot({
      capturedAt,
      counts: { [Q_STARVED]: 0, [Q_PAUSED]: 0, [Q_EMPTY]: 0 },
    });

  // ── (a) Idle windows below threshold just increment the counter. ─
  for (let i = 1; i <= 2; i++) {
    const capturedAt = nextWindowCapturedAt();
    watcherMod.__testHelpers.setSnapshotForTests(() => idleSnapshot(capturedAt));
    const r = await watcherMod.checkStarvedQueues();
    assert.equal(r.alertsSent, 0, `tick #${i}: must not alert below threshold`);
    const starved = r.perQueue.find((p) => p.queueName === Q_STARVED);
    assert.ok(starved, `tick #${i}: Q_STARVED should appear`);
    assert.equal(starved!.decision, "incremented_idle");
    assert.equal(starved!.consecutiveIdleWindows, i);
  }

  // ── (b) Crossing the threshold fires exactly one alert. ─────────
  const alertWindowAt = nextWindowCapturedAt();
  watcherMod.__testHelpers.setSnapshotForTests(() => idleSnapshot(alertWindowAt));
  const r3 = await watcherMod.checkStarvedQueues();
  assert.equal(r3.alertsSent, 1, "third idle window crosses threshold and fires");
  assert.equal(calls.length, 1, "dispatcher called once");
  assert.equal(calls[0]!.id, "queue.scheduler.starved");
  assert.match(calls[0]!.text, new RegExp(Q_STARVED));
  assert.equal((calls[0]!.metadata as any)?.event, "starved");

  const starved3 = r3.perQueue.find((p) => p.queueName === Q_STARVED)!;
  assert.equal(starved3.decision, "alerted");
  assert.equal(starved3.consecutiveIdleWindows, 3);

  // (d) Paused queue must be exempted — no alert, counter pinned at 0.
  const paused3 = r3.perQueue.find((p) => p.queueName === Q_PAUSED)!;
  assert.equal(paused3.decision, "skipped_paused");
  assert.equal(paused3.consecutiveIdleWindows, 0);

  // Re-running with the SAME snapshot must not double-count or re-alert.
  const r3b = await watcherMod.checkStarvedQueues();
  assert.equal(r3b.alertsSent, 0, "same window must not be processed twice");
  const starved3b = r3b.perQueue.find((p) => p.queueName === Q_STARVED)!;
  assert.equal(starved3b.decision, "skipped_window_unchanged");
  assert.equal(calls.length, 1, "dispatcher must not be called twice for the same window");

  // ── (c) Recovery: a window with dispatches resets and resolves. ──
  await insertPending(Q_STARVED, 0); // no-op, counts unchanged
  const recoverWindowAt = nextWindowCapturedAt();
  watcherMod.__testHelpers.setSnapshotForTests(() =>
    makeSnapshot({
      capturedAt: recoverWindowAt,
      counts: { [Q_STARVED]: 7, [Q_PAUSED]: 0, [Q_EMPTY]: 0 },
    }),
  );
  const r4 = await watcherMod.checkStarvedQueues();
  assert.equal(r4.resolvesSent, 1, "recovery window must send resolved follow-up");
  assert.equal(r4.alertsSent, 0);
  assert.equal(calls.length, 2, "dispatcher called for the resolved message");
  assert.equal((calls[1]!.metadata as any)?.event, "resolved");
  assert.match(calls[1]!.text, /recovered/);
  const starved4 = r4.perQueue.find((p) => p.queueName === Q_STARVED)!;
  assert.equal(starved4.decision, "resolved");
  assert.equal(starved4.consecutiveIdleWindows, 0);

  // The next idle window must start the counter from 0 again.
  const afterResolveAt = nextWindowCapturedAt();
  watcherMod.__testHelpers.setSnapshotForTests(() => idleSnapshot(afterResolveAt));
  const r5 = await watcherMod.checkStarvedQueues();
  const starved5 = r5.perQueue.find((p) => p.queueName === Q_STARVED)!;
  assert.equal(starved5.decision, "incremented_idle");
  assert.equal(starved5.consecutiveIdleWindows, 1);

  // ── (e) Queue with no pending depth is exempted. ────────────────
  const empty5 = r5.perQueue.find((p) => p.queueName === Q_EMPTY)!;
  assert.equal(empty5.decision, "skipped_below_min_pending");
  assert.equal(empty5.consecutiveIdleWindows, 0);

  watcherMod.__testHelpers.setDispatcherForTests(null);
  watcherMod.__testHelpers.setSnapshotForTests(null);
  watcherMod.__testHelpers.resetStateForTests();

  await cleanup();
  _resetQueueDrainStateForTests();
  console.log("queue-starvation-alerts.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch {}
    process.exitCode = 1;
  });
