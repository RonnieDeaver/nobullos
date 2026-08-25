// @db-pool-intent: worker
// @cross-instance-safe: per-instance by design — the interval flusher drains
//   THIS instance's in-memory route buckets into append-only
//   api_route_stats_windows rows (each instance's traffic is distinct data,
//   so N instances produce N valid sample rows, never duplicated work), and
//   the ~hourly retention prune is an idempotent range DELETE that is safe
//   to run concurrently from multiple instances.
/**
 * Task #3816 — App-wide request spine, part 4: rolling per-route API metrics.
 *
 * In-process aggregator fed by the access-log finish hook (every /api
 * request, including elided-from-log ones). Per route (`METHOD /api/x/:id`):
 *
 *  - a ring of the last {@link RING_SIZE} (durationMs, ts, statusClass)
 *    samples → rolling-window p50/p95/max/avg + 4xx/5xx rates for the
 *    health console and the regression alerter;
 *  - cumulative counters since boot;
 *  - an interval bucket that `flushOnce` drains to `api_route_stats_windows`
 *    every {@link FLUSH_INTERVAL_MS} so history survives restarts and the
 *    console can show trends.
 *
 * Cardinality is bounded twice: route keys come pre-normalized (UUIDs →
 * `:id`, see apiLabel.ts) and the map is capped at {@link MAX_ROUTES} with
 * least-recently-seen eviction (same discipline as db.ts labelStats).
 *
 * The module is import-light (no db/storage at top level) so middleware and
 * hermetic tests can use the aggregator without a DATABASE_URL; persistence
 * lazy-imports the worker pool inside the flush tick.
 */

export const RING_SIZE = 512;
export const MAX_ROUTES = 400;
export const FLUSH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_SUMMARY_WINDOW_MS = 15 * 60_000;
/** Persisted-window retention (pruned opportunistically from the flusher). */
export const RETENTION_MS = 14 * 24 * 60 * 60_000;
/** Cap rows per flush so a route-cardinality bug can't bloat the table. */
const MAX_ROUTES_PER_FLUSH = 60;
/** Pseudo-route aggregating every API request (overall spine health). */
export const ALL_ROUTES_KEY = "_ALL_";

interface RingSample {
  ts: number;
  ms: number;
  /** 2 | 3 | 4 | 5 — status class. */
  cls: number;
}

interface IntervalBucket {
  count: number;
  err4xx: number;
  err5xx: number;
  totalMs: number;
  maxMs: number;
  /** Bounded duration reservoir for interval percentiles. */
  samples: number[];
}

const INTERVAL_RESERVOIR = 200;

interface RouteStat {
  key: string;
  firstSeenAt: number;
  lastSeenAt: number;
  ring: RingSample[];
  ringIdx: number;
  cum: { count: number; err4xx: number; err5xx: number; totalMs: number; maxMs: number };
  bucket: IntervalBucket;
}

const routeStats = new Map<string, RouteStat>();

function newBucket(): IntervalBucket {
  return { count: 0, err4xx: 0, err5xx: 0, totalMs: 0, maxMs: 0, samples: [] };
}

function getOrCreate(key: string, now: number): RouteStat {
  let stat = routeStats.get(key);
  if (stat) return stat;
  if (routeStats.size >= MAX_ROUTES) {
    // Evict the least-recently-seen route (never the _ALL_ aggregate).
    let oldestKey: string | null = null;
    let oldestSeen = Infinity;
    for (const [k, s] of routeStats) {
      if (k === ALL_ROUTES_KEY) continue;
      if (s.lastSeenAt < oldestSeen) {
        oldestSeen = s.lastSeenAt;
        oldestKey = k;
      }
    }
    if (oldestKey) routeStats.delete(oldestKey);
  }
  stat = {
    key,
    firstSeenAt: now,
    lastSeenAt: now,
    ring: [],
    ringIdx: 0,
    cum: { count: 0, err4xx: 0, err5xx: 0, totalMs: 0, maxMs: 0 },
    bucket: newBucket(),
  };
  routeStats.set(key, stat);
  return stat;
}

