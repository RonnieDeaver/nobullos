/**
 * Boot — graceful shutdown.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * trackTimer, gracefulShutdown, SIGTERM/SIGINT hooks.
 */


export let isGracefulShutdown = false;
const backgroundTimerIds: ReturnType<typeof setTimeout>[] = [];

export function trackTimer(timerId: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  backgroundTimerIds.push(timerId);
  return timerId;
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (isGracefulShutdown) return;
  isGracefulShutdown = true;
  console.log(`[Shutdown] ${signal} received — initiating graceful shutdown`);

  try {
    const { stopScheduler, releaseInFlightLeasesOnShutdown } = await import(
      "../services/workScheduler"
    );
    stopScheduler();
    console.log("[Shutdown] Work scheduler stopped");
    // Task #1676: release in-flight leases owned by this process so the
    // next boot's cleanupStaleJobsOnStartup doesn't classify them as
    // zombies/orphans (the primary source of cross-queue
    // `startup_stale_recovery` and downstream `stale_lease_exhaustion`
    // churn observed in the May 20 production health check).
    await releaseInFlightLeasesOnShutdown();
  } catch (err) {
    console.warn("[Shutdown] Work scheduler stop / lease release failed:", err);
  }

  try {
    const { stopLeaseChurnAlertsScheduler } = await import(
      "../services/leaseChurnAlerts"
    );
    stopLeaseChurnAlertsScheduler();
    console.log("[Shutdown] Lease churn alerts scheduler stopped");
  } catch {}

  try {
    const { stopRepairDispatcher } = await import("../services/repairDispatcher");
    stopRepairDispatcher();
    console.log("[Shutdown] Repair dispatcher stopped");
  } catch {}

  try {
    const { stopInventorySyncScheduler } = await import("../services/semrushInventorySync");
    stopInventorySyncScheduler();
    console.log("[Shutdown] Semrush inventory sync stopped");
  } catch {}

  try {
    const { stopRisAutoPullScheduler } = await import("../services/ris/risAutoPullScheduler");
    stopRisAutoPullScheduler();
    console.log("[Shutdown] RIS BigQuery auto-pull stopped");
  } catch {}

  try {
    const { stopLiveDataScheduler } = await import("../services/liveData/liveDataScheduler");
    stopLiveDataScheduler();
    console.log("[Shutdown] Live Data auto-pull stopped");
  } catch {}

  try {
    const { stopSheetsAutoRefreshProducer } = await import("../services/sheetsDataRefresh");
    stopSheetsAutoRefreshProducer();
    console.log("[Shutdown] Sheets auto-refresh producer stopped");
  } catch {}

  try {
    const { stopAppBackupScheduler } = await import("../services/appBackupScheduler");
    stopAppBackupScheduler();
    console.log("[Shutdown] App backup scheduler stopped");
  } catch {}

  try {
    const { stopZoomTokenKeepAliveScheduler } = await import(
      "../services/zoomTokenKeepAliveScheduler"
    );
    stopZoomTokenKeepAliveScheduler();
    console.log("[Shutdown] Zoom token keep-alive scheduler stopped");
  } catch {}

  try {
    const { stopAdsOsPacingRefreshScheduler } = await import(
      "../services/adsOs/morningPacingScheduler"
    );
    stopAdsOsPacingRefreshScheduler();
    console.log("[Shutdown] Ads OS pacing refresh scheduler stopped");
  } catch {}

  try {
    const { stopAutoTuneScheduler } = await import("../services/rateLimitAutoTuner");
    stopAutoTuneScheduler();
    console.log("[Shutdown] Rate limit auto-tune scheduler stopped");
  } catch {}

  try {
    const { stopAuditRetentionScheduler } = await import("../services/auditRetention");
    stopAuditRetentionScheduler();
    console.log("[Shutdown] Audit retention scheduler stopped");
  } catch {}

  try {
    const { stopPendingDigestAlertsRetentionScheduler } = await import(
      "../services/pendingDigestAlertsRetention"
    );
    stopPendingDigestAlertsRetentionScheduler();
    console.log("[Shutdown] Pending digest alerts retention scheduler stopped");
  } catch {}

  try {
    const { stopSemrushGhostCleanupScheduler } = await import(
      "../services/semrushGhostCleanup"
    );
    stopSemrushGhostCleanupScheduler();
    console.log("[Shutdown] SEMrush ghost cleanup scheduler stopped");
  } catch {}

  try {
    const { stopRegressionSweepScheduler } = await import(
      "../services/regressionSweepScheduler"
    );
    stopRegressionSweepScheduler();
    console.log("[Shutdown] Regression sweep scheduler stopped");
  } catch {}

  try {
    const { stopRateLimitAlertAutoRetryScheduler } = await import(
      "../services/rateLimitAlertAutoRetry"
    );
    stopRateLimitAlertAutoRetryScheduler();
    console.log("[Shutdown] Rate-limit alert auto-retry scheduler stopped");
  } catch {}

  try {
    const { stopMatchSettingsAlertAutoRetryScheduler } = await import(
      "../services/matchSettingsAlertAutoRetry"
    );
    stopMatchSettingsAlertAutoRetryScheduler();
    console.log("[Shutdown] Match-settings alert auto-retry scheduler stopped");
  } catch {}

  try {
    const { stopRecoveryPruneSweep } = await import("../services/frontHistoricalRecovery");
    stopRecoveryPruneSweep();
    console.log("[Shutdown] Front recovery prune sweep stopped");
  } catch {}

  try {
    const { stopMemoryWatchdog } = await import("../services/memoryWatchdog");
    stopMemoryWatchdog();
    console.log("[Shutdown] Memory watchdog stopped");
  } catch {}

  for (const timerId of backgroundTimerIds) {
    clearTimeout(timerId);
  }
  backgroundTimerIds.length = 0;
  console.log("[Shutdown] Background timers cleared");

  console.log("[Shutdown] Graceful shutdown complete — allowing 5s for in-flight work");
  setTimeout(() => {
    console.log("[Shutdown] Grace period expired — exiting");
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
