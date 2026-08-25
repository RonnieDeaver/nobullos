// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type {
  CoverageMonth,
  GapMonthAttempt,
  IntegrationStatus,
  OutboundGapMonthRow,
  OutboundGapStatusResponse,
  ScopedDriverRunEnqueuedResponse,
  UnreadableAlertConfigUpdateResponse,
} from "./types";
import { extractBlockedReason } from "./shared";

type Props = {
  isAdmin: boolean;
  months: CoverageMonth[];
  status: IntegrationStatus | undefined;
};

export function OutboundGapCloseReadout({ isAdmin, months, status }: Props) {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Task #2021 — operator readout for the outbound gap-close driver
  // (Task #1984). Surfaces per-month outbound gap (worst-first) plus the
  // last tick's outcome. Pure read; never triggers a Front API call.
  const { data: outboundGapStatus } = useQuery<OutboundGapStatusResponse>({
    queryKey: ["/api/admin/front/analytics-coverage/outbound-gap-status"],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: isTabVisible ? 60000 : false,
    refetchIntervalInBackground: false,
  });


  // Task #2025 — operator-triggered "Run now" for the outbound gap
  // closer (Task #1984). POSTs to the existing trigger route which
  // enqueues a `front_outbound_gap_close` job. The route returns calm
  // 503s when the closer is disabled / queue-paused / kill-switched /
  // per-message materialization is OFF; surface those reasons instead
  // of a generic failure, then refresh the status readout on success.
  // Task #2057 — a `month` (YYYY-MM) scopes the run to a single row in
  // the gap-months table (the per-row "Run" action); omit it to run the
  // worst-gap-first budgeted run (the header "Run now" button).
  const outboundGapCloseMutation = useMutation<ScopedDriverRunEnqueuedResponse, Error, string | undefined>({
    meta: { silent: true },
    mutationFn: async (month?: string) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/analytics-coverage/close-outbound-gap",
        month ? { month } : {},
      );
      return res.json();
    },
    onSuccess: (_data, month) => {
      toast({
        title: "Gap closer queued",
        description: month
          ? `Front outbound gap-close run enqueued for ${month}.`
          : "Front outbound gap-close run enqueued.",
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/admin/front/analytics-coverage/outbound-gap-status"],
      });
    },
    onError: (err: Error) => {
      const raw = err.message ?? "";
      let title = "Run failed";
      if (raw.includes("front_outbound_gap_close_enabled=false")) {
        title = "Blocked: outbound gap closer is disabled";
      } else if (raw.includes("queue paused")) {
        title = "Blocked: queue paused";
      } else if (raw.includes("KILL_SWITCH_NON_CRITICAL_SWEEPS")) {
        title = "Blocked: non-critical sweeps kill switch";
      } else if (raw.includes("per-message materialization disabled")) {
        title = "Blocked: per-message materialization is OFF";
      }
      // The route now returns a plain-English `reason` alongside the raw
      // machine `error`. apiRequest throws "<status>: <body-text>", so the
      // friendly sentence is embedded in the message — prefer it when present.
      toast({ title, description: extractBlockedReason(raw), variant: "destructive" });
    },
  });


  // Task #2236 — tune / mute the corrupt-status admin alert (Task #2197)
  // from the panel. Sends only the field(s) that changed.
  const [unreadableAlertCooldownInput, setUnreadableAlertCooldownInput] =
    useState<string>("");

  const unreadableAlertConfigMutation = useMutation<
    UnreadableAlertConfigUpdateResponse,
    Error,
    { cooldownMinutes?: number; muted?: boolean }
  >({
    meta: { silent: true },
    mutationFn: async (patch) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/analytics-coverage/unreadable-alert-config",
        patch,
      );
      return res.json();
    },
    onSuccess: (data, patch) => {
      toast({
        title:
          patch.muted !== undefined
            ? data.muted
              ? "Corrupt-status alert muted"
              : "Corrupt-status alert un-muted"
            : "Alert cooldown updated",
        description:
          patch.muted !== undefined && data.muted
            ? "Admins will no longer be pinged when the saved status goes corrupt."
            : `Cooldown is now ${data.cooldownMinutes} min between repeat alerts.`,
      });
      setUnreadableAlertCooldownInput("");
      void queryClient.invalidateQueries({
        queryKey: ["/api/admin/front/analytics-coverage/outbound-gap-status"],
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to update alert settings",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <>
              {/* Task #2021 — outbound gap-close driver readout (Task
                  #1984). Per-month outbound gap (worst-first) + the last
                  tick's outcome so operators can confirm the gap is
                  shrinking and spot months stuck on a hard-gap reason. */}
              {(() => {
                if (!outboundGapStatus) return null;
                const cfg = outboundGapStatus.config ?? {};
                const alertCfg = cfg.unreadableAlert ?? null;
                const lastRun = outboundGapStatus.lastRun ?? null;
                const lastRunUnreadable =
                  outboundGapStatus.lastRunStatus === "unreadable";
                const lastRunError =
                  typeof outboundGapStatus.lastRunError === "string"
                    ? outboundGapStatus.lastRunError
                    : null;
                const gapMonths: OutboundGapMonthRow[] = Array.isArray(outboundGapStatus.gapMonths)
                  ? outboundGapStatus.gapMonths
                  : [];
                const attempted: GapMonthAttempt[] = Array.isArray(lastRun?.attempted)
                  ? lastRun.attempted
                  : [];
                const triggered = attempted.filter(
                  (a) => a.outcome === "recovery_triggered",
                ).length;
                const deferred = attempted.filter(
                  (a) => a.outcome === "deferred_recovery_cap",
                ).length;
                const alreadyClosed = attempted.filter(
                  (a) => a.outcome === "already_closed",
                ).length;
                const outcomeLabel: Record<string, string> = {
                  recovery_triggered: "recovery triggered",
                  already_closed: "already closed",
                  front_count_unknown: "Front count unknown",
                  deferred_recovery_cap: "deferred (recovery cap)",
                };
                // Task #2025 — mirror the route's 503 gates so the
                // "Run now" button is disabled with a calm reason
                // instead of POSTing a run that can't help.
                const runDisabledReason = !cfg.enabled
                  ? "Outbound gap closer is disabled"
                  : cfg.paused
                    ? "Queue is paused"
                    : cfg.killSwitchNonCriticalSweeps
                      ? "Non-critical sweeps kill switch is ON"
                      : !cfg.materializationEnabled
                        ? "Per-message materialization is OFF (hard gap)"
                        : null;
                const runDisabled =
                  runDisabledReason != null || outboundGapCloseMutation.isPending;
                return (
                  <div
                    className="border rounded p-2 mb-3 bg-muted/50"
                    data-testid="section-front-outbound-gap-close"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                      <h5 className="text-xs font-semibold text-foreground">
                        Outbound gap closer
                      </h5>
                      <div className="flex items-center gap-1 flex-wrap">
                        <Badge
                          variant="outline"
                          className={
                            cfg.enabled
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-muted text-muted-foreground border-border"
                          }
                          data-testid="badge-outbound-gap-enabled"
                        >
                          {cfg.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={
                            cfg.materializationEnabled
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-amber-50 text-amber-800 border-amber-200"
                          }
                          title={cfg.materializationSwitch}
                          data-testid="badge-outbound-gap-materialization"
                        >
                          {cfg.materializationEnabled
                            ? "materialization ON"
                            : "materialization OFF (hard gap)"}
                        </Badge>
                        {cfg.paused ? (
                          <Badge
                            variant="outline"
                            className="bg-amber-50 text-amber-800 border-amber-200"
                            data-testid="badge-outbound-gap-paused"
                          >
                            queue paused
                          </Badge>
                        ) : null}
                        <Badge
                          variant="outline"
                          className="bg-card text-muted-foreground border-border"
                          data-testid="badge-outbound-gap-budget"
                        >
                          {cfg.maxMonthsPerTick}/tick
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={runDisabled}
                          title={runDisabledReason ?? "Enqueue an outbound gap-close run now"}
                          onClick={() => outboundGapCloseMutation.mutate(undefined)}
                          data-testid="button-run-outbound-gap-close"
                        >
                          {outboundGapCloseMutation.isPending ? "Running…" : "Run now"}
                        </Button>
                      </div>
                    </div>
                    {runDisabledReason ? (
                      <p
                        className="text-xs text-amber-700 mb-1"
                        data-testid="text-outbound-gap-run-disabled-reason"
                      >
                        {runDisabledReason} — enable it before running.
                      </p>
                    ) : null}

                    <p
                      className="text-xs text-foreground"
                      data-testid="text-outbound-gap-last-run"
                    >
                      {lastRun ? (
                        <>
                          Last tick{" "}
                          {lastRun.ranAt
                            ? new Date(lastRun.ranAt).toLocaleString()
                            : "—"}
                          : {lastRun.candidateMonths ?? 0} candidate month
                          {(lastRun.candidateMonths ?? 0) === 1 ? "" : "s"},{" "}
                          {triggered} triggered, {alreadyClosed} already closed,{" "}
                          {deferred} deferred (recovery cap).
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
                        "The closer has not run yet."
                      )}
                    </p>

                    {lastRunUnreadable ? (
                      <p
                        className="text-xs text-red-700 mt-1"
                        data-testid="text-outbound-gap-last-run-unreadable"
                      >
                        ⚠ The stored last-run status could not be read — this
                        usually means the saved value is corrupt (a persistence
                        bug), not that the closer never ran. Check the server
                        logs.
                        {lastRunError ? (
                          <span className="block text-xs text-red-600 font-mono mt-0.5">
                            {lastRunError}
                          </span>
                        ) : null}
                      </p>
                    ) : null}

                    {/* Task #2236 — tune / mute the proactive corrupt-status
                        admin alert (Task #2197) without touching raw system
                        settings. team_lead / CEO only (route is requireTeamLead). */}
                    {alertCfg ? (
                      <div
                        className="mt-2 border-t pt-2"
                        data-testid="section-outbound-gap-corrupt-alert"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-xs font-medium text-foreground">
                            Corrupt-status alert
                          </span>
                          <Badge
                            variant="outline"
                            className={
                              alertCfg.muted
                                ? "bg-muted text-muted-foreground border-border"
                                : "bg-emerald-50 text-emerald-700 border-emerald-200"
                            }
                            data-testid="badge-corrupt-alert-muted"
                          >
                            {alertCfg.muted
                              ? "muted"
                              : `every ${alertCfg.cooldownMinutes} min`}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {alertCfg.muted
                            ? "Admins are not pinged when the saved status goes corrupt. The warning above still shows here."
                            : "Admins get at most one ping per cooldown window when the saved status goes corrupt."}
                        </p>
                        <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                          <Label
                            htmlFor="input-corrupt-alert-cooldown"
                            className="text-xs text-muted-foreground"
                          >
                            Cooldown (min)
                          </Label>
                          <Input
                            id="input-corrupt-alert-cooldown"
                            type="number"
                            min={alertCfg.minCooldownMinutes}
                            max={alertCfg.maxCooldownMinutes}
                            value={unreadableAlertCooldownInput}
                            placeholder={String(alertCfg.cooldownMinutes)}
                            onChange={(e) =>
                              setUnreadableAlertCooldownInput(e.target.value)
                            }
                            className="h-6 w-20 text-xs"
                            disabled={
                              alertCfg.muted ||
                              unreadableAlertConfigMutation.isPending
                            }
                            data-testid="input-corrupt-alert-cooldown"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            disabled={
                              alertCfg.muted ||
                              unreadableAlertConfigMutation.isPending ||
                              unreadableAlertCooldownInput.trim() === "" ||
                              !Number.isInteger(
                                Number(unreadableAlertCooldownInput),
                              ) ||
                              Number(unreadableAlertCooldownInput) <
                                alertCfg.minCooldownMinutes ||
                              Number(unreadableAlertCooldownInput) >
                                alertCfg.maxCooldownMinutes
                            }
                            title={`Set the cooldown between ${alertCfg.minCooldownMinutes} and ${alertCfg.maxCooldownMinutes} minutes`}
                            onClick={() =>
                              unreadableAlertConfigMutation.mutate({
                                cooldownMinutes: Number(
                                  unreadableAlertCooldownInput,
                                ),
                              })
                            }
                            data-testid="button-corrupt-alert-cooldown-save"
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            disabled={unreadableAlertConfigMutation.isPending}
                            onClick={() =>
                              unreadableAlertConfigMutation.mutate({
                                muted: !alertCfg.muted,
                              })
                            }
                            data-testid="button-corrupt-alert-mute-toggle"
                          >
                            {alertCfg.muted ? "Un-mute" : "Mute"}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {attempted.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {attempted.map((a, i) => (
                          <span
                            key={`${a.month}-${i}`}
                            className="text-xs px-1.5 py-0.5 rounded border bg-card text-foreground"
                            data-testid={`chip-outbound-gap-attempt-${a.month}`}
                            title={
                              a.recoveryJobId
                                ? `recovery job ${a.recoveryJobId}`
                                : undefined
                            }
                          >
                            <span className="font-mono">{a.month}</span>{" "}
                            {outcomeLabel[a.outcome] ?? a.outcome}
                            {typeof a.remainingGap === "number"
                              ? ` · gap ${a.remainingGap.toLocaleString()}`
                              : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="mt-2">
                      <div className="text-xs text-muted-foreground mb-0.5">
                        Months with an outbound gap (worst first)
                      </div>
                      {gapMonths.length === 0 ? (
                        <div
                          className="text-xs text-emerald-700"
                          data-testid="text-outbound-gap-none"
                        >
                          No months currently report an outbound gap.
                        </div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table
                            className="w-full text-xs"
                            data-testid="table-outbound-gap-months"
                          >
                            <thead className="text-muted-foreground">
                              <tr className="border-b">
                                <th className="text-left py-0.5 px-1">Month</th>
                                <th className="text-right py-0.5 px-1">
                                  Front outbound
                                </th>
                                <th className="text-right py-0.5 px-1">
                                  Local outbound
                                </th>
                                <th className="text-right py-0.5 px-1">Gap</th>
                                <th className="text-right py-0.5 px-1">
                                  Action
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {gapMonths.map((m) => {
                                // Task #2057 — per-row "Run" re-drives just
                                // this month. Disabled for the same gating
                                // reasons as the header "Run now"; while any
                                // run is pending, only mark the row being run.
                                const pendingMonth =
                                  outboundGapCloseMutation.variables;
                                const isRowRunning =
                                  outboundGapCloseMutation.isPending &&
                                  pendingMonth === m.month;
                                const rowRunDisabled =
                                  runDisabledReason != null ||
                                  outboundGapCloseMutation.isPending;
                                return (
                                  <tr
                                    key={m.month}
                                    className="border-b last:border-0"
                                    data-testid={`row-outbound-gap-${m.month}`}
                                  >
                                    <td className="py-0.5 px-1 font-mono">
                                      {m.month}
                                    </td>
                                    <td className="py-0.5 px-1 text-right">
                                      {m.messagesOutboundFront == null
                                        ? "—"
                                        : Number(
                                            m.messagesOutboundFront,
                                          ).toLocaleString()}
                                    </td>
                                    <td className="py-0.5 px-1 text-right">
                                      {m.messagesOutboundLocal == null
                                        ? "—"
                                        : Number(
                                            m.messagesOutboundLocal,
                                          ).toLocaleString()}
                                    </td>
                                    <td
                                      className="py-0.5 px-1 text-right font-semibold text-amber-700"
                                      data-testid={`text-outbound-gap-value-${m.month}`}
                                    >
                                      {m.messagesOutboundGap == null
                                        ? "—"
                                        : Number(
                                            m.messagesOutboundGap,
                                          ).toLocaleString()}
                                    </td>
                                    <td className="py-0.5 px-1 text-right">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-5 px-2 text-xs"
                                        disabled={rowRunDisabled}
                                        title={
                                          runDisabledReason ??
                                          `Re-drive the outbound gap for ${m.month}`
                                        }
                                        onClick={() =>
                                          outboundGapCloseMutation.mutate(m.month)
                                        }
                                        data-testid={`button-run-outbound-gap-${m.month}`}
                                      >
                                        {isRowRunning ? "Running…" : "Run"}
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
