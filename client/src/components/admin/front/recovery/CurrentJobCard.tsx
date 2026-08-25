// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { AlertTriangle, Download, Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { FRONT_CONSOLE_LENSES, getFrontConsoleMetric } from "@shared/frontConsoleMetrics";
import type {
  IntegrationStatus,
  RecoveryJobSnapshot,
  RecoveryJobWindow,
  RecoveryRetryAlertResponse,
  RetryPressureAlertEntry,
} from "./types";
import type { RecoveryJobsHook } from "./useRecoveryJobs";
import type { Dispatch, SetStateAction } from "react";

type Props = {
  isAdmin: boolean;
  recoveryDeleteJobMutation: RecoveryJobsHook["recoveryDeleteJobMutation"];
  recoveryExecuteMutation: RecoveryJobsHook["recoveryExecuteMutation"];
  recoveryJob: RecoveryJobSnapshot | null;
  recoveryPollingJobId: string | null;
  recoveryResumeMutation: RecoveryJobsHook["recoveryResumeMutation"];
  recoveryRetryAlert: RecoveryRetryAlertResponse | undefined;
  setRecoveryJob: Dispatch<SetStateAction<RecoveryJobSnapshot | null>>;
  showResumeUnavailableToast: (args: { jobId: string; status?: string; description: string; runAgainConfirmMessage?: string }) => void;
  status: IntegrationStatus | undefined;
  statusBadgeFor: (s: string) => string;
};

