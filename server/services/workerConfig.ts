export const WORKER_SCHEDULE_JITTER_MS = 30_000;
export const WORKER_LOCK_TTL_MS = 900_000;
export const WORKER_LOCK_HEARTBEAT_MS = 30_000;
export const WORKER_DB_HEAVY_MAX_CONCURRENCY = 3;
export const WORKER_BATCH_SIZE = 5;
export const WORKER_BATCH_YIELD_MS = 250;

// Task #2383 — cross-instance lock watchdog ceilings. A run-once job holds
// its cluster-wide Postgres advisory lock for the WHOLE run (see
// `crossInstanceLock.ts`). That self-heals on crash — the session drops and
// the lock releases — but if a job *hangs* without crashing (e.g. an
// external API call stalls without timing out) the winning instance keeps
// the lock and no other instance can take over until that process dies.
// These ceilings bound the hold: once a job has held its lock longer than
// the ceiling, the watchdog force-releases the advisory lock (and logs at
// error level / emits `worker_lock_watchdog_fired`) so a hung instance can
// never block the cluster forever.
//
// Each value is set comfortably ABOVE the job's worst *legitimate* runtime
// so a healthy long run is never interrupted — interrupting one would let a
// second instance start a duplicate run, defeating the singleton. Tune up,
// not down, if a job legitimately runs longer.
export const CROSS_INSTANCE_LOCK_MAX_HOLD_MS = {
  // Per-location wall-clock budget (6 min) × many locations, batched.
  local_dominance_sync: 90 * 60_000,
  // ~4h cadence; lists campaigns + a per-campaign detail fetch each.
  semrush_inventory_sync: 60 * 60_000,
  // Daily cron; one per-client judgment pass.
  daily_judgment: 60 * 60_000,
  // Daily; a handful of DB aggregate queries over contacts/suggestions.
  import_ghosts_snapshot: 30 * 60_000,
  // Task #2657 — daily app backup. The dump+upload of the prod DB plus the
  // incremental file archive can take a while on a large dataset; set the
  // ceiling well above the worst legitimate runtime so a healthy long run is
  // never interrupted (interrupting it would let a second instance start a
  // duplicate backup), but bounded so a hung run can't hold the lock forever.
  app_backup: 120 * 60_000,
  // Task #4645 — Slack sustained-outage periodic evaluator: one cheap
  // aggregate query + at most a handful of inbox writes per pass.
  slack_outage_evaluator: 5 * 60_000,
  // Task #4888 — weekly win-cadence nudge evaluator: one win-tracking
  // aggregate query + at most a handful of inbox writes per pass.
  win_cadence_nudge: 5 * 60_000,
  // Task #4964 — Ads OS monitor-label drift guard: two GAQL queries per
  // enrolled account (~40) once per ET day + a handful of inbox writes.
  ads_os_label_drift: 15 * 60_000,
  // Ads OS enrollment/MCC integrity guard: one cached ClickUp directory read,
  // one MCC GAQL query, bounded 10s Slack posts per missing CID, and a small
  // responsible-admin bell fan-out. Sized above a whole enrolled portfolio.
  ads_os_mcc_enrollment_guard: 30 * 60_000,
  // Ads OS label-drift liveness watchdog: two singleton health-row reads +
  // bounded responsible-admin inbox writes only when the guard is stale.
  ads_os_label_drift_staleness: 5 * 60_000,
  // Task #2984 — ClickUp reconciliation sweep. Walks all connected workspaces,
  // checks syncedAt staleness, and enqueues hierarchy backfills. Well above the
  // worst-case runtime for a fully-stale multi-workspace scan.
  clickup_reconciliation: 30 * 60_000,
  // Task #3520 — comms draft-attachment cleanup sweep. One paged storage
  // list + bounded (≤2000) per-object deletes; comfortably done well
  // inside this ceiling on any legitimate run.
  comms_draft_attachment_cleanup: 30 * 60_000,
  // Task #3983 — abandoned presigned-upload cleanup sweep. Three paged
  // storage lists + three reference SELECTs + bounded (≤2000) per-object
  // deletes; comfortably done well inside this ceiling.
  abandoned_upload_cleanup: 30 * 60_000,
  // Task #3711 — daily client-offboarding sweep. A single indexed read for
  // due records plus one archive UPDATE + comms-channel archive per due
  // client; minutes at absolute worst.
  client_offboarding_sweep: 30 * 60_000,
  // Task #4023 — client-file trash retention purge. One indexed expired-
  // trash read + bounded (≤2000 files) object deletes + per-client row
  // purges; comfortably done well inside this ceiling.
  client_file_trash_purge: 30 * 60_000,
  // Task #3694 — weekly aging asks & promises digest. One rollup query
  // plus a handful of notification inserts; 10 minutes is far above any
  // legitimate run, tight enough that a hung pass cannot block the next
  // instance for long.
  open_asks_digest: 10 * 60_000,
  // Task #3692 — on-demand Churn Risk Radar sweep. One AI interview per
  // active client at bounded concurrency; sized like daily_judgment (same
  // per-client model call class) so a hung model call can't hold the
  // cluster-wide lock forever.
  churn_risk_radar: 60 * 60_000,
} as const;

