// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LastEditedBadge } from "@/components/LastEditedBadge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { RecoveryRetryAlertResponse } from "./types";
import type { QueryObserverResult, RefetchOptions } from "@tanstack/react-query";

type Props = {
  recoveryRetryAlert: RecoveryRetryAlertResponse | undefined;
  refetchRecoveryRetryAlert: (options?: RefetchOptions) => Promise<QueryObserverResult<RecoveryRetryAlertResponse, Error>>;
};

export function RetryAlertSettings({ recoveryRetryAlert, refetchRecoveryRetryAlert }: Props) {
  const { toast } = useToast();

  const [recoveryRetryAlertDraft, setRecoveryRetryAlertDraft] = useState<string>("");

  useEffect(() => {
    if (recoveryRetryAlert?.totalRetriesThreshold != null) {
      setRecoveryRetryAlertDraft(String(recoveryRetryAlert.totalRetriesThreshold));
    }
  }, [recoveryRetryAlert?.totalRetriesThreshold]);

  // Task #1083 — drafts for the two consecutive-window slow-burn knobs.
  const [recoveryConsecutiveCountDraft, setRecoveryConsecutiveCountDraft] = useState<string>("");

  const [recoveryConsecutive5xxFloorDraft, setRecoveryConsecutive5xxFloorDraft] = useState<string>("");

  useEffect(() => {
    if (recoveryRetryAlert?.consecutiveWindowCount != null) {
      setRecoveryConsecutiveCountDraft(String(recoveryRetryAlert.consecutiveWindowCount));
    }
  }, [recoveryRetryAlert?.consecutiveWindowCount]);

  useEffect(() => {
    if (recoveryRetryAlert?.consecutive5xxFloor != null) {
      setRecoveryConsecutive5xxFloorDraft(String(recoveryRetryAlert.consecutive5xxFloor));
    }
  }, [recoveryRetryAlert?.consecutive5xxFloor]);


  const recoveryRetryAlertMutation = useMutation<
    {
      enabled: boolean;
      totalRetriesThreshold: number;
      consecutiveWindowCount: number;
      consecutive5xxFloor: number;
    },
    Error,
    {
      enabled?: boolean;
      totalRetriesThreshold?: number;
      consecutiveWindowCount?: number;
      consecutive5xxFloor?: number;
    }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("PUT", "/api/integrations/front/historical-recovery/retry-alert", body);
      return res.json();
    },
    onSuccess: (data, vars) => {
      let what: string;
      if (vars.enabled !== undefined) {
        what = `Retry-pressure alert ${data.enabled ? "enabled" : "disabled"}.`;
      } else if (vars.consecutiveWindowCount !== undefined) {
        what = `Consecutive-window count updated to ${data.consecutiveWindowCount}.`;
      } else if (vars.consecutive5xxFloor !== undefined) {
        what = `Per-window Front 5xx floor updated to ${data.consecutive5xxFloor}.`;
      } else {
        what = `Threshold updated to ${data.totalRetriesThreshold} retries / window.`;
      }
      toast({ title: "Saved", description: what });
      void refetchRecoveryRetryAlert(); // fire-and-forget: refetch only
    },
    onError: (err) => {
      toast({ title: "Failed to save retry-alert config", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  return (
    <>
            {recoveryRetryAlert && (
              <div className="flex items-center gap-2 flex-wrap pt-1" data-testid="section-recovery-retry-alert">
                <div className="text-xs font-semibold text-gray-700">Retry-pressure alert</div>
                <Button
                  size="sm"
                  variant={recoveryRetryAlert.enabled ? "outline" : "ghost"}
                  className="h-7 px-2 text-xs"
                  data-testid="button-recovery-retry-alert-toggle"
                  disabled={recoveryRetryAlertMutation.isPending}
                  onClick={() =>
                    recoveryRetryAlertMutation.mutate({ enabled: !recoveryRetryAlert.enabled })
                  }
                >
                  {recoveryRetryAlert.enabled ? "Enabled" : "Disabled"}
                </Button>
                <span className="text-xs text-gray-600">— alert when window retries ≥</span>
                <Input
                  type="number"
                  min={recoveryRetryAlert.minThreshold}
                  max={recoveryRetryAlert.maxThreshold}
                  step={1}
                  value={recoveryRetryAlertDraft}
                  onChange={(e) => setRecoveryRetryAlertDraft(e.target.value)}
                  className="h-7 w-20 text-xs"
                  data-testid="input-recovery-retry-alert-threshold"
                />
                <span className="text-xs text-gray-600">retries</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  data-testid="button-recovery-retry-alert-save"
                  disabled={
                    recoveryRetryAlertMutation.isPending ||
                    recoveryRetryAlertDraft === "" ||
                    Number(recoveryRetryAlertDraft) === recoveryRetryAlert.totalRetriesThreshold ||
                    !Number.isInteger(Number(recoveryRetryAlertDraft)) ||
                    Number(recoveryRetryAlertDraft) < recoveryRetryAlert.minThreshold ||
                    Number(recoveryRetryAlertDraft) > recoveryRetryAlert.maxThreshold
                  }
                  onClick={() =>
                    recoveryRetryAlertMutation.mutate({
                      totalRetriesThreshold: Number(recoveryRetryAlertDraft),
                    })
                  }
                >
                  Save
                </Button>
                {recoveryRetryAlert.totalRetriesThreshold !== recoveryRetryAlert.defaultThreshold && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-gray-500"
                    data-testid="button-recovery-retry-alert-reset"
                    disabled={recoveryRetryAlertMutation.isPending}
                    onClick={() =>
                      recoveryRetryAlertMutation.mutate({
                        totalRetriesThreshold: recoveryRetryAlert.defaultThreshold,
                      })
                    }
                  >
                    Reset to {recoveryRetryAlert.defaultThreshold}
                  </Button>
                )}
                <span className="text-xs text-gray-500" data-testid="text-recovery-retry-alert-help">
                  Fires once per (job, window) when totalRetries crosses the threshold. Range: {recoveryRetryAlert.minThreshold}–{recoveryRetryAlert.maxThreshold} (default {recoveryRetryAlert.defaultThreshold}).
                </span>
                <div className="basis-full flex items-center gap-2 flex-wrap">
                  <LastEditedBadge
                    info={recoveryRetryAlert.thresholdLastEdited ?? undefined}
                    testId="last-edited-recovery-retry-alert-threshold"
                    emptyText="Threshold using default — never overridden"
                  />
                  <LastEditedBadge
                    info={recoveryRetryAlert.enabledLastEdited ?? undefined}
                    testId="last-edited-recovery-retry-alert-enabled"
                    emptyText="Enabled flag using default — never overridden"
                  />
                </div>
                {/* Task #1083 — slow-burn pattern: N consecutive completed
                    windows each bleeding ≥ floor front_5xx retries. */}
                <div
                  className="basis-full flex items-center gap-2 flex-wrap pt-1"
                  data-testid="section-recovery-retry-alert-consecutive"
                >
                  <span className="text-xs text-gray-600">+ also alert when</span>
                  <Input
                    type="number"
                    min={recoveryRetryAlert.minConsecutiveWindowCount}
                    max={recoveryRetryAlert.maxConsecutiveWindowCount}
                    step={1}
                    value={recoveryConsecutiveCountDraft}
                    onChange={(e) => setRecoveryConsecutiveCountDraft(e.target.value)}
                    className="h-7 w-16 text-xs"
                    data-testid="input-recovery-retry-alert-consecutive-count"
                  />
                  <span className="text-xs text-gray-600">consecutive completed windows each have Front 5xx retries ≥</span>
                  <Input
                    type="number"
                    min={recoveryRetryAlert.minConsecutive5xxFloor}
                    max={recoveryRetryAlert.maxConsecutive5xxFloor}
                    step={1}
                    value={recoveryConsecutive5xxFloorDraft}
                    onChange={(e) => setRecoveryConsecutive5xxFloorDraft(e.target.value)}
                    className="h-7 w-20 text-xs"
                    data-testid="input-recovery-retry-alert-consecutive-floor"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    data-testid="button-recovery-retry-alert-consecutive-count-save"
                    disabled={
                      recoveryRetryAlertMutation.isPending ||
                      recoveryConsecutiveCountDraft === "" ||
                      Number(recoveryConsecutiveCountDraft) === recoveryRetryAlert.consecutiveWindowCount ||
                      !Number.isInteger(Number(recoveryConsecutiveCountDraft)) ||
                      Number(recoveryConsecutiveCountDraft) < recoveryRetryAlert.minConsecutiveWindowCount ||
                      Number(recoveryConsecutiveCountDraft) > recoveryRetryAlert.maxConsecutiveWindowCount
                    }
                    onClick={() =>
                      recoveryRetryAlertMutation.mutate({
                        consecutiveWindowCount: Number(recoveryConsecutiveCountDraft),
                      })
                    }
                  >
                    Save count
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    data-testid="button-recovery-retry-alert-consecutive-floor-save"
                    disabled={
                      recoveryRetryAlertMutation.isPending ||
                      recoveryConsecutive5xxFloorDraft === "" ||
                      Number(recoveryConsecutive5xxFloorDraft) === recoveryRetryAlert.consecutive5xxFloor ||
                      !Number.isInteger(Number(recoveryConsecutive5xxFloorDraft)) ||
                      Number(recoveryConsecutive5xxFloorDraft) < recoveryRetryAlert.minConsecutive5xxFloor ||
                      Number(recoveryConsecutive5xxFloorDraft) > recoveryRetryAlert.maxConsecutive5xxFloor
                    }
                    onClick={() =>
                      recoveryRetryAlertMutation.mutate({
                        consecutive5xxFloor: Number(recoveryConsecutive5xxFloorDraft),
                      })
                    }
                  >
                    Save floor
                  </Button>
                  {(recoveryRetryAlert.consecutiveWindowCount !== recoveryRetryAlert.defaultConsecutiveWindowCount ||
                    recoveryRetryAlert.consecutive5xxFloor !== recoveryRetryAlert.defaultConsecutive5xxFloor) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-gray-500"
                      data-testid="button-recovery-retry-alert-consecutive-reset"
                      disabled={recoveryRetryAlertMutation.isPending}
                      onClick={() => {
                        if (
                          recoveryRetryAlert.consecutiveWindowCount !==
                          recoveryRetryAlert.defaultConsecutiveWindowCount
                        ) {
                          recoveryRetryAlertMutation.mutate({
                            consecutiveWindowCount: recoveryRetryAlert.defaultConsecutiveWindowCount,
                          });
                        }
                        if (
                          recoveryRetryAlert.consecutive5xxFloor !==
                          recoveryRetryAlert.defaultConsecutive5xxFloor
                        ) {
                          recoveryRetryAlertMutation.mutate({
                            consecutive5xxFloor: recoveryRetryAlert.defaultConsecutive5xxFloor,
                          });
                        }
                      }}
                    >
                      Reset to {recoveryRetryAlert.defaultConsecutiveWindowCount}/{recoveryRetryAlert.defaultConsecutive5xxFloor}
                    </Button>
                  )}
                  <span className="text-xs text-gray-500" data-testid="text-recovery-retry-alert-consecutive-help">
                    Slow-burn signal — fires once per (job, trailing-window) when the last N completed windows each bleed ≥ floor Front 5xx retries (501/502/503/504 + generic 5xx). Count range: {recoveryRetryAlert.minConsecutiveWindowCount}–{recoveryRetryAlert.maxConsecutiveWindowCount}; floor range: {recoveryRetryAlert.minConsecutive5xxFloor}–{recoveryRetryAlert.maxConsecutive5xxFloor}.
                  </span>
                  <div className="basis-full flex items-center gap-2 flex-wrap">
                    <LastEditedBadge
                      info={recoveryRetryAlert.consecutiveWindowCountLastEdited ?? undefined}
                      testId="last-edited-recovery-retry-alert-consecutive-count"
                      emptyText="Consecutive-window count using default — never overridden"
                    />
                    <LastEditedBadge
                      info={recoveryRetryAlert.consecutive5xxFloorLastEdited ?? undefined}
                      testId="last-edited-recovery-retry-alert-consecutive-floor"
                      emptyText="Per-window 5xx floor using default — never overridden"
                    />
                  </div>
                </div>
              </div>
            )}
    </>
  );
}
