const env = (key: string, fallback: number) => {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const envBounded = (key: string, fallback: number, min: number, max: number) => {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
};

const envBool = (key: string, fallback: boolean) => {
  const v = process.env[key];
  if (!v) return fallback;
  return v === "true" || v === "1";
};

export const PERF = {
  DB_API_POOL_MIN: env("DB_API_POOL_MIN", 2),
  DB_API_POOL_MAX: env("DB_API_POOL_MAX", 18),
  DB_WORKER_POOL_MIN: env("DB_WORKER_POOL_MIN", 1),
  // Task #1729 Phase 2.4 — originally bumped 7 → 8 to keep one worker
  // connection free for non-slot operations (queue lease recovery,
  // scheduler ticks, periodic timers migrated off the API pool in
  // Phase 2.1).
  // Throughput follow-up (post-#1787): bumped 8 → 10 alongside
  // `RETROACTIVE_REPROCESS_CONCURRENCY` 4 → 6 so `TOTAL_BUDGET` (in
  // `services/workloadManager.ts`) resolves to 9 (`RETROACTIVE_REPROCESS_CONCURRENCY` 6 + 3
  // reserve) while still leaving ≥1 spare DB worker connection. The
  // boot-time `[BudgetValidation]` warning about "leaves <1 spare DB
  // worker connection" stays quiet under default config.
  DB_WORKER_POOL_MAX: env("DB_WORKER_POOL_MAX", 10),
  SEMRUSH_POLL_INTERVAL_MS: env("SEMRUSH_POLL_INTERVAL_MS", 8_000),
  SEMRUSH_MAX_POLLS: env("SEMRUSH_MAX_POLLS", 45),

  ACTIVITY_FLUSH_INTERVAL_MS: env("ACTIVITY_FLUSH_INTERVAL_MS", 30_000),
  ACTIVITY_MAX_BATCH: env("ACTIVITY_MAX_BATCH", 50),

  FRONT_SPAM_CLEANUP_INTERVAL_MS: env("FRONT_SPAM_CLEANUP_INTERVAL_MS", 15 * 60_000),
  FRONT_CLIENT_MATCHING_INTERVAL_MS: env("FRONT_CLIENT_MATCHING_INTERVAL_MS", 10 * 60_000),

  DB_POOL_STATS_INTERVAL_MS: env("DB_POOL_STATS_INTERVAL_MS", 60_000),
  DB_POOL_UTIL_WARN_PCT: env("DB_POOL_UTIL_WARN_PCT", 80),
  DB_ACQUIRE_WAIT_WARN_MS: env("DB_ACQUIRE_WAIT_WARN_MS", 100),
  // Task #818: Phase 0 instrumentation. We separately track real client-hold
  // time (connect → release) so we can distinguish slot duration from actual
  // DB occupancy. Logs a warning + per-interval counter when a single
  // checkout holds the client past this threshold.
  DB_HOLD_WARN_MS: env("DB_HOLD_WARN_MS", 1000),
  DB_POOL_STATS_LOG_ONLY_WHEN_ACTIVE: envBool("DB_POOL_STATS_LOG_ONLY_WHEN_ACTIVE", true),
  DB_POOL_WAITING_WARN_COUNT: env("DB_POOL_WAITING_WARN_COUNT", 1),

  SEMRUSH_ENRICHMENT_CONCURRENCY: env("SEMRUSH_ENRICHMENT_CONCURRENCY", 2),
  SEMRUSH_HEATMAP_CONCURRENCY: env("SEMRUSH_HEATMAP_CONCURRENCY", 2),
  SEMRUSH_CAMPAIGN_START_DELAY_MS: env("SEMRUSH_CAMPAIGN_START_DELAY_MS", 500),
  SEMRUSH_STARTUP_INITIAL_DELAY_MS: env("SEMRUSH_STARTUP_INITIAL_DELAY_MS", 15_000),
  SEMRUSH_429_BASE_BACKOFF_MS: env("SEMRUSH_429_BASE_BACKOFF_MS", 5_000),
  SEMRUSH_429_MAX_BACKOFF_MS: env("SEMRUSH_429_MAX_BACKOFF_MS", 60_000),
  SEMRUSH_429_MAX_RETRIES_PER_REQUEST: env("SEMRUSH_429_MAX_RETRIES_PER_REQUEST", 3),
  SEMRUSH_429_JITTER_MS: env("SEMRUSH_429_JITTER_MS", 1_000),

  // Task #953 / #945B — SEMrush upstream circuit breaker.
  // The breaker watches a rolling success/failure window over SEMrush API
  // calls and trips the worker into a bounded cooldown state when the
  // upstream collapses (timeouts, repeated 5xx, exhausted 429 retries).
  // Defaults are conservative — we want to keep absorbing modest noise
  // without tripping, but stop hammering once the success rate truly falls.
  SEMRUSH_BREAKER_WINDOW_MS: env("SEMRUSH_BREAKER_WINDOW_MS", 5 * 60_000),
  SEMRUSH_BREAKER_MIN_SAMPLES: env("SEMRUSH_BREAKER_MIN_SAMPLES", 10),
  SEMRUSH_BREAKER_FAILURE_THRESHOLD: envBounded("SEMRUSH_BREAKER_FAILURE_THRESHOLD", 0.8, 0.1, 1.0),
  SEMRUSH_BREAKER_COOLDOWN_MS: env("SEMRUSH_BREAKER_COOLDOWN_MS", 5 * 60_000),
  SEMRUSH_BREAKER_MAX_COOLDOWN_MS: env("SEMRUSH_BREAKER_MAX_COOLDOWN_MS", 30 * 60_000),
  // Per-campaign cooldown applied after a refresh-job failure so the next
  // background sweep doesn't immediately re-enqueue the same broken campaign.
  // Manual operator triggers ignore this map.
  SEMRUSH_CAMPAIGN_BACKOFF_MS: env("SEMRUSH_CAMPAIGN_BACKOFF_MS", 10 * 60_000),

  ZOOM_VALIDATION_FAILURE_LIMIT: env("ZOOM_VALIDATION_FAILURE_LIMIT", 3),
  ZOOM_VALIDATION_BACKOFF_MS: env("ZOOM_VALIDATION_BACKOFF_MS", 1_800_000),

  LOG_SAMPLE_LIMIT: env("LOG_SAMPLE_LIMIT", 5),
  FRONT_SKIP_REASON_SAMPLE_LIMIT: env("FRONT_SKIP_REASON_SAMPLE_LIMIT", 5),

  STARVATION_AGE_THRESHOLD_MS: env("STARVATION_AGE_THRESHOLD_MS", 600_000),

  REPAIR_DISPATCHER_POLL_MS: env("REPAIR_DISPATCHER_POLL_MS", 5_000),
  REPAIR_DISPATCHER_LEASE_MS: env("REPAIR_DISPATCHER_LEASE_MS", 300_000),
  REPAIR_DISPATCHER_HEARTBEAT_MS: env("REPAIR_DISPATCHER_HEARTBEAT_MS", 60_000),
  REPAIR_DISPATCHER_BASE_BACKOFF_MS: env("REPAIR_DISPATCHER_BASE_BACKOFF_MS", 10_000),
  REPAIR_DISPATCHER_MAX_BACKOFF_MS: env("REPAIR_DISPATCHER_MAX_BACKOFF_MS", 600_000),
  REPAIR_DISPATCHER_MAX_SKIP_CYCLES: env("REPAIR_DISPATCHER_MAX_SKIP_CYCLES", 3),
  REPAIR_DISPATCHER_MAX_ATTEMPTS: env("REPAIR_DISPATCHER_MAX_ATTEMPTS", 5),

  REPAIR_QUEUE_ENABLED: envBool("REPAIR_QUEUE_ENABLED", false),
  REPAIR_DISPATCHER_ENABLED: envBool("REPAIR_DISPATCHER_ENABLED", false),
  INTERACTIVE_REPAIR_ENQUEUE_ENABLED: envBool("INTERACTIVE_REPAIR_ENQUEUE_ENABLED", false),

  ZOOM_EVENT_INGEST_ENABLED: envBool("ZOOM_EVENT_INGEST_ENABLED", true),
  ZOOM_RECONCILIATION_ENABLED: envBool("ZOOM_RECONCILIATION_ENABLED", true),

  FRONT_EVENT_INGEST_ENABLED: envBool("FRONT_EVENT_INGEST_ENABLED", true),
  FRONT_RECONCILIATION_ENABLED: envBool("FRONT_RECONCILIATION_ENABLED", true),
  FRONT_RECONCILIATION_INTERVAL_MS: env("FRONT_RECONCILIATION_INTERVAL_MS", 15 * 60_000),
  FRONT_RECONCILIATION_BATCH_SIZE: env("FRONT_RECONCILIATION_BATCH_SIZE", 50),
  // Front auto-closure tick scheduler — enqueues `front_auto_closure_tick`
  // jobs so the self-heal loop (`runFrontAutoClosureTick`) drives the
  // warp knobs (recovery budget, cooldown, retry budget, concurrency
  // cap) on its own cadence instead of piggy-backing on the
  // de-cadenced `front_analytics_coverage_refresh` handler.
  FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED: envBool("FRONT_AUTO_CLOSURE_SCHEDULER_ENABLED", true),
  FRONT_AUTO_CLOSURE_TICK_INTERVAL_MS: env("FRONT_AUTO_CLOSURE_TICK_INTERVAL_MS", 60_000),

  SEMRUSH_INVENTORY_SYNC_ENABLED: envBool("SEMRUSH_INVENTORY_SYNC_ENABLED", true),
  SEMRUSH_REPORT_REFRESH_ENABLED: envBool("SEMRUSH_REPORT_REFRESH_ENABLED", true),
  SEMRUSH_INVENTORY_SYNC_INTERVAL_MS: env("SEMRUSH_INVENTORY_SYNC_INTERVAL_MS", 4 * 60 * 60 * 1000),
  SEMRUSH_INVENTORY_SYNC_STAGGER_MS: env("SEMRUSH_INVENTORY_SYNC_STAGGER_MS", 60_000),

  // Task #1785: demand-driven cadence — env default for the background
  // refresh enqueue cadence. Was a hardcoded 60-min constant in
  // `semrushApi.ts`; promoted to PERF (default 12h) so cadence can be
  // tuned per environment, and overridden live via the
  // `semrush_background_refresh_interval_ms` system setting.
  SEMRUSH_BACKGROUND_REFRESH_INTERVAL_MS: env(
    "SEMRUSH_BACKGROUND_REFRESH_INTERVAL_MS",
    12 * 60 * 60 * 1000,
  ),
  // Default staleness threshold for cached campaign/heatmap data — only
  // refresh if last applied/cached age exceeds this. Overridable via
  // `semrush_refresh_staleness_threshold_hours`.
  SEMRUSH_REFRESH_STALENESS_THRESHOLD_HOURS: env(
    "SEMRUSH_REFRESH_STALENESS_THRESHOLD_HOURS",
    24,
  ),
  // Default active-client window. A client is "active" if any of its
  // products was viewed in the last N days. Overridable via
  // `semrush_active_client_window_days`.
  SEMRUSH_ACTIVE_CLIENT_WINDOW_DAYS: env(
    "SEMRUSH_ACTIVE_CLIENT_WINDOW_DAYS",
    14,
  ),
  // Per-location auto-retry tick (Task #1785: was hardcoded 30s).
  SEMRUSH_LOCATION_AUTO_RETRY_TICK_MS: env(
    "SEMRUSH_LOCATION_AUTO_RETRY_TICK_MS",
    30_000,
  ),

  DURABLE_APPLY_ENABLED: envBool("DURABLE_APPLY_ENABLED", false),

  LEGACY_DIRECT_MUTATION_FRONT_ENABLED: envBool("LEGACY_DIRECT_MUTATION_FRONT_ENABLED", false),
  LEGACY_DIRECT_MUTATION_ZOOM_ENABLED: envBool("LEGACY_DIRECT_MUTATION_ZOOM_ENABLED", false),
  LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED: envBool("LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED", false),

  FRONT_PIPELINE_FETCH_SPLIT_ENABLED: envBool("FRONT_PIPELINE_FETCH_SPLIT_ENABLED", true),
  FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED: envBool("FRONT_PIPELINE_VERSIONED_DISCOVERY_ENABLED", true),
  FRONT_PIPELINE_HYDRATE_ENABLED: envBool("FRONT_PIPELINE_HYDRATE_ENABLED", true),
  FRONT_PIPELINE_PROCESS_SPLIT_ENABLED: envBool("FRONT_PIPELINE_PROCESS_SPLIT_ENABLED", true),
  FRONT_PIPELINE_APPLY_ENABLED: envBool("FRONT_PIPELINE_APPLY_ENABLED", true),
  FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED: envBool("FRONT_BACKGROUND_JOBS_ENQUEUE_ENABLED", true),
  FRONT_LEGACY_INLINE_PROCESSING_ENABLED: envBool("FRONT_LEGACY_INLINE_PROCESSING_ENABLED", false),
  FRONT_LEGACY_DOUBLE_FETCH_ENABLED: envBool("FRONT_LEGACY_DOUBLE_FETCH_ENABLED", false),

  // Task #2637 (T2): the AI agent matcher was removed. Its threshold /
  // ambiguity / shadow-eval knobs were consumed only by the deleted
  // matcher (and a verification script). The remaining
  // AGENT_EVIDENCE_AWARE_ENABLED flag is still read by out-of-cluster
  // route code (server/routes/agents.ts) and is left in place for the
  // route owner to reconcile.
  AGENT_EVIDENCE_AWARE_ENABLED: envBool("AGENT_EVIDENCE_AWARE_ENABLED", true),

  // Task #815: Cap how long a pooled DB connection lives before we proactively
  // recycle it, so we retire connections on our own schedule instead of being
  // surprised by Neon's idle-recycle. Default 25 min keeps us comfortably
  // under the typical Neon ~30 min idle horizon. A small per-client jitter
  // (+/-10%) is applied at connect time to avoid mass simultaneous eviction.
  // Set to 0 to disable.
  // Bounded so a misconfigured `0`/negative value can't turn the sweep
  // into a hot loop or set an effectively-zero lifetime that thrashes
  // the pool. `0` is reserved for "disabled" and handled in db.ts.
  DB_CONN_MAX_LIFETIME_MS: envBounded("DB_CONN_MAX_LIFETIME_MS", 25 * 60_000, 0, 24 * 60 * 60_000),
  DB_CONN_LIFETIME_SWEEP_MS: envBounded("DB_CONN_LIFETIME_SWEEP_MS", 60_000, 1_000, 60 * 60_000),

  // Task #836 Phase 2: rolling slow-acquire count over the last 60s that
  // triggers background backoff. Independent of the per-interval pool
  // stats counter. Defaults conservative — production may tune up if
  // backoff fires too aggressively.
  DB_API_SLOW_ACQUIRE_BACKOFF_COUNT: env("DB_API_SLOW_ACQUIRE_BACKOFF_COUNT", 5),

  // Task #836 Phase 2: backoff sleep duration when a background job
  // detects API pool pressure. Sleep is capped per call; jobs check
  // pressure repeatedly through the workload manager helper.
  WORKLOAD_BACKOFF_SLEEP_MS: env("WORKLOAD_BACKOFF_SLEEP_MS", 2_000),
  WORKLOAD_BACKOFF_MAX_SLEEP_MS: env("WORKLOAD_BACKOFF_MAX_SLEEP_MS", 30_000),

  // Task #836 Phase 2: emergency kill switches. When set true, the
  // matching background workload aborts at the next safe boundary
  // (between batches / between jobs) without redeploy. Default false
  // so behavior is unchanged unless explicitly enabled.
  KILL_SWITCH_RETROACTIVE_REPROCESS: envBool("KILL_SWITCH_RETROACTIVE_REPROCESS", false),
  KILL_SWITCH_FRONT_SYNC_REPROCESS: envBool("KILL_SWITCH_FRONT_SYNC_REPROCESS", false),
  KILL_SWITCH_AUTO_RETRY: envBool("KILL_SWITCH_AUTO_RETRY", false),
  KILL_SWITCH_NON_CRITICAL_SWEEPS: envBool("KILL_SWITCH_NON_CRITICAL_SWEEPS", false),
  KILL_SWITCH_LARGE_BACKFILLS: envBool("KILL_SWITCH_LARGE_BACKFILLS", false),
  // Task #3701: pause Rev AI transcript generation for Zoom recordings that
  // never got a Zoom transcript (fallback enqueue + revival + submission).
  KILL_SWITCH_ZOOM_REVAI_TRANSCRIPTION: envBool("KILL_SWITCH_ZOOM_REVAI_TRANSCRIPTION", false),
  // Task #3963 (audit B-012): pause the ATS video-submission Rev AI
  // transcription pipeline — new job submission AND the fallback sweeper.
  // The authenticated callback route stays live so jobs already submitted
  // (and billed) still record their outcome. Default false = pipeline on.
  KILL_SWITCH_ATS_REVAI_TRANSCRIPTION: envBool("KILL_SWITCH_ATS_REVAI_TRANSCRIPTION", false),
  // Task #978 (Phase 2): pause SEMrush background campaign refresh without
  // a redeploy. Default off — when engaged, the periodic enqueue stops
  // and any pending semrush_background_refresh job aborts at the kill
  // switch boundary in its handler.
  KILL_SWITCH_SEMRUSH_BACKGROUND_REFRESH: envBool("KILL_SWITCH_SEMRUSH_BACKGROUND_REFRESH", false),
  // Task #1785: demand-driven cadence master switch. When TRUE (default),
  // SEMrush refresh enqueue requires BOTH stale-cache AND recently-viewed
  // gates to pass. When FALSE, the legacy "refresh-everyone-on-timer"
  // path runs (still respecting the standard queue-drain pause). This is
  // an emergency fallback, not the preferred mode.
  SEMRUSH_DEMAND_DRIVEN_REFRESH_ENABLED: envBool(
    "SEMRUSH_DEMAND_DRIVEN_REFRESH_ENABLED",
    true,
  ),
  // Task #1785: when TRUE (default) the per-location auto-retry worker
  // uses the new long-form backoff curve (1m → 5m → 30m → 2h → 24h →
  // dead-letter) and refuses to retry deterministic permanent errors.
  // When FALSE, falls back to the legacy short-cycle backoff in
  // `computeBackoffMs`.
  SEMRUSH_AUTO_RETRY_BACKOFF_ENABLED: envBool(
    "SEMRUSH_AUTO_RETRY_BACKOFF_ENABLED",
    true,
  ),
  // Task #1785: when TRUE (default) `semrush_heatmap_apply` is suppressed
  // whenever the freshly-fetched response hashes identically to the last
  // applied snapshot. Independent of `external_call_audit_enabled`.
  SEMRUSH_IDENTICAL_RESULT_APPLY_SUPPRESSION_ENABLED: envBool(
    "SEMRUSH_IDENTICAL_RESULT_APPLY_SUPPRESSION_ENABLED",
    true,
  ),

  // Task #836 Phase 6: max age before a pending repair-class job is
  // considered "wedged" and gets escalation logging + retry_at clear.
  STUCK_JOB_MAX_AGE_MS: env("STUCK_JOB_MAX_AGE_MS", 24 * 60 * 60 * 1000),
  STUCK_JOB_ESCALATION_INTERVAL_MS: env("STUCK_JOB_ESCALATION_INTERVAL_MS", 6 * 60 * 60 * 1000),

  // Task #1024: Front Historical Recovery resilience knobs.
  // INGEST_CONCURRENCY caps how many per-page conversations get ingested in
  // parallel inside a single recovery window. Default 1 keeps the existing
  // serial behaviour (safer for DB pool); operators can raise to 5 when the
  // pool has headroom. PAGE_DELAY_MS is the standard inter-page sleep;
  // PAGE_DELAY_SATURATED_MS is the longer sleep used after a pg-pool
  // saturation signal so subsequent pages give the pool time to recover.
  FRONT_RECOVERY_INGEST_CONCURRENCY: envBounded("FRONT_RECOVERY_INGEST_CONCURRENCY", 1, 1, 5),
  FRONT_RECOVERY_PAGE_DELAY_MS: env("FRONT_RECOVERY_PAGE_DELAY_MS", 500),
  FRONT_RECOVERY_PAGE_DELAY_SATURATED_MS: env("FRONT_RECOVERY_PAGE_DELAY_SATURATED_MS", 5_000),

  // Task #1025: retroactive_reprocess concurrency + per-client backpressure.
  // - Concurrency: up to N distinct-client retroactive_reprocess jobs may
  //   run in parallel from the same dispatcher cycle.
  // - PendingPerClientMax: hard ceiling enforced at every enqueue site
  //   (periodic sweep, manual retroactive route, contact add/update, and
  //   the env-gated boot memory-reset remediation — the release-and-rematch
  //   route was removed in Task #4087). Producers that would
  //   push a client over this many pending jobs are skipped with a
  //   throttled log line — this is what stops the 91k duplicate backlog
  //   from re-growing after the one-shot collapse drains it.
  RETROACTIVE_REPROCESS_CONCURRENCY: envBounded("RETROACTIVE_REPROCESS_CONCURRENCY", 6, 1, 8),
  RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX: envBounded("RETROACTIVE_REPROCESS_PENDING_PER_CLIENT_MAX", 3, 1, 50),

  // Task #1032A — Recurring meeting expansion caps. The validator and
  // expander reject payloads that would emit more than this many
  // occurrences, span past this horizon, or carry more than this many
  // EXDATE entries. Defaults match the recurring-meetings epic spec.
  BOOKING_RECURRENCE_MAX_OCCURRENCES: envBounded("BOOKING_RECURRENCE_MAX_OCCURRENCES", 100, 1, 1000),
  BOOKING_RECURRENCE_MAX_HORIZON_MONTHS: envBounded("BOOKING_RECURRENCE_MAX_HORIZON_MONTHS", 24, 1, 120),
  BOOKING_RECURRENCE_MAX_EXDATES: envBounded("BOOKING_RECURRENCE_MAX_EXDATES", 50, 1, 500),

  // Task #1643 — max completed months the Front Analytics coverage refresh
  // worker is allowed to back-fill per tick. Keeps the first-run backfill
  // throttled so Front's Analytics API quota isn't burned and so each tick
  // stays bounded. The current month is ALWAYS re-pulled on top of these
  // backfill slots.
  FRONT_ANALYTICS_COVERAGE_MAX_MONTHS_PER_TICK: envBounded(
    "FRONT_ANALYTICS_COVERAGE_MAX_MONTHS_PER_TICK",
    3,
    1,
    24,
  ),

  // Task #1983 — per-message enumeration fallback budget. Caps how many
  // Front conversations the coverage worker walks per tick when filling
  // per-direction denominators for plan-limited months. Keeps each tick
  // bounded; the walk resumes across ticks via a checkpoint stored in
  // `system_settings`.
  FRONT_ANALYTICS_ENUM_CONVERSATIONS_PER_TICK: envBounded(
    "FRONT_ANALYTICS_ENUM_CONVERSATIONS_PER_TICK",
    150,
    1,
    2000,
  ),
  // Companion cap on Front message-page requests per enumeration tick.
  // Checked only at conversation boundaries so the walk stays
  // conversation-atomic.
  FRONT_ANALYTICS_ENUM_MESSAGE_PAGES_PER_TICK: envBounded(
    "FRONT_ANALYTICS_ENUM_MESSAGE_PAGES_PER_TICK",
    600,
    1,
    20000,
  ),
} as const;

/**
 * Alias for the perfConfig knob, exported under the camelCase name
 * referenced by the Task #1643 spec.
 */
export const frontAnalyticsCoverageMaxMonthsPerTick =
  PERF.FRONT_ANALYTICS_COVERAGE_MAX_MONTHS_PER_TICK;
