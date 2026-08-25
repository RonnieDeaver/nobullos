/**
 * Task #1784: SEMrush emergency stabilization.
 *
 * One script, four stages:
 *
 *   --stage=baseline   (default if no --stage given, always read-only)
 *       Snapshot of pending / failed / dead_letter counts for the three
 *       SEMrush queues, oldest pending per queue, last created / last
 *       processed per queue, and current queue_drain_state for the two
 *       refresh queues.
 *
 *   --stage=pause      Persist queue_drain_state pause for
 *                      `semrush_background_refresh` and
 *                      `semrush_report_refresh` via the existing
 *                      `setQueuePause` helper (writes
 *                      system_settings.queue_drain_state). Idempotent.
 *
 *   --stage=archive    Flip status='failed' OR 'dead_letter' rows in the
 *                      two refresh queues to status='cancelled' and
 *                      prefix `error_message` with `[backlog-flush
 *                      2026-05] `. Rows are NEVER deleted. Idempotent —
 *                      already-prefixed rows are skipped.
 *
 *   --stage=apply-drain Cancel stale pending rows in
 *                      `semrush_heatmap_apply` where any of:
 *                        - created_at < now() - 24h
 *                        - superseded by a newer pending/leased apply
 *                          row for the same campaign+report_date
 *                      Currently leased/processing rows are NEVER
 *                      touched.
 *
 *   --stage=all        baseline → pause → archive → apply-drain →
 *                      baseline (post).
 *
 * Default mode is dry-run (no writes). Pass `--apply` to commit. The
 * pause stage uses `setQueuePause()` which always writes — but it is
 * idempotent and the operator runbook treats re-running as a safe
 * no-op.
 *
 * Usage:
 *   tsx scripts/semrush-emergency-stabilization.ts                   # baseline only, dry-run
 *   tsx scripts/semrush-emergency-stabilization.ts --stage=all       # full plan, dry-run
 *   tsx scripts/semrush-emergency-stabilization.ts --stage=all --apply
 *   tsx scripts/semrush-emergency-stabilization.ts --stage=archive --apply
 */
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { bindArrayParam } from "../server/utils/sqlArray";

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes("--apply");
const STAGE =
  (ARGS.find((a) => a.startsWith("--stage="))?.split("=")[1] ?? "baseline") as
    | "baseline"
    | "pause"
    | "archive"
    | "apply-drain"
    | "all";
const ACTOR = "task-1784-backlog-flush-2026-05";
const ARCHIVE_PREFIX = "[backlog-flush 2026-05]";
const PAUSE_NOTE = "Pool epic — cadence rewrite pending";
const REFRESH_QUEUES = [
  "semrush_background_refresh",
  "semrush_report_refresh",
] as const;
const ALL_SEMRUSH_QUEUES = [
  ...REFRESH_QUEUES,
  "semrush_heatmap_apply",
] as const;
const STALE_APPLY_AGE_HOURS = 24;

function log(line: string): void {
  console.log(`[SemrushStabilize] ${line}`);
}

