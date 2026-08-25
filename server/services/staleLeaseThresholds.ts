import { storage } from "../storage";
import { recordPruneEvent } from "./auditPruneEvents";

export const STALE_LEASE_THRESHOLDS_KEY = "stale_lease_thresholds";
export const STALE_LEASE_THRESHOLD_AUDIT_RETENTION_KEY = "stale_lease_threshold_audit_retention";

const DEFAULT_LEASE_CUTOFF_MS = 300_000;

function envLeaseCutoffMs(): number {
  const raw = process.env.WORK_QUEUE_LEASE_CUTOFF_MS;
  if (!raw) return DEFAULT_LEASE_CUTOFF_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1000) return DEFAULT_LEASE_CUTOFF_MS;
  return n;
}

function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Retention policy for the `stale_lease_threshold_audit` table.
 *
 * After every successful audit insert in `setStaleLeaseThresholds`, we prune
 * rows that fall outside this window so the table cannot grow unboundedly.
 * Mirrors `QUEUE_TIMING_AUDIT_RETENTION` so admins get a consistent story.
 *
 * Configurable via env (both bounds apply; whichever removes more rows wins):
 * - `STALE_LEASE_THRESHOLD_AUDIT_MAX_ENTRIES` (default 500, min 1, max 1,000,000)
 *     Keep only the N most recent audit rows.
 * - `STALE_LEASE_THRESHOLD_AUDIT_MAX_AGE_DAYS` (default 365, min 1, max 3650)
 *     Drop audit rows older than N days.
 */
export const AUDIT_RETENTION_BOUNDS = {
  maxEntries: { min: 1, max: 1_000_000 },
  maxAgeDays: { min: 1, max: 3650 },
} as const;

export type AuditRetention = {
  maxEntries: number;
  maxAgeDays: number;
};

export const STALE_LEASE_THRESHOLD_AUDIT_RETENTION_DEFAULTS: AuditRetention = {
  maxEntries: envInt("STALE_LEASE_THRESHOLD_AUDIT_MAX_ENTRIES", 500, 1, 1_000_000),
  maxAgeDays: envInt("STALE_LEASE_THRESHOLD_AUDIT_MAX_AGE_DAYS", 365, 1, 3650),
};

/**
 * @deprecated env-only snapshot; prefer `getStaleLeaseThresholdAuditRetention()`
 * which honors the live `system_settings` override.
 */
export const STALE_LEASE_THRESHOLD_AUDIT_RETENTION: AuditRetention = {
  ...STALE_LEASE_THRESHOLD_AUDIT_RETENTION_DEFAULTS,
};

function parseAuditRetention(raw: string): AuditRetention | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: AuditRetention = { ...STALE_LEASE_THRESHOLD_AUDIT_RETENTION_DEFAULTS };
    for (const key of ["maxEntries", "maxAgeDays"] as const) {
      if (parsed[key] !== undefined) {
        const n = Number(parsed[key]);
        const { min, max } = AUDIT_RETENTION_BOUNDS[key];
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
        out[key] = n;
      }
    }
    return out;
  } catch {
    return null;
  }
}

let cachedAuditRetention: { value: AuditRetention; ts: number } | null = null;
const AUDIT_RETENTION_CACHE_TTL_MS = 30_000;

export async function getStaleLeaseThresholdAuditRetention(): Promise<AuditRetention> {
  const now = Date.now();
  if (cachedAuditRetention && now - cachedAuditRetention.ts < AUDIT_RETENTION_CACHE_TTL_MS) {
    return cachedAuditRetention.value;
  }
  try {
    const setting = await storage.getSystemSetting(STALE_LEASE_THRESHOLD_AUDIT_RETENTION_KEY);
    if (setting?.value) {
      const parsed = parseAuditRetention(setting.value);
      if (parsed) {
        cachedAuditRetention = { value: parsed, ts: now };
        return parsed;
      }
    }
  } catch {}
  const defaults = { ...STALE_LEASE_THRESHOLD_AUDIT_RETENTION_DEFAULTS };
  cachedAuditRetention = { value: defaults, ts: now };
  return defaults;
}

export function invalidateStaleLeaseThresholdAuditRetentionCache(): void {
  cachedAuditRetention = null;
}

export async function setStaleLeaseThresholdAuditRetention(
  values: Partial<AuditRetention>,
  updatedBy?: string,
): Promise<AuditRetention> {
  const current = await getStaleLeaseThresholdAuditRetention();
  const merged: AuditRetention = {
    maxEntries: values.maxEntries !== undefined ? Number(values.maxEntries) : current.maxEntries,
    maxAgeDays: values.maxAgeDays !== undefined ? Number(values.maxAgeDays) : current.maxAgeDays,
  };
  const parsed = parseAuditRetention(JSON.stringify(merged));
  if (!parsed) {
    throw new Error(
      `Invalid retention: maxEntries must be an integer between ${AUDIT_RETENTION_BOUNDS.maxEntries.min} and ${AUDIT_RETENTION_BOUNDS.maxEntries.max}; maxAgeDays must be an integer between ${AUDIT_RETENTION_BOUNDS.maxAgeDays.min} and ${AUDIT_RETENTION_BOUNDS.maxAgeDays.max}`,
    );
  }
  const previous = current;
  await storage.setSystemSetting(
    STALE_LEASE_THRESHOLD_AUDIT_RETENTION_KEY,
    JSON.stringify(parsed),
    updatedBy ?? "system",
  );
  invalidateStaleLeaseThresholdAuditRetentionCache();
  if (previous.maxEntries !== parsed.maxEntries || previous.maxAgeDays !== parsed.maxAgeDays) {
    try {
      await storage.recordAdminSettingChange({
        settingKey: STALE_LEASE_THRESHOLD_AUDIT_RETENTION_KEY,
        scope: null,
        changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
        oldValues: previous,
        newValues: parsed,
      });
    } catch (err: any) {
      console.error("[staleLeaseThresholds] Failed to record audit retention change:", err?.message ?? err);
    }
  }
  return parsed;
}

