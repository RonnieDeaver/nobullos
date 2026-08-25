// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Alert-thresholds domain: config query + save/reset mutations + card.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { ThresholdConfig } from "./types";
import { ThresholdSettings } from "./ThresholdSettings";

// Called unconditionally by HealthDashboardSection in the same
// hook-sequence position as the original thresholds query (F11D split).
export function useThresholdsDomain({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: thresholds, isLoading: thresholdsLoading, error: thresholdsError, refetch: refetchThresholds } = useQuery<ThresholdConfig>({
    queryKey: ["/api/health/thresholds"],
    enabled: isAdmin,
  });

  const updateThresholdsMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (config: ThresholdConfig) => {
      const res = await apiRequest("PUT", "/api/health/thresholds", config);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/health/thresholds"], data);
      toast({ title: "Thresholds updated", description: "Alert thresholds have been saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update thresholds", description: err.message, variant: "destructive" });
    },
  });

  const resetThresholdsMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/health/thresholds/reset");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/health/thresholds"], data);
      toast({ title: "Thresholds reset", description: "Alert thresholds have been restored to defaults." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to reset thresholds", description: err.message, variant: "destructive" });
    },
  });

  return {
    thresholds,
    thresholdsLoading,
    thresholdsError,
    refetchThresholds,
    updateThresholdsMutation,
    resetThresholdsMutation,
  };
}

export type ThresholdsDomain = ReturnType<typeof useThresholdsDomain>;

export function ThresholdsCard({ domain }: { domain: ThresholdsDomain }) {
  const { thresholds, updateThresholdsMutation, resetThresholdsMutation } = domain;
  return (
    <>
            {thresholds && (
              <Card data-testid="card-thresholds">
                <CardHeader>
                  <CardTitle className="text-foreground">Alert Thresholds</CardTitle>
                  <CardDescription>
                    Configure when warning and critical alerts trigger
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ThresholdSettings
                    thresholds={thresholds}
                    onSave={(config) => updateThresholdsMutation.mutate(config)}
                    onReset={() => resetThresholdsMutation.mutate()}
                    isSaving={updateThresholdsMutation.isPending}
                    isResetting={resetThresholdsMutation.isPending}
                  />
                </CardContent>
              </Card>
            )}
    </>
  );
}
