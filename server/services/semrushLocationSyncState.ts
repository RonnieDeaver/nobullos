/**
 * Per-location SEMrush sync state helpers.
 *
 * Owns the canonical (clientId, locationId, campaignId) lifecycle row used by
 * both the worker (to persist outcomes / schedule auto-retries) and by the
 * dashboard + manual-retry endpoint. Sibling locations must remain isolated:
 * a failure here is recorded against ONE row only.
 */
import { workerDb as db } from "../db";
import {
  semrushLocationSyncState,
  clientSemrushIntegrations,
  type SemrushLocationSyncState,
  type SemrushLocationSyncStateStatus,
  type SemrushLocationSyncStateErrorCategory,
} from "@shared/schema";
import { and, eq, sql, lte, lt, isNotNull, inArray } from "drizzle-orm";
import { SemrushNotFoundError, SemrushRateLimitError } from "./semrushApi";
import { recordAttempt } from "./semrushLocationSyncAttempts";
import { computeLongFormBackoffMs, LONG_FORM_BACKOFF_MAX_ATTEMPTS, getCadenceSettings } from "./semrushCadenceGate";

export const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const JITTER_MS = 2_000;

/**
 * Task #1785: permanent-error error categories. Rows that fail with one
 * of these terminate the auto-retry budget immediately — the failure is
 * deterministic and re-driving the same call will produce the same
 * error.
 */
export const PERMANENT_ERROR_CATEGORIES: ReadonlySet<SemrushLocationSyncStateErrorCategory> = new Set([
  "not_found",
  "missing_place_id",
  "mapping_disabled",
  "invalid_mapping",
  "auth_config",
  "malformed_payload",
]);

export interface SyncStateKey {
  clientId: string;
  locationId: string;
  campaignId: string;
}

export interface BeginAttemptInput extends SyncStateKey {
  runId: string;
  triggeredBy: "manual" | "scheduled" | "auto_retry";
  reportDate?: string | null;
  expectedKeywordCount?: number;
  resetAttempts?: boolean;
}

export interface CompleteAttemptInput extends SyncStateKey {
  status: SemrushLocationSyncStateStatus;
  reportDate?: string | null;
  importedKeywordCount?: number;
  expectedKeywordCount?: number;
  durationMs?: number;
  message?: string | null;
  errorCategory?: SemrushLocationSyncStateErrorCategory | null;
  lastError?: string | null;
  /**
   * Workers/queues parity (E-F01): stale-owner finalization guard.
   * When set, the outcome write only lands if the row's current `runId`
   * still matches — i.e. the caller's orchestration still owns the row.
   * If a newer run (stuck-sweep recovery → auto-retry, or a manual
   * re-drive) has re-claimed the row with a different runId, the write
   * is skipped and the returned row carries `staleRunIgnored: true`.
   * Callers that don't pass this (manual/dashboard paths) keep the
   * legacy last-writer-wins behavior unchanged.
   */
  expectedRunId?: string | null;
}

export function classifyError(err: unknown): SemrushLocationSyncStateErrorCategory {
  if (err instanceof SemrushNotFoundError) return "not_found";
  if (err instanceof SemrushRateLimitError) return "rate_limit";
  const e = err as any;
  // Task #1877: respect an explicit `errorCategory` tag set by the thrower
  // (e.g. SemrushAuthMissingError). This short-circuits the string-matching
  // heuristics below so a definitive auth-config failure can never be
  // misclassified as `transient` / `unknown` and consume the retry budget.
  if (e && typeof e.errorCategory === "string") {
    const tagged = e.errorCategory as SemrushLocationSyncStateErrorCategory;
    return tagged;
  }
  const msg = (e?.message || String(e || "")).toLowerCase();
  // Task #1877: explicit string match for the historic "Semrush not connected"
  // message — older callers may still throw a plain `Error` without the tag.
  if (msg.includes("semrush not connected") || msg.includes("no semrush refresh token") ||
      msg.includes("please re-authorize") || msg.includes("please authorize")) {
    return "auth_config";
  }
  // Task #1785: classify deterministic permanent failures up front so
  // they short-circuit the auto-retry loop instead of burning the
  // attempt budget for a guaranteed re-failure.
  if (msg.includes("missing place id") || msg.includes("no place_id") || msg.includes("place id required")) {
    return "missing_place_id";
  }
  if (msg.includes("mapping disabled") || msg.includes("integration disabled")) {
    return "mapping_disabled";
  }
  if (msg.includes("invalid mapping") || msg.includes("mapping not found")) {
    return "invalid_mapping";
  }
  if (msg.includes("invalid token") || msg.includes("unauthorized") || msg.includes("forbidden") ||
      msg.includes("http 401") || msg.includes("http 403") || msg.includes("missing api key")) {
    return "auth_config";
  }
  if (msg.includes("malformed") || msg.includes("invalid payload") || msg.includes("schema validation")) {
    return "malformed_payload";
  }
  if (e?.name === "AbortError" || msg.includes("aborted") || msg.includes("timed out")) return "timeout";
  if (msg.includes("connection terminated") || msg.includes("connection timeout") ||
      msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("network")) {
    return "transient";
  }
  if (msg.includes("http 5") || msg.includes("status 5") || msg.includes("internal server")) return "server";
  return "unknown";
}

