/**
 * DB Pool Stability Epic — kill-switch STATE (dependency-free leaf).
 *
 * Task #3947 — this module breaks the boot-time runtime module cycle
 *
 *   poolEpicKillSwitches → storage → storage/settingsStorage
 *     → services/cache/redisCache → poolEpicKillSwitches ↩
 *
 * It holds the parts of the pool-epic kill-switch surface that low-level
 * infrastructure (the Redis cache) is allowed to consume: the switch
 * name registry, the hard-coded defaults, the in-memory override state,
 * and the synchronous read. This file imports NOTHING, so pulling it
 * into an infrastructure module can never drag the storage aggregator or
 * a feature service into that module's boot-time ring.
 *
 * ── Design decision (Task #3947, step 2 — recorded per spec) ─────────
 * Option A (CHOSEN): extract the in-memory switch state + sync read into
 * this leaf. The DB-backed loader (`./poolEpicKillSwitches.ts`) keeps
 * its `storage` import for the two settings operations
 * (`getSystemSettings` / `setSystemSetting`), mutates this state through
 * the narrow writers below, and registers its background-refresh trigger
 * here AT ITS OWN MODULE-INIT TIME. The cache imports only this leaf.
 * ESM evaluates a module before any importer's code runs, so the trigger
 * is registered before any caller can use the public kill-switch
 * surface — one-way dependencies, no initialization-order race, and no
 * per-test manual wiring (importing `poolEpicKillSwitches`, which every
 * existing consumer and test already does, wires the boundary as a side
 * effect).
 *
 * Option B (REJECTED): drop the `redisCache → poolEpicKillSwitches`
 * import and have boot code register a cache-gate predicate into the
 * cache module. Rejected because switch seeding/loading runs via dynamic
 * import in `boot/workersAndCleanup.ts` AFTER early settings reads, so
 * the gate would have an unregistered boot window (cache behavior would
 * depend on registration order), and every test exercising the active
 * cache path would need manual gate wiring.
 *
 * Boundary consequence, by design: if a process never evaluates the
 * loader module (today the server, workers, scripts, and tests all do),
 * reads here serve the hard-coded defaults plus any in-memory overrides,
 * and no background DB refresh fires — this leaf can never reach the DB
 * itself. That is the fail-open direction: `redis_cache_enabled`
 * defaults OFF ⇒ cache bypassed ⇒ readers go straight to the DB.
 */