async function snapshotBaseline(label: string): Promise<void> {
  log(`---- BASELINE (${label}) ----`);
  const countsRes: any = await workerDb.execute(sql`
    SELECT queue_name, status, COUNT(*)::int AS cnt
    FROM work_queue
    WHERE queue_name IN (
      'semrush_background_refresh',
      'semrush_report_refresh',
      'semrush_heatmap_apply'
    )
    GROUP BY queue_name, status
    ORDER BY queue_name, status
  `);
  const countsRows = (Array.isArray(countsRes) ? countsRes : countsRes.rows ?? []) as Array<{
    queue_name: string;
    status: string;
    cnt: number;
  }>;
  for (const r of countsRows) {
    log(`  count queue=${r.queue_name} status=${r.status} cnt=${r.cnt}`);
  }

  const agesRes: any = await workerDb.execute(sql`
    SELECT
      queue_name,
      MIN(created_at) FILTER (WHERE status = 'pending')   AS oldest_pending,
      MAX(created_at)                                      AS last_created,
      MAX(completed_at) FILTER (WHERE status = 'completed') AS last_processed
    FROM work_queue
    WHERE queue_name IN (
      'semrush_background_refresh',
      'semrush_report_refresh',
      'semrush_heatmap_apply'
    )
    GROUP BY queue_name
    ORDER BY queue_name
  `);
  const ageRows = (Array.isArray(agesRes) ? agesRes : agesRes.rows ?? []) as Array<{
    queue_name: string;
    oldest_pending: Date | null;
    last_created: Date | null;
    last_processed: Date | null;
  }>;
  for (const r of ageRows) {
    log(
      `  ages queue=${r.queue_name} ` +
        `oldest_pending=${r.oldest_pending?.toISOString() ?? "-"} ` +
        `last_created=${r.last_created?.toISOString() ?? "-"} ` +
        `last_processed=${r.last_processed?.toISOString() ?? "-"}`,
    );
  }

  const drainRes: any = await workerDb.execute(sql`
    SELECT value
    FROM system_settings
    WHERE key = 'queue_drain_state'
    LIMIT 1
  `);
  const drainRow = (Array.isArray(drainRes) ? drainRes : drainRes.rows ?? [])[0] as
    | { value: string }
    | undefined;
  if (!drainRow?.value) {
    log("  queue_drain_state: <unset>");
  } else {
    try {
      const parsed = JSON.parse(drainRow.value);
      for (const q of REFRESH_QUEUES) {
        const s = parsed?.[q];
        log(
          `  queue_drain_state queue=${q} ` +
            `paused=${s?.paused ?? false} pausedAt=${s?.pausedAt ?? "-"} ` +
            `pausedAtBacklog=${s?.pausedAtBacklog ?? "-"} ` +
            `pauseNote=${s?.pauseNote ? JSON.stringify(s.pauseNote) : "-"}`,
        );
      }
    } catch (err: any) {
      log(`  queue_drain_state: <parse failed: ${err?.message}>`);
    }
  }

  // Task #1784 — operational proof for Stage 0 / Stage 5 acceptance:
  // capture the most-recent `pool_state_samples` row per pool plus the
  // lease-churn signals (reset stale leases + dead-lettered SEMrush
  // rows in the last hour). These come from `worker_log_events` only
  // when those workers actually ran; absence is reported as `-`.
  try {
    const poolRes: any = await workerDb.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (pool_name) *
        FROM pool_state_samples
        WHERE sampled_at > (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint - 600000
        ORDER BY pool_name, sampled_at DESC
      )
      SELECT pool_name, utilization_pct, total_count, max_count,
             waiting_count, slow_holds_in_interval, top_hold_labels
      FROM latest
      ORDER BY pool_name
    `);
    const poolRows = (Array.isArray(poolRes) ? poolRes : poolRes.rows ?? []) as Array<{
      pool_name: string;
      utilization_pct: number;
      total_count: number;
      max_count: number;
      waiting_count: number;
      slow_holds_in_interval: number;
      top_hold_labels: unknown;
    }>;
    if (poolRows.length === 0) {
      log("  pool_state_samples: <no samples in last 10m>");
    } else {
      for (const r of poolRows) {
        const labels = Array.isArray(r.top_hold_labels)
          ? (r.top_hold_labels as Array<{ label?: string; count?: number }>)
              .slice(0, 3)
              .map((l) => `${l.label ?? "?"}:${l.count ?? 0}`)
              .join(",")
          : "-";
        log(
          `  pool pool=${r.pool_name} util=${r.utilization_pct}% ` +
            `in_use=${r.total_count}/${r.max_count} waiting=${r.waiting_count} ` +
            `slow_holds=${r.slow_holds_in_interval} top_holds=[${labels}]`,
        );
      }
    }
  } catch (err: any) {
    log(`  pool_state_samples: <query failed: ${err?.message}>`);
  }

  // Lease-churn proxy from `work_queue` — same source `leaseChurnAlerts`
  // uses: rows completed in the last hour with a churn-related
  // error_code, plus SEMrush-queue dead-letter count over the same
  // window. Matches the cross-queue churn rollup operators already
  // monitor in Slack.
  try {
    const churnRes: any = await workerDb.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE completed_at > NOW() - INTERVAL '1 hour'
          AND error_code IN ('stale_lease_exhaustion','max_processing_exhaustion','startup_stale_recovery')
        )::int AS stale_resets_1h,
        COUNT(*) FILTER (
          WHERE completed_at > NOW() - INTERVAL '1 hour'
          AND status = 'dead_letter'
          AND queue_name LIKE 'semrush%'
        )::int AS semrush_dlq_1h
      FROM work_queue
      WHERE completed_at > NOW() - INTERVAL '1 hour'
    `);
    const churn = ((Array.isArray(churnRes) ? churnRes : churnRes.rows ?? [])[0] ?? {}) as {
      stale_resets_1h?: number;
      semrush_dlq_1h?: number;
    };
    log(
      `  lease_churn(1h): stale_resets=${churn.stale_resets_1h ?? 0} ` +
        `semrush_dead_letters=${churn.semrush_dlq_1h ?? 0}`,
    );
  } catch (err: any) {
    log(`  lease_churn: <query failed: ${err?.message}>`);
  }
}

