// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { apiRequest } from "@/lib/queryClient";
import type { CoverageReport, IntegrationStatus, RecoveryExecuteResponse, RecoveryJobsListResponse, RecoveryJobSnapshot } from "./types";

/**
 * Precise return type of {@link useRecoveryJobs}. Section components type
 * their mutation/refetch props via indexed access (e.g.
 * `RecoveryJobsHook["recoveryExecuteMutation"]`) so payload/result misuse
 * is a compile error, matching the pre-split inferred generics.
 */
export type RecoveryJobsHook = ReturnType<typeof useRecoveryJobs>;

export function useRecoveryJobs({ isAdmin, status }: {
  isAdmin: boolean;
  status: IntegrationStatus | undefined;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isTabVisible = useTabVisibility();


  const [recoveryPollingJobId, setRecoveryPollingJobId] = useState<string | null>(null);

  const [recoveryJob, setRecoveryJob] = useState<RecoveryJobSnapshot | null>(null);


  const { data: coverageReport, refetch: refetchCoverage, isFetching: coverageLoading } = useQuery<CoverageReport>({
    queryKey: ["/api/integrations/front/historical-recovery/coverage"],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: recoveryPollingJobId && isTabVisible ? 15000 : false,
    refetchIntervalInBackground: false,
  });


  // Task #2481 — the Front coverage floor is a hard-coded constant
  // (FRONT_ADOPTION_DATE = 2025-07-01) with no API or UI way to change it.
  // The operator override input/button/mutation (Task #1656) was removed;
  // the floor is now surfaced read-only on the dashboard headline.

  const { data: recoveryJobsList, refetch: refetchRecoveryJobs } = useQuery<RecoveryJobsListResponse>({
    queryKey: ["/api/integrations/front/historical-recovery/jobs"],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: isTabVisible ? (recoveryPollingJobId ? 10000 : 30000) : false,
    refetchIntervalInBackground: false,
  });


  useEffect(() => {
    if (!recoveryPollingJobId) return;
    let failures = 0;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/integrations/front/historical-recovery/status/${recoveryPollingJobId}`, { credentials: "include" });
        if (!res.ok) {
          failures++;
          if (failures >= 3) { setRecoveryPollingJobId(null); }
          return;
        }
        failures = 0;
        const job = await res.json();
        setRecoveryJob(job);
        const TERMINAL = new Set(["complete", "partial", "blocked", "failed"]);
        if (TERMINAL.has(job.status)) {
          setRecoveryPollingJobId(null);
          void refetchCoverage(); // fire-and-forget: refetch only
          void refetchRecoveryJobs(); // fire-and-forget: refetch only
          const isDry = !!job.dryRun;
          const titleByStatus: Record<string, string> = isDry
            ? {
                complete: "Dry run complete",
                partial: "Dry run partial",
                blocked: "Dry run blocked",
                failed: "Dry run failed",
              }
            : {
                complete: "Recovery complete",
                partial: "Recovery partial",
                blocked: "Recovery blocked",
                failed: "Recovery failed",
              };
          const variant: "default" | "destructive" = job.status === "complete"
            ? "default"
            : isDry && job.status !== "failed"
              ? "default"
              : "destructive";
          const scanned = job.totals?.scanned ?? 0;
          const ingested = job.totals?.ingested ?? 0;
          const skipped = job.totals?.skipped ?? 0;
          const windowCount = job.windows?.length ?? 0;
          let desc: string;
          if (isDry) {
            const verbedClause = `Scanned ${scanned} email${scanned === 1 ? "" : "s"}. Would import ${ingested}, would skip ${skipped} across ${windowCount} window${windowCount === 1 ? "" : "s"}.`;
            const cta = job.status === "complete" && ingested > 0
              ? " Nothing was imported yet — see the Recovery panel below to run for real."
              : job.status === "complete"
                ? " Nothing was imported yet (no missing emails found in this range)."
                : " Nothing was imported yet — results above show what was previewed before the run stopped.";
            desc = job.statusReason ? `${verbedClause}${cta} ${job.statusReason}` : `${verbedClause}${cta}`;
          } else {
            desc = job.statusReason
              ? `${scanned} scanned, ${ingested} ingested across ${windowCount} window(s). ${job.statusReason}`
              : `${scanned} scanned, ${ingested} ingested across ${windowCount} window(s).`;
          }
          toast({
            title: titleByStatus[job.status as string] ?? `Recovery ${job.status}`,
            description: desc,
            variant,
            duration: isDry ? 12000 : 5000,
          });
        }
      } catch {
        failures++;
        if (failures >= 3) { setRecoveryPollingJobId(null); }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [recoveryPollingJobId, toast, refetchCoverage, refetchRecoveryJobs]);


  const recoveryDeleteJobMutation = useMutation<unknown, Error, string>({
    mutationFn: async (jobId: string) => {
      const res = await apiRequest("DELETE", `/api/integrations/front/historical-recovery/jobs/${jobId}`);
      return res.json();
    },
    onSuccess: (_data, jobId) => {
      toast({ title: "Recovery job deleted", description: `Removed job ${jobId} from history.` });
      if (recoveryJob?.jobId === jobId) setRecoveryJob(null);
      void refetchRecoveryJobs(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      const msg = err.message?.includes("409")
        ? "Cannot delete a recovery job that is still running."
        : err.message;
      toast({ title: "Delete failed", description: msg, variant: "destructive" });
    },
    meta: { silent: true },
  });


  // Task #989: Resume / Run again mutation. mode="resume" preserves the
  // saved per-window cursor; mode="run_again" clears it so windows
  // restart from page 1.
  const recoveryResumeMutation = useMutation<
    {
      ok: boolean;
      success?: boolean;
      jobId: string;
      sourceJobId: string;
      mode: "resume" | "run_again";
      continuesJobId?: string;
      continuationType?: "manual" | "auto";
      windows: number;
    },
    Error,
    { sourceJobId: string; mode: "resume" | "run_again" }
  >({
    mutationFn: async ({ sourceJobId, mode }) => {
      const res = await apiRequest("POST", `/api/integrations/front/historical-recovery/${sourceJobId}/resume`, { mode });
      return res.json();
    },
    onSuccess: (data) => {
      setRecoveryPollingJobId(data.jobId);
      setRecoveryJob({
        jobId: data.jobId,
        status: "running",
        windows: [],
        totals: { scanned: 0, ingested: 0, skipped: 0, errors: 0, pages: 0 },
        continuesJobId: data.sourceJobId,
        continuationType: "manual",
      });
      toast({
        title: data.mode === "resume" ? "Resume started" : "Re-run started",
        description: data.mode === "resume"
          ? `Picking up partial recovery ${data.sourceJobId} from saved checkpoint.`
          : `Re-running ${data.windows} window(s) from scratch (saved cursors cleared).`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/jobs"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      const msg = err.message?.includes("409") || err.message?.includes("already running") || err.message?.includes("still active")
        ? "A recovery job is already running. Please wait for it to finish."
        : err.message?.includes("400") || err.message?.includes("not resumable")
        ? "This recovery job cannot be resumed (no checkpoint or non-transient failure). Try Run again instead."
        : err.message;
      toast({ title: "Resume failed", description: msg, variant: "destructive" });
    },
    meta: { silent: true },
  });


  // Task #1628 — surface why Resume is disabled. The on-row tooltip
  // already explains the reason on hover, but operators commonly miss
  // it and report "Resume does nothing". When the disabled-styled
  // Resume is clicked we fire a toast with the same wording and, when
  // applicable, a one-click "Run again instead" path that mirrors the
  // existing Run-again button (including the confirm prompt).
  // Task #4589 — the toast's "Run again instead" action confirms via the
  // shared ConfirmActionDialog (controlled mode; the toast dismisses when
  // its action is clicked, so the dialog is rendered by the panel instead).
  const [runAgainConfirm, setRunAgainConfirm] = useState<{ jobId: string; message: string } | null>(null);

  const showResumeUnavailableToast = (args: {
    jobId: string;
    status?: string;
    description: string;
    runAgainConfirmMessage?: string;
  }) => {
    const runAgainAllowed =
      args.status === "partial" || args.status === "blocked" || args.status === "failed";
    const confirmMessage =
      args.runAgainConfirmMessage ??
      "This re-runs the job's windows from scratch. Any saved checkpoint will be cleared, so progress from the previous attempt is discarded and all pages are fetched again.";
    toast({
      title: "Resume unavailable",
      description: args.description,
      action: runAgainAllowed ? (
        <ToastAction
          altText="Run again instead"
          data-testid={`toast-action-recovery-run-again-${args.jobId}`}
          onClick={() => setRunAgainConfirm({ jobId: args.jobId, message: confirmMessage })}
        >
          Run again instead
        </ToastAction>
      ) : undefined,
    });
  };

  /**
   * Confirmation dialog for the toast's "Run again instead" action. The
   * composing panel must render this node (controlled ConfirmActionDialog).
   */
  const resumeRunAgainConfirmDialog = (
    <ConfirmActionDialog
      open={runAgainConfirm != null}
      onOpenChange={(open) => { if (!open) setRunAgainConfirm(null); }}
      title={`Re-run recovery ${runAgainConfirm?.jobId ?? ""} from page 1?`}
      description={runAgainConfirm?.message ?? ""}
      confirmLabel="Run again"
      onConfirm={() => {
        if (runAgainConfirm) {
          recoveryResumeMutation.mutate({ sourceJobId: runAgainConfirm.jobId, mode: "run_again" });
        }
        setRunAgainConfirm(null);
      }}
      testId="dialog-recovery-toast-run-again"
    />
  );


  const recoveryExecuteMutation = useMutation({
    mutationFn: async (opts: { dryRun: boolean; customWindows?: Array<{ label: string; afterTimestamp: number; beforeTimestamp: number }> }) => {
      type RecoveryExecuteBody = {
        dryRun: boolean;
        customWindows?: Array<{ label: string; afterTimestamp: number; beforeTimestamp: number }>;
      };
      const body: RecoveryExecuteBody = { dryRun: opts.dryRun };
      if (opts.customWindows && opts.customWindows.length > 0) body.customWindows = opts.customWindows;
      const res = await apiRequest("POST", "/api/integrations/front/historical-recovery/execute", body);
      return res.json() as Promise<RecoveryExecuteResponse>;
    },
    onSuccess: (data, variables) => {
      if (data.jobId) {
        setRecoveryPollingJobId(data.jobId);
        setRecoveryJob({ jobId: data.jobId, status: "running", dryRun: variables.dryRun, windows: [], totals: { scanned: 0, ingested: 0, skipped: 0, errors: 0, pages: 0 } });
        const isCustom = !!(variables.customWindows && variables.customWindows.length > 0);
        toast({
          title: variables.dryRun ? "Dry run started" : isCustom ? "Custom range recovery started" : "Historical recovery started",
          description: isCustom
            ? "Recovering the requested Front date range. Live progress will appear below."
            : "Recovering missing Front history. Live progress will appear below.",
        });
      }
    },
    onError: (err: Error) => {
      const msg = err.message?.includes("409") || err.message?.includes("already running")
        ? "A recovery job is already running. Please wait for it to finish."
        : err.message;
      toast({ title: "Recovery failed to start", description: msg, variant: "destructive" });
    },
    meta: { silent: true },
  });

  const recoveryRunning = !!recoveryPollingJobId;

  const statusBadgeFor = (s: string) => {
    switch (s) {
      case "complete": return "bg-green-50 text-green-700 border-green-200";
      case "partial": return "bg-amber-50 text-amber-800 border-amber-200";
      case "blocked": return "bg-red-50 text-red-700 border-red-200";
      case "failed": return "bg-red-100 text-red-800 border-red-300";
      case "running": return "bg-blue-50 text-blue-700 border-blue-200";
      case "queued": return "bg-slate-100 text-slate-700 border-slate-200";
      case "empty_source": return "bg-gray-100 text-gray-600 border-gray-200";
      default: return "bg-gray-50 text-gray-600 border-gray-200";
    }
  };

  return {
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
  };
}