export type PoolEpicSwitchName =
  | "db_pool_tenancy_enforcement_enabled"
  | "notify_user_optimized_path_enabled"
  | "semrush_persistent_enrichment_cache_enabled"
  | "semrush_no_external_calls_inside_db_hold_enabled"
  | "front_recovery_pool_threshold_tuning_enabled"
  | "external_call_audit_enabled"
  | "db_hold_rollup_enabled"
  // Task #1787 (Stage 5/6) — Front Stabilization Epic rollback switches.
  // Registered here so operators have a single, hot-flippable surface;
  // wiring inside `frontHistoricalRecovery.ts` reads via
  // `isPoolEpicSwitchEnabled(...)`. Default ON because the intended
  // steady state is ON after deploy verification; flip to false to
  // restore legacy behavior without a redeploy.
  | "front_recovery_same_response_suppression_enabled"
  | "front_recovery_active_inbox_filter_enabled"
  // Task #1886 — Switch sparse single-month recovery windows from
  // Front's `/conversations?sort_by=date` enumeration (which puts every
  // bumped old conv at the head of the list and exhausts the 500-page
  // safety cap before reaching the genuinely-missing tail) to the
  // `/conversations/search/<query>` endpoint with `after:/before:`
  // filters, which orders strictly by message timestamp within the
  // window and does not surface already-seen bumped convs. Default ON
  // because this is the intended steady state — flip to false to
  // restore the legacy enumeration-only behavior without a redeploy.
  // Reading site: `buildInitialPath` in
  // `server/services/frontHistoricalRecovery.ts`.
  | "front_recovery_sparse_month_search_strategy_enabled"
  // Task #1963 — gate for `resetStuckRecoveryCheckpoints`. When ON
  // (default), the CEO prod action `reset_stuck_front_recovery_checkpoints`
  // and any future scheduled call to that helper are allowed to clear
  // `lastPageUrl` / `scanned` / `skipped` / `pages` on per-window
  // checkpoints whose status='partial', statusReason starts with
  // `safety_max_pages_reached`, and lastPageUrl matches the legacy
  // `/conversations?` enumeration. Flip OFF to halt resets without
  // un-registering the prod action.
  | "front_recovery_checkpoint_reset_enabled"
  // Task #1963 — gate for per-message materialization inside
  // `normalizeReconciliationEvent`. When ON, every `historical_recovery`
  // source_event hydrates the full message list and inserts one
  // `raw_communication_records` row per `msg_*` id. Dedupe is
  // best-effort via a lookup on `external_source_id` before each
  // insert (there is no unique constraint on that column, so a true
  // ON CONFLICT path is not available — a concurrent duplicate would
  // produce two rows, which is acceptable given the historical-evidence
  // role of these rows). Rows are written at processingStatus='processed'
  // so they do not re-enter the classifier queue. Default OFF so the
  // deploy is behavior-neutral; flip ON after the reset step has
  // populated some search-strategy pages and a sample shows the
  // conversation envelopes are landing as expected.
  | "front_recovery_per_message_materialization_enabled"
  // Task #3889 — hydrate reconciliation-poller conversation envelopes with
  // the conversation's real messages. Front's `GET /conversations` list API
  // returns NO `last_message` payload, so without hydration every
  // reconciliation envelope falls through to direction='internal' and the
  // per-message truth (inbound/outbound rows powering Going Quiet, daily
  // judgment, coverage) only ever arrives via month-scoped backfill
  // drivers. When ON, `normalizeReconciliationEvent` fetches the
  // conversation's messages once per new conversation version (cached by
  // version key in front_hydrate_snapshots), stamps the envelope's
  // direction/timestamp/message id from the real latest message, and
  // materializes per-message rows through the same dedupe-safe write path
  // the backfill drivers use (~500 conversations/day → trivial API cost).
  // Breaker-aware: skipped entirely while the Front auth-dead breaker is
  // open. Default ON — this IS the fix for the false-inbound-zero
  // regression; flip OFF only to shed Front API load in an emergency.
  | "front_reconciliation_per_message_materialization_enabled"
  // Task #2602 — gate for the materialized-Front-message AI study driver
  // (`server/services/frontMaterializedMessageStudy.ts`). The per-message
  // materialization path (above) writes historical message rows at
  // processingStatus='processed' with NO clientId, so they never enter the
  // classifier queue and are never studied into agent_knowledge_base. When
  // this switch is ON, the `study_materialized_front_messages` prod-action
  // (and its self-heal cadence) resolves each materialized message to a
  // client via the deterministic hard-match index and enqueues an
  // `analyze_communication` job so it is AI-studied. Default OFF because
  // studying ~100% of historical Front messages through GPT-4o is real,
  // unbounded OpenAI spend — opt-in only, matching every other heavy Front
  // driver. Unmatched messages are stamped terminal (no client KB target,
  // no AI burn). Reading site: `frontMaterializedMessageStudy.ts`.
  | "front_materialized_message_study_enabled"
  // DB Scale Layer epic (`.local/tasks/db-scale-layer-redis-pgbouncer.md`).
  // Default OFF so the Redis foundation ships dark; flip via the
  // `enable_redis_cache_globally` CEO action once the Upstash REST URL +
  // token env vars are in place. Reading site:
  // `server/services/cache/redisCache.ts` (runtime gate; flip is hot,
  // no restart needed — the cache reads this leaf's sync read, which
  // kicks the loader's background refresh when state goes stale).
  // PgBouncer cutover is intentionally NOT a kill switch — it's gated
  // on the presence of `DATABASE_URL_POOLED` at boot in `server/db.ts`,
  // because pool wiring is locked at module load and a live pool's
  // connection string can't be hot-swapped.
  | "redis_cache_enabled"
  // Task #1829 — Front pipeline warp-speed throughput epic. Master
  // switch is OFF by default so the deploy is behavior-neutral: the
  // dedicated `front_ingestion` workload class, the fast-poll
  // multi-dispatch timer, and the Front-queue enqueue remap all stay
  // dormant until the operator flips this switch. The two
  // `front_ingestion_*_guard_enabled` switches are inner safety
  // tripwires (API-pool waiter backoff, Front 429 rate-limit pacing)
  // that protect the worker pool when warp speed is ON — both default
  // ON so flipping the master switch on does not also unlock unsafe
  // behavior. See `server/services/frontWarpSettings.ts` for the
  // numeric knobs (concurrency, manual reserve, poll interval,
  // per-cycle dispatch max, idle workers min).
  | "front_warp_speed_enabled"
  | "front_ingestion_api_waiter_backoff_enabled"
  | "front_ingestion_front_rate_limit_guard_enabled"
  // Task #1831 — webhook-stage mirror back into `front_sync_emails`.
  // Default ON: the table froze on 2026-04-14 when the on-demand
  // `syncFrontEmails` writer was decommissioned, leaving every
  // downstream reader (frontPipelineMetrics,
  // frontAutoClosure, frontPipelineStuckAlerts, frontBulkActions,
  // healthDegradedTracker, frontAnalyticsCoverage, routes, etc.)
  // with a stale picture. Flip to false to disable the mirror without
  // a redeploy if the upsert ever pressures the worker pool.
  // Reading sites: `server/services/frontSyncEmailMirror.ts`.
  | "front_sync_emails_mirror_enabled"
  // Task #1850 — Two previously ungated periodic / on-demand workers.
  // Both default ON (existing behavior). Operators can flip either to
  // false via `system_settings` to halt the worker without a deploy.
  // Reading sites:
  //   `server/services/healthRollups.ts` (gates rollup + prune ticks)
  //   `server/services/dbServerMetrics.ts` (gates all four metric fetchers)
  | "health_rollups_enabled"
  | "db_server_metrics_enabled";