export const DEFAULT_STALE_LEASE_THRESHOLDS = {
  staleWarning: 3,
  staleCritical: 10,
  exhaustedWarning: 2,
  exhaustedCritical: 5,
  leaseCutoffMs: envLeaseCutoffMs(),
} as const;

export type StaleLeaseThresholds = {
  staleWarning: number;
  staleCritical: number;
  exhaustedWarning: number;
  exhaustedCritical: number;
  leaseCutoffMs: number;
};

let cached: { value: StaleLeaseThresholds; ts: number } | null = null;
const CACHE_TTL_MS = 30_000;

const COUNT_FIELDS: Array<keyof StaleLeaseThresholds> = [
  "staleWarning",
  "staleCritical",
  "exhaustedWarning",
  "exhaustedCritical",
];

const MIN_LEASE_CUTOFF_MS = 1000;
const MAX_LEASE_CUTOFF_MS = 24 * 60 * 60 * 1000;

function parseThresholds(raw: string): StaleLeaseThresholds | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const merged: StaleLeaseThresholds = { ...DEFAULT_STALE_LEASE_THRESHOLDS };
    for (const key of COUNT_FIELDS) {
      if (parsed[key] !== undefined) {
        const num = Number(parsed[key]);
        if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) return null;
        merged[key] = num;
      }
    }
    if (parsed.leaseCutoffMs !== undefined) {
      const num = Number(parsed.leaseCutoffMs);
      if (!Number.isFinite(num) || !Number.isInteger(num)) return null;
      if (num < MIN_LEASE_CUTOFF_MS || num > MAX_LEASE_CUTOFF_MS) return null;
      merged.leaseCutoffMs = num;
    }
    if (merged.staleCritical < merged.staleWarning) return null;
    if (merged.exhaustedCritical < merged.exhaustedWarning) return null;
    return merged;
  } catch {
    return null;
  }
}

export async function getStaleLeaseThresholds(): Promise<StaleLeaseThresholds> {
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.value;
  try {
    const setting = await storage.getSystemSetting(STALE_LEASE_THRESHOLDS_KEY);
    if (setting?.value) {
      const parsed = parseThresholds(setting.value);
      if (parsed) {
        cached = { value: parsed, ts: now };
        return parsed;
      }
    }
  } catch {}
  const defaults = { ...DEFAULT_STALE_LEASE_THRESHOLDS };
  cached = { value: defaults, ts: now };
  return defaults;
}

export async function getLeaseCutoffMs(): Promise<number> {
  const t = await getStaleLeaseThresholds();
  return t.leaseCutoffMs;
}

export function invalidateStaleLeaseThresholdsCache() {
  cached = null;
}

export async function setStaleLeaseThresholds(
  values: StaleLeaseThresholds,
  updatedBy?: string,
): Promise<StaleLeaseThresholds> {
  const serialized = JSON.stringify(values);
  const parsed = parseThresholds(serialized);
  if (!parsed) {
    throw new Error("Invalid thresholds: counts must be positive integers (warning <= critical), leaseCutoffMs must be an integer between 1000 and 86400000");
  }
  const previous = await getStaleLeaseThresholds();
  await storage.setSystemSetting(STALE_LEASE_THRESHOLDS_KEY, serialized, updatedBy ?? "system");
  invalidateStaleLeaseThresholdsCache();

  const changed =
    previous.staleWarning !== parsed.staleWarning ||
    previous.staleCritical !== parsed.staleCritical ||
    previous.exhaustedWarning !== parsed.exhaustedWarning ||
    previous.exhaustedCritical !== parsed.exhaustedCritical;
  if (changed) {
    try {
      const auditRow = await storage.recordStaleLeaseThresholdChange({
        changedBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
        oldValues: previous,
        newValues: parsed,
      });
      try {
        const retention = await getStaleLeaseThresholdAuditRetention();
        const pruned = await storage.pruneStaleLeaseThresholdAudit({
          maxEntries: retention.maxEntries,
          maxAgeDays: retention.maxAgeDays,
        });
        if (pruned > 0) {
          console.log(
            `[staleLeaseThresholds] Pruned ${pruned} old stale_lease_threshold_audit row(s) ` +
              `(keep last ${retention.maxEntries} entries / ${retention.maxAgeDays} days)`,
          );
        }
        await recordPruneEvent("stale_lease_threshold_audit", {
          at: new Date().toISOString(),
          removed: pruned,
          maxEntries: retention.maxEntries,
          maxAgeDays: retention.maxAgeDays,
          trigger: "save",
          triggeredBy: updatedBy && updatedBy !== "system" ? updatedBy : null,
          auditEntryId: auditRow?.id ?? null,
        });
      } catch (pruneErr) {
        console.error("[staleLeaseThresholds] Failed to prune audit entries:", pruneErr);
      }
    } catch (err) {
      console.error("[staleLeaseThresholds] Failed to record audit entry:", err);
    }
  }
  return parsed;
}
