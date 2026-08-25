// @cross-instance-safe: enqueue-only tick — enqueues a dedupe-keyed work_queue job; the handler runs once per claim and duplicate enqueues collapse via wq_dedupe_key_idx.
/**
 * Task #1759 — Google Ads daily sync worker.
 *
 * One scheduler tick per `SYNC_INTERVAL_MS` enqueues a single
 * `google_ads_sync` job; the work-queue handler walks every enabled
 * customer in `google_ads_customers` and runs `syncCustomer()` against
 * each. Sync activity ALWAYS runs on the worker pool via
 * `runWithWorkerDb()` so the API pool stays free for operator routes.
 *
 * Gated by:
 *   - `system_settings.google_ads_sync_enabled` (default ON) — operator
 *     kill switch persisted in `system_settings` so flipping it doesn't
 *     require a deploy.
 *   - `system_settings.google_ads_lookback_days` (default 90) — operator-
 *     tunable lookback window.
 *   - `isKillSwitchEnabled("non_critical_sweeps")` — global kill switch
 *     that pauses every non-critical sweep.
 *   - The worker also short-circuits when the GOOGLE_ADS_* env secrets are
 *     incomplete (`not_configured`) or the shared env-trio mint's
 *     terminal-rejection negative cache is armed (`env_token_rejected`,
 *     Task #4008) so a dead credential is never re-POSTed to Google once
 *     per customer.
 */

import { runWithWorkerDb, withDbAttribution } from "../db";
import { enqueueJob, registerHandler } from "./workScheduler";
import { isKillSwitchEnabled } from "./killSwitches";
import { storage } from "../storage";
import {
  createGoogleAdsSyncRun,
  finishGoogleAdsSyncRun,
  listGoogleAdsCustomers,
  markGoogleAdsCustomerSynced,
} from "../storage/googleAdsStorage";
import {
  discoverAndUpsertCustomers,
  isConnected,
  isGoogleAdsConfigured,
  syncCustomer,
} from "./googleAdsIntegration";

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h between scheduler ticks
const DEFAULT_LOOKBACK_DAYS = 90;
const KILL_SWITCH_KEY = "google_ads_sync_enabled";
const LOOKBACK_SETTING_KEY = "google_ads_lookback_days";

let scheduler: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

async function readKillSwitch(): Promise<boolean> {
  try {
    const row = await storage.getSystemSetting(KILL_SWITCH_KEY);
    if (!row?.value) return true; // default ON
    return row.value === "true" || row.value === "1";
  } catch {
    return true;
  }
}

async function readLookbackDays(): Promise<number> {
  try {
    const row = await storage.getSystemSetting(LOOKBACK_SETTING_KEY);
    const v = row?.value ? Number(row.value) : NaN;
    if (Number.isFinite(v) && v > 0) return Math.min(Math.floor(v), 365);
  } catch {
    // fallthrough
  }
  return DEFAULT_LOOKBACK_DAYS;
}

export interface GoogleAdsSyncSummary {
  skipped: boolean;
  reason?: string;
  customersProcessed: number;
  customersFailed: number;
  campaignsUpserted: number;
  campaignStatsUpserted: number;
  keywordStatsUpserted: number;
  errors: Array<{ customerId: string; error: string }>;
}

