import { storage } from "../storage";

export type PruneTable =
  | "stale_lease_threshold_audit"
  | "queue_timing_audit"
  | "admin_setting_audit"
  | "blocked_ip_audit"
  | "client_contacts_audit";

export type PruneTrigger = "scheduled" | "manual" | "save";

export type PruneEvent = {
  at: string;
  removed: number;
  maxEntries: number;
  maxAgeDays: number;
  trigger?: PruneTrigger;
  triggeredBy?: string | null;
  auditEntryId?: string | null;
};

const MAX_EVENTS = 50;

function keyFor(table: PruneTable): string {
  return `${table}_prune_events`;
}

function isValidEvent(e: any): e is PruneEvent {
  return (
    e &&
    typeof e === "object" &&
    typeof e.at === "string" &&
    typeof e.removed === "number" &&
    Number.isFinite(e.removed) &&
    typeof e.maxEntries === "number" &&
    Number.isFinite(e.maxEntries) &&
    typeof e.maxAgeDays === "number" &&
    Number.isFinite(e.maxAgeDays)
  );
}

export async function listPruneEvents(table: PruneTable, limit = MAX_EVENTS): Promise<PruneEvent[]> {
  try {
    const setting = await storage.getSystemSetting(keyFor(table));
    if (!setting?.value) return [];
    const parsed = JSON.parse(setting.value);
    if (!Array.isArray(parsed)) return [];
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), MAX_EVENTS));
    return parsed.filter(isValidEvent).slice(0, safeLimit);
  } catch {
    return [];
  }
}

export async function recordPruneEvent(table: PruneTable, event: PruneEvent): Promise<void> {
  try {
    const existing = await listPruneEvents(table);
    const next = [event, ...existing].slice(0, MAX_EVENTS);
    await storage.setSystemSetting(keyFor(table), JSON.stringify(next), "system");
  } catch (err) {
    console.error(`[auditPruneEvents] Failed to record prune event for ${table}:`, err);
  }
}
