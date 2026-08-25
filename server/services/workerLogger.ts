export type WorkerEvent =
  | "worker_started"
  | "worker_lock_acquired"
  | "worker_heartbeat"
  | "worker_skipped_overlap"
  | "worker_skipped_global_limit"
  | "worker_skipped_class_limit"
  | "worker_batch_completed"
  | "worker_completed"
  | "worker_failed"
  | "worker_lock_recovered"
  | "worker_slot_summary"
  | "job_enqueued"
  | "job_leased"
  | "job_heartbeat"
  | "job_released"
  | "job_completed"
  | "job_failed"
  | "job_retrying"
  | "job_dead_lettered"
  | "scheduler_cycle"
  | "slot_acquired"
  | "slot_released"
  | "slot_hold_tracked"
  | "starvation_warning"
  | "dispatcher_cycle"
  | "dispatcher_started"
  | "dispatcher_stopped"
  | "event_received"
  | "duplicate_ignored"
  | "normalized"
  | "ready_to_apply"
  | "applied"
  | "no_op"
  | "failed"
  | "replayed"
  | "reconciled"
  | "replay_started"
  | "replay_event_failed"
  | "replay_completed"
  | "replay_chunk_completed"
  | "reconciliation_started"
  | "reconciliation_skipped"
  | "reconciliation_event_failed"
  | "reconciliation_completed"
  | "reconciliation_chunk_completed"
  | "backfill_started"
  | "backfill_record_failed"
  | "backfill_completed"
  | "backfill_chunk_completed"
  | "vendor_fetcher_registered"
  | "stale_job_reset"
  | "zombie_job_failed"
  | "job_permanently_failed"
  | "zombie_job_dead_lettered"
  | "job_replayed_from_dead_letter"
  | "stale_lease_exhausted"
  // Task #1676: graceful-shutdown released an in-flight lease so the
  // next boot doesn't classify the row as a zombie/orphan.
  | "in_flight_lease_released"
  | "bulk_dead_letter_replay"
  | "manual_reserve_slot_acquired"
  // Task #836 Phase 2: backoff and kill-switch operator-facing events.
  | "workload_backoff_api_pressure"
  | "kill_switch_abort"
  // Task #836 Phase 6: stuck-job recovery / escalation.
  | "stuck_job_escalation"
  | "stuck_job_requeued"
  // Task #897 Phase 0: producer-side missing-handler containment signal.
  | "enqueue_missing_handler"
  // Sheets data-block refresh events.
  | "skip_no_block_id"
  | "block_not_found"
  | "unknown_connector"
  | "workbook_not_found"
  | "connector_error"
  | "refreshed"
  | "skip_kill_switch_off"
  | "list_error"
  | "enqueue_error"
  | "enqueued"
  | "tick_error"
  | "started"
  // Task #953 / #945B: SEMrush refresh deferred by upstream circuit breaker.
  | "refresh_deferred_breaker"
  // Task #978 Phase 1: startup assertion + per-handler skip events.
  | "required_handlers_missing"
  | "skipped_feature_disabled"
  // Task #987: per-queue drain control (pause/resume/cancel/rate-limit).
  | "queue_paused"
  | "queue_resumed"
  | "queue_rate_limit_set"
  | "queue_pending_cancelled"
  | "queue_dispatch_skipped_drain"
  | "handler_aborted_queue_paused"
  // Task #1784: SEMrush refresh enqueue/handler short-circuits while the
  // queue is paused via the queue-drain control plane.
  | "semrush_refresh_enqueue_skipped_queue_paused"
  | "semrush_refresh_enqueue_skipped_demand_gate"
  | "handler_skipped_queue_paused"
  // Task #986: per-queue fairness dispatch decisions.
  | "queue_fairness_dispatched"
  | "scheduler_cycle_dispatch_summary"
  // Task #1025: pre-enqueue per-client ceiling skip for retroactive_reprocess.
  | "retroactive_reprocess_ceiling_skip"
  // Task #1050: SEMrush handler caught DB-pool saturation and re-enqueued
  // a deferred copy instead of consuming a maxAttempts slot.
  | "db_pool_partial_deferred"
  | "db_pool_partial_reenqueue_failed"
  // Task #1048: per-queue max processing duration breached by heartbeat.
  | "max_processing_exceeded"
  // Task #1048: terminal write skipped because the lease was reclaimed
  // by recoverStaleLeases while the original handler was still running.
  | "job_completion_stale_lease_ignored"
  // Task #1047: handler-side deferral when too many distinct clients are
  // already inflight on retroactive_reprocess.
  | "handler_deferred_distinct_client_ceiling"
  // Task #1020: dispatch-window ring buffer hydrated from persisted snapshots.
  | "dispatch_window_history_hydrated"
  // Task #1643: Front Analytics coverage refresh tick completion.
  | "tick_complete"
  // Task #1829: Front warp-speed fast-poll events.
  | "front_warp_skipped_rate_limited"
  | "front_warp_skipped_worker_pool_thin"
  | "front_warp_db_hold_throttle"
  | "front_warp_apply_backoff_api_pressure"
  | "front_warp_dispatched"
  | "front_warp_cycle_summary"
  | "front_warp_guard_triggered"
  // Task #1877: SEMrush local-dominance sweep short-circuited because the
  // OAuth token is missing (paused_auth) rather than failing per-client.
  | "worker_paused_auth"
  // Task #2383: the cross-instance lock max-hold watchdog fired — a hung
  // holder exceeded its ceiling so the cluster-wide advisory lock was
  // force-released to let another instance take over.
  | "worker_lock_watchdog_fired"
  // Task #2657: daily app backup (DB dump + Object Storage file manifest).
  | "app_backup_completed"
  | "app_backup_db_failed"
  | "app_backup_files_failed"
  | "app_backup_file_copy_failed"
  | "app_backup_alert_failed"
  // Task #2984: ClickUp sync hardening — reconciliation sweep + webhook health/repair.
  | "backfill_enqueued"
  | "sweep_completed"
  | "skip"
  | "fetch_error"
  | "degraded"
  | "health_check_completed"
  | "delete_failed"
  | "create_failed"
  | "repair_completed"
  // Task #2943 / Service Desk ClickUp mapping events.
  | "sd_ticket_mapping_applied"
  | "sd_ticket_mapping_error"
  // Task #3059: Service Desk scheduler events.
  | "sd_overdue_sweep_completed"
  | "sd_autoclose_completed"
  | "sd_ticket_overdue_notified"
  | "sd_ticket_autoclosed"
  | "sd_ticket_autoclose_skipped"
  | "sd_config_missing"
  // Task #3373: Template enforcement events.
  | "sd_template_checklist_applied"
  | "sd_template_checklist_error"
  // Task #3656: checklist step assignee resolution events.
  | "sd_checklist_assignee_skip"
  | "sd_checklist_assignee_error"
  | "sd_needs_info_comment_error"
  | "sd_needs_info_notified"
  | "sd_template_enforcement_error"
  // Task #3393: Client field option UUID resolution in webhook apply path.
  | "sd_client_option_resolved"
  | "sd_client_option_unresolved";

