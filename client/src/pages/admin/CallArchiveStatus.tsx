import React, { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/admin/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, RotateCcw, AlertTriangle, ExternalLink, Unlock, History, Activity } from "lucide-react";
import { ArchiveHealthSparkline, type SparklinePoint } from "@/components/admin/ArchiveHealthSparkline";

type ArchiveTrendPoint = {
  sampledAt: string;
  pendingStuckCount: number;
  oldestPendingAgeSeconds: number | null;
  recentFailedCount: number;
};
type ArchiveTrendResponse = { hours: number; points: ArchiveTrendPoint[] };

function toSpark(points: ArchiveTrendPoint[], key: keyof Omit<ArchiveTrendPoint, "sampledAt">): SparklinePoint[] {
  return points.map((p) => ({ t: new Date(p.sampledAt).getTime(), v: p[key] as number | null }));
}

function fmtAge(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}

function ArchiveTrendCard() {
  const { data, isFetching, refetch } = useQuery<ArchiveTrendResponse>({
    queryKey: ["/api/admin/twilio/call-archive/health/trend"],
    refetchInterval: 5 * 60_000,
  });
  const points = data?.points ?? [];
  const last = points[points.length - 1];
  const first = points[0];
  return (
    <Card data-testid="card-archive-trend">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          24h archive backlog trend
          <Badge variant="outline" className="ml-1" data-testid="badge-archive-trend-points">
            {points.length} pt
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh archive backlog trend"
            data-testid="button-refresh-archive-trend"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Same counters the alert watcher evaluates, sampled every 15 minutes. Use the
          24h delta to answer "is the pipeline draining?" at a glance.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-md border p-3" data-testid="trend-pending-stuck">
            <div className="text-xs uppercase text-muted-foreground">Pending stuck</div>
            <div className="text-2xl font-semibold" data-testid="text-trend-pending-now">
              {last?.pendingStuckCount ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground">
              24h ago: {first?.pendingStuckCount ?? "—"}
            </div>
            <div className="mt-2">
              <ArchiveHealthSparkline
                points={toSpark(points, "pendingStuckCount")}
                color="#b45309"
                width={180}
                testId="sparkline-trend-pending"
              />
            </div>
          </div>
          <div className="rounded-md border p-3" data-testid="trend-oldest-pending">
            <div className="text-xs uppercase text-muted-foreground">Oldest pending</div>
            <div className="text-2xl font-semibold" data-testid="text-trend-oldest-now">
              {fmtAge(last?.oldestPendingAgeSeconds ?? null)}
            </div>
            <div className="text-xs text-muted-foreground">
              24h ago: {fmtAge(first?.oldestPendingAgeSeconds ?? null)}
            </div>
            <div className="mt-2">
              <ArchiveHealthSparkline
                points={toSpark(points, "oldestPendingAgeSeconds")}
                color="#9c2c46"
                width={180}
                testId="sparkline-trend-oldest"
              />
            </div>
          </div>
          <div className="rounded-md border p-3" data-testid="trend-recent-failures">
            <div className="text-xs uppercase text-muted-foreground">Recent failures</div>
            <div className="text-2xl font-semibold" data-testid="text-trend-failed-now">
              {last?.recentFailedCount ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground">
              24h ago: {first?.recentFailedCount ?? "—"}
            </div>
            <div className="mt-2">
              <ArchiveHealthSparkline
                points={toSpark(points, "recentFailedCount")}
                color="#b91c1c"
                width={180}
                testId="sparkline-trend-failed"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

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

type StuckRecording = {
  id: string;
  clientId: string | null;
  twilioSid: string | null;
  direction: string;
  fromNumber: string;
  toNumber: string;
  archiveStatus: string;
  archiveAttempts: number;
  archiveLastError: string | null;
  archiveLockedUntil: string | null;
  updatedAt: string | null;
  recordingStatus: string | null;
  processingAgeMs: number | null;
  leaseRemainingMs: number | null;
  leaseReleasedMs: number | null;
  leaseReleased: boolean;
  overCeiling: boolean;
  willReclaim: boolean;
};

type StuckResponse = {
  rows: StuckRecording[];
  stuckCount: number;
  leaseReleasedCount: number;
  overCeilingCount: number;
  activeCount: number;
  totalRows: number;
  maxProcessingMs: number;
  queueName: string;
};

type ArchiveStatus = "pending" | "queued" | "processing" | "done" | "failed" | "skipped";

const ALL_STATUSES: ArchiveStatus[] = ["pending", "queued", "processing", "done", "failed", "skipped"];

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700 border-gray-200",
  queued: "bg-blue-100 text-blue-700 border-blue-200",
  processing: "bg-amber-100 text-amber-800 border-amber-200",
  done: "bg-green-100 text-green-700 border-green-200",
  failed: "bg-red-100 text-red-700 border-red-200",
  skipped: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

type CallArchiveRow = {
  id: string;
  client_id: string | null;
  twilio_sid: string | null;
  direction: string;
  from_number: string;
  to_number: string;
  status: string;
  duration: number | null;
  created_at: string | null;
  updated_at: string | null;
  recording_sid: string | null;
  recording_url: string | null;
  recording_status: string | null;
  archive_status: ArchiveStatus | null;
  archive_attempts: number | null;
  archive_last_error: string | null;
  archive_locked_until: string | null;
  archive_next_attempt_at: string | null;
  object_storage_key: string | null;
  object_storage_archived_at: string | null;
  transcript_completed_at: string | null;
  transcript_error: string | null;
  drive_recording_uploaded_at: string | null;
  drive_recording_web_link: string | null;
  drive_transcript_uploaded_at: string | null;
  drive_transcript_web_link: string | null;
  // Task #4025: in-app client-file delivery columns.
  client_file_recording_id: string | null;
  client_file_recording_saved_at: string | null;
  client_file_transcript_id: string | null;
  client_file_transcript_saved_at: string | null;
  twilio_delete_eligible_at: string | null;
  twilio_recording_deleted_at: string | null;
};

type ArchiveResponse = {
  rows: CallArchiveRow[];
  counts: Record<string, number>;
  stuckCount: number;
  limit: number;
};

function fmtDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function StageBadge({ label, ts, error }: { label: string; ts: string | null; error?: string | null }) {
  if (error) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-700" title={error}>
        <AlertTriangle className="h-3 w-3" /> {label}
      </span>
    );
  }
  if (ts) {
    return (
      <span className="text-xs text-green-700" title={fmtDate(ts)}>
        ✓ {label}
      </span>
    );
  }
  return <span className="text-xs text-gray-400">○ {label}</span>;
}

type RequeueAuditRow = {
  id: string;
  userId: string | null;
  mode: "single" | "bulk_failed" | "bulk_stuck" | string;
  targetCallId: string | null;
  affectedCount: number;
  note: string | null;
  createdAt: string;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string | null;
};

type RequeueAuditResponse = {
  rows: RequeueAuditRow[];
  limit: number;
};

function operatorLabel(row: RequeueAuditRow): string {
  const name = [row.userFirstName, row.userLastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (row.userEmail) return row.userEmail;
  if (row.userId) return row.userId;
  return "(unknown user)";
}

function modeLabel(mode: string): string {
  if (mode === "single") return "Per-row re-queue";
  if (mode === "bulk_failed") return "Bulk re-queue (failed)";
  if (mode === "bulk_stuck") return "Bulk re-queue (stuck)";
  return mode;
}

function timeAgo(value: string, nowMs: number): string {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diff = Math.max(0, nowMs - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function RecentRequeuesCard() {
  const [nowTick, setNowTick] = useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, isFetching, refetch } = useQuery<RequeueAuditResponse>({
    queryKey: ["/api/admin/twilio/call-archive/requeue-audit"],
    queryFn: async () => {
      const res = await fetch("/api/admin/twilio/call-archive/requeue-audit?limit=20", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const rows = data?.rows ?? [];

  return (
    <Card data-testid="card-recent-requeues">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-5 w-5 text-muted-foreground" />
          Recent re-queues
          <Badge variant="outline" className="ml-1" data-testid="badge-recent-requeues-count">
            {rows.length}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh recent re-queues"
            data-testid="button-refresh-recent-requeues"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Latest {data?.limit ?? 20} re-queue actions (per-row and bulk) triggered from this page,
          newest first. Use this to see who kicked the call-archive pipeline and when.
        </p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
        ) : rows.length === 0 ? (
          <p
            className="text-sm text-muted-foreground py-4 text-center"
            data-testid="text-recent-requeues-empty"
          >
            No re-queue actions recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="table-recent-requeues">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Operator</th>
                  <th className="py-2 pr-3 font-medium">Action</th>
                  <th className="py-2 pr-3 font-medium">Rows</th>
                  <th className="py-2 pr-3 font-medium">Target</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b last:border-b-0"
                    data-testid={`row-requeue-audit-${row.id}`}
                  >
                    <td
                      className="py-2 pr-3 whitespace-nowrap"
                      title={fmtDate(row.createdAt)}
                      data-testid={`text-requeue-when-${row.id}`}
                    >
                      {timeAgo(row.createdAt, nowTick)}
                    </td>
                    <td
                      className="py-2 pr-3"
                      data-testid={`text-requeue-operator-${row.id}`}
                    >
                      {operatorLabel(row)}
                    </td>
                    <td className="py-2 pr-3" data-testid={`text-requeue-mode-${row.id}`}>
                      <Badge
                        variant="outline"
                        className={
                          row.mode === "single"
                            ? "bg-blue-50 text-blue-700 border-blue-200"
                            : row.mode === "bulk_failed"
                            ? "bg-red-50 text-red-700 border-red-200"
                            : row.mode === "bulk_stuck"
                            ? "bg-amber-50 text-amber-800 border-amber-200"
                            : ""
                        }
                      >
                        {modeLabel(row.mode)}
                      </Badge>
                    </td>
                    <td
                      className="py-2 pr-3 tabular-nums"
                      data-testid={`text-requeue-count-${row.id}`}
                    >
                      {row.affectedCount}
                    </td>
                    <td
                      className="py-2 pr-3 font-mono text-xs break-all"
                      data-testid={`text-requeue-target-${row.id}`}
                    >
                      {row.targetCallId ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StuckRecordingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [nowTick, setNowTick] = useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, isFetching, refetch } = useQuery<StuckResponse>({
    queryKey: ["/api/admin/twilio/call-archive/stuck-processing"],
    queryFn: async () => {
      const res = await fetch("/api/admin/twilio/call-archive/stuck-processing", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });

  const forceReleaseMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/twilio/call-archive/${id}/force-release`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Lease released", description: "Worker will reclaim the row on the next tick." });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive/stuck-processing"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Force-release failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const leaseReleasedCount = data?.leaseReleasedCount ?? 0;
  const overCeilingCount = data?.overCeilingCount ?? 0;
  const activeCount = data?.activeCount ?? 0;
  const totalRows = data?.totalRows ?? 0;
  const ceilingMs = data?.maxProcessingMs ?? 0;

  return (
    <Card data-testid="card-stuck-recordings">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className={`h-5 w-5 ${leaseReleasedCount > 0 ? "text-red-600" : overCeilingCount > 0 ? "text-amber-600" : activeCount > 0 ? "text-amber-500" : "text-gray-400"}`} />
          Stuck recordings (call_archive lease)
          {leaseReleasedCount > 0 && (
            <Badge variant="outline" className="ml-1 bg-red-50 text-red-700 border-red-200" data-testid="badge-stuck-recordings-released">
              {leaseReleasedCount} lease released
            </Badge>
          )}
          {overCeilingCount > 0 && (
            <Badge variant="outline" className="ml-1 bg-amber-50 text-amber-800 border-amber-200" data-testid="badge-stuck-recordings-over-ceiling">
              {overCeilingCount} over ceiling
            </Badge>
          )}
          {activeCount > 0 && (
            <Badge variant="outline" className="ml-1 bg-blue-50 text-blue-700 border-blue-200" data-testid="badge-stuck-recordings-active">
              {activeCount} active
            </Badge>
          )}
          {data && totalRows === 0 && (
            <Badge variant="outline" className="ml-1 bg-green-50 text-green-700 border-green-200" data-testid="badge-stuck-recordings-ok">
              Healthy
            </Badge>
          )}
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            Ceiling: {formatDurationMs(ceilingMs)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh stuck recordings"
            data-testid="button-refresh-stuck-recordings"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Call recordings whose archive pipeline is currently in <code>processing</code>. Rows marked
          "Will reclaim" have had their lease released — either the heartbeat hit the per-queue
          max-processing ceiling or the handler died — and the next claim tick will pick them up.
          Use "Force release" to recover one without waiting.
        </p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
        ) : !data || data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-stuck-recordings-empty">
            No call recordings are currently in the processing state.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="table-stuck-recordings">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Call</th>
                  <th className="py-2 pr-3 font-medium">From → To</th>
                  <th className="py-2 pr-3 font-medium">Attempts</th>
                  <th className="py-2 pr-3 font-medium">Processing age</th>
                  <th className="py-2 pr-3 font-medium">Lease</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const liveProcessingAgeMs = r.updatedAt
                    ? nowTick - new Date(r.updatedAt).getTime()
                    : r.processingAgeMs;
                  const liveLeaseRemainingMs = r.archiveLockedUntil
                    ? new Date(r.archiveLockedUntil).getTime() - nowTick
                    : r.leaseRemainingMs;
                  const liveReleased = liveLeaseRemainingMs != null && liveLeaseRemainingMs <= 0;
                  return (
                    <tr key={r.id} className="border-b last:border-b-0" data-testid={`row-stuck-recording-${r.id}`}>
                      <td className="py-2 pr-3 font-mono text-xs" data-testid={`text-call-id-${r.id}`}>
                        {r.id.slice(0, 8)}…
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.fromNumber} → {r.toNumber}
                      </td>
                      <td className="py-2 pr-3" data-testid={`text-stuck-attempts-${r.id}`}>
                        {r.archiveAttempts}
                      </td>
                      <td className="py-2 pr-3" data-testid={`text-processing-age-${r.id}`}>
                        {formatDurationMs(liveProcessingAgeMs)}
                        {r.overCeiling && (
                          <span className="ml-1 text-red-600" title={`Over ceiling of ${formatDurationMs(ceilingMs)}`}>
                            (over)
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3" data-testid={`text-lease-${r.id}`}>
                        {liveReleased
                          ? `released ${formatDurationMs(Math.abs(liveLeaseRemainingMs ?? 0))} ago`
                          : `${formatDurationMs(liveLeaseRemainingMs)} left`}
                      </td>
                      <td className="py-2 pr-3" data-testid={`text-stuck-status-${r.id}`}>
                        {r.willReclaim || liveReleased ? (
                          <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 text-xs">
                            Lease released — will reclaim
                          </Badge>
                        ) : r.overCeiling ? (
                          <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200 text-xs" title="Processing age has exceeded the ceiling. Heartbeat will revoke the lease shortly.">
                            Over ceiling
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-xs">
                            Active
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!liveReleased || forceReleaseMutation.isPending}
                          onClick={() => forceReleaseMutation.mutate(r.id)}
                          data-testid={`button-force-release-${r.id}`}
                          title={liveReleased
                            ? "Release lease and re-queue immediately"
                            : "Wait until the lease expires (heartbeat is still extending it)"}
                        >
                          <Unlock className="h-3.5 w-3.5 mr-1" /> Force release
                        </Button>
                      </td>
                    </tr>
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

export default function CallArchiveStatus() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedStatuses, setSelectedStatuses] = useState<Set<ArchiveStatus>>(new Set());
  const [stuckOnly, setStuckOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<null | "failed" | "stuck">(null);

  const queryKey = useMemo(() => {
    const params = new URLSearchParams();
    if (selectedStatuses.size > 0) {
      params.set("status", Array.from(selectedStatuses).join(","));
    }
    if (stuckOnly) params.set("stuck", "true");
    params.set("limit", "200");
    return ["/api/admin/twilio/call-archive", params.toString()];
  }, [selectedStatuses, stuckOnly]);

  const { data, isLoading, refetch, isFetching } = useQuery<ArchiveResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/admin/twilio/call-archive?${queryKey[1]}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const requeueMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/twilio/call-archive/${id}/requeue`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Re-queued", description: "Worker will pick up the row on the next tick." });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive/requeue-audit"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Re-queue failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const bulkRequeueMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (mode: "failed" | "stuck") => {
      const body = mode === "failed" ? { status: "failed" } : { stuck: true };
      const res = await apiRequest("POST", `/api/admin/twilio/call-archive/requeue-bulk`, body);
      return res.json() as Promise<{ mode: string; count: number }>;
    },
    onSuccess: (result) => {
      toast({
        title: `Re-queued ${result.count} ${result.mode} row${result.count === 1 ? "" : "s"}`,
        description: "Worker will pick them up on the next tick.",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive/requeue-audit"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Bulk re-queue failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
    onSettled: () => {
      setBulkConfirm(null);
    },
  });

  const toggleStatus = (status: ArchiveStatus) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const rows = data?.rows ?? [];
  const counts = data?.counts ?? {};
  const stuckCount = data?.stuckCount ?? 0;
  const failedCount = counts.failed ?? 0;

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-4 max-w-7xl">
      <PageHeader
        title="Call recording archive"
        backHref="/admin/twilio"
        backLabel="Twilio admin"
        backTestId="link-back-twilio"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh"
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        }
      />

      <ArchiveTrendCard />

      <StuckRecordingsCard />

      <RecentRequeuesCard />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Status totals</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {ALL_STATUSES.map((s) => {
            const active = selectedStatuses.has(s);
            const count = counts[s] ?? 0;
            return (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition ${
                  active ? "ring-2 ring-offset-1 ring-burgundy-500" : ""
                } ${STATUS_COLORS[s]}`}
                data-testid={`filter-status-${s}`}
              >
                <span className="font-medium capitalize">{s}</span>
                <span className="text-xs opacity-80">{count}</span>
              </button>
            );
          })}
          <div className="flex items-center gap-2 ml-2 pl-2 border-l">
            <Switch
              checked={stuckOnly}
              onCheckedChange={setStuckOnly}
              aria-label="Show stuck recordings only"
              data-testid="switch-stuck-only"
            />
            <span className="text-sm">
              Stuck only
              <Badge variant="outline" className="ml-2" data-testid="badge-stuck-count">
                {stuckCount}
              </Badge>
            </span>
          </div>
          {(selectedStatuses.size > 0 || stuckOnly) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelectedStatuses(new Set());
                setStuckOnly(false);
              }}
              data-testid="button-clear-filters"
            >
              Clear filters
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bulk actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={failedCount === 0 || bulkRequeueMutation.isPending}
            onClick={() => setBulkConfirm("failed")}
            data-testid="button-bulk-requeue-failed"
          >
            <RotateCcw className="h-4 w-4 mr-1" /> Re-queue all failed ({failedCount})
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={stuckCount === 0 || bulkRequeueMutation.isPending}
            onClick={() => setBulkConfirm("stuck")}
            data-testid="button-bulk-requeue-stuck"
          >
            <RotateCcw className="h-4 w-4 mr-1" /> Re-queue all stuck ({stuckCount})
          </Button>
          <p className="text-xs text-muted-foreground self-center ml-2">
            "Failed" = retry budget exhausted. "Stuck" = recording-status webhook never delivered.
          </p>
        </CardContent>
      </Card>

      <AlertDialog open={bulkConfirm !== null} onOpenChange={(open) => !open && setBulkConfirm(null)}>
        <AlertDialogContent data-testid="dialog-bulk-requeue-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Re-queue all {bulkConfirm === "failed" ? "failed" : "stuck"} call recordings?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will re-queue{" "}
              <strong>
                {bulkConfirm === "failed" ? failedCount : stuckCount}{" "}
                {bulkConfirm === "failed" ? "failed" : "stuck"} row
                {(bulkConfirm === "failed" ? failedCount : stuckCount) === 1 ? "" : "s"}
              </strong>{" "}
              in a single transaction. Each row's attempt counter resets to 0 and the next
              worker tick will pick them up.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-bulk-requeue-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => bulkConfirm && bulkRequeueMutation.mutate(bulkConfirm)}
              disabled={bulkRequeueMutation.isPending}
              data-testid="button-bulk-requeue-confirm"
            >
              {bulkRequeueMutation.isPending ? "Re-queueing…" : "Re-queue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Recent calls
            <span className="text-sm text-muted-foreground ml-2 font-normal">
              {isLoading ? "loading…" : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {!isLoading && rows.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center" data-testid="text-empty">
              No calls match the current filters.
            </p>
          )}
          {rows.length > 0 && (
            <table className="w-full text-sm" data-testid="table-call-archive">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Direction</th>
                  <th className="py-2 pr-3">From → To</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Attempts</th>
                  <th className="py-2 pr-3">Pipeline stages</th>
                  <th className="py-2 pr-3">Next attempt</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const status = r.archive_status ?? "pending";
                  // Re-queue is only allowed for rows in 'failed' state — see
                  // server/routes/twilio.ts for the rationale (avoid racing
                  // an in-flight 'processing' row, etc.).
                  const canRequeue = status === "failed";
                  const isExpanded = expandedId === r.id;
                  return (
                    <React.Fragment key={r.id}>
                      <tr
                        className="border-b hover:bg-muted/30 cursor-pointer"
                        onClick={() => setExpandedId(isExpanded ? null : r.id)}
                        data-testid={`row-call-${r.id}`}
                      >
                        <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                        <td className="py-2 pr-3 capitalize">{r.direction}</td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {r.from_number} → {r.to_number}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge
                            variant="outline"
                            className={STATUS_COLORS[status] ?? ""}
                            data-testid={`badge-status-${r.id}`}
                          >
                            {status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 text-center" data-testid={`text-attempts-${r.id}`}>
                          {r.archive_attempts ?? 0}
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            <StageBadge label="storage" ts={r.object_storage_archived_at} />
                            <StageBadge
                              label="transcript"
                              ts={r.transcript_completed_at}
                              error={r.transcript_error}
                            />
                            {/* Task #4025: in-app files are the canonical copies now. */}
                            <StageBadge label="files (rec)" ts={r.client_file_recording_saved_at} />
                            <StageBadge label="files (txt)" ts={r.client_file_transcript_saved_at} />
                            <StageBadge label="drive (rec)" ts={r.drive_recording_uploaded_at} />
                            <StageBadge label="drive (txt)" ts={r.drive_transcript_uploaded_at} />
                            <StageBadge label="twilio deleted" ts={r.twilio_recording_deleted_at} />
                          </div>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground">
                          {fmtDate(r.archive_next_attempt_at)}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {canRequeue && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation();
                                requeueMutation.mutate(r.id);
                              }}
                              disabled={requeueMutation.isPending}
                              data-testid={`button-requeue-${r.id}`}
                            >
                              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Re-queue
                            </Button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-muted/20 border-b">
                          <td colSpan={8} className="p-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                              <div className="space-y-1">
                                <div><span className="text-muted-foreground">Call id:</span> <span className="font-mono">{r.id}</span></div>
                                <div><span className="text-muted-foreground">Twilio SID:</span> <span className="font-mono">{r.twilio_sid ?? "—"}</span></div>
                                <div><span className="text-muted-foreground">Recording SID:</span> <span className="font-mono">{r.recording_sid ?? "—"}</span></div>
                                <div><span className="text-muted-foreground">Recording status:</span> {r.recording_status ?? "—"}</div>
                                <div><span className="text-muted-foreground">Client:</span> {r.client_id ?? "(unmatched)"}</div>
                                <div><span className="text-muted-foreground">Locked until:</span> {fmtDate(r.archive_locked_until)}</div>
                                <div><span className="text-muted-foreground">Twilio delete eligible at:</span> {fmtDate(r.twilio_delete_eligible_at)}</div>
                                <div><span className="text-muted-foreground">Object storage key:</span> <span className="font-mono break-all">{r.object_storage_key ?? "—"}</span></div>
                              </div>
                              <div className="space-y-1">
                                <div><span className="text-muted-foreground">Storage archived at:</span> {fmtDate(r.object_storage_archived_at)}</div>
                                <div><span className="text-muted-foreground">Transcript at:</span> {fmtDate(r.transcript_completed_at)}</div>
                                {/* Task #4025: in-app client-file copies are the primary links; Drive is legacy. */}
                                <div><span className="text-muted-foreground">Client-file recording at:</span> {fmtDate(r.client_file_recording_saved_at)}
                                  {r.client_file_recording_id && r.client_id && (
                                    <a href={`/clients/${r.client_id}?tab=files&file=${r.client_file_recording_id}`} className="ml-1 inline-flex items-center text-indigo-600 hover:underline" data-testid={`link-client-file-recording-${r.id}`}>
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
                                </div>
                                <div><span className="text-muted-foreground">Client-file transcript at:</span> {fmtDate(r.client_file_transcript_saved_at)}
                                  {r.client_file_transcript_id && r.client_id && (
                                    <a href={`/clients/${r.client_id}?tab=files&file=${r.client_file_transcript_id}`} className="ml-1 inline-flex items-center text-indigo-600 hover:underline" data-testid={`link-client-file-transcript-${r.id}`}>
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
                                </div>
                                <div><span className="text-muted-foreground">Drive recording at (legacy):</span> {fmtDate(r.drive_recording_uploaded_at)}
                                  {r.drive_recording_web_link && (
                                    <a href={r.drive_recording_web_link} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center text-blue-600 hover:underline">
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
                                </div>
                                <div><span className="text-muted-foreground">Drive transcript at (legacy):</span> {fmtDate(r.drive_transcript_uploaded_at)}
                                  {r.drive_transcript_web_link && (
                                    <a href={r.drive_transcript_web_link} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center text-blue-600 hover:underline">
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
                                </div>
                                <div><span className="text-muted-foreground">Twilio recording deleted at:</span> {fmtDate(r.twilio_recording_deleted_at)}</div>
                                {r.archive_last_error && (
                                  <div className="mt-2 rounded border border-red-200 bg-red-50 p-2">
                                    <div className="font-semibold text-red-800 mb-1">Archive last error</div>
                                    <pre className="whitespace-pre-wrap break-all text-red-900" data-testid={`text-error-${r.id}`}>{r.archive_last_error}</pre>
                                  </div>
                                )}
                                {r.transcript_error && (
                                  <div className="mt-2 rounded border border-red-200 bg-red-50 p-2">
                                    <div className="font-semibold text-red-800 mb-1">Transcript error</div>
                                    <pre className="whitespace-pre-wrap break-all text-red-900">{r.transcript_error}</pre>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
