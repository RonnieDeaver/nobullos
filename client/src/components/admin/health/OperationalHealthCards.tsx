import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { useAuth } from "@/hooks/use-auth";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";

type DeadLetterJob = {
  id: string;
  queueName: string;
  jobType: string;
  workloadClass: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  errorMessage: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  payload: any;
};

type DeadLetterResponse = {
  jobs: DeadLetterJob[];
  total: number;
};

type BulkReplayPreview = {
  count: number;
  cap: number;
  wouldExceedCap?: boolean;
  warning?: string;
  queueName: string | null;
  sample?: Array<{ id: string; queueName: string; workloadClass: string; errorMessage: string | null; completedAt: string | null }>;
};

type BulkReplayCapError = {
  matchCount: number;
  cap: number;
  hint?: string;
  queueName: string | null;
};

const DEAD_LETTER_PAGE_SIZE = 20;
const DEAD_LETTER_REFRESH_INTERVAL_MS = 15000;
const STUCK_PROCESSING_REFRESH_INTERVAL_MS = 10000;

type StuckProcessingJob = {
  id: string;
  queueName: string;
  workloadClass: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  processingAgeMs: number;
  heartbeatAgeMs: number | null;
  leaseRemainingMs: number | null;
  maxProcessingMs: number;
  overMaxByMs: number;
  willReclaim: boolean;
};

type StuckProcessingResponse = {
  rows: StuckProcessingJob[];
  byQueue: Array<{
    queueName: string;
    count: number;
    maxProcessingMs: number;
    oldestProcessingAgeMs: number;
  }>;
  countOverMax: number;
  totalRows: number;
};

