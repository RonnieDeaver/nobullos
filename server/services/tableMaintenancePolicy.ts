/**
 * Task #3814 — Table-maintenance policy: the single source of truth for
 * which high-churn operational tables have declared retention windows,
 * how their prune-eligible rows are identified, and what size band each
 * table is expected to stay inside.
 *
 * Production measurements (2026-08-05) that motivated this:
 *   work_queue               809,610 rows / 693 MB (queue should hold ~in-flight work)
 *   front_hydrate_snapshots  1,050 MB holding 31 live rows (rows pruned, space never reclaimed)
 *   source_event_log         399 MB
 *   work_result_log          294 MB
 *   call_analysis_jobs       238 MB
 *   apply_state              128 MB
 *   mcu_cache                 56 MB
 *   pool_state_samples        47 MB
 *
 * Consumed by:
 *   - `tableRetentionPruner.ts` — hourly batched deletes of prune-eligible rows.
 *   - `tableSizeWatchdog.ts` — 6-hourly size samples + over-band alerting.
 *   - `prodActionsRegistry.ts` (`deep_prune_reclaim_oversized_tables`) — the
 *     one-press initial backlog prune + `VACUUM (FULL, ANALYZE)` reclaim.
 *   - the admin health dashboard "Size Trend" view (bands surface there).
 *
 * Retention windows are DECLARED here (defaults) and TUNABLE via
 * `system_settings` (per-unit key, days as an integer string), mirroring the
 * audit-retention settings pattern (`server/services/auditRetention.ts`).
 * Size bands are declared here (MB defaults) and tunable via ONE JSON
 * setting `table_size_watchdog_bands_mb` (e.g. `{"work_queue": 400}`), so an
 * operator can re-band a table without a deploy.
 *
 * Terminal-only pruning:
 *   - `work_queue`: completed/cancelled rows age out fast (the queue is a
 *     conveyor, not an archive); failed/dead_letter kept longer for
 *     diagnosis. Non-terminal rows are NEVER touched.
 *   - `source_event_log`: terminal statuses only. Deleting a source event
 *     CASCADEs to `work_result_log` + `apply_state` children (both FKs are
 *     ON DELETE CASCADE), which is exactly how those two tables' declared
 *     retention is enforced — pruning the parent keeps replay lineage
 *     consistent (a result row without its source event is meaningless).
 *   - `call_analysis_jobs`: complete/failed only; queued/processing never.
 *   - `mcu_cache`: rows carry their own `expires_at` TTL — the pruner just
 *     enforces it (previously `clearExpiredCache()` existed but nothing
 *     called it on a schedule).
 */

export interface PruneUnit {
  /** Stable key — used in settings, logs, and drain summaries. */
  key: string;
  /** Table the DELETE targets. */
  table: string;
  /** Primary-key column used for the batched `WHERE pk IN (SELECT pk …)` delete. */
  pkColumn: string;
  /** Human description of what is deleted. */
  label: string;
  /**
   * `system_settings` key holding the retention window in days.
   * `null` = the unit has an inherent expiry (mcu_cache's expires_at).
   */
  retentionSettingKey: string | null;
  /** Default retention window (days). `null` only when inherent expiry. */
  defaultRetentionDays: number | null;
  /**
   * SQL text of the eligibility predicate. `$CUTOFF` is replaced by the
   * pruner with a bound timestamp parameter. Timestamp columns are
   * `timestamptz`-comparable except table_size_samples (bigint epoch ms).
   */
  wherePredicate: string;
  /** Column type expected for the cutoff binding. */
  cutoffKind: "timestamp" | "epoch_ms" | "none";
  /** Note shown in admin/detail strings. */
  note?: string;
}

export interface CoveredTable {
  table: string;
  /** Expected steady-state ceiling for pg_total_relation_size, in MB. */
  defaultBandMb: number;
  /**
   * How rows leave this table:
   *   "unit"     — one or more PruneUnits in this policy delete rows here.
   *   "cascade"  — rows die via FK cascade from a parent unit's deletes.
   *   "external" — a pre-existing dedicated pruner owns row retention
   *                (front_hydrate_snapshots Task #1810, pool_state_samples
   *                Task #861); this policy only adds size watch + reclaim.
   */
  rowRetention: "unit" | "cascade" | "external";
  retentionNote: string;
}

