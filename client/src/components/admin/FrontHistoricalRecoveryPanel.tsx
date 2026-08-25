// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { useAuth } from "@/hooks/use-auth";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { Activity, ChevronDown, ChevronUp, Download, Loader2, RefreshCw } from "lucide-react";
import type { AutoClosureStatus, CoverageMonth, IntegrationStatus, RecoverySweepStatusResponse, RecoveryAutoContinueResponse, RecoveryRetryAlertResponse } from "./front/recovery/types";
import { useRecoveryJobs } from "./front/recovery/useRecoveryJobs";
import { RecoveryStatusBanner } from "./front/recovery/RecoveryStatusBanner";
import { CoverageWindowsStrip } from "./front/recovery/CoverageWindowsStrip";
import { AutoClosureParkedSection } from "./front/recovery/AutoClosureParkedSection";
import { OvernightConfigSection } from "./front/recovery/OvernightConfigSection";
import { RegressionAlertSection } from "./front/recovery/RegressionAlertSection";
import { AnalyticsCoverageSection } from "./front/recovery/AnalyticsCoverageSection";
import { CustomRangeSection } from "./front/recovery/CustomRangeSection";
import { CurrentJobCard } from "./front/recovery/CurrentJobCard";
import { RecoveryTuningSection } from "./front/recovery/RecoveryTuningSection";
import { MaterializerBudgetSection } from "./front/recovery/MaterializerBudgetSection";
import { RecoverySettingsSection } from "./front/recovery/RecoverySettingsSection";
import { RecoveryHistorySection } from "./front/recovery/RecoveryHistorySection";
import { AdvancedBackfillSection } from "./front/recovery/AdvancedBackfillSection";

export function FrontHistoricalRecoveryPanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";
  const isTabVisible = useTabVisibility();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: status } = useQuery<IntegrationStatus>({
    queryKey: ["/api/integrations/all-status"],
  });
  const {
    coverageLoading,
    coverageReport,
    recoveryDeleteJobMutation,
    recoveryExecuteMutation,
    recoveryJob,
    recoveryJobsList,
    recoveryPollingJobId,
    recoveryResumeMutation,
    recoveryRunning,
    refetchCoverage,
    refetchRecoveryJobs,
    resumeRunAgainConfirmDialog,
    setRecoveryJob,
    showResumeUnavailableToast,
    statusBadgeFor,
  } = useRecoveryJobs({ isAdmin, status });

  const [recoveryAdvancedOpen, setRecoveryAdvancedOpen] = useState(false);
  const [autohealNowMs, setAutohealNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAutohealNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  // Task #1682 — Front self-healing coverage loop status.
  const { data: autoClosureStatus } = useQuery<AutoClosureStatus>({
    queryKey: ["/api/admin/front/auto-closure/status"],
    enabled: isAdmin && !!status?.front.connected,
    // Task #2118 — keep the existing 60s cadence, but fast-poll (5s) only
    // while a per-window re-arm drain is actively running so its inline
    // progress/last-result badge feels responsive without adding a new
    // query. Falls back to 60s the moment all drains finish.
    refetchInterval: (query) => {
      if (!isTabVisible) return false;
      const data: any = query.state.data;
      const anyPerWindowRunning = data?.reArmDrains
        ? Object.values(data.reArmDrains).some((d: any) => d?.running)
        : false;
      // Task #2148 — also fast-poll while the all-windows re-arm drain runs.
      const allRunning = data?.allReArmDrain?.running === true;
      return anyPerWindowRunning || allRunning ? 5000 : 60000;
    },
    refetchIntervalInBackground: false,
  });

  const { data: recoverySweepStatus } = useQuery<RecoverySweepStatusResponse>({
    queryKey: ["/api/integrations/front/historical-recovery/sweep-status"],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: isTabVisible ? 60_000 : false,
    refetchIntervalInBackground: false,
  });

  // Task #989: GET / PUT for auto-continue max attempts cap + history.
  const { data: recoveryAutoContinue, refetch: refetchRecoveryAutoContinue } = useQuery<RecoveryAutoContinueResponse>({
    queryKey: ["/api/integrations/front/historical-recovery/auto-continue-max-attempts"],
    enabled: isAdmin && !!status?.front.connected,
  });

  // Task #1023: GET / PUT for the retry-pressure alert config.
  const { data: recoveryRetryAlert, refetch: refetchRecoveryRetryAlert } = useQuery<RecoveryRetryAlertResponse>({
    queryKey: ["/api/integrations/front/historical-recovery/retry-alert"],
    enabled: isAdmin && !!status?.front.connected,
  });

  const autohealStatus = useMemo(() => {
    const ss = recoverySweepStatus;
    const ac = recoveryAutoContinue;
    const jobs = recoveryJobsList?.jobs ?? [];
    const running = !!ss?.running;
    const intervalMs = ss?.intervalMs ?? 0;
    const lastSweepMs = ss?.lastSweepAt ? new Date(ss.lastSweepAt).getTime() : null;
    const sweepStale = running && lastSweepMs != null && intervalMs > 0
      && (autohealNowMs - lastSweepMs) > 2 * intervalMs;
    const skipReasonCounts: Record<string, number> = {};
    for (const j of jobs) {
      if ((j.status === "partial" || j.status === "blocked" || j.status === "failed")
          && j.reasonClassification) {
        skipReasonCounts[j.reasonClassification] =
          (skipReasonCounts[j.reasonClassification] ?? 0) + 1;
      }
    }
    const hasNonTransient = (skipReasonCounts["non_transient"] ?? 0) > 0;
    const hitCap = jobs.some(j =>
      (j.autoContinueAttempt ?? 0) > 0
      && (j.autoContinueMaxAttempts ?? 0) > 0
      && (j.autoContinueAttempt ?? 0) >= (j.autoContinueMaxAttempts ?? 0)
      && (j.status === "partial" || j.status === "blocked" || j.status === "failed"));
    const paused = !!ss?.paused;
    let state: "green" | "amber" | "red" | "gray";
    if (!running) state = "gray";
    else if (ss?.lastError || hasNonTransient || hitCap) state = "red";
    else if (paused || sweepStale || (ac?.maxAttempts === 0)) state = "amber";
    else state = "green";
    return { state, paused };
  }, [recoverySweepStatus, recoveryAutoContinue, recoveryJobsList, autohealNowMs]);

  if (!status?.front.connected) return null;

  const months: CoverageMonth[] = coverageReport?.months ?? [];
  const gapCount = (coverageReport?.gaps ?? []).length;
  return (
    <Card className="bg-card" data-testid="card-front-historical-recovery">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="w-5 h-5 text-emerald-600" />
          Front Historical Recovery
          {gapCount > 0 ? (
            <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200" data-testid="badge-recovery-gaps">{gapCount} gap{gapCount === 1 ? "" : "s"}</Badge>
          ) : coverageReport ? (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200" data-testid="badge-recovery-no-gaps">No gaps</Badge>
          ) : null}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => refetchCoverage()} disabled={coverageLoading} data-testid="button-recovery-refresh-coverage">
            {coverageLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Refresh
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <RecoveryStatusBanner
          autohealNowMs={autohealNowMs}
          autohealStatus={autohealStatus}
          isAdmin={isAdmin}
          recoveryAutoContinue={recoveryAutoContinue}
          recoveryJobsList={recoveryJobsList}
          recoverySweepStatus={recoverySweepStatus}
          refetchRecoveryAutoContinue={refetchRecoveryAutoContinue}
          status={status}
        />

        <CoverageWindowsStrip
          coverageReport={coverageReport}
          gapCount={gapCount}
          months={months}
        />

        <AutoClosureParkedSection
          autoClosureStatus={autoClosureStatus}
          months={months}
          status={status}
        />

        <OvernightConfigSection
          isAdmin={isAdmin}
          status={status}
        />

        <RegressionAlertSection
          isAdmin={isAdmin}
          status={status}
        />

        <AnalyticsCoverageSection
          autoClosureStatus={autoClosureStatus}
          isAdmin={isAdmin}
          months={months}
          status={status}
        />


        <div className="flex flex-wrap gap-2">
          <ConfirmActionDialog
            trigger={
              <Button
                size="sm"
                variant="default"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                data-testid="button-recovery-run"
                disabled={recoveryRunning || recoveryExecuteMutation.isPending}
              >
                {recoveryRunning ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
                Recover gaps
              </Button>
            }
            title="Recover missing Front history?"
            description="This runs the canonical recovery engine across detected gap windows, re-fetching those ranges from Front's API. It is checkpointed and resumable, and only one recovery job can run at a time."
            confirmLabel="Recover gaps"
            onConfirm={() => recoveryExecuteMutation.mutate({ dryRun: false })}
            testId="dialog-recovery-run"
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="button-recovery-dry-run"
            disabled={recoveryRunning || recoveryExecuteMutation.isPending}
            onClick={() => recoveryExecuteMutation.mutate({ dryRun: true })}
          >
            {recoveryExecuteMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Activity className="w-3 h-3 mr-1" />}
            Dry run
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-recovery-custom-range-toggle"
            onClick={() => setCustomRangeOpen(!customRangeOpen)}
          >
            {customRangeOpen ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
            Custom range
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground ml-auto"
            data-testid="button-recovery-advanced-toggle"
            onClick={() => setRecoveryAdvancedOpen(!recoveryAdvancedOpen)}
          >
            {recoveryAdvancedOpen ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
            Advanced
          </Button>
        </div>

        <CustomRangeSection
          customRangeOpen={customRangeOpen}
          months={months}
          recoveryExecuteMutation={recoveryExecuteMutation}
          recoveryJobsList={recoveryJobsList}
          recoveryRunning={recoveryRunning}
          status={status}
        />

        <CurrentJobCard
          isAdmin={isAdmin}
          recoveryDeleteJobMutation={recoveryDeleteJobMutation}
          recoveryExecuteMutation={recoveryExecuteMutation}
          recoveryJob={recoveryJob}
          recoveryPollingJobId={recoveryPollingJobId}
          recoveryResumeMutation={recoveryResumeMutation}
          recoveryRetryAlert={recoveryRetryAlert}
          setRecoveryJob={setRecoveryJob}
          showResumeUnavailableToast={showResumeUnavailableToast}
          status={status}
          statusBadgeFor={statusBadgeFor}
        />

        <RecoveryTuningSection
          isAdmin={isAdmin}
          status={status}
        />

        <MaterializerBudgetSection
          isAdmin={isAdmin}
          status={status}
        />

        <RecoverySettingsSection
          isAdmin={isAdmin}
          recoveryRetryAlert={recoveryRetryAlert}
          refetchRecoveryJobs={refetchRecoveryJobs}
          refetchRecoveryRetryAlert={refetchRecoveryRetryAlert}
          status={status}
        />

        <RecoveryHistorySection
          autohealStatus={autohealStatus}
          recoveryDeleteJobMutation={recoveryDeleteJobMutation}
          recoveryJob={recoveryJob}
          recoveryJobsList={recoveryJobsList}
          recoveryPollingJobId={recoveryPollingJobId}
          recoveryResumeMutation={recoveryResumeMutation}
          refetchRecoveryJobs={refetchRecoveryJobs}
          setRecoveryJob={setRecoveryJob}
          showResumeUnavailableToast={showResumeUnavailableToast}
          status={status}
          statusBadgeFor={statusBadgeFor}
        />

        <AdvancedBackfillSection
          recoveryAdvancedOpen={recoveryAdvancedOpen}
          status={status}
        />

        {/* Confirmation for the "Run again instead" toast action (Task #4589) */}
        {resumeRunAgainConfirmDialog}
      </CardContent>
    </Card>
  );
}
