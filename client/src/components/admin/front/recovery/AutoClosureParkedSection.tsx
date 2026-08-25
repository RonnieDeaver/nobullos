// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type {
  AutoClosureStatus,
  CoverageMonth,
  IntegrationStatus,
  ParkedWindowEntry,
  ReArmDrainStatus,
} from "./types";

type Props = {
  autoClosureStatus: AutoClosureStatus | undefined;
  months: CoverageMonth[];
  status: IntegrationStatus | undefined;
};

export function AutoClosureParkedSection({ autoClosureStatus, months, status }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();


  // Task #1885 — operator un-park for a parked recovery window.
  const unparkRecoveryMutation = useMutation<
    { unparked: boolean; month: string },
    Error,
    { month: string }
  >({
    meta: { silent: true },
    mutationFn: async ({ month }) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/auto-closure/unpark",
        { month },
      );
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.unparked ? "Window un-parked" : "Window was not parked",
        description: `${data.month} will be re-evaluated on the next auto-closure tick.`,
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/admin/front/auto-closure/status"],
      });
    },
    onError: (err) => {
      toast({
        title: "Un-park failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });


  // Task #2085 — operator one-press re-arm of all parked recovery
  // windows under the search strategy. Starts a worker-pool background
  // drain; status flips back via the auto-closure status poll.
  const rearmParkedMutation = useMutation<
    { state: string; detail: string; totalParked: number },
    Error,
    void
  >({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/auto-closure/rearm",
        {},
      );
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title:
          data.state === "switch_off"
            ? "Search strategy is off"
            : data.state === "nothing-to-do"
              ? "Nothing to re-arm"
              : "Re-arm started",
        description: data.detail,
        variant: data.state === "switch_off" ? "destructive" : "default",
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/admin/front/auto-closure/status"],
      });
    },
    onError: (err) => {
      toast({
        title: "Re-arm failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });


  // Task #2098 — operator re-arm of a SINGLE parked recovery window under
  // the search strategy. Mirrors the all-windows re-arm but targets one
  // month; starts a per-month worker-pool background drain. `pendingMonth`
  // tracks which row's button should show the "Starting…" state.
  const [rearmingMonth, setRearmingMonth] = useState<string | null>(null);

  const rearmOneMutation = useMutation<
    { state: string; detail: string; totalParked: number; month: string },
    Error,
    { month: string }
  >({
    meta: { silent: true },
    mutationFn: async ({ month }) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/auto-closure/rearm-one",
        { month },
      );
      return res.json();
    },
    onMutate: ({ month }) => {
      setRearmingMonth(month);
    },
    onSuccess: (data) => {
      toast({
        title:
          data.state === "switch_off"
            ? "Search strategy is off"
            : data.state === "nothing-to-do"
              ? "Nothing to re-arm"
              : "Re-arm started",
        description: `${data.month}: ${data.detail}`,
        variant: data.state === "switch_off" ? "destructive" : "default",
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/admin/front/auto-closure/status"],
      });
    },
    onError: (err) => {
      toast({
        title: "Re-arm failed",
        description: err.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      setRearmingMonth(null);
    },
  });


  // Task #2088 — "Un-park all" — re-arm every currently-parked window by
  // looping the existing single-window unpark route. No new mutation path
  // is introduced; this is purely a convenience over the per-row action.
  // (Phase 1's re-arm-under-search-strategy action is not in this
  // environment, so re-arm == un-park here. See commit notes.)
  const unparkAllRecoveryMutation = useMutation<
    { unparked: number; total: number },
    Error,
    { months: string[] }
  >({
    meta: { silent: true },
    mutationFn: async ({ months }) => {
      let unparked = 0;
      for (const month of months) {
        const res = await apiRequest(
          "POST",
          "/api/admin/front/auto-closure/unpark",
          { month },
        );
        const data = await res.json();
        if (data?.unparked) unparked++;
      }
      return { unparked, total: months.length };
    },
    onSuccess: (data) => {
      toast({
        title: "Un-parked all windows",
        description: `${data.unparked}/${data.total} window(s) will be re-evaluated on the next auto-closure tick.`,
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/admin/front/auto-closure/status"],
      });
    },
    onError: (err) => {
      toast({
        title: "Un-park all failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <>
        {/* Task #1682 — Front self-healing coverage loop status. */}
        {autoClosureStatus && (
          <div
            className="text-xs text-gray-700 bg-slate-50 border border-slate-200 rounded p-2 mt-2"
            data-testid="text-front-auto-closure-status"
          >
            <span className="font-medium">Auto-closure:</span>{" "}
            <span data-testid="text-fa-auto-closure-enabled">
              {autoClosureStatus.enabled ? "on" : "off"}
            </span>
            {" · mode "}
            <span data-testid="text-fa-auto-closure-mode">
              {autoClosureStatus.currentMode ?? "daytime"}
            </span>
            {autoClosureStatus.lastSummary ? (
              <>
                {" · last run "}
                <span data-testid="text-fa-auto-closure-last-run">
                  {new Date(autoClosureStatus.lastSummary.ranAt).toLocaleString()}
                </span>
                {autoClosureStatus.lastSummary.mode ? (
                  <>
                    {" · last mode "}
                    <span data-testid="text-fa-auto-closure-last-mode">
                      {autoClosureStatus.lastSummary.mode}
                    </span>
                  </>
                ) : null}
                {" · retries "}
                <span data-testid="text-fa-auto-closure-retries">
                  {autoClosureStatus.lastSummary.errorRetrySuccesses}/
                  {autoClosureStatus.lastSummary.errorsRetried}
                </span>
                {" · ingest recoveries "}
                <span data-testid="text-fa-auto-closure-recoveries">
                  {autoClosureStatus.lastSummary.ingestRecoveriesEnqueued}
                </span>
                {" · apply nudges "}
                <span data-testid="text-fa-auto-closure-nudges">
                  {autoClosureStatus.lastSummary.applyNudgesEnqueued}
                </span>
                {" · skipped unrecoverable "}
                <span data-testid="text-fa-auto-closure-skipped-unrecoverable">
                  {autoClosureStatus.lastSummary.skips?.unrecoverable ?? 0}
                </span>
                {" · skipped budget "}
                <span data-testid="text-fa-auto-closure-skipped-budget">
                  {autoClosureStatus.lastSummary.skips?.budget ?? 0}
                </span>
                {" · skipped gates "}
                <span data-testid="text-fa-auto-closure-skipped-gates">
                  {(autoClosureStatus.lastSummary.skips?.queue_paused ?? 0) +
                    (autoClosureStatus.lastSummary.skips?.in_flight ?? 0) +
                    (autoClosureStatus.lastSummary.skips?.cooldown ?? 0) +
                    (autoClosureStatus.lastSummary.skips?.auth_failed ?? 0) +
                    (autoClosureStatus.lastSummary.skips?.threshold ?? 0) +
                    (autoClosureStatus.lastSummary.skips?.parked ?? 0) +
                    (autoClosureStatus.lastSummary.skips?.dedupe_closed ?? 0)}
                </span>
                {/* Task #2088 — split the old unified "parked" counter into
                    parked vs dedupe-closed so operators can tell a quiescent
                    park apart from an auto-close. */}
                {" · skipped parked "}
                <span data-testid="text-fa-auto-closure-skipped-parked">
                  {autoClosureStatus.lastSummary.skips?.parked ?? 0}
                </span>
                {" · closed (webhook dedupe) "}
                <span data-testid="text-fa-auto-closure-skipped-dedupe-closed">
                  {autoClosureStatus.lastSummary.skips?.dedupe_closed ?? 0}
                </span>
                {autoClosureStatus.lastSummary.skippedReason ? (
                  <>
                    {" · skipped: "}
                    <span
                      className="text-amber-700"
                      data-testid="text-fa-auto-closure-skipped"
                    >
                      {autoClosureStatus.lastSummary.skippedReason}
                    </span>
                  </>
                ) : null}
                {autoClosureStatus.lastSummary.lastSelfError ? (
                  <>
                    {" · self-error: "}
                    <span
                      className="text-red-700"
                      data-testid="text-fa-auto-closure-self-error"
                    >
                      {autoClosureStatus.lastSummary.lastSelfError}
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <span> · no run recorded yet</span>
            )}
            {/* Task #1885 / #2088 — parked recovery windows: per-row metadata,
                per-row + bulk un-park, and an explicit empty state. */}
            <div
              className="mt-2 pt-2 border-t border-slate-200"
              data-testid="section-fa-auto-closure-parked"
            >
              {(() => {
                const parked = autoClosureStatus.parkedWindows ?? {};
                const months = Object.keys(parked).sort((a, b) =>
                  a.localeCompare(b),
                );
                if (months.length === 0) {
                  return (
                    <div
                      className="text-gray-500"
                      data-testid="text-fa-parked-empty"
                    >
                      No recovery windows are currently parked — the auto-closer
                      is re-enqueueing all months normally.
                    </div>
                  );
                }
                // Task #2148 — all-windows re-arm drain state from the
                // auto-closure status poll, surfaced as a running/finished
                // badge in the header so operators can see how many parked
                // windows the "Re-arm all" press has drained.
                const allDrain: ReArmDrainStatus | null | undefined =
                  autoClosureStatus?.allReArmDrain;
                return (
                  <>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="font-medium text-amber-800">
                        Parked windows (auto-closure stopped re-enqueueing){" "}
                        <span data-testid="text-fa-parked-count">
                          ({months.length})
                        </span>
                        {/* Task #2148 — live all-windows re-arm drain badge.
                            Running shows processed/total progress; finished
                            shows the final outcome tally + timestamp. */}
                        {allDrain ? (
                          allDrain.running ? (
                            <span
                              className="ml-2 inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700"
                              data-testid="badge-fa-rearm-all-drain-running"
                              title={allDrain.progress}
                            >
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-600" />
                              Re-arming all… {allDrain.processed}/
                              {allDrain.totalAtStart}
                            </span>
                          ) : (
                            <span
                              className={`ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
                                allDrain.error
                                  ? "bg-red-100 text-red-700"
                                  : allDrain.lastOutcomeKind === "still_empty"
                                    ? "bg-amber-100 text-amber-800 border border-amber-300"
                                    : "bg-green-100 text-green-700"
                              }`}
                              data-testid="badge-fa-rearm-all-drain-finished"
                              title={
                                allDrain.error
                                  ? allDrain.error
                                  : allDrain.lastOutcomeKind === "still_empty"
                                    ? "Every re-armed window was re-driven under the search strategy and still ingested nothing. These months are permanently exhausted — re-pressing will not recover anything."
                                    : allDrain.progress
                              }
                            >
                              {allDrain.error
                                ? "Re-arm all failed"
                                : allDrain.lastOutcomeKind === "still_empty"
                                  ? `No more to recover: ${allDrain.processed}/${allDrain.totalAtStart}`
                                  : `Re-arm all done: ${allDrain.processed}/${allDrain.totalAtStart}${
                                      allDrain.lastOutcomeKind
                                        ? ` · ${allDrain.lastOutcomeKind}`
                                        : ""
                                    }`}
                              {allDrain.finishedAt
                                ? ` · ${new Date(
                                    allDrain.finishedAt,
                                  ).toLocaleTimeString()}`
                                : ""}
                            </span>
                          )
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Task #2085 — one-press re-arm of all parked windows
                            under the search strategy. */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          data-testid="button-fa-rearm-all"
                          disabled={
                            rearmParkedMutation.isPending || allDrain?.running
                          }
                          onClick={() => rearmParkedMutation.mutate()}
                        >
                          {rearmParkedMutation.isPending
                            ? "Starting…"
                            : allDrain?.running
                              ? "Re-arming all…"
                              : "Re-arm all (search strategy)"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          data-testid="button-fa-unpark-all"
                          disabled={
                            unparkAllRecoveryMutation.isPending ||
                            unparkRecoveryMutation.isPending
                          }
                          onClick={() =>
                            unparkAllRecoveryMutation.mutate({ months })
                          }
                        >
                          {unparkAllRecoveryMutation.isPending
                            ? "Un-parking…"
                            : "Re-arm / un-park all"}
                        </Button>
                      </div>
                    </div>
                    <ul className="space-y-1">
                      {months.map((month) => {
                        const entry: ParkedWindowEntry | undefined =
                          parked[month];
                        // Task #2118 — per-window re-arm drain state from
                        // the auto-closure status poll. Present only while
                        // a drain for this month exists in the running
                        // process; otherwise the row falls back to the
                        // persisted `reArmOutcome` line.
                        const drain: ReArmDrainStatus | undefined =
                          autoClosureStatus?.reArmDrains?.[month];
                        return (
                          <li
                            key={month}
                            className="flex items-center justify-between gap-2"
                            data-testid={`row-fa-parked-${month}`}
                          >
                            <span className="text-gray-700">
                              <span
                                className="font-mono"
                                data-testid={`text-fa-parked-month-${month}`}
                              >
                                {month}
                              </span>
                              {" — "}
                              <span
                                data-testid={`text-fa-parked-reason-${month}`}
                              >
                                {entry?.reason ??
                                  `${entry?.deadRuns ?? 0} consecutive runs hit the page cap with 0 ingested`}
                              </span>
                              {typeof entry?.deadRuns === "number" ? (
                                <span
                                  className="text-gray-500"
                                  data-testid={`text-fa-parked-deadruns-${month}`}
                                >
                                  {" · "}
                                  {entry.deadRuns} dead run
                                  {entry.deadRuns === 1 ? "" : "s"}
                                </span>
                              ) : null}
                              {entry?.parkedAt ? (
                                <span
                                  className="text-gray-500"
                                  data-testid={`text-fa-parked-since-${month}`}
                                >
                                  {" · since "}
                                  {new Date(entry.parkedAt).toLocaleString()}
                                </span>
                              ) : null}
                              {entry?.lastCheckpointAt ? (
                                <span
                                  className="text-gray-500"
                                  data-testid={`text-fa-parked-checkpoint-${month}`}
                                >
                                  {" · last checkpoint "}
                                  {new Date(
                                    entry.lastCheckpointAt,
                                  ).toLocaleString()}
                                </span>
                              ) : null}
                              {/* Task #2085 — search escalation / re-arm
                                  outcome telemetry. */}
                              {entry?.searchEscalated ? (
                                <span
                                  className="text-blue-700"
                                  data-testid={`text-fa-parked-escalated-${month}`}
                                >
                                  {" · already re-run under search strategy"}
                                </span>
                              ) : null}
                              {/* Phase 1 re-arm-outcome data; rendered only
                                  if present (not in this environment). */}
                              {entry?.reArmOutcome ? (
                                <span
                                  className={
                                    entry.reArmOutcome?.kind === "error"
                                      ? "text-red-700"
                                      : "text-gray-500"
                                  }
                                  data-testid={`text-fa-parked-rearm-${month}`}
                                >
                                  {" · last re-arm: "}
                                  {typeof entry.reArmOutcome === "object"
                                    ? `${entry.reArmOutcome.kind}${entry.reArmOutcome.source ? ` (${entry.reArmOutcome.source})` : ""}`
                                    : String(entry.reArmOutcome)}
                                  {/* Task #2230 — surface WHY a re-arm keeps
                                      failing: the `error` detail
                                      (status:statusReason, e.g. blocked:auth)
                                      and how many times in a row it has
                                      errored, so an auth-blocked window is
                                      distinguishable from a still-empty one
                                      at a glance. */}
                                  {typeof entry.reArmOutcome === "object" &&
                                  entry.reArmOutcome?.kind === "error" &&
                                  entry.reArmOutcome?.detail ? (
                                    <span
                                      data-testid={`text-fa-parked-rearm-detail-${month}`}
                                    >
                                      {` — ${entry.reArmOutcome.detail}`}
                                    </span>
                                  ) : null}
                                  {typeof entry?.reArmConsecutiveErrors ===
                                    "number" &&
                                  entry.reArmConsecutiveErrors > 0 ? (
                                    <span
                                      data-testid={`text-fa-parked-rearm-errcount-${month}`}
                                    >
                                      {` · ${entry.reArmConsecutiveErrors} consecutive error${
                                        entry.reArmConsecutiveErrors === 1
                                          ? ""
                                          : "s"
                                      }`}
                                    </span>
                                  ) : null}
                                </span>
                              ) : null}
                              {/* Task #2118 — live per-window re-arm drain
                                  badge. Shows a running indicator while the
                                  month's background drain is in flight, then
                                  a finished/failed badge with the last
                                  outcome and timestamp once it completes. */}
                              {drain ? (
                                drain.running ? (
                                  <span
                                    className="ml-1 inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700"
                                    data-testid={`badge-fa-rearm-drain-running-${month}`}
                                    title={drain.progress}
                                  >
                                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-600" />
                                    Re-arming…
                                  </span>
                                ) : (
                                  <span
                                    className={`ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
                                      drain.error ||
                                      drain.lastOutcomeKind === "error"
                                        ? "bg-red-100 text-red-700"
                                        : drain.lastOutcomeKind === "still_empty"
                                          ? "bg-amber-100 text-amber-800 border border-amber-300"
                                          : "bg-green-100 text-green-700"
                                    }`}
                                    data-testid={`badge-fa-rearm-drain-finished-${month}`}
                                    title={
                                      drain.error
                                        ? drain.error
                                        : drain.lastOutcomeKind === "error"
                                          ? // Task #2230 — the re-arm completed
                                            // but the window stayed parked with a
                                            // transient `error` (e.g. blocked:auth).
                                            // Show WHY from the persisted outcome
                                            // detail + how many times in a row.
                                            `This window keeps failing to recover${
                                              entry?.reArmOutcome?.detail
                                                ? `: ${entry.reArmOutcome.detail}`
                                                : ""
                                            }${
                                              (entry?.reArmConsecutiveErrors ?? 0) > 0
                                                ? ` (${entry.reArmConsecutiveErrors} consecutive error${
                                                    entry.reArmConsecutiveErrors ===
                                                    1
                                                      ? ""
                                                      : "s"
                                                  })`
                                                : ""
                                            }. It is not exhausted — re-pressing once the cause clears may recover it.`
                                          : drain.lastOutcomeKind ===
                                              "still_empty"
                                            ? "This month was re-driven under the search strategy and still ingested nothing. It is permanently exhausted — re-pressing will not recover anything."
                                            : drain.progress
                                    }
                                  >
                                    {drain.error
                                      ? "Re-arm failed"
                                      : drain.lastOutcomeKind === "error"
                                        ? `Re-arm errored${
                                            entry?.reArmOutcome?.detail
                                              ? `: ${entry.reArmOutcome.detail}`
                                              : ""
                                          }`
                                        : drain.lastOutcomeKind === "still_empty"
                                          ? "No more to recover"
                                          : `Re-arm done${
                                              drain.lastOutcomeKind
                                                ? `: ${drain.lastOutcomeKind}`
                                                : ""
                                            }`}
                                    {drain.finishedAt
                                      ? ` · ${new Date(
                                          drain.finishedAt,
                                        ).toLocaleTimeString()}`
                                      : ""}
                                  </span>
                                )
                              ) : null}
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              {/* Task #2098 — per-window re-arm under the
                                  search strategy. Hidden when the window is
                                  permanently ineligible (a prior re-arm
                                  proved it `still_empty`), mirroring
                                  `isReArmEligible` for a fresh epoch. */}
                              {entry?.reArmOutcome?.kind !== "still_empty" ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-xs"
                                  data-testid={`button-fa-rearm-${month}`}
                                  disabled={
                                    rearmOneMutation.isPending ||
                                    rearmParkedMutation.isPending ||
                                    drain?.running
                                  }
                                  onClick={() =>
                                    rearmOneMutation.mutate({ month })
                                  }
                                >
                                  {rearmOneMutation.isPending &&
                                  rearmingMonth === month
                                    ? "Starting…"
                                    : drain?.running
                                      ? "Re-arming…"
                                      : "Re-arm"}
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-xs"
                                data-testid={`button-fa-unpark-${month}`}
                                disabled={
                                  unparkRecoveryMutation.isPending ||
                                  unparkAllRecoveryMutation.isPending
                                }
                                onClick={() =>
                                  unparkRecoveryMutation.mutate({ month })
                                }
                              >
                                Un-park
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                );
              })()}
            </div>
          </div>
        )}
    </>
  );
}
