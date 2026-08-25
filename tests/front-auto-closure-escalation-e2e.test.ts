/* test-registration
{
  "name": "Front auto-closure search-escalation e2e (Task #2120)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~1.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "timeoutMs": 300000,
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/frontAutoClosureEscalationRecoverySetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2120 — End-to-end auto-park search-escalation suite.
 *
 * The helper-level suite
 * (tests/front-auto-closure-search-escalation-rearm.test.ts, Task #2097)
 * exercises the Task #2085 classifiers in isolation. This file drives
 * the FULL escalation branch inside `runFrontAutoClosureTick`
 * (server/services/frontAutoClosure.ts, the `enqueueIngestRecoveries`
 * park guard) over real ticks against the live dev DB, now that the
 * module-mock seam (a `--import` resolve hook redirecting the tick's
 * dynamic `import("./frontHistoricalRecovery")` to an in-memory stub)
 * exists. It asserts the four behaviors the helper suite cannot:
 *
 *   1. Escalate-once — a legacy page-cap dead run that crosses
 *      `parkAfterDeadRuns` enqueues exactly one search-strategy re-run
 *      (`resumeMode:"clear_checkpoints"`) and records the in-flight
 *      escalation marker.
 *   2. Wait-while-in-flight — a subsequent tick whose checkpoint has NOT
 *      advanced past the escalation trigger does NOT re-enqueue and does
 *      NOT park; it waits (skips.in_flight).
 *   3. Park-on-fresh-dead-run — once the escalated re-run lands a NEW
 *      dead-run checkpoint (completedAt advanced), the window parks with
 *      `searchEscalated:true` and the in-flight marker is dropped.
 *   4. Release-on-progress — if the escalated re-run instead makes
 *      forward progress (ingested>0), the streak resets, the escalation
 *      marker is cleared, and the window is NOT parked.
 *
 * Isolation strategy: every coverage row uses a far-future month prefix
 * (2996-*) AND an astronomically large ingest gap, with the candidate
 * floors raised so high that ONLY these seeded rows qualify as ingest
 * candidates. Real dev coverage rows therefore never enter the recovery
 * loop during the test, so the stubbed `runHistoricalRecovery` is called
 * only for our months and the call counts are exact. Recovery calls are
 * additionally filtered by the seeded month's window label so a
 * concurrently-running dev-server tick cannot perturb the assertions.
 * The live dev server's `runFrontAutoClosureTick` also mutates the
 * shared persisted state in `system_settings`; we only ever read-modify-
 * write our own 2996-* month keys and clean them up in `finally`. See
 * .agents/memory/test-db-pool-exit-and-contention.md.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import {
  runFrontAutoClosureTick,
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
  SETTING_PARK_AFTER_DEAD_RUNS,
  SETTING_CLOSE_AFTER_DEDUPE_ONLY_RUNS,
  createInMemoryStateStore,
  __frontAutoClosureTestHelpers,
  type FrontAutoClosureConfig,
} from "../server/services/frontAutoClosure";
import {
  setPoolEpicSwitch,
  isPoolEpicSwitchEnabled,
  ensurePoolEpicSwitchesLoaded,
} from "../server/services/poolEpicKillSwitches";
import {
  __getRecoveryCalls,
  __resetRecovery,
} from "./helpers/frontAutoClosureEscalationRecoveryStub.mjs";

const FUTURE_YEAR = 2996;
const SEARCH_SWITCH = "front_recovery_sparse_month_search_strategy_enabled";

const { autoClosureWindowLabel, recoveryCheckpointKey } =
  __frontAutoClosureTestHelpers;

// Task #2199 — orchestrator run-state (deadRunStreak / parkedWindows /
// searchEscalations) is driven through an injected in-memory store, not
// the process-global `front_auto_closure_state` setting. This makes the
// suite hermetic against the always-on dev-server tick and sibling suites
// that also write that global blob. Every tick below is handed this same
// store; the test seeds and inspects state through it.
const stateStore = createInMemoryStateStore();

/** Canonical legacy page-cap dead-run checkpoint reason. */
const DEAD_REASON =
  "safety_max_pages_reached_resume_available scanned=25000 ingested=0";
const LEGACY_CURSOR = "/conversations?sort_by=date&page_token=abc";
const SEARCH_CURSOR = "/conversations/search/after:1/before:2?page_token=xyz";

interface Checkpoint {
  ingested: number;
  scanned?: number;
  status?: string;
  statusReason: string | null;
  completedAt: string | null;
  lastPageUrl: string | null;
}

