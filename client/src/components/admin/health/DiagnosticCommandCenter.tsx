/**
 * Diagnostic Command Center panels (introduced by Task #861).
 *
 * Self-contained section that renders on top of the existing Health Dashboard:
 *  - Overview / SLO / regression banner
 *  - Telemetry freshness badges
 *  - Open incidents (ack / snooze / resolve)
 *  - Pool state attribution (api + worker)
 *  - DB server-side metrics (slow queries, locks, table health, availability)
 *  - Markdown report export
 *  - Slack digest controls
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Download,
  RefreshCw,
  Send,
  Sparkles,
  Activity,
} from "lucide-react";

interface OverviewWindow {
  okPct: number;
  degradedPct: number;
  errorPct: number;
  sampleCount: number;
}
interface OverviewResponse {
  currentStatus: "ok" | "degraded" | "error";
  windows: { h24: OverviewWindow; d7: OverviewWindow; d30: OverviewWindow };
  latency: {
    roundTripP95Ms: number | null;
    roundTripP99Ms: number | null;
    dbProbeP95Ms: number | null;
    dbProbeP99Ms: number | null;
  };
  slo: { errorBudgetTargetPct: number; errorBudgetUsedPct: number; errorBudgetRemainingPct: number };
  regression: { isRegression: boolean; metric: string; currentP95: number; baselineP95: number; deltaPct: number; summary: string } | null;
  incidents: { openCount: number; last24hCount: number };
}

interface FreshnessRow {
  table: string;
  status: "healthy" | "delayed" | "missing" | "disabled";
  rowsLastHour: number;
  rowsLast24h: number;
  lastSampleTimestamp: number | null;
  expectedCadenceSeconds: number;
  notes?: string;
}

interface IncidentRow {
  id: number;
  fingerprint: string;
  metric: string;
  severity: "warning" | "critical";
  title: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  peakValue: number;
  latestValue: number;
  threshold: number;
  status: "firing" | "acknowledged" | "snoozed" | "resolved";
  acknowledgedBy?: string | null;
  snoozedUntil?: number | null;
}

interface PoolStateRow {
  id: number;
  sampledAt: number;
  poolName: string;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  maxCount: number;
  utilizationPct: number;
  slowAcquiresInInterval: number;
  slowHoldsInInterval: number;
  topHoldLabels: any;
  unknownLabelPct: number;
}

interface SlowQueryRow {
  query: string;
  calls: number;
  totalTimeMs: number;
  meanTimeMs: number;
  rows: number;
}
interface LockRow {
  blockedPid: number;
  blockingPid: number | null;
  blockedQuery: string;
  blockingQuery: string | null;
  waitDurationMs: number;
  relation: string | null;
  lockType: string | null;
  state: string | null;
}
// Task #3814 — per-table size trend (server: buildTableSizeTrendSummary).
interface TableSizeTrendEntry {
  table: string;
  bandMb: number;
  rowRetention: string;
  retentionNote: string;
  latest: {
    sampledAt: number;
    totalMb: number;
    tableMb: number;
    indexMb: number;
    liveTuples: number;
    deadTuples: number;
  } | null;
  deltaMb: number | null;
  sampleCount: number;
  overBand: boolean;
}

interface TableSizeTrendSummary {
  windowMs: number;
  enabled: boolean;
  tables: TableSizeTrendEntry[];
}

interface TableHealthRow {
  schema: string;
  table: string;
  liveTuples: number;
  deadTuples: number;
  deadTupleRatio: number;
  tableSizeBytes: number;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
}
interface MetricAvailabilityStatus {
  feature: string;
  available: boolean;
  reason?: string;
  lastCheckedAt: number;
}
interface MetricAvailabilityEnvelope {
  available: boolean;
  data: MetricAvailabilityStatus[];
  generatedAt: number;
}

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}
function fmtMs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${Math.round(n)}ms`;
}
function fmtAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString();
}

// ─── Task #1625 — silent polling helpers ───────────────────────────────────
// The DB Health page fires ~10 parallel polling queries on auto-refresh.
// Any transient `Failed to fetch` (dev reload, slow pg_stat_*, brief blip)
// used to surface as a generic global "Request failed — Network error"
// toast via `QueryCache.onError` in `queryClient.ts`. We instead opt these
// reads out of the global toast (`meta.silent`), retry transient network /
// 5xx failures with bounded exponential backoff, give each fetch a hard
// timeout via AbortController, and render inline per-card error UI.
//
// Mutations on this page (ack/snooze/resolve, digest save / send-now) are
// intentionally left untouched and continue to surface the standard
// "Action failed" toast through `MutationCache.onError`.

class HealthHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`${status}: ${body}`);
    this.name = "HealthHttpError";
  }
}

function isHealthNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const msg = err.message || "";
  return msg.includes("Failed to fetch") || msg.includes("NetworkError");
}

function shouldRetryHealthQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false; // up to 3 attempts total
  if (error instanceof HealthHttpError) {
    return error.status >= 500; // retry 5xx, never retry 4xx
  }
  return isHealthNetworkError(error);
}

function healthRetryDelay(attempt: number): number {
  // 500ms, 1s, 2s, capped at 4s
  return Math.min(500 * 2 ** attempt, 4000);
}

// Task #3816 — /api/health/request-metrics envelope.
interface RouteMetricsRow {
  route: string;
  count: number;
  rpm: number;
  err4xx: number;
  err5xx: number;
  err5xxRatePct: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
  lastSeenAt: number;
}
interface RouteMetricsResponse {
  generatedAt: number;
  windowMs: number;
  overall: RouteMetricsRow | null;
  routes: RouteMetricsRow[];
  trackedRoutes: number;
  alerts: {
    notificationId: string;
    breaching: Array<{ route: string; kind: string | null; streak: number; alerted: boolean }>;
    config: { p95Ms: number; errorRatePct: number; minCount: number; consecutiveBreaches: number };
    configSettingKey: string;
  };
  persistence: {
    lastFlush: { at: number; rows: number; error: string | null } | null;
    flushIntervalMs: number;
  };
}

async function fetchHealthJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { credentials: "include", signal: ctrl.signal });
    if (!r.ok) {
      let body = "";
      try { body = await r.text(); } catch { /* ignore */ }
      throw new HealthHttpError(r.status, body || r.statusText);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// Spread into every polling useQuery on this page.
const POLLING_QUERY_OPTIONS = {
  meta: { silent: true } as const,
  retry: shouldRetryHealthQuery,
  retryDelay: healthRetryDelay,
};

// Timeouts: 15s for pg_stat_* / diagnostic endpoints that can be slow,
// 10s for lighter overview/config/digest reads.
const TIMEOUT_DIAGNOSTIC_MS = 15_000;
const TIMEOUT_LIGHT_MS = 10_000;

