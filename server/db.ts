// @cross-instance-safe: purely in-process — sweeps this instance's own connection-pool idle list; no shared state.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, PoolConfig, PoolClient } from "pg";
import { AsyncLocalStorage } from "async_hooks";
import * as schema from "@shared/schema";
import { PERF } from "./perfConfig";
import { getApiPoolPressureTuning } from "./services/apiPoolPressureTuning";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

// ─── DB Scale Layer epic — connection-string routing ─────────────────
//
// Spec: `.local/tasks/db-scale-layer-redis-pgbouncer.md` (Phase 4/5).
//
// Three logical roles:
//   • DIRECT      — every pool defaults here. Session-state-safe (advisory
//                   locks, long transactions, named prepared statements,
//                   `LISTEN/NOTIFY`, migrations) all work.
//   • POOLED      — Neon's `-pooler` host (PgBouncer transaction mode). Use
//                   for stateless request/response API traffic only.
//   • MIGRATIONS  — always direct. Schema changes must never go through
//                   PgBouncer in transaction mode.
//
// Env var precedence:
//   DATABASE_URL_DIRECT     → DIRECT      (else: DATABASE_URL)
//   DATABASE_URL_POOLED     → POOLED      (else: DIRECT)
//   DATABASE_URL_MIGRATIONS → MIGRATIONS  (else: DIRECT)
//
// Only the api pool routes to POOLED. Worker + probe stay DIRECT
// because they hold session-affine state (advisory locks, long
// transactions, the warm 1-connection probe loop). To roll back, unset
// `DATABASE_URL_POOLED` and restart — that's the single config flip.
//
// ─── PgBouncer transaction-mode compatibility notes (Phase 4) ────────
// The `pg` driver + Drizzle node-postgres combo works under PgBouncer
// transaction-mode pooling without changes IF the following hold (all
// true in this codebase, verified May 2026):
//   1. No `client.prepare(name, ...)` with explicit statement names.
//      Drizzle issues every parameterized query with an empty
//      statement name through pg's extended protocol, which PgBouncer
//      treats as anonymous and does not pin to a backend. We grep for
//      explicit `.prepare(` calls and find none on the api hot path.
//   2. No `LISTEN`/`NOTIFY`, no `SET LOCAL`/session GUCs, no advisory
//      locks, no temp tables in request handlers. These all require
//      session-mode pooling. Workers that need them already live on
//      the DIRECT `workerDb` per the Pool Tenancy rules.
//   3. Transactions are short and do not span network boundaries.
//      PgBouncer pins a backend connection only for the lifetime of
//      one transaction; long-held transactions defeat pooling.
//
// First production deploy with `DATABASE_URL_POOLED` set should be
// watched for `prepared statement "S_N" does not exist` errors in
// the request logs. If they appear, rollback is the single env-var
// unset described above. See `RUNBOOKS.md` for the watch window.
const DB_URL_DIRECT = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL!;
const DB_URL_POOLED = process.env.DATABASE_URL_POOLED ?? DB_URL_DIRECT;
export const MIGRATION_CONNECTION_STRING =
  process.env.DATABASE_URL_MIGRATIONS ?? DB_URL_DIRECT;

// ─── Task #3797: hermetic test-DB guard ──────────────────────────────
//
// Test mode must never touch the shared Helium dev database or any Neon
// host. `npm test` provisions a private throwaway Postgres per run (see
// tests/hermetic/provision.ts) and injects its URL into every connection-
// string variant; a test process that still resolves to the shared dev DB
// means the harness was bypassed (bare `NODE_ENV=test npx tsx …`) or is
// broken — fail loudly at import time instead of silently mutating shared
// state. There is NO escape hatch: the per-suite `sharedDev` tag was
// retired in Task #3862, and the whole-run TEST_SHARED_DEV_DB=1 legacy
// mode was retired once confirmed unused — every suite runs hermetically.
if (process.env.NODE_ENV === "test") {
  const roleUrls: Array<[string, string]> = [
    ["DIRECT", DB_URL_DIRECT],
    ["POOLED", DB_URL_POOLED],
    ["MIGRATIONS", MIGRATION_CONNECTION_STRING],
  ];
  for (const [role, rawUrl] of roleUrls) {
    let hostname = "";
    let pathname = "";
    try {
      const u = new URL(rawUrl);
      hostname = u.hostname;
      pathname = u.pathname;
    } catch {
      /* unparseable → substring checks below still apply */
    }
    if (
      (hostname.endsWith("neon.tech") || rawUrl.includes("neon.tech")) &&
      process.env.ALLOW_PROD_DB_TESTS !== "1"
    ) {
      throw new Error(
        `[db] Test mode refuses the production Neon database (${role} URL). Tests mutate schema and data.`,
      );
    }
    const isSharedDev = pathname === "/heliumdb" || (hostname === "" && rawUrl.includes("heliumdb"));
    if (isSharedDev) {
      throw new Error(
        `[db] Test mode refuses the SHARED dev database (${role} URL → heliumdb). ` +
          `Run suites through the harness: \`npm test\` (full) or ` +
          `\`npm test -- --file=tests/<suite>.test.ts\` (single file) — it provisions a private ` +
          `per-run Postgres and injects its URL. See TESTING.md. There is no ` +
          `escape hatch — make the suite hermetic (self-seed fixtures on the per-run DB).`,
      );
    }
  }
}

const API_POOL_USING_POOLED = DB_URL_POOLED !== DB_URL_DIRECT;
if (API_POOL_USING_POOLED) {
  // Mask host for the boot log so we never echo credentials.
  let host = "unknown";
  try {
    host = new URL(DB_URL_POOLED).host;
  } catch {}
  console.log(`[DB] API pool routed through pooled URL (host=${host})`);
}
export function isApiPoolUsingPgBouncer(): boolean {
  return API_POOL_USING_POOLED;
}

