/**
 * Task #928 — Post-deploy verification panel.
 *
 * Renders the §8 runbook checklist as a single admin-facing panel:
 *   - "Run checklist" button → fires every check, shows pass/fail per item
 *     with the underlying numbers.
 *   - "Save as baseline" → persists the current numerics so the next run
 *     renders a "compare to last deploy" diff.
 *   - "Force-resolve legacy stuck incidents" → one-click escape hatch for
 *     the documented `db_latency:warning:probe` rollout case.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Save,
  Wrench,
  ArrowDown,
  ArrowUp,
  Minus,
  ClipboardCheck,
  Trash2,
  Undo2,
  ChevronDown,
  ChevronRight,
  CheckCheck,
} from "lucide-react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  YAxis,
  Dot,
} from "recharts";

type CheckStatus = "pass" | "fail" | "warn";

interface CheckRow {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  numeric?: number | null;
}

interface CheckGroup {
  id: string;
  title: string;
  status: CheckStatus;
  checks: CheckRow[];
}

interface BaselineSnapshot {
  id: number;
  savedAt: number;
  savedBy: string | null;
  metrics: Record<string, number | null>;
  overallStatus: CheckStatus | null;
}

interface MetricAcknowledgement {
  by: string | null;
  at: number;
}

interface ComparisonRow {
  key: string;
  label: string;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  drift: "better" | "worse" | "same" | "unknown";
  acknowledgement: MetricAcknowledgement | null;
}

interface BaselineTrashEntry {
  snapshot: BaselineSnapshot;
  deletedAt: number;
  deletedBy: string | null;
}

interface VerificationReport {
  generatedAt: number;
  overall: CheckStatus;
  groups: CheckGroup[];
  baseline: BaselineSnapshot | null;
  baselines: BaselineSnapshot[];
  comparison: ComparisonRow[];
  metrics: Record<string, number | null>;
  autoBaseline: { enabled: boolean };
  baselineTrash?: BaselineTrashEntry[];
}

const AUTO_BASELINE_PREFIX = "auto:";

function isAutoBaseline(b: BaselineSnapshot | null): boolean {
  return !!b?.savedBy && b.savedBy.startsWith(AUTO_BASELINE_PREFIX);
}

interface ForceResolveResult {
  resolved: number;
  details: Array<{ id: number; fingerprint: string; previousStatus: string }>;
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "pass") return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
  if (status === "warn") return <AlertTriangle className="w-4 h-4 text-amber-600" />;
  return <XCircle className="w-4 h-4 text-red-600" />;
}

function StatusBadge({ status }: { status: CheckStatus }) {
  const cls =
    status === "pass"
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : status === "warn"
      ? "bg-amber-100 text-amber-700 border-amber-200"
      : "bg-red-100 text-red-700 border-red-200";
  return (
    <Badge variant="outline" className={cls} data-testid={`badge-status-${status}`}>
      {status.toUpperCase()}
    </Badge>
  );
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString();
}

interface SparkPoint {
  savedAt: number;
  value: number;
  isCurrent: boolean;
}

function MetricSparkline({
  rowKey,
  label,
  baselines,
  current,
  generatedAt,
}: {
  rowKey: string;
  label: string;
  baselines: BaselineSnapshot[];
  current: number | null;
  generatedAt: number;
}) {
  // baselines arrive newest-first; reverse to oldest → newest, then append
  // the current run as the rightmost point.
  const points: SparkPoint[] = [];
  for (let i = baselines.length - 1; i >= 0; i--) {
    const b = baselines[i];
    const v = b.metrics[rowKey];
    if (v != null && Number.isFinite(v)) {
      points.push({ savedAt: b.savedAt, value: v, isCurrent: false });
    }
  }
  if (current != null && Number.isFinite(current)) {
    points.push({ savedAt: generatedAt, value: current, isCurrent: true });
  }

  if (points.length < 2) {
    return (
      <span
        className="text-xs text-muted-foreground"
        data-testid={`spark-empty-${rowKey}`}
      >
        —
      </span>
    );
  }

  return (
    <div
      className="inline-block align-middle"
      style={{ width: 100, height: 28 }}
      data-testid={`spark-${rowKey}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={points}
          margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
        >
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const p = payload[0].payload as SparkPoint;
              return (
                <div className="rounded border bg-background px-2 py-1 text-xs shadow-sm">
                  <div className="font-medium">{label}</div>
                  <div className="text-muted-foreground">
                    {fmtTs(p.savedAt)}
                    {p.isCurrent ? " (current)" : ""}
                  </div>
                  <div className="tabular-nums">{fmtNum(p.value)}</div>
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={(props: {
              cx?: number;
              cy?: number;
              index?: number;
              payload?: SparkPoint;
            }) => {
              const { cx, cy, payload, index } = props;
              const isLast = payload?.isCurrent === true;
              return (
                <Dot
                  key={`dot-${rowKey}-${index ?? 0}`}
                  cx={cx}
                  cy={cy}
                  r={isLast ? 2.5 : 1.5}
                  fill={isLast ? "hsl(var(--primary))" : "#a37687"}
                  stroke="none"
                />
              );
            }}
            activeDot={{ r: 3, fill: "hsl(var(--primary))" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DriftIcon({ drift }: { drift: ComparisonRow["drift"] }) {
  if (drift === "better") return <ArrowDown className="w-3 h-3 text-emerald-600" />;
  if (drift === "worse") return <ArrowUp className="w-3 h-3 text-red-600" />;
  if (drift === "same") return <Minus className="w-3 h-3 text-zinc-400" />;
  return <Minus className="w-3 h-3 text-zinc-300" />;
}

export function PostDeployVerificationPanel({ enabled }: { enabled: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Task #983 — which historical baseline the panel is currently comparing
  // against. `null` = use whatever the server picks (newest).
  const [selectedBaselineId, setSelectedBaselineId] = useState<number | null>(
    null,
  );

  // Task #1008 — sort the compare table by drift magnitude (worst-worsening
  // first) instead of the server's group-defined ordering.
  const [sortByDrift, setSortByDrift] = useState<boolean>(true);

  // Task #1007 — collapse/expand the "Recently deleted" trash section.
  const [trashExpanded, setTrashExpanded] = useState<boolean>(false);
  // Task #4357: force-resolve sits in the header row next to routine
  // Run/Save buttons; the AlertDialog makes the destructive step deliberate.
  const [confirmForceResolveOpen, setConfirmForceResolveOpen] = useState(false);

  const reportQ = useQuery<VerificationReport>({
    queryKey: [
      "/api/health/post-deploy-verification",
      { baselineId: selectedBaselineId },
    ],
    queryFn: async () => {
      const url =
        selectedBaselineId != null
          ? `/api/health/post-deploy-verification?baselineId=${selectedBaselineId}`
          : "/api/health/post-deploy-verification";
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled,
    // Don't auto-poll — this is a "run on demand after each deploy" panel.
    refetchOnWindowFocus: false,
    refetchInterval: false,
    staleTime: 60_000,
  });

  const refreshMut = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["/api/health/post-deploy-verification"],
      });
      return reportQ.refetch();
    },
    onError: (e: any) =>
      toast({
        title: "Verification failed",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const baselineMut = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const r = await fetch("/api/health/post-deploy-verification/baseline", {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      toast({
        title: "Baseline saved",
        description: "Future runs will compare against this snapshot.",
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/health/post-deploy-verification"],
      });
    },
    onError: (e: any) =>
      toast({
        title: "Failed to save baseline",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const autoBaselineMut = useMutation({
    meta: { silent: true },
    mutationFn: async (enabled: boolean) => {
      const r = await fetch(
        "/api/health/post-deploy-verification/auto-baseline-setting",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<{ enabled: boolean }>;
    },
    onSuccess: (data) => {
      toast({
        title: data.enabled
          ? "Auto-snapshot enabled"
          : "Auto-snapshot disabled",
        description: data.enabled
          ? "A baseline will be auto-saved a few minutes after each clean boot."
          : "Boot-time baselines will not be saved until re-enabled.",
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/health/post-deploy-verification"],
      });
    },
    onError: (e: any) =>
      toast({
        title: "Failed to update auto-snapshot setting",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const acknowledgeMut = useMutation<
    { ok: true; acknowledgement: MetricAcknowledgement },
    Error,
    { baselineId: number; metricKey: string }
  >({
    meta: { silent: true },
    mutationFn: async ({ baselineId, metricKey }) => {
      const r = await fetch(
        "/api/health/post-deploy-verification/acknowledge",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baselineId, metricKey }),
        },
      );
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/health/post-deploy-verification"],
      });
    },
    onError: (e) =>
      toast({
        title: "Failed to acknowledge metric",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const unacknowledgeMut = useMutation<
    { ok: true },
    Error,
    { baselineId: number; metricKey: string }
  >({
    meta: { silent: true },
    mutationFn: async ({ baselineId, metricKey }) => {
      const params = new URLSearchParams({
        baselineId: String(baselineId),
        metricKey,
      });
      const r = await fetch(
        `/api/health/post-deploy-verification/acknowledge?${params.toString()}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/health/post-deploy-verification"],
      });
    },
    onError: (e) =>
      toast({
        title: "Failed to undo acknowledgement",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const deleteBaselineMut = useMutation<
    { ok: true },
    Error,
    { id: number; wasSelected: boolean }
  >({
    meta: { silent: true },
    mutationFn: async ({ id }) => {
      const r = await fetch(
        `/api/health/post-deploy-verification/baseline/${id}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (_data, vars) => {
      toast({
        title: "Baseline deleted",
        description: "It will no longer appear in the comparison history.",
      });
      // If the deleted baseline was the selected one, fall back to the most
      // recent (server-picked default).
      if (vars.wasSelected) setSelectedBaselineId(null);
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/health/post-deploy-verification"],
      });
    },
    onError: (e) =>
      toast({
        title: "Failed to delete baseline",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const restoreBaselineMut = useMutation<
    { baseline: BaselineSnapshot },
    Error,
    { id: number }
  >({
    meta: { silent: true },
    mutationFn: async ({ id }) => {
      const r = await fetch(
        `/api/health/post-deploy-verification/baseline/${id}/restore`,
        { method: "POST", credentials: "include" },
      );
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Baseline restored",
        description: `Restored snapshot from ${fmtTs(data.baseline.savedAt)}.`,
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/health/post-deploy-verification"],
      });
    },
    onError: (e) =>
      toast({
        title: "Failed to restore baseline",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const forceMut = useMutation<ForceResolveResult>({
    meta: { silent: true },
    mutationFn: async () => {
      const r = await fetch(
        "/api/health/post-deploy-verification/force-resolve-legacy",
        { method: "POST", credentials: "include" },
      );
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.resolved > 0 ? `Resolved ${data.resolved} legacy incident(s)` : "Nothing to resolve",
        description:
          data.resolved > 0
            ? data.details.map((d) => `#${d.id} ${d.fingerprint}`).join(", ")
            : "No legacy stuck incidents matched the runbook criteria.",
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/health/post-deploy-verification"],
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/health/incidents"] }); // fire-and-forget: cache refresh only
    },
    onError: (e: any) =>
      toast({
        title: "Force-resolve failed",
        description: String(e?.message ?? e),
        variant: "destructive",
      }),
  });

  const report = reportQ.data;

  // Task #1008 — derive a sorted view of the comparison rows. When sorting by
  // drift, "worse" rows come first ranked by absolute delta (largest worsening
  // first), then "unknown", then "same", then "better". The top N worsening
  // rows are tagged so we can tint them in the table.
  const WORST_HIGHLIGHT_COUNT = 3;
  const sortedComparison = useMemo(() => {
    const rows = report?.comparison ?? [];
    const indexed = rows.map((row, originalIndex) => ({ row, originalIndex }));
    if (!sortByDrift) return indexed;
    const driftRank: Record<ComparisonRow["drift"], number> = {
      worse: 0,
      unknown: 1,
      same: 2,
      better: 3,
    };
    const mag = (r: ComparisonRow): number =>
      r.delta != null && Number.isFinite(r.delta) ? Math.abs(r.delta) : -1;
    return [...indexed].sort((a, b) => {
      // Task #1018 — acknowledged rows always sink below their un-acked
      // peers within the same drift bucket so the next un-handled
      // regression keeps standing out at the top.
      const aAck = a.row.acknowledgement != null ? 1 : 0;
      const bAck = b.row.acknowledgement != null ? 1 : 0;
      const dr = driftRank[a.row.drift] - driftRank[b.row.drift];
      if (dr !== 0) return dr;
      if (aAck !== bAck) return aAck - bAck;
      // Within the same drift bucket, larger magnitude first.
      const dm = mag(b.row) - mag(a.row);
      if (dm !== 0) return dm;
      // Stable fallback to original ordering.
      return a.originalIndex - b.originalIndex;
    });
  }, [report?.comparison, sortByDrift]);

  const worstWorseningKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!report?.comparison) return keys;
    // Task #1018 — acknowledged rows are excluded from the red highlight so
    // an operator who has already triaged a regression isn't shouted at on
    // every re-run.
    const worse = report.comparison.filter(
      (r) =>
        r.drift === "worse" &&
        r.delta != null &&
        Number.isFinite(r.delta) &&
        r.acknowledgement == null,
    );
    worse.sort((a, b) => Math.abs(b.delta as number) - Math.abs(a.delta as number));
    for (const r of worse.slice(0, WORST_HIGHLIGHT_COUNT)) keys.add(r.key);
    return keys;
  }, [report?.comparison]);

  const summary = useMemo(() => {
    if (!report) return { pass: 0, warn: 0, fail: 0 };
    return report.groups
      .flatMap((g) => g.checks)
      .reduce(
        (acc, c) => {
          acc[c.status]++;
          return acc;
        },
        { pass: 0, warn: 0, fail: 0 } as Record<CheckStatus, number>,
      );
  }, [report]);

  if (!enabled) return null;

  return (
    <Card data-testid="card-post-deploy-verification">
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="w-5 h-5 text-primary" />
            <CardTitle
              className="text-foreground"
              data-testid="text-post-deploy-title"
            >
              Post-deploy verification
            </CardTitle>
            {report && <StatusBadge status={report.overall} />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMut.mutate()}
              disabled={reportQ.isFetching || refreshMut.isPending}
              data-testid="button-run-verification"
            >
              <RefreshCw
                className={`w-3 h-3 mr-1 ${
                  reportQ.isFetching || refreshMut.isPending ? "animate-spin" : ""
                }`}
              />
              {report ? "Re-run checklist" : "Run checklist"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => baselineMut.mutate()}
              disabled={baselineMut.isPending || !report}
              data-testid="button-save-baseline"
            >
              <Save className="w-3 h-3 mr-1" />
              Save as baseline
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmForceResolveOpen(true)}
              disabled={forceMut.isPending}
              data-testid="button-force-resolve-legacy"
            >
              <Wrench className="w-3 h-3 mr-1" />
              Force-resolve legacy
            </Button>
            <AlertDialog
              open={confirmForceResolveOpen}
              onOpenChange={setConfirmForceResolveOpen}
            >
              <AlertDialogContent data-testid="dialog-confirm-force-resolve-legacy">
                <AlertDialogHeader>
                  <AlertDialogTitle>Force-resolve legacy stuck incidents?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Marks every legacy stuck incident as resolved without
                    re-checking it. This is the documented escape hatch for the
                    old db_latency probe rollout — a genuinely active incident
                    force-resolved here stops alerting until it re-fires.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-force-resolve-abort">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    data-testid="button-force-resolve-confirm"
                    onClick={() => {
                      setConfirmForceResolveOpen(false);
                      forceMut.mutate();
                    }}
                  >
                    Force-resolve
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
        {report && (
          <div
            className="text-xs text-muted-foreground mt-2"
            data-testid="text-verification-meta"
          >
            Last run {fmtTs(report.generatedAt)} · {summary.pass} pass ·{" "}
            {summary.warn} warn · {summary.fail} fail
            {report.baseline ? (
              isAutoBaseline(report.baseline) ? (
                <>
                  {" "}
                  · baseline auto-saved at {fmtTs(report.baseline.savedAt)}
                </>
              ) : (
                <>
                  {" "}
                  · baseline saved {fmtTs(report.baseline.savedAt)}
                  {report.baseline.savedBy
                    ? ` by ${report.baseline.savedBy}`
                    : ""}
                </>
              )
            ) : (
              " · no baseline saved yet"
            )}
          </div>
        )}
        {report && (
          <div
            className="flex items-center gap-2 mt-2"
            data-testid="row-auto-baseline-toggle"
          >
            <Switch
              id="auto-baseline-toggle"
              checked={report.autoBaseline.enabled}
              onCheckedChange={(v) => autoBaselineMut.mutate(!!v)}
              disabled={autoBaselineMut.isPending}
              data-testid="switch-auto-baseline"
            />
            <Label
              htmlFor="auto-baseline-toggle"
              className="text-xs text-muted-foreground"
            >
              Auto-save baseline ~5 min after each clean boot
              {autoBaselineMut.isPending ? " (saving…)" : ""}
            </Label>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {reportQ.isLoading && (
          <div
            className="text-sm text-muted-foreground"
            data-testid="text-verification-loading"
          >
            Running checklist…
          </div>
        )}
        {reportQ.error && (
          <div
            className="text-sm text-red-700 flex items-center gap-2"
            data-testid="text-verification-error"
          >
            <XCircle className="w-4 h-4" />
            {String((reportQ.error as any)?.message ?? reportQ.error)}
          </div>
        )}

        {report?.groups.map((group) => (
          <div
            key={group.id}
            className="border rounded-md"
            data-testid={`group-${group.id}`}
          >
            <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b">
              <div className="flex items-center gap-2">
                <StatusIcon status={group.status} />
                <span
                  className="font-medium text-sm"
                  data-testid={`text-group-title-${group.id}`}
                >
                  {group.title}
                </span>
              </div>
              <StatusBadge status={group.status} />
            </div>
            <div>
              {group.checks.map((c) => (
                <div
                  key={c.id}
                  className="flex items-start gap-3 px-3 py-2 border-b last:border-b-0"
                  data-testid={`row-check-${c.id}`}
                >
                  <div className="pt-0.5">
                    <StatusIcon status={c.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium" data-testid={`text-check-label-${c.id}`}>
                      {c.label}
                    </div>
                    <div
                      className="text-xs text-muted-foreground break-words"
                      data-testid={`text-check-detail-${c.id}`}
                    >
                      {c.detail}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {report &&
          (report.comparison.length > 0 ||
            (report.baselines && report.baselines.length > 0) ||
            (report.baselineTrash && report.baselineTrash.length > 0)) && (
          <div
            className="border rounded-md"
            data-testid="section-comparison"
          >
            <div className="px-3 py-2 bg-muted/40 border-b flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">
                  Compare to last deploy
                </span>
                {report.baseline && (
                  <span className="text-xs text-muted-foreground">
                    baseline: {fmtTs(report.baseline.savedAt)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div
                  className="flex items-center gap-2"
                  data-testid="row-sort-toggle"
                >
                  <Switch
                    id="sort-by-drift-toggle"
                    checked={sortByDrift}
                    onCheckedChange={(v) => setSortByDrift(!!v)}
                    data-testid="switch-sort-by-drift"
                  />
                  <Label
                    htmlFor="sort-by-drift-toggle"
                    className="text-xs text-muted-foreground"
                  >
                    {sortByDrift
                      ? "Sorting by worst drift"
                      : "Sorting by group order"}
                  </Label>
                </div>
              {report.baselines && report.baselines.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Label
                    htmlFor="baseline-picker"
                    className="text-xs text-muted-foreground"
                  >
                    Baseline:
                  </Label>
                  <Select
                    value={
                      report.baseline
                        ? String(report.baseline.id)
                        : String(report.baselines[0].id)
                    }
                    onValueChange={(v) => {
                      const n = Number(v);
                      setSelectedBaselineId(Number.isFinite(n) ? n : null);
                    }}
                    disabled={reportQ.isFetching}
                  >
                    <SelectTrigger
                      id="baseline-picker"
                      className="h-7 w-full sm:w-[260px] text-xs"
                      data-testid="select-baseline"
                    >
                      <SelectValue placeholder="Most recent" />
                    </SelectTrigger>
                    <SelectContent>
                      {report.baselines.map((b, idx) => {
                        const auto = isAutoBaseline(b);
                        const who = auto
                          ? "auto"
                          : b.savedBy ?? "operator";
                        const status = b.overallStatus
                          ? b.overallStatus.toUpperCase()
                          : "—";
                        const label = `${fmtTs(b.savedAt)} · ${who} · ${status}${idx === 0 ? " (latest)" : ""}`;
                        return (
                          <SelectItem
                            key={b.id}
                            value={String(b.id)}
                            data-testid={`option-baseline-${b.id}`}
                          >
                            {label}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}
              </div>
            </div>
            {report.baselines && report.baselines.length > 0 && (
              <div
                className="px-3 py-2 border-b bg-muted/20"
                data-testid="list-baseline-history"
              >
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Baseline history ({report.baselines.length})
                </div>
                <ul className="space-y-1">
                  {report.baselines.map((b, idx) => {
                    const auto = isAutoBaseline(b);
                    const who = auto ? "auto" : b.savedBy ?? "operator";
                    const status = b.overallStatus
                      ? b.overallStatus.toUpperCase()
                      : "—";
                    const isSelected =
                      (report.baseline?.id ?? report.baselines[0]?.id) === b.id;
                    return (
                      <li
                        key={b.id}
                        className="flex items-center justify-between gap-2 text-xs"
                        data-testid={`row-baseline-${b.id}`}
                      >
                        <span className="truncate">
                          {fmtTs(b.savedAt)} · {who} · {status}
                          {idx === 0 ? " (latest)" : ""}
                          {isSelected ? " · selected" : ""}
                        </span>
                        <ConfirmActionDialog
                          title="Delete this saved baseline?"
                          description={`Baseline saved ${fmtTs(b.savedAt)} will be moved to "Recently deleted"${isSelected ? " (it is the currently selected comparison baseline)" : ""}. You can restore it from there within 24 hours; after that it is gone.`}
                          confirmLabel="Delete baseline"
                          testId={`dialog-confirm-delete-baseline-${b.id}`}
                          onConfirm={() => {
                            deleteBaselineMut.mutate({
                              id: b.id,
                              wasSelected: isSelected,
                            });
                          }}
                          trigger={
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-red-600 hover:text-red-700"
                              disabled={
                                deleteBaselineMut.isPending &&
                                deleteBaselineMut.variables?.id === b.id
                              }
                              data-testid={`button-delete-baseline-${b.id}`}
                              aria-label={`Delete baseline ${fmtTs(b.savedAt)}`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {report.baselineTrash && report.baselineTrash.length > 0 && (
              <div
                className="px-3 py-2 border-b bg-muted/10"
                data-testid="section-baseline-trash"
              >
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => setTrashExpanded((v) => !v)}
                  data-testid="button-toggle-baseline-trash"
                  aria-expanded={trashExpanded}
                >
                  {trashExpanded ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                  Recently deleted ({report.baselineTrash.length})
                </button>
                {trashExpanded && (
                  <ul className="space-y-1 mt-2">
                    {report.baselineTrash.map((entry) => {
                      const auto = isAutoBaseline(entry.snapshot);
                      const who = auto
                        ? "auto"
                        : entry.snapshot.savedBy ?? "operator";
                      const status = entry.snapshot.overallStatus
                        ? entry.snapshot.overallStatus.toUpperCase()
                        : "—";
                      const isPending =
                        restoreBaselineMut.isPending &&
                        restoreBaselineMut.variables?.id === entry.snapshot.id;
                      return (
                        <li
                          key={entry.snapshot.id}
                          className="flex items-center justify-between gap-2 text-xs"
                          data-testid={`row-trash-baseline-${entry.snapshot.id}`}
                        >
                          <span className="truncate text-muted-foreground">
                            {fmtTs(entry.snapshot.savedAt)} · {who} · {status} ·
                            deleted {fmtTs(entry.deletedAt)}
                            {entry.deletedBy ? ` by ${entry.deletedBy}` : ""}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-primary-ink hover:text-primary-ink/90"
                            onClick={() =>
                              restoreBaselineMut.mutate({
                                id: entry.snapshot.id,
                              })
                            }
                            disabled={isPending}
                            data-testid={`button-restore-baseline-${entry.snapshot.id}`}
                            aria-label={`Restore baseline ${fmtTs(entry.snapshot.savedAt)}`}
                          >
                            <Undo2 className="w-3 h-3 mr-1" />
                            Restore
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            <div className="os-table-wrap">
              <table className="w-full text-sm os-sticky-col">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="text-left px-3 py-2 font-medium">Metric</th>
                    <th className="text-right px-3 py-2 font-medium">Baseline</th>
                    <th className="text-right px-3 py-2 font-medium">Current</th>
                    <th className="text-right px-3 py-2 font-medium">Δ</th>
                    <th className="text-right px-3 py-2 font-medium">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedComparison.map(({ row }) => {
                    const isWorst = worstWorseningKeys.has(row.key);
                    const ack = row.acknowledgement;
                    const ackPending =
                      (acknowledgeMut.isPending &&
                        acknowledgeMut.variables?.metricKey === row.key) ||
                      (unacknowledgeMut.isPending &&
                        unacknowledgeMut.variables?.metricKey === row.key);
                    // Only highlighted rows (or already-acknowledged ones) get
                    // the Acknowledge affordance — there's nothing to silence
                    // for a row that's already passing or unchanged.
                    const showAckButton =
                      report.baseline != null && (isWorst || ack != null);
                    return (
                    <tr
                      key={row.key}
                      className={`border-b last:border-b-0 ${
                        isWorst
                          ? "bg-red-50/70 dark:bg-red-950/25 [--os-sticky-col-bg:color-mix(in_srgb,var(--color-red-50)_70%,hsl(var(--os-table-surface)))] dark:[--os-sticky-col-bg:color-mix(in_srgb,var(--color-red-950)_25%,hsl(var(--os-table-surface)))]"
                          : ""
                      } ${ack != null ? "opacity-70" : ""}`}
                      data-testid={`row-compare-${row.key}`}
                      data-worst-drift={isWorst ? "true" : undefined}
                      data-acknowledged={ack != null ? "true" : undefined}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span>{row.label}</span>
                          {showAckButton && report.baseline != null && (
                            ack != null ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() =>
                                  unacknowledgeMut.mutate({
                                    baselineId: report.baseline!.id,
                                    metricKey: row.key,
                                  })
                                }
                                disabled={ackPending}
                                data-testid={`button-unacknowledge-${row.key}`}
                                aria-label={`Undo acknowledgement for ${row.label}`}
                              >
                                <Undo2 className="w-3 h-3 mr-1" />
                                Undo
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs text-primary-ink"
                                onClick={() =>
                                  acknowledgeMut.mutate({
                                    baselineId: report.baseline!.id,
                                    metricKey: row.key,
                                  })
                                }
                                disabled={ackPending}
                                data-testid={`button-acknowledge-${row.key}`}
                                aria-label={`Acknowledge ${row.label}`}
                              >
                                <CheckCheck className="w-3 h-3 mr-1" />
                                Acknowledge
                              </Button>
                            )
                          )}
                        </div>
                        {ack != null && (
                          <div
                            className="text-xs text-muted-foreground mt-0.5"
                            data-testid={`text-ack-${row.key}`}
                          >
                            acknowledged by {ack.by ?? "operator"} ·{" "}
                            {fmtTs(ack.at)}
                          </div>
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        data-testid={`text-baseline-${row.key}`}
                      >
                        {fmtNum(row.baseline)}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        data-testid={`text-current-${row.key}`}
                      >
                        {fmtNum(row.current)}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        data-testid={`text-delta-${row.key}`}
                      >
                        <span className="inline-flex items-center justify-end gap-1">
                          <DriftIcon drift={row.drift} />
                          {row.delta == null
                            ? "—"
                            : `${row.delta > 0 ? "+" : ""}${fmtNum(row.delta)}`}
                        </span>
                      </td>
                      <td
                        className="px-3 py-2 text-right"
                        data-testid={`cell-trend-${row.key}`}
                      >
                        <MetricSparkline
                          rowKey={row.key}
                          label={row.label}
                          baselines={report.baselines ?? []}
                          current={row.current}
                          generatedAt={report.generatedAt}
                        />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {report && !report.baseline && (
          <div
            className="text-xs text-muted-foreground"
            data-testid="text-no-baseline-hint"
          >
            {report.autoBaseline.enabled
              ? "Tip: a baseline will be auto-saved a few minutes after each clean boot (overall status must be pass). Click \"Save as baseline\" to capture one immediately."
              : "Tip: auto-snapshot is disabled. Click \"Save as baseline\" after a clean deploy so the next run can flag attribution / freshness drift at a glance."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
