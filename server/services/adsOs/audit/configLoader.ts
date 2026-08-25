/**
 * Ads OS — audit config loader (port of backend/app/audit/config_loader.py).
 *
 * The Python source loads checks.yaml + weights.yaml once (lru_cache) and
 * exposes lookup helpers. Here the same data ships as TS constants
 * (checksConfig.ts / weightsConfig.ts — verbatim ports of the YAML), so
 * "loading" is just flattening the catalog once at module init. Semantics of
 * every helper match the Python original.
 */

import { CHECKS_BY_CATEGORY, type CheckDef } from "./checksConfig";
import { WEIGHTS, type ImpactLevel, type WeightsConfig } from "./weightsConfig";

export interface CheckMeta extends CheckDef {
  category: string;
}

let flatChecks: Map<string, CheckMeta> | null = null;

export function loadWeights(): WeightsConfig {
  return WEIGHTS;
}

/** Flatten the check catalog into {check_id: metadata} for easy lookup. */
export function loadChecks(): Map<string, CheckMeta> {
  if (!flatChecks) {
    flatChecks = new Map();
    for (const [category, items] of Object.entries(CHECKS_BY_CATEGORY)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        flatChecks.set(item.id, { ...item, category });
      }
    }
  }
  return flatChecks;
}

export function checkMeta(checkId: string): CheckMeta | undefined {
  return loadChecks().get(checkId);
}

export function categoryName(code: string): string {
  return loadWeights().categories[code]?.name ?? code;
}

/** Performance impact tier for a check: critical | high | medium | low. */
export function impactLevel(checkId: string): ImpactLevel {
  return loadWeights().impact[checkId] ?? "medium";
}

/** Global weight a check carries in the overall (flat) average. */
export function impactWeight(checkId: string): number {
  const w = loadWeights().impact_weights;
  return Number(w[impactLevel(checkId)] ?? 1);
}

export function isCriticalImpact(checkId: string): boolean {
  return impactLevel(checkId) === "critical";
}

/**
 * Effective score cap given the failing critical checks (null if none).
 *
 * cap = critical_default - per_additional * (count - 1), floored; then any
 * per-check hard override in caps.by_check (currently none) lowers it further.
 */
export function dynamicCap(failingCriticalIds: string[]): number | null {
  if (!failingCriticalIds.length) return null;
  const caps = loadWeights().caps;
  const base = caps.critical_default ?? 65;
  const step = caps.per_additional ?? 10;
  const floor = caps.floor ?? 10;
  const byCheck = caps.by_check ?? {};
  let cap = base - step * (failingCriticalIds.length - 1);
  for (const cid of failingCriticalIds) {
    if (cid in byCheck) cap = Math.min(cap, byCheck[cid]);
  }
  return Math.max(cap, floor);
}
