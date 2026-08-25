// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
// Manual Sync Reserve health domain: reserve-pressure card (per-worker
// history, export range/selection, mute controls) and the advisory
// local-dominance bypass card.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AlertTriangle, CheckCircle, Download, RefreshCw, XCircle, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { HealthHistory, HealthSnapshot, ManualReserveWorkerHistory } from "./types";
import { ManualReserveChart, ManualReserveByWorkerChart } from "./charts";
import { SuppressedDuringMuteSection, ManualReserveMuteControl } from "./muteControls";

// Per-worker history/export/selection state. Called unconditionally by
// HealthDashboardSection so the by-worker history query keeps its
// original mount position (after the snapshot query) — F11D split.
export function useManualReserveDomain({
  isAdmin,
  isTabVisible,
  pollingInterval,
  historyWindow,
  windowMs,
}: {
  isAdmin: boolean;
  isTabVisible: boolean;
  pollingInterval: number;
  historyWindow: string;
  windowMs: number;
}) {
  const [perWorkerExportFrom, setPerWorkerExportFrom] = useState<string>("");
  const [perWorkerExportTo, setPerWorkerExportTo] = useState<string>("");
  const perWorkerExportFromRef = useRef(perWorkerExportFrom);
  const perWorkerExportToRef = useRef(perWorkerExportTo);
  const windowMsRef = useRef(windowMs);
  const historyWindowRef = useRef(historyWindow);
  const perWorkerSoloSelectedRef = useRef<string | null>(null);
  const perWorkerSelectedListRef = useRef<string[]>([]);
  useEffect(() => { perWorkerExportFromRef.current = perWorkerExportFrom; }, [perWorkerExportFrom]);
  useEffect(() => { perWorkerExportToRef.current = perWorkerExportTo; }, [perWorkerExportTo]);
  useEffect(() => { windowMsRef.current = windowMs; }, [windowMs]);
  useEffect(() => { historyWindowRef.current = historyWindow; }, [historyWindow]);

  const triggerPerWorkerExport = (format: "csv" | "json") => {
    const fromStr = perWorkerExportFromRef.current;
    const toStr = perWorkerExportToRef.current;
    const fromMs = fromStr ? new Date(fromStr).getTime() : NaN;
    const toMs = toStr ? new Date(toStr).getTime() : NaN;
    const since = !Number.isNaN(fromMs) ? fromMs : Date.now() - windowMsRef.current;
    const until = !Number.isNaN(toMs) ? toMs : null;
    const workers = perWorkerSelectedListRef.current;

    const params = new URLSearchParams();
    params.set("format", format);
    params.set("since", String(since));
    if (until !== null) params.set("until", String(until));
    if (workers.length > 0) params.set("worker", workers.join(","));

    const sliceDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const fromPart = !Number.isNaN(fromMs) ? sliceDate(fromMs) : null;
    const toPart = until !== null ? sliceDate(until) : null;
    const rangeSuffix =
      fromPart && toPart
        ? `${fromPart}_${toPart}`
        : fromPart
          ? `${fromPart}_now`
          : toPart
            ? `until-${toPart}`
            : historyWindowRef.current;
    const workerSuffix =
      workers.length === 1
        ? `-${workers[0].replace(/[^a-zA-Z0-9_-]+/g, "_")}`
        : workers.length > 1
          ? "-multi"
          : "";
    const filename = `manual-reserve-by-worker-${rangeSuffix}${workerSuffix}.${format}`;

    const a = document.createElement("a");
    a.href = `/api/health/manual-reserve/by-worker/history/export?${params.toString()}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const { data: workerHistory } = useQuery<ManualReserveWorkerHistory>({
    queryKey: ["/api/health/manual-reserve/by-worker/history", historyWindow],
    queryFn: async () => {
      const since = Date.now() - windowMs;
      const res = await fetch(`/api/health/manual-reserve/by-worker/history?since=${since}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return res.json();
    },
    refetchInterval: isTabVisible ? pollingInterval : false,
    refetchIntervalInBackground: false,
    enabled: isAdmin,
  });

  const PER_WORKER_SELECTION_STORAGE_KEY = "health-dashboard-per-worker-selection";
  const [perWorkerSelection, setPerWorkerSelection] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = window.localStorage.getItem(PER_WORKER_SELECTION_STORAGE_KEY);
      if (!stored) return new Set();
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is string => typeof v === "string"));
      }
    } catch {
      /* ignore malformed storage */
    }
    return new Set();
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        PER_WORKER_SELECTION_STORAGE_KEY,
        JSON.stringify(Array.from(perWorkerSelection)),
      );
    } catch {
      /* ignore storage errors */
    }
  }, [perWorkerSelection]);

  const togglePerWorkerSelected = (worker: string) => {
    setPerWorkerSelection((prev) => {
      const next = new Set(prev);
      if (next.has(worker)) {
        next.delete(worker);
      } else {
        next.add(worker);
      }
      return next;
    });
  };

  const clearPerWorkerSelection = () => setPerWorkerSelection(new Set());

  const perWorkerSoloSelected = perWorkerSelection.size === 1
    ? Array.from(perWorkerSelection)[0]
    : "";
  useEffect(() => {
    perWorkerSoloSelectedRef.current = perWorkerSoloSelected || null;
  }, [perWorkerSoloSelected]);
  const perWorkerSelectedList = Array.from(perWorkerSelection).sort();
  useEffect(() => {
    perWorkerSelectedListRef.current = perWorkerSelectedList;
  }, [perWorkerSelectedList]);

  return {
    workerHistory,
    perWorkerExportFrom,
    setPerWorkerExportFrom,
    perWorkerExportTo,
    setPerWorkerExportTo,
    triggerPerWorkerExport,
    perWorkerSelection,
    togglePerWorkerSelected,
    clearPerWorkerSelection,
    perWorkerSoloSelected,
  };
}

