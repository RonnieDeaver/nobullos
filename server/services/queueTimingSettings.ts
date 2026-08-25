import { storage } from "../storage";
import { recordPruneEvent } from "./auditPruneEvents";

export const QUEUE_TIMING_SETTINGS_KEY = "work_queue_timings";
export const QUEUE_TIMING_AUDIT_RETENTION_KEY = "queue_timing_audit_retention";

const POLL_MIN = 250;
const POLL_MAX = 5 * 60_000;
const HEARTBEAT_MIN = 5_000;
const HEARTBEAT_MAX = 30 * 60_000;
const BASE_BACKOFF_MIN = 100;
const BASE_BACKOFF_MAX = 60 * 60_000;
const MAX_BACKOFF_MIN = 1_000;
const MAX_BACKOFF_MAX = 24 * 60 * 60_000;

function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export const QUEUE_TIMING_BOUNDS = {
  pollIntervalMs: { min: POLL_MIN, max: POLL_MAX },
  heartbeatIntervalMs: { min: HEARTBEAT_MIN, max: HEARTBEAT_MAX },
  baseBackoffMs: { min: BASE_BACKOFF_MIN, max: BASE_BACKOFF_MAX },
  maxBackoffMs: { min: MAX_BACKOFF_MIN, max: MAX_BACKOFF_MAX },
} as const;

/**
 * Retention policy for the `queue_timing_audit` table.
 *
 * After every successful audit insert in `setQueueTimings`, we prune rows
 * that fall outside this window so the table cannot grow unboundedly.
 *
 * Configurable via env (both bounds apply; whichever removes more rows wins):
 * - `QUEUE_TIMING_AUDIT_MAX_ENTRIES` (default 500, min 1, max 1,000,000)
 *     Keep only the N most recent audit rows.
 * - `QUEUE_TIMING_AUDIT_MAX_AGE_DAYS` (default 365, min 1, max 3650)
 *     Drop audit rows older than N days.
 */
export const QUEUE_TIMING_AUDIT_RETENTION_BOUNDS = {
  maxEntries: { min: 1, max: 1_000_000 },
  maxAgeDays: { min: 1, max: 3650 },
} as const;

export type QueueTimingAuditRetention = {
  maxEntries: number;
  maxAgeDays: number;
};

export const QUEUE_TIMING_AUDIT_RETENTION_DEFAULTS: QueueTimingAuditRetention = {
  maxEntries: envInt("QUEUE_TIMING_AUDIT_MAX_ENTRIES", 500, 1, 1_000_000),
  maxAgeDays: envInt("QUEUE_TIMING_AUDIT_MAX_AGE_DAYS", 365, 1, 3650),
};

/**
 * @deprecated env-only snapshot; prefer `getQueueTimingAuditRetention()`
 * which honors the live `system_settings` override.
 */
export const QUEUE_TIMING_AUDIT_RETENTION: QueueTimingAuditRetention = {
  ...QUEUE_TIMING_AUDIT_RETENTION_DEFAULTS,
};

function parseAuditRetention(raw: string): QueueTimingAuditRetention | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: QueueTimingAuditRetention = { ...QUEUE_TIMING_AUDIT_RETENTION_DEFAULTS };
    for (const key of ["maxEntries", "maxAgeDays"] as const) {
      if (parsed[key] !== undefined) {
        const n = Number(parsed[key]);
        const { min, max } = QUEUE_TIMING_AUDIT_RETENTION_BOUNDS[key];
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
        out[key] = n;
      }
    }
    return out;
  } catch {
    return null;
  }
}

let cachedAuditRetention: { value: QueueTimingAuditRetention; ts: number } | null = null;
const AUDIT_RETENTION_CACHE_TTL_MS = 30_000;

export async function getQueueTimingAuditRetention(): Promise<QueueTimingAuditRetention> {
  const now = Date.now();
  if (cachedAuditRetention && now - cachedAuditRetention.ts < AUDIT_RETENTION_CACHE_TTL_MS) {
    return cachedAuditRetention.value;
  }
  try {
    const setting = await storage.getSystemSetting(QUEUE_TIMING_AUDIT_RETENTION_KEY);
    if (setting?.value) {
      const parsed = parseAuditRetention(setting.value);
      if (parsed) {
        cachedAuditRetention = { value: parsed, ts: now };
        return parsed;
      }
    }
  } catch {}
  const defaults = { ...QUEUE_TIMING_AUDIT_RETENTION_DEFAULTS };
  cachedAuditRetention = { value: defaults, ts: now };
  return defaults;
}

export function invalidateQueueTimingAuditRetentionCache(): void {
  cachedAuditRetention = null;
}

