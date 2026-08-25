import { useAuth } from "@/hooks/use-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { XCircle, RefreshCw, Download } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { DiagnosticCommandCenter } from "./DiagnosticCommandCenter";
import { CallAnalysisFailureMixCard, CallAnalysisFailureSpikeAlertConfigCard, DeadLetterQueueCard, StaleLeaseExhaustionCard, StuckProcessingJobsCard } from "./OperationalHealthCards";
import { PostDeployVerificationPanel } from "./PostDeployVerificationPanel";
import type { Alert, HealthSnapshot, HealthHistory } from "./dashboard/types";
import { HISTORY_WINDOW_OPTIONS, HISTORY_WINDOW_STORAGE_KEY } from "./dashboard/historyWindow";
import { DegradedSubChecksBanner } from "./dashboard/DegradedSubChecksBanner";
import { StatusBadge } from "./dashboard/StatusBadge";
import { SemrushGhostCleanupCard } from "./dashboard/SemrushGhostCleanupCard";
import { ImportGhostsSnapshotCard } from "./dashboard/ImportGhostsSnapshotCard";
import { useQueueDrainDomain, QueueDrainControlCard } from "./dashboard/QueueDrainControlCard";
import { useIncidentsDomain, OpenIncidentsCard } from "./dashboard/OpenIncidentsCard";
import { useSamplersDomain, SamplerRuntimeCard } from "./dashboard/SamplerRuntimeCard";
import { useManualReserveDomain, useManualReserveMuteDomain, ManualReserveCard, AdvisoryBypassCard } from "./dashboard/ManualReserveCard";
import { useDbPoolsDomain, DbPoolsCards } from "./dashboard/DbPoolsCards";
import { SectionNav } from "@/components/admin/SectionNav";
import { HEALTH_DASHBOARD_SECTIONS } from "./dashboard/healthSections";
import { useManualReserveAlertsDomain, ManualReserveAlertsCard } from "./dashboard/ManualReserveAlertsCard";
import { StatsOverviewGrid } from "./dashboard/StatsOverviewGrid";
import { LatencyChartCard } from "./dashboard/LatencyChartCard";
import { AlertsStatusCards } from "./dashboard/AlertsStatusCards";
import { useThresholdsDomain, ThresholdsCard } from "./dashboard/ThresholdsCard";

