// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type {
  CoverageMonth,
  IntegrationStatus,
  MessageGrainPendingMonth,
  MessageGrainUpgradeStatusResponse,
  ScopedDriverRunEnqueuedResponse,
  UpgradeMonthAttempt,
} from "./types";
import { extractBlockedReason } from "./shared";
import { PercentText } from "../PercentText";

type Props = {
  isAdmin: boolean;
  months: CoverageMonth[];
  status: IntegrationStatus | undefined;
};

export function MessageGrainUpgradeReadout({ isAdmin, months, status }: Props) {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Task #2365 — operator readout for the message-grain upgrade driver.
  // Surfaces finalized months still below `messages_all` grain (oldest
  // first) plus the last tick's outcome. Pure read; no Front API call.
  const { data: messageGrainUpgradeStatus } =
    useQuery<MessageGrainUpgradeStatusResponse>({
    queryKey: [
      "/api/admin/front/analytics-coverage/message-grain-upgrade-status",
    ],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: isTabVisible ? 60000 : false,
    refetchIntervalInBackground: false,
  });


  // Task #2365 — operator-triggered message-grain upgrade run. Enqueues a
  // `front_message_grain_upgrade` job. The route 503s when the upgrader is
  // disabled / queue-paused / kill-switched / per-message enumeration is
  // OFF / the Front auth breaker is open; surface those reasons instead of
  // a generic failure, then refresh the status readout on success. An
  // optional `month` (YYYY-MM) scopes the run to a single row (the per-row
  // "Upgrade" action); omit it for the budgeted oldest-first run.
  const messageGrainUpgradeMutation = useMutation<ScopedDriverRunEnqueuedResponse, Error, string | undefined>({
    meta: { silent: true },
    mutationFn: async (month?: string) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/analytics-coverage/upgrade-message-grain",
        month ? { month } : {},
      );
      return res.json();
    },
    onSuccess: (_data, month) => {
      toast({
        title: "Message-grain upgrade queued",
        description: month
          ? `Front message-grain upgrade enqueued for ${month}.`
          : "Front message-grain upgrade enqueued.",
      });
      void queryClient.invalidateQueries({
        queryKey: [
          "/api/admin/front/analytics-coverage/message-grain-upgrade-status",
        ],
      });
    },
    onError: (err: Error) => {
      const raw = err.message ?? "";
      let title = "Run failed";
      if (raw.includes("front_message_grain_upgrade_enabled=false")) {
        title = "Blocked: message-grain upgrader is disabled";
      } else if (raw.includes("queue paused")) {
        title = "Blocked: queue paused";
      } else if (raw.includes("KILL_SWITCH_NON_CRITICAL_SWEEPS")) {
        title = "Blocked: non-critical sweeps kill switch";
      } else if (raw.includes("per-message enumeration disabled")) {
        title = "Blocked: per-message enumeration is OFF";
      } else if (raw.includes("front auth breaker open")) {
        title = "Blocked: Front auth is down";
      }
      toast({ title, description: extractBlockedReason(raw), variant: "destructive" });
    },
  });

  return (
    <>
              {/* Task #2365 — message-grain upgrade driver readout. Finalized
                  months still below `messages_all` grain (oldest first) + the
                  last tick's outcome so operators can confirm the grain is
                  climbing toward 100% of messages and spot months stuck on a
                  hard-gap reason (per-message enumeration OFF / auth down). */}
              {(() => {
                if (!messageGrainUpgradeStatus) return null;
                const cfg = messageGrainUpgradeStatus.config ?? {};
                const lastRun = messageGrainUpgradeStatus.lastRun ?? null;
                const lastRunUnreadable =
                  messageGrainUpgradeStatus.lastRunStatus === "unreadable";
                const lastRunError =
                  typeof messageGrainUpgradeStatus.lastRunError === "string"
                    ? messageGrainUpgradeStatus.lastRunError
                    : null;
                const pendingMonths: MessageGrainPendingMonth[] = Array.isArray(
                  messageGrainUpgradeStatus.pendingMonths,
                )
                  ? messageGrainUpgradeStatus.pendingMonths
                  : [];
                const attempted: UpgradeMonthAttempt[] = Array.isArray(lastRun?.attempted)
                  ? lastRun.attempted
                  : [];
                const upgraded = attempted.filter(
                  (a) => a.outcome === "upgraded",
                ).length;
                const advanced = attempted.filter(
                  (a) => a.outcome === "advanced",
                ).length;
                const errored = attempted.filter(
                  (a) => a.outcome === "error",
                ).length;
                const outcomeLabel: Record<string, string> = {
                  upgraded: "upgraded → messages_all",
                  advanced: "advanced (still walking)",
                  already_message_grain: "already message grain",
                  error: "error",
                };
                // Mirror the route's 503 gates so "Run now" is disabled with a
                // calm reason instead of POSTing a run that can't help.
                const runDisabledReason = !cfg.enabled
                  ? "Message-grain upgrader is disabled"
                  : cfg.paused
                    ? "Queue is paused"
                    : cfg.killSwitchNonCriticalSweeps
                      ? "Non-critical sweeps kill switch is ON"
                      : !cfg.enumEnabled
                        ? "Per-message enumeration is OFF (hard gap)"
                        : cfg.frontAuthBreakerOpen
                          ? "Front auth is down"
                          : null;
                const runDisabled =
                  runDisabledReason != null ||
                  messageGrainUpgradeMutation.isPending;
                return (
                  <div
                    className="border rounded p-2 mb-3 bg-muted/50"
                    data-testid="section-front-message-grain-upgrade"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                      <h5 className="text-xs font-semibold text-foreground">
                        Message-grain upgrader
                      </h5>
                      <div className="flex items-center gap-1 flex-wrap">
                        <Badge
                          variant="outline"
                          className={
                            cfg.enabled
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-muted text-muted-foreground border-border"
                          }
                          data-testid="badge-message-grain-enabled"
                        >
                          {cfg.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={
                            cfg.enumEnabled
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-amber-50 text-amber-800 border-amber-200"
                          }
                          title={cfg.enumSwitch}
                          data-testid="badge-message-grain-enum"
                        >
                          {cfg.enumEnabled
                            ? "enumeration ON"
                            : "enumeration OFF (hard gap)"}
                        </Badge>
                        {cfg.frontAuthBreakerOpen ? (
                          <Badge
                            variant="outline"
                            className="bg-red-50 text-red-700 border-red-200"
                            data-testid="badge-message-grain-auth-down"
                          >
                            auth down
                          </Badge>
                        ) : null}
                        {cfg.paused ? (
                          <Badge
                            variant="outline"
                            className="bg-amber-50 text-amber-800 border-amber-200"
                            data-testid="badge-message-grain-paused"
                          >
                            queue paused
                          </Badge>
                        ) : null}
                        <Badge
                          variant="outline"
                          className="bg-card text-muted-foreground border-border"
                          data-testid="badge-message-grain-budget"
                        >
                          {cfg.maxMonthsPerTick}/tick
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={runDisabled}
                          title={
                            runDisabledReason ??
                            "Enqueue a message-grain upgrade run now"
                          }
                          onClick={() =>
                            messageGrainUpgradeMutation.mutate(undefined)
                          }
                          data-testid="button-run-message-grain-upgrade"
                        >
                          {messageGrainUpgradeMutation.isPending
                            ? "Running…"
                            : "Run now"}
                        </Button>
                      </div>
                    </div>
                    {runDisabledReason ? (
                      <p
                        className="text-xs text-amber-700 mb-1"
                        data-testid="text-message-grain-run-disabled-reason"
                      >
                        {runDisabledReason} — enable it before running.
                      </p>
                    ) : null}

                    <p
                      className="text-xs text-foreground"
                      data-testid="text-message-grain-last-run"
                    >
                      {lastRun ? (
                        <>
                          Last tick{" "}
                          {lastRun.ranAt
                            ? new Date(lastRun.ranAt).toLocaleString()
                            : "—"}
                          : {lastRun.candidateMonths ?? 0} candidate month
                          {(lastRun.candidateMonths ?? 0) === 1 ? "" : "s"},{" "}
                          {upgraded} upgraded, {advanced} advanced, {errored}{" "}
                          errored.
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
                        "The upgrader has not run yet."
                      )}
                    </p>

                    {lastRunUnreadable ? (
                      <p
                        className="text-xs text-red-700 mt-1"
                        data-testid="text-message-grain-last-run-unreadable"
                      >
                        ⚠ The stored last-run status could not be read — this
                        usually means the saved value is corrupt (a persistence
                        bug), not that the upgrader never ran. Check the server
                        logs.
                        {lastRunError ? (
                          <span className="block text-xs text-red-600 font-mono mt-0.5">
                            {lastRunError}
                          </span>
                        ) : null}
                      </p>
                    ) : null}

                    {attempted.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {attempted.map((a, i) => (
                          <span
                            key={`${a.month}-${i}`}
                            className="text-xs px-1.5 py-0.5 rounded border bg-card text-foreground"
                            data-testid={`chip-message-grain-attempt-${a.month}`}
                            title={a.errorCode ? `error: ${a.errorCode}` : undefined}
                          >
                            <span className="font-mono">{a.month}</span>{" "}
                            {outcomeLabel[a.outcome] ?? a.outcome}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="mt-2">
                      <div className="text-xs text-muted-foreground mb-0.5">
                        Finalized months below message grain (oldest first)
                      </div>
                      {pendingMonths.length === 0 ? (
                        <div
                          className="text-xs text-emerald-700"
                          data-testid="text-message-grain-none"
                        >
                          All finalized months are at message grain.
                        </div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table
                            className="w-full text-xs"
                            data-testid="table-message-grain-months"
                          >
                            <thead className="text-muted-foreground">
                              <tr className="border-b">
                                <th className="text-left py-0.5 px-1">Month</th>
                                <th className="text-left py-0.5 px-1">
                                  Current grain
                                </th>
                                <th className="text-right py-0.5 px-1">
                                  Coverage %
                                </th>
                                <th className="text-right py-0.5 px-1">
                                  Action
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {pendingMonths.map((m) => {
                                const pendingMonth =
                                  messageGrainUpgradeMutation.variables;
                                const isRowRunning =
                                  messageGrainUpgradeMutation.isPending &&
                                  pendingMonth === m.month;
                                const rowRunDisabled =
                                  runDisabledReason != null ||
                                  messageGrainUpgradeMutation.isPending;
                                return (
                                  <tr
                                    key={m.month}
                                    className="border-b last:border-0"
                                    data-testid={`row-message-grain-${m.month}`}
                                  >
                                    <td className="py-0.5 px-1 font-mono">
                                      {m.month}
                                    </td>
                                    <td
                                      className="py-0.5 px-1 font-mono text-muted-foreground"
                                      data-testid={`text-message-grain-unit-${m.month}`}
                                    >
                                      {m.denominatorUnit ?? "—"}
                                    </td>
                                    <td className="py-0.5 px-1 text-right">
                                      <PercentText
                                        value={m.appliedCoveragePct}
                                        digits={1}
                                      />
                                    </td>
                                    <td className="py-0.5 px-1 text-right">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-5 px-2 text-xs"
                                        disabled={rowRunDisabled}
                                        title={
                                          runDisabledReason ??
                                          `Upgrade ${m.month} toward message grain`
                                        }
                                        onClick={() =>
                                          messageGrainUpgradeMutation.mutate(
                                            m.month,
                                          )
                                        }
                                        data-testid={`button-run-message-grain-${m.month}`}
                                      >
                                        {isRowRunning ? "Running…" : "Upgrade"}
                                      </Button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
    </>
  );
}