// Task #2400 — cross-instance lock watchdog ceilings for the CEO prod-action
// BACKGROUND DRAINS (`prodActionBackgroundDrain.ts`). Those drains hold the
// same cluster-wide advisory lock (namespace "DRAI") for the whole drain.
// Like the run-once workers above, the lock self-heals when the winning
// instance CRASHES (Postgres drops the session) but NOT when the drain
// *hangs* — e.g. an external API call (SEMrush top-competitors re-fetch,
// Front coverage probe) stalls without a timeout. The process stays alive,
// the session stays open, and the lock is held forever, so re-running that
// action on any instance is blocked indefinitely.
//
// Drains were deliberately left on the pre-watchdog behavior (maxHoldMs OFF)
// because each has its own `finishedAt` lifecycle and can legitimately run a
// long time. This map opts the SELF-HEALING / RECURRING drains (the ones the
// `prod_action_self_heal` scheduler can auto-re-apply, so a stuck lock is most
// harmful) back into a bounded ceiling. Keyed by the drain's `actionId`; a
// drain whose id is absent keeps the watchdog OFF (unchanged behavior — e.g.
// long operator one-press drains like the 122k backlog or full-catalog
// reformat, where interrupting a healthy long run would let a second instance
// start a DUPLICATE drain).
//
// Each ceiling is set comfortably ABOVE the drain's worst *legitimate* runtime
// (these re-fetch SEMrush competitors per client / re-probe Front coverage
// months, breaker-aware) yet below the self-heal cadence (60 min) so a
// genuinely hung drain is force-released before the next auto-apply. Tune up,
// not down, if a drain legitimately runs longer.
export const PROD_ACTION_DRAIN_MAX_HOLD_MS: Record<string, number> = {
  // Re-fetches SEMrush top-competitors per client, fills NULL location labels.
  backfill_competitor_location_labels: 30 * 60_000,
  // Sibling of the above; parses structured locality/street per competitor.
  backfill_competitor_structured_location: 30 * 60_000,
  // Re-corrects already-non-NULL competitor localities; same SEMrush re-fetch.
  backfill_competitor_locality_relabel: 30 * 60_000,
  // Re-probes Front coverage months to message grain via the search fallback.
  reach_front_coverage_full_message_grain: 45 * 60_000,
  // Re-drives stale SEMrush partial/paused_auth sweeps (external API heavy).
  rerun_stale_semrush_partials: 45 * 60_000,
  // Resolves + enqueues AI study for materialized Front messages; can be a
  // large historical backlog, so allow a long drain window.
  study_materialized_front_messages: 45 * 60_000,
};

export const ZOOM_SYNC_CRON_HOUR = 2;
export const ZOOM_RECORDING_LOOKBACK_HOURS = 72;
// Task #3689: the transcript backfill window is also what the client badge
// copy cites, so the constant lives in @shared/zoomTranscript (single source)
// and is re-exported here for the existing worker-side import sites.
export { ZOOM_TRANSCRIPT_BACKFILL_HOURS } from "@shared/zoomTranscript";

