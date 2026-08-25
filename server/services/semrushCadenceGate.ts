/**
 * Task #1785 — SEMrush demand-driven cadence gate.
 *
 * Owns the demand-driven refresh decision: should this campaign /
 * client be enqueued for a SEMrush refresh right now?
 *
 * Two gates must pass before enqueue:
 *   1. **Stale gate** — last cached data is older than the configured
 *      staleness threshold.
 *   2. **Active gate** — the client was viewed within the configured
 *      active-client window.
 *
 * Skips are recorded as a daily rollup in `semrush_cadence_skip_log`
 * (one row per (date, queue, reason) — never per-skip rows).
 *
 * Identical-result suppression: a stable hash of the refresh response
 * is compared against `semrush_last_applied_hashes`. If identical, the
 * heatmap-apply enqueue is skipped (and logged as
 * `skipped_identical_result`). Independent of the
 * `external_call_audit_enabled` feature flag.
 *
 * Pool tenancy: writes go through `workerDb` (background context).
 */
import { workerDb, withDbHoldLabel } from "../db";
import { sql } from "drizzle-orm";
import { PERF } from "../perfConfig";
import { storage } from "../storage";
import { isKillSwitchEnabled } from "./killSwitches";
import { isQueuePaused } from "./queueDrainControl";
import { workerLog } from "./workerLogger";
import { clients } from "@shared/schema";
import { eq, and, gte, sql as dsql } from "drizzle-orm";
import { createHash } from "crypto";
import { bindArrayParam } from "../utils/sqlArray";
import type { SemrushCadenceSkipReason } from "@shared/schema";

// ── Settings ──

const SETTING_KEYS = {
  intervalMs: "semrush_background_refresh_interval_ms",
  stalenessHours: "semrush_refresh_staleness_threshold_hours",
  activeWindowDays: "semrush_active_client_window_days",
} as const;

export interface CadenceSettings {
  demandDrivenEnabled: boolean;
  autoRetryBackoffEnabled: boolean;
  identicalResultSuppressionEnabled: boolean;
  intervalMs: number;
  stalenessThresholdHours: number;
  activeWindowDays: number;
}

let cachedSettings: { value: CadenceSettings; loadedAt: number } | null = null;
const SETTING_CACHE_TTL_MS = 30_000;

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Live cadence settings. Reads `system_settings` once per 30 s window
 * so the hot-path gate doesn't pay a DB round-trip on every campaign
 * but a setting flip still takes effect within seconds — operators do
 * not need a redeploy.
 */
export async function getCadenceSettings(): Promise<CadenceSettings> {
  if (cachedSettings && Date.now() - cachedSettings.loadedAt < SETTING_CACHE_TTL_MS) {
    return cachedSettings.value;
  }
  let rows: Record<string, string> = {};
  try {
    rows = await withDbHoldLabel("worker:semrush_cadence_gate:load_settings", () =>
      storage.getSystemSettings(Object.values(SETTING_KEYS)),
    );
  } catch (err: any) {
    console.warn(`[SemrushCadence] Failed to load settings (using defaults): ${err?.message}`);
  }
  const value: CadenceSettings = {
    demandDrivenEnabled: isKillSwitchEnabled("semrush_demand_driven_refresh"),
    autoRetryBackoffEnabled: isKillSwitchEnabled("semrush_auto_retry_backoff"),
    identicalResultSuppressionEnabled: isKillSwitchEnabled(
      "semrush_identical_result_apply_suppression",
    ),
    intervalMs: parseNumber(
      rows[SETTING_KEYS.intervalMs],
      PERF.SEMRUSH_BACKGROUND_REFRESH_INTERVAL_MS,
    ),
    stalenessThresholdHours: parseNumber(
      rows[SETTING_KEYS.stalenessHours],
      PERF.SEMRUSH_REFRESH_STALENESS_THRESHOLD_HOURS,
    ),
    activeWindowDays: parseNumber(
      rows[SETTING_KEYS.activeWindowDays],
      PERF.SEMRUSH_ACTIVE_CLIENT_WINDOW_DAYS,
    ),
  };
  cachedSettings = { value, loadedAt: Date.now() };
  return value;
}

/** Test/diagnostic helper — force the next read to hit `system_settings`. */
export function _resetCadenceSettingsCache(): void {
  cachedSettings = null;
}

/**
 * Synchronous peek at the cached interval. Returns `null` if no
 * settings load has completed yet. Used by `semrushApi.ts` to keep its
 * bucket math synchronous while still picking up live setting updates
 * within `SETTING_CACHE_TTL_MS` of the previous async load.
 */
