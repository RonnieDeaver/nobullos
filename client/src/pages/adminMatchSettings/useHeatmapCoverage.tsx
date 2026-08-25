// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { type LastEditedInfo } from "@/components/LastEditedBadge";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

type UseHeatmapCoverageDeps = {
  user: ReturnType<typeof useAuth>["user"];
  qc: ReturnType<typeof useQueryClient>;
  toast: ReturnType<typeof useToast>["toast"];
};

export function useHeatmapCoverage({
  user,
  qc,
  toast,
}: UseHeatmapCoverageDeps) {
  // Task #1115 — admin form for the post-backfill heatmap coverage check
  // settings (Task #651). Setting keys are loaded/saved via
  // /api/admin/heatmap-coverage-check/settings (server-side audit recorded
  // per changed key, mirroring the comparative-reset alert channel form).
  type HeatmapCoverageSettings = {
    enabled: boolean;
    delaySeconds: number;
    recheckIntervalSeconds: number;
    maxAttempts: number;
    slackChannelId: string | null;
    alertOnSuccess: boolean;
  };
  type HeatmapCoverageStatus = {
    settings: HeatmapCoverageSettings;
    defaults: HeatmapCoverageSettings;
    lastEdited: LastEditedInfo | null;
    lastEditedKey: string | null;
  };
  const { data: heatmapCoverageStatus } = useQuery<HeatmapCoverageStatus>({
    queryKey: ["/api/admin/heatmap-coverage-check/settings"],
    queryFn: async () => {
      const res = await fetch("/api/admin/heatmap-coverage-check/settings", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch heatmap coverage settings");
      return res.json();
    },
    // The MatchSettings page itself is CEO-gated below; align this query to
    // the page-level guard so we don't issue requests that 403 or render UI
    // that team_leads can't reach via this route.
    enabled: !!user && user.role === "ceo",
  });
  // Slack channel list for the coverage-alert channel picker. This query
  // used to live in useComparativeSemantic; it moved here when the Zoom
  // comparative-semantic card was retired (Task #4177 — its
  // /api/agents/shadow-metrics feed never existed server-side).
  const { data: slackChannelsData } = useQuery<{
    channels: Array<{ id: string; name: string; isPrivate: boolean }>;
  }>({
    queryKey: ["/api/integrations/slack/channels"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/slack/channels", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch Slack channels");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
  });
  const slackChannels = slackChannelsData?.channels ?? [];
  const [heatmapCoverageDraft, setHeatmapCoverageDraft] =
    useState<HeatmapCoverageSettings | null>(null);
  const [heatmapCoverageDirty, setHeatmapCoverageDirty] = useState(false);
  useEffect(() => {
    if (heatmapCoverageStatus && !heatmapCoverageDirty) {
      setHeatmapCoverageDraft(heatmapCoverageStatus.settings);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatmapCoverageStatus]);
  const heatmapCoverageEffective: HeatmapCoverageSettings | null =
    heatmapCoverageDraft ?? heatmapCoverageStatus?.settings ?? null;
  const updateHeatmapCoverageDraft = (
    patch: Partial<HeatmapCoverageSettings>,
  ) => {
    setHeatmapCoverageDirty(true);
    setHeatmapCoverageDraft((prev) => ({
      ...(prev ??
        heatmapCoverageStatus?.settings ?? {
          enabled: true,
          delaySeconds: 3600,
          recheckIntervalSeconds: 1800,
          maxAttempts: 6,
          slackChannelId: null,
          alertOnSuccess: false,
        }),
      ...patch,
    }));
  };
  const saveHeatmapCoverageMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (next: HeatmapCoverageSettings) => {
      const res = await fetch("/api/admin/heatmap-coverage-check/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: next.enabled,
          delaySeconds: next.delaySeconds,
          recheckIntervalSeconds: next.recheckIntervalSeconds,
          maxAttempts: next.maxAttempts,
          slackChannelId: next.slackChannelId ?? "",
          alertOnSuccess: next.alertOnSuccess,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to update settings");
      }
      return res.json() as Promise<{
        status: HeatmapCoverageStatus;
        changed: string[];
      }>;
    },
    onSuccess: (data) => {
      setHeatmapCoverageDirty(false);
      setHeatmapCoverageDraft(data.status.settings);
      void qc.invalidateQueries({
        queryKey: ["/api/admin/heatmap-coverage-check/settings"],
      }); // fire-and-forget: cache refresh only
      toast({
        title:
          data.changed.length === 0
            ? "No changes to save"
            : `Heatmap coverage check updated (${data.changed.length} setting${
                data.changed.length === 1 ? "" : "s"
              })`,
        duration: 3500,
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Update failed",
        description: err.message,
        variant: "destructive",
        duration: 5000,
      });
    },
  });
  return {
    heatmapCoverageStatus,
    heatmapCoverageDraft,
    setHeatmapCoverageDraft,
    heatmapCoverageDirty,
    setHeatmapCoverageDirty,
    heatmapCoverageEffective,
    updateHeatmapCoverageDraft,
    saveHeatmapCoverageMutation,
    slackChannels,
  };
}

export type HeatmapCoverageBag = ReturnType<typeof useHeatmapCoverage>;
