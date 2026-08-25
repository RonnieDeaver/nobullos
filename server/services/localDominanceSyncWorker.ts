import { workerDb as db, withDbAttribution } from "../db";
import { clientSemrushIntegrations, semrushLocationCampaigns, clientLocations, heatmapSnapshots } from "@shared/schema";
import { eq, and, ne, notInArray, sql, inArray, gte, lte } from "drizzle-orm";
import { SemrushNotFoundError, hasSemrushAccessToken } from "./semrushApi";
import { semrushAuthBreakerActive } from "./semrushAuthBreaker";
import { PERF } from "../perfConfig";
import { normalizeKeyword, normalizedKeywordSet } from "@shared/keywordNormalization";
import {
  beginAttempt as beginSyncAttempt,
  completeAttempt as completeSyncAttempt,
  markStale as markStateStale,
  markPausedAuth as markStatePausedAuth,
  clearAllPausedAuth as clearAllPausedAuthRows,
  recoverPausedAuthRows,
  pruneOrphanRows as pruneSyncStateOrphans,
  classifyError as classifyLocationSyncError,
  isRetryableCategory,
  computeBackoffMs as computeLocationBackoffMs,
  DEFAULT_MAX_ATTEMPTS,
  sweepStuckInProgress,
  STUCK_IN_PROGRESS_CUTOFF_MS,
} from "./semrushLocationSyncState";
import {
  checkSemrushGlobalDisconnectAlert,
  onSemrushAuthRestored,
} from "./semrushDisconnectAlert";
// Workers/queues parity (E-F02/E-F05): operator kill switch + canonical
// max-processing lane + structured logging for the paths this worker owns.
import { isKillSwitchEnabled } from "./killSwitches";
import { getMaxProcessingMs } from "./queueMaxProcessing";
import { workerLog } from "./workerLogger";

/**
 * Per-location budget knobs for the multi-location resilience refactor (task #681).
 *
 * - LOCATION_BUDGET_MS: hard wall-clock budget for ONE attempt against ONE location.
 *   Each location gets its own AbortController + setTimeout — sibling locations are
 *   unaffected. A timeout marks that location's state row as failed/timeout (retryable).
 *
 * - LOCATION_MAX_ATTEMPTS: bounded auto-retry budget per (clientId, locationId, campaignId)
 *   per orchestration. Jittered exponential backoff between attempts. Manual retry resets
 *   the counter via resetForManualRetry().
 *
 * Intentionally NOT solved by raising the global timeout: the goal is "slow location
 * doesn't cascade", not "wait longer for everything".
 */
const LOCATION_BUDGET_MS = 6 * 60 * 1000;
const LOCATION_MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;

let isSyncing = false;

const ADVISORY_WINDOW_SIZE = 200;
const advisoryBypassCountersLifetime: Record<string, number> = {};
let advisoryBypassLifetime = 0;
let advisoryAcquireLifetime = 0;
const advisoryWindow: Array<{ bypassed: boolean; label: string; at: number }> = [];

function recordAdvisoryOutcome(label: string, bypassed: boolean): void {
  advisoryAcquireLifetime++;
  if (bypassed) {
    advisoryBypassLifetime++;
    advisoryBypassCountersLifetime[label] = (advisoryBypassCountersLifetime[label] || 0) + 1;
  }
  advisoryWindow.push({ bypassed, label, at: Date.now() });
  if (advisoryWindow.length > ADVISORY_WINDOW_SIZE) advisoryWindow.shift();
}

export function getLocalDominanceSlotMetrics(): {
  windowSize: number;
  windowSamples: number;
  windowBypassCount: number;
  windowBypassRate: number;
  windowBypassByLabel: Record<string, number>;
  oldestSampleAgeMs: number | null;
  lifetime: {
    acquires: number;
    bypasses: number;
    bypassRate: number;
    bypassByLabel: Record<string, number>;
  };
} {
  let windowBypassCount = 0;
  const windowBypassByLabel: Record<string, number> = {};
  for (const s of advisoryWindow) {
    if (s.bypassed) {
      windowBypassCount++;
      windowBypassByLabel[s.label] = (windowBypassByLabel[s.label] || 0) + 1;
    }
  }
  const windowSamples = advisoryWindow.length;
  return {
    windowSize: ADVISORY_WINDOW_SIZE,
    windowSamples,
    windowBypassCount,
    windowBypassRate: windowSamples > 0 ? windowBypassCount / windowSamples : 0,
    windowBypassByLabel,
    oldestSampleAgeMs: windowSamples > 0 ? Date.now() - advisoryWindow[0].at : null,
    lifetime: {
      acquires: advisoryAcquireLifetime,
      bypasses: advisoryBypassLifetime,
      bypassRate: advisoryAcquireLifetime > 0 ? advisoryBypassLifetime / advisoryAcquireLifetime : 0,
      bypassByLabel: { ...advisoryBypassCountersLifetime },
    },
  };
}

type WorkOriginLocal = "user_manual" | "scheduled_background";

/**
 * ADVISORY slot — for low-risk single-row metadata writes (status, progress, heartbeat).
 * If the workload slot can't be acquired within the 30s window, logs a warning and
 * proceeds without slot accounting. NOT for bulk writes or real data commits.
 */
async function advisorySlot(label: string, instrumentation?: any, origin: WorkOriginLocal = "scheduled_background"): Promise<{ release: () => void }> {
  const { awaitClassSlot, releaseClassSlot } = await import("./workloadManager");
  let held = false;
  try {
    await awaitClassSlot("local_dominance_sync", { origin });
    held = true;
    instrumentation?.slotAcquire?.();
    recordAdvisoryOutcome(label, false);
  } catch (e: any) {
    const msg = e?.message || String(e || "");
    if (!msg.includes("[WorkloadManager]")) throw e;
    recordAdvisoryOutcome(label, true);
    const m = getLocalDominanceSlotMetrics();
    console.warn(
      `[LocalDominanceSync] advisory slot bypass label=${label} origin=${origin} reason="${msg}" ` +
      `windowBypass=${m.windowBypassCount}/${m.windowSamples} ` +
      `windowRate=${m.windowBypassRate.toFixed(3)} ` +
      `lifetimeBypass=${m.lifetime.bypasses}`
    );
  }
  return {
    release: () => {
      if (held) {
        try { releaseClassSlot("local_dominance_sync"); } catch {}
        instrumentation?.slotRelease?.();
        held = false;
      }
    },
  };
}

/**
 * REQUIRED slot — for real DB-heavy commits (bulk writes, data imports).
 * If the slot can't be acquired, throws — caller must contain the error to a
 * single chunk (per-keyword, per-cleanup-batch) so the whole sync isn't killed.
 *
 * Commit-phase semantics are NEVER bypassed based on origin. Origin only affects
 * scheduler priority (manual gets reserved ingestion capacity via workloadManager).
 */
async function requiredSlot(label: string, instrumentation?: any, origin: WorkOriginLocal = "scheduled_background"): Promise<{ release: () => void }> {
  const { awaitClassSlot, releaseClassSlot } = await import("./workloadManager");
  await awaitClassSlot("local_dominance_sync", { origin });
  instrumentation?.slotAcquire?.();
  let held = true;
  return {
    release: () => {
      if (held) {
        try { releaseClassSlot("local_dominance_sync"); } catch {}
        instrumentation?.slotRelease?.();
        held = false;
      }
    },
  };
}

const acquireOrSkipSlot = advisorySlot;

// ---------------------------------------------------------------------------
// Test seam — allows the sync idempotency tests to substitute the SEMrush API
// and heatmap-import dependencies that `syncCampaignForClient` resolves via
// dynamic import. Production callers never set these overrides.
// ---------------------------------------------------------------------------
type SemrushApiSubset = {
  getCampaign: typeof import("./semrushApi").getCampaign;
  getCampaignKeywordsWithMeta: typeof import("./semrushApi").getCampaignKeywordsWithMeta;
  getHeatmapData: typeof import("./semrushApi").getHeatmapData;
  findBestReportDate: typeof import("./semrushApi").findBestReportDate;
};
type HeatmapServiceSubset = {
  importHeatmap: typeof import("./heatmapService").importHeatmap;
};
let __testSemrushApiOverride: Partial<SemrushApiSubset> | null = null;
let __testHeatmapServiceOverride: Partial<HeatmapServiceSubset> | null = null;
/**
 * Test-only seam: install fake implementations of the dynamically-imported
 * `./semrushApi` and `./heatmapService` modules used by `syncCampaignForClient`.
 *
 * Refuses to run unless NODE_ENV === "test" (or VITEST/JEST/RUN_INTEGRATION_TESTS
 * indicators are present), so accidental production calls fail loudly instead
 * of silently swapping the SEMrush integration with a stub.
 */
export function __setSemrushSyncTestOverrides(overrides: {
  semrushApi?: Partial<SemrushApiSubset> | null;
  heatmapService?: Partial<HeatmapServiceSubset> | null;
} | null): void {
  const env = process.env;
  const isTestEnv =
    env.NODE_ENV === "test" ||
    !!env.VITEST ||
    !!env.JEST_WORKER_ID ||
    !!env.RUN_INTEGRATION_TESTS;
  if (!isTestEnv) {
    throw new Error(
      "__setSemrushSyncTestOverrides is test-only and refuses to run outside a test environment",
    );
  }
  __testSemrushApiOverride = overrides?.semrushApi ?? null;
  __testHeatmapServiceOverride = overrides?.heatmapService ?? null;
}