async function pauseQueues(): Promise<void> {
  log("---- STAGE: pause refresh queues ----");
  if (!APPLY) {
    log(
      "  DRY-RUN: would call setQueuePause(queue, true, actor) for both refresh queues",
    );
    for (const q of REFRESH_QUEUES) log(`  DRY-RUN: pause ${q} (note: ${PAUSE_NOTE})`);
    return;
  }
  const { setQueuePause, isQueuePaused, ensureQueueDrainStateLoaded } =
    await import("../server/services/queueDrainControl");
  await ensureQueueDrainStateLoaded();
  for (const q of REFRESH_QUEUES) {
    if (isQueuePaused(q)) {
      log(`  ${q} already paused — no-op`);
      continue;
    }
    const next = await setQueuePause(q, true, ACTOR, { note: PAUSE_NOTE });
    log(
      `  ✓ paused ${q} pausedAt=${next.pausedAt} pausedAtBacklog=${next.pausedAtBacklog ?? "-"}`,
    );
  }
  log(`  pause note (operator-facing): "${PAUSE_NOTE}"`);
}

async function archiveRefreshBacklog(): Promise<void> {
  log("---- STAGE: archive failed + dead-letter refresh rows ----");
  const beforeRes: any = await workerDb.execute(sql`
    SELECT queue_name, status, COUNT(*)::int AS cnt
    FROM work_queue
    WHERE queue_name IN ('semrush_background_refresh', 'semrush_report_refresh')
      AND status IN ('failed', 'dead_letter')
    GROUP BY queue_name, status
    ORDER BY queue_name, status
  `);
  const beforeRows = (Array.isArray(beforeRes) ? beforeRes : beforeRes.rows ?? []) as Array<{
    queue_name: string;
    status: string;
    cnt: number;
  }>;
  for (const r of beforeRows) {
    log(`  before queue=${r.queue_name} status=${r.status} cnt=${r.cnt}`);
  }
  if (beforeRows.length === 0) log("  before: nothing to archive");

  if (!APPLY) {
    log("  DRY-RUN: would UPDATE these rows status='cancelled' with prefix");
    return;
  }

  const updateRes: any = await workerDb.execute(sql`
    UPDATE work_queue
    SET
      status = 'cancelled',
      error_message = ${ARCHIVE_PREFIX + " "} || COALESCE(error_message, '<no error_message>'),
      completed_at = COALESCE(completed_at, NOW()),
      updated_at = NOW()
    WHERE queue_name IN ('semrush_background_refresh', 'semrush_report_refresh')
      AND status IN ('failed', 'dead_letter')
      AND (error_message IS NULL OR position(${ARCHIVE_PREFIX} in error_message) <> 1)
    RETURNING id, queue_name
  `);
  const updatedRows = (Array.isArray(updateRes) ? updateRes : updateRes.rows ?? []) as Array<{
    id: string;
    queue_name: string;
  }>;
  const byQueue = new Map<string, number>();
  for (const r of updatedRows) byQueue.set(r.queue_name, (byQueue.get(r.queue_name) ?? 0) + 1);
  for (const [q, n] of byQueue.entries()) log(`  ✓ cancelled ${n} rows in ${q}`);
  log(`  total archived: ${updatedRows.length}`);

  const afterRes: any = await workerDb.execute(sql`
    SELECT queue_name, status, COUNT(*)::int AS cnt
    FROM work_queue
    WHERE queue_name IN ('semrush_background_refresh', 'semrush_report_refresh')
      AND status IN ('failed', 'dead_letter')
    GROUP BY queue_name, status
    ORDER BY queue_name, status
  `);
  const afterRows = (Array.isArray(afterRes) ? afterRes : afterRes.rows ?? []) as Array<{
    queue_name: string;
    status: string;
    cnt: number;
  }>;
  for (const r of afterRows) {
    log(`  after  queue=${r.queue_name} status=${r.status} cnt=${r.cnt}`);
  }
  if (afterRows.length === 0) log("  after: 0 failed/dead_letter rows remain");
}

