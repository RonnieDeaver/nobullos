import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  MapPin,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

type CoverageStatus = "ok" | "partial" | "missing" | "inconclusive";

type LocationCoverage = {
  clientId: string;
  clientName: string;
  locationId: string;
  locationName: string;
  total: number;
  ok: number;
  partial: number;
  missing: number;
  inconclusive: number;
  campaignCount: number;
  status: CoverageStatus;
  earliestGapDate: string | null;
  latestGapDate: string | null;
};

type CoverageRow = {
  clientId: string;
  locationId: string;
  campaignId: string;
  campaignName: string | null;
  reportDate: string;
  expectedKeywords: number | null;
  actualSnapshots: number;
  coverage: CoverageStatus;
  note?: string;
  usedCachedMetadata?: boolean;
  cachedMetadataAt?: string | null;
};

type CoverageResponse = {
  generatedAt: string;
  summary: {
    mappings: number;
    campaignsFetched: number;
    campaignFetchFailures: number;
    dateTuples: number;
    ok: number;
    partial: number;
    missing: number;
    inconclusive: number;
  };
  perLocation: LocationCoverage[];
  campaignFetchFailures: Array<{ campaignId: string; error: string }>;
};

type DrilldownResponse = {
  clientId: string;
  locationId: string;
  rows: CoverageRow[];
  gapWindows: Array<{
    campaignId: string;
    campaignName: string | null;
    sinceDate: string;
    untilDate: string;
    reportDates: string[];
  }>;
  generatedAt: string;
};

const STATUS_LABEL: Record<CoverageStatus, string> = {
  ok: "OK",
  partial: "Partial",
  missing: "Missing",
  inconclusive: "Inconclusive",
};

const STATUS_CLASS: Record<CoverageStatus, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800",
  missing: "bg-rose-50 text-rose-700 border-rose-200",
  inconclusive: "bg-gray-100 text-gray-700 border-gray-200",
};