function InlineQueryError({
  label,
  error,
  onRetry,
  testIdSuffix,
}: {
  label: string;
  error: unknown;
  onRetry: () => void;
  testIdSuffix: string;
}) {
  const detail =
    error instanceof Error ? error.message : error ? String(error) : "unknown error";
  const short = detail.length > 140 ? detail.slice(0, 140) + "…" : detail;
  return (
    <div
      className="rounded-md border border-amber-200 bg-amber-50 p-3 flex items-start justify-between gap-3"
      data-testid={`inline-error-${testIdSuffix}`}
    >
      <div className="text-sm text-amber-900 min-w-0">
        <div className="font-medium">Couldn't load {label} — retrying…</div>
        <div className="text-xs text-amber-800/80 mt-0.5 break-all">{short}</div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onRetry}
        data-testid={`button-inline-retry-${testIdSuffix}`}
      >
        <RefreshCw className="w-3 h-3 mr-1" /> Retry
      </Button>
    </div>
  );
}

function StatusPill({ status }: { status: "ok" | "degraded" | "error" }) {
  const cls =
    status === "ok"
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : status === "degraded"
      ? "bg-amber-100 text-amber-700 border-amber-200"
      : "bg-red-100 text-red-700 border-red-200";
  return (
    <Badge variant="outline" className={cls} data-testid={`status-pill-${status}`}>
      {status.toUpperCase()}
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: "warning" | "critical" }) {
  return (
    <Badge
      variant="outline"
      className={
        severity === "critical"
          ? "bg-red-100 text-red-700 border-red-200"
          : "bg-amber-100 text-amber-700 border-amber-200"
      }
      data-testid={`badge-severity-${severity}`}
    >
      {severity.toUpperCase()}
    </Badge>
  );
}

function FreshnessBadge({ status }: { status: "healthy" | "delayed" | "missing" | "disabled" }) {
  const map = {
    healthy: "bg-emerald-100 text-emerald-700 border-emerald-200",
    delayed: "bg-amber-100 text-amber-700 border-amber-200",
    missing: "bg-red-100 text-red-700 border-red-200",
    disabled: "bg-zinc-100 text-zinc-600 border-zinc-200",
  } as const;
  return (
    <Badge variant="outline" className={map[status]} data-testid={`badge-freshness-${status}`}>
      {status.toUpperCase()}
    </Badge>
  );
}

