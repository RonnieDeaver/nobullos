// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Open-incidents health domain: incident lifecycle list + ack/resolve
// actions with optimistic cache updates.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

  // Task #918 (913E) — Open incidents (913D), supervised sampler runtime (913B).
  type IncidentRow = {
    id: number;
    metric: string;
    severity: string;
    title: string;
    firstSeenAt: number;
    lastSeenAt: number;
    occurrenceCount: number;
    latestValue: number;
    peakValue: number;
    threshold: number;
    status: "firing" | "acknowledged" | "snoozed" | "resolved";
    acknowledgedBy: string | null;
    snoozedUntil: number | null;
    metadata?: { origin?: string | null; message?: string | null } | null;
  };

// Called unconditionally by HealthDashboardSection in the same
// hook-sequence position as the original inline block (F11D).
export function useIncidentsDomain({
  isAdmin,
  isTabVisible,
  pollingInterval,
}: {
  isAdmin: boolean;
  isTabVisible: boolean;
  pollingInterval: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const incidentsQueryKey = ["/api/health/incidents"] as const;
  const { data: incidentsData, refetch: refetchIncidents, isLoading: incidentsLoading, error: incidentsError } = useQuery<{
    open: IncidentRow[];
    recent: IncidentRow[];
    since: number;
  }>({
    queryKey: incidentsQueryKey,
    refetchInterval: isTabVisible ? pollingInterval : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });

  const removeIncidentFromCache = (id: number) => {
    queryClient.setQueryData<{ open: IncidentRow[]; recent: IncidentRow[]; since: number } | undefined>(
      incidentsQueryKey,
      (prev) => (prev ? { ...prev, open: prev.open.filter((i) => i.id !== id) } : prev),
    );
  };

  const ackIncidentMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/health/incidents/${id}/ack`);
      return res.json();
    },
    onMutate: async (id: number) => {
      await queryClient.cancelQueries({ queryKey: incidentsQueryKey });
      const prev = queryClient.getQueryData<{ open: IncidentRow[]; recent: IncidentRow[]; since: number }>(incidentsQueryKey);
      // Acknowledge keeps the row in the open list (per 913D it's still
      // open until resolved). Transition status in place to avoid the
      // remove/refetch-reinsert flicker.
      queryClient.setQueryData<{ open: IncidentRow[]; recent: IncidentRow[]; since: number } | undefined>(
        incidentsQueryKey,
        (curr) =>
          curr
            ? {
                ...curr,
                open: curr.open.map((i) => (i.id === id ? { ...i, status: "acknowledged" } : i)),
              }
            : curr,
      );
      return { prev };
    },
    onError: (err: Error, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(incidentsQueryKey, ctx.prev);
      toast({ title: "Failed to acknowledge incident", description: err.message, variant: "destructive" });
    },
    onSuccess: () => {
      toast({ title: "Incident acknowledged" });
    },
    onSettled: () => {
      void refetchIncidents();
    },
  });

  const resolveIncidentMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/health/incidents/${id}/resolve`);
      return res.json();
    },
    onMutate: async (id: number) => {
      await queryClient.cancelQueries({ queryKey: incidentsQueryKey });
      const prev = queryClient.getQueryData<{ open: IncidentRow[]; recent: IncidentRow[]; since: number }>(incidentsQueryKey);
      removeIncidentFromCache(id);
      return { prev };
    },
    onError: (err: Error, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(incidentsQueryKey, ctx.prev);
      toast({ title: "Failed to resolve incident", description: err.message, variant: "destructive" });
    },
    onSuccess: () => {
      toast({ title: "Incident resolved" });
    },
    onSettled: () => {
      void refetchIncidents();
    },
  });

  return {
    incidentsData,
    refetchIncidents,
    incidentsLoading,
    incidentsError,
    ackIncidentMutation,
    resolveIncidentMutation,
  };
}

export type IncidentsDomain = ReturnType<typeof useIncidentsDomain>;

