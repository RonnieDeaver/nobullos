/**
 * Dependency-free leaf module: pure helpers for detecting whether an Ads OS
 * criteria doc is "seeded-minimal" (no operator content) and whether it has
 * passed the 7-day staleness threshold.
 *
 * Extracted from seededCriteriaIncompletenessAlerts.ts so that
 * platformOpsActions.ts (which imports SCHEDULE_SYNC_TARGETS from this
 * directory) can also use these helpers without creating a static import cycle.
 *
 * This module intentionally has NO imports — it must remain a pure leaf so
 * the server import-cycle gate stays green.
 */

/** Grace window before a seeded-but-incomplete doc is considered overdue. */
export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the raw stored doc has no operator-authored content. */
export function isSeededMinimal(rawDoc: Record<string, any>): boolean {
  const name = typeof rawDoc.business_name === "string" ? rawDoc.business_name.trim() : "";
  const area = typeof rawDoc.service_area === "string" ? rawDoc.service_area.trim() : "";
  return name === "" && area === "";
}

/** True when the stored doc's updated_at is older than the stale threshold. */
export function isOverdue(rawDoc: Record<string, any>, now: number): boolean {
  const ts = typeof rawDoc.updated_at === "string" ? Date.parse(rawDoc.updated_at) : NaN;
  if (!Number.isFinite(ts)) return false; // can't determine age — skip
  return now - ts >= STALE_THRESHOLD_MS;
}
