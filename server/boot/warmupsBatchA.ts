/**
 * Boot — deferred warmups batch A.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * independent DB warmups and cache hydrations (parallel, fail-soft).
 */

import { loadRateLimitMultipliers, startRateLimitMultipliersRefresh } from "../routes/middleware";
import {
  loadBlockedIPsFromDB,
  loadAlertThresholdsFromDB,
  loadDefaultBlockDurationFromDB,
  loadBlockedEventsRetentionFromDB,
  loadBlockedRateLimitEventsFromDB,
  startBlockedRateLimitEventsPruneTimer,
} from "../services/rateLimitMonitor";
import { withDbAttribution as _withDbAttribution } from "../db";
import { shouldRunFrontBackgroundWorkers } from "../lib/deploymentEnv";
import { log } from "./httpApp";

export function kickWarmupsBatchA(): void {
  // Batch A: independent DB warmups and cache hydrations (parallel).
  void _withDbAttribution("startup:deferred-warmups", async () => {
    await Promise.allSettled([
      // Rate-limit loaders
      (async () => {
        try {
          await loadRateLimitMultipliers();
          startRateLimitMultipliersRefresh();
        } catch (err) { console.warn("[Bootstrap] loadRateLimitMultipliers failed:", err); }
      })(),
      (async () => {
        try {
          await loadBlockedIPsFromDB();
          await loadAlertThresholdsFromDB();
          await loadDefaultBlockDurationFromDB();
          await loadBlockedEventsRetentionFromDB();
          await loadBlockedRateLimitEventsFromDB();
          startBlockedRateLimitEventsPruneTimer();
        } catch (err) { console.warn("[Bootstrap] rate-limit IP/threshold loaders failed:", err); }
      })(),
      (async () => {
        try {
          const { loadAutoTunePersistedState } = await import("../services/rateLimitAutoTuner");
          await loadAutoTunePersistedState();
        } catch (err) { console.warn("[AutoTuner] Failed to restore persisted state:", err); }
      })(),
      (async () => {
        try {
          const { warmMatchSettingsCache } = await import("../services/matchSettings");
          await warmMatchSettingsCache();
        } catch (err) { console.warn("[matchSettings] startup warm failed:", err); }
      })(),
      // Front recovery job hydration
      (async () => {
        try {
          const { listRecoveryJobs } = await import("../services/frontHistoricalRecovery");
          const jobs = await listRecoveryJobs();
          log(`[FrontRecovery] Hydrated ${jobs.length} persisted recovery job(s) on startup`);
        } catch (err) { console.warn("[FrontRecovery] startup hydration failed:", err); }
      })(),
      // Task #2289 — the recovery prune sweep is a Front background worker; gate
      // it to the deployment so the workspace process is not a second instance
      // touching recovery state (and, transitively, the Front OAuth refresher).
      (async () => {
        if (shouldRunFrontBackgroundWorkers()) {
          try {
            const { startRecoveryPruneSweepFromSettings } = await import("../services/frontHistoricalRecovery");
            await startRecoveryPruneSweepFromSettings();
          } catch (err) { console.warn("[FrontRecovery] failed to start prune sweep:", err); }
        } else {
          log("[FrontRecovery] prune sweep skipped (workspace) — deployment owns Front recovery workers (Task #2289)");
        }
      })(),
      // Auth breaker hydrations (all independent)
      // Task #2103 — re-hydrate the Front auth-dead breaker.
      (async () => {
        try {
          const { hydrateFrontAuthBreakerFromStore } = await import("../services/frontAuthBreaker");
          const { breakerOpen } = await hydrateFrontAuthBreakerFromStore();
          log(`[FrontAuthBreaker] Hydrated durable breaker on startup (open=${breakerOpen})`);
        } catch (err) { console.warn("[FrontAuthBreaker] startup hydration failed:", err); }
      })(),
      // Task #2122 — same durable re-hydration for Zoom / SEMrush auth
      // breakers. (Google Ads left this family in Task #4008: its auth state
      // is the shared env-trio mint's in-process negative cache, nothing
      // durable to hydrate.)
      (async () => {
        try {
          const { hydrateSemrushAuthBreakerFromStore } = await import("../services/semrushAuthBreaker");
          const { breakerOpen } = await hydrateSemrushAuthBreakerFromStore();
          log(`[SemrushAuthBreaker] Hydrated durable breaker on startup (open=${breakerOpen})`);
        } catch (err) { console.warn("[SemrushAuthBreaker] startup hydration failed:", err); }
      })(),
      (async () => {
        try {
          const { hydrateZoomAuthGateFromStore } = await import("../services/zoomIntegration");
          const { gateOpen } = await hydrateZoomAuthGateFromStore();
          log(`[ZoomAuthGate] Hydrated durable gate on startup (open=${gateOpen})`);
        } catch (err) { console.warn("[ZoomAuthGate] startup hydration failed:", err); }
      })(),
      // Task #2984 — restore any in-flight ClickUp per-user auth breakers.
      (async () => {
        try {
          const { hydrateClickUpAuthBreakers } = await import("../services/clickUpBreakerPersistence");
          await hydrateClickUpAuthBreakers();
        } catch (err) { console.warn("[ClickUpBreaker] startup hydration failed:", err); }
      })(),
      // Task #2663 — re-hydrate the Replit Auth session-refresh breaker's aggregate telemetry.
      (async () => {
        try {
          const { hydrateReplitAuthBreakerFromStore } = await import("../services/replitAuthBreaker");
          const { breakerOpen } = await hydrateReplitAuthBreakerFromStore();
          log(`[ReplitAuthBreaker] Hydrated durable breaker on startup (open=${breakerOpen})`);
        } catch (err) { console.warn("[ReplitAuthBreaker] startup hydration failed:", err); }
      })(),
      // Task #824: rehydrate filter-rule retroactive-apply jobs from work_queue.
      (async () => {
        try {
          const { hydrateFilterRuleApplyJobs } = await import("../services/frontFilterRules");
          const result = await hydrateFilterRuleApplyJobs();
          log(
            `[FrontFilterRules] Hydrated ${result.rehydrated} apply job(s) on startup ` +
              `(watchers resumed: ${result.watchersResumed}, orphans failed: ${result.orphansFailed})`,
          );
        } catch (err) { console.warn("[FrontFilterRules] startup hydration failed:", err); }
      })(),
    ]);
  });
}
