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
import type { IntegrationStatus, RecoveryPruneIntervalResponse, RecoverySettingHistoryEntry } from "./types";

type Props = {
  isAdmin: boolean;
  status: IntegrationStatus | undefined;
};

export function PruneIntervalSettings({ isAdmin, status }: Props) {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();


  const { data: recoveryPruneInterval, refetch: refetchRecoveryPruneInterval } = useQuery<RecoveryPruneIntervalResponse>({
    queryKey: ["/api/integrations/front/historical-recovery/prune-interval"],
    enabled: isAdmin && !!status?.front.connected,
  });

  const [recoveryPruneIntervalDraft, setRecoveryPruneIntervalDraft] = useState<string>("");

  useEffect(() => {
    if (recoveryPruneInterval?.intervalMinutes != null) {
      setRecoveryPruneIntervalDraft(String(recoveryPruneInterval.intervalMinutes));
    }
  }, [recoveryPruneInterval?.intervalMinutes]);

  const [recoveryPruneIntervalHistoryOpen, setRecoveryPruneIntervalHistoryOpen] = useState(false);

  const { data: recoveryPruneIntervalHistoryData } = useQuery<{ history: RecoverySettingHistoryEntry[] }>({
    queryKey: ["/api/integrations/front/historical-recovery/prune-interval/history"],
    enabled: isAdmin && !!status?.front.connected && recoveryPruneIntervalHistoryOpen,
    refetchInterval: recoveryPruneIntervalHistoryOpen && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const recoveryPruneIntervalHistory = recoveryPruneIntervalHistoryData?.history ?? [];


  const recoveryPruneIntervalMutation = useMutation<{ intervalMinutes: number }, Error, number>({
    mutationFn: async (intervalMinutes: number) => {
      const res = await apiRequest("PUT", "/api/integrations/front/historical-recovery/prune-interval", { intervalMinutes });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sweep interval updated",
        description: `Background prune sweep now runs every ${data.intervalMinutes} min.`,
      });
      void refetchRecoveryPruneInterval(); // fire-and-forget: refetch only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/sweep-status"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/historical-recovery/prune-interval/history"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update sweep interval", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  return (
    <>
            {recoveryPruneInterval && (
              <div className="flex items-center gap-2 flex-wrap pt-1" data-testid="section-recovery-prune-interval">
                <div className="text-xs font-semibold text-foreground">Background sweep runs every</div>
                <Input
                  type="number"
                  min={recoveryPruneInterval.minMinutes}
                  max={recoveryPruneInterval.maxMinutes}
                  step={1}
                  value={recoveryPruneIntervalDraft}
                  onChange={(e) => setRecoveryPruneIntervalDraft(e.target.value)}
                  className="h-7 w-20 text-xs"
                  data-testid="input-recovery-prune-interval-minutes"
                />
                <span className="text-xs text-muted-foreground">min</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  data-testid="button-recovery-prune-interval-save"
                  disabled={
                    recoveryPruneIntervalMutation.isPending ||
                    recoveryPruneIntervalDraft === "" ||
                    Number(recoveryPruneIntervalDraft) === recoveryPruneInterval.intervalMinutes ||
                    !Number.isInteger(Number(recoveryPruneIntervalDraft)) ||
                    Number(recoveryPruneIntervalDraft) < recoveryPruneInterval.minMinutes ||
                    Number(recoveryPruneIntervalDraft) > recoveryPruneInterval.maxMinutes
                  }
                  onClick={() => recoveryPruneIntervalMutation.mutate(Number(recoveryPruneIntervalDraft))}
                >
                  Save
                </Button>
                {recoveryPruneInterval.intervalMinutes !== recoveryPruneInterval.defaultMinutes && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    data-testid="button-recovery-prune-interval-reset"
                    disabled={recoveryPruneIntervalMutation.isPending}
                    onClick={() => recoveryPruneIntervalMutation.mutate(recoveryPruneInterval.defaultMinutes)}
                  >
                    Reset to {recoveryPruneInterval.defaultMinutes}m
                  </Button>
                )}
                <span className="text-xs text-muted-foreground" data-testid="text-recovery-prune-interval-help">
                  Range: {recoveryPruneInterval.minMinutes}–{recoveryPruneInterval.maxMinutes} min (default {recoveryPruneInterval.defaultMinutes}).
                </span>
                <div className="basis-full flex items-center gap-2 flex-wrap">
                  <LastEditedBadge
                    info={recoveryPruneInterval.lastEdited}
                    testId="last-edited-recovery-prune-interval"
                    emptyText="Using default — never overridden"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-xs text-muted-foreground"
                    onClick={() => setRecoveryPruneIntervalHistoryOpen((v) => !v)}
                    data-testid="button-recovery-prune-interval-history-toggle"
                  >
                    {recoveryPruneIntervalHistoryOpen ? (
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
                {recoveryPruneIntervalHistoryOpen && (
                  <div className="basis-full border rounded bg-muted/50 px-2.5 py-2 mt-1" data-testid="recovery-prune-interval-history">
                    <h6 className="text-xs font-semibold text-foreground mb-1">Recent changes (last {recoveryPruneIntervalHistory.length || 5})</h6>
                    {recoveryPruneIntervalHistory.length === 0 ? (
                      <div className="text-xs text-muted-foreground" data-testid="text-recovery-prune-interval-history-empty">
                        No changes recorded yet.
                      </div>
                    ) : (
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {recoveryPruneIntervalHistory.map((entry) => {
                          const who = formatEditorAttribution(entry);
                          const oldV = entry.oldValues?.intervalMinutes ?? null;
                          const newV = entry.newValues?.intervalMinutes ?? null;
                          const canRevert =
                            isAdmin &&
                            oldV != null &&
                            Number.isInteger(oldV) &&
                            oldV >= recoveryPruneInterval.minMinutes &&
                            oldV <= recoveryPruneInterval.maxMinutes &&
                            oldV !== recoveryPruneInterval.intervalMinutes;
                          return (
                            <div
                              key={entry.id}
                              className="bg-card rounded px-2 py-1 text-xs border"
                              data-testid={`recovery-prune-interval-history-${entry.id}`}
                            >
                              <div className="flex items-center justify-between mb-0.5">
                                <span className="font-medium text-foreground" data-testid={`text-rpi-history-user-${entry.id}`}>{who}</span>
                                <span className="text-muted-foreground" data-testid={`text-rpi-history-time-${entry.id}`}>{new Date(entry.changedAt).toLocaleString()}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <span className="text-foreground line-through">{oldV != null ? `${oldV}m` : "—"}</span>
                                <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                                <span className="font-semibold text-foreground">{newV != null ? `${newV}m` : "—"}</span>
                                {isAdmin && (
                                  <ConfirmActionDialog
                                    trigger={
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-5 ml-auto px-1.5 text-xs text-muted-foreground"
                                        data-testid={`button-rpi-history-revert-${entry.id}`}
                                        disabled={!canRevert || recoveryPruneIntervalMutation.isPending}
                                        title={
                                          oldV == null
                                            ? "No previous value to revert to"
                                            : oldV === recoveryPruneInterval.intervalMinutes
                                              ? `Already set to ${oldV}m`
                                              : `Revert to ${oldV} minute${oldV === 1 ? "" : "s"}`
                                        }
                                      >
                                        <RotateCcw className="w-2.5 h-2.5 mr-0.5" />
                                        Revert
                                      </Button>
                                    }
                                    title="Revert background sweep interval?"
                                    description={`This changes how often the background sweep runs for everyone: ${recoveryPruneInterval.intervalMinutes}m → ${oldV}m. The change takes effect on the next sweep cycle and is recorded in the change history, so you can revert again if needed.`}
                                    confirmLabel="Revert"
                                    onConfirm={() => {
                                      if (!canRevert || oldV == null) return;
                                      recoveryPruneIntervalMutation.mutate(oldV);
                                    }}
                                    testId={`dialog-rpi-history-revert-${entry.id}`}
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
            )}
    </>
  );
}
