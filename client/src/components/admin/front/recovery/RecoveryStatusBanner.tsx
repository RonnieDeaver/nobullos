// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Input } from "@/components/ui/input";
import { LastEditedBadge } from "@/components/LastEditedBadge";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ArrowRight, ChevronDown, ChevronUp, Loader2, RotateCcw } from "lucide-react";
import type { IntegrationStatus, RecoveryJobsListResponse, RecoverySweepStatusResponse, RecoveryAutoContinueResponse, RecoverySettingHistoryEntry } from "./types";
import type { QueryObserverResult, RefetchOptions } from "@tanstack/react-query";

type Props = {
  autohealNowMs: number;
  autohealStatus: { state: "green" | "amber" | "red" | "gray"; paused: boolean };
  isAdmin: boolean;
  recoveryAutoContinue: RecoveryAutoContinueResponse | undefined;
  recoveryJobsList: RecoveryJobsListResponse | undefined;
  recoverySweepStatus: RecoverySweepStatusResponse | undefined;
  refetchRecoveryAutoContinue: (options?: RefetchOptions) => Promise<QueryObserverResult<RecoveryAutoContinueResponse, Error>>;
  status: IntegrationStatus | undefined;
};

export function RecoveryStatusBanner({ autohealNowMs, autohealStatus, isAdmin, recoveryAutoContinue, recoveryJobsList, recoverySweepStatus, refetchRecoveryAutoContinue, status }: Props) {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [autohealExpandedOverride, setAutohealExpandedOverride] = useState<boolean | null>(null);


  const recoveryRunSweepMutation = useMutation<
    { ran: boolean; prunedCount: number; lastSweepAt: string | null; lastError: string | null },
    Error,
    void
  >({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/front/historical-recovery/run-sweep", {});
      return res.json();
    },
    onSuccess: (data) => {
      if (data.lastError) {
        toast({
          title: "Sweep finished with errors",
          description: data.lastError,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Prune sweep complete",
          description: data.prunedCount > 0
            ? `Pruned ${data.prunedCount} expired job${data.prunedCount === 1 ? "" : "s"}.`
            : "No expired jobs to prune.",
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/sweep-status"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/jobs"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/manual-sweep-history"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Failed to run prune sweep", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  const [recoveryAutoContinueDraft, setRecoveryAutoContinueDraft] = useState<string>("");

  useEffect(() => {
    if (recoveryAutoContinue?.maxAttempts != null) {
      setRecoveryAutoContinueDraft(String(recoveryAutoContinue.maxAttempts));
    }
  }, [recoveryAutoContinue?.maxAttempts]);

  const [recoveryAutoContinueHistoryOpen, setRecoveryAutoContinueHistoryOpen] = useState(false);

  const { data: recoveryAutoContinueHistoryData } = useQuery<{ history: RecoverySettingHistoryEntry[] }>({
    queryKey: ["/api/integrations/front/historical-recovery/auto-continue-max-attempts/history"],
    enabled: isAdmin && !!status?.front.connected && recoveryAutoContinueHistoryOpen,
    refetchInterval: recoveryAutoContinueHistoryOpen && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const recoveryAutoContinueHistory = recoveryAutoContinueHistoryData?.history ?? [];


  const recoveryAutoContinueMutation = useMutation<{ maxAttempts: number }, Error, number>({
    mutationFn: async (maxAttempts: number) => {
      const res = await apiRequest("PUT", "/api/integrations/front/historical-recovery/auto-continue-max-attempts", { maxAttempts });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Auto-continue cap updated",
        description: `Background sweep will auto-resume at most ${data.maxAttempts} time${data.maxAttempts === 1 ? "" : "s"} per partial recovery lineage.`,
      });
      void refetchRecoveryAutoContinue(); // fire-and-forget: refetch only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/auto-continue-max-attempts/history"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update auto-continue cap", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });


  const renderAutoContinueCap = () => {
    if (!recoveryAutoContinue) return null;
    return (
      <div className="flex items-center gap-2 flex-wrap pt-1" data-testid="section-recovery-auto-continue">
        <div className="text-xs font-semibold text-foreground">Auto-continue partial recoveries up to</div>
        <Input
          type="number"
          min={recoveryAutoContinue.minAttempts}
          max={recoveryAutoContinue.maxAttemptsAllowed}
          step={1}
          value={recoveryAutoContinueDraft}
          onChange={(e) => setRecoveryAutoContinueDraft(e.target.value)}
          className="h-7 w-20 text-xs"
          data-testid="input-recovery-auto-continue-attempts"
        />
        <span className="text-xs text-muted-foreground">attempts</span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          data-testid="button-recovery-auto-continue-save"
          disabled={
            recoveryAutoContinueMutation.isPending ||
            recoveryAutoContinueDraft === "" ||
            Number(recoveryAutoContinueDraft) === recoveryAutoContinue.maxAttempts ||
            !Number.isInteger(Number(recoveryAutoContinueDraft)) ||
            Number(recoveryAutoContinueDraft) < recoveryAutoContinue.minAttempts ||
            Number(recoveryAutoContinueDraft) > recoveryAutoContinue.maxAttemptsAllowed
          }
          onClick={() => recoveryAutoContinueMutation.mutate(Number(recoveryAutoContinueDraft))}
        >
          Save
        </Button>
        {recoveryAutoContinue.maxAttempts !== recoveryAutoContinue.defaultAttempts && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            data-testid="button-recovery-auto-continue-reset"
            disabled={recoveryAutoContinueMutation.isPending}
            onClick={() => recoveryAutoContinueMutation.mutate(recoveryAutoContinue.defaultAttempts)}
          >
            Reset to {recoveryAutoContinue.defaultAttempts}
          </Button>
        )}
        <span className="text-xs text-muted-foreground" data-testid="text-recovery-auto-continue-help">
          Per partial-recovery lineage. Range: {recoveryAutoContinue.minAttempts}–{recoveryAutoContinue.maxAttemptsAllowed} (default {recoveryAutoContinue.defaultAttempts}).
        </span>
        <div className="basis-full flex items-center gap-2 flex-wrap">
          <LastEditedBadge
            info={recoveryAutoContinue.lastEdited}
            testId="last-edited-recovery-auto-continue"
            emptyText="Using default — never overridden"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs text-muted-foreground"
            onClick={() => setRecoveryAutoContinueHistoryOpen((v) => !v)}
            data-testid="button-recovery-auto-continue-history-toggle"
          >
            {recoveryAutoContinueHistoryOpen ? (
              <>
                <ChevronUp className="w-3 h-3 mr-1" />
                Hide history
              </>
            ) : (
              <>
                <ChevronDown className="w-3 h-3 mr-1" />
                Show history
              </>
            )}
          </Button>
        </div>
        {recoveryAutoContinueHistoryOpen && (
          <div className="basis-full border rounded bg-muted/50 px-2.5 py-2 mt-1" data-testid="recovery-auto-continue-history">
            <h6 className="text-xs font-semibold text-foreground mb-1">Recent changes (last {recoveryAutoContinueHistory.length || 5})</h6>
            {recoveryAutoContinueHistory.length === 0 ? (
              <div className="text-xs text-muted-foreground" data-testid="text-recovery-auto-continue-history-empty">
                No changes recorded yet.
              </div>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {recoveryAutoContinueHistory.map((entry) => {
                  const who = formatEditorAttribution(entry);
                  const oldV = entry.oldValues?.maxAttempts ?? null;
                  const newV = entry.newValues?.maxAttempts ?? null;
                  const canRevert =
                    isAdmin &&
                    oldV != null &&
                    Number.isInteger(oldV) &&
                    oldV >= recoveryAutoContinue.minAttempts &&
                    oldV <= recoveryAutoContinue.maxAttemptsAllowed &&
                    oldV !== recoveryAutoContinue.maxAttempts;
                  return (
                    <div
                      key={entry.id}
                      className="bg-card rounded px-2 py-1 text-xs border"
                      data-testid={`recovery-auto-continue-history-${entry.id}`}
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="font-medium text-foreground">{who}</span>
                        <span className="text-muted-foreground">{new Date(entry.changedAt).toLocaleString()}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-foreground line-through">{oldV != null ? `${oldV}` : "—"}</span>
                        <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                        <span className="font-semibold text-foreground">{newV != null ? `${newV}` : "—"}</span>
                        {isAdmin && (
                          <ConfirmActionDialog
                            trigger={
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-5 ml-auto px-1.5 text-xs text-muted-foreground"
                                data-testid={`button-rac-history-revert-${entry.id}`}
                                disabled={!canRevert || recoveryAutoContinueMutation.isPending}
                                title={
                                  oldV == null
                                    ? "No previous value to revert to"
                                    : oldV === recoveryAutoContinue.maxAttempts
                                      ? `Already set to ${oldV}`
                                      : oldV < recoveryAutoContinue.minAttempts || oldV > recoveryAutoContinue.maxAttemptsAllowed
                                        ? `Out of allowed range (${recoveryAutoContinue.minAttempts}–${recoveryAutoContinue.maxAttemptsAllowed})`
                                        : `Revert to ${oldV} attempt${oldV === 1 ? "" : "s"}`
                                }
                              >
                                <RotateCcw className="w-2.5 h-2.5 mr-0.5" />
                                Revert
                              </Button>
                            }
                            title="Revert auto-continue cap?"
                            description={`This changes how many times a partial recovery is auto-continued before giving up: ${recoveryAutoContinue.maxAttempts} → ${oldV}. A lower cap can leave partial recoveries un-finished sooner; jobs already at the new cap will stop auto-continuing.`}
                            confirmLabel="Revert"
                            onConfirm={() => {
                              if (!canRevert || oldV == null) return;
                              recoveryAutoContinueMutation.mutate(oldV);
                            }}
                            testId={`dialog-rac-history-revert-${entry.id}`}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };


  return (
    <>
        {(() => {
          const ss = recoverySweepStatus;
          const ac = recoveryAutoContinue;
          const jobs = recoveryJobsList?.jobs ?? [];
          const now = autohealNowMs;
          const running = !!ss?.running;
          const intervalMs = ss?.intervalMs ?? 0;
          const lastSweepMs = ss?.lastSweepAt ? new Date(ss.lastSweepAt).getTime() : null;
          const nextSweepMs = running && lastSweepMs != null && intervalMs > 0
            ? lastSweepMs + intervalMs
            : null;
          const sweepStale = running && lastSweepMs != null && intervalMs > 0
            && (now - lastSweepMs) > 2 * intervalMs;

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
          const autoResumingIds = jobs
            .filter(j => (j.status === "running" || j.status === "queued") && j.continuationType === "auto")
            .map(j => j.jobId);

          const paused = !!ss?.paused;
          const pauseReasons = ss?.pauseReasons ?? [];
          const bannerState = autohealStatus.state;
          const autohealExpanded = autohealExpandedOverride ?? (bannerState !== "green");

          const stateLabel = bannerState === "green" ? "Healthy"
            : bannerState === "amber" ? (paused ? "Paused" : "Degraded")
            : bannerState === "red" ? "Attention needed"
            : "Sweep off";

          const hitCapCount = jobs.filter(j =>
            (j.autoContinueAttempt ?? 0) > 0
            && (j.autoContinueMaxAttempts ?? 0) > 0
            && (j.autoContinueAttempt ?? 0) >= (j.autoContinueMaxAttempts ?? 0)
            && (j.status === "partial" || j.status === "blocked" || j.status === "failed")).length;
          const nonTransientCount = skipReasonCounts["non_transient"] ?? 0;
          const intervalMins = intervalMs > 0 ? Math.max(1, Math.round(intervalMs / 60_000)) : 0;
          const stalenessMins = lastSweepMs != null
            ? Math.max(0, Math.round((now - lastSweepMs) / 60_000))
            : 0;

          const stateReasons: string[] = [];
          if (bannerState === "gray") {
            stateReasons.push("Auto-heal sweep is not running");
          } else {
            if (ss?.lastError) {
              stateReasons.push(`Last sweep errored: ${ss.lastError}`);
            }
            if (nonTransientCount > 0) {
              stateReasons.push(`${nonTransientCount} job${nonTransientCount === 1 ? "" : "s"} hit non-transient errors`);
            }
            if (hitCapCount > 0) {
              stateReasons.push(`${hitCapCount} job${hitCapCount === 1 ? "" : "s"} hit the auto-continue cap`);
            }
            if (paused) {
              stateReasons.push(pauseReasons.length > 0
                ? `Sweep paused: ${pauseReasons.join(", ")}`
                : "Sweep paused");
            }
            if (sweepStale) {
              stateReasons.push(intervalMins > 0
                ? `Sweep hasn't run in 2× interval (${stalenessMins} min since last, interval ${intervalMins} min)`
                : "Sweep hasn't run in 2× its interval");
            }
            if (ac?.maxAttempts === 0) {
              stateReasons.push("Auto-continue cap is 0 (jobs will not auto-resume)");
            }
          }
          if (stateReasons.length === 0) {
            stateReasons.push(bannerState === "green"
              ? "Sweep running normally; no degraded signals"
              : "No specific reason detected");
          }
          const stateTooltip = `Auto-heal: ${stateLabel}\n• ${stateReasons.join("\n• ")}`;

          const formatRelative = (iso: string | null): string => {
            if (!iso) return "never";
            const t = new Date(iso).getTime();
            if (!Number.isFinite(t)) return "never";
            const diff = now - t;
            if (diff < 60_000) return "just now";
            const mins = Math.round(diff / 60_000);
            if (mins < 60) return `${mins} min ago`;
            const hours = Math.round(mins / 60);
            if (hours < 24) return `${hours} h ago`;
            const days = Math.round(hours / 24);
            return `${days} d ago`;
          };

          const isToday = (iso: string | null): boolean => {
            if (!iso) return false;
            const d = new Date(iso);
            const n = new Date(now);
            return d.getFullYear() === n.getFullYear()
              && d.getMonth() === n.getMonth()
              && d.getDate() === n.getDate();
          };

          const skipBreakdownIsToday = isToday(ss?.lastSweepAt ?? null);
          const wrapClasses = bannerState === "green" ? "bg-green-50 border-green-200"
            : bannerState === "amber" ? "bg-amber-50 border-amber-200"
            : bannerState === "red" ? "bg-red-50 border-red-200"
            : "bg-muted/50 border-border";
          const dotClasses = bannerState === "green" ? "bg-green-500"
            : bannerState === "amber" ? "bg-amber-500"
            : bannerState === "red" ? "bg-red-500"
            : "bg-gray-400";

          const lastSweepText = formatRelative(ss?.lastSweepAt ?? null);
          const lastSweepAbsolute = ss?.lastSweepAt
            ? new Date(ss.lastSweepAt).toLocaleString()
            : "";
          const lastSummary = ss?.lastSweepAt
            ? `pruned ${ss.lastPrunedCount ?? 0}`
              + (ss.lastAutoResumedCount != null ? ` · auto-resumed ${ss.lastAutoResumedCount}` : "")
              + (ss.lastSkippedCount != null ? ` · skipped ${ss.lastSkippedCount}` : "")
            : null;

          let countdownText: string | null = null;
          if (running && nextSweepMs != null) {
            const remaining = nextSweepMs - now;
            if (remaining <= 0) countdownText = "due now";
            else {
              const mins = Math.max(1, Math.round(remaining / 60_000));
              countdownText = `in ${mins} min`;
            }
          } else if (running && intervalMs > 0) {
            countdownText = `every ${Math.round(intervalMs / 60_000)} min`;
          }

          return (
            <div
              className={`rounded-lg border ${wrapClasses}`}
              data-testid="banner-recovery-autoheal"
              data-state={bannerState}
            >
              <div className="flex items-center gap-2 px-3 py-2 text-xs flex-wrap">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${dotClasses} ${
                    autoResumingIds.length > 0 ? "animate-pulse" : ""
                  }`}
                  aria-hidden="true"
                />
                <span
                  className="font-semibold text-foreground cursor-help"
                  data-testid={`banner-recovery-autoheal-state-${bannerState}`}
                  title={stateTooltip}
                  aria-label={stateTooltip}
                >
                  Auto-heal: {stateLabel}
                </span>
                <span
                  className="text-foreground"
                  data-testid="text-recovery-autoheal-last-sweep"
                  title={lastSweepAbsolute || undefined}
                >
                  Last sweep {lastSweepText}
                  {lastSummary ? ` (${lastSummary})` : ""}
                </span>
                {paused && pauseReasons.length > 0 && (
                  <Badge
                    variant="outline"
                    className="bg-card text-amber-700 border-amber-300"
                    title={pauseReasons.join(", ")}
                    data-testid="badge-recovery-autoheal-paused"
                  >
                    Paused: {pauseReasons.join(", ")}
                  </Badge>
                )}
                {countdownText && (
                  <span className="text-muted-foreground" data-testid="text-recovery-autoheal-next-sweep">
                    · next {countdownText}
                  </span>
                )}
                {autoResumingIds.length > 0 && (
                  <Badge
                    variant="outline"
                    className="bg-card border-current"
                    data-testid="badge-recovery-autoheal-resuming"
                  >
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    Auto-resuming {autoResumingIds.length}
                  </Badge>
                )}
                {ss?.lastError && (
                  <Badge
                    variant="outline"
                    className="bg-card text-red-700 border-red-300"
                    title={ss.lastError}
                    data-testid="badge-recovery-autoheal-last-error"
                  >
                    Last error
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 ml-auto px-1.5 text-xs"
                  aria-expanded={autohealExpanded}
                  aria-label={autohealExpanded ? "Hide auto-heal details" : "Show auto-heal details"}
                  data-testid="button-recovery-autoheal-expand"
                  onClick={() => setAutohealExpandedOverride(!autohealExpanded)}
                >
                  {autohealExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </Button>
              </div>
              {autohealExpanded && (
                <div
                  className="border-t bg-muted/60 px-3 py-2 space-y-2 text-xs text-foreground"
                  data-testid="section-recovery-autoheal-details"
                >
                  {Object.keys(skipReasonCounts).length > 0 && (
                    <div
                      className="flex items-center gap-2 flex-wrap"
                      data-testid="section-recovery-autoheal-skip-reasons"
                    >
                      <span className="font-semibold">
                        Skip reasons{skipBreakdownIsToday ? " (today)" : ""}:
                      </span>
                      {Object.entries(skipReasonCounts).map(([reason, count]) => (
                        <Badge
                          key={reason}
                          variant="outline"
                          className="bg-card"
                          data-testid={`badge-recovery-autoheal-skip-${reason}`}
                        >
                          {reason}: {count}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {autoResumingIds.length > 0 && (
                    <div
                      className="flex items-center gap-2 flex-wrap"
                      data-testid="section-recovery-autoheal-resuming-ids"
                    >
                      <span className="font-semibold">Auto-resuming now:</span>
                      <span className="font-mono text-muted-foreground break-all">
                        {autoResumingIds.join(", ")}
                      </span>
                    </div>
                  )}
                  {ss?.lastError && (
                    <div
                      className="text-red-700 whitespace-pre-wrap break-words"
                      data-testid="text-recovery-autoheal-last-error"
                    >
                      <span className="font-semibold">Last error:</span> {ss.lastError}
                    </div>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      data-testid="button-recovery-run-sweep-now"
                      disabled={recoveryRunSweepMutation.isPending || !!ss?.inFlight}
                      title="Run the prune sweep immediately instead of waiting for the next scheduled run."
                      onClick={() => recoveryRunSweepMutation.mutate()}
                    >
                      {recoveryRunSweepMutation.isPending || ss?.inFlight ? "Running…" : "Run sweep now"}
                    </Button>
                    {!running && (
                      <span className="text-muted-foreground" data-testid="text-recovery-autoheal-sweep-off-hint">
                        Background sweep is currently off.
                      </span>
                    )}
                  </div>
                  {renderAutoContinueCap()}
                </div>
              )}
            </div>
          );
        })()}
    </>
  );
}
