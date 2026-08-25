// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { AlertTriangle, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import type { IntegrationStatus, RecoveryJobSummary, RecoveryJobSnapshot, RecoveryJobsListResponse, RecoveryClearResponse } from "./types";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import type { RecoveryJobsHook } from "./useRecoveryJobs";
import type { Dispatch, SetStateAction } from "react";

type Props = {
  autohealStatus: { state: "green" | "amber" | "red" | "gray"; paused: boolean };
  recoveryDeleteJobMutation: RecoveryJobsHook["recoveryDeleteJobMutation"];
  recoveryJob: RecoveryJobSnapshot | null;
  recoveryJobsList: RecoveryJobsListResponse | undefined;
  recoveryPollingJobId: string | null;
  recoveryResumeMutation: RecoveryJobsHook["recoveryResumeMutation"];
  refetchRecoveryJobs: RecoveryJobsHook["refetchRecoveryJobs"];
  setRecoveryJob: Dispatch<SetStateAction<RecoveryJobSnapshot | null>>;
  showResumeUnavailableToast: (args: { jobId: string; status?: string; description: string; runAgainConfirmMessage?: string }) => void;
  status: IntegrationStatus | undefined;
  statusBadgeFor: (s: string) => string;
};

export function RecoveryHistorySection({ autohealStatus, recoveryDeleteJobMutation, recoveryJob, recoveryJobsList, recoveryPollingJobId, recoveryResumeMutation, refetchRecoveryJobs, setRecoveryJob, showResumeUnavailableToast, status, statusBadgeFor }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();

  const [recoveryHistoryShowOnlyInterrupted, setRecoveryHistoryShowOnlyInterrupted] = useState(false);

  const recoveryHistoryShowOnlyInterruptedHydratedRef = useRef<string | null>(null);

  const recoveryHistoryShowOnlyInterruptedStorageKey = user?.id
    ? `recoveryHistoryShowOnlyInterrupted:${user.id}`
    : null;

  useEffect(() => {
    if (!recoveryHistoryShowOnlyInterruptedStorageKey) return;
    if (recoveryHistoryShowOnlyInterruptedHydratedRef.current === recoveryHistoryShowOnlyInterruptedStorageKey) return;
    recoveryHistoryShowOnlyInterruptedHydratedRef.current = recoveryHistoryShowOnlyInterruptedStorageKey;
    try {
      const stored = window.localStorage.getItem(recoveryHistoryShowOnlyInterruptedStorageKey);
      if (stored === "true") {
        setRecoveryHistoryShowOnlyInterrupted(true);
      } else if (stored === "false") {
        setRecoveryHistoryShowOnlyInterrupted(false);
      } else {
        setRecoveryHistoryShowOnlyInterrupted(false);
      }
    } catch {}
  }, [recoveryHistoryShowOnlyInterruptedStorageKey]);

  useEffect(() => {
    if (!recoveryHistoryShowOnlyInterruptedStorageKey) return;
    if (recoveryHistoryShowOnlyInterruptedHydratedRef.current !== recoveryHistoryShowOnlyInterruptedStorageKey) return;
    try {
      window.localStorage.setItem(
        recoveryHistoryShowOnlyInterruptedStorageKey,
        String(recoveryHistoryShowOnlyInterrupted),
      );
    } catch {}
  }, [recoveryHistoryShowOnlyInterruptedStorageKey, recoveryHistoryShowOnlyInterrupted]);

  const [recoveryTrendWindowDays, setRecoveryTrendWindowDays] = useState<7 | 14 | 30>(14);

  const recoveryTrendWindowHydratedRef = useRef<string | null>(null);

  const recoveryTrendWindowStorageKey = user?.id
    ? `recoveryTrendWindowDays:${user.id}`
    : null;

  useEffect(() => {
    if (!recoveryTrendWindowStorageKey) return;
    if (recoveryTrendWindowHydratedRef.current === recoveryTrendWindowStorageKey) return;
    recoveryTrendWindowHydratedRef.current = recoveryTrendWindowStorageKey;
    try {
      const stored = window.localStorage.getItem(recoveryTrendWindowStorageKey);
      const parsed = stored != null ? Number(stored) : NaN;
      if (parsed === 7 || parsed === 14 || parsed === 30) {
        setRecoveryTrendWindowDays(parsed);
      } else {
        setRecoveryTrendWindowDays(14);
      }
    } catch {}
  }, [recoveryTrendWindowStorageKey]);

  useEffect(() => {
    if (!recoveryTrendWindowStorageKey) return;
    if (recoveryTrendWindowHydratedRef.current !== recoveryTrendWindowStorageKey) return;
    try {
      window.localStorage.setItem(
        recoveryTrendWindowStorageKey,
        String(recoveryTrendWindowDays),
      );
    } catch {}
  }, [recoveryTrendWindowStorageKey, recoveryTrendWindowDays]);


  const recoveryClearJobsMutation = useMutation<RecoveryClearResponse, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/integrations/front/historical-recovery/jobs");
      return res.json() as Promise<RecoveryClearResponse>;
    },
    onSuccess: (data) => {
      const skippedNote = data?.skipped ? ` (${data.skipped} running job${data.skipped === 1 ? "" : "s"} kept)` : "";
      toast({
        title: "Recovery history cleared",
        description: `Removed ${data?.deleted ?? 0} job${data?.deleted === 1 ? "" : "s"}.${skippedNote}`,
      });
      if (recoveryJob && recoveryJob.status !== "running" && recoveryJob.status !== "queued") {
        setRecoveryJob(null);
      }
      void refetchRecoveryJobs(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      toast({ title: "Clear failed", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  return (
    <>
        {Array.isArray(recoveryJobsList?.jobs) && recoveryJobsList.jobs.length > 0 && (() => {
          const interruptedCount = recoveryJobsList.jobs.filter(
            (j: RecoveryJobSummary) => j.statusReason === "interrupted_by_server_restart",
          ).length;
          const filterActive = recoveryHistoryShowOnlyInterrupted && interruptedCount > 0;
          const visibleJobs = filterActive
            ? recoveryJobsList.jobs.filter(
                (j: RecoveryJobSummary) => j.statusReason === "interrupted_by_server_restart",
              )
            : recoveryJobsList.jobs;
          return (
          <div className="border-t pt-3 space-y-2" data-testid="section-recovery-history">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-xs font-semibold text-foreground">Recovery history</div>
              <Badge variant="outline" className="text-xs" data-testid="badge-recovery-history-count">
                {recoveryJobsList.jobs.length}
              </Badge>
              {interruptedCount > 0 && (
                <Badge
                  variant="outline"
                  className="text-xs bg-amber-100 text-amber-800 border-amber-300 flex items-center gap-1"
                  title={`${interruptedCount} past recovery job${interruptedCount === 1 ? " was" : "s were"} cut short by a server restart.`}
                  data-testid="badge-recovery-history-interrupted-count"
                >
                  <AlertTriangle className="w-3 h-3" />
                  {interruptedCount} interrupted by restart
                </Badge>
              )}
              {interruptedCount > 0 && (
                <label
                  className="flex items-center gap-1 text-xs text-foreground cursor-pointer select-none"
                  title="Filter the list to only show jobs that were cut short by a server restart."
                >
                  <input
                    type="checkbox"
                    className="rounded border-border"
                    checked={recoveryHistoryShowOnlyInterrupted}
                    onChange={(e) => setRecoveryHistoryShowOnlyInterrupted(e.target.checked)}
                    data-testid="checkbox-recovery-history-only-interrupted"
                  />
                  Show only interrupted
                </label>
              )}
              <ConfirmActionDialog
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50"
                    data-testid="button-recovery-clear-history"
                    disabled={recoveryClearJobsMutation.isPending}
                  >
                    <Trash2 className="w-3 h-3 mr-1" />
                    Clear history
                  </Button>
                }
                title={`Clear all ${recoveryJobsList.jobs.length} recovery job${recoveryJobsList.jobs.length === 1 ? "" : "s"} from history?`}
                description="Any running jobs will be kept, but every finished job record — including checkpoints for partial jobs — is removed. This cannot be undone."
                confirmLabel="Clear history"
                onConfirm={() => recoveryClearJobsMutation.mutate()}
                testId="dialog-recovery-clear-history"
              />
            </div>
            {(() => {
              const DAYS = recoveryTrendWindowDays;
              const now = new Date();
              const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
              const dayMs = 24 * 60 * 60 * 1000;
              const buckets: Array<{ dayStart: number; completed: number; interrupted: number; other: number }> = [];
              for (let i = DAYS - 1; i >= 0; i--) {
                buckets.push({ dayStart: startOfToday - i * dayMs, completed: 0, interrupted: 0, other: 0 });
              }
              const earliest = buckets[0].dayStart;
              const latest = buckets[buckets.length - 1].dayStart + dayMs;
              for (const j of recoveryJobsList.jobs as RecoveryJobSummary[]) {
                if (j.status === "running" || j.status === "queued") continue;
                const ref = j.completedAt ?? j.startedAt;
                if (!ref) continue;
                const t = new Date(ref).getTime();
                if (Number.isNaN(t) || t < earliest || t >= latest) continue;
                const idx = Math.floor((t - earliest) / dayMs);
                const bucket = buckets[idx];
                if (!bucket) continue;
                if (j.statusReason === "interrupted_by_server_restart") bucket.interrupted += 1;
                else if (j.status === "complete") bucket.completed += 1;
                else bucket.other += 1;
              }
              const totalCompleted = buckets.reduce((s, b) => s + b.completed, 0);
              const totalInterrupted = buckets.reduce((s, b) => s + b.interrupted, 0);
              const totalOther = buckets.reduce((s, b) => s + b.other, 0);
              const totalShown = totalCompleted + totalInterrupted + totalOther;
              const maxPerDay = Math.max(1, ...buckets.map((b) => b.completed + b.interrupted + b.other));
              const barAreaHeight = 40;
              return (
                <div
                  className="rounded border border-border bg-muted/50 p-2"
                  data-testid="chart-recovery-history-trend"
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-medium text-foreground">
                        Last {DAYS} days
                      </div>
                      <div
                        className="inline-flex rounded border border-border overflow-hidden"
                        role="group"
                        aria-label="Trend window"
                        data-testid="group-recovery-trend-window"
                      >
                        {([7, 14, 30] as const).map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setRecoveryTrendWindowDays(d)}
                            className={`px-1.5 py-0.5 text-xs leading-none ${
                              recoveryTrendWindowDays === d
                                ? "bg-gray-700 text-white"
                                : "bg-card text-foreground hover:bg-muted"
                            }`}
                            aria-pressed={recoveryTrendWindowDays === d}
                            data-testid={`button-recovery-trend-window-${d}`}
                          >
                            {d}d
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1" data-testid="legend-recovery-trend-completed">
                        <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500" />
                        Completed {totalCompleted}
                      </span>
                      <span className="flex items-center gap-1" data-testid="legend-recovery-trend-interrupted">
                        <span className="inline-block w-2 h-2 rounded-sm bg-amber-500" />
                        Interrupted {totalInterrupted}
                      </span>
                      {totalOther > 0 && (
                        <span className="flex items-center gap-1" data-testid="legend-recovery-trend-other">
                          <span className="inline-block w-2 h-2 rounded-sm bg-gray-400" />
                          Other {totalOther}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-end gap-0.5" style={{ height: barAreaHeight }}>
                    {buckets.map((b) => {
                      const total = b.completed + b.interrupted + b.other;
                      const heightPct = total === 0 ? 0 : Math.max(6, Math.round((total / maxPerDay) * 100));
                      const completedPct = total > 0 ? (b.completed / total) * 100 : 0;
                      const interruptedPct = total > 0 ? (b.interrupted / total) * 100 : 0;
                      const otherPct = total > 0 ? (b.other / total) * 100 : 0;
                      const dayDate = new Date(b.dayStart);
                      const dayKey = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, "0")}-${String(dayDate.getDate()).padStart(2, "0")}`;
                      return (
                        <div
                          key={b.dayStart}
                          className="flex-1 min-w-[6px] flex flex-col justify-end"
                          title={`${dayKey}: ${total} job${total === 1 ? "" : "s"} (completed ${b.completed}, interrupted ${b.interrupted}, other ${b.other})`}
                          data-testid={`bar-recovery-trend-${dayKey}`}
                        >
                          {total > 0 ? (
                            <div className="w-full rounded-t overflow-hidden flex flex-col" style={{ height: `${heightPct}%` }}>
                              {b.completed > 0 && <div className="w-full bg-emerald-500" style={{ height: `${completedPct}%` }} />}
                              {b.interrupted > 0 && <div className="w-full bg-amber-500" style={{ height: `${interruptedPct}%` }} />}
                              {b.other > 0 && <div className="w-full bg-gray-400" style={{ height: `${otherPct}%` }} />}
                            </div>
                          ) : (
                            <div className="w-full bg-muted rounded-t" style={{ height: 2 }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between mt-1 text-xs text-muted-foreground">
                    <span data-testid="text-recovery-trend-start-date">
                      {new Date(earliest).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                    <span>{totalShown} job{totalShown === 1 ? "" : "s"} in this window</span>
                    <span data-testid="text-recovery-trend-end-date">
                      {new Date(latest - dayMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  </div>
                </div>
              );
            })()}
            <div className="space-y-1">
              {visibleJobs.map((j: RecoveryJobSummary) => {
                const isRunning = j.status === "running" || j.status === "queued";
                const interruptedByRestart = j.statusReason === "interrupted_by_server_restart";
                const partialSummary = `Captured before restart — pages ${j.totals?.pages ?? 0}, scanned ${j.totals?.scanned ?? 0}, ingested ${j.totals?.ingested ?? 0}, skipped ${j.totals?.skipped ?? 0}, errors ${j.totals?.errors ?? 0}.`;
                const isSelected = recoveryJob?.jobId === j.jobId;
                const isAutoContinued = (j.autoContinueAttempt ?? 0) > 0 || j.continuationType === "auto";
                const isCurrentlyAutoResuming = isRunning && j.continuationType === "auto";
                // Status-signal rail — official --status-* tokens (Task #4492;
                // side-tab accent consolidation follow-up). Non-Card row keeps
                // its 4px width; "gray" is a neutral no-signal state and stays
                // on the neutral palette (the kit has no gray status accent).
                const accentBase = autohealStatus.state === "green" ? "border-l-status-ok"
                  : autohealStatus.state === "amber" ? "border-l-status-warn"
                  : autohealStatus.state === "red" ? "border-l-status-critical"
                  : "border-l-gray-400";
                const accentClass = isAutoContinued
                  ? `border-l-4 ${accentBase} ${isCurrentlyAutoResuming ? "animate-pulse" : ""}`
                  : "";
                return (
                  <div
                    key={j.jobId}
                    className={`flex items-center gap-2 text-xs bg-card rounded border px-2 py-1 cursor-pointer hover:bg-muted/50 ${
                      isSelected ? "border-blue-300 ring-1 ring-blue-200" : ""
                    } ${interruptedByRestart ? "border-amber-300" : ""} ${accentClass}`}
                    data-testid={`row-recovery-history-${j.jobId}`}
                    data-auto-continued={isAutoContinued ? "true" : undefined}
                    data-auto-resuming={isCurrentlyAutoResuming ? "true" : undefined}
                    role="button"
                    tabIndex={0}
                    onClick={() => setRecoveryJob(j)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setRecoveryJob(j);
                      }
                    }}
                    title="Click to view details"
                  >
                    <span className="font-mono text-foreground truncate" title={j.jobId}>{j.jobId}</span>
                    <Badge variant="outline" className={statusBadgeFor(j.status)}>{j.status}</Badge>
                    {j.dryRun && <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">dry</Badge>}
                    {interruptedByRestart && (
                      <Badge
                        variant="outline"
                        className="bg-amber-100 text-amber-800 border-amber-300 flex items-center gap-1"
                        title={partialSummary}
                        data-testid={`badge-recovery-history-interrupted-${j.jobId}`}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        Interrupted by restart
                      </Badge>
                    )}
                    <span className="text-muted-foreground truncate">
                      {new Date(j.startedAt).toLocaleString()} · scan {j.totals?.scanned ?? 0} · ing {j.totals?.ingested ?? 0}
                    </span>
                    {j.humanPartialReason && (
                      <span
                        className={`text-xs truncate max-w-[180px] ${
                          j.reasonClassification === "non_transient" ? "text-red-700" : "text-amber-700"
                        }`}
                        title={j.humanPartialReason}
                        data-testid={`text-recovery-history-reason-${j.jobId}`}
                      >
                        {j.humanPartialReason}
                      </span>
                    )}
                    {(j.continuationType === "auto" || (j.autoContinueAttempt ?? 0) > 0) && (
                      <Badge
                        variant="outline"
                        className="bg-muted text-foreground border-border text-xs"
                        title={`Auto-continued${j.continuesJobId ? ` from ${j.continuesJobId}` : ""}${
                          j.autoContinueAttempt && j.autoContinueMaxAttempts
                            ? ` · attempt ${j.autoContinueAttempt}/${j.autoContinueMaxAttempts}`
                            : ""
                        }`}
                        data-testid={`badge-recovery-history-auto-${j.jobId}`}
                      >
                        auto-continued{j.autoContinueAttempt ? ` ${j.autoContinueAttempt}` : ""}
                      </Badge>
                    )}
                    <div className="ml-auto flex items-center gap-0.5">
                      {(j.status === "partial" || j.status === "blocked" || j.status === "failed") && !isRunning && (() => {
                        const inFlight = !!recoveryPollingJobId || recoveryResumeMutation.isPending;
                        const blockedByUnavailable = !inFlight && !j.canManualResume;
                        const tooltipText = j.canManualResume
                          ? j.reasonClassification === "non_transient"
                            ? "Front is reconnected — resume from the saved checkpoint"
                            : "Continue this recovery from the saved checkpoint"
                          : j.reasonClassification === "non_transient"
                            ? "Cannot resume: Front is not connected. Reconnect Front first, then resume."
                            : !j.hasResumableCheckpoint
                              ? "Cannot resume: no checkpoint was saved. Use Run again to restart from page 1."
                              : "Cannot resume this recovery.";
                        return (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={`h-6 px-1.5 text-xs ${blockedByUnavailable ? "text-muted-foreground cursor-not-allowed hover:bg-transparent hover:text-muted-foreground" : "text-blue-700 hover:bg-blue-50"}`}
                            data-testid={blockedByUnavailable ? `button-recovery-history-resume-disabled-${j.jobId}` : `button-recovery-history-resume-${j.jobId}`}
                            disabled={inFlight}
                            aria-disabled={blockedByUnavailable || undefined}
                            title={tooltipText}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (blockedByUnavailable) {
                                showResumeUnavailableToast({
                                  jobId: j.jobId,
                                  status: j.status,
                                  description: tooltipText,
                                });
                                return;
                              }
                              recoveryResumeMutation.mutate({ sourceJobId: j.jobId, mode: "resume" });
                            }}
                          >
                            <RotateCcw className="w-3 h-3 mr-1" />Resume
                          </Button>
                          <ConfirmActionDialog
                            trigger={
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1.5 text-xs text-foreground hover:bg-muted"
                                data-testid={`button-recovery-history-run-again-${j.jobId}`}
                                disabled={!!recoveryPollingJobId || recoveryResumeMutation.isPending}
                                title="Re-run these windows from page 1 (clears any saved checkpoint)"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <RefreshCw className="w-3 h-3 mr-1" />Run again
                              </Button>
                            }
                            title={`Re-run recovery ${j.jobId} from page 1?`}
                            description="This re-runs the job's windows from scratch. Any saved checkpoint will be cleared, so progress from the previous attempt is discarded and all pages are fetched again."
                            confirmLabel="Run again"
                            onConfirm={() => recoveryResumeMutation.mutate({ sourceJobId: j.jobId, mode: "run_again" })}
                            testId={`dialog-recovery-history-run-again-${j.jobId}`}
                          />
                        </>
                        );
                      })()}
                      <ConfirmActionDialog
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 disabled:opacity-40"
                            data-testid={`button-recovery-delete-${j.jobId}`}
                            disabled={isRunning || recoveryDeleteJobMutation.isPending}
                            title={isRunning ? "Cannot delete a running job" : "Delete this job"}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        }
                        title={`Delete recovery job ${j.jobId} from history?`}
                        description="This removes the job record and any saved checkpoint, so it can no longer be resumed or re-run from here. This cannot be undone."
                        confirmLabel="Delete"
                        onConfirm={() => recoveryDeleteJobMutation.mutate(j.jobId)}
                        testId={`dialog-recovery-delete-${j.jobId}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          );
        })()}
    </>
  );
}