export const POOL_EPIC_SWITCH_NAMES: PoolEpicSwitchName[] = [
  "db_pool_tenancy_enforcement_enabled",
  "notify_user_optimized_path_enabled",
  "semrush_persistent_enrichment_cache_enabled",
  "semrush_no_external_calls_inside_db_hold_enabled",
  "front_recovery_pool_threshold_tuning_enabled",
  "external_call_audit_enabled",
  "db_hold_rollup_enabled",
  "front_recovery_same_response_suppression_enabled",
  "front_recovery_active_inbox_filter_enabled",
  "front_recovery_sparse_month_search_strategy_enabled",
  "front_recovery_checkpoint_reset_enabled",
  "front_recovery_per_message_materialization_enabled",
  "front_reconciliation_per_message_materialization_enabled",
  "front_materialized_message_study_enabled",
  "redis_cache_enabled",
  "front_warp_speed_enabled",
  "front_ingestion_api_waiter_backoff_enabled",
  "front_ingestion_front_rate_limit_guard_enabled",
  "front_sync_emails_mirror_enabled",
  "health_rollups_enabled",
  "db_server_metrics_enabled",
];

export const POOL_EPIC_SWITCH_DEFAULTS: Record<PoolEpicSwitchName, boolean> = {
  db_pool_tenancy_enforcement_enabled: false,
  notify_user_optimized_path_enabled: true,
  semrush_persistent_enrichment_cache_enabled: false,
  semrush_no_external_calls_inside_db_hold_enabled: false,
  front_recovery_pool_threshold_tuning_enabled: false,
  external_call_audit_enabled: false,
  db_hold_rollup_enabled: false,
  front_recovery_same_response_suppression_enabled: true,
  front_recovery_active_inbox_filter_enabled: true,
  front_recovery_sparse_month_search_strategy_enabled: true,
  front_recovery_checkpoint_reset_enabled: true,
  front_recovery_per_message_materialization_enabled: false,
  front_reconciliation_per_message_materialization_enabled: true,
  front_materialized_message_study_enabled: false,
  redis_cache_enabled: false,
  front_warp_speed_enabled: false,
  front_ingestion_api_waiter_backoff_enabled: true,
  front_ingestion_front_rate_limit_guard_enabled: true,
  front_sync_emails_mirror_enabled: true,
  health_rollups_enabled: true,
  db_server_metrics_enabled: true,
};

const overrides = new Map<PoolEpicSwitchName, boolean>();
let loaded = false;
let loadedAt = 0;

// Cache TTL — refresh from `system_settings` at most once per
// `OVERRIDE_REFRESH_MS` so out-of-process flips (made by another
// instance or by direct SQL during an incident) propagate without
// requiring a restart. In-process flips via `setPoolEpicSwitch()`
// remain immediately effective because they update both the in-memory
// map and the row in the same call.
const OVERRIDE_REFRESH_MS = 60_000;

