// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { useAuth } from "@/hooks/use-auth";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { type GuardrailChangeTrendRow, type GuardrailChangeTrendsResponse, type HistoryResponse, ZOOM_NUMERIC_GUARDRAIL_TREND_KEYS, ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET } from "./model";
import { type BulkRetryRowResult, createRetryToastHelpers, postRetryAlerts } from "./retryAlerts";

type UseChangeHistoryDeps = {
  user: ReturnType<typeof useAuth>["user"];
  qc: ReturnType<typeof useQueryClient>;
  toast: ReturnType<typeof useToast>["toast"];
  namesTrendWindowMs: number;
  setRetryError: Dispatch<SetStateAction<{ id: string; message: string } | null>>;
  setRetryingHistoryId: Dispatch<SetStateAction<string | null>>;
  showRetrySuccessToast: ReturnType<typeof createRetryToastHelpers>["showRetrySuccessToast"];
  showRetryErrorToast: ReturnType<typeof createRetryToastHelpers>["showRetryErrorToast"];
};

export function useChangeHistory({
  user,
  qc,
  toast,
  namesTrendWindowMs,
  setRetryError,
  setRetryingHistoryId,
  showRetrySuccessToast,
  showRetryErrorToast,
}: UseChangeHistoryDeps) {
  // Numeric Zoom guardrail keys also surfaced in the main Change History
  // table. Each key is fetched against the same trends endpoint as
  // common-first-names, so the per-edit routed-to-review sparkline + the
  // dismiss-reason delta render with identical math. The key list +
  // membership set are module-scope constants (exported above) so the UI
  // regression test can import them directly. Task #1239's two extra
  // generalized-trends keys (ZOOM_TRANSCRIPT_CONTEXT_BUDGET,
  // ZOOM_SHORTLIST_MAX) live in the same exported list.
  const ZOOM_GUARDRAIL_TREND_KEYS = ZOOM_NUMERIC_GUARDRAIL_TREND_KEYS;
  const ZOOM_GUARDRAIL_TREND_KEY_SET = ZOOM_NUMERIC_GUARDRAIL_TREND_KEY_SET;

  function useGuardrailTrend(key: string) {
    return useQuery<GuardrailChangeTrendsResponse>({
      queryKey: [
        "/api/admin/zoom/guardrail-change-history-trends",
        key,
        namesTrendWindowMs,
      ],
      queryFn: async () => {
        const params = new URLSearchParams({
          settingKey: key,
          windowMs: String(namesTrendWindowMs),
          limit: "25",
        });
        const res = await fetch(
          `/api/admin/zoom/guardrail-change-history-trends?${params.toString()}`,
          { credentials: "include" },
        );
        if (!res.ok) throw new Error("Failed to fetch guardrail-change history trends");
        return res.json();
      },
      enabled: !!user && user.role === "ceo",
    });
  }

  // Zoom guardrail keys whose history rows are decorated with the same
  // routed-to-review sparkline + dismiss-reason delta as common-first-names.
  // Task #1239 added the last two — they reuse the generalized trends
  // endpoint and default to sourceType="zoom".
  const strongTrend = useGuardrailTrend("ZOOM_STRONG_SIGNAL_MIN_WEIGHT");
  const shortTokenTrend = useGuardrailTrend("ZOOM_SHORT_TOKEN_MAX_LEN");
  const transcriptBudgetTrend = useGuardrailTrend("ZOOM_TRANSCRIPT_CONTEXT_BUDGET");
  const shortlistMaxTrend = useGuardrailTrend("ZOOM_SHORTLIST_MAX");

  const guardrailTrendByHistoryId = useMemo(() => {
    const m = new Map<string, GuardrailChangeTrendRow>();
    // Iterate the `.data` payloads directly (not the query objects) so the
    // dependency list matches exactly what the memo reads.
    for (const d of [
      strongTrend.data,
      shortTokenTrend.data,
      transcriptBudgetTrend.data,
      shortlistMaxTrend.data,
    ]) {
      for (const r of d?.rows ?? []) m.set(r.auditId, r);
    }
    return m;
  }, [
    strongTrend.data,
    shortTokenTrend.data,
    transcriptBudgetTrend.data,
    shortlistMaxTrend.data,
  ]);

  const guardrailTrendsLoading =
    strongTrend.isLoading ||
    shortTokenTrend.isLoading ||
    transcriptBudgetTrend.isLoading ||
    shortlistMaxTrend.isLoading;

  const { data: history } = useQuery<HistoryResponse>({
    queryKey: ["/api/admin/match-settings/history"],
    queryFn: async () => {
      const res = await fetch("/api/admin/match-settings/history?limit=50", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch history");
      return res.json();
    },
    enabled: !!user && user.role === "ceo",
  });

  const [pendingThresholdRestoreRowId, setPendingThresholdRestoreRowId] = useState<string | null>(null);
  const [restoringThresholdRowId, setRestoringThresholdRowId] = useState<string | null>(null);

  const [bulkRetrySummary, setBulkRetrySummary] = useState<
    | null
    | {
        kind: "success" | "error";
        message: string;
        results?: BulkRetryRowResult[];
      }
  >(null);
  const [bulkRetryBreakdownOpen, setBulkRetryBreakdownOpen] = useState(false);

  const [highlightedHistoryId, setHighlightedHistoryId] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
    };
  }, []);
  const jumpToHistoryRow = (rowId: string) => {
    const el = document.getElementById(`history-row-${rowId}`);
    if (el) {
      el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
    }
    setHighlightedHistoryId(rowId);
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedHistoryId(null);
      highlightTimeoutRef.current = null;
    }, 2500);
  };

  const retryAlertMutation = useMutation({
    meta: { silent: true },
    mutationFn: (rowId: string) =>
      postRetryAlerts(
        `/api/admin/match-settings/history/${encodeURIComponent(rowId)}/retry-alerts`,
      ),
    onSuccess: (data) => {
      setRetryError(null);
      showRetrySuccessToast(data);
      void qc.invalidateQueries({ queryKey: ["/api/admin/match-settings/history"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: unknown, rowId: string) => {
      const message = err instanceof Error ? err.message : "Failed to retry alerts";
      setRetryError({ id: rowId, message });
      showRetryErrorToast(err);
    },
    onSettled: () => {
      setRetryingHistoryId(null);
    },
  });

  const bulkRetryAlertsMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await fetch(
        "/api/admin/match-settings/history/retry-failed",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to retry alerts");
      }
      return res.json() as Promise<{
        requested: number;
        succeededCount: number;
        failedCount: number;
        errorCount: number;
        results: Array<{ id: string; status: "succeeded" | "failed" | "error"; error?: string }>;
      }>;
    },
    onSuccess: (data) => {
      setRetryError(null);
      const stillBroken = data.failedCount + data.errorCount;
      const parts: string[] = [];
      parts.push(`${data.succeededCount} succeeded`);
      if (data.failedCount > 0) parts.push(`${data.failedCount} still failed`);
      if (data.errorCount > 0) parts.push(`${data.errorCount} could not retry`);
      setBulkRetrySummary({
        kind: stillBroken > 0 ? "error" : "success",
        message: `Retried ${data.requested} row${data.requested === 1 ? "" : "s"}: ${parts.join(", ")}.`,
        results: data.results.map(r => ({ id: r.id, status: r.status, error: r.error })),
      });
      setBulkRetryBreakdownOpen(stillBroken > 0);
      void qc.invalidateQueries({ queryKey: ["/api/admin/match-settings/history"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      setBulkRetrySummary({ kind: "error", message: err.message });
      setBulkRetryBreakdownOpen(false);
    },
  });
  return {
    ZOOM_GUARDRAIL_TREND_KEYS,
    ZOOM_GUARDRAIL_TREND_KEY_SET,
    useGuardrailTrend,
    strongTrend,
    shortTokenTrend,
    transcriptBudgetTrend,
    shortlistMaxTrend,
    guardrailTrendByHistoryId,
    guardrailTrendsLoading,
    history,
    pendingThresholdRestoreRowId,
    setPendingThresholdRestoreRowId,
    restoringThresholdRowId,
    setRestoringThresholdRowId,
    bulkRetrySummary,
    setBulkRetrySummary,
    bulkRetryBreakdownOpen,
    setBulkRetryBreakdownOpen,
    highlightedHistoryId,
    setHighlightedHistoryId,
    highlightTimeoutRef,
    jumpToHistoryRow,
    retryAlertMutation,
    bulkRetryAlertsMutation,
  };
}

export type ChangeHistoryBag = ReturnType<typeof useChangeHistory>;
