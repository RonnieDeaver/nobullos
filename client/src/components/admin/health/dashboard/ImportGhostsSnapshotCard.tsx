// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw } from "lucide-react";

// Task #1222: import-ghosts snapshot card. Reads
// `/api/health/import-ghosts-snapshot`, which returns the daily rollup
// rows persisted by the scheduler in `health_daily_rollups` plus the
// last-run summary from `system_settings`. Surfaces the *other* ghost
// surfaces audited by `scripts/cleanup-import-ghosts.ts` —
// auto-discovered client_contacts and the import_entity_suggestions
// queue — so operators can see drift without running the script.
type ImportGhostsSnapshotSeriesPoint = {
  date: string;
  scannedContacts: number;
  ghostContacts: number;
  unusedContacts: number;
  pendingSuggestionsCount: number;
  suggestionGroupsCount: number;
};

type ImportGhostsSnapshotResponse = {
  days: number;
  enabled: boolean;
  lastRun:
    | {
        scannedContacts: number;
        ghostContacts: number;
        unusedContacts: number;
        manualEditedGhostContacts: number;
        referencedGhostContacts: number;
        pendingSuggestionsCount: number;
        suggestions: Array<{
          surface: string;
          entityKind: string;
          status: string;
          count: number;
        }>;
        scannedAt: number;
        durationMs: number;
        skippedReason?: string;
      }
    | null;
  // Task #2198 — readable-vs-corrupt signal for the stored last-run summary.
  lastRunStatus?: "ok" | "never_run" | "unreadable";
  lastRunError?: string;
  series: ImportGhostsSnapshotSeriesPoint[];
};

export function ImportGhostsSnapshotCard() {
  const { data, isLoading, error, refetch } = useQuery<ImportGhostsSnapshotResponse>({
    queryKey: ["/api/health/import-ghosts-snapshot", 30],
    queryFn: async () => {
      const res = await fetch(`/api/health/import-ghosts-snapshot?days=30`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 5 * 60_000,
  });

  const series = data?.series ?? [];
  const lastRun = data?.lastRun ?? null;
  const lastRunUnreadable = data?.lastRunStatus === "unreadable";
  const lastRunError =
    typeof data?.lastRunError === "string" ? data.lastRunError : null;
  const suggestions = lastRun?.suggestions ?? [];

  return (
    <Card data-testid="card-import-ghosts-snapshot">
      <CardHeader>
        <CardTitle className="text-foreground">Import Ghosts Snapshot</CardTitle>
        <CardDescription>
          Daily snapshot of the other ghost surfaces audited by
          <code> scripts/cleanup-import-ghosts.ts</code>: auto-discovered
          <code> client_contacts</code> (likely ghost rows from the old
          Front enrichment path) and the
          <code> import_entity_suggestions</code> review queue. Reports
          counts only — contact deletion is intentionally never automated.
          Disable via the system setting
          <code> import_ghosts_snapshot_enabled</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Status:{" "}
            <span data-testid="text-import-ghosts-snapshot-enabled">
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
            data-testid="button-refresh-import-ghosts-snapshot"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Refresh
          </Button>
        </div>

        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : error ? (
          <div
            className="text-xs text-red-600"
            data-testid="text-import-ghosts-snapshot-error"
          >
            Failed to load.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="border rounded p-2">
                <div className="text-muted-foreground">Last run</div>
                <div data-testid="text-import-ghosts-snapshot-last-run">
                  {lastRun
                    ? new Date(lastRun.scannedAt).toLocaleString()
                    : "—"}
                </div>
              </div>
              <div className="border rounded p-2">
                <div className="text-muted-foreground">
                  Ghost contacts (unused / total)
                </div>
                <div data-testid="text-import-ghosts-snapshot-contacts">
                  {lastRun
                    ? `${lastRun.unusedContacts} / ${lastRun.ghostContacts}`
                    : "—"}
                </div>
              </div>
              <div className="border rounded p-2">
                <div className="text-muted-foreground">
                  Manual-edited / referenced
                </div>
                <div data-testid="text-import-ghosts-snapshot-edited-referenced">
                  {lastRun
                    ? `${lastRun.manualEditedGhostContacts} / ${lastRun.referencedGhostContacts}`
                    : "—"}
                </div>
              </div>
              <div className="border rounded p-2">
                <div className="text-muted-foreground">
                  Pending suggestions
                </div>
                <div data-testid="text-import-ghosts-snapshot-pending-suggestions">
                  {lastRun ? lastRun.pendingSuggestionsCount : "—"}
                </div>
              </div>
            </div>

            {/* Task #2245 — distinguish a corrupt stored last-run record from
                a job that has simply never run. A blank "Last run" cell on its
                own hides a real persistence bug. */}
            {lastRunUnreadable ? (
              <div
                className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"
                data-testid="text-import-ghosts-snapshot-last-run-unreadable"
              >
                ⚠ The stored last-run record could not be read — this usually
                means the saved value is corrupt (a persistence bug), not that
                the snapshot never ran. Check the server logs.
                {lastRunError ? (
                  <span className="mt-0.5 block font-mono text-xs text-amber-700">
                    {lastRunError}
                  </span>
                ) : null}
              </div>
            ) : !lastRun ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="text-import-ghosts-snapshot-never-run"
              >
                The snapshot has not run yet.
              </div>
            ) : null}

            {suggestions.length > 0 && (
              <div className="overflow-x-auto">
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Suggestion queue (latest run)
                </div>
                <table
                  className="w-full text-xs"
                  data-testid="table-import-ghosts-snapshot-suggestions"
                >
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-2">Surface</th>
                      <th className="py-1 pr-2">Entity kind</th>
                      <th className="py-1 pr-2">Status</th>
                      <th className="py-1 pr-2 text-right">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((s) => (
                      <tr
                        key={`${s.surface}-${s.entityKind}-${s.status}`}
                        data-testid={`row-import-ghosts-suggestion-${s.surface}-${s.entityKind}-${s.status}`}
                      >
                        <td className="py-1 pr-2">{s.surface}</td>
                        <td className="py-1 pr-2">{s.entityKind}</td>
                        <td className="py-1 pr-2">{s.status}</td>
                        <td className="py-1 pr-2 text-right">{s.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {series.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No runs recorded yet — the scheduler will populate this trend
                once it has run.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Daily trend (last {data?.days ?? 30} days)
                </div>
                <table
                  className="w-full text-xs"
                  data-testid="table-import-ghosts-snapshot-trend"
                >
                  <thead className="text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-2">Date</th>
                      <th className="py-1 pr-2 text-right">Scanned contacts</th>
                      <th className="py-1 pr-2 text-right">Ghost contacts</th>
                      <th className="py-1 pr-2 text-right">Unused</th>
                      <th className="py-1 pr-2 text-right">Pending suggestions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series
                      .slice()
                      .reverse()
                      .map((p) => (
                        <tr
                          key={p.date}
                          data-testid={`row-import-ghosts-snapshot-${p.date}`}
                        >
                          <td className="py-1 pr-2">{p.date}</td>
                          <td className="py-1 pr-2 text-right">
                            {p.scannedContacts}
                          </td>
                          <td className="py-1 pr-2 text-right">
                            {p.ghostContacts}
                          </td>
                          <td className="py-1 pr-2 text-right">
                            {p.unusedContacts}
                          </td>
                          <td className="py-1 pr-2 text-right">
                            {p.pendingSuggestionsCount}
                          </td>
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