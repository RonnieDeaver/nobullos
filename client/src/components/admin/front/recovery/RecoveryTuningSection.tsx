// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { IntegrationStatus } from "./types";

type Props = {
  isAdmin: boolean;
  status: IntegrationStatus | undefined;
};

export function RecoveryTuningSection({ isAdmin, status }: Props) {
  const isTabVisible = useTabVisibility();
  const { toast } = useToast();


  // Post-#1787 throughput follow-up: live-tunable Front recovery
  // ingest concurrency + Phase 3 tuning kill switch. Replaces the
  // operator-only `scripts/flip-front-recovery-tuning-on.ts`.
  type RecoveryTuningResponse = {
    ingestConcurrency: number;
    tuningEnabled: boolean;
    minConcurrency: number;
    maxConcurrency: number;
    defaultConcurrency: number;
    concurrencyLastEdited?: LastEditedInfo | null;
    tuningEnabledLastEdited?: LastEditedInfo | null;
  };

  const { data: recoveryTuning, refetch: refetchRecoveryTuning } =
    useQuery<RecoveryTuningResponse>({
      queryKey: ["/api/integrations/front/historical-recovery/tuning"],
      enabled: isAdmin && !!status?.front.connected,
      refetchInterval: isTabVisible ? 60_000 : false,
    });

  const [recoveryConcurrencyDraft, setRecoveryConcurrencyDraft] =
    useState<string>("");

  useEffect(() => {
    if (recoveryTuning?.ingestConcurrency != null) {
      setRecoveryConcurrencyDraft(String(recoveryTuning.ingestConcurrency));
    }
  }, [recoveryTuning?.ingestConcurrency]);

  const recoveryTuningMutation = useMutation<
    RecoveryTuningResponse,
    Error,
    { ingestConcurrency?: number; tuningEnabled?: boolean }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest(
        "PUT",
        "/api/integrations/front/historical-recovery/tuning",
        body,
      );
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Recovery tuning updated",
        description: `Concurrency = ${data.ingestConcurrency}, Phase 3 tuning ${data.tuningEnabled ? "ON" : "OFF"}.`,
      });
      void refetchRecoveryTuning(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to update recovery tuning",
        description: err.message,
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  return (
    <>
        {recoveryTuning && (
          <div
            className="border-t pt-3 space-y-2"
            data-testid="section-recovery-tuning"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-xs font-semibold text-gray-700">
                Recovery throughput — ingest concurrency
              </div>
              <Input
                type="number"
                min={recoveryTuning.minConcurrency}
                max={recoveryTuning.maxConcurrency}
                step={1}
                value={recoveryConcurrencyDraft}
                onChange={(e) => setRecoveryConcurrencyDraft(e.target.value)}
                className="h-7 w-16 text-xs"
                data-testid="input-recovery-ingest-concurrency"
              />
              <span className="text-xs text-gray-600">
                pages in parallel (range {recoveryTuning.minConcurrency}–
                {recoveryTuning.maxConcurrency}, default{" "}
                {recoveryTuning.defaultConcurrency})
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                data-testid="button-recovery-ingest-concurrency-save"
                disabled={
                  recoveryTuningMutation.isPending ||
                  recoveryConcurrencyDraft === "" ||
                  !Number.isInteger(Number(recoveryConcurrencyDraft)) ||
                  Number(recoveryConcurrencyDraft) <
                    recoveryTuning.minConcurrency ||
                  Number(recoveryConcurrencyDraft) >
                    recoveryTuning.maxConcurrency ||
                  Number(recoveryConcurrencyDraft) ===
                    recoveryTuning.ingestConcurrency
                }
                onClick={() =>
                  recoveryTuningMutation.mutate({
                    ingestConcurrency: Number(recoveryConcurrencyDraft),
                  })
                }
              >
                Save
              </Button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-xs font-semibold text-gray-700">
                Phase 3 tuning
              </div>
              <Badge
                variant={recoveryTuning.tuningEnabled ? "default" : "outline"}
                className="text-xs"
                data-testid="badge-recovery-tuning-enabled"
              >
                {recoveryTuning.tuningEnabled ? "ON" : "OFF"}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                data-testid="button-recovery-tuning-toggle"
                disabled={recoveryTuningMutation.isPending}
                onClick={() =>
                  recoveryTuningMutation.mutate({
                    tuningEnabled: !recoveryTuning.tuningEnabled,
                  })
                }
              >
                {recoveryTuning.tuningEnabled ? "Turn OFF" : "Turn ON"}
              </Button>
              <span className="text-xs text-gray-500">
                Hysteresis-aware API-pool backoff + per-page saturation guard +
                200ms inter-page delay (legacy 500ms when OFF).
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <LastEditedBadge
                info={recoveryTuning.concurrencyLastEdited ?? undefined}
                testId="last-edited-recovery-ingest-concurrency"
                emptyText="Concurrency — using default"
              />
              <LastEditedBadge
                info={recoveryTuning.tuningEnabledLastEdited ?? undefined}
                testId="last-edited-recovery-tuning-enabled"
                emptyText="Tuning switch — using default"
              />
            </div>
            <div className="text-xs text-gray-500">
              Live webhooks run through the scheduler's <code>ingestion</code>{" "}
              class (cap 3). Historical backfill runs through this concurrency
              knob. Next ceiling beyond both is Front's per-token API rate
              limit (~50 req/min on most plans), not our scheduler.
            </div>
          </div>
        )}
    </>
  );
}
