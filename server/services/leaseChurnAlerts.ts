/**
 * Task #1676 — cross-queue lease churn + production pipeline backlog alerts.
 *
 * The May 20 production health check found that several pipelines
 * (Front webhook normalize/apply, raw_communication_records AI
 * processing, SEMrush refresh) had re-accumulated backlogs despite
 * recent targeted fixes (#1602, #1050, #952, ...). The shared root
 * cause was cross-queue worker lease churn — `stale_lease_exhaustion`
 * and `startup_stale_recovery` terminal classifications growing across
 * many queues, driven by graceful-shutdown not releasing in-flight
 * leases (now fixed in `workScheduler.releaseInFlightLeasesOnShutdown`).
 *
 * This watcher is the regression-alert leg of the same task. It runs
 * every CHECK_INTERVAL_MS and fires Slack alerts (via the unified
 * `notifyByType` dispatcher) when any of the following hold:
 *
 *   1. Cross-queue lease churn — count of `work_queue` rows that
 *      terminated in the last hour with
 *      `error_code IN ('stale_lease_exhaustion',
 *                     'max_processing_exhaustion',
 *                     'startup_stale_recovery')`
 *      exceeds `lease_churn_alert_per_hour_threshold`.
 *
 *   2. Front webhook backlog — `front_webhook_normalize` or
 *      `front_webhook_apply` pending count > threshold AND oldest
 *      pending row older than `lease_churn_backlog_age_minutes`.
 *
 *   3. raw_communication_records ratio inversion — over the last 30
 *      days, `pending > processed` AND oldest pending older than the
 *      same age window.
 *
 *   4. SEMrush dead-letter spike — combined
 *      `semrush_report_refresh` + `semrush_background_refresh`
 *      dead-letter count grew by more than
 *      `lease_churn_semrush_dlq_growth_threshold` in the last hour.
 *
 * Each alert condition has its own per-condition cooldown (in-memory)
 * so a sustained incident doesn't spam Slack every check interval.
 *
 * All thresholds live in `system_settings` so an operator can tune
 * them without a deploy. The watcher itself is gated by
 * `lease_churn_alerts_enabled` (default true).
 */
import { sql } from "drizzle-orm";
import { workerDb, withDbAttribution } from "../db";
import { getSystemSetting } from "../storage/settingsStorage";
import { registerAlertProbe } from "./probeAudit";

// Task #1882 — register a no-op (LIMIT 0) variant of every probe query
// so the boot-time probe audit fails loudly if a column is renamed or
// a table goes missing, instead of silently warn-and-skip every tick.
registerAlertProbe("leaseChurnAlerts.lease_churn", async () => {
  await workerDb.execute(sql`
    SELECT queue_name, error_code, COUNT(*)::int AS cnt
    FROM work_queue
    WHERE completed_at >= NOW()
      AND error_code IN (
        'stale_lease_exhaustion',
        'max_processing_exhaustion',
        'startup_stale_recovery'
      )
    GROUP BY queue_name, error_code
    LIMIT 0
  `);
});
registerAlertProbe("leaseChurnAlerts.front_backlog", async () => {
  await workerDb.execute(sql`
    SELECT queue_name,
           COUNT(*)::int AS pending,
           COUNT(*) FILTER (WHERE created_at <= NOW())::int AS aged_pending,
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_age_seconds
    FROM work_queue
    WHERE status = 'pending'
      AND queue_name IN ('front_webhook_normalize', 'front_webhook_apply')
    GROUP BY queue_name
    LIMIT 0
  `);
});
registerAlertProbe("leaseChurnAlerts.raw_communications_inverted", async () => {
  await workerDb.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE processing_status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE processing_status = 'processed')::int AS processed,
      COUNT(*) FILTER (WHERE processing_status = 'processing')::int AS processing,
      EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE processing_status = 'pending')))::int AS oldest_pending_seconds
    FROM raw_communication_records
    WHERE created_at >= NOW()
    LIMIT 0
  `);
});
registerAlertProbe("leaseChurnAlerts.semrush_dlq", async () => {
  await workerDb.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM work_queue
    WHERE status = 'dead_letter'
      AND queue_name IN ('semrush_report_refresh', 'semrush_background_refresh')
    LIMIT 0
  `);
});

