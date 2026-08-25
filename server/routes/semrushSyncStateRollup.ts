/**
 * Pure rollup helpers for `GET /api/semrush/console/sync-state` (Task #739).
 *
 * Extracted from server/routes/heatmap.ts so the per-client outcome mapping
 * (failed / already_current / partially_refreshed / freshly_synced /
 * neverRun) can be exercised in isolation by
 * tests/semrush-console-sync-state-rollup.test.ts (Task #1212).
 *
 * Mapping rules (mirrors the legacy inline logic — DO NOT change without a
 * paired test update):
 *   • syncStatus === "error"                                  → failed
 *   • lastSyncOutcome === "already_current"                   → already_current
 *   • lastSyncOutcome === "partial_success"                   → partially_refreshed
 *   • lastSyncOutcome === "success"                           → freshly_synced
 *   • lastSyncOutcome IS NULL && syncStatus === "success"     → freshly_synced (legacy)
 *   • everything else                                         → neverRun
 *
 * The handler also guarantees that every integration row produces a
 * `perClient` bucket even when there is no matching
 * `semrush_location_sync_state` row — the per-client integration card needs
 * to render for clients whose sync queue is empty.
 */

export type IntegrationOutcome =
  | "freshly_synced"
  | "already_current"
  | "partially_refreshed"
  | "failed"
  // Task #1877: sweep-level short-circuit when SEMrush OAuth is missing.
  // Distinct from "failed" so dashboards show ONE plain-English reason
  // ("Semrush not connected") instead of an inflated per-client failure
  // count that drains the retry budget.
  | "paused_auth"
  | null;

export interface PerClientBucket {
  clientId: string;
  clientName: string | null;
  succeeded: number;
  partial: number;
  failed: number;
  stale: number;
  inProgress: number;
  skipped: number;
  pausedAuth: number;
  total: number;
  integration: {
    outcome: IntegrationOutcome;
    summary: string | null;
    syncStatus: string | null;
    lastSyncAt: string | null;
    errorMessage: string | null;
  } | null;
}

export interface OutcomeTotals {
  freshlySynced: number;
  alreadyCurrent: number;
  partiallyRefreshed: number;
  failed: number;
  pausedAuth: number;
  neverRun: number;
  totalIntegrations: number;
}

export interface SyncStateAggregateTotals {
  succeeded: number;
  partial: number;
  failed: number;
  stale: number;
  inProgress: number;
  skipped: number;
  pausedAuth: number;
  total: number;
}

export interface SyncStateRowForRollup {
  clientId: string;
  clientName: string | null;
  status: string | null;
}

export interface IntegrationRowForRollup {
  clientId: string;
  clientName: string | null;
  syncStatus: string | null;
  lastSyncOutcome: string | null;
  lastSyncSummary: string | null;
  lastSuccessfulSyncAt: Date | null;
  lastFailedSyncAt: Date | null;
  errorMessage: string | null;
}

export interface SyncStateRollupResult {
  perClient: PerClientBucket[];
  totals: SyncStateAggregateTotals;
  outcomeTotals: OutcomeTotals;
}

/**
 * Classify a single integration row into one of the five outcome buckets
 * the admin overview surfaces. Exposed for direct unit testing.
 */
export function classifyIntegrationOutcome(args: {
  syncStatus: string | null;
  lastSyncOutcome: string | null;
}): { outcome: IntegrationOutcome; bucket: keyof Omit<OutcomeTotals, "totalIntegrations"> } {
  const { syncStatus, lastSyncOutcome } = args;
  // Task #1877: paused_auth wins over "error" so the dashboard surfaces the
  // actionable reason ("Semrush not connected") instead of a generic failure
  // label that would otherwise demand per-client triage.
  if (syncStatus === "paused_auth" || lastSyncOutcome === "paused_auth") {
    return { outcome: "paused_auth", bucket: "pausedAuth" };
  }
  if (syncStatus === "error") {
    return { outcome: "failed", bucket: "failed" };
  }
  if (lastSyncOutcome === "already_current") {
    return { outcome: "already_current", bucket: "alreadyCurrent" };
  }
  if (lastSyncOutcome === "partial_success") {
    return { outcome: "partially_refreshed", bucket: "partiallyRefreshed" };
  }
  if (
    lastSyncOutcome === "success" ||
    (syncStatus === "success" && !lastSyncOutcome)
  ) {
    return { outcome: "freshly_synced", bucket: "freshlySynced" };
  }
  return { outcome: null, bucket: "neverRun" };
}