function recordInto(stat: RouteStat, now: number, ms: number, cls: number): void {
  stat.lastSeenAt = now;
  const sample: RingSample = { ts: now, ms, cls };
  if (stat.ring.length < RING_SIZE) {
    stat.ring.push(sample);
  } else {
    stat.ring[stat.ringIdx] = sample;
    stat.ringIdx = (stat.ringIdx + 1) % RING_SIZE;
  }
  stat.cum.count += 1;
  stat.cum.totalMs += ms;
  if (ms > stat.cum.maxMs) stat.cum.maxMs = ms;
  if (cls === 4) stat.cum.err4xx += 1;
  if (cls === 5) stat.cum.err5xx += 1;
  const b = stat.bucket;
  b.count += 1;
  b.totalMs += ms;
  if (ms > b.maxMs) b.maxMs = ms;
  if (cls === 4) b.err4xx += 1;
  if (cls === 5) b.err5xx += 1;
  if (b.samples.length < INTERVAL_RESERVOIR) {
    b.samples.push(ms);
  } else {
    // Reservoir sampling keeps interval percentiles unbiased under load.
    const j = Math.floor(Math.random() * b.count);
    if (j < INTERVAL_RESERVOIR) b.samples[j] = ms;
  }
}

export function recordRequestSample(input: {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  now?: number;
}): void {
  try {
    const now = input.now ?? Date.now();
    const ms = Math.max(0, Math.round(input.durationMs));
    const cls = Math.min(5, Math.max(1, Math.floor(input.status / 100)));
    const key = `${input.method} ${input.route}`.slice(0, 180);
    recordInto(getOrCreate(key, now), now, ms, cls);
    recordInto(getOrCreate(ALL_ROUTES_KEY, now), now, ms, cls);
  } catch {
    // Metrics must never break a request.
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface RouteWindowStats {
  route: string;
  count: number;
  /** Requests per minute over the window. */
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

export interface RequestMetricsSummary {
  generatedAt: number;
  windowMs: number;
  overall: RouteWindowStats | null;
  routes: RouteWindowStats[];
  trackedRoutes: number;
}

function windowStats(stat: RouteStat, now: number, windowMs: number): RouteWindowStats | null {
  const since = now - windowMs;
  const durations: number[] = [];
  let count = 0;
  let err4xx = 0;
  let err5xx = 0;
  let totalMs = 0;
  let maxMs = 0;
  for (const s of stat.ring) {
    if (s.ts < since) continue;
    count += 1;
    totalMs += s.ms;
    durations.push(s.ms);
    if (s.ms > maxMs) maxMs = s.ms;
    if (s.cls === 4) err4xx += 1;
    if (s.cls === 5) err5xx += 1;
  }
  if (count === 0) return null;
  durations.sort((a, b) => a - b);
  return {
    route: stat.key,
    count,
    rpm: Math.round((count / (windowMs / 60_000)) * 10) / 10,
    err4xx,
    err5xx,
    err5xxRatePct: Math.round((err5xx / count) * 1000) / 10,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs,
    avgMs: Math.round(totalMs / count),
    lastSeenAt: stat.lastSeenAt,
  };
}

export function getRequestMetricsSummary(options?: {
  windowMs?: number;
  limit?: number;
  minCount?: number;
  now?: number;
}): RequestMetricsSummary {
  const now = options?.now ?? Date.now();
  const windowMs = Math.max(60_000, Math.min(60 * 60_000, options?.windowMs ?? DEFAULT_SUMMARY_WINDOW_MS));
  const limit = Math.max(1, Math.min(200, options?.limit ?? 50));
  const minCount = Math.max(1, options?.minCount ?? 1);
  let overall: RouteWindowStats | null = null;
  const routes: RouteWindowStats[] = [];
  for (const stat of routeStats.values()) {
    const w = windowStats(stat, now, windowMs);
    if (!w) continue;
    if (stat.key === ALL_ROUTES_KEY) {
      overall = w;
      continue;
    }
    if (w.count < minCount) continue;
    routes.push(w);
  }
  routes.sort((a, b) => b.count - a.count);
  return {
    generatedAt: now,
    windowMs,
    overall,
    routes: routes.slice(0, limit),
    trackedRoutes: Math.max(0, routeStats.size - (routeStats.has(ALL_ROUTES_KEY) ? 1 : 0)),
  };
}

// ── periodic persistence ─────────────────────────────────────────────────────

export interface RouteStatsWindowRow {
  windowStartedAt: number;
  windowMs: number;
  route: string;
  count: number;
  err4xx: number;
  err5xx: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

type WindowWriter = (rows: RouteStatsWindowRow[]) => Promise<void>;

let writerOverride: WindowWriter | null = null;
let lastFlushStartedAt = 0;
let lastFlushInfo: { at: number; rows: number; error: string | null } | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInFlight = false;
let flushesSincePrune = 0;

async function defaultWriter(rows: RouteStatsWindowRow[]): Promise<void> {
  // Lazy import keeps this module DATABASE_URL-free for middleware/tests.
  const { workerDb, runWithWorkerDb, withDbAttribution } = await import("../db");
  const { apiRouteStatsWindows } = await import("@shared/schema");
  await runWithWorkerDb(() =>
    withDbAttribution("maintenance:request-metrics-flush", async () => {
      await workerDb.insert(apiRouteStatsWindows).values(
        rows.map((r) => ({
          windowStartedAt: r.windowStartedAt,
          windowMs: r.windowMs,
          route: r.route,
          count: r.count,
          err4xx: r.err4xx,
          err5xx: r.err5xx,
          p50Ms: r.p50Ms,
          p95Ms: r.p95Ms,
          maxMs: r.maxMs,
          avgMs: r.avgMs,
        })) as (typeof apiRouteStatsWindows.$inferInsert)[],
      );
      flushesSincePrune += 1;
      if (flushesSincePrune >= 12) {
        // ~hourly: prune windows past retention (index-backed range delete).
        flushesSincePrune = 0;
        const { sql } = await import("drizzle-orm");
        const cutoff = Date.now() - RETENTION_MS;
        await workerDb.execute(
          sql`DELETE FROM api_route_stats_windows WHERE window_started_at < ${cutoff}`,
        );
      }
    }),
  );
}

/**
 * Drain interval buckets into one persisted row per active route (top
 * {@link MAX_ROUTES_PER_FLUSH} by count, plus the _ALL_ aggregate). Buckets
 * reset even when the write fails — metrics are best-effort and a retry
 * with stale windows would double-count.
 */
export async function flushOnce(now: number = Date.now()): Promise<{ rows: number; error: string | null }> {
  const windowStartedAt = lastFlushStartedAt || now - FLUSH_INTERVAL_MS;
  lastFlushStartedAt = now;
  const candidates: Array<{ stat: RouteStat; bucket: IntervalBucket }> = [];
  for (const stat of routeStats.values()) {
    if (stat.bucket.count === 0) continue;
    candidates.push({ stat, bucket: stat.bucket });
    stat.bucket = newBucket();
  }
  if (candidates.length === 0) {
    lastFlushInfo = { at: now, rows: 0, error: null };
    return { rows: 0, error: null };
  }
  const all = candidates.filter((c) => c.stat.key === ALL_ROUTES_KEY);
  const perRoute = candidates
    .filter((c) => c.stat.key !== ALL_ROUTES_KEY)
    .sort((a, b) => b.bucket.count - a.bucket.count)
    .slice(0, MAX_ROUTES_PER_FLUSH);
  const rows: RouteStatsWindowRow[] = [...all, ...perRoute].map(({ stat, bucket }) => {
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    return {
      windowStartedAt,
      windowMs: Math.max(1, now - windowStartedAt),
      route: stat.key,
      count: bucket.count,
      err4xx: bucket.err4xx,
      err5xx: bucket.err5xx,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: bucket.maxMs,
      avgMs: Math.round(bucket.totalMs / bucket.count),
    };
  });
  try {
    await (writerOverride ?? defaultWriter)(rows);
    lastFlushInfo = { at: now, rows: rows.length, error: null };
    return { rows: rows.length, error: null };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    lastFlushInfo = { at: now, rows: 0, error: msg };
    console.warn(`[RequestMetrics] flush failed (${rows.length} rows dropped): ${msg}`);
    return { rows: 0, error: msg };
  }
}

export function getPersistenceInfo(): { lastFlush: typeof lastFlushInfo; intervalMs: number } {
  return { lastFlush: lastFlushInfo, intervalMs: FLUSH_INTERVAL_MS };
}

export function startRequestMetricsFlusher(): void {
  if (flushTimer) return;
  lastFlushStartedAt = Date.now();
  flushTimer = setInterval(() => {
    if (flushInFlight) return;
    flushInFlight = true;
    void flushOnce()
      .catch((err) => console.warn(`[RequestMetrics] flush tick failed: ${err?.message ?? err}`))
      .finally(() => {
        flushInFlight = false;
      });
  }, FLUSH_INTERVAL_MS);
  if (typeof (flushTimer as any).unref === "function") (flushTimer as any).unref();
  console.log(
    `[RequestMetrics] flusher started — persisting per-route windows every ${FLUSH_INTERVAL_MS / 60_000} min (retention ${RETENTION_MS / 86_400_000}d)`,
  );
}

export function stopRequestMetricsFlusher(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export const __testHelpers = {
  resetForTests(): void {
    routeStats.clear();
    lastFlushStartedAt = 0;
    lastFlushInfo = null;
    flushesSincePrune = 0;
  },
  setWriterForTests(fn: WindowWriter | null): void {
    writerOverride = fn;
  },
  routeCountForTests(): number {
    return routeStats.size;
  },
};