const NOTIF_LEASE_CHURN = "queue.scheduler.lease_churn_spike";
const NOTIF_FRONT_BACKLOG = "queue.front_webhook.backlog";
const NOTIF_RAW_COMM_INVERTED = "queue.raw_communications.processing_inverted";
const NOTIF_SEMRUSH_DLQ = "queue.semrush_refresh.dead_letter_spike";
const NOTIF_DENOMINATOR_FLOOR = "infra.front_coverage.denominator_floor_violated";

export const SETTING_ENABLED = "lease_churn_alerts_enabled";
export const SETTING_CHURN_PER_HOUR = "lease_churn_alert_per_hour_threshold";
export const SETTING_BACKLOG_THRESHOLD = "lease_churn_backlog_threshold";
export const SETTING_BACKLOG_AGE_MIN = "lease_churn_backlog_age_minutes";
export const SETTING_SEMRUSH_DLQ_GROWTH = "lease_churn_semrush_dlq_growth_threshold";
export const SETTING_COOLDOWN_MIN = "lease_churn_alert_cooldown_minutes";

const DEFAULTS = {
  enabled: true,
  churnPerHourThreshold: 25,
  backlogThreshold: 1000,
  backlogAgeMinutes: 60,
  semrushDlqGrowthThreshold: 25,
  cooldownMinutes: 60,
};

const CHECK_INTERVAL_MS = 5 * 60_000;

type NotifyByTypeFn = (
  id: string,
  payload: { text: string; preview?: string },
  options: { triggerSource: string; bypassDedupe?: boolean; metadata?: Record<string, unknown> },
) => Promise<{ delivered: boolean; status?: string; skipReason?: string }>;

let dispatcherOverride: NotifyByTypeFn | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

// Per-condition cooldown — keyed by a stable per-condition string so
// the four alert classes don't share a single cooldown.
const lastAlertAt = new Map<string, number>();
// SEMrush dead-letter growth needs a baseline that survives across
// ticks so we can detect *new* dead-letter rows rather than total
// volume. Re-baselined whenever the alert fires.
let semrushDlqBaseline: { count: number; capturedAt: number } | null = null;

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseBool(raw: string | undefined | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return fallback;
}

export interface LeaseChurnAlertConfig {
  enabled: boolean;
  churnPerHourThreshold: number;
  backlogThreshold: number;
  backlogAgeMinutes: number;
  semrushDlqGrowthThreshold: number;
  cooldownMinutes: number;
}

export async function getLeaseChurnAlertConfig(): Promise<LeaseChurnAlertConfig> {
  const [enabled, churn, backlog, backlogAge, semrush, cooldown] = await Promise.all([
    getSystemSetting(SETTING_ENABLED).catch(() => null),
    getSystemSetting(SETTING_CHURN_PER_HOUR).catch(() => null),
    getSystemSetting(SETTING_BACKLOG_THRESHOLD).catch(() => null),
    getSystemSetting(SETTING_BACKLOG_AGE_MIN).catch(() => null),
    getSystemSetting(SETTING_SEMRUSH_DLQ_GROWTH).catch(() => null),
    getSystemSetting(SETTING_COOLDOWN_MIN).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabled?.value, DEFAULTS.enabled),
    churnPerHourThreshold: parsePositiveInt(churn?.value, DEFAULTS.churnPerHourThreshold),
    backlogThreshold: parsePositiveInt(backlog?.value, DEFAULTS.backlogThreshold),
    backlogAgeMinutes: parsePositiveInt(backlogAge?.value, DEFAULTS.backlogAgeMinutes),
    semrushDlqGrowthThreshold: parsePositiveInt(
      semrush?.value,
      DEFAULTS.semrushDlqGrowthThreshold,
    ),
    cooldownMinutes: parsePositiveInt(cooldown?.value, DEFAULTS.cooldownMinutes),
  };
}

async function fireAlert(
  cooldownKey: string,
  notificationId: string,
  text: string,
  metadata: Record<string, unknown>,
  cooldownMs: number,
  now: number,
): Promise<boolean> {
  const last = lastAlertAt.get(cooldownKey) ?? 0;
  if (now - last < cooldownMs) return false;
  try {
    const notify = dispatcherOverride
      ?? (await import("./notifications/dispatcher")).notifyByType;
    const r = await notify(
      notificationId,
      { text, preview: text.slice(0, 300) },
      {
        triggerSource: "alert_service",
        bypassDedupe: true,
        metadata,
      },
    );
    if (r.delivered) {
      lastAlertAt.set(cooldownKey, now);
      return true;
    }
    return false;
  } catch (err: any) {
    console.error(`[LeaseChurnAlerts] dispatch failed for ${notificationId}: ${err?.message}`);
    return false;
  }
}

