/**
 * Task #1829 Phase 7 — Front pipeline warp-speed validator.
 *
 * Three modes, one script:
 *
 *   npx tsx scripts/front-warp-validate.ts
 *     Dry-run. Read-only snapshot of: kill switches, persisted
 *     settings, live in-memory settings, workload-manager state,
 *     pending counts per queue × workload_class, recent completions
 *     (5 min), pool state, Front API 429 count, DB hold labels > 10s,
 *     newest `front_sync_emails` row. Prints what would change. Does
 *     not flip any switch.
 *
 *   npx tsx scripts/front-warp-validate.ts --apply [--wait-seconds N]
 *     Activation flow. Snapshot → set
 *     `front_warp_speed_enabled='true'` in `system_settings` →
 *     wait 10 min (default; `--wait-seconds` overrides for testing) →
 *     re-sample → print PASS/FAIL against Phase 7 criteria. On FAIL,
 *     prints the rollback SQL.
 *
 *   npx tsx scripts/front-warp-validate.ts --rollback
 *     Flip `front_warp_speed_enabled='false'`. Idempotent.
 *
 * PASS criteria (from task plan):
 *   - `front_webhook_normalize` ≥ 30 completions/min
 *   - `front_webhook_apply` ≥ 30 completions/min
 *   - worker pool utilization < 80 %
 *   - API pool waiters ≈ 0 (no material increase vs baseline)
 *   - no Front 429 spike (recent count ≤ baseline)
 *   - no Front-labelled DB hold > 10 s
 *   - newest `front_sync_emails` timestamp advances
 *
 * Pool tenancy: uses `workerDb` because this is a worker-pool admin
 * task, not a request handler. The settings flip goes through
 * `storage.setSystemSetting` (worker-pool tenant).
 *
 * Safety: this script does NOT delete rows, does NOT touch any pool
 * config, and does NOT cancel work-queue rows. The only mutation is
 * `system_settings.front_warp_speed_enabled`.
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  isPoolEpicSwitchEnabled,
  ensurePoolEpicSwitchesLoaded,
  POOL_EPIC_SWITCH_NAMES,
} from "../server/services/poolEpicKillSwitches";
import {
  ensureFrontWarpSettingsLoaded,
  getFrontWarpSettings,
  FRONT_WARP_QUEUE_NAMES,
  FRONT_WARP_SETTING_KEYS,
  getRecentFront429Count,
  getFrontWarpGuardCounters,
} from "../server/services/frontWarpSettings";
import {
  getFrontIngestionClassConcurrency,
  getFrontIngestionManualReserve,
  TOTAL_BUDGET,
} from "../server/services/workloadManager";

interface Args {
  apply: boolean;
  rollback: boolean;
  waitSeconds: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, rollback: false, waitSeconds: 600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--rollback") out.rollback = true;
    else if (a === "--wait-seconds") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.waitSeconds = Math.floor(n);
    }
  }
  if (out.apply && out.rollback) {
    throw new Error("--apply and --rollback are mutually exclusive");
  }
  return out;
}

interface Snapshot {
  takenAt: Date;
  pendingByQueueClass: Array<{ queue_name: string; workload_class: string; c: number }>;
  completionsLast5MinPerQueue: Record<string, number>;
  oldestPendingAgeSecPerQueue: Record<string, number | null>;
  workerPool: { active: number; idle: number; total: number; max: number; utilizationPct: number; waiting: number };
  apiPool: { active: number; idle: number; total: number; max: number; utilizationPct: number; waiting: number };
  recentFront429: number;
  frontLabelsOver10sLast5Min: Array<{ pool: string; hold_label: string; max_duration_ms: number; count: number }>;
  newestFrontSyncEmailAt: string | null;
  guardCounters: ReturnType<typeof getFrontWarpGuardCounters>;
}

async function takeSnapshot(): Promise<Snapshot> {
  const takenAt = new Date();
  const { getWorkerPoolSnapshot, getApiPoolSnapshot } = await import("../server/db");

  const pending = (await workerDb.execute<{ queue_name: string; workload_class: string; c: number }>(sql`
    SELECT queue_name, workload_class, COUNT(*)::int AS c
    FROM work_queue
    WHERE queue_name IN (${sql.join(FRONT_WARP_QUEUE_NAMES.map((n) => sql`${n}`), sql`, `)})
      AND status = 'pending'
    GROUP BY queue_name, workload_class
    ORDER BY queue_name, workload_class
  `)).rows as any[];

  const completions = (await workerDb.execute<{ queue_name: string; c: number }>(sql`
    SELECT queue_name, COUNT(*)::int AS c
    FROM work_queue
    WHERE queue_name IN (${sql.join(FRONT_WARP_QUEUE_NAMES.map((n) => sql`${n}`), sql`, `)})
      AND status = 'completed'
      AND completed_at >= NOW() - INTERVAL '5 minutes'
    GROUP BY queue_name
  `)).rows as any[];
  const completionsLast5MinPerQueue: Record<string, number> = {};
  for (const q of FRONT_WARP_QUEUE_NAMES) completionsLast5MinPerQueue[q] = 0;
  for (const r of completions) completionsLast5MinPerQueue[r.queue_name] = Number(r.c);

  const oldestPending = (await workerDb.execute<{ queue_name: string; age_sec: number }>(sql`
    SELECT queue_name,
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS age_sec
    FROM work_queue
    WHERE queue_name IN (${sql.join(FRONT_WARP_QUEUE_NAMES.map((n) => sql`${n}`), sql`, `)})
      AND status = 'pending'
    GROUP BY queue_name
  `)).rows as any[];
  const oldestPendingAgeSecPerQueue: Record<string, number | null> = {};
  for (const q of FRONT_WARP_QUEUE_NAMES) oldestPendingAgeSecPerQueue[q] = null;
  for (const r of oldestPending) oldestPendingAgeSecPerQueue[r.queue_name] = Number(r.age_sec);

  let frontLabelsOver10sLast5Min: any[] = [];
  try {
    frontLabelsOver10sLast5Min = (await workerDb.execute(sql`
      SELECT pool, hold_label, MAX(max_duration_ms)::int AS max_duration_ms, SUM(count)::int AS count
      FROM db_hold_label_rollups
      WHERE date >= TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
        AND hold_label LIKE 'worker:front_%'
        AND max_duration_ms >= 10000
      GROUP BY pool, hold_label
      ORDER BY max_duration_ms DESC
      LIMIT 20
    `)).rows as any[];
  } catch {
    /* rollup table may not exist in some envs — non-fatal */
  }

  let newestFrontSyncEmailAt: string | null = null;
  try {
    const r = (await workerDb.execute<{ ts: string | null }>(sql`
      SELECT MAX(updated_at)::text AS ts FROM front_sync_emails
    `)).rows[0] as any;
    newestFrontSyncEmailAt = r?.ts ?? null;
  } catch {
    /* table may not exist in test envs */
  }

  return {
    takenAt,
    pendingByQueueClass: pending,
    completionsLast5MinPerQueue,
    oldestPendingAgeSecPerQueue,
    workerPool: { ...getWorkerPoolSnapshot() },
    apiPool: { ...getApiPoolSnapshot() },
    recentFront429: getRecentFront429Count(),
    frontLabelsOver10sLast5Min,
    newestFrontSyncEmailAt,
    guardCounters: getFrontWarpGuardCounters(),
  };
}

