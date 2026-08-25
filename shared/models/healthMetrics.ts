import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, boolean, varchar, bigint, text, timestamp } from "drizzle-orm/pg-core";

export const healthSamples = pgTable(
  "health_samples",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    dbConnected: boolean("db_connected").notNull(),
    dbLatencyMs: integer("db_latency_ms"),
    alerts: jsonb("alerts").notNull().default(sql`'[]'::jsonb`),
    manualReserve: jsonb("manual_reserve"),
    // Task #813: separated metrics so the Health dashboard distinguishes
    //   - dbRoundTripMs    : actual probe round-trip on a dedicated max=1 pool
    //   - apiPoolWaitMs    : how long a connect() on the main API pool took
    //   - transientDbRecoveries : count of transient errors recovered by dbRetry
    //                             since the previous sample
    // The pre-existing dbLatencyMs column is kept and will mirror dbRoundTripMs
    // for backward compatibility with older dashboard clients / exports.
    dbRoundTripMs: integer("db_round_trip_ms"),
    apiPoolWaitMs: integer("api_pool_wait_ms"),
    transientDbRecoveries: integer("transient_db_recoveries"),
    // Task #861 Phase 1: probe-pool acquire/connect cost as a first-class
    // persisted metric so post-incident review can isolate handshake cost
    // from wire round-trip cost.
    dbProbeConnectMs: integer("db_probe_connect_ms"),
  },
  (table) => [
    index("idx_health_samples_timestamp").on(table.timestamp),
  ]
);

export type InsertHealthSample = Omit<typeof healthSamples.$inferInsert, "id">;
export type HealthSampleRecord = typeof healthSamples.$inferSelect;

export const manualReserveWorkerSamples = pgTable(
  "manual_reserve_worker_samples",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    worker: varchar("worker", { length: 128 }).notNull(),
    workloadClass: varchar("workload_class", { length: 64 }).notNull(),
    manualAcquires: integer("manual_acquires").notNull().default(0),
    manualDelayedByBackgroundCount: integer("manual_delayed_by_background_count").notNull().default(0),
    manualTimeoutCount: integer("manual_timeout_count").notNull().default(0),
    manualWaitAvgMs: integer("manual_wait_avg_ms"),
    manualWaitP95Ms: integer("manual_wait_p95_ms"),
  },
  (table) => [
    index("idx_manual_reserve_worker_samples_timestamp").on(table.timestamp),
    index("idx_manual_reserve_worker_samples_worker_ts").on(table.worker, table.timestamp),
  ]
);

export type InsertManualReserveWorkerSample = Omit<typeof manualReserveWorkerSamples.$inferInsert, "id">;
export type ManualReserveWorkerSampleRecord = typeof manualReserveWorkerSamples.$inferSelect;

export const manualReserveAlertDispatches = pgTable(
  "manual_reserve_alert_dispatches",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    eventType: varchar("event_type", { length: 24 }).notNull().default("alert"),
    metric: varchar("metric", { length: 128 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    message: text("message").notNull(),
    value: integer("value").notNull().default(0),
    threshold: integer("threshold").notNull().default(0),
    status: varchar("status", { length: 24 }).notNull(),
    detail: text("detail"),
    mutedBy: varchar("muted_by", { length: 128 }),
    muteReason: text("mute_reason"),
    triggeredBy: varchar("triggered_by", { length: 128 }),
    triggerSource: varchar("trigger_source", { length: 64 }),
    isResend: boolean("is_resend").notNull().default(false),
  },
  (table) => [
    index("idx_manual_reserve_alert_dispatches_ts").on(table.timestamp),
    index("idx_manual_reserve_alert_dispatches_event_ts").on(table.eventType, table.timestamp),
  ],
);

export type InsertManualReserveAlertDispatch = Omit<typeof manualReserveAlertDispatches.$inferInsert, "id">;
export type ManualReserveAlertDispatchRecord = typeof manualReserveAlertDispatches.$inferSelect;

// Task #861 Phase 4: periodic snapshot of the API/worker pool state and the
// top hold-label attribution so the dashboard can plot pool saturation and
// surface the dominant offending route/worker without scanning logs.
export const poolStateSamples = pgTable(
  "pool_state_samples",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sampledAt: bigint("sampled_at", { mode: "number" }).notNull(),
    poolName: varchar("pool_name", { length: 32 }).notNull(),
    totalCount: integer("total_count").notNull().default(0),
    idleCount: integer("idle_count").notNull().default(0),
    waitingCount: integer("waiting_count").notNull().default(0),
    maxCount: integer("max_count").notNull().default(0),
    utilizationPct: integer("utilization_pct").notNull().default(0),
    slowAcquiresInInterval: integer("slow_acquires_in_interval").notNull().default(0),
    slowHoldsInInterval: integer("slow_holds_in_interval").notNull().default(0),
    topHoldLabels: jsonb("top_hold_labels").notNull().default(sql`'[]'::jsonb`),
    unknownLabelPct: integer("unknown_label_pct").notNull().default(0),
  },
  (table) => [
    index("idx_pool_state_samples_sampled_at").on(table.sampledAt),
    index("idx_pool_state_samples_pool_ts").on(table.poolName, table.sampledAt),
  ],
);