let slowAcquireCountApi = 0;
let slowAcquireCountWorker = 0;
// Task #818: Phase 0 — separate counters for actual client-hold duration
// (connect → release) so we can distinguish "slot was held" from "client was
// actually checked out" in the per-interval pool stats line.
let slowHoldCountApi = 0;
let slowHoldCountWorker = 0;

// Task #818: Phase 0 — handler label propagated through the async tree so
// that long client holds can be attributed to the ingestion path that
// caused them. Set at the top of an ingestion handler with
// `withDbHoldLabel(label, fn)` and read inside the pool wrapper when a
// client is checked out. Defaults to "unknown" outside any handler.
//
// Task #836: Phase 1 — switched from a plain string to a mutable ref so
// that an outer Express middleware can install a fallback label at
// request entry, and an inner per-route step can refine it to the
// matched route pattern (e.g. `api:GET /api/clients/:id`) before any DB
// checkout reads it. Holding a ref instead of a string means the read
// inside `wrapHoldOnce` always sees the most-recent label set in this
// async context.
type LabelRef = { label: string };
const dbHoldLabelStorage = new AsyncLocalStorage<LabelRef>();

// Task #836 Phase 1: per-pool counter of long client holds that resolved
// with the literal "unknown" label. Surfaced through
// `getDbHoldLabelCounters()` so the Health dashboard can flag missing
// attribution as a regression.
let unknownHoldCountApi = 0;
let unknownHoldCountWorker = 0;

// Task #836 Phase 1 (post-review): track API checkouts that resolved
// with a *fallback* label (a normalized URL) instead of a matched
// route pattern. This is the "best-effort attribution failed" signal
// the reviewer asked us to surface — it goes up whenever the
// `setImmediate` refinement path could not find `req.route`.
let fallbackLabelCountApi = 0;
export function recordApiFallbackLabelHit(): void {
  fallbackLabelCountApi++;
}
export function getApiFallbackLabelCount(): number {
  return fallbackLabelCountApi;
}

// Task #836 Phase 8: rolling top-N labels by count and by max hold
// duration since process start (or since last reset). Bounded in size
// by `LABEL_STATS_MAX_KEYS`; least-recently-incremented entries are
// evicted past the cap so a noisy long-tail cannot blow up memory.
interface LabelStat {
  label: string;
  count: number;
  totalMs: number;
  maxMs: number;
  lastSeenAt: number;
  pool: "api" | "worker";
  // Task #1722 Phase 1.5 — Bounded ring buffer of recent hold durations
  // so we can compute a per-label p95 on demand without storing every
  // sample. Memory cap = LABEL_STATS_MAX_KEYS (500) * LABEL_SAMPLE_CAP
  // (128) * 8B ≈ 500KB worst case.
  samples: number[];
  sampleHead: number;
  sampleFilled: number;
}
const labelStats = new Map<string, LabelStat>();
const LABEL_STATS_MAX_KEYS = 500;
const LABEL_SAMPLE_CAP = 128;

function recordLabelStat(label: string, pool: "api" | "worker", elapsedMs: number): void {
  const key = `${pool}::${label}`;
  let entry = labelStats.get(key);
  if (!entry) {
    if (labelStats.size >= LABEL_STATS_MAX_KEYS) {
      // Evict oldest by lastSeenAt
      let oldestKey: string | null = null;
      let oldestSeen = Infinity;
      for (const [k, v] of labelStats) {
        if (v.lastSeenAt < oldestSeen) {
          oldestSeen = v.lastSeenAt;
          oldestKey = k;
        }
      }
      if (oldestKey) labelStats.delete(oldestKey);
    }
    entry = {
      label,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      lastSeenAt: 0,
      pool,
      samples: new Array(LABEL_SAMPLE_CAP),
      sampleHead: 0,
      sampleFilled: 0,
    };
    labelStats.set(key, entry);
  }
  entry.count++;
  entry.totalMs += elapsedMs;
  if (elapsedMs > entry.maxMs) entry.maxMs = elapsedMs;
  entry.lastSeenAt = Date.now();
  entry.samples[entry.sampleHead] = elapsedMs;
  entry.sampleHead = (entry.sampleHead + 1) % LABEL_SAMPLE_CAP;
  if (entry.sampleFilled < LABEL_SAMPLE_CAP) entry.sampleFilled++;
}

function computePercentile(samples: number[], filled: number, p: number): number {
  if (filled === 0) return 0;
  const sorted = samples.slice(0, filled).sort((a, b) => a - b);
  const idx = Math.min(filled - 1, Math.max(0, Math.ceil(p * filled) - 1));
  return sorted[idx];
}

// Test-only seam: exposed so unit tests can simulate recorded hold
// events without booting the pool. Production code should rely on the
// pool wrapper feeding `recordLabelStat` via `withDbHoldLabel`.
export function __recordDbHoldEventForTest(
  pool: "api" | "worker",
  label: string,
  elapsedMs: number,
): void {
  recordLabelStat(label, pool, elapsedMs);
}

export function getDbHoldLabelCounters(): { api: { unknown: number }; worker: { unknown: number } } {
  return {
    api: { unknown: unknownHoldCountApi },
    worker: { unknown: unknownHoldCountWorker },
  };
}

// Task #913C — Attribution-quality metric. Reports per-pool total holds
// recorded since process start (or last reset), how many were attributed
// to a real label (anything other than literal `unknown`), and the
// `unknown`-percentage. Surfaced through `/api/health/db-attribution` so
// the Health surface (and 913E's Admin UI) can flag attribution
// regressions on its own — i.e. before they show up as unactionable
// pool-state samples.
export interface DbAttributionQualityForPool {
  totalHolds: number;
  attributedHolds: number;
  unknownHolds: number;
  unknownPct: number;
  uniqueLabels: number;
}

