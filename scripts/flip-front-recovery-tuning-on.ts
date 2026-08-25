/**
 * Task #1787 Stage 4 — Turn on Phase 3 tuning + ramp Front recovery
 * ingest concurrency 1 → 3 (post-#1787 throughput follow-up bumped the
 * Stage 4 target from the original 1 → 2 after the worker pool grew
 * 8 → 10 and the global slot cap grew 7 → 9).
 *
 * Preconditions (operator must verify before running with --apply):
 *   - Stage 1 cadence change is stable (front_analytics_coverage_refresh
 *     not hammering the queue every 30m).
 *   - Stage 2 backlog cancellation completed (no stale failed/dead_letter
 *     Front rows lingering — alert noise quiet).
 *   - Stage 3 DB hold split deployed (`front_webhook_apply:read` /
 *     `:persist` labels visible in /admin/db-attribution/trends).
 *   - API pool utilization + worker pool utilization show headroom in
 *     the last 24h (no `db_pool_saturated` in Front recovery checkpoints
 *     during recent runs).
 *
 * What this script does (idempotent):
 *   - Sets `front_recovery_pool_threshold_tuning_enabled = "true"`.
 *   - Sets `front_recovery_ingest_concurrency = "3"` (ramped from the
 *     prior 1 → 2 ceiling after the post-#1787 worker pool bump from
 *     8 → 10 / global slot cap 7 → 9 absorbed the extra concurrency).
 *
 * Watch window after applying:
 *   - First 30 minutes: API/worker pool utilization, Front recovery
 *     pages/min, Front API 429s, lease-churn alerts.
 *   - After 24h: same metrics + Conversation Hub freshness.
 *
 * Rollback (single setting flip per knob):
 *   tsx -e 'import("./server/storage").then(({ storage }) => Promise.all([
 *     storage.setSystemSetting("front_recovery_pool_threshold_tuning_enabled", "false"),
 *     storage.setSystemSetting("front_recovery_ingest_concurrency", "1"),
 *   ]))'
 *
 * Usage:
 *   tsx scripts/flip-front-recovery-tuning-on.ts
 *   tsx scripts/flip-front-recovery-tuning-on.ts --apply
 */

import { storage } from "../server/storage";

const TARGETS: Array<{ key: string; value: string; reason: string }> = [
  {
    key: "front_recovery_pool_threshold_tuning_enabled",
    value: "true",
    reason:
      "Phase 3 hysteresis-aware backoff: consecutive-samples tripped backoff + " +
      "per-page consecutive-saturation flag + 500ms→200ms inter-page sleep.",
  },
  {
    key: "front_recovery_ingest_concurrency",
    value: "3",
    reason:
      "Ramp 1 → 3. Safe after the post-#1787 worker pool bump (8 → 10) " +
      "and global slot cap bump (7 → 9 via RETROACTIVE_REPROCESS_CONCURRENCY 4 → 6). " +
      "Front per-token API rate limit (~50 req/min on most plans) is now " +
      "the dominant ceiling, not our scheduler.",
  },
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log("== Stage 4: Front recovery throughput ramp ==");
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log("");

  for (const t of TARGETS) {
    const before = await storage.getSystemSetting(t.key);
    const beforeVal = before?.value ?? "<unset>";
    console.log(`  ${t.key}`);
    console.log(`    before: ${beforeVal}`);
    console.log(`    after:  ${t.value}`);
    console.log(`    reason: ${t.reason}`);
    if (apply) {
      if (beforeVal === t.value) {
        console.log(`    → already at target, no-op`);
      } else {
        await storage.setSystemSetting(t.key, t.value);
        console.log(`    → APPLIED`);
      }
    }
    console.log("");
  }

  if (!apply) {
    console.log("Dry-run complete. Re-run with --apply to flip the settings.");
    console.log("Watch the 30-minute and 24-hour windows documented in WORKERS_QUEUES_RUNBOOK.md.");
  } else {
    console.log("Settings flipped. Begin Stage 4 watch window now.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