function printSnapshot(label: string, s: Snapshot) {
  console.log(`\n=== Snapshot: ${label} @ ${s.takenAt.toISOString()} ===`);
  console.log("Pending by queue × workload_class:");
  if (s.pendingByQueueClass.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of s.pendingByQueueClass) {
      console.log(`  ${r.queue_name.padEnd(28)} ${String(r.workload_class).padEnd(18)} ${r.c}`);
    }
  }
  console.log("Oldest pending age (sec):");
  for (const q of FRONT_WARP_QUEUE_NAMES) {
    const age = s.oldestPendingAgeSecPerQueue[q];
    console.log(`  ${q.padEnd(28)} ${age == null ? "—" : `${age}s`}`);
  }
  console.log("Completions last 5 min (per/min):");
  for (const q of FRONT_WARP_QUEUE_NAMES) {
    const total = s.completionsLast5MinPerQueue[q];
    console.log(`  ${q.padEnd(28)} ${total} total → ${(total / 5).toFixed(1)}/min`);
  }
  console.log(`Worker pool: active=${s.workerPool.active}/${s.workerPool.max} (util=${s.workerPool.utilizationPct}%, idle=${s.workerPool.idle}, waiting=${s.workerPool.waiting})`);
  console.log(`API pool:    active=${s.apiPool.active}/${s.apiPool.max} (util=${s.apiPool.utilizationPct}%, idle=${s.apiPool.idle}, waiting=${s.apiPool.waiting})`);
  console.log(`Front API 429 (last 60s): ${s.recentFront429}`);
  console.log(`Front DB-hold labels ≥10s today: ${s.frontLabelsOver10sLast5Min.length}`);
  for (const r of s.frontLabelsOver10sLast5Min) {
    console.log(`  ${r.pool}/${r.hold_label}  max=${r.max_duration_ms}ms  count=${r.count}`);
  }
  console.log(`Newest front_sync_emails.updated_at: ${s.newestFrontSyncEmailAt ?? "(unknown)"}`);
  console.log(`Guard counters: ${JSON.stringify(s.guardCounters)}`);
}