export function getDbAttributionQuality(): {
  api: DbAttributionQualityForPool;
  worker: DbAttributionQualityForPool;
} {
  const computeFor = (poolName: "api" | "worker"): DbAttributionQualityForPool => {
    const all = Array.from(labelStats.values()).filter((s) => s.pool === poolName);
    const totalHolds = all.reduce((s, e) => s + e.count, 0);
    // Task #959: count both the legacy bare `unknown` (true no-scope) and
    // the structured `unattributed:<pool>` fallback emitted by
    // `wrapHoldOnce` so the unknown_label_pct metric still reflects all
    // unattributed checkouts even though the dashboard now sees a named
    // bucket per pool.
    const unknownHolds = all
      .filter((e) => e.label === "unknown" || e.label.startsWith("unattributed:"))
      .reduce((s, e) => s + e.count, 0);
    const attributedHolds = totalHolds - unknownHolds;
    const unknownPct =
      totalHolds > 0 ? Math.round((unknownHolds / totalHolds) * 1000) / 10 : 0;
    return {
      totalHolds,
      attributedHolds,
      unknownHolds,
      unknownPct,
      uniqueLabels: all.length,
    };
  };
  return { api: computeFor("api"), worker: computeFor("worker") };
}

export function getTopDbHoldLabels(pool: "api" | "worker", limit = 10): {
  byCount: Array<{ label: string; count: number; totalMs: number; maxMs: number }>;
  byMaxMs: Array<{ label: string; count: number; totalMs: number; maxMs: number }>;
  byTotalMs: Array<{ label: string; count: number; totalMs: number; maxMs: number }>;
  unknownPct: number;
} {
  const all = Array.from(labelStats.values()).filter(s => s.pool === pool);
  const totalCount = all.reduce((s, e) => s + e.count, 0);
  const unknownCount = all
    .filter(e => e.label === "unknown" || e.label.startsWith("unattributed:"))
    .reduce((s, e) => s + e.count, 0);
  const unknownPct = totalCount > 0 ? Math.round((unknownCount / totalCount) * 1000) / 10 : 0;
  const project = (e: LabelStat) => ({
    label: e.label,
    count: e.count,
    totalMs: e.totalMs,
    maxMs: e.maxMs,
  });
  const byCount = [...all].sort((a, b) => b.count - a.count).slice(0, limit).map(project);
  const byMaxMs = [...all].sort((a, b) => b.maxMs - a.maxMs).slice(0, limit).map(project);
  const byTotalMs = [...all].sort((a, b) => b.totalMs - a.totalMs).slice(0, limit).map(project);
  return { byCount, byMaxMs, byTotalMs, unknownPct };
}

// Task #1722 Phase 1.5 — Per-label DB-time observability with p95.
// Feeds `/api/_internal/db-metrics`. Each entry summarizes a single
// attribution label (typically `route:<METHOD path>` for API requests,
// `worker:<queue>` for background jobs); p50/p95/p99 are computed from
// the in-memory ring buffer (last ${LABEL_SAMPLE_CAP} holds).
export interface LabelTimingSummary {
  label: string;
  pool: "api" | "worker";
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  sampleSize: number;
  lastSeenAt: number;
}

export function getLabelTimingsByP95(
  pool: "api" | "worker",
  limit = 25,
  opts: { minCount?: number } = {},
): LabelTimingSummary[] {
  const minCount = Math.max(1, opts.minCount ?? 5);
  const all = Array.from(labelStats.values()).filter(
    (s) => s.pool === pool && s.count >= minCount,
  );
  const enriched = all.map<LabelTimingSummary>((e) => ({
    label: e.label,
    pool: e.pool,
    count: e.count,
    totalMs: Math.round(e.totalMs),
    avgMs: e.count > 0 ? Math.round((e.totalMs / e.count) * 10) / 10 : 0,
    maxMs: Math.round(e.maxMs),
    p50Ms: Math.round(computePercentile(e.samples, e.sampleFilled, 0.5)),
    p95Ms: Math.round(computePercentile(e.samples, e.sampleFilled, 0.95)),
    p99Ms: Math.round(computePercentile(e.samples, e.sampleFilled, 0.99)),
    sampleSize: e.sampleFilled,
    lastSeenAt: e.lastSeenAt,
  }));
  enriched.sort((a, b) => b.p95Ms - a.p95Ms || b.totalMs - a.totalMs);
  return enriched.slice(0, limit);
}

// ─── Task #913C — Canonical DB Hold-Label Attribution Contract ───────────
//
// Every DB checkout must occur within an attribution scope so the
// pool-state samples can answer "which route or worker is holding
// connections?". The label namespaces are:
//
//   route:<METHOD path>      e.g. `route:GET /api/clients/:id`
//                            (legacy alias still emitted as `api:METHOD path`
//                            by the API request middleware so existing
//                            dashboards keep rendering).
//   worker:<queue|name>      worker that pulls jobs off `work_queue` or
//                            otherwise processes background work.
//   scheduler:<name>         scheduler-loop tick that polls/dispatches
//                            (e.g. work-queue scheduler, autotuner).
//   startup:<phase>          one-shot work that runs on process boot
//                            (table bootstrap, ATS backfill, …).
//   middleware:<name>        Express middleware that itself does DB I/O
//                            before route matching (rate-limit warmer,
//                            auth resolution, …).
//   maintenance:<task>       periodic background sweep that isn't worker
//                            queue work (health metrics flush, audit
//                            retention, recording-archive reconciler, …).
//
// `unknown` is reserved for the "no scope at all" fallback. If a precise
// name isn't easily available, prefer a structured fallback inside the
// right namespace (e.g. `worker:unknown-worker-name`,
// `startup:bootstrap`, `middleware:auth`) over the bare literal.
//
// `withDbAttribution(label, fn)` is the canonical helper. It is an
// alias for `withDbHoldLabel` (kept for callers that already adopted
// the older name) so there is exactly one shared contract.
export function withDbHoldLabel<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return dbHoldLabelStorage.run({ label }, fn);
}