interface ChurnByQueueRow {
  queue_name: string;
  error_code: string;
  cnt: number;
}

async function checkLeaseChurn(
  config: LeaseChurnAlertConfig,
  now: number,
): Promise<void> {
  const sinceMs = new Date(now - 3_600_000);
  const result = await workerDb.execute(sql`
    SELECT queue_name, error_code, COUNT(*)::int AS cnt
    FROM work_queue
    WHERE completed_at >= ${sinceMs}
      AND error_code IN (
        'stale_lease_exhaustion',
        'max_processing_exhaustion',
        'startup_stale_recovery'
      )
    GROUP BY queue_name, error_code
  `);
  const rows = result.rows as unknown as ChurnByQueueRow[];
  const total = rows.reduce((sum, r) => sum + r.cnt, 0);
  if (total < config.churnPerHourThreshold) return;

  const byQueue = new Map<string, number>();
  for (const r of rows) {
    byQueue.set(r.queue_name, (byQueue.get(r.queue_name) ?? 0) + r.cnt);
  }
  const top = [...byQueue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const byCode = new Map<string, number>();
  for (const r of rows) {
    byCode.set(r.error_code, (byCode.get(r.error_code) ?? 0) + r.cnt);
  }

  const text = [
    `:warning: *Cross-queue worker lease churn spike* — ${total} terminal events in the last 60 min (threshold ${config.churnPerHourThreshold})`,
    `• By error_code: ${[...byCode.entries()].map(([c, n]) => `\`${c}\`=${n}`).join(", ")}`,
    `• Top queues: ${top.map(([q, n]) => `\`${q}\`=${n}`).join(", ") || "(none)"}`,
    `Runbook: WORKERS_QUEUES_RUNBOOK.md (Lease churn root-cause section)`,
  ].join("\n");

  await fireAlert(
    "lease_churn",
    NOTIF_LEASE_CHURN,
    text,
    {
      windowMs: 3_600_000,
      total,
      threshold: config.churnPerHourThreshold,
      byErrorCode: Object.fromEntries(byCode),
      topQueues: Object.fromEntries(top),
    },
    config.cooldownMinutes * 60_000,
    now,
  );
}

async function checkFrontBacklog(
  config: LeaseChurnAlertConfig,
  now: number,
): Promise<void> {
  const ageCutoff = new Date(now - config.backlogAgeMinutes * 60_000);
  const result = await workerDb.execute(sql`
    SELECT queue_name,
           COUNT(*)::int AS pending,
           COUNT(*) FILTER (WHERE created_at <= ${ageCutoff})::int AS aged_pending,
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_age_seconds
    FROM work_queue
    WHERE status = 'pending'
      AND queue_name IN ('front_webhook_normalize', 'front_webhook_apply')
    GROUP BY queue_name
  `);
  const rows = result.rows as unknown as Array<{
    queue_name: string;
    pending: number;
    aged_pending: number;
    oldest_age_seconds: number | null;
  }>;

  for (const r of rows) {
    if (r.pending < config.backlogThreshold) continue;
    if (r.aged_pending < config.backlogThreshold) continue;
    const oldestMinutes = Math.round((r.oldest_age_seconds ?? 0) / 60);
    const text = [
      `:warning: *Front webhook backlog* — \`${r.queue_name}\` pending=${r.pending} (≥${config.backlogThreshold}) for >${config.backlogAgeMinutes} min`,
      `• Oldest pending row age: ${oldestMinutes} min`,
      `• Regression-guard for Task #1602`,
      `Runbook: WORKERS_QUEUES_RUNBOOK.md`,
    ].join("\n");
    await fireAlert(
      `front_backlog:${r.queue_name}`,
      NOTIF_FRONT_BACKLOG,
      text,
      {
        queueName: r.queue_name,
        pending: r.pending,
        agedPending: r.aged_pending,
        oldestAgeMinutes: oldestMinutes,
        threshold: config.backlogThreshold,
        ageMinutes: config.backlogAgeMinutes,
      },
      config.cooldownMinutes * 60_000,
      now,
    );
  }
}