function buildWindowQuery(since: string, until: string): string {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (until) params.set("until", until);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function LocationDrilldown({
  clientId,
  locationId,
  clientName,
  locationName,
  since,
  until,
}: {
  clientId: string;
  locationId: string;
  clientName: string;
  locationName: string;
  since: string;
  until: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [refreshingMetadataFor, setRefreshingMetadataFor] = useState<
    string | null
  >(null);

  const windowQs = buildWindowQuery(since, until);
  const drilldownUrl = `/api/integrations/semrush/heatmap-coverage/${clientId}/${locationId}${windowQs}`;
  const { data, isLoading, isFetching, refetch, error } =
    useQuery<DrilldownResponse>({
      queryKey: [drilldownUrl],
    });

  const refreshMetadata = async (campaignId: string) => {
    setRefreshingMetadataFor(campaignId);
    try {
      const res = await fetch(
        `/api/integrations/semrush/heatmap-coverage/campaign/${campaignId}/refresh-metadata`,
        { method: "POST", credentials: "include" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error || `Refresh failed (${res.status})`);
      }
      if (json.live) {
        toast({
          title: "Metadata refreshed",
          description: `Fetched ${json.reportDateCount} report date(s) and ${
            json.activeKeywordCount ?? "?"
          } active keyword(s) from SEMrush.`,
        });
      } else if (json.usedCachedMetadata) {
        toast({
          title: "SEMrush still unavailable",
          description: `Live fetch failed — still showing cached metadata from ${
            (json.cachedMetadataAt || "").slice(0, 10) || "earlier"
          }.`,
        });
      } else {
        toast({
          title: "SEMrush unavailable",
          description:
            json.campaignError ||
            json.keywordError ||
            "Live fetch failed and no cached metadata is available yet.",
          variant: "destructive",
        });
      }
      void queryClient.invalidateQueries({
        queryKey: ["/api/integrations/semrush/heatmap-coverage"],
      }); // fire-and-forget: cache refresh only
      void refetch(); // fire-and-forget: cache refresh only
    } catch (err: any) {
      toast({
        title: "Refresh failed",
        description: err?.message || "Try again.",
        variant: "destructive",
      });
    } finally {
      setRefreshingMetadataFor(null);
    }
  };

  const rerunMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch(
        `/api/integrations/semrush/heatmap-coverage/${clientId}/${locationId}/rerun${windowQs}`,
        { method: "POST", credentials: "include" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(json?.error || `Rerun failed (${res.status})`);
      return json as {
        ok: boolean;
        ranWindows: number;
        totalEnqueued?: number;
      };
    },
    onSuccess: (json) => {
      toast({
        title: "Backfill enqueued",
        description: `Re-ran ${json.ranWindows} gap window(s); ${
          json.totalEnqueued ?? 0
        } refresh job(s) enqueued.`,
      });
      setConfirming(false);
      void queryClient.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).startsWith(
            "/api/integrations/semrush/heatmap-coverage",
          ),
      }); // fire-and-forget: cache refresh only
      void refetch(); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Rerun failed",
        description: err?.message || "Try again.",
        variant: "destructive",
      });
      setConfirming(false);
    },
  });

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground p-4"
        data-testid={`text-coverage-drilldown-loading-${clientId}-${locationId}`}
      >
        <Loader2 className="w-4 h-4 animate-spin" /> Loading gap detail…
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="text-sm text-rose-600 p-4"
        data-testid={`text-coverage-drilldown-error-${clientId}-${locationId}`}
      >
        Failed to load coverage drill-down.
      </div>
    );
  }
  if (!data) return null;

  const gapRows = data.rows.filter(
    (r) => r.coverage === "missing" || r.coverage === "partial",
  );
  const inconclusiveRows = data.rows.filter(
    (r) => r.coverage === "inconclusive",
  );
  const hasGaps = data.gapWindows.length > 0;

  return (
    <div
      className="bg-slate-50 border-t px-4 py-3 space-y-3"
      data-testid={`drilldown-coverage-${clientId}-${locationId}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-gray-600">
          {gapRows.length} gap date(s){" "}
          {inconclusiveRows.length > 0 &&
            `· ${inconclusiveRows.length} inconclusive`}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={isFetching}
            onClick={() => refetch()}
            data-testid={`button-coverage-drilldown-refresh-${clientId}-${locationId}`}
          >
            {isFetching ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
          {hasGaps &&
            (confirming ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={rerunMutation.isPending}
                  onClick={() => rerunMutation.mutate()}
                  data-testid={`button-coverage-rerun-confirm-${clientId}-${locationId}`}
                >
                  {rerunMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Confirm rerun ({data.gapWindows.length} window
                  {data.gapWindows.length === 1 ? "" : "s"})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rerunMutation.isPending}
                  onClick={() => setConfirming(false)}
                  data-testid={`button-coverage-rerun-cancel-${clientId}-${locationId}`}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={() => setConfirming(true)}
                data-testid={`button-coverage-rerun-${clientId}-${locationId}`}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                Re-run backfill for gaps
              </Button>
            ))}
        </div>
      </div>

      {hasGaps && (
        <div className="text-xs text-gray-600">
          Re-run will enqueue refresh jobs for these per-campaign windows for{" "}
          <span className="font-medium">
            {clientName} / {locationName}
          </span>
          :
          <ul className="list-disc ml-5 mt-1 space-y-0.5">
            {data.gapWindows.map((w) => (
              <li
                key={w.campaignId}
                data-testid={`text-gap-window-${w.campaignId}`}
              >
                {w.campaignName || w.campaignId} — {w.sinceDate} → {w.untilDate}{" "}
                ({w.reportDates.length} date
                {w.reportDates.length === 1 ? "" : "s"})
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="text-sm text-muted-foreground italic">
          No coverage rows for this location.
        </div>
      ) : (
        <div className="overflow-x-auto border rounded">
          <table
            className="w-full text-xs"
            data-testid={`table-coverage-drilldown-${clientId}-${locationId}`}
          >
            <thead className="bg-card text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Campaign</th>
                <th className="text-left px-3 py-2">Report date</th>
                <th className="text-right px-3 py-2">Snapshots</th>
                <th className="text-right px-3 py-2">Expected</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Note</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.rows
                .slice()
                .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
                .map((r, idx) => {
                  const isInconclusive = r.coverage === "inconclusive";
                  const refreshing = refreshingMetadataFor === r.campaignId;
                  return (
                  <tr
                    key={`${r.campaignId}-${r.reportDate}-${idx}`}
                    className="border-t bg-card"
                    data-testid={`row-coverage-row-${r.campaignId}-${r.reportDate}`}
                  >
                    <td className="px-3 py-1.5">
                      <div>{r.campaignName || "—"}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {r.campaignId}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 font-mono">
                      {r.reportDate.slice(0, 10)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {r.actualSnapshots}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {r.expectedKeywords ?? "?"}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge
                        variant="outline"
                        className={STATUS_CLASS[r.coverage]}
                      >
                        {STATUS_LABEL[r.coverage]}
                      </Badge>
                      {r.usedCachedMetadata && r.cachedMetadataAt && (
                        <div
                          className="text-xs text-amber-700 dark:text-amber-400 mt-0.5"
                          data-testid={`text-coverage-cached-meta-${r.campaignId}-${r.reportDate}`}
                        >
                          cached {r.cachedMetadataAt.slice(0, 10)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {r.note || ""}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {(isInconclusive || r.usedCachedMetadata) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={refreshing}
                          onClick={() => refreshMetadata(r.campaignId)}
                          data-testid={`button-coverage-refresh-metadata-${r.campaignId}-${r.reportDate}`}
                        >
                          {refreshing ? (
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3 h-3 mr-1" />
                          )}
                          Refresh metadata
                        </Button>
                      )}
                    </td>
                  </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function HeatmapCoveragePanel() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showOnlyGaps, setShowOnlyGaps] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const windowQs = buildWindowQuery(since, until);
  const coverageUrl = `/api/integrations/semrush/heatmap-coverage${windowQs}`;
  const { data, isLoading, isFetching, refetch, error } =
    useQuery<CoverageResponse>({
      queryKey: [coverageUrl],
    });

  const { toast } = useToast();
  const [recomputing, setRecomputing] = useState(false);
  const handleForceRefresh = async () => {
    setRecomputing(true);
    try {
      const forceParams = new URLSearchParams(windowQs.replace(/^\?/, ""));
      forceParams.set("force", "true");
      const res = await fetch(
        `/api/integrations/semrush/heatmap-coverage?${forceParams.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || `Re-compute failed (${res.status})`);
      }
      void queryClient.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).startsWith(
            "/api/integrations/semrush/heatmap-coverage",
          ),
      }); // fire-and-forget: cache refresh only
      toast({
        title: "Coverage re-computed",
        description: "Server-side cache bypassed; results refreshed.",
      });
    } catch (err: any) {
      toast({
        title: "Re-compute failed",
        description: err?.message || "Try again.",
        variant: "destructive",
      });
    } finally {
      setRecomputing(false);
    }
  };

  const filtered = (() => {
    if (!data) return [];
    let items = data.perLocation;
    if (showOnlyGaps) {
      items = items.filter((i) => i.status !== "ok");
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      items = items.filter((i) =>
        [i.clientName, i.locationName, i.clientId, i.locationId]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(s)),
      );
    }
    return items;
  })();

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Card data-testid="section-heatmap-coverage">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
              <MapPin className="w-5 h-5 text-orange-600" />
              Heatmap Coverage Gaps
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Per-location heatmap snapshot coverage across the SEMrush mapping
              inventory. Drill into a location to see the missing report dates
              and re-run a scoped backfill.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-heatmap-coverage-refresh"
            >
              {isFetching ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              )}
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleForceRefresh}
              disabled={isFetching || recomputing}
              data-testid="button-heatmap-coverage-recompute"
              title="Bypass server-side cache and re-fetch SEMrush metadata"
            >
              {recomputing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Re-compute
            </Button>
          </div>
        </div>
        {data && (
          <div className="flex items-center gap-2 flex-wrap pt-2">
            <Badge
              variant="outline"
              className={STATUS_CLASS.ok}
              data-testid="badge-coverage-summary-ok"
            >
              OK: {data.summary.ok}
            </Badge>
            <Badge
              variant="outline"
              className={STATUS_CLASS.partial}
              data-testid="badge-coverage-summary-partial"
            >
              Partial: {data.summary.partial}
            </Badge>
            <Badge
              variant="outline"
              className={STATUS_CLASS.missing}
              data-testid="badge-coverage-summary-missing"
            >
              Missing: {data.summary.missing}
            </Badge>
            <Badge
              variant="outline"
              className={STATUS_CLASS.inconclusive}
              data-testid="badge-coverage-summary-inconclusive"
            >
              Inconclusive: {data.summary.inconclusive}
            </Badge>
            <span
              className="text-xs text-muted-foreground"
              data-testid="text-coverage-summary-meta"
            >
              {data.summary.dateTuples} date tuples across{" "}
              {data.summary.mappings} mapping(s) ·{" "}
              {data.summary.campaignsFetched} campaign(s) fetched
              {data.summary.campaignFetchFailures > 0 &&
                ` · ${data.summary.campaignFetchFailures} fetch failure(s)`}
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by client or location..."
            className="max-w-sm"
            data-testid="input-coverage-search"
          />
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={showOnlyGaps}
              onChange={(e) => setShowOnlyGaps(e.target.checked)}
              data-testid="checkbox-coverage-only-gaps"
            />
            Only show locations with gaps
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            Since
            <Input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="h-8 w-[150px]"
              data-testid="input-coverage-since"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            Until
            <Input
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="h-8 w-[150px]"
              data-testid="input-coverage-until"
            />
          </label>
          {(since || until) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSince("");
                setUntil("");
              }}
              data-testid="button-coverage-clear-window"
            >
              Clear
            </Button>
          )}
        </div>
        {data && data.campaignFetchFailures.length > 0 && (
          <div
            className="text-xs text-amber-700 bg-amber-50 border border-amber-200 dark:text-amber-300 dark:bg-amber-950/30 dark:border-amber-800 rounded px-3 py-2 flex items-start gap-2"
            data-testid="text-coverage-campaign-failures"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              {data.campaignFetchFailures.length} campaign(s) could not be
              fetched from SEMrush — affected locations show as inconclusive.
            </div>
          </div>
        )}
        {isLoading ? (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="text-coverage-loading"
          >
            <Loader2 className="w-4 h-4 animate-spin" /> Loading coverage… this
            can take a few seconds while SEMrush metadata is fetched.
          </div>
        ) : error ? (
          <div className="text-sm text-rose-600" data-testid="text-coverage-error">
            Failed to load coverage.
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="text-sm text-muted-foreground italic"
            data-testid="text-coverage-empty"
          >
            {showOnlyGaps
              ? "No locations have heatmap coverage gaps. ✓"
              : "No locations match the current filter."}
          </div>
        ) : (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm" data-testid="table-coverage">
              <thead className="bg-slate-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="px-2 py-2 w-6"></th>
                  <th className="text-left px-3 py-2">Client / Location</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">OK</th>
                  <th className="text-right px-3 py-2">Partial</th>
                  <th className="text-right px-3 py-2">Missing</th>
                  <th className="text-right px-3 py-2">Inconclusive</th>
                  <th className="text-left px-3 py-2">Gap window</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((loc) => {
                  const key = `${loc.clientId}::${loc.locationId}`;
                  const isOpen = expanded.has(key);
                  return (
                    <Fragment key={key}>
                      <tr
                        id={`coverage-row-${loc.clientId}-${loc.locationId}`}
                        className="border-t cursor-pointer hover:bg-slate-50 target:bg-amber-50 target:outline target:outline-2 target:outline-amber-400 scroll-mt-24"
                        onClick={() => toggle(key)}
                        data-testid={`row-coverage-${loc.clientId}-${loc.locationId}`}
                      >
                        <td className="px-2 py-2 align-top text-muted-foreground">
                          {isOpen ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="font-medium">{loc.clientName}</div>
                          <div className="text-xs text-gray-600">
                            {loc.locationName}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {loc.campaignCount} campaign
                            {loc.campaignCount === 1 ? "" : "s"}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <Badge
                            variant="outline"
                            className={STATUS_CLASS[loc.status]}
                            data-testid={`badge-coverage-status-${loc.clientId}-${loc.locationId}`}
                          >
                            {loc.status === "ok" && (
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                            )}
                            {STATUS_LABEL[loc.status]}
                          </Badge>
                        </td>
                        <td
                          className="px-3 py-2 align-top text-right"
                          data-testid={`text-coverage-ok-${loc.clientId}-${loc.locationId}`}
                        >
                          {loc.ok}
                        </td>
                        <td
                          className="px-3 py-2 align-top text-right"
                          data-testid={`text-coverage-partial-${loc.clientId}-${loc.locationId}`}
                        >
                          {loc.partial}
                        </td>
                        <td
                          className="px-3 py-2 align-top text-right"
                          data-testid={`text-coverage-missing-${loc.clientId}-${loc.locationId}`}
                        >
                          {loc.missing}
                        </td>
                        <td
                          className="px-3 py-2 align-top text-right"
                          data-testid={`text-coverage-inconclusive-${loc.clientId}-${loc.locationId}`}
                        >
                          {loc.inconclusive}
                        </td>
                        <td className="px-3 py-2 align-top text-xs text-gray-600">
                          {loc.earliestGapDate ? (
                            <>
                              {loc.earliestGapDate}
                              {loc.latestGapDate &&
                                loc.latestGapDate !== loc.earliestGapDate && (
                                  <> → {loc.latestGapDate}</>
                                )}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr
                          data-testid={`row-coverage-detail-${loc.clientId}-${loc.locationId}`}
                        >
                          <td colSpan={8} className="p-0">
                            <LocationDrilldown
                              clientId={loc.clientId}
                              locationId={loc.locationId}
                              clientName={loc.clientName}
                              locationName={loc.locationName}
                              since={since}
                              until={until}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
