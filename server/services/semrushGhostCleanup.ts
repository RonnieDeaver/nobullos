// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  // @cross-instance-safe: the node-cron job deletes ghost mappings by primary id
  // and upserts the day's health rollup keyed by (metric, date). node-cron's
  // in-process timer fires on every autoscale instance, but delete-by-id and the
  // keyed upsert are both idempotent, so concurrent runs converge with no
  // double-effect. (Task #2397)
  /**
 * Task #758 — daily auto-cleanup of stale SEMrush location-campaign mappings.
 *
 * `scripts/cleanup-import-ghosts.ts --apply` already deletes
 * `semrush_location_campaigns` rows whose `(client_id, location_id)` pair is
 * no longer present in `client_locations`, but it only runs when an operator
 * remembers to invoke it. Operators de-configure locations during normal
 * client maintenance, so drift accumulates and silently breaks heatmap
 * rendering until somebody notices.
 *
 * This service runs the same planner (`planSemrushGhosts`, exported from the
 * script) once a day, deletes the unambiguous ghost rows, logs a summary
 * line, and persists the last-run summary as a JSON `system_settings` value
 * so it can be surfaced on the Health dashboard later. Operators can disable
 * the auto-cleanup without a deploy by setting the `system_settings` row
 * `semrush_ghost_cleanup_enabled` to `false` / `0` / `off` / `no`; default is
 * enabled. The manual `--apply` script remains the source of truth and is
 * unaffected by this setting.
 */
import cron from "node-cron";
import { eq } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";
import { upsertDailyRollup } from "../storage/healthMetricsStorage";
import type { InsertHealthDailyRollup } from "@shared/schema";
import {
  planSemrushGhosts,
  type SemrushGhostRow,
} from "../../scripts/cleanup-import-ghosts";

/**
 * Health-rollup metric name. The Health dashboard reads
 * `health_daily_rollups` filtered by metric to render long-window trends
 * (see `getDailyRollupsSince` in `server/storage/healthMetricsStorage.ts`).
 *
 * Field mapping for this metric:
 *   sampleCount    = scanned mappings considered
 *   alertCount     = ghost mappings detected (locationId no longer configured)
 *   incidentCount  = ghost mappings actually deleted this run
 *   metadata       = { durationMs, scannedAt, skippedReason? }
 */
export const HEALTH_METRIC = "semrush_ghost_cleanup";

export const SETTING_ENABLED = "semrush_ghost_cleanup_enabled";
export const SETTING_LAST_RUN = "semrush_ghost_cleanup_last_run";

const OFF_TOKENS = new Set(["false", "0", "off", "no"]);

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let runInFlight = false;

export interface SemrushGhostCleanupResult {
  scanned: number;
  ghosts: number;
  deleted: number;
  scannedAt: number;
  durationMs: number;
  skippedReason?: "disabled";
}

export async function isSemrushGhostCleanupEnabled(): Promise<boolean> {
  try {
    const row = await getSystemSetting(SETTING_ENABLED);
    const raw = row?.value?.trim().toLowerCase();
    if (!raw) return true;
    return !OFF_TOKENS.has(raw);
  } catch (err: any) {
    console.error(
      "[SemrushGhostCleanup] Failed to read enabled flag, defaulting to enabled:",
      err?.message ?? err,
    );
    return true;
  }
}

export async function runSemrushGhostCleanup(opts: { force?: boolean } = {}): Promise<SemrushGhostCleanupResult> {
  const startedAt = Date.now();
  const enabled = opts.force ? true : await isSemrushGhostCleanupEnabled();
  if (!enabled) {
    const result: SemrushGhostCleanupResult = {
      scanned: 0,
      ghosts: 0,
      deleted: 0,
      scannedAt: startedAt,
      durationMs: 0,
      skippedReason: "disabled",
    };
    await persistLastRun(result);
    console.log(
      `[SemrushGhostCleanup] Skipped — disabled via system setting "${SETTING_ENABLED}"`,
    );
    return result;
  }

  const db = getDb();
  const { semrushLocationCampaigns, clientLocations } = await import("@shared/schema");

  const allMappings: SemrushGhostRow[] = await db
    .select({
      id: semrushLocationCampaigns.id,
      clientId: semrushLocationCampaigns.clientId,
      locationId: semrushLocationCampaigns.locationId,
      semrushCampaignId: semrushLocationCampaigns.semrushCampaignId,
      semrushCampaignName: semrushLocationCampaigns.semrushCampaignName,
    })
    .from(semrushLocationCampaigns);

  const allLocs = await db.select({ id: clientLocations.id }).from(clientLocations);
  const configuredIds = new Set(allLocs.map((l) => l.id));
  const ghosts = planSemrushGhosts(allMappings, configuredIds);

  let deleted = 0;
  for (const g of ghosts) {
    try {
      await db
        .delete(semrushLocationCampaigns)
        .where(eq(semrushLocationCampaigns.id, g.id));
      deleted++;
    } catch (err: any) {
      console.error(
        `[SemrushGhostCleanup] Failed to delete ghost mapping id=${g.id}:`,
        err?.message ?? err,
      );
    }
  }

  const durationMs = Date.now() - startedAt;
  const result: SemrushGhostCleanupResult = {
    scanned: allMappings.length,
    ghosts: ghosts.length,
    deleted,
    scannedAt: startedAt,
    durationMs,
  };

  console.log(
    `[SemrushGhostCleanup] scanned=${result.scanned} ghosts=${result.ghosts} ` +
      `deleted=${result.deleted} durationMs=${result.durationMs}`,
  );

  await persistLastRun(result);
  await recordHealthRollup(result);
  return result;
}