export function withDbAttribution<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return dbHoldLabelStorage.run({ label }, fn);
}

// Lightweight wrapper for setInterval tick handlers that want a
// per-tick attribution scope without nesting an extra closure at every
// call site. `wrapTickWithAttribution(label, fn)` returns a function
// that, when invoked, runs `fn` inside `withDbAttribution(label, …)`
// and converts a sync return into a resolved promise.
export function wrapTickWithAttribution(
  label: string,
  fn: () => unknown,
): () => Promise<void> {
  return () =>
    withDbAttribution(label, async () => {
      await fn();
    });
}

// Task #836 Phase 1: refine the active label after route matching. Safe
// to call whenever `withDbHoldLabel` (or the API request middleware)
// has already established a ref in the current async context. No-op
// outside such a context.
export function setCurrentDbHoldLabel(label: string): void {
  const ref = dbHoldLabelStorage.getStore();
  if (ref) ref.label = label;
}

export function getCurrentDbHoldLabel(): string {
  return dbHoldLabelStorage.getStore()?.label ?? "unknown";
}

// pg-pool reassigns `client.release` to a fresh `releaseOnce` on every
// acquire (see pg-pool/index.js `_acquireClient`). Wrapping the current
// `client.release` per checkout therefore does not chain across pooled
// reuse — the pool overwrites our wrap on the next acquire. The
// double-release guard is provided by pg's own `releaseOnce`.
type ReleaseFn = (arg?: boolean | Error) => void;

// ─── Task #815 — Connection max-lifetime ────────────────────────────────
// Neon (and most managed Postgres hosts) periodically recycles idle
// connections. When that happens, the next query through that client
// raises a transient error which Task #813's `dbRetry` absorbs and
// counts. To eliminate the underlying churn, we cap how long any pooled
// client may live and proactively retire it on our own schedule before
// the host does.
//
// Two enforcement points:
//   (a) On release: if the client has lived past its effective lifetime,
//       we forward `release(err)` so pg-pool destroys it instead of
//       returning it to the idle list.
//   (b) Periodic sweep: idle clients that never get checked out again
//       still need to be retired before the host kills them. Every
//       `DB_CONN_LIFETIME_SWEEP_MS` we walk the pool's idle list and
//       remove over-aged entries through pg-pool's internal `_remove`.
//
// A small per-client jitter is applied at connect time so we don't
// evict the entire pool at the same moment.
const clientBornAt = new WeakMap<PoolClient, number>();
const clientMaxLifetimeMs = new WeakMap<PoolClient, number>();
let connectionRecycleCount = 0;

function effectiveLifetimeForNewClient(overrideBase?: number): number {
  const base = overrideBase ?? PERF.DB_CONN_MAX_LIFETIME_MS;
  if (base <= 0) return 0;
  if (overrideBase !== undefined) {
    // Test seam: skip jitter and the 1s floor so unit tests can pin a
    // tiny lifetime (e.g. 200ms) deterministically.
    return base;
  }
  const jitter = Math.floor(base * 0.1 * (Math.random() * 2 - 1));
  return Math.max(1000, base + jitter);
}

function isClientExpired(client: PoolClient): boolean {
  const max = clientMaxLifetimeMs.get(client);
  if (!max || max <= 0) return false;
  const born = clientBornAt.get(client);
  if (!born) return false;
  return Date.now() - born >= max;
}

interface LifetimeOverride {
  maxLifetimeMs: number;
  sweepIntervalMs: number;
}

function installConnectionLifetime(
  targetPool: Pool,
  label: string,
  override?: LifetimeOverride,
): { stop: () => void } | void {
  const effectiveMax = override?.maxLifetimeMs ?? PERF.DB_CONN_MAX_LIFETIME_MS;
  const effectiveSweep = override?.sweepIntervalMs ?? PERF.DB_CONN_LIFETIME_SWEEP_MS;
  if (effectiveMax <= 0) return;
  const onConnect = (client: PoolClient) => {
    clientBornAt.set(client, Date.now());
    clientMaxLifetimeMs.set(
      client,
      effectiveLifetimeForNewClient(override ? effectiveMax : undefined),
    );
  };
  targetPool.on("connect", onConnect);
  const sweep = () => {
    try {
      const internals = targetPool as unknown as {
        _idle?: Array<{ client: PoolClient }>;
        _remove?: (client: PoolClient) => void;
      };
      const idle = internals._idle;
      const remove = internals._remove;
      if (!Array.isArray(idle) || typeof remove !== "function") return;
      for (const item of idle.slice()) {
        const client = item?.client;
        if (client && isClientExpired(client)) {
          try {
            remove.call(targetPool, client);
            connectionRecycleCount++;
            console.log(
              `[DB Pool] Recycled idle ${label} connection past max lifetime` +
              ` (lifetime_ms=${clientMaxLifetimeMs.get(client) ?? 0})`,
            );
          } catch (err: any) {
            console.warn(
              `[DB Pool] Failed to recycle idle ${label} connection: ${err?.message ?? err}`,
            );
          }
        }
      }
    } catch (err: any) {
      console.warn(`[DB Pool] Lifetime sweep error on ${label}: ${err?.message ?? err}`);
    }
  };
  const interval = setInterval(sweep, effectiveSweep);
  if (typeof interval.unref === "function") interval.unref();
  return {
    stop: () => {
      clearInterval(interval);
      targetPool.off("connect", onConnect);
    },
  };
}