export async function syncAllActiveClients(): Promise<{
  synced: number;
  failed: number;
  errors: Array<{ clientId: string; error: string }>;
}> {
  const { acquireDistributedLock } = await import("./workerLock");
  const { SyncInstrumentation } = await import("./workerLogger");
  const { WORKER_BATCH_SIZE, WORKER_BATCH_YIELD_MS, CROSS_INSTANCE_LOCK_MAX_HOLD_MS } = await import("./workerConfig");
  const { getCutoverDecision, logShadowComparison } = await import("./cutoverGuard");
  const WORKER_NAME = "local_dominance_sync";

  const decision = getCutoverDecision("semrush");

  if (!decision.runLegacy && decision.runDurable) {
    console.log("[LocalDominanceSync] Skipping legacy sync — durable pipeline is active for semrush");
    workerLog({ worker: WORKER_NAME, event: "worker_skipped_overlap" });
    return { synced: 0, failed: 0, errors: [] };
  }

  if (isSyncing) {
    workerLog({ worker: WORKER_NAME, event: "worker_skipped_overlap" });
    return { synced: 0, failed: 0, errors: [] };
  }
  // Workers/queues parity (E-F05): operator kill switch — checked before
  // taking the cluster-wide lock so a disabled sweep doesn't hold the
  // advisory slot. Distinct from the cutover + auth gates above/below:
  // this is an explicit operator stop, logged as such.
  if (isKillSwitchEnabled(WORKER_NAME)) {
    workerLog({
      worker: WORKER_NAME,
      event: "kill_switch_abort",
      killSwitch: WORKER_NAME,
      detail: "sweep skipped - operator kill switch enabled",
    });
    return { synced: 0, failed: 0, errors: [] };
  }
  // Task #2363 — cluster-wide single-flight. On `autoscale` this scheduler
  // fires on every instance; the advisory lock makes exactly one instance
  // run the per-client SEMrush/GBP sync so we don't double-call those APIs
  // or double-write rollups.
  // Task #2383 — bound the hold so a hung per-location sync (e.g. a stalled
  // SEMrush/GBP call) can't keep the cluster-wide lock forever.
  const lock = await acquireDistributedLock(
    WORKER_NAME,
    undefined,
    undefined,
    CROSS_INSTANCE_LOCK_MAX_HOLD_MS.local_dominance_sync,
  );
  if (!lock) {
    return { synced: 0, failed: 0, errors: [] };
  }

  isSyncing = true;
  const startTime = Date.now();
  const instrumentation = new SyncInstrumentation(WORKER_NAME);
  workerLog({ worker: WORKER_NAME, event: "worker_started" });
  const results = { synced: 0, failed: 0, errors: [] as Array<{ clientId: string; error: string }> };

  try {
    const integrations = await db.select()
      .from(clientSemrushIntegrations)
      .where(
        and(
          eq(clientSemrushIntegrations.isActive, true),
          eq(clientSemrushIntegrations.integrationEnabled, true),
        )
      );

    instrumentation.itemsFetched = integrations.length;
    console.log(`[LocalDominanceSync] Found ${integrations.length} active integrations`);

    // Task #2877 — promote any sync_state rows that are stuck in
    // `in_progress` beyond the cutoff (crash recovery). Must run
    // before the auth gate so recovered rows are eligible this sweep.
    // E-F02: the cutoff now comes from the canonical
    // `local_dominance_sync` max-processing lane (default = the legacy
    // 4h constant) instead of a duplicated hard-coded value.
    try {
      const staleCutoffMs = await getMaxProcessingMs(WORKER_NAME).catch(
        () => STUCK_IN_PROGRESS_CUTOFF_MS,
      );
      const swept = await sweepStuckInProgress(staleCutoffMs);
      if (swept > 0) {
        console.log(`[LocalDominanceSync] sweepStuckInProgress: promoted ${swept} row(s) to failed/timeout for retry`);
        workerLog({
          worker: WORKER_NAME,
          event: "stale_job_reset",
          itemsProcessed: swept,
          detail: `stuck in_progress rows promoted to failed/timeout (cutoff ${Math.round(staleCutoffMs / 60_000)}m)`,
        });
      }
    } catch (e: any) {
      console.warn(`[LocalDominanceSync] sweepStuckInProgress failed (non-fatal): ${e?.message}`);
    }

    // Task #1877: sweep-level auth gate. Before attempting any per-location
    // sync, probe the SEMrush OAuth setting once. If the access token is
    // missing the entire sweep is a no-op: every location across every
    // client would otherwise throw "Semrush not connected" and burn the
    // retry budget (4–7x the natural fail count once you account for
    // auto-retries). Mark each integration + sync_state row with
    // `paused_auth` so the dashboard shows ONE plain-English reason
    // instead of N per-client failure pills.
    // Task #2102 — also short-circuit when the auth-dead breaker is open.
    // A terminal refresh wipes the stored token (so `!tokenPresent` usually
    // already covers it), but the breaker can be open while a stale token
    // is still present (e.g. tripped on a missing refresh token); gate on
    // both so the sweep pauses instead of attempting every location.
    const tokenPresent = await hasSemrushAccessToken();
    if ((!tokenPresent || semrushAuthBreakerActive()) && integrations.length > 0) {
      const reason = "Semrush not connected — sweep paused until re-authorization via Integrations Hub";
      console.warn(`[LocalDominanceSync] ${reason} (${integrations.length} integrations short-circuited)`);
      for (const integration of integrations) {
        try {
          await db.update(clientSemrushIntegrations)
            .set({
              syncStatus: "paused_auth",
              lastSyncOutcome: "paused_auth",
              lastSyncSummary: reason,
              errorMessage: reason.substring(0, 500),
              // E-F16 typed-failure parity: paused_auth is definitionally an
              // auth-config failure (matches the sync_state rows' category).
              errorCategory: "auth_config",
              warningMessage: null,
              syncProgress: null,
              updatedAt: new Date(),
            })
            .where(eq(clientSemrushIntegrations.id, integration.id));
        } catch (e: any) {
          console.warn(`[LocalDominanceSync] paused_auth update failed for client ${integration.clientId}: ${e?.message}`);
        }
        try {
          const mappings = await db.select()
            .from(semrushLocationCampaigns)
            .where(eq(semrushLocationCampaigns.clientId, integration.clientId));
          for (const m of mappings) {
            await markStatePausedAuth({
              clientId: integration.clientId,
              locationId: m.locationId,
              campaignId: m.semrushCampaignId,
            }, reason);
          }
        } catch (e: any) {
          console.warn(`[LocalDominanceSync] paused_auth state-row update failed for client ${integration.clientId}: ${e?.message}`);
        }
      }
      workerLog({ worker: WORKER_NAME, event: "worker_paused_auth", itemsProcessed: integrations.length, durationMs: Date.now() - startTime });
      // Task #2877 — fire once-per-streak global-disconnect alert (best-effort,
      // non-blocking). The dispatcher health-state machine deduplicates; we
      // never alert twice per outage streak without a recovery in between.
      const alertReason = !tokenPresent ? "tokens_absent" : "breaker_open";
      void checkSemrushGlobalDisconnectAlert(alertReason);
      return { synced: 0, failed: 0, errors: [] };
    }

    // Task #1877: if a previous sweep marked rows as paused_auth and the
    // operator has since re-authorized, clear those flags so the rows are
    // picked up normally this run. Idempotent / cheap when nothing matches.
    if (tokenPresent) {
      try {
        // Task #2643 — clear BOTH the per-location sync_state rows AND the
        // per-client integration paused_auth rows in one shot so client pages
        // return to normal immediately, not just as each integration re-syncs.
        const { locationRows, integrationRows } = await recoverPausedAuthRows();
        if (locationRows > 0 || integrationRows > 0) {
          console.log(`[LocalDominanceSync] Auth restored — cleared ${locationRows} paused_auth sync_state row(s) and ${integrationRows} client-integration row(s)`);
          // Task #2877 — re-arm the disconnect alert streak so the NEXT outage
          // immediately re-alerts without being silenced by the previous one.
          void onSemrushAuthRestored();
        }
      } catch (e: any) {
        console.warn(`[LocalDominanceSync] recoverPausedAuthRows failed (non-fatal): ${e?.message}`);
      }
    }

    // E-F05: long sweeps recheck the kill switch at safe boundaries —
    // between integrations here, and between locations inside
    // syncClientIntegration (via `shouldStop`). Remaining work is left
    // untouched for the next enabled sweep; nothing is marked failed.
    let stoppedByKillSwitch = false;
    for (let i = 0; i < integrations.length; i += WORKER_BATCH_SIZE) {
      const batch = integrations.slice(i, i + WORKER_BATCH_SIZE);

      for (const integration of batch) {
        if (isKillSwitchEnabled(WORKER_NAME)) {
          stoppedByKillSwitch = true;
          workerLog({
            worker: WORKER_NAME,
            event: "kill_switch_abort",
            killSwitch: WORKER_NAME,
            detail: `operator stop honored mid-sweep before client ${integration.clientId} — remaining integrations left for the next enabled sweep`,
          });
          break;
        }
        try {
          const outcome = await syncClientIntegration(integration, undefined, instrumentation, {
            shouldStop: () => isKillSwitchEnabled(WORKER_NAME),
          });
          const okSlot = await acquireOrSkipSlot("scheduled-success", instrumentation);
          try {
            results.synced++;
            instrumentation.itemsCommitted++;
            await db.update(clientSemrushIntegrations)
              .set({
                syncStatus: "success",
                lastSuccessfulSyncAt: new Date(),
                errorMessage: null,
                errorCategory: null,
                warningMessage: outcome.warningMessage ?? null,
                lastSyncOutcome: outcome.status,
                lastSyncSummary: outcome.summary ?? null,
                syncProgress: null,
                updatedAt: new Date(),
              })
              .where(eq(clientSemrushIntegrations.id, integration.id));
          } finally {
            okSlot.release();
          }

        } catch (err: any) {
          results.failed++;
          const errorMsg = err?.message || String(err);
          results.errors.push({ clientId: integration.clientId, error: errorMsg });

          const errSlot = await acquireOrSkipSlot("scheduled-error", instrumentation);
          try {
            await db.update(clientSemrushIntegrations)
              .set({
                syncStatus: "error",
                lastFailedSyncAt: new Date(),
                errorMessage: errorMsg.substring(0, 500),
                // E-F16 typed-failure parity: machine-readable classification
                // beside the raw text (same classifier as the sync_state rows).
                errorCategory: classifyLocationSyncError(err),
                lastSyncOutcome: "error",
                lastSyncSummary: errorMsg.substring(0, 500),
                syncProgress: null,
                updatedAt: new Date(),
              })
              .where(eq(clientSemrushIntegrations.id, integration.id));
          } finally {
            errSlot.release();
          }

          console.error(`[LocalDominanceSync] Failed for client ${integration.clientId}:`, errorMsg);
        }
      }

      workerLog({
        worker: WORKER_NAME,
        event: "worker_batch_completed",
        batchIndex: Math.floor(i / WORKER_BATCH_SIZE) + 1,
        batchSize: batch.length,
        itemsProcessed: Math.min(i + WORKER_BATCH_SIZE, integrations.length),
        totalItems: integrations.length,
      });

      if (stoppedByKillSwitch) break;

      if (i + WORKER_BATCH_SIZE < integrations.length) {
        await new Promise(resolve => setTimeout(resolve, WORKER_BATCH_YIELD_MS));
      }
    }

    console.log(`[LocalDominanceSync] Completed: ${results.synced} synced, ${results.failed} failed${stoppedByKillSwitch ? " (stopped early: kill switch)" : ""}`);
    instrumentation.logSummary();
    workerLog({
      worker: WORKER_NAME,
      event: "worker_completed",
      durationMs: Date.now() - startTime,
      itemsProcessed: results.synced,
      ...(stoppedByKillSwitch ? { stopReason: "kill_switch" } : {}),
    });

    if (decision.shadowMode && decision.runDurable) {
      let durableOutcome: "success" | "error" | "skipped" = "skipped";
      let durableError: string | undefined;
      const durableStart = Date.now();
      try {
        const { ingestEvent } = await import("./pipelineProcessor");
        for (const integration of integrations) {
          const dedupeKey = `semrush:sync:${integration.clientId}:${integration.semrushCampaignId}`;
          await ingestEvent({
            sourceSystem: "semrush",
            sourceEventType: "inventory_sync",
            sourceObjectId: `semrush_integration_${integration.id}`,
            dedupeKey,
            payloadJson: {
              clientId: integration.clientId,
              campaignId: integration.semrushCampaignId,
              integrationId: integration.id,
              syncedAt: new Date().toISOString(),
            },
          });
        }
        durableOutcome = "success";
      } catch (err: any) {
        durableOutcome = "error";
        durableError = err.message;
        console.error("[LocalDominanceSync] Durable shadow ingest failed:", err.message);
      }
      const legacyOutcome = results.failed > 0 && results.synced === 0 ? "error" as const : "success" as const;
      logShadowComparison({
        source: "semrush",
        operation: "syncAllActiveClients",
        legacyOutcome,
        durableOutcome,
        match: legacyOutcome === durableOutcome,
        legacyError: results.errors.length > 0 ? results.errors[0]?.error : undefined,
        durableError,
        durationLegacyMs: Date.now() - startTime,
        durableDurationMs: Date.now() - durableStart,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    instrumentation.logSummary();
    workerLog({ worker: WORKER_NAME, event: "worker_failed", durationMs: Date.now() - startTime, error: err?.message });
  } finally {
    isSyncing = false;
    await lock.release();
  }

  return results;
}

interface ClientIntegrationSyncOutcome {
  status: "success" | "already_current" | "partial_success";
  warningMessage?: string;
  summary?: string;
  freshlyImported?: number;
  alreadyCurrentCount?: number;
  partialCount?: number;
  totalCampaigns?: number;
}

interface RunLocationArgs {
  integration: typeof clientSemrushIntegrations.$inferSelect;
  mapping: typeof semrushLocationCampaigns.$inferSelect;
  locIndex: number;
  totalLocations: number;
  runId: string;
  triggeredBy: "manual" | "scheduled" | "auto_retry";
  maxAttempts: number;
  perLocationBudgetMs: number;
  parentSignal?: AbortSignal;
  instrumentation?: import("./workerLogger").SyncInstrumentation;
  origin: WorkOriginLocal;
  updateProgress: (progress: { currentLocation: number; totalLocations: number; currentKeyword: number; totalKeywords: number; locationName?: string; keywordName?: string }) => Promise<void>;
}

interface RunLocationOutcome {
  // Task #2265 — `paused_auth` is a non-failure terminal: a mid-sweep
  // auth-missing error routes the row to paused_auth (no burned attempt, no
  // red "failed" pill) and is auto-cleared on the next healthy sweep.
  terminalStatus: "succeeded" | "failed" | "stale" | "paused_auth";
  result?: SyncCampaignResult;
  lastError?: any;
  attemptsUsed: number;
}

/**
 * Runs ONE (clientId, locationId, campaignId) location independently.
 *
 * - Each attempt gets its OWN AbortController + per-location wall-clock budget.
 *   Sibling locations are NEVER affected by this location's timeout/retry.
 * - Bounded auto-retry with jittered exponential backoff up to `maxAttempts`.
 *   Non-retryable errors (404 / not_found) short-circuit immediately.
 * - Persists canonical state to `semrush_location_sync_state` on every begin
 *   and complete so dashboard + manual-retry stay accurate even mid-run.
 *
 * Never throws — caller inspects `outcome.terminalStatus`.
 */
async function runLocationWithRetry(args: RunLocationArgs): Promise<RunLocationOutcome> {
  const {
    integration, mapping, locIndex, totalLocations, runId, triggeredBy,
    maxAttempts, perLocationBudgetMs, parentSignal, instrumentation, origin, updateProgress,
  } = args;

  const key = {
    clientId: integration.clientId,
    locationId: mapping.locationId,
    campaignId: mapping.semrushCampaignId,
  };

  let lastErr: any = null;
  let lastResult: SyncCampaignResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (parentSignal?.aborted) {
      return { terminalStatus: "failed", lastError: lastErr || new Error("parent abort"), attemptsUsed: attempt - 1 };
    }

    if (attempt > 1) {
      const backoffMs = computeLocationBackoffMs(attempt - 1);
      console.log(`[LocalDominanceSync] location=${mapping.locationId} camp=${mapping.semrushCampaignId} retry ${attempt}/${maxAttempts} after ${backoffMs}ms backoff`);
      await new Promise(r => setTimeout(r, backoffMs));
      if (parentSignal?.aborted) {
        return { terminalStatus: "failed", lastError: lastErr || new Error("parent abort during backoff"), attemptsUsed: attempt - 1 };
      }
    }

    // Per-location AbortController. Aborts on (a) per-location timeout, or
    // (b) parent signal. Crucially, this signal is NOT shared across siblings.
    const ac = new AbortController();
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, perLocationBudgetMs);
    const onParentAbort = () => ac.abort();
    parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });

    const t0 = Date.now();
    try {
      await beginSyncAttempt({
        ...key,
        runId,
        triggeredBy: attempt === 1 ? triggeredBy : "auto_retry",
      });
    } catch (e: any) {
      console.warn(`[LocalDominanceSync] beginAttempt persistence failed for loc=${mapping.locationId} (continuing): ${e?.message}`);
    }

    try {
      const result = await syncCampaignForClient(
        integration.clientId,
        mapping.semrushCampaignId,
        mapping.locationId,
        mapping.semrushCampaignName,
        ac.signal,
        async (kwIndex, kwTotal, kwName) => {
          await updateProgress({
            currentLocation: locIndex + 1,
            totalLocations,
            currentKeyword: kwIndex,
            totalKeywords: kwTotal,
            locationName: mapping.semrushCampaignName || undefined,
            keywordName: kwName,
          });
        },
        instrumentation,
        { origin },
      );
      clearTimeout(timeoutHandle);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
      lastResult = result;
      const durationMs = Date.now() - t0;

      // Map syncCampaignForClient's status to canonical state.
      let stateStatus: "succeeded" | "partial" | "failed" | "skipped";
      if (result.skipped) stateStatus = "skipped";
      else if (result.status === "success") stateStatus = "succeeded";
      else if (result.status === "already_current") stateStatus = "succeeded";
      else if (result.status === "partial_success") stateStatus = "partial";
      else stateStatus = "failed";

      try {
        const updated = await completeSyncAttempt({
          ...key,
          status: stateStatus,
          reportDate: result.targetReportDate,
          importedKeywordCount: result.imported,
          expectedKeywordCount: result.expectedCoverageCount,
          durationMs,
          message: result.message ?? null,
          errorCategory: stateStatus === "failed" ? "unknown" : null,
          lastError: stateStatus === "failed" ? (result.message ?? null) : null,
          // E-F01: a former owner whose row was re-claimed by a newer run
          // must not clobber that run's in-flight state.
          expectedRunId: runId,
        });
        if (updated.staleRunIgnored) {
          workerLog({
            worker: "local_dominance_sync",
            event: "job_completion_stale_lease_ignored",
            detail: `outcome write skipped for loc=${mapping.locationId} camp=${mapping.semrushCampaignId} — sync_state row re-claimed by a newer runId`,
          });
        }
      } catch (e: any) {
        console.warn(`[LocalDominanceSync] completeAttempt persistence failed for loc=${mapping.locationId}: ${e?.message}`);
      }

      // result-level "failed" (incomplete coverage from per-keyword errors)
      // is NOT thrown out of syncCampaignForClient. Treat as retryable when
      // we still have attempts left, otherwise return as terminal failed.
      if (stateStatus === "failed" && attempt < maxAttempts) {
        lastErr = new Error(result.message || "incomplete coverage");
        continue;
      }

      return {
        terminalStatus: stateStatus === "failed" ? "failed" : "succeeded",
        result,
        attemptsUsed: attempt,
      };
    } catch (err: any) {
      clearTimeout(timeoutHandle);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
      lastErr = err;

      if (err instanceof SemrushNotFoundError) {
        try {
          await markStateStale(key, err?.message || "campaign not found");
        } catch {}
        return { terminalStatus: "stale", lastError: err, attemptsUsed: attempt };
      }

      // Reclassify abort caused by our per-location timeout as `timeout` so
      // the dashboard surfaces the right reason (vs an unrelated cancel).
      const category = timedOut ? "timeout" : classifyLocationSyncError(err);
      const durationMs = Date.now() - t0;
      const message = timedOut
        ? `Per-location budget exceeded (${Math.round(perLocationBudgetMs / 1000)}s)`
        : (err?.message || String(err));

      // Task #2265 — a mid-sweep auth-missing error (token wiped / not
      // connected) is NOT this location's fault: route it to `paused_auth`
      // instead of `failed` so it shows no red pill and burns no attempt.
      // The next healthy sweep clears paused_auth rows back to queued
      // (see clearAllPausedAuthRows after the per-location loop). Mirrors the
      // top-of-sweep paused_auth gate (Task #1877) for the case where auth
      // disappears partway through a run.
      if (!timedOut && category === "auth_config") {
        try {
          await markStatePausedAuth(key, message.substring(0, 500), { resetAttempts: true });
        } catch (e: any) {
          console.warn(`[LocalDominanceSync] markPausedAuth persistence failed for loc=${mapping.locationId}: ${e?.message}`);
        }
        console.warn(`[LocalDominanceSync] loc=${mapping.locationId} camp=${mapping.semrushCampaignId} paused_auth mid-sweep (auth missing) — no attempt burned: ${message}`);
        return { terminalStatus: "paused_auth", lastError: err, attemptsUsed: Math.max(0, attempt - 1) };
      }

      try {
        const updated = await completeSyncAttempt({
          ...key,
          status: "failed",
          durationMs,
          message,
          errorCategory: category,
          lastError: message.substring(0, 500),
          // E-F01: see the success-path note — stale owners never clobber.
          expectedRunId: runId,
        });
        if (updated.staleRunIgnored) {
          workerLog({
            worker: "local_dominance_sync",
            event: "job_completion_stale_lease_ignored",
            detail: `failed-outcome write skipped for loc=${mapping.locationId} camp=${mapping.semrushCampaignId} — sync_state row re-claimed by a newer runId`,
          });
        }
      } catch (e: any) {
        console.warn(`[LocalDominanceSync] completeAttempt(failed) persistence failed for loc=${mapping.locationId}: ${e?.message}`);
      }

      console.warn(`[LocalDominanceSync] loc=${mapping.locationId} camp=${mapping.semrushCampaignId} attempt ${attempt}/${maxAttempts} failed (${category}): ${message}`);

      if (!isRetryableCategory(category)) {
        return { terminalStatus: "failed", lastError: err, attemptsUsed: attempt };
      }
      if (parentSignal?.aborted) {
        return { terminalStatus: "failed", lastError: err, attemptsUsed: attempt };
      }
      // else: loop will retry after backoff (or fall through after maxAttempts)
    }
  }

  return {
    terminalStatus: lastResult ? "failed" : "failed",
    lastError: lastErr,
    result: lastResult,
    attemptsUsed: maxAttempts,
  };
}