interface WorkerLogPayload {
  worker: string;
  event: WorkerEvent;
  durationMs?: number;
  batchIndex?: number;
  batchSize?: number;
  itemsProcessed?: number;
  totalItems?: number;
  error?: string;
  lockHolder?: string;
  lockAge?: number;
  concurrentCount?: number;
  [key: string]: unknown;
}

export function workerLog(payload: WorkerLogPayload): void {
  const { worker, event, error, ...rest } = payload;
  const ts = new Date().toISOString();
  const cleanRest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) cleanRest[k] = v;
  }
  const extra = Object.keys(cleanRest).length > 0
    ? " " + JSON.stringify(cleanRest)
    : "";
  // Task #2100 — benign high-volume events must NOT render as warn. A
  // class-limit skip / no-op / duplicate is expected steady-state worker
  // behavior (especially under the auth-dead Front backoff, which skips
  // every tick); emitting them at warn floods the logs and trips
  // "[Error]"-style alerting. Only genuine starvation stays at warn.
  const level = event === "worker_failed" || event === "job_dead_lettered" || event === "job_failed" || event === "failed" || event === "stale_lease_exhausted" ? "error"
    : event === "starvation_warning" ? "warn"
    : "info";

  const msg = `[Worker] ${ts} ${event} worker=${worker}${error ? ` error="${error}"` : ""}${extra}`;

  if (level === "error") {
    console.error(msg);
  } else if (level === "warn") {
    console.warn(msg);
  } else {
    console.log(msg);
  }
}

export class SyncInstrumentation {
  readonly worker: string;
  private startTime: number;
  private slotHoldMs = 0;
  private slotAcquiredAt: number | null = null;
  private commitBursts = 0;
  itemsFetched = 0;
  itemsCommitted = 0;

  constructor(worker: string) {
    this.worker = worker;
    this.startTime = Date.now();
  }

  slotAcquire(): void {
    if (this.slotAcquiredAt === null) {
      this.slotAcquiredAt = Date.now();
      this.commitBursts++;
    }
  }

  slotRelease(): void {
    if (this.slotAcquiredAt !== null) {
      this.slotHoldMs += Date.now() - this.slotAcquiredAt;
      this.slotAcquiredAt = null;
    }
  }

  async withSlot<T>(
    awaitFn: (worker: string) => Promise<void>,
    releaseFn: (worker: string) => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    await awaitFn(this.worker);
    this.slotAcquire();
    try {
      return await fn();
    } finally {
      releaseFn(this.worker);
      this.slotRelease();
    }
  }

  logSummary(): void {
    const totalMs = Date.now() - this.startTime;
    workerLog({
      worker: this.worker,
      event: "worker_slot_summary",
      durationMs: totalMs,
      slotHoldMs: this.slotHoldMs,
      slotHoldPct: totalMs > 0 ? Math.round((this.slotHoldMs / totalMs) * 100) : 0,
      itemsFetched: this.itemsFetched,
      itemsCommitted: this.itemsCommitted,
      commitBursts: this.commitBursts,
    });
  }
}