async function checkRawCommunicationsInverted(
  config: LeaseChurnAlertConfig,
  now: number,
): Promise<void> {
  // Detect the May 20 pattern: pending count for last-30d rows exceeds
  // processed count, AND the oldest pending row is older than the
  // configured age window. The table holds `processing_status` ∈
  // {pending, processing, processed, failed}; the failed path is left
  // alone here — operator triage decides whether to requeue.
  const since = new Date(now - 30 * 24 * 3_600_000);
  const ageCutoff = new Date(now - config.backlogAgeMinutes * 60_000);
  let pending = 0;
  let processed = 0;
  let oldestPendingSeconds: number | null = null;
  let stuckProcessing = 0;
  try {
    const result = await workerDb.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE processing_status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE processing_status = 'processed')::int AS processed,
        COUNT(*) FILTER (WHERE processing_status = 'processing')::int AS processing,
        EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE processing_status = 'pending')))::int AS oldest_pending_seconds
      FROM raw_communication_records
      WHERE created_at >= ${since}
    `);
    const row = result.rows[0] as
      | { pending: number; processed: number; processing: number; oldest_pending_seconds: number | null }
      | undefined;
    if (!row) return;
    pending = row.pending;
    processed = row.processed;
    stuckProcessing = row.processing;
    oldestPendingSeconds = row.oldest_pending_seconds;
  } catch (err: any) {
    // Table may not exist in dev sandboxes; treat as a no-op.
    console.warn(
      `[LeaseChurnAlerts] raw_communication_records probe failed: ${err?.message}`,
    );
    return;
  }
  if (pending <= processed) return;
  if (!oldestPendingSeconds || oldestPendingSeconds < config.backlogAgeMinutes * 60) return;
  // Also require the oldest pending row to be older than the age
  // cutoff. The query above already implicitly checks this via
  // oldest_pending_seconds, but the explicit comparison makes the
  // invariant readable.
  void ageCutoff;

  const oldestMinutes = Math.round(oldestPendingSeconds / 60);
  const text = [
    `:warning: *raw_communication_records AI processing inverted* — pending=${pending} > processed=${processed} for last-30d window`,
    `• Stuck in \`processing\`: ${stuckProcessing}`,
    `• Oldest pending row age: ${oldestMinutes} min`,
    `Runbook: WORKERS_QUEUES_RUNBOOK.md`,
  ].join("\n");
  await fireAlert(
    "raw_comm_inverted",
    NOTIF_RAW_COMM_INVERTED,
    text,
    {
      pending,
      processed,
      stuckProcessing,
      oldestPendingMinutes: oldestMinutes,
      windowDays: 30,
    },
    config.cooldownMinutes * 60_000,
    now,
  );
}

async function checkSemrushDeadLetterSpike(
  config: LeaseChurnAlertConfig,
  now: number,
): Promise<void> {
  const result = await workerDb.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM work_queue
    WHERE status = 'dead_letter'
      AND queue_name IN ('semrush_report_refresh', 'semrush_background_refresh')
  `);
  const row = result.rows[0] as { cnt: number } | undefined;
  const cnt = row?.cnt ?? 0;

  if (!semrushDlqBaseline) {
    semrushDlqBaseline = { count: cnt, capturedAt: now };
    return;
  }
  const elapsedMs = now - semrushDlqBaseline.capturedAt;
  // Refresh the baseline at least every hour so a slow leak still
  // surfaces as growth-since-baseline within a bounded window.
  if (elapsedMs > 3_600_000) {
    semrushDlqBaseline = { count: cnt, capturedAt: now };
    return;
  }
  const growth = cnt - semrushDlqBaseline.count;
  if (growth < config.semrushDlqGrowthThreshold) return;

  const text = [
    `:warning: *SEMrush refresh dead-letter spike* — +${growth} new dead-letter rows in the last ${Math.round(elapsedMs / 60_000)} min (threshold ${config.semrushDlqGrowthThreshold})`,
    `• Combined \`semrush_report_refresh\` + \`semrush_background_refresh\` dead-letter total now ${cnt}`,
    `• Runbook: SEMRUSH_MAPPING.md and WORKERS_QUEUES_RUNBOOK.md`,
  ].join("\n");
  const fired = await fireAlert(
    "semrush_dlq",
    NOTIF_SEMRUSH_DLQ,
    text,
    {
      previousCount: semrushDlqBaseline.count,
      currentCount: cnt,
      growth,
      windowMs: elapsedMs,
      threshold: config.semrushDlqGrowthThreshold,
    },
    config.cooldownMinutes * 60_000,
    now,
  );
  if (fired) {
    semrushDlqBaseline = { count: cnt, capturedAt: now };
  }
}