export function computeSyncStateRollup(args: {
  syncStateRows: SyncStateRowForRollup[];
  integrationRows: IntegrationRowForRollup[];
}): SyncStateRollupResult {
  const perClient = new Map<string, PerClientBucket>();
  const totals: SyncStateAggregateTotals = {
    succeeded: 0, partial: 0, failed: 0, stale: 0, inProgress: 0, skipped: 0, pausedAuth: 0, total: 0,
  };

  type StatusKey = "succeeded" | "partial" | "failed" | "stale" | "inProgress" | "skipped" | "pausedAuth";
  const statusKeyFor = (status: string | null): StatusKey => {
    switch (status) {
      case "succeeded":   return "succeeded";
      case "partial":     return "partial";
      case "failed":      return "failed";
      case "stale":       return "stale";
      case "skipped":     return "skipped";
      case "paused_auth": return "pausedAuth";
      default:            return "inProgress";
    }
  };

  for (const r of args.syncStateRows) {
    let bucket = perClient.get(r.clientId);
    if (!bucket) {
      bucket = {
        clientId: r.clientId,
        clientName: r.clientName,
        succeeded: 0, partial: 0, failed: 0, stale: 0, inProgress: 0, skipped: 0, pausedAuth: 0, total: 0,
        integration: null,
      };
      perClient.set(r.clientId, bucket);
    }
    bucket.total += 1;
    totals.total += 1;
    const k = statusKeyFor(r.status);
    bucket[k] += 1;
    totals[k] += 1;
  }

  const outcomeTotals: OutcomeTotals = {
    freshlySynced: 0,
    alreadyCurrent: 0,
    partiallyRefreshed: 0,
    failed: 0,
    pausedAuth: 0,
    neverRun: 0,
    totalIntegrations: 0,
  };

  for (const ir of args.integrationRows) {
    outcomeTotals.totalIntegrations += 1;
    const { outcome, bucket: bucketKey } = classifyIntegrationOutcome({
      syncStatus: ir.syncStatus,
      lastSyncOutcome: ir.lastSyncOutcome,
    });
    outcomeTotals[bucketKey] += 1;

    const lastSyncAt: Date | null = ir.lastSuccessfulSyncAt ?? ir.lastFailedSyncAt ?? null;
    const integration = {
      outcome,
      summary: ir.lastSyncSummary ?? null,
      syncStatus: ir.syncStatus ?? null,
      lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
      errorMessage: ir.errorMessage ?? null,
    };

    let bucket = perClient.get(ir.clientId);
    if (!bucket) {
      bucket = {
        clientId: ir.clientId,
        clientName: ir.clientName,
        succeeded: 0, partial: 0, failed: 0, stale: 0, inProgress: 0, skipped: 0, pausedAuth: 0, total: 0,
        integration,
      };
      perClient.set(ir.clientId, bucket);
    } else {
      bucket.integration = integration;
      if (!bucket.clientName) bucket.clientName = ir.clientName;
    }
  }

  const sorted = Array.from(perClient.values()).sort((a, b) => {
    // Task #1877: paused_auth is an actionable system-wide signal (re-auth
    // unblocks every client at once), so it sorts to the top above generic
    // failures which require per-client triage.
    const integrationScore = (c: PerClientBucket) =>
      c.integration?.outcome === "paused_auth" ? 300 :
      c.integration?.outcome === "failed" ? 200 :
      c.integration?.outcome === "partially_refreshed" ? 25 :
      0;
    const score = (c: PerClientBucket) =>
      (c.pausedAuth * 150) + (c.failed * 100) + (c.stale * 50) + (c.partial * 10) + integrationScore(c);
    return score(b) - score(a);
  });

  return { perClient: sorted, totals, outcomeTotals };
}