/** Master gate for the scheduled pruner (default OFF until the CEO flips it). */
export const TABLE_RETENTION_PRUNER_ENABLED_KEY = "table_retention_pruner_enabled";
/** Master gate for the size watchdog/sampler (default OFF). */
export const TABLE_SIZE_WATCHDOG_ENABLED_KEY = "table_size_watchdog_enabled";
/** JSON override for per-table size bands, MB: {"work_queue": 400, ...}. */
export const TABLE_SIZE_BANDS_SETTING_KEY = "table_size_watchdog_bands_mb";
/**
 * JSON per-table reclaim stamps written by the deep-prune prod-action:
 * {"work_queue": {"at": "2026-08-05T...", "bytesBefore": 726...,
 * "bytesAfter": 41...}}. Lets the action converge to not-needed after a
 * reclaim even when a band is mis-tuned (the watchdog then flags the band).
 */
export const TABLE_RECLAIM_STATE_SETTING_KEY = "table_reclaim_state";

export const RETENTION_SETTING_KEYS = {
  workQueueTerminal: "work_queue_retention_terminal_days",
  workQueueFailed: "work_queue_retention_failed_days",
  sourceEventLog: "source_event_log_retention_days",
  callAnalysisJobs: "call_analysis_jobs_retention_days",
  tableSizeSamples: "table_size_samples_retention_days",
  commsLinkPreviews: "comms_link_previews_retention_days",
  semrushLocationSyncAttempts: "semrush_location_sync_attempts_retention_days",
  bookingClientTokens: "booking_client_tokens_retention_days",
  userActivityLogs: "user_activity_logs_retention_days",
  clientFileShareLinks: "client_file_share_links_retention_days",
} as const;

/**
 * Task #4392 — explicit retain decision (recorded, not an omission):
 * `website_inquiries` is deliberately NOT pruned. Rows are business lead
 * records — contact-kind inquiries are promoted into client/lead rows
 * (Task #4330, lead_client_id) and carry first-touch UTM attribution
 * (Task #4337) that lead reporting reads back. Volume is low-rate and
 * bounded by the public endpoint's rate limiting (~0 MB in prod,
 * 2026-08-11). Revisit only if the table ever approaches a real size band.
 */

