/* test-registration
{
  "name": "LocalDominance/Semrush parity watchers (workers parity E-F15/E-F16)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy focused watcher suite covering the two custom-table pipeline watchers (predicates + once-per-streak alert state with recovery re-arm), mirroring the sweep-only call-archive watcher template; runs in the full suite and the nightly --regression sweep rather than the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Workers/queues parity (E-F15/E-F16) — focused suite for the two
 * stale/stuck watchers and their once-per-streak alert state (the Google
 * Drive staleness watcher was retired with the Drive integration, Task
 * #4084):
 *
 *  - localDominanceStuckSyncAlerts (`queue.local_dominance_sync.stuck_rows`):
 *    predicate (in_progress past cutoff; fresh active rows stay quiet),
 *    streak fire-once (count growth does NOT re-fire), recovery re-arm —
 *    and it KEEPS firing while the local_dominance_sync switch is on
 *    (stuck rows cannot self-heal during an operator stop);
 *  - semrushAutoRetryOverdueAlerts (`queue.semrush_auto_retry.overdue_rows`):
 *    predicate (failed + next_retry_at overdue; NULL/future/terminal rows
 *    stay quiet), streak fire-once, kill-switch skip that leaves streak
 *    state untouched, disabled skip that leaves streak state untouched,
 *    recovery re-arm;
 *  - dedupe isolation: notification ids AND health-state dedupe keys are
 *    pairwise distinct across the queue watchers.
 *
 * Dispatchers + markRecovered are stubbed via each watcher's
 * __testHelpers; settings are pinned and restored; kill switches restored
 * to OFF in finally.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import { setKillSwitch } from "../server/services/killSwitches";
import {
  __testHelpers as ldHelpers,
  checkLocalDominanceStuckSync,
  SETTING_ENABLED as LD_ENABLED,
  SETTING_AGE_MINUTES as LD_AGE,
  SETTING_COUNT as LD_COUNT,
} from "../server/services/localDominanceStuckSyncAlerts";
import {
  __testHelpers as srHelpers,
  checkSemrushAutoRetryOverdue,
  SETTING_ENABLED as SR_ENABLED,
  SETTING_AGE_MINUTES as SR_AGE,
  SETTING_COUNT as SR_COUNT,
} from "../server/services/semrushAutoRetryOverdueAlerts";
import { __testHelpers as caHelpers } from "../server/services/callAnalysisStuckProcessingAlerts";

const MARKER = `t_parity_w_${process.pid}_${Date.now()}`;

const ALL_SETTINGS = [
  LD_ENABLED, LD_AGE, LD_COUNT,
  SR_ENABLED, SR_AGE, SR_COUNT,
] as const;

interface DispatchCall {
  id: string;
  text: string;
  dedupeKey?: string;
  bypassDedupe?: boolean;
  metadata?: Record<string, unknown>;
}
type WatcherHelpers = {
  setDispatcherForTests(fn: any): void;
  setMarkRecoveredForTests(fn: any): void;
};
function stub(helpers: WatcherHelpers, calls: DispatchCall[]) {
  helpers.setDispatcherForTests(async (
    id: string,
    payload: { text: string },
    options: { dedupeKey?: string; bypassDedupe?: boolean; metadata?: Record<string, unknown> },
  ) => {
    calls.push({
      id,
      text: payload.text,
      dedupeKey: options.dedupeKey,
      bypassDedupe: options.bypassDedupe,
      metadata: options.metadata,
    });
    return { delivered: true, status: "sent" };
  });
}
function stubMarkRecovered(helpers: WatcherHelpers, recoveries: Array<{ id: string; dedupeKey: string }>) {
  helpers.setMarkRecoveredForTests(async (id: string, dedupeKey: string) => {
    recoveries.push({ id, dedupeKey });
  });
}

let clientId = "";
let locationId = "";

async function seedParents(): Promise<void> {
  const cr = await workerDb.execute(sql`INSERT INTO clients (firm_name) VALUES (${`${MARKER} Firm`}) RETURNING id`);
  clientId = String((cr.rows?.[0] as any)?.id);
  const lr = await workerDb.execute(sql`INSERT INTO client_locations (client_id, name) VALUES (${clientId}, ${`${MARKER} Loc`}) RETURNING id`);
  locationId = String((lr.rows?.[0] as any)?.id);
}

async function insertSyncRow(opts: {
  status: string;
  lastAttemptOffsetMs?: number | null;
  nextRetryOffsetMs?: number | null;
}): Promise<string> {
  const iv = (ms: number | null | undefined) =>
    ms == null ? sql`NULL` : sql`NOW() + (${Math.round(ms / 1000)} || ' seconds')::interval`;
  const r = await workerDb.execute(sql`
    INSERT INTO semrush_location_sync_state
      (client_id, location_id, campaign_id, status, attempt_count, max_attempts,
       last_attempt_at, next_retry_at, created_at, updated_at)
    VALUES
      (${clientId}, ${locationId}, ${`${MARKER}_camp_${randomUUID().slice(0, 8)}`}, ${opts.status}, 1, 3,
       ${iv(opts.lastAttemptOffsetMs)}, ${iv(opts.nextRetryOffsetMs)}, NOW(), NOW())
    RETURNING id
  `);
  return String((r.rows?.[0] as any)?.id);
}

async function cleanup(): Promise<void> {
  if (clientId) {
    await workerDb.execute(sql`DELETE FROM semrush_location_sync_state WHERE client_id = ${clientId}`);
    await workerDb.execute(sql`DELETE FROM client_locations WHERE client_id = ${clientId}`);
    await workerDb.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  }
  for (const k of ALL_SETTINGS) {
    try { await storage.deleteSystemSetting(k); } catch {}
  }
  try { await storage.deleteSystemSetting("kill_switch_local_dominance_sync"); } catch {}
  try { await storage.deleteSystemSetting("kill_switch_auto_retry"); } catch {}
  for (const h of [ldHelpers, srHelpers]) {
    h.resetLastAlertCache();
    h.setDispatcherForTests(null);
    h.setMarkRecoveredForTests(null);
  }
}

async function main(): Promise<void> {
  await seedParents();
  // Prune litter a SIGKILL'd earlier suite may have left: these watchers
  // count table-wide, so stray rows would skew counts/decisions. The
  // hermetic per-run DB holds only test fixtures — safe to clear.
  await workerDb.execute(sql`
    DELETE FROM semrush_location_sync_state
    WHERE (status = 'in_progress' AND last_attempt_at <= NOW() - interval '240 minutes')
       OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW() - interval '60 minutes')
  `);
  try {
    // ------------------------------------------------------------------
    // 0. Dedupe isolation across the queue watchers: notification ids AND
    //    health-state dedupe keys are pairwise distinct namespaces.
    // ------------------------------------------------------------------
    {
      const ids = [
        caHelpers.NOTIFICATION_ID,
        ldHelpers.NOTIFICATION_ID,
        srHelpers.NOTIFICATION_ID,
      ];
      assert.equal(new Set(ids).size, ids.length, `watcher notification ids must be pairwise distinct: ${ids.join(", ")}`);
      assert.equal(ldHelpers.NOTIFICATION_ID, "queue.local_dominance_sync.stuck_rows");
      assert.equal(srHelpers.NOTIFICATION_ID, "queue.semrush_auto_retry.overdue_rows");
      const keys = [
        ldHelpers.DEDUPE_KEY,
        srHelpers.DEDUPE_KEY,
      ];
      assert.equal(new Set(keys).size, keys.length, `watcher dedupe keys must be pairwise distinct: ${keys.join(", ")}`);
      assert.equal(ldHelpers.DEDUPE_KEY, "local_dominance_sync:stuck_rows");
      assert.equal(srHelpers.DEDUPE_KEY, "semrush_auto_retry:overdue_rows");
      console.log("PASS: watcher notification ids + dedupe keys pairwise distinct");
    }

    // ------------------------------------------------------------------
    // 1. Local Dominance stuck-in_progress watcher — streak lifecycle.
    // ------------------------------------------------------------------
    {
      const calls: DispatchCall[] = [];
      const recoveries: Array<{ id: string; dedupeKey: string }> = [];
      stub(ldHelpers, calls);
      stubMarkRecovered(ldHelpers, recoveries);
      await storage.setSystemSetting(LD_ENABLED, "true", "test");
      await storage.setSystemSetting(LD_AGE, "240", "test");
      await storage.setSystemSetting(LD_COUNT, "1", "test");

      // Fresh in_progress (healthy active lease) + terminal rows: quiet,
      // and the healthy observation re-arms.
      await insertSyncRow({ status: "in_progress", lastAttemptOffsetMs: -10 * 60_000 });
      await insertSyncRow({ status: "succeeded", lastAttemptOffsetMs: -500 * 60_000 });
      const r1 = await checkLocalDominanceStuckSync();
      assert.equal(r1.decision, "skipped_below_threshold", `fresh/terminal rows don't count (got ${r1.decision}, count=${r1.count})`);
      assert.equal(r1.count, 0);
      assert.equal(recoveries.length, 1, "healthy observation calls markRecovered");
      assert.equal(recoveries[0].dedupeKey, ldHelpers.DEDUPE_KEY);

      // Stuck row past the 240min cutoff: alerts once.
      await insertSyncRow({ status: "in_progress", lastAttemptOffsetMs: -300 * 60_000 });
      const r2 = await checkLocalDominanceStuckSync();
      assert.equal(r2.decision, "alerted");
      assert.equal(r2.count, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, "queue.local_dominance_sync.stuck_rows");
      assert.equal(calls[0].dedupeKey, ldHelpers.DEDUPE_KEY, "dispatch carries the health-state dedupe key");
      assert.ok(!calls[0].bypassDedupe, "transition dedupe must NOT be bypassed");

      // Same streak: suppressed.
      const r3 = await checkLocalDominanceStuckSync();
      assert.equal(r3.decision, "skipped_streak_already_alerted");
      assert.equal(calls.length, 1);

      // Count GROWTH within the same streak: still one page per streak —
      // the page already says the worker/recovery is not running.
      await insertSyncRow({ status: "in_progress", lastAttemptOffsetMs: -400 * 60_000 });
      const r4 = await checkLocalDominanceStuckSync();
      assert.equal(r4.decision, "skipped_streak_already_alerted", "growth does not re-fire within a streak");
      assert.equal(r4.count, 2);
      assert.equal(calls.length, 1);

      // Recovery: stuck rows promoted/cleared -> re-arm...
      const recoveriesBefore = recoveries.length;
      await workerDb.execute(sql`
        DELETE FROM semrush_location_sync_state WHERE client_id = ${clientId} AND status = 'in_progress'
      `);
      const r5 = await checkLocalDominanceStuckSync();
      assert.equal(r5.decision, "skipped_below_threshold");
      assert.ok(recoveries.length > recoveriesBefore, "recovery calls markRecovered");
      assert.equal(ldHelpers.getStreakAlerted(), false);

      // ...and the NEXT streak pages again — even during an operator stop:
      // this watcher deliberately keeps firing while the
      // local_dominance_sync switch is ON (recovery is off, rows cannot
      // self-heal).
      await setKillSwitch("local_dominance_sync", true, "test");
      try {
        await insertSyncRow({ status: "in_progress", lastAttemptOffsetMs: -300 * 60_000 });
        const r6 = await checkLocalDominanceStuckSync();
        assert.equal(r6.decision, "alerted", "operator stop does NOT silence the stuck-row page");
        assert.equal(calls.length, 2);
      } finally {
        await setKillSwitch("local_dominance_sync", false, "test");
      }
      await workerDb.execute(sql`DELETE FROM semrush_location_sync_state WHERE client_id = ${clientId}`);
      console.log("PASS: local-dominance stuck watcher (predicate/streak fire-once incl. growth/recovery re-arm/kill-switch keeps firing)");
    }

    // ------------------------------------------------------------------
    // 2. Semrush auto-retry overdue watcher — streak lifecycle.
    // ------------------------------------------------------------------
    {
      const calls: DispatchCall[] = [];
      const recoveries: Array<{ id: string; dedupeKey: string }> = [];
      stub(srHelpers, calls);
      stubMarkRecovered(srHelpers, recoveries);
      await storage.setSystemSetting(SR_ENABLED, "true", "test");
      await storage.setSystemSetting(SR_AGE, "60", "test");
      await storage.setSystemSetting(SR_COUNT, "1", "test");

      // Merely due (not overdue past 60min), NULL retry, future retry,
      // terminal status: none count; healthy observation re-arms.
      await insertSyncRow({ status: "failed", nextRetryOffsetMs: -10 * 60_000 });
      await insertSyncRow({ status: "failed", nextRetryOffsetMs: null });
      await insertSyncRow({ status: "failed", nextRetryOffsetMs: 30 * 60_000 });
      await insertSyncRow({ status: "stale", nextRetryOffsetMs: -120 * 60_000 });
      const r1 = await checkSemrushAutoRetryOverdue();
      assert.equal(r1.decision, "skipped_below_threshold", `only overdue failed rows count (got count=${r1.count})`);
      assert.equal(r1.count, 0);
      assert.equal(calls.length, 0);
      assert.equal(recoveries.length, 1, "healthy observation calls markRecovered");
      assert.equal(recoveries[0].dedupeKey, srHelpers.DEDUPE_KEY);

      // Overdue past the threshold: alerts once.
      await insertSyncRow({ status: "failed", nextRetryOffsetMs: -120 * 60_000 });
      const r2 = await checkSemrushAutoRetryOverdue();
      assert.equal(r2.decision, "alerted");
      assert.equal(r2.count, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, "queue.semrush_auto_retry.overdue_rows");
      assert.equal(calls[0].dedupeKey, srHelpers.DEDUPE_KEY, "dispatch carries the health-state dedupe key");
      assert.ok(!calls[0].bypassDedupe, "transition dedupe must NOT be bypassed");

      // Same streak: suppressed.
      const r3 = await checkSemrushAutoRetryOverdue();
      assert.equal(r3.decision, "skipped_streak_already_alerted");
      assert.equal(calls.length, 1);

      // auto_retry kill switch ON: overdue rows expected -> skip, streak
      // state untouched (no observation)...
      const recoveriesBeforeSwitch = recoveries.length;
      await setKillSwitch("auto_retry", true, "test");
      try {
        const r4 = await checkSemrushAutoRetryOverdue();
        assert.equal(r4.decision, "skipped_kill_switch", "operator stop silences the overdue page");
        assert.equal(calls.length, 1);
        assert.equal(srHelpers.getStreakAlerted(), true, "kill-switch skip makes no observation - streak state untouched");
        assert.equal(recoveries.length, recoveriesBeforeSwitch, "kill-switch skip never re-arms");
      } finally {
        await setKillSwitch("auto_retry", false, "test");
      }
      // ...so after the switch lifts mid-streak there is STILL no double
      // page for the same streak.
      const r5 = await checkSemrushAutoRetryOverdue();
      assert.equal(r5.decision, "skipped_streak_already_alerted", "streak state survives a kill-switch window");
      assert.equal(calls.length, 1);

      // Disabled skip: observational only, streak state + health state
      // untouched.
      await storage.setSystemSetting(SR_ENABLED, "false", "test");
      const recoveriesBeforeDisabled = recoveries.length;
      const r6 = await checkSemrushAutoRetryOverdue();
      assert.equal(r6.decision, "skipped_disabled");
      assert.equal(srHelpers.getStreakAlerted(), true, "disabled skip leaves streak state untouched");
      assert.equal(recoveries.length, recoveriesBeforeDisabled, "disabled skip never re-arms");
      await storage.setSystemSetting(SR_ENABLED, "true", "test");

      // Recovery: overdue backlog drained -> re-arm; next streak pages.
      const recoveriesBefore = recoveries.length;
      await workerDb.execute(sql`
        DELETE FROM semrush_location_sync_state WHERE client_id = ${clientId} AND status = 'failed'
      `);
      const r7 = await checkSemrushAutoRetryOverdue();
      assert.equal(r7.decision, "skipped_below_threshold");
      assert.ok(recoveries.length > recoveriesBefore, "recovery calls markRecovered");
      assert.equal(srHelpers.getStreakAlerted(), false);
      await insertSyncRow({ status: "failed", nextRetryOffsetMs: -120 * 60_000 });
      const r8 = await checkSemrushAutoRetryOverdue();
      assert.equal(r8.decision, "alerted", "recovery re-arms the next streak");
      assert.equal(calls.length, 2);
      console.log("PASS: semrush auto-retry overdue watcher (predicate/streak fire-once/kill-switch + disabled leave state/recovery re-arm)");
    }

    console.log("ALL parity watcher tests passed");
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAIL:", err);
    process.exit(1);
  },
);
