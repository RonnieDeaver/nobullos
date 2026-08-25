// Task #2485 — RIS effective-rule resolution.
//
// Both the QA auto-pull (risAutoPull.ts) and the Performance pull
// (risPerformancePull.ts) must resolve the rule that drives a BigQuery query
// through ONE shared path: a per-client override (ris_client_auto_source_overrides)
// layered over the global per-`auto_source` mapping (ris_auto_source_mappings).
//
// Resolution order (per field): per-client override → global mapping.
// An override field that is null/undefined means "inherit the global value";
// a non-null value wins. There is no per-override `enabled` flag — the global
// mapping's `enabled` toggle still governs whether a check pulls at all.

import type {
  RisAutoSourceMapping,
  RisClientAutoSourceOverride,
} from "@shared/schema";

/** The effective rule after merging a per-client override over the global
 *  mapping. Field shapes mirror the global mapping so the pulls can treat a
 *  resolved rule and a raw mapping uniformly. `filterValue` has no global
 *  fallback — it only ever comes from an override (null when unset). */
export interface ResolvedRisRule {
  autoSource: string;
  enabled: boolean;
  sqlTemplate: string;
  valueColumn: string;
  comparator: string;
  threshold: string | null;
  unitLabel: string | null;
  bqLocation: string | null;
  filterValue: string | null;
}

/** First non-null/undefined value, else null. Treats an override field of
 *  null/undefined as "inherit". */
function pick<T>(override: T | null | undefined, base: T | null | undefined): T | null {
  if (override !== null && override !== undefined) return override;
  return base ?? null;
}

/**
 * Merge a per-client override over the global mapping. Returns null when no
 * global mapping exists for the auto-source (the caller degrades that to
 * needs_review / gray, never a silent Pass). `unitLabel` is intentionally not
 * overridable — it is display-only and stays global.
 */
export function resolveRisRule(
  mapping: RisAutoSourceMapping | undefined,
  override: RisClientAutoSourceOverride | undefined,
): ResolvedRisRule | null {
  if (!mapping) return null;
  return {
    autoSource: mapping.autoSource,
    enabled: mapping.enabled,
    sqlTemplate: pick(override?.sqlTemplate, mapping.sqlTemplate) ?? "",
    valueColumn: pick(override?.valueColumn, mapping.valueColumn) ?? "value",
    comparator: pick(override?.comparator, mapping.comparator) ?? "none",
    threshold: pick(override?.threshold, mapping.threshold),
    unitLabel: mapping.unitLabel ?? null,
    bqLocation: pick(override?.bqLocation, mapping.bqLocation),
    filterValue: override?.filterValue ?? null,
  };
}

/** Key a per-client override list by `${clientId}:${autoSource}` so a pull can
 *  look up the override for a given (client, auto-source) in O(1). */
export function indexOverridesByClientSource(
  overrides: RisClientAutoSourceOverride[],
): Map<string, RisClientAutoSourceOverride> {
  return new Map(overrides.map((o) => [`${o.clientId}:${o.autoSource}`, o]));
}

/** True when a resolved SQL template references the `@clientKey` named param.
 *  When it does and the client has no key set, the check must degrade to
 *  needs_review (QA) / gray (Performance) instead of running with a null key. */
export function templateNeedsClientKey(sqlTemplate: string): boolean {
  // `@clientKey` followed by a non-word char (or end) — avoids matching e.g.
  // a longer `@clientKeyword` placeholder.
  return /@clientKey\b/.test(sqlTemplate ?? "");
}