export function _peekCachedIntervalMs(): number | null {
  return cachedSettings?.value.intervalMs ?? null;
}

// ── Skip-log daily rollup ──

const skipBuffer = new Map<string, { count: number; clients: Set<string>; campaigns: Set<string> }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 5_000;

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function bucketKey(date: string, queueName: string, reason: SemrushCadenceSkipReason): string {
  return `${date}::${queueName}::${reason}`;
}

/**
 * Record one skip / enqueue decision. Buffered in-memory and flushed in
 * batches so a high-rate skip storm doesn't fan out into per-row writes
 * on the worker pool.
 */
export function recordCadenceDecision(opts: {
  queueName: string;
  reason: SemrushCadenceSkipReason;
  clientId?: string | null;
  campaignId?: string | null;
}): void {
  const date = todayUtc();
  const key = bucketKey(date, opts.queueName, opts.reason);
  let entry = skipBuffer.get(key);
  if (!entry) {
    entry = { count: 0, clients: new Set(), campaigns: new Set() };
    skipBuffer.set(key, entry);
  }
  entry.count++;
  if (opts.clientId) entry.clients.add(opts.clientId);
  if (opts.campaignId) entry.campaigns.add(opts.campaignId);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushSkipBuffer().catch((e) =>
        console.warn(`[SemrushCadence] flushSkipBuffer failed: ${e?.message}`),
      );
    }, FLUSH_DEBOUNCE_MS);
    if ((flushTimer as any).unref) (flushTimer as any).unref();
  }
}

export async function flushSkipBuffer(): Promise<number> {
  if (skipBuffer.size === 0) return 0;
  const entries = Array.from(skipBuffer.entries());
  skipBuffer.clear();
  let wrote = 0;
  await withDbHoldLabel("worker:semrush_cadence_gate:flush_skip_log", async () => {
    for (const [key, value] of entries) {
      const [date, queueName, reason] = key.split("::");
      try {
        await workerDb.execute(sql`
          INSERT INTO semrush_cadence_skip_log
            (date, queue_name, reason, count, client_count, campaign_count, updated_at)
          VALUES (
            ${date}::date,
            ${queueName},
            ${reason},
            ${value.count},
            ${value.clients.size},
            ${value.campaigns.size},
            NOW()
          )
          ON CONFLICT (date, queue_name, reason) DO UPDATE
          SET count = semrush_cadence_skip_log.count + EXCLUDED.count,
              client_count = GREATEST(semrush_cadence_skip_log.client_count, EXCLUDED.client_count),
              campaign_count = GREATEST(semrush_cadence_skip_log.campaign_count, EXCLUDED.campaign_count),
              updated_at = NOW()
        `);
        wrote++;
      } catch (err: any) {
        console.warn(`[SemrushCadence] skip-log upsert failed for ${key}: ${err?.message}`);
      }
    }
  });
  return wrote;
}

/** Drop any skip-log rollups older than 90 days. Called by the maintenance sweep. */
export async function pruneSkipLog(maxAgeDays = 90): Promise<number> {
  const days = Math.max(1, Math.floor(maxAgeDays));
  const res = await workerDb.execute<{ id: string }>(sql`
    DELETE FROM semrush_cadence_skip_log
    WHERE date < (NOW()::date - ${days})
    RETURNING id
  `);
  return res.rows.length;
}

// ── Active-client signal ──

/**
 * Bump `clients.last_viewed_at`. Called from heatmap / GBP / report
 * view routes. Best-effort, never throws — view rendering must not
 * fail because the signal write failed.
 */
export async function markClientViewed(clientId: string, source: string): Promise<void> {
  if (!clientId) return;
  try {
    await withDbHoldLabel("worker:semrush_cadence_gate:mark_viewed", async () => {
      await workerDb
        .update(clients)
        .set({ lastViewedAt: new Date() })
        .where(eq(clients.id, clientId));
    });
  } catch (err: any) {
    // Best-effort; view routes don't fail just because we couldn't bump.
    console.warn(`[SemrushCadence] markClientViewed(${clientId}, ${source}) failed: ${err?.message}`);
  }
}

export async function isClientActive(clientId: string, settings?: CadenceSettings): Promise<boolean> {
  if (!clientId) return false;
  const s = settings ?? (await getCadenceSettings());
  const cutoff = new Date(Date.now() - s.activeWindowDays * 24 * 60 * 60 * 1000);
  const rows = await withDbHoldLabel("worker:semrush_cadence_gate:check_active", async () =>
    workerDb
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, clientId), gte(clients.lastViewedAt, cutoff)))
      .limit(1),
  );
  return rows.length > 0;
}