export const ZOOM_RECONCILIATION_CRON_HOUR = 2;
export const ZOOM_RECONCILIATION_LOOKBACK_HOURS = 72;

export const WORKER_STAGGER_OFFSETS: Record<string, number> = {
  front_sync: 10_000,
  zoom_sync: 40_000,
  local_dominance_sync: 100_000,
  call_analysis: 130_000,
  // Task #1049: slow-lane poller starts ~15 s after the normal lane so
  // the two pollers never wake on the same JS tick.
  call_analysis_slow: 145_000,
  front_health_check: 20_000,
  front_spam_cleanup: 50_000,
  front_client_matching: 80_000,
  daily_judgment: 110_000,
  semrush_enrichment: 25_000,
  semrush_inventory_sync: 140_000,
  slack_profile_sync: 55_000,
  rate_limit_auto_tune: 90_000,
  // Task #2897 — hourly memory (RSS/heap) watchdog for the Reserved VM
  // deployment. Staggered so its first sample doesn't wake on the same
  // JS tick as the health-adjacent schedulers.
  memory_watchdog: 317_500,
  zoom_review_alerts: 120_000,
  // Task #3702 — Zoom client face-sentiment sweep scheduler. Staggered
  // past the retention/alert schedulers so its first enqueue tick doesn't
  // wake on the same JS tick as another maintenance-class producer.
  zoom_face_sentiment: 290_000,
  audit_retention: 150_000,
  rate_limit_notification_retention: 160_000,
  pending_digest_alerts_retention: 170_000,
  rate_limit_alert_auto_retry: 180_000,
  queue_drain_backlog_alerts: 195_000,
  // Task #1053 — call-recording archive health watcher. Stagger after the
  // queue-drain backlog watcher so the two health checks don't wake on
  // the same JS tick.
  call_archive_backlog_alerts: 210_000,
  // Task #1076 — single-reason call-analysis failure spike watcher.
  // Stagger after the call-archive watcher so the two health checks
  // don't wake on the same JS tick.
  call_analysis_failure_spike_alerts: 225_000,
  // Task #672 — background auto-retry for failed threshold-alert
  // (agent_match_setting_history) Slack/email deliveries. Stagger after
  // the failure-spike watcher so it lands on a separate JS tick.
  match_settings_alert_auto_retry: 240_000,
  // Task #711 — daily/weekly digest summarizing recent reserve-pressure
  // spikes. Stagger after the match-settings auto-retry so the two health
  // schedulers don't wake on the same JS tick.
  manual_reserve_digest: 255_000,
  // Task #758 — daily auto-cleanup of stale SEMrush location-campaign
  // mappings (ghost rows whose locationId is no longer configured).
  // Stagger after the manual-reserve digest so the two daily-ish jobs
  // don't wake on the same JS tick.
  semrush_ghost_cleanup: 270_000,
  // Task #1222 — daily snapshot of the *other* ghost surfaces audited by
  // `scripts/cleanup-import-ghosts.ts` (auto-discovered client_contacts
  // and import_entity_suggestions queue counts). Stagger after the
  // SEMrush ghost cleanup so the two daily-ish jobs don't wake on the
  // same JS tick.
  import_ghosts_snapshot: 275_000,
  // Task #1009 — proactive starvation alert when a queue has 0
  // dispatches across N consecutive scheduler windows. Stagger after
  // the SEMrush ghost cleanup so the watcher doesn't wake on the same
  // JS tick as the daily-ish jobs.
  queue_starvation_alerts: 285_000,
  // Task #1073 — alert when a /api/health sub-check has been degraded
  // longer than its per-key threshold. Stagger after the queue
  // starvation alerts so the two health-adjacent jobs don't wake on
  // the same JS tick.
  health_degraded_alerts: 300_000,
  // Task #1098 — alert when call recordings stay stuck in
  // `archive_status='processing'` past the call_archive ceiling.
  // Stagger after the health-degraded alerts so the two alert
  // schedulers don't wake on the same JS tick.
  call_archive_stuck_processing_alerts: 315_000,
  // Task #1103 — alert when the booking schema readiness flips
  // ready=true → false. Stagger after the call-archive stuck-processing
  // alerts so the two alert schedulers don't wake on the same JS tick.
  booking_schema_readiness_alerts: 330_000,
  // Task #1224 — backlog/digest alerts for pending
  // `import_entity_suggestions` (SEMrush mapping / Front enrichment /
  // etc.). Stagger after the booking schema readiness alerts so the
  // two alert schedulers don't wake on the same JS tick.
  import_suggestions_backlog_alerts: 345_000,
  // Task #1231 — alert when the audit count of clients with invalid stored
  // product values grows since the last snapshot. Stagger after the
  // import-suggestions backlog watcher so the two alert schedulers don't
  // wake on the same JS tick.
  invalid_products_growth_alerts: 360_000,
  // Task #1284 — alert when Twilio inbound-webhook retries cause a spike of
  // 23505 unique-SID collisions on `twilio_messages`. Stagger after the
  // invalid-products growth alerts so the two alert schedulers don't
  // wake on the same JS tick.
  twilio_webhook_collision_alerts: 375_000,
  // Task #1282 — alert when Front Historical Recovery jobs end with a
  // `fatal_error:` reason at a rate above the configured threshold.
  // Stagger after the Twilio webhook collision watcher so the two alert
  // schedulers don't wake on the same JS tick.
  front_historical_recovery_fatal_alerts: 390_000,
  // Task #1575 (Track E, F-03) — per-location SEMrush auto-retry worker
  // (semrushLocationAutoRetryWorker). Previously started synchronously
  // inside the main bootstrap path, racing the WORKER_STAGGER_OFFSETS
  // cohort. Now deferred and staggered after the Front Historical
  // Recovery fatal alerts so its first 30s-interval tick doesn't wake
  // on the same JS tick as another scheduler.
  semrush_location_auto_retry: 405_000,
  // Task #1602 — watcher that fires when no Front webhook event has
  // landed in `source_event_log` for longer than the configured
  // threshold (default 60 min). Catches the next upstream Front delivery
  // stall (like the May-15→May-18 outage) automatically instead of
  // waiting for someone to notice. Stagger after the SEMrush
  // auto-retry so the two schedulers don't wake on the same JS tick.
  front_webhook_receiver_staleness_alerts: 420_000,
  // Task #1610 — watcher that fires when the Slack auth circuit
  // breaker (Task #1602) has been persistently tripped longer than
  // the configured threshold, plus a one-time recovery alert. Stagger
  // after the Front receiver-staleness watcher so the two
  // notification schedulers don't wake on the same JS tick.
  slack_auth_breaker_stuck_alerts: 480_000,
  // Task #1643 — low-priority observability worker that pulls Front's
  // Analytics Reports API as the authoritative monthly message
  // denominator and refreshes the all-time coverage cache. Stagger
  // after the Slack auth breaker stuck-alerts so the two
  // observability schedulers don't wake on the same JS tick.
  front_analytics_coverage_refresh: 495_000,
  // Task #1642 — watcher that fires when rows in
  // `front_sync_emails` have been sitting in a non-terminal
  // `pipeline_state` longer than the configured age threshold
  // (default 60 min). Catches the next silent apply-stage stall
  // (like the May-18 17,805-row backlog) automatically. Stagger
  // after the Front Analytics coverage refresh so the two
  // Front-pipeline observability schedulers don't wake on the
  // same JS tick.
  front_pipeline_stuck_alerts: 540_000,
  // Task #2146 — watcher that fires when the `front_sync_emails`
  // mirror's newest row (`MAX(created_at)`) has fallen behind live
  // Front webhook intake by more than the configured lag threshold
  // while webhooks are still arriving (the writer is disabled or
  // broken). Catches the next silent mirror freeze (like the
  // 2026-04-14 weeks-long stall) automatically. Stagger between the
  // front-pipeline stuck-alerts and lease-churn watchers so the
  // Front-pipeline observability schedulers don't wake on the same
  // JS tick.
  front_mirror_freshness_alerts: 547_500,
  // Task #1676 — cross-queue lease churn + production pipeline backlog
  // watcher. Surfaces `stale_lease_exhaustion` /
  // `startup_stale_recovery` rate spikes, Front normalize/apply
  // backlogs, raw_communication_records ratio inversion, and SEMrush
  // dead-letter spikes. Stagger after the front-pipeline stuck-alerts
  // watcher so the two pipeline-health schedulers don't wake on the
  // same JS tick.
  lease_churn_alerts: 555_000,
  // Task #1689 — alert when the Front self-healing coverage loop
  // (Task #1682) has itself stopped running (stale summary or
  // consecutive `lastSelfError` streak). Lightweight counterpart to
  // the broader Task #1684 regression alerter with an explicit
  // stuck → recovered pair (mirrors `slackAuthBreakerStuckAlerts`).
  // Stagger after the lease-churn alerts so the two pipeline-health
  // schedulers don't wake on the same JS tick.
  front_auto_closure_stalled_loop_alerts: 570_000,
  // Task #1759 — daily Google Ads sync worker. Stagger after the front
  // auto-closure stalled-loop alerts so the two schedulers don't wake
  // on the same JS tick.
  google_ads_sync: 585_000,
  // Task #1825 — periodic enqueue of `front_reconciliation` jobs so
  // the auto-heal sweep that pulls missed Front conversations off the
  // REST API runs on a cadence (default every 15 min). Prior to this
  // scheduler nothing enqueued the queue; the May 18 → May 21 outage
  // proved the live webhook stream is not always reliable. Stagger
  // after the Google Ads sync so the two enqueue-only schedulers don't
  // wake on the same JS tick.
  front_reconciliation_enqueue: 600_000,
  // Front auto-closure tick enqueue scheduler. Drives the warp
  // self-heal knobs (recovery budget / cooldown / retry budget /
  // concurrency cap) on its own ~60s cadence so the historical-gap
  // drain runs continuously instead of piggy-backing on the
  // de-cadenced front_analytics_coverage_refresh handler. Stagger
  // after the front_reconciliation enqueue scheduler so the two
  // Front enqueue-only schedulers don't wake on the same JS tick.
  front_auto_closure_enqueue: 615_000,
  // Task #1984 — periodic enqueue of `front_outbound_gap_close` jobs so
  // months with a positive `messages_outbound_gap` are driven back
  // through the historical-recovery ingestion pipeline automatically.
  // Default OFF via `front_outbound_gap_close_enabled`; the scheduler
  // skips enqueue entirely while disabled. Stagger after the front
  // auto-closure enqueue so the Front enqueue-only schedulers don't wake
  // on the same JS tick.
  front_outbound_gap_close: 630_000,
  // Task #2010 — periodic enqueue of `front_outbound_gap_backfill` jobs
  // so months with a positive `messages_outbound_gap` are repaired at
  // message grain (single enumeration-walk per conversation, writing only
  // the missing outbound rows). Default OFF via
  // `front_outbound_gap_backfill_enabled`; the scheduler skips enqueue
  // entirely while disabled. Stagger after the front outbound gap-close
  // enqueue so the Front enqueue-only schedulers don't wake on the same
  // JS tick.
  front_outbound_gap_backfill: 637_500,
  // Task #2365 — periodic enqueue of `front_message_grain_upgrade` jobs
  // so finalized months still below `messages_all` denominator grain are
  // re-probed via the search fallback (advancing the per-message
  // enumeration walk) until they reach message grain. Default OFF via
  // `front_message_grain_upgrade_enabled`; the scheduler skips enqueue
  // entirely while disabled. Stagger after the front outbound gap-backfill
  // enqueue so the Front enqueue-only schedulers don't wake on the same
  // JS tick.
  front_message_grain_upgrade: 645_000,
  // Task #2529 — periodic enqueue of `front_finish_message_grain` jobs so
  // every in-scope Front coverage month is driven to a real `messages_all`
  // denominator on a cadence (via the shared
  // `applyFinishFrontMessageGrainCoverage` apply path) WITHOUT requiring the
  // global self-heal master switch. Default OFF via
  // `front_finish_message_grain_enabled`; the scheduler skips enqueue
  // entirely while disabled. Stagger after the message-grain upgrade enqueue
  // so the Front enqueue-only schedulers don't wake on the same JS tick.
  front_finish_message_grain: 650_000,
  // Task #2029 — periodic enqueue of `restored_email_cleanup` jobs so
  // active users left on a `<original>.restored.<ts>` fallback email are
  // auto-repaired back to their original address once it is free.
  // Default OFF via `restored_email_cleanup_enabled`; the scheduler
  // skips enqueue entirely while disabled. Stagger after the front
  // outbound gap-backfill enqueue so the enqueue-only schedulers don't
  // wake on the same JS tick.
  restored_email_cleanup: 645_000,
  // Task #2066 — periodic enqueue of `feedback_slack_retry` jobs so
  // feedback rows whose Slack relay failed (slack_status <> 'delivered')
  // are automatically re-sent once Slack reconnects. Default OFF via
  // `feedback_slack_retry_enabled`; the scheduler skips enqueue entirely
  // while disabled. Stagger after the restored-email-cleanup enqueue so
  // the enqueue-only schedulers don't wake on the same JS tick.
  feedback_slack_retry: 660_000,
  // Task #2086 — periodic enqueue of `prod_action_self_heal` jobs so the
  // idempotent, recurring maintenance prod-actions that opt in via
  // `ProdAction.selfHeal` are applied automatically and the CEO stops
  // re-applying them by hand. Default OFF via
  // `prod_action_self_heal_enabled`; the scheduler skips enqueue entirely
  // while disabled. Stagger after the feedback-slack-retry enqueue so the
  // enqueue-only schedulers don't wake on the same JS tick.
  prod_action_self_heal: 675_000,
  // Task #2203 — periodic enqueue of `orphaned_user_heal` jobs. RETIRED
  // by Task #4554 (closed admission): the tick short-circuits
  // unconditionally and never creates users rows; the enable switch only
  // controls whether no-op jobs are enqueued. Kept so the queue's
  // config/status surfaces stay coherent. Stagger after the
  // prod-action-self-heal enqueue so the enqueue-only schedulers don't
  // wake on the same JS tick.
  orphaned_user_heal: 690_000,
  // Task #2414 — periodic enqueue of `feedback_video_resume` jobs so a
  // feedback video left `processing` by a server restart (its in-memory
  // TwelveLabs job orphaned) is re-driven to completion without manual
  // intervention. Default OFF via `feedback_video_resume_enabled`; the
  // scheduler skips enqueue entirely while disabled. Stagger after the
  // orphaned-user heal so the enqueue-only schedulers don't wake on the
  // same JS tick.
  feedback_video_resume: 720_000,
  // Task #2368 — RIS BigQuery auto-pull. Default OFF via the
  // `enable_ris_bigquery_autopull` system setting; the scheduler ticks but
  // each tick is a no-op while disabled. Stagger after the orphaned-user
  // heal so the worker schedulers don't wake on the same JS tick.
  ris_bigquery_autopull: 705_000,
  // Task #2686 — Live Data hourly BigQuery pull. Default OFF via the
  // `enable_live_data_autopull` system setting; the scheduler ticks but
  // each tick is a no-op while disabled. Stagger slightly after the RIS
  // pull so the two BQ schedulers don't wake on the same JS tick.
  live_data_autopull: 720_000,
  // Task #2657 — daily app backup (deployment-gated, cross-instance
  // singleton). Stagger after the RIS auto-pull so the daily schedulers
  // don't wake on the same JS tick.
  app_backup: 735_000,
  slack_outage_evaluator: 765_000,
  // Task #2740 — proactive Zoom token keep-alive (deployment-gated,
  // cross-instance singleton). Stagger after the app backup so the
  // schedulers don't wake on the same JS tick.
  zoom_token_keepalive: 750_000,
  // Proactive SEMrush token keep-alive (deployment-gated, cross-instance
  // singleton). SEMrush access tokens last 7 days; rotating 48 h early
  // prevents the Jul 1–15 2026-class quiet-period expiry outage.
  // Stagger after the Zoom keep-alive so the two schedulers don't wake
  // on the same JS tick.
  semrush_token_keepalive: 765_000,
  // Task #2938 — daily Sheets auto-refresh producer. Enqueues one
  // `sheets_data_block_refresh` job per auto-refresh block on a 6h cadence.
  // Default OFF via `sheets_auto_refresh_enabled`. Stagger after the
  // SEMrush keep-alive so the schedulers don't wake on the same JS tick.
  sheets_auto_refresh: 780_000,
  // Task #2984 — ClickUp reconciliation sweep + webhook health scheduler.
  // Deployment-gated, cross-instance singleton, default OFF via
  // `clickup_reconciliation_sweep_enabled` (system setting). Staggered after
  // the Sheets auto-refresh so the schedulers don't wake on the same JS tick.
  clickup_reconciliation: 810_000,
  // Task #3520 — comms draft-attachment cleanup sweep. Deployment-gated,
  // cross-instance singleton, default OFF via
  // `comms_draft_attachment_cleanup_enabled` (system setting). Staggered
  // after ClickUp reconciliation so the schedulers don't wake on the same
  // JS tick.
  comms_draft_attachment_cleanup: 840_000,
  // Task #3059 — Service Desk overdue sweep + delivered auto-close scheduler.
  // Deployment-gated, cross-instance singleton, default OFF via
  // `sd_scheduler_enabled` (system setting). Staggered after ClickUp
  // reconciliation so the schedulers don't wake on the same JS tick.
  sd_scheduler: 825_000,
  // Ads OS morning budget-pacing refresh — deployment-gated,
  // cross-instance singleton, default OFF via `ads_os_pacing_refresh_enabled`.
  // Staggered after comms_draft_attachment_cleanup so the schedulers don't
  // wake on the same JS tick.
  ads_os_pacing_refresh: 855_000,
  // Task #3711 — daily client-offboarding sweep (auto-archive on the final
  // service day). Deployment-gated, cross-instance singleton. Default ON
  // with kill switch `client_offboarding_sweep_disabled` (system setting) —
  // unlike the maintenance schedulers above, this executes operator-scheduled
  // offboardings, so it must work without a hidden enable flag. Staggered
  // after ads_os_pacing_refresh so the schedulers don't wake on the same tick.
  client_offboarding_sweep: 870_000,
  // Comms scheduled-message delivery tick — scans comms_scheduled_messages for
  // due rows and enqueues one comms_scheduled_delivery job per message (60 s
  // cadence). Not cross-instance-locked: concurrent ticks produce duplicate
  // dedupe-keyed enqueue attempts which the queue deduplicates safely.
  // Staggered after sd_scheduler so the schedulers don't wake on the same tick.
  comms_scheduled_delivery: 5_000,
  // Comms message-reminder tick — checks comms_message_reminders for due rows
  // and enqueues one comms_reminder_deliver drain job per minute window (60 s
  // cadence). Not cross-instance-locked: concurrent ticks produce duplicate
  // dedupe-keyed enqueue attempts which the queue deduplicates safely.
  // Staggered shortly after comms_scheduled_delivery.
  comms_reminder_deliver: 12_000,
  // Task #3694 — weekly aging asks & promises digest scheduler init (the
  // startup catch-up pass runs at init). Staggered after
  // client_offboarding_sweep (870s) so the schedulers don't wake on the
  // same JS tick.
  open_asks_digest: 885_000,
  // Workers/queues parity (E-F12/E-F15) — stuck/stale watchers for the four
  // custom-table pipelines that previously had no (or partial) coverage.
  // Staggered after the open-asks digest, 15s apart, so the alert
  // schedulers don't wake on the same JS tick.
  call_analysis_stuck_processing_alerts: 900_000,
  local_dominance_stuck_sync_alerts: 930_000,
  semrush_auto_retry_overdue_alerts: 945_000,
  // Task #3963 (audit B-012) — ATS Rev.ai transcription fallback sweeper:
  // reconciles submissions whose completion callback never arrived. Stagger
  // after the SEMrush auto-retry overdue alerts so the two maintenance
  // schedulers don't wake on the same JS tick.
  ats_transcription_sweep: 960_000,
  // Task #3983 — abandoned presigned-upload cleanup sweep. Deployment-gated,
  // cross-instance singleton, default OFF via
  // `abandoned_upload_cleanup_enabled` (system setting). Staggered after the
  // ATS transcription sweep so the schedulers don't wake on the same JS tick.
  abandoned_upload_cleanup: 975_000,
  // Task #4023 — client-file trash retention purge. Deployment-gated,
  // cross-instance singleton, default OFF via
  // `client_file_trash_purge_enabled` (system setting). Staggered after the
  // abandoned-upload cleanup so the storage-delete sweeps never wake on the
  // same JS tick.
  client_file_trash_purge: 990_000,
  // Task #4329 — tags & segments reconciliation sweep producer.
  // Deployment-gated, cross-instance singleton, default OFF via
  // `tags_segments_sweep_enabled` (system setting). Staggered after the
  // client-file trash purge so the two maintenance-class producers don't
  // wake on the same JS tick.
  tag_segment_reconcile: 1_005_000,
  // Task #4333 — nightly deal/lead score recompute producer.
  // Deployment-gated, cross-instance singleton, default ON with kill
  // switch `scoring_sweep_enabled` (system setting; engagement windows
  // decay daily, so the sweep is what keeps scores honest). Staggered
  // after the tags & segments sweep so the two criteria-driven
  // maintenance producers don't wake on the same JS tick.
  score_recompute: 1_020_000,
  // Task #4640 — dev/prod schema-drift catalog check. In deployments:
  // nightly comparator (cross-instance singleton, default ON, kill switch
  // `schema_drift_check_enabled`). In the main dev workspace: periodic
  // catalog snapshot publisher (default ON, kill switch
  // `schema_drift_snapshot_publish_enabled`). Staggered after the score
  // recompute producer.
  schema_drift_check: 1_035_000,
  // Task #4832 — alert when Ads OS seeded-minimal criteria docs (created by
  // the schedule-sync prod action, Task #4827) have no operator-authored
  // content after 7 days. Low-urgency hygiene alert; 4-hour check cadence.
  // Staggered after the schema-drift check so the two maintenance-class
  // checks don't wake on the same JS tick.
  ads_os_seeded_criteria_incompleteness_alerts: 1_050_000,
  // Task #4888 — weekly win-cadence nudge evaluator (cross-instance
  // singleton, 6h cadence + boot catch-up pass). Staggered after the Ads OS
  // seeded-criteria alerts so the maintenance-class evaluators don't wake
  // on the same JS tick.
  win_cadence_nudge: 1_065_000,
  // Task #4964 — Ads OS monitor-label drift guard (deployment-gated,
  // cross-instance singleton, once per ET day via durable date guard, kill
  // switch `ads_os_label_drift_guard_enabled`, default ON). Staggered after
  // the win-cadence evaluator so the maintenance-class evaluators don't wake
  // on the same JS tick.
  ads_os_label_drift: 1_080_000,
  // Ads OS ClickUp-enrollment vs ENABLED-MCC guard. Separate from label drift
  // so the two Google Ads checks never wake on the same JS tick.
  ads_os_mcc_enrollment_guard: 1_095_000,
  // Independent liveness watchdog for the label-drift guard above. Starts 30
  // seconds after its guarded scheduler and 15 seconds after the MCC guard so
  // all three Ads OS checks wake on separate JS ticks.
  ads_os_label_drift_staleness: 1_110_000,
};