async function drainStaleApplyJobs(): Promise<void> {
  log("---- STAGE: drain stale/superseded semrush_heatmap_apply pending ----");
  const beforeRes: any = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM work_queue
    WHERE queue_name = 'semrush_heatmap_apply' AND status = 'pending'
  `);
  const pendingBefore =
    ((Array.isArray(beforeRes) ? beforeRes : beforeRes.rows ?? [])[0] as { cnt: number })?.cnt ?? 0;
  log(`  pending before: ${pendingBefore}`);

  // ── Safety model ──
  // We will only cancel pending apply rows under two conditions, both
  // of which guarantee the row is NOT the latest visible apply work
  // for its target:
  //
  //   1. `superseded` — a strictly newer apply row (pending/leased/
  //      processing) exists for the same `work_result_log.correlation_id`
  //      (canonical `${campaignId}:${locationId}:${keywordId}:${reportDate}`).
  //      Even though the refresh queues are paused, any *enqueued* newer
  //      apply row already carries fresher data than the older sibling.
  //
  //   2. `orphan_over_24h` — `payload->>'workResultId'` does NOT resolve
  //      to a `work_result_log` row (deleted / never inserted), so there
  //      is literally nothing to apply, AND the row was created > 24h
  //      ago. This catches truly broken rows; it can never cancel a
  //      latest-valid apply because there is no `work_result_log` data
  //      backing it at all.
  //
  // A pending apply that is "merely" >24h old but still the latest for
  // its target is **NOT** cancelled — that case is `keep_latest_old`
  // and will be reported in the candidate breakdown so operators can
  // see it but the script will leave it for the apply worker to process
  // when the queue catches up. Leased/processing rows count as valid
  // superseders but are NEVER cancelled themselves; the UPDATE below
  // re-checks `status='pending' AND lease_owner IS NULL` at write time.
  const candidatesRes: any = await workerDb.execute(sql`
    WITH apply AS (
      SELECT
        wq.id,
        wq.created_at,
        wq.status,
        wq.lease_owner,
        wq.payload->>'workResultId' AS work_result_id_str,
        wrl.id AS wrl_id,
        wrl.correlation_id
      FROM work_queue wq
      LEFT JOIN work_result_log wrl
        ON wrl.id::text = wq.payload->>'workResultId'
      WHERE wq.queue_name = 'semrush_heatmap_apply'
        AND wq.status IN ('pending', 'leased', 'processing')
    ),
    pending AS (
      SELECT id, created_at, correlation_id, work_result_id_str, wrl_id
      FROM apply
      WHERE status = 'pending'
        AND lease_owner IS NULL
    ),
    superseded AS (
      SELECT DISTINCT p.id
      FROM pending p
      JOIN apply newer
        ON  newer.correlation_id IS NOT NULL
        AND newer.correlation_id = p.correlation_id
        AND newer.id <> p.id
        AND newer.created_at > p.created_at
    )
    SELECT
      id,
      created_at,
      CASE
        WHEN id IN (SELECT id FROM superseded)
          THEN 'superseded'
        WHEN wrl_id IS NULL
          AND created_at < NOW() - (${STALE_APPLY_AGE_HOURS} || ' hours')::interval
          THEN 'orphan_over_24h'
        WHEN created_at < NOW() - (${STALE_APPLY_AGE_HOURS} || ' hours')::interval
          THEN 'keep_latest_old'
        ELSE 'keep'
      END AS reason
    FROM pending
  `);
  const candidates = (Array.isArray(candidatesRes) ? candidatesRes : candidatesRes.rows ?? []) as Array<{
    id: string;
    created_at: Date;
    reason: string;
  }>;
  const superseded = candidates.filter((r) => r.reason === "superseded").map((r) => r.id);
  const orphanOver24h = candidates
    .filter((r) => r.reason === "orphan_over_24h")
    .map((r) => r.id);
  const keepLatestOld = candidates.filter((r) => r.reason === "keep_latest_old").length;
  const keep = candidates.filter((r) => r.reason === "keep").length;
  log(
    `  candidates: superseded=${superseded.length} orphan_over_24h=${orphanOver24h.length}` +
      ` keep_latest_old=${keepLatestOld} keep=${keep}`,
  );
  if (keepLatestOld > 0) {
    log(
      `  NOTE: ${keepLatestOld} pending apply rows are >24h old but still the latest for their target` +
        ` — NOT cancelled; the apply worker will catch up when the backlog drains.`,
    );
  }

  const toCancel = Array.from(new Set([...superseded, ...orphanOver24h]));
  if (toCancel.length === 0) {
    log("  nothing to cancel");
    return;
  }

  if (!APPLY) {
    log(`  DRY-RUN: would cancel ${toCancel.length} rows`);
    return;
  }

  // Re-check status='pending' AND lease_owner IS NULL at write time so
  // we never clobber a row that was just claimed.
  const chunkSize = 500;
  let cancelled = 0;
  for (let i = 0; i < toCancel.length; i += chunkSize) {
    const chunk = toCancel.slice(i, i + chunkSize);
    const res: any = await workerDb.execute(sql`
      UPDATE work_queue
      SET
        status = 'cancelled',
        error_message = ${ARCHIVE_PREFIX + " stale_or_superseded_pending_apply"},
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = ANY(${bindArrayParam(chunk, "varchar")})
        AND queue_name = 'semrush_heatmap_apply'
        AND status = 'pending'
        AND lease_owner IS NULL
      RETURNING id
    `);
    cancelled += ((Array.isArray(res) ? res : res.rows ?? []) as any[]).length;
  }
  log(`  ✓ cancelled ${cancelled} stale/superseded apply rows`);

  const afterRes: any = await workerDb.execute(sql`
    SELECT
      COUNT(*)::int AS cnt,
      MIN(created_at) AS oldest
    FROM work_queue
    WHERE queue_name = 'semrush_heatmap_apply' AND status = 'pending'
  `);
  const afterRow = ((Array.isArray(afterRes) ? afterRes : afterRes.rows ?? [])[0] ?? {}) as {
    cnt: number;
    oldest: Date | null;
  };
  log(
    `  pending after: ${afterRow.cnt ?? 0} oldest_remaining=${
      afterRow.oldest ? afterRow.oldest.toISOString() : "-"
    }`,
  );
}

async function main(): Promise<void> {
  log(
    `Mode: ${APPLY ? "APPLY" : "DRY-RUN"} Stage: ${STAGE} ` +
      `Queues: ${ALL_SEMRUSH_QUEUES.join(", ")}`,
  );

  if (STAGE === "baseline") {
    await snapshotBaseline("only");
    return;
  }

  if (STAGE === "all" || STAGE === "pause") {
    if (STAGE === "all") await snapshotBaseline("before");
    await pauseQueues();
  }
  if (STAGE === "all" || STAGE === "archive") {
    if (STAGE === "archive") await snapshotBaseline("before");
    await archiveRefreshBacklog();
  }
  if (STAGE === "all" || STAGE === "apply-drain") {
    if (STAGE === "apply-drain") await snapshotBaseline("before");
    await drainStaleApplyJobs();
  }
  if (STAGE === "all") {
    await snapshotBaseline("after");
  }

  if (!APPLY) {
    log("DRY-RUN complete. Re-run with --apply to commit writes.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[SemrushStabilize] FAILED:", err);
    process.exit(1);
  });