export function OpenIncidentsCard({ domain }: { domain: IncidentsDomain }) {
  const {
    incidentsData,
    refetchIncidents,
    incidentsLoading,
    incidentsError,
    ackIncidentMutation,
    resolveIncidentMutation,
  } = domain;
  return (
            <Card data-testid="card-open-incidents">
              <CardHeader>
                <CardTitle className="text-foreground">Open Incidents</CardTitle>
                <CardDescription>
                  Active firing or acknowledged incidents from the lifecycle engine. Resolved
                  incidents are tracked separately and do not appear here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {incidentsError ? (
                  <div className="text-sm text-red-600" data-testid="text-incidents-error">
                    Failed to load incidents: {(incidentsError as Error).message}
                  </div>
                ) : incidentsLoading && !incidentsData ? (
                  <div className="text-sm text-muted-foreground" data-testid="text-incidents-loading">
                    Loading incidents…
                  </div>
                ) : !incidentsData || incidentsData.open.length === 0 ? (
                  <div
                    className="flex items-center gap-2 text-sm text-green-700"
                    data-testid="text-no-open-incidents"
                  >
                    <CheckCircle className="w-4 h-4" />
                    No open incidents.
                  </div>
                ) : (
                  <div className="border rounded-md overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left px-2 py-1">Metric</th>
                          <th className="text-left px-2 py-1">Severity</th>
                          <th className="text-left px-2 py-1">Status</th>
                          <th className="text-right px-2 py-1">Count</th>
                          <th className="text-right px-2 py-1">Latest / Threshold</th>
                          <th className="text-left px-2 py-1">First seen</th>
                          <th className="text-left px-2 py-1">Last seen</th>
                          <th className="text-right px-2 py-1">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {incidentsData.open.map((inc) => {
                          const sev = inc.severity;
                          const sevClass =
                            sev === "critical"
                              ? "bg-red-100 text-red-700"
                              : sev === "warning"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-blue-100 text-blue-700";
                          const statusClass =
                            inc.status === "firing"
                              ? "bg-red-100 text-red-700"
                              : "bg-amber-100 text-amber-700";
                          return (
                            <tr key={inc.id} className="border-t" data-testid={`row-incident-${inc.id}`}>
                              <td className="px-2 py-1 font-mono">
                                {inc.metric}
                                {inc.metadata?.origin && (
                                  <span className="text-muted-foreground"> @ {inc.metadata.origin}</span>
                                )}
                              </td>
                              <td className="px-2 py-1">
                                <Badge className={sevClass} data-testid={`badge-incident-severity-${inc.id}`}>
                                  {sev}
                                </Badge>
                              </td>
                              <td className="px-2 py-1">
                                <Badge className={statusClass} data-testid={`badge-incident-status-${inc.id}`}>
                                  {inc.status}
                                </Badge>
                              </td>
                              <td className="px-2 py-1 text-right" data-testid={`text-incident-count-${inc.id}`}>
                                {inc.occurrenceCount}
                              </td>
                              <td className="px-2 py-1 text-right" data-testid={`text-incident-value-${inc.id}`}>
                                {inc.latestValue} / {inc.threshold}
                              </td>
                              <td
                                className="px-2 py-1 text-muted-foreground"
                                title={new Date(inc.firstSeenAt).toLocaleString()}
                                data-testid={`text-incident-first-${inc.id}`}
                              >
                                {new Date(inc.firstSeenAt).toLocaleString()}
                              </td>
                              <td
                                className="px-2 py-1 text-muted-foreground"
                                title={new Date(inc.lastSeenAt).toLocaleString()}
                                data-testid={`text-incident-last-${inc.id}`}
                              >
                                {new Date(inc.lastSeenAt).toLocaleString()}
                              </td>
                              <td className="px-2 py-1 text-right">
                                <div className="flex justify-end gap-1">
                                  {inc.status !== "acknowledged" && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={ackIncidentMutation.isPending}
                                      onClick={() => ackIncidentMutation.mutate(inc.id)}
                                      data-testid={`button-ack-incident-${inc.id}`}
                                    >
                                      Acknowledge
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={resolveIncidentMutation.isPending}
                                    onClick={() => resolveIncidentMutation.mutate(inc.id)}
                                    data-testid={`button-resolve-incident-${inc.id}`}
                                  >
                                    Resolve
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="text-right mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchIncidents()}
                    data-testid="button-refresh-incidents"
                  >
                    <RefreshCw className="w-3 h-3 mr-1" />
                    Refresh
                  </Button>
                </div>
              </CardContent>
            </Card>
  );
}