async function checkDenominatorFloor(
  config: LeaseChurnAlertConfig,
  now: number,
): Promise<void> {
  // Task #2795 — detect persisted rows where applied_into_nobull >
  // front_total_messages. The read-path floor masks the bad value for
  // consumers, but the underlying stored row is wrong and will silently
  // accumulate unless caught here. Fires once per cooldown window so a
  // sustained bad-write series doesn't spam Slack.
  let cnt = 0;
  let violatingMonths: string[] = [];
  try {
    const result = await workerDb.execute(sql`
      SELECT COUNT(*)::int AS cnt,
             ARRAY_AGG(month ORDER BY month) AS violating_months
      FROM front_analytics_monthly_coverage
      WHERE denominator_unit = 'messages_all'
        AND applied_into_nobull > front_total_messages
    `);
    const row = result.rows[0] as
      | { cnt: number; violating_months: string[] | null }
      | undefined;
    if (!row) return;
    cnt = row.cnt ?? 0;
    violatingMonths = row.violating_months ?? [];
  } catch (err: any) {
    console.warn(`[LeaseChurnAlerts] denominator_floor probe failed: ${err?.message}`);
    return;
  }
  if (cnt === 0) return;

  const monthList = violatingMonths.slice(0, 10).join(", ");
  const text = [
    `:warning: *Front coverage denominator floor violated* — ${cnt} stored message-grain month(s) have \`applied_into_nobull > front_total_messages\``,
    `• Months: ${monthList}${violatingMonths.length > 10 ? ` … +${violatingMonths.length - 10} more` : ""}`,
    `• The read-path floor is hiding these. Trigger a recompute (prod-action \`recompute_front_analytics_all\`) to repair the stored rows.`,
    `Runbook: FRONT_ANALYTICS_COVERAGE.md`,
  ].join("\n");
  await fireAlert(
    "denominator_floor",
    NOTIF_DENOMINATOR_FLOOR,
    text,
    { cnt, violatingMonths },
    config.cooldownMinutes * 60_000,
    now,
  );
}

export async function checkLeaseChurnAlerts(
  now: number = Date.now(),
): Promise<void> {
  const config = await getLeaseChurnAlertConfig();
  if (!config.enabled) return;
  // Each condition is independent; one failing must not silence the
  // others.
  await Promise.allSettled([
    checkLeaseChurn(config, now),
    checkFrontBacklog(config, now),
    checkRawCommunicationsInverted(config, now),
    checkSemrushDeadLetterSpike(config, now),
    checkDenominatorFloor(config, now),
  ]);
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    try {
      await checkLeaseChurnAlerts();
    } catch (err: any) {
      console.warn(`[LeaseChurnAlerts] tick failed: ${err?.message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startLeaseChurnAlertsScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void withDbAttribution("scheduler:lease-churn-alerts", () => tick());
  }, CHECK_INTERVAL_MS);
  console.log(
    `[LeaseChurnAlerts] scheduler started (check every ${CHECK_INTERVAL_MS / 60_000}min)`,
  );
}

export function stopLeaseChurnAlertsScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export const __testHelpers = {
  NOTIF_LEASE_CHURN,
  NOTIF_FRONT_BACKLOG,
  NOTIF_RAW_COMM_INVERTED,
  NOTIF_SEMRUSH_DLQ,
  NOTIF_DENOMINATOR_FLOOR,
  DEFAULTS,
  resetCooldowns(): void {
    lastAlertAt.clear();
    semrushDlqBaseline = null;
  },
  setDispatcherForTests(fn: NotifyByTypeFn | null): void {
    dispatcherOverride = fn;
  },
  // Directly calls checkDenominatorFloor with the live config so tests can
  // verify query correctness against the real (or isolated) DB.
  async checkDenominatorFloorForTests(now: number = Date.now()): Promise<void> {
    const config = await getLeaseChurnAlertConfig();
    return checkDenominatorFloor(config, now);
  },
};
