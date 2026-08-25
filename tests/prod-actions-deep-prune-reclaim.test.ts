/* test-registration
{
  "name": "Deep prune + reclaim prod-action: registration, stamps convergence, VACUUM executor (Task #3814)",
  "smoke": true,
  "smokeReason": "Guards the CEO deep-prune action's registration + convergence stamps + VACUUM executor safety rails (covered-table allowlist, lock-skip); regressions surface as a wedged or destructive prod action.",
  "tier": "small"
}
test-registration */
/**
 * Task #3814 — one-press `deep_prune_reclaim_oversized_tables` production
 * action plus its two companion enable actions.
 *
 * Asserts:
 *  - all three actions are registered in PROD_ACTIONS with status/apply;
 *    the deep-prune action is manual-only (no selfHeal opt-in);
 *  - reclaim-stamp convergence primitives: isStampFresh treats stamps
 *    younger than the 7-day cooldown as fresh, older/absent as stale —
 *    this is what makes status() report not-needed after a successful
 *    reclaim instead of counting the same over-band tables forever;
 *  - readReclaimStamps round-trips the JSON setting and tolerates garbage;
 *  - vacuumFullTable refuses non-covered tables, and really executes
 *    VACUUM (FULL, ANALYZE) on the (small) covered table_size_samples
 *    table — outcome `done`, or `lock_skipped` when another session holds
 *    the table (both are valid terminal outcomes by design);
 *  - formatDeepPruneSummary folds perKey tallies into the human summary
 *    (pruned counts, reclaimed tables, lock-skipped tables);
 *  - live status() executes end-to-end and returns a well-formed state
 *    (value depends on shared dev-DB backlog, so only the shape and
 *    state-domain are asserted).
 *
 * The full drain (runDeepPruneChunk against real backlogs) is deliberately
 * NOT executed here: with production-default retention windows it would
 * mass-delete rows from the shared dev DB and VACUUM FULL its largest
 * tables mid-suite. The chunk pipeline's pieces (deleteOneBatch,
 * vacuumFullTable, stamps) are each covered individually.
 */
import { storage } from "../server/storage";
import {
  PROD_ACTIONS,
} from "../server/services/prodActionsRegistry";
import {
  BACKLOG_PENDING_THRESHOLD,
  DEEP_PRUNE_ACTION_ID,
  RECLAIM_COOLDOWN_MS,
  formatDeepPruneSummary,
  isStampFresh,
  readReclaimStamps,
  resetDeepPruneRunState,
  vacuumFullTable,
} from "../server/services/tableDeepPruneReclaim";
import { TABLE_RECLAIM_STATE_SETTING_KEY } from "../server/services/tableMaintenancePolicy";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main(): Promise<void> {
  // ── registration ──
  const deepPrune = PROD_ACTIONS.find((a) => a.id === DEEP_PRUNE_ACTION_ID);
  assert(deepPrune, "deep_prune_reclaim_oversized_tables registered");
  assert(typeof deepPrune!.status === "function" && typeof deepPrune!.apply === "function",
    "deep-prune action has status/apply");
  assert(deepPrune!.selfHeal === undefined,
    "deep-prune action is manual-only (VACUUM FULL must never self-run)");
  for (const id of ["enable_table_retention_pruner", "enable_table_size_watchdog"]) {
    const a = PROD_ACTIONS.find((x) => x.id === id);
    assert(a, `${id} registered`);
  }

  // ── stamp freshness (convergence primitive) ──
  const now = Date.now();
  assert(!isStampFresh(undefined, now), "absent stamp is stale");
  assert(
    isStampFresh({ at: new Date(now - RECLAIM_COOLDOWN_MS / 2).toISOString(), bytesBefore: 10, bytesAfter: 5 }, now),
    "half-cooldown-old stamp is fresh",
  );
  assert(
    !isStampFresh({ at: new Date(now - RECLAIM_COOLDOWN_MS - 60_000).toISOString(), bytesBefore: 10, bytesAfter: 5 }, now),
    "past-cooldown stamp is stale",
  );
  assert(
    !isStampFresh({ at: "not-a-date", bytesBefore: 10, bytesAfter: 5 } as any, now),
    "unparseable stamp date is stale",
  );

  // ── readReclaimStamps round-trip + garbage tolerance ──
  const prevStamps = await storage.getSystemSetting(TABLE_RECLAIM_STATE_SETTING_KEY);
  try {
    const stamp = { at: new Date(now).toISOString(), bytesBefore: 1000, bytesAfter: 100 };
    await storage.setSystemSetting(
      TABLE_RECLAIM_STATE_SETTING_KEY,
      JSON.stringify({ work_queue: stamp }),
      "test",
    );
    const stamps = await readReclaimStamps();
    assert(stamps.work_queue?.bytesBefore === 1000, "stamps round-trip through the setting");
    assert(isStampFresh(stamps.work_queue, now), "round-tripped stamp is fresh");

    await storage.setSystemSetting(TABLE_RECLAIM_STATE_SETTING_KEY, "{{garbage", "test");
    const garbage = await readReclaimStamps();
    assert(
      garbage && typeof garbage === "object" && Object.keys(garbage).length === 0,
      "garbage stamp JSON degrades to empty stamps, never throws",
    );
  } finally {
    if (prevStamps) {
      await storage.setSystemSetting(TABLE_RECLAIM_STATE_SETTING_KEY, prevStamps.value, "test");
    } else {
      const { deleteSystemSetting } = await import("../server/storage/settingsStorage");
      await deleteSystemSetting(TABLE_RECLAIM_STATE_SETTING_KEY);
    }
  }

  // ── vacuum executor ──
  let rejected = false;
  try {
    await vacuumFullTable("users");
  } catch {
    rejected = true;
  }
  assert(rejected, "vacuumFullTable refuses tables outside the covered policy list");

  const vac = await vacuumFullTable("table_size_samples");
  assert(
    vac.outcome === "done" || vac.outcome === "lock_skipped",
    `vacuum outcome is done|lock_skipped (got ${vac.outcome})`,
  );

  // ── summary formatting ──
  const summary = formatDeepPruneSummary({
    "pruned:work_queue_terminal": 12000,
    "pruned:mcu_cache_expired": 34,
    "reclaimed:work_queue": 1,
    "reclaimed:mcu_cache": 1,
    "lock_skipped:source_event_log": 1,
  });
  assert(/12,034/.test(summary), "summary sums pruned rows across units");
  assert(/work_queue/.test(summary) && /mcu_cache/.test(summary), "summary names reclaimed tables");
  assert(/source_event_log/.test(summary), "summary names lock-skipped tables");
  assert(/again later/.test(summary), "summary tells the operator skipped tables are retryable");

  // ── live status() end-to-end (read-only; shared dev DB decides the state) ──
  resetDeepPruneRunState();
  const status = await deepPrune!.status(null);
  assert(
    status.state === "pending" || status.state === "not-needed",
    `status() resolves a real state (got ${status.state})`,
  );
  assert(typeof status.detail === "string" && status.detail.length > 10, "status() carries a detail");
  assert(BACKLOG_PENDING_THRESHOLD > 0, "pending threshold declared");

  console.log("prod-actions-deep-prune-reclaim.test.ts: ALL PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("prod-actions-deep-prune-reclaim.test.ts FAILED:", err);
    process.exit(1);
  });
