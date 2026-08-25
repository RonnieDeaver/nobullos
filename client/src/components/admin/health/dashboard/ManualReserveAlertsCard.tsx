// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Manual-reserve alert-dispatch audit domain: durable dispatch log with
// event/severity filters, metric drill-in, sparklines, and resend.
import { useQuery, useMutation } from "@tanstack/react-query";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, XCircle, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { ManualReserveAlertDispatch } from "./types";

// Called unconditionally by HealthDashboardSection in the same
// hook-sequence position as the original filter state (the dispatch query
// still mounts between the by-worker history and thresholds queries, as
// before the F11D split).
export function useManualReserveAlertsDomain({
  isAdmin,
  isTabVisible,
  pollingInterval,
  historyWindow,
  windowMs,
}: {
  isAdmin: boolean;
  isTabVisible: boolean;
  pollingInterval: number;
  historyWindow: string;
  windowMs: number;
}) {
  const { toast } = useToast();

  const [alertEventTypeFilter, setAlertEventTypeFilter] = useState<
    Set<"alert" | "muted" | "backed_up" | "all_clear" | "auto_muted" | "auto_unmuted">
  >(
    () => new Set(["alert", "muted", "backed_up", "all_clear", "auto_muted", "auto_unmuted"]),
  );
  const [alertSeverityFilter, setAlertSeverityFilter] = useState<Set<"critical" | "warning" | "info">>(
    () => new Set(["critical", "warning", "info"]),
  );
  const [alertMetricDrillIn, setAlertMetricDrillIn] = useState<string | null>(null);

  const {
    data: manualReserveAlertsData,
    isLoading: manualReserveAlertsLoading,
    error: manualReserveAlertsError,
    refetch: refetchManualReserveAlerts,
  } = useQuery<{ dispatches: ManualReserveAlertDispatch[] }>({
    queryKey: [
      "/api/health/manual-reserve-alerts",
      historyWindow,
      Array.from(alertEventTypeFilter).sort().join(","),
      Array.from(alertSeverityFilter).sort().join(","),
      alertMetricDrillIn ?? "",
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("since", String(Date.now() - windowMs));
      params.set("limit", "500");
      if (alertEventTypeFilter.size > 0 && alertEventTypeFilter.size < 6) {
        params.set("eventType", Array.from(alertEventTypeFilter).join(","));
      }
      if (alertSeverityFilter.size > 0 && alertSeverityFilter.size < 3) {
        params.set("severity", Array.from(alertSeverityFilter).join(","));
      }
      if (alertMetricDrillIn) params.set("metric", alertMetricDrillIn);
      const res = await fetch(`/api/health/manual-reserve-alerts?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return res.json();
    },
    refetchInterval: isTabVisible ? pollingInterval : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });

  // Task #721 — Resend a failed manual-reserve alert dispatch. Bypasses
  // the per-(metric,severity) cooldown (the service treats this as an
  // explicit operator-initiated retry).
  const resendManualReserveAlertMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: { timestamp: number; metric: string; severity: string }) => {
      const res = await apiRequest(
        "POST",
        "/api/health/manual-reserve-alerts/resend",
        payload,
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Alert resent to Slack" });
      void refetchManualReserveAlerts(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      toast({ title: "Resend failed", description: err.message, variant: "destructive" });
    },
  });

  return {
    alertEventTypeFilter,
    setAlertEventTypeFilter,
    alertSeverityFilter,
    setAlertSeverityFilter,
    alertMetricDrillIn,
    setAlertMetricDrillIn,
    manualReserveAlertsData,
    manualReserveAlertsLoading,
    manualReserveAlertsError,
    refetchManualReserveAlerts,
    resendManualReserveAlertMutation,
  };
}

export type ManualReserveAlertsDomain = ReturnType<typeof useManualReserveAlertsDomain>;

export function ManualReserveAlertsCard({
  domain,
  windowMs,
}: {
  domain: ManualReserveAlertsDomain;
  windowMs: number;
}) {
  const {
    alertEventTypeFilter,
    setAlertEventTypeFilter,
    alertSeverityFilter,
    setAlertSeverityFilter,
    alertMetricDrillIn,
    setAlertMetricDrillIn,
    manualReserveAlertsData,
    manualReserveAlertsLoading,
    manualReserveAlertsError,
    refetchManualReserveAlerts,
    resendManualReserveAlertMutation,
  } = domain;
  return (
            <Card data-testid="card-manual-reserve-alerts">
              <CardHeader>
                <CardTitle className="text-foreground flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" />
                  Manual Reserve Alert Dispatches
                </CardTitle>
                <CardDescription>
                  Durable audit log of manual-reserve alert events. Includes Slack delivery attempts,
                  alerts suppressed by an active mute window, and "backed_up" / "all_clear" state
                  transitions. Persisted to the database; retained 7 days.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {manualReserveAlertsLoading && !manualReserveAlertsData && (
                  <div className="text-sm text-muted-foreground" data-testid="text-manual-reserve-alerts-loading">
                    Loading alert dispatches…
                  </div>
                )}
                {manualReserveAlertsError && (
                  <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3" data-testid="text-manual-reserve-alerts-error">
                    <XCircle className="w-4 h-4 shrink-0" />
                    <span>Failed to load manual reserve alert history.</span>
                    <Button variant="outline" size="sm" className="ml-auto" onClick={() => refetchManualReserveAlerts()} data-testid="button-retry-manual-reserve-alerts">
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Retry
                    </Button>
                  </div>
                )}
                <div className="mb-3 flex flex-col gap-2" data-testid="section-alert-dispatch-filters">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Event type:</span>
                    {(["alert", "muted", "backed_up", "all_clear", "auto_muted", "auto_unmuted"] as const).map((t) => {
                      const active = alertEventTypeFilter.has(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => {
                            const next = new Set(alertEventTypeFilter);
                            if (next.has(t)) next.delete(t); else next.add(t);
                            if (next.size === 0) next.add(t); // never empty
                            setAlertEventTypeFilter(next);
                          }}
                          className={`px-2 py-0.5 rounded-full border ${active ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}
                          data-testid={`chip-event-${t}`}
                        >
                          {t.replace("_", " ")}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Severity:</span>
                    {(["critical", "warning", "info"] as const).map((s) => {
                      const active = alertSeverityFilter.has(s);
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => {
                            const next = new Set(alertSeverityFilter);
                            if (next.has(s)) next.delete(s); else next.add(s);
                            if (next.size === 0) next.add(s);
                            setAlertSeverityFilter(next);
                          }}
                          className={`px-2 py-0.5 rounded-full border ${active ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}
                          data-testid={`chip-severity-${s}`}
                        >
                          {s}
                        </button>
                      );
                    })}
                    {alertMetricDrillIn && (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-muted-foreground">Drilled in:</span>
                        <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200" data-testid="badge-metric-drillin">
                          {alertMetricDrillIn}
                        </Badge>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground underline"
                          onClick={() => setAlertMetricDrillIn(null)}
                          data-testid="button-clear-metric-drillin"
                        >
                          clear
                        </button>
                      </span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto h-7 px-2 text-xs"
                      onClick={() => {
                        const params = new URLSearchParams();
                        params.set("since", String(Date.now() - windowMs));
                        params.set("limit", "1000");
                        if (alertEventTypeFilter.size > 0 && alertEventTypeFilter.size < 6) {
                          params.set("eventType", Array.from(alertEventTypeFilter).join(","));
                        }
                        if (alertSeverityFilter.size > 0 && alertSeverityFilter.size < 3) {
                          params.set("severity", Array.from(alertSeverityFilter).join(","));
                        }
                        if (alertMetricDrillIn) params.set("metric", alertMetricDrillIn);
                        window.location.href = `/api/health/manual-reserve-alerts.csv?${params.toString()}`;
                      }}
                      data-testid="button-export-manual-reserve-alerts-csv"
                    >
                      Download CSV
                    </Button>
                  </div>
                </div>
                {manualReserveAlertsData && manualReserveAlertsData.dispatches.length === 0 && (
                  <div className="text-sm text-muted-foreground" data-testid="text-manual-reserve-alerts-empty">
                    No manual reserve alert events match the current filters in the selected window.
                  </div>
                )}
                {manualReserveAlertsData && manualReserveAlertsData.dispatches.length > 0 && (() => {
                  // Build a per-metric sparkline: count of alert/muted events per
                  // 10 buckets across the visible window. Click a metric in the
                  // table to filter to it.
                  const buckets = 10;
                  const bucketMs = Math.max(1, Math.floor(windowMs / buckets));
                  const start = Date.now() - windowMs;
                  const seriesByMetric = new Map<string, number[]>();
                  const firstRowByMetricBucket = new Map<string, number>();
                  manualReserveAlertsData.dispatches.forEach((d, rowIdx) => {
                    if (d.eventType && d.eventType !== "alert" && d.eventType !== "muted") return;
                    const bIdx = Math.min(buckets - 1, Math.max(0, Math.floor((d.timestamp - start) / bucketMs)));
                    const arr = seriesByMetric.get(d.metric) ?? new Array(buckets).fill(0);
                    arr[bIdx] = (arr[bIdx] || 0) + 1;
                    seriesByMetric.set(d.metric, arr);
                    const k = `${d.metric}::${bIdx}`;
                    if (!firstRowByMetricBucket.has(k)) firstRowByMetricBucket.set(k, rowIdx);
                  });
                  const jumpToRow = (rowIdx: number) => {
                    const el = document.getElementById(`row-manual-reserve-alert-${rowIdx}`);
                    if (el) {
                      el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
                      el.classList.add("ring-2", "ring-primary");
                      setTimeout(() => el.classList.remove("ring-2", "ring-primary"), 1500);
                    }
                  };
                  return (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse" data-testid="table-manual-reserve-alerts">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th className="py-2 pr-3 font-medium">Time</th>
                            <th className="py-2 pr-3 font-medium">Event</th>
                            <th className="py-2 pr-3 font-medium">Metric</th>
                            <th className="py-2 pr-3 font-medium">Severity</th>
                            <th className="py-2 pr-3 font-medium text-right">Value</th>
                            <th className="py-2 pr-3 font-medium text-right">Threshold</th>
                            <th className="py-2 pr-3 font-medium">Trend</th>
                            <th className="py-2 pr-3 font-medium">Delivery</th>
                          </tr>
                        </thead>
                        <tbody>
                          {manualReserveAlertsData.dispatches.map((d, idx) => {
                            const key = `${d.timestamp}-${d.metric}-${d.severity}-${idx}`;
                            const evt = d.eventType ?? "alert";
                            const eventBadge = evt === "alert"
                              ? { label: "alert", className: "bg-red-50 text-red-700 border-red-200" }
                              : evt === "muted"
                              ? { label: "muted", className: "bg-muted text-foreground border-border" }
                              : evt === "backed_up"
                              ? { label: "backed up", className: "bg-amber-50 text-amber-700 border-amber-200" }
                              : evt === "auto_muted"
                              ? { label: "auto-muted", className: "bg-indigo-50 text-indigo-700 border-indigo-200" }
                              : evt === "auto_unmuted"
                              ? { label: "auto-unmuted", className: "bg-indigo-50 text-indigo-700 border-indigo-200" }
                              : { label: "all clear", className: "bg-green-50 text-green-700 border-green-200" };
                            const autoTransition = evt === "auto_muted" || evt === "auto_unmuted";
                            const autoLabel = autoTransition
                              ? `${evt === "auto_muted" ? "auto-muted by" : "auto-mute released by"} ${d.mutedBy ?? "(unknown job)"}`
                              : null;
                            const statusBadge = d.status === "sent"
                              ? { label: "Slack sent", className: "bg-green-100 text-green-800 border-green-200" }
                              : d.status === "failed"
                              ? { label: "Failed", className: "bg-red-100 text-red-800 border-red-200" }
                              : d.status === "muted"
                              ? { label: "Suppressed (muted)", className: "bg-muted text-foreground border-border" }
                              : d.status === "transition"
                              ? { label: "—", className: "bg-muted/50 text-muted-foreground border-border" }
                              : { label: "Not configured", className: "bg-muted text-foreground border-border" };
                            const series = seriesByMetric.get(d.metric);
                            const maxVal = series ? Math.max(1, ...series) : 1;
                            return (
                              <tr
                                key={key}
                                id={`row-manual-reserve-alert-${idx}`}
                                className={`border-b last:border-b-0 align-top transition-shadow ${
                                  d.isResend ? "bg-primary/5 border-l-2 border-l-primary/60" : ""
                                }`}
                                data-testid={`row-manual-reserve-alert-${idx}`}
                              >
                                <td className="py-2 pr-3 whitespace-nowrap" data-testid={`text-alert-time-${idx}`}>
                                  {new Date(d.timestamp).toLocaleString()}
                                </td>
                                <td className="py-2 pr-3" data-testid={`text-alert-event-${idx}`}>
                                  <Badge variant="outline" className={eventBadge.className}>
                                    {eventBadge.label}
                                  </Badge>
                                </td>
                                <td className="py-2 pr-3 font-mono" data-testid={`text-alert-metric-${idx}`}>
                                  <button
                                    type="button"
                                    className="underline-offset-2 hover:underline text-left"
                                    onClick={() => setAlertMetricDrillIn(d.metric)}
                                    data-testid={`button-drill-metric-${idx}`}
                                    title="Filter to this metric"
                                  >
                                    {d.metric}
                                  </button>
                                </td>
                                <td className="py-2 pr-3" data-testid={`text-alert-severity-${idx}`}>
                                  <Badge
                                    variant="outline"
                                    className={
                                      d.severity === "critical"
                                        ? "bg-red-50 text-red-700 border-red-200"
                                        : d.severity === "warning"
                                        ? "bg-amber-50 text-amber-700 border-amber-200"
                                        : "bg-muted/50 text-muted-foreground border-border"
                                    }
                                  >
                                    {d.severity}
                                  </Badge>
                                </td>
                                <td className="py-2 pr-3 text-right tabular-nums" data-testid={`text-alert-value-${idx}`}>
                                  {evt === "backed_up" || evt === "all_clear" ? "" : d.value}
                                </td>
                                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground" data-testid={`text-alert-threshold-${idx}`}>
                                  {evt === "backed_up" || evt === "all_clear" ? "" : d.threshold}
                                </td>
                                <td className="py-2 pr-3" data-testid={`text-alert-spark-${idx}`}>
                                  {series ? (
                                    <div className="flex items-end gap-px h-5">
                                      {series.map((v, i) => {
                                        const targetRow = firstRowByMetricBucket.get(`${d.metric}::${i}`);
                                        const clickable = v > 0 && targetRow !== undefined;
                                        return (
                                          <button
                                            key={i}
                                            type="button"
                                            disabled={!clickable}
                                            onClick={() => clickable && jumpToRow(targetRow!)}
                                            title={clickable ? `${v} event(s) — jump to first row` : "no events in this bucket"}
                                            className={`w-1 ${v > 0 ? "bg-primary/70 hover:bg-primary" : "bg-slate-200"} ${clickable ? "cursor-pointer" : "cursor-default"}`}
                                            style={{ height: `${Math.max(2, Math.round((v / maxVal) * 18))}px` }}
                                            data-testid={`spark-bar-${idx}-${i}`}
                                          />
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </td>
                                <td className="py-2 pr-3" data-testid={`text-alert-status-${idx}`}>
                                  <div className="flex flex-wrap items-center gap-1">
                                    <Badge variant="outline" className={statusBadge.className}>
                                      {statusBadge.label}
                                    </Badge>
                                    {d.isResend && (
                                      <Badge
                                        variant="outline"
                                        className="bg-primary/10 text-primary border-primary/30 text-xs px-1.5 py-0"
                                        data-testid={`badge-resend-${idx}`}
                                      >
                                        Resent
                                      </Badge>
                                    )}
                                  </div>
                                  {d.detail && (
                                    <div className="text-xs text-muted-foreground mt-1" data-testid={`text-alert-detail-${idx}`}>
                                      {d.detail}
                                    </div>
                                  )}
                                  {autoTransition ? (
                                    <div
                                      className="text-xs text-indigo-700 mt-1 font-medium"
                                      data-testid={`text-alert-auto-mute-${idx}`}
                                    >
                                      {autoLabel}
                                      {d.muteReason && (
                                        <span className="text-muted-foreground font-normal"> — {d.muteReason}</span>
                                      )}
                                    </div>
                                  ) : (
                                    (d.mutedBy || d.muteReason) && (
                                      <div className="text-xs text-muted-foreground mt-1" data-testid={`text-alert-muted-by-${idx}`}>
                                        {d.mutedBy && <span>Muted by <span className="font-medium">{d.mutedBy}</span></span>}
                                        {d.muteReason && <span>{d.mutedBy ? " — " : ""}{d.muteReason}</span>}
                                      </div>
                                    )
                                  )}
                                  {d.status === "failed" && (d.severity === "warning" || d.severity === "critical") && (
                                    <div className="mt-1">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-6 px-2 text-xs"
                                        disabled={
                                          resendManualReserveAlertMutation.isPending &&
                                          resendManualReserveAlertMutation.variables?.timestamp === d.timestamp &&
                                          resendManualReserveAlertMutation.variables?.metric === d.metric &&
                                          resendManualReserveAlertMutation.variables?.severity === d.severity
                                        }
                                        onClick={() =>
                                          resendManualReserveAlertMutation.mutate({
                                            timestamp: d.timestamp,
                                            metric: d.metric,
                                            severity: d.severity,
                                          })
                                        }
                                        data-testid={`button-resend-alert-${idx}`}
                                      >
                                        <RefreshCw className="w-3 h-3 mr-1" />
                                        Resend
                                      </Button>
                                    </div>
                                  )}
                                  {d.isResend && (() => {
                                    const resendLabel = d.triggeredByName ?? d.triggeredBy ?? "unknown";
                                    const tooltip = d.triggeredByName && d.triggeredBy
                                      ? `Last resend by ${d.triggeredByName} (${d.triggeredBy}) at ${new Date(d.timestamp).toLocaleString()} (source: ${d.triggerSource ?? "unknown"})`
                                      : `Last resend by ${d.triggeredBy ?? "unknown"} at ${new Date(d.timestamp).toLocaleString()} (source: ${d.triggerSource ?? "unknown"})`;
                                    return (
                                    <div
                                      className="mt-1 text-xs text-muted-foreground"
                                      title={tooltip}
                                      data-testid={`text-last-resend-${idx}`}
                                    >
                                      Last resend by{" "}
                                      <span
                                        className="font-medium text-foreground"
                                        data-testid={`text-last-resend-by-${idx}`}
                                      >
                                        {resendLabel}
                                      </span>{" "}
                                      at{" "}
                                      <span data-testid={`text-last-resend-at-${idx}`}>
                                        {new Date(d.timestamp).toLocaleString()}
                                      </span>{" "}
                                      <span
                                        className="text-muted-foreground"
                                        data-testid={`text-last-resend-source-${idx}`}
                                      >
                                        ({d.triggerSource ?? "unknown"})
                                      </span>
                                    </div>
                                    );
                                  })()}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="mt-2 text-xs text-muted-foreground">
                        Showing {manualReserveAlertsData.dispatches.length} event(s) (newest first) in the selected window.
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
  );
}