export async function runGoogleAdsSync(): Promise<GoogleAdsSyncSummary> {
  if (isRunning) {
    return emptySummary(true, "overlap");
  }
  if (isKillSwitchEnabled("non_critical_sweeps")) {
    return emptySummary(true, "non_critical_sweeps");
  }
  if (!(await readKillSwitch())) {
    return emptySummary(true, "google_ads_sync_disabled");
  }
  if (!isGoogleAdsConfigured()) {
    return emptySummary(true, "not_configured");
  }
  // Task #4008 — `isConnected()` is env presence + the shared mint's
  // terminal-rejection negative cache (no DB read, no network). When Google
  // recently rejected the env trio terminally, skip the whole tick instead
  // of enumerating customers and re-driving the doomed token POST.
  if (!isConnected()) {
    return emptySummary(true, "env_token_rejected");
  }

  isRunning = true;
  const lookbackDays = await readLookbackDays();
  const summary: GoogleAdsSyncSummary = {
    skipped: false,
    customersProcessed: 0,
    customersFailed: 0,
    campaignsUpserted: 0,
    campaignStatsUpserted: 0,
    keywordStatsUpserted: 0,
    errors: [],
  };

  try {
    await runWithWorkerDb(async () => {
      await withDbAttribution("worker:google_ads_sync_discovery", async () => {
        try {
          await discoverAndUpsertCustomers();
        } catch (err: any) {
          console.error("[GoogleAds] Discovery failed:", err?.message || err);
        }
      });

      const customers = await withDbAttribution(
        "worker:google_ads_sync_list",
        async () => listGoogleAdsCustomers(),
      );
      const enabled = customers.filter(
        (c) => c.syncEnabled && !c.isManager,
      );

      for (const customer of enabled) {
        const run = await withDbAttribution(
          "worker:google_ads_sync_run_open",
          async () =>
            createGoogleAdsSyncRun({
              customerId: customer.customerId,
              status: "running",
              metadata: { lookbackDays },
            }),
        );
        try {
          const result = await syncCustomer(customer.customerId, lookbackDays);
          summary.customersProcessed++;
          summary.campaignsUpserted += result.campaignsUpserted;
          summary.campaignStatsUpserted += result.campaignStatsUpserted;
          summary.keywordStatsUpserted += result.keywordStatsUpserted;
          await withDbAttribution(
            "worker:google_ads_sync_run_close",
            async () =>
              finishGoogleAdsSyncRun(run.id, {
                status: "succeeded",
                campaignsUpserted: result.campaignsUpserted,
                campaignStatsUpserted: result.campaignStatsUpserted,
                keywordStatsUpserted: result.keywordStatsUpserted,
              }),
          );
        } catch (err: any) {
          const message = err?.message || String(err);
          summary.customersFailed++;
          summary.errors.push({ customerId: customer.customerId, error: message });
          await withDbAttribution(
            "worker:google_ads_sync_run_fail",
            async () =>
              finishGoogleAdsSyncRun(run.id, {
                status: "failed",
                error: message,
              }),
          );
          await withDbAttribution(
            "worker:google_ads_sync_mark_failed",
            async () =>
              markGoogleAdsCustomerSynced(customer.customerId, message),
          );
          console.error(
            `[GoogleAds] sync failed for customer ${customer.customerId}:`,
            message,
          );
        }
      }
    });
  } finally {
    isRunning = false;
  }
  return summary;
}

function emptySummary(skipped: boolean, reason?: string): GoogleAdsSyncSummary {
  return {
    skipped,
    reason,
    customersProcessed: 0,
    customersFailed: 0,
    campaignsUpserted: 0,
    campaignStatsUpserted: 0,
    keywordStatsUpserted: 0,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Work-queue handler + scheduler
// ---------------------------------------------------------------------------

export async function handleGoogleAdsSyncJob(): Promise<{ cursor?: string } | void> {
  await runGoogleAdsSync();
}

export function registerGoogleAdsSyncHandler(): void {
  registerHandler("google_ads_sync", handleGoogleAdsSyncJob);
}

export function startGoogleAdsSyncScheduler(): void {
  if (scheduler) return;
  const tick = async () => {
    try {
      await enqueueJob({
        queueName: "google_ads_sync",
        workloadClass: "maintenance",
        dedupeKey: "google_ads_sync:tick",
        payload: { kind: "scheduled" },
      });
    } catch (err: any) {
      console.warn("[GoogleAds] enqueue tick failed:", err?.message || err);
    }
  };
  // First tick immediately (after the WORKER_STAGGER_OFFSET delay applied
  // by the bootstrap caller), then every SYNC_INTERVAL_MS.
  void tick();
  scheduler = setInterval(() => void tick(), SYNC_INTERVAL_MS);
}

export function stopGoogleAdsSyncScheduler(): void {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
}