function utcDateString(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Persist the run summary into `health_daily_rollups` so the Health
 * dashboard's existing rollup-trend infrastructure can render
 * SEMrush-ghost drift over time without reading anything new. The
 * upsert key is (metric, date) — re-running on the same day overwrites
 * the day's row, which matches the once-a-day cadence of this job.
 */
async function recordHealthRollup(result: SemrushGhostCleanupResult): Promise<void> {
  try {
    const record: InsertHealthDailyRollup = {
      metric: HEALTH_METRIC,
      date: utcDateString(result.scannedAt),
      sampleCount: result.scanned,
      okCount: 0,
      degradedCount: 0,
      errorCount: 0,
      p50: null,
      p95: null,
      p99: null,
      minVal: null,
      maxVal: null,
      avgVal: null,
      alertCount: result.ghosts,
      incidentCount: result.deleted,
      metadata: {
        durationMs: result.durationMs,
        scannedAt: result.scannedAt,
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
      },
    };
    await upsertDailyRollup(record);
  } catch (err: any) {
    console.error(
      "[SemrushGhostCleanup] Failed to record health daily rollup:",
      err?.message ?? err,
    );
  }
}

async function persistLastRun(result: SemrushGhostCleanupResult): Promise<void> {
  try {
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(result));
  } catch (err: any) {
    console.error(
      "[SemrushGhostCleanup] Failed to persist last-run summary:",
      err?.message ?? err,
    );
  }
}

/**
 * Why the last-run summary could not be returned as a parsed object:
 *   - "ok"         — a well-formed summary was read.
 *   - "never_run"  — the key is absent/empty; normal on a fresh deploy.
 *   - "unreadable" — the stored value (or the settings read itself)
 *     failed to produce a summary; signals a real persistence bug, not
 *     a fresh deploy.
 */
export type LastSemrushGhostCleanupRunStatus = "ok" | "never_run" | "unreadable";

export interface LastSemrushGhostCleanupRunRead {
  /** The parsed summary, or null when status is not "ok". */
  lastRun: SemrushGhostCleanupResult | null;
  status: LastSemrushGhostCleanupRunStatus;
  /** Plain-English reason present only when status === "unreadable". */
  error?: string;
}

/**
 * Read the persisted last-run summary and classify the outcome so the
 * operator status route can tell "never ran" (normal) apart from
 * "stored value was unreadable" (a persistence regression). Never
 * throws — a settings-read failure is reported as `unreadable` with the
 * error message rather than masquerading as `never_run`.
 */
export async function readLastSemrushGhostCleanupRun(): Promise<LastSemrushGhostCleanupRunRead> {
  let raw: string | undefined;
  try {
    const row = await getSystemSetting(SETTING_LAST_RUN);
    raw = row?.value?.trim();
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(
      "[SemrushGhostCleanup] Failed to read last-run summary:",
      message,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }

  if (!raw) return { lastRun: null, status: "never_run" };

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { lastRun: parsed as SemrushGhostCleanupResult, status: "ok" };
    }
    const message = "stored last-run value was not a JSON object";
    console.error(`[SemrushGhostCleanup] ${message}`);
    return { lastRun: null, status: "unreadable", error: message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(
      "[SemrushGhostCleanup] Failed to parse last-run summary:",
      message,
    );
    return { lastRun: null, status: "unreadable", error: message };
  }
}

/**
 * Read the persisted last-run summary, or null if the cleanup has not
 * run yet (or the stored value is unparseable). Thin back-compat wrapper
 * over {@link readLastSemrushGhostCleanupRun} that preserves the original
 * "null for both never-run and unreadable" contract.
 */
export async function getLastSemrushGhostCleanupRun(): Promise<SemrushGhostCleanupResult | null> {
  return (await readLastSemrushGhostCleanupRun()).lastRun;
}

async function runOnce(): Promise<void> {
  if (runInFlight) {
    console.log("[SemrushGhostCleanup] Previous run still in flight, skipping");
    return;
  }
  runInFlight = true;
  try {
    await runSemrushGhostCleanup();
  } catch (err: any) {
    console.error("[SemrushGhostCleanup] Run failed:", err?.message ?? err);
  } finally {
    runInFlight = false;
  }
}

export function startSemrushGhostCleanupScheduler(
  cronExpression = "30 4 * * *",
): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
  }

  scheduledTask = cron.schedule(
    cronExpression,
    () => {
      void withDbAttribution("scheduler:semrush-ghost-cleanup", () => runOnce());
    },
    { timezone: "America/New_York" },
  );

  console.log(
    `[SemrushGhostCleanup] Scheduled with cron: ${cronExpression} ` +
      `(America/New_York), admin-disable via system setting "${SETTING_ENABLED}"`,
  );

  setTimeout(() => {
    void withDbAttribution("startup:semrush-ghost-cleanup-initial-run", () => runOnce());
  }, 5_000);
}

export function stopSemrushGhostCleanupScheduler(): void {
  if (scheduledTask) {
    void scheduledTask.stop(); // fire-and-forget: node-cron v4 stop() is async; nothing awaits teardown
    scheduledTask = null;
    console.log("[SemrushGhostCleanup] Stopped");
  }
}
