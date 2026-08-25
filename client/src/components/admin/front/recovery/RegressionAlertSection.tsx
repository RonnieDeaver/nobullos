// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type {
  IntegrationStatus,
  RegressionAlertReevaluateResponse,
  RegressionAlertStatusResponse,
} from "./types";

type Props = {
  isAdmin: boolean;
  status: IntegrationStatus | undefined;
};

export function RegressionAlertSection({ isAdmin, status }: Props) {
  const isTabVisible = useTabVisibility();
  const { toast } = useToast();


  // Task #1693 — Front auto-closure regression alert status.
  const {
    data: regressionAlertStatus,
    refetch: refetchRegressionAlertStatus,
  } = useQuery<RegressionAlertStatusResponse>({
    queryKey: ["/api/admin/front/auto-closure/regression-alert-status"],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: isTabVisible ? 60000 : false,
    refetchIntervalInBackground: false,
  });

  const [expandedFiredIdx, setExpandedFiredIdx] = useState<number | null>(null);

  const regressionAlertReevaluateMutation = useMutation<
    RegressionAlertReevaluateResponse,
    Error,
    void
  >({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/auto-closure/regression-alert-status/re-evaluate",
        {},
      );
      return res.json();
    },
    onSuccess: (data) => {
      const fired = data.result.fired?.length ?? 0;
      toast({
        title: `Re-evaluated: ${data.result.decision}`,
        description:
          fired > 0
            ? `${fired} alert${fired === 1 ? "" : "s"} fired`
            : data.result.skipReason ?? "No alerts fired",
      });
      void refetchRegressionAlertStatus(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      toast({
        title: "Re-evaluation failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <>
        {/* Task #1693 — Front auto-closure regression alert status. */}
        {regressionAlertStatus && regressionAlertStatus.thresholds && (
          <div
            className="text-xs text-foreground bg-muted/50 border border-border rounded p-2 mt-2 space-y-2"
            data-testid="panel-front-auto-closure-regression-alerts"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <span className="font-medium">Regression alerts:</span>{" "}
                <span data-testid="text-fa-regression-enabled">
                  {regressionAlertStatus.enabled ? "on" : "off"}
                </span>
                {" · last evaluated "}
                <span data-testid="text-fa-regression-last-evaluated">
                  {regressionAlertStatus.lastEvaluatedAt
                    ? new Date(regressionAlertStatus.lastEvaluatedAt).toLocaleString()
                    : "never"}
                </span>
                {" · last observed tick "}
                <span data-testid="text-fa-regression-last-observed">
                  {regressionAlertStatus.lastObservedRanAt
                    ? new Date(regressionAlertStatus.lastObservedRanAt).toLocaleString()
                    : "—"}
                </span>
                {regressionAlertStatus.sameSkipReason ? (
                  <>
                    {" · same-skip streak "}
                    <span data-testid="text-fa-regression-same-skip">
                      {regressionAlertStatus.sameSkipStreak}× ({regressionAlertStatus.sameSkipReason})
                    </span>
                  </>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => regressionAlertReevaluateMutation.mutate()}
                disabled={regressionAlertReevaluateMutation.isPending}
                data-testid="button-fa-regression-reevaluate"
              >
                {regressionAlertReevaluateMutation.isPending ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3 mr-1" />
                )}
                Re-evaluate now
              </Button>
            </div>

            <div
              className="text-xs text-muted-foreground"
              data-testid="text-fa-regression-thresholds"
            >
              Thresholds: gap-growth {regressionAlertStatus.thresholds.gapGrowthTicks} ticks ·
              silent {regressionAlertStatus.thresholds.silentMinutes} min ·
              same-gate {regressionAlertStatus.thresholds.sameGateSkipTicks} ticks ·
              no-convergence {regressionAlertStatus.thresholds.noConvergenceRuns} runs ·
              unrecovered {regressionAlertStatus.thresholds.unrecoveredRetryAttempts} ticks ·
              cooldown {regressionAlertStatus.cooldownMinutes} min ·
              kill switch <code>{regressionAlertStatus.killSwitchKey}</code>
            </div>

            <div data-testid="section-fa-regression-armed">
              <div className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Armed dedupes ({regressionAlertStatus.armedDedupes?.length ?? 0})
              </div>
              {(regressionAlertStatus.armedDedupes?.length ?? 0) === 0 ? (
                <div className="text-xs text-muted-foreground" data-testid="text-fa-regression-armed-empty">
                  None — no condition is currently in cooldown.
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {regressionAlertStatus.armedDedupes.map((d, i) => (
                    <li
                      key={`${d.scope}-${d.condition}-${d.month ?? "global"}-${i}`}
                      className="text-xs flex flex-wrap gap-x-2"
                      data-testid={`row-fa-regression-armed-${i}`}
                    >
                      <span className="font-mono text-amber-700">{d.condition}</span>
                      {d.month ? <span className="text-muted-foreground">month {d.month}</span> : <span className="text-muted-foreground">(global)</span>}
                      <span className="text-muted-foreground">fired {new Date(d.firedAt).toLocaleString()}</span>
                      <span className="text-muted-foreground">expires {new Date(d.expiresAt).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div data-testid="section-fa-regression-recent">
              <div className="font-medium text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Most recent fired ({regressionAlertStatus.recentFired?.length ?? 0})
              </div>
              {(regressionAlertStatus.recentFired?.length ?? 0) === 0 ? (
                <div className="text-xs text-muted-foreground" data-testid="text-fa-regression-recent-empty">
                  No regression alerts have fired since the state was last reset.
                </div>
              ) : (
                <ul className="space-y-1">
                  {regressionAlertStatus.recentFired.slice(0, 10).map((f, i) => {
                    const expanded = expandedFiredIdx === i;
                    return (
                      <li
                        key={`${f.firedAt}-${f.condition}-${i}`}
                        className="border border-border rounded p-1.5 bg-card"
                        data-testid={`row-fa-regression-fired-${i}`}
                      >
                        <button
                          type="button"
                          className="w-full text-left flex flex-wrap items-center gap-x-2 text-xs"
                          onClick={() => setExpandedFiredIdx(expanded ? null : i)}
                          data-testid={`button-fa-regression-fired-toggle-${i}`}
                        >
                          {expanded ? (
                            <ChevronDown className="w-3 h-3 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-muted-foreground" />
                          )}
                          <span className="font-mono text-amber-700">{f.condition}</span>
                          {f.month ? <span className="text-muted-foreground">month {f.month}</span> : <span className="text-muted-foreground">(global)</span>}
                          <span className="text-muted-foreground">{new Date(f.firedAt).toLocaleString()}</span>
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded ${f.delivered ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}
                            data-testid={`badge-fa-regression-fired-delivered-${i}`}
                          >
                            {f.delivered ? "delivered" : f.skipReason ? `skipped: ${f.skipReason}` : "skipped"}
                          </span>
                        </button>
                        {expanded && (
                          <pre
                            className="mt-1 whitespace-pre-wrap text-xs font-mono text-foreground bg-muted/50 rounded p-1.5 border border-border"
                            data-testid={`text-fa-regression-fired-detail-${i}`}
                          >
                            {f.detail}
                          </pre>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
    </>
  );
}
