import { useQuery } from "@tanstack/react-query";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, RefreshCw, Clock, AlertTriangle, Database } from "lucide-react";
import type { ConsoleOverview } from "./types";
import { formatSeconds, relativeTime } from "./utils";
import { FRONT_TERMINAL_DONE_PIPELINE_STATES } from "@shared/frontConsoleMetrics";
import { FRONT_MESSAGE_GRAIN_METRIC_TITLES as DEF } from "./messageGrainMetricTitles";
import { FrontPipelineHealthCard } from "./FrontPipelineHealthCard";
import { FrontMatchStatsTile } from "./FrontMatchStatsTile";
import { FrontUnmatchedDiagnosisCard } from "./FrontUnmatchedDiagnosisCard";

export function FrontPipelineHealthTab() {
  const { data, isLoading, isFetching, refetch, error } = useQuery<ConsoleOverview>({
    queryKey: ["/api/integrations/front/console/overview"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/front/console/overview", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Front console overview");
      return res.json();
    },
    refetchInterval: (query) => {
      const overview = query.state.data as ConsoleOverview | undefined;
      const hasLiveRecovery = overview?.jobs?.some(
        (j) => j.type === "historical_recovery" && (j.status === "running" || j.status === "queued"),
      );
      return hasLiveRecovery ? 5_000 : false;
    },
    refetchOnWindowFocus: true,
  });

  const conn = data?.connection;
  const msgs = data?.messages;
  const pipe = data?.pipeline;
  const jobs = data?.jobs ?? [];

  const failedRecoveryJobs = jobs.filter(
    (j) => j.type === "historical_recovery" && j.status === "failed",
  );
  const scrollToJob = (jobId: string) => {
    const el = document.getElementById(`front-job-${jobId}`);
    if (el) el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
  };

  return (
    <div className="space-y-4" data-testid="card-front-console-overview">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
              <Activity className="w-5 h-5 text-blue-600" />
              Pipeline Health
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-refresh-pipeline-health"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {data?.generatedAt
              ? `Updated ${relativeTime(data.generatedAt)}`
              : isLoading
              ? "Loading…"
              : "—"}
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {error ? (
            <div
              className="text-sm bg-red-50 border border-red-200 rounded p-3 text-red-700"
              data-testid="error-pipeline-health"
            >
              Failed to load overview: {(error as Error).message}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3" data-testid="row-connection-status">
            <Badge
              variant="outline"
              className={
                conn?.connected
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-red-50 text-red-700 border-red-200"
              }
              data-testid="badge-connection-status"
            >
              {conn?.connected ? "Connected" : "Disconnected"}
            </Badge>
            <span
              className="text-xs text-muted-foreground inline-flex items-center gap-1"
              data-testid="text-last-sync-success"
            >
              <Clock className="w-3 h-3" />
              Last successful sync: {relativeTime(conn?.lastSyncSuccess)}
            </span>
            {data?.syncProgress?.isRunning && (
              <Badge
                variant="outline"
                className="bg-blue-50 text-blue-700 border-blue-200"
                data-testid="badge-sync-running"
              >
                <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                Sync in progress
              </Badge>
            )}
            {conn?.lastSyncError && (
              <span
                className="text-xs text-red-700 inline-flex items-center gap-1 max-w-full truncate"
                title={conn.lastSyncError}
                data-testid="text-last-sync-error"
              >
                <AlertTriangle className="w-3 h-3" />
                Last error: {conn.lastSyncError}
              </span>
            )}
          </div>

          {/* Task #2603 — Front Console is message-grain only. The former
              conversations-vs-messages caption was removed; the tiles below now
              speak in individual emails/messages, consistent with the Analytics
              Coverage screen. */}

          {failedRecoveryJobs.length > 0 && (
            <div
              className="border border-red-300 bg-red-50 rounded-lg p-3 space-y-2"
              data-testid="banner-recovery-failed"
              role="alert"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-700 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-red-800" data-testid="text-recovery-failed-headline">
                    {failedRecoveryJobs.length === 1
                      ? "1 historical-recovery job died (fatal error)"
                      : `${failedRecoveryJobs.length} historical-recovery jobs died (fatal error)`}
                  </p>
                  <p className="text-xs text-red-700/80">
                    The entire job aborted — not just one window. Resume or re-run is required.
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                {failedRecoveryJobs.map((j) => (
                  <div
                    key={j.id}
                    className="bg-card border border-red-200 rounded p-2 text-xs"
                    data-testid={`row-recovery-failed-${j.id}`}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => scrollToJob(j.id)}
                        className="font-mono text-red-700 hover:underline truncate max-w-[260px]"
                        title={j.id}
                        data-testid={`link-recovery-failed-${j.id}`}
                      >
                        {j.id}
                      </button>
                      <span className="text-red-600/80" data-testid={`text-recovery-failed-updated-${j.id}`}>
                        {relativeTime(j.lastUpdateAt)}
                      </span>
                    </div>
                    {j.statusReason && (
                      <p
                        className="font-mono text-xs text-red-800 mt-1 whitespace-pre-wrap break-words"
                        data-testid={`text-recovery-failed-reason-${j.id}`}
                      >
                        {j.statusReason}
                      </p>
                    )}
                    {j.lastError && (
                      <p
                        className="text-xs text-red-700 mt-1 whitespace-pre-wrap break-words"
                        data-testid={`text-recovery-failed-error-${j.id}`}
                      >
                        {j.lastError}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
            <div
              className={`rounded p-3 ${
                failedRecoveryJobs.length > 0
                  ? "bg-red-50 border border-red-200"
                  : "bg-muted/50"
              }`}
              data-testid="stat-overview-recovery-failed"
            >
              <p className="text-muted-foreground">Recovery jobs failed</p>
              <p
                className={`text-lg sm:text-2xl font-semibold ${
                  failedRecoveryJobs.length > 0 ? "text-red-700" : "text-foreground"
                }`}
                data-testid="text-recovery-failed-count"
              >
                {failedRecoveryJobs.length}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Job-level fatal errors</p>
            </div>
            <div className="bg-amber-50 rounded p-3" data-testid="stat-overview-cursor-age">
              <p className="text-muted-foreground">Sync cursor age</p>
              <p className="text-lg sm:text-2xl font-semibold text-amber-700">
                {formatSeconds(pipe?.cursorAgeSeconds ?? null)}
              </p>
              <p className="text-xs text-amber-700/80 mt-0.5">
                {pipe?.pageTokenActive ? "Page-token in flight" : "Cursor only"}
              </p>
            </div>
            <div className="bg-rose-50 rounded p-3" data-testid="stat-overview-failed">
              <p className="text-muted-foreground">Pipeline failed</p>
              <p className="text-lg sm:text-2xl font-semibold text-rose-700">
                {pipe?.health.failedCount ?? 0}
              </p>
              <p className="text-xs text-rose-700/80 mt-0.5">
                Dead-lettered: {pipe?.health.deadLetteredCount ?? 0}
              </p>
            </div>
            <div className="bg-purple-50 rounded p-3" data-testid="stat-overview-oldest-unprocessed">
              <p className="text-muted-foreground">Oldest unprocessed</p>
              <p className="text-lg sm:text-2xl font-semibold text-purple-700">
                {formatSeconds(pipe?.health.oldestUnprocessedAgeSeconds ?? null)}
              </p>
              <p className="text-xs text-purple-700/80 mt-0.5">
                Avg discover→apply:{" "}
                {pipe?.health.avgDiscoveryToApplyMs != null
                  ? `${Math.round(pipe.health.avgDiscoveryToApplyMs)}ms`
                  : "—"}
              </p>
            </div>
          </div>

          {pipe && Object.keys(pipe.backlogs).length > 0 && (
            <div data-testid="section-pipeline-backlogs">
              <h3 className="text-sm font-medium text-foreground mb-2 flex items-center gap-1.5">
                <Database className="w-4 h-4" />
                Pipeline by state
              </h3>
              <div className="flex items-center gap-4 mb-2 text-xs">
                <span data-testid="text-backlog-summary" title={DEF.backlog}>
                  <span className="text-muted-foreground">Backlog (awaiting/failing): </span>
                  <span className={`font-semibold ${(pipe.backlogCount ?? 0) > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                    {(pipe.backlogCount ?? 0).toLocaleString()}
                  </span>
                </span>
                <span data-testid="text-applied-done-summary" title={DEF.appliedDone}>
                  <span className="text-muted-foreground">Applied / done: </span>
                  <span className="font-semibold text-emerald-700">
                    {(pipe.appliedDoneCount ?? 0).toLocaleString()}
                  </span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(pipe.backlogs)
                  .sort((a, b) => b[1] - a[1])
                  .map(([state, count]) => {
                    const isTerminalDone = (FRONT_TERMINAL_DONE_PIPELINE_STATES as readonly string[]).includes(state);
                    return (
                      <Badge
                        key={state}
                        variant="outline"
                        className={`text-xs ${isTerminalDone ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-card"}`}
                        data-testid={`badge-backlog-${state}`}
                        title={isTerminalDone ? "Terminal / done — not counted as backlog" : "Awaiting or failing processing — counts as backlog"}
                      >
                        <span className="font-mono">{state}</span>
                        <span className="ml-1.5 font-semibold">{count}</span>
                        {isTerminalDone ? <span className="ml-1 text-xs opacity-70">done</span> : null}
                      </Badge>
                    );
                  })}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Backlog excludes terminal states ({FRONT_TERMINAL_DONE_PIPELINE_STATES.join(", ")}). · Version no-ops in last hour: {pipe.versionNoopsLast1h} · Hydrate retries:{" "}
                {pipe.health.hydrateRetryCount}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <FrontUnmatchedDiagnosisCard />
      <FrontPipelineHealthCard />
      <FrontMatchStatsTile />
    </div>
  );
}