async function syncClientIntegration(
  integration: typeof clientSemrushIntegrations.$inferSelect,
  signal?: AbortSignal,
  instrumentation?: import("./workerLogger").SyncInstrumentation,
  options?: {
    origin?: WorkOriginLocal;
    restrictToLocationId?: string | null;
    /**
     * Workers/queues parity (E-F05): cooperative stop checked BETWEEN
     * locations (never mid-location, so in-flight work completes and no
     * attempt budget is burned). Only the scheduled sweep passes this —
     * manual/single-client paths are unaffected.
     */
    shouldStop?: () => boolean;
  }
): Promise<ClientIntegrationSyncOutcome> {
  const origin: WorkOriginLocal = options?.origin ?? "scheduled_background";
  const initSlot = await acquireOrSkipSlot("init", instrumentation, origin);
  try {
    await db.update(clientSemrushIntegrations)
      .set({ syncStatus: "syncing", updatedAt: new Date() })
      .where(eq(clientSemrushIntegrations.id, integration.id));
  } finally {
    initSlot.release();
  }

  const locationMappings = await db.select()
    .from(semrushLocationCampaigns)
    .where(eq(semrushLocationCampaigns.clientId, integration.clientId));

  const updateProgress = async (progress: { currentLocation: number; totalLocations: number; currentKeyword: number; totalKeywords: number; locationName?: string; keywordName?: string }) => {
    try {
      const progSlot = await acquireOrSkipSlot("progress", instrumentation, origin);
      try {
        await db.update(clientSemrushIntegrations)
          .set({
            syncProgress: JSON.stringify(progress),
            updatedAt: new Date(),
          })
          .where(eq(clientSemrushIntegrations.id, integration.id));
      } finally {
        progSlot.release();
      }
    } catch (e: any) {
      console.warn(`[LocalDominanceSync] Progress update failed for client ${integration.clientId}: ${e?.message || e}`);
    }
  };

  if (integration.semrushCampaignId && locationMappings.length === 0) {
    try {
      const result = await syncCampaignForClient(integration.clientId, integration.semrushCampaignId, integration.businessLocationId, integration.businessName, signal, async (kwIndex, kwTotal, kwName) => {
        await updateProgress({ currentLocation: 1, totalLocations: 1, currentKeyword: kwIndex, totalKeywords: kwTotal, locationName: integration.businessName || undefined, keywordName: kwName });
      }, instrumentation, { origin });
      if (result.skipped) {
        throw new Error(`Campaign ${integration.semrushCampaignId} skipped: ${result.skippedReason}`);
      }
      if (result.status === "failed") {
        const errorDetail = result.keywordErrors.length > 0
          ? ` Keyword errors: ${result.keywordErrors.slice(0, 3).join("; ")}${result.keywordErrors.length > 3 ? ` (+${result.keywordErrors.length - 3} more)` : ""}`
          : "";
        throw new Error(`Campaign ${integration.semrushCampaignId} sync failed: ${result.message || `coverage ${result.existingCoverageCount}/${result.expectedCoverageCount} for ${result.targetReportDate}`}.${errorDetail}`);
      }
      if (result.status === "already_current") {
        console.log(`[LocalDominanceSync] Campaign ${integration.semrushCampaignId} already current (${result.message})`);
        return {
          status: "already_current",
          summary: result.message ?? "Data already current",
          freshlyImported: 0,
          alreadyCurrentCount: 1,
          partialCount: 0,
          totalCampaigns: 1,
        };
      }
      if (result.status === "partial_success") {
        const warn = `Partial sync for campaign ${integration.semrushCampaignId}: ${result.message ?? `${result.imported}/${result.attempted} keywords imported, coverage ${result.existingCoverageCount}/${result.expectedCoverageCount}`}`;
        console.warn(`[LocalDominanceSync] ${warn}`);
        return {
          status: "partial_success",
          warningMessage: warn.substring(0, 500),
          summary: result.message,
          freshlyImported: 0,
          alreadyCurrentCount: 0,
          partialCount: 1,
          totalCampaigns: 1,
        };
      }
      return {
        status: "success",
        summary: result.message,
        freshlyImported: 1,
        alreadyCurrentCount: 0,
        partialCount: 0,
        totalCampaigns: 1,
      };
    } catch (err: any) {
      if (err instanceof SemrushNotFoundError) {
        throw new Error(`Campaign ${integration.semrushCampaignId} no longer exists in SEMrush. Please reconfigure in Settings.`);
      }
      throw err;
    }
  }

  if (locationMappings.length === 0) {
    throw new Error("No Semrush campaigns mapped to locations");
  }

  await cleanupOrphanedSnapshots(integration.clientId, locationMappings, instrumentation, { origin });
  // Drop per-location state rows that no longer have a corresponding mapping
  // — keeps the canonical state table aligned with current configuration.
  try {
    await pruneSyncStateOrphans(
      integration.clientId,
      locationMappings.map(m => ({ locationId: m.locationId, campaignId: m.semrushCampaignId })),
    );
  } catch (e: any) {
    console.warn(`[LocalDominanceSync] Per-location state orphan prune failed (non-fatal): ${e?.message || e}`);
  }

  let succeeded = 0;
  let alreadyCurrentCount = 0;
  let partialCount = 0;
  let failed = 0;
  let staleCount = 0;
  let noDataCount = 0;
  let pausedAuthCount = 0;
  const errors: string[] = [];
  const noDataReasons: string[] = [];
  const partialReasons: string[] = [];
  const pausedAuthReasons: string[] = [];
  let totalPrunedKeywords = 0;
  let inventoryIncompleteCount = 0;
  const inventoryIncompleteDetails: Array<{ campaignId: string; reason?: string }> = [];
  let cleanupFailedCount = 0;

  // Generate a per-orchestration runId so dashboard / observability can group
  // a wave of attempts. Each location row records this on its lastAttempt.
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const runTriggeredBy: "manual" | "scheduled" =
    origin === "user_manual" ? "manual" : "scheduled";

  // Allow caller (manual single-location retry path) to scope the run to one
  // mapping. Default: every mapping for the client.
  const restrictToLocationId = options?.restrictToLocationId ?? null;
  const targetMappings = restrictToLocationId
    ? locationMappings.filter(m => m.locationId === restrictToLocationId)
    : locationMappings;

  for (let i = 0; i < targetMappings.length; i++) {
    const mapping = targetMappings[i];
    // Honour a parent abort signal (e.g. server shutdown) but DO NOT propagate
    // a per-location timeout into siblings — each location gets its own
    // AbortController inside runLocationWithRetry().
    if (signal?.aborted) {
      console.log(`[LocalDominanceSync] Parent abort received — stopping further locations for client ${integration.clientId}`);
      break;
    }
    // E-F05: operator stop honored at the location boundary. The break
    // mirrors the parent-abort semantics above: already-synced locations
    // keep their recorded outcomes, the remainder stay in their prior
    // state for the next enabled sweep (never falsely failed).
    if (options?.shouldStop?.()) {
      workerLog({
        worker: "local_dominance_sync",
        event: "kill_switch_abort",
        killSwitch: "local_dominance_sync",
        detail: `operator stop honored at location boundary for client ${integration.clientId} (${i}/${targetMappings.length} locations processed) — remainder left for the next enabled sweep`,
      });
      break;
    }
    if (mapping.isStale) {
      staleCount++;
      try {
        await markStateStale(
          { clientId: integration.clientId, locationId: mapping.locationId, campaignId: mapping.semrushCampaignId },
          "campaign mapping flagged stale",
        );
      } catch (e: any) {
        console.warn(`[LocalDominanceSync] markStale state update failed (non-fatal): ${e?.message}`);
      }
      console.log(`[LocalDominanceSync] Skipping stale campaign ${mapping.semrushCampaignId} for location ${mapping.locationId}`);
      continue;
    }

    // Stagger the START of each location so we don't burst SEMrush. The wait
    // happens BEFORE we begin a per-location attempt — it does NOT consume
    // that location's wall-clock budget.
    if (i > 0) {
      await new Promise(r => setTimeout(r, PERF.SEMRUSH_CAMPAIGN_START_DELAY_MS));
    }

    const outcome = await runLocationWithRetry({
      integration,
      mapping,
      locIndex: i,
      totalLocations: targetMappings.length,
      runId,
      triggeredBy: runTriggeredBy,
      maxAttempts: LOCATION_MAX_ATTEMPTS,
      perLocationBudgetMs: LOCATION_BUDGET_MS,
      parentSignal: signal,
      instrumentation,
      origin,
      updateProgress,
    });

    const result = outcome.result;
    if (outcome.terminalStatus === "stale") {
      staleCount++;
      const staleSlot = await acquireOrSkipSlot("stale", instrumentation, origin);
      try {
        await db.update(semrushLocationCampaigns)
          .set({ isStale: true, staleSince: new Date() })
          .where(eq(semrushLocationCampaigns.id, mapping.id));
      } finally {
        staleSlot.release();
      }
      console.warn(`[LocalDominanceSync] Campaign ${mapping.semrushCampaignId} (${mapping.semrushCampaignName || 'unknown'}) returned 404 — marked as stale`);
    } else if (outcome.terminalStatus === "failed") {
      failed++;
      const errMsg = outcome.lastError?.message || "unknown error";
      errors.push(`Campaign ${mapping.semrushCampaignId}: ${errMsg}`);
      console.error(`[LocalDominanceSync] Failed campaign ${mapping.semrushCampaignId} for location ${mapping.locationId} after ${outcome.attemptsUsed} attempt(s): ${errMsg}`);
    } else if (outcome.terminalStatus === "paused_auth") {
      // Task #2265 — mid-sweep auth-missing. NOT a failure: the row is already
      // marked paused_auth (no red pill, no burned attempt) and will be cleared
      // back to queued on the next healthy sweep. Count separately so the
      // integration-level summary never reports it as failed/no-data.
      pausedAuthCount++;
      const reason = outcome.lastError?.message || "Semrush auth missing";
      pausedAuthReasons.push(`Campaign ${mapping.semrushCampaignId}: ${reason}`);
      console.warn(`[LocalDominanceSync] Campaign ${mapping.semrushCampaignId} for location ${mapping.locationId} paused_auth mid-sweep (no attempt burned): ${reason}`);
    } else if (result) {
      if (result.skipped) {
        noDataCount++;
        const reason = result.skippedReason || "skipped";
        noDataReasons.push(`Campaign ${mapping.semrushCampaignId}: ${reason}`);
        console.warn(`[LocalDominanceSync] Campaign ${mapping.semrushCampaignId} completed without data: ${reason}`);
      } else if (result.status === "failed") {
        // result.status==="failed" means partial keyword failures left coverage incomplete
        // — represented as noDataReasons here for the integration-level summary; the
        // per-location state row was already persisted as 'failed' inside the runner.
        noDataCount++;
        let reason = result.message || `coverage ${result.existingCoverageCount}/${result.expectedCoverageCount}`;
        if (result.keywordErrors.length > 0 && !reason.includes("Errors:")) {
          reason += ` (${result.keywordErrors.slice(0, 2).join("; ")}${result.keywordErrors.length > 2 ? ` +${result.keywordErrors.length - 2} more` : ""})`;
        }
        noDataReasons.push(`Campaign ${mapping.semrushCampaignId}: ${reason}`);
        console.warn(`[LocalDominanceSync] Campaign ${mapping.semrushCampaignId} failed: ${reason}`);
      } else if (result.status === "already_current") {
        succeeded++;
        alreadyCurrentCount++;
        console.log(`[LocalDominanceSync] Campaign ${mapping.semrushCampaignId} already current: ${result.message}`);
      } else if (result.status === "partial_success") {
        succeeded++;
        partialCount++;
        const reason = result.message || `${result.imported}/${result.attempted} keywords imported, coverage ${result.existingCoverageCount}/${result.expectedCoverageCount}`;
        partialReasons.push(`Campaign ${mapping.semrushCampaignId}: ${reason}`);
        console.warn(`[LocalDominanceSync] Campaign ${mapping.semrushCampaignId} partial_success: ${reason}`);
      } else {
        succeeded++;
      }
      if (typeof result.prunedKeywordsCount === "number") {
        totalPrunedKeywords += result.prunedKeywordsCount;
      }
      if (result.keywordInventoryComplete === false) {
        inventoryIncompleteCount++;
        inventoryIncompleteDetails.push({
          campaignId: mapping.semrushCampaignId,
          reason: result.keywordInventoryIncompleteReason,
        });
      }
      if (result.cleanupFailedReason) {
        cleanupFailedCount++;
      }
    }
  }

  if (succeeded === 0 && failed > 0) {
    throw new Error(`All ${failed} campaign syncs failed: ${errors[0]}`);
  }

  if (succeeded === 0 && staleCount > 0 && failed === 0 && noDataCount === 0) {
    throw new Error(`All ${staleCount} campaign(s) are stale (no longer found in SEMrush). Please reconfigure in Settings.`);
  }

  if (succeeded === 0 && noDataCount > 0 && failed === 0) {
    const detail = noDataReasons.slice(0, 3).join(". ");
    const extra = noDataReasons.length > 3 ? ` (+${noDataReasons.length - 3} more campaigns)` : "";
    throw new Error(`Sync completed but no data was imported from ${noDataCount} campaign(s). ${detail}${extra}`);
  }

  // Task #2265 — every location paused mid-sweep on missing auth and nothing
  // else ran. This is NOT a failure (no red pill, no burned attempt): the rows
  // are already paused_auth and the next healthy sweep clears them. Surface a
  // plain-English partial outcome instead of throwing (a throw would flip the
  // integration to `error`).
  if (succeeded === 0 && pausedAuthCount > 0 && failed === 0 && noDataCount === 0 && staleCount === 0) {
    const detail = pausedAuthReasons.slice(0, 2).join("; ");
    const extra = pausedAuthReasons.length > 2 ? ` (+${pausedAuthReasons.length - 2} more)` : "";
    const warningMessage = `Sync paused — Semrush authorization missing for ${pausedAuthCount} location(s); will auto-resume once reconnected. ${detail}${extra}`.substring(0, 500);
    return {
      status: "partial_success",
      warningMessage,
      summary: `${pausedAuthCount} paused (auth missing)`,
      freshlyImported: 0,
      alreadyCurrentCount: 0,
      partialCount: 0,
      totalCampaigns: locationMappings.length,
    };
  }

  // At this point succeeded > 0. Determine whether the overall outcome is a clean
  // success or a partial_success that needs to surface a warning to the operator.
  const freshlyImported = succeeded - alreadyCurrentCount - partialCount;
  const summaryParts: string[] = [];
  if (freshlyImported > 0) summaryParts.push(`${freshlyImported} freshly imported`);
  if (alreadyCurrentCount > 0) summaryParts.push(`${alreadyCurrentCount} already current`);
  if (partialCount > 0) summaryParts.push(`${partialCount} partially refreshed`);
  if (failed > 0) summaryParts.push(`${failed} failed`);
  if (noDataCount > 0) summaryParts.push(`${noDataCount} returned no data`);
  if (staleCount > 0) summaryParts.push(`${staleCount} stale`);
  if (pausedAuthCount > 0) summaryParts.push(`${pausedAuthCount} paused (auth missing)`);
  const summary = summaryParts.join(", ");

  // Cleanup observability — surface to operator regardless of overall status.
  const cleanupNotes: string[] = [];
  if (totalPrunedKeywords > 0) {
    cleanupNotes.push(`pruned ${totalPrunedKeywords} stale keyword snapshot(s)`);
  }
  if (inventoryIncompleteCount > 0) {
    const reasonLabels: Record<string, string> = {
      page_cap_reached: "page cap reached",
      aborted: "aborted",
      non_array_payload: "malformed payload",
    };
    const detailParts = inventoryIncompleteDetails.slice(0, 3).map(d => {
      const label = d.reason ? (reasonLabels[d.reason] ?? d.reason) : "reason unknown";
      return `${d.campaignId}: ${label}`;
    });
    const extra = inventoryIncompleteDetails.length > 3
      ? ` (+${inventoryIncompleteDetails.length - 3} more)`
      : "";
    const detailSuffix = detailParts.length > 0 ? ` (${detailParts.join("; ")}${extra})` : "";
    cleanupNotes.push(`${inventoryIncompleteCount} campaign(s) had incomplete keyword inventory${detailSuffix} — stale-keyword cleanup skipped`);
  }
  if (cleanupFailedCount > 0) {
    cleanupNotes.push(`${cleanupFailedCount} campaign(s) had cleanup errors (non-fatal)`);
  }

  const hasIncompleteSubset = failed > 0 || noDataCount > 0 || partialCount > 0 || staleCount > 0;
  // An incomplete keyword inventory means the dashboard's "available keywords"
  // for those campaigns may still include stale entries — operator needs to see
  // this even when every per-campaign sync technically succeeded.
  const cleanupRequiresWarning = inventoryIncompleteCount > 0 || cleanupFailedCount > 0;

  if (hasIncompleteSubset || cleanupRequiresWarning) {
    const warningParts: string[] = [];
    if (failed > 0 && errors.length > 0) {
      warningParts.push(`${failed} campaign(s) failed: ${errors.slice(0, 2).join("; ")}${errors.length > 2 ? ` (+${errors.length - 2} more)` : ""}`);
    }
    if (noDataCount > 0 && noDataReasons.length > 0) {
      warningParts.push(`${noDataCount} campaign(s) returned no data: ${noDataReasons.slice(0, 2).join("; ")}${noDataReasons.length > 2 ? ` (+${noDataReasons.length - 2} more)` : ""}`);
    }
    if (partialCount > 0 && partialReasons.length > 0) {
      warningParts.push(`${partialCount} partial: ${partialReasons.slice(0, 2).join("; ")}${partialReasons.length > 2 ? ` (+${partialReasons.length - 2} more)` : ""}`);
    }
    if (staleCount > 0) {
      warningParts.push(`${staleCount} campaign(s) marked stale`);
    }
    if (pausedAuthCount > 0) {
      warningParts.push(`${pausedAuthCount} paused (Semrush auth missing — auto-resumes once reconnected)`);
    }
    if (cleanupNotes.length > 0) {
      warningParts.push(cleanupNotes.join("; "));
    }
    // If the only reason we're surfacing a warning is cleanup observability
    // (no actual sync failures), keep the overall status as success and just
    // attach the warning so the operator sees the cleanup info.
    const status: "success" | "partial_success" = hasIncompleteSubset ? "partial_success" : "success";
    const prefix = hasIncompleteSubset ? "Partial sync" : "Sync complete";
    const warningMessage = `${prefix} — ${summary}. ${warningParts.join(". ")}`.substring(0, 500);
    return {
      status,
      warningMessage,
      summary,
      freshlyImported,
      alreadyCurrentCount,
      partialCount,
      totalCampaigns: locationMappings.length,
    };
  }

  const successSummary = cleanupNotes.length > 0 ? `${summary} (${cleanupNotes.join("; ")})` : summary;
  // If every campaign that succeeded was already current (none freshly imported),
  // surface that as a distinct outcome so the UI can render an "Already current"
  // pill instead of a generic success.
  const everythingAlreadyCurrent =
    freshlyImported === 0 && partialCount === 0 && alreadyCurrentCount > 0;
  const status: "success" | "already_current" = everythingAlreadyCurrent
    ? "already_current"
    : "success";
  return {
    status,
    summary: successSummary,
    freshlyImported,
    alreadyCurrentCount,
    partialCount,
    totalCampaigns: locationMappings.length,
  };
}

