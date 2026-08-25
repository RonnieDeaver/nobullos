import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Clock, History, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface SyncStateRow {
  id: string;
  clientId: string;
  locationId: string;
  campaignId: string;
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
  message: string | null;
  updatedAt: string | null;
  locationName: string | null;
  locationCity: string | null;
  locationState: string | null;
  campaignName: string | null;
}

interface Props {
  clientId: string;
  canRetry: boolean;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "succeeded" || status === "already_current") {
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
  return <Badge variant="outline" className="border-red-500 text-red-700"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
}

function formatTime(s: string | null): string {
  if (!s) return "—";
  try {
    const d = new Date(s);
    return d.toLocaleString();
  } catch {
    return s;
  }
}

interface AttemptRow {
  id: string;
  attemptNumber: number;
  phase: string;
  status: string;
  triggeredBy: string | null;
  reportDate: string | null;
  importedKeywordCount: number | null;
  expectedKeywordCount: number | null;
  durationMs: number | null;
  errorCategory: string | null;
  lastError: string | null;
  message: string | null;
  createdAt: string;
}

function AttemptHistory({ clientId, locationId }: { clientId: string; locationId: string }) {
  // The append-only history table is the source of truth for "what's
  // happened to this location lately?". Render most recent first; cap at
  // 25 rows in the UI to avoid blowing up the layout when a flapping
  // location has hundreds of attempts.
  const { data, isLoading } = useQuery<{ rows: AttemptRow[] }>({
    queryKey: ["semrush-sync-attempts", clientId, locationId],
    queryFn: async () => {
      const res = await fetch(
        `/api/clients/${clientId}/semrush-integration/locations/${locationId}/attempts?limit=25`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("failed to load attempt history");
      return res.json();
    },
  });
  if (isLoading) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-1" data-testid={`attempts-loading-${locationId}`}>
        <Loader2 className="w-3 h-3 animate-spin" /> Loading attempt history…
      </div>
    );
  }
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground" data-testid={`attempts-empty-${locationId}`}>No attempt history yet.</div>;
  }
  return (
    <div className="border border-border rounded bg-muted/50 overflow-x-auto" data-testid={`attempts-list-${locationId}`}>
      <table className="w-full text-xs min-w-[480px]">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="px-2 py-1">When</th>
            <th className="px-2 py-1">#</th>
            <th className="px-2 py-1">Phase</th>
            <th className="px-2 py-1">Status</th>
            <th className="px-2 py-1">Trigger</th>
            <th className="px-2 py-1">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(a => (
            <tr key={a.id} className="border-t border-border" data-testid={`attempt-row-${a.id}`}>
              <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{formatTime(a.createdAt)}</td>
              <td className="px-2 py-1">{a.attemptNumber}</td>
              <td className="px-2 py-1">{a.phase}</td>
              <td className="px-2 py-1">{a.status}</td>
              <td className="px-2 py-1">{a.triggeredBy || "—"}</td>
              <td className="px-2 py-1 text-muted-foreground truncate max-w-[260px]" title={a.lastError || a.message || ""}>
                {a.lastError
                  ? `${a.errorCategory ? `[${a.errorCategory}] ` : ""}${a.lastError}`
                  : a.message
                    ? a.message
                    : a.importedKeywordCount != null
                      ? `${a.importedKeywordCount}/${a.expectedKeywordCount ?? "?"} keywords${a.durationMs ? ` · ${Math.round(a.durationMs / 1000)}s` : ""}`
                      : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LocalDominanceSyncStatePanel({ clientId, canRetry }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (locationId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(locationId)) next.delete(locationId); else next.add(locationId);
      return next;
    });
  };

  const { data, isLoading } = useQuery<{ rows: SyncStateRow[] }>({
    queryKey: ["semrush-sync-state", clientId],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/semrush-integration/sync-state`, { credentials: "include" });
      if (!res.ok) throw new Error("failed to load sync state");
      return res.json();
    },
    refetchInterval: (q) => {
      const rows = (q.state.data as any)?.rows as SyncStateRow[] | undefined;
      const active = rows?.some(r => r.status === "in_progress" || r.status === "queued");
      return active ? 4000 : 30000;
    },
  });

  const retry = useMutation({
    mutationFn: async (locationId: string) => {
      const res = await fetch(
        `/api/clients/${clientId}/semrush-integration/locations/${locationId}/retry`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "retry failed");
      }
      return res.json();
    },
    onSuccess: (_data, locationId) => {
      toast({ title: "Retry queued", description: `Retrying sync for location ${locationId.slice(0, 8)}…` });
      void qc.invalidateQueries({ queryKey: ["semrush-sync-state", clientId] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Retry failed", description: err?.message || "could not queue retry" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="sync-state-loading">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading per-location sync status…
      </div>
    );
  }

  const rows = data?.rows ?? [];
  if (rows.length === 0) return null;

  const failedRows = rows.filter(r => r.status === "failed" || r.status === "stale");
  const sortedRows = [...rows].sort((a, b) => {
    const order = (s: string) => (s === "failed" ? 0 : s === "stale" ? 1 : s === "in_progress" || s === "queued" ? 2 : s === "partial" ? 3 : 4);
    return order(a.status) - order(b.status);
  });

  return (
    <div
      className="border border-border rounded-lg bg-card"
      data-testid="panel-sync-state"
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Per-location sync status</h3>
          <p className="text-xs text-muted-foreground">
            {rows.length} location{rows.length === 1 ? "" : "s"} tracked
            {failedRows.length > 0 ? ` · ${failedRows.length} need attention` : ""}
          </p>
        </div>
      </div>
      <div className="divide-y divide-border">
        {sortedRows.map(r => (
          <div
            key={r.id}
            className="px-4 py-3 flex items-start justify-between gap-3"
            data-testid={`row-sync-state-${r.locationId}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-foreground truncate" data-testid={`text-location-name-${r.locationId}`}>
                  {r.locationName || r.locationId.slice(0, 8)}
                </span>
                {r.locationCity && (
                  <span className="text-xs text-muted-foreground">
                    {r.locationCity}{r.locationState ? `, ${r.locationState}` : ""}
                  </span>
                )}
                <StatusBadge status={r.status} />
                <span className="text-xs text-muted-foreground" data-testid={`text-attempts-${r.locationId}`}>
                  attempt {r.attemptCount}/{r.maxAttempts}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                <span><Clock className="w-3 h-3 inline mr-0.5" />Last attempt: {formatTime(r.lastAttemptAt)}</span>
                {r.importedKeywordCount > 0 && (
                  <span>{r.importedKeywordCount}/{r.expectedKeywordCount || "?"} keywords</span>
                )}
                {r.nextRetryAt && (r.status === "failed") && (
                  <span data-testid={`text-next-retry-${r.locationId}`}>Auto-retry at {formatTime(r.nextRetryAt)}</span>
                )}
              </div>
              {r.lastError && (r.status === "failed" || r.status === "stale") && (
                <div
                  className="mt-1 text-xs text-red-700 truncate"
                  title={r.lastError}
                  data-testid={`text-last-error-${r.locationId}`}
                >
                  {r.errorCategory ? `[${r.errorCategory}] ` : ""}{r.lastError}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => toggleExpanded(r.locationId)}
                data-testid={`button-toggle-attempts-${r.locationId}`}
                title="Show attempt history"
              >
                {expanded.has(r.locationId) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <History className="w-3 h-3 ml-1" />
              </Button>
              {canRetry && (r.status === "failed" || r.status === "stale" || r.status === "partial") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => retry.mutate(r.locationId)}
                  disabled={retry.isPending && retry.variables === r.locationId}
                  data-testid={`button-retry-location-${r.locationId}`}
                >
                  {retry.isPending && retry.variables === r.locationId ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3 h-3 mr-1" />
                  )}
                  Retry
                </Button>
              )}
            </div>
          </div>
        ))}
        {sortedRows.filter(r => expanded.has(r.locationId)).map(r => (
          <div key={`history-${r.id}`} className="px-4 pb-3 -mt-px" data-testid={`attempts-container-${r.locationId}`}>
            <AttemptHistory clientId={clientId} locationId={r.locationId} />
          </div>
        ))}
      </div>
    </div>
  );
}
