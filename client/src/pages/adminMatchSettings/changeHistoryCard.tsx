// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { AlertTriangle, ChevronDown, ChevronRight, History, RefreshCw, RotateCcw } from "lucide-react";
import { type Dispatch, Fragment, type SetStateAction } from "react";
import { AlertAutoRetryStatusLine, AlertStatusBadge, ResendByBadge } from "./alertBadges";
import { formatNumber, formatUser } from "./guardrails";
import { DEFAULT_ALERT_AUTO_RETRY_MAX_ATTEMPTS, type Scope } from "./model";
import { DismissReasonDelta, RoutedToReviewSparkline } from "./trendVisuals";
import type { ChangeHistoryBag } from "./useChangeHistory";
import type { CoreSettingsBag } from "./useCoreSettings";

type ChangeHistoryCardProps = {
  historyDomain: ChangeHistoryBag;
  core: CoreSettingsBag;
  retryError: { id: string; message: string } | null;
  retryingHistoryId: string | null;
  setRetryError: Dispatch<SetStateAction<{ id: string; message: string } | null>>;
  setRetryingHistoryId: Dispatch<SetStateAction<string | null>>;
};

export function ChangeHistoryCard(props: ChangeHistoryCardProps) {
  const { ZOOM_GUARDRAIL_TREND_KEY_SET, bulkRetryAlertsMutation, bulkRetryBreakdownOpen, bulkRetrySummary, guardrailTrendByHistoryId, guardrailTrendsLoading, highlightedHistoryId, history, jumpToHistoryRow, restoringThresholdRowId, retryAlertMutation, setBulkRetryBreakdownOpen, setBulkRetrySummary, setPendingThresholdRestoreRowId } = props.historyDomain;
  const { data, error, updateMutation } = props.core;
  const { retryError, retryingHistoryId, setRetryError, setRetryingHistoryId } = props;
  return (
    <>
            <div className="bg-card rounded-lg border shadow-sm overflow-hidden" data-testid="card-history">
              <div className="px-4 py-3 border-b bg-muted/50 flex items-center gap-2">
                <History className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Change History</h3>
                <span className="text-xs text-muted-foreground">latest 50</span>
                {(() => {
                  const failedIds = (history?.rows || [])
                    .filter(r => r.slackStatus === "failed" || r.emailStatus === "failed")
                    .map(r => r.id);
                  if (failedIds.length === 0) return null;
                  const isPending = bulkRetryAlertsMutation.isPending;
                  return (
                    <button
                      type="button"
                      className="ml-auto inline-flex items-center px-2.5 py-1 rounded border text-xs font-medium bg-card text-amber-700 border-amber-300 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={`Re-send the failed alerts for all ${failedIds.length} affected row${failedIds.length === 1 ? "" : "s"}.`}
                      disabled={isPending}
                      onClick={() => {
                        setBulkRetrySummary(null);
                        setBulkRetryBreakdownOpen(false);
                        bulkRetryAlertsMutation.mutate(failedIds);
                      }}
                      data-testid="button-retry-all-failed-alerts"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
                      {isPending ? "Retrying…" : `Retry all failed (${failedIds.length})`}
                    </button>
                  );
                })()}
              </div>
              {bulkRetrySummary && (
                <div
                  className={`px-4 py-2 border-b text-xs ${
                    bulkRetrySummary.kind === "success"
                      ? "bg-emerald-50 text-emerald-800"
                      : "bg-amber-50 text-amber-900"
                  }`}
                  data-testid="text-bulk-retry-summary"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{bulkRetrySummary.message}</span>
                    {bulkRetrySummary.results && bulkRetrySummary.results.length > 0 && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 underline hover:no-underline"
                        onClick={() => setBulkRetryBreakdownOpen(v => !v)}
                        data-testid="button-toggle-bulk-retry-breakdown"
                        aria-expanded={bulkRetryBreakdownOpen}
                      >
                        {bulkRetryBreakdownOpen ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                        {bulkRetryBreakdownOpen ? "Hide details" : "Show details"}
                      </button>
                    )}
                  </div>
                  {bulkRetryBreakdownOpen && bulkRetrySummary.results && bulkRetrySummary.results.length > 0 && (
                    <ul
                      className="mt-2 space-y-1 max-h-60 overflow-y-auto"
                      data-testid="list-bulk-retry-breakdown"
                    >
                      {bulkRetrySummary.results.map(r => {
                        const shortId = r.id.length > 8 ? `${r.id.slice(0, 8)}…` : r.id;
                        const statusLabel =
                          r.status === "succeeded"
                            ? "Succeeded"
                            : r.status === "failed"
                              ? "Still failed"
                              : "Could not retry";
                        const statusClass =
                          r.status === "succeeded"
                            ? "bg-emerald-100 text-emerald-800"
                            : r.status === "failed"
                              ? "bg-amber-100 text-amber-900"
                              : "bg-rose-100 text-rose-900";
                        const canJump = r.status !== "succeeded";
                        return (
                          <li
                            key={r.id}
                            className="flex items-start gap-2 text-[11px] leading-tight"
                            data-testid={`row-bulk-retry-breakdown-${r.id}`}
                          >
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded font-medium uppercase tracking-wide whitespace-nowrap ${statusClass}`}
                            >
                              {statusLabel}
                            </span>
                            <span className="font-mono text-foreground" title={r.id}>
                              {shortId}
                            </span>
                            {r.error && (
                              <span className="text-foreground italic">— {r.error}</span>
                            )}
                            {canJump && (
                              <button
                                type="button"
                                className="ml-auto underline text-[11px] text-foreground hover:no-underline"
                                onClick={() => jumpToHistoryRow(r.id)}
                                data-testid={`button-jump-to-history-${r.id}`}
                              >
                                Jump to row
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
              {history?.channels &&
                !history.channels.slackConfigured &&
                !history.channels.emailConfigured && (
                  <div
                    className="px-4 py-3 border-b bg-amber-50 flex items-start gap-2"
                    data-testid="banner-no-alert-channels"
                  >
                    <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-900">
                      Neither Slack nor email alerts are configured. Threshold changes are only
                      surfaced as in-app notifications — your teammates won't get an external ping.
                    </p>
                  </div>
                )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">When</th>
                      <th className="px-4 py-2 font-medium">Scope</th>
                      <th className="px-4 py-2 font-medium">Setting</th>
                      <th className="px-4 py-2 font-medium">Old</th>
                      <th className="px-4 py-2 font-medium">New</th>
                      <th className="px-4 py-2 font-medium">By</th>
                      <th className="px-4 py-2 font-medium">Impact</th>
                      <th className="px-4 py-2 font-medium">Alerts</th>
                      <th className="px-4 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(history?.rows || []).length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-6 text-center text-sm text-muted-foreground" data-testid="text-history-empty">
                          No changes recorded yet.
                        </td>
                      </tr>
                    ) : (
                      (history?.rows || []).map((row) => {
                        const isZoomGuardrail =
                          row.source === "zoom" &&
                          ZOOM_GUARDRAIL_TREND_KEY_SET.has(row.settingKey);
                        const trend = isZoomGuardrail
                          ? guardrailTrendByHistoryId.get(row.id) ?? null
                          : null;
                        const dismissBefore = trend?.dismissReasons.before;
                        const dismissAfter = trend?.dismissReasons.after;
                        const hasDismissData = !!(
                          trend &&
                          ((dismissBefore && (Object.keys(dismissBefore.byReason).length > 0 || dismissBefore.total > 0)) ||
                            (dismissAfter && (Object.keys(dismissAfter.byReason).length > 0 || dismissAfter.total > 0)))
                        );
                        return (
                        <Fragment key={row.id}>
                        <tr
                          id={`history-row-${row.id}`}
                          className={
                            highlightedHistoryId === row.id
                              ? "bg-amber-100 transition-colors duration-500"
                              : "transition-colors duration-500"
                          }
                          data-testid={`row-history-${row.id}`}
                        >
                          <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(row.changedAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-xs">
                            <span className="px-2 py-0.5 rounded bg-muted text-foreground">{row.source}</span>
                          </td>
                          <td className="px-4 py-2 font-mono text-xs">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span>{row.settingKey}</span>
                              {row.restoreFromHistoryId && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-medium uppercase tracking-wide"
                                  title={
                                    row.restoreFromChangedAt
                                      ? `Restored from history entry on ${new Date(row.restoreFromChangedAt).toLocaleString()}`
                                      : `Restored from history entry ${row.restoreFromHistoryId}`
                                  }
                                  data-testid={`badge-history-restored-${row.id}`}
                                >
                                  {row.restoreFromChangedAt
                                    ? `Restored from ${new Date(row.restoreFromChangedAt).toISOString().slice(0, 10)}`
                                    : "Restored"}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{formatNumber(row.oldValue)}</td>
                          <td className="px-4 py-2 font-mono text-xs text-foreground">
                            {row.newValue === null ? <span className="italic text-muted-foreground">cleared</span> : formatNumber(row.newValue)}
                          </td>
                          <td className="px-4 py-2 text-xs text-foreground">{formatUser(row)}</td>
                          <td
                            className="px-4 py-2 text-xs whitespace-nowrap"
                            data-testid={`cell-history-trend-${row.id}`}
                          >
                            {isZoomGuardrail ? (
                              trend ? (
                                <RoutedToReviewSparkline
                                  trend={trend}
                                  testId={`sparkline-history-${row.id}`}
                                />
                              ) : (
                                <span
                                  className="text-[10px] text-muted-foreground italic"
                                  data-testid={`text-history-trend-empty-${row.id}`}
                                >
                                  {guardrailTrendsLoading ? "…" : "—"}
                                </span>
                              )
                            ) : (
                              <span className="text-[10px] text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-xs whitespace-nowrap">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <AlertStatusBadge
                                channel="slack"
                                status={row.slackStatus}
                                rowId={row.id}
                                failureReason={row.slackFailureReason}
                                attemptCount={row.slackAttemptCount}
                                maxAttempts={history?.autoRetry?.maxAttempts}
                              />
                              <AlertStatusBadge
                                channel="email"
                                status={row.emailStatus}
                                rowId={row.id}
                                failureReason={row.emailFailureReason}
                                attemptCount={row.emailAttemptCount}
                                maxAttempts={history?.autoRetry?.maxAttempts}
                              />
                              {(row.slackStatus === "failed" || row.emailStatus === "failed") && (
                                <button
                                  type="button"
                                  className="inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide bg-card text-amber-700 border-amber-300 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                  title="Re-send the failed alert(s) for this change."
                                  disabled={retryingHistoryId === row.id}
                                  onClick={() => {
                                    setRetryingHistoryId(row.id);
                                    setRetryError(null);
                                    retryAlertMutation.mutate(row.id);
                                  }}
                                  data-testid={`button-retry-alert-${row.id}`}
                                >
                                  <RefreshCw
                                    className={`w-3 h-3 mr-1 ${retryingHistoryId === row.id ? "animate-spin" : ""}`}
                                  />
                                  {retryingHistoryId === row.id ? "Retrying" : "Retry"}
                                </button>
                              )}
                            </div>
                            {retryError && retryError.id === row.id && (
                              <div
                                className="mt-1 text-[11px] text-red-600"
                                data-testid={`text-retry-alert-error-${row.id}`}
                              >
                                {retryError.message}
                              </div>
                            )}
                            <AlertAutoRetryStatusLine
                              row={row}
                              maxAttempts={
                                history?.autoRetry?.maxAttempts ??
                                DEFAULT_ALERT_AUTO_RETRY_MAX_ATTEMPTS
                              }
                              testIdSuffix={row.id}
                            />
                            <ResendByBadge
                              lastResendAt={row.lastResendAt}
                              lastResendBy={row.lastResendBy}
                              lastResendByUser={row.lastResendByUser}
                              lastResendSource={row.lastResendSource}
                              testIdSuffix={row.id}
                            />
                          </td>
                          <td className="px-4 py-2 text-xs whitespace-nowrap">
                            {(() => {
                              const currentRow = data?.rows.find(
                                (r) => r.scope === row.source && r.key === row.settingKey,
                              );
                              const currentValue = currentRow?.persistedValue ?? null;
                              const isNoOp = currentValue === row.oldValue;
                              const isRestoring = restoringThresholdRowId === row.id;
                              const tooltip = isNoOp
                                ? "Already at this value — nothing to restore"
                                : `Restore ${row.settingKey} to ${formatNumber(row.oldValue)}`;
                              return (
                                <button
                                  type="button"
                                  className="inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide bg-card text-emerald-700 border-emerald-300 hover:bg-emerald-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                  title={tooltip}
                                  disabled={isNoOp || isRestoring || updateMutation.isPending}
                                  onClick={() => setPendingThresholdRestoreRowId(row.id)}
                                  data-testid={`button-history-restore-${row.id}`}
                                >
                                  <RotateCcw
                                    className={`w-3 h-3 mr-1 ${isRestoring ? "animate-spin" : ""}`}
                                  />
                                  {isRestoring ? "Restoring" : "Restore"}
                                </button>
                              );
                            })()}
                          </td>
                        </tr>
                        {trend && hasDismissData && (
                          <tr
                            data-testid={`row-history-dismiss-${row.id}`}
                            className="bg-muted/20"
                          >
                            <td
                              colSpan={9}
                              className="px-4 py-1.5 border-t border-dashed border-border"
                            >
                              <DismissReasonDelta
                                trend={trend}
                                testId={`dismiss-history-${row.id}`}
                              />
                            </td>
                          </tr>
                        )}
                        </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
    </>
  );
}
