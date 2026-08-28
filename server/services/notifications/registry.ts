/**
 * Task #994 — Canonical notification registry.
 *
 * One in-code source of truth for every Slack notification the system can
 * send. Services reference notification IDs (`category.subject.event`) — never
 * raw setting keys. The registry distinguishes implemented (live signal
 * already wired) vs. placeholder (registered but the dispatcher will not be
 * called until the signal lands).
 */

export type NotificationCategoryId =
  | "integration"
  | "infra"
  | "queue"
  | "usage"
  | "workflow";

export interface NotificationCategoryMeta {
  id: NotificationCategoryId;
  label: string;
  description: string;
}

export const NOTIFICATION_CATEGORIES: NotificationCategoryMeta[] = [
  {
    id: "integration",
    label: "Integration Health",
    description: "Auth/credential failures across third-party integrations.",
  },
  {
    id: "infra",
    label: "Infrastructure",
    description: "Database, worker, webhook, storage and deployment signals.",
  },
  {
    id: "queue",
    label: "Operational Queues",
    description: "Backlog and failure-rate alerts for review/repair queues.",
  },
  {
    id: "usage",
    label: "Usage & Limits",
    description: "Rate-limit, manual-reserve and external-API spend signals.",
  },
  {
    id: "workflow",
    label: "Workflow Events",
    description: "Settings changes, daily summaries and milestone events.",
  },
];

export interface NotificationRegistryEntry {
  id: string;
  category: NotificationCategoryId;
  label: string;
  description: string;
  defaultEnabled: boolean;
  /** Legacy `system_settings` key that holds the channel for migration. */
  defaultChannelSettingKey?: string;
  /** Other legacy keys whose channel value should be migrated if present. */
  legacySettingKeys?: string[];
  /** Env vars that, when set, override the saved channel id. */
  envOverrideKeys?: string[];
  /** Whether the dispatcher exposes a "send test" path for this notification. */
  supportsTest: boolean;
  /** True only if a live signal already calls `notifyByType` for this id. */
  implemented: boolean;
  /** Human-readable owner for triage. */
  ownerService?: string;
}