async function cleanupOrphanedSnapshots(
  clientId: string,
  locationMappings: Array<{ locationId: string; semrushCampaignId: string }>,
  instrumentation?: import("./workerLogger").SyncInstrumentation,
  options?: { origin?: WorkOriginLocal }
): Promise<void> {
  const origin: WorkOriginLocal = options?.origin ?? "scheduled_background";
  try {
    const validPairs = locationMappings.map(m => ({
      locationId: m.locationId,
      campaignId: m.semrushCampaignId,
    }));

    const allSnapshots = await db.select({
      id: heatmapSnapshots.id,
      locationId: heatmapSnapshots.locationId,
      campaignId: heatmapSnapshots.campaignId,
    })
      .from(heatmapSnapshots)
      .where(eq(heatmapSnapshots.clientId, clientId));

    const orphanedIds = allSnapshots
      .filter(s => !validPairs.some(p => p.locationId === s.locationId && p.campaignId === s.campaignId))
      .map(s => s.id);

    if (orphanedIds.length > 0) {
      // Cleanup is a real commit (bulk delete) — always use requiredSlot.
      // Origin only flows through so manual work can claim its reserved capacity.
      const cleanSlot = await requiredSlot("cleanup", instrumentation, origin);
      try {
        await db.delete(heatmapSnapshots)
          .where(inArray(heatmapSnapshots.id, orphanedIds));
      } finally {
        cleanSlot.release();
      }
      console.log(`[LocalDominanceSync] Cleaned up ${orphanedIds.length} orphaned snapshots for client ${clientId} (location-campaign mapping changed)`);
    }
  } catch (err: any) {
    console.warn(`[LocalDominanceSync] Orphaned snapshot cleanup failed (non-fatal): ${err?.message}`);
  }
}