export type InsertPoolStateSample = Omit<typeof poolStateSamples.$inferInsert, "id">;
export type PoolStateSampleRecord = typeof poolStateSamples.$inferSelect;

// Task #3814: per-table size trend samples for the oversized-table watchdog.
// The table-size watchdog (server/services/tableSizeWatchdog.ts) snapshots
// pg_total_relation_size / pg_stat_user_tables for every table covered by
// the table-maintenance policy so operators can see growth BEFORE it hurts
// queue polling, vacuum, and the daily backup. Rows are pruned by the
// table-retention pruner (this table is itself a covered table).
export const tableSizeSamples = pgTable(
  "table_size_samples",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sampledAt: bigint("sampled_at", { mode: "number" }).notNull(),
    tableName: varchar("table_name", { length: 128 }).notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull().default(0),
    tableBytes: bigint("table_bytes", { mode: "number" }).notNull().default(0),
    indexBytes: bigint("index_bytes", { mode: "number" }).notNull().default(0),
    liveTuples: bigint("live_tuples", { mode: "number" }).notNull().default(0),
    deadTuples: bigint("dead_tuples", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("idx_table_size_samples_table_ts").on(table.tableName, table.sampledAt),
    index("idx_table_size_samples_sampled_at").on(table.sampledAt),
  ],
);

export type InsertTableSizeSample = Omit<typeof tableSizeSamples.$inferInsert, "id">;
export type TableSizeSampleRecord = typeof tableSizeSamples.$inferSelect;

// Task #3816: persisted per-route API request-metrics windows. The
// in-process rolling aggregator (server/services/requestMetrics.ts) flushes
// one row per active route (plus the `_ALL_` aggregate) every 5 minutes so
// per-route latency/error history survives restarts. Read by the System
// Health Console's "API Route Metrics" panel; pruned to 14 days by the
// flusher itself.
export const apiRouteStatsWindows = pgTable(
  "api_route_stats_windows",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    windowStartedAt: bigint("window_started_at", { mode: "number" }).notNull(),
    windowMs: integer("window_ms").notNull().default(0),
    route: varchar("route", { length: 180 }).notNull(),
    count: integer("count").notNull().default(0),
    err4xx: integer("err_4xx").notNull().default(0),
    err5xx: integer("err_5xx").notNull().default(0),
    p50Ms: integer("p50_ms").notNull().default(0),
    p95Ms: integer("p95_ms").notNull().default(0),
    maxMs: integer("max_ms").notNull().default(0),
    avgMs: integer("avg_ms").notNull().default(0),
  },
  (table) => [
    index("idx_api_route_stats_windows_started_at").on(table.windowStartedAt),
    index("idx_api_route_stats_windows_route_ts").on(table.route, table.windowStartedAt),
  ],
);

export type InsertApiRouteStatsWindow = Omit<typeof apiRouteStatsWindows.$inferInsert, "id">;
export type ApiRouteStatsWindowRecord = typeof apiRouteStatsWindows.$inferSelect;