// Background-refresh trigger, registered by `./poolEpicKillSwitches.ts`
// at its module-init time (see the design note in this file's header).
// The trigger must be fire-and-forget and must never throw; the loader
// deduplicates concurrent invocations internally, so calling it while a
// load is already in flight is a no-op.
let refreshTrigger: (() => void) | null = null;

export function registerPoolEpicSwitchRefreshTrigger(
  trigger: (() => void) | null,
): void {
  refreshTrigger = trigger;
}

export function parsePoolEpicSwitchValue(
  raw: string | undefined,
): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return undefined;
}

function envOverride(name: PoolEpicSwitchName): boolean | undefined {
  // Only `notify_user_optimized_path_enabled` honors a legacy env
  // override: `NOTIFY_USER_OPTIMIZED_PATH_DISABLED=true` forces the
  // effective value to `false` so the env-based rollback path
  // `userInbox.ts` documents keeps working until that path is removed
  // in a later phase. All other switches are settings-only.
  if (name === "notify_user_optimized_path_enabled") {
    if (process.env.NOTIFY_USER_OPTIMIZED_PATH_DISABLED === "true") return false;
  }
  return undefined;
}

function maybeBackgroundRefresh(): void {
  if (!refreshTrigger) return;
  if (!loaded || Date.now() - loadedAt >= OVERRIDE_REFRESH_MS) {
    refreshTrigger();
  }
}

export function isPoolEpicSwitchEnabled(name: PoolEpicSwitchName): boolean {
  maybeBackgroundRefresh();
  const env = envOverride(name);
  if (env !== undefined) return env;
  const override = overrides.get(name);
  return override ?? POOL_EPIC_SWITCH_DEFAULTS[name];
}

/**
 * Wholesale-replace the override map from a completed settings load, so
 * a row deleted out-of-process reverts to its hard-coded default on the
 * next refresh. Marks the state fresh. Called only by the loader on a
 * SUCCESSFUL load — a failed load must leave the previous state (and
 * therefore the fail-open defaults) untouched.
 */
export function replacePoolEpicSwitchOverrides(
  next: ReadonlyMap<PoolEpicSwitchName, boolean>,
): void {
  overrides.clear();
  for (const [name, value] of next) overrides.set(name, value);
  loaded = true;
  loadedAt = Date.now();
}

/** In-memory half of `setPoolEpicSwitch` — immediate in-process effect. */
export function setPoolEpicSwitchOverrideInMemory(
  name: PoolEpicSwitchName,
  value: boolean,
): void {
  overrides.set(name, value);
}

/** Force the next sync read to kick a background reload (post-seed). */
export function markPoolEpicSwitchOverridesStale(): void {
  loaded = false;
  loadedAt = 0;
}

export function arePoolEpicSwitchOverridesFresh(): boolean {
  return loaded && Date.now() - loadedAt < OVERRIDE_REFRESH_MS;
}

/**
 * Synchronous snapshot of the current in-memory state. The loader wraps
 * this with `ensurePoolEpicSwitchesLoaded()` for the public async
 * snapshot endpoint.
 */
export function getPoolEpicSwitchStateSnapshot(): Record<
  PoolEpicSwitchName,
  { effective: boolean; default: boolean; overridden: boolean; envForced: boolean }
> {
  const out = {} as Record<
    PoolEpicSwitchName,
    { effective: boolean; default: boolean; overridden: boolean; envForced: boolean }
  >;
  for (const name of POOL_EPIC_SWITCH_NAMES) {
    const def = POOL_EPIC_SWITCH_DEFAULTS[name];
    const override = overrides.get(name);
    const env = envOverride(name);
    out[name] = {
      effective: env ?? override ?? def,
      default: def,
      overridden: override !== undefined,
      envForced: env !== undefined,
    };
  }
  return out;
}

// Test seam: clears the in-memory state so unit tests can simulate a
// fresh process. Deliberately does NOT unregister the refresh trigger —
// registration happens once at loader module-init and tests rely on the
// production wiring staying intact across resets. Not exported through
// any public registry; the loader's `__resetPoolEpicSwitchesForTest`
// wraps this and additionally clears its in-flight load promise.
export function __resetPoolEpicSwitchStateForTest(): void {
  overrides.clear();
  loaded = false;
  loadedAt = 0;
}
