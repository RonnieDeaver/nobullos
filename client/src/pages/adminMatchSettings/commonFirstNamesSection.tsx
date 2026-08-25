// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { LastEditedBadge } from "@/components/LastEditedBadge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { Activity, ChevronDown, ChevronRight, History, RefreshCw, RotateCcw, Save, Users, X } from "lucide-react";
import { type Dispatch, Fragment, type SetStateAction, useState } from "react";
import { DangerZone } from "@/components/kit/DangerZone";
import { Link } from "wouter";
import { AlertStatusBadge, ResendByBadge } from "./alertBadges";
import { ZOOM_COMMON_FIRST_NAMES_KEY, diffNameLists, summarizeNameList } from "./model";
import { DismissReasonDelta, GuardrailDismissReasonAnchoredDelta, GuardrailImpactSparkline, RoutedToReviewSparkline, formatAnchorTooltip, formatDurationShort, renderTrendDelta } from "./trendVisuals";
import { NAMES_TREND_WINDOW_OPTIONS } from "./viewPrefs";
import type { ChangeHistoryBag } from "./useChangeHistory";
import type { CommonFirstNamesBag } from "./useCommonFirstNames";
import type { CoreSettingsBag } from "./useCoreSettings";

type CommonFirstNamesSectionProps = {
  names: CommonFirstNamesBag;
  historyDomain: ChangeHistoryBag;
  core: CoreSettingsBag;
  commonFirstNamesAnchorAuditId: string | null;
  retryError: { id: string; message: string } | null;
  retryingHistoryId: string | null;
  setCommonFirstNamesAnchorAuditId: Dispatch<SetStateAction<string | null>>;
  setRetryError: Dispatch<SetStateAction<{ id: string; message: string } | null>>;
  setRetryingHistoryId: Dispatch<SetStateAction<string | null>>;
  toast: ReturnType<typeof useToast>["toast"];
};

