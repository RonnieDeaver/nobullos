// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LastEditedBadge } from "@/components/LastEditedBadge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { CoverageMonth, IntegrationStatus, FrontAnalyticsCoverageAlertsResponse } from "./types";

type Props = {
  isAdmin: boolean;
  months: CoverageMonth[];
  status: IntegrationStatus | undefined;
};

export function AnalyticsCoverageAlertsConfig({ isAdmin, months, status }: Props) {
  const { toast } = useToast();


  // Task #1645 — Front Analytics coverage alert threshold editor.
  const { data: analyticsAlerts, refetch: refetchAnalyticsAlerts } = useQuery<FrontAnalyticsCoverageAlertsResponse>({
    queryKey: ["/api/admin/front/analytics-coverage/alerts"],
    enabled: isAdmin && !!status?.front.connected,
  });

  const [analyticsDropDraft, setAnalyticsDropDraft] = useState<string>("");

  const [analyticsFloorDraft, setAnalyticsFloorDraft] = useState<string>("");

  useEffect(() => {
    if (analyticsAlerts?.dropDeltaPct != null) {
      setAnalyticsDropDraft(String(analyticsAlerts.dropDeltaPct));
    }
  }, [analyticsAlerts?.dropDeltaPct]);

  useEffect(() => {
    if (analyticsAlerts?.monthFloorPct != null) {
      setAnalyticsFloorDraft(String(analyticsAlerts.monthFloorPct));
    }
  }, [analyticsAlerts?.monthFloorPct]);

  // Task #2834 — floor-raise regrowth threshold draft.
  const [analyticsRegrowthDraft, setAnalyticsRegrowthDraft] = useState<string>("");

  useEffect(() => {
    if (analyticsAlerts?.floorRaiseRegrowthPct != null) {
      setAnalyticsRegrowthDraft(String(analyticsAlerts.floorRaiseRegrowthPct));
    }
  }, [analyticsAlerts?.floorRaiseRegrowthPct]);


  const analyticsAlertsMutation = useMutation<
    {
      enabled: boolean;
      dropDeltaPct: number;
      monthFloorPct: number;
      completenessAlertsEnabled: boolean;
      floorRaiseAlertsEnabled: boolean;
      floorRaiseRegrowthPct: number;
    },
    Error,
    {
      enabled?: boolean;
      dropDeltaPct?: number;
      monthFloorPct?: number;
      completenessAlertsEnabled?: boolean;
      floorRaiseAlertsEnabled?: boolean;
      floorRaiseRegrowthPct?: number;
    }
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("PUT", "/api/admin/front/analytics-coverage/alerts", body);
      return res.json();
    },
    onSuccess: (data, vars) => {
      let what: string;
      if (vars.enabled !== undefined) {
        what = `Coverage alerts ${data.enabled ? "enabled" : "disabled"}.`;
      } else if (vars.dropDeltaPct !== undefined) {
        what = `Drop delta updated to ${data.dropDeltaPct}pp.`;
      } else if (vars.floorRaiseAlertsEnabled !== undefined) {
        what = `Floor-raise alerts ${data.floorRaiseAlertsEnabled ? "enabled" : "disabled"}.`;
      } else if (vars.floorRaiseRegrowthPct !== undefined) {
        what = `Floor-raise regrowth threshold updated to ${data.floorRaiseRegrowthPct}%.`;
      } else if (vars.completenessAlertsEnabled !== undefined) {
        what = `Completeness alerts ${data.completenessAlertsEnabled ? "enabled" : "disabled"}.`;
      } else {
        what = `Month floor updated to ${data.monthFloorPct}%.`;
      }
      toast({ title: "Saved", description: what });
      void refetchAnalyticsAlerts(); // fire-and-forget: refetch only
    },
    onError: (err) => {
      toast({ title: "Failed to save coverage alert config", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  return (
    <>
          {analyticsAlerts && (
            <div
              className="mt-3 border rounded-lg p-3 bg-slate-50"
              data-testid="section-front-analytics-coverage-alerts"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <div>
                  <h5 className="text-xs font-semibold text-gray-700">Coverage alert thresholds</h5>
                  <p className="text-xs text-gray-500">
                    Tune when the drop-delta and below-floor alerts fire. Changes are audit-logged.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={analyticsAlerts.enabled ? "outline" : "ghost"}
                  className="h-7 px-2 text-xs"
                  data-testid="button-front-analytics-alerts-toggle"
                  disabled={analyticsAlertsMutation.isPending}
                  onClick={() => analyticsAlertsMutation.mutate({ enabled: !analyticsAlerts.enabled })}
                >
                  {analyticsAlerts.enabled ? "Enabled" : "Disabled"}
                </Button>
              </div>

              <div className="flex items-center gap-2 flex-wrap" data-testid="row-front-analytics-alerts-drop">
                <span className="text-xs text-gray-600">Drop alert when all-time applied coverage falls by &gt;</span>
                <Input
                  type="number"
                  min={analyticsAlerts.minDropDeltaPct}
                  max={analyticsAlerts.maxDropDeltaPct}
                  step={0.1}
                  value={analyticsDropDraft}
                  onChange={(e) => setAnalyticsDropDraft(e.target.value)}
                  className="h-7 w-24 text-xs"
                  data-testid="input-front-analytics-drop-delta"
                />
                <span className="text-xs text-gray-600">pp</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  data-testid="button-front-analytics-drop-delta-save"
                  disabled={
                    analyticsAlertsMutation.isPending ||
                    analyticsDropDraft === "" ||
                    Number(analyticsDropDraft) === analyticsAlerts.dropDeltaPct ||
                    !Number.isFinite(Number(analyticsDropDraft)) ||
                    Number(analyticsDropDraft) < analyticsAlerts.minDropDeltaPct ||
                    Number(analyticsDropDraft) > analyticsAlerts.maxDropDeltaPct
                  }
                  onClick={() =>
                    analyticsAlertsMutation.mutate({ dropDeltaPct: Number(analyticsDropDraft) })
                  }
                >
                  Save
                </Button>
                {analyticsAlerts.dropDeltaPct !== analyticsAlerts.defaultDropDeltaPct && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-gray-500"
                    data-testid="button-front-analytics-drop-delta-reset"
                    disabled={analyticsAlertsMutation.isPending}
                    onClick={() =>
                      analyticsAlertsMutation.mutate({ dropDeltaPct: analyticsAlerts.defaultDropDeltaPct })
                    }
                  >
                    Reset to {analyticsAlerts.defaultDropDeltaPct}
                  </Button>
                )}
                <span className="text-xs text-gray-500">
                  Range: {analyticsAlerts.minDropDeltaPct}–{analyticsAlerts.maxDropDeltaPct} (default {analyticsAlerts.defaultDropDeltaPct}).
                </span>
                <div className="basis-full">
                  <LastEditedBadge
                    info={analyticsAlerts.dropDeltaPctLastEdited ?? undefined}
                    testId="last-edited-front-analytics-drop-delta"
                    emptyText="Drop delta using default — never overridden"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap pt-2" data-testid="row-front-analytics-alerts-floor">
                <span className="text-xs text-gray-600">Below-floor alert when any month's applied coverage falls under</span>
                <Input
                  type="number"
                  min={analyticsAlerts.minMonthFloorPct}
                  max={analyticsAlerts.maxMonthFloorPct}
                  step={0.1}
                  value={analyticsFloorDraft}
                  onChange={(e) => setAnalyticsFloorDraft(e.target.value)}
                  className="h-7 w-24 text-xs"
                  data-testid="input-front-analytics-month-floor"
                />
                <span className="text-xs text-gray-600">%</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  data-testid="button-front-analytics-month-floor-save"
                  disabled={
                    analyticsAlertsMutation.isPending ||
                    analyticsFloorDraft === "" ||
                    Number(analyticsFloorDraft) === analyticsAlerts.monthFloorPct ||
                    !Number.isFinite(Number(analyticsFloorDraft)) ||
                    Number(analyticsFloorDraft) < analyticsAlerts.minMonthFloorPct ||
                    Number(analyticsFloorDraft) > analyticsAlerts.maxMonthFloorPct
                  }
                  onClick={() =>
                    analyticsAlertsMutation.mutate({ monthFloorPct: Number(analyticsFloorDraft) })
                  }
                >
                  Save
                </Button>
                {analyticsAlerts.monthFloorPct !== analyticsAlerts.defaultMonthFloorPct && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-gray-500"
                    data-testid="button-front-analytics-month-floor-reset"
                    disabled={analyticsAlertsMutation.isPending}
                    onClick={() =>
                      analyticsAlertsMutation.mutate({ monthFloorPct: analyticsAlerts.defaultMonthFloorPct })
                    }
                  >
                    Reset to {analyticsAlerts.defaultMonthFloorPct}
                  </Button>
                )}
                <span className="text-xs text-gray-500">
                  Range: {analyticsAlerts.minMonthFloorPct}–{analyticsAlerts.maxMonthFloorPct} (default {analyticsAlerts.defaultMonthFloorPct}).
                </span>
                <div className="basis-full">
                  <LastEditedBadge
                    info={analyticsAlerts.monthFloorPctLastEdited ?? undefined}
                    testId="last-edited-front-analytics-month-floor"
                    emptyText="Month floor using default — never overridden"
                  />
                </div>
              </div>

              <div
                className="flex items-center gap-2 flex-wrap pt-2 border-t mt-2"
                data-testid="row-front-analytics-alerts-completeness"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-gray-600">
                    Alert on finalized months with masked gaps (ingest/apply/not-measured)
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={analyticsAlerts.completenessAlertsEnabled ? "outline" : "ghost"}
                  className="h-7 px-2 text-xs"
                  data-testid="button-front-analytics-completeness-toggle"
                  disabled={analyticsAlertsMutation.isPending}
                  onClick={() =>
                    analyticsAlertsMutation.mutate({
                      completenessAlertsEnabled: !analyticsAlerts.completenessAlertsEnabled,
                    })
                  }
                >
                  {analyticsAlerts.completenessAlertsEnabled ? "Enabled" : "Disabled"}
                </Button>
                <span className="text-xs text-gray-500 basis-full">
                  Default {analyticsAlerts.defaultCompletenessAlertsEnabled ? "on" : "off"}.
                </span>
                <div className="basis-full">
                  <LastEditedBadge
                    info={analyticsAlerts.completenessAlertsEnabledLastEdited ?? undefined}
                    testId="last-edited-front-analytics-completeness"
                    emptyText="Completeness alerts using default — never overridden"
                  />
                </div>
              </div>

              {/* Task #2834 — floor-raise (denominator raised upward) alert
                  toggle + material-regrowth threshold, backed by the Task
                  #2819 settings. */}
              <div
                className="flex items-center gap-2 flex-wrap pt-2 border-t mt-2"
                data-testid="row-front-analytics-alerts-floor-raise"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-gray-600">
                    Alert when a month's message denominator is corrected upward (floor raise)
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={analyticsAlerts.floorRaiseAlertsEnabled ? "outline" : "ghost"}
                  className="h-7 px-2 text-xs"
                  data-testid="button-front-analytics-floor-raise-toggle"
                  disabled={analyticsAlertsMutation.isPending}
                  onClick={() =>
                    analyticsAlertsMutation.mutate({
                      floorRaiseAlertsEnabled: !analyticsAlerts.floorRaiseAlertsEnabled,
                    })
                  }
                >
                  {analyticsAlerts.floorRaiseAlertsEnabled ? "Enabled" : "Disabled"}
                </Button>
                <span className="text-xs text-gray-500 basis-full">
                  Default {analyticsAlerts.defaultFloorRaiseAlertsEnabled ? "on" : "off"}.
                </span>
                <div className="basis-full">
                  <LastEditedBadge
                    info={analyticsAlerts.floorRaiseAlertsEnabledLastEdited ?? undefined}
                    testId="last-edited-front-analytics-floor-raise-enabled"
                    emptyText="Floor-raise alerts using default — never overridden"
                  />
                </div>
              </div>

              <div
                className="flex items-center gap-2 flex-wrap pt-2"
                data-testid="row-front-analytics-alerts-floor-raise-regrowth"
              >
                <span className="text-xs text-gray-600">Re-alert an already-alerted month only when its excess regrows by ≥</span>
                <Input
                  type="number"
                  min={analyticsAlerts.minFloorRaiseRegrowthPct}
                  max={analyticsAlerts.maxFloorRaiseRegrowthPct}
                  step={1}
                  value={analyticsRegrowthDraft}
                  onChange={(e) => setAnalyticsRegrowthDraft(e.target.value)}
                  className="h-7 w-24 text-xs"
                  data-testid="input-front-analytics-floor-raise-regrowth"
                />
                <span className="text-xs text-gray-600">%</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  data-testid="button-front-analytics-floor-raise-regrowth-save"
                  disabled={
                    analyticsAlertsMutation.isPending ||
                    analyticsRegrowthDraft === "" ||
                    Number(analyticsRegrowthDraft) === analyticsAlerts.floorRaiseRegrowthPct ||
                    !Number.isFinite(Number(analyticsRegrowthDraft)) ||
                    Number(analyticsRegrowthDraft) < analyticsAlerts.minFloorRaiseRegrowthPct ||
                    Number(analyticsRegrowthDraft) > analyticsAlerts.maxFloorRaiseRegrowthPct
                  }
                  onClick={() =>
                    analyticsAlertsMutation.mutate({
                      floorRaiseRegrowthPct: Number(analyticsRegrowthDraft),
                    })
                  }
                >
                  Save
                </Button>
                {analyticsAlerts.floorRaiseRegrowthPct !== analyticsAlerts.defaultFloorRaiseRegrowthPct && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-gray-500"
                    data-testid="button-front-analytics-floor-raise-regrowth-reset"
                    disabled={analyticsAlertsMutation.isPending}
                    onClick={() =>
                      analyticsAlertsMutation.mutate({
                        floorRaiseRegrowthPct: analyticsAlerts.defaultFloorRaiseRegrowthPct,
                      })
                    }
                  >
                    Reset to {analyticsAlerts.defaultFloorRaiseRegrowthPct}
                  </Button>
                )}
                <span className="text-xs text-gray-500">
                  Range: {analyticsAlerts.minFloorRaiseRegrowthPct}–{analyticsAlerts.maxFloorRaiseRegrowthPct} (default {analyticsAlerts.defaultFloorRaiseRegrowthPct}).
                </span>
                <div className="basis-full">
                  <LastEditedBadge
                    info={analyticsAlerts.floorRaiseRegrowthPctLastEdited ?? undefined}
                    testId="last-edited-front-analytics-floor-raise-regrowth"
                    emptyText="Floor-raise regrowth using default — never overridden"
                  />
                </div>
              </div>

              <div className="pt-2">
                <LastEditedBadge
                  info={analyticsAlerts.enabledLastEdited ?? undefined}
                  testId="last-edited-front-analytics-alerts-enabled"
                  emptyText="Enabled flag using default — never overridden"
                />
              </div>
            </div>
          )}
    </>
  );
}