// Test seam: lets unit tests install the same lifetime + sweep policy on
// a throwaway pool with a tiny `maxLifetimeMs` so the Task #815 contract
// (recycle expired clients on release, sweep idle expired clients) can be
// exercised end-to-end without waiting 25 minutes. Returns a `stop()`
// handle the test must call to clear the interval and detach the
// listener. Production code must continue to use the no-override call
// sites in this file.
export function __installConnectionLifetimeForTest(
  targetPool: Pool,
  label: string,
  override: LifetimeOverride,
): { stop: () => void } {
  const handle = installConnectionLifetime(targetPool, label, override);
  if (!handle) {
    throw new Error("__installConnectionLifetimeForTest: maxLifetimeMs must be > 0");
  }
  return handle;
}

// Test seam: exposes the `InstrumentedPool` constructor so unit tests
// can verify the release-time recycle path (which lives in
// `wrapHoldOnce`). Not used by production code.
export function __makeInstrumentedPoolForTest(
  config: PoolConfig,
  label: string,
): Pool {
  return new InstrumentedPool(config, label);
}

export function getConnectionRecycleCount(): number {
  return connectionRecycleCount;
}

class InstrumentedPool extends Pool {
  private poolLabel: string;

  constructor(config: PoolConfig, label: string) {
    super(config);
    this.poolLabel = label;
  }

  override connect(): Promise<PoolClient>;
  override connect(
    callback: (err: Error | undefined, client: PoolClient | undefined, done: (release?: Error) => void) => void,
  ): void;
  override connect(
    callback?: (err: Error | undefined, client: PoolClient | undefined, done: (release?: Error) => void) => void,
  ): Promise<PoolClient> | void {
    const start = performance.now();
    if (callback) {
      return super.connect((err, client, done) => {
        if (!err && client) {
          const elapsed = Math.round(performance.now() - start);
          this.logAcquireWait(elapsed);
          // In pg-pool, `done` IS `client.release` (same reference). Wrap
          // once on the client and pass the wrapper through as `done` so
          // both consumer styles route through a single instrumentation.
          const wrapped = this.wrapHoldOnce(client);
          callback(undefined, client, wrapped);
          return;
        }
        callback(err, client, done);
      });
    }
    return super.connect().then((client) => {
      const elapsed = Math.round(performance.now() - start);
      this.logAcquireWait(elapsed);
      this.wrapHoldOnce(client);
      return client;
    });
  }

  // Wrap the current `client.release` once per checkout; record the first
  // call and forward through. Returns the wrapper so the callback variant
  // can reuse it as `done` (in pg-pool, `done` and `client.release` share
  // the same reference).
  private wrapHoldOnce(client: PoolClient): ReleaseFn {
    const holdStart = performance.now();
    // Task #836 Phase 1: capture the label *ref* at acquire time and read
    // it at release time. The Express middleware may refine the label
    // mid-request after the matched route is known, and we want the
    // attribution recorded against the most-specific label seen.
    const labelRef = dbHoldLabelStorage.getStore();
    const original: ReleaseFn = client.release.bind(client);
    let recorded = false;
    const wrapped: ReleaseFn = (arg?: boolean | Error) => {
      if (!recorded) {
        recorded = true;
        const elapsed = Math.round(performance.now() - holdStart);
        // Task #959: structured fallback. When no AsyncLocalStorage scope
        // is in place we still know which pool the checkout came from, so
        // emit `unattributed:<pool>` instead of the literal `unknown`.
        // Reserve raw `unknown` only for the (now unreachable) case where
        // the pool label itself is missing. Both buckets continue to be
        // counted as unattributed in `getDbAttributionQuality` /
        // `getTopDbHoldLabels` so the unknown_label_pct metric remains
        // comparable across the #959 cutover.
        const fallbackLabel = this.poolLabel === "api" || this.poolLabel === "worker"
          ? `unattributed:${this.poolLabel}`
          : "unknown";
        const label = labelRef?.label ?? fallbackLabel;
        // Always record into the rolling label stats so the dashboard can
        // surface the top offenders even when no individual hold trips
        // the long-hold warning.
        recordLabelStat(label, this.poolLabel as "api" | "worker", elapsed);
        if (label === "unknown" || label.startsWith("unattributed:")) {
          if (this.poolLabel === "api") unknownHoldCountApi++;
          else unknownHoldCountWorker++;
        }
        this.logHoldDuration(elapsed, label);
      }
      // Task #815: if the underlying client has lived past its max
      // lifetime, force pg-pool to discard it instead of returning it
      // to the idle list. We only do this when the caller did not
      // already pass a release-with-error (preserving the existing
      // semantics for explicit error-driven discards).
      if (!arg && isClientExpired(client)) {
        connectionRecycleCount++;
        console.log(
          `[DB Pool] Recycled ${this.poolLabel} connection on release past max lifetime` +
          ` (lifetime_ms=${clientMaxLifetimeMs.get(client) ?? 0})`,
        );
        original(new Error("connection retired: max lifetime exceeded"));
        return;
      }
      original(arg);
    };
    client.release = wrapped;
    return wrapped;
  }

  private logAcquireWait(elapsedMs: number): void {
    // Live-tunable threshold — falls back to PERF when no override row.
    const tuning = getApiPoolPressureTuning();
    if (elapsedMs > tuning.acquireWaitWarnMs) {
      const active = this.totalCount - this.idleCount;
      if (this.poolLabel === "api") {
        slowAcquireCountApi++;
        // Task #836 Phase 2: feed the rolling window used by
        // `isApiPoolUnderPressure()` so background jobs back off when
        // recent API acquires are slow, not only when the per-interval
        // counter is high.
        recordApiSlowAcquireForBackoff();
      } else slowAcquireCountWorker++;
      console.warn(
        `[DB Pool] ⚠ Slow acquire on ${this.poolLabel}: ${elapsedMs}ms` +
        ` (threshold ${tuning.acquireWaitWarnMs}ms, active=${active}, waiting=${this.waitingCount})`
      );
    }
  }