const ACCEPTED_KEYWORD_STATUSES = new Set([
  "COLLECTED",
  "UNKNOWN",
  "ACTIVE",
  "IN_PROGRESS",
  "PENDING",
  "READY",
  "PROCESSING",
  "DONE",
]);

type SyncCampaignStatus = "success" | "already_current" | "partial_success" | "failed" | "skipped";

interface SyncCampaignResult {
  imported: number;
  attempted: number;
  skipped: boolean;
  skippedReason?: string;
  keywordErrors: string[];
  filteredStatuses: Record<string, number>;
  status: SyncCampaignStatus;
  targetReportDate: string | null;
  skippedAlreadyCurrent: number;
  expectedCoverageCount: number;
  existingCoverageCount: number;
  message?: string;
  keywordInventoryComplete?: boolean;
  keywordInventoryIncompleteReason?: import("./semrushApi").SemrushKeywordInventoryIncompleteReason;
  cleanupSkippedReason?: string | null;
  cleanupFailedReason?: string | null;
  prunedKeywordsCount?: number;
}

/**
 * Stale-keyword cleanup, extracted so the safety guards and identity
 * normalization are unit-testable without spinning up the full sync pipeline.
 *
 * Returns `{ cleanupSkippedReason, cleanupFailedReason, prunedKeywordsCount }`
 * matching the surface that `syncCampaignForClient` exposes in its result.
 *
 * Exported for tests (see `tests/stale-keyword-cleanup.test.ts`).
 */