export function HealthDashboardSection() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";

  const POLLING_STORAGE_KEY = "health-dashboard-polling-interval";
  const POLLING_OPTIONS = [10000, 30000, 60000];
  const [pollingInterval, setPollingInterval] = useState<number>(() => {
    if (typeof window === "undefined") return 30000;
    const stored = window.localStorage.getItem(POLLING_STORAGE_KEY);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    return POLLING_OPTIONS.includes(parsed) ? parsed : 30000;
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(POLLING_STORAGE_KEY, String(pollingInterval));
    }
  }, [pollingInterval]);

  const [isTabVisible, setIsTabVisible] = useState(() => {
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
  });

  const [historyWindow, setHistoryWindow] = useState<string>(() => {
    if (typeof window === "undefined") return "3h";
    const stored = window.localStorage.getItem(HISTORY_WINDOW_STORAGE_KEY);
    return HISTORY_WINDOW_OPTIONS.some((o) => o.value === stored) ? (stored as string) : "3h";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(HISTORY_WINDOW_STORAGE_KEY, historyWindow);
    }
  }, [historyWindow]);

  const windowMs = useMemo(
    () => HISTORY_WINDOW_OPTIONS.find((o) => o.value === historyWindow)?.ms ?? HISTORY_WINDOW_OPTIONS[0].ms,
    [historyWindow]
  );

  // Task #992 — server-computed health overview drives the top-level
  // status badge. We poll on the same cadence as `history` and fall back
  // gracefully if the endpoint is unavailable (the badge then derives
  // from the freshest history sample).
  const { data: overview } = useQuery<{
    generatedAt: number;
    currentStatus: "ok" | "degraded" | "error" | "unknown";
    latestSampleAt: number | null;
  }>({
    queryKey: ["/api/health/overview"],
    refetchInterval: isTabVisible ? pollingInterval : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });

  const { data: history, isLoading: historyLoading, error: historyError, refetch: refetchHistory, dataUpdatedAt } = useQuery<HealthHistory>({
    queryKey: ["/api/health/history", historyWindow],
    queryFn: async () => {
      const since = Date.now() - windowMs;
      const res = await fetch(`/api/health/history?since=${since}`, { credentials: "include" });
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

  const {
    data: snapshot,
    error: snapshotError,
    isLoading: snapshotLoading,
    dataUpdatedAt: snapshotUpdatedAt,
    refetch: refetchSnapshot,
  } = useQuery<HealthSnapshot>({
    queryKey: ["/api/health"],
    refetchInterval: isTabVisible ? pollingInterval : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });

  // Task #712/#830 — manual-reserve per-worker domain (by-worker history,
  // export range + selection state). Hook runs unconditionally here so
  // the by-worker history query keeps its original mount position (F11D).
  const manualReserveDomain = useManualReserveDomain({
    isAdmin, isTabVisible, pollingInterval, historyWindow, windowMs,
  });

  // Task #713/#721 — manual-reserve alert-dispatch audit domain (filters,
  // dispatch log, resend). Hook runs unconditionally in the same
  // hook-sequence position as the original filter state (F11D split).
  const manualReserveAlertsDomain = useManualReserveAlertsDomain({
    isAdmin,
    isTabVisible,
    pollingInterval,
    historyWindow,
    windowMs,
  });
  const { refetchManualReserveAlerts } = manualReserveAlertsDomain;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden";
      setIsTabVisible(visible);
      if (visible && isAdmin) {
        void refetchHistory(); // fire-and-forget: refetch only
        void refetchSnapshot(); // fire-and-forget: refetch only
        void refetchManualReserveAlerts(); // fire-and-forget: refetch only
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [isAdmin, refetchHistory, refetchSnapshot, refetchManualReserveAlerts]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsSinceUpdate = dataUpdatedAt ? Math.max(0, Math.floor((nowMs - dataUpdatedAt) / 1000)) : null;
  const secondsUntilRefresh = dataUpdatedAt && isTabVisible
    ? Math.max(0, Math.ceil((dataUpdatedAt + pollingInterval - nowMs) / 1000))
    : null;

  // Alert-thresholds domain (config query + save/reset mutations). Hook
  // runs unconditionally in the same hook-sequence position as the
  // original thresholds query (F11D split).
  const thresholdsDomain = useThresholdsDomain({ isAdmin });
  const { thresholds, thresholdsLoading, thresholdsError, refetchThresholds } = thresholdsDomain;

  // Task #836 Phase 8 — DB pool attribution / kill-switch domain. Hook
  // runs unconditionally in the same hook-sequence position as the
  // original inline query (F11D split).
  const dbPoolsDomain = useDbPoolsDomain({ isAdmin, isTabVisible, pollingInterval });

  // Task #987/#997/#1012/#1013/#1784 — queue-drain control domain
  // (drain state, action history, backlog alerts). The hook runs
  // unconditionally in the same hook-sequence position as the original
  // inline block, so query mounting and polling are unchanged.
  const queueDrainDomain = useQueueDrainDomain({ isAdmin, isTabVisible, pollingInterval });

  // Manual-reserve mute domain (mute state + set/clear). Hook runs
  // unconditionally in the same hook-sequence position as the original
  // muteState query (F11D split).
  const manualReserveMuteDomain = useManualReserveMuteDomain({ isAdmin, isTabVisible });
  const { refetchMute } = manualReserveMuteDomain;

  // Task #918 (913E) — Open incidents (913D), supervised sampler runtime
  // (913B). Domain hooks run unconditionally in the same hook-sequence
  // positions as the original inline blocks (F11D split).
  const incidentsDomain = useIncidentsDomain({ isAdmin, isTabVisible, pollingInterval });
  const samplersDomain = useSamplersDomain({ isAdmin, isTabVisible, pollingInterval });

  if (authLoading) return <PageSkeleton />;

  if (!user || !isAdmin) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center" data-testid="text-access-denied">
        <p className="text-muted-foreground">Access restricted to admin users.</p>
      </div>
    );
  }

  const isLoading = historyLoading || thresholdsLoading;
  const hasError = historyError || thresholdsError;
  // Task #992 — drive the top-level badge from the server-computed
  // `currentStatus` published by /api/health/overview. The server is
  // the only place that knows the watchdog's heartbeat-aware verdict
  // (and the unknown-age threshold), so the UI must not recompute it
  // from the persisted-row age. Falls back to the freshest history
  // sample's status while the overview query is loading.
  const currentStatus: "ok" | "degraded" | "error" | "unknown" =
    overview?.currentStatus ??
    (history?.samples?.length
      ? history.samples[history.samples.length - 1].status
      : "unknown");

  return (
    <div data-testid="section-health-dashboard">
      <div className="border-b bg-card/80 backdrop-blur-sm">
        <div className="container mx-auto px-3 sm:px-4 py-2 sm:py-3 flex items-center justify-end gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={currentStatus} />
            {secondsSinceUpdate !== null && (
              <span className="text-xs text-muted-foreground hidden sm:inline" data-testid="text-last-updated">
                Updated {secondsSinceUpdate}s ago
                {isTabVisible
                  ? secondsUntilRefresh !== null && ` · next in ${secondsUntilRefresh}s`
                  : " · paused (tab hidden)"}
              </span>
            )}
            <Select
              value={historyWindow}
              onValueChange={(v) => setHistoryWindow(v)}
            >
              <SelectTrigger className="w-[140px] h-8" data-testid="select-history-window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HISTORY_WINDOW_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    data-testid={`option-history-window-${opt.value}`}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(pollingInterval)}
              onValueChange={(v) => setPollingInterval(parseInt(v, 10))}
            >
              <SelectTrigger className="w-[110px] h-8" data-testid="select-polling-interval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10000" data-testid="option-polling-10s">Every 10s</SelectItem>
                <SelectItem value="30000" data-testid="option-polling-30s">Every 30s</SelectItem>
                <SelectItem value="60000" data-testid="option-polling-60s">Every 60s</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              asChild
              data-testid="button-export-csv"
            >
              <a href={`/api/health/history/export?format=csv&since=${Date.now() - windowMs}`} download={`health-metrics-${historyWindow}.csv`}>
                <Download className="w-3 h-3 mr-1" />
                Download CSV
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              asChild
              data-testid="button-export-json"
            >
              <a href={`/api/health/history/export?format=json&since=${Date.now() - windowMs}`} download={`health-metrics-${historyWindow}.json`}>
                <Download className="w-3 h-3 mr-1" />
                JSON
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void refetchHistory(); void refetchThresholds(); void refetchSnapshot(); void refetchMute(); }} // fire-and-forget: refetch only
              data-testid="button-refresh"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6">
        {/* Task #4344 — two-column shell: content column + sticky SectionNav
            anchor rail (xl and up) so operators can jump between the 15+
            stacked sections (audit §6.1-E / §8.3). */}
        <div className="flex items-start gap-6">
        <div className="flex-1 min-w-0 space-y-6">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-muted animate-pulse rounded-lg" />
            ))}
          </div>
        ) : (
          <>
            {hasError && (
              <Card className="border-red-200" data-testid="card-fetch-error">
                <CardContent className="py-4 flex items-center gap-2 text-red-700">
                  <XCircle className="w-5 h-5" />
                  <span className="font-medium">
                    Failed to load health data. {historyError ? "History endpoint unreachable." : ""} {thresholdsError ? "Thresholds endpoint unreachable." : ""}
                  </span>
                  <Button variant="outline" size="sm" className="ml-auto" onClick={() => { void refetchHistory(); void refetchThresholds(); }} data-testid="button-retry">
                    <RefreshCw className="w-3 h-3 mr-1" />
                    Retry
                  </Button>
                </CardContent>
              </Card>
            )}
            {/* Task #1068 — surface non-critical degradations from
                /api/health that no longer flip the HTTP status code. */}
            <DegradedSubChecksBanner snapshot={snapshot} />
            {/* Task #928: Post-deploy verification — runs the §8 runbook
                checklist on demand right after each rollout, with a
                compare-to-last-deploy view and a one-click force-resolve
                for legacy stuck incidents. Sits above the Diagnostic
                Command Center so it's the first thing an operator sees
                after a deploy. */}
            <section id="post-deploy-verification" className="scroll-mt-16">
              <PostDeployVerificationPanel enabled={isAdmin} />
            </section>
            {/* Task #861: Diagnostic Command Center sits at the top of the
                dashboard so operators see SLO/incidents/freshness/db-metrics
                before drilling into the older stat grid below. */}
            <section id="diagnostic-command-center" className="scroll-mt-16">
              <DiagnosticCommandCenter enabled={isAdmin} />
            </section>
            {/* Task #898: Operational Health — Dead Letter Queue & Stale Lease
                Exhaustion cards relocated from /admin/integrations so all
                operator-facing health surfaces live on /admin/health. */}
            {isAdmin && (
              <section id="operational-health" className="space-y-4 scroll-mt-16" data-testid="section-operational-health">
                <h2 className="text-lg font-semibold text-foreground">Operational Health</h2>
                <DeadLetterQueueCard />
                <StaleLeaseExhaustionCard />
                {/* Task #1057: Call-analysis failure mix — typed failure_reason
                    × lane breakdown over 24h/7d plus the live slow-lane backlog. */}
                <CallAnalysisFailureMixCard />
                {/* Task #1096: Failure-spike alert config (thresholds + mute
                    list + dry-run preview) lives next to the failure-mix
                    panel so operators can tune Task #1076 from the UI. */}
                <CallAnalysisFailureSpikeAlertConfigCard />
                {/* Task #1054 — surface the stuck-processing inventory
                    (jobs leased/processing too long, with the next sweep
                    flagged) right next to the other work-queue panels. */}
                <StuckProcessingJobsCard />
              </section>
            )}
            {/* Task #813: stat grid expanded from 4 → 6 tiles to surface
                separated pool-wait + transient-recovery metrics. The two
                "DB round-trip" tiles replace the previous "Latency" tiles
                (server still emits dbLatencyMs as an alias, so older clients
                continue to render).
                Task #1255: extended to 7 tiles to add the proactive
                connection-recycle counter alongside transient recoveries. */}
            <section id="stats-overview" className="scroll-mt-16">
              <StatsOverviewGrid history={history} />
            </section>

            <section id="manual-reserve" className="scroll-mt-16">
              <ManualReserveCard
                domain={manualReserveDomain}
                muteDomain={manualReserveMuteDomain}
                snapshot={snapshot}
                snapshotLoading={snapshotLoading}
                snapshotError={snapshotError}
                snapshotUpdatedAt={snapshotUpdatedAt}
                history={history}
                windowMs={windowMs}
                isAdmin={isAdmin}
                isTabVisible={isTabVisible}
                pollingInterval={pollingInterval}
                refetchSnapshot={refetchSnapshot}
              />
            </section>

            <section id="advisory-bypass" className="scroll-mt-16">
              <AdvisoryBypassCard snapshot={snapshot} snapshotLoading={snapshotLoading} />
            </section>

            <section id="reserve-alerts" className="scroll-mt-16">
              <ManualReserveAlertsCard domain={manualReserveAlertsDomain} windowMs={windowMs} />
            </section>

            <section id="latency" className="scroll-mt-16">
              <LatencyChartCard history={history} thresholds={thresholds} windowMs={windowMs} />
            </section>

            <section id="alerts-status" className="scroll-mt-16">
              <AlertsStatusCards history={history} thresholds={thresholds} />
            </section>

            <section id="open-incidents" className="scroll-mt-16">
              <OpenIncidentsCard domain={incidentsDomain} />
            </section>

            <section id="sampler-runtime" className="scroll-mt-16">
              <SamplerRuntimeCard domain={samplersDomain} />
            </section>

            <section id="db-pools" className="scroll-mt-16">
              <DbPoolsCards domain={dbPoolsDomain} />
            </section>

            {/* Task #758: SEMrush ghost cleanup trend. */}
            <section id="semrush-ghost-cleanup" className="scroll-mt-16">
              <SemrushGhostCleanupCard />
            </section>

            {/* Task #1222: import-ghosts snapshot (the *other* ghost surfaces). */}
            <section id="import-ghosts" className="scroll-mt-16">
              <ImportGhostsSnapshotCard />
            </section>

            {/* Task #987: Queue drain control. */}
            <section id="queue-drain" className="scroll-mt-16">
              <QueueDrainControlCard domain={queueDrainDomain} />
            </section>

            <section id="thresholds" className="scroll-mt-16">
              <ThresholdsCard domain={thresholdsDomain} />
            </section>
          </>
        )}
        </div>
        <SectionNav
          sections={HEALTH_DASHBOARD_SECTIONS}
          className="hidden xl:block w-56 shrink-0"
        />
        </div>
      </div>
    </div>
  );
}