export function CurrentJobCard({ isAdmin, recoveryDeleteJobMutation, recoveryExecuteMutation, recoveryJob, recoveryPollingJobId, recoveryResumeMutation, recoveryRetryAlert, setRecoveryJob, showResumeUnavailableToast, status, statusBadgeFor }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();


  // Task #1091 — admin-only "Acknowledge alert / Clear alert history"
  // for a single recovery window. Wipes the persisted
  // `retryPressureAlerts` array on the window and removes the
  // in-memory dedupe key so a re-evaluation can fire a fresh alert if
  // the threshold is crossed again.
  const recoveryClearWindowAlertsMutation = useMutation<
    {
      success: boolean;
      jobId: string;
      windowLabel: string;
      alertsCleared: number;
      singleWindowDedupeCleared: boolean;
      consecutivePatternsCleared: number;
    },
    Error,
    { jobId: string; windowLabel: string }
  >({
    mutationFn: async ({ jobId, windowLabel }) => {
      const res = await apiRequest(
        "POST",
        `/api/integrations/front/historical-recovery/jobs/${encodeURIComponent(jobId)}/windows/${encodeURIComponent(windowLabel)}/clear-alerts`,
      );
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Alert history cleared",
        description: `Cleared ${data.alertsCleared} alert event${data.alertsCleared === 1 ? "" : "s"} on window ${data.windowLabel}. A fresh alert can fire if the threshold is crossed again.`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/jobs"] }); // fire-and-forget: cache refresh only
      if (recoveryJob?.jobId === data.jobId) {
        setRecoveryJob((prev) => {
          if (!prev || prev.jobId !== data.jobId) return prev;
          const windows = Array.isArray(prev.windows)
            ? prev.windows.map((w) =>
                w?.windowLabel === data.windowLabel
                  ? { ...w, retryPressureAlerts: [] }
                  : w,
              )
            : prev.windows;
          return { ...prev, windows };
        });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Clear alerts failed", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  // Task #1016: humanize the per-window retry breakdown surfaced in the
  // recovery job card. Keys come from the page helper's
  // `FrontRecoveryRetryReason`; anything unknown falls back to the raw
  // key so new server-side reasons stay visible without a UI deploy.
  const RETRY_REASON_LABELS: Record<string, string> = {
    timeout: "timeout",
    network: "network",
    front_502: "502",
    front_503: "503",
    front_504: "504",
    front_5xx: "5xx",
    front_429: "rate-limit",
    auth_refresh_transient: "token refresh",
    db_pool_saturated: "DB pool saturated",
    db_pool_contended: "DB pool contended",
    // Task #1903 — surface the Stage 5/6 suppression skip counters next
    // to the retry counters so operators see them at a glance.
    same_response_suppressed: "same-response suppressed",
    inactive_inbox_skipped: "inactive inbox skipped",
  };

  // Task #1084: humanize retry-pressure alert decisions surfaced on the
  // window timeline. Unknown decisions fall back to the raw key so new
  // server-side decisions stay visible without a UI deploy.
  const ALERT_DECISION_LABELS: Record<string, string> = {
    alerted: "alert sent",
    skipped_disabled: "alert disabled",
    skipped_send_failed: "send failed",
    skipped_dispatcher_skipped: "suppressed by dispatcher",
    skipped_no_counters: "no counters",
  };

  const formatAlertTime = (iso: string): string => {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  const count5xxFromRetries = (retries: Record<string, number>): number =>
    (Number(retries.front_501) || 0) +
    (Number(retries.front_502) || 0) +
    (Number(retries.front_503) || 0) +
    (Number(retries.front_504) || 0) +
    (Number(retries.front_5xx) || 0);

  const renderRecoveryWindowResilience = (
    w: RecoveryJobWindow,
    streakInfo?: { streak: number; required: number; floor: number } | null,
    jobId?: string,
  ) => {
    const retries: Record<string, number> = (w?.retriesByReason && typeof w.retriesByReason === "object")
      ? w.retriesByReason
      : {};
    const totalRetries = typeof w?.totalRetries === "number"
      ? w.totalRetries
      : Object.values(retries).reduce((a: number, v) => a + (Number(v) || 0), 0);
    const tokenRefreshes = Number(w?.tokenRefreshes ?? 0) || 0;
    const alerts: RetryPressureAlertEntry[] = Array.isArray(w?.retryPressureAlerts) ? w.retryPressureAlerts : [];
    const alertSent = alerts.find((a) => a?.decision === "alerted");
    const front5xxRetries = count5xxFromRetries(retries);
    const showStreak = !!streakInfo && streakInfo.required > 0 && streakInfo.streak > 0;
    const streakAtOrOver = showStreak && (streakInfo!.streak >= streakInfo!.required);
    const front5xxOverFloor =
      !!streakInfo && streakInfo.floor > 0 && front5xxRetries >= streakInfo.floor;
    if (
      totalRetries === 0 &&
      tokenRefreshes === 0 &&
      alerts.length === 0 &&
      front5xxRetries === 0 &&
      !showStreak
    ) return null;
    const sortedEntries = Object.entries(retries)
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => (Number(b[1]) - Number(a[1])));
    const breakdownTitle = sortedEntries.length > 0
      ? sortedEntries.map(([k, v]) => `${RETRY_REASON_LABELS[k] ?? k}: ${v}`).join(", ")
      : "";
    return (
      <span className="flex items-center gap-1 flex-wrap">
        {totalRetries > 0 && (
          <Badge
            variant="outline"
            className={`text-xs px-1.5 py-0 font-normal ${
              alertSent
                ? "bg-red-50 text-red-800 border-red-200"
                : "bg-amber-50 text-amber-800 border-amber-200"
            }`}
            title={
              alertSent
                ? `Retry-pressure alert fired — threshold ≥ ${alertSent.threshold}${
                    breakdownTitle ? ` · ${breakdownTitle}` : ""
                  }`
                : breakdownTitle
                  ? `Retries — ${breakdownTitle}`
                  : undefined
            }
            data-testid={`badge-recovery-window-retries-${w.windowLabel}`}
          >
            {alertSent && <AlertTriangle className="w-3 h-3 mr-0.5" />}
            {totalRetries} retr{totalRetries === 1 ? "y" : "ies"}
            {sortedEntries.length > 0 && (
              <span className={`ml-1 ${alertSent ? "text-red-700/80" : "text-amber-700/80"}`}>
                ({sortedEntries.map(([k, v]) => `${RETRY_REASON_LABELS[k] ?? k} ${v}`).join(" · ")})
              </span>
            )}
            {alertSent && (
              <span
                className="ml-1 text-red-700 font-medium"
                data-testid={`indicator-recovery-window-alert-${w.windowLabel}`}
              >
                · alert fired
              </span>
            )}
          </Badge>
        )}
        {tokenRefreshes > 0 && (
          <Badge
            variant="outline"
            className="bg-sky-50 text-sky-800 border-sky-200 text-xs px-1.5 py-0 font-normal"
            title={`Front access token was refreshed ${tokenRefreshes} time${tokenRefreshes === 1 ? "" : "s"} during this window`}
            data-testid={`badge-recovery-window-token-refresh-${w.windowLabel}`}
          >
            <RefreshCw className="w-3 h-3 mr-0.5" />
            token refreshed{tokenRefreshes > 1 ? ` ×${tokenRefreshes}` : ""}
          </Badge>
        )}
        {front5xxRetries > 0 && (
          <Badge
            variant="outline"
            className={`text-xs px-1.5 py-0 font-normal ${
              front5xxOverFloor
                ? "bg-amber-50 text-amber-800 border-amber-200"
                : "bg-muted/50 text-foreground border-border"
            }`}
            title={
              streakInfo && streakInfo.floor > 0
                ? `Front 5xx retries this window: ${front5xxRetries}${
                    front5xxOverFloor
                      ? ` (≥ floor ${streakInfo.floor})`
                      : ` (floor ${streakInfo.floor})`
                  }`
                : `Front 5xx retries this window: ${front5xxRetries}`
            }
            data-testid={`badge-recovery-window-front-5xx-${w.windowLabel}`}
          >
            Front 5xx: {front5xxRetries}
          </Badge>
        )}
        {showStreak && (
          <Badge
            variant="outline"
            className={`text-xs px-1.5 py-0 font-normal ${
              streakAtOrOver
                ? "bg-amber-50 text-amber-800 border-amber-200"
                : "bg-muted/50 text-foreground border-border"
            }`}
            title={
              streakAtOrOver
                ? `Trailing ${streakInfo!.required} completed windows have all bled ≥ ${streakInfo!.floor} Front 5xx retries — slow-burn alert pattern reached`
                : `Trailing streak of completed windows with ≥ ${streakInfo!.floor} Front 5xx retries — alert fires at ${streakInfo!.required}`
            }
            data-testid={`badge-recovery-window-front-5xx-streak-${w.windowLabel}`}
          >
            {streakAtOrOver && <AlertTriangle className="w-3 h-3 mr-0.5" />}
            {streakInfo!.streak} of {streakInfo!.required} windows over floor
          </Badge>
        )}
        {alerts.length > 0 && (
          <span
            className="basis-full flex flex-col gap-0.5 text-xs text-muted-foreground mt-0.5"
            data-testid={`list-recovery-window-alerts-${w.windowLabel}`}
          >
            {isAdmin && jobId && (
              <span className="flex justify-end">
                <ConfirmActionDialog
                  title={`Clear alert history on window ${w.windowLabel}?`}
                  description={`This clears ${alerts.length} retry-pressure alert event${alerts.length === 1 ? "" : "s"} recorded on window ${w.windowLabel}. A fresh alert can fire again if the threshold is crossed.`}
                  confirmLabel="Clear alert history"
                  testId={`dialog-confirm-clear-recovery-window-alerts-${w.windowLabel}`}
                  onConfirm={() => {
                    recoveryClearWindowAlertsMutation.mutate({
                      jobId,
                      windowLabel: w.windowLabel,
                    });
                  }}
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-xs text-muted-foreground hover:text-red-700"
                      disabled={
                        recoveryClearWindowAlertsMutation.isPending &&
                        recoveryClearWindowAlertsMutation.variables?.jobId === jobId &&
                        recoveryClearWindowAlertsMutation.variables?.windowLabel === w.windowLabel
                      }
                      data-testid={`button-clear-recovery-window-alerts-${w.windowLabel}`}
                      title="Acknowledge & clear this window's retry-pressure alert history"
                    >
                      Clear alert history
                    </Button>
                  }
                />
              </span>
            )}
            {alerts.map((a, i) => {
              const isAlerted = a?.decision === "alerted";
              const label = ALERT_DECISION_LABELS[a?.decision] ?? String(a?.decision ?? "unknown");
              return (
                <span
                  key={`${w.windowLabel}-alert-${i}`}
                  className={`flex items-center gap-1 flex-wrap ${
                    isAlerted ? "text-red-700" : "text-amber-700"
                  }`}
                  data-testid={`item-recovery-window-alert-${w.windowLabel}-${i}`}
                  title={a?.skipReason ? `Reason: ${a.skipReason}` : undefined}
                >
                  <AlertTriangle className="w-3 h-3" />
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground">at {formatAlertTime(a?.at)}</span>
                  <span className="text-muted-foreground">
                    · {Number(a?.totalRetries ?? 0)} retries (threshold ≥ {Number(a?.threshold ?? 0)})
                  </span>
                  {!isAlerted && a?.skipReason && (
                    <span className="text-muted-foreground truncate">— {String(a.skipReason)}</span>
                  )}
                </span>
              );
            })}
          </span>
        )}
      </span>
    );
  };

  return (
    <>
        {recoveryJob && (() => {
          type RecoveryWindow = {
            windowLabel?: string;
            afterTimestamp?: number;
            beforeTimestamp?: number;
          };
          const isRerunWindow = (
            w: RecoveryWindow,
          ): w is { windowLabel: string; afterTimestamp: number; beforeTimestamp: number } =>
            !!w &&
            typeof w.windowLabel === "string" &&
            w.windowLabel.length > 0 &&
            typeof w.afterTimestamp === "number" &&
            typeof w.beforeTimestamp === "number";
          const interruptedByRestart = recoveryJob.statusReason === "interrupted_by_server_restart";
          const partialSummary = `Captured before restart — pages ${recoveryJob.totals?.pages ?? 0}, scanned ${recoveryJob.totals?.scanned ?? 0}, ingested ${recoveryJob.totals?.ingested ?? 0}, skipped ${recoveryJob.totals?.skipped ?? 0}, errors ${recoveryJob.totals?.errors ?? 0}.`;
          const rerunWindows: Array<{ label: string; afterTimestamp: number; beforeTimestamp: number }> = Array.isArray(recoveryJob.windows)
            ? (recoveryJob.windows as RecoveryWindow[])
                .filter(isRerunWindow)
                .map((w) => ({ label: w.windowLabel, afterTimestamp: w.afterTimestamp, beforeTimestamp: w.beforeTimestamp }))
            : [];
          const isDryRunJob = !!recoveryJob.dryRun;
          const dryRunStatus = recoveryJob.status as string | undefined;
          const dryRunIsRunning = dryRunStatus === "running" || dryRunStatus === "queued";
          const dryRunIsTerminal = dryRunStatus === "complete" || dryRunStatus === "partial" || dryRunStatus === "blocked" || dryRunStatus === "failed";
          const dryRunIngested = recoveryJob.totals?.ingested ?? 0;
          const dryRunFoundWork = isDryRunJob && dryRunIsTerminal && dryRunIngested > 0;
          return (
          <div
            className={`border rounded-lg p-3 space-y-2 ${interruptedByRestart ? "bg-amber-50 border-amber-300" : "bg-muted/50"}`}
            data-testid="div-recovery-status"
          >
            <div className="flex items-center gap-2 text-sm font-medium flex-wrap">
              {recoveryJob.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-blue-600" />}
              Recovery
              <Badge variant="outline" className={statusBadgeFor(recoveryJob.status)} data-testid="badge-recovery-status">
                {recoveryJob.status}
              </Badge>
              {recoveryJob.dryRun && <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">dry run</Badge>}
              {interruptedByRestart && (
                <Badge
                  variant="outline"
                  className="bg-amber-100 text-amber-800 border-amber-300 flex items-center gap-1"
                  title={partialSummary}
                  data-testid="badge-recovery-interrupted-by-restart"
                >
                  <AlertTriangle className="w-3 h-3" />
                  Interrupted by restart
                </Badge>
              )}
              {recoveryJob.jobId && recoveryJob.status !== "running" && recoveryJob.status !== "queued" && (
                <ConfirmActionDialog
                  title="Delete this recovery job from history?"
                  description={`Recovery job ${recoveryJob.jobId} and its window bookkeeping will be removed from the history list. This cannot be undone.`}
                  confirmLabel="Delete job"
                  testId="dialog-confirm-recovery-delete-current"
                  onConfirm={() => recoveryDeleteJobMutation.mutate(recoveryJob.jobId)}
                  trigger={
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50"
                      data-testid="button-recovery-delete-current"
                      disabled={recoveryDeleteJobMutation.isPending}
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      Delete
                    </Button>
                  }
                />
              )}
            </div>
            {isDryRunJob && (
              <div
                className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1.5"
                data-testid="text-recovery-dry-run-banner"
              >
                <div className="font-medium">
                  {dryRunIsRunning
                    ? "Preview in progress — nothing is being imported."
                    : dryRunIsTerminal
                      ? dryRunFoundWork
                        ? "Preview finished. The numbers below show what a real run would import — nothing has been imported yet."
                        : "Preview finished. No missing emails were found in this range — nothing needs to be imported."
                      : "Preview only — nothing will be imported. The numbers below show what a real run would do."}
                </div>
                {dryRunFoundWork && (
                  <div className="mt-2">
                    <ConfirmActionDialog
                      title="Import the previewed emails now?"
                      description={
                        rerunWindows.length > 0
                          ? `This runs a real import for ${rerunWindows.map((w) => w.label).join(", ")} — the same windows you just previewed. Emails found missing will be imported into the system.`
                          : "This runs the canonical recovery engine across the same gap windows you just previewed. Emails found missing will be imported into the system."
                      }
                      confirmLabel="Run for real"
                      testId="dialog-confirm-recovery-run-for-real"
                      onConfirm={() => {
                        const usedCustomWindows = rerunWindows.length > 0;
                        recoveryExecuteMutation.mutate({
                          dryRun: false,
                          ...(usedCustomWindows ? { customWindows: rerunWindows } : {}),
                        });
                      }}
                      trigger={
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                      data-testid="button-recovery-run-for-real"
                      disabled={!!recoveryPollingJobId || recoveryExecuteMutation.isPending}
                    >
                      {recoveryExecuteMutation.isPending ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <Download className="w-3 h-3 mr-1" />
                      )}
                      Run for real
                    </Button>
                      }
                    />
                  </div>
                )}
              </div>
            )}
            {interruptedByRestart ? (
              <div
                className="text-xs text-amber-800 bg-amber-100/60 border border-amber-200 rounded px-2 py-1.5"
                data-testid="text-recovery-interrupted-banner"
              >
                <div className="font-medium">This run was cut short when the server restarted.</div>
                <div className="text-amber-700 mt-0.5" data-testid="text-recovery-interrupted-totals">{partialSummary}</div>
                {rerunWindows.length > 0 && (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-amber-400 text-amber-900 hover:bg-amber-200"
                      data-testid="button-recovery-rerun-interrupted"
                      disabled={!!recoveryPollingJobId || recoveryExecuteMutation.isPending}
                      onClick={() => recoveryExecuteMutation.mutate({ dryRun: !!recoveryJob.dryRun, customWindows: rerunWindows })}
                    >
                      {recoveryExecuteMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RotateCcw className="w-3 h-3 mr-1" />}
                      Re-run these windows
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              (recoveryJob.humanPartialReason || recoveryJob.statusReason) && (
                <div className="space-y-1" data-testid="text-recovery-status-reason-block">
                  {recoveryJob.humanPartialReason && (
                    <div
                      className={`text-xs rounded px-2 py-1.5 border ${
                        recoveryJob.reasonClassification === "non_transient"
                          ? "text-red-800 bg-red-50 border-red-200"
                          : "text-amber-800 bg-amber-50 border-amber-200"
                      }`}
                      data-testid="text-recovery-human-partial-reason"
                    >
                      <div className="font-medium">{recoveryJob.humanPartialReason}</div>
                      {recoveryJob.reasonClassification === "unknown" &&
                        recoveryJob.partialReason &&
                        recoveryJob.partialReason !== recoveryJob.humanPartialReason && (
                        <div
                          className="text-xs text-muted-foreground font-mono mt-0.5 truncate"
                          title={`Unmapped raw reason: ${recoveryJob.partialReason}`}
                          data-testid="text-recovery-raw-partial-reason"
                        >
                          {recoveryJob.partialReason}
                        </div>
                      )}
                      {recoveryJob.jobId && (() => {
                        const currentJobId = recoveryJob.jobId;
                        const inFlight = !!recoveryPollingJobId || recoveryResumeMutation.isPending;
                        const blockedByUnavailable = !inFlight && !recoveryJob.canManualResume;
                        const tooltipText = recoveryJob.canManualResume
                          ? recoveryJob.reasonClassification === "non_transient"
                            ? "Front is reconnected — resume from the saved checkpoint."
                            : "Continue this recovery from the saved checkpoint."
                          : recoveryJob.reasonClassification === "non_transient"
                            ? "Cannot resume: Front is not connected. Reconnect Front first, then resume."
                            : !recoveryJob.hasResumableCheckpoint
                              ? "Cannot resume: no checkpoint was saved before this run stopped. Use Run again to restart from page 1."
                              : "Cannot resume this recovery.";
                        return (
                        <div className="flex flex-wrap gap-2 mt-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className={`h-7 text-xs ${blockedByUnavailable ? "text-muted-foreground cursor-not-allowed hover:bg-transparent hover:text-muted-foreground" : ""}`}
                            data-testid={blockedByUnavailable ? `button-recovery-resume-current-disabled` : "button-recovery-resume-current"}
                            disabled={inFlight}
                            aria-disabled={blockedByUnavailable || undefined}
                            title={tooltipText}
                            onClick={() => {
                              if (blockedByUnavailable) {
                                showResumeUnavailableToast({
                                  jobId: currentJobId,
                                  status: recoveryJob.status,
                                  description: tooltipText,
                                  runAgainConfirmMessage:
                                    "Re-run these windows from page 1? Any saved checkpoint will be cleared and the windows will start from the beginning.",
                                });
                                return;
                              }
                              recoveryResumeMutation.mutate({ sourceJobId: currentJobId, mode: "resume" });
                            }}
                          >
                            {recoveryResumeMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RotateCcw className="w-3 h-3 mr-1" />}
                            Resume
                          </Button>
                          <ConfirmActionDialog
                            title="Re-run these windows from page 1?"
                            description="Any saved checkpoint will be cleared and the windows will start from the beginning. Already-imported emails are not duplicated."
                            confirmLabel="Run again"
                            testId="dialog-confirm-recovery-run-again-current"
                            onConfirm={() => {
                              recoveryResumeMutation.mutate({ sourceJobId: currentJobId, mode: "run_again" });
                            }}
                            trigger={
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs text-foreground"
                                data-testid="button-recovery-run-again-current"
                                disabled={inFlight}
                                title="Re-run the same windows from page 1 (clears any saved checkpoint)."
                              >
                                <RefreshCw className="w-3 h-3 mr-1" />
                                Run again
                              </Button>
                            }
                          />
                        </div>
                        );
                      })()}
                    </div>
                  )}
                  {!recoveryJob.humanPartialReason && recoveryJob.statusReason && (
                    <div className="text-xs text-muted-foreground" data-testid="text-recovery-status-reason">{recoveryJob.statusReason}</div>
                  )}
                  {(recoveryJob.continuesJobId || (recoveryJob.autoContinueAttempt ?? 0) > 0) && (
                    <div
                      className="text-xs text-muted-foreground"
                      data-testid="text-recovery-lineage-hint"
                      title={recoveryJob.continuesJobId ? `Continues job ${recoveryJob.continuesJobId}` : undefined}
                    >
                      {recoveryJob.continuationType === "auto"
                        ? "Auto-resumed"
                        : recoveryJob.continuationType === "manual"
                          ? "Manually continued"
                          : "Continued"}
                      {recoveryJob.autoContinueAttempt && recoveryJob.autoContinueMaxAttempts
                        ? <> · attempt {recoveryJob.autoContinueAttempt} of {recoveryJob.autoContinueMaxAttempts}</>
                        : null}
                    </div>
                  )}
                </div>
              )
            )}
            {/* Task #2685 — name the lens. These run totals are the
                recovery-run-progress lens ("for a single run, how much did
                THIS run scan/ingest"), a different question from Pipeline
                Health's "is everything fetched drained" and Analytics
                Coverage's "did we fetch everything Front has". Stating it stops
                a single run's "scanned/ingested" reading as a coverage figure. */}
            <p
              className="text-xs font-medium text-indigo-700 mb-1"
              data-testid="text-recovery-run-lens-label"
            >
              Lens {FRONT_CONSOLE_LENSES[3].lens} — {FRONT_CONSOLE_LENSES[3].title}: {FRONT_CONSOLE_LENSES[3].question}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>Pages: <span className="font-medium text-foreground" data-testid="text-recovery-pages">{recoveryJob.totals?.pages ?? 0}</span></span>
              <span>Scanned: <span className="font-medium text-foreground" data-testid="text-recovery-scanned" data-metric-id={getFrontConsoleMetric("front.recovery.scanned").id}>{recoveryJob.totals?.scanned ?? 0}</span></span>
              <span>
                {isDryRunJob ? "Would import" : "Ingested"}:{" "}
                <span
                  className={`font-medium ${isDryRunJob ? "text-blue-700" : "text-emerald-700"}`}
                  data-testid="text-recovery-ingested"
                  data-metric-id={getFrontConsoleMetric("front.recovery.ingested").id}
                >
                  {recoveryJob.totals?.ingested ?? 0}
                </span>
              </span>
              <span>
                {isDryRunJob ? "Would skip" : "Skipped"}:{" "}
                <span className="font-medium text-muted-foreground" data-testid="text-recovery-skipped">
                  {recoveryJob.totals?.skipped ?? 0}
                </span>
              </span>
              <span>Errors: <span className="font-medium text-red-700" data-testid="text-recovery-errors">{recoveryJob.totals?.errors ?? 0}</span></span>
            </div>
            {Array.isArray(recoveryJob.windows) && recoveryJob.windows.length > 0 && (() => {
              const wins: RecoveryJobWindow[] = recoveryJob.windows;
              const floor = Number(recoveryRetryAlert?.consecutive5xxFloor ?? 0) || 0;
              const required = Number(recoveryRetryAlert?.consecutiveWindowCount ?? 0) || 0;
              const front5xxByIdx = wins.map((win) => {
                const r: Record<string, number> = (win?.retriesByReason && typeof win.retriesByReason === "object")
                  ? win.retriesByReason
                  : {};
                return count5xxFromRetries(r);
              });
              const streakByIdx = wins.map((_, i) => {
                if (floor <= 0 || required <= 0) return 0;
                let s = 0;
                for (let j = i; j >= 0; j--) {
                  if (wins[j]?.status === "complete" && front5xxByIdx[j] >= floor) {
                    s++;
                  } else {
                    break;
                  }
                }
                return s;
              });
              return (
              <div className="space-y-1 mt-2">
                {wins.map((w, idx) => (
                  <div key={w.windowLabel} className="flex items-center gap-2 text-xs bg-card rounded border px-2 py-1 flex-wrap" data-testid={`row-recovery-window-${w.windowLabel}`}>
                    <span className="font-mono text-foreground">{w.windowLabel}</span>
                    <Badge variant="outline" className={statusBadgeFor(w.status)}>{w.status}</Badge>
                    <span className="text-muted-foreground">pg {w.pages} · scan {w.scanned} · ing {w.ingested} · skip {w.skipped} · err {w.errors?.length ?? 0}</span>
                    {renderRecoveryWindowResilience(
                      w,
                      recoveryRetryAlert
                        ? { streak: streakByIdx[idx], required, floor }
                        : null,
                      recoveryJob.jobId,
                    )}
                    {(w.humanStatusReason || w.statusReason) && (
                      <span
                        className={`italic truncate ${
                          w.statusReasonClassification === "non_transient"
                            ? "text-red-700"
                            : w.statusReasonClassification === "transient" || w.statusReasonClassification === "checkpoint_required"
                              ? "text-amber-700"
                              : "text-muted-foreground"
                        }`}
                        title={w.statusReason || w.humanStatusReason}
                        data-testid={`text-recovery-window-reason-${w.windowLabel}`}
                      >
                        — {w.humanStatusReason || w.statusReason}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              );
            })()}
          </div>
          );
        })()}
    </>
  );
}
