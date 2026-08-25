/**
 * Cutover Guard — controls the staged migration from legacy direct-mutation
 * paths to the durable pipeline for each integration source.
 *
 * DECISION MATRIX:
 *   legacy ON  + durable ON  → shadowMode=true  (both run, compare results)
 *   legacy OFF + durable ON  → shadowMode=false  (durable only — target state)
 *   legacy ON  + durable OFF → shadowMode=false  (legacy only — pre-cutover)
 *
 * Shadow mode is a transitional safety net: both legacy and durable paths run,
 * results are compared via logShadowComparison(), and the legacy result is
 * authoritative. Once shadow logs show consistent matches, disable legacy flags
 * to complete the cutover. Shadow mode infrastructure should be removed once
 * all sources reach durable-only state.
 *
 * RELEVANT ENV FLAGS (per-source):
 *   Front:   FRONT_EVENT_INGEST_ENABLED, FRONT_PIPELINE_FETCH_SPLIT_ENABLED,
 *            FRONT_PIPELINE_PROCESS_SPLIT_ENABLED, FRONT_PIPELINE_APPLY_ENABLED,
 *            FRONT_LEGACY_INLINE_PROCESSING_ENABLED, LEGACY_DIRECT_MUTATION_FRONT_ENABLED
 *   Zoom:    ZOOM_EVENT_INGEST_ENABLED, LEGACY_DIRECT_MUTATION_ZOOM_ENABLED
 *   Semrush: SEMRUSH_INVENTORY_SYNC_ENABLED, SEMRUSH_REPORT_REFRESH_ENABLED,
 *            LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED
 *   Global:  DURABLE_APPLY_ENABLED
 */
import { PERF } from "../perfConfig";

export type SourceName = "front" | "zoom" | "semrush";

export interface CutoverDecision {
  runLegacy: boolean;
  runDurable: boolean;
  shadowMode: boolean;
  reason: string;
}

export function getCutoverDecision(source: SourceName): CutoverDecision {
  const durableApply = PERF.DURABLE_APPLY_ENABLED;

  let sourceIngestEnabled: boolean;
  let legacyEnabled: boolean;

  switch (source) {
    case "front":
      sourceIngestEnabled = PERF.FRONT_EVENT_INGEST_ENABLED;
      legacyEnabled = PERF.LEGACY_DIRECT_MUTATION_FRONT_ENABLED || PERF.FRONT_LEGACY_INLINE_PROCESSING_ENABLED;
      break;
    case "zoom":
      sourceIngestEnabled = PERF.ZOOM_EVENT_INGEST_ENABLED;
      legacyEnabled = PERF.LEGACY_DIRECT_MUTATION_ZOOM_ENABLED;
      break;
    case "semrush":
      sourceIngestEnabled = PERF.SEMRUSH_INVENTORY_SYNC_ENABLED || PERF.SEMRUSH_REPORT_REFRESH_ENABLED;
      legacyEnabled = PERF.LEGACY_DIRECT_MUTATION_SEMRUSH_ENABLED;
      break;
  }

  if (source === "front") {
    const pipelineActive = sourceIngestEnabled
      && PERF.FRONT_PIPELINE_FETCH_SPLIT_ENABLED
      && PERF.FRONT_PIPELINE_PROCESS_SPLIT_ENABLED
      && PERF.FRONT_PIPELINE_APPLY_ENABLED;
    const legacyInline = PERF.FRONT_LEGACY_INLINE_PROCESSING_ENABLED
      || PERF.LEGACY_DIRECT_MUTATION_FRONT_ENABLED;

    if (pipelineActive && legacyInline) {
      return {
        runLegacy: true,
        runDurable: true,
        shadowMode: true,
        reason: "shadow_mode: front pipeline active alongside legacy inline",
      };
    }

    if (pipelineActive && !legacyInline) {
      return {
        runLegacy: false,
        runDurable: true,
        shadowMode: false,
        reason: "durable_only: front pipeline cutover complete, legacy inline disabled",
      };
    }
  }

  const durableActive = sourceIngestEnabled && durableApply;

  if (durableActive && legacyEnabled) {
    return {
      runLegacy: true,
      runDurable: true,
      shadowMode: true,
      reason: `shadow_mode: both durable and legacy active for ${source}`,
    };
  }

  if (durableActive && !legacyEnabled) {
    return {
      runLegacy: false,
      runDurable: true,
      shadowMode: false,
      reason: `durable_only: legacy disabled for ${source}`,
    };
  }

  return {
    runLegacy: true,
    runDurable: false,
    shadowMode: false,
    reason: `legacy_only: durable pipeline not active for ${source}`,
  };
}

export interface ShadowComparisonResult {
  source: SourceName;
  operation: string;
  legacyOutcome: "success" | "skipped" | "error";
  durableOutcome: "success" | "skipped" | "error" | "not_run";
  match: boolean;
  legacyRecordId?: string;
  durableRecordId?: string;
  legacyError?: string;
  durableError?: string;
  durationLegacyMs?: number;
  durableDurationMs?: number;
  timestamp: string;
}

const shadowComparisonLog: ShadowComparisonResult[] = [];
const MAX_SHADOW_LOG = 500;

export function logShadowComparison(result: ShadowComparisonResult): void {
  shadowComparisonLog.push(result);
  if (shadowComparisonLog.length > MAX_SHADOW_LOG) {
    shadowComparisonLog.splice(0, shadowComparisonLog.length - MAX_SHADOW_LOG);
  }

  const matchLabel = result.match ? "MATCH" : "MISMATCH";
  const prefix = `[CutoverShadow:${result.source}]`;

  if (result.match) {
    console.log(
      `${prefix} ${matchLabel} op=${result.operation} legacy=${result.legacyOutcome} durable=${result.durableOutcome}`,
    );
  } else {
    console.warn(
      `${prefix} ${matchLabel} op=${result.operation} legacy=${result.legacyOutcome} durable=${result.durableOutcome}` +
        (result.legacyError ? ` legacyErr=${result.legacyError}` : "") +
        (result.durableError ? ` durableErr=${result.durableError}` : ""),
    );
  }
}

export function getShadowComparisonLog(source?: SourceName, limit = 50): ShadowComparisonResult[] {
  let filtered = source
    ? shadowComparisonLog.filter((r) => r.source === source)
    : shadowComparisonLog;
  return filtered.slice(-limit);
}

export function getShadowComparisonSummary(): Record<SourceName, { total: number; matches: number; mismatches: number }> {
  const summary: Record<SourceName, { total: number; matches: number; mismatches: number }> = {
    front: { total: 0, matches: 0, mismatches: 0 },
    zoom: { total: 0, matches: 0, mismatches: 0 },
    semrush: { total: 0, matches: 0, mismatches: 0 },
  };

  for (const entry of shadowComparisonLog) {
    const s = summary[entry.source];
    s.total++;
    if (entry.match) s.matches++;
    else s.mismatches++;
  }

  return summary;
}