/** Tenant-wide check: is any client active inside the window? */
export async function anyClientActiveInWindow(settings?: CadenceSettings): Promise<boolean> {
  const s = settings ?? (await getCadenceSettings());
  const cutoff = new Date(Date.now() - s.activeWindowDays * 24 * 60 * 60 * 1000);
  const rows = await withDbHoldLabel(
    "worker:semrush_cadence_gate:any_active",
    async () =>
      workerDb.execute<{ exists: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM clients
          WHERE last_viewed_at IS NOT NULL AND last_viewed_at >= ${cutoff}
        ) AS exists
      `),
  );
  return rows.rows[0]?.exists === true;
}

/** Batched active check for the inventory-sync candidate loop. */
export async function listActiveClientIds(
  candidateClientIds: string[],
  settings?: CadenceSettings,
): Promise<Set<string>> {
  if (candidateClientIds.length === 0) return new Set();
  const s = settings ?? (await getCadenceSettings());
  const cutoff = new Date(Date.now() - s.activeWindowDays * 24 * 60 * 60 * 1000);
  const rows = await withDbHoldLabel("worker:semrush_cadence_gate:list_active", async () =>
    workerDb.execute<{ id: string }>(sql`
      SELECT id FROM clients
      WHERE id = ANY(${bindArrayParam(candidateClientIds, "text")})
        AND last_viewed_at IS NOT NULL
        AND last_viewed_at >= ${cutoff}
    `),
  );
  const out = new Set<string>();
  for (const r of rows.rows) out.add(r.id);
  return out;
}

// ── Campaign → client + last-applied lookups (used by inventory-sync gate) ──

/**
 * Batched campaign → client lookup via `semrush_location_campaigns`.
 * A single SEMrush campaign can technically appear under multiple
 * client mappings; we return the first one (deterministic by client_id)
 * which is sufficient for the active-client gate decision.
 */
export async function resolveClientIdForCampaign(
  campaignIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (campaignIds.length === 0) return out;
  // Primary: canonical per-location mapping table.
  const rows = await withDbHoldLabel(
    "worker:semrush_cadence_gate:resolve_client_for_campaign",
    async () =>
      workerDb.execute<{ semrush_campaign_id: string; client_id: string }>(sql`
        SELECT DISTINCT ON (semrush_campaign_id)
               semrush_campaign_id, client_id
        FROM semrush_location_campaigns
        WHERE semrush_campaign_id = ANY(${bindArrayParam(campaignIds, "text")})
        ORDER BY semrush_campaign_id, client_id
      `),
  );
  for (const r of rows.rows) out.set(r.semrush_campaign_id, r.client_id);
  // Task #1785 review-remediation: legacy fallback. Some clients are
  // still on the original `client_semrush_integrations` single-campaign
  // mapping and have no row in `semrush_location_campaigns` yet. Fall
  // back to that table for any campaignId still unresolved so the
  // gate doesn't classify legacy-but-active clients as
  // `skipped_missing_mapping`. This is read-only and does not change
  // SEMrush mapping write policy.
  const unresolved = campaignIds.filter((c) => !out.has(c));
  if (unresolved.length > 0) {
    const legacyRows = await withDbHoldLabel(
      "worker:semrush_cadence_gate:resolve_client_for_campaign_legacy",
      async () =>
        workerDb.execute<{ semrush_campaign_id: string; client_id: string }>(sql`
          SELECT DISTINCT ON (semrush_campaign_id)
                 semrush_campaign_id, client_id
          FROM client_semrush_integrations
          WHERE semrush_campaign_id IS NOT NULL
            AND semrush_campaign_id = ANY(${bindArrayParam(unresolved, "text")})
            AND integration_enabled = true
            AND is_active = true
          ORDER BY semrush_campaign_id, client_id
        `),
    );
    for (const r of legacyRows.rows) {
      if (!out.has(r.semrush_campaign_id)) {
        out.set(r.semrush_campaign_id, r.client_id);
      }
    }
  }
  return out;
}

/**
 * Batched campaign → most recent applied-at timestamp, sourced from
 * `semrush_last_applied_hashes`. Used as the `lastRefreshedAt` input
 * for the staleness gate when enqueuing inventory-diff refreshes.
 */
export async function lastAppliedAtForCampaign(
  campaignIds: string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (campaignIds.length === 0) return out;
  const rows = await withDbHoldLabel(
    "worker:semrush_cadence_gate:last_applied_for_campaign",
    async () =>
      workerDb.execute<{ campaign_id: string; max_applied: Date }>(sql`
        SELECT campaign_id, MAX(applied_at) AS max_applied
        FROM semrush_last_applied_hashes
        WHERE campaign_id = ANY(${bindArrayParam(campaignIds, "text")})
        GROUP BY campaign_id
      `),
  );
  for (const r of rows.rows) {
    if (r.max_applied) out.set(r.campaign_id, new Date(r.max_applied as any));
  }
  return out;
}

// ── Demand-driven gate decision ──

export interface GateInput {
  queueName: string;
  clientId?: string | null;
  campaignId?: string | null;
  /** When the cached data was last refreshed/applied. `null` = never (always stale). */
  lastRefreshedAt?: Date | null;
  /**
   * Tenant-wide caller (e.g. campaign-list cache refresh). When TRUE the
   * gate replaces the per-client active check with an "any active client
   * exists in window" check — without this flag a tenant-wide caller
   * with no campaign/no client would silently bypass the active gate.
   */
  tenantWide?: boolean;
}

export type GateDecision =
  | { allow: true; reason: "enqueued_refresh" }
  | { allow: false; reason: SemrushCadenceSkipReason };

/**
 * Decide whether to enqueue a SEMrush refresh for this candidate.
 * Records the decision in the skip-log rollup as a side effect.
 *
 * Order of checks:
 *   1. Queue pause wins over everything.
 *   2. Demand-driven kill switch off → legacy "always enqueue".
 *   3. Staleness gate.
 *   4. Active-client gate (only when clientId is provided).
 */
export async function evaluateRefreshGate(input: GateInput): Promise<GateDecision> {
  if (isQueuePaused(input.queueName)) {
    recordCadenceDecision({
      queueName: input.queueName,
      reason: "skipped_queue_paused",
      clientId: input.clientId,
      campaignId: input.campaignId,
    });
    return { allow: false, reason: "skipped_queue_paused" };
  }
  const settings = await getCadenceSettings();

  if (!settings.demandDrivenEnabled) {
    // Legacy fallback path — still allow enqueue but record so operators
    // can see it's the emergency mode running.
    recordCadenceDecision({
      queueName: input.queueName,
      reason: "skipped_kill_switch_legacy",
      clientId: input.clientId,
      campaignId: input.campaignId,
    });
    return { allow: true, reason: "enqueued_refresh" };
  }

  // Staleness gate.
  if (input.lastRefreshedAt) {
    const ageMs = Date.now() - input.lastRefreshedAt.getTime();
    const thresholdMs = settings.stalenessThresholdHours * 60 * 60 * 1000;
    if (ageMs < thresholdMs) {
      recordCadenceDecision({
        queueName: input.queueName,
        reason: "skipped_not_stale",
        clientId: input.clientId,
        campaignId: input.campaignId,
      });
      return { allow: false, reason: "skipped_not_stale" };
    }
  }

  // Active-client gate. Code review (Task #1785) requires this to be
  // unconditional — a missing client mapping or zero active clients
  // must skip, not bypass.
  if (input.clientId) {
    const active = await isClientActive(input.clientId, settings);
    if (!active) {
      recordCadenceDecision({
        queueName: input.queueName,
        reason: "skipped_inactive_client",
        clientId: input.clientId,
        campaignId: input.campaignId,
      });
      return { allow: false, reason: "skipped_inactive_client" };
    }
  } else if (input.campaignId) {
    // Campaign-scoped caller without a resolvable client: this means
    // the campaign isn't mapped to any client in
    // `semrush_location_campaigns`. We refuse the enqueue and record
    // it so operators can spot stranded mappings.
    recordCadenceDecision({
      queueName: input.queueName,
      reason: "skipped_missing_mapping",
      clientId: null,
      campaignId: input.campaignId,
    });
    return { allow: false, reason: "skipped_missing_mapping" };
  } else if (input.tenantWide) {
    // Tenant-wide caller (campaign-list cache): only refresh when at
    // least one client has been active inside the window.
    const anyActive = await anyClientActiveInWindow(settings);
    if (!anyActive) {
      recordCadenceDecision({
        queueName: input.queueName,
        reason: "skipped_inactive_client",
        clientId: null,
        campaignId: null,
      });
      return { allow: false, reason: "skipped_inactive_client" };
    }
  } else {
    // Caller passed neither clientId nor campaignId nor tenantWide.
    // Block enqueue rather than silently bypass — record so the gap
    // is visible. Callers should set `tenantWide: true` if intentional.
    recordCadenceDecision({
      queueName: input.queueName,
      reason: "skipped_missing_mapping",
      clientId: null,
      campaignId: null,
    });
    return { allow: false, reason: "skipped_missing_mapping" };
  }

  recordCadenceDecision({
    queueName: input.queueName,
    reason: "enqueued_refresh",
    clientId: input.clientId,
    campaignId: input.campaignId,
  });
  return { allow: true, reason: "enqueued_refresh" };
}

// ── Identical-result apply suppression ──

/** Deterministic JSON stringify (sorted keys) for stable hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as any)[k])).join(",") + "}";
}

export function hashSemrushResponse(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export interface IdenticalCheckKey {
  campaignId: string;
  locationId?: string;
  snapshotKey?: string;
}

/**
 * Returns TRUE when the freshly-computed hash matches the last applied
 * hash for this (campaign, location, snapshot) — i.e. enqueueing a
 * heatmap-apply would be a no-op. Records a `skipped_identical_result`
 * skip-log entry on match.
 *
 * Always returns FALSE (no suppression) when the
 * `semrush_identical_result_apply_suppression` switch is off.
 */
export async function shouldSuppressApply(opts: {
  key: IdenticalCheckKey;
  freshHash: string;
  queueName?: string;
  clientId?: string | null;
}): Promise<boolean> {
  const settings = await getCadenceSettings();
  if (!settings.identicalResultSuppressionEnabled) return false;
  try {
    const rows = await withDbHoldLabel("worker:semrush_cadence_gate:check_hash", async () =>
      workerDb.execute<{ response_hash: string }>(sql`
        SELECT response_hash FROM semrush_last_applied_hashes
        WHERE campaign_id = ${opts.key.campaignId}
          AND location_id = ${opts.key.locationId ?? ""}
          AND snapshot_key = ${opts.key.snapshotKey ?? ""}
        LIMIT 1
      `),
    );
    const stored = rows.rows[0]?.response_hash;
    if (stored && stored === opts.freshHash) {
      recordCadenceDecision({
        queueName: opts.queueName ?? "semrush_heatmap_apply",
        reason: "skipped_identical_result",
        clientId: opts.clientId,
        campaignId: opts.key.campaignId,
      });
      return true;
    }
    return false;
  } catch (err: any) {
    console.warn(`[SemrushCadence] shouldSuppressApply failed: ${err?.message}`);
    return false;
  }
}

/** Persist a fresh hash after a successful apply. Idempotent upsert. */
export async function recordAppliedHash(opts: {
  key: IdenticalCheckKey;
  responseHash: string;
}): Promise<void> {
  try {
    await withDbHoldLabel("worker:semrush_cadence_gate:write_hash", async () => {
      await workerDb.execute(sql`
        INSERT INTO semrush_last_applied_hashes
          (campaign_id, location_id, snapshot_key, response_hash, applied_at)
        VALUES (
          ${opts.key.campaignId},
          ${opts.key.locationId ?? ""},
          ${opts.key.snapshotKey ?? ""},
          ${opts.responseHash},
          NOW()
        )
        ON CONFLICT (campaign_id, location_id, snapshot_key) DO UPDATE
        SET response_hash = EXCLUDED.response_hash,
            applied_at = NOW()
      `);
    });
  } catch (err: any) {
    console.warn(`[SemrushCadence] recordAppliedHash failed: ${err?.message}`);
  }
}

// ── Long-form backoff curve (Stage 4) ──

/**
 * Backoff curve: 1 m → 5 m → 30 m → 2 h → 24 h → dead-letter.
 * `attemptCount` is the number of completed attempts; the returned
 * delay is the wait BEFORE the next attempt.
 */
const LONG_BACKOFF_CURVE_MS = [
  1 * 60_000,        // 1m
  5 * 60_000,        // 5m
  30 * 60_000,       // 30m
  2 * 60 * 60_000,   // 2h
  24 * 60 * 60_000,  // 24h
];

export function computeLongFormBackoffMs(attemptCount: number): number {
  const idx = Math.max(0, Math.min(attemptCount - 1, LONG_BACKOFF_CURVE_MS.length - 1));
  const base = LONG_BACKOFF_CURVE_MS[idx];
  // ±10% jitter so a wave of simultaneously-failed rows doesn't retry in lockstep.
  const jitter = Math.floor((Math.random() - 0.5) * 0.2 * base);
  return base + jitter;
}

export const LONG_FORM_BACKOFF_MAX_ATTEMPTS = LONG_BACKOFF_CURVE_MS.length;

// suppress unused-import warning
void dsql;