  private logHoldDuration(elapsedMs: number, label: string): void {
    if (elapsedMs <= PERF.DB_HOLD_WARN_MS) return;
    if (this.poolLabel === "api") slowHoldCountApi++;
    else slowHoldCountWorker++;
    const active = this.totalCount - this.idleCount;
    console.warn(
      `[DB Pool] ⚠ Long client hold on ${this.poolLabel}: ${elapsedMs}ms` +
      ` (threshold ${PERF.DB_HOLD_WARN_MS}ms, label=${label}, active=${active}, waiting=${this.waitingCount})`
    );
    // Task #1731 (Pool epic Phase 4, spec 4.3) — layer the 10s warn /
    // 30s critical tiers on top of the existing 1s warning. Lazy-import
    // avoids a server/db.ts ↔ services/* require cycle at module load.
    if (elapsedMs >= 10_000) {
      void import("./services/longDbHoldAlerts")
        .then(({ recordDbHoldDuration }) => {
          try {
            recordDbHoldDuration({
              pool: this.poolLabel,
              label,
              durationMs: elapsedMs,
              callerLabel: label,
              requestId: null,
            });
          } catch {
            // never let the alert path destabilise the pool-release path
          }
        })
        .catch(() => {});
    }
  }
}

// ─── Task #2084 — Shared test teardown: let DB-touching suites exit cleanly ──
//
// Every test file runs in its own child process (see `tests/run-all.ts`) and
// transitively imports this module, which warms the pg pools. A pool's idle
// client sockets are active libuv handles that keep the Node event loop alive,
// so a suite that finishes its assertions but only `return`s/`await`s would
// hang until the harness SIGTERMs it on the per-file timeout — reported as a
// false failure. The historical stopgap was a manual `process.exit()` at the
// end of each suite, which is per-suite and easy to forget.
//
// Instead, in test mode we make idle pooled sockets stop pinning the loop:
//   • on `acquire`  → `ref()` the socket, so an in-flight query (its client is
//                     checked out) always keeps the process alive until the
//                     response lands; nothing is ever abandoned mid-query.
//   • on `connect`/`release` → `unref()` the socket, so a quiescent pool no
//                     longer holds the loop open.
// When a suite's work is done, every connection is idle + unref'd, the loop
// drains, and the child exits on its own — no `process.exit()` needed. We also
// register a one-shot `beforeExit` hook (reachable only because the sockets are
// unref'd) that gracefully `end()`s the pools. Gated on NODE_ENV==='test' so
// the long-running server is never affected.
const IS_TEST = process.env.NODE_ENV === "test";

function setPoolClientSocketRef(client: PoolClient, shouldRef: boolean): void {
  try {
    const stream = (client as unknown as {
      connection?: { stream?: { ref?: () => void; unref?: () => void } };
    }).connection?.stream;
    if (!stream) return;
    if (shouldRef) stream.ref?.();
    else stream.unref?.();
  } catch {
    // Best-effort: never let ref/unref bookkeeping destabilize the pool.
  }
}

function installTestSocketUnref(targetPool: Pool): void {
  if (!IS_TEST) return;
  targetPool.on("connect", (client) => setPoolClientSocketRef(client, false));
  targetPool.on("acquire", (client) => setPoolClientSocketRef(client, true));
  targetPool.on("release", (_err, client) => setPoolClientSocketRef(client, false));
}

const pool = new InstrumentedPool({
  connectionString: DB_URL_POOLED,
  min: PERF.DB_API_POOL_MIN,
  max: PERF.DB_API_POOL_MAX,
  // Task #2084: in test mode disable pg-pool's idle reaper. The reaper is a
  // *ref'd* `setTimeout(idleTimeoutMillis)` armed on every release — it, not
  // the socket, is the active handle that keeps a child suite's event loop
  // alive. With it off (0) and the idle socket unref'd, a quiescent pool no
  // longer pins the process and the suite exits on its own.
  idleTimeoutMillis: IS_TEST ? 0 : 30000,
  // API pool allows a 30s acquire during Neon cold-start handoff.
  // See Task #1630 / 2026-05-19 bootstrap auth-timeout incident.
  connectionTimeoutMillis: 30000,
  statement_timeout: 30000,
}, "api");

pool.on("error", (err) => {
  console.error("[DB Pool] Unexpected error on idle client:", err.message);
});

installConnectionLifetime(pool, "api");
installTestSocketUnref(pool);

// Task #813: dedicated tiny pool used exclusively by the Health dashboard
// probe. Max=1 means it never queues behind API/worker traffic, and the
// short statement/connection timeouts keep a stuck DB from masking itself
// as a healthy one. Anything that reads this pool reflects true DB
// round-trip latency without any API-pool acquire-wait conflation.
//
// We keep a single warm connection (min=1) and disable the idle timeout
// (idleTimeoutMillis=0) so the per-sample probe never pays for a cold
// reconnect — the round-trip metric stays representative of the DB wire
// latency. The sampler also strictly times only the SELECT 1 after the
// client has been acquired (see `collectSample`), so even on the rare
// cases when we do reconnect, the metric stays clean.
const probePool = new Pool({
  connectionString: DB_URL_DIRECT,
  min: 1,
  max: 1,
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});

probePool.on("error", (err) => {
  console.error("[DB ProbePool] Unexpected error on idle client:", err.message);
});

installConnectionLifetime(probePool, "probe");
installTestSocketUnref(probePool);

