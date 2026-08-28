/* test-registration
{
  "name": "Queue drain backlog alerts (Task #998)",
  "tier": "small"
}
test-registration */
/**
 * Task #998 regression tests: paused-queue backlog growth alert.
 *
 * Covers the cooldown-vs-pause-cycle interaction the code review flagged:
 *   (a) first alert after resume/re-pause within the cooldown window must fire,
 *   (b) cooldown suppression within the same pause cycle works,
 *   (c) re-alert fires when backlog grows by another full growthThreshold
 *       since the last alert (even within cooldown).
 *
 * Stubs the dispatcher so no Slack call is made; uses the real worker DB
 * for `work_queue` reads (matching the existing `work-queue-scheduler.test.ts`
 * pattern).
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

const MARKER = `t998_${process.pid}_${Date.now()}`;
const Q = `${MARKER}_paused`;

const SETTING_KEYS = [
  "queue_drain_backlog_alert_enabled",
  "queue_drain_backlog_alert_hours_threshold",
  "queue_drain_backlog_alert_growth_threshold",
  "queue_drain_backlog_alert_cooldown_minutes",
  "queue_drain_state",
] as const;

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM work_queue WHERE queue_name LIKE ${MARKER + "_%"}`);
  // Task #1821: defensive — also drop any queue_drain_state entries that
  // mention this test's MARKER queue name. We do NOT delete the whole
  // `queue_drain_state` setting because other tests / live drain UI
  // share it; we only strip our own keys so re-runs start clean and a
  // crashed prior invocation can't leave a stale paused=true entry that
  // would make `loadPausedQueues()` return more queues than the test
  // seeded, flipping the `r3.alertsSent === 1` assertion at L138.
  try {
    const row = await storage.getSystemSetting("queue_drain_state");
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      let changed = false;
      for (const key of Object.keys(parsed)) {
        if (key.startsWith(MARKER + "_")) {
          delete parsed[key];
          changed = true;
        }
      }
      if (changed) {
        await storage.setSystemSetting(
          "queue_drain_state",
          JSON.stringify(parsed),
          "system",
        );
      }
    }
  } catch {}
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

/**
 * Force the persisted `queue_drain_state` so the snapshot reads what we want
 * (paused, with a specific pausedAt + baseline) without sleeping for hours.
 */
async function forceDrainState(queueName: string, pausedAtIso: string, baseline: number): Promise<void> {
  const value = JSON.stringify({
    [queueName]: {
      paused: true,
      ratePerMinute: null,
      updatedAt: pausedAtIso,
      updatedBy: "test",
      pausedAt: pausedAtIso,
      pausedAtBacklog: baseline,
    },
  });
  await storage.setSystemSetting("queue_drain_state", value, "system");
  _resetQueueDrainStateForTests();
  await ensureQueueDrainStateLoaded();
}

interface DispatchCall {
  id: string;
  text: string;
}

async function installDispatcherStub(calls: DispatchCall[], outcome: { delivered: boolean; status?: string; skipReason?: string } = { delivered: true }) {
  const mod = await import("../server/services/queueDrainBacklogAlerts");
  mod.__testHelpers.setDispatcherForTests(async (id, payload) => {
    calls.push({ id, text: payload.text });
    return {
      delivered: outcome.delivered,
      status: outcome.status ?? (outcome.delivered ? "sent" : "failed"),
      skipReason: outcome.skipReason,
    };
  });
  return () => {
    mod.__testHelpers.setDispatcherForTests(null);
  };
}

async function run(): Promise<void> {
  await cleanup();
  _resetQueueDrainStateForTests();
  await ensureQueueDrainStateLoaded();

  // Configure thresholds: 1h paused, +5 growth, 60min cooldown.
  await storage.setSystemSetting("queue_drain_backlog_alert_enabled", "true", "system");
  await storage.setSystemSetting("queue_drain_backlog_alert_hours_threshold", "1", "system");
  await storage.setSystemSetting("queue_drain_backlog_alert_growth_threshold", "5", "system");
  await storage.setSystemSetting("queue_drain_backlog_alert_cooldown_minutes", "60", "system");

  // Re-import the watcher AFTER setting up stubs so its module-scoped cache is fresh.
  const watcherMod = await import("../server/services/queueDrainBacklogAlerts");
  watcherMod.__testHelpers.resetLastAlertCache();

  // ── (b) cooldown suppression within the same pause cycle ───────────
  // Pause "long ago" with baseline 0 and create 10 pending jobs (growth
  // = +10, well over the +5 threshold).
  const pausedAtA = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await forceDrainState(Q, pausedAtA, 0);
  await insertPending(Q, 10);

  const callsA: DispatchCall[] = [];
  let restoreA = await installDispatcherStub(callsA);
  let r1 = await watcherMod.checkPausedQueueBacklogs();
  assert.equal(r1.alertsSent, 1, "first tick must fire an alert");
  assert.equal(callsA.length, 1, "dispatcher must be called once");
  assert.equal(callsA[0]!.id, "queue.drain_control.paused_backlog_growing");

  // Second tick immediately — no growth since last alert; cooldown active.
  let r2 = await watcherMod.checkPausedQueueBacklogs();
  assert.equal(r2.alertsSent, 0, "second tick within cooldown must NOT re-alert");
  const decisionR2 = r2.perQueue.find((p) => p.queueName === Q)?.decision;
  assert.ok(
    decisionR2 === "skipped_no_growth_since_last_alert" || decisionR2 === "skipped_cooldown",
    `expected cooldown-related skip, got: ${decisionR2}`,
  );
  restoreA();

  // ── (c) re-alert when backlog grows by another full growthThreshold ─
  // Add +5 more pending jobs (now +15 vs baseline, +5 since last alert).
  await insertPending(Q, 5);
  const callsC: DispatchCall[] = [];
  const restoreC = await installDispatcherStub(callsC);
  const r3 = await watcherMod.checkPausedQueueBacklogs();
  assert.equal(
    r3.alertsSent,
    1,
    "must re-alert when growth-since-last ≥ growthThreshold even within cooldown",
  );
  restoreC();

  // ── (a) first alert of a NEW pause cycle must fire even if the prior
  //        cycle's cooldown is still in effect ───────────────────────
  // Simulate resume + re-pause: the cache record for Q is still warm
  // from above. Real `setQueuePause(false) → setQueuePause(true)` would
  // change `pausedAt`. Mimic that by writing a brand-new pause cycle
  // directly into the persisted state (still "long ago" so we're past
  // the hours threshold).
  const pausedAtB = new Date(Date.now() - 3 * 3_600_000).toISOString();
  assert.notEqual(pausedAtB, pausedAtA, "pause cycles must have distinct pausedAt");
  // Resume bookkeeping — clear the prior cycle's pendings so the new
  // baseline is meaningful.
  await workerDb.execute(sql`DELETE FROM work_queue WHERE queue_name = ${Q}`);
  await forceDrainState(Q, pausedAtB, 0);
  await insertPending(Q, 8); // growth = +8 ≥ threshold

  const callsB: DispatchCall[] = [];
  const restoreB = await installDispatcherStub(callsB);
  const r4 = await watcherMod.checkPausedQueueBacklogs();
  assert.equal(
    r4.alertsSent,
    1,
    "first alert of a NEW pause cycle must fire even if old cooldown record exists",
  );
  assert.equal(callsB.length, 1);
  restoreB();

  await cleanup();
  _resetQueueDrainStateForTests();
  console.log("queue-drain-backlog-alerts.test.ts: OK");
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