export function isRetryableCategory(category: SemrushLocationSyncStateErrorCategory): boolean {
  // Task #1785: any category in the permanent set never retries.
  return !PERMANENT_ERROR_CATEGORIES.has(category);
}

export function computeBackoffMs(attemptCount: number): number {
  // Legacy short-cycle backoff. attempt 1 → 5s, 2 → 10s, 3 → 20s, capped.
  // Used as a fallback when the demand-driven backoff curve setting is OFF.
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attemptCount - 1)));
  const jitter = Math.floor(Math.random() * JITTER_MS);
  return exp + jitter;
}

/**
 * Task #1785: select the active backoff curve. When the
 * `semrush_auto_retry_backoff` switch is ON (default), the long-form
 * curve (1m → 5m → 30m → 2h → 24h) is used and the attempt budget
 * is widened to match. When OFF, the legacy short-cycle backoff runs.
 */
export async function computeActiveBackoffMs(attemptCount: number): Promise<number> {
  const settings = await getCadenceSettings();
  if (settings.autoRetryBackoffEnabled) {
    return computeLongFormBackoffMs(attemptCount);
  }
  return computeBackoffMs(attemptCount);
}

export async function getEffectiveMaxAttempts(rowMaxAttempts: number): Promise<number> {
  const settings = await getCadenceSettings();
  if (settings.autoRetryBackoffEnabled) {
    return Math.max(rowMaxAttempts, LONG_FORM_BACKOFF_MAX_ATTEMPTS);
  }
  return rowMaxAttempts;
}

async function ensureRow(key: SyncStateKey): Promise<SemrushLocationSyncState> {
  const existing = await db.select().from(semrushLocationSyncState).where(
    and(
      eq(semrushLocationSyncState.clientId, key.clientId),
      eq(semrushLocationSyncState.locationId, key.locationId),
      eq(semrushLocationSyncState.campaignId, key.campaignId),
    )
  ).limit(1);
  if (existing[0]) return existing[0];
  const [row] = await db.insert(semrushLocationSyncState).values({
    clientId: key.clientId,
    locationId: key.locationId,
    campaignId: key.campaignId,
    status: "queued",
    attemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  }).onConflictDoNothing({
    target: [
      semrushLocationSyncState.clientId,
      semrushLocationSyncState.locationId,
      semrushLocationSyncState.campaignId,
    ],
  }).returning();
  if (row) return row;
  // race lost — re-read
  const [again] = await db.select().from(semrushLocationSyncState).where(
    and(
      eq(semrushLocationSyncState.clientId, key.clientId),
      eq(semrushLocationSyncState.locationId, key.locationId),
      eq(semrushLocationSyncState.campaignId, key.campaignId),
    )
  ).limit(1);
  return again!;
}

export async function getSyncState(key: SyncStateKey): Promise<SemrushLocationSyncState | null> {
  const [row] = await db.select().from(semrushLocationSyncState).where(
    and(
      eq(semrushLocationSyncState.clientId, key.clientId),
      eq(semrushLocationSyncState.locationId, key.locationId),
      eq(semrushLocationSyncState.campaignId, key.campaignId),
    )
  ).limit(1);
  return row ?? null;
}

export async function listSyncStateForClient(clientId: string): Promise<SemrushLocationSyncState[]> {
  return await db.select().from(semrushLocationSyncState)
    .where(eq(semrushLocationSyncState.clientId, clientId));
}

