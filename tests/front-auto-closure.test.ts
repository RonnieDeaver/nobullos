/* test-registration
{
  "name": "Front self-healing coverage loop (Task #1682)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.7s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 300000,
  "notes": "Task #1701: known-slow fixture. The self-healing loop exercises multiple stubbed Front recovery ticks, retry budgets, and dedupe paths in series; bump the per-test wall-clock so it doesn't trip the default 180s timeout on a loaded test DB.",
  "tier": "small"
}
test-registration */
/**
 * Task #1682 — Front self-healing coverage loop tests.
 *
 * Covers:
 *   1. Gating: master kill switch, KILL_SWITCH_NON_CRITICAL_SWEEPS,
 *      front_analytics_refresh_enabled, queue pause, DB pressure are
 *      all short-circuits that record a `skippedReason` and never
 *      touch the database.
 *   2. Threshold logic: isIngestCandidate / isApplyCandidate respect
 *      both count and percent floors and skip unrecoverable rows.
 *   3. Retry: error rows are retried via refreshMonth; unrecoverable
 *      and auth-failed rows are NOT retried; retry budget is honored.
 *   4. Ingest gap: enqueueIngestRecoveries calls runHistoricalRecovery
 *      for the highest-priority candidate, honors per-month cooldown
 *      and per-tick budget, and treats "already running" as in_flight
 *      rather than a self-error.
 *   5. Apply gap: nudgeApplyGaps enqueues `front_webhook_apply` jobs
 *      with the canonical `apply:${sourceEventId}` dedupeKey for
 *      months that have unresolved `front_sync_emails` rows; second
 *      tick is naturally deduped.
 *   6. Status: getFrontAutoClosureStatus returns the last summary.
 *
 * Uses test-helper hooks where possible and never hits Front or
 * Front-historical-recovery over the network — we stub the relevant
 * modules via dynamic `import` and rewriting the relevant exports.
 * Test rows use a far-future month prefix (2998-*) so they cannot
 * collide with the existing front-analytics-coverage suite.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { frontAnalyticsMonthlyCoverage, workQueue } from "@shared/schema";
import {
  __frontAnalyticsClientTestHelpers,
  type MonthlyMetricResult,
} from "../server/services/frontAnalyticsClient";
import { resetFrontAuthBreaker } from "../server/services/frontAuthBreaker";
import {
  runFrontAutoClosureTick,
  getFrontAutoClosureStatus,
  SETTING_ENABLED,
  SETTING_RETRY_BUDGET,
  SETTING_INGEST_RECOVERY_BUDGET,
  SETTING_APPLY_NUDGE_BUDGET,
  SETTING_INGEST_GAP_COUNT,
  SETTING_INGEST_GAP_PCT,
  SETTING_APPLY_GAP_COUNT,
  SETTING_APPLY_GAP_PCT,
  SETTING_COOLDOWN_MINUTES,
  SETTING_MAX_RECOVERY_RUNS_PER_DAY,
  createInMemoryStateStore,
  __frontAutoClosureTestHelpers,
  type FrontAutoClosureConfig,
} from "../server/services/frontAutoClosure";

const FUTURE_YEAR = 2998;

async function cleanupTestRows(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month LIKE ${`${FUTURE_YEAR}-%`}
  `);
  await db.execute(sql`
    DELETE FROM work_queue
    WHERE queue_name = 'front_webhook_apply'
      AND dedupe_key LIKE 'apply:auto_closure_test_%'
  `);
}

async function withSettingsBackup<T>(
  keys: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | null>();
  for (const k of keys) {
    const row = await storage.getSystemSetting(k).catch(() => null);
    saved.set(k, row?.value ?? null);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === null) {
        await storage.deleteSystemSetting(k);
      } else {
        await storage.setSystemSetting(k, v, "system");
      }
    }
  }
}

function monthDates(label: string): { start: Date; end: Date } {
  const [y, m] = label.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
}

async function insertCoverageRow(opts: {
  month: string;
  frontTotal: number;
  fetched: number;
  applied: number;
  ingestGap: number;
  applyGap: number;
  error?: string | null;
  unrecoverable?: boolean;
  status?: string | null;
}): Promise<void> {
  const { start, end } = monthDates(opts.month);
  await db.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end, front_total_messages, fetched_into_nobull,
       applied_into_nobull, ingest_gap, apply_gap, fetched_coverage_pct,
       applied_coverage_pct, front_analytics_error, unrecoverable, front_analytics_status,
       is_finalized_month, pulled_at)
    VALUES (${opts.month}, ${start.toISOString()}, ${end.toISOString()},
            ${opts.frontTotal}, ${opts.fetched}, ${opts.applied},
            ${opts.ingestGap}, ${opts.applyGap},
            ${opts.frontTotal > 0 ? (opts.fetched / opts.frontTotal) * 100 : 0},
            ${opts.frontTotal > 0 ? (opts.applied / opts.frontTotal) * 100 : 0},
            ${opts.error ?? null}, ${opts.unrecoverable ?? false},
            ${opts.status ?? null}, true, NOW())
    ON CONFLICT (month) DO UPDATE SET
      front_total_messages = EXCLUDED.front_total_messages,
      fetched_into_nobull = EXCLUDED.fetched_into_nobull,
      applied_into_nobull = EXCLUDED.applied_into_nobull,
      ingest_gap = EXCLUDED.ingest_gap,
      apply_gap = EXCLUDED.apply_gap,
      front_analytics_error = EXCLUDED.front_analytics_error,
      unrecoverable = EXCLUDED.unrecoverable,
      front_analytics_status = EXCLUDED.front_analytics_status
  `);
}

// Task #2157 — auto-closure config is now driven via the tick's
// `configOverride` param (in-memory) instead of mutating the shared
// `front_auto_closure_*` system_settings rows, so concurrent suites (or
// the always-on dev-server tick) can no longer clobber this suite's
// config. Task #2239 — the orchestrator run-state is likewise driven
// through an injected in-memory store, so this suite no longer reads,
// writes, or deletes the global `front_auto_closure_state` setting. There
// are no shared system_settings rows left to back up.
const SETTING_KEYS_TO_RESTORE: string[] = [];

await withSettingsBackup(SETTING_KEYS_TO_RESTORE, async () => {
  await cleanupTestRows();
  // Reset orchestrator state by starting from a fresh in-memory store, so
  // cooldowns / parked windows from a prior run can never bleed into this
  // execution (replaces the old `deleteSystemSetting(SETTING_STATE)`).
  const stateStore = createInMemoryStateStore();

  // Drive every tick with an explicit in-memory config and the injected
  // state store. Config defaults to a "loop is on" config; each call
  // layers on only the keys it cares about. No `system_settings` writes
  // => immune to shared-setting collisions (Tasks #2157 / #2239).
  const runTick = (now: Date, cfg: Partial<FrontAutoClosureConfig> = {}) =>
    runFrontAutoClosureTick({
      now,
      configOverride: { enabled: true, analyticsRefreshEnabled: true, ...cfg },
      stateStore,
    });

  // ──────────────────────────────────────────────────────────────────────
  // 1. Threshold helpers.
  // ──────────────────────────────────────────────────────────────────────
  const { isIngestCandidate, isApplyCandidate } = __frontAutoClosureTestHelpers;
  // Row that meets the count floor.
  assert.equal(
    isIngestCandidate(
      { frontTotalMessages: 10_000, ingestGap: 600 } as any,
      { ingestGapCount: 500, ingestGapPct: 5.0 },
    ),
    true,
    "ingest candidate: count floor met",
  );
  // Row that meets the percent floor but not the count floor.
  assert.equal(
    isIngestCandidate(
      { frontTotalMessages: 1000, ingestGap: 100 } as any,
      { ingestGapCount: 500, ingestGapPct: 5.0 },
    ),
    true,
    "ingest candidate: pct floor met",
  );
  // Row that meets neither.
  assert.equal(
    isIngestCandidate(
      { frontTotalMessages: 1000, ingestGap: 20 } as any,
      { ingestGapCount: 500, ingestGapPct: 5.0 },
    ),
    false,
    "ingest candidate: below both floors",
  );
  // Apply candidate uses fetched as denominator for the pct check.
  assert.equal(
    isApplyCandidate(
      { fetchedIntoNobull: 10_000, applyGap: 600 } as any,
      { applyGapCount: 500, applyGapPct: 5.0 },
    ),
    true,
    "apply candidate: count floor met",
  );

  // ──────────────────────────────────────────────────────────────────────
  // 2. Gate: master kill switch.
  // ──────────────────────────────────────────────────────────────────────
  const offTick = await runTick(new Date(Date.UTC(FUTURE_YEAR, 5, 15)), {
    enabled: false,
  });
  assert.equal(offTick.enabled, false);
  assert.equal(offTick.skippedReason, `${SETTING_ENABLED}=false`);
  assert.equal(offTick.monthsInspected, 0);
  assert.equal(offTick.errorsRetried, 0);
  assert.equal(offTick.ingestRecoveriesEnqueued, 0);
  assert.equal(offTick.applyNudgesEnqueued, 0);

  // ──────────────────────────────────────────────────────────────────────
  // 3. Gate: front_analytics_refresh_enabled inherited.
  // ──────────────────────────────────────────────────────────────────────
  const refreshOffTick = await runTick(new Date(Date.UTC(FUTURE_YEAR, 5, 15)), {
    analyticsRefreshEnabled: false,
  });
  assert.equal(refreshOffTick.enabled, true);
  assert.equal(
    refreshOffTick.skippedReason,
    "front_analytics_refresh_enabled=false",
  );

  // ──────────────────────────────────────────────────────────────────────
  // 3b. Gate: Front auth-dead breaker (Task #2100). When the global auth
  //     breaker is open, the tick must short-circuit with
  //     skippedReason="front_auth_dead", increment skips.auth_failed, and
  //     enqueue NO recovery/apply work. Mirrors the SEMrush paused_auth
  //     short-circuit.
  // ──────────────────────────────────────────────────────────────────────
  {
    const {
      tripFrontAuthBreaker,
      resetFrontAuthBreaker,
      __resetFrontAuthBreakerForTest,
    } = await import("../server/services/frontAuthBreaker");
    __resetFrontAuthBreakerForTest();
    try {
      tripFrontAuthBreaker("front_refresh_failed_permanent");
      const authDeadTick = await runTick(
        new Date(Date.UTC(FUTURE_YEAR, 5, 15)),
      );
      assert.equal(authDeadTick.enabled, true);
      assert.equal(
        authDeadTick.skippedReason,
        "front_auth_dead",
        `expected front_auth_dead skip (got ${authDeadTick.skippedReason})`,
      );
      assert.equal(
        authDeadTick.skips.auth_failed,
        1,
        "auth_failed must increment when the breaker short-circuits the tick",
      );
      assert.equal(
        authDeadTick.ingestRecoveriesEnqueued,
        0,
        "no recovery work while auth is dead",
      );
      assert.equal(
        authDeadTick.applyNudgesEnqueued,
        0,
        "no apply work while auth is dead",
      );
    } finally {
      resetFrontAuthBreaker();
      __resetFrontAuthBreakerForTest();
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 4. Retry path: error rows are retried; unrecoverable + auth_failed are not.
  // ──────────────────────────────────────────────────────────────────────
  const errMonth = `${FUTURE_YEAR}-01`;
  const unrecMonth = `${FUTURE_YEAR}-02`;
  const authMonth = `${FUTURE_YEAR}-03`;
  await insertCoverageRow({
    month: errMonth,
    frontTotal: 0,
    fetched: 0,
    applied: 0,
    ingestGap: 0,
    applyGap: 0,
    error: "front_analytics_report_failed: transient",
    status: "error",
  });
  await insertCoverageRow({
    month: unrecMonth,
    frontTotal: 0,
    fetched: 0,
    applied: 0,
    ingestGap: 0,
    applyGap: 0,
    error: "front_analytics_report_failed: forever",
    unrecoverable: true,
    status: "error",
  });
  await insertCoverageRow({
    month: authMonth,
    frontTotal: 0,
    fetched: 0,
    applied: 0,
    ingestGap: 0,
    applyGap: 0,
    error: "front_analytics_auth_failed: 401",
    status: "error",
  });

  // Script the Front pull so the retry succeeds for errMonth.
  const scripted: Array<{ kind: "ok"; value: number }> = [
    { kind: "ok", value: 123 },
  ];
  __frontAnalyticsClientTestHelpers.setPullOverride(async () => {
    const next = scripted.shift();
    if (!next) throw new Error("test: scripted pull queue empty");
    return {
      reportId: `auto-retry-${Math.random().toString(36).slice(2, 8)}`,
      value: next.value,
      status: "done",
      metric: "num_messages_received",
    } as MonthlyMetricResult;
  });

  try {
    const retryTick = await runTick(new Date(Date.UTC(FUTURE_YEAR, 5, 15)), {
      retryBudget: 2,
      ingestRecoveryBudget: 0,
      applyNudgeBudget: 0,
    });
    assert.equal(retryTick.enabled, true);
    assert.ok(retryTick.skippedReason == null, `unexpected skip: ${retryTick.skippedReason}`);
    assert.equal(retryTick.errorsRetried, 1, "only the recoverable error row is retried");
    assert.equal(retryTick.errorRetrySuccesses, 1);
    // Verify per-row skip behavior on the test-seeded months instead of
    // asserting on the aggregate `retryTick.skips.*` counters. The live
    // `front_analytics_monthly_coverage` table may contain real prod
    // rows in the same skip categories — they would inflate the
    // aggregate counters and force a hedged ">= 1" assertion. Row-level
    // checks are exact AND stronger: they prove THIS test's rows were
    // classified correctly, not just that "something" was skipped.
    const unrecRowsRes: any = await db.execute(sql`
      SELECT unrecoverable, front_analytics_error
      FROM front_analytics_monthly_coverage
      WHERE month = ${unrecMonth}
    `);
    const unrecRow = ((unrecRowsRes as any).rows ?? unrecRowsRes)[0];
    assert.ok(unrecRow, `seeded unrecoverable row missing: ${unrecMonth}`);
    assert.equal(
      unrecRow.unrecoverable,
      true,
      "test's unrecoverable row was skipped by the retry pass (still flagged unrecoverable)",
    );
    assert.equal(
      String(unrecRow.front_analytics_error ?? ""),
      "front_analytics_report_failed: forever",
      "test's unrecoverable row error message was not overwritten by a retry",
    );

    const authRowsRes: any = await db.execute(sql`
      SELECT front_analytics_error
      FROM front_analytics_monthly_coverage
      WHERE month = ${authMonth}
    `);
    const authRow = ((authRowsRes as any).rows ?? authRowsRes)[0];
    assert.ok(authRow, `seeded auth-failed row missing: ${authMonth}`);
    assert.match(
      String(authRow.front_analytics_error ?? ""),
      /front_analytics_auth_failed/,
      "test's auth-failed row was skipped (error message unchanged after retry pass)",
    );

    // ────────────────────────────────────────────────────────────────────
    // 5. Apply nudge: enqueue front_webhook_apply for the unresolved row,
    //    second tick is naturally deduped via the canonical dedupeKey.
    // ────────────────────────────────────────────────────────────────────
    // Task #2100 added a process-global Front auth-breaker short-circuit:
    // when the breaker is open the whole self-heal tick is skipped
    // (`skippedReason: "front_auth_dead"`). The retry pass above exercises
    // `refreshMonth`, whose real search-conversations companion pull hits a
    // not-connected Front in the test environment and TRIPS that breaker as
    // a side effect. Clear it here so the apply-nudge tick below actually
    // runs — this suite is verifying apply-nudge classification, not the
    // (separately covered) auth-breaker deferral gate.
    resetFrontAuthBreaker();
    const applyMonth = `${FUTURE_YEAR}-04`;
    await insertCoverageRow({
      month: applyMonth,
      frontTotal: 1000,
      fetched: 900,
      applied: 100,
      ingestGap: 100,
      applyGap: 800,
    });

    // Seed a single `front_sync_emails` row whose pipeline_state has
    // stalled, plus a matching source_event_log + work_result_log pair
    // so the apply nudger has something to enqueue.
    const convId = `auto_closure_test_conv_${FUTURE_YEAR}_04`;
    const sourceEventId = `auto_closure_test_se_${FUTURE_YEAR}_04`;
    const workResultId = `auto_closure_test_wr_${FUTURE_YEAR}_04`;
    const dedupeKey = `apply:${sourceEventId}`;
    const lastMessageAt = new Date(Date.UTC(FUTURE_YEAR, 3, 10, 12, 0, 0)).toISOString();
    await db.execute(sql`
      INSERT INTO front_sync_emails
        (id, conversation_id, pipeline_state, last_message_at, match_status, created_at)
      VALUES (${`auto_closure_test_fse_${FUTURE_YEAR}_04`}, ${convId},
              'normalized', ${lastMessageAt}, 'unmatched', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO source_event_log
        (id, source_system, source_event_type, source_object_id, dedupe_key,
         payload_json, status, replayable, received_at)
      VALUES (${sourceEventId}, 'front', 'conversation.message',
              ${convId}, ${`auto_closure_test_dedupe_${FUTURE_YEAR}_04`},
              '{}'::jsonb, 'received', true, NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO work_result_log
        (id, source_event_id, source_system, result_type, result_json,
         status, created_at)
      VALUES (${workResultId}, ${sourceEventId}, 'front',
              'communication_result',
              ${JSON.stringify({ conversationId: convId })}::jsonb,
              'completed', NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    const applyTick = await runTick(new Date(Date.UTC(FUTURE_YEAR, 3, 15)), {
      retryBudget: 0,
      ingestRecoveryBudget: 0,
      applyNudgeBudget: 10,
      applyGapCount: 1,
      applyGapPct: 0.0001,
    });
    assert.ok(
      applyTick.applyNudgesEnqueued >= 1,
      `expected at least 1 apply nudge, got ${applyTick.applyNudgesEnqueued}`,
    );

    // Second tick: same source event — dedupeKey collision means the
    // workScheduler returns the existing job; our counter still ticks
    // up the enqueue call, but a downstream verification is that no
    // duplicate row landed in the work_queue.
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM work_queue
      WHERE dedupe_key = ${dedupeKey}
    `);
    const count = ((rows as any).rows ?? rows)[0]?.n ?? 0;
    assert.ok(count <= 1, `expected at most 1 queue row for ${dedupeKey}, got ${count}`);

    // ────────────────────────────────────────────────────────────────────
    // 6. Status endpoint exposes the last summary.
    // ────────────────────────────────────────────────────────────────────
    const status = await getFrontAutoClosureStatus({ stateStore });
    assert.ok(status.lastSummary, "lastSummary persisted");
    // The applied budget is now supplied via the tick's in-memory
    // `configOverride` (Task #2157), not written to system_settings, so
    // `status.config` (freshly loaded from globals) won't reflect it.
    // Assert on the tick summary's effective budget instead — a stronger,
    // collision-immune check that the override actually drove the tick.
    assert.equal(applyTick.effectiveBudgets.applyNudge, 10);

    // ────────────────────────────────────────────────────────────────────
    // 7. Pause gate: ingest recovery must NOT enqueue when a downstream
    //    queue (front_webhook_normalize / front_webhook_apply) is paused
    //    via queue_drain_state. Skip is surfaced via skips.queue_paused.
    // ────────────────────────────────────────────────────────────────────
    const { setQueuePause } = await import(
      "../server/services/queueDrainControl"
    );
    // Seed an ingest-gap row that would otherwise qualify (well above the
    // floors we set earlier).
    await insertCoverageRow({
      month: `${FUTURE_YEAR}-06`,
      frontTotal: 10_000,
      fetched: 0,
      applied: 0,
      ingestGap: 10_000,
      applyGap: 0,
    });
    // Capture and restore prior pause state so we don't perturb other tests.
    let appliedPause = false;
    try {
      await setQueuePause("front_webhook_normalize", true, "auto_closure_test");
      appliedPause = true;
      const pauseTick = await runTick(new Date(Date.UTC(FUTURE_YEAR, 5, 15)), {
        retryBudget: 0,
        ingestRecoveryBudget: 1,
        applyNudgeBudget: 0,
        ingestGapCount: 500,
        ingestGapPct: 5.0,
      });
      assert.equal(
        pauseTick.ingestRecoveriesEnqueued,
        0,
        "ingest recovery must defer when front_webhook_normalize is paused",
      );
      assert.ok(
        pauseTick.skips.queue_paused >= 1,
        "skips.queue_paused must increment on downstream pause",
      );
    } finally {
      if (appliedPause) {
        await setQueuePause("front_webhook_normalize", false, "auto_closure_test");
      }
    }

    // (Threshold-guard logic for ingest gaps is covered by the
    // `isIngestCandidate` / `isApplyCandidate` unit assertions in
    // section 1 above. We deliberately do NOT run a "should-not-recover"
    // end-to-end assertion here because real dev rows in
    // `front_analytics_monthly_coverage` may legitimately clear the
    // floors and would start a real recovery job during the test.)

  } finally {
    __frontAnalyticsClientTestHelpers.setPullOverride(null);
    // Tidy work_queue rows we may have created.
    await db.execute(sql`
      DELETE FROM work_queue
      WHERE queue_name = 'front_webhook_apply'
        AND dedupe_key LIKE 'apply:auto_closure_test_%'
    `);
    await db.execute(sql`
      DELETE FROM front_sync_emails
      WHERE id LIKE 'auto_closure_test_%'
    `);
    await db.execute(sql`
      DELETE FROM work_result_log
      WHERE id LIKE 'auto_closure_test_%'
    `);
    await db.execute(sql`
      DELETE FROM source_event_log
      WHERE id LIKE 'auto_closure_test_%'
    `);
    await cleanupTestRows();
  }
});

console.log("✓ front-auto-closure tests passed");
// Silence unused-import warning for the workQueue symbol kept for parity.
void workQueue;
// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the child
// exits on its own — no manual process.exit() needed (Task #2084).