// Warm the probe pool eagerly so the very first sample after boot does
// not include reconnect handshake time.
probePool
  .connect()
  .then((client) => {
    client.release();
    console.log("[DB] Probe pool warmed up successfully (max 1)");
  })
  .catch((err) => {
    console.error("[DB] Probe pool warmup failed:", err.message);
  });

export { pool as apiPool, probePool };
// Task #1573 (Audit Track C): export workerPool so on-demand admin
// diagnostics (e.g. server/services/dbServerMetrics.ts) can use it
// instead of probePool, which is reserved for the health sampler.
export { workerPool };

pool.connect()
  .then((client) => {
    console.log(`[DB] API pool warmed up successfully (max ${PERF.DB_API_POOL_MAX})`);
    client.release();
  })
  .catch((err) => {
    console.error("[DB] API pool warmup failed:", err.message);
  });

export const db = drizzle(pool, { schema });

const workerPool = new InstrumentedPool({
  connectionString: DB_URL_DIRECT,
  min: PERF.DB_WORKER_POOL_MIN,
  max: PERF.DB_WORKER_POOL_MAX,
  // Task #2084: see api pool — disable the idle reaper timer in test mode.
  idleTimeoutMillis: IS_TEST ? 0 : 60000,
  connectionTimeoutMillis: 30000,
  statement_timeout: 120000,
}, "worker");

workerPool.on("error", (err) => {
  console.error("[DB WorkerPool] Unexpected error on idle client:", err.message);
});

installConnectionLifetime(workerPool, "worker");
installTestSocketUnref(workerPool);

workerPool.connect()
  .then((client) => {
    console.log(`[DB] Worker pool warmed up successfully (max ${PERF.DB_WORKER_POOL_MAX})`);
    client.release();
  })
  .catch((err) => {
    console.error("[DB] Worker pool warmup failed:", err.message);
  });

export const workerDb = drizzle(workerPool, { schema });

// Task #2084 — Idempotent shutdown for all three pools. In test mode it is
// invoked once from the `beforeExit` hook below for a graceful close; it is
// also exported so a suite (or future harness teardown) can `await` it
// explicitly if it ever needs deterministic closure before the loop drains.
let dbPoolsClosed = false;
// Task #3809: inside the run-all batch worker one process hosts many suites
// sequentially, so pool closure (an exit-hygiene concern for the
// process-per-suite world) must become a no-op — an ended pg Pool cannot be
// reopened and would fail every later suite's queries. The batch worker's
// sockets are unref'd (test mode) and the parent kills the process anyway.
const IS_BATCH_WORKER = process.env.RUN_ALL_BATCH_WORKER === "1";
export async function closeDbPools(): Promise<void> {
  if (dbPoolsClosed || IS_BATCH_WORKER) return;
  dbPoolsClosed = true;
  await Promise.allSettled([pool.end(), workerPool.end(), probePool.end()]);
}

if (IS_TEST && !IS_BATCH_WORKER) {
  // Reachable only because `installTestSocketUnref` unref'd the idle pool
  // sockets; once a suite's work finishes the loop empties, this fires once,
  // and we close the pools gracefully before the child exits.
  process.once("beforeExit", () => {
    void closeDbPools();
  });
}

let poolMonitorStarted = false;

function logPoolStats(targetPool: Pool, label: string, maxSize: number): boolean {
  const total = targetPool.totalCount;
  const idle = targetPool.idleCount;
  const waiting = targetPool.waitingCount;
  const active = total - idle;
  const rawUtilPct = maxSize > 0 ? (active / maxSize) * 100 : 0;
  const utilization_pct = Math.round(rawUtilPct);
  const isHigh = rawUtilPct > PERF.DB_POOL_UTIL_WARN_PCT;

  const hasActivity = active > 0 || waiting > 0;
  if (!hasActivity && PERF.DB_POOL_STATS_LOG_ONLY_WHEN_ACTIVE) {
    return false;
  }

  const slowCount = label === "api" ? slowAcquireCountApi : slowAcquireCountWorker;
  const slowHoldCount = label === "api" ? slowHoldCountApi : slowHoldCountWorker;
  const msg = `[DB Pool] ${label}: total=${total} idle=${idle} waiting=${waiting} max=${maxSize} utilization_pct=${utilization_pct} slow_acquires_in_interval=${slowCount} slow_holds_in_interval=${slowHoldCount}`;

  if (isHigh || waiting >= PERF.DB_POOL_WAITING_WARN_COUNT) {
    console.warn(`${msg} ⚠ HIGH UTILIZATION (>${PERF.DB_POOL_UTIL_WARN_PCT}%)`);
  } else {
    console.log(msg);
  }

  if (label === "api") {
    slowAcquireCountApi = 0;
    slowHoldCountApi = 0;
  } else {
    slowAcquireCountWorker = 0;
    slowHoldCountWorker = 0;
  }

  return true;
}

function logPoolUtilization() {
  logPoolStats(pool, "api", PERF.DB_API_POOL_MAX);
  logPoolStats(workerPool, "worker", PERF.DB_WORKER_POOL_MAX);
}

// Task #836 Phase 2: rolling slow-acquire counter that decays over time.
// Background workloads consult this through `isApiPoolUnderPressure()`
// so a recent burst of slow API acquires causes them to back off even
// after the per-interval counter has been reset.
const apiSlowAcquireWindow: number[] = [];
const API_SLOW_ACQUIRE_WINDOW_MS = 60_000;

export function recordApiSlowAcquireForBackoff(): void {
  const now = Date.now();
  apiSlowAcquireWindow.push(now);
  while (apiSlowAcquireWindow.length > 0 && now - apiSlowAcquireWindow[0] > API_SLOW_ACQUIRE_WINDOW_MS) {
    apiSlowAcquireWindow.shift();
  }
}

