// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { ToastAction } from "@/components/ui/toast";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { type CommonFirstNamesMutationResponse, type CommonFirstNamesResponse, type GuardrailChangeTrendRow, type GuardrailChangeTrendsResponse, type NamesHistoryResponse, ZOOM_COMMON_FIRST_NAMES_AUDIT_KEY } from "./model";
import { type BulkRetryRowResult, createRetryToastHelpers, postRetryAlerts } from "./retryAlerts";
import { NAMES_TREND_WINDOW_DEFAULT_ID, NAMES_TREND_WINDOW_DEFAULT_MS, NAMES_TREND_WINDOW_OPTIONS, NAMES_TREND_WINDOW_VALID_IDS, namesTrendWindowStorageKey } from "./viewPrefs";

type UseCommonFirstNamesDeps = {
  user: ReturnType<typeof useAuth>["user"];
  qc: ReturnType<typeof useQueryClient>;
  toast: ReturnType<typeof useToast>["toast"];
  commonFirstNamesAnchorAuditId: string | null;
  setCommonFirstNamesAnchorAuditId: Dispatch<SetStateAction<string | null>>;
  setRetryError: Dispatch<SetStateAction<{ id: string; message: string } | null>>;
  setRetryingHistoryId: Dispatch<SetStateAction<string | null>>;
  showRetrySuccessToast: ReturnType<typeof createRetryToastHelpers>["showRetrySuccessToast"];
  showRetryErrorToast: ReturnType<typeof createRetryToastHelpers>["showRetryErrorToast"];
};