export async function pruneStaleKeywordSnapshots(args: {
  clientId: string;
  campaignId: string;
  effectiveLocationId: string;
  dayStart: Date;
  dayEnd: Date;
  reportDateOnly: string;
  expectedKeywordNames: Set<string>;
  keywordListComplete: boolean;
  signal?: AbortSignal;
  instrumentation?: import("./workerLogger").SyncInstrumentation;
  origin: WorkOriginLocal;
}): Promise<{
  cleanupSkippedReason: string | null;
  cleanupFailedReason: string | null;
  prunedKeywordsCount: number;
}> {
  const {
    clientId, campaignId, effectiveLocationId, dayStart, dayEnd, reportDateOnly,
    expectedKeywordNames, keywordListComplete, signal, instrumentation, origin,
  } = args;
  // Use the canonical shared normalizer so cleanup identity matches the
  // write-path / coverage-check identity exactly.
  const expectedKeywordNamesNormalized = normalizedKeywordSet(expectedKeywordNames);
  let cleanupSkippedReason: string | null = null;
  let cleanupFailedReason: string | null = null;
  let prunedKeywordsCount = 0;
  if (!keywordListComplete) {
    cleanupSkippedReason = "keyword inventory incomplete";
  } else if (expectedKeywordNames.size === 0) {
    cleanupSkippedReason = "empty SEMrush keyword list";
  } else if (signal?.aborted) {
    cleanupSkippedReason = "sync aborted";
  } else {
    try {
      const currentDateSnaps = await db.select({
        id: heatmapSnapshots.id,
        keywordName: heatmapSnapshots.keywordName,
      })
        .from(heatmapSnapshots)
        .where(
          and(
            eq(heatmapSnapshots.clientId, clientId),
            eq(heatmapSnapshots.campaignId, campaignId),
            eq(heatmapSnapshots.locationId, effectiveLocationId),
            gte(heatmapSnapshots.reportDate, dayStart),
            lte(heatmapSnapshots.reportDate, dayEnd),
          )
        );
      const staleSnaps = currentDateSnaps.filter(
        s => !expectedKeywordNamesNormalized.has(normalizeKeyword(s.keywordName))
      );
      if (staleSnaps.length > 0) {
        const staleNames = Array.from(new Set(staleSnaps.map(s => s.keywordName))).slice(0, 5);
        const staleSlot = await requiredSlot("cleanup", instrumentation, origin);
        try {
          await db.delete(heatmapSnapshots)
            .where(inArray(heatmapSnapshots.id, staleSnaps.map(s => s.id)));
        } finally {
          staleSlot.release();
        }
        prunedKeywordsCount = staleSnaps.length;
        console.log(`[LocalDominanceSync] Campaign ${campaignId} loc=${effectiveLocationId} date=${reportDateOnly}: pruned ${staleSnaps.length} stale-keyword snapshot(s) no longer in SEMrush (sample: ${staleNames.join(", ")})`);
      }
    } catch (err: any) {
      cleanupFailedReason = err?.message || String(err);
      console.warn(`[LocalDominanceSync] Stale-keyword cleanup failed for campaign ${campaignId} loc=${effectiveLocationId} (non-fatal): ${cleanupFailedReason}`);
    }
  }
  return { cleanupSkippedReason, cleanupFailedReason, prunedKeywordsCount };
}