export const NOTIFICATION_REGISTRY: NotificationRegistryEntry[] = [
  // ──────────────── Category 1: Integration Health ────────────────
  {
    id: "integration.front.auth_failed",
    category: "integration",
    label: "Front auth failure",
    description: "Front OAuth expired, refresh failed, or sustained API auth failures.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
    ownerService: "frontIntegration",
  },
  {
    id: "integration.zoom.auth_failed",
    category: "integration",
    label: "Zoom auth failure",
    description: "Zoom OAuth expired, refresh failed, or sustained API auth failures.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "zoomIntegration",
  },
  {
    id: "integration.google.auth_failed",
    category: "integration",
    label: "Google Calendar auth failure",
    description: "Calendar token expired, refresh failed, missing scope, or auth failure.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
    ownerService: "googleCalendarIntegration",
  },
  {
    id: "integration.pandadoc.auth_failed",
    category: "integration",
    label: "PandaDoc auth failure",
    description: "Token rejected, sustained 401/403, or webhook auth issue.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
    ownerService: "pandadocIntegration",
  },
  {
    id: "integration.slack.auth_failed",
    category: "integration",
    label: "Slack auth failure",
    description: "Bot token revoked, missing scope, or channel post auth failure.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
    ownerService: "slackIntegration",
  },
  {
    id: "integration.semrush.auth_or_circuit_open",
    category: "integration",
    label: "SEMrush auth / circuit open",
    description:
      "SEMrush tokens absent or auth-dead breaker open beyond the grace window — fleet-wide sync is paused. " +
      "Re-authorize in Settings → Integrations Hub to recover. (Task #2877)",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "semrushCircuitBreaker",
  },
  {
    id: "integration.semrush.api_key_rejected",
    category: "integration",
    label: "SEMrush API key rejected",
    description:
      "Key-mode SEMrush calls are hitting repeated 401/403 — the SEMRUSH_V4_API_KEY secret is invalid, revoked, or expired. " +
      "Rotate the secret and republish; this is NOT an OAuth reconnect. (Task #3672)",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "semrushKeyModeAlert",
  },
  {
    id: "integration.semrush.keepalive_terminal",
    category: "integration",
    label: "SEMrush keep-alive terminal failure",
    description:
      "The proactive SEMrush token keep-alive refresh failed terminally (non-authoritative path — breaker NOT yet open). " +
      "The access token will not be renewed automatically; reconnect SEMrush before the 7-day token expires.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "semrushTokenKeepAlive",
  },
  {
    id: "integration.twilio.auth_or_config_failed",
    category: "integration",
    label: "Twilio auth / config failure",
    description: "SID/Auth Token rejected, API Key SID invalid, or TwiML App invalid.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
    ownerService: "twilioErrors",
  },
  {
    id: "integration.stripe.auth_or_webhook_failed",
    category: "integration",
    label: "Stripe auth / webhook failure",
    description: "API key rejected or sustained webhook signature failures.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "integration.openai.auth_or_quota_failed",
    category: "integration",
    label: "OpenAI auth / quota failure",
    description: "API key rejected, quota exhausted, or sustained billing errors.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "integration.rev.auth_failed",
    category: "integration",
    label: "Rev.ai / Rev.com auth failure",
    description: "Rev API key rejected or transcription credentials invalid.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "integration.twelvelabs.auth_failed",
    category: "integration",
    label: "TwelveLabs auth failure",
    description: "TwelveLabs API key rejected.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "integration.maps.auth_failed",
    category: "integration",
    label: "Maps providers auth failure",
    description: "Repeated auth failures for Google Maps, MapTiler, or FCC.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },

  {
    // Task #2984 — fires once per new streak when the per-user ClickUp auth
    // breaker opens (trip hook registered in clickUpBreakerPersistence.ts).
    // Deduped per token suffix so only one alert fires per streak.
    // Kill switch: none (always-on when ClickUp is connected).
    id: "integration.clickup.auth_dead",
    category: "integration",
    label: "ClickUp auth breaker opened",
    description:
      "A per-user ClickUp token appears revoked or invalid — the auth breaker has opened for that token. Re-authorize ClickUp in Settings → Integrations Hub to recover.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "clickUpBreakerPersistence",
  },

  {
    // Task #5156 — fires when a cu_role_projection_commands row reaches
    // terminal failure (exhausted max attempts or non-retryable error).
    // Deduped per (clientId+destinationId) per 24 h to prevent storms.
    // Kill switch: `clickup_role_projection` (same as the worker kill switch).
    id: "integration.clickup.role_projection_terminal",
    category: "integration",
    label: "ClickUp role projection terminal failure",
    description:
      "A ClickUp role projection command has exhausted all retries or hit a non-retryable error. " +
      "The People field on the ClickUp task may be out of sync with NoBull. " +
      "Check the admin projection status panel and use manual resync to recover.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "clickUpRoleProjection",
  },

  {
    // Task #3662 — fires once per outage streak when the Ads OS ClickUp
    // Client List directory fetch goes down: HTTP 401 (auth-dead, e.g. the
    // company token was rotated/revoked) after a short grace window, or any
    // other failure after a consecutive-failure threshold. Re-armed by the
    // next successful fetch (markRecovered). Uses the COMPANY token, not
    // per-user OAuth — distinct from integration.clickup.auth_dead.
    // Kill switch: `kill_switch_clickup_directory_alert` ("false" disables).
    id: "integration.clickup.ads_os_directory_down",
    category: "integration",
    label: "Ads OS ClickUp directory down",
    description:
      "The Ads OS Client List directory fetch is failing (auth-dead company token or persistent errors). " +
      "Dashboards degrade to raw Google Ads account names until it recovers. " +
      "Rotate the token in Settings → Integrations Hub → ClickUp — no republish needed.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "clickUpDirectoryAlert",
  },

  {
    // Task #2984 — fires when the clickup_webhook_health_check handler finds
    // one or more webhooks with excessive fail_count or not present in ClickUp.
    // Deduped per hour to prevent alert storms during sustained outages.
    // Kill switch: `clickup_reconciliation_sweep_enabled` (sweep must be ON
    // for the health-check handler to be enqueued).
    id: "integration.clickup.webhook_health_degraded",
    category: "integration",
    label: "ClickUp webhook degraded / dead",
    description:
      "A registered ClickUp webhook has accumulated failures or gone missing. " +
      "The auto-repair handler will attempt to delete and recreate it. " +
      "Check Settings → Integrations → ClickUp to review.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "clickUpWebhookHealthCheck",
  },
  {
    id: "integration.clickup.webhook_event_terminal",
    category: "integration",
    label: "ClickUp webhook task event failed",
    description:
      "A verified canonical Client List task event exhausted its bounded work-queue retries. " +
      "Review and replay the ClickUp task-apply job from the dead-letter queue.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "clickUpWebhookInbox",
  },

  {
    // Task #1643 — fires when Front Analytics all-time applied coverage
    // drops by more than `front_analytics_coverage_drop_delta_pct`
    // (default 2.0) between refreshes, OR when any month's applied
    // coverage falls below `front_analytics_month_floor_pct`
    // (default 95.0). Kill switch: `front_analytics_coverage_alerts_enabled`.
    id: "integration.front.analytics_coverage_drop",
    category: "integration",
    label: "Front Analytics coverage drop / below floor",
    description:
      "Front Analytics-derived all-time email coverage dropped past the configured delta, or a month is below the configured floor (defaults: drop ≥2pp; floor 95%). Payload distinguishes ingest gap (Front has, we never fetched) vs apply gap (we fetched, never applied).",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "frontAnalyticsCoverageAlerts",
  },

  {
    // Task #2819 — fires when a coverage refresh corrects a Front month's
    // message denominator UPWARD (Task #2795 floor invariant: local
    // message count exceeded Front's reported total). Deduped once per
    // month per raise (new excess, or material regrowth past the
    // last-alerted excess — `front_analytics_floor_raise_regrowth_pct`,
    // default 25%), never on every refresh tick. Sub-switch:
    // `front_analytics_floor_raise_alerts_enabled` (default ON); also
    // gated by the master `front_analytics_coverage_alerts_enabled`.
    id: "integration.front.coverage_denominator_floor_raise",
    category: "integration",
    label: "Front coverage denominator raised (floor invariant)",
    description:
      "A coverage refresh raised a Front month's message denominator because the local message count exceeded Front's reported total. Names the month, the excess, and the reconciliation note; recurring or growing excess suggests Front Analytics totals and local tables are drifting.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "frontAnalyticsCoverageAlerts",
  },

  {
    // Task #1684 — fires when the Front self-healing coverage loop
    // (Task #1682) is running but not making progress, or has gone
    // quiet. Seven conditions: ingest/apply gap growth across N
    // consecutive ticks, auto-healer silent, repeated same-gate skips,
    // recovery not converging, unrecovered monthly errors, and
    // overnight window missed (overnight task not yet shipped — that
    // condition is intentionally skipped at runtime).
    // Kill switch: `front_auto_closure_alerts_enabled` — independent
    // from the existing `front_analytics_coverage_alerts_enabled`.
    id: "integration.front.auto_closure_regression",
    category: "integration",
    label: "Front auto-closure regression",
    description:
      "Front auto-closure loop (Task #1682) is running but not making progress, or has gone silent. Fires on ingest/apply gap growth, repeated same-gate skips, recovery non-convergence, persistent monthly errors, or auto-healer silence past the configured interval.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "frontAutoClosureRegressionAlerts",
  },

  // ──────────────── Category 2: Infrastructure ────────────────
  {
    id: "infra.database.connection_failures",
    category: "infra",
    label: "DB connection failures",
    description: "Consecutive DB connection failures over threshold.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "infra.database.pool_saturation",
    category: "infra",
    label: "DB pool saturation",
    description: "Sustained pool utilization above threshold for configured duration.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "infra.database.slow_query_spike",
    category: "infra",
    label: "Slow-query spike",
    description: "Slow-query count or p95 latency spike.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #1731 (Pool epic Phase 4, spec 4.3) — high-severity signal for
    // any single DB-connection hold exceeding 30s. Layered on top of the
    // existing 1s warn / 10s structured-warn tiers in
    // `InstrumentedPool.logHoldDuration` (see `services/longDbHoldAlerts`).
    id: "infra.database.hold_duration_critical",
    category: "infra",
    label: "DB connection held > 30s",
    description:
      "An individual DB-pool connection was held for more than 30s. Holds this long indicate that an external call, AI completion, or unbounded loop is running inside a DB-hold window — the Pool Tenancy & DB-Hold Rules forbid this. The Phase 4 guard in `services/longDbHoldAlerts` emits this signal with per-(pool,label) cooldown so a single stuck connection does not fan out. Gated by `db_hold_rollup_enabled` (Phase 0 switch).",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "longDbHoldAlerts",
  },
  {
    // Task #1731 (Pool epic Phase 4, spec 4.4) — periodic evaluator over
    // `external_call_audits` / `external_call_audit_daily_rollups` /
    // `pool_state_samples`. Fires on same-response storms, WoW cache-hit
    // drops, calls/min spikes, duration spikes, and external-call ↔ DB
    // saturation correlation. See `services/externalCallAuditAlerts`.
    id: "infra.usage.external_call_audit_alert",
    category: "infra",
    label: "External-call audit alert",
    description:
      "External-call audit evaluator detected a same-response storm, cache-hit drop, calls/min spike, duration spike, or external-call ↔ DB-saturation correlation. Thresholds live in `system_settings` (`external_call_alert_*`); active alerts surface on /admin/db-attribution/trends. Gated by `external_call_audit_enabled` (Phase 0 switch).",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "externalCallAuditAlerts",
  },
  {
    id: "infra.worker.sampler_stalled",
    category: "infra",
    label: "Worker sampler stalled",
    description: "Supervised sampler watchdog tripped or health sampler stalled.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "infra.worker.repeated_job_failures",
    category: "infra",
    label: "Repeated worker job failures",
    description: "Worker failure rate exceeds threshold per queue/worker.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "infra.webhook.5xx_spike",
    category: "infra",
    label: "Inbound webhook 5xx spike",
    description: "Sustained 5xx responses from inbound webhooks (Front, Twilio, Stripe, PandaDoc).",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "infra.storage.failures",
    category: "infra",
    label: "Object storage failures",
    description: "Sustained read/write failures to object storage or Drive mirror.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #3703 — fires when the Front per-message materializer's write path
    // detects that the raw-SQL-managed partial unique index
    // `raw_comm_external_source_id_unique_idx` (the ON CONFLICT arbiter for
    // `createRawCommunicationOnConflictSkip`) has vanished from
    // raw_communication_records. Without it every Front email materialization
    // insert fails with 42P10 and rows silently stop landing. The detector
    // runs a one-shot in-process self-heal (dedupe keep-oldest + CREATE UNIQUE
    // INDEX IF NOT EXISTS, same as the server/index.ts bootstrap) and this
    // alert reports the drop + heal outcome either way.
    id: "infra.database.raw_comm_unique_index_missing",
    category: "infra",
    label: "Front email dedupe index vanished",
    description:
      "The partial unique index raw_comm_external_source_id_unique_idx (the ON CONFLICT arbiter for Front per-message materialization) is missing from raw_communication_records — every Front email insert was failing. A one-shot in-process self-heal (dedupe keep-oldest + recreate index) runs on detection; the alert names whether it succeeded. If the heal failed, restart the server to re-run the bootstrap ensure.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "rawCommIndexSelfHeal",
  },
  {
    // Task #2657 — fires when the daily app backup (Postgres dump + Object
    // Storage file manifest/incremental archive) finishes in a non-success
    // state (`failed` = both halves failed, `partial` = one half failed).
    // A silent backup outage is dangerous, so any non-success run alerts.
    id: "infra.backup.failed",
    category: "infra",
    label: "App backup failed / partial",
    description:
      "The daily app backup (Postgres dump + Object Storage file manifest) completed in a failed or partial state. Payload names which half(s) failed.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "appBackupScheduler",
  },
  {
    // Task #4184 — fires when an ATS JSONB boundary accessor
    // (server/services/atsJsonb.ts, F4 #4150) detects a malformed stored row
    // (corrupted ai_score_json, assessment_json, ...). Reads degrade to the
    // boundary's documented fallback, so without this alert the only symptom
    // would be a silently missing score or shorter assessment. Deduped per
    // table.column boundary; the alert names sample row IDs only (no
    // candidate PII, no stored-value preview — that stays in the server log).
    id: "infra.ats.jsonb_malformed",
    category: "infra",
    label: "Corrupted ATS candidate data detected",
    description:
      "An ATS JSONB read boundary (e.g. ats_candidates.ai_score_json, ats_jobs.assessment_json) found a stored row that does not match its expected shape. Endpoints degrade gracefully, but the row needs repair — the alert names the table.column and a sample job/candidate id; the stored-value preview is in the server logs under \"[ATS JSONB]\".",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "atsJsonbCorruptionAlerts",
  },
  {
    // Task #4197 — same gap as infra.ats.jsonb_malformed, for the REPORTS
    // JSONB boundaries (F5, server/lib/reportJsonbAccessors.ts).
    id: "infra.reports.jsonb_malformed",
    category: "infra",
    label: "Corrupted reports data detected",
    description:
      "A reports JSONB read boundary (e.g. report_sections.data, ceo_pulses.ai_analysis) found a stored row that does not match its expected shape. Endpoints degrade gracefully (empty section / missing analysis), but the row needs repair — the alert names the boundary and a sample report/section/pulse id; the stored-value details are in the server logs under \"[reportJsonbAccessors]\".",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "reportJsonbCorruptionAlerts",
  },
  {
    // Task #4620 — serve-time twin of the Lifetime Value slide's Task #4592
    // client gate: when the trend window's per-source lead sum (gbp +
    // googleAds + lsa + webinar per month) exceeds lifetimeValue.totalLeads,
    // the slide hides its compounding-arc chart with only a browser
    // console.warn. This alert fires from buildReportResponse (share +
    // preview serves) so operators see the data inconsistency instead of
    // clients silently losing the chart. Deduped per report id.
    id: "infra.reports.lifetime_lead_mismatch",
    category: "infra",
    label: "Report lifetime-vs-monthly lead mismatch",
    description:
      "A served client report's trend-window per-source lead sum exceeds its lifetime headline (lifetimeValue.totalLeads), so the Lifetime Value slide hides its compounding-arc chart for viewers. Usually a bad backfill, an edited month, or formula drift — the alert names the report, client, month, and both numbers. Deduped per report.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "lifetimeLeadMismatchAlerts",
  },
  {
    // Task #3699 — fires when the Zoom stale-apply sweep finds
    // recording/transcript source events stuck pre-apply (ready_to_apply
    // et al.) past the 6h threshold, i.e. a Zoom transcript/recording
    // arrived but its attach-to-meeting apply crashed and was never
    // re-driven. Once-per-streak: re-arms when a sweep finds none.
    id: "infra.zoom.stale_apply_events",
    category: "infra",
    label: "Zoom apply events stuck pre-apply",
    description:
      "The Zoom stale-apply sweep found recording/transcript events stuck before apply for more than 6 hours (crashed/interrupted apply). The sweep re-drives them with bounded retries; drain manually via the 'Drain stale Zoom apply events' prod-action.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "zoomStaleApplyEventSweep",
  },
  {
    // Task #2897 — memory watchdog for the Reserved VM deployment. Fires
    // when process RSS crosses the configured threshold (default 3072 MB
    // ≈ 75% of the 4 GB tier); a single "recovered" follow-up is sent when
    // RSS drops back below the re-arm level. Once-per-breach-streak dedupe
    // lives in the watchdog itself.
    id: "infra.memory.high_rss",
    category: "infra",
    label: "High process memory (RSS)",
    description:
      "Process RSS crossed the memory-watchdog alert threshold (default 3072 MB, ~75% of the 4 GB Reserved VM tier). Fires once per breach streak; a recovered follow-up re-arms it.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "memoryWatchdog",
  },
  {
    // Task #3814 — table-size watchdog. Fires when a table covered by the
    // table-maintenance policy (work_queue, front_hydrate_snapshots,
    // source_event_log, work_result_log, apply_state, call_analysis_jobs,
    // mcu_cache, pool_state_samples, table_size_samples) grows past its
    // expected size band, i.e. retention/pruning stopped keeping up or the
    // band needs retuning. Sustained-breach dedupe uses one dedupeKey per
    // table (`table_growth:<table>`); the watchdog marks recovery when the
    // table falls back under 90% of the band.
    id: "infra.database.table_growth",
    category: "infra",
    label: "DB table over size band",
    description:
      "A covered high-churn table (queue/log/cache) grew past its expected size band. Points at the deep-prune/reclaim production action or a band retune via `table_size_watchdog_bands_mb`.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "tableSizeWatchdog",
  },
  {
    // Task #3816 — app-wide request spine: a specific API route's rolling
    // p95 latency or 5xx error rate stayed above its band across N
    // consecutive evaluations (requestMetricsAlerts). One dedupeKey per
    // route (`api_route_regression:<METHOD /route>`); recovery is marked
    // when the route returns in band or its traffic stops.
    id: "infra.api.route_regression",
    category: "infra",
    label: "API route regression",
    description:
      "A specific API route's rolling p95 latency or 5xx error rate stayed above its band across consecutive evaluations. Correlate `rid=` access-log lines for the route, then check System Health → API Route Metrics. Bands tune via `request_metrics_alert_config`.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "requestMetricsAlerts",
  },
  {
    // Task #774 — alert when an audit prune deletes an unusually large
    // number of rows (configurable absolute floor + ratio against the
    // recent baseline). Lets operators catch retention-misconfiguration
    // data loss instead of silently nuking history.
    id: "infra.audit_prune.unusually_large_delete",
    category: "infra",
    label: "Audit prune unusually large delete",
    description:
      "An audit-table prune (admin_setting_audit, stale_lease_threshold_audit, queue_timing_audit, or blocked_ip_audit) deleted more rows than the configured anomaly threshold (default ≥1,000 rows AND ≥5x the recent baseline average).",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "auditPruneAnomalyAlerts",
  },
  {
    // Task #973 — post-deploy verification report (pass / warn).
    // Fires once per boot ~7 min after server start with the §8 checklist
    // summary + baseline comparison, so the team's normal Slack channel
    // confirms a clean rollout without anyone opening /admin/health.
    id: "infra.deployment.post_deploy_verification",
    category: "infra",
    label: "Post-deploy verification report",
    description:
      "Compact pass/warn summary of `runPostDeployVerification()` plus the comparison-to-baseline diff, posted once after every server boot. Failures are routed to a separate paging notification.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "postDeployVerificationDigest",
  },
  {
    // Task #973 — paging variant fired only when overall=`fail`. Lets ops
    // route the FAIL signal to a high-attention channel (on-call) while the
    // routine pass/warn report goes to the regular digest channel.
    id: "infra.deployment.post_deploy_verification_failed",
    category: "infra",
    label: "Post-deploy verification FAILED (page on-call)",
    description:
      "Fired when `runPostDeployVerification()` returns overall=`fail` shortly after a deploy. Routes the FAIL summary to the on-call channel so somebody is paged within minutes of a bad rollout.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "postDeployVerificationDigest",
  },
  {
    // Task #2611 — nightly regression-sweep failure. Fired when the scheduled
    // `--regression --sweep` run has at least one non-quarantined failure (or
    // the run crashed before producing a report) so a rotted, rarely-run test
    // is caught within a day. Mirrors to the admin in-app inbox automatically.
    id: "infra.regression_sweep.failed",
    category: "infra",
    label: "Nightly regression sweep FAILED",
    description:
      "Fired when the nightly workspace regression sweep (`tests/run-all.ts --regression --sweep`) has a real, non-quarantined test failure. Names the broken tests so a regression-flagged-but-rarely-run test can't rot unnoticed.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "regressionSweepScheduler",
  },
  {
    // Task #4729 — weekly non-Latin spreadsheet typing safety check. Fired
    // when the scheduled build+harness run fails (either leg), and by the
    // 6h staleness watchdog when no successful run is on record within the
    // threshold — so a silently dead harness (2026-08-11 auth-cutover class)
    // surfaces without a human remembering to run it.
    id: "infra.sheet_nonlatin_check.failed",
    category: "infra",
    label: "Weekly spreadsheet non-Latin typing check FAILED/stale",
    description:
      "Fired when the weekly production-build check of CJK/emoji/accented/RTL spreadsheet typing (`scripts/verify-sheet-nonlatin-e2e.ts`) fails, or when the staleness watchdog finds no successful run within the threshold. Either spreadsheet typing regressed in production builds or the harness itself broke.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "sheetNonlatinCheckScheduler",
  },
  {
    // Task #4640 — nightly dev/prod catalog drift comparator. Fires when
    // production holds a table/index/constraint the dev DB lacks (excluding
    // intentional pending drops from listed SAFE_MIGRATIONS files), or when
    // the check itself cannot run (missing/stale dev snapshot, errors) —
    // the drift check is never silent.
    id: "infra.schema_drift.prod_only_objects",
    category: "infra",
    label: "Dev/prod schema drift",
    description:
      "Production database has catalog objects (tables/indexes/constraints) the dev DB lacks — the next Publish diff could DROP them from production (0085 incident class). Also fires when the nightly check is blind (missing/stale dev catalog snapshot) or errored.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "schemaDriftCheck",
  },
  {
    id: "infra.deployment.unexpected_restart",
    category: "infra",
    label: "Unexpected deployment restart",
    description: "Crash loop or unexpected boot recovery if detectable.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #984 — boot-time post-deploy auto-baseline snapshot was skipped
    // because overall checklist status was not "pass". Surfaces a one-shot
    // alert (with persisted cooldown) so a degraded deploy doesn't silently
    // leave the baseline stale.
    id: "infra.deployment.auto_baseline_skipped",
    category: "infra",
    label: "Post-deploy auto-baseline skipped",
    description:
      "The boot-time post-deploy verification ran and overall status was not 'pass', so the baseline was not auto-refreshed. Lists the failing checklist groups so the on-call can jump straight to the panel.",
    defaultEnabled: true,
    // Reuse the existing health/admin alert channel so default deployments
    // route the alert without admins having to configure a new channel.
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "autoBaselineSkipAlerts",
  },
  {
    // Task #1231 — alert when the number of clients whose stored `products`
    // column contains values that would now fail strict `validateProductList`
    // validation grows since the last check. The audit endpoint
    // (`/api/admin/clients/invalid-products`, Task #778) is a pull surface
    // admins only see when they visit the Client Management page; this alert
    // is a passive push so an import or older code path that writes a new bad
    // row surfaces immediately.
    id: "data.client_products.invalid_growth",
    category: "infra",
    label: "Clients with invalid product values increased",
    description:
      "The audit at `/api/admin/clients/invalid-products` (Task #778) found more client rows whose stored `products` column fails strict `validateProductList` than the last snapshot. Includes the new count, the distinct invalid values, and the affected client names/codes so an operator can correct the source. Fires only when the count grows; stable or shrinking counts are silent.",
    defaultEnabled: true,
    // Reuse the existing health/admin alert channel so default deployments
    // route the alert without admins having to configure a new channel.
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "invalidProductsGrowthAlerts",
  },
  {
    // Task #1110 — startup client-products normalization backfill (Task #656)
    // dropped values that the canonical product resolver does not recognize.
    // Without this alert the only signal is a single console.warn at boot, so
    // a real new product missing from `shared/productResolution.ts` silently
    // disappears from clients on every restart.
    id: "infra.client_products_backfill.unknown_values",
    category: "infra",
    label: "Client-products backfill dropped unrecognized values",
    description:
      "The startup client-products normalization backfill found product strings it could not resolve and dropped them from the canonical array. Includes the count, distinct unrecognized values, and sample client IDs so an operator can either add the missing alias to `shared/productResolution.ts` or clean the source data.",
    defaultEnabled: true,
    // Reuse the existing health/admin alert channel so default deployments
    // route the alert without admins having to configure a new channel.
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "clientProductsBackfillAlerts",
  },
  {
    // Task #1986 — fires when a client create/update/delete audit-log write
    // fails. Those writes feed the client History popover and are
    // intentionally best-effort (the mutation succeeds even if logging
    // throws), so before this alert a persistently broken logging path
    // quietly emptied the timeline with only a console.error line. Routes
    // the failure through the dispatcher so a broken history path is noticed.
    id: "infra.client_audit_log.write_failed",
    category: "infra",
    label: "Client audit-log write failed (History popover)",
    description:
      "An audit-log write during a client create/update/delete failed, so the rows that feed the client History popover were lost even though the mutation itself succeeded. Includes the operation, client, dropped-event count, and the underlying error. A persistent failure means the logging path (`insertActivityLogs` → `user_activity_logs`) is broken. Cooldown via `client_audit_log:write_failed_alert_cooldown_minutes` (default 30m).",
    defaultEnabled: true,
    // Reuse the existing health/admin alert channel so default deployments
    // route the alert without admins having to configure a new channel.
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "clientAuditLogFailureAlerts",
  },

  // ──────────────── Category 3: Operational Queues ────────────────
  {
    id: "queue.zoom_review.backlog",
    category: "queue",
    label: "Zoom review queue backlog",
    description: "Pending Zoom review calls over threshold or oldest item too old.",
    defaultEnabled: false,
    defaultChannelSettingKey: "zoom_review_alert_slack_channel",
    supportsTest: true,
    implemented: true,
    ownerService: "zoomReviewQueueAlerts",
  },
  {
    id: "queue.slack_review.backlog",
    category: "queue",
    label: "Slack review queue backlog",
    description: "Slack review/claim flow backlog. Disabled until claim flow ships.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "queue.front_review.backlog",
    category: "queue",
    label: "Front review queue backlog",
    description: "Unmatched/pending Front review count over threshold.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #1053 — alert when the Twilio call-recording archive pipeline
    // appears to have stalled (rows stuck in `pending` past the threshold,
    // or rows landing in `failed` after exhausting MAX_ATTEMPTS).
    id: "queue.call_recording_archive.backlog_or_failures",
    category: "queue",
    label: "Call recording archive backlog / failures",
    description:
      "Twilio call recordings stuck in `archive_status='pending'` for too long, or rows transitioning to `failed` after exhausting the bounded retry budget.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "callArchiveBacklogAlerts",
  },
  {
    id: "queue.repair.backlog_or_failures",
    category: "queue",
    label: "Repair queue backlog / failures",
    description: "Repair backlog or failure rate over threshold.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #1224 — total pending `import_entity_suggestions` exceeded
    // the configured threshold (queue is not being worked).
    id: "queue.import_suggestions.backlog",
    category: "queue",
    label: "Import suggestions backlog",
    description:
      "Pending import_entity_suggestions (SEMrush mapping / Front enrichment / etc.) crossed the configured threshold.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "importSuggestionsBacklogAlerts",
  },
  {
    // Task #1224 — daily/weekly digest of pending
    // `import_entity_suggestions` grouped by client + surface.
    id: "queue.import_suggestions.digest",
    category: "queue",
    label: "Import suggestions digest",
    description:
      "Daily or weekly summary of pending import_entity_suggestions, grouped by client and surface.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: true,
    ownerService: "importSuggestionsBacklogAlerts",
  },
  {
    id: "queue.pending_digest_alerts.backlog",
    category: "queue",
    label: "Pending digest alerts backlog",
    description: "Pending digest alert backlog grows or fails to drain.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #1023 — Front Historical Recovery window crossed the
    // configured retry-volume threshold (Front is being hammered).
    id: "integration.front.recovery_retry_pressure",
    category: "integration",
    label: "Front recovery retry pressure",
    description:
      "A Front Historical Recovery window's totalRetries crossed the configured threshold (Front is flaky or rate-limiting). Fires once per (jobId, windowLabel).",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontRecoveryRetryAlerts",
  },
  {
    // Task #1903 — Front Historical Recovery dedupe-key contract
    // failures. Fires when same-response suppression skips dominate a
    // recovery window (≥ ratio over a min-pages sample), or when the
    // sibling probe finds any `source_event_log` rows whose dedupe
    // key has regressed to the empty-suffix `front:recovery:<id>:`
    // shape. Both signals indicate the dedupe-key version slot has
    // collapsed and silent drops are imminent.
    id: "integration.front.recovery_dedupe_contract_failure",
    category: "integration",
    label: "Front recovery dedupe-key contract failure",
    description:
      "Same-response suppression is dominating a Front recovery window, or `source_event_log` rows with empty-suffix dedupe keys were observed. Either signal means the per-message dedupe slot has collapsed and Front pages are being silently absorbed instead of persisted. Thresholds live in `system_settings` (`front_recovery_suppression_dominance_alert_*`, `front_recovery_empty_suffix_dedupe_alert_enabled`).",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontRecoveryRetryAlerts",
  },
  {
    // Task #1872 — Front Historical Recovery's per-page dedupe
    // sample has flipped `apply_layer_dropping` across N consecutive
    // pages for the same (jobId, windowLabel). Means recovered
    // conversations are being silently dropped at the apply layer
    // rather than persisted — dedupe pct looks healthy but real
    // ingest is stalled.
    id: "integration.front.recovery_apply_layer_drop",
    category: "integration",
    label: "Front recovery apply-layer drop",
    description:
      "Front Historical Recovery's per-page dedupe sample reported `apply_layer_dropping` across the configured number of consecutive pages (default 3) for the same window. Threshold lives in `system_settings` (`front_recovery_dedupe_drop_alert_*`).",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontRecoveryDedupeDropAlerts",
  },
  {
    // Task #1282 — a Front Historical Recovery job ended with a
    // `fatal_error:` reason (i.e. the recovery IIFE hit an unexpected
    // throw and the job moved to `status="failed"`). Fires when the
    // count of NEW fatal jobs in the configured rolling window
    // crosses the threshold; per-job and per-lineage dedupe prevent
    // re-alerting on every sweep.
    id: "integration.front.historical_recovery_fatal_errors",
    category: "integration",
    label: "Front historical recovery fatal-error rate",
    description:
      "Count of Front Historical Recovery jobs that ended with a `fatal_error:` reason in the rolling window crossed the configured threshold. Excludes `db_pool_saturated:` (a recoverable pool stall handled separately). Threshold + window + cooldown live in `system_settings` (`front_historical_recovery_fatal_alert_*`).",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontHistoricalRecoveryFatalAlerts",
  },
  {
    // Task #1076 — alert when failed call_analysis_jobs spike for a
    // single failure_reason (absolute count or 3x baseline).
    id: "queue.call_analysis.failure_spike",
    category: "queue",
    label: "Call analysis failure spike (single reason)",
    description:
      "A single `call_analysis_jobs.failure_reason` crossed the configured absolute (default 10/h) or ratio (default 3x of the 7d baseline) threshold. Per-reason mute list and thresholds live in `system_settings`.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "callAnalysisFailureSpikeAlerts",
  },
  {
    // Task #1073 — a /api/health sub-check (e.g. db, tables,
    // scheduler_stale, advisory_slot_bypass_high) has stayed in the
    // `degraded` set longer than its configured per-key threshold
    // (defaults: 10m for critical `db`/`tables`, 30m for soft warnings).
    id: "infra.health.subcheck_degraded_persistent",
    category: "infra",
    label: "Health sub-check degraded too long",
    description:
      "A /api/health sub-check has stayed degraded past its per-key threshold (default 10m for critical `db`/`tables`, 30m for soft warnings). Auto-resolves with a recovery message when the entry drops out of the degraded set. Thresholds and cooldown live in `system_settings` (`health_degraded_alert_threshold_*`).",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "healthDegradedAlerts",
  },
  {
    // Task #1103 — booking schema readiness flipped `ready=true → false`
    // (e.g. a deploy where migrations 0034-0036 didn't run, the booking
    // tables were dropped, or the no-overlap / one-page-per-AM
    // constraints disappeared). A recovery message posts when readiness
    // flips back to true. Gated by the
    // `booking_schema_readiness_alert_enabled` system_settings kill
    // switch so it can be silenced without a deploy.
    id: "infra.booking.schema_unhealthy",
    category: "infra",
    label: "Booking schema unhealthy",
    description:
      "The cached `getBookingSchemaReadiness()` snapshot flipped `ready=true → false`. Lists the missing tables/constraints plus the operator action so on-call can jump straight to applying migrations 0034-0036. Posts a recovery message when readiness flips back.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "bookingSchemaReadinessAlerts",
  },
  {
    // Task #858 — direct-conversation merge skipped a duplicate group
    // because the duplicate rows link to different clientIds and an
    // automatic survivor pick would silently lose data.
    id: "infra.conversation_dedupe.client_conflict",
    category: "infra",
    label: "Conversation dedupe — client conflict skip",
    description:
      "`mergeDuplicateDirectConversations` (or any other caller of `mergeDirectConversationGroup`) skipped a duplicate-direct-thread group because the duplicates link to different clientIds. An operator must link the survivor to the correct client and rerun the merge.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "conversationDedupe",
  },
  {
    // Task #1009 — scheduler dispatched 0 jobs to a queue across N
    // consecutive ~60-cycle dispatch windows while the queue still
    // had pending depth (and wasn't paused via Queue Drain Control).
    id: "queue.scheduler.starved",
    category: "queue",
    label: "Queue starved across multiple dispatch windows",
    description:
      "The work scheduler has dispatched 0 jobs to this queue for the configured number of consecutive ~60-cycle windows while the queue had pending depth. A follow-up 'recovered' message is sent automatically once dispatches resume.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "queueStarvationAlerts",
  },
  {
    // Task #998 — paused queue's backlog keeps growing.
    id: "queue.drain_control.paused_backlog_growing",
    category: "queue",
    label: "Paused queue backlog growing",
    description:
      "A queue paused via the Queue Drain Control card has been paused for too long AND its pending count has grown past the configured threshold.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "queueDrainBacklogAlerts",
  },
  {
    // Task #1284 — Twilio inbound-webhook unique-SID collision spike.
    id: "infra.twilio_webhook.sid_collision_spike",
    category: "infra",
    label: "Twilio webhook — unique-SID collision spike",
    description:
      "Twilio inbound-webhook retries collided with the `twilio_msg_twilio_sid_uniq` partial unique index more times than the configured threshold within the rolling window. Normal Twilio retries are harmless, but a sustained spike usually means the webhook handler is too slow, signature verification regressed, or someone is replaying webhooks.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "twilioWebhookCollisionAlerts",
  },
  {
    // Task #4336 — SMS opt-out storm (spike of inbound STOP-family
    // keywords within the rolling window). Usually means an automated or
    // marketing send went out that shouldn't have, or webhook replay abuse.
    id: "infra.twilio_webhook.sms_optout_spike",
    category: "infra",
    label: "SMS consent — opt-out storm",
    description:
      "More STOP-family SMS opt-outs were recorded in the rolling window than the configured threshold. At this book size even a handful in an hour is a strong signal that an automated/marketing send misfired, a recipient list was texted without consent, or inbound webhooks are being replayed. Review /admin/sms-consent.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "smsOptOutStormAlerts",
  },
  {
    // Task #1602 — alert when no Front webhook event has landed in
    // `source_event_log` for longer than the configured threshold.
    // Catches upstream Front delivery stalls (the May-15 → May-18
    // outage was invisible until a manual SQL inspection).
    id: "pipeline.front_webhook.receiver_stale",
    category: "infra",
    label: "Front webhook — receiver staleness",
    description:
      "Fires when the most recent WEBHOOK-ORIGIN `source_event_log` row (`source_system='front'` AND `dedupe_key LIKE 'front:webhook:%'`) is older than the configured threshold (default 60 min) — reconcile-sweep rows no longer count as freshness (Task #3993). Also emits a distinct 'webhook never validated — polling carrying sync' alert (daily cooldown) when Front polling activity exists but not one webhook delivery has ever landed. Threshold and cooldowns live in `system_settings`.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontWebhookReceiverStalenessAlerts",
  },
  {
    // Task #1610 — sustained-breaker watcher for Slack auth. The breaker
    // itself (Task #1602) opens for 5 min on terminal auth errors; this
    // alert fires once per cooldown window when the breaker keeps tripping
    // long enough to require human intervention (e.g. revoked token).
    // Slack delivery is listed for symmetry but will record
    // `not_configured` while the breaker is open — the real delivery
    // channels for this alert are email + in-app.
    id: "pipeline.slack_auth.breaker_stuck",
    category: "infra",
    label: "Slack auth breaker stuck",
    description:
      "Slack has been failing terminal authentication checks long enough to require reconnecting the Slack integration. While the breaker is open, Slack delivery of this alert will record `not_configured` — the real delivery channels are email + in-app.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "slackAuthBreakerStuckAlerts",
  },
  {
    // Task #2733 — fires when Slack delivery has had no successful call for
    // a sustained window (default 60 min) even though the auth breaker has
    // NOT tripped. This covers the incident scenario where a Redis negative-
    // cache sentinel returned an empty token without ever making an API call,
    // so the breaker was never engaged but feedback was silently dropped.
    // Delivery channels: email + in-app (Slack itself may be unreachable).
    id: "pipeline.slack_delivery.dead",
    category: "infra",
    label: "Slack delivery dark (no auth-breaker trip)",
    description:
      "No successful Slack call has been recorded for the configured window, but the auth circuit breaker has not tripped. Likely cause: a transient credential-read miss (e.g. a Redis negative-cache sentinel) silently dropped delivery. Threshold lives in `slack_delivery_dead_alert_threshold_minutes` (default 60 min); cooldown reuses the breaker-stuck cooldown setting.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: false,
    implemented: true,
    ownerService: "slackAuthBreakerStuckAlerts",
  },
  {
    // Task #1610 — recovery counterpart. Fires exactly once after a
    // `pipeline.slack_auth.breaker_stuck` alert, once Slack has come
    // back (successful auth.test or other successful Slack call).
    id: "pipeline.slack_auth.breaker_recovered",
    category: "infra",
    label: "Slack auth recovered",
    description:
      "Slack authentication recovered after a sustained breaker-open period. Fires exactly once per stuck→recovered cycle.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "slackAuthBreakerStuckAlerts",
  },
  {
    // Task #2663 — sustained-breaker watcher for the Replit Auth session-
    // refresh path. The per-session breaker trips when a session's refresh
    // token family is terminally dead; this alert fires once per cooldown
    // window when terminal trips persist past the threshold without any
    // successful refresh in between — i.e. an issuer-wide auth outage rather
    // than a single operator who needs to re-login.
    id: "integration.replit_auth.breaker_stuck",
    category: "infra",
    label: "Replit Auth session-refresh breaker stuck",
    description:
      "Replit Auth session-refresh tokens have been failing terminally long enough to suggest an issuer-wide auth problem (no successful refresh across the configured streak). Threshold and cooldown live in `system_settings`.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "replitAuthBreakerStuckAlerts",
  },
  {
    // Task #2663 — recovery counterpart. Fires exactly once after a
    // `integration.replit_auth.breaker_stuck` alert, once any session refresh
    // succeeds again (the streak ends).
    id: "integration.replit_auth.breaker_recovered",
    category: "infra",
    label: "Replit Auth session-refresh recovered",
    description:
      "Replit Auth session-refresh recovered after a sustained breaker-open period. Fires exactly once per stuck→recovered cycle.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "replitAuthBreakerStuckAlerts",
  },
  {
    // Task #1689 — fires when the Front self-healing coverage loop
    // (Task #1682) has itself stopped running or keeps re-tripping on
    // its own `lastSelfError`. Lightweight, narrow counterpart to the
    // broader Task #1684 regression alerter, with explicit stuck →
    // recovered pairing modelled on `pipeline.slack_auth.breaker_stuck`
    // (Task #1610).
    id: "pipeline.front_auto_closure.loop_stalled",
    category: "infra",
    label: "Front auto-closure loop stalled",
    description:
      "The Front self-healing coverage loop (Task #1682) has not produced a fresh summary in longer than the configured threshold (default 30 min) or its `lastSelfError` has been non-null for the configured streak (default 3 consecutive ticks). Threshold, streak, and cooldown live in `system_settings`.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontAutoClosureStalledLoopAlerts",
  },
  {
    // Task #1689 — recovery counterpart. Fires exactly once after a
    // `pipeline.front_auto_closure.loop_stalled` alert, once the loop
    // is producing fresh, error-free summaries again.
    id: "pipeline.front_auto_closure.loop_recovered",
    category: "infra",
    label: "Front auto-closure loop recovered",
    description:
      "The Front self-healing coverage loop is producing fresh, error-free summaries again after a sustained stalled-loop alert. Fires exactly once per stuck→recovered cycle.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontAutoClosureStalledLoopAlerts",
  },
  {
    // Task #1642 — alert when rows in `front_sync_emails` have been
    // sitting in a non-terminal `pipeline_state` (anything other
    // than `applied`) for longer than the configured age threshold.
    // Catches silent apply-stage stalls (the May-18 17,805-row
    // backlog) before they show up as a flat coverage gap.
    id: "pipeline.front_sync_emails.stuck",
    category: "infra",
    label: "Front pipeline — stuck rows",
    description:
      "Fires when rows in `front_sync_emails` sit in a non-terminal `pipeline_state` longer than the configured age threshold (default 60 min). Catches apply-stage stalls — env kill switch (`PERF.FRONT_PIPELINE_APPLY_ENABLED`), paused `front_webhook_apply` queue, or a dead/wedged apply worker — before they show up as a lagging coverage-report gap. Threshold, min-count, and cooldown live in `system_settings`.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontPipelineStuckAlerts",
  },
  {
    // Task #2146 — fires when the `front_sync_emails` mirror stops
    // getting new rows (its `MAX(created_at)` falls behind live Front
    // webhook intake by more than the configured lag threshold) while
    // Front webhooks ARE still arriving — i.e. the mirror writer is
    // disabled (`front_sync_emails_mirror_enabled`) or broken. Catches
    // the next silent mirror freeze (the 2026-04-14 weeks-long stall
    // that nobody noticed until coverage drifted). Stays silent when no
    // fresh Front webhooks exist (a quiet period, or an upstream Front
    // delivery stall owned by `pipeline.front_webhook.receiver_stale`).
    id: "pipeline.front_sync_emails.mirror_frozen",
    category: "infra",
    label: "Front pipeline — mirror frozen",
    description:
      "Fires when `front_sync_emails`'s newest row (`MAX(created_at)`) lags live Front webhook intake (`source_event_log` for `source_system='front'`) by more than the configured lag threshold (default 180 min) while webhooks are still arriving — the mirror writer is disabled or broken. Distinguishes writer-disabled/broken from a genuinely quiet period (no fresh webhooks → silent). Lag threshold and cooldown live in `system_settings`.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "frontMirrorFreshnessAlerts",
  },
  {
    // Task #1676 — cross-queue lease churn spike. Fires when the count
    // of jobs terminating with `error_code IN
    // ('stale_lease_exhaustion','max_processing_exhaustion','startup_stale_recovery')`
    // over a rolling 1h window crosses the configured threshold.
    id: "queue.scheduler.lease_churn_spike",
    category: "queue",
    label: "Worker lease churn spike",
    description:
      "Cross-queue rate of `stale_lease_exhaustion` / `max_processing_exhaustion` / `startup_stale_recovery` job terminations exceeded the configured per-hour threshold. Typical causes: frequent deploys/restarts dropping in-flight leases, hung handlers exceeding max_processing, or a stale-lease sweeper fighting with still-alive workers. See WORKERS_QUEUES_RUNBOOK.md.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "leaseChurnAlerts",
  },
  {
    // Task #1676 — Front webhook normalize/apply backlog watchers.
    id: "queue.front_webhook.backlog",
    category: "queue",
    label: "Front webhook queue backlog",
    description:
      "`front_webhook_normalize` or `front_webhook_apply` pending count exceeded the configured threshold (default 1,000) for longer than the configured age window (default 60 min). Regression-guard for Task #1602.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "leaseChurnAlerts",
  },
  {
    // Task #1676 — raw_communication_records AI processing ratio inversion.
    id: "queue.raw_communications.processing_inverted",
    category: "queue",
    label: "Raw communications AI processing inverted",
    description:
      "`raw_communication_records` pending count for rows created in the last 30 days exceeds processed count (ratio inverted) for longer than the configured age window. Indicates the downstream classifier/handler has stopped draining new Front/Twilio records.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "leaseChurnAlerts",
  },
  {
    // Task #1676 — SEMrush refresh dead-letter spike.
    id: "queue.semrush_refresh.dead_letter_spike",
    category: "queue",
    label: "SEMrush refresh dead-letter spike",
    description:
      "Combined `semrush_report_refresh` + `semrush_background_refresh` dead-letter count grew by more than the configured delta within the rolling 1h window. Catches regressions of Tasks #897/#952/#953/#957/#1050 even after lease churn is suppressed.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "leaseChurnAlerts",
  },
  {
    // Task #1098 — call recordings stuck in `archive_status='processing'`
    // with their lease released past the call_archive ceiling.
    id: "queue.call_recording_archive.stuck_processing",
    category: "queue",
    label: "Call recording archive — stuck-processing rows",
    description:
      "Rows in `twilio_calls` with `archive_status='processing'` whose archive lease has been released for longer than the configurable threshold (default = call_archive ceiling). Mirrors the admin Stuck Background Jobs view; the next archive claim tick will reclaim these rows but a growing count is the symptom of a hung handler.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "callArchiveStuckProcessingAlerts",
  },
  {
    // Workers/queues parity (E-F12) — call-analysis jobs stuck in
    // `status='processing'` with their lease expired past the
    // call_analysis ceiling.
    id: "queue.call_analysis.stuck_processing",
    category: "queue",
    label: "Call analysis — stuck-processing jobs",
    description:
      "Rows in `call_analysis_jobs` with `status='processing'` whose lease (`locked_until`) has been expired for longer than the configurable threshold (default = call_analysis ceiling). Stale recovery normally requeues these within minutes; a growing count means the call-analysis workers or their recovery pass are not running.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "callAnalysisStuckProcessingAlerts",
  },
  {
    // Workers/queues parity (E-F15) — Local Dominance sync rows stuck in
    // `in_progress` past the local_dominance_sync ceiling.
    id: "queue.local_dominance_sync.stuck_rows",
    category: "queue",
    label: "Local Dominance sync — stuck in_progress rows",
    description:
      "Rows in `semrush_location_sync_state` with `status='in_progress'` whose `last_attempt_at` is older than the configurable threshold (default = local_dominance_sync ceiling, 4h). The worker's recovery sweep normally promotes these to failed/timeout; a growing count means the worker (and its recovery) is not running. Keeps alerting during an operator stop — stuck rows cannot self-heal while the worker is off. Fires once per stuck streak; a below-threshold observation re-arms it.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "localDominanceStuckSyncAlerts",
  },
  {
    // Workers/queues parity (E-F15) — Semrush auto-retry rows overdue
    // (due-for-retry but never picked up by the ticker).
    id: "queue.semrush_auto_retry.overdue_rows",
    category: "queue",
    label: "Semrush auto-retry — overdue rows not picked up",
    description:
      "Rows in `semrush_location_sync_state` with `status='failed'` whose `next_retry_at` has been overdue for longer than the configured threshold (default 60 min vs the ~30s tick). Means the auto-retry ticker is not running (scheduler wedged, cross-instance lock stuck) and failed locations have silently stopped retrying. Skipped while the auto_retry kill switch is on (overdue rows are then expected). Fires once per overdue streak; a below-threshold observation re-arms it.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "semrushAutoRetryOverdueAlerts",
  },

  // ──────────────── Category 4: Usage & Limits ────────────────
  {
    id: "usage.rate_limits.warning",
    category: "usage",
    label: "Rate-limit warning",
    description: "Per-user rate-limit warnings (preserves existing cadence/email side-effects).",
    defaultEnabled: true,
    defaultChannelSettingKey: "rate_limit_alert_slack_channel_id",
    supportsTest: true,
    implemented: true,
    ownerService: "rateLimitAlertNotifier",
  },
  {
    id: "usage.manual_reserve.starvation",
    category: "usage",
    label: "Manual-reserve starvation",
    description: "Backed-up / all-clear / muted manual-reserve health alerts.",
    defaultEnabled: true,
    // Falls back to the rate-limit alert channel when neither
    // notification_settings nor env override is set — preserves the
    // pre-Task-#994 behaviour of `loadAlertNotifyConfig`.
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    envOverrideKeys: ["HEALTH_ALERTS_SLACK_CHANNEL_ID"],
    supportsTest: true,
    implemented: true,
    ownerService: "manualReserveAlerts",
  },
  {
    // Task #711 — daily/weekly digest summarizing recent reserve-pressure
    // spikes (counts per metric × severity over the configured window).
    id: "usage.manual_reserve.digest",
    category: "usage",
    label: "Manual-reserve digest",
    description:
      "Daily/weekly Slack digest summarizing recent reserve-pressure spikes. Aggregates warning vs critical breach counts per manual-reserve metric from raw `health_samples.alerts` (so counts stay accurate even when live Slack delivery is muted, disconnected, or rate-limited by the per-(metric,severity) cooldown), with backed-up/all-clear transitions sourced from `manual_reserve_alert_dispatches`.",
    defaultEnabled: false,
    defaultChannelSettingKey: "manual_reserve_digest.channel",
    // Pre-#711: no settings; share the rate-limit alert channel as the
    // resolver's last-resort fallback (same chain the live alert uses).
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    envOverrideKeys: ["HEALTH_ALERTS_SLACK_CHANNEL_ID"],
    supportsTest: true,
    implemented: true,
    ownerService: "manualReserveDigest",
  },
  {
    // Task #780 — fired when the per-IP retention cap auto-trims rows
    // from the blocked-IP change-history table. Batched + cooldowned by
    // the alert service so a noisy IP can't flood the channel.
    id: "usage.blocked_ip_audit.trimmed",
    category: "usage",
    label: "Blocked-IP history auto-trimmed",
    description:
      "Out-of-band notification when the per-IP retention cap trims rows from the blocked-IP change-history table. Batched per `blocked_ip_trim_alert_batch_window_seconds` with a per-IP cooldown so a noisy IP cannot flood admins. Email recipients are configured separately via `blocked_ip_trim_alert_email`; opt out by clearing `blocked_ip_trim_alert_enabled`.",
    defaultEnabled: false,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "blockedIpTrimAlerts",
  },
  {
    id: "usage.openai.spend_or_tokens",
    category: "usage",
    label: "OpenAI spend / tokens",
    description: "Daily spend or token usage above threshold (placeholder).",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },

  // ──────────────── Category 5: Workflow Events ────────────────
  {
    // Task #4331 — a deal stage automation rule failed while executing
    // its actions (dealAutomationEngine records the failed run row, then
    // alerts here with a per-rule dedupeKey).
    id: "workflow.deal_automation.run_failed",
    category: "workflow",
    label: "Deal automation run failed",
    description:
      "A stage-automation rule failed while executing its actions for a deal (details in the rule's run history).",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "dealAutomationEngine",
  },
  {
    // Task #4332 — a native deal trigger hook (booking / PandaDoc / Front
    // reply) has failed repeatedly: ≥3 consecutive failed events for one
    // hook. Per-hook dedupeKey; details in the trigger run log.
    id: "workflow.deal_triggers.hook_failed",
    category: "workflow",
    label: "Deal trigger hook failing",
    description:
      "A native deal auto-move hook (booking, PandaDoc, or inbound-reply) failed several events in a row (details in the trigger run log).",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "dealTriggers",
  },
  {
    id: "workflow.match_settings.changed",
    category: "workflow",
    label: "Match-settings change",
    description: "Operator changed a matching threshold (preserves existing alert).",
    defaultEnabled: true,
    defaultChannelSettingKey: "match_settings_alert_slack_channel_id",
    envOverrideKeys: ["MATCH_SETTINGS_SLACK_CHANNEL_ID"],
    supportsTest: true,
    implemented: true,
    ownerService: "matchSettingsAlerts",
  },
  {
    id: "workflow.account_judgment.daily_summary",
    category: "workflow",
    label: "Account judgment daily summary",
    description: "Daily account judgment digest.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #3695 — fires when the daily going-quiet sweep NEWLY flags a
    // client (previous snapshot unflagged → today flagged): inbound volume
    // collapsed vs the client's own baseline and/or hard inbound silence.
    // Once per quiet streak (the durable snapshot transition is the gate),
    // re-armed via markRecovered when the client re-engages. Targeted
    // in-app rows go to the client owner + all director+ users
    // (skipAdminInAppMirror — no generic admin mirror). Kill switch:
    // `kill_switch_going_quiet_alert` ("false" disables; default ON).
    id: "workflow.client.going_quiet",
    category: "workflow",
    label: "Client going quiet",
    description:
      "A client's inbound communication dropped sharply against their own baseline or went silent — early disengagement warning from the daily going-quiet sweep. Owner + directors get one in-app alert per quiet streak.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "goingQuietAlert",
  },
  {
    // Task #3889 — fires when the daily going-quiet sweep detects that the
    // communication ingestion feed ITSELF is stale (newest ingested Front
    // inbound row lags Front's own conversation activity beyond the
    // configured threshold while clients are demonstrably active). The
    // sweep persists data-gap snapshots with flags + per-client
    // notifications suppressed, and this single pipeline alert replaces
    // what would otherwise be a fleet-wide false "clients went quiet"
    // fanout. Once per stale streak (durable system_settings gate,
    // re-armed by the first healthy sweep). Generic admin in-app mirror +
    // Slack. Deliberately independent of `kill_switch_going_quiet_alert`.
    id: "workflow.pipeline.going_quiet_feed_stale",
    category: "workflow",
    label: "Going-quiet feed stale (data gap)",
    description:
      "The communication ingestion feed fell behind Front's own conversation activity, so the going-quiet sweep suppressed client flags and wrote data-gap snapshots instead. One admin alert per stale streak.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "goingQuietAlert",
  },
  {
    // Task #3694 — Monday-morning cross-client digest of aging open asks
    // and unkept internal promises (Churn Command Center "Promises &
    // Asks" tab). Director+ users always get the targeted in-app rows
    // directly from the digest job (which sets skipAdminInAppMirror);
    // this registry entry governs the optional Slack/ops channel copy.
    id: "workflow.open_asks.weekly_digest",
    category: "workflow",
    label: "Aging asks & promises weekly digest",
    description:
      "Weekly summary of the oldest / highest-concern open client asks and internal promises across active clients.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: true,
    ownerService: "openAsksDigest",
  },
  {
    // Task #4334 — the outbound-email dispatch-claim ledger blocked a
    // second vendor call for a send that already went out (replayed job,
    // reclaimed lease, or concurrent attempt). The double-send was
    // PREVENTED; the alert exists so a systemic replay bug is noticed
    // instead of silently absorbed. Deduped per send row.
    id: "workflow.outbound_email.duplicate_send_attempt",
    category: "workflow",
    label: "Outbound email duplicate-send attempt",
    description:
      "A second dispatch attempt for an already-sent outbound email was blocked by the claim ledger. No duplicate was sent — investigate what replayed the job.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "outboundEmail",
  },
  {
    // Task #4334 — a client-facing send has an ambiguous vendor outcome
    // (timeout mid-flight or 5xx on a non-idempotent create). The row is
    // parked as `unknown` and NEVER auto-retried — retrying an ambiguous
    // send is how duplicates happen — so an operator must check the
    // mailbox/Front and re-send manually if it truly never left.
    id: "workflow.outbound_email.unknown_outcome",
    category: "workflow",
    label: "Outbound email unknown outcome",
    description:
      "An outbound client email ended with an ambiguous vendor outcome and was parked (not auto-retried). Verify in the sender mailbox or Front, then re-send manually if needed.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "outboundEmail",
  },
  {
    // Task #4335 — the sequence claim ledger refused a second send record
    // for a step that was already handled. No duplicate email went out;
    // the alert exists so a systemic replay/advance bug is investigated
    // instead of silently absorbed. Deduped per (enrollment, step).
    id: "workflow.email_sequences.duplicate_step_send",
    category: "workflow",
    label: "Email sequence duplicate-send attempt",
    description:
      "A second send attempt for an already-handled sequence step was blocked by the claim ledger. No duplicate was sent — investigate what replayed the step.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "emailSequences",
  },
  {
    // Task #4335 — a sequence step could not be rendered (template deleted
    // or a render exception). The enrollment holds at the step until an
    // operator rejects (skip) or cancels; without the alert it would just
    // sit there.
    id: "workflow.email_sequences.render_failed",
    category: "workflow",
    label: "Email sequence step render failed",
    description:
      "A sequence step failed to render its template. The enrollment is holding at this step — fix the template, then reject the queue item to skip or cancel the enrollment.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "emailSequences",
  },
  {
    id: "workflow.health.daily_digest",
    category: "workflow",
    label: "Health daily digest",
    description: "Daily Slack digest of system health (preserves existing digest).",
    defaultEnabled: false,
    defaultChannelSettingKey: "health.digest.channel",
    // Pre-#994 fallback: if `health.digest.channel` is unset, the digest
    // shared the rate-limit alert channel via loadAlertNotifyConfig().
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "healthSlackDigest",
  },
  {
    id: "workflow.ats.candidate_high_score",
    category: "workflow",
    label: "ATS — candidate high score",
    description: "Candidate score exceeds configured threshold.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },
  {
    id: "workflow.booking.changed",
    category: "workflow",
    label: "Booking changed",
    description: "Booking created, cancelled, or materially changed.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #2779 — Slack channel alert when a client texts. Fired from
    // the inbound-SMS webhook path (twilioService.handleInboundSms) via
    // `clientTextSlackAlert.ts`, which @-mentions the conversation
    // owners (thread assignee ∪ client account manager) using their
    // linked `user_slack_identities` row. The channel defaults to
    // `#client-texts` via the legacy setting key below (seeded
    // idempotently); an admin-saved Notifications Console row takes
    // precedence per the dispatcher's channel-resolution order.
    id: "workflow.client_sms.received",
    category: "workflow",
    label: "Client text received",
    description:
      "A client (or unknown number) texted a NoBull number. Posts to the configured Slack channel and @-mentions the conversation owners (thread assignee and/or client account manager).",
    defaultEnabled: true,
    defaultChannelSettingKey: "client_text_slack_channel_id",
    supportsTest: true,
    implemented: true,
    ownerService: "clientTextSlackAlert",
  },
  {
    id: "workflow.service_desk.waiting_on_fields_missing",
    category: "workflow",
    label: "Service Desk — waiting-on fields not saved",
    description:
      "A waiting-on status transition ran but the sd_list_mapping config is missing the waiting-on custom-field UUIDs " +
      "(fieldWaitingWhoId / fieldWaitingWhatId / fieldWaitingWhenId), so the who/what/when details were NOT written to ClickUp. " +
      "Fix via the Service Desk setup wizard at /admin/service-desk. Rate-limited to once per list per day. (Task #3175)",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "serviceDeskConfigAlert",
  },
  {
    id: "workflow.service_desk.config_fields_missing",
    category: "workflow",
    label: "Service Desk — mapped field write skipped",
    description:
      "A Service Desk action tried to write a mapped ClickUp custom field but the sd_list_mapping config is missing the " +
      "field UUID or option mapping (e.g. fieldDepartmentId or a departmentOptionIds entry), so the value was NOT written to ClickUp. " +
      "Fix via the Service Desk setup wizard at /admin/service-desk. Rate-limited to once per list per day. (Task #3227)",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "serviceDeskConfigAlert",
  },
  {
    id: "workflow.client_onboarding.milestone",
    category: "workflow",
    label: "Client onboarding milestone",
    description: "First report, first matched call, first campaign launch, etc.",
    defaultEnabled: false,
    supportsTest: true,
    implemented: false,
  },
  {
    // Task #3693 — fired by the 6am daily judgment cron when a client's
    // health degrades day-over-day (status slipped in the explicit
    // Healthy<Watch<At Risk<Critical ordering, or the 0-100 risk score
    // jumped past client_risk_shift_score_jump_threshold). Once per
    // degradation streak (dedupeKey client:<id>, markRecovered re-arms on
    // recovery); >=4 degradations in one run collapse into a single
    // bundled alert (dedupeKey bulk:<date>). The module owns its targeted
    // director+/owner in-app fan-out, so the generic admin mirror is
    // skipped. Kill switch: kill_switch_client_risk_shift_alert.
    id: "workflow.client_risk.shift_detected",
    category: "workflow",
    label: "Client risk shift detected",
    description:
      "A client's daily judgment degraded (status slipped or risk score jumped past the tunable threshold). Director+ users and the client's owner get the old→new status, headline, top concerns, and a client link; mass degradations in one run are bundled.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "clientRiskShiftAlert",
  },
  {
    // Task #3711 — fired by the daily offboarding sweep when a scheduled
    // offboarding reaches its final service day and the client is
    // auto-archived (dedupe-keyed per client). This is the Slack hook path
    // future offboarding steps will extend.
    id: "workflow.client_offboarding.completed",
    category: "workflow",
    label: "Client offboarding completed",
    description:
      "A scheduled offboarding reached its final day of service and the daily sweep auto-archived the client.",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "clientOffboardingSweep",
  },
  {
    id: "infra.front_coverage.denominator_floor_violated",
    category: "infra",
    label: "Front coverage denominator floor violated",
    description:
      "One or more message-grain months in front_analytics_coverage have a stored applied_into_nobull > front_total_messages, meaning the read-path floor is masking a bad write. Names the violating months so an operator can trigger a recompute.",
    defaultEnabled: true,
    legacySettingKeys: ["rate_limit_alert_slack_channel_id"],
    supportsTest: true,
    implemented: true,
    ownerService: "leaseChurnAlerts",
  },
  {
    // Task #4832 — alert the team when newly-seeded Ads OS criteria docs have
    // not been completed by an operator after 7 days. The schedule-sync prod
    // action (Task #4827) seeds minimal schedule-only docs; operators must
    // fill in business_name, service_area, etc. via the Edit Criteria UI.
    // Fires at most once per UTC calendar day while overdue docs remain.
    id: "workflow.ads_os.seeded_criteria_incomplete",
    category: "workflow",
    label: "Ads OS seeded criteria still incomplete",
    description:
      "One or more clients had a schedule-only criteria doc seeded by the schedule-sync prod action " +
      "but the operator has not filled in business_name or service_area after 7 days. " +
      "Open the Ads OS Edit Criteria panel for each listed client and save the required fields. " +
      "Fires at most once per UTC calendar day while overdue docs remain. (Task #4832)",
    defaultEnabled: true,
    supportsTest: false,
    implemented: true,
    ownerService: "adsOsSeededCriteriaIncompletenessAlerts",
  },
  {
    // Task #4789 — immediate 5xx alert for POST /api/feedback. The generic
    // requestMetricsAlerts evaluator requires ≥30 req/10-min window before
    // flagging a route; feedback sees ~2 req/day and is structurally invisible
    // to that check. One dedupeKey per UTC calendar day
    // (`feedback:submit:5xx:YYYY-MM-DD`) so the bell collapses same-day
    // repeats without a permanent forever-unread row.
    id: "infra.feedback.submit_failure",
    category: "infra",
    label: "Feedback submit server error",
    description:
      "POST /api/feedback threw in the route handler (5xx path). The row may or may not have been inserted — check server logs for `[Feedback] Error:` lines and verify user_feedback. One alert per UTC day; recovery is automatic (no health-state streak).",
    defaultEnabled: true,
    supportsTest: true,
    implemented: true,
    ownerService: "feedbackSubmitFailureAlert",
  },
];

const ID_INDEX = new Map<string, NotificationRegistryEntry>(
  NOTIFICATION_REGISTRY.map((e) => [e.id, e]),
);

export function getNotification(id: string): NotificationRegistryEntry | undefined {
  return ID_INDEX.get(id);
}

export function listNotifications(): NotificationRegistryEntry[] {
  return [...NOTIFICATION_REGISTRY];
}

export function listNotificationsByCategory(): Array<{
  category: NotificationCategoryMeta;
  notifications: NotificationRegistryEntry[];
}> {
  return NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    notifications: NOTIFICATION_REGISTRY.filter((n) => n.category === category.id),
  }));
}

/** Compile-time uniqueness check: throw at module load if any id is repeated. */
(() => {
  const seen = new Set<string>();
  for (const e of NOTIFICATION_REGISTRY) {
    if (seen.has(e.id)) {
      throw new Error(`[notifications/registry] duplicate notification id: ${e.id}`);
    }
    seen.add(e.id);
  }
})();