export function DiagnosticCommandCenter({ enabled }: { enabled: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [refreshTick, setRefreshTick] = useState(0);

  // ── data ──
  const overviewQ = useQuery<OverviewResponse>({
    queryKey: ["/api/health/overview", refreshTick],
    queryFn: () => fetchHealthJson<OverviewResponse>("/api/health/overview", TIMEOUT_LIGHT_MS),
    enabled,
    refetchInterval: 60_000,
    ...POLLING_QUERY_OPTIONS,
  });

  const freshnessQ = useQuery<{ freshness: FreshnessRow[] }>({
    queryKey: ["/api/health/freshness", refreshTick],
    queryFn: () => fetchHealthJson<{ freshness: FreshnessRow[] }>("/api/health/freshness", TIMEOUT_LIGHT_MS),
    enabled,
    refetchInterval: 60_000,
    ...POLLING_QUERY_OPTIONS,
  });

  const incidentsQ = useQuery<{ open: IncidentRow[]; recent: IncidentRow[] }>({
    queryKey: ["/api/health/incidents", refreshTick],
    queryFn: () => fetchHealthJson<{ open: IncidentRow[]; recent: IncidentRow[] }>("/api/health/incidents", TIMEOUT_LIGHT_MS),
    enabled,
    refetchInterval: 30_000,
    ...POLLING_QUERY_OPTIONS,
  });

  const poolQ = useQuery<{ since: number; latest: PoolStateRow[]; series: PoolStateRow[] }>({
    queryKey: ["/api/health/pool-state", refreshTick],
    queryFn: () =>
      fetchHealthJson<{ since: number; latest: PoolStateRow[]; series: PoolStateRow[] }>(
        "/api/health/pool-state",
        TIMEOUT_LIGHT_MS,
      ),
    enabled,
    refetchInterval: 60_000,
    ...POLLING_QUERY_OPTIONS,
  });

  const availabilityQ = useQuery<MetricAvailabilityEnvelope>({
    queryKey: ["/api/health/db/metric-availability", refreshTick],
    queryFn: () =>
      fetchHealthJson<MetricAvailabilityEnvelope>(
        "/api/health/db/metric-availability",
        TIMEOUT_DIAGNOSTIC_MS,
      ),
    enabled,
    refetchInterval: 5 * 60_000,
    ...POLLING_QUERY_OPTIONS,
  });

  const slowQ = useQuery<{ available: boolean; data: SlowQueryRow[]; generatedAt: number }>({
    queryKey: ["/api/health/db/slow-queries", refreshTick],
    queryFn: () =>
      fetchHealthJson<{ available: boolean; data: SlowQueryRow[]; generatedAt: number }>(
        "/api/health/db/slow-queries",
        TIMEOUT_DIAGNOSTIC_MS,
      ),
    enabled,
    refetchInterval: 60_000,
    ...POLLING_QUERY_OPTIONS,
  });

  const locksQ = useQuery<{ available: boolean; data: LockRow[]; generatedAt: number }>({
    queryKey: ["/api/health/db/locks", refreshTick],
    queryFn: () =>
      fetchHealthJson<{ available: boolean; data: LockRow[]; generatedAt: number }>(
        "/api/health/db/locks",
        TIMEOUT_DIAGNOSTIC_MS,
      ),
    enabled,
    refetchInterval: 30_000,
    ...POLLING_QUERY_OPTIONS,
  });

  const tablesQ = useQuery<{ available: boolean; data: TableHealthRow[]; generatedAt: number }>({
    queryKey: ["/api/health/db/table-health", refreshTick],
    queryFn: () =>
      fetchHealthJson<{ available: boolean; data: TableHealthRow[]; generatedAt: number }>(
        "/api/health/db/table-health",
        TIMEOUT_DIAGNOSTIC_MS,
      ),
    enabled,
    refetchInterval: 5 * 60_000,
    ...POLLING_QUERY_OPTIONS,
  });

  // Task #3816 — app-wide request spine: rolling per-route API latency /
  // error rates from the in-process aggregator + regression-alert state.
  const routeMetricsQ = useQuery<RouteMetricsResponse>({
    queryKey: ["/api/health/request-metrics", refreshTick],
    queryFn: () =>
      fetchHealthJson<RouteMetricsResponse>(
        "/api/health/request-metrics?limit=40",
        TIMEOUT_LIGHT_MS,
      ),
    enabled,
    refetchInterval: 60_000,
    ...POLLING_QUERY_OPTIONS,
  });

  // Task #3814 — per-table size trend (covered high-churn tables).
  const sizeTrendQ = useQuery<TableSizeTrendSummary>({
    queryKey: ["/api/health/db/table-size-trend", refreshTick],
    queryFn: () =>
      fetchHealthJson<TableSizeTrendSummary>(
        "/api/health/db/table-size-trend?days=14",
        TIMEOUT_DIAGNOSTIC_MS,
      ),
    enabled,
    refetchInterval: 5 * 60_000,
    ...POLLING_QUERY_OPTIONS,
  });

  const digestConfigQ = useQuery<{
    enabled: boolean;
    hourUtc: number;
    snoozedUntil: number | null;
    channel: string | null;
    lastSentDate: string | null;
  }>({
    queryKey: ["/api/health/digest/config", refreshTick],
    queryFn: () =>
      fetchHealthJson<{
        enabled: boolean;
        hourUtc: number;
        snoozedUntil: number | null;
        channel: string | null;
        lastSentDate: string | null;
      }>("/api/health/digest/config", TIMEOUT_LIGHT_MS),
    enabled,
    ...POLLING_QUERY_OPTIONS,
  });

  // ── mutations ──
  const ackMut = useMutation({
    meta: { silent: true },
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/health/incidents/${id}/ack`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/health/incidents"] }); // fire-and-forget: cache refresh only
      toast({ title: "Acknowledged" });
    },
    onError: (e: any) => toast({ title: "Failed", description: String(e.message || e), variant: "destructive" }),
  });

  const snoozeMut = useMutation({
    meta: { silent: true },
    mutationFn: async ({ id, minutes }: { id: number; minutes: number }) => {
      const r = await fetch(`/api/health/incidents/${id}/snooze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ minutes }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/health/incidents"] }); // fire-and-forget: cache refresh only
      toast({ title: "Snoozed" });
    },
    onError: (e: any) => toast({ title: "Failed", description: String(e.message || e), variant: "destructive" }),
  });

  const resolveMut = useMutation({
    meta: { silent: true },
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/health/incidents/${id}/resolve`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/health/incidents"] }); // fire-and-forget: cache refresh only
      toast({ title: "Resolved" });
    },
    onError: (e: any) => toast({ title: "Failed", description: String(e.message || e), variant: "destructive" }),
  });

  const digestSendMut = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const r = await fetch("/api/health/digest/send-now", { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: data?.sent ? "Digest sent" : "Digest skipped", description: String(data?.reason ?? "") });
    },
    onError: (e: any) => toast({ title: "Failed", description: String(e.message || e), variant: "destructive" }),
  });

  const updateDigestMut = useMutation({
    meta: { silent: true },
    mutationFn: async (body: any) => {
      const r = await fetch("/api/health/digest/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/health/digest/config"] }); // fire-and-forget: cache refresh only
      toast({ title: "Digest config updated" });
    },
    onError: (e: any) => toast({ title: "Failed", description: String(e.message || e), variant: "destructive" }),
  });

  const overview = overviewQ.data;
  const freshness = freshnessQ.data?.freshness ?? [];
  const openIncidents = incidentsQ.data?.open ?? [];
  const recentIncidents = incidentsQ.data?.recent ?? [];
  const poolLatest = poolQ.data?.latest ?? [];
  const availability = availabilityQ.data;

  const reportUrl = (range: "24h" | "7d") => `/api/health/report?range=${range}`;

  const refreshAll = () => {
    setRefreshTick((t) => t + 1);
    void overviewQ.refetch(); // fire-and-forget: background refetch only
    void freshnessQ.refetch(); // fire-and-forget: background refetch only
    void incidentsQ.refetch(); // fire-and-forget: background refetch only
    void poolQ.refetch(); // fire-and-forget: background refetch only
    void availabilityQ.refetch(); // fire-and-forget: background refetch only
    void slowQ.refetch(); // fire-and-forget: background refetch only
    void locksQ.refetch(); // fire-and-forget: background refetch only
    void tablesQ.refetch(); // fire-and-forget: background refetch only
  };

  if (!enabled) return null;

  return (
    <div className="space-y-6" data-testid="section-task861">
      {/* ─── Header / actions ─── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-foreground" data-testid="text-task861-title">
            Diagnostic Command Center
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            data-testid="button-task861-refresh"
          >
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
          <Button asChild variant="outline" size="sm" data-testid="button-export-24h">
            <a href={reportUrl("24h")} target="_blank" rel="noreferrer">
              <Download className="w-3 h-3 mr-1" /> Export 24h
            </a>
          </Button>
          <Button asChild variant="outline" size="sm" data-testid="button-export-7d">
            <a href={reportUrl("7d")} target="_blank" rel="noreferrer">
              <Download className="w-3 h-3 mr-1" /> Export 7d
            </a>
          </Button>
        </div>
      </div>

      {/* ─── Overview / SLO / Regression ─── */}
      <Card data-testid="card-overview">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="w-4 h-4" /> Overview & SLO
            {overview && <StatusPill status={overview.currentStatus} />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {overviewQ.isError ? (
            <InlineQueryError
              label="overview"
              error={overviewQ.error}
              onRetry={() => overviewQ.refetch()}
              testIdSuffix="overview"
            />
          ) : !overview ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {(["h24", "d7", "d30"] as const).map((k) => {
                const w = overview.windows[k];
                const label = k === "h24" ? "24h" : k === "d7" ? "7d" : "30d";
                return (
                  <div
                    key={k}
                    className="rounded-md border p-3 space-y-1"
                    data-testid={`overview-window-${k}`}
                  >
                    <div className="text-xs uppercase text-muted-foreground">{label} window</div>
                    <div className="text-2xl font-semibold">{fmtPct(w.okPct)}</div>
                    <div className="text-xs text-muted-foreground">
                      ok / degraded {fmtPct(w.degradedPct)} / error {fmtPct(w.errorPct)}
                    </div>
                    <div className="text-xs text-muted-foreground">samples: {w.sampleCount}</div>
                  </div>
                );
              })}
              <div className="rounded-md border p-3 space-y-1" data-testid="overview-latency">
                <div className="text-xs uppercase text-muted-foreground">Round-trip</div>
                <div className="text-sm">p95: <span className="font-medium">{fmtMs(overview.latency.roundTripP95Ms)}</span></div>
                <div className="text-sm">p99: <span className="font-medium">{fmtMs(overview.latency.roundTripP99Ms)}</span></div>
                <div className="text-sm">db probe p95: <span className="font-medium">{fmtMs(overview.latency.dbProbeP95Ms)}</span></div>
                <div className="text-sm">db probe p99: <span className="font-medium">{fmtMs(overview.latency.dbProbeP99Ms)}</span></div>
              </div>
              <div className="rounded-md border p-3 space-y-1" data-testid="overview-slo">
                <div className="text-xs uppercase text-muted-foreground">Error Budget (30d)</div>
                <div className="text-2xl font-semibold">{fmtPct(overview.slo.errorBudgetRemainingPct)}</div>
                <div className="text-xs text-muted-foreground">
                  used {fmtPct(overview.slo.errorBudgetUsedPct)} of {fmtPct(overview.slo.errorBudgetTargetPct)}
                </div>
              </div>
              <div className="rounded-md border p-3 space-y-1" data-testid="overview-incidents">
                <div className="text-xs uppercase text-muted-foreground">Incidents</div>
                <div className="text-2xl font-semibold">{overview.incidents.openCount}</div>
                <div className="text-xs text-muted-foreground">
                  open · {overview.incidents.last24hCount} in last 24h
                </div>
              </div>
            </div>
          )}
          {overview?.regression?.isRegression && (
            <div
              className="mt-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800"
              data-testid="banner-regression"
            >
              <AlertTriangle className="w-4 h-4" />
              <span className="text-sm font-medium">{overview.regression.summary}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Telemetry freshness ─── */}
      <Card data-testid="card-freshness">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="w-4 h-4" /> Telemetry Freshness
          </CardTitle>
        </CardHeader>
        <CardContent>
          {freshnessQ.isError ? (
            <InlineQueryError
              label="telemetry freshness"
              error={freshnessQ.error}
              onRetry={() => freshnessQ.refetch()}
              testIdSuffix="freshness"
            />
          ) : freshness.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {freshness.map((f) => {
                const ageSec = f.lastSampleTimestamp != null
                  ? Math.max(0, Math.round((Date.now() - f.lastSampleTimestamp) / 1000))
                  : null;
                return (
                  <div
                    key={f.table}
                    className="rounded-md border p-2 flex items-center justify-between text-sm"
                    data-testid={`row-freshness-${f.table}`}
                  >
                    <div>
                      <div className="font-mono text-xs">{f.table}</div>
                      <div className="text-xs text-muted-foreground">
                        {f.rowsLastHour} rows / 1h · {f.rowsLast24h} / 24h · age {fmtAge(ageSec)}
                      </div>
                      {f.notes ? (
                        <div className="text-xs text-muted-foreground/80 mt-0.5" title={f.notes}>
                          {f.notes}
                        </div>
                      ) : null}
                    </div>
                    <FreshnessBadge status={f.status} />
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Incidents ─── */}
      <Card data-testid="card-incidents">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="w-4 h-4" /> Incidents
            <Badge variant="outline" className="ml-2">{openIncidents.length} open</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {incidentsQ.isError ? (
            <InlineQueryError
              label="incidents"
              error={incidentsQ.error}
              onRetry={() => incidentsQ.refetch()}
              testIdSuffix="incidents"
            />
          ) : (
            <Tabs defaultValue="open">
              <TabsList className="max-w-full flex-wrap h-auto">
                <TabsTrigger value="open" data-testid="tab-incidents-open">Open</TabsTrigger>
                <TabsTrigger value="recent" data-testid="tab-incidents-recent">Recent (7d)</TabsTrigger>
              </TabsList>
              <TabsContent value="open" className="mt-3">
                <IncidentTable
                  rows={openIncidents}
                  onAck={(id) => ackMut.mutate(id)}
                  onSnooze={(id) => snoozeMut.mutate({ id, minutes: 60 })}
                  onResolve={(id) => resolveMut.mutate(id)}
                />
              </TabsContent>
              <TabsContent value="recent" className="mt-3">
                <IncidentTable rows={recentIncidents} readonly />
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>

      {/* ─── Pool state ─── */}
      <Card data-testid="card-pool-state">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="w-4 h-4" /> DB Pool Attribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          {poolQ.isError ? (
            <InlineQueryError
              label="pool state"
              error={poolQ.error}
              onRetry={() => poolQ.refetch()}
              testIdSuffix="pool-state"
            />
          ) : poolLatest.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pool samples yet.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {poolLatest.map((p) => (
                <div key={p.id} className="rounded-md border p-3 space-y-2" data-testid={`pool-${p.poolName}`}>
                  <div className="flex items-center justify-between">
                    <div className="font-medium capitalize">{p.poolName} pool</div>
                    <Badge variant="outline">{p.utilizationPct}%</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    total {p.totalCount}/{p.maxCount} · idle {p.idleCount} · waiting {p.waitingCount}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    slow holds (interval): {p.slowHoldsInInterval} · unknown labels: {p.unknownLabelPct}%
                  </div>
                  <div>
                    <div className="text-xs uppercase text-muted-foreground mb-1">Top hold labels</div>
                    <ul className="text-xs space-y-0.5">
                      {(p.topHoldLabels?.byCount ?? []).slice(0, 5).map((l: any, i: number) => (
                        <li key={i} className="font-mono">
                          {l.label}: {l.count}
                        </li>
                      ))}
                      {(p.topHoldLabels?.byCount ?? []).length === 0 && (
                        <li className="text-muted-foreground">no labels</li>
                      )}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── DB server-side metrics ─── */}
      <Card data-testid="card-db-metrics">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="w-4 h-4" /> DB Server Metrics
          </CardTitle>
          {availability && availability.data.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              {availability.data.map((s) => (
                <span key={s.feature} className="flex items-center gap-1" data-testid={`availability-${s.feature}`}>
                  {s.available ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="w-3 h-3 text-amber-600" />
                  )}
                  <span>{s.feature}</span>
                </span>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="slow">
            <TabsList className="max-w-full flex-wrap h-auto">
              <TabsTrigger value="slow" data-testid="tab-db-slow">Slow Queries</TabsTrigger>
              <TabsTrigger value="locks" data-testid="tab-db-locks">Lock Waits</TabsTrigger>
              <TabsTrigger value="tables" data-testid="tab-db-tables">Table Health</TabsTrigger>
              <TabsTrigger value="size-trend" data-testid="tab-db-size-trend">Size Trend</TabsTrigger>
            </TabsList>
            <TabsContent value="slow" className="mt-3">
              {slowQ.isError ? (
                <InlineQueryError
                  label="slow queries"
                  error={slowQ.error}
                  onRetry={() => slowQ.refetch()}
                  testIdSuffix="slow-queries"
                />
              ) : !slowQ.data?.available ? (
                <p className="text-sm text-muted-foreground">Not available on this database.</p>
              ) : slowQ.data.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No slow queries reported.</p>
              ) : (
                <div className="space-y-2 max-h-72 overflow-auto">
                  {slowQ.data.data.map((q, i) => (
                    <div key={i} className="rounded-md border p-2 text-xs" data-testid={`row-slow-${i}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium">mean {Math.round(q.meanTimeMs)}ms · {q.calls} calls</span>
                        <span className="text-muted-foreground">total {Math.round(q.totalTimeMs)}ms</span>
                      </div>
                      <div className="font-mono text-xs whitespace-pre-wrap break-all">{q.query.slice(0, 240)}</div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
            <TabsContent value="locks" className="mt-3">
              {locksQ.isError ? (
                <InlineQueryError
                  label="lock waits"
                  error={locksQ.error}
                  onRetry={() => locksQ.refetch()}
                  testIdSuffix="locks"
                />
              ) : !locksQ.data?.available ? (
                <p className="text-sm text-muted-foreground">Not available.</p>
              ) : locksQ.data.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active lock waits.</p>
              ) : (
                <div className="space-y-2 max-h-72 overflow-auto">
                  {locksQ.data.data.map((l, i) => (
                    <div key={i} className="rounded-md border p-2 text-xs" data-testid={`row-lock-${i}`}>
                      <div>
                        pid {l.blockedPid} blocked by pid {l.blockingPid ?? "—"} · waited {Math.round(l.waitDurationMs)}ms
                        {l.relation ? ` · ${l.relation}` : ""}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground mt-1 break-all">
                        {(l.blockedQuery ?? "").slice(0, 200)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
            <TabsContent value="tables" className="mt-3">
              {tablesQ.isError ? (
                <InlineQueryError
                  label="table health"
                  error={tablesQ.error}
                  onRetry={() => tablesQ.refetch()}
                  testIdSuffix="table-health"
                />
              ) : !tablesQ.data?.available ? (
                <p className="text-sm text-muted-foreground">Not available.</p>
              ) : tablesQ.data.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bloated tables.</p>
              ) : (
                <div className="space-y-1 max-h-72 overflow-auto">
                  {tablesQ.data.data.map((t, i) => (
                    <div
                      key={i}
                      className="rounded-md border p-2 text-xs flex items-center justify-between"
                      data-testid={`row-table-${i}`}
                    >
                      <div className="font-mono">{t.schema}.{t.table}</div>
                      <div className="text-muted-foreground">
                        dead {t.deadTupleRatio}% · {t.deadTuples}/{t.liveTuples + t.deadTuples}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
            <TabsContent value="size-trend" className="mt-3">
              {sizeTrendQ.isError ? (
                <InlineQueryError
                  label="size trend"
                  error={sizeTrendQ.error}
                  onRetry={() => sizeTrendQ.refetch()}
                  testIdSuffix="size-trend"
                />
              ) : !sizeTrendQ.data ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <div className="space-y-2">
                  {!sizeTrendQ.data.enabled && (
                    <p className="text-xs text-amber-600" data-testid="text-size-trend-disabled">
                      Table-size watchdog is disabled — no new samples are being recorded. Enable it via the
                      production action "Enable table-size watchdog".
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Covered high-churn tables vs their expected size bands · Δ over last 14 days
                  </p>
                  <div className="space-y-1 max-h-72 overflow-auto">
                    {sizeTrendQ.data.tables.map((t) => (
                      <div
                        key={t.table}
                        className="rounded-md border p-2 text-xs"
                        data-testid={`row-size-trend-${t.table}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono truncate">{t.table}</span>
                            {t.overBand && (
                              <Badge variant="destructive" className="text-xs px-1.5 py-0" data-testid={`badge-over-band-${t.table}`}>
                                over band
                              </Badge>
                            )}
                          </div>
                          <div className="text-muted-foreground whitespace-nowrap">
                            {t.latest ? (
                              <>
                                <span className={t.overBand ? "text-red-600 font-medium" : ""}>
                                  {t.latest.totalMb} MB
                                </span>
                                {" "}/ band {t.bandMb} MB
                                {t.deltaMb !== null && (
                                  <span className={t.deltaMb > 0 ? "text-amber-600" : "text-emerald-600"}>
                                    {" "}· Δ {t.deltaMb > 0 ? "+" : ""}{t.deltaMb} MB
                                  </span>
                                )}
                              </>
                            ) : (
                              <span>no samples yet</span>
                            )}
                          </div>
                        </div>
                        {t.latest && (
                          <div className="text-muted-foreground mt-1">
                            table {t.latest.tableMb} MB + idx {t.latest.indexMb} MB ·{" "}
                            {t.latest.liveTuples.toLocaleString()} live / {t.latest.deadTuples.toLocaleString()} dead ·{" "}
                            {t.sampleCount} sample(s)
                          </div>
                        )}
                        <div className="text-muted-foreground/70 mt-0.5 truncate" title={t.retentionNote}>
                          retention: {t.retentionNote}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* ─── API route metrics (Task #3816 request spine) ─── */}
      <Card data-testid="card-request-metrics">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="w-4 h-4" /> API Route Metrics
          </CardTitle>
          {routeMetricsQ.data?.overall && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span data-testid="text-rm-overall">
                last {Math.round(routeMetricsQ.data.windowMs / 60_000)} min: {routeMetricsQ.data.overall.count} req
                {" "}· p50 {routeMetricsQ.data.overall.p50Ms}ms · p95 {routeMetricsQ.data.overall.p95Ms}ms
                {" "}· 5xx {routeMetricsQ.data.overall.err5xxRatePct}%
              </span>
              <span>{routeMetricsQ.data.trackedRoutes} routes tracked</span>
              {routeMetricsQ.data.persistence.lastFlush && (
                <span>
                  flush {routeMetricsQ.data.persistence.lastFlush.error ? "failed" : "ok"}{" "}
                  {new Date(routeMetricsQ.data.persistence.lastFlush.at).toLocaleTimeString()}
                </span>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {routeMetricsQ.isError ? (
            <InlineQueryError
              label="request metrics"
              error={routeMetricsQ.error}
              onRetry={() => routeMetricsQ.refetch()}
              testIdSuffix="request-metrics"
            />
          ) : !routeMetricsQ.data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="space-y-3">
              {routeMetricsQ.data.alerts.breaching.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2 space-y-1" data-testid="rm-breaching">
                  {routeMetricsQ.data.alerts.breaching.map((b) => (
                    <div key={b.route} className="flex items-center gap-2 text-xs">
                      {b.alerted ? (
                        <AlertTriangle className="w-3 h-3 text-red-600 shrink-0" />
                      ) : (
                        <Clock className="w-3 h-3 text-amber-600 shrink-0" />
                      )}
                      <span className="font-mono truncate">{b.route}</span>
                      <span className="text-muted-foreground whitespace-nowrap">
                        {b.kind === "error_rate" ? "5xx rate" : "p95"} over band · streak {b.streak}/
                        {routeMetricsQ.data!.alerts.config.consecutiveBreaches}
                        {b.alerted ? " · alerted" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {routeMetricsQ.data.routes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No API traffic in the window yet.</p>
              ) : (
                <Tabs defaultValue="traffic">
                  <TabsList>
                    <TabsTrigger value="traffic" data-testid="tab-rm-traffic">By Traffic</TabsTrigger>
                    <TabsTrigger value="p95" data-testid="tab-rm-p95">By p95</TabsTrigger>
                    <TabsTrigger value="errors" data-testid="tab-rm-errors">By 5xx</TabsTrigger>
                  </TabsList>
                  {(["traffic", "p95", "errors"] as const).map((mode) => {
                    const rows = [...routeMetricsQ.data!.routes].sort((a, b) =>
                      mode === "p95"
                        ? b.p95Ms - a.p95Ms
                        : mode === "errors"
                          ? b.err5xx - a.err5xx || b.err4xx - a.err4xx
                          : b.count - a.count,
                    );
                    return (
                      <TabsContent key={mode} value={mode} className="mt-3">
                        <div className="space-y-1 max-h-72 overflow-auto">
                          {rows.slice(0, 25).map((r, i) => (
                            <div
                              key={r.route}
                              className="rounded-md border p-2 text-xs flex items-center justify-between gap-2"
                              data-testid={`row-rm-${mode}-${i}`}
                            >
                              <span className="font-mono truncate min-w-0">{r.route}</span>
                              <span className="text-muted-foreground whitespace-nowrap">
                                {r.count} req · p50 {r.p50Ms} · p95{" "}
                                <span
                                  className={
                                    r.p95Ms > routeMetricsQ.data!.alerts.config.p95Ms
                                      ? "text-red-600 font-medium"
                                      : ""
                                  }
                                >
                                  {r.p95Ms}
                                </span>{" "}
                                · max {r.maxMs}ms
                                {r.err5xx > 0 ? (
                                  <span className="text-red-600"> · 5xx {r.err5xx} ({r.err5xxRatePct}%)</span>
                                ) : null}
                                {r.err4xx > 0 ? <span className="text-amber-600"> · 4xx {r.err4xx}</span> : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      </TabsContent>
                    );
                  })}
                </Tabs>
              )}
              <p className="text-xs text-muted-foreground">
                Rolling in-process window (per instance) · persisted every{" "}
                {Math.round(routeMetricsQ.data.persistence.flushIntervalMs / 60_000)} min · regression alert after{" "}
                {routeMetricsQ.data.alerts.config.consecutiveBreaches} consecutive breaches of p95 &gt;{" "}
                {routeMetricsQ.data.alerts.config.p95Ms}ms or 5xx &gt; {routeMetricsQ.data.alerts.config.errorRatePct}%
                (≥{routeMetricsQ.data.alerts.config.minCount} req) · tune via{" "}
                <code>{routeMetricsQ.data.alerts.configSettingKey}</code>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Slack digest ─── */}
      {digestConfigQ.isError ? (
        <Card data-testid="card-digest">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="w-4 h-4" /> Daily Slack Digest
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InlineQueryError
              label="digest config"
              error={digestConfigQ.error}
              onRetry={() => digestConfigQ.refetch()}
              testIdSuffix="digest-config"
            />
          </CardContent>
        </Card>
      ) : (
        <DigestPanel
          config={digestConfigQ.data}
          onSendNow={() => digestSendMut.mutate()}
          onSave={(body) => updateDigestMut.mutate(body)}
          onSnooze={(minutes) => updateDigestMut.mutate({ snoozeMinutes: minutes })}
        />
      )}

      {/* Task #711 — reserve-pressure spike digest ─── */}
      <ReservePressureDigestPanel refreshTick={refreshTick} enabled={enabled} />
    </div>
  );
}

// ─── Task #711 — reserve-pressure spike digest panel ───────────────────────

interface ReserveDigestConfig {
  enabled: boolean;
  cadence: "daily" | "weekly";
  hourUtc: number;
  weekdayUtc: number;
  windowHours: number;
  channel: string | null;
  snoozedUntil: number | null;
  lastSentKey: string | null;
  metrics: string[];
}

interface ReserveDigestSummary {
  windowHours: number;
  windowStart: number;
  windowEnd: number;
  breachSamples: number;
  totalAlerts: number;
  totalWarning: number;
  totalCritical: number;
  perMetric: Array<{
    metric: string;
    warning: number;
    critical: number;
    total: number;
    firstSeenAt: number;
    lastSeenAt: number;
    peakValue: number;
    peakThreshold: number;
  }>;
  transitions: Array<{ at: number; eventType: string; message: string }>;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ReservePressureDigestPanel({
  refreshTick,
  enabled,
}: {
  refreshTick: number;
  enabled: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const configQ = useQuery<ReserveDigestConfig>({
    queryKey: ["/api/health/manual-reserve-digest/config", refreshTick],
    queryFn: () =>
      fetchHealthJson<ReserveDigestConfig>(
        "/api/health/manual-reserve-digest/config",
        TIMEOUT_LIGHT_MS,
      ),
    enabled,
    ...POLLING_QUERY_OPTIONS,
  });

  const previewQ = useQuery<{
    summary: ReserveDigestSummary;
    message: string;
    cadence: "daily" | "weekly";
  }>({
    queryKey: ["/api/health/manual-reserve-digest/preview", refreshTick],
    queryFn: () =>
      fetchHealthJson<{
        summary: ReserveDigestSummary;
        message: string;
        cadence: "daily" | "weekly";
      }>("/api/health/manual-reserve-digest/preview", TIMEOUT_DIAGNOSTIC_MS),
    enabled,
    ...POLLING_QUERY_OPTIONS,
  });

  const [draftEnabled, setDraftEnabled] = useState(false);
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [hourUtc, setHourUtc] = useState<number>(15);
  const [weekdayUtc, setWeekdayUtc] = useState<number>(1);
  const [windowHours, setWindowHours] = useState<number>(24);
  const [channel, setChannel] = useState<string>("");
  const [metricsText, setMetricsText] = useState<string>("");

  useEffect(() => {
    const c = configQ.data;
    if (!c) return;
    setDraftEnabled(c.enabled);
    setCadence(c.cadence);
    setHourUtc(c.hourUtc);
    setWeekdayUtc(c.weekdayUtc);
    setWindowHours(c.windowHours);
    setChannel(c.channel ?? "");
    setMetricsText((c.metrics ?? []).join(", "));
  }, [configQ.data]);

  const saveMut = useMutation({
    meta: { silent: true },
    mutationFn: async (body: any) => {
      const r = await fetch("/api/health/manual-reserve-digest/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/manual-reserve-digest/config"],
      }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/manual-reserve-digest/preview"],
      }); // fire-and-forget: cache refresh only
      toast({ title: "Reserve digest config updated" });
    },
    onError: (e: any) =>
      toast({
        title: "Failed",
        description: String(e.message || e),
        variant: "destructive",
      }),
  });

  const historyQ = useQuery<{
    notificationId: string;
    deliveries: Array<{
      id: string;
      createdAt: string;
      status: string;
      channelId: string | null;
      channelName: string | null;
      errorMessage: string | null;
      errorCode: string | null;
      skipReason: string | null;
      triggerSource: string | null;
    }>;
  }>({
    queryKey: ["/api/health/manual-reserve-digest/history", refreshTick],
    queryFn: () =>
      fetchHealthJson<{
        notificationId: string;
        deliveries: Array<{
          id: string;
          createdAt: string;
          status: string;
          channelId: string | null;
          channelName: string | null;
          errorMessage: string | null;
          errorCode: string | null;
          skipReason: string | null;
          triggerSource: string | null;
        }>;
      }>("/api/health/manual-reserve-digest/history?limit=10", TIMEOUT_LIGHT_MS),
    enabled,
    ...POLLING_QUERY_OPTIONS,
  });

  const sendMut = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const r = await fetch("/api/health/manual-reserve-digest/send-now", {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (data: any) => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/manual-reserve-digest/history"],
      }); // fire-and-forget: cache refresh only
      toast({
        title: data?.sent ? "Reserve digest sent" : "Reserve digest skipped",
        description: String(data?.reason ?? ""),
      });
    },
    onError: (e: any) =>
      toast({
        title: "Failed",
        description: String(e.message || e),
        variant: "destructive",
      }),
  });

  const snoozedActive =
    configQ.data?.snoozedUntil != null &&
    configQ.data.snoozedUntil > Date.now();

  return (
    <Card data-testid="card-reserve-pressure-digest">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="w-4 h-4" /> Reserve-pressure spike digest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Aggregates manual-reserve threshold breaches (manual timeouts,
          delayed-by-background, background saturation) from the persisted
          dispatch history into a single Slack message at the configured
          cadence. Ride-along to the per-tick alerts so multi-hour incidents
          surface as a clean summary instead of scrolling the dashboard.
        </p>

        {configQ.isError && (
          <InlineQueryError
            label="reserve digest config"
            error={configQ.error}
            onRetry={() => configQ.refetch()}
            testIdSuffix="reserve-digest-config"
          />
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <Switch
            checked={draftEnabled}
            onCheckedChange={setDraftEnabled}
            aria-label="Enabled"
            data-testid="switch-reserve-digest-enabled"
          />
          <Label>Enabled</Label>
          {configQ.data?.lastSentKey && (
            <span
              className="text-xs text-muted-foreground"
              data-testid="text-reserve-digest-last-sent"
            >
              last sent for {configQ.data.lastSentKey}
            </span>
          )}
          {snoozedActive && (
            <span
              className="text-xs text-amber-700"
              data-testid="text-reserve-digest-snoozed"
            >
              snoozed until {fmtTs(configQ.data!.snoozedUntil!)}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs">Cadence</Label>
            <select
              className="border rounded-md h-9 px-2 w-full text-sm bg-background"
              value={cadence}
              onChange={(e) =>
                setCadence(e.target.value === "weekly" ? "weekly" : "daily")
              }
              aria-label="Cadence"
              data-testid="select-reserve-digest-cadence"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">Hour (UTC)</Label>
            <Input
              type="number"
              min={0}
              max={23}
              value={hourUtc}
              onChange={(e) => setHourUtc(Number(e.target.value))}
              aria-label="Hour (UTC)"
              data-testid="input-reserve-digest-hour"
            />
          </div>
          <div>
            <Label className="text-xs">Weekday (UTC)</Label>
            <select
              className="border rounded-md h-9 px-2 w-full text-sm bg-background disabled:opacity-50"
              value={weekdayUtc}
              disabled={cadence !== "weekly"}
              onChange={(e) => setWeekdayUtc(Number(e.target.value))}
              aria-label="Weekday (UTC)"
              data-testid="select-reserve-digest-weekday"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Window (hours)</Label>
            <Input
              type="number"
              min={1}
              max={24 * 14}
              value={windowHours}
              onChange={(e) => setWindowHours(Number(e.target.value))}
              aria-label="Window (hours)"
              data-testid="input-reserve-digest-window"
            />
          </div>
        </div>

        <div>
          <Label className="text-xs">Channel ID (optional override)</Label>
          <Input
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="C0123456789"
            aria-label="Channel ID (optional override)"
            data-testid="input-reserve-digest-channel"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Falls back to the Slack Notifications Console mapping for the
            manual-reserve digest setting
            <code className="mx-1">usage.manual_reserve.digest</code>, then to
            the rate-limit alert channel.
          </p>
        </div>

        <div>
          <Label className="text-xs">Metric filter (optional)</Label>
          <Input
            value={metricsText}
            onChange={(e) => setMetricsText(e.target.value)}
            placeholder="manual_timeout_window, background_ingestion_saturation_window"
            aria-label="Metric filter (optional)"
            data-testid="input-reserve-digest-metrics"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Comma-separated list of manual-reserve metric names to include in
            the digest. Leave blank to include every manual-reserve metric.
            Known names: manual wait p95 <code>manual_wait_p95_ms</code>,{" "}
            <code>manual_timeout_window</code>,{" "}
            <code>manual_delayed_by_background_window</code>,{" "}
            <code>background_ingestion_saturation_window</code>, plus
            per-entry-point variants prefixed with{" "}
            <code>manual_entrypoint_timeout_window:</code> /{" "}
            <code>manual_entrypoint_delayed_window:</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() =>
              saveMut.mutate({
                enabled: draftEnabled,
                cadence,
                hourUtc,
                weekdayUtc,
                windowHours,
                channel,
                metrics: metricsText,
              })
            }
            data-testid="button-save-reserve-digest"
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => sendMut.mutate()}
            data-testid="button-send-reserve-digest"
          >
            Send now
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => saveMut.mutate({ snoozeMinutes: 60 })}
            data-testid="button-snooze-reserve-digest-1h"
          >
            Snooze 1h
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => saveMut.mutate({ snoozeMinutes: 24 * 60 })}
            data-testid="button-snooze-reserve-digest-24h"
          >
            Snooze 24h
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => saveMut.mutate({ snoozeMinutes: 0 })}
            data-testid="button-clear-reserve-digest-snooze"
          >
            Clear snooze
          </Button>
        </div>

        {previewQ.isError && (
          <InlineQueryError
            label="reserve digest preview"
            error={previewQ.error}
            onRetry={() => previewQ.refetch()}
            testIdSuffix="reserve-digest-preview"
          />
        )}

        {previewQ.data && (
          <div
            className="rounded-md border p-3 space-y-2 bg-muted/30"
            data-testid="card-reserve-digest-preview"
          >
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-xs font-medium">
                Preview ({previewQ.data.summary.windowHours}h window)
              </div>
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <span data-testid="text-reserve-digest-totals">
                  {previewQ.data.summary.totalAlerts} breach detection(s) across{" "}
                  {previewQ.data.summary.breachSamples} sampler tick(s) —
                  <span className="text-red-700 ml-1">
                    {previewQ.data.summary.totalCritical} critical
                  </span>{" "}
                  /
                  <span className="text-amber-700 ml-1">
                    {previewQ.data.summary.totalWarning} warning
                  </span>
                </span>
              </div>
            </div>
            {previewQ.data.summary.perMetric.length > 0 ? (
              <div className="overflow-x-auto">
                <table
                  className="w-full text-xs border-collapse"
                  data-testid="table-reserve-digest-per-metric"
                >
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2">Metric</th>
                      <th className="py-1 pr-2">Critical</th>
                      <th className="py-1 pr-2">Warning</th>
                      <th className="py-1 pr-2">Peak (thr)</th>
                      <th className="py-1 pr-2">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewQ.data.summary.perMetric.map((m) => (
                      <tr
                        key={m.metric}
                        className="border-t"
                        data-testid={`row-reserve-digest-metric-${m.metric}`}
                      >
                        <td className="py-1 pr-2 font-mono">{m.metric}</td>
                        <td className="py-1 pr-2 text-red-700">{m.critical}</td>
                        <td className="py-1 pr-2 text-amber-700">{m.warning}</td>
                        <td className="py-1 pr-2">
                          {m.peakValue} ({m.peakThreshold})
                        </td>
                        <td className="py-1 pr-2 text-muted-foreground">
                          {fmtTs(m.lastSeenAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p
                className="text-xs text-muted-foreground"
                data-testid="text-reserve-digest-empty"
              >
                No reserve-pressure breaches in this window.
              </p>
            )}
          </div>
        )}

        {/* Task #1183 — recent send history */}
        <div
          className="rounded-md border p-3 space-y-2"
          data-testid="card-reserve-digest-history"
        >
          <div className="text-xs font-medium">Recent sends</div>
          {historyQ.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : historyQ.isError ? (
            <InlineQueryError
              label="digest history"
              error={historyQ.error}
              onRetry={() => historyQ.refetch()}
              testIdSuffix="reserve-digest-history"
            />
          ) : historyQ.data && historyQ.data.deliveries.length > 0 ? (
            <div className="overflow-x-auto">
              <table
                className="w-full text-xs border-collapse"
                data-testid="table-reserve-digest-history"
              >
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2">When</th>
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">Trigger</th>
                    <th className="py-1 pr-2">Channel</th>
                    <th className="py-1 pr-2">Reason / error</th>
                  </tr>
                </thead>
                <tbody>
                  {historyQ.data.deliveries.map((d) => {
                    const isSuccess = d.status === "success";
                    const isFailure = d.status === "failed";
                    const statusClass = isSuccess
                      ? "text-emerald-700"
                      : isFailure
                      ? "text-red-700"
                      : "text-amber-700";
                    const reason =
                      d.errorMessage ||
                      d.skipReason ||
                      d.errorCode ||
                      (isSuccess ? "" : d.status);
                    return (
                      <tr
                        key={d.id}
                        className="border-t"
                        data-testid={`row-reserve-digest-history-${d.id}`}
                      >
                        <td className="py-1 pr-2 text-muted-foreground whitespace-nowrap">
                          {fmtTs(new Date(d.createdAt).getTime())}
                        </td>
                        <td
                          className={`py-1 pr-2 font-mono ${statusClass}`}
                          data-testid={`text-reserve-digest-history-status-${d.id}`}
                        >
                          {d.status}
                        </td>
                        <td className="py-1 pr-2 text-muted-foreground">
                          {d.triggerSource ?? "—"}
                        </td>
                        <td className="py-1 pr-2 font-mono text-muted-foreground">
                          {d.channelName || d.channelId || "—"}
                        </td>
                        <td
                          className="py-1 pr-2 text-muted-foreground"
                          title={reason || ""}
                        >
                          {reason || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p
              className="text-xs text-muted-foreground"
              data-testid="text-reserve-digest-history-empty"
            >
              No digest sends recorded yet.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function IncidentTable({
  rows,
  onAck,
  onSnooze,
  onResolve,
  readonly = false,
}: {
  rows: IncidentRow[];
  onAck?: (id: number) => void;
  onSnooze?: (id: number) => void;
  onResolve?: (id: number) => void;
  readonly?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No incidents.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div
          key={r.id}
          className="rounded-md border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
          data-testid={`row-incident-${r.id}`}
        >
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <SeverityBadge severity={r.severity} />
              <span className="font-medium">{r.title}</span>
              <Badge variant="outline" className="text-xs">×{r.occurrenceCount}</Badge>
              <Badge variant="outline" className="text-xs">{r.status}</Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              first: {fmtTs(r.firstSeenAt)} · last: {fmtTs(r.lastSeenAt)} · peak {r.peakValue} (thr {r.threshold})
            </div>
            {r.acknowledgedBy && (
              <div className="text-xs text-muted-foreground">acked by {r.acknowledgedBy}</div>
            )}
            {r.snoozedUntil && (
              <div className="text-xs text-muted-foreground">snoozed until {fmtTs(r.snoozedUntil)}</div>
            )}
          </div>
          {!readonly && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => onAck?.(r.id)} data-testid={`button-ack-${r.id}`}>
                Ack
              </Button>
              <Button size="sm" variant="outline" onClick={() => onSnooze?.(r.id)} data-testid={`button-snooze-${r.id}`}>
                Snooze 1h
              </Button>
              <Button size="sm" variant="outline" onClick={() => onResolve?.(r.id)} data-testid={`button-resolve-${r.id}`}>
                Resolve
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DigestPanel({
  config,
  onSendNow,
  onSave,
  onSnooze,
}: {
  config?: { enabled: boolean; hourUtc: number; snoozedUntil: number | null; channel: string | null; lastSentDate: string | null };
  onSendNow: () => void;
  onSave: (body: any) => void;
  onSnooze: (minutes: number) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [hourUtc, setHourUtc] = useState<number>(14);
  const [channel, setChannel] = useState<string>("");

  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setHourUtc(config.hourUtc);
      setChannel(config.channel ?? "");
    }
  }, [config]);

  return (
    <Card data-testid="card-digest">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="w-4 h-4" /> Daily Slack Digest
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" data-testid="switch-digest-enabled" />
          <Label>Enabled</Label>
          {config?.lastSentDate && (
            <span className="text-xs text-muted-foreground ml-2">last sent {config.lastSentDate}</span>
          )}
          {config?.snoozedUntil && config.snoozedUntil > Date.now() && (
            <span className="text-xs text-amber-700 ml-2">snoozed until {fmtTs(config.snoozedUntil)}</span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Hour (UTC)</Label>
            <Input
              type="number"
              min={0}
              max={23}
              value={hourUtc}
              onChange={(e) => setHourUtc(Number(e.target.value))}
              aria-label="Hour (UTC)"
              data-testid="input-digest-hour"
            />
          </div>
          <div>
            <Label className="text-xs">Channel ID (optional override)</Label>
            <Input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="C0123456789"
              aria-label="Channel ID (optional override)"
              data-testid="input-digest-channel"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => onSave({ enabled, hourUtc, channel })}
            data-testid="button-save-digest"
          >
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={onSendNow} data-testid="button-send-digest">
            Send now
          </Button>
          <Button size="sm" variant="outline" onClick={() => onSnooze(60)} data-testid="button-snooze-digest-1h">
            Snooze 1h
          </Button>
          <Button size="sm" variant="outline" onClick={() => onSnooze(24 * 60)} data-testid="button-snooze-digest-24h">
            Snooze 24h
          </Button>
          <Button size="sm" variant="outline" onClick={() => onSnooze(0)} data-testid="button-clear-digest-snooze">
            Clear snooze
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
