/**
 * Task #1728 (Pool epic Phase 1.5.3) — admin trends page.
 *
 * Single page with eight panels powered by
 * `GET /api/admin/db-attribution/trends`:
 *   1. Top DB hold labels today
 *   2. Week-over-week movers
 *   3. Longest max holds (7d)
 *   4. Labels exceeding 10s (7d)
 *   5. Background work hitting the API pool
 *   6. External call volume + error rate by integration (7d)
 *   7. Noisy external endpoints (same-response count)
 *   8. Front recovery backoff frequency (last 24h, live audit table)
 *
 * All numbers stay zero until the operator flips the Phase 0 switches
 * (`external_call_audit_enabled`, `db_hold_rollup_enabled`).
 */

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageSkeleton } from "@/components/ui/skeleton-loaders";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/admin/PageHeader";

type HoldRow = {
  pool: string;
  hold_label: string;
  count: number;
  max_duration_ms: number;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
  total_hold_time_ms: number;
};

type WowRow = {
  pool: string;
  hold_label: string;
  curr_count: number;
  prev_count: number;
  curr_total_ms: number;
  prev_total_ms: number;
};

type IntegrationRow = {
  integration: string;
  call_count: number;
  error_count: number;
  cache_hit_count: number;
  same_response_count: number;
  cache_hit_ratio: number;
  same_response_ratio: number;
  total_response_bytes: number;
};

type NoisyEndpointRow = {
  integration: string;
  endpoint: string;
  caller_label: string;
  call_count: number;
  same_response_count: number;
  cache_hit_count: number;
};

type FrontBackoffRow = {
  caller_label: string;
  call_count_24h: number;
  rate_limited_count: number;
  call_count_1h: number;
};

type LongHoldEvent = {
  pool: string;
  label: string;
  durationMs: number;
  tier: "warn" | "critical";
  observedAt: number;
  callerLabel: string | null;
  requestId: string | null;
};

type ExternalCallAlert = {
  kind:
    | "same_response_storm"
    | "cache_hit_drop"
    | "rpm_spike"
    | "duration_spike"
    | "db_saturation_correlation";
  integration: string;
  message: string;
  metric: Record<string, unknown>;
  firedAt: number;
};

type FrontWarpPerQueueRow = {
  queue_name: string;
  workload_class: string;
  pending: number;
  processing: number;
  completed_5m: number;
  completed_30m: number;
  oldest_pending_age_sec: number | null;
};

type FrontWarpPayload = {
  scheduler: {
    running: boolean;
    enabled: boolean;
    lastCycleAt: string | null;
    cycleCount: number;
    pollIntervalMs: number;
  };
  settings: {
    classConcurrency: number;
    manualReserve: number;
    pollIntervalMs: number;
    perCycleDispatchMax: number;
    workerIdleMin: number;
  };
  classCap: number;
  manualReserve: number;
  totalBudget: number;
  killSwitches: {
    front_warp_speed_enabled: boolean;
    front_ingestion_api_waiter_backoff_enabled: boolean;
    front_ingestion_front_rate_limit_guard_enabled: boolean;
  };
  guardCounters: {
    workerIdle: number;
    apiPoolWaiter: number;
    frontRateLimit: number;
    dbHoldThrottle: number;
    classCapReached: number;
    perCycleMaxReached: number;
    masterSwitchOff: number;
    queuePaused: number;
  };
  recentFront429: number;
  workerPool: { active: number; idle: number; total: number; max: number; utilizationPct: number; waiting: number };
  apiPool: { active: number; idle: number; total: number; max: number; utilizationPct: number; waiting: number };
  perQueue: FrontWarpPerQueueRow[];
};

type DedupeSampleRow = {
  jobId: string | null;
  windowLabel: string;
  pageNumber: number;
  pageScanned: number;
  pageDedupeSkipped: number;
  dedupePct: number;
  sampleSize: number;
  applied: number;
  discovered: number;
  missing: number;
  otherStates: number;
  verdict: "apply_layer_dropping" | "coverage_denominator_likely_wrong" | "mixed";
  observedAt: number;
};

type DedupeDropChain = {
  jobId: string | null;
  windowLabel: string;
  consecutivePages: number;
  firstPageNumber: number;
  lastPageNumber: number;
  observedAt: number;
  alerted: boolean;
};

type DedupeDropPayload = {
  recentSamples: DedupeSampleRow[];
  verdictCounters: {
    apply_layer_dropping: number;
    coverage_denominator_likely_wrong: number;
    mixed: number;
  };
  aggregate: {
    sampleCount: number;
    applyLayerDropRate: number;
    avgDedupePct: number;
    historicalWindowDays?: number;
  };
  activeChains: DedupeDropChain[];
};

type TrendsResponse = {
  generatedAt: number;
  topHoldsToday: HoldRow[];
  wowMovers: WowRow[];
  longestMaxHolds: HoldRow[];
  labelsOver10s: (HoldRow & { last_date: string })[];
  backgroundOnApi: HoldRow[];
  externalByIntegration: IntegrationRow[];
  noisyEndpoints: NoisyEndpointRow[];
  frontRecoveryBackoff: FrontBackoffRow[];
  activeLongHolds?: LongHoldEvent[];
  longHoldCounters?: {
    warn: number;
    critical: number;
    exceptionSuppressed: number;
    slackDispatched: number;
    slackSuppressedCooldown: number;
    slackSuppressedDisabled: number;
    slackFailed: number;
  };
  activeExternalCallAlerts?: ExternalCallAlert[];
  frontWarp?: FrontWarpPayload;
  dedupeDrop?: DedupeDropPayload;
  poolAuditTableSizes?: PoolAuditTableSizeRow[];
  frontParkedWindows?: FrontParkedWindowsPayload | null;
  frontMirrorFreshness?: FrontMirrorFreshnessPayload | null;
};