export const PRUNE_UNITS: PruneUnit[] = [
  {
    key: "work_queue_terminal",
    table: "work_queue",
    pkColumn: "id",
    label: "work_queue completed/cancelled rows",
    retentionSettingKey: RETENTION_SETTING_KEYS.workQueueTerminal,
    defaultRetentionDays: 7,
    wherePredicate: "status IN ('completed', 'cancelled') AND updated_at < $CUTOFF",
    cutoffKind: "timestamp",
    note: "A queue should hold roughly in-flight work only; completed rows are audit exhaust.",
  },
  {
    key: "work_queue_failed",
    table: "work_queue",
    pkColumn: "id",
    label: "work_queue failed/dead_letter rows",
    retentionSettingKey: RETENTION_SETTING_KEYS.workQueueFailed,
    defaultRetentionDays: 30,
    wherePredicate: "status IN ('failed', 'dead_letter') AND updated_at < $CUTOFF",
    cutoffKind: "timestamp",
    note: "Kept longer than completed rows so failure forensics stay available.",
  },
  {
    key: "source_event_log_terminal",
    table: "source_event_log",
    pkColumn: "id",
    label: "source_event_log terminal rows (cascades to work_result_log + apply_state)",
    retentionSettingKey: RETENTION_SETTING_KEYS.sourceEventLog,
    defaultRetentionDays: 90,
    wherePredicate:
      "status IN ('applied', 'ignored', 'failed', 'dead_lettered') AND received_at < $CUTOFF",
    cutoffKind: "timestamp",
    note: "FK ON DELETE CASCADE removes the event's work_result_log and apply_state children in the same delete — that cascade IS those tables' retention path.",
  },
  {
    key: "call_analysis_jobs_terminal",
    table: "call_analysis_jobs",
    pkColumn: "analysis_id",
    label: "call_analysis_jobs complete/failed rows",
    retentionSettingKey: RETENTION_SETTING_KEYS.callAnalysisJobs,
    defaultRetentionDays: 90,
    wherePredicate: "status IN ('complete', 'failed') AND created_at < $CUTOFF",
    cutoffKind: "timestamp",
    note: "Result JSON + transcripts dominate row width; readers only poll recent jobs.",
  },
  {
    key: "mcu_cache_expired",
    table: "mcu_cache",
    pkColumn: "id",
    label: "mcu_cache rows past their own expires_at TTL",
    retentionSettingKey: null,
    defaultRetentionDays: null,
    wherePredicate: "expires_at < NOW()",
    cutoffKind: "none",
    note: "Rows already declare their TTL; clearExpiredCache() existed but nothing ran it on a schedule.",
  },
  {
    key: "table_size_samples_old",
    table: "table_size_samples",
    pkColumn: "id",
    label: "table_size_samples rows past retention",
    retentionSettingKey: RETENTION_SETTING_KEYS.tableSizeSamples,
    defaultRetentionDays: 180,
    wherePredicate: "sampled_at < $CUTOFF",
    cutoffKind: "epoch_ms",
    note: "The watchdog's own trend table must not become the next unbounded table.",
  },
  {
    key: "comms_link_previews_stale",
    table: "comms_link_previews",
    pkColumn: "id",
    label: "comms_link_previews rows stale past retention",
    retentionSettingKey: RETENTION_SETTING_KEYS.commsLinkPreviews,
    defaultRetentionDays: 30,
    wherePredicate: "cached_until < $CUTOFF",
    cutoffKind: "timestamp",
    note: "Unfurl cache — a row whose cached_until TTL lapsed ≥30d ago hasn't been re-shared; the unfurl path refetches on demand (cached_until index-backed).",
  },
  {
    key: "semrush_location_sync_attempts_old",
    table: "semrush_location_sync_attempts",
    pkColumn: "id",
    label: "semrush_location_sync_attempts rows past retention",
    retentionSettingKey: RETENTION_SETTING_KEYS.semrushLocationSyncAttempts,
    defaultRetentionDays: 90,
    wherePredicate: "created_at < $CUTOFF",
    cutoffKind: "timestamp",
    note: "Insert-only attempt history; the schema comment always promised cleanup via a dedicated retention job — this is that job (created_at index-backed). Latest state lives in semrush_location_sync_state.",
  },
  {
    key: "booking_client_tokens_expired",
    table: "booking_client_tokens",
    pkColumn: "id",
    label: "booking_client_tokens rows expired past retention",
    retentionSettingKey: RETENTION_SETTING_KEYS.bookingClientTokens,
    defaultRetentionDays: 30,
    wherePredicate: "expires_at < $CUTOFF",
    cutoffKind: "timestamp",
    note: "Single-use tokens can never be redeemed after expires_at; the 30d window past expiry keeps recent issuance forensics (expires_at index-backed; used-but-unexpired rows age out at expiry+retention).",
  },
  {
    key: "user_activity_logs_old",
    table: "user_activity_logs",
    pkColumn: "id",
    label: "user_activity_logs rows past retention",
    retentionSettingKey: RETENTION_SETTING_KEYS.userActivityLogs,
    defaultRetentionDays: 365,
    wherePredicate: '"timestamp" < $CUTOFF',
    cutoffKind: "timestamp",
    note: "Task #4392 — append-only activity log (one row per user action, previously unbounded). Every row is terminal at insert, so age is the only eligibility criterion (timestamp index-backed). 365d default keeps a full year of internal-usage forensics.",
  },
  {
    key: "client_file_share_links_dead",
    table: "client_file_share_links",
    pkColumn: "id",
    label: "client_file_share_links rows dead (expired or revoked) past retention",
    retentionSettingKey: RETENTION_SETTING_KEYS.clientFileShareLinks,
    defaultRetentionDays: 90,
    wherePredicate: "LEAST(expires_at, COALESCE(revoked_at, expires_at)) < $CUTOFF",
    cutoffKind: "timestamp",
    note: "Task #4392 — a link is dead at min(expires_at, revoked_at): it can never be redeemed again, so only access-forensics value remains (kept 90d past death; expression index-backed). Active (unexpired, unrevoked) links are NEVER touched.",
  },
];

