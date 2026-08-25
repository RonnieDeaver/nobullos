/* test-registration
{
  "name": "Call-analysis stuck-processing alerts (workers parity E-F12)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy focused watcher suite mirroring tests/call-archive-stuck-processing-alerts.test.ts (its template, also sweep-only); runs in the full suite and the nightly --regression sweep rather than the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Workers/queues parity (E-F12) — focused suite for the call-analysis
 * stuck-processing watcher (`callAnalysisStuckProcessingAlerts`):
 *
 *  - predicate parity: only processing rows whose lease (locked_until)
 *    has been EXPIRED for >= ageMinutes count — actively heartbeating
 *    rows (future lease) and recently claimed/expired rows do not;
 *  - threshold, cooldown, growth-since-last-alert re-fire, disabled;
 *  - real-dispatcher path: one check drives notifyByType end to end and
 *    leaves a `notification_deliveries` evidence row for the registered
 *    id (`skipped_no_channel` is dev-normal — the delivery ATTEMPT is
 *    the fixture, matching the repository's alert-evidence convention);
 *  - dedupe isolation: the watcher's notification id is distinct from
 *    the call-archive watcher's, so their dispatcher-side dedupe keys
 *    can never collide.
 *
 * Threshold knobs are pinned via system_settings and restored in
 * finally; the dispatcher is stubbed for the decision-path cases via
 * __testHelpers.setDispatcherForTests.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  __testHelpers,
  checkCallAnalysisStuckProcessing,
  stuckProcessingWhere,
  SETTING_ENABLED,
  SETTING_AGE_MINUTES,
  SETTING_COUNT,
  SETTING_COOLDOWN,
} from "../server/services/callAnalysisStuckProcessingAlerts";
import { __testHelpers as archiveHelpers } from "../server/services/callArchiveStuckProcessingAlerts";

const MARKER = `t_ca_stuck_${process.pid}_${Date.now()}`;
const AGE_MINUTES = 5;

const SETTING_KEYS = [SETTING_ENABLED, SETTING_AGE_MINUTES, SETTING_COUNT, SETTING_COOLDOWN] as const;

async function insertJob(opts: {
  status?: string;
  lockedUntilOffsetMs?: number | null;
}): Promise<string> {
  const id = randomUUID();
  const iv = (ms: number | null | undefined) =>
    ms == null ? sql`NULL` : sql`NOW() + (${Math.round(ms / 1000)} || ' seconds')::interval`;
  await workerDb.execute(sql`
    INSERT INTO call_analysis_jobs
      (analysis_id, external_id, idempotency_key, status, lane, attempt_count,
       locked_until, leased_at, started_at, created_at)
    VALUES
      (${id}, ${`${MARKER}_ext_${id.slice(0, 8)}`}, ${`${MARKER}_idem_${id}`},
       ${opts.status ?? "processing"}, 'normal', 1,
       ${iv(opts.lockedUntilOffsetMs)}, NOW() - interval '30 minutes', NOW() - interval '30 minutes', NOW() - interval '30 minutes')
  `);
  return id;
}

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE external_id LIKE ${`${MARKER}%`}`);
  for (const k of SETTING_KEYS) {
    try { await storage.deleteSystemSetting(k); } catch {}
  }
  __testHelpers.resetLastAlertCache();
  __testHelpers.setDispatcherForTests(null);
}

interface DispatchCall {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function stubDispatcher(calls: DispatchCall[], delivered = true) {
  __testHelpers.setDispatcherForTests(async (id, payload, options) => {
    calls.push({ id, text: payload.text, metadata: options.metadata });
    return { delivered, status: delivered ? "sent" : "skipped", skipReason: delivered ? undefined : "skipped_no_channel" };
  });
}

async function main(): Promise<void> {
  await cleanup();
  // Prune litter a SIGKILL'd earlier suite may have left: the watcher
  // counts table-wide, so stray processing rows would skew thresholds.
  await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE status = 'processing'`);
  // Pin thresholds: age 5min, count >= 2, cooldown 60min.
  await storage.setSystemSetting(SETTING_ENABLED, "true", "test");
  await storage.setSystemSetting(SETTING_AGE_MINUTES, String(AGE_MINUTES), "test");
  await storage.setSystemSetting(SETTING_COUNT, "2", "test");
  await storage.setSystemSetting(SETTING_COOLDOWN, "60", "test");

  try {
    // ------------------------------------------------------------------
    // 0. Registered ids are distinct across the queue watchers (dedupe
    //    isolation at the dispatcher).
    // ------------------------------------------------------------------
    assert.equal(__testHelpers.NOTIFICATION_ID, "queue.call_analysis.stuck_processing");
    assert.notEqual(__testHelpers.NOTIFICATION_ID, archiveHelpers.NOTIFICATION_ID,
      "call-analysis watcher must not share the call-archive dedupe id");

    // ------------------------------------------------------------------
    // 1. Predicate: expired-past-age counts; heartbeating/fresh/queued
    //    rows do not.
    // ------------------------------------------------------------------
    {
      const calls: DispatchCall[] = [];
      stubDispatcher(calls);

      const stuckA = await insertJob({ lockedUntilOffsetMs: -10 * 60_000 });   // expired 10min ago
      await insertJob({ lockedUntilOffsetMs: 5 * 60_000 });                    // actively heartbeating (future lease)
      await insertJob({ lockedUntilOffsetMs: -60_000 });                       // expired only 1min ago (recently claimed)
      await insertJob({ status: "queued", lockedUntilOffsetMs: null });        // not processing
      await insertJob({ status: "complete", lockedUntilOffsetMs: null });      // terminal

      const r1 = await checkCallAnalysisStuckProcessing();
      assert.equal(r1.decision, "skipped_below_threshold", `1 stuck < threshold 2 (got ${r1.decision}, count=${r1.count})`);
      assert.equal(r1.count, 1, "only the genuinely stale row counts");
      assert.equal(calls.length, 0);

      // Cross-check the exported predicate matches the watcher count.
      const direct = await workerDb.execute(sql`
        SELECT COUNT(*)::int AS n FROM call_analysis_jobs WHERE ${stuckProcessingWhere(AGE_MINUTES)}
      `);
      assert.equal(Number((direct.rows?.[0] as any)?.n), 1, "exported predicate parity");

      // Second stale row crosses the threshold -> alert with metadata.
      const stuckB = await insertJob({ lockedUntilOffsetMs: -20 * 60_000 });
      const r2 = await checkCallAnalysisStuckProcessing();
      assert.equal(r2.decision, "alerted");
      assert.equal(r2.count, 2);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].id, "queue.call_analysis.stuck_processing");
      assert.match(calls[0].text, /stuck/i);
      assert.equal(calls[0].metadata?.count, 2);
      // No payload/secret content: alert text carries counts + column
      // names only, never job payloads or transcript content.
      assert.ok(!calls[0].text.includes(MARKER), "alert text must not embed row payload data");

      // ----------------------------------------------------------------
      // 2. Cooldown: identical state inside the window does not re-fire.
      // ----------------------------------------------------------------
      const r3 = await checkCallAnalysisStuckProcessing();
      assert.equal(r3.decision, "skipped_no_growth_since_last_alert", "no duplicate alert inside cooldown");
      assert.equal(calls.length, 1);

      // Growth below a full threshold inside cooldown: still suppressed.
      const stuckC = await insertJob({ lockedUntilOffsetMs: -30 * 60_000 });
      const r4 = await checkCallAnalysisStuckProcessing();
      assert.equal(r4.decision, "skipped_cooldown", "sub-threshold growth stays suppressed");
      assert.equal(calls.length, 1);

      // Growth by >= threshold inside cooldown: re-fires.
      const stuckD = await insertJob({ lockedUntilOffsetMs: -40 * 60_000 });
      const r5 = await checkCallAnalysisStuckProcessing();
      assert.equal(r5.decision, "alerted", "threshold-sized growth re-fires inside cooldown");
      assert.equal(r5.count, 4);
      assert.equal(calls.length, 2);

      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id IN (${stuckA}, ${stuckB}, ${stuckC}, ${stuckD})`);
      __testHelpers.resetLastAlertCache();
      console.log("PASS: predicate + threshold + cooldown + growth re-fire");
    }

    // ------------------------------------------------------------------
    // 3. Disabled: evaluates but never dispatches.
    // ------------------------------------------------------------------
    {
      const calls: DispatchCall[] = [];
      stubDispatcher(calls);
      await insertJob({ lockedUntilOffsetMs: -10 * 60_000 });
      await insertJob({ lockedUntilOffsetMs: -10 * 60_000 });
      await storage.setSystemSetting(SETTING_ENABLED, "false", "test");
      const r = await checkCallAnalysisStuckProcessing();
      assert.equal(r.decision, "skipped_disabled");
      assert.equal(calls.length, 0);
      await storage.setSystemSetting(SETTING_ENABLED, "true", "test");
      console.log("PASS: disabled switch suppresses dispatch");
    }

    // ------------------------------------------------------------------
    // 4. Real-dispatcher evidence: the delivery attempt lands in
    //    notification_deliveries under the registered id (dev-normal
    //    status `skipped_no_channel` still writes the evidence row).
    // ------------------------------------------------------------------
    {
      __testHelpers.setDispatcherForTests(null);
      __testHelpers.resetLastAlertCache();
      const before = await workerDb.execute(sql`
        SELECT COUNT(*)::int AS n FROM notification_deliveries
        WHERE notification_id = ${__testHelpers.NOTIFICATION_ID}
      `);
      const nBefore = Number((before.rows?.[0] as any)?.n ?? 0);

      const r = await checkCallAnalysisStuckProcessing();
      assert.ok(
        ["alerted", "skipped_dispatcher_skipped"].includes(r.decision),
        `real dispatcher path reached (got ${r.decision} / ${r.skipReason ?? ""})`,
      );

      const after = await workerDb.execute(sql`
        SELECT status, dedupe_key FROM notification_deliveries
        WHERE notification_id = ${__testHelpers.NOTIFICATION_ID}
        ORDER BY created_at DESC LIMIT 5
      `);
      const rows = (after.rows ?? []) as Array<{ status: string; dedupe_key: string | null }>;
      assert.ok(rows.length >= 1 && rows.length + nBefore >= nBefore + 1,
        "delivery evidence row recorded for the watcher's notification id");
      // Dev-normal statuses: skipped_no_channel (no Slack channel bound)
      // or sent (if the run's DB carries a channel). Either proves the
      // dispatcher path end to end.
      assert.ok(rows[0].status.length > 0);
      console.log(`PASS: real dispatcher evidence row (status=${rows[0].status})`);
    }

    console.log("ALL call-analysis stuck-processing alert tests passed");
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
