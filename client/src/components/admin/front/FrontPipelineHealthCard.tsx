import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, ChevronUp, ChevronDown, RefreshCw } from "lucide-react";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import type { PipelineMetrics } from "./types";
import { PIPELINE_REFRESH_INTERVAL_MS } from "./utils";

export function FrontPipelineHealthCard() {
  const queryClient = useQueryClient();
  const isTabVisible = useTabVisibility();
  const [pipelineExpanded, setPipelineExpanded] = useState(false);

  const { data: status } = useQuery<{ front: { connected: boolean } }>({
    queryKey: ["/api/integrations/all-status"],
    refetchInterval: isTabVisible ? 5000 : false,
    refetchIntervalInBackground: false,
  });

  const { data: pipelineMetrics, dataUpdatedAt: pipelineMetricsUpdatedAt } = useQuery<PipelineMetrics>({
    queryKey: ["/api/integrations/front/pipeline-metrics"],
    enabled: pipelineExpanded && !!status?.front.connected,
    refetchInterval: pipelineExpanded && isTabVisible ? PIPELINE_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState !== "hidden" && pipelineExpanded) {
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/pipeline-metrics"] }); // fire-and-forget: cache refresh only
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [queryClient, pipelineExpanded]);

  const [pipelineNowTick, setPipelineNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!pipelineExpanded) return;
    setPipelineNowTick(Date.now());
    const id = setInterval(() => setPipelineNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pipelineExpanded]);
  const pipelineSecondsSinceRefresh = pipelineMetricsUpdatedAt
    ? Math.max(0, Math.floor((pipelineNowTick - pipelineMetricsUpdatedAt) / 1000))
    : null;
  const pipelineSecondsUntilRefresh = pipelineMetricsUpdatedAt
    ? Math.max(0, Math.ceil((pipelineMetricsUpdatedAt + PIPELINE_REFRESH_INTERVAL_MS - pipelineNowTick) / 1000))
    : null;

  if (!status?.front.connected) return null;

  return (
    <Card className="bg-card" data-testid="card-pipeline-health">
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setPipelineExpanded(!pipelineExpanded)}>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-5 h-5 text-indigo-600" />
          Front Pipeline Health
          {pipelineMetrics?.health.failedCount ? (
            <Badge variant="outline" className="ml-2 bg-red-50 text-red-700 border-red-200" data-testid="badge-pipeline-failed">{pipelineMetrics.health.failedCount} failed</Badge>
          ) : null}
          {pipelineExpanded && pipelineMetricsUpdatedAt > 0 && (
            <span
              className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground"
              data-testid="text-pipeline-refresh-countdown"
              title={`Last refreshed ${pipelineSecondsSinceRefresh}s ago`}
            >
              <RefreshCw className="w-3 h-3 text-muted-foreground" />
              <span>{isTabVisible ? `Refreshes in ${pipelineSecondsUntilRefresh}s` : "Paused (tab hidden)"}</span>
            </span>
          )}
          {pipelineExpanded ? <ChevronUp className={`w-4 h-4 text-muted-foreground ${pipelineMetricsUpdatedAt > 0 ? "ml-2" : "ml-auto"}`} /> : <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      {pipelineExpanded && (
        <CardContent className="space-y-4" data-testid="pipeline-metrics-content">
          {!pipelineMetrics ? (
            <InlineLoadingSkeleton />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-foreground">Cursor & Sync</h4>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div className="flex justify-between" data-testid="metric-page-token">
                      <span>Page token active</span>
                      <span className="font-medium text-foreground">{pipelineMetrics.cursorFreshness.pageTokenActive ? "Yes" : "No"}</span>
                    </div>
                    <div className="flex justify-between" data-testid="metric-last-cursor-advance">
                      <span>Last cursor advance</span>
                      <span className="font-medium text-foreground">
                        {pipelineMetrics.cursorFreshness.lastCursorAdvanceAt
                          ? new Date(pipelineMetrics.cursorFreshness.lastCursorAdvanceAt).toLocaleTimeString()
                          : "—"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-foreground mb-2">Throughput (last 5m / 1h / total)</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 text-xs" data-testid="pipeline-throughput">
                  {[
                    { key: "discovered", label: "Discovered" },
                    { key: "triage_dismissed", label: "Triage Dismissed" },
                    { key: "deterministic_matched", label: "Det. Matched" },
                    { key: "ai_matched", label: "AI Matched" },
                    { key: "unmatched", label: "Unmatched" },
                    { key: "applied", label: "Applied" },
                    { key: "failed", label: "Failed" },
                    { key: "version_noop", label: "Version No-ops" },
                  ].map(({ key, label }) => {
                    const t = pipelineMetrics.throughput[key];
                    return (
                      <div key={key} className="bg-muted/50 rounded px-2 py-1.5" data-testid={`throughput-${key}`}>
                        <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
                        <div className="font-medium text-foreground">
                          {t ? `${t.last5m} / ${t.last1h} / ${t.total}` : "0 / 0 / 0"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