/**
 * Size bands: expected pg_total_relation_size ceiling per covered table, MB.
 * Conservative — sized to post-deep-prune steady state plus generous
 * headroom, so the watchdog flags real regrowth without flapping. Tunable
 * via TABLE_SIZE_BANDS_SETTING_KEY without a deploy.
 */
export const COVERED_TABLES: CoveredTable[] = [
  {
    table: "work_queue",
    defaultBandMb: 250,
    rowRetention: "unit",
    retentionNote: "completed/cancelled 7d, failed/dead_letter 30d (work_queue_retention_*_days)",
  },
  {
    table: "front_hydrate_snapshots",
    defaultBandMb: 200,
    rowRetention: "external",
    retentionNote: "rows: Task #1810 pruner (front_hydrate_snapshots_retention_days, default 30d)",
  },
  {
    table: "source_event_log",
    defaultBandMb: 600,
    rowRetention: "unit",
    retentionNote: "terminal rows 90d (source_event_log_retention_days)",
  },
  {
    table: "work_result_log",
    defaultBandMb: 450,
    rowRetention: "cascade",
    retentionNote: "rows die with their source_event_log parent (ON DELETE CASCADE, 90d)",
  },
  {
    table: "apply_state",
    defaultBandMb: 250,
    rowRetention: "cascade",
    retentionNote: "rows die with their source_event_log / work_result_log parents (CASCADE, 90d)",
  },
  {
    table: "call_analysis_jobs",
    defaultBandMb: 350,
    rowRetention: "unit",
    retentionNote: "complete/failed rows 90d (call_analysis_jobs_retention_days)",
  },
  {
    table: "mcu_cache",
    defaultBandMb: 120,
    rowRetention: "unit",
    retentionNote: "rows past their own expires_at TTL",
  },
  {
    table: "pool_state_samples",
    defaultBandMb: 120,
    rowRetention: "external",
    retentionNote: "rows: Task #861 hourly prune (7d fixed)",
  },
  {
    table: "table_size_samples",
    defaultBandMb: 50,
    rowRetention: "unit",
    retentionNote: "180d (table_size_samples_retention_days)",
  },
  {
    table: "comms_link_previews",
    defaultBandMb: 100,
    rowRetention: "unit",
    retentionNote: "rows stale ≥30d past their cached_until TTL (comms_link_previews_retention_days)",
  },
  {
    table: "manual_reserve_worker_samples",
    defaultBandMb: 120,
    rowRetention: "external",
    retentionNote: "rows: healthMetrics prune sampler (7d fixed, same loop as health_samples)",
  },
  {
    table: "semrush_location_sync_attempts",
    defaultBandMb: 150,
    rowRetention: "unit",
    retentionNote: "90d (semrush_location_sync_attempts_retention_days)",
  },
  {
    table: "booking_client_tokens",
    defaultBandMb: 50,
    rowRetention: "unit",
    retentionNote: "expired rows 30d past expires_at (booking_client_tokens_retention_days)",
  },
  {
    table: "user_activity_logs",
    defaultBandMb: 100,
    rowRetention: "unit",
    retentionNote: "365d (user_activity_logs_retention_days)",
  },
  {
    table: "client_file_share_links",
    defaultBandMb: 50,
    rowRetention: "unit",
    retentionNote: "dead (expired/revoked) rows 90d past death (client_file_share_links_retention_days); active links never pruned",
  },
];

export const COVERED_TABLE_NAMES: string[] = COVERED_TABLES.map((t) => t.table);

export function getCoveredTable(table: string): CoveredTable | undefined {
  return COVERED_TABLES.find((t) => t.table === table);
}

export function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Resolve the effective band (bytes) for a covered table, applying the JSON
 * override setting when present and sane (positive finite number of MB).
 */
export function resolveBandBytes(
  table: string,
  overridesJson: string | null | undefined,
): number {
  const covered = getCoveredTable(table);
  const defaultMb = covered?.defaultBandMb ?? 0;
  let mb = defaultMb;
  if (overridesJson) {
    try {
      const parsed = JSON.parse(overridesJson);
      const candidate = Number(parsed?.[table]);
      if (Number.isFinite(candidate) && candidate > 0) mb = candidate;
    } catch {
      // Malformed override JSON → fall back to the declared default.
    }
  }
  return Math.round(mb * 1024 * 1024);
}