export async function setQueueTimingAuditRetention(
  values: Partial<QueueTimingAuditRetention>,
  updatedBy?: string,
): Promise<QueueTimingAuditRetention> {
  const current = await getQueueTimingAuditRetention();
  const merged: QueueTimingAuditRetention = {
    maxEntries: values.maxEntries !== undefined ? Number(values.maxEntries) : current.maxEntries,
    maxAgeDays: values.maxAgeDays !== undefined ? Number(values.maxAgeDays) : current.maxAgeDays,
  };
  const parsed = parseAuditRetention(JSON.stringify(merged));
  if (!parsed) {
    throw new Error(
      `Invalid retention: maxEntries must be an integer between ${QUEUE_TIMING_AUDIT_RETENTION_BOUNDS.maxEntries.min} and ${QUEUE_TIMING_AUDIT_RETENTION_BOUNDS.maxEntries.max}; maxAgeDays must be an integer between ${QUEUE_TIMING_AUDIT_RETENTION_BOUNDS.maxAgeDays.min} and ${QUEUE_TIMING_AUDIT_RETENTION_BOUNDS.maxAgeDays.max}`,
    );
  }
  const previous = current;
  await storage.setSystemSetting(
    QUEUE_TIMING_AUDIT_RETENTION_KEY,
    JSON.stringify(parsed),
    updatedBy ?? "system",
  );
  invalidateQueueTimingAuditRetentionCache();
  if (previous.maxEntries !== parsed.maxEntries || previous.maxAgeDays !== parsed.maxAgeDays) {
    try {
      await storage.recordAdminSettingChange({
        settingKey: QUEUE_TIMING_AUDIT_RETENTION_KEY,
        scope: null,
        changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
        oldValues: previous,
        newValues: parsed,
      });
    } catch (err: any) {
      console.error("[queueTimingSettings] Failed to record audit retention change:", err?.message ?? err);
    }
  }
  return parsed;
}

export const DEFAULT_QUEUE_TIMINGS = {
  pollIntervalMs: envInt("WORK_QUEUE_POLL_INTERVAL_MS", 5_000, POLL_MIN, POLL_MAX),
  heartbeatIntervalMs: envInt("WORK_QUEUE_HEARTBEAT_INTERVAL_MS", 60_000, HEARTBEAT_MIN, HEARTBEAT_MAX),
  baseBackoffMs: envInt("WORK_QUEUE_BASE_BACKOFF_MS", 10_000, BASE_BACKOFF_MIN, BASE_BACKOFF_MAX),
  maxBackoffMs: envInt("WORK_QUEUE_MAX_BACKOFF_MS", 600_000, MAX_BACKOFF_MIN, MAX_BACKOFF_MAX),
};

export type QueueTimings = typeof DEFAULT_QUEUE_TIMINGS;

let cached: { value: QueueTimings; ts: number } | null = null;
const CACHE_TTL_MS = 30_000;

const FIELDS: Array<keyof QueueTimings> = [
  "pollIntervalMs",
  "heartbeatIntervalMs",
  "baseBackoffMs",
  "maxBackoffMs",
];

function validate(input: any): QueueTimings | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const merged: QueueTimings = { ...DEFAULT_QUEUE_TIMINGS };
  for (const k of FIELDS) {
    if (input[k] !== undefined) {
      const n = Number(input[k]);
      const { min, max } = QUEUE_TIMING_BOUNDS[k];
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
      merged[k] = n;
    }
  }
  if (merged.maxBackoffMs < merged.baseBackoffMs) return null;
  return merged;
}

export async function getQueueTimings(): Promise<QueueTimings> {
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.value;
  try {
    const setting = await storage.getSystemSetting(QUEUE_TIMING_SETTINGS_KEY);
    if (setting?.value) {
      const parsed = validate(JSON.parse(setting.value));
      if (parsed) {
        cached = { value: parsed, ts: now };
        return parsed;
      }
    }
  } catch {}
  const defaults = { ...DEFAULT_QUEUE_TIMINGS };
  cached = { value: defaults, ts: now };
  return defaults;
}

export function invalidateQueueTimingsCache(): void {
  cached = null;
}

export async function setQueueTimings(values: Partial<QueueTimings>, updatedBy?: string): Promise<QueueTimings> {
  const current = await getQueueTimings();
  const merged = { ...current, ...values };
  const parsed = validate(merged);
  if (!parsed) {
    throw new Error(
      "Invalid queue timings: each value must be an integer within its allowed range; maxBackoffMs must be >= baseBackoffMs",
    );
  }
  const previous = current;
  await storage.setSystemSetting(QUEUE_TIMING_SETTINGS_KEY, JSON.stringify(parsed), updatedBy ?? "system");
  invalidateQueueTimingsCache();

  const changed = FIELDS.some((k) => previous[k] !== parsed[k]);
  if (changed) {
    try {
      const auditRow = await storage.recordQueueTimingChange({
        changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
        oldValues: previous,
        newValues: parsed,
      });
      try {
        const retention = await getQueueTimingAuditRetention();
        const pruned = await storage.pruneQueueTimingAudit({
          maxEntries: retention.maxEntries,
          maxAgeDays: retention.maxAgeDays,
        });
        if (pruned > 0) {
          console.log(
            `[queueTimingSettings] Pruned ${pruned} old queue_timing_audit row(s) ` +
              `(keep last ${retention.maxEntries} entries / ${retention.maxAgeDays} days)`,
          );
        }
        await recordPruneEvent("queue_timing_audit", {
          at: new Date().toISOString(),
          removed: pruned,
          maxEntries: retention.maxEntries,
          maxAgeDays: retention.maxAgeDays,
          trigger: "save",
          triggeredBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
          auditEntryId: auditRow?.id ?? null,
        });
      } catch (pruneErr) {
        console.error("[queueTimingSettings] Failed to prune audit entries:", pruneErr);
      }
    } catch (err) {
      console.error("[queueTimingSettings] Failed to record audit entry:", err);
    }
  }
  return parsed;
}