export type ManualReserveDomain = ReturnType<typeof useManualReserveDomain>;

// Mute state + set/clear mutations. Called unconditionally by
// HealthDashboardSection in the same hook-sequence position as the
// original muteState query (F11D split).
export function useManualReserveMuteDomain({
  isAdmin,
  isTabVisible,
}: {
  isAdmin: boolean;
  isTabVisible: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: muteState, refetch: refetchMute } = useQuery<{
    muted: boolean;
    mutedUntil: number | null;
    mutedAt: number | null;
    mutedBy: string | null;
    reason: string | null;
    source?: "manual" | "auto" | null;
    jobId?: string | null;
    jobLabel?: string | null;
  }>({
    queryKey: ["/api/health/manual-reserve-mute"],
    enabled: isAdmin,
    refetchInterval: isTabVisible ? 60_000 : false,
  });

  const setMuteMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: { mutedUntil: number; reason?: string | null }) => {
      const res = await apiRequest("POST", "/api/health/manual-reserve-mute", payload);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/health/manual-reserve-mute"], data);
      toast({ title: "Manual reserve alerts muted", description: data?.mutedUntil ? `Until ${new Date(data.mutedUntil).toLocaleString()}` : undefined });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to mute alerts", description: err.message, variant: "destructive" });
    },
  });

  const clearMuteMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/health/manual-reserve-mute");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/health/manual-reserve-mute"], data);
      toast({ title: "Manual reserve alerts unmuted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to unmute alerts", description: err.message, variant: "destructive" });
    },
  });

  return {
    muteState,
    refetchMute,
    setMuteMutation,
    clearMuteMutation,
  };
}

export type ManualReserveMuteDomain = ReturnType<typeof useManualReserveMuteDomain>;