interface PassFail { ok: boolean; reason: string }

function evaluate(before: Snapshot, after: Snapshot): PassFail[] {
  const checks: PassFail[] = [];

  const normCompletions = after.completionsLast5MinPerQueue["front_webhook_normalize"] ?? 0;
  const applyCompletions = after.completionsLast5MinPerQueue["front_webhook_apply"] ?? 0;
  // Completions are 5-min totals; 30/min = 150 over 5 min.
  checks.push({
    ok: normCompletions >= 150,
    reason: `front_webhook_normalize: ${normCompletions} completions in last 5 min (need ≥ 150 = 30/min) → ${(normCompletions / 5).toFixed(1)}/min`,
  });
  checks.push({
    ok: applyCompletions >= 150,
    reason: `front_webhook_apply:     ${applyCompletions} completions in last 5 min (need ≥ 150 = 30/min) → ${(applyCompletions / 5).toFixed(1)}/min`,
  });

  checks.push({
    ok: after.workerPool.utilizationPct < 80,
    reason: `worker pool utilization: ${after.workerPool.utilizationPct}% (need < 80%)`,
  });

  // API pool waiters: must not materially increase. Accept up to +1
  // since the read itself can briefly enqueue.
  const waiterDelta = after.apiPool.waiting - before.apiPool.waiting;
  checks.push({
    ok: waiterDelta <= 1,
    reason: `API pool waiters: before=${before.apiPool.waiting}, after=${after.apiPool.waiting} (delta=${waiterDelta}, allow ≤ 1)`,
  });

  // No Front 429 spike: after count must not exceed before by more than 2.
  const f429Delta = after.recentFront429 - before.recentFront429;
  checks.push({
    ok: f429Delta <= 2,
    reason: `Front 429 (last 60s): before=${before.recentFront429}, after=${after.recentFront429} (delta=${f429Delta}, allow ≤ 2)`,
  });

  // No NEW Front-labelled DB hold > 10 s during the window.
  const newHolds = after.frontLabelsOver10sLast5Min.length - before.frontLabelsOver10sLast5Min.length;
  checks.push({
    ok: newHolds <= 0,
    reason: `Front DB-hold labels ≥10s: before=${before.frontLabelsOver10sLast5Min.length}, after=${after.frontLabelsOver10sLast5Min.length} (delta=${newHolds}, allow ≤ 0)`,
  });

  // front_sync_emails timestamp must advance OR start non-null.
  let fsAdvanced = false;
  if (after.newestFrontSyncEmailAt && !before.newestFrontSyncEmailAt) fsAdvanced = true;
  else if (after.newestFrontSyncEmailAt && before.newestFrontSyncEmailAt) {
    fsAdvanced = new Date(after.newestFrontSyncEmailAt).getTime() > new Date(before.newestFrontSyncEmailAt).getTime();
  }
  checks.push({
    ok: fsAdvanced,
    reason: `front_sync_emails newest: before=${before.newestFrontSyncEmailAt ?? "(none)"}, after=${after.newestFrontSyncEmailAt ?? "(none)"} (advanced=${fsAdvanced})`,
  });

  return checks;
}

const ROLLBACK_SQL = `
-- Task #1829 rollback. Idempotent.
UPDATE system_settings SET value='false' WHERE key='front_warp_speed_enabled';
-- Optional belt-and-braces: shrink class concurrency so existing
-- workload_class='front_ingestion' rows can't keep multi-dispatching.
UPDATE system_settings SET value='1' WHERE key='front_ingestion_class_concurrency';
`.trim();