// Task #2171 — always-visible Front mirror health. Mirrors the shape of
// `FrontMirrorFreshnessEvaluation` from
// server/services/frontMirrorFreshnessAlerts.ts.
type FrontMirrorFreshnessPayload = {
  evaluatedAt: string;
  state: "no_webhook_traffic" | "mirror_fresh" | "frozen";
  lagMinutes: number;
  mirrorLatest: string | null;
  webhookLatest: string | null;
  mirrorAgeMinutes: number | null;
  webhookAgeMinutes: number | null;
  mirrorBehindWebhookMinutes: number | null;
  mirrorSwitchEnabled: boolean;
  reason: string;
};

type PoolAuditTableSizeRow = {
  table: string;
  rowCount: number | null;
  rowCountError: string | null;
  lastPruneDeleted: number | null;
  lastPruneAt: number | null;
};

// Task #2088 — Front recovery parked-window visibility.
type FrontParkedWindowsPayload = {
  currentlyParked: number;
  parkedWindows: {
    month: string;
    parkedAt: string;
    deadRuns: number;
    lastCheckpointAt: string | null;
    reason: string;
  }[];
  periodStart: string;
  parkedInPeriod: number;
  autoUnparkedInPeriod: number;
  operatorUnparkedInPeriod: number;
};

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtPct(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function DbAttributionTrends() {
  const { user, isLoading: authLoading } = useAuth();
  const role = (user as any)?.role as string | undefined;
  const isAdmin = role === "ceo" || role === "team_lead";

  const { data, isLoading, error } = useQuery<TrendsResponse>({
    queryKey: ["/api/admin/db-attribution/trends"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/db-attribution/trends");
      return (await res.json()) as TrendsResponse;
    },
    enabled: !!isAdmin,
    refetchInterval: 60_000,
  });

  if (authLoading) return <PageSkeleton />;
  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
            <CardDescription>This page is only available to team leads.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Failed to load trends</CardTitle>
            <CardDescription data-testid="text-error">{String((error as any)?.message ?? error)}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }
  if (isLoading || !data) return <PageSkeleton />;

  return (
    <div className="p-6 space-y-6" data-testid="page-db-attribution-trends">
      <div>
        <PageHeader
          title="DB attribution & external-call trends"
          backHref="/"
          backLabel="Dashboard"
        />
        <p className="text-sm text-muted-foreground" data-testid="text-generated-at">
          Rollups update hourly. Generated at {new Date(data.generatedAt).toLocaleString()}.
        </p>
      </div>

      <ActiveAlertsPanel
        longHolds={data.activeLongHolds ?? []}
        externalCallAlerts={data.activeExternalCallAlerts ?? []}
        longHoldCounters={data.longHoldCounters}
      />

      {data.frontWarp ? <FrontWarpPanel data={data.frontWarp} /> : null}

      {data.dedupeDrop ? <DedupeDropPanel data={data.dedupeDrop} /> : null}

      {data.poolAuditTableSizes ? (
        <PoolAuditTableSizesPanel rows={data.poolAuditTableSizes} />
      ) : null}

      {data.frontParkedWindows ? (
        <FrontParkedWindowsPanel data={data.frontParkedWindows} />
      ) : null}

      {data.frontMirrorFreshness ? (
        <FrontMirrorFreshnessPanel data={data.frontMirrorFreshness} />
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card data-testid="card-top-holds-today">
          <CardHeader>
            <CardTitle>Top DB hold labels — today</CardTitle>
            <CardDescription>Sorted by total hold time (UTC day).</CardDescription>
          </CardHeader>
          <CardContent>
            <Table
              cols={["pool", "label", "count", "max", "avg", "total"]}
              rows={data.topHoldsToday.map((r, i) => ({
                key: `${r.pool}:${r.hold_label}:${i}`,
                cells: [
                  <Badge key="p" variant="outline">{r.pool}</Badge>,
                  <code key="l" className="text-xs break-all">{r.hold_label}</code>,
                  String(r.count),
                  fmtMs(r.max_duration_ms),
                  fmtMs(r.avg_duration_ms),
                  fmtMs(r.total_hold_time_ms),
                ],
              }))}
              empty="No data yet — flip db_hold_rollup_enabled to start collecting."
            />
          </CardContent>
        </Card>

        <Card data-testid="card-wow-movers">
          <CardHeader>
            <CardTitle>Week-over-week movers</CardTitle>
            <CardDescription>Biggest absolute increase in total hold time (current 7d vs prior 7d).</CardDescription>
          </CardHeader>
          <CardContent>
            <Table
              cols={["pool", "label", "curr count", "prev count", "Δ total"]}
              rows={data.wowMovers.map((r, i) => {
                const delta = Number(r.curr_total_ms) - Number(r.prev_total_ms);
                return {
                  key: `${r.pool}:${r.hold_label}:${i}`,
                  cells: [
                    <Badge key="p" variant="outline">{r.pool}</Badge>,
                    <code key="l" className="text-xs break-all">{r.hold_label}</code>,
                    String(r.curr_count),
                    String(r.prev_count),
                    <span key="d" className={delta > 0 ? "text-red-600" : "text-green-700"}>
                      {delta > 0 ? "+" : ""}{fmtMs(Math.abs(delta))}
                    </span>,
                  ],
                };
              })}
              empty="No week-over-week data yet."
            />
          </CardContent>
        </Card>

        <Card data-testid="card-longest-holds">
          <CardHeader>
            <CardTitle>Longest max holds (7d)</CardTitle>
            <CardDescription>Single longest connection check-out per label.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table
              cols={["pool", "label", "max", "count"]}
              rows={data.longestMaxHolds.map((r, i) => ({
                key: `${r.pool}:${r.hold_label}:${i}`,
                cells: [
                  <Badge key="p" variant="outline">{r.pool}</Badge>,
                  <code key="l" className="text-xs break-all">{r.hold_label}</code>,
                  fmtMs(r.max_duration_ms),
                  String(r.count),
                ],
              }))}
              empty="No data yet."
            />
          </CardContent>
        </Card>

        <Card data-testid="card-labels-over-10s">
          <CardHeader>
            <CardTitle>Labels exceeding 10s (7d)</CardTitle>
            <CardDescription>Any label whose max hold ≥ 10s on any sample.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table
              cols={["pool", "label", "max", "count", "last date"]}
              rows={data.labelsOver10s.map((r, i) => ({
                key: `${r.pool}:${r.hold_label}:${i}`,
                cells: [
                  <Badge key="p" variant="outline">{r.pool}</Badge>,
                  <code key="l" className="text-xs break-all">{r.hold_label}</code>,
                  <Badge key="m" variant="destructive">{fmtMs(r.max_duration_ms)}</Badge>,
                  String(r.count),
                  r.last_date,
                ],
              }))}
              empty="No labels exceeded 10s — pool is healthy."
            />
          </CardContent>
        </Card>

        <Card data-testid="card-background-on-api">
          <CardHeader>
            <CardTitle>Background work on API pool (7d)</CardTitle>
            <CardDescription>Worker / maintenance labels checking out the API pool — investigate any non-empty rows.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table
              cols={["label", "count", "max", "total"]}
              rows={data.backgroundOnApi.map((r, i) => ({
                key: `${r.hold_label}:${i}`,
                cells: [
                  <code key="l" className="text-xs break-all">{r.hold_label}</code>,
                  String(r.count),
                  fmtMs(r.max_duration_ms),
                  fmtMs(r.total_hold_time_ms),
                ],
              }))}
              empty="No background contamination on the API pool — good."
            />
          </CardContent>
        </Card>

        <Card data-testid="card-external-by-integration">
          <CardHeader>
            <CardTitle>External call volume (7d)</CardTitle>
            <CardDescription>Per-integration call counts + cache hit / same-response ratios.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table
              cols={["integration", "calls", "errors", "cache", "same-resp", "bytes"]}
              rows={data.externalByIntegration.map((r) => ({
                key: r.integration,
                cells: [
                  <Badge key="i" variant="outline">{r.integration}</Badge>,
                  String(r.call_count),
                  String(r.error_count),
                  `${r.cache_hit_count} (${fmtPct(r.cache_hit_ratio)})`,
                  `${r.same_response_count} (${fmtPct(r.same_response_ratio)})`,
                  fmtBytes(Number(r.total_response_bytes)),
                ],
              }))}
              empty="No external call audits yet — flip external_call_audit_enabled to start."
            />
          </CardContent>
        </Card>

        <Card data-testid="card-noisy-endpoints" className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Noisiest external endpoints (7d)</CardTitle>
            <CardDescription>Top 25 (integration × endpoint × caller) by same-response count. High numbers = repeated identical calls; candidates for caching.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table
              cols={["integration", "endpoint", "caller", "calls", "same-resp", "cache hits"]}
              rows={data.noisyEndpoints.map((r, i) => ({
                key: `${r.integration}:${r.endpoint}:${r.caller_label}:${i}`,
                cells: [
                  <Badge key="i" variant="outline">{r.integration}</Badge>,
                  <code key="e" className="text-xs break-all">{r.endpoint}</code>,
                  <code key="c" className="text-xs break-all">{r.caller_label}</code>,
                  String(r.call_count),
                  String(r.same_response_count),
                  String(r.cache_hit_count),
                ],
              }))}
              empty="No external call audits yet."
            />
          </CardContent>
        </Card>

        <Card data-testid="card-front-backoff" className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Front recovery backoff frequency (24h)</CardTitle>
            <CardDescription>Per-caller call counts and 429 rate-limit counts in the last 24h. Spikes in 1h column indicate a hot backoff loop.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table
              cols={["caller", "calls 24h", "429s", "calls 1h"]}
              rows={data.frontRecoveryBackoff.map((r, i) => ({
                key: `${r.caller_label}:${i}`,
                cells: [
                  <code key="c" className="text-xs break-all">{r.caller_label}</code>,
                  String(r.call_count_24h),
                  r.rate_limited_count > 0 ? (
                    <Badge key="r" variant="destructive">{r.rate_limited_count}</Badge>
                  ) : (
                    "0"
                  ),
                  String(r.call_count_1h),
                ],
              }))}
              empty="No Front audit data in the last 24h."
            />
          </CardContent>
        </Card>
      </div>

      <FrontPipelineLabelsPanel data={data} />
    </div>
  );
}

/**
 * Task #1787 Stage 7A — Front pipeline labels panel.
 *
 * Filters the existing trends data to labels whose name starts with
 * `front_` (matches `front_sync_reprocess:*`, `front_webhook_apply`,
 * `front_webhook_apply:read`, `front_webhook_apply:persist`,
 * `front_webhook_normalize`, `front_analytics_coverage_refresh`, etc).
 * This is purely a client-side filter; the underlying rollup data
 * unchanged.
 *
 * Three side-by-side tables: top holds today, longest max holds (7d),
 * and labels exceeding 10s (7d) — all scoped to Front. An empty state
 * for the 10s panel is the win condition for the epic: no Front hold
 * windows over 10s means Stage 3B did its job.
 */
function FrontPipelineLabelsPanel(props: { data: TrendsResponse }) {
  const { data } = props;
  const isFront = (label: string) => label.startsWith("front_");
  const top = data.topHoldsToday.filter((r) => isFront(r.hold_label));
  const longest = data.longestMaxHolds.filter((r) => isFront(r.hold_label));
  const over10 = data.labelsOver10s.filter((r) => isFront(r.hold_label));

  return (
    <Card data-testid="card-front-pipeline-labels">
      <CardHeader>
        <CardTitle>Front pipeline labels</CardTitle>
        <CardDescription>
          Stage 3 split labels: <code className="text-xs">front_webhook_apply:read</code> /
          <code className="text-xs"> :persist</code> and{" "}
          <code className="text-xs">front_sync_reprocess:batch:fetch</code>. A
          healthy steady state shows no Front label in the &ge; 10s table.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold mb-2">Front labels — top holds today</h3>
          <Table
            cols={["pool", "label", "count", "max", "avg", "total"]}
            rows={top.map((r, i) => ({
              key: `front-top-${r.pool}:${r.hold_label}:${i}`,
              cells: [
                <Badge key="p" variant="outline">{r.pool}</Badge>,
                <code key="l" className="text-xs break-all">{r.hold_label}</code>,
                String(r.count),
                fmtMs(r.max_duration_ms),
                fmtMs(r.avg_duration_ms),
                fmtMs(r.total_hold_time_ms),
              ],
            }))}
            empty="No Front labels seen today."
          />
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2">Front labels — longest max holds (7d)</h3>
          <Table
            cols={["pool", "label", "max", "count"]}
            rows={longest.map((r, i) => ({
              key: `front-longest-${r.pool}:${r.hold_label}:${i}`,
              cells: [
                <Badge key="p" variant="outline">{r.pool}</Badge>,
                <code key="l" className="text-xs break-all">{r.hold_label}</code>,
                fmtMs(r.max_duration_ms),
                String(r.count),
              ],
            }))}
            empty="No Front labels recorded in 7d."
          />
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2">Front labels exceeding 10s (7d)</h3>
          <Table
            cols={["pool", "label", "max", "count", "last date"]}
            rows={over10.map((r, i) => ({
              key: `front-over10-${r.pool}:${r.hold_label}:${i}`,
              cells: [
                <Badge key="p" variant="outline">{r.pool}</Badge>,
                <code key="l" className="text-xs break-all">{r.hold_label}</code>,
                <Badge key="m" variant="destructive">{fmtMs(r.max_duration_ms)}</Badge>,
                String(r.count),
                r.last_date,
              ],
            }))}
            empty="No Front labels exceeded 10s — Stage 3 split is holding."
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Task #1872 — Front recovery apply-layer drop panel.
 *
 * Shows the apply-layer-drop rate (share of per-page dedupe samples
 * that flipped `apply_layer_dropping`) alongside the average dedupe
 * pct from those samples. When dedupe pct stays high but the apply
 * layer is dropping conversations, the headline number is the gap
 * between the two: real ingest is stalled even though dedupe looks
 * healthy. Active per-window chains (≥ N consecutive `apply_layer_dropping`
 * verdicts) escalate to a Slack alert.
 */
function DedupeDropPanel(props: { data: DedupeDropPayload }) {
  const { data } = props;
  const { aggregate, verdictCounters, recentSamples, activeChains } = data;
  const dropPct = aggregate.applyLayerDropRate * 100;
  const dedupePct = aggregate.avgDedupePct * 100;
  return (
    <Card data-testid="card-dedupe-drop">
      <CardHeader>
        <CardTitle>Front recovery apply-layer drops</CardTitle>
        <CardDescription>
          Per-page dedupe samples and their verdict. A non-zero
          apply-layer-drop rate means recovered conversations are being
          skipped at apply rather than persisted — dedupe pct stays high
          but real ingest is stalled. Verdict counts and the headline
          drop rate are summed over the last
          {" "}{aggregate.historicalWindowDays ?? 14}{" "} UTC days from
          the persisted rollup and survive process restart; the
          sampled-page average and the recent-samples table are
          process-local.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 text-xs" data-testid="text-dedupe-drop-rates">
          <Badge variant={dropPct > 0 ? "destructive" : "outline"}>
            apply-layer drop rate: {dropPct.toFixed(1)}%
          </Badge>
          <Badge variant="outline">
            avg dedupe pct (sampled pages): {dedupePct.toFixed(1)}%
          </Badge>
          <Badge variant="outline">samples: {aggregate.sampleCount}</Badge>
          <Badge variant={verdictCounters.apply_layer_dropping > 0 ? "destructive" : "outline"}>
            apply_layer_dropping: {verdictCounters.apply_layer_dropping}
          </Badge>
          <Badge variant="outline">
            coverage_denominator_likely_wrong: {verdictCounters.coverage_denominator_likely_wrong}
          </Badge>
          <Badge variant="outline">mixed: {verdictCounters.mixed}</Badge>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Active drop chains</h3>
          <Table
            cols={["window", "job", "consecutive pages", "page range", "alerted"]}
            rows={activeChains.map((c, i) => ({
              key: `dedupe-chain-${c.windowLabel}:${i}`,
              cells: [
                <code key="w" className="text-xs break-all">{c.windowLabel}</code>,
                <code key="j" className="text-xs break-all">{c.jobId ?? "—"}</code>,
                <Badge key="n" variant={c.consecutivePages >= 3 ? "destructive" : "outline"}>
                  {c.consecutivePages}
                </Badge>,
                `${c.firstPageNumber}–${c.lastPageNumber}`,
                c.alerted ? (
                  <Badge key="a" variant="destructive">alerted</Badge>
                ) : (
                  "no"
                ),
              ],
            }))}
            empty="No open apply-layer drop chains."
          />
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Recent page samples</h3>
          <Table
            cols={["observed", "window", "page", "dedupe%", "applied/disc/missing/other", "verdict"]}
            rows={recentSamples.map((s, i) => ({
              key: `dedupe-sample-${i}`,
              cells: [
                new Date(s.observedAt).toLocaleTimeString(),
                <code key="w" className="text-xs break-all">{s.windowLabel}</code>,
                String(s.pageNumber),
                `${(s.dedupePct * 100).toFixed(1)}%`,
                `${s.applied}/${s.discovered}/${s.missing}/${s.otherStates} of ${s.sampleSize}`,
                <Badge
                  key="v"
                  variant={s.verdict === "apply_layer_dropping" ? "destructive" : "outline"}
                >
                  {s.verdict}
                </Badge>,
              ],
            }))}
            empty="No dedupe samples observed since process start. Samples only fire when a page's dedupe rate exceeds 95%."
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ActiveAlertsPanel(props: {
  longHolds: LongHoldEvent[];
  externalCallAlerts: ExternalCallAlert[];
  longHoldCounters?: TrendsResponse["longHoldCounters"];
}) {
  const hasAlerts =
    props.longHolds.length > 0 || props.externalCallAlerts.length > 0;
  const c = props.longHoldCounters;
  return (
    <Card data-testid="card-active-alerts">
      <CardHeader>
        <CardTitle>Active runtime alerts</CardTitle>
        <CardDescription>
          DB-hold critical events (≥30s) and external-call audit alerts fired in
          the last hour. Counters are process-local — restart resets them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {c ? (
          <div className="flex flex-wrap gap-2 text-xs" data-testid="text-long-hold-counters">
            <Badge variant="outline">warn (≥10s): {c.warn}</Badge>
            <Badge variant={c.critical > 0 ? "destructive" : "outline"}>
              critical (≥30s): {c.critical}
            </Badge>
            <Badge variant="outline">exception suppressed: {c.exceptionSuppressed}</Badge>
            <Badge variant="outline">slack sent: {c.slackDispatched}</Badge>
            <Badge variant="outline">slack cooldown: {c.slackSuppressedCooldown}</Badge>
            <Badge variant="outline">slack disabled: {c.slackSuppressedDisabled}</Badge>
            {c.slackFailed > 0 ? (
              <Badge variant="destructive">slack failed: {c.slackFailed}</Badge>
            ) : null}
          </div>
        ) : null}
        {!hasAlerts ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-active-alerts">
            No active alerts. DB holds &lt; 30s and no external-call audit
            triggers in the last hour.
          </p>
        ) : null}
        {props.longHolds.length > 0 ? (
          <div data-testid="section-long-hold-alerts">
            <h3 className="text-sm font-semibold mb-2">DB hold ≥ 30s</h3>
            <Table
              cols={["pool", "label", "duration", "observed", "caller"]}
              rows={props.longHolds.map((e, i) => ({
                key: `long-hold-${i}`,
                cells: [
                  <Badge key="p" variant="outline">{e.pool}</Badge>,
                  <code key="l" className="text-xs break-all">{e.label}</code>,
                  <Badge key="d" variant="destructive">{fmtMs(e.durationMs)}</Badge>,
                  new Date(e.observedAt).toLocaleTimeString(),
                  e.callerLabel ? (
                    <code key="c" className="text-xs break-all">{e.callerLabel}</code>
                  ) : (
                    "—"
                  ),
                ],
              }))}
              empty=""
            />
          </div>
        ) : null}
        {props.externalCallAlerts.length > 0 ? (
          <div data-testid="section-external-call-alerts">
            <h3 className="text-sm font-semibold mb-2">External-call audit alerts</h3>
            <Table
              cols={["kind", "integration", "fired", "message"]}
              rows={props.externalCallAlerts.map((a, i) => ({
                key: `external-alert-${i}`,
                cells: [
                  <Badge key="k" variant="destructive">{a.kind}</Badge>,
                  <Badge key="i" variant="outline">{a.integration}</Badge>,
                  new Date(a.firedAt).toLocaleTimeString(),
                  <span key="m" className="text-xs">{a.message}</span>,
                ],
              }))}
              empty=""
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FrontWarpPanel(props: { data: FrontWarpPayload }) {
  const d = props.data;
  const aggPerQueue: Record<string, { pending: number; processing: number; completed_5m: number; completed_30m: number; oldest_sec: number | null }> = {};
  for (const r of d.perQueue) {
    const a = aggPerQueue[r.queue_name] ?? { pending: 0, processing: 0, completed_5m: 0, completed_30m: 0, oldest_sec: null };
    a.pending += r.pending;
    a.processing += r.processing;
    a.completed_5m += r.completed_5m;
    a.completed_30m += r.completed_30m;
    if (r.oldest_pending_age_sec != null) {
      a.oldest_sec = a.oldest_sec == null ? r.oldest_pending_age_sec : Math.max(a.oldest_sec, r.oldest_pending_age_sec);
    }
    aggPerQueue[r.queue_name] = a;
  }
  const queues = Object.keys(aggPerQueue);
  const masterOn = d.killSwitches.front_warp_speed_enabled;
  const cls = d.guardCounters;
  return (
    <Card data-testid="card-front-warp">
      <CardHeader>
        <CardTitle>Front pipeline throughput (Task #1829)</CardTitle>
        <CardDescription>
          Live snapshot of the Front warp-speed scheduler. Guard counters
          are process-local — restart resets them. Toggle{" "}
          <code>front_warp_speed_enabled</code> in <code>system_settings</code>{" "}
          to flip; rollback is one SQL update.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 text-xs" data-testid="text-front-warp-status">
          <Badge variant={masterOn ? "default" : "outline"} data-testid="badge-front-warp-master">
            master: {masterOn ? "ON" : "OFF"}
          </Badge>
          <Badge variant="outline">scheduler: {d.scheduler.running ? "running" : "stopped"}</Badge>
          <Badge variant="outline">poll: {d.scheduler.pollIntervalMs}ms</Badge>
          <Badge variant="outline">cycles: {d.scheduler.cycleCount}</Badge>
          <Badge variant="outline">last cycle: {d.scheduler.lastCycleAt ? new Date(d.scheduler.lastCycleAt).toLocaleTimeString() : "—"}</Badge>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Knobs (live)</h3>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">classConcurrency: {d.settings.classConcurrency}</Badge>
            <Badge variant="outline">manualReserve: {d.settings.manualReserve}</Badge>
            <Badge variant="outline">pollIntervalMs: {d.settings.pollIntervalMs}</Badge>
            <Badge variant="outline">perCycleDispatchMax: {d.settings.perCycleDispatchMax}</Badge>
            <Badge variant="outline">workerIdleMin: {d.settings.workerIdleMin}</Badge>
            <Badge variant="outline">classCap (live): {d.classCap}</Badge>
            <Badge variant="outline">TOTAL_BUDGET: {d.totalBudget}</Badge>
            <Badge variant={d.killSwitches.front_ingestion_api_waiter_backoff_enabled ? "default" : "outline"}>
              api-waiter guard: {d.killSwitches.front_ingestion_api_waiter_backoff_enabled ? "on" : "off"}
            </Badge>
            <Badge variant={d.killSwitches.front_ingestion_front_rate_limit_guard_enabled ? "default" : "outline"}>
              front-429 guard: {d.killSwitches.front_ingestion_front_rate_limit_guard_enabled ? "on" : "off"}
            </Badge>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Guard triggers (since process start)</h3>
          <div className="flex flex-wrap gap-2 text-xs" data-testid="text-front-warp-guards">
            <Badge variant={cls.workerIdle > 0 ? "destructive" : "outline"}>workerIdle: {cls.workerIdle}</Badge>
            <Badge variant={cls.apiPoolWaiter > 0 ? "destructive" : "outline"}>apiPoolWaiter: {cls.apiPoolWaiter}</Badge>
            <Badge variant={cls.frontRateLimit > 0 ? "destructive" : "outline"}>frontRateLimit: {cls.frontRateLimit}</Badge>
            <Badge variant={cls.dbHoldThrottle > 0 ? "destructive" : "outline"}>dbHoldThrottle: {cls.dbHoldThrottle}</Badge>
            <Badge variant="outline">classCapReached: {cls.classCapReached}</Badge>
            <Badge variant="outline">perCycleMaxReached: {cls.perCycleMaxReached}</Badge>
            <Badge variant="outline">queuePaused: {cls.queuePaused}</Badge>
            <Badge variant="outline">masterSwitchOff: {cls.masterSwitchOff}</Badge>
            <Badge variant={d.recentFront429 >= 3 ? "destructive" : "outline"}>front 429 (60s): {d.recentFront429}</Badge>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Pool state</h3>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant={d.workerPool.utilizationPct >= 80 ? "destructive" : "outline"}>
              worker: {d.workerPool.active}/{d.workerPool.max} ({d.workerPool.utilizationPct}%) idle={d.workerPool.idle} waiting={d.workerPool.waiting}
            </Badge>
            <Badge variant={d.apiPool.waiting > 0 ? "destructive" : "outline"}>
              api: {d.apiPool.active}/{d.apiPool.max} ({d.apiPool.utilizationPct}%) idle={d.apiPool.idle} waiting={d.apiPool.waiting}
            </Badge>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Per-queue throughput</h3>
          <Table
            cols={["queue", "pending", "in-flight", "completions / 5m", "/min", "oldest pending"]}
            rows={queues.map((q) => {
              const a = aggPerQueue[q]!;
              return {
                key: `front-warp-q-${q}`,
                cells: [
                  <code key="q" className="text-xs">{q}</code>,
                  String(a.pending),
                  String(a.processing),
                  String(a.completed_5m),
                  <Badge key="rate" variant={a.completed_5m / 5 >= 30 ? "default" : "outline"}>
                    {(a.completed_5m / 5).toFixed(1)}/min
                  </Badge>,
                  a.oldest_sec == null ? "—" : `${a.oldest_sec}s`,
                ],
              };
            })}
            empty="No Front-queue rows in last 30 minutes."
          />
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Per-queue × workload_class breakdown</h3>
          <Table
            cols={["queue", "class", "pending", "in-flight", "5m done", "30m done"]}
            rows={d.perQueue.map((r, i) => ({
              key: `front-warp-qc-${r.queue_name}-${r.workload_class}-${i}`,
              cells: [
                <code key="q" className="text-xs">{r.queue_name}</code>,
                <Badge key="c" variant={r.workload_class === "front_ingestion" ? "default" : "outline"}>
                  {r.workload_class}
                </Badge>,
                String(r.pending),
                String(r.processing),
                String(r.completed_5m),
                String(r.completed_30m),
              ],
            }))}
            empty="No rows."
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Task #2088 — Front recovery parked-window visibility. Read-only.
 * "Currently parked" is the point-in-time set; "this period" counts come
 * from the bounded park/unpark breadcrumb log (last 7d). Operator
 * un-park / re-arm lives on the Self-heal console, not here.
 */
function FrontParkedWindowsPanel(props: { data: FrontParkedWindowsPayload }) {
  const d = props.data;
  return (
    <Card data-testid="card-front-parked-windows">
      <CardHeader>
        <CardTitle>Front recovery — parked windows</CardTitle>
        <CardDescription>
          Windows the auto-closer stopped re-enqueueing (dead-run streaks).
          Period counts cover the last 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-6 text-sm">
          <div data-testid="stat-parked-currently">
            <div className="text-2xl font-bold">{d.currentlyParked}</div>
            <div className="text-muted-foreground">currently parked</div>
          </div>
          <div data-testid="stat-parked-this-period">
            <div className="text-2xl font-bold">{d.parkedInPeriod}</div>
            <div className="text-muted-foreground">parked (7d)</div>
          </div>
          <div data-testid="stat-auto-unparked-this-period">
            <div className="text-2xl font-bold">{d.autoUnparkedInPeriod}</div>
            <div className="text-muted-foreground">auto-unparked (7d)</div>
          </div>
          <div data-testid="stat-operator-unparked-this-period">
            <div className="text-2xl font-bold">{d.operatorUnparkedInPeriod}</div>
            <div className="text-muted-foreground">operator-unparked (7d)</div>
          </div>
        </div>
        <Table
          cols={["month", "dead runs", "parked at", "last checkpoint"]}
          rows={d.parkedWindows.map((w) => ({
            key: w.month,
            cells: [
              <code key="m" className="text-xs">{w.month}</code>,
              String(w.deadRuns),
              new Date(w.parkedAt).toLocaleString(),
              w.lastCheckpointAt
                ? new Date(w.lastCheckpointAt).toLocaleString()
                : "—",
            ],
          }))}
          empty="No windows are currently parked."
        />
      </CardContent>
    </Card>
  );
}

/**
 * Task #2171 — always-visible Front mirror health.
 *
 * Surfaces the same mirror-vs-webhook freshness verdict the background
 * watcher (Task #2146) alerts on, so operators can confirm health
 * proactively and after a fix instead of waiting for the next alert
 * tick. The numbers come from the watcher's exported
 * `evaluateFrontMirrorFreshness`, so this panel can never disagree with
 * the alert. The kill switch is not consulted here — health is always
 * shown.
 */
function fmtMinutesAge(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${Math.floor(min / (24 * 60))}d ${Math.floor((min % (24 * 60)) / 60)}h`;
}

function FrontMirrorFreshnessPanel(props: { data: FrontMirrorFreshnessPayload }) {
  const d = props.data;
  const stateMeta: Record<
    FrontMirrorFreshnessPayload["state"],
    { label: string; variant: "default" | "secondary" | "destructive"; testid: string }
  > = {
    mirror_fresh: { label: "Fresh", variant: "default", testid: "fresh" },
    frozen: { label: "Frozen", variant: "destructive", testid: "frozen" },
    no_webhook_traffic: {
      label: "No traffic",
      variant: "secondary",
      testid: "no-traffic",
    },
  };
  const meta = stateMeta[d.state];
  return (
    <Card data-testid="card-front-mirror-freshness">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Front email mirror health
          <Badge variant={meta.variant} data-testid={`status-mirror-${meta.testid}`}>
            {meta.label}
          </Badge>
        </CardTitle>
        <CardDescription>
          Compares the mirror's newest row (<code className="text-xs">MAX(created_at)</code>{" "}
          on <code className="text-xs">front_sync_emails</code>) against live Front
          webhook intake (<code className="text-xs">MAX(received_at)</code> on{" "}
          <code className="text-xs">source_event_log</code>). <b>Frozen</b> means
          webhooks are arriving but the mirror writer has stopped inserting rows.{" "}
          <b>No traffic</b> means no fresh Front webhooks, so mirror lag can't be
          judged. Same logic as the background watcher's alert.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-6 text-sm">
          <div data-testid="stat-mirror-latest">
            <div className="text-lg font-bold">{fmtMinutesAge(d.mirrorAgeMinutes)}</div>
            <div className="text-muted-foreground">mirror newest row</div>
            <div className="text-xs text-muted-foreground">
              {d.mirrorLatest ? new Date(d.mirrorLatest).toLocaleString() : "no rows"}
            </div>
          </div>
          <div data-testid="stat-webhook-latest">
            <div className="text-lg font-bold">{fmtMinutesAge(d.webhookAgeMinutes)}</div>
            <div className="text-muted-foreground">latest Front webhook</div>
            <div className="text-xs text-muted-foreground">
              {d.webhookLatest ? new Date(d.webhookLatest).toLocaleString() : "none"}
            </div>
          </div>
          <div data-testid="stat-mirror-lag">
            <div
              className={`text-lg font-bold ${d.state === "frozen" ? "text-red-600" : ""}`}
            >
              {fmtMinutesAge(d.mirrorBehindWebhookMinutes)}
            </div>
            <div className="text-muted-foreground">mirror behind webhook</div>
            <div className="text-xs text-muted-foreground">
              lag threshold {d.lagMinutes}m
            </div>
          </div>
          <div data-testid="stat-mirror-switch">
            <div className="text-lg font-bold">
              {d.mirrorSwitchEnabled ? "ON" : "OFF"}
            </div>
            <div className="text-muted-foreground">writer kill switch</div>
            <div className="text-xs text-muted-foreground">
              front_sync_emails_mirror_enabled
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="text-mirror-reason">
          {d.reason} · evaluated {new Date(d.evaluatedAt).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

function Table(props: {
  cols: string[];
  rows: { key: string; cells: React.ReactNode[] }[];
  empty: string;
}) {
  if (props.rows.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid="text-empty">{props.empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            {props.cols.map((c) => (
              <th key={c} className="py-2 pr-3 font-medium text-muted-foreground">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.key} className="border-b last:border-0" data-testid={`row-${r.key}`}>
              {r.cells.map((cell, i) => (
                <td key={i} className="py-2 pr-3 align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Task #1937 — pool-epic background-table size + last-prune panel.
 *
 * Shows current row-count estimate (pg_class.reltuples, cheap) and the
 * most-recent prune-deleted count for each of the tables that the
 * pruneTick() in poolAuditRollups.ts deletes from. Last-prune counts
 * are in-memory and reset on process restart — a long "—" after a
 * deploy is normal; an indefinite "—" alongside steady row-count
 * growth means the prune sweep is silently broken.
 */
function fmtRowCount(n: number | null): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtAgo(ts: number | null): string {
  if (ts == null) return "—";
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function PoolAuditTableSizesPanel(props: { rows: PoolAuditTableSizeRow[] }) {
  return (
    <Card data-testid="card-pool-audit-table-sizes">
      <CardHeader>
        <CardTitle>Background table sizes &amp; last prune</CardTitle>
        <CardDescription>
          Estimated row count (pg_class) and most-recent prune-deleted count for
          each pool-epic table that has a scheduled prune sweep. Last-prune
          counts are in-memory and reset on process restart — a "—" right
          after a deploy is normal; a "—" that stays for days alongside
          growing row counts means the sweep is silently broken.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table
          cols={["table", "rows (est.)", "last prune removed", "last prune at"]}
          rows={props.rows.map((r) => ({
            key: `pool-audit-size-${r.table}`,
            cells: [
              <code key="t" className="text-xs break-all" data-testid={`text-table-${r.table}`}>
                {r.table}
              </code>,
              r.rowCountError ? (
                <Badge key="rc" variant="destructive" data-testid={`text-rowcount-error-${r.table}`}>
                  err
                </Badge>
              ) : (
                <span key="rc" data-testid={`text-rowcount-${r.table}`}>{fmtRowCount(r.rowCount)}</span>
              ),
              <span key="lp" data-testid={`text-last-prune-${r.table}`}>
                {r.lastPruneDeleted == null ? "—" : fmtRowCount(r.lastPruneDeleted)}
              </span>,
              <span key="la" className="text-muted-foreground" data-testid={`text-last-prune-at-${r.table}`}>
                {fmtAgo(r.lastPruneAt)}
              </span>,
            ],
          }))}
          empty="No table size data available."
        />
      </CardContent>
    </Card>
  );
}