function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return `${sign}${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${sign}${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return `${sign}${hr}h ${remMin}m`;
  const days = Math.floor(hr / 24);
  const remHr = hr % 24;
  return `${sign}${days}d ${remHr}h`;
}

export function StuckProcessingJobsCard() {
  const queryClient = useQueryClient();
  const isTabVisible = useTabVisibility();
  const { toast } = useToast();

  const [stuckExpanded, setStuckExpanded] = useState(false);
  const [stuckQueueFilter, setStuckQueueFilter] = useState<string>("");
  const [stuckSortBy, setStuckSortBy] = useState<"processingAge" | "overMaxBy">("processingAge");
  const [stuckSortDir, setStuckSortDir] = useState<"asc" | "desc">("desc");
  const [stuckOnlyReclaim, setStuckOnlyReclaim] = useState<boolean>(false);
  const [reclaimTarget, setReclaimTarget] = useState<StuckProcessingJob | null>(null);
  const [reclaimingId, setReclaimingId] = useState<string | null>(null);

  const reclaimMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (jobId: string) => {
      const res = await fetch(`/api/integrations/work-queue/${jobId}/reclaim`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error || `Failed to reclaim job (HTTP ${res.status})`);
      }
      return body as {
        success: boolean;
        outcome: "recovered" | "exhausted";
        queueName: string;
        previousLeaseOwner: string | null;
      };
    },
    onSuccess: (data, jobId) => {
      const ownerNote = data.previousLeaseOwner
        ? ` Previous owner: ${data.previousLeaseOwner}.`
        : "";
      toast({
        title: data.outcome === "exhausted" ? "Job exhausted" : "Job released",
        description:
          data.outcome === "exhausted"
            ? `Job ${jobId.slice(0, 8)}… reached its attempt limit and was marked failed.${ownerNote}`
            : `Job ${jobId.slice(0, 8)}… was returned to pending and will be re-claimed.${ownerNote}`,
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/integrations/work-queue/stuck-processing"],
      });
    },
    onError: (err: any) => {
      toast({
        title: "Reclaim failed",
        description: err?.message ?? "Unable to reclaim job",
        variant: "destructive",
      });
    },
    onSettled: () => {
      setReclaimingId(null);
      setReclaimTarget(null);
    },
  });

  const handleConfirmReclaim = () => {
    if (!reclaimTarget) return;
    setReclaimingId(reclaimTarget.id);
    reclaimMutation.mutate(reclaimTarget.id);
  };

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState !== "hidden" && stuckExpanded) {
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/stuck-processing"] }); // fire-and-forget: cache refresh only
        void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive/stuck-processing"] }); // fire-and-forget: cache refresh only
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [queryClient, stuckExpanded]);

  const { data: stuckData, isLoading: stuckLoading, dataUpdatedAt: stuckUpdatedAt } = useQuery<StuckProcessingResponse>({
    queryKey: ["/api/integrations/work-queue/stuck-processing"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/work-queue/stuck-processing", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch stuck processing jobs");
      return res.json();
    },
    enabled: stuckExpanded,
    refetchInterval: stuckExpanded && isTabVisible ? STUCK_PROCESSING_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  // Task #1078: the call_archive lease lives on twilio_calls.archive_*
  // (not in work_queue) but is operationally identical to a stuck
  // work_queue row. Surface the count on the same card so the alerting
  // surface stays unified — operators don't have to know whether a
  // stuck recording lives in work_queue or twilio_calls.
  const { data: callArchiveStuck } = useQuery<{ stuckCount: number; leaseReleasedCount: number; overCeilingCount: number; activeCount: number; totalRows: number; maxProcessingMs: number }>({
    queryKey: ["/api/admin/twilio/call-archive/stuck-processing"],
    queryFn: async () => {
      const res = await fetch("/api/admin/twilio/call-archive/stuck-processing", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch stuck call recordings");
      return res.json();
    },
    refetchInterval: isTabVisible ? STUCK_PROCESSING_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
  // Mirror the work_queue card semantics: "will reclaim" counts only rows
  // whose lease has actually been released (the next claim tick will reclaim
  // them). Rows that are over the ceiling but still leased are surfaced
  // separately on the dedicated call-archive page.
  const callArchiveReleasedCount = callArchiveStuck?.leaseReleasedCount ?? 0;
  const callArchiveTotalProcessing = callArchiveStuck?.totalRows ?? 0;

  const [stuckNowTick, setStuckNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!stuckExpanded) return;
    setStuckNowTick(Date.now());
    const id = setInterval(() => setStuckNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [stuckExpanded]);
  const stuckSecondsSinceRefresh = stuckUpdatedAt
    ? Math.max(0, Math.floor((stuckNowTick - stuckUpdatedAt) / 1000))
    : null;
  const stuckSecondsUntilRefresh = stuckUpdatedAt
    ? Math.max(0, Math.ceil((stuckUpdatedAt + STUCK_PROCESSING_REFRESH_INTERVAL_MS - stuckNowTick) / 1000))
    : null;

  const totalRows = stuckData?.totalRows ?? 0;
  const countOverMax = stuckData?.countOverMax ?? 0;
  const totalReclaimCount = countOverMax + callArchiveReleasedCount;
  const totalProcessingCount = totalRows + callArchiveTotalProcessing;

  return (
    <Card className="bg-card" data-testid="card-stuck-processing-jobs">
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setStuckExpanded(!stuckExpanded)}>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className={`w-5 h-5 ${totalReclaimCount > 0 ? "text-red-600" : totalProcessingCount > 0 ? "text-amber-500" : "text-muted-foreground"}`} />
          Stuck Background Jobs
          {totalReclaimCount > 0 && (
            <Badge variant="outline" className="ml-2 bg-red-50 text-red-700 border-red-200" data-testid="badge-stuck-processing-reclaim">
              {totalReclaimCount} will reclaim
            </Badge>
          )}
          {totalProcessingCount > 0 && totalReclaimCount === 0 && (
            <Badge variant="outline" className="ml-2 bg-amber-50 text-amber-700 border-amber-200" data-testid="badge-stuck-processing-active">
              {totalProcessingCount} processing
            </Badge>
          )}
          {stuckData && totalProcessingCount === 0 && (
            <Badge variant="outline" className="ml-2 bg-green-50 text-green-700 border-green-200" data-testid="badge-stuck-processing-ok">
              Healthy
            </Badge>
          )}
          {callArchiveTotalProcessing > 0 && (
            <Badge
              variant="outline"
              className="ml-1 bg-blue-50 text-blue-700 border-blue-200 text-caption"
              data-testid="badge-stuck-call-archive"
              title="Call recording archive pipeline (twilio_calls.archive_*) — see admin Twilio call-archive page. Format: lease-released / total processing."
            >
              call_archive: {callArchiveReleasedCount}/{callArchiveTotalProcessing}
            </Badge>
          )}
          {stuckExpanded && stuckUpdatedAt > 0 && (
            <span
              className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground"
              data-testid="text-stuck-processing-refresh-countdown"
              title={`Last refreshed ${stuckSecondsSinceRefresh}s ago`}
            >
              <RefreshCw className="w-3 h-3 text-muted-foreground" />
              <span>{isTabVisible ? `Refreshes in ${stuckSecondsUntilRefresh}s` : "Paused (tab hidden)"}</span>
            </span>
          )}
          {stuckExpanded ? <ChevronUp className={`w-4 h-4 text-muted-foreground ${stuckUpdatedAt > 0 ? "ml-2" : "ml-auto"}`} /> : <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      {stuckExpanded && (
        <CardContent className="space-y-4" data-testid="stuck-processing-content">
          <p className="text-xs text-muted-foreground">
            Background jobs currently in <code>leased</code> or <code>processing</code>. Rows marked
            "Will reclaim" have exceeded the queue's max-processing ceiling and will be released on
            the next stale-lease sweep.
          </p>
          {stuckLoading ? (
            <InlineLoadingSkeleton />
          ) : !stuckData || stuckData.rows.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm" data-testid="text-stuck-processing-empty">
              No background jobs are currently stuck — all leases are within their max-processing window.
            </div>
          ) : (
            <>
              {stuckData.byQueue.length > 0 && (
                <div className="flex flex-wrap gap-2" data-testid="stuck-processing-by-queue">
                  {stuckData.byQueue.map((g) => (
                    <Badge
                      key={g.queueName}
                      variant="outline"
                      className={`text-xs cursor-pointer ${
                        stuckQueueFilter === g.queueName
                          ? "bg-blue-100 text-blue-800 border-blue-300"
                          : "bg-muted/50 text-foreground border-border"
                      }`}
                      onClick={() =>
                        setStuckQueueFilter(stuckQueueFilter === g.queueName ? "" : g.queueName)
                      }
                      data-testid={`badge-stuck-by-queue-${g.queueName}`}
                    >
                      {g.queueName}: {g.count} (oldest {formatDurationMs(g.oldestProcessingAgeMs)})
                    </Badge>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="stuck-queue-filter" className="text-xs text-muted-foreground">
                    Queue
                  </Label>
                  <Select
                    value={stuckQueueFilter || "__all__"}
                    onValueChange={(v) => setStuckQueueFilter(v === "__all__" ? "" : v)}
                  >
                    <SelectTrigger
                      id="stuck-queue-filter"
                      className="h-8 w-48 text-xs"
                      data-testid="select-stuck-queue-filter"
                    >
                      <SelectValue placeholder="All queues" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__" data-testid="option-stuck-queue-all">
                        All queues
                      </SelectItem>
                      {stuckData.byQueue.map((g) => (
                        <SelectItem
                          key={g.queueName}
                          value={g.queueName}
                          data-testid={`option-stuck-queue-${g.queueName}`}
                        >
                          {g.queueName} ({g.count})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stuckOnlyReclaim}
                    onChange={(e) => setStuckOnlyReclaim(e.target.checked)}
                    data-testid="checkbox-stuck-only-reclaim"
                    className="h-3.5 w-3.5"
                  />
                  Only rows that will reclaim
                </label>
                {(stuckQueueFilter || stuckOnlyReclaim) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setStuckQueueFilter("");
                      setStuckOnlyReclaim(false);
                    }}
                    data-testid="button-stuck-clear-filters"
                  >
                    Clear
                  </Button>
                )}
              </div>
              {(() => {
                const filteredRows = stuckData.rows
                  .filter((r) => (stuckQueueFilter ? r.queueName === stuckQueueFilter : true))
                  .filter((r) => (stuckOnlyReclaim ? r.willReclaim : true));
                const sortedRows = [...filteredRows].sort((a, b) => {
                  const av =
                    stuckSortBy === "processingAge" ? a.processingAgeMs : a.overMaxByMs;
                  const bv =
                    stuckSortBy === "processingAge" ? b.processingAgeMs : b.overMaxByMs;
                  return stuckSortDir === "asc" ? av - bv : bv - av;
                });
                const toggleSort = (col: "processingAge" | "overMaxBy") => {
                  if (stuckSortBy === col) {
                    setStuckSortDir(stuckSortDir === "asc" ? "desc" : "asc");
                  } else {
                    setStuckSortBy(col);
                    setStuckSortDir("desc");
                  }
                };
                const sortIndicator = (col: "processingAge" | "overMaxBy") =>
                  stuckSortBy === col ? (stuckSortDir === "asc" ? " ▲" : " ▼") : "";
                if (sortedRows.length === 0) {
                  return (
                    <div
                      className="text-center py-6 text-muted-foreground text-xs"
                      data-testid="text-stuck-processing-filtered-empty"
                    >
                      No rows match the current filters.
                    </div>
                  );
                }
                return (
                  <>
                    <div className="text-xs text-muted-foreground" data-testid="text-stuck-processing-filtered-count">
                      Showing {sortedRows.length} of {stuckData.rows.length} stuck job{stuckData.rows.length === 1 ? "" : "s"}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs" data-testid="table-stuck-processing">
                        <thead>
                          <tr className="text-left text-muted-foreground border-b">
                            <th className="py-2 pr-3 font-medium">Queue</th>
                            <th className="py-2 pr-3 font-medium">Status</th>
                            <th className="py-2 pr-3 font-medium">Lease age</th>
                            <th
                              className="py-2 pr-3 font-medium cursor-pointer select-none hover:text-foreground"
                              onClick={() => toggleSort("processingAge")}
                              data-testid="th-stuck-sort-processing-age"
                            >
                              Processing age{sortIndicator("processingAge")}
                            </th>
                            <th className="py-2 pr-3 font-medium">Max</th>
                            <th className="py-2 pr-3 font-medium">Attempts</th>
                            <th
                              className="py-2 pr-3 font-medium cursor-pointer select-none hover:text-foreground"
                              onClick={() => toggleSort("overMaxBy")}
                              data-testid="th-stuck-sort-over-max-by"
                              title="Sort by how far past the queue's max-processing ceiling each row is"
                            >
                              Over max by{sortIndicator("overMaxBy")}
                            </th>
                            <th className="py-2 pr-3 font-medium text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedRows.map((row) => {
                            const leaseAgeMs =
                              row.leasedAt != null
                                ? stuckNowTick - new Date(row.leasedAt).getTime()
                                : null;
                            return (
                              <tr
                                key={row.id}
                                className="border-b last:border-b-0"
                                data-testid={`row-stuck-job-${row.id}`}
                              >
                                <td className="py-2 pr-3">
                                  <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-caption" data-testid={`badge-stuck-queue-${row.id}`}>
                                    {row.queueName}
                                  </Badge>
                                  <span className="ml-2 text-muted-foreground" data-testid={`text-stuck-class-${row.id}`}>
                                    {row.workloadClass}
                                  </span>
                                </td>
                                <td className="py-2 pr-3 text-foreground" data-testid={`text-stuck-status-${row.id}`}>
                                  {row.status}
                                </td>
                                <td className="py-2 pr-3 text-foreground" data-testid={`text-stuck-lease-age-${row.id}`}>
                                  {formatDurationMs(leaseAgeMs)}
                                </td>
                                <td className="py-2 pr-3 text-foreground" data-testid={`text-stuck-processing-age-${row.id}`}>
                                  {formatDurationMs(row.processingAgeMs)}
                                </td>
                                <td className="py-2 pr-3 text-muted-foreground" data-testid={`text-stuck-max-${row.id}`}>
                                  {formatDurationMs(row.maxProcessingMs)}
                                </td>
                                <td className="py-2 pr-3 text-foreground" data-testid={`text-stuck-attempts-${row.id}`}>
                                  {row.attemptCount}/{row.maxAttempts}
                                </td>
                                <td className="py-2 pr-3" data-testid={`text-stuck-reclaim-${row.id}`}>
                                  {row.willReclaim ? (
                                    <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 text-caption">
                                      Will reclaim (over by {formatDurationMs(row.overMaxByMs)})
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-caption">
                                      Healthy
                                    </Badge>
                                  )}
                                </td>
                                <td className="py-2 pr-3 text-right">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-caption"
                                    disabled={reclaimingId === row.id}
                                    onClick={() => setReclaimTarget(row)}
                                    data-testid={`button-reclaim-${row.id}`}
                                    title="Force-release this lease back to pending now"
                                  >
                                    {reclaimingId === row.id ? (
                                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                    ) : (
                                      <RotateCcw className="w-3 h-3 mr-1" />
                                    )}
                                    Reclaim now
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                );
              })()}
            </>
          )}
        </CardContent>
      )}
      <Dialog
        open={!!reclaimTarget}
        onOpenChange={(open) => {
          if (!open && reclaimingId == null) setReclaimTarget(null);
        }}
      >
        <DialogContent data-testid="dialog-reclaim-confirm">
          <DialogHeader>
            <DialogTitle>Reclaim this background job now?</DialogTitle>
            <DialogDescription>
              This releases the lease immediately instead of waiting for the
              next stale-lease sweep. The job's attempt counter will be
              incremented; if it has already reached its max attempts it will
              be marked failed instead of returned to pending.
            </DialogDescription>
          </DialogHeader>
          {reclaimTarget && (
            <div className="space-y-2 text-xs text-foreground" data-testid="reclaim-target-summary">
              <div>
                <span className="text-muted-foreground">Job id:</span>{" "}
                <code className="text-foreground">{reclaimTarget.id}</code>
              </div>
              <div>
                <span className="text-muted-foreground">Queue:</span>{" "}
                <code className="text-foreground">{reclaimTarget.queueName}</code>{" "}
                <span className="text-muted-foreground">({reclaimTarget.workloadClass})</span>
              </div>
              <div>
                <span className="text-muted-foreground">Current lease owner:</span>{" "}
                <code className="text-foreground">{reclaimTarget.leaseOwner ?? "—"}</code>
              </div>
              <div>
                <span className="text-muted-foreground">Attempts:</span>{" "}
                {reclaimTarget.attemptCount}/{reclaimTarget.maxAttempts}
                {reclaimTarget.attemptCount + 1 >= reclaimTarget.maxAttempts && (
                  <span className="ml-2 text-red-700 font-medium">
                    (this attempt will exhaust it)
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">Processing age:</span>{" "}
                {formatDurationMs(reclaimTarget.processingAgeMs)}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReclaimTarget(null)}
              disabled={reclaimingId != null}
              data-testid="button-reclaim-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmReclaim}
              disabled={reclaimingId != null}
              data-testid="button-reclaim-confirm"
            >
              {reclaimingId != null && (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              )}
              Reclaim now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function DeadLetterQueueCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isTabVisible = useTabVisibility();

  const [deadLetterExpanded, setDeadLetterExpanded] = useState(false);
  const [deadLetterPage, setDeadLetterPage] = useState(0);
  const [deadLetterQueueFilter, setDeadLetterQueueFilter] = useState<string>("");
  const [expandedPayloads, setExpandedPayloads] = useState<Set<string>>(new Set());
  const [copiedPayloadJobId, setCopiedPayloadJobId] = useState<string | null>(null);
  const [replayingJobId, setReplayingJobId] = useState<string | null>(null);
  const [bulkReplayPreview, setBulkReplayPreview] = useState<BulkReplayPreview | null>(null);
  const [bulkReplayMaxBatch, setBulkReplayMaxBatch] = useState<string>("");
  const [bulkReplayCapError, setBulkReplayCapError] = useState<BulkReplayCapError | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState !== "hidden" && deadLetterExpanded) {
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/dead-letter"] }); // fire-and-forget: cache refresh only
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/dead-letter/queue-names"] }); // fire-and-forget: cache refresh only
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [queryClient, deadLetterExpanded]);

  const { data: deadLetterQueueNames } = useQuery<{ queueNames: string[] }>({
    queryKey: ["/api/integrations/work-queue/dead-letter/queue-names"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/work-queue/dead-letter/queue-names", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch queue names");
      return res.json();
    },
    enabled: deadLetterExpanded,
    refetchInterval: deadLetterExpanded && isTabVisible ? DEAD_LETTER_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  const { data: deadLetterData, isLoading: deadLetterLoading, dataUpdatedAt: deadLetterUpdatedAt } = useQuery<DeadLetterResponse>({
    queryKey: ["/api/integrations/work-queue/dead-letter", deadLetterPage, deadLetterQueueFilter],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(DEAD_LETTER_PAGE_SIZE),
        offset: String(deadLetterPage * DEAD_LETTER_PAGE_SIZE),
      });
      if (deadLetterQueueFilter) params.set("queueName", deadLetterQueueFilter);
      const res = await fetch(`/api/integrations/work-queue/dead-letter?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch dead-lettered jobs");
      return res.json();
    },
    enabled: deadLetterExpanded,
    refetchInterval: deadLetterExpanded && isTabVisible ? DEAD_LETTER_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  const replayMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (jobId: string) => {
      setReplayingJobId(jobId);
      const res = await apiRequest("POST", `/api/integrations/work-queue/dead-letter/${jobId}/replay`);
      return res.json();
    },
    onSuccess: () => {
      setReplayingJobId(null);
      toast({ title: "Job replayed", description: "The job has been re-enqueued for processing" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/dead-letter"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/dead-letter/queue-names"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/pipeline-metrics"], refetchType: "all" }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      setReplayingJobId(null);
      toast({ title: "Replay failed", description: err.message, variant: "destructive" });
    },
  });

  const parseBulkReplayMaxBatch = (): number | undefined => {
    const trimmed = bulkReplayMaxBatch.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.floor(n);
  };

  const parseErrorBody = (err: any): any | null => {
    try {
      return JSON.parse(String(err?.message ?? "").replace(/^\d+:\s*/, ""));
    } catch {
      return null;
    }
  };

  const bulkReplayDryRunMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (queueName: string) => {
      const maxBatchSize = parseBulkReplayMaxBatch();
      const res = await apiRequest("POST", "/api/integrations/work-queue/dead-letter/replay-all", {
        dryRun: true,
        ...(queueName ? { queueName } : {}),
        ...(maxBatchSize ? { maxBatchSize } : {}),
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      setBulkReplayCapError(null);
      setBulkReplayPreview({
        count: data.count ?? 0,
        cap: data.cap ?? 0,
        wouldExceedCap: data.wouldExceedCap,
        warning: data.warning,
        queueName: data.queueName ?? null,
        sample: data.sample,
      });
    },
    onError: (err: any) => {
      const parsed = parseErrorBody(err);
      if (parsed?.code === "bulk_replay_cap_exceeded") {
        toast({
          title: "Too many jobs to replay",
          description: `${parsed.matchCount} jobs match (cap is ${parsed.cap}). Narrow by queue or replay individually.`,
          variant: "destructive",
        });
        return;
      }
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    },
  });

  const bulkReplayMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (queueName: string | null) => {
      const maxBatchSize = parseBulkReplayMaxBatch();
      const res = await apiRequest("POST", "/api/integrations/work-queue/dead-letter/replay-all", {
        ...(queueName ? { queueName } : {}),
        ...(maxBatchSize ? { maxBatchSize } : {}),
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      setBulkReplayPreview(null);
      setBulkReplayCapError(null);
      toast({ title: "Bulk replay complete", description: `${data.count ?? 0} job(s) re-enqueued for processing` });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/dead-letter"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/pipeline-metrics"], refetchType: "all" }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      const parsed = parseErrorBody(err);
      if (parsed?.code === "bulk_replay_cap_exceeded") {
        setBulkReplayCapError({
          matchCount: Number(parsed.matchCount ?? 0),
          cap: Number(parsed.cap ?? 0),
          hint: parsed.hint,
          queueName: bulkReplayPreview?.queueName ?? null,
        });
        setBulkReplayPreview(null);
        return;
      }
      toast({ title: "Bulk replay failed", description: err.message, variant: "destructive" });
    },
  });

  const deadLetterTotalPages = deadLetterData ? Math.ceil(deadLetterData.total / DEAD_LETTER_PAGE_SIZE) : 0;

  const [deadLetterNowTick, setDeadLetterNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!deadLetterExpanded) return;
    setDeadLetterNowTick(Date.now());
    const id = setInterval(() => setDeadLetterNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadLetterExpanded]);
  const deadLetterSecondsSinceRefresh = deadLetterUpdatedAt
    ? Math.max(0, Math.floor((deadLetterNowTick - deadLetterUpdatedAt) / 1000))
    : null;
  const deadLetterSecondsUntilRefresh = deadLetterUpdatedAt
    ? Math.max(0, Math.ceil((deadLetterUpdatedAt + DEAD_LETTER_REFRESH_INTERVAL_MS - deadLetterNowTick) / 1000))
    : null;

  return (
    <>
      <Card className="bg-card" data-testid="card-dead-letter-queue">
        <CardHeader className="pb-3 cursor-pointer" onClick={() => setDeadLetterExpanded(!deadLetterExpanded)}>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertCircle className="w-5 h-5 text-red-600" />
            Dead Letter Queue
            {deadLetterData && deadLetterData.total > 0 && (
              <Badge variant="outline" className="ml-2 bg-red-50 text-red-700 border-red-200" data-testid="badge-dead-letter-count">
                {deadLetterData.total} job{deadLetterData.total !== 1 ? "s" : ""}
              </Badge>
            )}
            {deadLetterExpanded && deadLetterUpdatedAt > 0 && (
              <span
                className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground"
                data-testid="text-dead-letter-refresh-countdown"
                title={`Last refreshed ${deadLetterSecondsSinceRefresh}s ago`}
              >
                <RefreshCw className="w-3 h-3 text-muted-foreground" />
                <span>{isTabVisible ? `Refreshes in ${deadLetterSecondsUntilRefresh}s` : "Paused (tab hidden)"}</span>
              </span>
            )}
            {deadLetterExpanded ? <ChevronUp className={`w-4 h-4 text-muted-foreground ${deadLetterUpdatedAt > 0 ? "ml-2" : "ml-auto"}`} /> : <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        {deadLetterExpanded && (
          <CardContent className="space-y-4" data-testid="dead-letter-content">
            <div className="flex items-center gap-2">
              <Select
                value={deadLetterQueueFilter || "_all"}
                onValueChange={(value) => { setDeadLetterQueueFilter(value === "_all" ? "" : value); setDeadLetterPage(0); }}
              >
                <SelectTrigger className="max-w-xs text-sm" data-testid="select-dead-letter-filter">
                  <SelectValue placeholder="All queues" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all" data-testid="select-dead-letter-filter-all">All queues</SelectItem>
                  {deadLetterQueueNames?.queueNames.map((name) => (
                    <SelectItem key={name} value={name} data-testid={`select-dead-letter-filter-${name}`}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {deadLetterQueueFilter && (
                <Button variant="ghost" size="sm" onClick={() => { setDeadLetterQueueFilter(""); setDeadLetterPage(0); }} data-testid="button-clear-dead-letter-filter">
                  Clear
                </Button>
              )}
              <div className="ml-auto flex items-center gap-2">
                <label className="text-xs text-muted-foreground flex items-center gap-1" htmlFor="input-bulk-replay-max-batch">
                  Max batch
                  <input
                    id="input-bulk-replay-max-batch"
                    type="number"
                    min={1}
                    placeholder="default"
                    value={bulkReplayMaxBatch}
                    onChange={(e) => setBulkReplayMaxBatch(e.target.value)}
                    className="w-20 h-7 px-2 text-xs border border-border rounded"
                    data-testid="input-bulk-replay-max-batch"
                  />
                </label>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => bulkReplayDryRunMutation.mutate(deadLetterQueueFilter)}
                  disabled={bulkReplayDryRunMutation.isPending || bulkReplayMutation.isPending || !deadLetterData || deadLetterData.total === 0}
                  data-testid="button-bulk-replay"
                >
                  {bulkReplayDryRunMutation.isPending ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Loading…</>
                  ) : (
                    <><RotateCcw className="h-3 w-3 mr-1" />Replay All{deadLetterQueueFilter ? ` (${deadLetterQueueFilter})` : ""}</>
                  )}
                </Button>
              </div>
            </div>

            {deadLetterLoading ? (
              <InlineLoadingSkeleton />
            ) : !deadLetterData || deadLetterData.jobs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm" data-testid="text-dead-letter-empty">
                No dead-lettered jobs found
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  {deadLetterData.jobs.map((job) => (
                    <div key={job.id} className="border rounded-lg p-3 bg-muted/50 space-y-2" data-testid={`dead-letter-job-${job.id}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-xs" data-testid={`badge-queue-${job.id}`}>
                              {job.queueName}
                            </Badge>
                            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 text-xs" data-testid={`badge-class-${job.id}`}>
                              {job.workloadClass}
                            </Badge>
                            <span className="text-xs text-muted-foreground" data-testid={`text-job-type-${job.id}`}>
                              {job.jobType}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                            <span data-testid={`text-attempts-${job.id}`}>
                              {job.attemptCount}/{job.maxAttempts} attempts
                            </span>
                            <span data-testid={`text-created-${job.id}`}>
                              Created: {new Date(job.createdAt).toLocaleString()}
                            </span>
                            {job.completedAt && (
                              <span data-testid={`text-failed-at-${job.id}`}>
                                Failed: {new Date(job.completedAt).toLocaleString()}
                              </span>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => replayMutation.mutate(job.id)}
                          disabled={replayingJobId === job.id}
                          className="shrink-0 text-xs"
                          data-testid={`button-replay-${job.id}`}
                        >
                          {replayingJobId === job.id ? (
                            <Loader2 className="w-3 h-3 animate-spin mr-1" />
                          ) : (
                            <RotateCcw className="w-3 h-3 mr-1" />
                          )}
                          Replay
                        </Button>
                      </div>
                      {job.errorMessage && (
                        <div className="bg-red-50 rounded px-2.5 py-1.5 text-xs text-red-700 font-mono break-all" data-testid={`text-error-${job.id}`}>
                          {job.errorCode && <span className="font-semibold">[{job.errorCode}] </span>}
                          {job.errorMessage}
                        </div>
                      )}
                      {job.payload != null && (
                        <div data-testid={`payload-section-${job.id}`}>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                              onClick={() => setExpandedPayloads(prev => {
                                const next = new Set(prev);
                                if (next.has(job.id)) { next.delete(job.id); } else { next.add(job.id); }
                                return next;
                              })}
                              data-testid={`button-toggle-payload-${job.id}`}
                            >
                              {expandedPayloads.has(job.id) ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              <FileText className="w-3 h-3" />
                              Payload
                            </button>
                            <button
                              type="button"
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-green-600 transition-colors"
                              onClick={() => {
                                const text = typeof job.payload === "string"
                                  ? (() => { try { return JSON.stringify(JSON.parse(job.payload), null, 2); } catch { return job.payload; } })()
                                  : JSON.stringify(job.payload, null, 2);
                                navigator.clipboard.writeText(text).then(() => {
                                  setCopiedPayloadJobId(job.id);
                                  setTimeout(() => setCopiedPayloadJobId(prev => prev === job.id ? null : prev), 2000);
                                }).catch(() => {
                                  window.prompt("Copy failed. Select and copy manually:", text);
                                });
                              }}
                              data-testid={`button-copy-payload-${job.id}`}
                            >
                              {copiedPayloadJobId === job.id ? (
                                <><CheckCircle className="w-3 h-3 text-green-600" /><span className="text-green-600">Copied!</span></>
                              ) : (
                                <><Copy className="w-3 h-3" />Copy</>
                              )}
                            </button>
                          </div>
                          {expandedPayloads.has(job.id) && (
                            <pre
                              className="mt-1.5 bg-muted rounded px-3 py-2 text-xs font-mono text-foreground overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all"
                              data-testid={`text-payload-${job.id}`}
                            >
                              {(() => {
                                if (typeof job.payload === "string") {
                                  try { return JSON.stringify(JSON.parse(job.payload), null, 2); } catch { return job.payload; }
                                }
                                return JSON.stringify(job.payload, null, 2);
                              })()}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {deadLetterTotalPages > 1 && (
                  <div className="flex items-center justify-between pt-2" data-testid="dead-letter-pagination">
                    <span className="text-xs text-muted-foreground">
                      Page {deadLetterPage + 1} of {deadLetterTotalPages} ({deadLetterData.total} total)
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={deadLetterPage === 0}
                        onClick={() => setDeadLetterPage(p => p - 1)}
                        data-testid="button-dead-letter-prev"
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={deadLetterPage >= deadLetterTotalPages - 1}
                        onClick={() => setDeadLetterPage(p => p + 1)}
                        data-testid="button-dead-letter-next"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        )}
      </Card>

      <Dialog open={bulkReplayPreview !== null} onOpenChange={(open) => { if (!open) setBulkReplayPreview(null); }}>
        <DialogContent data-testid="dialog-bulk-replay-confirm">
          <DialogHeader>
            <DialogTitle>Replay all dead-lettered jobs?</DialogTitle>
            <DialogDescription>
              {bulkReplayPreview && (
                bulkReplayPreview.count === 0 ? (
                  <span data-testid="text-bulk-replay-count">No jobs match the current filter — nothing to replay.</span>
                ) : (
                  <span data-testid="text-bulk-replay-count">
                    {bulkReplayPreview.count} job{bulkReplayPreview.count === 1 ? "" : "s"} match
                    {bulkReplayPreview.queueName ? ` queue "${bulkReplayPreview.queueName}"` : " across all queues"} (safety cap: {bulkReplayPreview.cap}).
                    {bulkReplayPreview.wouldExceedCap && (
                      <span
                        className="mt-2 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800"
                        data-testid="text-bulk-replay-warning"
                      >
                        <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span className="text-xs">
                          {bulkReplayPreview.warning
                            ?? `Matched ${bulkReplayPreview.count} jobs, which exceeds the safety cap of ${bulkReplayPreview.cap}. Narrow by queueName or replay individual jobs.`}
                        </span>
                      </span>
                    )}
                  </span>
                )
              )}
            </DialogDescription>
          </DialogHeader>
          {bulkReplayPreview?.sample && bulkReplayPreview.sample.length > 0 && (
            <div className="max-h-48 overflow-y-auto border rounded p-2 bg-muted/50 space-y-1 text-xs" data-testid="list-bulk-replay-sample">
              {bulkReplayPreview.sample.map((s) => (
                <div key={s.id} className="flex items-center gap-2" data-testid={`bulk-replay-sample-${s.id}`}>
                  <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-xs">{s.queueName}</Badge>
                  <span className="text-muted-foreground">{s.workloadClass}</span>
                  {s.errorMessage && <span className="text-muted-foreground truncate">— {s.errorMessage}</span>}
                </div>
              ))}
              {bulkReplayPreview.count > bulkReplayPreview.sample.length && (
                <div className="text-muted-foreground italic pt-1">…and {bulkReplayPreview.count - bulkReplayPreview.sample.length} more</div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkReplayPreview(null)} disabled={bulkReplayMutation.isPending} data-testid="button-bulk-replay-cancel">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => bulkReplayMutation.mutate(bulkReplayPreview?.queueName ?? null)}
              disabled={!bulkReplayPreview || bulkReplayPreview.count === 0 || bulkReplayPreview.wouldExceedCap || bulkReplayMutation.isPending}
              data-testid="button-bulk-replay-confirm"
            >
              {bulkReplayMutation.isPending ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Replaying…</>
              ) : bulkReplayPreview?.wouldExceedCap ? (
                <>Replay blocked — exceeds cap</>
              ) : (
                <>Replay {bulkReplayPreview?.count ?? 0} job{bulkReplayPreview?.count === 1 ? "" : "s"}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkReplayCapError !== null} onOpenChange={(open) => { if (!open) setBulkReplayCapError(null); }}>
        <DialogContent data-testid="dialog-bulk-replay-cap-exceeded">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="h-5 w-5" />
              Bulk replay refused — safety cap exceeded
            </DialogTitle>
            <DialogDescription>
              {bulkReplayCapError && (
                <span className="block space-y-2" data-testid="text-bulk-replay-cap-error">
                  <span className="block">
                    <strong>{bulkReplayCapError.matchCount}</strong> dead-lettered job{bulkReplayCapError.matchCount === 1 ? "" : "s"} matched
                    {bulkReplayCapError.queueName ? <> queue <code className="px-1 bg-muted rounded">{bulkReplayCapError.queueName}</code></> : " across all queues"},
                    which exceeds the safety cap of <strong>{bulkReplayCapError.cap}</strong>.
                  </span>
                  <span className="block text-sm text-foreground">Suggested next steps:</span>
                  <ul className="list-disc pl-5 text-sm text-foreground space-y-1">
                    <li>Narrow the selection by picking a specific <em>queueName</em> filter above.</li>
                    <li>Raise the per-request <em>Max batch</em> only if you have a higher cap headroom — otherwise reduce the match set first.</li>
                    <li>Replay individual jobs from the list using their per-row Replay button.</li>
                  </ul>
                  {bulkReplayCapError.hint && (
                    <span className="block text-xs text-muted-foreground italic">{bulkReplayCapError.hint}</span>
                  )}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkReplayCapError(null)} data-testid="button-bulk-replay-cap-error-close">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type QueueStatusTerminalJob = {
  jobId: string;
  queueName: string;
  workloadClass: string;
  status: string;
  completedAt: string;
  attemptCount: number;
  errorMessage: string | null;
  leaseDurationMs: number | null;
};

type StaleLeaseThresholds = {
  staleWarning: number;
  staleCritical: number;
  exhaustedWarning: number;
  exhaustedCritical: number;
  leaseCutoffMs: number;
};

type QueueTimings = {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
};

type QueueTimingBounds = Record<keyof QueueTimings, { min: number; max: number }>;

type QueueStatus = {
  staleJobs: number;
  recentDeadLettered: QueueStatusTerminalJob[];
  recentFailures: QueueStatusTerminalJob[];
  retryDistribution: Record<string, number>;
  oldestPendingAgeMs: number | null;
  averageLeaseDurationMs: number | null;
  queueDepths: Record<string, number>;
  queueDepthsByClass: Record<string, number>;
  dispatchCounters?: {
    currentWindow: { cycleCount: number; counts: Record<string, number> };
    lastWindow: { capturedAt: string; cycleCount: number; counts: Record<string, number> };
    recentWindows?: Array<{ capturedAt: string; cycleCount: number; counts: Record<string, number> }>;
  };
  staleLeaseThresholds?: StaleLeaseThresholds;
  queueTimings?: QueueTimings;
  queueTimingDefaults?: QueueTimings;
  queueTimingBounds?: QueueTimingBounds;
  staleLeaseThresholdsLastEdited?: LastEditedInfo;
  queueTimingsLastEdited?: LastEditedInfo;
};

type ThresholdAuditEntry = {
  id: string;
  changedBy: string | null;
  changedByName: string | null;
  changedByEmail: string | null;
  oldValues: StaleLeaseThresholds | null;
  newValues: StaleLeaseThresholds;
  changedAt: string;
};

type QueueTimingThroughput = {
  windowMs: number;
  before: number | null;
  after: number | null;
  status: "ok" | "pending" | "no_baseline";
};

type QueueTimingAuditEntry = {
  id: string;
  changedBy: string | null;
  changedByName: string | null;
  changedByEmail: string | null;
  oldValues: QueueTimings | null;
  newValues: QueueTimings;
  changedAt: string;
  throughput: QueueTimingThroughput | null;
};

type RetentionAuditEntry = {
  id: string;
  changedBy: string | null;
  changedByName: string | null;
  changedByEmail: string | null;
  oldValues: Partial<AuditRetention> | null;
  newValues: Partial<AuditRetention> | null;
  changedAt: string;
};

type AuditPruneEvent = {
  at: string;
  removed: number;
  maxEntries: number;
  maxAgeDays: number;
  trigger?: "scheduled" | "manual" | "save";
  triggeredBy?: string | null;
  triggeredByName?: string | null;
  auditEntryId?: string | null;
};
type AuditRetention = { maxEntries: number; maxAgeDays: number };
type AuditRetentionBounds = { maxEntries: { min: number; max: number }; maxAgeDays: { min: number; max: number } };
type AuditPruneTableData = {
  events: AuditPruneEvent[];
  retention: AuditRetention;
  defaults?: AuditRetention;
  bounds?: AuditRetentionBounds;
};
type AuditPruneEventsResponse = {
  adminSettingAudit?: AuditPruneTableData;
  staleLeaseThresholdAudit: AuditPruneTableData;
  queueTimingAudit: AuditPruneTableData;
};

const AUDIT_RETENTION_BOUNDS_FALLBACK: AuditRetentionBounds = {
  maxEntries: { min: 1, max: 1_000_000 },
  maxAgeDays: { min: 1, max: 3650 },
};

const STALE_LEASE_REFRESH_INTERVAL_MS = 10000;

// Throughput comparison windows admins can pick on the Recent Queue Timing
// Changes audit list (Task #723). Keep in sync with the server-side
// QUEUE_TIMING_THROUGHPUT_ALLOWED_WINDOWS_MS allow-list.
const THROUGHPUT_WINDOW_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 5 * 60_000, label: "5m" },
  { value: 10 * 60_000, label: "10m" },
  { value: 30 * 60_000, label: "30m" },
  { value: 60 * 60_000, label: "1h" },
];

const QUEUE_TIMING_DEFAULTS_FALLBACK: QueueTimings = {
  pollIntervalMs: 5_000,
  heartbeatIntervalMs: 60_000,
  baseBackoffMs: 10_000,
  maxBackoffMs: 600_000,
};
const QUEUE_TIMING_BOUNDS_FALLBACK: QueueTimingBounds = {
  pollIntervalMs: { min: 250, max: 5 * 60_000 },
  heartbeatIntervalMs: { min: 5_000, max: 30 * 60_000 },
  baseBackoffMs: { min: 100, max: 60 * 60_000 },
  maxBackoffMs: { min: 1_000, max: 24 * 60 * 60_000 },
};

export function StaleLeaseExhaustionCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";
  const isTabVisible = useTabVisibility();

  const [staleLeaseExpanded, setStaleLeaseExpanded] = useState(false);
  const [highlightedTimingHistoryId, setHighlightedTimingHistoryId] = useState<string | null>(null);
  const [highlightedThresholdHistoryId, setHighlightedThresholdHistoryId] = useState<string | null>(null);
  const [timingCompareIds, setTimingCompareIds] = useState<string[]>([]);
  const [throughputWindowMs, setThroughputWindowMsState] = useState<number>(() => {
    if (typeof window === "undefined") return 10 * 60_000;
    const stored = window.localStorage?.getItem("queueTimingThroughputWindowMs");
    const parsed = stored ? Number(stored) : NaN;
    return THROUGHPUT_WINDOW_OPTIONS.some((o) => o.value === parsed) ? parsed : 10 * 60_000;
  });
  const setThroughputWindowMs = useCallback((value: number) => {
    setThroughputWindowMsState(value);
    if (typeof window !== "undefined") {
      try {
        window.localStorage?.setItem("queueTimingThroughputWindowMs", String(value));
      } catch {
        // ignore storage failures (private mode, quota, etc.)
      }
    }
  }, []);
  const timingHistoryHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thresholdHistoryHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToThresholdHistory = useCallback((entryId?: string) => {
    if (typeof document === "undefined") return;
    const targetId = entryId ? `threshold-history-${entryId}` : "threshold-history";
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-testid="${targetId}"]`)
        ?? document.querySelector(`[data-testid="threshold-history"]`);
      if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
        (el as HTMLElement).scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
      }
    });
    if (entryId) {
      setHighlightedThresholdHistoryId(entryId);
      if (thresholdHistoryHighlightTimeoutRef.current) {
        clearTimeout(thresholdHistoryHighlightTimeoutRef.current);
      }
      thresholdHistoryHighlightTimeoutRef.current = setTimeout(() => {
        setHighlightedThresholdHistoryId(null);
        thresholdHistoryHighlightTimeoutRef.current = null;
      }, 2000);
    }
  }, []);
  useEffect(() => () => {
    if (thresholdHistoryHighlightTimeoutRef.current) {
      clearTimeout(thresholdHistoryHighlightTimeoutRef.current);
    }
  }, []);

  const scrollToTimingHistory = useCallback((entryId?: string) => {
    if (typeof document === "undefined") return;
    const targetId = entryId ? `queue-timing-history-${entryId}` : "queue-timing-history";
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-testid="${targetId}"]`)
        ?? document.querySelector(`[data-testid="queue-timing-history"]`);
      if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
        (el as HTMLElement).scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
      }
    });
    if (entryId) {
      setHighlightedTimingHistoryId(entryId);
      if (timingHistoryHighlightTimeoutRef.current) {
        clearTimeout(timingHistoryHighlightTimeoutRef.current);
      }
      timingHistoryHighlightTimeoutRef.current = setTimeout(() => {
        setHighlightedTimingHistoryId(null);
        timingHistoryHighlightTimeoutRef.current = null;
      }, 2000);
    }
  }, []);
  useEffect(() => () => {
    if (timingHistoryHighlightTimeoutRef.current) {
      clearTimeout(timingHistoryHighlightTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState !== "hidden" && staleLeaseExpanded) {
        void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/status"] }); // fire-and-forget: cache refresh only
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [queryClient, staleLeaseExpanded]);

  const { data: queueStatus, dataUpdatedAt: queueStatusUpdatedAt } = useQuery<QueueStatus>({
    queryKey: ["/api/integrations/work-queue/status"],
    enabled: staleLeaseExpanded,
    refetchInterval: staleLeaseExpanded && isTabVisible ? STALE_LEASE_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  const [staleLeaseNowTick, setStaleLeaseNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!staleLeaseExpanded) return;
    setStaleLeaseNowTick(Date.now());
    const id = setInterval(() => setStaleLeaseNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [staleLeaseExpanded]);

  const staleLeaseSecondsSinceRefresh = queueStatusUpdatedAt
    ? Math.max(0, Math.floor((staleLeaseNowTick - queueStatusUpdatedAt) / 1000))
    : null;
  const staleLeaseSecondsUntilRefresh = queueStatusUpdatedAt
    ? Math.max(0, Math.ceil((queueStatusUpdatedAt + STALE_LEASE_REFRESH_INTERVAL_MS - staleLeaseNowTick) / 1000))
    : null;

  const staleLeaseExhaustionEvents = (queueStatus?.recentDeadLettered ?? []).filter(
    (j) => j.errorMessage === "max_attempts_exhausted_stale_lease"
  );
  const staleLeaseRecoveredCount = Object.entries(queueStatus?.retryDistribution ?? {})
    .filter(([attempts]) => Number(attempts) >= 1)
    .reduce((sum, [, count]) => sum + count, 0);
  const staleLeaseExhaustionCount = staleLeaseExhaustionEvents.length;
  const staleTotalActive = queueStatus?.staleJobs ?? 0;
  const STALE_LEASE_WARNING_THRESHOLD = queueStatus?.staleLeaseThresholds?.staleWarning ?? 3;
  const STALE_LEASE_CRITICAL_THRESHOLD = queueStatus?.staleLeaseThresholds?.staleCritical ?? 10;
  const STALE_EXHAUSTED_WARNING_THRESHOLD = queueStatus?.staleLeaseThresholds?.exhaustedWarning ?? 2;
  const STALE_EXHAUSTED_CRITICAL_THRESHOLD = queueStatus?.staleLeaseThresholds?.exhaustedCritical ?? 5;
  const staleLeaseAlertLevel: "ok" | "warning" | "critical" =
    staleTotalActive >= STALE_LEASE_CRITICAL_THRESHOLD || staleLeaseExhaustionCount >= STALE_EXHAUSTED_CRITICAL_THRESHOLD
      ? "critical"
      : staleTotalActive >= STALE_LEASE_WARNING_THRESHOLD || staleLeaseExhaustionCount >= STALE_EXHAUSTED_WARNING_THRESHOLD
      ? "warning"
      : "ok";

  const [thresholdsEditing, setThresholdsEditing] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState<StaleLeaseThresholds | null>(null);
  const currentThresholds: StaleLeaseThresholds = queueStatus?.staleLeaseThresholds ?? {
    staleWarning: STALE_LEASE_WARNING_THRESHOLD,
    staleCritical: STALE_LEASE_CRITICAL_THRESHOLD,
    exhaustedWarning: STALE_EXHAUSTED_WARNING_THRESHOLD,
    exhaustedCritical: STALE_EXHAUSTED_CRITICAL_THRESHOLD,
    leaseCutoffMs: 300_000,
  };

  const saveThresholdsMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (values: StaleLeaseThresholds) => {
      const res = await apiRequest("PUT", "/api/integrations/work-queue/stale-lease-thresholds", values);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Thresholds updated", description: "Stale lease thresholds saved" });
      setThresholdsEditing(false);
      setThresholdDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/stale-lease-thresholds/history"], refetchType: "all" }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
  });

  const currentQueueTimings: QueueTimings = queueStatus?.queueTimings ?? QUEUE_TIMING_DEFAULTS_FALLBACK;
  const queueTimingDefaults: QueueTimings = queueStatus?.queueTimingDefaults ?? QUEUE_TIMING_DEFAULTS_FALLBACK;
  const queueTimingBounds: QueueTimingBounds = queueStatus?.queueTimingBounds ?? QUEUE_TIMING_BOUNDS_FALLBACK;
  const [queueTimingsEditing, setQueueTimingsEditing] = useState(false);
  const [queueTimingsDraft, setQueueTimingsDraft] = useState<QueueTimings | null>(null);
  const saveQueueTimingsMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (values: QueueTimings) => {
      const res = await apiRequest("PUT", "/api/integrations/work-queue/timings", values);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Queue timings updated", description: "Work queue timing settings saved" });
      setQueueTimingsEditing(false);
      setQueueTimingsDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/timings/history"], refetchType: "all" }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
  });

  const { data: thresholdHistoryData } = useQuery<{ history: ThresholdAuditEntry[] }>({
    queryKey: ["/api/integrations/work-queue/stale-lease-thresholds/history"],
    enabled: staleLeaseExpanded && isAdmin,
    refetchInterval: staleLeaseExpanded && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const thresholdHistory = thresholdHistoryData?.history ?? [];

  const { data: queueTimingHistoryData } = useQuery<{ history: QueueTimingAuditEntry[] }>({
    queryKey: ["/api/integrations/work-queue/timings/history", { windowMs: throughputWindowMs }],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/integrations/work-queue/timings/history?windowMs=${throughputWindowMs}`,
      );
      return res.json();
    },
    enabled: staleLeaseExpanded && isAdmin,
    refetchInterval: staleLeaseExpanded && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const queueTimingHistory = useMemo(
    () => queueTimingHistoryData?.history ?? [],
    [queueTimingHistoryData?.history],
  );

  useEffect(() => {
    if (timingCompareIds.length === 0) return;
    const validIds = new Set(queueTimingHistory.map((e) => e.id));
    const filtered = timingCompareIds.filter((id) => validIds.has(id));
    if (filtered.length !== timingCompareIds.length) {
      setTimingCompareIds(filtered);
    }
  }, [queueTimingHistory, timingCompareIds]);

  const { data: auditPruneData } = useQuery<AuditPruneEventsResponse>({
    queryKey: ["/api/integrations/work-queue/audit-prune-events"],
    enabled: staleLeaseExpanded && isAdmin,
    refetchInterval: staleLeaseExpanded && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const [retentionEditing, setRetentionEditing] = useState<{ stale: boolean; queue: boolean }>({ stale: false, queue: false });
  const [retentionDrafts, setRetentionDrafts] = useState<{ stale: AuditRetention | null; queue: AuditRetention | null }>({ stale: null, queue: null });
  const [retentionHistoryExpanded, setRetentionHistoryExpanded] = useState<{ stale: boolean; queue: boolean }>({ stale: false, queue: false });

  const { data: staleRetentionHistoryData } = useQuery<{ history: RetentionAuditEntry[] }>({
    queryKey: ["/api/integrations/work-queue/audit-prune-events/stale-lease-threshold-audit/retention/history"],
    enabled: staleLeaseExpanded && isAdmin,
    refetchInterval: staleLeaseExpanded && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const { data: queueRetentionHistoryData } = useQuery<{ history: RetentionAuditEntry[] }>({
    queryKey: ["/api/integrations/work-queue/audit-prune-events/queue-timing-audit/retention/history"],
    enabled: staleLeaseExpanded && isAdmin,
    refetchInterval: staleLeaseExpanded && isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const retentionHistoryByKey: Record<"stale" | "queue", RetentionAuditEntry[]> = {
    stale: staleRetentionHistoryData?.history ?? [],
    queue: queueRetentionHistoryData?.history ?? [],
  };

  // Debounced copy of `retentionDrafts` used to drive the read-only prune
  // preview query (Task #1185). 400 ms keeps the UI snappy without slamming
  // the API on every keystroke.
  const [debouncedRetentionDrafts, setDebouncedRetentionDrafts] = useState<{
    stale: AuditRetention | null;
    queue: AuditRetention | null;
  }>({ stale: null, queue: null });
  useEffect(() => {
    const t = setTimeout(() => setDebouncedRetentionDrafts(retentionDrafts), 400);
    return () => clearTimeout(t);
  }, [retentionDrafts]);
  const buildPreviewEnabled = (
    table: "stale" | "queue",
    bounds: AuditRetentionBounds,
  ) => {
    if (!retentionEditing[table]) return false;
    const d = debouncedRetentionDrafts[table];
    if (!d) return false;
    return Number.isInteger(d.maxEntries)
      && d.maxEntries >= bounds.maxEntries.min
      && d.maxEntries <= bounds.maxEntries.max
      && Number.isInteger(d.maxAgeDays)
      && d.maxAgeDays >= bounds.maxAgeDays.min
      && d.maxAgeDays <= bounds.maxAgeDays.max;
  };
  const staleBoundsForPreview = auditPruneData?.staleLeaseThresholdAudit?.bounds ?? AUDIT_RETENTION_BOUNDS_FALLBACK;
  const queueBoundsForPreview = auditPruneData?.queueTimingAudit?.bounds ?? AUDIT_RETENTION_BOUNDS_FALLBACK;
  const stalePreviewDraft = debouncedRetentionDrafts.stale;
  const queuePreviewDraft = debouncedRetentionDrafts.queue;
  const stalePreviewQuery = useQuery<{ wouldRemove: number; total: number }>({
    queryKey: [
      "/api/integrations/work-queue/audit-prune-events/preview",
      "stale",
      stalePreviewDraft?.maxEntries,
      stalePreviewDraft?.maxAgeDays,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        table: "stale",
        maxEntries: String(stalePreviewDraft!.maxEntries),
        maxAgeDays: String(stalePreviewDraft!.maxAgeDays),
      });
      const res = await apiRequest(
        "GET",
        `/api/integrations/work-queue/audit-prune-events/preview?${params.toString()}`,
      );
      return res.json();
    },
    enabled: buildPreviewEnabled("stale", staleBoundsForPreview),
    staleTime: 10_000,
  });
  const queuePreviewQuery = useQuery<{ wouldRemove: number; total: number }>({
    queryKey: [
      "/api/integrations/work-queue/audit-prune-events/preview",
      "queue",
      queuePreviewDraft?.maxEntries,
      queuePreviewDraft?.maxAgeDays,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        table: "queue",
        maxEntries: String(queuePreviewDraft!.maxEntries),
        maxAgeDays: String(queuePreviewDraft!.maxAgeDays),
      });
      const res = await apiRequest(
        "GET",
        `/api/integrations/work-queue/audit-prune-events/preview?${params.toString()}`,
      );
      return res.json();
    },
    enabled: buildPreviewEnabled("queue", queueBoundsForPreview),
    staleTime: 10_000,
  });
  const saveRetentionMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (vars: { table: "stale" | "queue"; values: AuditRetention }) => {
      const path = vars.table === "stale"
        ? "/api/integrations/work-queue/audit-prune-events/stale-lease-threshold-audit/retention"
        : "/api/integrations/work-queue/audit-prune-events/queue-timing-audit/retention";
      const res = await apiRequest("PUT", path, vars.values);
      return { table: vars.table, body: await res.json() };
    },
    onSuccess: ({ table }) => {
      toast({ title: "Audit retention updated", description: table === "stale" ? "Stale lease threshold audit" : "Queue timing audit" });
      setRetentionEditing((s) => ({ ...s, [table]: false }));
      setRetentionDrafts((s) => ({ ...s, [table]: null }));
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/work-queue/audit-prune-events"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: [`/api/integrations/work-queue/audit-prune-events/${table === "stale" ? "stale-lease-threshold-audit" : "queue-timing-audit"}/retention/history`] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Could not update retention", description: err?.message || String(err), variant: "destructive" });
    },
  });

  return (
    <Card className="bg-card" data-testid="card-stale-lease-exhaustion">
      <CardHeader className="pb-3 cursor-pointer" onClick={() => setStaleLeaseExpanded(!staleLeaseExpanded)}>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertCircle className={`w-5 h-5 ${staleLeaseAlertLevel === "critical" ? "text-red-600" : staleLeaseAlertLevel === "warning" ? "text-amber-500" : "text-muted-foreground"}`} />
          Stale Lease Exhaustion
          {staleLeaseAlertLevel === "critical" && (
            <Badge variant="outline" className="ml-2 bg-red-50 text-red-700 border-red-200 animate-pulse" data-testid="badge-stale-lease-critical">Critical</Badge>
          )}
          {staleLeaseAlertLevel === "warning" && (
            <Badge variant="outline" className="ml-2 bg-amber-50 text-amber-700 border-amber-200" data-testid="badge-stale-lease-warning">Warning</Badge>
          )}
          {staleLeaseAlertLevel === "ok" && staleTotalActive === 0 && staleLeaseExhaustionCount === 0 && queueStatus && (
            <Badge variant="outline" className="ml-2 bg-green-50 text-green-700 border-green-200" data-testid="badge-stale-lease-ok">Healthy</Badge>
          )}
          {staleLeaseExpanded && queueStatusUpdatedAt > 0 && (
            <span
              className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground"
              data-testid="text-stale-lease-refresh-countdown"
              title={`Last refreshed ${staleLeaseSecondsSinceRefresh}s ago`}
            >
              <RefreshCw className="w-3 h-3 text-muted-foreground" />
              <span>{isTabVisible ? `Refreshes in ${staleLeaseSecondsUntilRefresh}s` : "Paused (tab hidden)"}</span>
            </span>
          )}
          {staleLeaseExpanded ? <ChevronUp className={`w-4 h-4 text-muted-foreground ${queueStatusUpdatedAt > 0 ? "ml-2" : "ml-auto"}`} /> : <ChevronDown className="w-4 h-4 ml-auto text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      {staleLeaseExpanded && (
        <CardContent className="space-y-4" data-testid="stale-lease-content">
          {!queueStatus ? (
            <InlineLoadingSkeleton />
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className={`rounded-lg px-3 py-2.5 ${staleTotalActive > 0 ? "bg-red-50 border border-red-200" : "bg-muted/50 border border-border"}`} data-testid="metric-stale-active">
                  <div className="text-caption uppercase tracking-wide text-muted-foreground">Currently Stale</div>
                  <div className={`text-2xl font-bold ${staleTotalActive > 0 ? "text-red-700" : "text-foreground"}`}>{staleTotalActive}</div>
                  <div className="text-caption text-muted-foreground">jobs past lease expiry</div>
                </div>
                <div className={`rounded-lg px-3 py-2.5 ${staleLeaseExhaustionCount > 0 ? "bg-red-50 border border-red-200" : "bg-muted/50 border border-border"}`} data-testid="metric-stale-exhausted">
                  <div className="text-caption uppercase tracking-wide text-muted-foreground">Exhausted (1h)</div>
                  <div className={`text-2xl font-bold ${staleLeaseExhaustionCount > 0 ? "text-red-700" : "text-foreground"}`}>{staleLeaseExhaustionCount}</div>
                  <div className="text-caption text-muted-foreground">permanently failed</div>
                </div>
                <div className="rounded-lg px-3 py-2.5 bg-muted/50 border border-border" data-testid="metric-stale-recovered">
                  <div className="text-caption uppercase tracking-wide text-muted-foreground">With Retries</div>
                  <div className="text-2xl font-bold text-foreground">{staleLeaseRecoveredCount}</div>
                  <div className="text-caption text-muted-foreground">jobs with 1+ attempts</div>
                </div>
                <div className="rounded-lg px-3 py-2.5 bg-muted/50 border border-border" data-testid="metric-avg-lease-duration">
                  <div className="text-caption uppercase tracking-wide text-muted-foreground">Avg Lease Duration</div>
                  <div className="text-2xl font-bold text-foreground">
                    {queueStatus.averageLeaseDurationMs !== null
                      ? queueStatus.averageLeaseDurationMs > 60000
                        ? `${(queueStatus.averageLeaseDurationMs / 60000).toFixed(1)}m`
                        : `${(queueStatus.averageLeaseDurationMs / 1000).toFixed(1)}s`
                      : "—"}
                  </div>
                  <div className="text-caption text-muted-foreground">completed jobs (1h)</div>
                </div>
              </div>

              {staleLeaseAlertLevel !== "ok" && (
                <div className={`rounded-lg px-3 py-2 flex items-start gap-2 text-sm ${staleLeaseAlertLevel === "critical" ? "bg-red-50 border border-red-200 text-red-800" : "bg-amber-50 border border-amber-200 text-amber-800"}`} data-testid="stale-lease-alert-banner">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <div>
                    {staleLeaseAlertLevel === "critical"
                      ? `Critical: ${staleTotalActive} stale job(s) detected with ${staleLeaseExhaustionCount} permanently failed. Jobs are getting stuck and exhausting retries.`
                      : `Warning: ${staleTotalActive} stale job(s) detected. Monitor closely — jobs may be approaching retry exhaustion.`}
                  </div>
                </div>
              )}

              <div>
                <h4 className="text-sm font-semibold text-foreground mb-2">Threshold Status</h4>
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-28">Stale Jobs</span>
                    <div className="flex-1">
                      <Progress
                        value={Math.min((staleTotalActive / STALE_LEASE_CRITICAL_THRESHOLD) * 100, 100)}
                        className="h-2"
                      />
                    </div>
                    <span className={`text-xs font-medium w-16 text-right ${staleTotalActive >= STALE_LEASE_CRITICAL_THRESHOLD ? "text-red-700" : staleTotalActive >= STALE_LEASE_WARNING_THRESHOLD ? "text-amber-600" : "text-muted-foreground"}`} data-testid="threshold-stale-jobs">
                      {staleTotalActive} / {STALE_LEASE_CRITICAL_THRESHOLD}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-28">Exhausted (1h)</span>
                    <div className="flex-1">
                      <Progress
                        value={Math.min((staleLeaseExhaustionCount / STALE_EXHAUSTED_CRITICAL_THRESHOLD) * 100, 100)}
                        className="h-2"
                      />
                    </div>
                    <span className={`text-xs font-medium w-16 text-right ${staleLeaseExhaustionCount >= STALE_EXHAUSTED_CRITICAL_THRESHOLD ? "text-red-700" : staleLeaseExhaustionCount >= STALE_EXHAUSTED_WARNING_THRESHOLD ? "text-amber-600" : "text-muted-foreground"}`} data-testid="threshold-exhausted">
                      {staleLeaseExhaustionCount} / {STALE_EXHAUSTED_CRITICAL_THRESHOLD}
                    </span>
                  </div>
                </div>
              </div>

              {isAdmin && queueTimingHistory.length > 0 && (
                <div className="border-t pt-3" data-testid="queue-timing-history-compact">
                  <div className="flex items-center justify-between mb-1.5">
                    <h4 className="text-sm font-semibold text-foreground">Recent Timing Changes</h4>
                    <div className="flex items-center gap-2">
                      <span className="text-caption text-muted-foreground">Edits often correlate with throughput shifts</span>
                      <button
                        type="button"
                        onClick={() => scrollToTimingHistory()}
                        className="text-caption font-medium text-blue-600 hover:text-blue-800 hover:underline"
                        data-testid="link-queue-timing-history-view-all"
                      >
                        View all →
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {queueTimingHistory.slice(0, 3).map((entry) => {
                      const who = formatEditorAttribution(entry);
                      const fmtSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;
                      const fmtPair = (key: keyof QueueTimings, label: string) => {
                        const oldV = entry.oldValues?.[key];
                        const newV = entry.newValues[key];
                        if (oldV === undefined || oldV === newV) return null;
                        return (
                          <span key={key} className="inline-flex items-center gap-1 mr-2">
                            <span className="text-muted-foreground">{label}:</span>
                            <span className="text-foreground line-through">{fmtSeconds(oldV)}</span>
                            <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                            <span className="font-semibold text-foreground">{fmtSeconds(newV)}</span>
                          </span>
                        );
                      };
                      const diffs = [
                        fmtPair("pollIntervalMs", "Poll"),
                        fmtPair("heartbeatIntervalMs", "Heartbeat"),
                        fmtPair("baseBackoffMs", "Base backoff"),
                        fmtPair("maxBackoffMs", "Max backoff"),
                      ].filter(Boolean);
                      return (
                        <div
                          key={entry.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => scrollToTimingHistory(entry.id)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); scrollToTimingHistory(entry.id); } }}
                          className="bg-muted/50 hover:bg-muted cursor-pointer rounded px-2.5 py-1.5 text-caption focus:outline-none focus:ring-2 focus:ring-blue-300"
                          title="Jump to full audit details"
                          data-testid={`queue-timing-history-compact-${entry.id}`}
                        >
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="font-medium text-foreground" data-testid={`text-qt-history-compact-user-${entry.id}`}>{who}</span>
                            <span className="text-muted-foreground" data-testid={`text-qt-history-compact-time-${entry.id}`}>{new Date(entry.changedAt).toLocaleString()}</span>
                          </div>
                          <div className="flex flex-wrap gap-y-0.5">
                            {diffs.length > 0 ? diffs : <span className="text-muted-foreground">No effective changes</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {isAdmin && (
                <div className="border-t pt-3" data-testid="stale-lease-threshold-config">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm font-semibold text-foreground">Alert Thresholds</h4>
                      <LastEditedBadge
                        info={queueStatus?.staleLeaseThresholdsLastEdited}
                        testId="badge-last-edited-stale-lease-thresholds"
                      />
                    </div>
                    {!thresholdsEditing ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setThresholdDraft({ ...currentThresholds });
                          setThresholdsEditing(true);
                        }}
                        data-testid="button-edit-thresholds"
                      >
                        Edit
                      </Button>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setThresholdsEditing(false); setThresholdDraft(null); }}
                          data-testid="button-cancel-thresholds"
                        >
                          Cancel
                        </Button>
                        {(() => {
                          const d = thresholdDraft;
                          const isValid = !!d
                            && [d.staleWarning, d.staleCritical, d.exhaustedWarning, d.exhaustedCritical]
                              .every((n) => Number.isInteger(n) && n > 0)
                            && d.staleCritical >= d.staleWarning
                            && d.exhaustedCritical >= d.exhaustedWarning
                            && Number.isInteger(d.leaseCutoffMs)
                            && d.leaseCutoffMs >= 1000
                            && d.leaseCutoffMs <= 24 * 60 * 60 * 1000;
                          return (
                            <Button
                              size="sm"
                              onClick={() => isValid && d && saveThresholdsMutation.mutate(d)}
                              disabled={saveThresholdsMutation.isPending || !isValid}
                              data-testid="button-save-thresholds"
                            >
                              {saveThresholdsMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                            </Button>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  {!thresholdsEditing ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-muted-foreground">
                      <div>Stale warn: <span className="font-semibold" data-testid="text-threshold-stale-warning">{currentThresholds.staleWarning}</span></div>
                      <div>Stale critical: <span className="font-semibold" data-testid="text-threshold-stale-critical">{currentThresholds.staleCritical}</span></div>
                      <div>Exhausted warn: <span className="font-semibold" data-testid="text-threshold-exhausted-warning">{currentThresholds.exhaustedWarning}</span></div>
                      <div>Exhausted critical: <span className="font-semibold" data-testid="text-threshold-exhausted-critical">{currentThresholds.exhaustedCritical}</span></div>
                      <div className="col-span-2 sm:col-span-4">Lease cutoff: <span className="font-semibold" data-testid="text-threshold-lease-cutoff">{Math.round(currentThresholds.leaseCutoffMs / 1000)}s</span> <span className="text-muted-foreground">(jobs leased longer than this are considered stale)</span></div>
                    </div>
                  ) : thresholdDraft && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <Label className="text-xs">Stale warn</Label>
                        <Input
                          type="number"
                          min={1}
                          value={thresholdDraft.staleWarning}
                          onChange={(e) => setThresholdDraft({ ...thresholdDraft, staleWarning: Number(e.target.value) })}
                          data-testid="input-threshold-stale-warning"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Stale critical</Label>
                        <Input
                          type="number"
                          min={1}
                          value={thresholdDraft.staleCritical}
                          onChange={(e) => setThresholdDraft({ ...thresholdDraft, staleCritical: Number(e.target.value) })}
                          data-testid="input-threshold-stale-critical"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Exhausted warn</Label>
                        <Input
                          type="number"
                          min={1}
                          value={thresholdDraft.exhaustedWarning}
                          onChange={(e) => setThresholdDraft({ ...thresholdDraft, exhaustedWarning: Number(e.target.value) })}
                          data-testid="input-threshold-exhausted-warning"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Exhausted critical</Label>
                        <Input
                          type="number"
                          min={1}
                          value={thresholdDraft.exhaustedCritical}
                          onChange={(e) => setThresholdDraft({ ...thresholdDraft, exhaustedCritical: Number(e.target.value) })}
                          data-testid="input-threshold-exhausted-critical"
                        />
                      </div>
                      <div className="col-span-2 sm:col-span-4">
                        <Label className="text-xs">Lease cutoff (seconds)</Label>
                        <Input
                          type="number"
                          min={1}
                          max={86400}
                          value={Math.round(thresholdDraft.leaseCutoffMs / 1000)}
                          onChange={(e) => setThresholdDraft({ ...thresholdDraft, leaseCutoffMs: Math.round(Number(e.target.value) * 1000) })}
                          data-testid="input-threshold-lease-cutoff"
                        />
                        <div className="text-caption text-muted-foreground mt-1">
                          How long a job can hold a lease (with heartbeats) before being considered stale. Default 300s (5 min).
                        </div>
                      </div>
                      <div className="col-span-full text-caption text-muted-foreground">
                        Critical must be ≥ warning. Counts must be positive integers. Lease cutoff must be 1–86400 seconds.
                      </div>
                    </div>
                  )}

                  <div className="mt-3 border-t pt-3" data-testid="threshold-history">
                    <h5 className="text-xs font-semibold text-foreground mb-1.5">Recent Threshold Changes</h5>
                    {thresholdHistory.length === 0 ? (
                      <div className="text-caption text-muted-foreground" data-testid="text-threshold-history-empty">No changes recorded yet.</div>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {thresholdHistory.map((entry) => {
                          const who = formatEditorAttribution(entry);
                          const fmtPair = (key: keyof StaleLeaseThresholds, label: string) => {
                            const oldV = entry.oldValues?.[key];
                            const newV = entry.newValues[key];
                            if (oldV === undefined || oldV === newV) return null;
                            return (
                              <span key={key} className="inline-flex items-center gap-1 mr-2">
                                <span className="text-muted-foreground">{label}:</span>
                                <span className="text-foreground line-through">{oldV}</span>
                                <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                                <span className="font-semibold text-foreground">{newV}</span>
                              </span>
                            );
                          };
                          const diffs = [
                            fmtPair("staleWarning", "Stale warn"),
                            fmtPair("staleCritical", "Stale crit"),
                            fmtPair("exhaustedWarning", "Exh warn"),
                            fmtPair("exhaustedCritical", "Exh crit"),
                          ].filter(Boolean);
                          return (
                            <div key={entry.id} className={`rounded px-2.5 py-1.5 text-caption transition-colors ${highlightedThresholdHistoryId === entry.id ? "bg-amber-100 ring-2 ring-amber-300" : "bg-muted/50"}`} data-testid={`threshold-history-${entry.id}`}>
                              <div className="flex items-center justify-between mb-0.5">
                                <span className="font-medium text-foreground" data-testid={`text-history-user-${entry.id}`}>{who}</span>
                                <span className="text-muted-foreground" data-testid={`text-history-time-${entry.id}`}>{new Date(entry.changedAt).toLocaleString()}</span>
                              </div>
                              <div className="flex flex-wrap gap-y-0.5">
                                {diffs.length > 0 ? diffs : <span className="text-muted-foreground">No effective changes</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {isAdmin && (
                <div className="border-t pt-3" data-testid="queue-timings-config">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-foreground">Queue Timings</h4>
                      <LastEditedBadge
                        info={queueStatus?.queueTimingsLastEdited}
                        testId="badge-last-edited-queue-timings"
                      />
                    </div>
                    {!queueTimingsEditing ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setQueueTimingsDraft({ ...currentQueueTimings });
                          setQueueTimingsEditing(true);
                        }}
                        data-testid="button-edit-queue-timings"
                      >
                        Edit
                      </Button>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setQueueTimingsEditing(false); setQueueTimingsDraft(null); }}
                          data-testid="button-cancel-queue-timings"
                        >
                          Cancel
                        </Button>
                        {(() => {
                          const d = queueTimingsDraft;
                          const inRange = (k: keyof QueueTimings) => {
                            if (!d) return false;
                            const v = d[k];
                            const { min, max } = queueTimingBounds[k];
                            return Number.isInteger(v) && v >= min && v <= max;
                          };
                          const isValid = !!d
                            && inRange("pollIntervalMs")
                            && inRange("heartbeatIntervalMs")
                            && inRange("baseBackoffMs")
                            && inRange("maxBackoffMs")
                            && d.maxBackoffMs >= d.baseBackoffMs;
                          return (
                            <Button
                              size="sm"
                              onClick={() => isValid && d && saveQueueTimingsMutation.mutate(d)}
                              disabled={saveQueueTimingsMutation.isPending || !isValid}
                              data-testid="button-save-queue-timings"
                            >
                              {saveQueueTimingsMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                            </Button>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  {!queueTimingsEditing ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-muted-foreground">
                      <div>Poll interval: <span className="font-semibold" data-testid="text-queue-timing-poll">{Math.round(currentQueueTimings.pollIntervalMs / 1000)}s</span></div>
                      <div>Heartbeat: <span className="font-semibold" data-testid="text-queue-timing-heartbeat">{Math.round(currentQueueTimings.heartbeatIntervalMs / 1000)}s</span></div>
                      <div>Base backoff: <span className="font-semibold" data-testid="text-queue-timing-base-backoff">{Math.round(currentQueueTimings.baseBackoffMs / 1000)}s</span></div>
                      <div>Max backoff: <span className="font-semibold" data-testid="text-queue-timing-max-backoff">{Math.round(currentQueueTimings.maxBackoffMs / 1000)}s</span></div>
                      <div className="col-span-full text-caption text-muted-foreground">
                        Defaults: poll {Math.round(queueTimingDefaults.pollIntervalMs / 1000)}s · heartbeat {Math.round(queueTimingDefaults.heartbeatIntervalMs / 1000)}s · base backoff {Math.round(queueTimingDefaults.baseBackoffMs / 1000)}s · max backoff {Math.round(queueTimingDefaults.maxBackoffMs / 1000)}s. Changes apply within ~30 seconds (cache TTL).
                      </div>
                    </div>
                  ) : queueTimingsDraft && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <Label className="text-xs">Poll interval (seconds)</Label>
                        <Input
                          type="number"
                          min={Math.max(1, Math.ceil(queueTimingBounds.pollIntervalMs.min / 1000))}
                          max={Math.floor(queueTimingBounds.pollIntervalMs.max / 1000)}
                          value={Math.round(queueTimingsDraft.pollIntervalMs / 1000)}
                          onChange={(e) => setQueueTimingsDraft({ ...queueTimingsDraft, pollIntervalMs: Math.round(Number(e.target.value) * 1000) })}
                          data-testid="input-queue-timing-poll"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Heartbeat (seconds)</Label>
                        <Input
                          type="number"
                          min={Math.ceil(queueTimingBounds.heartbeatIntervalMs.min / 1000)}
                          max={Math.floor(queueTimingBounds.heartbeatIntervalMs.max / 1000)}
                          value={Math.round(queueTimingsDraft.heartbeatIntervalMs / 1000)}
                          onChange={(e) => setQueueTimingsDraft({ ...queueTimingsDraft, heartbeatIntervalMs: Math.round(Number(e.target.value) * 1000) })}
                          data-testid="input-queue-timing-heartbeat"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Base backoff (seconds)</Label>
                        <Input
                          type="number"
                          min={Math.max(1, Math.ceil(queueTimingBounds.baseBackoffMs.min / 1000))}
                          max={Math.floor(queueTimingBounds.baseBackoffMs.max / 1000)}
                          value={Math.round(queueTimingsDraft.baseBackoffMs / 1000)}
                          onChange={(e) => setQueueTimingsDraft({ ...queueTimingsDraft, baseBackoffMs: Math.round(Number(e.target.value) * 1000) })}
                          data-testid="input-queue-timing-base-backoff"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Max backoff (seconds)</Label>
                        <Input
                          type="number"
                          min={Math.ceil(queueTimingBounds.maxBackoffMs.min / 1000)}
                          max={Math.floor(queueTimingBounds.maxBackoffMs.max / 1000)}
                          value={Math.round(queueTimingsDraft.maxBackoffMs / 1000)}
                          onChange={(e) => setQueueTimingsDraft({ ...queueTimingsDraft, maxBackoffMs: Math.round(Number(e.target.value) * 1000) })}
                          data-testid="input-queue-timing-max-backoff"
                        />
                      </div>
                      <div className="col-span-full text-caption text-muted-foreground">
                        Heartbeat should be well below the lease cutoff. Max backoff must be ≥ base backoff. Changes apply within ~30 seconds.
                      </div>
                    </div>
                  )}

                  <div className="mt-3 border-t pt-3" data-testid="queue-timing-history">
                    <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
                      <h5 className="text-xs font-semibold text-foreground">Recent Queue Timing Changes</h5>
                      <div className="flex items-center gap-3 flex-wrap">
                        <div
                          className="flex items-center gap-1"
                          data-testid="group-queue-timing-throughput-window"
                        >
                          <span className="text-caption text-muted-foreground">Throughput window:</span>
                          <div className="inline-flex rounded border border-border overflow-hidden">
                            {THROUGHPUT_WINDOW_OPTIONS.map((opt) => {
                              const active = opt.value === throughputWindowMs;
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => setThroughputWindowMs(opt.value)}
                                  aria-pressed={active}
                                  className={`px-1.5 py-0.5 text-caption font-medium transition-colors ${active ? "bg-blue-600 text-white" : "bg-card text-foreground hover:bg-muted/50"}`}
                                  data-testid={`button-queue-timing-window-${opt.label}`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        {queueTimingHistory.length > 0 && (
                          <span className="text-caption text-muted-foreground" data-testid="text-queue-timing-compare-hint">
                            Select two to compare ({timingCompareIds.length}/2)
                            {timingCompareIds.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setTimingCompareIds([])}
                                className="ml-2 text-blue-600 hover:text-blue-800 hover:underline"
                                data-testid="button-queue-timing-compare-clear"
                              >
                                Clear
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    {queueTimingHistory.length === 0 ? (
                      <div className="text-caption text-muted-foreground" data-testid="text-queue-timing-history-empty">No changes recorded yet.</div>
                    ) : (
                      <>
                        {timingCompareIds.length === 2 && (() => {
                          const selected = timingCompareIds
                            .map((id) => queueTimingHistory.find((e) => e.id === id))
                            .filter((e): e is QueueTimingAuditEntry => !!e)
                            .sort((a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime());
                          if (selected.length !== 2) return null;
                          const [older, newer] = selected;
                          const fmtSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;
                          const fields: Array<{ key: keyof QueueTimings; label: string }> = [
                            { key: "pollIntervalMs", label: "Poll" },
                            { key: "heartbeatIntervalMs", label: "Heartbeat" },
                            { key: "baseBackoffMs", label: "Base backoff" },
                            { key: "maxBackoffMs", label: "Max backoff" },
                          ];
                          const rows = fields.map(({ key, label }) => {
                            const a = older.newValues[key];
                            const b = newer.newValues[key];
                            return { key, label, a, b, changed: a !== b };
                          });
                          const whoOf = (e: QueueTimingAuditEntry) => formatEditorAttribution(e);
                          const handleCopyComparison = async () => {
                            const lines: string[] = [];
                            lines.push("Queue timing comparison");
                            lines.push(
                              `${new Date(older.changedAt).toLocaleString()} (${whoOf(older)}) → ${new Date(newer.changedAt).toLocaleString()} (${whoOf(newer)})`
                            );
                            lines.push("");
                            for (const { label, a, b, changed } of rows) {
                              lines.push(
                                changed
                                  ? `${label}: ${fmtSeconds(a)} → ${fmtSeconds(b)}`
                                  : `${label}: ${fmtSeconds(a)} (unchanged)`
                              );
                            }
                            if (rows.every((r) => !r.changed)) {
                              lines.push("");
                              lines.push("No differences between the selected entries.");
                            }
                            const text = lines.join("\n");
                            try {
                              await navigator.clipboard.writeText(text);
                              toast({ title: "Comparison copied", description: "Plain-text summary copied to your clipboard." });
                            } catch {
                              toast({
                                title: "Copy failed",
                                description: "Could not access the clipboard. Please copy manually.",
                                variant: "destructive",
                              });
                            }
                          };
                          return (
                            <div
                              className="mb-2 rounded border border-blue-200 bg-blue-50 p-2.5"
                              data-testid="panel-queue-timing-compare"
                            >
                              <div className="flex items-center justify-between mb-1.5 gap-2">
                                <span className="text-caption font-semibold text-blue-900">Comparison</span>
                                <div className="flex items-center gap-2">
                                  <span className="text-caption text-blue-800" data-testid="text-queue-timing-compare-range">
                                    {new Date(older.changedAt).toLocaleString()} → {new Date(newer.changedAt).toLocaleString()}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={handleCopyComparison}
                                    className="inline-flex items-center gap-1 rounded border border-blue-300 bg-card px-1.5 py-0.5 text-caption font-medium text-blue-800 hover:bg-blue-100"
                                    data-testid="button-queue-timing-compare-copy"
                                    title="Copy comparison as plain text"
                                  >
                                    <Copy className="w-2.5 h-2.5" />
                                    Copy
                                  </button>
                                </div>
                              </div>
                              <div className="space-y-0.5">
                                {rows.map(({ key, label, a, b, changed }) => (
                                  <div
                                    key={key}
                                    className="flex items-center text-caption"
                                    data-testid={`row-queue-timing-compare-${key}`}
                                  >
                                    <span className="w-24 text-muted-foreground">{label}:</span>
                                    {changed ? (
                                      <span className="inline-flex items-center gap-1">
                                        <span className="text-foreground line-through">{fmtSeconds(a)}</span>
                                        <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                                        <span className="font-semibold text-foreground">{fmtSeconds(b)}</span>
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground">{fmtSeconds(a)} (unchanged)</span>
                                    )}
                                  </div>
                                ))}
                                {rows.every((r) => !r.changed) && (
                                  <div className="text-caption text-muted-foreground" data-testid="text-queue-timing-compare-no-diff">
                                    No differences between the selected entries.
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {queueTimingHistory.map((entry) => {
                          const who = formatEditorAttribution(entry);
                          const fmtSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;
                          const fmtPair = (key: keyof QueueTimings, label: string) => {
                            const oldV = entry.oldValues?.[key];
                            const newV = entry.newValues[key];
                            if (oldV === undefined || oldV === newV) return null;
                            return (
                              <span key={key} className="inline-flex items-center gap-1 mr-2">
                                <span className="text-muted-foreground">{label}:</span>
                                <span className="text-foreground line-through">{fmtSeconds(oldV)}</span>
                                <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
                                <span className="font-semibold text-foreground">{fmtSeconds(newV)}</span>
                              </span>
                            );
                          };
                          const diffs = [
                            fmtPair("pollIntervalMs", "Poll"),
                            fmtPair("heartbeatIntervalMs", "Heartbeat"),
                            fmtPair("baseBackoffMs", "Base backoff"),
                            fmtPair("maxBackoffMs", "Max backoff"),
                          ].filter(Boolean);
                          const isSelected = timingCompareIds.includes(entry.id);
                          const toggleSelected = () => {
                            setTimingCompareIds((prev) => {
                              if (prev.includes(entry.id)) {
                                return prev.filter((id) => id !== entry.id);
                              }
                              if (prev.length >= 2) {
                                return [prev[1], entry.id];
                              }
                              return [...prev, entry.id];
                            });
                          };
                          return (
                            <div
                              key={entry.id}
                              className={`rounded px-2.5 py-1.5 text-caption transition-colors ${highlightedTimingHistoryId === entry.id ? "bg-amber-100 ring-2 ring-amber-300" : isSelected ? "bg-blue-50 ring-1 ring-blue-300" : "bg-muted/50"}`}
                              data-testid={`queue-timing-history-${entry.id}`}
                            >
                              <div className="flex items-center justify-between mb-0.5 gap-2">
                                <label className="flex items-center gap-1.5 cursor-pointer min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={toggleSelected}
                                    className="h-3 w-3"
                                    aria-label={`Select entry from ${who} for comparison`}
                                    data-testid={`checkbox-queue-timing-compare-${entry.id}`}
                                  />
                                  <span className="font-medium text-foreground truncate" data-testid={`text-qt-history-user-${entry.id}`}>{who}</span>
                                </label>
                                <span className="text-muted-foreground shrink-0" data-testid={`text-qt-history-time-${entry.id}`}>{new Date(entry.changedAt).toLocaleString()}</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-y-0.5">
                                {diffs.length > 0 ? diffs : <span className="text-muted-foreground">No effective changes</span>}
                                {(() => {
                                  const tp = entry.throughput;
                                  if (!tp) return null;
                                  const windowMin = Math.round(tp.windowMs / 60000);
                                  if (tp.status === "pending") {
                                    return (
                                      <span
                                        className="ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium bg-muted text-muted-foreground border border-border"
                                        title={`Waiting for ${windowMin} minutes of post-change data to compare against the prior ${windowMin}-minute window.`}
                                        data-testid={`badge-qt-throughput-${entry.id}`}
                                      >
                                        Throughput: pending
                                      </span>
                                    );
                                  }
                                  if (tp.status === "no_baseline") {
                                    return (
                                      <span
                                        className="ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium bg-muted text-muted-foreground border border-border"
                                        title={`No completed jobs in the ${windowMin} minutes before this change (after: ${tp.after ?? 0}). Cannot compute a percentage.`}
                                        data-testid={`badge-qt-throughput-${entry.id}`}
                                      >
                                        Throughput: n/a
                                      </span>
                                    );
                                  }
                                  const before = tp.before ?? 0;
                                  const after = tp.after ?? 0;
                                  const pct = before > 0 ? Math.round(((after - before) / before) * 100) : 0;
                                  const positive = pct > 0;
                                  const negative = pct < 0;
                                  const cls = positive
                                    ? "bg-green-50 text-green-700 border-green-200"
                                    : negative
                                      ? "bg-red-50 text-red-700 border-red-200"
                                      : "bg-muted text-muted-foreground border-border";
                                  const sign = pct > 0 ? "+" : "";
                                  return (
                                    <span
                                      className={`ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium border ${cls}`}
                                      title={`Completed jobs in the ${windowMin} min after this change: ${after}. Prior ${windowMin} min: ${before}. Change: ${sign}${pct}%.`}
                                      data-testid={`badge-qt-throughput-${entry.id}`}
                                    >
                                      Throughput {sign}{pct}% ({windowMin}m)
                                    </span>
                                  );
                                })()}
                              </div>
                            </div>
                          );
                        })}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {isAdmin && auditPruneData && (
                <div data-testid="audit-prune-events">
                  <h4 className="text-sm font-semibold text-foreground mb-2">Audit Table Pruning</h4>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {([
                      ...(auditPruneData.adminSettingAudit
                        ? [{
                            key: "admin" as const,
                            label: "Admin Setting Audit",
                            data: auditPruneData.adminSettingAudit,
                            testId: "admin-setting-audit",
                          }]
                        : []),
                      {
                        key: "stale" as const,
                        label: "Stale Lease Threshold Audit",
                        data: auditPruneData.staleLeaseThresholdAudit,
                        testId: "stale-lease-threshold-audit",
                      },
                      {
                        key: "queue" as const,
                        label: "Queue Timing Audit",
                        data: auditPruneData.queueTimingAudit,
                        testId: "queue-timing-audit",
                      },
                    ]).map(({ key, label, data, testId }) => {
                      const events = data.events ?? [];
                      const totalRemoved = events.reduce((sum, e) => sum + (e.removed || 0), 0);
                      const lastEvent = events[0];
                      const bounds = data.bounds ?? AUDIT_RETENTION_BOUNDS_FALLBACK;
                      const defaults = data.defaults ?? data.retention;
                      const editableKey: "stale" | "queue" | null =
                        key === "stale" || key === "queue" ? key : null;
                      const editing = editableKey ? retentionEditing[editableKey] : false;
                      const draft = editableKey ? retentionDrafts[editableKey] : null;
                      const draftValid = !!draft
                        && Number.isInteger(draft.maxEntries)
                        && draft.maxEntries >= bounds.maxEntries.min
                        && draft.maxEntries <= bounds.maxEntries.max
                        && Number.isInteger(draft.maxAgeDays)
                        && draft.maxAgeDays >= bounds.maxAgeDays.min
                        && draft.maxAgeDays <= bounds.maxAgeDays.max;
                      const isDefault = data.retention.maxEntries === defaults.maxEntries
                        && data.retention.maxAgeDays === defaults.maxAgeDays;
                      const startEdit = () => {
                        if (!editableKey) return;
                        setRetentionDrafts((s) => ({ ...s, [editableKey]: { ...data.retention } }));
                        setRetentionEditing((s) => ({ ...s, [editableKey]: true }));
                      };
                      const cancelEdit = () => {
                        if (!editableKey) return;
                        setRetentionDrafts((s) => ({ ...s, [editableKey]: null }));
                        setRetentionEditing((s) => ({ ...s, [editableKey]: false }));
                      };
                      const resetToDefaults = () => {
                        if (!editableKey) return;
                        setRetentionDrafts((s) => ({ ...s, [editableKey]: { ...defaults } }));
                      };
                      const renderRetentionLabel = () => data.retention.maxEntries > 0
                        ? `Keep last ${data.retention.maxEntries} / ${data.retention.maxAgeDays}d`
                        : `Keep last ${data.retention.maxAgeDays}d`;
                      const previewQuery = editableKey === "stale"
                        ? stalePreviewQuery
                        : editableKey === "queue"
                        ? queuePreviewQuery
                        : null;
                      const debouncedDraftForKey = editableKey ? debouncedRetentionDrafts[editableKey] : null;
                      const draftMatchesDebounced = !!draft && !!debouncedDraftForKey
                        && draft.maxEntries === debouncedDraftForKey.maxEntries
                        && draft.maxAgeDays === debouncedDraftForKey.maxAgeDays;
                      return (
                        <div key={key} className="bg-muted/50 rounded p-2.5 border border-border" data-testid={`prune-events-${testId}`}>
                          <div className="flex items-center justify-between mb-1.5 gap-2">
                            <span className="text-xs font-semibold text-foreground">{label}</span>
                            <div className="flex items-center gap-2">
                              {!editing && (
                                <span className="text-caption text-muted-foreground" data-testid={`text-prune-retention-${testId}`}>
                                  {renderRetentionLabel()}
                                  {editableKey && !isDefault && <span className="ml-1 text-caption text-amber-600" title={`Defaults: ${defaults.maxEntries} / ${defaults.maxAgeDays}d`}>(custom)</span>}
                                </span>
                              )}
                              {editableKey && (!editing ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-caption"
                                  onClick={startEdit}
                                  data-testid={`button-edit-retention-${testId}`}
                                >
                                  Edit
                                </Button>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-caption"
                                    onClick={resetToDefaults}
                                    data-testid={`button-reset-retention-${testId}`}
                                    title={`Reset to defaults (${defaults.maxEntries} / ${defaults.maxAgeDays}d)`}
                                  >
                                    Defaults
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-caption"
                                    onClick={cancelEdit}
                                    data-testid={`button-cancel-retention-${testId}`}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="h-6 px-2 text-caption"
                                    onClick={() => draft && draftValid && saveRetentionMutation.mutate({ table: editableKey, values: draft })}
                                    disabled={!draftValid || saveRetentionMutation.isPending}
                                    data-testid={`button-save-retention-${testId}`}
                                  >
                                    {saveRetentionMutation.isPending && saveRetentionMutation.variables?.table === editableKey
                                      ? <Loader2 className="w-3 h-3 animate-spin" />
                                      : "Save"}
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                          {editing && draft && (
                            <div className="grid grid-cols-2 gap-2 mb-2 bg-card rounded border border-border p-2" data-testid={`retention-editor-${testId}`}>
                              <div>
                                <Label className="text-caption text-muted-foreground">Max entries ({bounds.maxEntries.min}–{bounds.maxEntries.max.toLocaleString()})</Label>
                                <Input
                                  type="number"
                                  min={bounds.maxEntries.min}
                                  max={bounds.maxEntries.max}
                                  step={1}
                                  value={Number.isFinite(draft.maxEntries) ? draft.maxEntries : ""}
                                  onChange={(e) => setRetentionDrafts((s) => ({ ...s, [key]: { ...draft, maxEntries: Math.floor(Number(e.target.value)) } }))}
                                  className="h-7 text-xs"
                                  data-testid={`input-retention-max-entries-${testId}`}
                                />
                              </div>
                              <div>
                                <Label className="text-caption text-muted-foreground">Max age (days, {bounds.maxAgeDays.min}–{bounds.maxAgeDays.max})</Label>
                                <Input
                                  type="number"
                                  min={bounds.maxAgeDays.min}
                                  max={bounds.maxAgeDays.max}
                                  step={1}
                                  value={Number.isFinite(draft.maxAgeDays) ? draft.maxAgeDays : ""}
                                  onChange={(e) => setRetentionDrafts((s) => ({ ...s, [key]: { ...draft, maxAgeDays: Math.floor(Number(e.target.value)) } }))}
                                  className="h-7 text-xs"
                                  data-testid={`input-retention-max-age-days-${testId}`}
                                />
                              </div>
                              {previewQuery && (
                                <div
                                  className="col-span-2 text-caption"
                                  data-testid={`text-retention-preview-${testId}`}
                                >
                                  {!draftValid ? (
                                    <span className="text-muted-foreground">Enter values within the allowed range to see the prune preview.</span>
                                  ) : !draftMatchesDebounced || previewQuery.isFetching ? (
                                    <span className="text-muted-foreground inline-flex items-center gap-1">
                                      <Loader2 className="w-3 h-3 animate-spin" /> Estimating impact…
                                    </span>
                                  ) : previewQuery.isError ? (
                                    <span className="text-amber-600">Could not estimate impact ({previewQuery.error instanceof Error ? previewQuery.error.message : "request failed"}).</span>
                                  ) : previewQuery.data ? (
                                    previewQuery.data.wouldRemove > 0 ? (
                                      <span className="text-amber-700 font-medium">
                                        Saving will drop ~{previewQuery.data.wouldRemove.toLocaleString()} of {previewQuery.data.total.toLocaleString()} row{previewQuery.data.total === 1 ? "" : "s"} on next prune.
                                      </span>
                                    ) : (
                                      <span className="text-emerald-700">
                                        No rows will be removed (table has {previewQuery.data.total.toLocaleString()} row{previewQuery.data.total === 1 ? "" : "s"}).
                                      </span>
                                    )
                                  ) : null}
                                </div>
                              )}
                              <div className="col-span-2 text-caption text-muted-foreground">
                                Whichever bound removes more rows wins. Changes are recorded in the admin setting audit and apply within ~30s.
                              </div>
                            </div>
                          )}
                          {editableKey && (() => {
                            const history = retentionHistoryByKey[editableKey];
                            const last = history[0];
                            const lastEditedInfo = last
                              ? {
                                  updatedAt: last.changedAt,
                                  updatedBy: last.changedBy
                                    ? {
                                        id: last.changedBy,
                                        firstName: last.changedByName,
                                        lastName: null,
                                        email: last.changedByEmail,
                                      }
                                    : null,
                                }
                              : null;
                            const expanded = retentionHistoryExpanded[editableKey];
                            const formatRetention = (v: Partial<AuditRetention> | null | undefined) => {
                              if (!v) return "—";
                              const me = v.maxEntries ?? "?";
                              const md = v.maxAgeDays ?? "?";
                              return `${me} / ${md}d`;
                            };
                            return (
                              <div className="mb-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <LastEditedBadge
                                    info={lastEditedInfo}
                                    testId={`text-retention-last-edited-${testId}`}
                                    emptyText="No retention edits yet"
                                    className="!mt-0"
                                  />
                                  {history.length > 0 && (
                                    <button
                                      type="button"
                                      className="text-caption text-burgundy-700 hover:underline"
                                      onClick={() =>
                                        setRetentionHistoryExpanded((s) => ({
                                          ...s,
                                          [editableKey]: !expanded,
                                        }))
                                      }
                                      data-testid={`button-toggle-retention-history-${testId}`}
                                    >
                                      {expanded ? "Hide" : "Show"} recent changes ({history.length})
                                    </button>
                                  )}
                                </div>
                                {expanded && history.length > 0 && (
                                  <div
                                    className="mt-1 space-y-1 max-h-40 overflow-y-auto"
                                    data-testid={`retention-history-${testId}`}
                                  >
                                    {history.map((entry) => {
                                      const who = formatEditorAttribution(entry, "system");
                                      return (
                                        <div
                                          key={entry.id}
                                          className="bg-card rounded px-2 py-1 text-caption border border-border"
                                          data-testid={`retention-history-entry-${testId}-${entry.id}`}
                                        >
                                          <div className="flex items-center justify-between gap-2">
                                            <span
                                              className="font-medium text-foreground truncate"
                                              data-testid={`text-retention-history-by-${testId}-${entry.id}`}
                                            >
                                              {who}
                                            </span>
                                            <span
                                              className="text-muted-foreground shrink-0"
                                              data-testid={`text-retention-history-at-${testId}-${entry.id}`}
                                            >
                                              {new Date(entry.changedAt).toLocaleString()}
                                            </span>
                                          </div>
                                          <div className="text-muted-foreground">
                                            <span data-testid={`text-retention-history-old-${testId}-${entry.id}`}>
                                              {formatRetention(entry.oldValues)}
                                            </span>
                                            <span className="mx-1 text-muted-foreground">→</span>
                                            <span
                                              className="font-medium text-foreground"
                                              data-testid={`text-retention-history-new-${testId}-${entry.id}`}
                                            >
                                              {formatRetention(entry.newValues)}
                                            </span>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                          <div className="flex items-center gap-3 text-caption text-muted-foreground mb-1.5">
                            <span data-testid={`text-prune-runs-${testId}`}>
                              <span className="font-semibold text-foreground">{events.length}</span> recent run{events.length === 1 ? "" : "s"}
                            </span>
                            <span data-testid={`text-prune-total-removed-${testId}`}>
                              <span className="font-semibold text-foreground">{totalRemoved}</span> row{totalRemoved === 1 ? "" : "s"} removed
                            </span>
                            {lastEvent && (
                              <span className="text-muted-foreground" data-testid={`text-prune-last-${testId}`}>
                                Last: {new Date(lastEvent.at).toLocaleString()}
                              </span>
                            )}
                          </div>
                          {events.length === 0 ? (
                            <div className="text-caption text-muted-foreground" data-testid={`text-prune-empty-${testId}`}>
                              No prune runs recorded yet.
                            </div>
                          ) : (
                            <div className="space-y-1 max-h-40 overflow-y-auto">
                              {events.slice(0, 10).map((evt, idx) => {
                                const trigger = evt.trigger ?? "save";
                                const triggerLabel =
                                  trigger === "scheduled"
                                    ? "Scheduled"
                                    : trigger === "manual"
                                      ? "Manual"
                                      : "On change";
                                const triggerCls =
                                  trigger === "scheduled"
                                    ? "bg-blue-50 text-blue-700 border-blue-200"
                                    : trigger === "manual"
                                      ? "bg-purple-50 text-purple-700 border-purple-200"
                                      : "bg-muted text-muted-foreground border-border";
                                const linkableKey: "stale" | "queue" | null =
                                  trigger === "save" && evt.auditEntryId && (key === "stale" || key === "queue")
                                    ? key
                                    : null;
                                const who = evt.triggeredByName
                                  || (evt.triggeredBy && evt.triggeredBy !== "system" ? "Unknown user" : null);
                                const triggerTitle = linkableKey
                                  ? `Recorded after a setting save${who ? ` by ${who}` : ""}. Click to jump to the matching history row.`
                                  : trigger === "save" && who
                                    ? `Recorded after a setting save by ${who}.`
                                    : undefined;
                                const handleJump = () => {
                                  if (!linkableKey || !evt.auditEntryId) return;
                                  if (linkableKey === "stale") {
                                    scrollToThresholdHistory(evt.auditEntryId);
                                  } else {
                                    scrollToTimingHistory(evt.auditEntryId);
                                  }
                                };
                                return (
                                  <div
                                    key={`${evt.at}-${idx}`}
                                    className="flex items-center justify-between gap-2 bg-card rounded px-2 py-1 text-caption border border-border"
                                    data-testid={`prune-event-${testId}-${idx}`}
                                  >
                                    <span className="text-muted-foreground truncate" data-testid={`text-prune-event-time-${testId}-${idx}`}>
                                      {new Date(evt.at).toLocaleString()}
                                    </span>
                                    <div className="flex items-center gap-2 shrink-0">
                                      {linkableKey ? (
                                        <button
                                          type="button"
                                          onClick={handleJump}
                                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleJump(); } }}
                                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium border underline-offset-2 hover:underline focus:outline-none focus:ring-1 focus:ring-amber-400 ${triggerCls}`}
                                          title={triggerTitle}
                                          data-testid={`badge-prune-event-trigger-${testId}-${idx}`}
                                          aria-label={`Jump to history entry${who ? ` by ${who}` : ""}`}
                                        >
                                          {triggerLabel}
                                        </button>
                                      ) : (
                                        <span
                                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium border ${triggerCls}`}
                                          title={triggerTitle}
                                          data-testid={`badge-prune-event-trigger-${testId}-${idx}`}
                                        >
                                          {triggerLabel}
                                        </span>
                                      )}
                                      {trigger === "manual" && evt.triggeredByName && (
                                        <span
                                          className="text-caption text-muted-foreground truncate max-w-[140px]"
                                          title={evt.triggeredByName}
                                          data-testid={`text-prune-event-triggered-by-${testId}-${idx}`}
                                        >
                                          by {evt.triggeredByName}
                                        </span>
                                      )}
                                      <span
                                        className={`font-semibold ${evt.removed > 0 ? "text-amber-700" : "text-muted-foreground"}`}
                                        data-testid={`text-prune-event-removed-${testId}-${idx}`}
                                      >
                                        {evt.removed} row{evt.removed === 1 ? "" : "s"} removed
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {staleLeaseExhaustionEvents.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-2">Recent Exhaustion Events</h4>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto" data-testid="stale-lease-exhaustion-events">
                    {staleLeaseExhaustionEvents.map((evt) => (
                      <div key={evt.jobId} className="flex items-center justify-between bg-red-50 rounded px-2.5 py-1.5 text-xs border border-red-100" data-testid={`stale-event-${evt.jobId}`}>
                        <div className="flex items-center gap-2">
                          <Ban className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                          <span className="font-mono text-red-800 truncate max-w-[180px]" title={evt.jobId}>{evt.jobId.slice(0, 12)}...</span>
                          <Badge variant="outline" className="text-caption px-1.5 py-0 bg-red-100 text-red-700 border-red-200">{evt.workloadClass}</Badge>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <span>{evt.attemptCount} attempts</span>
                          <span>{new Date(evt.completedAt).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {queueStatus.dispatchCounters && (() => {
                const dc = queueStatus.dispatchCounters;
                const hasLastWindow = dc.lastWindow.cycleCount > 0;
                const recentWindows = dc.recentWindows ?? [];
                const queueNames = Array.from(
                  new Set([
                    ...Object.keys(dc.currentWindow.counts),
                    ...Object.keys(dc.lastWindow.counts),
                    ...recentWindows.flatMap((w) => Object.keys(w.counts)),
                    ...Object.keys(queueStatus.queueDepths ?? {}),
                  ]),
                ).sort();
                if (queueNames.length === 0) {
                  return (
                    <div data-testid="dispatch-counters-empty">
                      <h4 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
                        Per-Queue Dispatch Counts
                        <span
                          className="text-caption font-normal text-muted-foreground cursor-help"
                          title="Rolling round-robin dispatch counts. The window rolls every ~60 scheduler cycles; queues with 0 in the current window may be starved."
                          data-testid="dispatch-counters-help"
                        >
                          (?)
                        </span>
                      </h4>
                      <div className="text-xs text-muted-foreground">No queue dispatches recorded yet.</div>
                    </div>
                  );
                }
                const lastCapturedLabel = hasLastWindow && dc.lastWindow.capturedAt
                  ? new Date(dc.lastWindow.capturedAt).toLocaleString()
                  : null;
                return (
                  <div data-testid="dispatch-counters">
                    <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                      <h4 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                        Per-Queue Dispatch Counts
                        <span
                          className="text-caption font-normal text-muted-foreground cursor-help"
                          title="Rolling round-robin dispatch counts. The window rolls every ~60 scheduler cycles; queues with 0 in the current window may be starved."
                          data-testid="dispatch-counters-help"
                        >
                          (?)
                        </span>
                      </h4>
                      <div className="text-caption text-muted-foreground" data-testid="text-dispatch-counters-window-meta">
                        Current cycle {dc.currentWindow.cycleCount} / ~60 ·{" "}
                        {hasLastWindow
                          ? `Last window ${dc.lastWindow.cycleCount} cycles${lastCapturedLabel ? ` (captured ${lastCapturedLabel})` : ""}`
                          : "No completed window yet"}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs" data-testid="table-dispatch-counters">
                        <thead>
                          <tr className="text-left text-muted-foreground border-b">
                            <th className="py-1.5 pr-3 font-medium">Queue</th>
                            <th className="py-1.5 pr-3 font-medium">Recent Windows</th>
                            <th className="py-1.5 pr-3 font-medium text-right">Last Window</th>
                            <th className="py-1.5 pr-3 font-medium text-right">Current Window</th>
                          </tr>
                        </thead>
                        <tbody>
                          {queueNames.map((q) => {
                            const current = dc.currentWindow.counts[q] ?? 0;
                            const last = dc.lastWindow.counts[q] ?? 0;
                            const starved = current === 0;
                            const series = recentWindows.map((w) => w.counts[q] ?? 0);
                            const sparkMax = series.length > 0 ? Math.max(...series, 1) : 1;
                            const recent3 = series.slice(-3);
                            const prior7 = series.slice(-10, -3);
                            let trendingDown = false;
                            let trendTitle = "";
                            if (recent3.length === 3 && prior7.length === 7) {
                              const recentAvg = recent3.reduce((a, b) => a + b, 0) / 3;
                              const priorAvg = prior7.reduce((a, b) => a + b, 0) / 7;
                              if (priorAvg >= 1 && recentAvg < priorAvg * 0.5) {
                                trendingDown = true;
                                trendTitle = `Trending down: last 3 windows average ${recentAvg.toFixed(1)} dispatches vs ${priorAvg.toFixed(1)} across the prior 7 (under 50% of baseline).`;
                              }
                            }
                            const sparkW = 80;
                            const sparkH = 20;
                            const stepX = series.length > 1 ? sparkW / (series.length - 1) : 0;
                            const points = series.map((v, i) => {
                              const x = series.length > 1 ? i * stepX : sparkW / 2;
                              const y = sparkH - (v / sparkMax) * (sparkH - 2) - 1;
                              return `${x.toFixed(1)},${y.toFixed(1)}`;
                            }).join(" ");
                            const sparkTitle = series.length > 0
                              ? `Last ${series.length} windows: ${series.join(", ")}`
                              : "No completed windows yet";
                            return (
                              <tr
                                key={q}
                                className={`border-b last:border-b-0 ${starved ? "text-muted-foreground" : "text-foreground"}`}
                                title={starved ? "No dispatches in the current window — possible starvation" : undefined}
                                data-testid={`row-dispatch-counter-${q}`}
                              >
                                <td className="py-1.5 pr-3 font-mono" data-testid={`text-dispatch-queue-${q}`}>{q}</td>
                                <td className="py-1.5 pr-3" data-testid={`sparkline-dispatch-${q}`} title={sparkTitle}>
                                  <div className="flex items-center gap-1.5">
                                  {series.length === 0 ? (
                                    <span className="text-caption text-muted-foreground">—</span>
                                  ) : (
                                    <svg
                                      width={sparkW}
                                      height={sparkH}
                                      viewBox={`0 0 ${sparkW} ${sparkH}`}
                                      className="overflow-visible"
                                      aria-label={sparkTitle}
                                    >
                                      {series.length > 1 ? (
                                        <polyline
                                          fill="none"
                                          stroke={starved ? "hsl(var(--border))" : "hsl(var(--primary))"}
                                          strokeWidth="1.25"
                                          strokeLinejoin="round"
                                          strokeLinecap="round"
                                          points={points}
                                        />
                                      ) : null}
                                      {series.map((v, i) => {
                                        const x = series.length > 1 ? i * stepX : sparkW / 2;
                                        const y = sparkH - (v / sparkMax) * (sparkH - 2) - 1;
                                        const isLast = i === series.length - 1;
                                        return (
                                          <circle
                                            key={i}
                                            cx={x}
                                            cy={y}
                                            r={isLast ? 1.75 : 1.1}
                                            fill={starved ? "hsl(var(--border))" : "hsl(var(--primary))"}
                                          />
                                        );
                                      })}
                                    </svg>
                                  )}
                                  {trendingDown && (
                                    <span
                                      className="text-caption uppercase tracking-wide text-amber-700 bg-amber-100 rounded px-1 py-0.5"
                                      title={trendTitle}
                                      data-testid={`badge-dispatch-trending-down-${q}`}
                                    >
                                      ↓ trending
                                    </span>
                                  )}
                                  </div>
                                </td>
                                <td className="py-1.5 pr-3 text-right" data-testid={`text-dispatch-last-${q}`}>{last}</td>
                                <td className={`py-1.5 pr-3 text-right ${starved ? "" : "font-semibold"}`} data-testid={`text-dispatch-current-${q}`}>
                                  {current}
                                  {starved && (
                                    <span className="ml-1.5 text-caption uppercase tracking-wide text-amber-600" data-testid={`badge-dispatch-starved-${q}`}>idle</span>
                                  )}
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

              {Object.keys(queueStatus.retryDistribution).length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-2">Retry Distribution</h4>
                  <div className="flex flex-wrap gap-2" data-testid="retry-distribution">
                    {Object.entries(queueStatus.retryDistribution)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([attempts, count]) => (
                        <div key={attempts} className={`rounded px-2.5 py-1.5 text-xs font-medium ${Number(attempts) >= 3 ? "bg-red-100 text-red-800" : Number(attempts) >= 1 ? "bg-amber-100 text-amber-800" : "bg-muted text-foreground"}`} data-testid={`retry-bucket-${attempts}`}>
                          <div className="text-caption opacity-75">{attempts} retries</div>
                          <div className="text-lg font-bold">{count}</div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// Task #1057: Call-analysis failure mix panel — surfaces typed
// failure_reason × lane breakdown over the last 24h / 7d plus the
// current slow-lane backlog so operators can spot regressions
// without dropping into SQL.
type CallAnalysisFailureMixResponse = {
  reasons: readonly string[];
  lanes: readonly string[];
  windows: {
    last24h: { byReasonByLane: Record<string, Record<string, number>>; total: number };
    last7d: { byReasonByLane: Record<string, Record<string, number>>; total: number };
  };
  backlog: {
    slowLaneQueued: number;
    normalLaneQueued: number;
  };
  generatedAt: string;
};

const CALL_ANALYSIS_FAILURE_MIX_REFRESH_MS = 30000;

const FAILURE_REASON_LABELS: Record<string, string> = {
  ffmpeg_timeout: "ffmpeg timeout",
  ffmpeg_invalid_audio: "ffmpeg invalid audio",
  whisper_timeout: "whisper timeout",
  download_failed: "download failed",
  cpu_starved: "CPU starved",
  file_too_large: "file too large",
  unknown: "unknown",
};

// Task #1077: drill-down job-list payload returned by
// /api/ceo-tools/call-analysis/failure-mix/jobs.
type FailureMixJob = {
  analysis_id: string;
  external_id: string;
  error_message: string | null;
  failure_reason: string | null;
  lane: string | null;
  status: string;
  completed_at: string | null;
  attempt_count: number | null;
};

type FailureMixDrillSelection = {
  reason: string;
  lane: string;
  window: "24h" | "7d";
};

export function CallAnalysisFailureMixCard() {
  const isTabVisible = useTabVisibility();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [drill, setDrill] = useState<FailureMixDrillSelection | null>(null);

  const { data, isLoading, isError, dataUpdatedAt } = useQuery<CallAnalysisFailureMixResponse>({
    queryKey: ["/api/ceo-tools/call-analysis/failure-mix"],
    queryFn: async () => {
      const res = await fetch("/api/ceo-tools/call-analysis/failure-mix", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch call-analysis failure mix");
      return res.json();
    },
    refetchInterval: isTabVisible ? CALL_ANALYSIS_FAILURE_MIX_REFRESH_MS : false,
    refetchIntervalInBackground: false,
  });

  const drillQuery = useQuery<{ jobs: FailureMixJob[] }>({
    queryKey: [
      "/api/ceo-tools/call-analysis/failure-mix/jobs",
      drill?.reason,
      drill?.lane,
      drill?.window,
    ],
    queryFn: async () => {
      if (!drill) return { jobs: [] };
      const params = new URLSearchParams({
        reason: drill.reason,
        lane: drill.lane,
        window: drill.window,
      });
      const res = await fetch(`/api/ceo-tools/call-analysis/failure-mix/jobs?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load failure-mix jobs");
      return res.json();
    },
    enabled: !!drill,
  });

  const rerunMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (analysisId: string) => {
      const res = await fetch(`/api/ceo-tools/call-analysis/${analysisId}/rerun`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Rerun failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Job queued for re-analysis" });
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-tools/call-analysis/failure-mix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-tools/call-analysis/failure-mix/jobs"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to rerun job", variant: "destructive" });
    },
  });

  // Task #1092: bulk-rerun every visible failed job in the drill-down dialog.
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const bulkRerunMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (analysisIds: string[]) => {
      const res = await fetch(`/api/ceo-tools/call-analysis/failure-mix/bulk-rerun`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Bulk rerun failed");
      }
      return res.json() as Promise<{
        requested: number;
        succeededCount: number;
        failedCount: number;
        succeeded: string[];
        failed: Array<{ analysisId: string; error: string }>;
      }>;
    },
    onSuccess: (result) => {
      setBulkConfirmOpen(false);
      if (result.failedCount === 0) {
        toast({
          title: `Queued ${result.succeededCount} job${result.succeededCount === 1 ? "" : "s"} for re-analysis`,
        });
      } else {
        // Surface the first couple of per-job errors so the operator can see
        // why the partial-failure happened (e.g. "not_found" if a row was
        // already cleared).
        const sample = result.failed.slice(0, 3)
          .map((f) => `${f.analysisId.slice(0, 8)}…: ${f.error}`)
          .join("; ");
        toast({
          title: `Queued ${result.succeededCount} of ${result.requested} jobs`,
          description: `${result.failedCount} failed${sample ? ` — ${sample}` : ""}`,
          variant: result.succeededCount === 0 ? "destructive" : "default",
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-tools/call-analysis/failure-mix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/ceo-tools/call-analysis/failure-mix/jobs"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to rerun jobs", variant: "destructive" });
    },
  });

  const reasons = useMemo(() => data?.reasons ?? [], [data?.reasons]);
  const lanes = useMemo(() => data?.lanes ?? [], [data?.lanes]);

  const sortedReasons = useMemo(() => {
    if (!data) return reasons;
    // Sort reasons by 7d total desc so the worst offenders surface first.
    return [...reasons].sort((a, b) => {
      const totalA = lanes.reduce((acc, lane) => acc + (data.windows.last7d.byReasonByLane[a]?.[lane] ?? 0), 0);
      const totalB = lanes.reduce((acc, lane) => acc + (data.windows.last7d.byReasonByLane[b]?.[lane] ?? 0), 0);
      return totalB - totalA;
    });
  }, [data, reasons, lanes]);

  const slowQueued = data?.backlog.slowLaneQueued ?? 0;
  const normalQueued = data?.backlog.normalLaneQueued ?? 0;
  const slowBacklogTone =
    slowQueued >= 50 ? "bg-red-100 text-red-800"
    : slowQueued >= 10 ? "bg-amber-100 text-amber-800"
    : "bg-emerald-100 text-emerald-800";

  return (
    <Card data-testid="card-call-analysis-failure-mix">
      <CardHeader>
        <CardTitle className="text-foreground">Call Analysis — Failure Mix</CardTitle>
        <CardDescription>
          Counts by typed failure reason × lane (last 24h and 7d) plus the live slow-lane backlog.
          {dataUpdatedAt > 0 && (
            <span className="ml-2 text-xs text-muted-foreground" data-testid="text-failure-mix-updated">
              Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <InlineLoadingSkeleton />}
        {isError && (
          <div className="text-sm text-red-700" data-testid="text-failure-mix-error">
            Failed to load failure mix.
          </div>
        )}
        {data && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="grid-failure-mix-summary">
              <div className="rounded border border-border bg-muted/50 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Failures (24h)</div>
                <div className="text-2xl font-bold text-foreground" data-testid="text-failure-mix-total-24h">
                  {data.windows.last24h.total}
                </div>
              </div>
              <div className="rounded border border-border bg-muted/50 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Failures (7d)</div>
                <div className="text-2xl font-bold text-foreground" data-testid="text-failure-mix-total-7d">
                  {data.windows.last7d.total}
                </div>
              </div>
              <div className={`rounded p-3 ${slowBacklogTone}`}>
                <div className="text-xs uppercase tracking-wide opacity-80">Slow-lane backlog (queued)</div>
                <div className="text-2xl font-bold" data-testid="text-failure-mix-slow-backlog">
                  {slowQueued}
                </div>
                <div className="text-caption opacity-80 mt-1" data-testid="text-failure-mix-normal-backlog">
                  Normal-lane queued: {normalQueued}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-failure-mix">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b">
                    <th className="py-2 pr-3">Failure reason</th>
                    {lanes.map((lane) => (
                      <th key={`h24-${lane}`} className="py-2 pr-3 text-right">{lane} · 24h</th>
                    ))}
                    {lanes.map((lane) => (
                      <th key={`h7-${lane}`} className="py-2 pr-3 text-right">{lane} · 7d</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedReasons.map((reason) => {
                    const row24 = data.windows.last24h.byReasonByLane[reason] ?? {};
                    const row7 = data.windows.last7d.byReasonByLane[reason] ?? {};
                    const rowTotal7 = lanes.reduce((acc, lane) => acc + (row7[lane] ?? 0), 0);
                    return (
                      <tr
                        key={reason}
                        className={`border-b last:border-0 ${rowTotal7 > 0 ? "" : "text-muted-foreground"}`}
                        data-testid={`row-failure-mix-${reason}`}
                      >
                        <td className="py-2 pr-3 font-medium">{FAILURE_REASON_LABELS[reason] ?? reason}</td>
                        {lanes.map((lane) => {
                          const count = row24[lane] ?? 0;
                          return (
                            <td
                              key={`c24-${reason}-${lane}`}
                              className="py-2 pr-3 text-right tabular-nums"
                            >
                              <button
                                type="button"
                                disabled={count === 0}
                                onClick={() => setDrill({ reason, lane, window: "24h" })}
                                className={
                                  count > 0
                                    ? "underline decoration-dotted underline-offset-2 hover:text-primary-ink focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"
                                    : "text-muted-foreground cursor-default px-1"
                                }
                                data-testid={`cell-failure-mix-24h-${reason}-${lane}`}
                                aria-label={`Show ${count} ${reason} ${lane} failures in last 24 hours`}
                              >
                                {count}
                              </button>
                            </td>
                          );
                        })}
                        {lanes.map((lane) => {
                          const count = row7[lane] ?? 0;
                          return (
                            <td
                              key={`c7-${reason}-${lane}`}
                              className="py-2 pr-3 text-right tabular-nums"
                            >
                              <button
                                type="button"
                                disabled={count === 0}
                                onClick={() => setDrill({ reason, lane, window: "7d" })}
                                className={
                                  count > 0
                                    ? "underline decoration-dotted underline-offset-2 hover:text-primary-ink focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"
                                    : "text-muted-foreground cursor-default px-1"
                                }
                                data-testid={`cell-failure-mix-7d-${reason}-${lane}`}
                                aria-label={`Show ${count} ${reason} ${lane} failures in last 7 days`}
                              >
                                {count}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>

      {/* Task #1077: drill-down dialog for a single (reason × lane × window) cell. */}
      <Dialog open={!!drill} onOpenChange={(open) => { if (!open) setDrill(null); }}>
        <DialogContent className="max-w-3xl" data-testid="dialog-failure-mix-drill">
          <DialogHeader>
            <DialogTitle>
              {drill ? (
                <>Failed jobs · {FAILURE_REASON_LABELS[drill.reason] ?? drill.reason} · {drill.lane} lane · last {drill.window}</>
              ) : (
                "Failed jobs"
              )}
            </DialogTitle>
            <DialogDescription>
              Use Rerun to requeue a job, or open the call analysis page to inspect the full record.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto">
            {drillQuery.isLoading && <InlineLoadingSkeleton />}
            {drillQuery.isError && (
              <div className="text-sm text-red-700" data-testid="text-failure-mix-drill-error">
                Failed to load matching jobs.
              </div>
            )}
            {drillQuery.data && drillQuery.data.jobs.length === 0 && (
              <div className="text-sm text-muted-foreground" data-testid="text-failure-mix-drill-empty">
                No matching failed jobs in this window.
              </div>
            )}
            {drillQuery.data && drillQuery.data.jobs.length > 0 && (
              <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-failure-mix-drill">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b">
                    <th className="py-2 pr-3">Completed</th>
                    <th className="py-2 pr-3">Analysis ID</th>
                    <th className="py-2 pr-3">External ID</th>
                    <th className="py-2 pr-3">Error</th>
                    <th className="py-2 pr-3 text-right">Attempts</th>
                    <th className="py-2 pr-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {drillQuery.data.jobs.map((job) => (
                    <tr
                      key={job.analysis_id}
                      className="border-b last:border-0 align-top"
                      data-testid={`row-failure-mix-drill-${job.analysis_id}`}
                    >
                      <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground" data-testid={`text-failure-mix-drill-completed-${job.analysis_id}`}>
                        {job.completed_at ? new Date(job.completed_at).toLocaleString() : "—"}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs break-all" data-testid={`text-failure-mix-drill-analysis-${job.analysis_id}`}>
                        {job.analysis_id}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs break-all" data-testid={`text-failure-mix-drill-external-${job.analysis_id}`}>
                        {job.external_id}
                      </td>
                      <td className="py-2 pr-3 text-xs text-red-700 break-words max-w-md" data-testid={`text-failure-mix-drill-error-${job.analysis_id}`}>
                        {job.error_message ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums" data-testid={`text-failure-mix-drill-attempts-${job.analysis_id}`}>
                        {job.attempt_count ?? 0}
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <Button
                            asChild
                            variant="outline"
                            size="sm"
                            data-testid={`link-failure-mix-drill-view-${job.analysis_id}`}
                          >
                            <a
                              href={`/ceo/call-analysis?analysisId=${encodeURIComponent(job.analysis_id)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              View details
                            </a>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={rerunMutation.isPending && rerunMutation.variables === job.analysis_id}
                            onClick={() => rerunMutation.mutate(job.analysis_id)}
                            data-testid={`button-failure-mix-drill-rerun-${job.analysis_id}`}
                          >
                            <RotateCcw className="w-3.5 h-3.5 mr-1" />
                            Rerun
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <div>
              {drillQuery.data && drillQuery.data.jobs.length > 0 && (
                <Button
                  variant="default"
                  size="sm"
                  disabled={bulkRerunMutation.isPending}
                  onClick={() => setBulkConfirmOpen(true)}
                  data-testid="button-failure-mix-drill-rerun-all"
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1" />
                  Rerun all ({drillQuery.data.jobs.length})
                </Button>
              )}
            </div>
            <Button variant="outline" onClick={() => setDrill(null)} data-testid="button-failure-mix-drill-close">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task #1092: confirmation prompt for bulk-rerun. Shows the exact
          count being requeued. Nested Dialog renders above the drill-down. */}
      <Dialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => { if (!open && !bulkRerunMutation.isPending) setBulkConfirmOpen(false); }}
      >
        <DialogContent data-testid="dialog-failure-mix-bulk-rerun-confirm">
          <DialogHeader>
            <DialogTitle>Rerun all visible failed jobs?</DialogTitle>
            <DialogDescription>
              {drillQuery.data && drill ? (
                <>
                  This will requeue <span className="font-semibold" data-testid="text-failure-mix-bulk-rerun-count">{drillQuery.data.jobs.length}</span>
                  {" "}failed {FAILURE_REASON_LABELS[drill.reason] ?? drill.reason} job{drillQuery.data.jobs.length === 1 ? "" : "s"} on the {drill.lane} lane (last {drill.window}).
                  Each job's status will be reset to <code>queued</code> and its attempt count cleared.
                </>
              ) : (
                "This will requeue every failed job currently shown."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setBulkConfirmOpen(false)}
              disabled={bulkRerunMutation.isPending}
              data-testid="button-failure-mix-bulk-rerun-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={() => {
                if (!drillQuery.data) return;
                bulkRerunMutation.mutate(drillQuery.data.jobs.map((j) => j.analysis_id));
              }}
              disabled={bulkRerunMutation.isPending || !drillQuery.data || drillQuery.data.jobs.length === 0}
              data-testid="button-failure-mix-bulk-rerun-confirm"
            >
              {bulkRerunMutation.isPending ? "Requeuing…" : "Rerun all"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// Task #1096: Sibling card to the failure-mix panel exposing the
// Task #1076 failure-spike alert config (thresholds, mute list,
// cooldown, window/baseline) plus a "Run check now" affordance that
// calls the watcher's dry-run path so an operator can preview what
// would alert before flipping a knob.
type FailureSpikeConfig = {
  enabled: boolean;
  windowMinutes: number;
  baselineDays: number;
  absoluteThreshold: number;
  ratioThreshold: number;
  minCountForRatio: number;
  cooldownMinutes: number;
  mutedReasons: string[];
};

type FailureSpikeReasonEval = {
  reason: string;
  windowCount: number;
  baselinePerWindow: number;
  ratio: number | null;
  triggered: "absolute" | "ratio" | "absolute_and_ratio" | null;
  decision:
    | "alerted"
    | "skipped_disabled"
    | "skipped_muted"
    | "skipped_below_threshold"
    | "skipped_cooldown"
    | "skipped_no_growth_since_last_alert"
    | "skipped_send_failed"
    | "skipped_dispatcher_skipped";
  skipReason?: string;
};

type FailureSpikeCheckResult = {
  evaluatedAt: string;
  enabled: boolean;
  windowMinutes: number;
  baselineDays: number;
  alertsSent: number;
  reasons: FailureSpikeReasonEval[];
};

const DECISION_LABELS: Record<FailureSpikeReasonEval["decision"], string> = {
  alerted: "would alert",
  skipped_disabled: "alerts disabled",
  skipped_muted: "muted",
  skipped_below_threshold: "below threshold",
  skipped_cooldown: "in cooldown",
  skipped_no_growth_since_last_alert: "no growth since last alert",
  skipped_send_failed: "send failed",
  skipped_dispatcher_skipped: "dispatcher skipped",
};

function decisionTone(decision: FailureSpikeReasonEval["decision"]): string {
  if (decision === "alerted") return "bg-red-100 text-red-800";
  if (decision === "skipped_muted" || decision === "skipped_disabled") return "bg-muted text-foreground";
  if (decision === "skipped_below_threshold") return "bg-emerald-100 text-emerald-800";
  return "bg-amber-100 text-amber-800";
}

export function CallAnalysisFailureSpikeAlertConfigCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, isError } = useQuery<{ config: FailureSpikeConfig }>({
    queryKey: ["/api/ceo-tools/call-analysis/failure-spike-config"],
    queryFn: async () => {
      const res = await fetch("/api/ceo-tools/call-analysis/failure-spike-config", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load failure-spike alert config");
      return res.json();
    },
  });

  const [enabled, setEnabled] = useState(true);
  const [windowMinutes, setWindowMinutes] = useState("60");
  const [baselineDays, setBaselineDays] = useState("7");
  const [absoluteThreshold, setAbsoluteThreshold] = useState("10");
  const [ratioThreshold, setRatioThreshold] = useState("3");
  const [minCountForRatio, setMinCountForRatio] = useState("3");
  const [cooldownMinutes, setCooldownMinutes] = useState("360");
  const [mutedReasonsText, setMutedReasonsText] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [preview, setPreview] = useState<FailureSpikeCheckResult | null>(null);

  useEffect(() => {
    if (!data || hydrated) return;
    const c = data.config;
    setEnabled(c.enabled);
    setWindowMinutes(String(c.windowMinutes));
    setBaselineDays(String(c.baselineDays));
    setAbsoluteThreshold(String(c.absoluteThreshold));
    setRatioThreshold(String(c.ratioThreshold));
    setMinCountForRatio(String(c.minCountForRatio));
    setCooldownMinutes(String(c.cooldownMinutes));
    setMutedReasonsText(c.mutedReasons.join(", "));
    setHydrated(true);
  }, [data, hydrated]);

  const saveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const mutedReasons = mutedReasonsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const body = {
        enabled,
        windowMinutes: Number(windowMinutes),
        baselineDays: Number(baselineDays),
        absoluteThreshold: Number(absoluteThreshold),
        ratioThreshold: Number(ratioThreshold),
        minCountForRatio: Number(minCountForRatio),
        cooldownMinutes: Number(cooldownMinutes),
        mutedReasons,
      };
      const res = await fetch("/api/ceo-tools/call-analysis/failure-spike-config", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to save config");
      return json as { config: FailureSpikeConfig };
    },
    onSuccess: (json) => {
      toast({ title: "Failure-spike alert config saved" });
      queryClient.setQueryData(["/api/ceo-tools/call-analysis/failure-spike-config"], json);
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to save config", variant: "destructive" });
    },
  });

  const checkMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/ceo-tools/call-analysis/failure-spike-check", {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to run check");
      return json as FailureSpikeCheckResult;
    },
    onSuccess: (json) => {
      setPreview(json);
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to run check", variant: "destructive" });
    },
  });

  const sortedPreview = useMemo(() => {
    if (!preview) return [];
    return [...preview.reasons].sort((a, b) => {
      const aAlert = a.decision === "alerted" ? 1 : 0;
      const bAlert = b.decision === "alerted" ? 1 : 0;
      if (aAlert !== bAlert) return bAlert - aAlert;
      return b.windowCount - a.windowCount;
    });
  }, [preview]);

  return (
    <Card data-testid="card-call-analysis-failure-spike-config">
      <CardHeader>
        <CardTitle className="text-foreground">Failure-Spike Alert · Config</CardTitle>
        <CardDescription>
          Tune thresholds and the per-reason mute list for the call-analysis failure-spike
          watcher (Task #1076). "Run check now" previews what would alert without sending Slack.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <InlineLoadingSkeleton />}
        {isError && (
          <div className="text-sm text-red-700" data-testid="text-failure-spike-config-error">
            Failed to load alert config.
          </div>
        )}
        {data && (
          <>
            <div className="flex items-center justify-between rounded border border-border bg-muted/50 p-3">
              <div>
                <div className="text-sm font-medium">Enabled</div>
                <div className="text-xs text-muted-foreground">
                  When off, the watcher still computes diagnostics but never sends alerts.
                </div>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                data-testid="switch-failure-spike-enabled"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="failure-spike-window-minutes">Window (minutes)</Label>
                <Input
                  id="failure-spike-window-minutes"
                  type="number"
                  min={1}
                  value={windowMinutes}
                  onChange={(e) => setWindowMinutes(e.target.value)}
                  data-testid="input-failure-spike-window-minutes"
                />
              </div>
              <div>
                <Label htmlFor="failure-spike-baseline-days">Baseline (days)</Label>
                <Input
                  id="failure-spike-baseline-days"
                  type="number"
                  min={1}
                  value={baselineDays}
                  onChange={(e) => setBaselineDays(e.target.value)}
                  data-testid="input-failure-spike-baseline-days"
                />
              </div>
              <div>
                <Label htmlFor="failure-spike-absolute">Absolute threshold</Label>
                <Input
                  id="failure-spike-absolute"
                  type="number"
                  min={1}
                  value={absoluteThreshold}
                  onChange={(e) => setAbsoluteThreshold(e.target.value)}
                  data-testid="input-failure-spike-absolute"
                />
              </div>
              <div>
                <Label htmlFor="failure-spike-ratio">Ratio threshold (× baseline)</Label>
                <Input
                  id="failure-spike-ratio"
                  type="number"
                  min={0}
                  step="0.1"
                  value={ratioThreshold}
                  onChange={(e) => setRatioThreshold(e.target.value)}
                  data-testid="input-failure-spike-ratio"
                />
              </div>
              <div>
                <Label htmlFor="failure-spike-min-count">Min count for ratio fire</Label>
                <Input
                  id="failure-spike-min-count"
                  type="number"
                  min={1}
                  value={minCountForRatio}
                  onChange={(e) => setMinCountForRatio(e.target.value)}
                  data-testid="input-failure-spike-min-count"
                />
              </div>
              <div>
                <Label htmlFor="failure-spike-cooldown">Per-reason cooldown (minutes)</Label>
                <Input
                  id="failure-spike-cooldown"
                  type="number"
                  min={1}
                  value={cooldownMinutes}
                  onChange={(e) => setCooldownMinutes(e.target.value)}
                  data-testid="input-failure-spike-cooldown"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="failure-spike-muted">Muted reasons (comma-separated)</Label>
              <Textarea
                id="failure-spike-muted"
                rows={2}
                value={mutedReasonsText}
                onChange={(e) => setMutedReasonsText(e.target.value)}
                placeholder="e.g. cpu_starved, unknown"
                data-testid="textarea-failure-spike-muted"
              />
              <div className="text-xs text-muted-foreground mt-1">
                Reasons listed here are evaluated but never alert. Use lowercase reason
                identifiers (matches{" "}
                {Object.keys(FAILURE_REASON_LABELS).join(", ")}
                ).
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                data-testid="button-failure-spike-save"
              >
                {saveMutation.isPending ? "Saving…" : "Save config"}
              </Button>
              <Button
                variant="outline"
                onClick={() => checkMutation.mutate()}
                disabled={checkMutation.isPending}
                data-testid="button-failure-spike-check-now"
              >
                {checkMutation.isPending ? "Running…" : "Run check now"}
              </Button>
            </div>

            {preview && (
              <div className="space-y-2 rounded border border-border bg-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium" data-testid="text-failure-spike-preview-summary">
                    Dry run · {preview.alertsSent} reason(s) would alert · window{" "}
                    {preview.windowMinutes}m · baseline {preview.baselineDays}d
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(preview.evaluatedAt).toLocaleTimeString()}
                  </div>
                </div>
                {!preview.enabled && (
                  <div className="text-xs text-amber-800">
                    Alerts are currently disabled — these rows would not have been sent
                    even on a live tick.
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-failure-spike-preview">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b">
                        <th className="py-1.5 pr-3">Reason</th>
                        <th className="py-1.5 pr-3 text-right">Count (window)</th>
                        <th className="py-1.5 pr-3 text-right">Baseline / window</th>
                        <th className="py-1.5 pr-3 text-right">Ratio</th>
                        <th className="py-1.5 pr-3">Decision</th>
                        <th className="py-1.5 pr-3">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedPreview.map((row) => (
                        <tr
                          key={row.reason}
                          className="border-b last:border-0 align-top"
                          data-testid={`row-failure-spike-preview-${row.reason}`}
                        >
                          <td className="py-1.5 pr-3 font-medium">
                            {FAILURE_REASON_LABELS[row.reason] ?? row.reason}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums" data-testid={`text-failure-spike-preview-count-${row.reason}`}>
                            {row.windowCount}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {row.baselinePerWindow.toFixed(2)}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {row.ratio == null ? "—" : `${row.ratio.toFixed(2)}×`}
                          </td>
                          <td className="py-1.5 pr-3">
                            <span
                              className={`inline-block rounded px-2 py-0.5 text-xs ${decisionTone(row.decision)}`}
                              data-testid={`badge-failure-spike-preview-decision-${row.reason}`}
                            >
                              {DECISION_LABELS[row.decision]}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-xs text-muted-foreground break-words max-w-md">
                            {row.skipReason ?? (row.triggered ? `triggered: ${row.triggered}` : "—")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