export function ManualReserveCard({
  domain,
  muteDomain,
  snapshot,
  snapshotLoading,
  snapshotError,
  snapshotUpdatedAt,
  history,
  windowMs,
  isAdmin,
  isTabVisible,
  pollingInterval,
  refetchSnapshot,
}: {
  domain: ManualReserveDomain;
  muteDomain: ManualReserveMuteDomain;
  snapshot: HealthSnapshot | undefined;
  snapshotLoading: boolean;
  snapshotError: Error | null;
  snapshotUpdatedAt: number;
  history: HealthHistory | undefined;
  windowMs: number;
  isAdmin: boolean;
  isTabVisible: boolean;
  pollingInterval: number;
  refetchSnapshot: () => Promise<unknown>;
}) {
  const {
    workerHistory,
    perWorkerExportFrom,
    setPerWorkerExportFrom,
    perWorkerExportTo,
    setPerWorkerExportTo,
    triggerPerWorkerExport,
    perWorkerSelection,
    togglePerWorkerSelected,
    clearPerWorkerSelection,
    perWorkerSoloSelected,
  } = domain;
  const {
    muteState,
    setMuteMutation,
    clearMuteMutation,
  } = muteDomain;
              const origin = snapshot?.checks?.workers?.origin;
              const ingestion = snapshot?.checks?.workers?.classes?.ingestion;
              const hasReservePressure = origin
                ? origin.manualDelayedByBackgroundCount > 0 ||
                  origin.manualTimeoutCount > 0 ||
                  origin.backgroundIngestionSaturationCount > 0
                : false;
              const stale = snapshotError && !!snapshot;
              return (
                <Card data-testid="card-manual-reserve">
                  <CardHeader>
                    <CardTitle className="text-foreground flex items-center gap-2">
                      <Zap className="w-5 h-5" />
                      Manual Sync Reserve
                    </CardTitle>
                    <CardDescription>
                      Tracks user-triggered (Sync Now) ingestion that had to claim its reserved slot because background ingestion was saturated.
                      {ingestion && (
                        <span className="ml-1">
                          Ingestion class: {ingestion.active}/{ingestion.max} slots active (1 reserved for manual).
                        </span>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ManualReserveMuteControl
                      muteState={muteState ?? null}
                      onMute={(durationMs) =>
                        setMuteMutation.mutate({ mutedUntil: Date.now() + durationMs })
                      }
                      onMuteUntil={(ts) => setMuteMutation.mutate({ mutedUntil: ts })}
                      onUnmute={() => clearMuteMutation.mutate()}
                      isPendingSet={setMuteMutation.isPending}
                      isPendingClear={clearMuteMutation.isPending}
                    />
                    <SuppressedDuringMuteSection
                      windowMs={windowMs}
                      enabled={isAdmin}
                      isTabVisible={isTabVisible}
                      pollingInterval={pollingInterval}
                      onJumpToAudit={() => {
                        const el = document.querySelector('[data-testid="card-manual-reserve-alerts"]');
                        if (el) {
                          el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
                        }
                      }}
                    />
                    {!origin && snapshotLoading && (
                      <div className="text-sm text-muted-foreground" data-testid="text-manual-reserve-loading">
                        Loading manual reserve metrics…
                      </div>
                    )}
                    {!origin && !snapshotLoading && snapshotError && (
                      <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3" data-testid="text-manual-reserve-error">
                        <XCircle className="w-4 h-4 shrink-0" />
                        <span>
                          Failed to load manual reserve metrics from /api/health. The endpoint may be returning a degraded response.
                        </span>
                        <Button variant="outline" size="sm" className="ml-auto" onClick={() => refetchSnapshot()} data-testid="button-retry-snapshot">
                          <RefreshCw className="w-3 h-3 mr-1" />
                          Retry
                        </Button>
                      </div>
                    )}
                    {!origin && !snapshotLoading && !snapshotError && (
                      <div className="text-sm text-muted-foreground" data-testid="text-manual-reserve-unavailable">
                        Manual reserve metrics are unavailable right now.
                      </div>
                    )}
                    {origin && stale && (
                      <div className="mb-3 flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2" data-testid="text-manual-reserve-stale">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>
                          Showing last successful values{snapshotUpdatedAt ? ` from ${new Date(snapshotUpdatedAt).toLocaleTimeString()}` : ""} — latest /api/health request failed.
                        </span>
                      </div>
                    )}
                    {origin && (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                      <div>
                        <div className="text-xs text-muted-foreground">Manual Acquires</div>
                        <div className="text-xl font-bold text-foreground" data-testid="text-manual-acquires">
                          {origin.manualAcquires}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Reserve Pressure</div>
                        <div
                          className={`text-xl font-bold ${origin.manualDelayedByBackgroundCount > 0 ? "text-amber-600" : "text-green-600"}`}
                          data-testid="text-manual-delayed-by-background"
                        >
                          {origin.manualDelayedByBackgroundCount}
                        </div>
                        <div className="text-xs text-muted-foreground">delayed by background</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Manual Timeouts</div>
                        <div
                          className={`text-xl font-bold ${origin.manualTimeoutCount > 0 ? "text-red-600" : "text-green-600"}`}
                          data-testid="text-manual-timeouts"
                        >
                          {origin.manualTimeoutCount}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Background Saturation</div>
                        <div
                          className={`text-xl font-bold ${origin.backgroundIngestionSaturationCount > 0 ? "text-amber-600" : "text-green-600"}`}
                          data-testid="text-background-saturation"
                        >
                          {origin.backgroundIngestionSaturationCount}
                        </div>
                        <div className="text-xs text-muted-foreground">times reserve held line</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Avg Wait</div>
                        <div className="text-xl font-bold text-foreground" data-testid="text-manual-wait-avg">
                          {origin.manualWait.avgMs ?? "—"}
                          <span className="text-xs font-normal text-muted-foreground ml-1">ms</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">P95 Wait</div>
                        <div className="text-xl font-bold text-foreground" data-testid="text-manual-wait-p95">
                          {origin.manualWait.p95Ms ?? "—"}
                          <span className="text-xs font-normal text-muted-foreground ml-1">ms</span>
                        </div>
                      </div>
                    </div>
                    )}
                    {(history?.samples?.some((s) => s.manualReserve !== null) || origin) && (
                      <div className="mt-6">
                        <div className="text-sm font-medium text-foreground mb-2" data-testid="text-manual-reserve-trends-title">
                          Reserve trends over time
                        </div>
                        <ManualReserveChart samples={history?.samples ?? []} windowMs={windowMs} />
                        <div className="text-xs text-muted-foreground mt-1">
                          Counts shown as per-sample deltas (left axis); manual wait avg/p95 in ms (right axis).
                        </div>
                      </div>
                    )}
                    <div className="mt-6" data-testid="section-manual-reserve-by-worker-trends">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="text-sm font-medium text-foreground" data-testid="text-manual-reserve-by-worker-trends-title">
                          Delayed by background — per entry point
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="picker-per-worker-export-range">
                            <label className="flex items-center gap-1">
                              From
                              <input
                                type="datetime-local"
                                className="border border-border rounded px-1 py-0.5 text-xs"
                                value={perWorkerExportFrom}
                                onChange={(e) => setPerWorkerExportFrom(e.target.value)}
                                data-testid="input-per-worker-export-from"
                              />
                            </label>
                            <label className="flex items-center gap-1">
                              To
                              <input
                                type="datetime-local"
                                className="border border-border rounded px-1 py-0.5 text-xs"
                                value={perWorkerExportTo}
                                onChange={(e) => setPerWorkerExportTo(e.target.value)}
                                data-testid="input-per-worker-export-to"
                              />
                            </label>
                            {(perWorkerExportFrom || perWorkerExportTo) && (
                              <button
                                type="button"
                                onClick={() => { setPerWorkerExportFrom(""); setPerWorkerExportTo(""); }}
                                className="text-xs text-primary-ink underline"
                                data-testid="button-per-worker-export-range-reset"
                              >
                                reset
                              </button>
                            )}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => triggerPerWorkerExport("csv")}
                            data-testid="button-export-per-worker-csv"
                          >
                            <Download className="w-3 h-3 mr-1" />
                            CSV
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => triggerPerWorkerExport("json")}
                            data-testid="button-export-per-worker-json"
                          >
                            <Download className="w-3 h-3 mr-1" />
                            JSON
                          </Button>
                        </div>
                      </div>
                      {(workerHistory?.workers ?? []).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 mb-2" data-testid="filter-per-worker-toggles">
                          <span className="text-xs text-muted-foreground mr-1">Show:</span>
                          <button
                            type="button"
                            onClick={clearPerWorkerSelection}
                            className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${
                              perWorkerSelection.size === 0
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-card text-foreground border-border hover:bg-muted/50"
                            }`}
                            data-testid="button-per-worker-show-all"
                          >
                            All
                          </button>
                          {(workerHistory?.workers ?? []).map((w) => {
                            const isOn = perWorkerSelection.has(w);
                            return (
                              <button
                                key={w}
                                type="button"
                                onClick={() => togglePerWorkerSelected(w)}
                                className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${
                                  isOn
                                    ? "bg-primary text-primary-foreground border-primary"
                                    : "bg-card text-foreground border-border hover:bg-muted/50"
                                }`}
                                data-testid={`button-per-worker-toggle-${w}`}
                              >
                                {w}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <ManualReserveByWorkerChart
                        samples={workerHistory?.samples ?? []}
                        windowMs={windowMs}
                        selectedWorkers={perWorkerSelection}
                      />
                      <div className="text-xs text-muted-foreground mt-1">
                        Per-sample delta of manual acquires that had to wait on background work, broken down by ingestion entry point. Only entry points with delay activity in the selected window are shown.
                        {perWorkerSoloSelected && (
                          <> Wait p95 (ms) for <strong>{perWorkerSoloSelected}</strong> is overlaid on the right axis.</>
                        )}
                      </div>
                    </div>
                    {origin && origin.byWorker && origin.byWorker.length > 0 && (() => {
                      const starvedSet = new Set<string>();
                      const starvedMeta = new Map<string, "warning" | "critical">();
                      const starvedMessages = new Map<string, string[]>();
                      for (const a of history?.currentAlerts ?? []) {
                        const m = /^manual_entrypoint_(?:timeout|delayed)_window:(.+)$/.exec(a.metric);
                        if (!m) continue;
                        const w = m[1];
                        starvedSet.add(w);
                        const cur = starvedMeta.get(w);
                        if (a.severity === "critical" || cur !== "critical") {
                          starvedMeta.set(w, a.severity === "critical" ? "critical" : (cur ?? "warning"));
                        }
                        if (a.message) {
                          const list = starvedMessages.get(w) ?? [];
                          list.push(a.message);
                          starvedMessages.set(w, list);
                        }
                      }
                      return (
                      <div className="mt-6" data-testid="section-manual-reserve-by-worker">
                        <div className="text-sm font-semibold text-foreground mb-2">By Ingestion Entry Point</div>
                        <div className="text-xs text-muted-foreground mb-2">
                          Per-worker breakdown of manual acquisitions, how often each one had to wait on background work, and the wait time distribution.
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-collapse" data-testid="table-manual-reserve-by-worker">
                            <thead>
                              <tr className="border-b text-left text-muted-foreground">
                                <th className="py-2 pr-3 pl-2 font-medium sticky left-0 z-10 bg-card shadow-[1px_0_0_0_rgba(0,0,0,0.06)]">Entry Point</th>
                                <th className="py-2 pr-3 font-medium">Class</th>
                                <th className="py-2 pr-3 font-medium text-right">Manual</th>
                                <th className="py-2 pr-3 font-medium text-right">Delayed by BG</th>
                                <th className="py-2 pr-3 font-medium text-right">Timeouts</th>
                                <th className="py-2 pr-3 font-medium text-right">Avg Wait (ms)</th>
                                <th className="py-2 pr-3 font-medium text-right">P95 Wait (ms)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {origin.byWorker.map((w) => {
                                const isStarved = starvedSet.has(w.worker);
                                const sev = starvedMeta.get(w.worker);
                                const messages = starvedMessages.get(w.worker) ?? [];
                                const tooltip = messages.length > 0
                                  ? messages.join("\n")
                                  : "This entry point has tripped a per-entry-point reserve threshold";
                                const rowTint = isStarved
                                  ? sev === "critical"
                                    ? "bg-red-50/60 hover:bg-red-50"
                                    : "bg-amber-50/60 hover:bg-amber-50"
                                  : "";
                                // The first column is `position: sticky` so the entry-point name
                                // and Starved badge stay visible while operators scroll the wide
                                // table horizontally on tablet/mobile. Sticky cells need a solid
                                // background (the row's translucent tint won't cover the columns
                                // sliding underneath), so mirror the tint with an opaque color.
                                const stickyBg = isStarved
                                  ? sev === "critical"
                                    ? "bg-red-50"
                                    : "bg-amber-50"
                                  : "bg-card";
                                return (
                                <tr
                                  key={w.worker}
                                  className={`border-b last:border-b-0 ${rowTint}`}
                                  data-testid={`row-manual-reserve-worker-${w.worker}`}
                                  title={isStarved ? tooltip : undefined}
                                >
                                  <td className={`py-2 pr-3 pl-2 font-mono sticky left-0 z-10 ${stickyBg} shadow-[1px_0_0_0_rgba(0,0,0,0.06)]`} data-testid={`text-worker-name-${w.worker}`}>
                                    <span className="inline-flex items-center gap-1.5">
                                      {w.worker}
                                      {isStarved && (
                                        <span
                                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${
                                            sev === "critical"
                                              ? "bg-red-100 text-red-700 border border-red-200"
                                              : "bg-amber-100 text-amber-700 border border-amber-200"
                                          }`}
                                          data-testid={`badge-worker-starved-${w.worker}`}
                                          title={tooltip}
                                        >
                                          Starved
                                        </span>
                                      )}
                                    </span>
                                  </td>
                                  <td className="py-2 pr-3 text-muted-foreground" data-testid={`text-worker-class-${w.worker}`}>
                                    {w.workloadClass}
                                  </td>
                                  <td className="py-2 pr-3 text-right tabular-nums" data-testid={`text-worker-manual-acquires-${w.worker}`}>
                                    {w.manualAcquires}
                                  </td>
                                  <td
                                    className={`py-2 pr-3 text-right tabular-nums font-semibold ${w.manualDelayedByBackgroundCount > 0 ? "text-amber-600" : "text-muted-foreground"}`}
                                    data-testid={`text-worker-delayed-${w.worker}`}
                                  >
                                    {w.manualDelayedByBackgroundCount}
                                  </td>
                                  <td
                                    className={`py-2 pr-3 text-right tabular-nums ${w.manualTimeoutCount > 0 ? "text-red-600 font-semibold" : "text-muted-foreground"}`}
                                    data-testid={`text-worker-timeouts-${w.worker}`}
                                  >
                                    {w.manualTimeoutCount}
                                  </td>
                                  <td className="py-2 pr-3 text-right tabular-nums" data-testid={`text-worker-wait-avg-${w.worker}`}>
                                    {w.manualWait.avgMs ?? "—"}
                                  </td>
                                  <td className="py-2 pr-3 text-right tabular-nums" data-testid={`text-worker-wait-p95-${w.worker}`}>
                                    {w.manualWait.p95Ms ?? "—"}
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      );
                    })()}
                    {origin && origin.byWorker && origin.byWorker.length === 0 && (
                      <div className="mt-4 text-xs text-muted-foreground" data-testid="text-manual-reserve-no-worker-data">
                        No manual acquisitions recorded yet — per-entry-point breakdown will appear after the first user-triggered sync.
                      </div>
                    )}
                    {origin && (hasReservePressure ? (
                      <div className="mt-4 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2" data-testid="text-reserve-pressure-note">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>
                          Manual sync reserve has been exercised. If "delayed by background" or "manual timeouts" climbs steadily, background ingestion may be starving user-triggered syncs.
                        </span>
                      </div>
                    ) : (
                      <div className="mt-4 text-xs text-muted-foreground" data-testid="text-reserve-idle-note">
                        No reserve pressure observed — background ingestion has not crowded out manual syncs.
                      </div>
                    ))}
                  </CardContent>
                </Card>
              );
}

export function AdvisoryBypassCard({
  snapshot,
  snapshotLoading,
}: {
  snapshot: HealthSnapshot | undefined;
  snapshotLoading: boolean;
}) {
              // Task #1075 — show why local-dominance sync keeps bypassing
              // its advisory slot. Sourced from
              // `getLocalDominanceSlotMetrics()` (`server/services/
              // localDominanceSyncWorker.ts`), the same numbers that drive
              // the `advisory_slot_bypass_high` sub-check on /api/health
              // (windowBypassRate > 10% over ≥20 samples). Operators can
              // see the recent rate, the rolling-window count, and the
              // breakdown by call-site label without grep-ing logs.
              const ldSlot =
                snapshot?.checks?.workers?.advisoryBypass?.local_dominance_sync;
              const SUB_CHECK_RATE_THRESHOLD = 0.1;
              const SUB_CHECK_MIN_SAMPLES = 20;
              const formatPct = (rate: number) =>
                `${(rate * 100).toFixed(1)}%`;
              const formatAge = (ms: number | null) => {
                if (ms === null || ms === undefined) return "—";
                const sec = Math.max(0, Math.floor(ms / 1000));
                if (sec < 60) return `${sec}s`;
                const min = Math.floor(sec / 60);
                if (min < 60) return `${min}m`;
                const hr = Math.floor(min / 60);
                const remMin = min % 60;
                if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
                const day = Math.floor(hr / 24);
                return `${day}d`;
              };
              const sortedWindowLabels = ldSlot
                ? Object.entries(ldSlot.windowBypassByLabel).sort(
                    (a, b) => b[1] - a[1],
                  )
                : [];
              const sortedLifetimeLabels = ldSlot
                ? Object.entries(ldSlot.lifetime.bypassByLabel).sort(
                    (a, b) => b[1] - a[1],
                  )
                : [];
              const isOverThreshold =
                !!ldSlot &&
                ldSlot.windowSamples >= SUB_CHECK_MIN_SAMPLES &&
                ldSlot.windowBypassRate > SUB_CHECK_RATE_THRESHOLD;
              return (
                <Card
                  data-testid="card-advisory-bypass"
                  className={
                    isOverThreshold ? "border-amber-300" : undefined
                  }
                >
                  <CardHeader>
                    <CardTitle className="text-foreground flex items-center gap-2">
                      <AlertTriangle className="w-5 h-5" />
                      Local-Dominance Advisory Slot Bypass
                    </CardTitle>
                    <CardDescription>
                      Local-dominance sync uses an "advisory" workload slot
                      for low-risk metadata writes (status, progress,
                      heartbeat). When the slot can't be acquired within
                      30s, the call proceeds without slot accounting and
                      records a bypass. The{" "}
                      <code>advisory_slot_bypass_high</code> sub-check
                      flips degraded when the rolling-window bypass rate
                      exceeds {formatPct(SUB_CHECK_RATE_THRESHOLD)} over at
                      least {SUB_CHECK_MIN_SAMPLES} samples. Required-slot
                      commits (bulk writes) are never bypassed.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {!ldSlot && snapshotLoading && (
                      <div
                        className="text-sm text-muted-foreground"
                        data-testid="text-advisory-bypass-loading"
                      >
                        Loading advisory bypass metrics…
                      </div>
                    )}
                    {!ldSlot && !snapshotLoading && (
                      <div
                        className="text-sm text-muted-foreground"
                        data-testid="text-advisory-bypass-unavailable"
                      >
                        Advisory bypass metrics are not available right
                        now.
                      </div>
                    )}
                    {ldSlot && (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <div
                            className="border rounded-md p-3"
                            data-testid="stat-advisory-window-rate"
                          >
                            <div className="text-xs text-muted-foreground">
                              Recent bypass rate
                            </div>
                            <div
                              className={`text-2xl font-mono ${
                                isOverThreshold
                                  ? "text-amber-700"
                                  : "text-foreground"
                              }`}
                              data-testid="text-advisory-window-rate"
                            >
                              {formatPct(ldSlot.windowBypassRate)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              over last {ldSlot.windowSamples} of{" "}
                              {ldSlot.windowSize} samples · threshold{" "}
                              {formatPct(SUB_CHECK_RATE_THRESHOLD)}
                            </div>
                          </div>
                          <div
                            className="border rounded-md p-3"
                            data-testid="stat-advisory-window-count"
                          >
                            <div className="text-xs text-muted-foreground">
                              Recent bypass count
                            </div>
                            <div
                              className="text-2xl font-mono text-foreground"
                              data-testid="text-advisory-window-count"
                            >
                              {ldSlot.windowBypassCount}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              of {ldSlot.windowSamples} acquires in window
                            </div>
                          </div>
                          <div
                            className="border rounded-md p-3"
                            data-testid="stat-advisory-window-age"
                          >
                            <div className="text-xs text-muted-foreground">
                              Window span
                            </div>
                            <div
                              className="text-2xl font-mono text-foreground"
                              data-testid="text-advisory-window-age"
                            >
                              {formatAge(ldSlot.oldestSampleAgeMs)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              age of oldest sample
                            </div>
                          </div>
                          <div
                            className="border rounded-md p-3"
                            data-testid="stat-advisory-lifetime"
                          >
                            <div className="text-xs text-muted-foreground">
                              Lifetime bypass rate
                            </div>
                            <div
                              className="text-2xl font-mono text-foreground"
                              data-testid="text-advisory-lifetime-rate"
                            >
                              {formatPct(ldSlot.lifetime.bypassRate)}
                            </div>
                            <div
                              className="text-xs text-muted-foreground"
                              data-testid="text-advisory-lifetime-count"
                            >
                              {ldSlot.lifetime.bypasses} bypasses /{" "}
                              {ldSlot.lifetime.acquires} acquires since boot
                            </div>
                          </div>
                        </div>

                        <div>
                          <div className="text-sm font-semibold mb-2 text-foreground">
                            Recent bypasses by call site
                          </div>
                          {sortedWindowLabels.length === 0 ? (
                            <div
                              className="text-sm text-muted-foreground"
                              data-testid="text-advisory-window-empty"
                            >
                              No bypasses in the rolling window.
                            </div>
                          ) : (
                            <div className="border rounded-md overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead className="bg-muted/50">
                                  <tr>
                                    <th className="text-left px-2 py-1">
                                      Call site label
                                    </th>
                                    <th className="text-right px-2 py-1">
                                      Bypass count
                                    </th>
                                    <th className="text-right px-2 py-1">
                                      Share of bypasses
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {sortedWindowLabels.map(
                                    ([label, count]) => {
                                      const share =
                                        ldSlot.windowBypassCount > 0
                                          ? count / ldSlot.windowBypassCount
                                          : 0;
                                      return (
                                        <tr
                                          key={label}
                                          className="border-t"
                                          data-testid={`row-advisory-window-${label}`}
                                        >
                                          <td
                                            className="px-2 py-1 font-mono"
                                            data-testid={`text-advisory-window-label-${label}`}
                                          >
                                            {label}
                                          </td>
                                          <td
                                            className="px-2 py-1 text-right font-mono"
                                            data-testid={`text-advisory-window-count-${label}`}
                                          >
                                            {count}
                                          </td>
                                          <td
                                            className="px-2 py-1 text-right text-muted-foreground"
                                            data-testid={`text-advisory-window-share-${label}`}
                                          >
                                            {formatPct(share)}
                                          </td>
                                        </tr>
                                      );
                                    },
                                  )}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>

                        {sortedLifetimeLabels.length > 0 && (
                          <div>
                            <div className="text-sm font-semibold mb-2 text-foreground">
                              Lifetime bypasses by call site
                            </div>
                            <div className="border rounded-md overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead className="bg-muted/50">
                                  <tr>
                                    <th className="text-left px-2 py-1">
                                      Call site label
                                    </th>
                                    <th className="text-right px-2 py-1">
                                      Bypass count
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {sortedLifetimeLabels.map(
                                    ([label, count]) => (
                                      <tr
                                        key={label}
                                        className="border-t"
                                        data-testid={`row-advisory-lifetime-${label}`}
                                      >
                                        <td
                                          className="px-2 py-1 font-mono"
                                          data-testid={`text-advisory-lifetime-label-${label}`}
                                        >
                                          {label}
                                        </td>
                                        <td
                                          className="px-2 py-1 text-right font-mono"
                                          data-testid={`text-advisory-lifetime-count-${label}`}
                                        >
                                          {count}
                                        </td>
                                      </tr>
                                    ),
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {isOverThreshold ? (
                          <div
                            className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2"
                            data-testid="text-advisory-over-threshold"
                          >
                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                            <span>
                              Bypass rate is above the{" "}
                              {formatPct(SUB_CHECK_RATE_THRESHOLD)}{" "}
                              threshold. The top call sites above are the
                              ones unable to acquire the workload slot
                              within 30s — usually because the{" "}
                              <code>local_dominance_sync</code> class is
                              saturated. Required-slot commits still wait
                              for a real slot, so data integrity is
                              unaffected; only the advisory metadata
                              writes ran without slot accounting.
                            </span>
                          </div>
                        ) : (
                          <div
                            className="text-xs text-muted-foreground"
                            data-testid="text-advisory-under-threshold"
                          >
                            Bypass rate is within the{" "}
                            {formatPct(SUB_CHECK_RATE_THRESHOLD)}{" "}
                            threshold — no degraded sub-check.
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
}
