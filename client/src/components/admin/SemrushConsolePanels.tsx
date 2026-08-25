import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  ListChecks,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BreakerDetailRow } from "@/components/admin/BreakerDetailRow";

// Task #2177 — SEMrush auth-dead breaker detail forwarded by GET
// /api/integrations/all-status, surfaced on the dedicated console so an operator
// who lands here sees the same "Disconnected at / Auto-retry at / N trips"
// detail the Integrations Hub shows.
type SemrushBreakerStatus = {
  breakerOpen?: boolean;
  cooldownRemainingMs?: number;
  lastTrippedAt?: string | null;
  cooldownUntil?: string | null;
  tripCount?: number;
};

function formatTime(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return String(s);
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m ${rs}s`;
}

function relAge(s: string | null | undefined): string {
  if (!s) return "—";
  const ms = Date.now() - new Date(s).getTime();
  if (Number.isNaN(ms)) return "—";
  return formatDuration(ms) + " ago";
}

// ---------------------------------------------------------------------------
// Pipeline Health panel
// ---------------------------------------------------------------------------

interface OverviewResponse {
  connection: {
    status: "connected" | "expired" | "pending" | "disconnected";
    // Task #3670 — how SEMrush authenticates: v4 API key vs OAuth device flow.
    authMode?: "api_key" | "oauth";
    tokenExpiresAt: string | null;
    tokenExpiresInMs: number | null;
  };
  inventory: {
    isRunning: boolean;
    campaignCount: number;
    lastFetchedAt: string | null;
    flags: { inventorySyncEnabled: boolean; reportRefreshEnabled: boolean };
    durability: string;
  };
  queues: Array<{
    queueName: string;
    backlog: number;
    processing: number;
    failed24h: number;
    completed24h: number;
    enqueued24h: number;
    deadLetter: number;
    lastCompletedAt: string | null;
  }>;
  locationSync: { counts: Record<string, number>; awaitingAutoRetry: number };
  staleLease: { countInWindow: number; windowMs: number; threshold: number; durability: string };
  // Task #1973: 24h counter for semrush_keyword_inventory_bailout events.
  keywordInventoryBailouts?: {
    countInWindow: number;
    windowMs: number;
    byReason: Record<string, number>;
    recent: Array<{
      ts: number;
      campaignId: string;
      incompleteReason: string;
      pagesWalked: number;
      keywordCount: number;
    }>;
    durability: string;
  };
  generatedAt: string;
}

function ConnectionBadge({ status }: { status: OverviewResponse["connection"]["status"] }) {
  if (status === "connected") {
    return (
      <Badge variant="outline" className="border-green-500 text-green-700" data-testid="badge-connection-status">
        <CheckCircle2 className="w-3 h-3 mr-1" />Connected
      </Badge>
    );
  }
  if (status === "expired") {
    return (
      <Badge variant="outline" className="border-amber-500 text-amber-700" data-testid="badge-connection-status">
        <AlertTriangle className="w-3 h-3 mr-1" />Token expired
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge variant="outline" className="border-blue-500 text-blue-700" data-testid="badge-connection-status">
        <Loader2 className="w-3 h-3 mr-1 animate-spin" />Pending device flow
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-slate-400 text-muted-foreground" data-testid="badge-connection-status">
      <XCircle className="w-3 h-3 mr-1" />Not connected
    </Badge>
  );
}

export function SemrushOverviewPanel() {
  const { data, isLoading, isError, error } = useQuery<OverviewResponse>({
    queryKey: ["/api/semrush/console/overview"],
    queryFn: async () => {
      const res = await fetch("/api/semrush/console/overview", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load overview");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  // Task #2177 — auth-dead breaker detail from the shared all-status endpoint.
  const { data: allStatus } = useQuery<{ semrush?: SemrushBreakerStatus }>({
    queryKey: ["/api/integrations/all-status"],
  });
  const semrushBreaker = allStatus?.semrush;

  return (
    <Card data-testid="section-semrush-overview">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
          <Activity className="w-5 h-5 text-blue-600" />
          Overview & Pipeline Health
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Connection state, inventory freshness, queue backlogs, and worker health.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="overview-loading">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading pipeline health…
          </div>
        )}
        {isError && (
          <div className="text-sm text-red-700" data-testid="overview-error">
            Failed to load pipeline health: {(error as Error)?.message ?? "unknown error"}
          </div>
        )}
        {data && (
          <>
            {/* Connection + inventory row */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div
                className="border border-border rounded-md p-3 bg-card"
                data-testid="card-connection-status"
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Connection</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <ConnectionBadge status={data.connection.status} />
                  {/* Task #3670 — v4 API-key mode indicator (OAuth dormant). */}
                  {data.connection.authMode === "api_key" && (
                    <Badge
                      variant="outline"
                      className="border-purple-400 text-purple-700"
                      data-testid="badge-semrush-auth-mode"
                    >
                      API key
                    </Badge>
                  )}
                  {data.connection.tokenExpiresAt && (
                    <span className="text-xs text-muted-foreground" data-testid="text-token-expires">
                      Token expires {formatTime(data.connection.tokenExpiresAt)}
                    </span>
                  )}
                </div>
                {semrushBreaker?.breakerOpen && (
                  <div className="mt-2">
                    <BreakerDetailRow
                      lastTrippedAt={semrushBreaker.lastTrippedAt}
                      cooldownUntil={semrushBreaker.cooldownUntil}
                      tripCount={semrushBreaker.tripCount}
                      testIdPrefix="semrush"
                    />
                  </div>
                )}
              </div>
              <div
                className="border border-border rounded-md p-3 bg-card"
                data-testid="card-inventory-status"
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                  <Database className="w-3 h-3" />
                  Inventory snapshot
                </div>
                <div className="text-sm" data-testid="text-inventory-summary">
                  <span className="font-medium">{data.inventory.campaignCount}</span> campaigns
                  {" · "}
                  fetched {data.inventory.lastFetchedAt ? relAge(data.inventory.lastFetchedAt) : "never"}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {data.inventory.isRunning ? "Sync running now · " : ""}
                  Inventory sync {data.inventory.flags.inventorySyncEnabled ? "enabled" : "disabled"}
                  {" · "}
                  Report refresh {data.inventory.flags.reportRefreshEnabled ? "enabled" : "disabled"}
                </div>
              </div>
            </div>

            {/* Per-queue table */}
            <div className="border border-border rounded-md bg-card overflow-x-auto">
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">Queues</h4>
                <span className="text-xs text-muted-foreground">durable · from work_queue</span>
              </div>
              <table className="w-full text-xs sm:text-sm min-w-[640px]">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="px-3 py-2">Queue</th>
                    <th className="px-3 py-2">Backlog</th>
                    <th className="px-3 py-2">Processing</th>
                    <th className="px-3 py-2">24h enqueued</th>
                    <th className="px-3 py-2">24h completed</th>
                    <th className="px-3 py-2">24h failed</th>
                    <th className="px-3 py-2">Dead-letter</th>
                    <th className="px-3 py-2">Last success</th>
                  </tr>
                </thead>
                <tbody>
                  {data.queues.map(q => (
                    <tr
                      key={q.queueName}
                      className="border-t border-border"
                      data-testid={`row-queue-${q.queueName}`}
                    >
                      <td className="px-3 py-2 font-mono text-xs">{q.queueName}</td>
                      <td className="px-3 py-2" data-testid={`text-backlog-${q.queueName}`}>{q.backlog}</td>
                      <td className="px-3 py-2">{q.processing}</td>
                      <td className="px-3 py-2">{q.enqueued24h}</td>
                      <td className="px-3 py-2">{q.completed24h}</td>
                      <td
                        className={q.failed24h > 0 ? "px-3 py-2 text-red-700 font-medium" : "px-3 py-2"}
                        data-testid={`text-failed24h-${q.queueName}`}
                      >
                        {q.failed24h}
                      </td>
                      <td
                        className={q.deadLetter > 0 ? "px-3 py-2 text-red-700 font-medium" : "px-3 py-2"}
                        data-testid={`text-deadletter-${q.queueName}`}
                      >
                        {q.deadLetter}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {q.lastCompletedAt ? relAge(q.lastCompletedAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Worker / location-sync summary */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div
                className="border border-border rounded-md p-3 bg-card"
                data-testid="card-location-sync-summary"
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Per-location auto-retry worker
                </div>
                <div className="text-sm">
                  <span className="font-medium" data-testid="text-awaiting-retry">
                    {data.locationSync.awaitingAutoRetry}
                  </span>{" "}
                  failed locations awaiting auto-retry
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-2">
                  {Object.entries(data.locationSync.counts).map(([k, v]) => (
                    <span key={k} data-testid={`text-locsync-count-${k}`}>
                      {k}: <span className="font-medium">{v}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div
                className="border border-border rounded-md p-3 bg-card"
                data-testid="card-stale-lease"
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Stale-lease exhaustion
                </div>
                <div className="text-sm" data-testid="text-stale-lease">
                  <span
                    className={
                      data.staleLease.countInWindow >= data.staleLease.threshold
                        ? "font-medium text-red-700"
                        : "font-medium"
                    }
                  >
                    {data.staleLease.countInWindow}
                  </span>{" "}
                  in last {Math.round(data.staleLease.windowMs / 60_000)}m (alert ≥ {data.staleLease.threshold})
                </div>
                <div className="text-xs text-muted-foreground mt-1 italic">
                  In-memory · resets on server restart
                </div>
              </div>
              {data.keywordInventoryBailouts && (
                <div
                  className="border border-border rounded-md p-3 bg-card"
                  data-testid="card-keyword-inventory-bailouts"
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    Keyword-inventory bailouts (24h)
                  </div>
                  <div className="text-sm" data-testid="text-keyword-inventory-bailout-count">
                    <span
                      className={
                        data.keywordInventoryBailouts.countInWindow > 0
                          ? "font-medium text-amber-700"
                          : "font-medium"
                      }
                    >
                      {data.keywordInventoryBailouts.countInWindow}
                    </span>{" "}
                    pagination misfires in last {Math.round(data.keywordInventoryBailouts.windowMs / 3_600_000)}h
                  </div>
                  {Object.keys(data.keywordInventoryBailouts.byReason).length > 0 && (
                    <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-2">
                      {Object.entries(data.keywordInventoryBailouts.byReason).map(([reason, n]) => (
                        <span key={reason} data-testid={`text-kw-bailout-reason-${reason}`}>
                          {reason}: <span className="font-medium">{n}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1 italic">
                    In-memory · resets on server restart
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cross-client Sync State panel
// ---------------------------------------------------------------------------

interface SyncStateRow {
  id: string;
  clientId: string;
  clientName: string | null;
  locationId: string;
  locationName: string | null;
  locationCity: string | null;
  locationState: string | null;
  campaignId: string;
  campaignName: string | null;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  errorCategory: string | null;
  nextRetryAt: string | null;
  importedKeywordCount: number;
  expectedKeywordCount: number;
  durationMs: number | null;
  triggeredBy: string | null;
  updatedAt: string | null;
}

type IntegrationOutcome =
  | "freshly_synced"
  | "already_current"
  | "partially_refreshed"
  | "failed"
  // Task #1877: sweep-level pause when SEMrush OAuth is missing.
  | "paused_auth"
  | null;

interface PerClientRollup {
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

interface SyncStateResponse {
  rows: SyncStateRow[];
  perClient: PerClientRollup[];
  totals: {
    succeeded: number;
    partial: number;
    failed: number;
    stale: number;
    inProgress: number;
    skipped: number;
    pausedAuth: number;
    total: number;
  };
  outcomeTotals: {
    freshlySynced: number;
    alreadyCurrent: number;
    partiallyRefreshed: number;
    failed: number;
    pausedAuth: number;
    neverRun: number;
    totalIntegrations: number;
  };
  generatedAt: string;
}

function IntegrationOutcomeBadge({
  outcome,
  summary,
  errorMessage,
  testIdSuffix,
}: {
  outcome: IntegrationOutcome;
  summary: string | null;
  errorMessage: string | null;
  testIdSuffix: string;
}) {
  if (outcome === null) {
    return (
      <Badge
        variant="outline"
        className="border-border text-muted-foreground"
        data-testid={`badge-integration-outcome-never-${testIdSuffix}`}
      >
        Never run
      </Badge>
    );
  }
  if (outcome === "paused_auth") {
    return (
      <Badge
        variant="outline"
        className="border-orange-500 text-orange-700"
        title={summary ?? errorMessage ?? "Semrush not connected — re-authorize in Integrations Hub"}
        data-testid={`badge-integration-outcome-paused-auth-${testIdSuffix}`}
      >
        <AlertTriangle className="w-3 h-3 mr-1" /> Paused (auth)
      </Badge>
    );
  }
  if (outcome === "failed") {
    return (
      <Badge
        variant="outline"
        className="border-red-500 text-red-700"
        title={errorMessage ?? undefined}
        data-testid={`badge-integration-outcome-failed-${testIdSuffix}`}
      >
        <XCircle className="w-3 h-3 mr-1" /> Failed
      </Badge>
    );
  }
  if (outcome === "already_current") {
    return (
      <Badge
        variant="outline"
        className="border-sky-500 text-sky-700"
        title={summary ?? "Data already current"}
        data-testid={`badge-integration-outcome-already-current-${testIdSuffix}`}
      >
        <CheckCircle2 className="w-3 h-3 mr-1" /> Already current
      </Badge>
    );
  }
  if (outcome === "partially_refreshed") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500 text-amber-700"
        title={summary ?? errorMessage ?? "Partially refreshed"}
        data-testid={`badge-integration-outcome-partial-${testIdSuffix}`}
      >
        <AlertTriangle className="w-3 h-3 mr-1" /> Partially refreshed
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-green-500 text-green-700"
      title={summary ?? undefined}
      data-testid={`badge-integration-outcome-fresh-${testIdSuffix}`}
    >
      <CheckCircle2 className="w-3 h-3 mr-1" /> Freshly synced
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "succeeded") {
    return <Badge variant="outline" className="border-green-500 text-green-700"><CheckCircle2 className="w-3 h-3 mr-1" />Synced</Badge>;
  }
  if (status === "in_progress" || status === "queued") {
    return <Badge variant="outline" className="border-blue-500 text-blue-700"><Loader2 className="w-3 h-3 mr-1 animate-spin" />{status === "queued" ? "Queued" : "Syncing"}</Badge>;
  }
  if (status === "partial") {
    return <Badge variant="outline" className="border-amber-500 text-amber-700"><AlertTriangle className="w-3 h-3 mr-1" />Partial</Badge>;
  }
  if (status === "stale") {
    return <Badge variant="outline" className="border-slate-400 text-muted-foreground"><AlertTriangle className="w-3 h-3 mr-1" />Stale</Badge>;
  }
  if (status === "skipped") {
    return <Badge variant="outline" className="border-border text-muted-foreground">Skipped</Badge>;
  }
  if (status === "paused_auth") {
    return <Badge variant="outline" className="border-orange-500 text-orange-700"><AlertTriangle className="w-3 h-3 mr-1" />Paused (auth)</Badge>;
  }
  return <Badge variant="outline" className="border-red-500 text-red-700"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
}

export function SemrushSyncStatePanel() {
  const { data, isLoading, isError, error } = useQuery<SyncStateResponse>({
    queryKey: ["/api/semrush/console/sync-state"],
    queryFn: async () => {
      const res = await fetch("/api/semrush/console/sync-state", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load sync state");
      return res.json();
    },
    refetchInterval: (q) => {
      const rows = (q.state.data as SyncStateResponse | undefined)?.rows;
      const active = rows?.some(r => r.status === "in_progress" || r.status === "queued");
      return active ? 5_000 : 30_000;
    },
  });

  // Surface the most attention-worthy rows first.
  const sorted = data?.rows
    ? [...data.rows].sort((a, b) => {
        const order = (s: string) =>
          s === "failed" ? 0 :
          s === "stale" ? 1 :
          s === "partial" ? 2 :
          s === "in_progress" || s === "queued" ? 3 :
          4;
        return order(a.status) - order(b.status);
      })
    : [];

  return (
    <Card data-testid="section-semrush-sync-state">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
          <Database className="w-5 h-5 text-emerald-600" />
          Sync State
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Per-location SEMrush sync outcomes across all clients. Drill into a client's Local
          Dominance dashboard for attempt history and manual retry.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="sync-state-loading">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading sync state…
          </div>
        )}
        {isError && (
          <div className="text-sm text-red-700" data-testid="sync-state-error">
            Failed to load sync state: {(error as Error)?.message ?? "unknown error"}
          </div>
        )}
        {data && data.totals.total === 0 && data.outcomeTotals.totalIntegrations === 0 && (
          <p className="text-sm text-muted-foreground italic" data-testid="sync-state-empty">
            No SEMrush sync state rows yet. Configure a client mapping to start tracking syncs.
          </p>
        )}
        {data && (data.totals.total > 0 || data.outcomeTotals.totalIntegrations > 0) && (
          <>
            {data.outcomeTotals.pausedAuth > 0 && (
              <div
                className="flex items-start gap-2 border border-orange-300 bg-orange-50 text-orange-900 rounded-md px-3 py-2 text-sm"
                data-testid="banner-paused-auth"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Semrush not connected</p>
                  <p className="text-xs text-orange-800">
                    Sweep is paused for {data.outcomeTotals.pausedAuth} client{data.outcomeTotals.pausedAuth === 1 ? "" : "s"}.
                    Reconnect in Integrations Hub to resume — no per-client retry is needed.
                  </p>
                </div>
              </div>
            )}
            {data.outcomeTotals.totalIntegrations > 0 && (
              <div
                className="flex flex-wrap gap-3 text-xs sm:text-sm border border-border rounded-md bg-muted/50 px-3 py-2"
                data-testid="integration-outcome-totals"
              >
                <span className="font-medium text-foreground">
                  Per-client integration outcomes:
                </span>
                <span className="text-green-700" data-testid="text-outcome-fresh">
                  {data.outcomeTotals.freshlySynced} freshly synced
                </span>
                <span className="text-sky-700" data-testid="text-outcome-already-current">
                  {data.outcomeTotals.alreadyCurrent} already current
                </span>
                <span className="text-amber-700" data-testid="text-outcome-partial">
                  {data.outcomeTotals.partiallyRefreshed} partially refreshed
                </span>
                <span className="text-red-700" data-testid="text-outcome-failed">
                  {data.outcomeTotals.failed} failed
                </span>
                {data.outcomeTotals.pausedAuth > 0 && (
                  <span className="text-orange-700" data-testid="text-outcome-paused-auth">
                    {data.outcomeTotals.pausedAuth} paused (auth)
                  </span>
                )}
                {data.outcomeTotals.neverRun > 0 && (
                  <span className="text-muted-foreground" data-testid="text-outcome-never-run">
                    {data.outcomeTotals.neverRun} never run
                  </span>
                )}
              </div>
            )}
            <div
              className="flex flex-wrap gap-3 text-xs sm:text-sm"
              data-testid="sync-state-totals"
            >
              <span><span className="font-medium">{data.totals.total}</span> tracked</span>
              {data.totals.succeeded > 0 && (
                <span className="text-green-700" data-testid="text-totals-succeeded">
                  {data.totals.succeeded} synced
                </span>
              )}
              {data.totals.partial > 0 && (
                <span className="text-amber-700" data-testid="text-totals-partial">
                  {data.totals.partial} partial
                </span>
              )}
              {data.totals.failed > 0 && (
                <span className="text-red-700" data-testid="text-totals-failed">
                  {data.totals.failed} failed
                </span>
              )}
              {data.totals.stale > 0 && (
                <span className="text-muted-foreground" data-testid="text-totals-stale">
                  {data.totals.stale} stale
                </span>
              )}
              {data.totals.inProgress > 0 && (
                <span className="text-blue-700" data-testid="text-totals-in-progress">
                  {data.totals.inProgress} in-flight
                </span>
              )}
            </div>

            {/* Per-client rollup */}
            <div className="border border-border rounded-md bg-card overflow-x-auto">
              <div className="px-3 py-2 border-b border-border">
                <h4 className="text-sm font-semibold text-foreground">Per-client outcomes</h4>
              </div>
              <table className="w-full text-xs sm:text-sm min-w-[720px]">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="px-3 py-2">Client</th>
                    <th className="px-3 py-2">Last sync outcome</th>
                    <th className="px-3 py-2">Total</th>
                    <th className="px-3 py-2">Synced</th>
                    <th className="px-3 py-2">Partial</th>
                    <th className="px-3 py-2">Failed</th>
                    <th className="px-3 py-2">Stale</th>
                    <th className="px-3 py-2">In-flight</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perClient.map(c => (
                    <tr
                      key={c.clientId}
                      className="border-t border-border"
                      data-testid={`row-client-rollup-${c.clientId}`}
                    >
                      <td className="px-3 py-2 truncate max-w-[220px]">
                        {c.clientName || c.clientId.slice(0, 8)}
                      </td>
                      <td className="px-3 py-2">
                        {c.integration ? (
                          <IntegrationOutcomeBadge
                            outcome={c.integration.outcome}
                            summary={c.integration.summary}
                            errorMessage={c.integration.errorMessage}
                            testIdSuffix={c.clientId}
                          />
                        ) : (
                          <span className="text-muted-foreground text-xs">No integration</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{c.total}</td>
                      <td className="px-3 py-2">{c.succeeded}</td>
                      <td className={c.partial > 0 ? "px-3 py-2 text-amber-700" : "px-3 py-2"}>
                        {c.partial}
                      </td>
                      <td className={c.failed > 0 ? "px-3 py-2 text-red-700 font-medium" : "px-3 py-2"}>
                        {c.failed}
                      </td>
                      <td className={c.stale > 0 ? "px-3 py-2 text-muted-foreground" : "px-3 py-2"}>
                        {c.stale}
                      </td>
                      <td className={c.inProgress > 0 ? "px-3 py-2 text-blue-700" : "px-3 py-2"}>
                        {c.inProgress}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cross-client row list — attention-worthy first. */}
            <div className="border border-border rounded-md bg-card">
              <div className="px-3 py-2 border-b border-border">
                <h4 className="text-sm font-semibold text-foreground">
                  All locations
                </h4>
              </div>
              <div className="divide-y divide-border">
                {sorted.map(r => (
                  <div
                    key={r.id}
                    className="px-3 py-2 flex items-start justify-between gap-3"
                    data-testid={`row-sync-state-${r.locationId}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground truncate">
                          {r.clientName || r.clientId.slice(0, 8)}
                        </span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-sm text-foreground truncate">
                          {r.locationName || r.locationId.slice(0, 8)}
                        </span>
                        {r.locationCity && (
                          <span className="text-xs text-muted-foreground">
                            {r.locationCity}{r.locationState ? `, ${r.locationState}` : ""}
                          </span>
                        )}
                        <StatusBadge status={r.status} />
                        <span className="text-xs text-muted-foreground">
                          attempt {r.attemptCount}/{r.maxAttempts}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>
                          <Clock className="w-3 h-3 inline mr-0.5" />
                          Last attempt: {formatTime(r.lastAttemptAt)}
                        </span>
                        {r.importedKeywordCount > 0 && (
                          <span>{r.importedKeywordCount}/{r.expectedKeywordCount || "?"} keywords</span>
                        )}
                        {r.nextRetryAt && r.status === "failed" && (
                          <span data-testid={`text-next-retry-${r.locationId}`}>
                            Auto-retry at {formatTime(r.nextRetryAt)}
                          </span>
                        )}
                      </div>
                      {r.lastError && (r.status === "failed" || r.status === "stale") && (
                        <div
                          className="mt-0.5 text-xs text-red-700 truncate"
                          title={r.lastError}
                          data-testid={`text-last-error-${r.locationId}`}
                        >
                          {r.errorCategory ? `[${r.errorCategory}] ` : ""}{r.lastError}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recent Jobs panel
// ---------------------------------------------------------------------------

interface RecentJobRow {
  id: string;
  queueName: string;
  jobType: string;
  status: string;
  workloadClass: string;
  attemptCount: number;
  maxAttempts: number;
  dedupeKey: string | null;
  payload: any;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  leasedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  durationMs: number | null;
}

interface RecentJobsResponse {
  rows: RecentJobRow[];
  generatedAt: string;
}

function JobStatusBadge({ status }: { status: string }) {
  if (status === "completed") {
    return <Badge variant="outline" className="border-green-500 text-green-700"><CheckCircle2 className="w-3 h-3 mr-1" />Completed</Badge>;
  }
  if (status === "processing" || status === "leased") {
    return <Badge variant="outline" className="border-blue-500 text-blue-700"><Loader2 className="w-3 h-3 mr-1 animate-spin" />{status}</Badge>;
  }
  if (status === "pending") {
    return <Badge variant="outline" className="border-slate-400 text-muted-foreground">Pending</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="outline" className="border-amber-500 text-amber-700"><AlertTriangle className="w-3 h-3 mr-1" />Failed</Badge>;
  }
  if (status === "dead_letter") {
    return <Badge variant="outline" className="border-red-500 text-red-700"><XCircle className="w-3 h-3 mr-1" />Dead-letter</Badge>;
  }
  if (status === "cancelled") {
    return <Badge variant="outline" className="border-border text-muted-foreground">Cancelled</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

export function SemrushRecentJobsPanel() {
  const { data, isLoading, isError, error } = useQuery<RecentJobsResponse>({
    queryKey: ["/api/semrush/console/recent-jobs"],
    queryFn: async () => {
      const res = await fetch("/api/semrush/console/recent-jobs?limit=50", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed to load recent jobs");
      return res.json();
    },
    refetchInterval: 15_000,
  });

  return (
    <Card data-testid="section-semrush-recent-jobs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
          <ListChecks className="w-5 h-5 text-muted-foreground" />
          Recent Jobs
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Latest 50 SEMrush queue jobs (durable · from work_queue). Inventory and enrichment
          workers run on a timer and don't appear here — see Pipeline Health for their state.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="recent-jobs-loading">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading recent jobs…
          </div>
        )}
        {isError && (
          <div className="text-sm text-red-700" data-testid="recent-jobs-error">
            Failed to load recent jobs: {(error as Error)?.message ?? "unknown error"}
          </div>
        )}
        {data && data.rows.length === 0 && (
          <p className="text-sm text-muted-foreground italic" data-testid="recent-jobs-empty">
            No SEMrush jobs in the queue yet.
          </p>
        )}
        {data && data.rows.length > 0 && (
          <div className="border border-border rounded-md bg-card overflow-x-auto">
            <table className="w-full text-xs sm:text-sm min-w-[760px]">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2">Queue / type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Attempts</th>
                  <th className="px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => (
                  <tr
                    key={r.id}
                    className="border-t border-border align-top"
                    data-testid={`row-recent-job-${r.id}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs text-foreground">{r.queueName}</div>
                      <div className="text-xs text-muted-foreground">{r.jobType}</div>
                    </td>
                    <td className="px-3 py-2"><JobStatusBadge status={r.status} /></td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {relAge(r.createdAt)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDuration(r.durationMs)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={r.attemptCount > 1 ? "text-amber-700" : ""}
                        data-testid={`text-job-attempts-${r.id}`}
                      >
                        {r.attemptCount}/{r.maxAttempts}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground max-w-[280px]">
                      {r.errorMessage ? (
                        <div className="text-red-700 truncate" title={r.errorMessage} data-testid={`text-job-error-${r.id}`}>
                          {r.errorCode ? `[${r.errorCode}] ` : ""}{r.errorMessage}
                        </div>
                      ) : r.dedupeKey ? (
                        <div className="text-xs text-muted-foreground font-mono truncate" title={r.dedupeKey}>
                          {r.dedupeKey}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