export async function beginAttempt(input: BeginAttemptInput): Promise<SemrushLocationSyncState> {
  const row = await ensureRow(input);
  const now = new Date();
  const nextAttempt = (input.resetAttempts ? 0 : row.attemptCount) + 1;
  const [updated] = await db.update(semrushLocationSyncState)
    .set({
      status: "in_progress",
      attemptCount: nextAttempt,
      lastAttemptAt: now,
      runId: input.runId,
      triggeredBy: input.triggeredBy,
      reportDate: input.reportDate ?? row.reportDate ?? null,
      expectedKeywordCount: input.expectedKeywordCount ?? row.expectedKeywordCount,
      nextRetryAt: null,
      updatedAt: now,
    })
    .where(eq(semrushLocationSyncState.id, row.id))
    .returning();
  // Append-only attempt history (best effort).
  await recordAttempt({
    syncStateId: updated.id,
    clientId: updated.clientId,
    locationId: updated.locationId,
    campaignId: updated.campaignId,
    runId: input.runId,
    attemptNumber: nextAttempt,
    phase: "begin",
    status: "in_progress",
    triggeredBy: input.triggeredBy,
    reportDate: input.reportDate ?? null,
    expectedKeywordCount: input.expectedKeywordCount ?? null,
  });
  return updated;
}

export async function completeAttempt(
  input: CompleteAttemptInput,
): Promise<SemrushLocationSyncState & { staleRunIgnored?: boolean }> {
  const row = await ensureRow(input);
  // E-F01 stale-owner guard: a former owner (whose row was re-claimed by a
  // newer runId after e.g. a stuck-in_progress sweep + auto-retry) must not
  // clobber the newer run's in-flight state. Skip both the row write AND
  // the attempt-history record — the newer owner will record its own.
  if (
    input.expectedRunId != null &&
    row.runId != null &&
    row.runId !== input.expectedRunId
  ) {
    return { ...row, staleRunIgnored: true };
  }
  const now = new Date();
  const isSuccess = input.status === "succeeded" || input.status === "already_current" as any;
  const isFailure = input.status === "failed";
  const category = input.errorCategory ?? null;

  // Decide nextRetryAt for failed retryable rows. Permanent error
  // categories (Task #1785) short-circuit to dead-letter immediately.
  let nextRetryAt: Date | null = null;
  let effectiveLastError = input.lastError ?? null;
  if (isFailure && category && isRetryableCategory(category)) {
    const maxAttempts = await getEffectiveMaxAttempts(row.maxAttempts);
    if (row.attemptCount < maxAttempts) {
      const delayMs = await computeActiveBackoffMs(row.attemptCount);
      nextRetryAt = new Date(Date.now() + delayMs);
    }
  } else if (isFailure && category && !isRetryableCategory(category)) {
    if (effectiveLastError && !effectiveLastError.startsWith("terminal:")) {
      effectiveLastError = `terminal: ${effectiveLastError}`;
    }
  }

  const [updated] = await db.update(semrushLocationSyncState)
    .set({
      status: input.status,
      reportDate: input.reportDate ?? row.reportDate ?? null,
      importedKeywordCount: input.importedKeywordCount ?? row.importedKeywordCount,
      expectedKeywordCount: input.expectedKeywordCount ?? row.expectedKeywordCount,
      durationMs: input.durationMs ?? row.durationMs ?? null,
      message: input.message ?? null,
      errorCategory: category,
      lastError: effectiveLastError,
      lastSucceededAt: isSuccess ? now : row.lastSucceededAt,
      lastFailedAt: isFailure ? now : row.lastFailedAt,
      nextRetryAt,
      updatedAt: now,
    })
    .where(eq(semrushLocationSyncState.id, row.id))
    .returning();
  await recordAttempt({
    syncStateId: updated.id,
    clientId: updated.clientId,
    locationId: updated.locationId,
    campaignId: updated.campaignId,
    runId: updated.runId ?? "unknown",
    attemptNumber: updated.attemptCount,
    phase: "complete",
    status: input.status,
    triggeredBy: updated.triggeredBy ?? null,
    reportDate: input.reportDate ?? null,
    importedKeywordCount: input.importedKeywordCount ?? null,
    expectedKeywordCount: input.expectedKeywordCount ?? null,
    durationMs: input.durationMs ?? null,
    errorCategory: category ?? null,
    lastError: input.lastError ?? null,
    message: input.message ?? null,
  });
  return updated;
}