export async function syncCampaignForClient(
  clientId: string,
  campaignId: string,
  locationId: string | null | undefined,
  businessName: string | null | undefined,
  signal?: AbortSignal,
  onKeywordProgress?: (currentIndex: number, total: number, keywordName: string) => Promise<void>,
  instrumentation?: import("./workerLogger").SyncInstrumentation,
  options?: { origin?: WorkOriginLocal }
): Promise<SyncCampaignResult> {
  const origin: WorkOriginLocal = options?.origin ?? "scheduled_background";
  const realSemrushApi = await import("./semrushApi");
  const realHeatmapService = await import("./heatmapService");
  const semrushApi: SemrushApiSubset = { ...realSemrushApi, ...(__testSemrushApiOverride ?? {}) };
  const heatmapServiceMod: HeatmapServiceSubset = { ...realHeatmapService, ...(__testHeatmapServiceOverride ?? {}) };
  const { getCampaign, getCampaignKeywordsWithMeta, getHeatmapData, findBestReportDate } = semrushApi;
  const { importHeatmap } = heatmapServiceMod;

  const campaign = await getCampaign(campaignId, signal);

  let reportDate: string | null = null;
  if (campaign.reportDates && Array.isArray(campaign.reportDates) && campaign.reportDates.length > 0) {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    reportDate = findBestReportDate(campaign.reportDates, currentMonth);
    if (!reportDate) {
      reportDate = campaign.reportDates[0];
    }
  } else {
    console.warn(`[LocalDominanceSync] Campaign ${campaignId} has no reportDates available — skipping`);
    return {
      imported: 0,
      attempted: 0,
      skipped: true,
      skippedReason: "No report dates available",
      keywordErrors: [],
      filteredStatuses: {},
      status: "skipped",
      targetReportDate: null,
      skippedAlreadyCurrent: 0,
      expectedCoverageCount: 0,
      existingCoverageCount: 0,
      message: "No report dates available",
    };
  }

  const { keywords, complete: keywordListComplete, incompleteReason: keywordListIncompleteReason } = await getCampaignKeywordsWithMeta(campaignId, signal);

  const filteredStatuses: Record<string, number> = {};
  const activeKeywords = keywords.filter(kw => {
    const status = (kw.status || "UNKNOWN").toUpperCase();
    if (ACCEPTED_KEYWORD_STATUSES.has(status)) {
      return true;
    }
    filteredStatuses[status] = (filteredStatuses[status] || 0) + 1;
    return false;
  });

  const filteredOutEntries = Object.entries(filteredStatuses);
  if (filteredOutEntries.length > 0) {
    const statusSummary = filteredOutEntries.map(([s, c]) => `${s}=${c}`).join(", ");
    console.warn(`[LocalDominanceSync] Campaign ${campaignId}: filtered out ${keywords.length - activeKeywords.length} keywords with unrecognized statuses: ${statusSummary}`);
  }

  if (activeKeywords.length === 0) {
    const allStatuses = keywords.map(kw => kw.status || "UNKNOWN");
    const statusCounts = allStatuses.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {} as Record<string, number>);
    const statusDetail = Object.entries(statusCounts).map(([s, c]) => `${s}=${c}`).join(", ");
    const reason = keywords.length === 0
      ? "No keywords returned from SEMrush"
      : `All ${keywords.length} keywords were filtered out (statuses: ${statusDetail}). Accepted statuses: ${Array.from(ACCEPTED_KEYWORD_STATUSES).join(", ")}`;
    console.warn(`[LocalDominanceSync] No active keywords for campaign ${campaignId}: ${reason}`);
    return {
      imported: 0,
      attempted: 0,
      skipped: true,
      skippedReason: reason,
      keywordErrors: [],
      filteredStatuses,
      status: "skipped",
      targetReportDate: reportDate,
      skippedAlreadyCurrent: 0,
      expectedCoverageCount: 0,
      existingCoverageCount: 0,
      message: reason,
    };
  }

  const effectiveLocationId = locationId || `client-${clientId}`;
  const targetReportDate: string = reportDate!;
  const reportDateObj = new Date(targetReportDate);
  const reportDateOnly = reportDateObj.toISOString().split("T")[0];
  const dayStart = new Date(reportDateOnly + "T00:00:00.000Z");
  const dayEnd = new Date(reportDateOnly + "T23:59:59.999Z");

  // Coverage identity must match importHeatmap's snapshot uniqueness
  // (campaignId + locationId + normalize(keywordName) + reportDate-day).
  // Dedupe the expected keyword set by CANONICAL (normalized) name so that
  // duplicate-by-casing/whitespace keywords returned by SEMrush don't make
  // full coverage mathematically impossible AND so that snapshots stored
  // under any casing/whitespace variant still count as covered.
  const seenNormalized = new Set<string>();
  const seenKeywordNames = new Set<string>();
  const uniqueActiveKeywords = activeKeywords.filter(k => {
    const norm = normalizeKeyword(k.name);
    if (seenNormalized.has(norm)) return false;
    seenNormalized.add(norm);
    seenKeywordNames.add(k.name);
    return true;
  });
  const expectedKeywordNames = seenKeywordNames;
  const expectedKeywordNamesNorm = seenNormalized;
  const expectedCoverageCount = uniqueActiveKeywords.length;
  if (uniqueActiveKeywords.length !== activeKeywords.length) {
    console.log(`[LocalDominanceSync] Campaign ${campaignId}: deduped ${activeKeywords.length - uniqueActiveKeywords.length} duplicate keyword name(s) for coverage accounting`);
  }

  const queryExistingCoverage = async (): Promise<Set<string>> => {
    const rows = await db.select({ keywordName: heatmapSnapshots.keywordName })
      .from(heatmapSnapshots)
      .where(
        and(
          eq(heatmapSnapshots.campaignId, campaignId),
          eq(heatmapSnapshots.locationId, effectiveLocationId),
          gte(heatmapSnapshots.reportDate, dayStart),
          lte(heatmapSnapshots.reportDate, dayEnd),
        )
      );
    const set = new Set<string>();
    for (const r of rows) {
      // Match by normalized form so that "Plumber " and "plumber" both
      // count as coverage for the same expected keyword. Store the
      // normalized form in the returned set so callers can compare against
      // the same canonical identity regardless of which casing variant
      // landed in the DB.
      const norm = normalizeKeyword(r.keywordName);
      if (expectedKeywordNamesNorm.has(norm)) set.add(norm);
    }
    return set;
  };

  let existingCoverage: Set<string>;
  try {
    existingCoverage = await queryExistingCoverage();
  } catch (e: any) {
    console.warn(`[LocalDominanceSync] Preflight coverage check failed for campaign ${campaignId}: ${e?.message || e} — proceeding without skip optimization`);
    existingCoverage = new Set();
  }

  // Stale-keyword cleanup (current report date ONLY).
  //
  // Why current-date-only: a keyword removed from a SEMrush campaign should
  // disappear from the *current* dashboard view, but its historical snapshots
  // from prior months are legitimate audit data and must NOT be deleted.
  // Combined with the read-path change in localDominanceService that derives
  // `availableKeywords` from the latest report date per campaign/location, this
  // gives defense in depth without erasing history.
  //
  // Safety guards (must ALL hold or cleanup is skipped):
  //   1. `keywordListComplete` — pagination reached true end-of-list. A
  //      partial list (abort, MAX_PAGES cap, ambiguous pagination) could
  //      otherwise wrongly delete legitimate snapshots that simply weren't
  //      fetched in this run.
  //   2. `expectedKeywordNames.size > 0` — a transient empty SEMrush response
  //      can't wipe a location's current data.
  //   3. `!signal?.aborted` — don't mutate state during teardown.
  //
  // Identity comparison is normalized (trim + lowercase) so a casing or
  // whitespace difference between the SEMrush response and a stored snapshot
  // ("Divorce Lawyer" vs "divorce lawyer") cannot trigger a false-positive
  // delete. Snapshots are still deleted by id, so the comparison is purely
  // for the "should this row stay?" decision.
  const cleanup = await pruneStaleKeywordSnapshots({
    clientId,
    campaignId,
    effectiveLocationId,
    dayStart,
    dayEnd,
    reportDateOnly,
    expectedKeywordNames,
    keywordListComplete,
    signal,
    instrumentation,
    origin,
  });
  const cleanupSkippedReason = cleanup.cleanupSkippedReason;
  const cleanupFailedReason = cleanup.cleanupFailedReason;
  const prunedKeywordsCount = cleanup.prunedKeywordsCount;

  const missingKeywords = uniqueActiveKeywords.filter(
    k => !existingCoverage.has(normalizeKeyword(k.name)),
  );
  const skippedAlreadyCurrent = expectedCoverageCount - missingKeywords.length;

  if (missingKeywords.length === 0) {
    const message = `Data already current for ${reportDateOnly} (${skippedAlreadyCurrent}/${expectedCoverageCount} keywords)`;
    console.log(`[LocalDominanceSync] Campaign ${campaignId} ${message} — skipping SEMrush fetches`);
    return {
      imported: 0,
      attempted: 0,
      skipped: false,
      keywordErrors: [],
      filteredStatuses,
      status: "already_current",
      targetReportDate: reportDate,
      skippedAlreadyCurrent,
      expectedCoverageCount,
      existingCoverageCount: skippedAlreadyCurrent,
      message,
      keywordInventoryComplete: keywordListComplete,
      keywordInventoryIncompleteReason: keywordListIncompleteReason,
      cleanupSkippedReason,
      cleanupFailedReason,
      prunedKeywordsCount,
    };
  }

  const grid = campaign.gridSettings || campaign.grid || {};
  const campaignCid = campaign.business?.cid || campaign.cid;
  const campaignPlaceIds = campaign.business?.placeIds || campaign.placeIds;
  let importedCount = 0;
  const keywordErrors: string[] = [];

  // Per-keyword heatmap fetches are the slowest part of a sync (each
  // /campaigns/:id/heatmap call typically takes several seconds because SEMrush
  // walks a 9x9 grid). Running them serially used to push large multi-keyword
  // campaigns past the 9-15 minute manual-sync timeout, leaving the campaign in
  // partial_success with random keywords missing. Run them with bounded
  // concurrency (PERF.SEMRUSH_HEATMAP_CONCURRENCY, default 2) so a typical
  // 10-keyword campaign completes in roughly half the time without exceeding
  // the same per-call rate-limit budget the rest of the SEMrush pipeline uses.
  const heatmapConcurrency = Math.max(1, PERF.SEMRUSH_HEATMAP_CONCURRENCY ?? 2);
  let cursor = 0;
  let progressCounter = 0;

  async function processKeyword(kw: { id: string; name: string; status: string }): Promise<void> {
    if (signal?.aborted) return;
    const myProgress = ++progressCounter;
    if (onKeywordProgress) {
      try {
        await onKeywordProgress(myProgress, missingKeywords.length, kw.name || kw.id);
      } catch (_) {}
    }
    try {
      const heatmapOpts: { cid?: string; placeIds?: string[] } = {};
      if (campaignCid) heatmapOpts.cid = campaignCid;
      if (campaignPlaceIds?.length) heatmapOpts.placeIds = campaignPlaceIds;
      // Task #2893 — per-keyword report-date fallback: SEMrush returns a
      // non-retryable "wasn't collected" 400 when THIS keyword has no
      // collection at the campaign-level date. Retry against other campaign
      // report dates (bounded) before recording a keyword error. Any other
      // error still fails the keyword immediately (handled by the existing
      // retry pass / location backoff).
      const { fetchHeatmapWithDateFallback } = await import("./heatmapReportDateFallback");
      const { result: heatmapResult, usedFallback, reportDateUsed } =
        await fetchHeatmapWithDateFallback({
          fetchAtDate: (rd) => getHeatmapData(campaignId, kw.id, { ...heatmapOpts, reportDate: rd }, signal),
          selectedReportDate: reportDate!,
          reportDates: campaign.reportDates || [],
          keywordName: kw.name,
        });
      if (usedFallback) {
        console.log(`[LocalDominanceSync] Keyword "${kw.name}" had no data at ${reportDate}; imported from fallback report date ${reportDateUsed} (campaign ${campaignId})`);
      }

      let resolvedLocationName = businessName || campaign.businessName || "Unknown Location";
      if (locationId) {
        try {
          const [loc] = await db.select({ name: clientLocations.name })
            .from(clientLocations)
            .where(eq(clientLocations.id, locationId))
            .limit(1);
          if (loc?.name) {
            resolvedLocationName = loc.name;
          }
        } catch (e) {
          // fall back to businessName
        }
      }

      const payload = {
        clientId,
        locationId: locationId || `client-${clientId}`,
        locationName: resolvedLocationName,
        businessName: businessName || campaign.businessName,
        campaignId,
        keywordId: kw.id,
        // Use kw.name (the SEMrush /campaigns/:id/keywords value) as the
        // canonical keywordName because expectedKeywordNames / existingCoverage
        // are built from it. importHeatmap dedupes snapshots by
        // (campaignId, locationId, keywordName, reportDate-day), so if the
        // /heatmap response ever returns a different `keyword.name` for two
        // distinct kw.id values (e.g. the campaign's primary keyword echoed
        // back), every per-keyword import after the first would collide on the
        // existing snapshot row, leaving the campaign permanently in
        // partial_success with only one keyword pulled. Falling back to the
        // heatmap response's name preserves the prior behavior only when the
        // canonical name is somehow empty.
        keywordName: kw.name || heatmapResult.keyword.name,
        reportDate: heatmapResult.date,
        businessLat: grid.basePoint?.lat || campaign.lat || 0,
        businessLng: grid.basePoint?.lng || campaign.lng || 0,
        gridTemplate: grid.template || "9x9",
        gridUnit: grid.unit || "MILES",
        gridDistance: grid.distance || 5,
        baseLat: grid.basePoint?.lat || campaign.lat || 0,
        baseLng: grid.basePoint?.lng || campaign.lng || 0,
        pointsNumber: heatmapResult.positions.length,
        points: heatmapResult.positions.map((p: any) => ({
          id: p.point.id,
          lat: p.point.lat,
          lng: p.point.lng,
          position: p.rank,
          diff: p.diff,
        })),
        cid: campaignCid,
        placeIds: campaignPlaceIds,
        campaignReportDates: campaign.reportDates || [],
      };

      // Per-keyword heatmap import is a real commit — always use requiredSlot.
      // Origin only flows through so manual work can claim its reserved capacity.
      const importSlot = await requiredSlot("import-heatmap", instrumentation, origin);
      try {
        await importHeatmap(payload, signal);
      } finally {
        importSlot.release();
      }
      importedCount++;
    } catch (kwErr: any) {
      const errMsg = kwErr?.message || String(kwErr);
      keywordErrors.push(`"${kw.name}": ${errMsg}`);
      console.error(`[LocalDominanceSync] Failed keyword "${kw.name}" (${kw.id}) for client ${clientId}: ${errMsg}`);
    } finally {
      try {
        const hbSlot = await acquireOrSkipSlot("heartbeat", instrumentation, origin);
        try {
          await db.update(clientSemrushIntegrations)
            .set({ updatedAt: new Date() })
            .where(eq(clientSemrushIntegrations.clientId, clientId));
        } finally {
          hbSlot.release();
        }
      } catch (heartbeatErr: any) {
        console.warn(`[LocalDominanceSync] Heartbeat update failed for client ${clientId}: ${heartbeatErr?.message || heartbeatErr}`);
      }
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) return;
      const myIdx = cursor++;
      if (myIdx >= missingKeywords.length) return;
      // Stagger worker starts and per-call requests to respect the same
      // SEMrush rate-limit budget the rest of the pipeline uses.
      if (myIdx > 0) {
        await new Promise(r => setTimeout(r, PERF.SEMRUSH_CAMPAIGN_START_DELAY_MS));
      }
      await processKeyword(missingKeywords[myIdx]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(heatmapConcurrency, missingKeywords.length) }, () => worker())
  );

  if (signal?.aborted) {
    console.log(`[LocalDominanceSync] Sync aborted for client ${clientId} — keyword loop stopped early at campaign ${campaignId}`);
  }

  // Task #1877: keyword-level retry pass.
  //
  // Previously a single per-keyword fetch failure (rate-limit / 5xx / transient
  // network blip) left the location in `partial_success` because the only
  // recovery mechanism was the location-level auto-retry, which re-fetches
  // the entire keyword inventory and the OAuth dance. That's both expensive
  // and risky: between runs SEMrush may publish a newer `reportDate`, so what
  // looks like a "retry" of last attempt's missing keywords actually targets
  // a different snapshot date and never fills the original gap.
  //
  // This single bounded retry pass:
  //   • only fires when at least one keyword imported successfully AND at
  //     least one failed (the "partial" wedge that retries can actually
  //     help — pure-fail and pure-success cases are unchanged);
  //   • re-runs ONLY the keywords that errored, capped by
  //     PERF.SEMRUSH_KEYWORD_RETRY_LIMIT (default 5) to prevent a runaway
  //     burn if SEMrush is wholesale unhappy;
  //   • preserves the EXACT `reportDate` already chosen for the campaign
  //     (the worker's `reportDate` is closed over by `processKeyword` via
  //     `heatmapOpts.reportDate`), so a successful retry fills the original
  //     snapshot rather than a newer one that wouldn't satisfy coverage;
  //   • does NOT pause between keywords beyond the existing per-call delay
  //     (the cause was transient, not a sustained rate-limit — that gets
  //     handled by the location-level backoff curve).
  const keywordRetryLimit = Math.max(0, Math.min(
    20,
    (PERF as any).SEMRUSH_KEYWORD_RETRY_LIMIT ?? 5,
  ));
  if (
    keywordRetryLimit > 0 &&
    !signal?.aborted &&
    importedCount > 0 &&
    keywordErrors.length > 0 &&
    importedCount < missingKeywords.length
  ) {
    // Re-discover which keywords are still missing — use the canonical
    // (normalized) coverage set so a keyword that landed mid-loop after
    // its error counter incremented isn't pointlessly re-fetched.
    let coverageNow: Set<string>;
    try {
      coverageNow = await queryExistingCoverage();
    } catch {
      coverageNow = new Set();
    }
    const stillMissing = missingKeywords.filter(
      k => !coverageNow.has(normalizeKeyword(k.name)),
    );
    const retryBatch = stillMissing.slice(0, keywordRetryLimit);
    if (retryBatch.length > 0) {
      console.log(`[LocalDominanceSync] Campaign ${campaignId}: retrying ${retryBatch.length}/${stillMissing.length} keyword(s) that failed on first pass (reportDate=${reportDateOnly})`);
      const beforeRetryImported = importedCount;
      const beforeRetryErrors = keywordErrors.length;
      // Clear errors for the keywords we're about to retry so a successful
      // second attempt doesn't leave a stale "failed keyword" line in the
      // surfaced reason. Keyword errors are reported as plain strings so we
      // match on the leading `"name":` prefix.
      const retryNameSet = new Set(retryBatch.map(k => `"${k.name}":`));
      for (let i = keywordErrors.length - 1; i >= 0; i--) {
        for (const prefix of retryNameSet) {
          if (keywordErrors[i].startsWith(prefix)) {
            keywordErrors.splice(i, 1);
            break;
          }
        }
      }
      for (const kw of retryBatch) {
        if (signal?.aborted) break;
        await processKeyword(kw);
      }
      const retryGained = importedCount - beforeRetryImported;
      const retryStillFailed = keywordErrors.length - (beforeRetryErrors - retryNameSet.size);
      console.log(`[LocalDominanceSync] Campaign ${campaignId}: keyword retry pass — ${retryGained}/${retryBatch.length} recovered, ${retryStillFailed} still failing`);
    }
  }

  let finalCoverageCount = skippedAlreadyCurrent + importedCount;
  try {
    const finalCoverage = await queryExistingCoverage();
    finalCoverageCount = finalCoverage.size;
  } catch (e: any) {
    console.warn(`[LocalDominanceSync] Post-attempt coverage check failed for campaign ${campaignId}: ${e?.message || e} — using counted values`);
  }

  const isComplete = finalCoverageCount >= expectedCoverageCount;
  let status: SyncCampaignStatus;
  let message: string;
  if (isComplete && importedCount === 0) {
    status = "already_current";
    message = `Data already current for ${reportDateOnly} (${finalCoverageCount}/${expectedCoverageCount} keywords; concurrent import filled gaps)`;
    console.log(`[LocalDominanceSync] Campaign ${campaignId} ${message}`);
  } else if (isComplete) {
    status = "success";
    message = `Imported ${importedCount} new keyword(s); ${skippedAlreadyCurrent} already current; coverage ${finalCoverageCount}/${expectedCoverageCount} for ${reportDateOnly}`;
    console.log(`[LocalDominanceSync] Campaign ${campaignId} completed: ${importedCount}/${missingKeywords.length} new keywords imported, ${keywordErrors.length} failed, ${skippedAlreadyCurrent} already current`);
  } else if (importedCount > 0) {
    status = "partial_success";
    message = `Partial refresh for ${reportDateOnly}: imported ${importedCount}/${missingKeywords.length} missing keyword(s); coverage ${finalCoverageCount}/${expectedCoverageCount}`;
    console.warn(`[LocalDominanceSync] Campaign ${campaignId} partial: ${importedCount}/${missingKeywords.length} imported, coverage ${finalCoverageCount}/${expectedCoverageCount}`);
  } else {
    status = "failed";
    const errorSummary = keywordErrors.length > 0
      ? `. Errors: ${keywordErrors.slice(0, 5).join("; ")}${keywordErrors.length > 5 ? ` (+${keywordErrors.length - 5} more)` : ""}`
      : "";
    message = `0/${missingKeywords.length} missing keyword(s) imported for ${reportDateOnly}; coverage ${finalCoverageCount}/${expectedCoverageCount}${errorSummary}`;
    console.warn(`[LocalDominanceSync] Campaign ${campaignId} failed: ${message}`);
  }

  return {
    imported: importedCount,
    attempted: missingKeywords.length,
    skipped: false,
    keywordErrors,
    filteredStatuses,
    status,
    targetReportDate: reportDate,
    skippedAlreadyCurrent,
    expectedCoverageCount,
    existingCoverageCount: finalCoverageCount,
    message,
    keywordInventoryComplete: keywordListComplete,
    keywordInventoryIncompleteReason: keywordListIncompleteReason,
    cleanupSkippedReason,
    cleanupFailedReason,
    prunedKeywordsCount,
  };
}

