// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, RefreshCw } from "lucide-react";
import { FRONT_GRAIN_MESSAGES, FRONT_CONSOLE_LENSES, computeFrontCoverageReconciliation, frontReconciliationSentence, FRONT_PIPELINE_BRIDGE_NOTE, getFrontConsoleMetric } from "@shared/frontConsoleMetrics";
import type { AnalyticsCoverageMonth, AnalyticsCoverageSummary, AutoClosureStatus, CoverageMonth, IntegrationStatus } from "./types";
import { extractBlockedReason } from "./shared";
import { PercentText } from "../PercentText";
import { OutboundGapCloseReadout } from "./OutboundGapCloseReadout";
import { MessageGrainUpgradeReadout } from "./MessageGrainUpgradeReadout";
import { FinishMessageGrainDriverReadout } from "./FinishMessageGrainDriverReadout";
import { AnalyticsMonthlyTable } from "./AnalyticsMonthlyTable";
import { AnalyticsCoverageAlertsConfig } from "./AnalyticsCoverageAlertsConfig";

type Props = {
  autoClosureStatus: AutoClosureStatus | undefined;
  isAdmin: boolean;
  months: CoverageMonth[];
  status: IntegrationStatus | undefined;
};

export function AnalyticsCoverageSection({ autoClosureStatus, isAdmin, months, status }: Props) {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { toast } = useToast();


  // Task #1643 — Front Analytics all-time coverage. Cached summary
  // pulled from `front_analytics_monthly_coverage`; never triggers a
  // Front Analytics call on the request path.
  const {
    data: analyticsCoverage,
    refetch: refetchAnalyticsCoverage,
    isFetching: analyticsCoverageLoading,
  } = useQuery<AnalyticsCoverageSummary>({
    queryKey: ["/api/admin/front/analytics-coverage"],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: isTabVisible ? 60000 : false,
    refetchIntervalInBackground: false,
  });

  // Task #2250 — the shared gate state (master refresh OFF / queue
  // paused / kill switch ON) the refresh-month / reprobe-month /
  // recompute trigger routes all 503 on. The server precomputes the
  // plain-English `blockedReason` (reusing the same wording the 503
  // toast shows) so the panel can disable those buttons with an inline
  // reason BEFORE the operator presses one that can't succeed.
  const triggerGateBlockedReason: string | null =
    (analyticsCoverage?.triggerGates?.blockedReason as string | null) ?? null;

  // Task #2511 — progress + explicit done-state readout for the consolidated
  // "Finish message-grain coverage" control. Polls faster while a drain is
  // running (pending) so the operator sees live progress, then idles.
  const { data: finishMessageGrainStatus } = useQuery<{
    state: "applied" | "not-needed" | "error" | "blocked" | "pending";
    // `running` is true ONLY while a background drain is actively in progress.
    // A `pending` state WITHOUT `running` means "work remains, press to start" —
    // the button must stay clickable then.
    running?: boolean;
    detail: string;
    integration?: string;
    floorMonth: string | null;
    excludedMonths: number;
    months: string[];
  }>({
    queryKey: [
      "/api/admin/front/analytics-coverage/finish-message-grain-status",
    ],
    enabled: isAdmin && !!status?.front.connected,
    refetchInterval: (query) =>
      isTabVisible && (query.state.data as any)?.running
        ? 4000
        : isTabVisible
          ? 30000
          : false,
    refetchIntervalInBackground: false,
  });


  const analyticsRefreshMutation = useMutation<{ enqueued: boolean; jobId: string }, Error, void>({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/front/analytics-coverage/refresh", {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Refresh queued", description: "Front Analytics coverage refresh enqueued." });
      setTimeout(() => refetchAnalyticsCoverage(), 1500);
    },
    onError: (err: Error) => {
      toast({ title: "Refresh failed", description: err.message, variant: "destructive" });
    },
  });


  // Task #2511 — the SINGLE consolidated control. One press relabels every
  // free-convertible in-scope month to message grain (zero Front calls) then
  // drives the rest to message grain via a worker-pool background drain (the
  // same drain the `finish_front_message_grain_coverage` prod-action runs).
  // Surfaced from the all-time card's amber confirmation banner; replaces the
  // earlier free-only backfill button so operators have one control, not two.
  const finishMessageGrainMutation = useMutation<
    {
      state: "applied" | "not-needed" | "error" | "blocked";
      detail: string;
      integration?: string;
      rowsAffected?: number;
    },
    Error,
    void
  >({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/analytics-coverage/finish-message-grain",
        {},
      );
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title:
          data.state === "not-needed"
            ? "Already complete"
            : data.state === "blocked"
              ? "Reconnect Front to finish"
              : "Finishing message-grain coverage",
        description: data.detail,
        variant: data.state === "blocked" ? "destructive" : undefined,
      });
      void queryClient.invalidateQueries({
        queryKey: ["/api/admin/front/analytics-coverage"],
      });
      void queryClient.invalidateQueries({
        queryKey: [
          "/api/admin/front/analytics-coverage/finish-message-grain-status",
        ],
      });
    },
    onError: (err: Error) => {
      const raw = err.message ?? "";
      let title = "Finish message-grain coverage failed";
      if (raw.includes("queue paused")) {
        title = "Blocked: queue paused";
      } else if (raw.includes("KILL_SWITCH_NON_CRITICAL_SWEEPS")) {
        title = "Blocked: non-critical sweeps kill switch";
      } else if (raw.includes("refresh disabled")) {
        title = "Blocked: coverage refresh is disabled";
      }
      toast({ title, description: extractBlockedReason(raw), variant: "destructive" });
    },
  });


  // Task #1837 — operator-triggered backfill that re-labels every
  // coverage row's unit columns onto `conversations_all`, re-pulling
  // a units-comparable denominator from Conversations Search where
  // the prior denominator was in Analytics-messages units. Bounded
  // by `frontPullsBudget` (default 12) so a single click can't
  // fan out into an unbounded firehose; operators can re-click to
  // consume more budget.
  const analyticsRecomputeMutation = useMutation<
    {
      attempted: number;
      results: { month: string; outcome: string; errorMessage?: string }[];
      frontPullsUsed: number;
      frontPullsBudget: number;
    },
    Error,
    { frontPullsBudget?: number } | void
  >({
    meta: { silent: true },
    mutationFn: async (vars) => {
      const body = vars?.frontPullsBudget != null ? { frontPullsBudget: vars.frontPullsBudget } : {};
      const res = await apiRequest(
        "POST",
        "/api/admin/front/analytics-coverage/recompute",
        body,
      );
      return res.json();
    },
    onSuccess: (data) => {
      const by = data.results.reduce<Record<string, number>>((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      }, {});
      toast({
        title: "Recompute units: done",
        description: `${data.attempted} rows. ${by["relabel-only"] ?? 0} relabeled · ${by["repulled"] ?? 0} re-pulled · ${by["not-comparable"] ?? 0} still mismatched · ${by["error"] ?? 0} errored (Front pulls used: ${data.frontPullsUsed}/${data.frontPullsBudget}).`,
      });
      void refetchAnalyticsCoverage(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      const raw = err.message ?? "";
      let title = "Recompute failed";
      if (raw.includes("front_analytics_refresh_enabled=false")) {
        title = "Recompute blocked: refresh disabled";
      } else if (raw.includes("queue paused")) {
        title = "Recompute blocked: queue paused";
      } else if (raw.includes("KILL_SWITCH_NON_CRITICAL_SWEEPS")) {
        title = "Recompute blocked: non-critical sweeps kill switch";
      }
      toast({
        title,
        description: extractBlockedReason(raw),
        variant: "destructive",
      });
    },
  });

  return (
    <>
        {/* Task #1643 — Front Analytics all-time coverage. */}
        <div data-testid="section-front-analytics-coverage" className="border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h4 className="text-xs font-semibold text-foreground">Front Analytics all-time coverage</h4>
              {/* Task #2685 — name the lens so this screen's "coverage/gaps"
                  vocabulary is never confused with the Pipeline Health
                  ("backlog/drained") lens or a per-run recovery figure. */}
              <p
                className="text-xs font-medium text-indigo-700"
                data-testid="text-fa-lens-label"
              >
                Lens {FRONT_CONSOLE_LENSES[2].lens} — {FRONT_CONSOLE_LENSES[2].title}: {FRONT_CONSOLE_LENSES[2].question}
              </p>
              <p className="text-xs text-muted-foreground">
                Front Analytics is the authoritative monthly denominator. Measurement-only — never writes to Front sync or raw comms.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => analyticsRefreshMutation.mutate()}
                disabled={analyticsRefreshMutation.isPending}
                data-testid="button-front-analytics-refresh"
              >
                {analyticsRefreshMutation.isPending ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3 mr-1" />
                )}
                Refresh
              </Button>
              {/* Task #1837 — operator-triggered unit-unification
                  backfill. Re-labels every row's unit columns onto
                  `conversations_all` and re-pulls a units-comparable
                  denominator from Conversations Search where the row's
                  prior denominator was in Analytics-messages units.
                  Bounded by frontPullsBudget=12 per click. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => analyticsRecomputeMutation.mutate()}
                disabled={
                  analyticsRecomputeMutation.isPending ||
                  triggerGateBlockedReason != null
                }
                title={
                  triggerGateBlockedReason ??
                  "Re-pull a units-comparable message-grain denominator for every row (up to 12 Front pulls per click). Safe to re-run."
                }
                data-testid="button-front-analytics-recompute-units"
              >
                {analyticsRecomputeMutation.isPending ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : null}
                Recompute units
              </Button>
            </div>
          </div>

          {/* Task #2250 — surface WHY the refresh-month / reprobe-month /
              recompute trigger buttons are disabled BEFORE the operator
              presses them, mirroring the outbound gap-close "Run now"
              pre-press hint. The reason text reuses the same shared
              wording the 503 toast shows so it stays consistent. */}
          {triggerGateBlockedReason ? (
            <p
              className="text-xs text-amber-700 mb-2"
              data-testid="text-front-analytics-trigger-disabled-reason"
            >
              {triggerGateBlockedReason}
            </p>
          ) : null}

          {analyticsCoverageLoading && !analyticsCoverage ? (
            <InlineLoadingSkeleton />
          ) : !analyticsCoverage ? (
            <div className="text-xs text-muted-foreground" data-testid="text-front-analytics-empty">
              No Front Analytics data cached yet.
            </div>
          ) : (
            <>
              {/* Task #2685 — one reconciliation banner that ties the three
                  all-time figures into the identity
                  front total = applied + apply gap + ingest gap, plus the
                  bridge note that stops the Pipeline Health "no backlog" lens
                  from reading as a contradiction with a low coverage %.
                  Computed client-side from the numbers already in the summary —
                  no new query/count/Front call. Message-grain wording only. */}
              {(() => {
                const recon = computeFrontCoverageReconciliation({
                  frontTotal: Number(analyticsCoverage.allTime?.frontTotalMessages ?? 0),
                  fetched: Number(analyticsCoverage.allTime?.fetchedIntoNobull ?? 0),
                  applied: Number(analyticsCoverage.allTime?.appliedIntoNobull ?? 0),
                });
                return (
                  <div
                    className="border rounded p-2 mb-2 bg-indigo-50/60 border-indigo-200"
                    data-testid="banner-fa-reconciliation"
                  >
                    <p
                      className="text-xs text-foreground"
                      data-testid="text-fa-reconciliation-sentence"
                    >
                      {frontReconciliationSentence(recon)}
                    </p>
                    <p
                      className="text-xs text-muted-foreground mt-1 font-mono"
                      data-testid="text-fa-reconciliation-identity"
                    >
                      {Number(recon.frontTotal).toLocaleString()} front total ={" "}
                      {Number(recon.applied).toLocaleString()} applied +{" "}
                      {Number(recon.applyGap).toLocaleString()} apply gap +{" "}
                      {Number(recon.ingestGap).toLocaleString()} ingest gap
                    </p>
                    <p
                      className="text-xs text-muted-foreground mt-1"
                      data-testid="text-fa-pipeline-bridge-note"
                    >
                      {FRONT_PIPELINE_BRIDGE_NOTE}
                    </p>
                  </div>
                );
              })()}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-2" data-testid="grid-front-analytics-headline">
                <div className="border rounded p-2 bg-card">
                  <div className="text-xs text-muted-foreground">All-time applied</div>
                  <div className="text-lg font-semibold text-foreground" data-testid="text-fa-applied-pct" data-metric-id={getFrontConsoleMetric("front.coverage.applied_pct").id}>
                    <PercentText value={analyticsCoverage.allTime?.appliedCoveragePct ?? 0} digits={2} />
                  </div>
                  {/* Task #2510 → #2603 — explicit message-grain label. The
                      whole Front console is message-grain only now; this label
                      keeps the headline % unambiguous (the Pipeline Health
                      screen no longer surfaces any conversation-grain figure). */}
                  <div className="text-xs font-medium text-sky-700" data-testid="text-fa-applied-grain">
                    {FRONT_GRAIN_MESSAGES}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {Number(analyticsCoverage.allTime?.appliedIntoNobull ?? 0).toLocaleString()} / {Number(analyticsCoverage.allTime?.frontTotalMessages ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="border rounded p-2 bg-card">
                  <div className="text-xs text-muted-foreground">All-time fetched</div>
                  <div className="text-lg font-semibold text-foreground" data-testid="text-fa-fetched-pct" data-metric-id={getFrontConsoleMetric("front.coverage.fetched_pct").id}>
                    <PercentText value={analyticsCoverage.allTime?.fetchedCoveragePct ?? 0} digits={2} />
                  </div>
                  <div className="text-xs font-medium text-sky-700" data-testid="text-fa-fetched-grain">
                    {FRONT_GRAIN_MESSAGES}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {Number(analyticsCoverage.allTime?.fetchedIntoNobull ?? 0).toLocaleString()} / {Number(analyticsCoverage.allTime?.frontTotalMessages ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="border rounded p-2 bg-card">
                  <div className="text-xs text-muted-foreground">Ingest gap (Front has, we didn't fetch)</div>
                  <div className="text-lg font-semibold text-amber-700" data-testid="text-fa-ingest-gap" data-metric-id={getFrontConsoleMetric("front.coverage.ingest_gap").id}>
                    {Number(analyticsCoverage.allTime?.ingestGap ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="border rounded p-2 bg-card">
                  <div className="text-xs text-muted-foreground">Apply gap (fetched, not applied)</div>
                  <div className="text-lg font-semibold text-rose-700" data-testid="text-fa-apply-gap" data-metric-id={getFrontConsoleMetric("front.coverage.apply_gap").id}>
                    {Number(analyticsCoverage.allTime?.applyGap ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="border rounded p-2 bg-card">
                  <div className="text-xs text-muted-foreground">Adoption date (fixed)</div>
                  <div className="text-sm font-medium text-foreground" data-testid="text-fa-adoption-date">
                    {analyticsCoverage.adoptionDate ?? "—"}
                  </div>
                  <div className="text-xs text-muted-foreground" data-testid="text-fa-last-refresh">
                    Last refresh:{" "}
                    {analyticsCoverage.lastRefreshedAt
                      ? new Date(analyticsCoverage.lastRefreshedAt).toLocaleString()
                      : "never"}
                  </div>
                </div>
              </div>
              {/* Task #2603 — Front Console is message-grain only. The former
                  conversations-vs-messages caption was removed; every figure on
                  this screen is at individual-message grain, so there is no
                  longer a competing grain to disambiguate. */}
              {/* Task #2502 — reframe the headline coverage % so a low number
                  (e.g. ~6.5%) reads as a measurement caveat, not lost client
                  data. The denominator is Front's own message-grain total
                  (every individual message across all shared inboxes, incl.
                  internal/automated traffic); the numerator counts what we
                  applied/fetched. Most operational client comms ARE captured —
                  the percentage is small mostly because the denominator is the
                  full message firehose. Presentation only: no coverage math,
                  no Front API calls changed. */}
              <div
                className="text-xs rounded p-2 mb-2 border bg-sky-50 border-sky-200 text-sky-900"
                data-testid="text-fa-coverage-caveat"
              >
                <span className="font-semibold">How to read this:</span> the percentages above are
                measured against Front's <span className="font-semibold">message-grain</span> total —
                every individual message across all shared inboxes, including internal and automated
                traffic. A low percentage reflects that broad denominator and measurement grain, not
                lost client data; the figures here are measurement-only and never change Front sync,
                ingestion, or matching.
              </div>
              {/* Task #2439 — confirm the all-time headline counts every
                  in-scope month. inScopeExcludedMonths is the count of
                  at/after-floor months omitted purely because they are not
                  yet message-grain; drive them to message grain so they
                  re-enter the total. */}
              {(() => {
                const inScope = Number(analyticsCoverage.allTime?.inScopeMonths ?? 0);
                const counted = Number(analyticsCoverage.allTime?.inScopeCountedMonths ?? 0);
                const excluded = Number(analyticsCoverage.allTime?.inScopeExcludedMonths ?? 0);
                // Task #2603 — live progress toward 100% message-grain coverage.
                // The denominator is the in-scope month count (months at/after the
                // hard-coded adoption floor); the numerator is the months already
                // at real message grain. 100% is the explicit done state.
                const progressPct =
                  inScope > 0 ? Math.round((counted / inScope) * 100) : 100;
                const isComplete = excluded === 0;
                return (
                  <div
                    className={`text-xs rounded p-2 mb-2 border ${
                      excluded > 0
                        ? "bg-amber-50 border-amber-200 text-amber-800"
                        : "bg-emerald-50 border-emerald-200 text-emerald-800"
                    }`}
                    data-testid="text-fa-in-scope-confirmation"
                  >
                    {/* Task #2603 — always-on progress-to-100% indicator so the
                        operator can watch message-grain coverage climb. */}
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span
                        className="font-semibold"
                        data-testid="text-fa-message-grain-progress-pct"
                      >
                        Message-grain coverage: {progressPct}% ({counted.toLocaleString()} of{" "}
                        {inScope.toLocaleString()} in-scope month{inScope === 1 ? "" : "s"})
                      </span>
                      {isComplete ? (
                        <Badge
                          variant="outline"
                          className="bg-emerald-100 text-emerald-800 border-emerald-300 shrink-0"
                          data-testid="badge-fa-message-grain-complete"
                        >
                          100% — message-grain complete
                        </Badge>
                      ) : null}
                    </div>
                    <div
                      className="h-1.5 w-full rounded bg-muted overflow-hidden mb-1"
                      data-testid="bar-fa-message-grain-progress"
                      role="progressbar"
                      aria-valuenow={progressPct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className={`h-full ${isComplete ? "bg-emerald-500" : "bg-amber-500"}`}
                        style={{ width: `${progressPct}%` }}
                        data-testid="bar-fa-message-grain-progress-fill"
                      />
                    </div>
                    {excluded > 0 ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            {counted} of {inScope} in-scope month(s) counted in the all-time
                            headline; <span className="font-semibold">{excluded}</span> still
                            excluded (not yet message-grain). Drive every in-scope month to a
                            real message-grain total in one step.
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 shrink-0 text-xs"
                            disabled={
                              finishMessageGrainMutation.isPending ||
                              finishMessageGrainStatus?.running === true
                            }
                            onClick={() => finishMessageGrainMutation.mutate()}
                            data-testid="button-fa-finish-message-grain"
                          >
                            {finishMessageGrainMutation.isPending ||
                            finishMessageGrainStatus?.running === true
                              ? "Finishing…"
                              : "Finish message-grain coverage"}
                          </Button>
                        </div>
                        {finishMessageGrainStatus?.state === "pending" && (
                          <span
                            className="text-xs opacity-80"
                            data-testid="text-fa-finish-message-grain-progress"
                          >
                            {finishMessageGrainStatus.detail}
                          </span>
                        )}
                        {finishMessageGrainStatus?.state === "blocked" && (
                          <span
                            className="text-xs font-medium"
                            data-testid="text-fa-finish-message-grain-blocked"
                          >
                            {finishMessageGrainStatus.detail}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span data-testid="text-fa-finish-message-grain-done">
                        All {inScope} in-scope month(s) are message-grain and counted in
                        the all-time headline.
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Task #2440 — surface how complete the all-time headline is.
                  Task #2436 silently excludes pre-floor and not-yet-message-grain
                  months from the totals above, so an operator can't tell from the
                  headline alone whether it covers every in-scope month. These
                  counts make the exclusion visible and point to the right fix
                  (upgrade sweep for wrong-grain, purge action for pre-floor). */}
              {(() => {
                const at = analyticsCoverage.allTime ?? {};
                const inScope = Number(at.inScopeMonths ?? 0);
                const included = Number(at.includedMonths ?? 0);
                const wrongGrain = Number(at.excludedWrongGrainMonths ?? 0);
                const preFloor = Number(at.excludedPreFloorMonths ?? 0);
                const hasExclusions = wrongGrain > 0 || preFloor > 0;
                return (
                  <div
                    className={`text-xs rounded p-2 mb-2 border ${
                      hasExclusions
                        ? "bg-amber-50 border-amber-200 text-amber-800"
                        : "bg-emerald-50 border-emerald-200 text-emerald-800"
                    }`}
                    data-testid="text-fa-coverage-completeness"
                  >
                    <span className="font-medium">
                      All-time headline covers {included.toLocaleString()} of{" "}
                      {inScope.toLocaleString()} in-scope month
                      {inScope === 1 ? "" : "s"}.
                    </span>{" "}
                    {hasExclusions ? (
                      <>
                        {wrongGrain > 0 ? (
                          <span data-testid="text-fa-excluded-wrong-grain">
                            {wrongGrain.toLocaleString()} excluded for wrong grain
                            (not yet message-grain) — run the message-grain upgrade
                            sweep.
                          </span>
                        ) : null}{" "}
                        {preFloor > 0 ? (
                          <span data-testid="text-fa-excluded-pre-floor">
                            {preFloor.toLocaleString()} pre-floor month
                            {preFloor === 1 ? "" : "s"} excluded — run{" "}
                            <span className="font-mono">
                              purge_pre_floor_front_coverage_rows
                            </span>{" "}
                            to tidy up.
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span data-testid="text-fa-coverage-complete">
                        Every in-scope month contributes — the headline is complete.
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Task #2802 — denominator floor reconciliation summary.
                  Task #2795's floor invariant raises front_total_messages to
                  the local message count when local exceeds what Front
                  reported, storing the excess per month. This banner surfaces
                  the headline count ("N months had their denominator raised")
                  with an expandable per-month breakdown.
                  Task #2818 — the server reconciliation note now renders as
                  VISIBLE text under each month row (tapping/clicking the
                  banner expands it), so touch devices see the full
                  explanation. This is safe against the Task #2603
                  no-conversation-vocabulary render guard because
                  buildFloorReconciliationNote was reworded server-side to say
                  "threads" instead of "conversations". */}
              {(() => {
                const monthsArr: AnalyticsCoverageMonth[] = Array.isArray(analyticsCoverage.months)
                  ? analyticsCoverage.months
                  : [];
                const floorMonths = monthsArr
                  .filter(
                    (m) =>
                      typeof m.denominatorFloorExcess === "number" &&
                      m.denominatorFloorExcess > 0,
                  )
                  .sort((a, b) =>
                    String(a.month).localeCompare(String(b.month)),
                  );
                if (floorMonths.length === 0) return null;
                const totalExcess = floorMonths.reduce(
                  (sum: number, m) =>
                    sum + Number(m.denominatorFloorExcess ?? 0),
                  0,
                );
                return (
                  <details
                    className="text-xs rounded p-2 mb-2 border bg-amber-50 border-amber-200 text-amber-800"
                    data-testid="details-fa-floor-summary"
                  >
                    <summary
                      className="cursor-pointer select-none"
                      data-testid="text-fa-floor-summary"
                    >
                      <span className="font-semibold">
                        ⚠ {floorMonths.length} month
                        {floorMonths.length === 1 ? "" : "s"} had{" "}
                        {floorMonths.length === 1 ? "its" : "their"} denominator
                        raised
                      </span>{" "}
                      (+{totalExcess.toLocaleString()} message
                      {totalExcess === 1 ? "" : "s"} total) — the local message
                      count exceeded Front's reported total, so the denominator
                      floor lifted the stored Front total to keep the coverage %
                      at or below 100%. Tap for per-month detail.
                    </summary>
                    <div
                      className="mt-1.5 flex flex-col gap-1"
                      data-testid="list-fa-floor-months"
                    >
                      {floorMonths.map((m) => (
                        <div
                          key={m.month}
                          className="flex flex-col gap-0"
                          data-testid={`row-fa-floor-month-${m.month}`}
                        >
                          <div className="flex items-baseline gap-2">
                            <span className="font-medium">{m.month}</span>
                            <span data-testid={`text-fa-floor-month-excess-${m.month}`}>
                              +{Number(m.denominatorFloorExcess).toLocaleString()}{" "}
                              message
                              {Number(m.denominatorFloorExcess) === 1 ? "" : "s"}{" "}
                              above Front's reported total
                            </span>
                          </div>
                          {m.denominatorFloorReconciliationNote ? (
                            <div
                              className="text-amber-700 leading-tight pl-2"
                              data-testid={`text-fa-floor-month-note-${m.month}`}
                            >
                              {m.denominatorFloorReconciliationNote}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })()}

              {/* Task #2481 — the adoption-date override row (Task #1656) was
                  removed. The floor is a hard-coded constant
                  (FRONT_ADOPTION_DATE = 2025-07-01) and is surfaced read-only
                  in the headline "Adoption date (fixed)" card above. */}


              <OutboundGapCloseReadout
                isAdmin={isAdmin}
                months={months}
                status={status}
              />



              <MessageGrainUpgradeReadout
                isAdmin={isAdmin}
                months={months}
                status={status}
              />



              <FinishMessageGrainDriverReadout
                isAdmin={isAdmin}
                status={status}
              />



              <AnalyticsMonthlyTable
                analyticsCoverage={analyticsCoverage}
                autoClosureStatus={autoClosureStatus}
                months={months}
                refetchAnalyticsCoverage={refetchAnalyticsCoverage}
                status={status}
                triggerGateBlockedReason={triggerGateBlockedReason}
              />

            </>
          )}


          <AnalyticsCoverageAlertsConfig
            isAdmin={isAdmin}
            months={months}
            status={status}
          />

        </div>
    </>
  );
}