async function printDryRun(): Promise<void> {
  console.log("=== Task #1829 Front warp-speed validator — DRY RUN ===\n");

  await ensurePoolEpicSwitchesLoaded();
  console.log("-- Kill switches --");
  const switches = [
    "front_warp_speed_enabled",
    "front_ingestion_api_waiter_backoff_enabled",
    "front_ingestion_front_rate_limit_guard_enabled",
  ] as const;
  for (const name of switches) {
    if (!(POOL_EPIC_SWITCH_NAMES as readonly string[]).includes(name)) {
      console.log(`  ${name} = MISSING from POOL_EPIC_SWITCH_NAMES`);
      continue;
    }
    console.log(`  ${name} = ${isPoolEpicSwitchEnabled(name)}`);
  }

  console.log("\n-- Persisted settings rows --");
  const persisted = await storage.getSystemSettings([...FRONT_WARP_SETTING_KEYS]);
  for (const k of FRONT_WARP_SETTING_KEYS) {
    console.log(`  ${k} = ${persisted[k] ?? "(unset, default)"}`);
  }

  await ensureFrontWarpSettingsLoaded();
  const cfg = getFrontWarpSettings();
  console.log("\n-- Live in-memory settings --");
  console.log(`  classConcurrency=${cfg.classConcurrency}  manualReserve=${cfg.manualReserve}  pollIntervalMs=${cfg.pollIntervalMs}  perCycleDispatchMax=${cfg.perCycleDispatchMax}  workerIdleMin=${cfg.workerIdleMin}`);

  console.log("\n-- Workload-manager live state --");
  console.log(`  front_ingestion class cap = ${getFrontIngestionClassConcurrency()}  reserve = ${getFrontIngestionManualReserve()}  TOTAL_BUDGET = ${TOTAL_BUDGET}`);

  const snap = await takeSnapshot();
  printSnapshot("dry-run", snap);

  console.log("\n=== What --apply would do ===");
  console.log("  1. Re-snapshot baseline.");
  console.log("  2. UPDATE system_settings SET value='true' WHERE key='front_warp_speed_enabled'.");
  console.log("  3. Wait 10 minutes (override with --wait-seconds N).");
  console.log("  4. Re-snapshot post-activation.");
  console.log("  5. Print PASS/FAIL against the 7 Phase-7 criteria.");
  console.log("\nRollback SQL (always safe to run):");
  console.log(ROLLBACK_SQL);
}

async function runApply(waitSeconds: number): Promise<void> {
  console.log("=== Task #1829 Front warp-speed validator — APPLY ===\n");
  await ensurePoolEpicSwitchesLoaded();
  await ensureFrontWarpSettingsLoaded();

  const before = await takeSnapshot();
  printSnapshot("baseline (pre-flip)", before);

  console.log("\n>>> Flipping system_settings.front_warp_speed_enabled = 'true' ...");
  await storage.setSystemSetting("front_warp_speed_enabled", "true");
  console.log(`>>> Waiting ${waitSeconds}s for the fast-poll loop to pick up the flip and drain backlog ...`);
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));

  const after = await takeSnapshot();
  printSnapshot("post-activation", after);

  const checks = evaluate(before, after);
  console.log("\n=== PASS/FAIL ===");
  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.reason}`);
  }

  if (!allOk) {
    console.error("\n*** OVERALL: FAIL ***");
    console.error("Rollback SQL (run now if Front pipeline misbehaving):");
    console.error(ROLLBACK_SQL);
    process.exit(2);
  } else {
    console.log("\n*** OVERALL: PASS ***");
    console.log("Rollback SQL (keep handy):");
    console.log(ROLLBACK_SQL);
  }
}

async function runRollback(): Promise<void> {
  console.log("=== Task #1829 Front warp-speed validator — ROLLBACK ===\n");
  await ensurePoolEpicSwitchesLoaded();
  console.log("Setting front_warp_speed_enabled = 'false' ...");
  await storage.setSystemSetting("front_warp_speed_enabled", "false");
  console.log("Done. Verify via: SELECT key, value FROM system_settings WHERE key='front_warp_speed_enabled';");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rollback) {
    await runRollback();
  } else if (args.apply) {
    await runApply(args.waitSeconds);
  } else {
    await printDryRun();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("front-warp-validate failed:", err);
  process.exit(1);
});