export function CommonFirstNamesSection(props: CommonFirstNamesSectionProps) {
  const { bulkRetryNamesAlertsMutation, bulkRetryNamesBreakdownOpen, bulkRetryNamesSummary, compareCopied, compareIds, compareMode, namesData, namesDraft, namesDraftDirty, namesHistory, namesLoading, namesMutation, namesTrendByAuditId, namesTrendByAuditIdEmail, namesTrendWindowId, namesTrendsLoading, navigate, pendingCompareRestore, pendingRestoreRowId, previewRowId, restoreMutation, restoringRowId, retryNamesAlertMutation, search, setBulkRetryNamesBreakdownOpen, setBulkRetryNamesSummary, setCompareCopied, setCompareIds, setCompareMode, setNamesDraft, setNamesDraftDirty, setNamesTrendWindowId, setPendingCompareRestore, setPendingRestoreRowId, setPreviewRowId, setRestoreError, setRestoringRowId, toggleCompareSelect } = props.names;
  const { history } = props.historyDomain;
  const { data, error, guardrailImpact, guardrailImpactQuery, impact } = props.core;
  const { commonFirstNamesAnchorAuditId, retryError, retryingHistoryId, setCommonFirstNamesAnchorAuditId, setRetryError, setRetryingHistoryId, toast } = props;
  // Task #4357: "Reset to default" discards the whole curated override, so
  // it lives in a DangerZone below the editor (not beside routine Save) and
  // confirms before firing. History restore remains the recovery path.
  const [confirmNamesResetOpen, setConfirmNamesResetOpen] = useState(false);
  return (
    <>
            <div
              className="bg-card rounded-lg border shadow-sm overflow-hidden"
              data-testid="card-common-first-names"
            >
              <div className="px-4 py-3 border-b bg-muted/50 flex items-center gap-2 flex-wrap">
                <Users className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Zoom Guardrail — Common First Names List</h3>
                <span
                  className={`ml-2 text-xs px-2 py-0.5 rounded border ${
                    namesData?.isOverridden
                      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                      : "bg-muted text-foreground border-border"
                  }`}
                  data-testid="badge-common-first-names-source"
                >
                  {namesData?.isOverridden ? "persisted override" : "code default"}
                </span>
                {(() => {
                  const perKey = guardrailImpact?.perKey?.[ZOOM_COMMON_FIRST_NAMES_KEY];
                  const loading = guardrailImpactQuery.isFetching;
                  const count = guardrailImpact?.reasonSummary.byReason.contact_name_only_weak ?? 0;
                  const afterCount = perKey?.after?.byReason.contact_name_only_weak ?? 0;
                  const beforeCount = perKey?.before?.byReason.contact_name_only_weak ?? 0;
                  const hasAnchoredDelta =
                    !!perKey?.anchor && !!perKey.after && !!perKey.before;
                  const isCustomAnchor = !!commonFirstNamesAnchorAuditId;
                  const customAnchorRow = isCustomAnchor
                    ? (namesHistory?.rows || []).find(
                        (r) => r.id === commonFirstNamesAnchorAuditId,
                      )
                    : null;
                  const customAnchorLabel = customAnchorRow
                    ? new Date(customAnchorRow.changedAt).toLocaleString()
                    : null;
                  const anchorTooltip = formatAnchorTooltip(perKey);
                  const anchorScopeTooltip = isCustomAnchor
                    ? `Anchored on selected history row${customAnchorLabel ? ` (${customAnchorLabel})` : ""}.`
                    : `Δ compares an equal-length window before vs. after the last list change.`;
                  return (
                    <span
                      className={`ml-auto inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${
                        isCustomAnchor
                          ? "border-amber-300 bg-amber-50 text-amber-900"
                          : "border-indigo-200 bg-indigo-50 text-indigo-800"
                      }`}
                      title={
                        `Items currently routed to review for reason: Contact name only (weak) (chosen window). ` +
                        `${anchorScopeTooltip} ${anchorTooltip}`
                      }
                      data-testid="guardrail-impact-common-first-names"
                      data-anchor={perKey?.anchor || ""}
                      data-anchor-audit-id={commonFirstNamesAnchorAuditId || ""}
                    >
                      <Activity className="w-2.5 h-2.5" />
                      Contact name only (weak):
                      <span className="font-mono font-semibold">
                        {loading ? "…" : count}
                      </span>
                      {!loading && hasAnchoredDelta && (
                        <span
                          className="inline-flex items-center gap-0.5"
                          data-testid="guardrail-impact-common-first-names-trend"
                        >
                          <span className="text-muted-foreground">Δ</span>
                          {renderTrendDelta(afterCount, beforeCount)}
                        </span>
                      )}
                      {!loading && hasAnchoredDelta && (
                        <GuardrailImpactSparkline
                          buckets={perKey?.buckets?.contact_name_only_weak}
                          sampleMs={perKey?.sampleMs ?? 0}
                          reasonLabel="Contact name only (weak)"
                          reasonKey="contact_name_only_weak"
                          testId="guardrail-impact-common-first-names-sparkline"
                        />
                      )}
                      <span className="text-muted-foreground font-normal ml-0.5">
                        {perKey?.anchor
                          ? isCustomAnchor
                            ? `Δ vs ${formatDurationShort(perKey.sampleMs)} around selected change${customAnchorLabel ? ` (${customAnchorLabel})` : ""}`
                            : `Δ vs ${formatDurationShort(perKey.sampleMs)} before last change`
                          : "no change recorded"}
                      </span>
                      {!loading && perKey?.anchor && (
                        <GuardrailDismissReasonAnchoredDelta
                          perKey={perKey}
                          testId="guardrail-impact-common-first-names-dismiss"
                        />
                      )}
                      {isCustomAnchor && (
                        <button
                          type="button"
                          className="ml-1 inline-flex items-center text-amber-900 hover:text-amber-700"
                          onClick={() => setCommonFirstNamesAnchorAuditId(null)}
                          title="Clear custom anchor and return to the latest-change anchor"
                          data-testid="button-guardrail-impact-common-first-names-clear-anchor"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </span>
                  );
                })()}
              </div>
              <div className="px-4 py-4 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Tokens in this list are treated as weak contact-name signals and routed to review when they're
                  the only Zoom evidence. Comma- or newline-separated. Leave blank to use the built-in list
                  ({namesData?.defaults.length ?? 0} entries).
                </p>
                <Textarea
                  value={namesDraft}
                  onChange={(e) => {
                    setNamesDraft(e.target.value);
                    setNamesDraftDirty(true);
                  }}
                  placeholder={namesLoading ? "Loading…" : "alex, sam, chris, ..."}
                  rows={6}
                  className="font-mono text-xs"
                  data-testid="input-common-first-names"
                  disabled={namesMutation.isPending}
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      const parsed = namesDraft
                        .split(/[,\n]/)
                        .map(s => s.trim())
                        .filter(s => s.length > 0);
                      namesMutation.mutate({ names: parsed.length > 0 ? parsed : null });
                    }}
                    disabled={namesMutation.isPending || !namesDraftDirty}
                    data-testid="button-save-common-first-names"
                  >
                    <Save className="w-3.5 h-3.5 mr-1" /> Save list
                  </Button>
                  <span className="text-xs text-muted-foreground" data-testid="text-common-first-names-effective-count">
                    Effective list: {namesData?.effective.length ?? 0} names
                  </span>
                </div>
                <LastEditedBadge
                  info={namesData?.lastEdited}
                  testId="last-edited-common-first-names"
                  emptyText={namesData?.isOverridden ? "Never edited" : "Using default — never overridden"}
                />
                {namesMutation.isError && (
                  <div className="text-xs text-red-600" data-testid="text-common-first-names-error">
                    {(namesMutation.error as Error)?.message}
                  </div>
                )}
                {namesData?.isOverridden && (
                  <DangerZone
                    title="Reset to built-in list"
                    description={`Discards the persisted override and returns matching to the built-in list (${namesData?.defaults.length ?? 0} entries). The current custom list stays recoverable from the edit history below.`}
                    testId="danger-zone-common-first-names"
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmNamesResetOpen(true)}
                      disabled={namesMutation.isPending}
                      data-testid="button-clear-common-first-names"
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reset to default
                    </Button>
                  </DangerZone>
                )}
                <AlertDialog open={confirmNamesResetOpen} onOpenChange={setConfirmNamesResetOpen}>
                  <AlertDialogContent data-testid="dialog-confirm-clear-common-first-names">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Reset common first names to default?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The persisted override ({namesData?.effective.length ?? 0} names) is
                        removed and the built-in list ({namesData?.defaults.length ?? 0} names)
                        takes effect immediately for Zoom matching. You can restore the
                        current list later from the edit history.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel data-testid="button-clear-common-first-names-abort">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        data-testid="button-clear-common-first-names-confirm"
                        onClick={() => {
                          setConfirmNamesResetOpen(false);
                          namesMutation.mutate({ names: null });
                        }}
                      >
                        Reset to default
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>

            <div
              className="bg-card rounded-lg border shadow-sm overflow-hidden"
              data-testid="card-common-first-names-history"
            >
              <div className="px-4 py-3 border-b bg-muted/50 flex items-center gap-2 flex-wrap">
                <History className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">
                  Common First Names — Edit History
                </h3>
                <span className="text-xs text-muted-foreground">latest 25</span>
                <div className="ml-auto flex items-center gap-3 flex-wrap">
                  <div
                    className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                    data-testid="group-common-first-names-trend-window"
                  >
                    <span className="uppercase tracking-wide text-muted-foreground">Impact window</span>
                    {NAMES_TREND_WINDOW_OPTIONS.map((opt) => {
                      const active = namesTrendWindowId === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={`px-2 py-0.5 rounded border ${
                            active
                              ? "bg-indigo-600 border-indigo-600 text-white"
                              : "bg-card border-border text-foreground hover:bg-muted/50"
                          }`}
                          onClick={() => setNamesTrendWindowId(opt.id)}
                          data-testid={`button-common-first-names-trend-window-${opt.id}`}
                        >
                          ±{opt.label}
                        </button>
                      );
                    })}
                    {namesTrendsLoading && (
                      <span className="text-[10px] italic text-muted-foreground">loading…</span>
                    )}
                  </div>
                  {compareMode && compareIds.length > 0 && (
                    <span
                      className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-2 py-0.5"
                      data-testid="text-compare-selection-count"
                    >
                      {compareIds.length === 1 ? "1 selected · vs. live" : `${compareIds.length}/2 selected`}
                    </span>
                  )}
                  <Button
                    variant={compareMode ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setCompareMode((prev) => {
                        const next = !prev;
                        if (!next) {
                          setCompareIds([]);
                          setCompareCopied(null);
                        }
                        return next;
                      });
                    }}
                    data-testid="button-toggle-compare-mode"
                  >
                    {compareMode ? "Exit compare" : "Compare snapshots"}
                  </Button>
                  {(() => {
                    const failedIds = (namesHistory?.rows || [])
                      .filter(
                        (r: any) =>
                          r.slackStatus === "failed" || r.emailStatus === "failed",
                      )
                      .map((r: any) => r.id as string);
                    if (failedIds.length === 0) return null;
                    const isPending = bulkRetryNamesAlertsMutation.isPending;
                    return (
                      <button
                        type="button"
                        className="inline-flex items-center px-2.5 py-1 rounded border text-xs font-medium bg-card text-amber-700 border-amber-300 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={`Re-send the failed alerts for all ${failedIds.length} affected row${failedIds.length === 1 ? "" : "s"}.`}
                        disabled={isPending}
                        onClick={() => {
                          setBulkRetryNamesSummary(null);
                          setBulkRetryNamesBreakdownOpen(false);
                          bulkRetryNamesAlertsMutation.mutate(failedIds);
                        }}
                        data-testid="button-retry-all-failed-alerts-common-first-names"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 mr-1.5 ${isPending ? "animate-spin" : ""}`}
                        />
                        {isPending
                          ? "Retrying…"
                          : `Retry all failed (${failedIds.length})`}
                      </button>
                    );
                  })()}
                </div>
              </div>
              {bulkRetryNamesSummary && (
                <div
                  className={`px-4 py-2 border-b text-xs ${
                    bulkRetryNamesSummary.kind === "success"
                      ? "bg-emerald-50 text-emerald-800"
                      : "bg-amber-50 text-amber-900"
                  }`}
                  data-testid="text-bulk-retry-summary-common-first-names"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{bulkRetryNamesSummary.message}</span>
                    {bulkRetryNamesSummary.results &&
                      bulkRetryNamesSummary.results.length > 0 && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 underline hover:no-underline"
                          onClick={() =>
                            setBulkRetryNamesBreakdownOpen((v) => !v)
                          }
                          data-testid="button-toggle-bulk-retry-breakdown-common-first-names"
                          aria-expanded={bulkRetryNamesBreakdownOpen}
                        >
                          {bulkRetryNamesBreakdownOpen ? (
                            <ChevronDown className="w-3 h-3" />
                          ) : (
                            <ChevronRight className="w-3 h-3" />
                          )}
                          {bulkRetryNamesBreakdownOpen
                            ? "Hide details"
                            : "Show details"}
                        </button>
                      )}
                  </div>
                  {bulkRetryNamesBreakdownOpen &&
                    bulkRetryNamesSummary.results &&
                    bulkRetryNamesSummary.results.length > 0 && (
                      <ul
                        className="mt-2 space-y-1 max-h-60 overflow-y-auto"
                        data-testid="list-bulk-retry-breakdown-common-first-names"
                      >
                        {bulkRetryNamesSummary.results.map((r) => {
                          const shortId =
                            r.id.length > 8 ? `${r.id.slice(0, 8)}…` : r.id;
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
                          return (
                            <li
                              key={r.id}
                              className="flex items-start gap-2 text-[11px] leading-tight"
                              data-testid={`row-bulk-retry-breakdown-common-first-names-${r.id}`}
                            >
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded font-medium uppercase tracking-wide whitespace-nowrap ${statusClass}`}
                              >
                                {statusLabel}
                              </span>
                              <span
                                className="font-mono text-foreground"
                                title={r.id}
                              >
                                {shortId}
                              </span>
                              {r.error && (
                                <span className="text-foreground italic">
                                  — {r.error}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      {compareMode && (
                        <th className="px-3 py-2 font-medium w-8" aria-label="Compare select"></th>
                      )}
                      <th className="px-4 py-2 font-medium">When</th>
                      <th className="px-4 py-2 font-medium">By</th>
                      <th className="px-4 py-2 font-medium">Change</th>
                      <th className="px-4 py-2 font-medium">Added</th>
                      <th className="px-4 py-2 font-medium">Removed</th>
                      <th className="px-4 py-2 font-medium">Routed→review</th>
                      <th className="px-4 py-2 font-medium">Alerts</th>
                      <th className="px-4 py-2 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(namesHistory?.rows || []).length === 0 ? (
                      <tr>
                        <td
                          colSpan={compareMode ? 9 : 8}
                          className="px-4 py-6 text-center text-sm text-muted-foreground"
                          data-testid="text-common-first-names-history-empty"
                        >
                          No edits recorded yet.
                        </td>
                      </tr>
                    ) : (
                      (namesHistory?.rows || []).map((row) => {
                        const oldCount = row.oldValues?.count ?? row.oldValues?.names?.length ?? 0;
                        const newCount = row.newValues?.count ?? row.newValues?.names?.length ?? 0;
                        const isReset = row.newValues?.action === "reset_to_default";
                        const added = row.newValues?.added ?? [];
                        const removed = row.newValues?.removed ?? [];
                        const oldNames = row.oldValues?.names ?? [];
                        const restoreToDefault = oldNames.length === 0;
                        const restoreNames: string[] | null = restoreToDefault ? null : oldNames.slice();
                        const isRestoring = restoringRowId === row.id && restoreMutation.isPending;
                        const userName = formatEditorAttribution(row, "system");
                        const summarize = (list: string[]): string => {
                          if (list.length === 0) return "—";
                          if (list.length <= 6) return list.join(", ");
                          return `${list.slice(0, 6).join(", ")} (+${list.length - 6} more)`;
                        };
                        const isPreviewing = previewRowId === row.id;
                        const currentOverride = namesData?.override ?? [];
                        const currentIsOverridden = !!namesData?.isOverridden;
                        const defaultsList = namesData?.defaults ?? [];
                        const resultingList = restoreToDefault ? defaultsList : oldNames;
                        const resultingLabel = restoreToDefault
                          ? `Defaults (${defaultsList.length} names)`
                          : `Custom override (${oldNames.length} name${oldNames.length === 1 ? "" : "s"})`;
                        const baselineLabel = currentIsOverridden
                          ? `current override (${currentOverride.length})`
                          : `current defaults (${defaultsList.length})`;
                        const baselineList = currentIsOverridden
                          ? currentOverride
                          : defaultsList;
                        const previewDiff = diffNameLists(baselineList, resultingList);
                        const isNoOp =
                          previewDiff.added.length === 0 &&
                          previewDiff.removed.length === 0;
                        return (
                          <Fragment key={row.id}>
                            <tr
                              onMouseEnter={() => setPreviewRowId(row.id)}
                              onMouseLeave={() =>
                                setPreviewRowId((prev) => (prev === row.id ? null : prev))
                              }
                              onFocus={() => setPreviewRowId(row.id)}
                              onBlur={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                  setPreviewRowId((prev) => (prev === row.id ? null : prev));
                                }
                              }}
                              className={`${
                                compareIds.includes(row.id)
                                  ? "bg-indigo-100/60"
                                  : isPreviewing
                                    ? "bg-indigo-50/40"
                                    : ""
                              }`}
                              data-testid={`row-common-first-names-history-${row.id}`}
                            >
                              {compareMode && (
                                <td className="px-3 py-2 align-middle">
                                  <input
                                    type="checkbox"
                                    checked={compareIds.includes(row.id)}
                                    onChange={() => toggleCompareSelect(row.id)}
                                    aria-label={`Select snapshot ${new Date(row.changedAt).toLocaleString()} for comparison`}
                                    className="h-3.5 w-3.5 cursor-pointer"
                                    data-testid={`checkbox-compare-${row.id}`}
                                  />
                                </td>
                              )}
                              <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                {new Date(row.changedAt).toLocaleString()}
                              </td>
                              <td
                                className="px-4 py-2 text-xs text-foreground"
                                data-testid={`text-common-first-names-history-by-${row.id}`}
                              >
                                {userName}
                              </td>
                              <td className="px-4 py-2 text-xs text-foreground">
                                <div className="flex flex-wrap items-center gap-2">
                                  {isReset ? (
                                    <span>
                                      <span className="font-mono">{oldCount}</span>{" "}
                                      <span className="italic text-muted-foreground">→ reset to default</span>
                                    </span>
                                  ) : (
                                    <span className="font-mono">
                                      {oldCount} → {newCount}
                                    </span>
                                  )}
                                  {row.newValues?.restoreFromAuditId && (
                                    <span
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-medium uppercase tracking-wide"
                                      data-testid={`badge-common-first-names-history-restored-${row.id}`}
                                      title={
                                        row.newValues?.restoreFromAuditId
                                          ? `Restored from history entry ${row.newValues.restoreFromAuditId}`
                                          : undefined
                                      }
                                    >
                                      <RotateCcw className="w-3 h-3" />
                                      {row.newValues?.restoreFromChangedAt
                                        ? `Restored from ${new Date(row.newValues.restoreFromChangedAt).toISOString().slice(0, 10)}`
                                        : "Restored"}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td
                                className="px-4 py-2 text-xs text-emerald-700 font-mono"
                                data-testid={`text-common-first-names-history-added-${row.id}`}
                              >
                                {isReset ? "—" : summarize(added)}
                              </td>
                              <td
                                className="px-4 py-2 text-xs text-red-700 font-mono"
                                data-testid={`text-common-first-names-history-removed-${row.id}`}
                              >
                                {isReset
                                  ? summarize(row.oldValues?.names ?? [])
                                  : summarize(removed)}
                              </td>
                              <td
                                className="px-4 py-2 text-xs whitespace-nowrap"
                                data-testid={`cell-common-first-names-history-trend-${row.id}`}
                              >
                                {(() => {
                                  const trend = namesTrendByAuditId.get(row.id);
                                  if (!trend) {
                                    return (
                                      <span
                                        className="text-[10px] text-muted-foreground italic"
                                        data-testid={`text-common-first-names-history-trend-empty-${row.id}`}
                                      >
                                        {namesTrendsLoading ? "…" : "—"}
                                      </span>
                                    );
                                  }
                                  return (
                                    <RoutedToReviewSparkline
                                      trend={trend}
                                      testId={`sparkline-common-first-names-history-${row.id}`}
                                    />
                                  );
                                })()}
                              </td>
                              <td
                                className="px-4 py-2 text-xs whitespace-nowrap"
                                data-testid={`cell-common-first-names-history-alerts-${row.id}`}
                              >
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <AlertStatusBadge
                                    channel="slack"
                                    status={row.slackStatus}
                                    rowId={`common-first-names-${row.id}`}
                                    failureReason={row.slackFailureReason}
                                  />
                                  <AlertStatusBadge
                                    channel="email"
                                    status={row.emailStatus}
                                    rowId={`common-first-names-${row.id}`}
                                    failureReason={row.emailFailureReason}
                                  />
                                  {(row.slackStatus === "failed" ||
                                    row.emailStatus === "failed") && (
                                    <button
                                      type="button"
                                      className="inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide bg-card text-amber-700 border-amber-300 hover:bg-amber-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                      title="Re-send the failed alert(s) for this change."
                                      disabled={retryingHistoryId === row.id}
                                      onClick={() => {
                                        setRetryingHistoryId(row.id);
                                        setRetryError(null);
                                        retryNamesAlertMutation.mutate(row.id);
                                      }}
                                      data-testid={`button-retry-alert-common-first-names-${row.id}`}
                                    >
                                      <RefreshCw
                                        className={`w-3 h-3 mr-1 ${
                                          retryingHistoryId === row.id ? "animate-spin" : ""
                                        }`}
                                      />
                                      {retryingHistoryId === row.id ? "Retrying" : "Retry"}
                                    </button>
                                  )}
                                </div>
                                {retryError && retryError.id === row.id && (
                                  <div
                                    className="mt-1 text-[11px] text-red-600"
                                    data-testid={`text-retry-alert-error-common-first-names-${row.id}`}
                                  >
                                    {retryError.message}
                                  </div>
                                )}
                                <ResendByBadge
                                  lastResendAt={row.lastResendAt}
                                  lastResendBy={row.lastResendBy}
                                  lastResendByUser={row.lastResendByUser}
                                  lastResendSource={row.lastResendSource}
                                  testIdSuffix={`common-first-names-${row.id}`}
                                />
                              </td>
                              <td className="px-4 py-2 text-xs text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-1.5 justify-end">
                                  {commonFirstNamesAnchorAuditId === row.id ? (
                                    <Button
                                      variant="default"
                                      size="sm"
                                      onClick={() => setCommonFirstNamesAnchorAuditId(null)}
                                      data-testid={`button-common-first-names-history-clear-anchor-${row.id}`}
                                      title="Clear custom anchor and return to the latest-change anchor"
                                    >
                                      <Activity className="w-3 h-3 mr-1" />
                                      Anchor: clear
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setCommonFirstNamesAnchorAuditId(row.id)}
                                      data-testid={`button-common-first-names-history-anchor-${row.id}`}
                                      title="Use this change as the impact-delta anchor on the chip above"
                                    >
                                      <Activity className="w-3 h-3 mr-1" />
                                      Use as impact anchor
                                    </Button>
                                  )}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={isRestoring || restoreMutation.isPending || isNoOp}
                                    onClick={() => {
                                      setPendingRestoreRowId(row.id);
                                    }}
                                    data-testid={`button-common-first-names-history-restore-${row.id}`}
                                    title={
                                      isNoOp
                                        ? "Already at this state — nothing to restore"
                                        : restoreToDefault
                                          ? "Reset override to defaults"
                                          : "Restore previous list"
                                    }
                                  >
                                    <RotateCcw className="w-3 h-3 mr-1" />
                                    {isRestoring ? "Restoring…" : "Restore"}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                            {(() => {
                              const trend = namesTrendByAuditId.get(row.id);
                              if (!trend) return null;
                              const before = trend.dismissReasons.before.byReason;
                              const after = trend.dismissReasons.after.byReason;
                              const beforeTotal = trend.dismissReasons.before.total;
                              const afterTotal = trend.dismissReasons.after.total;
                              const hasAny =
                                Object.keys(before).length > 0 ||
                                Object.keys(after).length > 0 ||
                                beforeTotal > 0 ||
                                afterTotal > 0;
                              if (!hasAny) return null;
                              return (
                                <tr
                                  data-testid={`row-common-first-names-history-dismiss-${row.id}`}
                                  className={isPreviewing ? "bg-indigo-50/40" : "bg-muted/40"}
                                >
                                  <td
                                    colSpan={8}
                                    className="px-4 py-1.5 border-t border-dashed border-border"
                                  >
                                    <DismissReasonDelta
                                      trend={trend}
                                      testId={`dismiss-common-first-names-history-${row.id}`}
                                    />
                                  </td>
                                </tr>
                              );
                            })()}
                            {(() => {
                              // Task #1239: secondary "Email impact" row for the
                              // non-Zoom (front_email) source. The common-first-names
                              // list affected email matching historically too,
                              // so we render the same sparkline +
                              // dismiss-reason delta computed against
                              // `sourceType=front_email`. Hidden when there's no
                              // email activity in the window.
                              const trendEmail = namesTrendByAuditIdEmail.get(row.id);
                              if (!trendEmail) return null;
                              const sparkBefore = trendEmail.routedToReview.before;
                              const sparkAfter = trendEmail.routedToReview.after;
                              const before = trendEmail.dismissReasons.before.byReason;
                              const after = trendEmail.dismissReasons.after.byReason;
                              const beforeTotal = trendEmail.dismissReasons.before.total;
                              const afterTotal = trendEmail.dismissReasons.after.total;
                              const hasAny =
                                sparkBefore > 0 ||
                                sparkAfter > 0 ||
                                Object.keys(before).length > 0 ||
                                Object.keys(after).length > 0 ||
                                beforeTotal > 0 ||
                                afterTotal > 0;
                              if (!hasAny) return null;
                              return (
                                <tr
                                  data-testid={`row-common-first-names-history-email-impact-${row.id}`}
                                  className={isPreviewing ? "bg-indigo-50/40" : "bg-muted/40"}
                                >
                                  <td
                                    colSpan={8}
                                    className="px-4 py-1.5 border-t border-dashed border-border"
                                  >
                                    <div className="flex flex-wrap items-center gap-3">
                                      <span
                                        className="inline-flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700"
                                        data-testid={`badge-common-first-names-history-email-source-${row.id}`}
                                        title="Routed-to-review + dismiss-reason impact computed against the front_email decision source (Task #1239)."
                                      >
                                        Email impact
                                      </span>
                                      <RoutedToReviewSparkline
                                        trend={trendEmail}
                                        testId={`sparkline-common-first-names-history-email-${row.id}`}
                                      />
                                      <DismissReasonDelta
                                        trend={trendEmail}
                                        testId={`dismiss-common-first-names-history-email-${row.id}`}
                                      />
                                    </div>
                                  </td>
                                </tr>
                              );
                            })()}
                            {isPreviewing && (
                              <tr
                                data-testid={`row-common-first-names-history-preview-${row.id}`}
                              >
                                <td colSpan={compareMode ? 9 : 8} className="px-4 py-3 bg-indigo-50/40 border-t border-indigo-100">
                                  <div className="text-[11px] uppercase tracking-wide text-indigo-700 font-semibold mb-1">
                                    Restore preview
                                  </div>
                                  {isNoOp ? (
                                    <div
                                      className="text-xs text-muted-foreground"
                                      data-testid={`text-common-first-names-history-preview-noop-${row.id}`}
                                    >
                                      Restoring this point would not change the {baselineLabel}.
                                    </div>
                                  ) : (
                                    <div className="space-y-1 text-xs text-foreground">
                                      <div>
                                        Result: <span className="font-medium">{resultingLabel}</span>
                                      </div>
                                      <div className="text-muted-foreground">
                                        Sample:{" "}
                                        <span
                                          className="font-mono"
                                          data-testid={`text-common-first-names-history-preview-sample-${row.id}`}
                                        >
                                          {summarizeNameList(resultingList)}
                                        </span>
                                      </div>
                                      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                                        <span
                                          className="text-emerald-700"
                                          data-testid={`text-common-first-names-history-preview-added-${row.id}`}
                                        >
                                          +{previewDiff.added.length} vs {baselineLabel}
                                          {previewDiff.added.length > 0 && (
                                            <span className="ml-1 font-mono">
                                              ({summarizeNameList(previewDiff.added, 5)})
                                            </span>
                                          )}
                                        </span>
                                        <span
                                          className="text-red-700"
                                          data-testid={`text-common-first-names-history-preview-removed-${row.id}`}
                                        >
                                          −{previewDiff.removed.length}
                                          {previewDiff.removed.length > 0 && (
                                            <span className="ml-1 font-mono">
                                              ({summarizeNameList(previewDiff.removed, 5)})
                                            </span>
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  )}
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
              {compareMode && (() => {
                const rows = namesHistory?.rows || [];
                const selected = compareIds
                  .map((id) => rows.find((r) => r.id === id))
                  .filter((r): r is NonNullable<typeof r> => !!r);
                if (selected.length === 0) {
                  return (
                    <div
                      className="px-4 py-4 text-xs text-muted-foreground border-t bg-muted/50"
                      data-testid="text-compare-empty-hint"
                    >
                      Select one snapshot to compare it against the live list, or two snapshots to compare them side-by-side.
                    </div>
                  );
                }
                const labelFor = (r: typeof selected[number]) => {
                  const who = formatEditorAttribution(r, "system");
                  return `${new Date(r.changedAt).toLocaleString()} · ${who}`;
                };
                const namesOf = (r: typeof selected[number]): string[] =>
                  Array.isArray(r.newValues?.names)
                    ? r.newValues!.names!
                    : Array.isArray(r.oldValues?.names)
                      ? r.oldValues!.names!
                      : [];
                const sortedSelected = [...selected].sort(
                  (a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime(),
                );
                const left = sortedSelected[0];
                const rightRow = sortedSelected[1] ?? null;
                const liveIsOverridden = !!namesData?.isOverridden;
                const liveNames: string[] = liveIsOverridden
                  ? namesData?.override ?? []
                  : namesData?.defaults ?? [];
                const liveLabel = liveIsOverridden
                  ? `Live override (${liveNames.length})`
                  : `Live defaults (${liveNames.length})`;
                const usingLiveRight = !rightRow;
                const leftNames = namesOf(left);
                const rightNames = rightRow ? namesOf(rightRow) : liveNames;
                const rightLabel = rightRow ? `B · ${labelFor(rightRow)}` : `B · ${liveLabel}`;
                const diff = diffNameLists(leftNames, rightNames);
                const buildShareUrl = () => {
                  const ids = sortedSelected.map((r) => r.id).join(",");
                  const base = window.location.origin + window.location.pathname;
                  return `${base}?compare=${ids}`;
                };
                const buildNote = () => {
                  const lines: string[] = [];
                  lines.push(`Common First Names — snapshot comparison`);
                  lines.push(`A: ${labelFor(left)} → ${leftNames.length} name${leftNames.length === 1 ? "" : "s"}`);
                  if (rightRow) {
                    lines.push(`B: ${labelFor(rightRow)} → ${rightNames.length} name${rightNames.length === 1 ? "" : "s"}`);
                  } else {
                    lines.push(`B: ${liveLabel} → ${rightNames.length} name${rightNames.length === 1 ? "" : "s"}`);
                  }
                  lines.push("");
                  lines.push(`Added in B (${diff.added.length}): ${diff.added.length ? diff.added.join(", ") : "—"}`);
                  lines.push(`Removed in B (${diff.removed.length}): ${diff.removed.length ? diff.removed.join(", ") : "—"}`);
                  lines.push(`Unchanged: ${diff.unchanged}`);
                  lines.push("");
                  lines.push(`Link: ${buildShareUrl()}`);
                  return lines.join("\n");
                };
                const handleCopy = async (kind: "link" | "note") => {
                  try {
                    const text = kind === "link" ? buildShareUrl() : buildNote();
                    await navigator.clipboard.writeText(text);
                    setCompareCopied(kind);
                    toast({
                      title: kind === "link" ? "Share link copied" : "Snapshot note copied",
                      duration: 2500,
                    });
                    setTimeout(() => setCompareCopied((c) => (c === kind ? null : c)), 2000);
                  } catch {
                    toast({
                      title: "Copy failed",
                      description: "Clipboard is unavailable in this browser.",
                      variant: "destructive",
                    });
                  }
                };
                const updateUrlWithSelection = () => {
                  const params = new URLSearchParams(search);
                  params.set("compare", sortedSelected.map((r) => r.id).join(","));
                  navigate(`${window.location.pathname}?${params.toString()}`, { replace: true });
                };
                return (
                  <div
                    className="border-t bg-indigo-50/30 p-4"
                    data-testid="panel-compare-snapshots"
                  >
                    <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                      <div className="text-xs font-semibold text-indigo-900 uppercase tracking-wide">
                        Snapshot comparison
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            updateUrlWithSelection();
                            void handleCopy("link"); // fire-and-forget: copy handler manages its own errors internally
                          }}
                          disabled={selected.length < 1}
                          data-testid="button-copy-compare-link"
                        >
                          {compareCopied === "link" ? "Link copied!" : "Copy share link"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleCopy("note")}
                          disabled={selected.length < 1}
                          data-testid="button-copy-compare-note"
                        >
                          {compareCopied === "note" ? "Note copied!" : "Copy as note"}
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            setRestoreError(null);
                            setPendingCompareRestore({
                              rowId: left.id,
                              names: leftNames,
                              sourceLabel: labelFor(left),
                              side: "A",
                            });
                          }}
                          disabled={restoreMutation.isPending}
                          title={
                            usingLiveRight
                              ? "Restore the override to this snapshot's state (vs. live)"
                              : "Restore the override to snapshot A's state"
                          }
                          data-testid="button-restore-to-a"
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Restore to A
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            if (!rightRow) return;
                            setRestoreError(null);
                            setPendingCompareRestore({
                              rowId: rightRow.id,
                              names: rightNames,
                              sourceLabel: labelFor(rightRow),
                              side: "B",
                            });
                          }}
                          disabled={!rightRow || restoreMutation.isPending}
                          title={
                            !rightRow
                              ? "Select a second snapshot to enable restore"
                              : "Restore the override to snapshot B's state"
                          }
                          data-testid="button-restore-to-b"
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Restore to B
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            setCompareIds([]);
                            setCompareCopied(null);
                            const params = new URLSearchParams(search);
                            if (params.has("compare")) {
                              params.delete("compare");
                              const qs = params.toString();
                              navigate(qs ? `${window.location.pathname}?${qs}` : window.location.pathname, { replace: true });
                            }
                          }}
                          data-testid="button-clear-compare-selection"
                        >
                          Clear
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div
                        className="bg-card rounded border p-3"
                        data-testid="panel-compare-side-a"
                      >
                        <div className="text-[11px] font-semibold text-foreground mb-1">
                          A · {labelFor(left)}
                        </div>
                        <div className="text-[11px] text-muted-foreground mb-2">
                          {leftNames.length} name{leftNames.length === 1 ? "" : "s"}
                        </div>
                        <div
                          className="text-xs text-foreground font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto"
                          data-testid="text-compare-side-a-names"
                        >
                          {leftNames.length ? leftNames.join(", ") : "—"}
                        </div>
                      </div>
                      <div
                        className="bg-card rounded border p-3"
                        data-testid="panel-compare-side-b"
                      >
                        <div className="text-[11px] font-semibold text-foreground mb-1 flex items-center gap-2">
                          <span>{rightLabel}</span>
                          {usingLiveRight && (
                            <span
                              className="text-[9px] uppercase tracking-wide bg-indigo-100 text-indigo-800 border border-indigo-200 rounded px-1.5 py-0.5"
                              data-testid="badge-compare-side-b-live"
                            >
                              Live
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground mb-2">
                          {rightNames.length} name{rightNames.length === 1 ? "" : "s"}
                          {usingLiveRight && (
                            <span className="ml-1 text-muted-foreground">
                              · {liveIsOverridden ? "current override" : "current defaults"}
                            </span>
                          )}
                        </div>
                        <div
                          className="text-xs text-foreground font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto"
                          data-testid="text-compare-side-b-names"
                        >
                          {rightNames.length ? rightNames.join(", ") : "—"}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                      <div
                        className="bg-emerald-50 border border-emerald-200 rounded p-2"
                        data-testid="text-compare-added"
                      >
                          <div className="text-[10px] uppercase font-semibold text-emerald-800 mb-1">
                            Added in B ({diff.added.length})
                          </div>
                          <div className="text-emerald-900 font-mono break-words">
                            {diff.added.length ? summarizeNameList(diff.added, 20) : "—"}
                          </div>
                        </div>
                        <div
                          className="bg-red-50 border border-red-200 rounded p-2"
                          data-testid="text-compare-removed"
                        >
                          <div className="text-[10px] uppercase font-semibold text-red-800 mb-1">
                            Removed in B ({diff.removed.length})
                          </div>
                          <div className="text-red-900 font-mono break-words">
                            {diff.removed.length ? summarizeNameList(diff.removed, 20) : "—"}
                          </div>
                        </div>
                        <div
                          className="bg-muted/50 border border-border rounded p-2"
                          data-testid="text-compare-unchanged"
                        >
                          <div className="text-[10px] uppercase font-semibold text-foreground mb-1">
                            Unchanged
                          </div>
                        <div className="text-foreground font-mono">{diff.unchanged}</div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            <AlertDialog
              open={pendingRestoreRowId !== null}
              onOpenChange={(open) => {
                if (!open) setPendingRestoreRowId(null);
              }}
            >
              <AlertDialogContent data-testid="dialog-common-first-names-restore-confirm">
                {(() => {
                  const pendingRow = (namesHistory?.rows || []).find(
                    (r) => r.id === pendingRestoreRowId,
                  );
                  if (!pendingRow) return null;
                  const oldNames = pendingRow.oldValues?.names ?? [];
                  const restoreToDefault = oldNames.length === 0;
                  const restoreNames: string[] | null = restoreToDefault
                    ? null
                    : oldNames.slice();
                  const currentIsOverridden = !!namesData?.isOverridden;
                  const baselineList = currentIsOverridden
                    ? namesData?.override ?? []
                    : namesData?.defaults ?? [];
                  const baselineLabel = currentIsOverridden
                    ? `current override (${baselineList.length})`
                    : `current defaults (${baselineList.length})`;
                  const resultingList = restoreToDefault
                    ? namesData?.defaults ?? []
                    : oldNames;
                  const resultingLabel = restoreToDefault
                    ? `Defaults (${namesData?.defaults?.length ?? 0} names)`
                    : `Custom override (${oldNames.length} name${oldNames.length === 1 ? "" : "s"})`;
                  const diff = diffNameLists(baselineList, resultingList);
                  const isNoOp =
                    diff.added.length === 0 && diff.removed.length === 0;
                  const changedAtLabel = new Date(
                    pendingRow.changedAt,
                  ).toLocaleString();
                  return (
                    <>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Restore Common First Names override?
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                          <div className="space-y-3 text-sm text-foreground">
                            <div>
                              Restore to the state captured at{" "}
                              <span className="font-medium">
                                {changedAtLabel}
                              </span>
                              .
                            </div>
                            <div className="rounded border border-border bg-muted/50 p-3 space-y-2">
                              <div>
                                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                  Resulting override
                                </span>
                                <div
                                  className="font-medium"
                                  data-testid="text-restore-confirm-result-label"
                                >
                                  {resultingLabel}
                                </div>
                                <div
                                  className="text-xs text-muted-foreground font-mono mt-0.5"
                                  data-testid="text-restore-confirm-result-sample"
                                >
                                  {summarizeNameList(resultingList)}
                                </div>
                              </div>
                              <div className="border-t border-border pt-2">
                                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                  Diff vs {baselineLabel}
                                </span>
                                {isNoOp ? (
                                  <div
                                    className="text-xs text-muted-foreground mt-0.5"
                                    data-testid="text-restore-confirm-noop"
                                  >
                                    No changes — restore would leave the override
                                    exactly as it is now.
                                  </div>
                                ) : (
                                  <div className="mt-0.5 space-y-1 text-xs">
                                    <div
                                      className="text-emerald-700"
                                      data-testid="text-restore-confirm-added"
                                    >
                                      +{diff.added.length} added
                                      {diff.added.length > 0 && (
                                        <span className="ml-1 font-mono">
                                          ({summarizeNameList(diff.added, 8)})
                                        </span>
                                      )}
                                    </div>
                                    <div
                                      className="text-red-700"
                                      data-testid="text-restore-confirm-removed"
                                    >
                                      −{diff.removed.length} removed
                                      {diff.removed.length > 0 && (
                                        <span className="ml-1 font-mono">
                                          ({summarizeNameList(diff.removed, 8)})
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel data-testid="button-restore-confirm-cancel">
                          Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                          disabled={isNoOp || restoreMutation.isPending}
                          onClick={() => {
                            setRestoringRowId(pendingRow.id);
                            setPendingRestoreRowId(null);
                            restoreMutation.mutate({ names: restoreNames, restoreFromAuditId: pendingRow.id });
                          }}
                          data-testid="button-restore-confirm-apply"
                        >
                          {isNoOp ? "Nothing to restore" : "Restore"}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </>
                  );
                })()}
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog
              open={pendingCompareRestore !== null}
              onOpenChange={(open) => {
                if (!open) setPendingCompareRestore(null);
              }}
            >
              <AlertDialogContent data-testid="dialog-compare-restore-confirm">
                {(() => {
                  if (!pendingCompareRestore) return null;
                  const targetNames = pendingCompareRestore.names;
                  const restoreNames: string[] | null =
                    targetNames.length === 0 ? null : targetNames.slice();
                  const currentIsOverridden = !!namesData?.isOverridden;
                  const baselineList = currentIsOverridden
                    ? namesData?.override ?? []
                    : namesData?.defaults ?? [];
                  const baselineLabel = currentIsOverridden
                    ? `current override (${baselineList.length})`
                    : `current defaults (${baselineList.length})`;
                  const resultingList =
                    targetNames.length === 0
                      ? namesData?.defaults ?? []
                      : targetNames;
                  const resultingLabel =
                    targetNames.length === 0
                      ? `Defaults (${namesData?.defaults?.length ?? 0} names)`
                      : `Custom override (${targetNames.length} name${targetNames.length === 1 ? "" : "s"})`;
                  const diff = diffNameLists(baselineList, resultingList);
                  const isNoOp =
                    diff.added.length === 0 && diff.removed.length === 0;
                  return (
                    <>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Restore Common First Names to snapshot {pendingCompareRestore.side}?
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                          <div className="space-y-3 text-sm text-foreground">
                            <div>
                              Restore to snapshot {pendingCompareRestore.side} captured at{" "}
                              <span className="font-medium">
                                {pendingCompareRestore.sourceLabel}
                              </span>
                              .
                            </div>
                            <div className="rounded border border-border bg-muted/50 p-3 space-y-2">
                              <div>
                                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                  Resulting override
                                </span>
                                <div
                                  className="font-medium"
                                  data-testid="text-compare-restore-confirm-result-label"
                                >
                                  {resultingLabel}
                                </div>
                                <div
                                  className="text-xs text-muted-foreground font-mono mt-0.5"
                                  data-testid="text-compare-restore-confirm-result-sample"
                                >
                                  {summarizeNameList(resultingList)}
                                </div>
                              </div>
                              <div className="border-t border-border pt-2">
                                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                  Diff vs {baselineLabel}
                                </span>
                                {isNoOp ? (
                                  <div
                                    className="text-xs text-muted-foreground mt-0.5"
                                    data-testid="text-compare-restore-confirm-noop"
                                  >
                                    No changes — restore would leave the override
                                    exactly as it is now.
                                  </div>
                                ) : (
                                  <div className="mt-0.5 space-y-1 text-xs">
                                    <div
                                      className="text-emerald-700"
                                      data-testid="text-compare-restore-confirm-added"
                                    >
                                      +{diff.added.length} added
                                      {diff.added.length > 0 && (
                                        <span className="ml-1 font-mono">
                                          ({summarizeNameList(diff.added, 8)})
                                        </span>
                                      )}
                                    </div>
                                    <div
                                      className="text-red-700"
                                      data-testid="text-compare-restore-confirm-removed"
                                    >
                                      −{diff.removed.length} removed
                                      {diff.removed.length > 0 && (
                                        <span className="ml-1 font-mono">
                                          ({summarizeNameList(diff.removed, 8)})
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel data-testid="button-compare-restore-confirm-cancel">
                          Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                          disabled={isNoOp || restoreMutation.isPending}
                          onClick={() => {
                            const sourceRowId = pendingCompareRestore.rowId;
                            setRestoreError(null);
                            setRestoringRowId(sourceRowId);
                            setPendingCompareRestore(null);
                            restoreMutation.mutate({
                              names: restoreNames,
                              restoreFromAuditId: sourceRowId,
                            });
                          }}
                          data-testid="button-compare-restore-confirm-apply"
                        >
                          {isNoOp ? "Nothing to restore" : `Restore to ${pendingCompareRestore.side}`}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </>
                  );
                })()}
              </AlertDialogContent>
            </AlertDialog>
    </>
  );
}