/**
 * Locations whose latest attempt failed retryably and whose backoff has
 * elapsed. Used by the per-location auto-retry worker.
 */
export async function listDueAutoRetries(now: Date = new Date()): Promise<SemrushLocationSyncState[]> {
  // Task #1785: the long-form backoff curve widens the effective attempt
  // budget beyond the legacy `maxAttempts=3` stored on the row. The
  // `attemptCount < maxAttempts` filter here used to clamp retries at
  // the stored value, which would silently swallow attempts 4 + 5 of
  // the 1m → 5m → 30m → 2h → 24h curve. Instead we rely on
  // `completeAttempt()` (which uses `getEffectiveMaxAttempts`) to set
  // `nextRetryAt = null` once the effective cap is reached; rows past
  // the cap therefore drop out via the `isNotNull(nextRetryAt)` filter.
  return await db
    .select()
    .from(semrushLocationSyncState)
    .where(
      and(
        eq(semrushLocationSyncState.status, "failed"),
        isNotNull(semrushLocationSyncState.nextRetryAt),
        lte(semrushLocationSyncState.nextRetryAt, now),
      ),
    );
}

/**
 * Workers/queues parity (E-F01) — atomic claim for the per-location
 * auto-retry lane. Same eligibility filter as `listDueAutoRetries`, but
 * claims up to `limit` rows by pushing `nextRetryAt` forward `leaseMs`
 * inside a single UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED),
 * so two racing tickers (or a tick racing the recovery of a crashed one)
 * can never re-drive the same row concurrently.
 *
 * Lease semantics (no new columns; rollback-safe):
 *   - the pushed `nextRetryAt` IS the bounded lease — if the claimer dies
 *     before `beginAttempt` flips the row to `in_progress`, the row simply
 *     becomes due again `leaseMs` later (recoverable, nothing permanently
 *     locked);
 *   - once `beginAttempt` runs, the in_progress machinery (runId ownership
 *     + stuck-in_progress sweep) owns the row exactly as for sweep-driven
 *     attempts;
 *   - the attempt budget is untouched: `completeAttempt` still recomputes
 *     `nextRetryAt` from `attemptCount` after the attempt finishes.
 */
