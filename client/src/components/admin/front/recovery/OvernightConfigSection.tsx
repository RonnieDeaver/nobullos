// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type {
  IntegrationStatus,
  OvernightConfigResponse,
  OvernightConfigUpdateResponse,
  OvernightConfigValues,
} from "./types";

type Props = {
  isAdmin: boolean;
  status: IntegrationStatus | undefined;
};

export function OvernightConfigSection({ isAdmin, status }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();


  // Task #1695 — overnight aggressive-mode editor.
  const { data: overnightConfig, refetch: refetchOvernight } = useQuery<OvernightConfigResponse>({
    queryKey: ["/api/admin/front/auto-closure/overnight"],
    enabled: isAdmin && !!status?.front.connected,
  });

  const [overnightDraft, setOvernightDraft] = useState<{
    timezone: string;
    startHour: string;
    endHour: string;
    retryBudget: string;
    ingestRecoveryBudget: string;
    applyNudgeBudget: string;
  }>({
    timezone: "",
    startHour: "",
    endHour: "",
    retryBudget: "",
    ingestRecoveryBudget: "",
    applyNudgeBudget: "",
  });

  // Reseed the draft from extracted primitive fields (not the whole config
  // object) so the effect body and deps agree, and refetches that return an
  // unchanged config can't clobber in-progress edits.
  const overnightHasConfig = Boolean(overnightConfig?.config);

  const overnightTimezone = overnightConfig?.config?.timezone;

  const overnightStartHour = overnightConfig?.config?.startHour;

  const overnightEndHour = overnightConfig?.config?.endHour;

  const overnightRetryBudget = overnightConfig?.config?.retryBudget;

  const overnightIngestRecoveryBudget = overnightConfig?.config?.ingestRecoveryBudget;

  const overnightApplyNudgeBudget = overnightConfig?.config?.applyNudgeBudget;

  useEffect(() => {
    if (overnightHasConfig) {
      setOvernightDraft({
        timezone: String(overnightTimezone ?? ""),
        startHour: String(overnightStartHour ?? ""),
        endHour: String(overnightEndHour ?? ""),
        retryBudget: String(overnightRetryBudget ?? ""),
        ingestRecoveryBudget: String(overnightIngestRecoveryBudget ?? ""),
        applyNudgeBudget: String(overnightApplyNudgeBudget ?? ""),
      });
    }
  }, [
    overnightHasConfig,
    overnightTimezone,
    overnightStartHour,
    overnightEndHour,
    overnightRetryBudget,
    overnightIngestRecoveryBudget,
    overnightApplyNudgeBudget,
  ]);

  const overnightMutation = useMutation<
    OvernightConfigUpdateResponse,
    Error,
    Partial<OvernightConfigValues>
  >({
    mutationFn: async (body) => {
      const res = await apiRequest("PUT", "/api/admin/front/auto-closure/overnight", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Overnight aggressive-mode setting updated." });
      void refetchOvernight(); // fire-and-forget: refetch only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/front/auto-closure/status"] }); // fire-and-forget: cache refresh only
    },
    onError: (err) => {
      toast({
        title: "Failed to save overnight setting",
        description: err.message,
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  return (
    <>
        {/* Task #1695 — overnight aggressive-mode editor. */}
        {overnightConfig && overnightConfig.config && overnightConfig.defaults && overnightConfig.bounds && (
          <div
            className="mt-2 border rounded-[var(--radius-lg)] p-3 bg-slate-50"
            data-testid="section-front-auto-closure-overnight"
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div>
                <h5 className="text-xs font-semibold text-gray-700">
                  Overnight aggressive mode
                </h5>
                <p className="text-xs text-gray-500">
                  Tune the nightly window and per-tick budgets the auto-closer uses
                  outside business hours. Changes are audit-logged. Current mode:{" "}
                  <span data-testid="text-overnight-current-mode">
                    {overnightConfig.currentMode}
                  </span>
                  .
                </p>
              </div>
              <Button
                size="sm"
                variant={overnightConfig?.config?.enabled ? "outline" : "ghost"}
                className="h-7 px-2 text-xs"
                data-testid="button-overnight-toggle"
                disabled={overnightMutation.isPending}
                onClick={() =>
                  overnightMutation.mutate({ enabled: !overnightConfig?.config?.enabled })
                }
              >
                {overnightConfig?.config?.enabled ? "Enabled" : "Disabled"}
              </Button>
            </div>

            <div className="flex items-center gap-2 flex-wrap pt-1" data-testid="row-overnight-timezone">
              <span className="text-xs text-gray-600 w-44">Timezone</span>
              <Input
                type="text"
                value={overnightDraft.timezone}
                onChange={(e) =>
                  setOvernightDraft((d) => ({ ...d, timezone: e.target.value }))
                }
                className="h-7 w-56 text-xs"
                data-testid="input-overnight-timezone"
                placeholder={overnightConfig.defaults.timezone}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                data-testid="button-overnight-timezone-save"
                disabled={
                  overnightMutation.isPending ||
                  overnightDraft.timezone === "" ||
                  overnightDraft.timezone === overnightConfig.config.timezone
                }
                onClick={() =>
                  overnightMutation.mutate({ timezone: overnightDraft.timezone })
                }
              >
                Save
              </Button>
              {overnightConfig.config.timezone !== overnightConfig.defaults.timezone && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-gray-500"
                  data-testid="button-overnight-timezone-reset"
                  disabled={overnightMutation.isPending}
                  onClick={() =>
                    overnightMutation.mutate({ timezone: overnightConfig.defaults.timezone })
                  }
                >
                  Reset to {overnightConfig.defaults.timezone}
                </Button>
              )}
            </div>

            {(
              [
                {
                  field: "startHour",
                  label: "Start hour (0–23)",
                  min: overnightConfig.bounds.hourMin,
                  max: overnightConfig.bounds.hourMax,
                } as const,
                {
                  field: "endHour",
                  label: "End hour (exclusive, 0–23)",
                  min: overnightConfig.bounds.hourMin,
                  max: overnightConfig.bounds.hourMax,
                } as const,
                {
                  field: "retryBudget",
                  label: "Retry budget",
                  min: overnightConfig.bounds.retryBudgetMin,
                  max: overnightConfig.bounds.retryBudgetMax,
                } as const,
                {
                  field: "ingestRecoveryBudget",
                  label: "Ingest recovery budget",
                  min: overnightConfig.bounds.ingestRecoveryBudgetMin,
                  max: overnightConfig.bounds.ingestRecoveryBudgetMax,
                } as const,
                {
                  field: "applyNudgeBudget",
                  label: "Apply nudge budget",
                  min: overnightConfig.bounds.applyNudgeBudgetMin,
                  max: overnightConfig.bounds.applyNudgeBudgetMax,
                } as const,
              ]
            ).map(({ field, label, min, max }) => {
              const draft = overnightDraft[field];
              const current = overnightConfig.config[field] as number;
              const def = overnightConfig.defaults[field] as number;
              const numeric = Number(draft);
              const invalid =
                draft === "" ||
                !Number.isFinite(numeric) ||
                Math.floor(numeric) !== numeric ||
                numeric < min ||
                numeric > max;
              return (
                <div
                  key={field}
                  className="flex items-center gap-2 flex-wrap pt-2"
                  data-testid={`row-overnight-${field}`}
                >
                  <span className="text-xs text-gray-600 w-44">{label}</span>
                  <Input
                    type="number"
                    min={min}
                    max={max}
                    step={1}
                    value={draft}
                    onChange={(e) =>
                      setOvernightDraft((d) => ({ ...d, [field]: e.target.value }))
                    }
                    className="h-7 w-28 text-xs"
                    data-testid={`input-overnight-${field}`}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    data-testid={`button-overnight-${field}-save`}
                    disabled={
                      overnightMutation.isPending || invalid || numeric === current
                    }
                    onClick={() =>
                      overnightMutation.mutate({ [field]: numeric })
                    }
                  >
                    Save
                  </Button>
                  {current !== def && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-gray-500"
                      data-testid={`button-overnight-${field}-reset`}
                      disabled={overnightMutation.isPending}
                      onClick={() => overnightMutation.mutate({ [field]: def })}
                    >
                      Reset to {def}
                    </Button>
                  )}
                  <span className="text-xs text-gray-500">
                    Range: {min}–{max} (default {def}).
                  </span>
                </div>
              );
            })}
          </div>
        )}
    </>
  );
}
