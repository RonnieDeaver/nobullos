// Task #2686 — Live Data tab component.
//
// Displays current-period marketing metrics pulled from BigQuery via the
// hourly scheduler, plus a simple 6-period trend sparkline (Recharts).
// Reads from stored snapshots — never hits BigQuery directly on page load.
//
// Empty / unconfigured states are explicit and plain-English — never a fake
// zero or a silent crash. Matches the Beige & Burgundy design system.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { svgSafeId } from "@/lib/svgSafeId";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  AlertCircle,
  Info,
  BarChart3,
  Clock,
} from "lucide-react";
import { format, parseISO } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────

type LiveDataMetricStatus = "ok" | "not-configured" | "no-data" | "error";

interface LiveDataMetric {
  key: string;
  label: string;
  value: number | null;
  unitLabel: string | null;
  status: LiveDataMetricStatus;
  reason: string | null;
}

interface LiveDataTrendPoint {
  period: string;
  fetchedAt: string;
  overallStatus: string;
  metrics: LiveDataMetric[];
}

interface LiveDataSnapshotResponse {
  id: string;
  period: string;
  fetchedAt: string;
  overallStatus: string;
  metrics: LiveDataMetric[];
}

interface LiveDataResponse {
  clientId: string;
  period: string;
  bigQueryConfigured: boolean;
  bigQueryKeyConfigured: boolean;
  canManage: boolean;
  snapshot: LiveDataSnapshotResponse | null;
  trend: LiveDataTrendPoint[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function formatMetricValue(value: number | null, unitLabel: string | null): string {
  if (value === null) return "—";
  const rounded = Number.isInteger(value) ? value : parseFloat(value.toFixed(2));
  if (unitLabel === "$" || unitLabel?.startsWith("$")) {
    return `$${rounded.toLocaleString()}`;
  }
  if (unitLabel === "%") {
    return `${rounded}%`;
  }
  if (unitLabel) {
    return `${rounded.toLocaleString()} ${unitLabel}`;
  }
  return rounded.toLocaleString();
}

function formatPeriodLabel(period: string): string {
  try {
    const [y, m] = period.split("-");
    const date = new Date(parseInt(y), parseInt(m) - 1, 1);
    return format(date, "MMM yyyy");
  } catch {
    return period;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────

function MetricStatusBadge({ status }: { status: LiveDataMetricStatus }) {
  if (status === "ok") {
    return (
      <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px] h-5">
        Live
      </Badge>
    );
  }
  if (status === "not-configured") {
    return (
      <Badge className="bg-muted text-muted-foreground border-border text-[10px] h-5">
        Not configured
      </Badge>
    );
  }
  if (status === "no-data") {
    return (
      <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200 text-[10px] h-5">
        No data
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-100 text-red-700 border-red-200 text-[10px] h-5">
      Error
    </Badge>
  );
}

function MetricCard({ metric }: { metric: LiveDataMetric }) {
  const isOk = metric.status === "ok";
  return (
    <Card
      className="bg-card border-border"
      data-testid={`card-metric-${metric.key}`}
    >
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <span
            className="text-xs font-medium text-muted-foreground leading-snug"
            data-testid={`text-metric-label-${metric.key}`}
          >
            {metric.label}
          </span>
          <MetricStatusBadge status={metric.status} />
        </div>
        <div
          className="text-2xl font-bold text-foreground"
          data-testid={`text-metric-value-${metric.key}`}
        >
          {isOk ? formatMetricValue(metric.value, metric.unitLabel) : "—"}
        </div>
        {!isOk && metric.reason && (
          <p
            className="text-[11px] text-muted-foreground/70 mt-1 leading-snug"
            data-testid={`text-metric-reason-${metric.key}`}
          >
            {metric.reason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TrendChart({
  metricKey,
  metricLabel,
  trend,
  unitLabel,
}: {
  metricKey: string;
  metricLabel: string;
  trend: LiveDataTrendPoint[];
  unitLabel: string | null;
}) {
  const data = trend
    .filter((t) => {
      const m = t.metrics.find((mx) => mx.key === metricKey);
      return m?.status === "ok" && m.value !== null;
    })
    .map((t) => {
      const m = t.metrics.find((mx) => mx.key === metricKey)!;
      return {
        period: formatPeriodLabel(t.period),
        value: m.value as number,
      };
    })
    .reverse();

  if (data.length < 2) return null;

  const first = data[0].value;
  const last = data[data.length - 1].value;
  const delta = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
  const up = delta > 0;
  const down = delta < 0;

  return (
    <div
      className="space-y-1"
      data-testid={`chart-trend-${metricKey}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{metricLabel}</span>
        <span
          className={`flex items-center gap-0.5 text-xs font-medium ${
            up ? "text-green-600" : down ? "text-red-500" : "text-muted-foreground"
          }`}
          data-testid={`text-trend-delta-${metricKey}`}
        >
          {up ? (
            <TrendingUp className="w-3 h-3" />
          ) : down ? (
            <TrendingDown className="w-3 h-3" />
          ) : (
            <Minus className="w-3 h-3" />
          )}
          {Math.abs(delta).toFixed(1)}%
        </span>
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <AreaChart data={data} margin={{ top: 2, right: 4, left: 4, bottom: 2 }}>
          <defs>
            {/* Task #4430 — dynamic gradient ids sanitize via svgSafeId or an
                invalid url(#id) paint renders the area OPAQUE BLACK. */}
            <linearGradient id={`grad-${svgSafeId(metricKey)}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
              <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="period"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis hide />
          <Tooltip
            contentStyle={{
              fontSize: 11,
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              backgroundColor: "hsl(var(--card))",
              color: "hsl(var(--foreground))",
            }}
            formatter={(v: number) => [formatMetricValue(v, unitLabel), metricLabel]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            fill={`url(#grad-${svgSafeId(metricKey)})`}
            dot={{ r: 2, fill: "hsl(var(--primary))" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Not-configured state ─────────────────────────────────────────────

function NotConfiguredState({
  bigQueryConfigured,
  bigQueryKeyConfigured,
}: {
  bigQueryConfigured: boolean;
  bigQueryKeyConfigured: boolean;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center py-16 px-4 text-center"
      data-testid="state-not-configured"
    >
      <div className="w-12 h-12 rounded-full bg-primary/8 flex items-center justify-center mb-4">
        <BarChart3 className="w-6 h-6 text-primary/40" />
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-2">
        Live Data not configured
      </h3>
      {!bigQueryConfigured ? (
        <p className="text-xs text-muted-foreground/70 max-w-xs leading-relaxed">
          BigQuery is not connected on this system. An admin needs to configure
          the BigQuery credentials in System Settings before Live Data can pull
          marketing metrics.
        </p>
      ) : !bigQueryKeyConfigured ? (
        <p className="text-xs text-muted-foreground/70 max-w-xs leading-relaxed">
          This client has no BigQuery data key set. Configure the key in the RIS
          Client Bindings panel, then enable the Live Data auto-pull in System
          Settings.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground/70 max-w-xs leading-relaxed">
          No metrics are mapped for this client yet. Configure the BigQuery
          mappings in the RIS auto-source mapping registry, then trigger a
          refresh from this page.
        </p>
      )}
    </div>
  );
}

// ─── No-snapshot state ────────────────────────────────────────────────

function NoSnapshotState() {
  return (
    <div
      className="flex flex-col items-center justify-center py-16 px-4 text-center"
      data-testid="state-no-snapshot"
    >
      <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center mb-4">
        <Clock className="w-6 h-6 text-blue-400" />
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-2">
        No data yet for this period
      </h3>
      <p className="text-xs text-muted-foreground/70 max-w-xs leading-relaxed">
        The scheduler hasn't run yet for this period, or no data matched the
        configured BigQuery queries. Use the Refresh button to trigger a pull now.
      </p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────

interface LiveDataTabProps {
  clientId: string;
  canManage: boolean;
}

export default function LiveDataTab({ clientId, canManage }: LiveDataTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const queryKey = ["/api/live-data/clients", clientId];

  const { data, isLoading, isError } = useQuery<LiveDataResponse>({
    queryKey,
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/live-data/clients/${clientId}`, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error("Failed to load Live Data");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/live-data/clients/${clientId}/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Refresh failed");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey }); // fire-and-forget: cache refresh only
      toast({
        title: "Live Data refreshed",
        description: "BigQuery pull complete — metrics updated.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Refresh failed",
        description: err?.message ?? "Could not pull BigQuery data",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="live-data-loading">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-red-600 py-8"
        data-testid="live-data-error"
      >
        <AlertCircle className="w-4 h-4 shrink-0" />
        Failed to load Live Data. Please refresh the page.
      </div>
    );
  }

  const snapshot = data?.snapshot ?? null;
  const trend = data?.trend ?? [];
  const bigQueryConfigured = data?.bigQueryConfigured ?? false;
  const bigQueryKeyConfigured = data?.bigQueryKeyConfigured ?? false;
  const serverCanManage = data?.canManage ?? false;
  const hasData = snapshot !== null;

  const snapshotMetrics: LiveDataMetric[] = (snapshot?.metrics ?? []) as LiveDataMetric[];
  const okMetrics = snapshotMetrics.filter((m) => m.status === "ok");

  // "All metrics not-configured" only applies when a snapshot exists but every
  // metric degenerated — e.g. the mapping registry is empty for this client.
  const allMetricsNotConfigured =
    hasData && snapshotMetrics.length > 0 &&
    snapshotMetrics.every((m) => m.status === "not-configured");

  // Show NotConfiguredState when:
  //   • BQ is not globally connected, OR
  //   • client has no BQ data key set, OR
  //   • snapshot exists but every metric degenerated to "not-configured"
  const isNotConfigured =
    !bigQueryConfigured || !bigQueryKeyConfigured || allMetricsNotConfigured;
  // Show NoSnapshotState when: BQ is connected + client has a key but no pull has run yet.
  const isNoSnapshot = bigQueryConfigured && bigQueryKeyConfigured && !hasData;

  // Metrics to show in trend (ones that have at least one "ok" reading).
  const trendableKeys = new Set<string>();
  for (const point of trend) {
    for (const m of point.metrics) {
      if (m.status === "ok" && m.value !== null) {
        trendableKeys.add(m.key);
      }
    }
  }

  return (
    <div className="space-y-6" data-testid="live-data-tab">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Live Marketing Data
          </h2>
          {snapshot && (
            <p
              className="text-xs text-muted-foreground/70 mt-0.5"
              data-testid="text-last-refreshed"
            >
              Last refreshed:{" "}
              {format(
                typeof snapshot.fetchedAt === "string"
                  ? parseISO(snapshot.fetchedAt)
                  : snapshot.fetchedAt,
                "MMM d, yyyy 'at' h:mm a",
              )}
              {" · "}
              {formatPeriodLabel(snapshot.period)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {snapshot && (
            <Badge
              className={
                snapshot.overallStatus === "ok"
                  ? "bg-green-100 text-green-700 border-green-200"
                  : snapshot.overallStatus === "partial"
                  ? "bg-yellow-100 text-yellow-700 border-yellow-200"
                  : snapshot.overallStatus === "not-configured"
                  ? "bg-muted text-muted-foreground border-border"
                  : "bg-red-100 text-red-700 border-red-200"
              }
              data-testid="badge-overall-status"
            >
              {snapshot.overallStatus === "ok"
                ? "All metrics live"
                : snapshot.overallStatus === "partial"
                ? "Partial data"
                : snapshot.overallStatus === "not-configured"
                ? "Not configured"
                : "Pull error"}
            </Badge>
          )}
          {serverCanManage && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs border-primary/20 text-primary-ink hover:bg-primary/5"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              data-testid="button-refresh-live-data"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 mr-1.5 ${
                  refreshMutation.isPending ? "animate-spin" : ""
                }`}
              />
              {refreshMutation.isPending ? "Pulling…" : "Refresh now"}
            </Button>
          )}
        </div>
      </div>

      {/* Not configured: BQ not connected globally, no client key, or all metrics degenerated */}
      {isNotConfigured && (
        <NotConfiguredState
          bigQueryConfigured={bigQueryConfigured}
          bigQueryKeyConfigured={bigQueryKeyConfigured}
        />
      )}

      {/* No snapshot yet: BQ key is configured but no pull has run for this period */}
      {isNoSnapshot && <NoSnapshotState />}

      {/* Metric cards: snapshot exists and at least one metric is not "not-configured" */}
      {hasData && !isNotConfigured && (
        <>
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="grid-metrics"
          >
            {snapshotMetrics.map((metric) => (
              <MetricCard key={metric.key} metric={metric} />
            ))}
          </div>

          {/* Info note when some metrics aren't yet configured */}
          {okMetrics.length < snapshotMetrics.length && (
            <div
              className="flex items-start gap-2 p-3 rounded-lg bg-surface-warm-1/60 border border-primary/8 text-xs text-muted-foreground"
              data-testid="note-partial-metrics"
            >
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary/40" />
              Some metrics are not yet configured or returned no data. Configure
              the BigQuery mappings in the RIS auto-source mapping registry to
              enable them.
            </div>
          )}

          {/* Trend charts */}
          {trend.length >= 2 && trendableKeys.size > 0 && (
            <Card
              className="bg-card border-border"
              data-testid="card-trend"
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-foreground flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  Month-over-month trend
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-6 sm:grid-cols-2">
                  {snapshotMetrics
                    .filter((m) => trendableKeys.has(m.key))
                    .map((m) => (
                      <TrendChart
                        key={m.key}
                        metricKey={m.key}
                        metricLabel={m.label}
                        trend={trend}
                        unitLabel={m.unitLabel}
                      />
                    ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