export async function claimDueAutoRetries(
  limit: number,
  leaseMs: number,
  now: Date = new Date(),
): Promise<SemrushLocationSyncState[]> {
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) return [];
  const safeLeaseMs = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : 15 * 60_000;
  return await db
    .update(semrushLocationSyncState)
    .set({
      nextRetryAt: new Date(now.getTime() + safeLeaseMs),
      updatedAt: new Date(),
    })
    .where(
      sql`${semrushLocationSyncState.id} IN (
        SELECT id FROM semrush_location_sync_state
        WHERE status = 'failed'
          AND next_retry_at IS NOT NULL
          AND next_retry_at <= ${now}
        ORDER BY next_retry_at ASC
        LIMIT ${cap}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();
}

/**
 * Task #2265 — list per-location rows that are stuck in a non-terminal,
 * re-drivable state so the CEO "re-run stale Semrush partials" prod-action
 * can sweep them:
 *  - `partial`: a sync that imported some but not all keywords and was never
 *    completed (e.g. the long-stale April rows) — re-running may fill coverage.
 *  - `paused_auth`: rows a sweep paused on missing auth that a later healthy
 *    sweep never cleared (leftover) — re-running picks them up once auth is back.
 *
 * Only rows whose `updatedAt` is older than `staleBeforeMs` are returned, so an
 * in-flight/recent partial is left alone. Idempotent read; ordered oldest-first
 * so the longest-stuck rows drain first.
 */
export async function listStalePartialAndPausedAuth(
  staleBeforeMs: number,
  now: Date = new Date(),
): Promise<SemrushLocationSyncState[]> {
  const cutoff = new Date(now.getTime() - Math.max(0, staleBeforeMs));
  return await db
    .select()
    .from(semrushLocationSyncState)
    .where(
      and(
        inArray(semrushLocationSyncState.status, ["partial", "paused_auth"]),
        lt(semrushLocationSyncState.updatedAt, cutoff),
      ),
    )
    .orderBy(semrushLocationSyncState.updatedAt);
}

/**
 * Reset attempt counters when an operator triggers a manual retry. Without
 * this a row at attemptCount=maxAttempts couldn't be re-driven through the
 * bounded retry path.
 */
export async function resetForManualRetry(key: SyncStateKey): Promise<SemrushLocationSyncState | null> {
  const row = await getSyncState(key);
  if (!row) return null;
  const [updated] = await db.update(semrushLocationSyncState)
    .set({
      attemptCount: 0,
      status: "queued",
      nextRetryAt: null,
      lastError: null,
      errorCategory: null,
      updatedAt: new Date(),
    })
    .where(eq(semrushLocationSyncState.id, row.id))
    .returning();
  return updated;
}

/**
 * Task #1877: short-circuit a sweep when SEMrush OAuth is missing.
 *
 * Sets the row's status to `paused_auth` WITHOUT incrementing `attemptCount`
 * — the per-location retry budget is reserved for failures that re-driving
 * the same call could actually change. An auth-config failure is identical
 * across every location, so consuming the budget here just produced 11x the
 * dashboard noise without ever improving the outcome.
 *
 * Idempotent on repeated invocations while still paused: timestamps update,
 * counters do not. Clears `nextRetryAt` so the auto-retry sweeper skips
 * these rows entirely until the operator re-authorizes.
 *
 * Task #2265: `resetAttempts` lets a mid-sweep pause (where `beginAttempt`
 * already bumped `attemptCount` for this run) hand the row back with a clean
 * retry budget — auth being missing is not a burned attempt.
 */
export async function markPausedAuth(
  key: SyncStateKey,
  reason: string,
  opts?: { resetAttempts?: boolean },
): Promise<void> {
  const row = await ensureRow(key);
  await db.update(semrushLocationSyncState)
    .set({
      status: "paused_auth",
      errorCategory: "auth_config",
      lastError: reason,
      message: reason,
      nextRetryAt: null,
      ...(opts?.resetAttempts ? { attemptCount: 0 } : {}),
      updatedAt: new Date(),
    })
    .where(eq(semrushLocationSyncState.id, row.id));
}

/**
 * Task #1877: when the operator re-authorizes, drop any sweep-level pause
 * back to `queued` so the next run picks the rows up normally. Only
 * touches rows that are still in `paused_auth`; in-flight and succeeded
 * rows are left alone.
 */
export async function clearPausedAuthForClient(clientId: string): Promise<number> {
  const updated = await db.update(semrushLocationSyncState)
    .set({
      status: "queued",
      errorCategory: null,
      lastError: null,
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(semrushLocationSyncState.clientId, clientId),
      eq(semrushLocationSyncState.status, "paused_auth"),
    ))
    .returning({ id: semrushLocationSyncState.id });
  return updated.length;
}

export async function clearAllPausedAuth(): Promise<number> {
  const updated = await db.update(semrushLocationSyncState)
    .set({
      status: "queued",
      errorCategory: null,
      lastError: null,
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    .where(eq(semrushLocationSyncState.status, "paused_auth"))
    .returning({ id: semrushLocationSyncState.id });
  return updated.length;
}

/**
 * Task #2643 — recovery sweep for a restored SEMrush auth. When the global
 * auth breaker self-heals (a successful authenticated API call proves the
 * credential is live again) or operator reconnect happens BETWEEN
 * Local-Dominance sweeps, the `paused_auth` rows stamped by the sweep
 * short-circuit linger until the next sweep — so client pages keep showing
 * "Reconnect Required" on a connection that is already healthy. This clears
 * BOTH surfaces in one call:
 *   - per-location sync_state rows (`paused_auth` → `queued`), and
 *   - per-client `clientSemrushIntegrations` rows (`paused_auth` → `idle`,
 *     the schema default; the next sweep overwrites with the real outcome).
 * Idempotent and cheap when nothing is paused. Returns the counts cleared.
 */
export async function recoverPausedAuthRows(): Promise<{
  locationRows: number;
  integrationRows: number;
}> {
  const locationRows = await clearAllPausedAuth();
  const updatedIntegrations = await db.update(clientSemrushIntegrations)
    .set({
      syncStatus: "idle",
      lastSyncOutcome: null,
      errorMessage: null,
      errorCategory: null,
      updatedAt: new Date(),
    })
    .where(eq(clientSemrushIntegrations.syncStatus, "paused_auth"))
    .returning({ id: clientSemrushIntegrations.id });
  return { locationRows, integrationRows: updatedIntegrations.length };
}

export async function markStale(key: SyncStateKey, reason: string): Promise<void> {
  const row = await ensureRow(key);
  await db.update(semrushLocationSyncState)
    .set({
      status: "stale",
      errorCategory: "not_found",
      lastError: reason,
      lastFailedAt: new Date(),
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    .where(eq(semrushLocationSyncState.id, row.id));
}

/**
 * Task #2877 — Sweep `semrush_location_sync_state` rows stuck in `in_progress`.
 *
 * Background: if the Local-Dominance worker process crashes (OOM, SIGKILL,
 * deploy restart) mid-sync, the row's `beginAttempt` write already flipped
 * `status → in_progress` but `completeAttempt` never ran.  The rows sit
 * stuck forever — no new attempt fires because the scheduler treats
 * `in_progress` as "actively running" and skips re-queuing.
 *
 * This sweep promotes those rows to `failed / timeout` so the retry logic
 * picks them up on the next sweep cycle and enqueues a fresh attempt.
 * A `complete` phase attempt-history record is inserted for operator
 * post-mortems.
 *
 * Cutoff: rows stuck for more than `STUCK_IN_PROGRESS_CUTOFF_MS` (4 h).
 * The longest normal sync can take up to `LOCATION_BUDGET_MS` (6 min), so
 * 4 h is very conservative and will never race a healthy in-progress row.
 *
 * Called at the top of each `syncAllActiveClients` sweep (before any per-
 * location work) so the recovered rows are immediately eligible this run.
 *
 * @returns number of rows promoted.
 */
export const STUCK_IN_PROGRESS_CUTOFF_MS = 4 * 60 * 60 * 1000;

export async function sweepStuckInProgress(
  // Workers/queues parity (E-F02): the cutoff is now sourced from the
  // canonical `local_dominance_sync` max-processing lane by the worker
  // call site (default equals the legacy 4h constant, so behavior is
  // unchanged until an operator tunes the lane setting).
  cutoffMs: number = STUCK_IN_PROGRESS_CUTOFF_MS,
): Promise<number> {
  const effectiveCutoffMs =
    Number.isFinite(cutoffMs) && cutoffMs > 0 ? cutoffMs : STUCK_IN_PROGRESS_CUTOFF_MS;
  const cutoff = new Date(Date.now() - effectiveCutoffMs);
  const stuck = await db
    .select()
    .from(semrushLocationSyncState)
    .where(
      and(
        eq(semrushLocationSyncState.status, "in_progress"),
        lt(semrushLocationSyncState.lastAttemptAt, cutoff),
      ),
    );
  if (stuck.length === 0) return 0;

  const sweepRunId = `stuck-sweep-${Date.now()}`;
  const cutoffHours = Math.round((effectiveCutoffMs / 3_600_000) * 10) / 10;
  const message =
    `Row stuck in in_progress past the ${cutoffHours}-hour cutoff — promoted to failed/timeout by sweepStuckInProgress (Task #2877).`;

  for (const row of stuck) {
    try {
      await db
        .update(semrushLocationSyncState)
        .set({
          status: "failed",
          errorCategory: "timeout",
          lastError: message,
          lastFailedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(semrushLocationSyncState.id, row.id));

      await recordAttempt({
        syncStateId: row.id,
        clientId: row.clientId,
        locationId: row.locationId,
        campaignId: row.campaignId,
        runId: sweepRunId,
        attemptNumber: row.attemptCount,
        phase: "complete",
        status: "failed",
        errorCategory: "timeout",
        lastError: message,
        message,
      });
    } catch (e: any) {
      console.warn(
        `[SemrushSyncState] sweepStuckInProgress: failed to promote row ${row.id} (non-fatal): ${e?.message}`,
      );
    }
  }

  console.log(
    `[SemrushSyncState] sweepStuckInProgress: promoted ${stuck.length} stuck in_progress row(s) to failed/timeout`,
  );
  return stuck.length;
}

/** Drop rows for mappings that no longer exist (called after orphan cleanup). */
export async function pruneOrphanRows(
  clientId: string,
  validKeys: Array<{ locationId: string; campaignId: string }>,
): Promise<void> {
  const rows = await listSyncStateForClient(clientId);
  const keep = new Set(validKeys.map(k => `${k.locationId}::${k.campaignId}`));
  const drop = rows.filter(r => !keep.has(`${r.locationId}::${r.campaignId}`));
  if (drop.length === 0) return;
  for (const r of drop) {
    await db.delete(semrushLocationSyncState).where(eq(semrushLocationSyncState.id, r.id));
  }
}
