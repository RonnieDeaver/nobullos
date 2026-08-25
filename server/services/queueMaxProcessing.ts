/**
 * Task #1048: per-queue maximum total processing duration.
 *
 * The lease cutoff (`staleLeaseThresholds.leaseCutoffMs`, default 5min) is
 * extended every heartbeat tick (~60s), so a hung handler whose heartbeat
 * keeps firing can keep its lease alive forever — that's the root cause of
 * the 2h+ `semrush_report_refresh` and 7m+ `retroactive_reprocess` jobs
 * that motivated this task.
 *
 * This module gives each queue a hard ceiling on TOTAL processing time
 * (since `leased_at`). Once the ceiling is exceeded:
 *  - the heartbeat stops extending the lease (writes `lease_expires_at = now`)
 *    and shuts itself down, and
 *  - `recoverStaleLeases` independently reclaims any row whose
 *    `leased_at + maxProcessingMs < now()` even if heartbeats are still firing
 *    (belt-and-suspenders against a stuck-but-still-pinging handler).
 *
 * Defaults err on the generous side per queue. Operators can override via
 * `system_settings.work_queue_max_processing_ms` (JSON map keyed by queue
 * name, values in ms). Unknown queues fall back to `default`.
 */
import { storage } from "../storage";

export const QUEUE_MAX_PROCESSING_KEY = "work_queue_max_processing_ms";

const ONE_MIN = 60_000;

export const DEFAULT_QUEUE_MAX_PROCESSING_MS: Record<string, number> = {
  default: 15 * ONE_MIN,
  semrush_report_refresh: 60 * ONE_MIN,
  semrush_background_refresh: 60 * ONE_MIN,
  retroactive_reprocess: 15 * ONE_MIN,
  front_full_backfill: 60 * ONE_MIN,
  front_historical_backfill: 60 * ONE_MIN,
  front_rematch_all: 60 * ONE_MIN,
  front_reconciliation: 30 * ONE_MIN,
  front_sync_reprocess: 30 * ONE_MIN,
  zoom_transcript_backfill: 60 * ONE_MIN,
  agent_decontamination: 30 * ONE_MIN,
  replay_event_log: 60 * ONE_MIN,
  replay_vendor_reconciliation: 60 * ONE_MIN,
  replay_ruleset_backfill: 60 * ONE_MIN,
  analyze_communication: 10 * ONE_MIN,
  communication_apply: 5 * ONE_MIN,
  meeting_apply: 5 * ONE_MIN,
  transcript_apply: 5 * ONE_MIN,
  local_report_apply: 5 * ONE_MIN,
  match_state_apply: 5 * ONE_MIN,
  inventory_sync_apply: 10 * ONE_MIN,
  semrush_heatmap_apply: 10 * ONE_MIN,
  zoom_meeting_apply: 5 * ONE_MIN,
  zoom_transcript_apply: 5 * ONE_MIN,
  front_webhook_normalize: 5 * ONE_MIN,
  front_webhook_apply: 5 * ONE_MIN,
  front_bulk_action: 30 * ONE_MIN,
  front_filter_rule_apply: 30 * ONE_MIN,
  // Task #1055: Twilio call recording archive pipeline (own lease, not
  // backed by `work_queue`). Twilio download + OpenAI transcription +
  // Drive mirror together should comfortably finish well under this
  // ceiling; an overrun is the stuck-handler signal we want to catch.
  call_archive: 15 * ONE_MIN,
  // Workers/queues audit parity (E-F02/E-F12): custom-table worker lanes.
  // Defaults deliberately equal the previously hard-coded values so cutting
  // these workers over to canonical config changes no behavior:
  //  - call_analysis / call_analysis_slow: the old STALE_JOB_TIMEOUT
  //    constants (5 min normal / 16 min slow); the in-run wall-clock
  //    budget is derived as (ceiling - 60s) = the old 4/15-min timeouts.
  //  - local_dominance_sync: the old STUCK_IN_PROGRESS_CUTOFF_MS (4 h)
  //    used by the stuck-in_progress recovery sweep.
  //  - semrush_location_auto_retry: claim lease covering the pick→
  //    beginAttempt window; a crashed retry re-dues after this long.
  call_analysis: 5 * ONE_MIN,
  call_analysis_slow: 16 * ONE_MIN,
  local_dominance_sync: 240 * ONE_MIN,
  semrush_location_auto_retry: 15 * ONE_MIN,
};

const MIN_MAX_PROCESSING_MS = 30_000;
const MAX_MAX_PROCESSING_MS = 24 * 60 * 60_000;
const CACHE_TTL_MS = 30_000;

let cached: { overrides: Record<string, number>; ts: number } | null = null;

function parseOverrides(raw: string): Record<string, number> {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) continue;
      if (n < MIN_MAX_PROCESSING_MS || n > MAX_MAX_PROCESSING_MS) continue;
      out[String(k)] = n;
    }
    return out;
  } catch {
    return {};
  }
}

async function loadOverrides(): Promise<Record<string, number>> {
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.overrides;
  let overrides: Record<string, number> = {};
  try {
    const setting = await storage.getSystemSetting(QUEUE_MAX_PROCESSING_KEY);
    if (setting?.value) overrides = parseOverrides(setting.value);
  } catch {}
  cached = { overrides, ts: now };
  return overrides;
}

export function invalidateQueueMaxProcessingCache(): void {
  cached = null;
}

export async function getMaxProcessingMs(queueName: string): Promise<number> {
  const overrides = await loadOverrides();
  if (overrides[queueName] !== undefined) return overrides[queueName];
  if (DEFAULT_QUEUE_MAX_PROCESSING_MS[queueName] !== undefined) {
    return DEFAULT_QUEUE_MAX_PROCESSING_MS[queueName];
  }
  if (overrides.default !== undefined) return overrides.default;
  return DEFAULT_QUEUE_MAX_PROCESSING_MS.default;
}

/**
 * Snapshot of the effective max-processing map (defaults merged with
 * the operator-managed overrides) for the admin endpoint.
 */
export async function getEffectiveMaxProcessingMap(): Promise<Record<string, number>> {
  const overrides = await loadOverrides();
  return { ...DEFAULT_QUEUE_MAX_PROCESSING_MS, ...overrides };
}