function monthDates(label: string): { start: Date; end: Date } {
  const [y, m] = label.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
}

/** Insert a far-future ingest-candidate coverage row (huge gap). */
async function insertCandidateRow(month: string): Promise<void> {
  const { start, end } = monthDates(month);
  await db.execute(sql`
    INSERT INTO front_analytics_monthly_coverage
      (month, month_start, month_end, front_total_messages, fetched_into_nobull,
       applied_into_nobull, ingest_gap, apply_gap, fetched_coverage_pct,
       applied_coverage_pct, front_analytics_error, unrecoverable,
       front_analytics_status, is_finalized_month, pulled_at)
    VALUES (${month}, ${start.toISOString()}, ${end.toISOString()},
            ${10_000_000}, ${500_000}, ${500_000},
            ${9_500_000}, ${0}, ${5.0}, ${5.0},
            ${null}, ${false}, ${null}, true, NOW())
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

async function writeCheckpoint(month: string, cp: Checkpoint): Promise<void> {
  const key = recoveryCheckpointKey(autoClosureWindowLabel(month));
  await storage.setSystemSetting(key, JSON.stringify(cp), "system");
}

async function deleteCheckpoint(month: string): Promise<void> {
  const key = recoveryCheckpointKey(autoClosureWindowLabel(month));
  await storage.deleteSystemSetting(key).catch(() => {});
}

/** Recovery calls whose window label targets `month`. */
function recoveryCallsForMonth(month: string): any[] {
  const label = autoClosureWindowLabel(month);
  return __getRecoveryCalls().filter((c: any) =>
    Array.isArray(c?.customWindows)
      ? c.customWindows.some((w: any) => w?.label === label)
      : false,
  );
}

/**
 * Remove every 2996-* coverage row + checkpoint key this suite wrote.
 *
 * Task #2199 — orchestrator run-state no longer lives in the global
 * `front_auto_closure_state` setting for this suite (it's in `stateStore`,
 * an in-memory store discarded with the process), so there is nothing to
 * scrub there. Only the real DB coverage rows + recovery-checkpoint
 * settings need cleaning up.
 */
async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM front_analytics_monthly_coverage
    WHERE month LIKE ${`${FUTURE_YEAR}-%`}
  `);
  for (let m = 1; m <= 12; m++) {
    await deleteCheckpoint(`${FUTURE_YEAR}-${String(m).padStart(2, "0")}`);
  }
}

// Task #2157 — tick config is now supplied in-memory via configOverride, so
// this suite no longer mutates any shared `front_auto_closure_*` config row.
// Restoring them here would itself clobber the live dev-server tick's values
// (the very collision this task removes), so the restore list is empty. The
// only shared setting still flipped (the search-strategy switch) is restored
// directly in `main()`'s finally.
const SETTING_KEYS_TO_RESTORE: string[] = [];

async function withSettingsBackup<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | null>();
  for (const k of SETTING_KEYS_TO_RESTORE) {
    const row = await storage.getSystemSetting(k).catch(() => null);
    saved.set(k, row?.value ?? null);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved.entries()) {
      if (v === null) await storage.deleteSystemSetting(k).catch(() => {});
      else await storage.setSystemSetting(k, v, "system");
    }
  }
}

/** Reset the auth breaker so the tick's front_auth_dead gate never fires. */
async function resetAuthBreaker(): Promise<void> {
  const { __resetFrontAuthBreakerForTest } = await import(
    "../server/services/frontAuthBreaker"
  );
  __resetFrontAuthBreakerForTest();
}

// Task #2157 — drive ticks with an explicit in-memory config instead of
// mutating the shared `front_auto_closure_*` system_settings rows that the
// live dev-server tick and sibling suites also read. Gates open; retry /
// apply-nudge disabled so only ingest recovery acts; cooldown + dedupe-only
// close disabled (so the streak reaches the park guard); candidate floors
// raised so high that ONLY the seeded huge-gap rows qualify; park after 3
// dead runs.
const ESCALATION_BASE: Partial<FrontAutoClosureConfig> = {
  enabled: true,
  analyticsRefreshEnabled: true,
  retryBudget: 0,
  ingestRecoveryBudget: 100,
  applyNudgeBudget: 0,
  ingestGapCount: 9_000_000,
  ingestGapPct: 100_000,
  applyGapCount: 9_000_000,
  applyGapPct: 100_000,
  cooldownMinutes: 0,
  maxRecoveryRunsPerDay: 100_000,
  parkAfterDeadRuns: 3,
  closeAfterDedupeOnlyRuns: 0,
};