function recentApiSlowAcquireCount(): number {
  const cutoff = Date.now() - API_SLOW_ACQUIRE_WINDOW_MS;
  while (apiSlowAcquireWindow.length > 0 && apiSlowAcquireWindow[0] < cutoff) {
    apiSlowAcquireWindow.shift();
  }
  return apiSlowAcquireWindow.length;
}

// Task #836 Phase 2: snapshot of current API pool pressure for the
// workload manager. Returns true when API users are likely waiting.
// Background jobs should yield (`backoffForApiPoolPressure`) on a
// `true` reading. Threshold defaults are env-overridable via
// `PERF.DB_POOL_UTIL_WARN_PCT` and `PERF.DB_POOL_WAITING_WARN_COUNT`.
export function isApiPoolUnderPressure(): {
  underPressure: boolean;
  reasons: string[];
  utilizationPct: number;
  waitingCount: number;
  recentSlowAcquires: number;
} {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;
  const active = total - idle;
  const max = PERF.DB_API_POOL_MAX;
  const utilizationPct = max > 0 ? Math.round((active / max) * 100) : 0;
  const recentSlow = recentApiSlowAcquireCount();
  // Live-tunable thresholds — fall back to PERF when no override row.
  const tuning = getApiPoolPressureTuning();
  const reasons: string[] = [];
  if (utilizationPct > tuning.utilWarnPct) reasons.push(`util>${tuning.utilWarnPct}%`);
  if (waiting >= tuning.waitingWarnCount) reasons.push(`waiters>=${tuning.waitingWarnCount}`);
  if (recentSlow >= tuning.slowAcquireBackoffCount) {
    reasons.push(`slow_acquires>=${tuning.slowAcquireBackoffCount}`);
  }
  return {
    underPressure: reasons.length > 0,
    reasons,
    utilizationPct,
    waitingCount: waiting,
    recentSlowAcquires: recentSlow,
  };
}

export function getApiPoolSnapshot(): {
  total: number;
  idle: number;
  active: number;
  waiting: number;
  max: number;
  utilizationPct: number;
} {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;
  const active = total - idle;
  const max = PERF.DB_API_POOL_MAX;
  return {
    total,
    idle,
    active,
    waiting,
    max,
    utilizationPct: max > 0 ? Math.round((active / max) * 100) : 0,
  };
}

export function getWorkerPoolSnapshot(): {
  total: number;
  idle: number;
  active: number;
  waiting: number;
  max: number;
  utilizationPct: number;
} {
  const total = workerPool.totalCount;
  const idle = workerPool.idleCount;
  const waiting = workerPool.waitingCount;
  const active = total - idle;
  const max = PERF.DB_WORKER_POOL_MAX;
  return {
    total,
    idle,
    active,
    waiting,
    max,
    utilizationPct: max > 0 ? Math.round((active / max) * 100) : 0,
  };
}

if (!poolMonitorStarted) {
  poolMonitorStarted = true;
  const poolMonitorInterval = setInterval(logPoolUtilization, PERF.DB_POOL_STATS_INTERVAL_MS);
  if (typeof poolMonitorInterval.unref === "function") poolMonitorInterval.unref();
  console.log(`[DB Pool] Monitor started (interval=${PERF.DB_POOL_STATS_INTERVAL_MS}ms, pools=api,worker)`);
}

const dbContextStorage = new AsyncLocalStorage<"worker" | "api">();

// Test-only hook: when set (e.g. by tests/db-sandbox.ts), `getDb()` returns
// the registered transaction client instead of the API/worker pool. This
// lets transactional sandboxes redirect every storage / service read+write
// through a single tx that can be rolled back. Production code never sets
// this.
type DbLike = typeof db;
let testOverrideResolver: (() => DbLike | undefined) | null = null;

export function __setTestDbOverrideResolver(
  resolver: (() => DbLike | undefined) | null,
): void {
  testOverrideResolver = resolver;
}

export function getDb() {
  if (testOverrideResolver) {
    const override = testOverrideResolver();
    if (override) return override;
  }
  const ctx = dbContextStorage.getStore();
  return ctx === "worker" ? workerDb : db;
}

export function runWithWorkerDb<T>(fn: () => T): T {
  return dbContextStorage.run("worker", fn);
}

// Task #813: cumulative count of transient DB errors that were absorbed by
// `dbRetry` because a later attempt succeeded. The Health sampler reads
// this counter as a delta per sample so the dashboard can distinguish
// "Neon recycled a connection but we recovered" from "DB is actually
// failing".
let transientDbRecoveriesCount = 0;

export function getTransientDbRecoveriesCount(): number {
  return transientDbRecoveriesCount;
}

export async function dbRetry<T>(
  fn: () => Promise<T>,
  label: string = "db",
  maxAttempts: number = 3
): Promise<T> {
  const delays = [1000, 2000, 4000];
  let recoveredFromTransient = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (recoveredFromTransient) {
        transientDbRecoveriesCount++;
        console.info(
          `[dbRetry] ${label}: recovered from transient failure on attempt ${attempt}/${maxAttempts}`,
        );
      }
      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isRetryable =
        msg.includes("timeout") ||
        msg.includes("terminating connection") ||
        msg.includes("Connection terminated") ||
        msg.includes("connection timeout") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ECONNREFUSED");

      if (!isRetryable || attempt >= maxAttempts) {
        if (recoveredFromTransient) {
          // We tried to recover but ultimately failed; do not increment the
          // recovery counter. The caller will surface this as a hard failure.
          console.warn(
            `[dbRetry] ${label}: exhausted retries after transient failure(s); reporting as hard failure`,
          );
        }
        throw err;
      }

      recoveredFromTransient = true;
      const delay = delays[attempt - 1] || 4000;
      console.warn(`[dbRetry] ${label}: attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 80)}). Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`[dbRetry] ${label}: exhausted retries`);
}