// Task #861 Phase 3: incident grouping. Repeated samples with the same
// fingerprint roll into a single incident row so 6,422 critical alerts
// across 7 days surface as a small handful of actionable incidents.
export const healthIncidents = pgTable(
  "health_incidents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    fingerprint: varchar("fingerprint", { length: 256 }).notNull(),
    metric: varchar("metric", { length: 128 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    title: text("title").notNull(),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    peakValue: integer("peak_value").notNull().default(0),
    latestValue: integer("latest_value").notNull().default(0),
    threshold: integer("threshold").notNull().default(0),
    status: varchar("status", { length: 16 }).notNull().default("firing"),
    acknowledgedBy: varchar("acknowledged_by", { length: 128 }),
    acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
    snoozedUntil: bigint("snoozed_until", { mode: "number" }),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    sampleRefs: jsonb("sample_refs").notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_health_incidents_fingerprint").on(table.fingerprint),
    index("idx_health_incidents_status_last_seen").on(table.status, table.lastSeenAt),
    index("idx_health_incidents_metric_last_seen").on(table.metric, table.lastSeenAt),
  ],
);

export type InsertHealthIncident = Omit<typeof healthIncidents.$inferInsert, "id" | "createdAt" | "updatedAt">;
export type HealthIncidentRecord = typeof healthIncidents.$inferSelect;

// Task #861 Phase 8: daily aggregates for SLO and long-window trend views
// so we don't scan raw samples for 30/90 day windows.
export const healthDailyRollups = pgTable(
  "health_daily_rollups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    metric: varchar("metric", { length: 64 }).notNull(),
    date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD UTC
    sampleCount: integer("sample_count").notNull().default(0),
    okCount: integer("ok_count").notNull().default(0),
    degradedCount: integer("degraded_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    p50: integer("p50"),
    p95: integer("p95"),
    p99: integer("p99"),
    minVal: integer("min_val"),
    maxVal: integer("max_val"),
    avgVal: integer("avg_val"),
    alertCount: integer("alert_count").notNull().default(0),
    incidentCount: integer("incident_count").notNull().default(0),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_health_daily_rollups_metric_date").on(table.metric, table.date),
    index("idx_health_daily_rollups_date").on(table.date),
  ],
);

export type InsertHealthDailyRollup = Omit<typeof healthDailyRollups.$inferInsert, "id" | "createdAt" | "updatedAt">;
export type HealthDailyRollupRecord = typeof healthDailyRollups.$inferSelect;

// Task #1728 (Pool epic Phase 1.5.1) — per-call audit of outbound integration
// requests. Write-gated by `external_call_audit_enabled`. Stores hashes only,
// never raw payloads / tokens / PII.
export const externalCallAudits = pgTable(
  "external_call_audits",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    integration: varchar("integration", { length: 32 }).notNull(),
    endpoint: varchar("endpoint", { length: 256 }).notNull(),
    method: varchar("method", { length: 16 }).notNull().default("GET"),
    calledAt: bigint("called_at", { mode: "number" }).notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    statusCode: integer("status_code"),
    responseSizeBytes: integer("response_size_bytes"),
    responseCacheHit: boolean("response_cache_hit").notNull().default(false),
    sameResponseAsPrevious: boolean("same_response_as_previous").notNull().default(false),
    callerLabel: varchar("caller_label", { length: 128 }),
    requestDedupeKey: varchar("request_dedupe_key", { length: 64 }).notNull(),
    responseHash: varchar("response_hash", { length: 64 }),
    errorClass: varchar("error_class", { length: 64 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_external_call_audits_called_at").on(table.calledAt),
    index("idx_external_call_audits_integration_called").on(table.integration, table.calledAt),
    index("idx_external_call_audits_dedupe").on(table.requestDedupeKey, table.calledAt),
  ],
);

export type InsertExternalCallAudit = Omit<typeof externalCallAudits.$inferInsert, "id" | "createdAt">;
export type ExternalCallAuditRecord = typeof externalCallAudits.$inferSelect;

export const externalCallAuditDailyRollups = pgTable(
  "external_call_audit_daily_rollups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    date: varchar("date", { length: 10 }).notNull(),
    integration: varchar("integration", { length: 32 }).notNull(),
    endpoint: varchar("endpoint", { length: 256 }).notNull(),
    callerLabel: varchar("caller_label", { length: 128 }).notNull().default(""),
    callCount: integer("call_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    avgDurationMs: integer("avg_duration_ms"),
    p95DurationMs: integer("p95_duration_ms"),
    cacheHitCount: integer("cache_hit_count").notNull().default(0),
    sameResponseCount: integer("same_response_count").notNull().default(0),
    totalResponseBytes: bigint("total_response_bytes", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_external_call_audit_daily_rollups_date").on(table.date),
  ],
);

export type InsertExternalCallAuditDailyRollup = Omit<
  typeof externalCallAuditDailyRollups.$inferInsert,
  "id" | "createdAt" | "updatedAt"
>;
export type ExternalCallAuditDailyRollupRecord = typeof externalCallAuditDailyRollups.$inferSelect;

// Task #1728 (Pool epic Phase 1.5.2) — daily aggregate of
// `pool_state_samples.top_hold_labels` so the admin trends view can render
// 30-day windows without re-aggregating raw samples on every request.
export const dbHoldLabelRollups = pgTable(
  "db_hold_label_rollups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    date: varchar("date", { length: 10 }).notNull(),
    pool: varchar("pool", { length: 32 }).notNull(),
    holdLabel: varchar("hold_label", { length: 256 }).notNull(),
    count: integer("count").notNull().default(0),
    maxDurationMs: integer("max_duration_ms").notNull().default(0),
    avgDurationMs: integer("avg_duration_ms"),
    p95DurationMs: integer("p95_duration_ms"),
    totalHoldTimeMs: bigint("total_hold_time_ms", { mode: "number" }).notNull().default(0),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("idx_db_hold_label_rollups_date").on(table.date),
    index("idx_db_hold_label_rollups_pool_date").on(table.pool, table.date),
  ],
);

export type InsertDbHoldLabelRollup = Omit<
  typeof dbHoldLabelRollups.$inferInsert,
  "id" | "createdAt" | "updatedAt"
>;
export type DbHoldLabelRollupRecord = typeof dbHoldLabelRollups.$inferSelect;