/** Drive one tick with a fixed clock, after clearing the auth breaker. */
async function tick(now: Date) {
  await resetAuthBreaker();
  const summary = await runFrontAutoClosureTick({
    now,
    configOverride: ESCALATION_BASE,
    stateStore,
  });
  assert.ok(
    summary.skippedReason == null,
    `tick unexpectedly skipped: ${summary.skippedReason}`,
  );
  return summary;
}

async function main(): Promise<void> {
  __resetRecovery();
  await cleanup();
  await ensurePoolEpicSwitchesLoaded();
  const origSwitch = isPoolEpicSwitchEnabled(SEARCH_SWITCH);

  await withSettingsBackup(async () => {
    try {
      // Tick config (gates open, raised candidate floors, park-after-3) is
      // supplied per-tick in-memory via ESCALATION_BASE — see the `tick`
      // helper. The only shared setting this scenario still flips is the
      // search-strategy pool-epic switch, restored in `finally`.
      await setPoolEpicSwitch(SEARCH_SWITCH, true, "system");

      // ════════════════════════════════════════════════════════════════
      // Scenario A — escalate-once → wait-in-flight → park-on-fresh-dead-run
      // ════════════════════════════════════════════════════════════════
      const MA = `${FUTURE_YEAR}-01`;
      const T0 = "3001-01-01T00:00:00.000Z"; // already-counted checkpoint
      const T1 = "3001-01-02T00:00:00.000Z"; // legacy dead run that trips escalation
      const T2 = "3001-01-03T00:00:00.000Z"; // fresh dead run from the escalated re-run
      await insertCandidateRow(MA);

      // Seed a 2-run streak whose last counted checkpoint is T0, then a
      // legacy dead-run checkpoint at T1 (newer) so this tick's
      // updateDeadRunStreak advances the streak to 3 and enters the park
      // guard.
      {
        const s = await stateStore.load();
        s.deadRunStreak = s.deadRunStreak ?? {};
        s.deadRunStreak[MA] = { count: 2, lastCheckpointAt: T0 };
        delete s.searchEscalations?.[MA];
        delete s.parkedWindows?.[MA];
        await stateStore.save(s);
      }
      await writeCheckpoint(MA, {
        ingested: 0,
        scanned: 25000,
        status: "partial",
        statusReason: DEAD_REASON,
        completedAt: T1,
        lastPageUrl: LEGACY_CURSOR,
      });

      // ── Pass 1: escalate exactly once. ──────────────────────────────
      const p1 = await tick(new Date(Date.UTC(FUTURE_YEAR, 0, 10)));
      const callsAfterP1 = recoveryCallsForMonth(MA);
      assert.equal(
        callsAfterP1.length,
        1,
        "escalation enqueues exactly one recovery for the window",
      );
      assert.equal(
        callsAfterP1[0].resumeMode,
        "clear_checkpoints",
        "the escalation re-run clears checkpoints to switch strategy",
      );
      assert.ok(
        p1.ingestRecoveriesEnqueued >= 1,
        "the escalation counts as an enqueued recovery",
      );
      {
        const s = await stateStore.load();
        assert.ok(
          s.searchEscalations?.[MA],
          "an in-flight escalation marker is recorded",
        );
        assert.equal(
          s.searchEscalations?.[MA]?.triggeredByCheckpointAt,
          T1,
          "the marker pins the checkpoint that triggered escalation",
        );
        assert.equal(
          s.parkedWindows?.[MA],
          undefined,
          "the window is NOT parked yet — escalation is in flight",
        );
      }

      // ── Pass 2: escalated re-run still in flight (checkpoint
      //    unchanged) → wait, never re-escalate, never park. ───────────
      const p2 = await tick(new Date(Date.UTC(FUTURE_YEAR, 0, 11)));
      assert.equal(
        recoveryCallsForMonth(MA).length,
        1,
        "no second escalation while the first is still in flight (fires at most once)",
      );
      assert.ok(
        p2.skips.in_flight >= 1,
        "an in-flight escalation makes the tick wait (skips.in_flight)",
      );
      {
        const s = await stateStore.load();
        assert.ok(
          s.searchEscalations?.[MA],
          "the in-flight marker survives the waiting tick",
        );
        assert.equal(
          s.parkedWindows?.[MA],
          undefined,
          "still not parked while waiting for the escalated re-run to land",
        );
      }

      // ── Pass 3: escalated re-run lands a NEW dead-run checkpoint
      //    (completedAt advanced) → park with searchEscalated. ─────────
      await writeCheckpoint(MA, {
        ingested: 0,
        scanned: 25000,
        status: "partial",
        statusReason: DEAD_REASON,
        completedAt: T2,
        lastPageUrl: SEARCH_CURSOR,
      });
      const p3 = await tick(new Date(Date.UTC(FUTURE_YEAR, 0, 12)));
      assert.equal(
        recoveryCallsForMonth(MA).length,
        1,
        "parking does not enqueue another recovery",
      );
      assert.ok(
        p3.skips.parked >= 1,
        "the window parks once the escalated re-run lands a fresh dead run",
      );
      {
        const s = await stateStore.load();
        const parked = s.parkedWindows?.[MA];
        assert.ok(parked, "the window is now parked");
        assert.equal(
          parked?.searchEscalated,
          true,
          "the parked entry records that it was already search-escalated",
        );
        assert.equal(
          parked?.reArmOutcome?.kind,
          "still_empty",
          "the park outcome is still_empty (search re-run also dead-ran)",
        );
        assert.equal(
          parked?.reArmOutcome?.source,
          "auto_escalation",
          "the outcome is attributed to the automatic escalation",
        );
        assert.equal(
          s.searchEscalations?.[MA],
          undefined,
          "the transient escalation marker is dropped once parked",
        );
      }

      // ════════════════════════════════════════════════════════════════
      // Scenario B — release-on-progress: an in-flight escalation whose
      // re-run makes forward progress resets the streak, clears the
      // marker, and does NOT park.
      // ════════════════════════════════════════════════════════════════
      __resetRecovery();
      const MB = `${FUTURE_YEAR}-02`;
      const U0 = "3002-01-01T00:00:00.000Z"; // escalation trigger checkpoint
      const U1 = "3002-01-02T00:00:00.000Z"; // forward-progress checkpoint
      await insertCandidateRow(MB);

      // Seed an in-flight escalation: streak at the park threshold and a
      // marker triggered by the U0 checkpoint.
      {
        const s = await stateStore.load();
        s.deadRunStreak = s.deadRunStreak ?? {};
        s.searchEscalations = s.searchEscalations ?? {};
        s.deadRunStreak[MB] = { count: 3, lastCheckpointAt: U0 };
        s.searchEscalations[MB] = {
          escalatedAt: "3002-01-01T12:00:00.000Z",
          triggeredByCheckpointAt: U0,
          deadRunsAtEscalation: 3,
        };
        delete s.parkedWindows?.[MB];
        await stateStore.save(s);
      }
      // The escalated re-run produced forward progress (ingested>0).
      await writeCheckpoint(MB, {
        ingested: 12,
        scanned: 4000,
        status: "partial",
        statusReason: "done",
        completedAt: U1,
        lastPageUrl: SEARCH_CURSOR,
      });

      const pr = await tick(new Date(Date.UTC(FUTURE_YEAR, 1, 10)));
      {
        const s = await stateStore.load();
        assert.equal(
          s.parkedWindows?.[MB],
          undefined,
          "forward progress must NOT park the window",
        );
        assert.equal(
          s.searchEscalations?.[MB],
          undefined,
          "forward progress clears the in-flight escalation marker (released)",
        );
        assert.equal(
          s.deadRunStreak?.[MB]?.count,
          0,
          "forward progress resets the dead-run streak to 0",
        );
      }
      // Released back to the normal recovery path: a fresh (non-escalation)
      // recovery is enqueued for the window this tick.
      const mbCalls = recoveryCallsForMonth(MB);
      assert.equal(
        mbCalls.length,
        1,
        "a released window re-enters the normal recovery path",
      );
      assert.equal(
        mbCalls[0].resumeMode,
        undefined,
        "the normal recovery enqueue does not clear checkpoints (not an escalation)",
      );
      assert.ok(
        pr.ingestRecoveriesEnqueued >= 1,
        "the released window enqueues a normal recovery",
      );

      console.log(
        "✓ front auto-closure escalation e2e: escalate-once / wait / park / release all passed",
      );
    } finally {
      await setPoolEpicSwitch(SEARCH_SWITCH, origSwitch, "system");
      await cleanup();
    }
  });

}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