export async function syncSingleClient(clientId: string, options?: { origin?: WorkOriginLocal; restrictToLocationId?: string | null }): Promise<{
  success: boolean;
  synced?: number;
  failed?: number;
  error?: string;
}> {
  // Default to user_manual: this entry point is always reached via a user-triggered
  // route (POST /api/clients/:id/semrush-sync). Background reconciliation uses
  // syncAllActiveClients → syncClientIntegration directly.
  const origin: WorkOriginLocal = options?.origin ?? "user_manual";
  const rows = await db.select()
    .from(clientSemrushIntegrations)
    .where(eq(clientSemrushIntegrations.clientId, clientId))
    .limit(1);

  if (!rows[0]) {
    return { success: false, error: "No integration configured" };
  }

  const integration = rows[0];

  const locationMappings = await db.select()
    .from(semrushLocationCampaigns)
    .where(eq(semrushLocationCampaigns.clientId, clientId));

  if (!integration.semrushCampaignId && locationMappings.length === 0) {
    const errorMsg = "No Semrush campaigns mapped to locations";
    await db.update(clientSemrushIntegrations)
      .set({
        syncStatus: "error",
        lastFailedSyncAt: new Date(),
        errorMessage: errorMsg,
        // E-F16 typed-failure parity: deterministic config failure — no
        // campaign↔location mapping exists (same category the sync_state
        // vocabulary uses for mapping-not-found).
        errorCategory: "invalid_mapping",
        lastSyncOutcome: "error",
        lastSyncSummary: errorMsg,
        updatedAt: new Date(),
      })
      .where(eq(clientSemrushIntegrations.id, integration.id));
    return { success: false, error: errorMsg };
  }

  const uniqueCampaignIds = new Set(locationMappings.map(m => m.semrushCampaignId));
  if (integration.semrushCampaignId) uniqueCampaignIds.add(integration.semrushCampaignId);
  const campaignCount = uniqueCampaignIds.size;
  const locationCount = locationMappings.length;

  // Per-location budgets are now enforced inside runLocationWithRetry — there is
  // no shared abort signal that could cascade a slow location into killing
  // siblings. We keep an outer hard ceiling only as a defence-in-depth against
  // a runaway pipeline; it must be loose enough to never fire under normal
  // multi-location workloads. Per task #681: NOT solved by raising the global
  // timeout — the global timeout is just a backstop.
  const HARD_CEILING_MS = 60 * 60 * 1000;
  console.log(`[LocalDominanceSync] Manual sync starting for client ${clientId} (${locationCount} locations, ${campaignCount} campaigns); per-location budget enforced inside runner.`);

  const abortController = new AbortController();
  const ceilingHandle = setTimeout(() => abortController.abort(), HARD_CEILING_MS);

  await db.update(clientSemrushIntegrations)
    .set({ syncProgress: null, updatedAt: new Date() })
    .where(eq(clientSemrushIntegrations.id, integration.id));

  try {
    const outcome = await syncClientIntegration(
      integration,
      abortController.signal,
      undefined,
      { origin, restrictToLocationId: options?.restrictToLocationId ?? null },
    );

    await db.update(clientSemrushIntegrations)
      .set({
        syncStatus: "success",
        lastSuccessfulSyncAt: new Date(),
        errorMessage: null,
        errorCategory: null,
        warningMessage: outcome.warningMessage ?? null,
        lastSyncOutcome: outcome.status,
        lastSyncSummary: outcome.summary ?? null,
        syncProgress: null,
        updatedAt: new Date(),
      })
      .where(eq(clientSemrushIntegrations.id, integration.id));

    return { success: true, synced: locationMappings.length || 1, failed: 0 };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);

    await db.update(clientSemrushIntegrations)
      .set({
        syncStatus: "error",
        lastFailedSyncAt: new Date(),
        errorMessage: errorMsg.substring(0, 500),
        // E-F16 typed-failure parity: machine-readable classification beside
        // the raw text (same classifier as the sync_state rows).
        errorCategory: classifyLocationSyncError(err),
        lastSyncOutcome: "error",
        lastSyncSummary: errorMsg.substring(0, 500),
        syncProgress: null,
        updatedAt: new Date(),
      })
      .where(eq(clientSemrushIntegrations.id, integration.id));

    return { success: false, error: errorMsg };
  } finally {
    clearTimeout(ceilingHandle);
  }
}
