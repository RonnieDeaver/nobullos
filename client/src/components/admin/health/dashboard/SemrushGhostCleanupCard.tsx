// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

// Task #758: SEMrush ghost-cleanup trend card. Reads
// `/api/health/semrush-ghost-cleanup`, which serves the daily rollup
// rows persisted by the scheduler in `health_daily_rollups` plus the
// last-run summary from `system_settings`.
type SemrushGhostCleanupSeriesPoint = {
  date: string;
  scanned: number;
  ghosts: number;
  deleted: number;
};

type SemrushGhostCleanupResponse = {
  days: number;
  enabled: boolean;
  lastRun:
    | {
        scanned: number;
        ghosts: number;
        deleted: number;
        scannedAt: number;
        durationMs: number;
        skippedReason?: string;
      }
    | null;
  // Task #2198 — readable-vs-corrupt signal for the stored last-run summary.
  lastRunStatus?: "ok" | "never_run" | "unreadable";
  lastRunError?: string;
  series: SemrushGhostCleanupSeriesPoint[];
};

export function SemrushGhostCleanupCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error, refetch } = useQuery<SemrushGhostCleanupResponse>({
    queryKey: ["/api/health/semrush-ghost-cleanup", 30],
    queryFn: async () => {
      const res = await fetch(`/api/health/semrush-ghost-cleanup?days=30`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 5 * 60_000,
  });

  const toggleMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/health/semrush-ghost-cleanup", { enabled });
      return (await res.json()) as { ok: boolean; enabled: boolean };
    },
    onSuccess: (resp) => {
      toast({
        title: resp.enabled
          ? "SEMrush ghost cleanup enabled"
          : "SEMrush ghost cleanup disabled",
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/semrush-ghost-cleanup", 30],
      }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Failed to update toggle",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const series = data?.series ?? [];
  const lastRun = data?.lastRun ?? null;
  const lastRunUnreadable = data?.lastRunStatus === "unreadable";
  const lastRunError =
    typeof data?.lastRunError === "string" ? data.lastRunError : null;
  const totalDeleted = series.reduce((sum, p) => sum + p.deleted, 0);
  const totalGhosts = series.reduce((sum, p) => sum + p.ghosts, 0);

  return (
    <Card data-testid="card-semrush-ghost-cleanup">
      <CardHeader>
        <CardTitle className="text-foreground">SEMrush Ghost Cleanup</CardTitle>
        <CardDescription>
          Daily auto-cleanup of stale `semrush_location_campaigns` rows whose
          `(client_id, location_id)` is no longer configured. Disable via the
          system setting <code>semrush_ghost_cleanup_enabled</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Auto-cleanup:</span>
            <Switch
              checked={data?.enabled !== false}
              disabled={isLoading || toggleMutation.isPending}
              onCheckedChange={(v) => toggleMutation.mutate(Boolean(v))}
              aria-label="Auto-cleanup"
              data-testid="switch-semrush-ghost-cleanup-enabled"
            />
            <span data-testid="text-semrush-ghost-cleanup-enabled">
              {data?.enabled === false ? (
                <Badge variant="outline">Disabled</Badge>
              ) : (
                <Badge variant="secondary">Enabled</Badge>
              )}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            data-testid="button-refresh-semrush-ghost-cleanup"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Refresh
          </Button>
        </div>

        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="text-xs text-red-600" data-testid="text-semrush-ghost-cleanup-error">
            Failed to load.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="border rounded p-2">
                <div className="text-muted-foreground">Last run</div>
                <div data-testid="text-semrush-ghost-cleanup-last-run">
                  {lastRun
                    ? new Date(lastRun.scannedAt).toLocaleString()
                    : "—"}
                </div>
              </div>
              <div className="border rounded p-2">
                <div className="text-muted-foreground">Last deleted / detected</div>
                <div data-testid="text-semrush-ghost-cleanup-last-counts">
                  {lastRun ? `${lastRun.deleted} / ${lastRun.ghosts}` : "—"}
                </div>
              </div>
              <div className="border rounded p-2">
                <div className="text-muted-foreground">30d totals (deleted / detected)</div>
                <div data-testid="text-semrush-ghost-cleanup-30d-totals">
                  {totalDeleted} / {totalGhosts}
                </div>
              </div>
            </div>

            {/* Task #2245 — distinguish a corrupt stored last-run record from
                a job that has simply never run. A blank "Last run" cell on its
                own hides a real persistence bug. */}
            {lastRunUnreadable ? (
              <div
                className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
                data-testid="text-semrush-ghost-cleanup-last-run-unreadable"
              >
                ⚠ The stored last-run record could not be read — this usually
                means the saved value is corrupt (a persistence bug), not that
                the cleanup never ran. Check the server logs.
                {lastRunError ? (
                  <span className="mt-0.5 block font-mono text-xs text-amber-700">
                    {lastRunError}
                  </span>
                ) : null}
              </div>
            ) : !lastRun ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="text-semrush-ghost-cleanup-never-run"
              >
                The cleanup has not run yet.
              </div>
            ) : null}

            {series.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No runs recorded yet — the scheduler will populate this trend
                once it has run.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table
                  className="w-full text-xs"
                  data-testid="table-semrush-ghost-cleanup-trend"
                >
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-2">Date</th>
                      <th className="py-1 pr-2 text-right">Scanned</th>
                      <th className="py-1 pr-2 text-right">Detected</th>
                      <th className="py-1 pr-2 text-right">Deleted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series
                      .slice()
                      .reverse()
                      .map((p) => (
                        <tr
                          key={p.date}
                          data-testid={`row-semrush-ghost-cleanup-${p.date}`}
                        >
                          <td className="py-1 pr-2">{p.date}</td>
                          <td className="py-1 pr-2 text-right">{p.scanned}</td>
                          <td className="py-1 pr-2 text-right">{p.ghosts}</td>
                          <td className="py-1 pr-2 text-right">{p.deleted}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}