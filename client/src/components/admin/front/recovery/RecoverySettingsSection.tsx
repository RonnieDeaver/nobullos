// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Input } from "@/components/ui/input";
import { LastEditedBadge } from "@/components/LastEditedBadge";
import { useAuth } from "@/hooks/use-auth";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ArrowRight, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import type { IntegrationStatus, RecoveryMaxAgeResponse, RecoveryRetryAlertResponse, RecoverySettingHistoryEntry } from "./types";
import type { RecoveryJobsHook } from "./useRecoveryJobs";
import type { QueryObserverResult, RefetchOptions } from "@tanstack/react-query";
import { PruneIntervalSettings } from "./PruneIntervalSettings";
import { RetryAlertSettings } from "./RetryAlertSettings";
import { ManualSweepHistorySection } from "./ManualSweepHistorySection";

type Props = {
  isAdmin: boolean;
  recoveryRetryAlert: RecoveryRetryAlertResponse | undefined;
  refetchRecoveryJobs: RecoveryJobsHook["refetchRecoveryJobs"];
  refetchRecoveryRetryAlert: (options?: RefetchOptions) => Promise<QueryObserverResult<RecoveryRetryAlertResponse, Error>>;
  status: IntegrationStatus | undefined;
};

export function RecoverySettingsSection({ isAdmin, recoveryRetryAlert, refetchRecoveryJobs, refetchRecoveryRetryAlert, status }: Props) {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();


  const { data: recoveryMaxAge, refetch: refetchRecoveryMaxAge } = useQuery<RecoveryMaxAgeResponse>({
    queryKey: ["/api/integrations/front/historical-recovery/max-age"],
    enabled: isAdmin && !!status?.front.connected,
  });

  const [recoveryMaxAgeDraft, setRecoveryMaxAgeDraft] = useState<string>("");

  useEffect(() => {
    if (recoveryMaxAge?.maxAgeDays != null) {
      setRecoveryMaxAgeDraft(String(recoveryMaxAge.maxAgeDays));
    }
  }, [recoveryMaxAge?.maxAgeDays]);


  const [recoveryMaxAgeHistoryOpen, setRecoveryMaxAgeHistoryOpen] = useState(false);

  const { data: recoveryMaxAgeHistoryData } = useQuery<{ history: RecoverySettingHistoryEntry[] }>({
    queryKey: ["/api/integrations/front/historical-recovery/max-age/history"],
    enabled: isAdmin && !!status?.front.connected && recoveryMaxAgeHistoryOpen,
    refetchInterval: recoveryMaxAgeHistoryOpen && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const recoveryMaxAgeHistory = recoveryMaxAgeHistoryData?.history ?? [];


  const recoveryMaxAgeMutation = useMutation<{ maxAgeDays: number; pruned: number }, Error, number>({
    mutationFn: async (maxAgeDays: number) => {
      const res = await apiRequest("PUT", "/api/integrations/front/historical-recovery/max-age", { maxAgeDays });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Max age updated",
        description: data.pruned > 0
          ? `Recovery jobs older than ${data.maxAgeDays} day${data.maxAgeDays === 1 ? "" : "s"} will auto-expire. Pruned ${data.pruned} now.`
          : `Recovery jobs older than ${data.maxAgeDays} day${data.maxAgeDays === 1 ? "" : "s"} will auto-expire.`,
      });
      void refetchRecoveryMaxAge(); // fire-and-forget: refetch only
      void refetchRecoveryJobs(); // fire-and-forget: refetch only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/max-age/history"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update max age", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  return (
    <>
        {recoveryMaxAge && (
          <div className="border-t pt-3 space-y-2" data-testid="section-recovery-max-age">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-xs font-semibold text-foreground">Auto-expire history older than</div>
              <Input
                type="number"
                min={recoveryMaxAge.minDays}
                max={recoveryMaxAge.maxDays}
                step={1}
                value={recoveryMaxAgeDraft}
                onChange={(e) => setRecoveryMaxAgeDraft(e.target.value)}
                className="h-7 w-20 text-xs"
                data-testid="input-recovery-max-age-days"
              />
              <span className="text-xs text-muted-foreground">days</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                data-testid="button-recovery-max-age-save"
                disabled={
                  recoveryMaxAgeMutation.isPending ||
                  recoveryMaxAgeDraft === "" ||
                  Number(recoveryMaxAgeDraft) === recoveryMaxAge.maxAgeDays ||
                  !Number.isInteger(Number(recoveryMaxAgeDraft)) ||
                  Number(recoveryMaxAgeDraft) < recoveryMaxAge.minDays ||
                  Number(recoveryMaxAgeDraft) > recoveryMaxAge.maxDays
                }
                onClick={() => recoveryMaxAgeMutation.mutate(Number(recoveryMaxAgeDraft))}
              >
                Save
              </Button>
              {recoveryMaxAge.maxAgeDays !== recoveryMaxAge.defaultDays && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  data-testid="button-recovery-max-age-reset"
                  disabled={recoveryMaxAgeMutation.isPending}
                  onClick={() => recoveryMaxAgeMutation.mutate(recoveryMaxAge.defaultDays)}
                >
                  Reset to {recoveryMaxAge.defaultDays}d
                </Button>
              )}
            </div>
            <div className="text-xs text-muted-foreground" data-testid="text-recovery-max-age-help">
              Finished recovery jobs older than this are pruned automatically. Running and queued jobs are never expired. Range: {recoveryMaxAge.minDays}–{recoveryMaxAge.maxDays} days (default {recoveryMaxAge.defaultDays}).
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <LastEditedBadge
                info={recoveryMaxAge.lastEdited}
                testId="last-edited-recovery-max-age"
                emptyText="Using default — never overridden"
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs text-muted-foreground"
                onClick={() => setRecoveryMaxAgeHistoryOpen((v) => !v)}
                data-testid="button-recovery-max-age-history-toggle"
              >
                {recoveryMaxAgeHistoryOpen ? (
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
            {recoveryMaxAgeHistoryOpen && (
              <div className="border rounded bg-muted/50 px-2.5 py-2 mt-1" data-testid="recovery-max-age-history">
                <h6 className="text-xs font-semibold text-foreground mb-1">Recent changes (last {recoveryMaxAgeHistory.length || 5})</h6>
                {recoveryMaxAgeHistory.length === 0 ? (
                  <div className="text-xs text-muted-foreground" data-testid="text-recovery-max-age-history-empty">
                    No changes recorded yet.
                  </div>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {recoveryMaxAgeHistory.map((entry) => {
                      const who = formatEditorAttribution(entry);
                      const oldV = entry.oldValues?.maxAgeDays ?? null;
                      const newV = entry.newValues?.maxAgeDays ?? null;
                      const canRevert =
                        isAdmin &&
                        oldV != null &&
                        Number.isInteger(oldV) &&
                        oldV >= recoveryMaxAge.minDays &&
                        oldV <= recoveryMaxAge.maxDays &&
                        oldV !== recoveryMaxAge.maxAgeDays;
                      return (
                        <div
                          key={entry.id}
                          className="bg-card rounded px-2 py-1 text-xs border"
                          data-testid={`recovery-max-age-history-${entry.id}`}
                        >
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="font-medium text-foreground" data-testid={`text-rma-history-user-${entry.id}`}>{who}</span>
                            <span className="text-muted-foreground" data-testid={`text-rma-history-time-${entry.id}`}>{new Date(entry.changedAt).toLocaleString()}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-foreground line-through">{oldV != null ? `${oldV}d` : "—"}</span>
                            <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                            <span className="font-semibold text-foreground">{newV != null ? `${newV}d` : "—"}</span>
                            {isAdmin && (
                              <ConfirmActionDialog
                                trigger={
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-5 ml-auto px-1.5 text-xs text-muted-foreground"
                                    data-testid={`button-rma-history-revert-${entry.id}`}
                                    disabled={!canRevert || recoveryMaxAgeMutation.isPending}
                                    title={
                                      oldV == null
                                        ? "No previous value to revert to"
                                        : oldV === recoveryMaxAge.maxAgeDays
                                          ? `Already set to ${oldV}d`
                                          : `Revert to ${oldV} day${oldV === 1 ? "" : "s"}`
                                    }
                                  >
                                    <RotateCcw className="w-2.5 h-2.5 mr-0.5" />
                                    Revert
                                  </Button>
                                }
                                title="Revert auto-expire age?"
                                description={`This changes how long finished recovery jobs are kept before auto-expiring: ${recoveryMaxAge.maxAgeDays}d → ${oldV}d. A shorter age means older history rows are pruned sooner on the next sweep; this cannot bring back rows already pruned.`}
                                confirmLabel="Revert"
                                onConfirm={() => {
                                  if (!canRevert || oldV == null) return;
                                  recoveryMaxAgeMutation.mutate(oldV);
                                }}
                                testId={`dialog-rma-history-revert-${entry.id}`}
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

            <PruneIntervalSettings
              isAdmin={isAdmin}
              status={status}
            />

            <RetryAlertSettings
              recoveryRetryAlert={recoveryRetryAlert}
              refetchRecoveryRetryAlert={refetchRecoveryRetryAlert}
            />

            <ManualSweepHistorySection
              isAdmin={isAdmin}
              status={status}
            />

          </div>
        )}
    </>
  );
}