export function useCommonFirstNames({
  user,
  qc,
  toast,
  commonFirstNamesAnchorAuditId,
  setCommonFirstNamesAnchorAuditId,
  setRetryError,
  setRetryingHistoryId,
  showRetrySuccessToast,
  showRetryErrorToast,
}: UseCommonFirstNamesDeps) {
  const { data: namesData, isLoading: namesLoading } = useQuery<CommonFirstNamesResponse>({
    queryKey: ["/api/admin/match-settings/common-first-names"],
    queryFn: async () => {
      const res = await fetch("/api/admin/match-settings/common-first-names", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch common first names");
      return res.json();
    },
    enabled: !!user && user.role === "ceo",
  });

  const [namesDraft, setNamesDraft] = useState<string>("");
  const [namesDraftDirty, setNamesDraftDirty] = useState(false);

  useEffect(() => {
    if (namesDraftDirty) return;
    if (namesData?.isOverridden && namesData.override) {
      setNamesDraft(namesData.override.join(", "));
    } else {
      setNamesDraft("");
    }
  }, [namesData, namesDraftDirty]);

  const namesMutation = useMutation({
    mutationFn: async (params: { names: string[] | null }) => {
      const res = await fetch("/api/admin/match-settings/common-first-names", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: params.names }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to update common first names");
      }
      return res.json();
    },
    onSuccess: () => {
      setNamesDraftDirty(false);
      void qc.invalidateQueries({ queryKey: ["/api/admin/match-settings/common-first-names"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/match-settings/common-first-names/history"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/guardrail-impact"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/guardrail-change-history-trends"] }); // fire-and-forget: cache refresh only
    },
  });

  const { data: namesHistory } = useQuery<NamesHistoryResponse>({
    queryKey: ["/api/admin/match-settings/common-first-names/history"],
    queryFn: async () => {
      const res = await fetch(
        "/api/admin/match-settings/common-first-names/history?limit=25",
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch common first names history");
      return res.json();
    },
    enabled: !!user && user.role === "ceo",
  });

  const namesTrendWindowStorageKeyValue = namesTrendWindowStorageKey(user?.id);
  const [namesTrendWindowId, setNamesTrendWindowIdState] = useState<string>(
    NAMES_TREND_WINDOW_DEFAULT_ID,
  );
  // Re-hydrate the persisted choice whenever the per-user storage key changes
  // (e.g. user finishes loading, or a different admin signs in on the same
  // browser). When the new key has no stored value we fall back to the
  // default so we don't carry the previous admin's selection across.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let next: string = NAMES_TREND_WINDOW_DEFAULT_ID;
    try {
      const stored = window.localStorage.getItem(namesTrendWindowStorageKeyValue);
      if (stored && (NAMES_TREND_WINDOW_VALID_IDS as Set<string>).has(stored)) {
        next = stored;
      }
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
    setNamesTrendWindowIdState(next);
  }, [namesTrendWindowStorageKeyValue]);
  const setNamesTrendWindowId = (id: string) => {
    setNamesTrendWindowIdState(id);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(namesTrendWindowStorageKeyValue, id);
    } catch {
      // ignore
    }
  };
  const namesTrendWindowMs = useMemo(() => {
    const found = NAMES_TREND_WINDOW_OPTIONS.find((o) => o.id === namesTrendWindowId);
    return found?.ms ?? NAMES_TREND_WINDOW_DEFAULT_MS;
  }, [namesTrendWindowId]);

  const { data: namesTrends, isLoading: namesTrendsLoading } =
    useQuery<GuardrailChangeTrendsResponse>({
      queryKey: [
        "/api/admin/zoom/guardrail-change-history-trends",
        ZOOM_COMMON_FIRST_NAMES_AUDIT_KEY,
        namesTrendWindowMs,
      ],
      queryFn: async () => {
        const params = new URLSearchParams({
          settingKey: ZOOM_COMMON_FIRST_NAMES_AUDIT_KEY,
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

  // Task #1239: the common-first-names list also affected non-Zoom matching
  // (email/Slack/Twilio) historically, so
  // we additionally fetch the same trend with `sourceType=front_email` and
  // render it as a secondary "Email impact" row in the names-history table
  // beneath the existing Zoom row.
  const { data: namesTrendsEmail } =
    useQuery<GuardrailChangeTrendsResponse>({
      queryKey: [
        "/api/admin/zoom/guardrail-change-history-trends",
        ZOOM_COMMON_FIRST_NAMES_AUDIT_KEY,
        namesTrendWindowMs,
        "front_email",
      ],
      queryFn: async () => {
        const params = new URLSearchParams({
          settingKey: ZOOM_COMMON_FIRST_NAMES_AUDIT_KEY,
          windowMs: String(namesTrendWindowMs),
          limit: "25",
          sourceType: "front_email",
        });
        const res = await fetch(
          `/api/admin/zoom/guardrail-change-history-trends?${params.toString()}`,
          { credentials: "include" },
        );
        if (!res.ok) throw new Error("Failed to fetch guardrail-change history trends (email)");
        return res.json();
      },
      enabled: !!user && user.role === "ceo",
    });

  const namesTrendByAuditId = useMemo(() => {
    const m = new Map<string, GuardrailChangeTrendRow>();
    for (const r of namesTrends?.rows ?? []) m.set(r.auditId, r);
    return m;
  }, [namesTrends]);

  const namesTrendByAuditIdEmail = useMemo(() => {
    const m = new Map<string, GuardrailChangeTrendRow>();
    for (const r of namesTrendsEmail?.rows ?? []) m.set(r.auditId, r);
    return m;
  }, [namesTrendsEmail]);

  const [restoringRowId, setRestoringRowId] = useState<string | null>(null);
  const [previewRowId, setPreviewRowId] = useState<string | null>(null);
  const [pendingRestoreRowId, setPendingRestoreRowId] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareCopied, setCompareCopied] = useState<"link" | "note" | null>(null);
  const [pendingCompareRestore, setPendingCompareRestore] = useState<
    { rowId: string; names: string[]; sourceLabel: string; side: "A" | "B" } | null
  >(null);
  const [, navigate] = useLocation();
  const search = useSearch();
  const compareInitFromUrlRef = useRef(false);

  useEffect(() => {
    if (compareInitFromUrlRef.current) return;
    if (!namesHistory?.rows) return;
    compareInitFromUrlRef.current = true;
    const params = new URLSearchParams(search);
    const raw = params.get("compare");
    if (!raw) return;
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 2);
    if (ids.length === 0) return;
    const valid = ids.filter((id) => namesHistory.rows.some((r) => r.id === id));
    if (valid.length === 0) return;
    setCompareMode(true);
    setCompareIds(valid);
    setTimeout(() => {
      const el = document.querySelector('[data-testid="card-common-first-names-history"]');
      if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
        (el as HTMLElement).scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
      }
    }, 50);
  }, [namesHistory, search]);

  const toggleCompareSelect = (rowId: string) => {
    setCompareIds((prev) => {
      if (prev.includes(rowId)) return prev.filter((id) => id !== rowId);
      if (prev.length >= 2) return [prev[1], rowId];
      return [...prev, rowId];
    });
  };
  const lastRestoreToastRef = useRef<{ dismiss: () => void } | null>(null);
  const restoreMutation = useMutation<
    CommonFirstNamesMutationResponse,
    Error,
    { names: string[] | null; restoreFromAuditId?: string; isUndo?: boolean },
    { priorOverride: string[] | null }
  >({
    meta: { silent: true },
    mutationFn: async (params) => {
      const body: { names: string[] | null; restoreFromAuditId?: string } = {
        names: params.names,
      };
      if (params.restoreFromAuditId) {
        body.restoreFromAuditId = params.restoreFromAuditId;
      }
      const res = await fetch("/api/admin/match-settings/common-first-names", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to restore common first names");
      }
      return res.json();
    },
    onMutate: async () => {
      if (lastRestoreToastRef.current) {
        lastRestoreToastRef.current.dismiss();
        lastRestoreToastRef.current = null;
      }
      await qc.cancelQueries({ queryKey: ["/api/admin/match-settings/common-first-names"] });
      const current = qc.getQueryData<CommonFirstNamesResponse>([
        "/api/admin/match-settings/common-first-names",
      ]);
      const priorOverride: string[] | null = current?.isOverridden
        ? (current.override ?? []).slice()
        : null;
      return { priorOverride };
    },
    onSuccess: (data, params, ctx) => {
      setNamesDraftDirty(false);
      const next: CommonFirstNamesResponse = {
        effective: data.effective,
        override: data.override,
        defaults: data.defaults,
        isOverridden: data.isOverridden,
        lastEdited: data.lastEdited,
      };
      qc.setQueryData<CommonFirstNamesResponse>(
        ["/api/admin/match-settings/common-first-names"],
        next,
      );
      void qc.invalidateQueries({ queryKey: ["/api/admin/match-settings/common-first-names/history"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/guardrail-impact"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/guardrail-change-history-trends"] }); // fire-and-forget: cache refresh only
      const resultLabel =
        params.names === null
          ? "reset to defaults"
          : `${params.names.length} name${params.names.length === 1 ? "" : "s"}`;
      if (params.isUndo) {
        toast({
          title: "Restore undone",
          description: `Reverted override to its prior state (${resultLabel})`,
          duration: 5000,
        });
        return;
      }
      const newAuditId = data.auditId ?? null;
      const sourceRow = (namesHistory?.rows || []).find((r) => r.id === params.restoreFromAuditId);
      const whenLabel = sourceRow?.changedAt
        ? new Date(sourceRow.changedAt).toLocaleString()
        : null;
      const whoLabel = sourceRow ? formatEditorAttribution(sourceRow, "system") : null;
      const snapshotPart = whenLabel
        ? whoLabel
          ? `snapshot by ${whoLabel} on ${whenLabel}`
          : `snapshot taken ${whenLabel}`
        : "selected snapshot";
      const description = `Restored override to ${snapshotPart} (${resultLabel})`;
      const priorOverride = ctx?.priorOverride ?? null;
      const handle = toast({
        title: "Snapshot restored",
        description,
        duration: 5000,
        action: (
          <ToastAction
            altText="Undo restore"
            data-testid="button-undo-common-first-names-restore"
            onClick={() => {
              if (lastRestoreToastRef.current) {
                lastRestoreToastRef.current.dismiss();
                lastRestoreToastRef.current = null;
              }
              restoreMutation.mutate({
                names: priorOverride,
                isUndo: true,
                ...(newAuditId ? { restoreFromAuditId: newAuditId } : {}),
              });
            }}
          >
            Undo
          </ToastAction>
        ),
      });
      lastRestoreToastRef.current = { dismiss: handle.dismiss };
    },
    onError: (err: any) => {
      const message = err?.message || "Failed to restore";
      toast({
        title: "Restore failed",
        description: message,
        variant: "destructive",
        duration: 7000,
      });
    },
    onSettled: () => {
      setRestoringRowId(null);
    },
  });

  const [restoreError, setRestoreError] = useState<{ id: string; message: string } | null>(null);

  const [bulkRetryNamesSummary, setBulkRetryNamesSummary] = useState<
    | null
    | {
        kind: "success" | "error";
        message: string;
        results?: BulkRetryRowResult[];
      }
  >(null);
  const [bulkRetryNamesBreakdownOpen, setBulkRetryNamesBreakdownOpen] =
    useState(false);

  const retryNamesAlertMutation = useMutation({
    meta: { silent: true },
    mutationFn: (rowId: string) =>
      postRetryAlerts(
        `/api/admin/match-settings/common-first-names/history/${encodeURIComponent(rowId)}/retry-alerts`,
      ),
    onSuccess: (data) => {
      setRetryError(null);
      showRetrySuccessToast(data);
      void qc.invalidateQueries({
        queryKey: ["/api/admin/match-settings/common-first-names/history"],
      }); // fire-and-forget: cache refresh only
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

  const bulkRetryNamesAlertsMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await fetch(
        "/api/admin/match-settings/common-first-names/history/retry-failed",
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
      setBulkRetryNamesSummary({
        kind: stillBroken > 0 ? "error" : "success",
        message: `Retried ${data.requested} row${data.requested === 1 ? "" : "s"}: ${parts.join(", ")}.`,
        results: data.results.map(r => ({ id: r.id, status: r.status, error: r.error })),
      });
      setBulkRetryNamesBreakdownOpen(stillBroken > 0);
      void qc.invalidateQueries({
        queryKey: ["/api/admin/match-settings/common-first-names/history"],
      }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      setBulkRetryNamesSummary({ kind: "error", message: err.message });
      setBulkRetryNamesBreakdownOpen(false);
    },
  });
  return {
    namesData,
    namesLoading,
    namesDraft,
    setNamesDraft,
    namesDraftDirty,
    setNamesDraftDirty,
    namesMutation,
    namesHistory,
    namesTrendWindowStorageKeyValue,
    namesTrendWindowId,
    setNamesTrendWindowIdState,
    setNamesTrendWindowId,
    namesTrendWindowMs,
    namesTrends,
    namesTrendsLoading,
    namesTrendsEmail,
    namesTrendByAuditId,
    namesTrendByAuditIdEmail,
    restoringRowId,
    setRestoringRowId,
    previewRowId,
    setPreviewRowId,
    pendingRestoreRowId,
    setPendingRestoreRowId,
    compareMode,
    setCompareMode,
    compareIds,
    setCompareIds,
    compareCopied,
    setCompareCopied,
    pendingCompareRestore,
    setPendingCompareRestore,
    navigate,
    search,
    compareInitFromUrlRef,
    toggleCompareSelect,
    lastRestoreToastRef,
    restoreMutation,
    restoreError,
    setRestoreError,
    bulkRetryNamesSummary,
    setBulkRetryNamesSummary,
    bulkRetryNamesBreakdownOpen,
    setBulkRetryNamesBreakdownOpen,
    retryNamesAlertMutation,
    bulkRetryNamesAlertsMutation,
  };
}

export type CommonFirstNamesBag = ReturnType<typeof useCommonFirstNames>;
