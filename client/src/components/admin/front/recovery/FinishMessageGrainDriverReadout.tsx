// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type {
  DriverRunEnqueuedResponse,
  FinishMessageGrainDriverStatusResponse,
  IntegrationStatus,
} from "./types";
import { extractBlockedReason } from "./shared";

type Props = {
  isAdmin: boolean;
  status: IntegrationStatus | undefined;
};

export function FinishMessageGrainDriverReadout({ isAdmin, status }: Props) {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Task #2558 — operator readout for the Task #2529 scheduled
  // `front_finish_message_grain` driver. Surfaces its gating config plus the
  // last tick's persisted summary so an operator can see what the driver last
  // did. Pure read; no Front API call.
  const { data: finishMessageGrainDriverStatus } =
    useQuery<FinishMessageGrainDriverStatusResponse>({
    queryKey: [
      "/api/admin/front/analytics-coverage/finish-message-grain-driver-status",
    ],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: isTabVisible ? 60000 : false,
    refetchIntervalInBackground: false,
  });


  // Task #2558 — operator-triggered tick for the Task #2529 scheduled
  // `front_finish_message_grain` driver. Enqueues a single tick so the operator
  // need not wait up to an hour after flipping the switch. The route 503s when
  // the driver is disabled / queue-paused / kill-switched / the Front auth
  // breaker is open; surface those reasons instead of a generic failure, then
  // refresh the driver status readout on success.
  const finishMessageGrainDriverMutation = useMutation<
    DriverRunEnqueuedResponse,
    Error,
    void
  >({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/analytics-coverage/finish-message-grain-driver-run",
        {},
      );
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Finish-message-grain tick queued",
        description: "Front finish-message-grain driver tick enqueued.",
      });
      void queryClient.invalidateQueries({
        queryKey: [
          "/api/admin/front/analytics-coverage/finish-message-grain-driver-status",
        ],
      });
    },
    onError: (err: Error) => {
      const raw = err.message ?? "";
      let title = "Run failed";
      if (raw.includes("front_finish_message_grain_enabled=false")) {
        title = "Blocked: finish-message-grain driver is disabled";
      } else if (raw.includes("queue paused")) {
        title = "Blocked: queue paused";
      } else if (raw.includes("KILL_SWITCH_NON_CRITICAL_SWEEPS")) {
        title = "Blocked: non-critical sweeps kill switch";
      } else if (raw.includes("front auth breaker open")) {
        title = "Blocked: Front auth is down";
      }
      toast({ title, description: extractBlockedReason(raw), variant: "destructive" });
    },
  });

  return (
    <>
              {/* Task #2558 — finish-message-grain DRIVER readout. The Task
                  #2529 scheduled driver finishes every in-scope month to
                  message grain on a 60-min cadence; this surface lets an
                  operator see what its last tick did and kick a run on demand
                  instead of waiting up to an hour. Distinct from the manual
                  Task #2511 consolidated control above. */}
              {(() => {
                if (!finishMessageGrainDriverStatus) return null;
                const cfg = finishMessageGrainDriverStatus.config ?? {};
                const lastRun = finishMessageGrainDriverStatus.lastRun ?? null;
                const lastRunUnreadable =
                  finishMessageGrainDriverStatus.lastRunStatus === "unreadable";
                const lastRunError =
                  typeof finishMessageGrainDriverStatus.lastRunError === "string"
                    ? finishMessageGrainDriverStatus.lastRunError
                    : null;
                // Mirror the route's 503 gates so "Run now" is disabled with a
                // calm reason instead of POSTing a tick that can't help.
                const runDisabledReason = !cfg.enabled
                  ? "Finish-message-grain driver is disabled"
                  : cfg.paused
                    ? "Queue is paused"
                    : cfg.killSwitchNonCriticalSweeps
                      ? "Non-critical sweeps kill switch is ON"
                      : cfg.frontAuthBreakerOpen
                        ? "Front auth is down"
                        : null;
                const runDisabled =
                  runDisabledReason != null ||
                  finishMessageGrainDriverMutation.isPending;
                return (
                  <div
                    className="border rounded p-2 mb-3 bg-slate-50"
                    data-testid="section-front-finish-message-grain-driver"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                      <h5 className="text-xs font-semibold text-gray-700">
                        Finish-message-grain driver
                      </h5>
                      <div className="flex items-center gap-1 flex-wrap">
                        <Badge
                          variant="outline"
                          className={
                            cfg.enabled
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-gray-100 text-gray-600 border-gray-200"
                          }
                          data-testid="badge-finish-message-grain-driver-enabled"
                        >
                          {cfg.enabled ? "enabled" : "disabled"}
                        </Badge>
                        {cfg.frontAuthBreakerOpen ? (
                          <Badge
                            variant="outline"
                            className="bg-red-50 text-red-700 border-red-200"
                            data-testid="badge-finish-message-grain-driver-auth-down"
                          >
                            auth down
                          </Badge>
                        ) : null}
                        {cfg.paused ? (
                          <Badge
                            variant="outline"
                            className="bg-amber-50 text-amber-800 border-amber-200"
                            data-testid="badge-finish-message-grain-driver-paused"
                          >
                            queue paused
                          </Badge>
                        ) : null}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={runDisabled}
                          title={
                            runDisabledReason ??
                            "Enqueue a finish-message-grain driver tick now"
                          }
                          onClick={() =>
                            finishMessageGrainDriverMutation.mutate()
                          }
                          data-testid="button-run-finish-message-grain-driver"
                        >
                          {finishMessageGrainDriverMutation.isPending
                            ? "Running…"
                            : "Run now"}
                        </Button>
                      </div>
                    </div>
                    {runDisabledReason ? (
                      <p
                        className="text-xs text-amber-700 mb-1"
                        data-testid="text-finish-message-grain-driver-run-disabled-reason"
                      >
                        {runDisabledReason} — enable it before running.
                      </p>
                    ) : null}

                    <p
                      className="text-xs text-gray-700"
                      data-testid="text-finish-message-grain-driver-last-run"
                    >
                      {lastRun ? (
                        <>
                          Last tick{" "}
                          {lastRun.ranAt
                            ? new Date(lastRun.ranAt).toLocaleString()
                            : "—"}
                          :{" "}
                          {lastRun.applied
                            ? `apply ran (${
                                lastRun.outcomeState ?? "unknown"
                              }${
                                typeof lastRun.rowsAffected === "number"
                                  ? `, ${lastRun.rowsAffected} row${
                                      lastRun.rowsAffected === 1 ? "" : "s"
                                    } relabeled`
                                  : ""
                              })`
                            : "no-op (gate fired)"}
                          .
                          {lastRun.detail ? (
                            <span className="text-gray-600">
                              {" "}
                              {lastRun.detail}
                            </span>
                          ) : null}
                          {lastRun.reason ? (
                            <span className="text-amber-700">
                              {" "}
                              {lastRun.reason}
                            </span>
                          ) : null}
                        </>
                      ) : lastRunUnreadable ? (
                        "Last run status is unavailable."
                      ) : (
                        "The driver has not run yet."
                      )}
                    </p>

                    {lastRunUnreadable ? (
                      <p
                        className="text-xs text-red-700 mt-1"
                        data-testid="text-finish-message-grain-driver-last-run-unreadable"
                      >
                        ⚠ The stored last-run status could not be read — this
                        usually means the saved value is corrupt (a persistence
                        bug), not that the driver never ran. Check the server
                        logs.
                        {lastRunError ? (
                          <span className="block text-xs text-red-600 font-mono mt-0.5">
                            {lastRunError}
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                );
              })()}
    </>
  );
}
