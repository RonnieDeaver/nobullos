// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { type FrontPlanLimitedFallback, frontPlanLimitState, FRONT_PLAN_LIMITED_MEMO_NOTE, getFrontConsoleMetric } from "@shared/frontConsoleMetrics";
import type { AnalyticsCoverageMonth, AnalyticsCoverageSummary, AutoClosureStatus, CoverageMonth, IntegrationStatus } from "./types";
import type { QueryObserverResult, RefetchOptions } from "@tanstack/react-query";
import { extractBlockedReason, FrontAnalyticsErrorCell } from "./shared";
import { PercentText } from "../PercentText";

type Props = {
  analyticsCoverage: AnalyticsCoverageSummary;
  autoClosureStatus: AutoClosureStatus | undefined;
  months: CoverageMonth[];
  refetchAnalyticsCoverage: (options?: RefetchOptions) => Promise<QueryObserverResult<AnalyticsCoverageSummary, Error>>;
  status: IntegrationStatus | undefined;
  triggerGateBlockedReason: string | null;
};

export function AnalyticsMonthlyTable({ analyticsCoverage, autoClosureStatus, months, refetchAnalyticsCoverage, status, triggerGateBlockedReason }: Props) {
  const { toast } = useToast();

  const [analyticsSortKey, setAnalyticsSortKey] = useState<
    "month" | "frontTotal" | "fetched" | "applied" | "ingestGap" | "applyGap" | "fetchedPct" | "coverage" | "inboundPct" | "outboundPct" | "pulledAt"
  >("month");

  const [analyticsSortDir, setAnalyticsSortDir] = useState<"asc" | "desc">("desc");

  // Task #2088 — close-state filter for the coverage table.
  //   all          → every month
  //   open         → not parked AND not webhook-dedupe-closed
  //   parked       → month is in autoClosureStatus.parkedWindows
  //   dedupe_closed→ closedVia === "webhook_dedupe"
  const [analyticsCloseStateFilter, setAnalyticsCloseStateFilter] = useState<
    "all" | "open" | "parked" | "dedupe_closed"
  >("all");


  // Task #1675 — operator-triggered, single-month synchronous refresh.
  // Bypasses the scheduler so an admin can validate a fix (e.g. after
  // an OAuth reconnect) without waiting for the next 30-min tick.
  // Task #1691 — Retry on plan-limited months passes
  // `forceSearchFallback: true` so the search-API fallback runs
  // synchronously instead of burning a guaranteed-403 Analytics submit
  // first. This is what makes a single Retry click immediately heal
  // months that Analytics can't see (e.g. Jul–Oct 2025 on the current
  // workspace plan), instead of needing the one-shot backfill script.
  const analyticsRefreshMonthMutation = useMutation<
    {
      month: string;
      outcome: string;
      errorCode?: string;
      errorMessage?: string;
      unrecoverable?: boolean;
      denominatorSource?: string | null;
      denominatorUnit?: string | null;
      pulledAt?: string | null;
      frontAnalyticsStatus?: string | null;
      frontAnalyticsError?: string | null;
      frontTotalMessages?: number;
    },
    Error,
    { month: string; forceSearchFallback?: boolean }
  >({
    meta: { silent: true },
    mutationFn: async ({ month, forceSearchFallback }) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/analytics-coverage/refresh-month",
        forceSearchFallback ? { month, forceSearchFallback: true } : { month },
      );
      return res.json();
    },
    onSuccess: (data) => {
      // Task #1780 — translate the structured response into
      // operator-readable copy. Manual Retry never returns
      // `skipped_existing_finalized` (the endpoint forces a rerun);
      // if the backend ever does, surface that as a blocked outcome
      // so it's visible rather than silently ignored.
      const m = data.month;
      if (data.outcome === "front_error") {
        const code = data.errorCode ?? "front_error";
        const detail =
          code === "front_analytics_auth_failed"
            ? "reconnect Front"
            : (data.errorMessage ?? code);
        toast({
          title: `Retry failed: ${code}`,
          description: detail,
          variant: "destructive",
        });
      } else if (data.outcome === "skipped_existing_finalized") {
        toast({
          title: `Retry blocked on ${m}`,
          description: "Row reported as already finalized; check kill switches.",
          variant: "destructive",
        });
      } else if (data.outcome === "ok_search_fallback") {
        if (data.frontAnalyticsStatus === "search_truncated") {
          toast({
            title: `Retry completed: Search fallback truncated (${m})`,
            description: data.frontAnalyticsError ?? "Hit page cap; count is a lower bound.",
          });
        } else {
          toast({
            title: `Retry completed: Search fallback OK (${m})`,
            description: `Denominator: ${Number(data.frontTotalMessages ?? 0).toLocaleString()}.`,
          });
        }
      } else if (data.outcome === "ok" || data.outcome === "ok_current_upsert") {
        toast({
          title: `Retry completed: Analytics OK (${m})`,
          description: `Denominator: ${Number(data.frontTotalMessages ?? 0).toLocaleString()} (${data.denominatorUnit ?? "inbound_messages"}).`,
        });
      } else {
        toast({
          title: `Retry ${m}: ${data.outcome}`,
          description: "Front Analytics row updated.",
        });
      }
      void refetchAnalyticsCoverage(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      // Task #1780 — server-side gate responses (503 from a kill
      // switch / queue pause) land here; surface the actual reason
      // instead of a generic failure.
      const raw = err.message ?? "";
      let title = "Retry failed";
      if (raw.includes("front_analytics_refresh_enabled=false")) {
        title = "Retry blocked: Front analytics refresh is disabled";
      } else if (raw.includes("queue paused")) {
        title = "Retry blocked: queue paused";
      } else if (raw.includes("KILL_SWITCH_NON_CRITICAL_SWEEPS")) {
        title = "Retry blocked: non-critical sweeps kill switch";
      }
      toast({
        title,
        description: extractBlockedReason(raw),
        variant: "destructive",
      });
    },
  });


  // Task #1692 — operator override that nulls `analytics_plan_limited_at`
  // for a single month and immediately re-runs `refreshMonth`. Lets an
  // admin re-probe Front Analytics right after a plan upgrade instead
  // of waiting out the ~7-day PLAN_LIMIT_REPROBE_TTL_MS cooldown.
  const analyticsReprobeMonthMutation = useMutation<
    { month: string; outcome: string; errorCode?: string; errorMessage?: string; denominatorSource?: string | null; denominatorUnit?: string | null },
    Error,
    string
  >({
    meta: { silent: true },
    mutationFn: async (month: string) => {
      const res = await apiRequest(
        "POST",
        "/api/admin/front/analytics-coverage/reprobe-month",
        { month },
      );
      return res.json();
    },
    onSuccess: (data) => {
      if (data.outcome === "front_error") {
        toast({
          title: `Re-probe ${data.month}: still failing`,
          description: data.errorMessage ?? data.errorCode ?? "Front error",
          variant: "destructive",
        });
      } else if (data.denominatorSource === "search_conversations") {
        toast({
          title: `Re-probe ${data.month}: still plan-limited`,
          description: "Analytics returned plan_limited again; row remains on search fallback.",
        });
      } else {
        toast({
          title: `Re-probe ${data.month}: ${data.outcome}`,
          description: `Front Analytics row updated${data.denominatorSource ? ` (source: ${data.denominatorSource})` : ""}.`,
        });
      }
      void refetchAnalyticsCoverage(); // fire-and-forget: refetch only
    },
    onError: (err: Error) => {
      // Task #2211 — surface the calm 503 gate reasons (refresh
      // disabled / queue paused / kill switch) instead of a generic
      // failure, mirroring the other coverage trigger buttons.
      const raw = err.message ?? "";
      let title = "Re-probe failed";
      if (raw.includes("front_analytics_refresh_enabled=false")) {
        title = "Re-probe blocked: Front analytics refresh is disabled";
      } else if (raw.includes("queue paused")) {
        title = "Re-probe blocked: queue paused";
      } else if (raw.includes("KILL_SWITCH_NON_CRITICAL_SWEEPS")) {
        title = "Re-probe blocked: non-critical sweeps kill switch";
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
              {/* Task #2088 — close-state filter for the coverage table. */}
              <div
                className="flex items-center gap-1 mb-1 text-xs"
                data-testid="filter-fa-close-state"
              >
                <span className="text-muted-foreground">Close state:</span>
                {([
                  ["all", "All"],
                  ["open", "Open"],
                  ["parked", "Parked"],
                  ["dedupe_closed", "Webhook-dedupe-closed"],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`px-2 py-0.5 rounded border ${
                      analyticsCloseStateFilter === k
                        ? "bg-slate-800 text-white border-slate-800"
                        : "bg-card text-muted-foreground border-border hover:bg-muted/50"
                    }`}
                    onClick={() => setAnalyticsCloseStateFilter(k)}
                    data-testid={`button-fa-close-state-filter-${k}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto" data-testid="table-front-analytics-monthly-wrap">
                <table className="w-full text-xs" data-testid="table-front-analytics-monthly">
                  <thead className="text-muted-foreground">
                    <tr className="border-b">
                      {([
                        ["month", "Month"],
                        ["frontTotal", "Front total"],
                        ["fetched", "Fetched"],
                        ["applied", "Applied"],
                        ["ingestGap", "Ingest gap"],
                        ["applyGap", "Apply gap"],
                        ["fetchedPct", "Fetched %"],
                        ["coverage", "Applied %"],
                        ["inboundPct", "Inbound %"],
                        ["outboundPct", "Outbound %"],
                        ["pulledAt", "Last pulled"],
                      ] as const).map(([k, label]) => (
                        <th
                          key={k}
                          className="text-left py-1 px-1 cursor-pointer select-none"
                          onClick={() => {
                            if (analyticsSortKey === k) {
                              setAnalyticsSortDir((d) => (d === "asc" ? "desc" : "asc"));
                            } else {
                              setAnalyticsSortKey(k as typeof analyticsSortKey);
                              setAnalyticsSortDir(k === "month" ? "desc" : "desc");
                            }
                          }}
                          data-testid={`th-fa-${k}`}
                        >
                          {label}
                          {analyticsSortKey === k && (
                            <span className="ml-1">{analyticsSortDir === "asc" ? "▲" : "▼"}</span>
                          )}
                        </th>
                      ))}
                      <th className="text-left py-1 px-1">Close state</th>
                      <th className="text-left py-1 px-1">Status</th>
                      <th className="text-left py-1 px-1">Error</th>
                      <th className="text-left py-1 px-1">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const months: AnalyticsCoverageMonth[] = Array.isArray(analyticsCoverage.months)
                        ? [...analyticsCoverage.months]
                        : [];
                      const cmp = (a: AnalyticsCoverageMonth, b: AnalyticsCoverageMonth) => {
                        const get = (m: AnalyticsCoverageMonth) => {
                          switch (analyticsSortKey) {
                            case "month": return m.month ?? "";
                            case "frontTotal": return Number(m.frontTotalMessages ?? 0);
                            case "fetched": return Number(m.fetchedIntoNobull ?? 0);
                            case "applied": return Number(m.appliedIntoNobull ?? 0);
                            case "ingestGap": return Number(m.ingestGap ?? 0);
                            case "applyGap": return Number(m.applyGap ?? 0);
                            case "fetchedPct": return Number(m.fetchedCoveragePct ?? 0);
                            case "coverage": return Number(m.appliedCoveragePct ?? 0);
                            case "inboundPct": return Number(m.messagesInboundCoveragePct ?? -1);
                            case "outboundPct": return Number(m.messagesOutboundCoveragePct ?? -1);
                            case "pulledAt": return m.pulledAt ? new Date(m.pulledAt).getTime() : 0;
                          }
                        };
                        const av = get(a); const bv = get(b);
                        if (av < bv) return analyticsSortDir === "asc" ? -1 : 1;
                        if (av > bv) return analyticsSortDir === "asc" ? 1 : -1;
                        return 0;
                      };
                      months.sort(cmp);
                      // Task #2088 — close-state filter. parked is a live
                      // signal from the auto-closure status; dedupe_closed is
                      // persisted per-row as closedVia === "webhook_dedupe".
                      const parkedSet = autoClosureStatus?.parkedWindows ?? {};
                      const filteredMonths = months.filter((m) => {
                        if (analyticsCloseStateFilter === "all") return true;
                        const isParked = Boolean(parkedSet[m.month]);
                        const isDedupeClosed = m.closedVia === "webhook_dedupe";
                        if (analyticsCloseStateFilter === "parked")
                          return isParked;
                        if (analyticsCloseStateFilter === "dedupe_closed")
                          return isDedupeClosed;
                        // "open" — neither parked nor dedupe-closed
                        return !isParked && !isDedupeClosed;
                      });
                      if (filteredMonths.length === 0) {
                        return (
                          <tr>
                            <td colSpan={15} className="text-center text-muted-foreground py-2">
                              {analyticsCloseStateFilter === "all"
                                ? "No monthly rows yet."
                                : "No months match this close-state filter."}
                            </td>
                          </tr>
                        );
                      }
                      return filteredMonths.map((m) => {
                        const pct = Number(m.appliedCoveragePct ?? 0);
                        const status: string = m.frontAnalyticsStatus ?? "unknown";
                        const err: string | null = m.frontAnalyticsError ?? null;
                        // Task #1837 — `unitsComparable` is derived
                        // server-side; older rows that pre-date the
                        // unit refactor will be false here until the
                        // recompute endpoint re-pulls a comparable
                        // denominator. When false, the coverage %
                        // would mix conversations vs messages, so we
                        // suppress the % cells and show a badge in the
                        // status column instead.
                        const unitsComparable: boolean = m.unitsComparable === true;
                        // Task #2669 — plan-limited months have no per-message
                        // history (Front's plan blocks it), so their stored % is
                        // a misleading grain mix. When set, render the honest
                        // conversation-grain fallback instead, and never apply the
                        // message-grain floor highlight to such a row.
                        const planLimitedFallback: FrontPlanLimitedFallback | null =
                          (m.planLimitedFallback ?? null) as FrontPlanLimitedFallback | null;
                        const belowFloor =
                          planLimitedFallback == null &&
                          typeof analyticsCoverage.thresholds?.monthFloorPct === "number" &&
                          status === "ok" &&
                          unitsComparable &&
                          pct < analyticsCoverage.thresholds.monthFloorPct;
                        return (
                          <tr
                            key={m.month}
                            className={`border-b ${belowFloor ? "bg-rose-50" : ""}`}
                            data-testid={`row-fa-month-${m.month}`}
                          >
                            <td className="py-1 px-1 font-medium">{m.month}</td>
                            <td className="py-1 px-1" data-testid={`text-fa-front-total-${m.month}`} data-metric-id={getFrontConsoleMetric("front.coverage.month_front_total").id}>
                              <div>{Number(m.frontTotalMessages ?? 0).toLocaleString()}</div>
                              {/* Task #1837 — explicit per-row source +
                                  unit label so operators don't have to
                                  guess whether the denominator came
                                  from Analytics (inbound_messages) or
                                  Conversations Search (conversations_all). */}
                              {/* Task #2603 — message-grain only. A row is
                                  either at real message grain (messages_all /
                                  inbound_messages) or still being measured up to
                                  it; we no longer surface the conversation-grain
                                  unit/label, only the source + grain status. */}
                              <div className="text-xs text-muted-foreground" data-testid={`text-fa-front-total-source-${m.month}`}>
                                {(() => {
                                  const isMsgGrain =
                                    m.denominatorUnit === "messages_all" ||
                                    m.denominatorUnit === "inbound_messages";
                                  const grainStatus = isMsgGrain
                                    ? "message-grain"
                                    : "pending message-grain";
                                  const source =
                                    m.denominatorSource === "search_conversations"
                                      ? "via Search"
                                      : m.denominatorSource === "analytics_reports"
                                        ? "via Analytics"
                                        : "source unknown";
                                  return `${source} · ${grainStatus}`;
                                })()}
                                {typeof m.analyticsMessagesInbound === "number"
                                  ? ` · Analytics msgs: ${Number(m.analyticsMessagesInbound).toLocaleString()}`
                                  : ""}
                              </div>
                              {/* Task #2685 — resolve the confusing
                                  messages_all + analytics_plan_limited_at combo:
                                  this row is at real message grain YET still
                                  carries a plan-limit memo. Without this label
                                  the message-grain % reads as a contradiction
                                  with the plan-limited flag. Message-grain
                                  wording only (no conversation vocabulary), so it
                                  never trips the Task #2603 no-conversation
                                  guard. The conversation-grain fallback case is
                                  handled separately in the Applied % cell. */}
                              {frontPlanLimitState({
                                analyticsPlanLimitedAt: m.analyticsPlanLimitedAt ?? null,
                                denominatorUnit: m.denominatorUnit ?? null,
                              }) === "message-grain-memoized" ? (
                                <div
                                  className="text-xs text-amber-700 leading-tight mt-0.5"
                                  data-testid={`text-fa-plan-memo-${m.month}`}
                                  title={FRONT_PLAN_LIMITED_MEMO_NOTE}
                                >
                                  plan-limit memo (message-grain)
                                </div>
                              ) : null}
                            </td>
                            <td className="py-1 px-1">{Number(m.fetchedIntoNobull ?? 0).toLocaleString()}</td>
                            <td className="py-1 px-1">{Number(m.appliedIntoNobull ?? 0).toLocaleString()}</td>
                            <td className={`py-1 px-1 ${unitsComparable && Number(m.ingestGap ?? 0) > 0 ? "text-amber-700" : ""}`} data-testid={`text-fa-ingest-gap-${m.month}`} data-metric-id={getFrontConsoleMetric("front.coverage.month_ingest_gap").id}>
                              {unitsComparable ? Number(m.ingestGap ?? 0).toLocaleString() : "—"}
                            </td>
                            <td className={`py-1 px-1 ${unitsComparable && Number(m.applyGap ?? 0) > 0 ? "text-rose-700" : ""}`} data-testid={`text-fa-apply-gap-${m.month}`} data-metric-id={getFrontConsoleMetric("front.coverage.month_apply_gap").id}>
                              {unitsComparable ? Number(m.applyGap ?? 0).toLocaleString() : "—"}
                            </td>
                            <td className="py-1 px-1" data-testid={`text-fa-fetched-pct-${m.month}`} data-metric-id={getFrontConsoleMetric("front.coverage.month_fetched_pct").id}>
                              {unitsComparable
                                ? <PercentText value={m.fetchedCoveragePct ?? 0} digits={2} />
                                : "—"}
                            </td>
                            {/* Task #2669 — for plan-limited months Front never
                                exposes per-message history, so the stored applied
                                % is a misleading grain mix. Render the honest,
                                explicitly-labeled conversation-grain fallback
                                ("X of Y conversations — Front plan blocks
                                per-message history") instead. Strict message-grain
                                months keep their normal %. */}
                            <td className="py-1 px-1 align-top max-w-[200px]" data-testid={`text-fa-applied-pct-${m.month}`} data-metric-id={getFrontConsoleMetric("front.coverage.month_applied_pct").id}>
                              {planLimitedFallback ? (
                                <div
                                  className="text-amber-800"
                                  title={`Front's analytics plan blocks per-message history for this month, so coverage is reported at conversation grain: ${planLimitedFallback.coveredConversations.toLocaleString()} of ${planLimitedFallback.totalConversations.toLocaleString()} conversations fetched.`}
                                  data-testid={`text-fa-plan-limited-${m.month}`}
                                >
                                  <div className="font-medium whitespace-nowrap">
                                    <PercentText value={planLimitedFallback.coveragePct} digits={2} /> conv
                                  </div>
                                  <div className="text-xs text-amber-700 leading-tight">
                                    {planLimitedFallback.label}
                                  </div>
                                </div>
                              ) : (
                                <span className={belowFloor ? "text-rose-700 font-medium" : ""}>
                                  {unitsComparable ? <PercentText value={pct} digits={2} /> : "—"}
                                </span>
                              )}
                              {/* Task #2795 — denominator floor reconciliation note.
                                  Shown when the local message count exceeded the
                                  Front-enumerated total; the floor raised the
                                  denominator so the % stays ≤ 100%.
                                  Task #2826 — the full note is a tap-expandable
                                  disclosure (not just a hover tooltip) so phone/
                                  tablet operators can read the explanation
                                  inline. The note wording is vocab-safe
                                  ("threads", Task #2818) so it may render as
                                  visible text without tripping the Task #2603
                                  no-conversation-vocabulary render guard. */}
                              {typeof m.denominatorFloorExcess === "number" &&
                                m.denominatorFloorExcess > 0 &&
                                m.denominatorFloorReconciliationNote ? (
                                <details
                                  className="text-xs text-amber-700 leading-tight mt-0.5"
                                  data-testid={`details-fa-floor-note-${m.month}`}
                                >
                                  <summary
                                    className="cursor-pointer list-none select-none"
                                    data-testid={`text-fa-floor-note-${m.month}`}
                                    title={m.denominatorFloorReconciliationNote}
                                  >
                                    ⚠ floor applied +{Number(m.denominatorFloorExcess).toLocaleString()}
                                  </summary>
                                  <div
                                    className="mt-0.5 whitespace-normal break-words text-amber-800"
                                    data-testid={`text-fa-floor-note-full-${m.month}`}
                                  >
                                    {m.denominatorFloorReconciliationNote}
                                  </div>
                                </details>
                              ) : null}
                            </td>
                            {/* Task #1974 — per-direction message coverage.
                                NULL on plan-limited months and pre-#1974
                                rows: render "not yet measured" rather than
                                a fake 0% that would imply outbound was
                                checked and came up empty. */}
                            {(() => {
                              const inPct = m.messagesInboundCoveragePct;
                              const outPct = m.messagesOutboundCoveragePct;
                              const inFront = m.messagesInboundFront;
                              const inLocal = m.messagesInboundLocal;
                              const inGap = m.messagesInboundGap;
                              const outFront = m.messagesOutboundFront;
                              const outLocal = m.messagesOutboundLocal;
                              const outGap = m.messagesOutboundGap;
                              const renderCell = (
                                pctVal: number | null,
                                frontVal: number | null,
                                localVal: number | null,
                                gapVal: number | null,
                                key: string,
                              ) => (
                                <td
                                  className={`py-1 px-1 ${typeof gapVal === "number" && gapVal > 0 ? "text-amber-700" : ""}`}
                                  data-testid={`text-fa-${key}-pct-${m.month}`}
                                >
                                  {typeof pctVal === "number" ? (
                                    <>
                                      <div><PercentText value={pctVal} digits={2} /></div>
                                      <div className="text-xs text-muted-foreground">
                                        {Number(localVal ?? 0).toLocaleString()} / {Number(frontVal ?? 0).toLocaleString()}
                                        {typeof gapVal === "number" && gapVal > 0
                                          ? ` · gap ${gapVal.toLocaleString()}`
                                          : ""}
                                      </div>
                                    </>
                                  ) : (
                                    <span
                                      className="text-muted-foreground italic"
                                      title="Per-direction counts are not yet available for this month (plan-limited or pre-#1974 row)."
                                    >
                                      not yet measured
                                    </span>
                                  )}
                                </td>
                              );
                              return (
                                <>
                                  {renderCell(inPct ?? null, inFront ?? null, inLocal ?? null, inGap ?? null, "inbound")}
                                  {renderCell(outPct ?? null, outFront ?? null, outLocal ?? null, outGap ?? null, "outbound")}
                                </>
                              );
                            })()}
                            <td className="py-1 px-1 whitespace-nowrap text-muted-foreground" data-testid={`text-fa-pulled-at-${m.month}`}>
                              {m.pulledAt ? new Date(m.pulledAt).toLocaleString() : "—"}
                            </td>
                            {/* Task #2088 — close-state column. parked is a
                                live auto-closure signal; webhook-dedupe-closed
                                is persisted on the row (closedVia). */}
                            <td className="py-1 px-1" data-testid={`text-fa-close-state-${m.month}`}>
                              {(() => {
                                const isParked = Boolean(
                                  autoClosureStatus?.parkedWindows?.[m.month],
                                );
                                const isDedupeClosed =
                                  m.closedVia === "webhook_dedupe";
                                if (isParked) {
                                  return (
                                    <Badge
                                      variant="outline"
                                      className="bg-amber-50 text-amber-800 border-amber-200"
                                      title="Auto-closure parked this window after repeated dead runs. Un-park it from the Self-heal console above."
                                      data-testid={`badge-fa-close-state-parked-${m.month}`}
                                    >
                                      parked
                                    </Badge>
                                  );
                                }
                                if (isDedupeClosed) {
                                  return (
                                    <Badge
                                      variant="outline"
                                      className="bg-violet-50 text-violet-700 border-violet-200"
                                      title="Closed because every page was already ingested via the live Front webhook (webhook dedupe) — no gap remained."
                                      data-testid={`badge-fa-close-state-dedupe-${m.month}`}
                                    >
                                      webhook-dedupe-closed
                                    </Badge>
                                  );
                                }
                                return (
                                  <Badge
                                    variant="outline"
                                    className="bg-muted/50 text-muted-foreground border-border"
                                    data-testid={`badge-fa-close-state-open-${m.month}`}
                                  >
                                    open
                                  </Badge>
                                );
                              })()}
                            </td>
                            <td className="py-1 px-1">
                              {/* Task #2087 — completeness badge is the
                                  primary signal. It separates "denominator
                                  measured" (isFinalizedMonth) from
                                  "ingest/apply actually complete" so a
                                  finalized-but-gappy month never reads as
                                  done. Derived server-side
                                  (completenessStatus / completenessReason).
                                  The legacy final/current state is demoted
                                  to a muted sub-label below. */}
                              {(() => {
                                const cs: string = m.completenessStatus ?? "in-progress";
                                const reason: string | undefined = m.completenessReason ?? undefined;
                                const styles: Record<string, string> = {
                                  covered: "bg-green-50 text-green-700 border-green-200",
                                  "ingest-gap": "bg-amber-50 text-amber-800 border-amber-300",
                                  "apply-gap": "bg-rose-50 text-rose-700 border-rose-300",
                                  "in-progress": "bg-sky-50 text-sky-700 border-sky-200",
                                  "not-measured": "bg-muted text-muted-foreground border-border border-dashed",
                                };
                                const labels: Record<string, string> = {
                                  covered: "covered",
                                  "ingest-gap": "ingest gap",
                                  "apply-gap": "apply gap",
                                  "in-progress": "in progress",
                                  "not-measured": "not measured",
                                };
                                return (
                                  <Badge
                                    variant="outline"
                                    className={styles[cs] ?? styles["in-progress"]}
                                    title={reason}
                                    data-testid={`badge-fa-completeness-${m.month}`}
                                  >
                                    {labels[cs] ?? cs}
                                  </Badge>
                                );
                              })()}
                              {/* Task #1783 — retriable error / unrecoverable
                                  pills remain alongside the completeness
                                  badge so operators can still see the raw
                                  failure state for non-terminal errors. */}
                              {err !== null && status !== "pending" ? (
                                <span title={err ?? undefined}>
                                  <Badge variant="outline" className="ml-1 bg-rose-50 text-rose-700 border-rose-200">error</Badge>
                                  {m.unrecoverable ? (
                                    <Badge
                                      variant="outline"
                                      className="ml-1 bg-rose-100 text-rose-800 border-rose-300"
                                      data-testid={`badge-fa-unrecoverable-${m.month}`}
                                    >
                                      unrecoverable
                                    </Badge>
                                  ) : null}
                                </span>
                              ) : status === "pending" ? (
                                <Badge variant="outline" className="ml-1 bg-muted/50 text-muted-foreground border-border">pending</Badge>
                              ) : null}
                              {/* Task #2087 — measurement-state sub-label.
                                  isFinalizedMonth still means "denominator
                                  measured"; surfaced muted so its semantics
                                  stay visible without reading as "done". */}
                              <div
                                className="text-xs text-muted-foreground mt-0.5"
                                data-testid={`text-fa-finalized-${m.month}`}
                              >
                                {m.isFinalizedMonth ? "denominator: finalized" : "denominator: current"}
                              </div>
                              {/* Task #1681 — denominator-source pill. Surfaces when the
                                  count came from the search fallback (or a truncated
                                  one) so operators don't compare inbound-conversations
                                  to inbound-messages without seeing the unit mismatch. */}
                              {m.denominatorSource === "search_conversations" ? (
                                <Badge
                                  variant="outline"
                                  className="ml-1 bg-amber-50 text-amber-800 border-amber-200"
                                  title={`Denominator from the Front search API fallback. Plan-limited month — Analytics will re-probe weekly.`}
                                  data-testid={`badge-fa-source-${m.month}`}
                                >
                                  {status === "search_truncated" ? "search (truncated)" : "search"}
                                </Badge>
                              ) : null}
                              {/* Task #1974 — the legacy "units not
                                  comparable" badge was removed; the
                                  per-direction Inbound % / Outbound %
                                  cells now carry the operator signal
                                  ("not yet measured" when null), and
                                  unitsComparable still controls whether
                                  the mixed-unit Applied % cell prints
                                  numbers. */}
                            </td>
                            <td
                              className="py-1 px-1 text-xs text-rose-700 max-w-[280px] align-top"
                              data-testid={`text-fa-error-${m.month}`}
                            >
                              {err ? (
                                <FrontAnalyticsErrorCell
                                  month={m.month}
                                  error={err}
                                  reasonHuman={m.reasonHuman ?? null}
                                />
                              ) : (
                                ""
                              )}
                            </td>
                            <td className="py-1 px-1">
                              {(() => {
                                // Task #1691 — a "plan-limited" month is
                                // one Front Analytics can't see on the
                                // current workspace plan. Three signals
                                // identify it:
                                //   1. The row is already sourced from the
                                //      search fallback.
                                //   2. The plan-limit memo is set
                                //      (`analyticsPlanLimitedAt`).
                                //   3. The persisted error contains the
                                //      Front plan-history phrase.
                                // On Retry for any such month, force the
                                // search fallback so the click immediately
                                // populates a non-zero denominator instead
                                // of burning a guaranteed-403 Analytics
                                // submit (the same outcome the one-shot
                                // backfill script would produce).
                                const errStr = (m.frontAnalyticsError ?? "") as string;
                                const isPlanLimited =
                                  m.denominatorSource === "search_conversations" ||
                                  m.analyticsPlanLimitedAt != null ||
                                  /plan does not give you access/i.test(errStr);
                                return (
                                  <div className="flex items-center gap-1">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={
                                        analyticsRefreshMonthMutation.isPending ||
                                        triggerGateBlockedReason != null
                                      }
                                      onClick={() =>
                                        analyticsRefreshMonthMutation.mutate({
                                          month: m.month,
                                          forceSearchFallback: isPlanLimited,
                                        })
                                      }
                                      title={
                                        triggerGateBlockedReason ??
                                        (isPlanLimited
                                          ? "Plan-limited month — runs search-API fallback directly"
                                          : undefined)
                                      }
                                      data-testid={`button-fa-retry-${m.month}`}
                                    >
                                      {isPlanLimited ? "Retry (search)" : "Retry"}
                                    </Button>
                                    {/* Task #1692 — visible only for rows whose denominator
                                        came from the search fallback. Clears
                                        analytics_plan_limited_at and re-runs refreshMonth so
                                        an operator who just upgraded their Front plan
                                        doesn't have to wait out the ~7-day re-probe TTL. */}
                                    {m.denominatorSource === "search_conversations" ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100"
                                        title={
                                          triggerGateBlockedReason ??
                                          "Clear the plan-limit memo and re-probe Front Analytics now (use after a Front plan upgrade)."
                                        }
                                        disabled={
                                          analyticsReprobeMonthMutation.isPending ||
                                          triggerGateBlockedReason != null
                                        }
                                        onClick={() => analyticsReprobeMonthMutation.mutate(m.month)}
                                        data-testid={`button-fa-reprobe-${m.month}`}
                                      >
                                        Re-probe Analytics
                                      </Button>
                                    ) : null}
                                    {/* Task #1974 — Reconnect Front button
                                        appears when the per-row error maps
                                        to an OAuth/auth fix (needsReconnect
                                        is derived server-side via
                                        explainFrontAnalyticsError). Single
                                        click jumps straight to the Front
                                        OAuth re-grant — same endpoint the
                                        Integrations Hub uses — so the
                                        operator never has to leave the
                                        analytics panel to unblock the row. */}
                                    {m.needsReconnect ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                                        title="Front authorization failed — re-grant OAuth and the row will auto-retry on the next scheduler tick."
                                        data-testid={`button-fa-reconnect-front-${m.month}`}
                                        onClick={async () => {
                                          try {
                                            const res = await fetch(
                                              "/api/integrations/front/authorize",
                                              { credentials: "include" },
                                            );
                                            if (!res.ok) {
                                              throw new Error("Failed to start Front authorization");
                                            }
                                            const data = await res.json();
                                            if (data.url) {
                                              window.location.href = data.url;
                                            } else {
                                              throw new Error(data.error || "No authorization URL returned");
                                            }
                                          } catch (e: any) {
                                            toast({
                                              title: "Reconnect failed",
                                              description: e?.message ?? String(e),
                                              variant: "destructive",
                                            });
                                          }
                                        }}
                                      >
                                        Reconnect Front
                                      </Button>
                                    ) : null}
                                  </div>
                                );
                              })()}
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
    </>
  );
}
